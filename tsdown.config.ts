import { defineConfig } from 'tsdown'

/**
 * Bundle the compiled JavaScript the TypeScript build emits.
 *
 * DSH 0.2.1 removed the runtime invariant registry, so the package no longer
 * publishes an invariant companion entry.
 */
export default defineConfig([
  {
    entry: ['lib/types/index.js'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
  },
])
