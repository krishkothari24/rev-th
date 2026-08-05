/**
 * Dashboard basic auth — BUILD_GUIDE §8.5: "ship it behind a hard-to-guess
 * path or basic auth" before deploying the (otherwise unauthenticated)
 * dashboard publicly. Guards the dashboard page, its REST surface, and the
 * SSE stream — see the registration in `app.ts` for exactly what's inside
 * this scope vs. left open (health check, signed webhooks, tool routes).
 *
 * Active only when both `DASHBOARD_BASIC_AUTH_USER` and
 * `DASHBOARD_BASIC_AUTH_PASS` are set, so local dev (Phase 0-8, neither var
 * populated) stays frictionless. Standard 401 + `WWW-Authenticate: Basic`
 * challenge: the browser's own basic-auth prompt handles credential
 * collection and caches them for the origin, so `fetch`/`EventSource` calls
 * from the dashboard's own JS need no auth-aware code at all — this is a
 * transport-level control, not an application one.
 *
 * `timingSafeEqual` is the same constant-time-compare primitive already
 * used for Retell's HMAC digest (transports/retell/signature.ts) — a
 * naive `===` here would leak the credential length/prefix through timing.
 */
import { timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';

const CHALLENGE = 'Basic realm="Summit Air Dispatch", charset="UTF-8"';

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  // Constant-time compare requires equal-length buffers; unequal lengths
  // are themselves not a hazard worth hiding (only the *content* match is),
  // so short-circuit rather than padding.
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function parseBasicAuthHeader(header: string | undefined): { user: string; pass: string } | null {
  if (!header?.startsWith('Basic ')) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(header.slice('Basic '.length), 'base64').toString('utf8');
  } catch {
    return null;
  }
  const sep = decoded.indexOf(':');
  if (sep === -1) return null;
  return { user: decoded.slice(0, sep), pass: decoded.slice(sep + 1) };
}

/** Whether the dashboard auth vars are configured at all — callers use this
 * to decide whether to register the guarded scope's hook in the first
 * place, rather than registering a hook that's a no-op on every request. */
export function dashboardAuthConfigured(): boolean {
  return Boolean(config.DASHBOARD_BASIC_AUTH_USER && config.DASHBOARD_BASIC_AUTH_PASS);
}

export function requireDashboardBasicAuth(req: FastifyRequest, reply: FastifyReply): void {
  const expectedUser = config.DASHBOARD_BASIC_AUTH_USER;
  const expectedPass = config.DASHBOARD_BASIC_AUTH_PASS;
  if (!expectedUser || !expectedPass) return; // not configured — see dashboardAuthConfigured()

  const parsed = parseBasicAuthHeader(req.headers.authorization);
  const ok = parsed !== null && safeEqual(parsed.user, expectedUser) && safeEqual(parsed.pass, expectedPass);
  if (!ok) {
    reply
      .code(401)
      .header('WWW-Authenticate', CHALLENGE)
      .send({ error: 'unauthorized' });
  }
}
