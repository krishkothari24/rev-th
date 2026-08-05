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

const stateQuerySchema = z.object({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD')
    .optional(),
});

const acknowledgeParamsSchema = z.object({
  id: z.string().uuid(),
});

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

export async function registerDashboardRoutes(app: FastifyInstance): Promise<void> {
  const rateLimited = { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } };

  app.get('/state', rateLimited, handleGetState);
  app.post('/emergencies/:id/acknowledge', rateLimited, handleAcknowledge);
}
