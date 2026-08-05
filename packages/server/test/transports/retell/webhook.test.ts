import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../../src/app.js';
import { config } from '../../../src/config.js';
import { resetDb, seedFixtures } from '../../helpers/db.js';

const apiKey = config.RETELL_API_KEY!;

function sign(rawBody: string, timestampMs: number = Date.now()): string {
  const digest = createHmac('sha256', apiKey).update(rawBody + String(timestampMs)).digest('hex');
  return `v=${timestampMs},d=${digest}`;
}

describe('POST /webhooks/retell', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
  });

  beforeEach(async () => {
    await resetDb();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('204s for a validly signed call_started event', async () => {
    const rawBody = JSON.stringify({ event: 'call_started', call: { call_id: 'retell-call-1' } });
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/retell',
      headers: { 'content-type': 'application/json', 'x-retell-signature': sign(rawBody) },
      payload: rawBody,
    });
    expect(res.statusCode).toBe(204);
  });

  it('204s for call_ended and call_analyzed too', async () => {
    for (const event of ['call_ended', 'call_analyzed']) {
      const rawBody = JSON.stringify({ event, call: { call_id: 'retell-call-2' } });
      const res = await app.inject({
        method: 'POST',
        url: '/webhooks/retell',
        headers: { 'content-type': 'application/json', 'x-retell-signature': sign(rawBody) },
        payload: rawBody,
      });
      expect(res.statusCode).toBe(204);
    }
  });

  it('rejects a tampered body with 401', async () => {
    const rawBody = JSON.stringify({ event: 'call_started', call: { call_id: 'retell-call-3' } });
    const signatureHeader = sign(rawBody);
    const tamperedBody = JSON.stringify({ event: 'call_ended', call: { call_id: 'retell-call-3' } });
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/retell',
      headers: { 'content-type': 'application/json', 'x-retell-signature': signatureHeader },
      payload: tamperedBody,
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a missing signature header with 401', async () => {
    const rawBody = JSON.stringify({ event: 'call_started', call: { call_id: 'retell-call-4' } });
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/retell',
      headers: { 'content-type': 'application/json' },
      payload: rawBody,
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a stale timestamp with 401', async () => {
    const rawBody = JSON.stringify({ event: 'call_started', call: { call_id: 'retell-call-5' } });
    const staleTimestamp = Date.now() - 10 * 60 * 1000;
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/retell',
      headers: { 'content-type': 'application/json', 'x-retell-signature': sign(rawBody, staleTimestamp) },
      payload: rawBody,
    });
    expect(res.statusCode).toBe(401);
  });

  it('regression: /tools/customer_lookup JSON parsing is unaffected by the retell plugin-scoped raw-body parser', async () => {
    const fx = await seedFixtures();
    const res = await app.inject({
      method: 'POST',
      url: '/tools/customer_lookup',
      payload: { call_id: 'regression-check', phone: fx.customerPhone },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().found).toBe(true);
  });
});
