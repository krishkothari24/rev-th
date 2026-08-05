/**
 * Retell HTTP webhook (BUILD_GUIDE §8.1, IMPLEMENTATION_PLAN Phase 8) —
 * separate from the Custom LLM WebSocket (websocket.ts); carries
 * `call_started`/`call_ended`/`call_analyzed` lifecycle notifications.
 *
 * Registered as its own encapsulated plugin so the raw-body-preserving
 * content-type parser below is scoped to *this* route only — Fastify's
 * plugin encapsulation means `addContentTypeParser` calls inside a
 * `register()`ed function never leak to sibling routes, so `/tools/*` keeps
 * the default JSON parser untouched (see the regression check in
 * webhook.test.ts). Fastify's default JSON parser would otherwise consume
 * the body before signature verification ever saw the raw bytes it needs to
 * hash — the exact failure mode BUILD_GUIDE §8.1 calls out.
 *
 * This route does not itself call `finalizeConversation` — the WS `close`
 * handler is authoritative for voice, since it holds the real in-process
 * message array this webhook's payload doesn't carry. `finalizeConversation`
 * is idempotent (agent/context.ts) either way.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { config } from '../../config.js';
import { verifyRetellSignature } from './signature.js';

interface RetellWebhookBody {
  event?: string;
  call?: { call_id?: string; [key: string]: unknown };
}

function getRawBody(req: FastifyRequest): string {
  return (req as FastifyRequest & { rawBody?: string }).rawBody ?? '';
}

export async function registerRetellWebhookRoute(app: FastifyInstance): Promise<void> {
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (req, body: Buffer, done) => {
      const rawBody = body.toString('utf-8');
      (req as FastifyRequest & { rawBody?: string }).rawBody = rawBody;
      try {
        done(null, rawBody.length ? JSON.parse(rawBody) : {});
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  app.post(
    '/webhooks/retell',
    { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const apiKey = config.RETELL_API_KEY;
      const sig = req.headers['x-retell-signature'];
      const rawBody = getRawBody(req);

      if (
        !apiKey ||
        typeof sig !== 'string' ||
        !verifyRetellSignature(rawBody, sig, apiKey)
      ) {
        req.log.warn('rejected /webhooks/retell: bad or missing signature');
        return reply.code(401).send();
      }

      const body = req.body as RetellWebhookBody;
      switch (body.event) {
        case 'call_started':
        case 'call_ended':
        case 'call_analyzed':
          req.log.info({ event: body.event, callId: body.call?.call_id }, 'retell webhook received');
          break;
        default:
          req.log.warn({ event: body.event }, 'unrecognized retell webhook event');
      }
      return reply.code(204).send();
    },
  );
}
