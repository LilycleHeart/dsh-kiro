import { chmod, mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { KiroAccountStore } from '../src/accounts.ts'
import { resolveAdapterOptions } from '../src/index.ts'
import { FileModelSettingsStore } from '../src/model-settings.ts'
import { registerWebApi } from '../src/web.ts'
import type { WebDependencies } from '../src/web.ts'

const temporaryDirectories: string[] = []
const originalUmask = process.umask()

afterEach(async () => {
  process.umask(originalUmask)
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'dsh-kiro-mode-'))
  temporaryDirectories.push(path)
  return path
}

/** One credential record shaped like the adapter's own token file. */
function credential(accessToken: string, clientIdHash?: string): Record<string, unknown> {
  return {
    accessToken,
    refreshToken: accessToken + '-refresh',
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    region: 'us-east-1',
    authMethod: 'builder-id',
    ...clientIdHash === undefined ? {} : { clientIdHash },
  }
}

describe('credential directory permissions', () => {
  it('creates the directory owner-only even under a group-widening umask', async () => {
    const home = await directory()
    process.umask(0o002)
    const file = join(home, 'storages', 'kiro-auth', 'model-settings.json')
    await new FileModelSettingsStore(file).setEnabledModelIds(['auto'], [])
    // The model-settings writer reaches the credential directory first on a
    // fresh install, so it is the one that decides this mode.
    expect((await stat(join(home, 'storages', 'kiro-auth'))).mode & 0o777).toBe(0o700)
  })

  it('tightens a directory the filesystem left group-writable and stores anyway', async () => {
    const path = await directory()
    const folder = join(path, 'kiro-auth')
    await mkdir(folder, { recursive: true, mode: 0o700 })
    await chmod(folder, 0o775)
    const store = new KiroAccountStore(folder)
    const added = await store.upsert({ credential: credential('one') })
    expect((await stat(folder)).mode & 0o777).toBe(0o700)
    const snapshot = await store.snapshot()
    expect(snapshot.accounts.map(account => account.id)).toEqual([added.accountId])
    expect((await stat(store.documentPath)).mode & 0o777).toBe(0o600)
  })

  it('leaves an owner-only directory alone', async () => {
    const path = await directory()
    const folder = join(path, 'kiro-auth')
    await mkdir(folder, { recursive: true, mode: 0o700 })
    await new KiroAccountStore(folder).upsert({ credential: credential('one') })
    expect((await stat(folder)).mode & 0o777).toBe(0o700)
  })

  it('refuses a credential directory that is a symlink, without touching its target', async () => {
    const path = await directory()
    const target = join(path, 'elsewhere')
    await mkdir(target, { recursive: true, mode: 0o700 })
    await chmod(target, 0o775)
    const link = join(path, 'kiro-auth')
    await symlink(target, link)
    await expect(new KiroAccountStore(link).upsert({ credential: credential('one') }))
      .rejects.toMatchObject({ code: 'UNSAFE_ACCOUNT_STORE' })
    // A `chmod` that followed the link would have narrowed the real directory.
    expect((await stat(target)).mode & 0o777).toBe(0o775)
  })
})

describe('removing a credential from a group-writable directory', () => {
  let home: string
  let folder: string
  let handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>

  /** Drive one request through the registered Kiro API handler. */
  async function call(method: string, path: string, body?: unknown): Promise<{ status: number; value: any }> {
    const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
    const request = {
      method,
      url: path,
      async *[Symbol.asyncIterator]() {
        for (const chunk of chunks) yield chunk
      },
    } as unknown as IncomingMessage
    let status = 0
    let payload = ''
    const response = {
      writeHead: (code: number) => { status = code },
      end: (value: string) => { payload = value },
    } as unknown as ServerResponse
    await handler(request, response)
    return { status, value: payload.length === 0 ? undefined : JSON.parse(payload) }
  }

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'dsh-kiro-mode-api-'))
    temporaryDirectories.push(home)
    process.env.DSH_HOME = home
    folder = join(home, 'storages', 'kiro-auth')
    // An installation whose directory the filesystem made group-writable, which
    // is what a `umask 002` host produced before the settings writer set a mode.
    await mkdir(folder, { recursive: true, mode: 0o700 })
    await chmod(folder, 0o775)
    const ctx = {
      emit: () => undefined,
      logger: { warn: () => undefined, error: () => undefined },
      inject: (_names: string[], use: (scope: unknown) => void) => {
        use({
          effect: (run: () => unknown) => run(),
          webServer: {
            register: (options: { handler: typeof handler }) => {
              handler = options.handler
              return () => undefined
            },
          },
        })
      },
    }
    const dependencies = {
      managedDirectory: folder,
      options: () => resolveAdapterOptions({ region: 'us-east-1' }),
      discovery: { current: () => undefined, clear: () => undefined, list: async () => [] },
      modelSettings: new FileModelSettingsStore(),
      usage: { current: () => undefined, clear: () => undefined, get: async () => ({}) },
      resolveToken: async () => { throw new Error('not used by these routes') },
    } as unknown as WebDependencies
    registerWebApi(ctx as never, dependencies)
  })

  afterEach(() => {
    delete process.env.DSH_HOME
  })

  it('removes the credential the page lists, the way the reported failure tried to', async () => {
    const hash = 'b'.repeat(64)
    await writeFile(join(folder, 'kiro-auth-token.json'), JSON.stringify({
      ...credential('legacy-access', hash),
      clientIdHash: hash,
    }, null, 2), { mode: 0o600 })
    await writeFile(join(folder, hash + '.json'), JSON.stringify({ clientId: 'c', clientSecret: 's' }), { mode: 0o600 })

    const status = await call('GET', '/kiro/api/status')
    expect(status.value.value.accounts.migrated).toBe(true)
    const accountId = status.value.value.accounts.accounts[0].id

    const removed = await call('POST', '/kiro/api/accounts/remove', { accountId })
    expect(removed.status).toBe(200)
    expect(removed.value.error).toBeUndefined()
    expect(removed.value.value.accounts.accounts).toEqual([])
    expect(removed.value.value.accounts.activeAccountId).toBeNull()
    expect(removed.value.value.authenticated).toBe(false)
    // The directory is owner-only afterwards, the credential is gone, and its
    // device registration went with it.
    expect((await stat(folder)).mode & 0o777).toBe(0o700)
    await expect(stat(join(folder, 'kiro-auth-token.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(join(folder, hash + '.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
