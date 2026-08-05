/**
 * GET /events — Server-Sent Events fan-out of the in-process event bus
 * (BUILD_GUIDE §6: "Transport is SSE from `/events`... do not reach for
 * WebSockets — the data flows one direction"). Registered top-level, not
 * under `/dashboard`, matching that literal path.
 *
 * No replay/backfill here by design — a client that (re)connects fetches
 * `GET /dashboard/state` (dashboard/routes.ts) for the current snapshot and
 * layers subsequent SSE events on top, rather than this route trying to
 * buffer and replay history. Each connection subscribes to `eventBus` for
 * its own lifetime and unsubscribes the moment it closes, so a demo session
 * full of reconnects never accumulates dead listeners.
 *
 * `reply.hijack()` hands the raw Node response to us — required because we
 * write to `reply.raw` directly and never call `reply.send()`; without it
 * Fastify would try to send its own (empty) response once the handler
 * returns and error on the already-open stream. The real cost of hijacking:
 * `@fastify/cors`'s own header injection runs on Fastify's normal onSend
 * hook, which a hijacked response never reaches — so this route computes and
 * writes `Access-Control-Allow-Origin` itself (`resolveAllowedDashboardOrigins`,
 * the same allow-list `app.ts` hands the cors plugin) instead of getting it
 * for free. Skipping this was an actual bug during Phase 7 verification: the
 * browser silently dropped the connection with no console error, only
 * visible as the request never completing in the network panel.
 */
import type { FastifyInstance } from 'fastify';
import { resolveAllowedDashboardOrigins } from '../config.js';
import { eventBus, type DashboardEvent } from './bus.js';

/** Keeps the connection alive through idle-timeout proxies between real events. */
const HEARTBEAT_MS = 20_000;

function resolveAllowOriginHeader(requestOrigin: string | undefined): string | null {
  const allowed = resolveAllowedDashboardOrigins();
  if (allowed === true) return requestOrigin ?? '*';
  if (requestOrigin && allowed.includes(requestOrigin)) return requestOrigin;
  return null;
}

export async function registerEventsRoute(app: FastifyInstance): Promise<void> {
  app.get('/events', (req, reply) => {
    reply.hijack();

    const headers: Record<string, string> = {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      // Disables response buffering on common reverse proxies (nginx) so
      // events reach the browser as they're written, not batched.
      'X-Accel-Buffering': 'no',
    };
    const allowOrigin = resolveAllowOriginHeader(req.headers.origin);
    if (allowOrigin) {
      headers['Access-Control-Allow-Origin'] = allowOrigin;
      headers['Access-Control-Allow-Credentials'] = 'true';
      headers.Vary = 'Origin';
    }
    reply.raw.writeHead(200, headers);
    reply.raw.write(': connected\n\n');

    const send = (event: DashboardEvent): void => {
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    const unsubscribe = eventBus.subscribe(send);

    const heartbeat = setInterval(() => {
      reply.raw.write(': ping\n\n');
    }, HEARTBEAT_MS);

    req.raw.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });
}
