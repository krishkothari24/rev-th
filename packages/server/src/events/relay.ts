/**
 * POST /events/relay — local-development-only bridge, not part of the real
 * production architecture.
 *
 * `npm run sim` (transports/sim/repl.ts) drives the exact same
 * loop/tools/triage code real calls will, but runs as its own OS process for
 * fast, $0, no-server-required iteration (Phase 4's whole point — see that
 * file's docblock). That means it has its *own* in-memory `eventBus`
 * instance; its `flag_emergency`/`book_appointment`/etc. calls really do
 * write to the same Postgres database the dashboard reads from, but the
 * dashboard's `/events` SSE stream is served by a *different* process (`npm
 * run dev`) and can never observe another process's in-memory bus directly.
 *
 * This route is how the sim's events reach it anyway: the sim subscribes to
 * its own local bus and POSTs each event here; this handler re-publishes it
 * on *this* process's bus, which the real `/events` subscribers are on. It
 * does not re-run any tool or side effect — it only makes an already-real
 * event visible to the dashboard.
 *
 * This gap doesn't recur once Phase 8 telephony lands: the Retell/Twilio
 * webhook handlers and `/events` will live in the same process by
 * construction, so production calls never need this bridge — hence gating
 * it out of production entirely rather than hardening it.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { isProduction } from '../config.js';
import { dashboardEventSchema, eventBus } from './bus.js';

async function handleRelay(req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
  const parsed = dashboardEventSchema.safeParse(req.body);
  if (!parsed.success) {
    return reply.code(400).send({
      error: 'invalid_event',
      issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  eventBus.publish(parsed.data);
  return reply.code(204).send();
}

export async function registerEventsRelayRoute(app: FastifyInstance): Promise<void> {
  if (isProduction) return; // sim-only bridge — never registered in a real deployment
  app.post('/events/relay', handleRelay);
}
