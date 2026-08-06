import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  readWebhookHeaders,
  verifyOpenAIWebhookSignature,
} from '../../../src/transports/openai-realtime/signature.js';

const secret = 'whsec_dGVzdC1zaWduYXR1cmUtc2VjcmV0';
const rawBody = '{"type":"realtime.call.incoming","data":{"call_id":"rtc_1"}}';

function sign(
  body: string,
  secretToUse: string,
  id: string,
  timestamp: string,
): string {
  const secretBytes = Buffer.from(secretToUse.replace(/^whsec_/, ''), 'base64');
  const digest = createHmac('sha256', secretBytes)
    .update(`${id}.${timestamp}.${body}`)
    .digest('base64');
  return `v1,${digest}`;
}

describe('verifyOpenAIWebhookSignature', () => {
  it('accepts a validly signed, recent request', () => {
    const now = Date.now();
    const timestamp = String(Math.floor(now / 1000));
    const id = 'evt_1';
    const signature = sign(rawBody, secret, id, timestamp);
    expect(
      verifyOpenAIWebhookSignature(rawBody, { id, timestamp, signature }, secret, { nowMs: now }),
    ).toBe(true);
  });

  it('rejects a tampered body', () => {
    const now = Date.now();
    const timestamp = String(Math.floor(now / 1000));
    const id = 'evt_1';
    const signature = sign(rawBody, secret, id, timestamp);
    const tamperedBody = rawBody.replace('rtc_1', 'rtc_evil');
    expect(
      verifyOpenAIWebhookSignature(tamperedBody, { id, timestamp, signature }, secret, {
        nowMs: now,
      }),
    ).toBe(false);
  });

  it('rejects a signature signed with the wrong secret', () => {
    const now = Date.now();
    const timestamp = String(Math.floor(now / 1000));
    const id = 'evt_1';
    const signature = sign(rawBody, 'whsec_d3Jvbmctc2VjcmV0', id, timestamp);
    expect(
      verifyOpenAIWebhookSignature(rawBody, { id, timestamp, signature }, secret, { nowMs: now }),
    ).toBe(false);
  });

  it('rejects a timestamp outside the skew window', () => {
    const now = Date.now();
    const staleTimestamp = String(Math.floor(now / 1000) - 10 * 60);
    const id = 'evt_1';
    const signature = sign(rawBody, secret, id, staleTimestamp);
    expect(
      verifyOpenAIWebhookSignature(
        rawBody,
        { id, timestamp: staleTimestamp, signature },
        secret,
        { nowMs: now },
      ),
    ).toBe(false);
  });

  it('rejects missing headers', () => {
    const now = Date.now();
    expect(
      verifyOpenAIWebhookSignature(
        rawBody,
        { id: undefined, timestamp: undefined, signature: undefined },
        secret,
        { nowMs: now },
      ),
    ).toBe(false);
  });

  it('accepts a match against any token in a multi-signature header (key rotation)', () => {
    const now = Date.now();
    const timestamp = String(Math.floor(now / 1000));
    const id = 'evt_1';
    const goodSig = sign(rawBody, secret, id, timestamp);
    const decoySig = 'v1,not-a-real-signature==';
    expect(
      verifyOpenAIWebhookSignature(
        rawBody,
        { id, timestamp, signature: `${decoySig} ${goodSig}` },
        secret,
        { nowMs: now },
      ),
    ).toBe(true);
  });

  it('readWebhookHeaders pulls the three lower-cased headers straight off a Fastify request.headers object', () => {
    const headers = readWebhookHeaders({
      'webhook-id': 'evt_1',
      'webhook-timestamp': '123',
      'webhook-signature': 'v1,abc',
      'content-type': 'application/json',
    });
    expect(headers).toEqual({ id: 'evt_1', timestamp: '123', signature: 'v1,abc' });
  });
});
