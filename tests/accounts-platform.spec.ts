import { constants } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * Windows cannot open a directory for reading, so every directory `open` in the
 * credential store is emulated as `EISDIR` here. A POSIX host would never
 * produce that error, which is exactly why the store must not depend on it.
 */
const simulated = vi.hoisted(() => ({ directory: undefined as string | undefined }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    open: async (path: Parameters<typeof actual.open>[0], flags?: number | string, mode?: number) => {
      // A read-only open of the store directory itself: Windows answers EISDIR.
      if (path === simulated.directory && (typeof flags === 'number' ? (flags & constants.O_CREAT) === 0 : flags === 'r')) {
        const error = new Error('EISDIR: illegal operation on a directory, open') as NodeJS.ErrnoException
        error.code = 'EISDIR'
        throw error
      }
      return actual.open(path, flags as never, mode)
    },
  }
})

const { KiroAccountStore } = await import('../src/accounts.ts')

const temporaryDirectories: string[] = []
const originalPlatform = process.platform

afterEach(async () => {
  Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
  simulated.directory = undefined
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

/** One credential record shaped like the adapter's own token file. */
function credential(accessToken: string): Record<string, unknown> {
  return {
    accessToken,
    refreshToken: accessToken + '-refresh',
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    region: 'us-east-1',
    authMethod: 'builder-id',
  }
}

describe('Kiro account store where a directory cannot be opened', () => {
  it('still stores an account when the directory fsync is unavailable', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-kiro-accounts-win-'))
    temporaryDirectories.push(directory)
    simulated.directory = directory
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })

    const store = new KiroAccountStore(directory)
    const added = await store.upsert({ credential: credential('a'), authMethod: 'builder-id' })
    // The write must have landed, not merely returned: a caller that stored an
    // account has to find it again.
    const snapshot = await store.snapshot()
    expect(snapshot.accounts.map(account => account.id)).toEqual([added.accountId])
    expect(snapshot.activeAccountId).toBe(added.accountId)
    const written = JSON.parse(await readFile(store.documentPath, 'utf8')) as { accounts: unknown[] }
    expect(written.accounts).toHaveLength(1)
  })
})
