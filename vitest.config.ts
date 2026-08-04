import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/src/**/*.test.ts', 'packages/**/test/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    // Tool-layer and triage tests hit the local database; running files
    // sequentially keeps their fixtures from colliding.
    fileParallelism: false,
    testTimeout: 15_000,
  },
});
