/**
 * OpenAI Realtime webhook at `POST /webhooks/openai-realtime`
 * (IMPLEMENTATION_PLAN Phase 11, BUILD_GUIDE §8.1/§12) — the entry point for
 * an inbound call once Twilio's SIP trunk hands it to OpenAI. Registered as
 * its own encapsulated plugin so the raw-body-preserving content-type parser
 * below is scoped to this route only, same reasoning as
 * `retell/webhook.ts`'s identical pattern: Fastify's default JSON parser
 * would otherwise consume the body before signature verification ever sees
 * the raw bytes it needs to hash.
 *
 * On a genuine `realtime.call.incoming` event, responds `200` immediately
 * (CLAUDE.md: "webhooks return 2xx fast; slow work happens after the
 * response is queued, never inline in the request path") and only then does
 * the real work — customer lookup, building `instructions`, `accept`ing the
 * call, and opening the session's WebSocket — asynchronously.
 *
 * The exact webhook envelope shape below (`{type, data: {call_id,
 * sip_headers}}`) is modeled from OpenAI's documented description of the
 * event, not a captured real payload — confirm against a live webhook
 * delivery before Phase 11 step 4 (accounts) and adjust `extractCallerPhone`
 * / the body type if the real shape differs.
 */
import type { FastifyBaseLogger, FastifyInstance, FastifyRequest } from 'fastify';
import { config, requireEnv } from '../../config.js';
import { runCallStartRecognition } from '../../agent/callStartRecognition.js';
import { startConversation } from '../../agent/context.js';
import { buildSystemPromptForTurn } from '../../agent/prompts.js';
import { getOpenAIRealtimeToolDefinitions } from '../../tools/registry.js';
import {
  acceptRealtimeCall,
  connectRealtimeSessionWithRetry,
  type RealtimeClientConfig,
} from './client.js';
import { readWebhookHeaders, verifyOpenAIWebhookSignature } from './signature.js';
import { runRealtimeSession } from './session.js';

interface SipHeader {
  name?: string;
  value?: string;
}

interface OpenAIWebhookBody {
  type?: string;
  data?: {
    call_id?: string;
    sip_headers?: SipHeader[];
  };
}

function getRawBody(req: FastifyRequest): string {
  return (req as FastifyRequest & { rawBody?: string }).rawBody ?? '';
}

/** Pulls an E.164-ish number out of a SIP `From` header's `sip:+1770...@...`
 * URI. Returns `null` (not a guess) when the header is missing or doesn't
 * parse — callers fall back to `'unknown'`, same as `retell/websocket.ts`'s
 * `from_number ?? 'unknown'`. */
function extractCallerPhone(sipHeaders: SipHeader[] | undefined): string | null {
  const from = sipHeaders?.find((h) => h.name?.toLowerCase() === 'from')?.value;
  if (!from) return null;
  const match = /sip:(\+?[0-9]{7,15})@/i.exec(from);
  return match?.[1] ?? null;
}

export interface RegisterOpenAIRealtimeWebhookRouteOptions {
  /** Test seams — production omits these and gets real network calls
   * against the real OpenAI hosts. */
  acceptCall?: typeof acceptRealtimeCall;
  connectSession?: typeof connectRealtimeSessionWithRetry;
}

// `startConversation` already dedupes the `conversations` row insert against
// a retried call-start (onConflictDoNothing), but that guards the DB write
// only — it does nothing to stop a redelivered `realtime.call.incoming`
// webhook from calling accept() a second time and opening a second
// WebSocket/`runRealtimeSession` loop for the same live call (Svix retries
// on any delivery-layer failure even after our fast 200; a signature is
// also technically replayable within the 5-minute freshness window). Two
// concurrent sessions on one call_id means two greetings talking over each
// other and duplicate tool-call handling. Single-process guard — sufficient
// for this deployment (one Railway replica); would need to move to a DB row
// or Redis lock before scaling to multiple instances.
const callsInFlightOrHandled = new Set<string>();

async function handleIncomingCall(
  callId: string,
  data: OpenAIWebhookBody['data'],
  deps: Required<RegisterOpenAIRealtimeWebhookRouteOptions>,
  log: FastifyBaseLogger,
): Promise<void> {
  const callerPhone = extractCallerPhone(data?.sip_headers) ?? 'unknown';
  const state = await startConversation({ channel: 'voice', externalId: callId, callerPhone });

  const recognitionCall = await runCallStartRecognition(state);
  if (recognitionCall) {
    log.info(
      { callId, found: recognitionCall.result.found },
      'openai-realtime: call-start recognition',
    );
  }

  const instructions = buildSystemPromptForTurn(state);
  const client: RealtimeClientConfig = { apiKey: requireEnv('OPENAI_API_KEY') };

  const acceptStart = Date.now();
  await deps.acceptCall(
    callId,
    {
      model: config.OPENAI_REALTIME_MODEL,
      voice: config.OPENAI_REALTIME_VOICE,
      instructions,
      tools: getOpenAIRealtimeToolDefinitions(),
      transcribeModel: config.OPENAI_REALTIME_TRANSCRIBE_MODEL,
    },
    client,
  );
  log.info(
    { callId, elapsedMs: Date.now() - acceptStart },
    'openai-realtime: accept succeeded, opening WS',
  );

  const socket = await deps.connectSession(callId, client, { logger: log });
  // Release the in-flight guard once this call's socket actually closes —
  // only *concurrent* duplicate deliveries need blocking; a call that has
  // genuinely ended must not be permanently unable to be retried.
  socket.once('close', () => callsInFlightOrHandled.delete(callId));
  runRealtimeSession(state, socket, instructions);
  log.info({ callId }, 'openai-realtime: session connected');
}

export async function registerOpenAIRealtimeWebhookRoute(
  app: FastifyInstance,
  opts: RegisterOpenAIRealtimeWebhookRouteOptions = {},
): Promise<void> {
  const deps: Required<RegisterOpenAIRealtimeWebhookRouteOptions> = {
    acceptCall: opts.acceptCall ?? acceptRealtimeCall,
    connectSession: opts.connectSession ?? connectRealtimeSessionWithRetry,
  };

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
    '/webhooks/openai-realtime',
    { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const secret = config.OPENAI_WEBHOOK_SECRET;
      const headers = readWebhookHeaders(req.headers as Record<string, unknown>);
      const rawBody = getRawBody(req);

      if (!secret || !verifyOpenAIWebhookSignature(rawBody, headers, secret)) {
        req.log.warn('rejected /webhooks/openai-realtime: bad or missing signature');
        return reply.code(401).send();
      }

      const body = req.body as OpenAIWebhookBody;
      if (body.type !== 'realtime.call.incoming') {
        req.log.warn({ type: body.type }, 'unrecognized openai-realtime webhook event');
        return reply.code(204).send();
      }

      const callId = body.data?.call_id;
      if (!callId) {
        req.log.warn('openai-realtime webhook: realtime.call.incoming missing call_id');
        return reply.code(204).send();
      }

      reply.code(200).send();

      if (callsInFlightOrHandled.has(callId)) {
        req.log.warn({ callId }, 'openai-realtime: duplicate call.incoming delivery, ignoring');
        return;
      }
      callsInFlightOrHandled.add(callId);

      handleIncomingCall(callId, body.data, deps, req.log).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        req.log.error(
          { err, callId },
          `openai-realtime: failed to accept/connect call: ${message}`,
        );
        // accept/connect never got as far as opening a socket (no `close`
        // event will ever come to release the guard) — release it here so a
        // genuine retry of this call_id isn't blocked forever.
        callsInFlightOrHandled.delete(callId);
      });
    },
  );
}
