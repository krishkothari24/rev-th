/**
 * POST /tools/* — the five tools as HTTP endpoints (BUILD_GUIDE §4). This is
 * what Phase 2 curl-tests against. The voice agent loop (Phase 4+) is a
 * Custom LLM WebSocket running in this same process, so it calls the
 * `*Service` functions in-process for latency via `registry.ts`'s
 * `dispatchTool` rather than looping back through HTTP — but SMS, curl, and
 * any other external caller go through these routes, and both paths run the
 * identical (schema, service) pair defined once in `registry.ts`. One tool
 * layer, per CLAUDE.md's "voice and SMS share one tool layer."
 *
 * Each handler: Zod-validate → runTool (idempotency) → reply. No signature
 * verification here — that's §8.1's concern for /webhooks/*, which carry
 * Retell/Twilio's own HMAC. These routes aren't public-facing telephony
 * callbacks; they're rate-limited (§8.5) and, once deployed, sit behind
 * whatever network boundary the transport layer defines.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';
import { runTool } from './runTool.js';
import { TOOL_ENTRIES } from './registry.js';

async function handleTool<TArgs extends { call_id: string }>(
  toolName: string,
  // Input is `unknown`, not TArgs: several schemas have `.default(...)`
  // fields, so their pre-parse input type legitimately allows `undefined`
  // where the post-parse output does not. We only ever parse an unknown
  // request body, so pinning Input to TArgs would be both wrong and unusable.
  schema: z.ZodType<TArgs, z.ZodTypeDef, unknown>,
  service: (args: TArgs) => Promise<Record<string, unknown>>,
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply> {
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return reply.code(400).send({
      error: 'invalid_arguments',
      issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  const result = await runTool(toolName, parsed.data, () => service(parsed.data));
  return reply.send(result);
}

export async function registerToolRoutes(app: FastifyInstance): Promise<void> {
  const rateLimited = { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } };

  for (const toolEntry of TOOL_ENTRIES) {
    app.post(`/${toolEntry.name}`, rateLimited, (req, reply) =>
      handleTool(toolEntry.name, toolEntry.schema, toolEntry.service, req, reply),
    );
  }
}
