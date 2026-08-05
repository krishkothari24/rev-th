/**
 * `app.inject()` can't exercise this route: it resolves on stream *end*, and
 * `/events` deliberately never ends while a client is connected. So this
 * spins up a real listening server and uses `fetch` with an `AbortController`
 * — enough to read response headers, then tear the connection down.
 *
 * This test exists because of a real bug caught during Phase 7 manual
 * verification: `reply.hijack()` (required to write SSE frames straight to
 * `reply.raw`) bypasses `@fastify/cors`'s onSend hook, so the route silently
 * shipped with no `Access-Control-Allow-Origin` header at all — every other
 * route got CORS for free from the plugin; this one has to set it by hand
 * (see events/sse.ts). The browser dropped the EventSource connection with
 * no console error; only the network panel showed it never completing.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';

describe('GET /events — CORS on a hijacked SSE response', () => {
  let app: FastifyInstance;
  let baseUrl: string;

  beforeAll(async () => {
    app = await buildApp();
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('expected a bound TCP address');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await app?.close();
  });

  it('echoes an allowed DASHBOARD_ORIGIN back as Access-Control-Allow-Origin', async () => {
    const controller = new AbortController();
    const res = await fetch(`${baseUrl}/events`, {
      headers: { Origin: 'http://localhost:5173' },
      signal: controller.signal,
    });
    controller.abort();

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
    expect(res.headers.get('access-control-allow-credentials')).toBe('true');
  });

  it('does not reflect an origin outside DASHBOARD_ORIGIN', async () => {
    const controller = new AbortController();
    const res = await fetch(`${baseUrl}/events`, {
      headers: { Origin: 'http://evil.example' },
      signal: controller.signal,
    });
    controller.abort();

    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });
});
