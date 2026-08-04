/**
 * The `postgres` driver throws plain errors decorated with the raw Postgres
 * error fields (SQLSTATE `code`, `constraint_name`, ...) rather than a typed
 * exception hierarchy, and drizzle-orm re-wraps that in a `DrizzleQueryError`
 * with the original on `.cause` (see drizzle-orm/errors.ts). This unwraps
 * one level of `.cause` so callers can catch specific constraint violations
 * — e.g. the double-booking guard and the one-flag-per-call constraint —
 * without string-matching an error message.
 */
interface PgError extends Error {
  code?: string;
  constraint_name?: string;
  cause?: unknown;
}

const UNIQUE_VIOLATION = '23505';

export function isUniqueViolation(err: unknown, constraintName?: string): boolean {
  for (const candidate of [err, err instanceof Error ? err.cause : undefined]) {
    if (!(candidate instanceof Error)) continue;
    const pgErr = candidate as PgError;
    if (pgErr.code !== UNIQUE_VIOLATION) continue;
    if (constraintName === undefined || pgErr.constraint_name === constraintName) return true;
  }
  return false;
}
