import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Boots an in-process Postgres (pglite) over a socket for integration tests.
    globalSetup: ['./test/global-setup.ts'],
    // The app's Prisma client reads DATABASE_URL; point it at the pglite socket. Unit tests
    // that mock @/lib/prisma ignore it; integration tests use it.
    env: {
      DATABASE_URL: 'postgresql://postgres:postgres@127.0.0.1:54329/postgres',
      // pglite serves one connection at a time — keep the test pool single-connection.
      DATABASE_POOL_MAX: '1',
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
})
