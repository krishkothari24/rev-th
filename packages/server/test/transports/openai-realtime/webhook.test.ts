import { EventEmitter } from 'node:events';
import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import type WebSocket from 'ws';
import { buildApp } from '../../../src/app.js';
import { db } from '../../../src/db/client.js';
import { conversations } from '../../../src/db/schema.js';
import { config } from '../../../src/config.js';
import { registerOpenAIRealtimeWebhookRoute } from '../../../src/transports/openai-realtime/webhook.js';
import type { OpenAIRealtimeToolDefinition } from '../../../src/tools/registry.js';
import { resetDb, seedFixtures } from '../../helpers/db.js';

const secret = config.OPENAI_WEBHOOK_SECRET!;

function sign(
  rawBody: string,
  id = 'evt_1',
  timestamp: string = String(Math.floor(Date.now() / 1000)),
): { 'webhook-id': string; 'webhook-timestamp': string; 'webhook-signature': string } {
  const secretBytes = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const digest = createHmac('sha256', secretBytes)
    .update(`${id}.${timestamp}.${rawBody}`)
    .digest('base64');
  return { 'webhook-id': id, 'webhook-timestamp': timestamp, 'webhook-signature': `v1,${digest}` };
}

function incomingCallBody(callId: string, fromPhone: string): string {
  return JSON.stringify({
    type: 'realtime.call.incoming',
    data: { call_id: callId, sip_headers: [{ name: 'From', value: `sip:${fromPhone}@example.com` }] },
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('POST /webhooks/openai-realtime', () => {
  let app: FastifyInstance | undefined;

  beforeEach(async () => {
    await resetDb();
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('rejects a tampered body with 401', async () => {
    app = Fastify({ logger: false });
    await app.register(registerOpenAIRealtimeWebhookRoute);

    const rawBody = incomingCallBody('rtc-tamper', '+17705550100');
    const headers = sign(rawBody);
    const tamperedBody = incomingCallBody('rtc-tamper-evil', '+17705550100');

    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/openai-realtime',
      headers: { 'content-type': 'application/json', ...headers },
      payload: tamperedBody,
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a missing signature with 401', async () => {
    app = Fastify({ logger: false });
    await app.register(registerOpenAIRealtimeWebhookRoute);

    const rawBody = incomingCallBody('rtc-nosig', '+17705550100');
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/openai-realtime',
      headers: { 'content-type': 'application/json' },
      payload: rawBody,
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a stale timestamp with 401', async () => {
    app = Fastify({ logger: false });
    await app.register(registerOpenAIRealtimeWebhookRoute);

    const rawBody = incomingCallBody('rtc-stale', '+17705550100');
    const staleTimestamp = String(Math.floor(Date.now() / 1000) - 10 * 60);
    const headers = sign(rawBody, 'evt_1', staleTimestamp);

    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/openai-realtime',
      headers: { 'content-type': 'application/json', ...headers },
      payload: rawBody,
    });
    expect(res.statusCode).toBe(401);
  });

  it('204s an unrecognized event type without attempting to accept a call', async () => {
    app = Fastify({ logger: false });
    const acceptCall = vi.fn();
    const connectSession = vi.fn();
    await app.register(registerOpenAIRealtimeWebhookRoute, { acceptCall, connectSession });

    const rawBody = JSON.stringify({ type: 'some.other.event', data: {} });
    const headers = sign(rawBody);

    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/openai-realtime',
      headers: { 'content-type': 'application/json', ...headers },
      payload: rawBody,
    });
    expect(res.statusCode).toBe(204);
    expect(acceptCall).not.toHaveBeenCalled();
  });

  it('204s realtime.call.incoming missing a call_id without attempting to accept a call', async () => {
    app = Fastify({ logger: false });
    const acceptCall = vi.fn();
    const connectSession = vi.fn();
    await app.register(registerOpenAIRealtimeWebhookRoute, { acceptCall, connectSession });

    const rawBody = JSON.stringify({ type: 'realtime.call.incoming', data: {} });
    const headers = sign(rawBody);

    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/openai-realtime',
      headers: { 'content-type': 'application/json', ...headers },
      payload: rawBody,
    });
    expect(res.statusCode).toBe(204);
    expect(acceptCall).not.toHaveBeenCalled();
  });

  it('200s immediately, then accepts and connects a genuine realtime.call.incoming, recognizing a seeded caller', async () => {
    const fx = await seedFixtures();

    const acceptCall = vi.fn().mockResolvedValue(undefined);
    const fakeSocket = new EventEmitter() as unknown as WebSocket;
    (fakeSocket as unknown as { send: () => void }).send = vi.fn();
    const connectSession = vi.fn().mockResolvedValue(fakeSocket);

    app = Fastify({ logger: false });
    await app.register(registerOpenAIRealtimeWebhookRoute, { acceptCall, connectSession });

    const callId = 'rtc-happy-path';
    const rawBody = incomingCallBody(callId, fx.customerPhone);
    const headers = sign(rawBody);

    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/openai-realtime',
      headers: { 'content-type': 'application/json', ...headers },
      payload: rawBody,
    });
    // Responds before the accept/connect work even starts — the point of
    // "webhooks return 2xx fast" (CLAUDE.md).
    expect(res.statusCode).toBe(200);

    await waitFor(() => connectSession.mock.calls.length > 0);

    expect(acceptCall).toHaveBeenCalledTimes(1);
    const [acceptedCallId, acceptConfig] = acceptCall.mock.calls[0] as [
      string,
      { instructions: string; tools: OpenAIRealtimeToolDefinition[] },
    ];
    expect(acceptedCallId).toBe(callId);
    // Recognized-caller summary (§8.2/BUILD_GUIDE §3) landed in the
    // accept-time instructions, not just a raw customer record.
    expect(acceptConfig.instructions).toContain('Test Customer');
    expect(acceptConfig.tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(['customer_lookup', 'check_availability', 'book_appointment']),
    );
    expect(acceptConfig.tools.every((t) => t.type === 'function')).toBe(true);

    const [connectedCallId] = connectSession.mock.calls[0] as [string];
    expect(connectedCallId).toBe(callId);

    const [row] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.externalId, callId));
    expect(row).toBeDefined();
  });

  it('regression: /tools/customer_lookup JSON parsing is unaffected by the openai-realtime plugin-scoped raw-body parser', async () => {
    const fx = await seedFixtures();
    app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/tools/customer_lookup',
      payload: { call_id: 'regression-check-openai-realtime', phone: fx.customerPhone },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().found).toBe(true);
  });
});
