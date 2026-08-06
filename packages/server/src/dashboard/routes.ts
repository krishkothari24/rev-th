/**
 * GET /dashboard/state, POST /dashboard/emergencies/:id/acknowledge —
 * IMPLEMENTATION_PLAN Phase 7. The dashboard's only REST surface; live
 * updates arrive separately over `/events` (events/sse.ts). Rate-limited
 * like `/tools/*` for defense in depth (§8.5) — the real boundary is CORS
 * restricted to `DASHBOARD_ORIGIN`, same as today.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { acknowledgeEmergency, getDashboardState } from './state.js';
import { endSimSession, runSimTurn, startSimSession } from './simSession.js';
import { phoneSchema } from '../tools/common.js';

const stateQuerySchema = z.object({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD')
    .optional(),
});

const acknowledgeParamsSchema = z.object({
  id: z.string().uuid(),
});

const simStartBodySchema = z.object({ callerPhone: phoneSchema });
const simTurnBodySchema = z.object({
  externalId: z.string().min(1),
  message: z.string().trim().min(1).max(2000),
});
const simEndBodySchema = z.object({ externalId: z.string().min(1) });

async function handleGetState(req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
  const parsed = stateQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return reply.code(400).send({
      error: 'invalid_query',
      issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  const state = await getDashboardState(parsed.data.date);
  return reply.send(state);
}

async function handleAcknowledge(req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
  const parsed = acknowledgeParamsSchema.safeParse(req.params);
  if (!parsed.success) {
    return reply.code(400).send({
      error: 'invalid_params',
      issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  const result = await acknowledgeEmergency(parsed.data.id);
  if (!result.ok) {
    return reply.code(404).send({ error: 'not_found' });
  }
  return reply.send(result);
}

/**
 * The embedded sim panel (IMPLEMENTATION_PLAN, "cool features" follow-up):
 * a thin HTTP wrapper around dashboard/simSession.ts, itself a wrapper
 * around the exact loop transports/sim/repl.ts drives from a terminal — see
 * that file's docblock for why this is safe to add with no new business
 * logic. `startSimSession` throws a clear "ANTHROPIC_API_KEY is not set"
 * error via `requireEnv` when the key isn't configured yet; surfaced here as
 * 503 rather than a bare 500, since "not configured yet" is expected before
 * Phase 9's account setup, not a bug.
 */
async function handleSimStart(req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
  const parsed = simStartBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return reply.code(400).send({
      error: 'invalid_body',
      issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  try {
    const result = await startSimSession(parsed.data.callerPhone);
    return reply.send(result);
  } catch (err) {
    req.log.warn({ err }, 'dashboard sim: could not start session');
    return reply.code(503).send({
      error: 'sim_unavailable',
      message: 'ANTHROPIC_API_KEY is not configured on the server yet.',
    });
  }
}

async function handleSimTurn(req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
  const parsed = simTurnBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return reply.code(400).send({
      error: 'invalid_body',
      issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  const result = await runSimTurn(parsed.data.externalId, parsed.data.message);
  if (!result) return reply.code(404).send({ error: 'not_found' });
  return reply.send(result);
}

async function handleSimEnd(req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
  const parsed = simEndBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return reply.code(400).send({
      error: 'invalid_body',
      issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  const ended = await endSimSession(parsed.data.externalId);
  if (!ended) return reply.code(404).send({ error: 'not_found' });
  return reply.send({ ended: true });
}

export async function registerDashboardRoutes(app: FastifyInstance): Promise<void> {
  const rateLimited = { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } };
  // Each turn is a real model call — a tighter budget than the read-mostly
  // endpoints above, generous enough for an interactive back-and-forth demo.
  const simRateLimited = { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } };

  app.get('/state', rateLimited, handleGetState);
  app.post('/emergencies/:id/acknowledge', rateLimited, handleAcknowledge);
  app.post('/sim/start', simRateLimited, handleSimStart);
  app.post('/sim/turn', simRateLimited, handleSimTurn);
  app.post('/sim/end', rateLimited, handleSimEnd);
}
