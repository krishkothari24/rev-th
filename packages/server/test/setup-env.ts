/**
 * Vitest setupFiles entry — runs before any test file's imports resolve, so
 * this must set process.env before `src/config.ts` is ever imported by
 * anything under test. Points the whole run at a dedicated `summit_air_test`
 * database so tool-layer tests never touch the seeded demo data in
 * `summit_air_dev`. `dotenv.config()` (called by config.ts on import) does
 * not override an already-set process.env var, so setting it here wins.
 *
 * First-time setup, from packages/server:
 *   createdb summit_air_test
 *   DATABASE_URL=postgres://localhost:5432/summit_air_test npx tsx src/db/migrate.ts
 */
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://localhost:5432/summit_air_test';
process.env.NODE_ENV = 'test';
