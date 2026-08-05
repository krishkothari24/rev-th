import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyRetellSignature } from '../../../src/transports/retell/signature.js';

const apiKey = 'test-retell-api-key';
const rawBody = '{"event":"call_started","call":{"call_id":"c1"}}';

function sign(body: string, apiKeyToUse: string, timestampMs: number): string {
  const digest = createHmac('sha256', apiKeyToUse).update(body + String(timestampMs)).digest('hex');
  return `v=${timestampMs},d=${digest}`;
}

describe('verifyRetellSignature', () => {
  it('accepts a validly signed, recent request', () => {
    const now = Date.now();
    const header = sign(rawBody, apiKey, now);
    expect(verifyRetellSignature(rawBody, header, apiKey, { nowMs: now })).toBe(true);
  });

  it('rejects a tampered body', () => {
    const now = Date.now();
    const header = sign(rawBody, apiKey, now);
    const tamperedBody = rawBody.replace('call_started', 'call_ended');
    expect(verifyRetellSignature(tamperedBody, header, apiKey, { nowMs: now })).toBe(false);
  });

  it('rejects a digest signed with the wrong key', () => {
    const now = Date.now();
    const header = sign(rawBody, 'a-different-key', now);
    expect(verifyRetellSignature(rawBody, header, apiKey, { nowMs: now })).toBe(false);
  });

  it('rejects a timestamp outside the skew window', () => {
    const now = Date.now();
    const staleTimestamp = now - 10 * 60 * 1000; // 10 minutes old
    const header = sign(rawBody, apiKey, staleTimestamp);
    expect(verifyRetellSignature(rawBody, header, apiKey, { nowMs: now })).toBe(false);
  });

  it('rejects a malformed header', () => {
    const now = Date.now();
    expect(verifyRetellSignature(rawBody, 'not-the-right-shape', apiKey, { nowMs: now })).toBe(false);
    expect(verifyRetellSignature(rawBody, undefined, apiKey, { nowMs: now })).toBe(false);
  });
});
