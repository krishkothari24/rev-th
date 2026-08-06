/**
 * OpenAI Realtime webhook authenticity (BUILD_GUIDE §8.1, IMPLEMENTATION_PLAN
 * Phase 11) — unlike Retell's hand-rolled `v=<ts>,d=<digest>` header,
 * OpenAI's webhooks (confirmed against the live docs during this migration's
 * research pass; re-verify if this stops matching real traffic) follow the
 * Svix webhook-signing convention: three headers —
 *
 *   webhook-id:        unique delivery id (also usable for de-duplication)
 *   webhook-timestamp:  unix seconds
 *   webhook-signature:  space-separated `v1,<base64 sig>` tokens (Svix signs
 *                       with every currently-active signing key, so more than
 *                       one token can be present — a match on any one counts)
 *
 * Signed content is `${id}.${timestamp}.${raw_body}`, HMAC-SHA256, keyed by
 * the webhook secret from the OpenAI dashboard (format `whsec_<base64>` —
 * the `whsec_` prefix is stripped before base64-decoding the key material).
 * Hand-rolled with `node:crypto` for the same reason retell/signature.ts is:
 * the algorithm is fully specified and this avoids a Svix SDK dependency for
 * one HMAC check.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

const DEFAULT_MAX_SKEW_MS = 5 * 60 * 1000;
const SECRET_PREFIX = 'whsec_';

export interface VerifyOpenAIWebhookSignatureOptions {
  nowMs?: number;
  maxSkewMs?: number;
}

export interface OpenAIWebhookHeaders {
  id: string | undefined;
  timestamp: string | undefined;
  signature: string | undefined;
}

function decodeSecret(secret: string): Buffer {
  const raw = secret.startsWith(SECRET_PREFIX) ? secret.slice(SECRET_PREFIX.length) : secret;
  return Buffer.from(raw, 'base64');
}

/** Extracts the three signing headers, tolerating Fastify's lower-cased
 * header keys either way. */
export function readWebhookHeaders(headers: Record<string, unknown>): OpenAIWebhookHeaders {
  const get = (name: string): string | undefined => {
    const value = headers[name];
    return typeof value === 'string' ? value : undefined;
  };
  return {
    id: get('webhook-id'),
    timestamp: get('webhook-timestamp'),
    signature: get('webhook-signature'),
  };
}

export function verifyOpenAIWebhookSignature(
  rawBody: string,
  headers: OpenAIWebhookHeaders,
  secret: string,
  opts: VerifyOpenAIWebhookSignatureOptions = {},
): boolean {
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature) return false;

  const now = opts.nowMs ?? Date.now();
  const maxSkewMs = opts.maxSkewMs ?? DEFAULT_MAX_SKEW_MS;
  const timestampMs = Number(timestamp) * 1000;
  if (!Number.isFinite(timestampMs) || Math.abs(now - timestampMs) > maxSkewMs) return false;

  const signedContent = `${id}.${timestamp}.${rawBody}`;
  const expected = createHmac('sha256', decodeSecret(secret)).update(signedContent).digest();

  // webhook-signature can carry multiple space-separated "v1,<sig>" tokens
  // (key rotation) — accept a match against any of them.
  const tokens = signature.trim().split(/\s+/);
  for (const token of tokens) {
    const [version, sigB64] = token.split(',');
    if (version !== 'v1' || !sigB64) continue;
    let actual: Buffer;
    try {
      actual = Buffer.from(sigB64, 'base64');
    } catch {
      continue;
    }
    if (actual.length !== expected.length) continue;
    if (timingSafeEqual(expected, actual)) return true;
  }
  return false;
}
