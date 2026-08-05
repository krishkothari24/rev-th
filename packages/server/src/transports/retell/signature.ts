/**
 * Retell webhook authenticity (BUILD_GUIDE §8.1): `x-retell-signature` is
 * formatted `v=<timestamp>,d=<digest>`, where `digest` is HMAC-SHA256 over
 * `raw_body + timestamp` (string concatenation), keyed by the Retell API key
 * itself (only a key with the webhook badge verifies correctly — there is no
 * separate webhook-signing secret). Hand-rolled with `node:crypto` rather
 * than the `retell-sdk` package: the algorithm is fully specified, there's no
 * real account yet to validate SDK behavior against, and `node:crypto` is
 * already this codebase's idempotency-hashing primitive (tools/runTool.ts).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

const DEFAULT_MAX_SKEW_MS = 5 * 60 * 1000;

export interface VerifyRetellSignatureOptions {
  nowMs?: number;
  maxSkewMs?: number;
}

function parseHeader(header: string): { timestamp: string; digest: string } | null {
  const match = /^v=(\d+),d=([0-9a-f]+)$/i.exec(header.trim());
  if (!match) return null;
  const [, timestamp, digest] = match;
  if (!timestamp || !digest) return null;
  return { timestamp, digest };
}

export function verifyRetellSignature(
  rawBody: string,
  signatureHeader: string | undefined,
  apiKey: string,
  opts: VerifyRetellSignatureOptions = {},
): boolean {
  if (!signatureHeader) return false;
  const parsed = parseHeader(signatureHeader);
  if (!parsed) return false;

  const now = opts.nowMs ?? Date.now();
  const maxSkewMs = opts.maxSkewMs ?? DEFAULT_MAX_SKEW_MS;
  const timestampMs = Number(parsed.timestamp);
  if (!Number.isFinite(timestampMs) || Math.abs(now - timestampMs) > maxSkewMs) return false;

  const expectedDigest = createHmac('sha256', apiKey)
    .update(rawBody + parsed.timestamp)
    .digest('hex');

  const expected = Buffer.from(expectedDigest, 'hex');
  const actual = Buffer.from(parsed.digest, 'hex');
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}
