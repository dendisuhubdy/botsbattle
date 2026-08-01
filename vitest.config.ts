import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Every suite shares one Postgres instance, so nothing may run concurrently.
    pool: 'forks',
    maxWorkers: 1,
    fileParallelism: false,
    testTimeout: 30_000,
    setupFiles: ['dotenv/config'],
  },
  // tsconfig.json sets `jsx: preserve` because Next does its own JSX transform. Vitest gets
  // no such pass, so component tests need JSX compiled here or the import fails to parse.
  oxc: { jsx: { runtime: 'automatic' } },
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
})
