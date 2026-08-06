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

// Phase 8 transport tests sign fixtures against these — real values are
// unnecessary (and unavailable pre-Phase-9), so tests never need a real
// account. `??=` so a real .env value (if ever present) still wins.
process.env.RETELL_API_KEY ??= 'test-retell-api-key';
process.env.TWILIO_AUTH_TOKEN ??= 'test-twilio-auth-token';
process.env.PUBLIC_BASE_URL ??= 'http://localhost:3100';

// IMPLEMENTATION_PLAN Phase 11 — same reasoning as the Retell/Twilio vars
// above: fixtures sign against a synthetic secret, no real OpenAI account
// needed to run these tests. Valid-shaped base64 payload so
// `signature.ts`'s `Buffer.from(secret, 'base64')` decoding exercises the
// real code path rather than an empty/garbage key.
process.env.OPENAI_API_KEY ??= 'test-openai-api-key';
process.env.OPENAI_WEBHOOK_SECRET ??= 'whsec_dGVzdC1vcGVuYWktd2ViaG9vay1zZWNyZXQ=';

// Phase 9a added dashboard basic-auth, gated on both vars being set
// (dashboard/basicAuth.ts). dotenv.config() (called from config.ts on
// import) picks up a real developer .env unless we blank these first —
// without this, running the suite locally with real Railway/dashboard
// creds in .env silently turns on auth mid-run and 401s every
// dashboard/SSE test that (correctly, for its own scope) doesn't send
// credentials. The auth gate itself is exercised live against the
// deployed instance, not by this suite.
process.env.DASHBOARD_BASIC_AUTH_USER = '';
process.env.DASHBOARD_BASIC_AUTH_PASS = '';
