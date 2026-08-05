/**
 * Twilio inbound SMS webhook (BUILD_GUIDE §7/§8.1, IMPLEMENTATION_PLAN
 * Phase 8). Twilio POSTs `application/x-www-form-urlencoded` — parsed by
 * `@fastify/formbody`, registered once at app level (see app.ts) — not JSON,
 * so this route needs no raw-body content-type parser the way
 * transports/retell/webhook.ts does; Twilio's own signature is computed over
 * the *parsed* param object plus the exact webhook URL, not raw bytes.
 *
 * Signature verification always runs first, unconditionally, for every
 * request — including a STOP message — because an unauthenticated request
 * must never be able to set DNC for an arbitrary number or otherwise act on
 * unverified content.
 */
import type { FastifyInstance } from 'fastify';
import Twilio from 'twilio';
import { config } from '../../config.js';
import { redactPhone } from '../../lib/redact.js';
import { runTurn } from '../../agent/loop.js';
import { AnthropicProvider } from '../../agent/providers/anthropic.js';
import { ScriptedProvider, type ScriptedProviderScript } from '../../agent/providers/scripted.js';
import type { AgentProvider } from '../../agent/types.js';
import { setDnc } from '../../sms/dnc.js';
import { verifyTwilioSignature } from './signature.js';
import { getOrCreateSmsThread } from './conversationStore.js';

const STOP_KEYWORDS = new Set(['STOP', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT']);

const STOP_CONFIRMATION =
  "You've been unsubscribed from Summit Air texts and won't receive further messages. " +
  'Call us anytime if you need service.';

// Repeating fallback for the (mis)configuration case where this route runs
// with no ANTHROPIC_API_KEY set — better than a crash mid-conversation; a
// real deploy always has the key set by Phase 9.
const MISCONFIGURED_FALLBACK_SCRIPT: ScriptedProviderScript = {
  name: 'sms-misconfigured-fallback',
  steps: Array.from({ length: 20 }, () => ({
    type: 'text' as const,
    text: "Thanks for texting Summit Air — we're having a technical issue on our end right now. A dispatcher will follow up with you directly.",
  })),
};

function defaultSmsProviderFactory(): AgentProvider {
  return config.ANTHROPIC_API_KEY
    ? new AnthropicProvider({ apiKey: config.ANTHROPIC_API_KEY, model: config.MODEL_FAST })
    : new ScriptedProvider(MISCONFIGURED_FALLBACK_SCRIPT);
}

function messagingTwiml(body: string): string {
  const twiml = new Twilio.twiml.MessagingResponse();
  twiml.message(body);
  return twiml.toString();
}

function emptyTwiml(): string {
  return new Twilio.twiml.MessagingResponse().toString();
}

export interface RegisterTwilioSmsRouteOptions {
  /** Test seam — production omits this and gets the real Anthropic-vs-fallback decision. */
  providerFactory?: () => AgentProvider;
}

export async function registerTwilioSmsRoute(
  app: FastifyInstance,
  opts: RegisterTwilioSmsRouteOptions = {},
): Promise<void> {
  app.post(
    '/webhooks/twilio-sms',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const authToken = config.TWILIO_AUTH_TOKEN;
      const publicBaseUrl = config.PUBLIC_BASE_URL;
      const sig = req.headers['x-twilio-signature'];
      const params = (req.body ?? {}) as Record<string, string>;

      if (
        !authToken ||
        !publicBaseUrl ||
        typeof sig !== 'string' ||
        !verifyTwilioSignature({
          authToken,
          signatureHeader: sig,
          url: `${publicBaseUrl}/webhooks/twilio-sms`,
          params,
        })
      ) {
        req.log.warn('rejected /webhooks/twilio-sms: bad or missing signature');
        return reply.code(401).send();
      }

      const from = params.From;
      const body = (params.Body ?? '').trim();
      if (!from) {
        return reply.code(400).send();
      }

      if (STOP_KEYWORDS.has(body.toUpperCase())) {
        await setDnc(from);
        req.log.info({ from: redactPhone(from) }, 'SMS opt-out recorded');
        return reply.header('Content-Type', 'text/xml').send(messagingTwiml(STOP_CONFIRMATION));
      }

      const providerFactory = opts.providerFactory ?? defaultSmsProviderFactory;
      const { state, provider } = await getOrCreateSmsThread(from, providerFactory);
      const result = await runTurn(state, body, provider);

      if (!result.assistantReply) {
        // Streaming isn't used on the SMS path — an empty reply means the
        // model produced nothing speakable this turn; better silence than an
        // empty text bubble.
        return reply.header('Content-Type', 'text/xml').send(emptyTwiml());
      }
      return reply.header('Content-Type', 'text/xml').send(messagingTwiml(result.assistantReply));
    },
  );
}
