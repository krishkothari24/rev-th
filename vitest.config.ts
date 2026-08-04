import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/src/**/*.test.ts', 'packages/**/test/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    // Tool-layer and triage tests hit the local database; running files
    // sequentially keeps their fixtures from colliding.
    fileParallelism: false,
    testTimeout: 15_000,
    // Points DATABASE_URL at summit_air_test before src/config.ts loads —
    // see packages/server/test/setup-env.ts for the one-time DB setup.
    setupFiles: ['./packages/server/test/setup-env.ts'],
  },
});
