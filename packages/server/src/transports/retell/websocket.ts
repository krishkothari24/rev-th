/**
 * Retell Custom LLM WebSocket at `/llm-websocket/:call_id` (IMPLEMENTATION_PLAN
 * Phase 8) — the realtime side of the voice channel. Retell owns STT/TTS/
 * turn-taking; this route just drives `runTurn`/`runReminderTurn` per
 * `response_required`/`reminder_required` event and streams the result back
 * as `response`/`agent_interrupt` frames.
 *
 * One connection per call; per-connection state (the `ConversationState`,
 * the provider, and which "mode" the current turn is streaming in) lives in
 * closure variables rather than a shared map — unlike the SMS transport,
 * there's no cross-connection resumption concern here.
 *
 * Safety-override handling: `runTurn`'s `onSafetyOverrideFired` fires
 * synchronously before any model call for a turn (agent/loop.ts). This route
 * uses that to flip `isSafetyTurn` *before* any deltas for the turn are
 * generated, so the whole turn's deltas — and its final frame — go out as
 * `agent_interrupt` frames instead of normal `response` frames, satisfying
 * "cut in mid-utterance" rather than politely queuing behind Retell's normal
 * turn-taking.
 */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { finalizeConversation, startConversation } from '../../agent/context.js';
import { runReminderTurn, runTurn } from '../../agent/loop.js';
import { AnthropicProvider } from '../../agent/providers/anthropic.js';
import { config, requireEnv } from '../../config.js';
import type { AgentProvider, ConversationState, ExecutedToolCall } from '../../agent/types.js';

interface RetellTranscriptTurn {
  role: 'agent' | 'user';
  content: string;
}

type RetellInboundMessage =
  | {
      interaction_type: 'call_details';
      call: {
        call_id?: string;
        from_number?: string;
        to_number?: string;
        retell_llm_dynamic_variables?: Record<string, unknown>;
      };
    }
  | { interaction_type: 'update_only'; transcript?: RetellTranscriptTurn[] }
  | { interaction_type: 'response_required'; response_id: number; transcript?: RetellTranscriptTurn[] }
  | { interaction_type: 'reminder_required'; response_id: number; transcript?: RetellTranscriptTurn[] }
  | { interaction_type: 'ping_pong'; timestamp: number };

type RetellOutboundFrame =
  | { response_type: 'response'; response_id: number; content: string; content_complete: boolean }
  | {
      response_type: 'agent_interrupt';
      interrupt_id: number;
      content: string;
      content_complete: boolean;
      no_interruption_allowed: true;
    }
  | { response_type: 'tool_call_invocation'; tool_call_id: string; name: string; arguments: string }
  | { response_type: 'tool_call_result'; tool_call_id: string; content: string }
  | { response_type: 'ping_pong'; timestamp: number };

function latestUserUtterance(transcript: RetellTranscriptTurn[] | undefined): string {
  if (!transcript) return '';
  for (let i = transcript.length - 1; i >= 0; i -= 1) {
    if (transcript[i]?.role === 'user') return transcript[i]?.content ?? '';
  }
  return '';
}

export interface RegisterRetellWebsocketRouteOptions {
  /** Test seam — production omits this and gets a real AnthropicProvider on MODEL_VOICE. */
  providerFactory?: () => AgentProvider;
}

function defaultProviderFactory(): AgentProvider {
  return new AnthropicProvider({
    apiKey: requireEnv('ANTHROPIC_API_KEY'),
    model: config.MODEL_VOICE,
  });
}

export async function registerRetellWebsocketRoute(
  app: FastifyInstance,
  opts: RegisterRetellWebsocketRouteOptions = {},
): Promise<void> {
  const providerFactory = opts.providerFactory ?? defaultProviderFactory;

  app.get<{ Params: { call_id: string } }>(
    '/llm-websocket/:call_id',
    { websocket: true, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    (socket, req: FastifyRequest<{ Params: { call_id: string } }>) => {
      const callId = req.params.call_id;
      let state: ConversationState | null = null;
      let provider: AgentProvider | null = null;
      let isSafetyTurn = false;
      let interruptId = 0;

      function send(frame: RetellOutboundFrame): void {
        socket.send(JSON.stringify(frame));
      }

      function sendToolFrames(call: ExecutedToolCall): void {
        const toolCallId = randomUUID();
        send({
          response_type: 'tool_call_invocation',
          tool_call_id: toolCallId,
          name: call.name,
          arguments: JSON.stringify(call.dispatchedArgs),
        });
        send({ response_type: 'tool_call_result', tool_call_id: toolCallId, content: JSON.stringify(call.result) });
      }

      function sendFinalFrame(responseId: number): void {
        if (isSafetyTurn) {
          send({
            response_type: 'agent_interrupt',
            interrupt_id: interruptId,
            content: '',
            content_complete: true,
            no_interruption_allowed: true,
          });
        } else {
          send({ response_type: 'response', response_id: responseId, content: '', content_complete: true });
        }
      }

      function onDelta(responseId: number, delta: string): void {
        if (isSafetyTurn) {
          send({
            response_type: 'agent_interrupt',
            interrupt_id: interruptId,
            content: delta,
            content_complete: false,
            no_interruption_allowed: true,
          });
        } else {
          send({ response_type: 'response', response_id: responseId, content: delta, content_complete: false });
        }
      }

      async function handleMessage(msg: RetellInboundMessage): Promise<void> {
        switch (msg.interaction_type) {
          case 'call_details': {
            state = await startConversation({
              channel: 'voice',
              externalId: callId,
              callerPhone: msg.call.from_number ?? 'unknown',
            });
            provider = providerFactory();
            req.log.info({ callId }, 'retell ws: call_details received');
            return;
          }
          case 'ping_pong': {
            send({ response_type: 'ping_pong', timestamp: msg.timestamp });
            return;
          }
          case 'update_only': {
            return; // transcript display sync only — nothing to act on
          }
          case 'response_required': {
            if (!state || !provider) return;
            isSafetyTurn = false;
            const responseId = msg.response_id;
            const utterance = latestUserUtterance(msg.transcript);
            const result = await runTurn(state, utterance, provider, {
              onAssistantTextDelta: (delta) => onDelta(responseId, delta),
              onSafetyOverrideFired: () => {
                isSafetyTurn = true;
                interruptId += 1;
              },
            });
            for (const call of result.toolCalls) sendToolFrames(call);
            sendFinalFrame(responseId);
            return;
          }
          case 'reminder_required': {
            if (!state || !provider) return;
            const responseId = msg.response_id;
            const result = await runReminderTurn(state, provider, {
              onAssistantTextDelta: (delta) => onDelta(responseId, delta),
            });
            for (const call of result.toolCalls) sendToolFrames(call);
            sendFinalFrame(responseId);
            return;
          }
          default:
            req.log.warn({ msg }, 'retell ws: unrecognized interaction_type');
        }
      }

      socket.on('message', (raw: Buffer) => {
        let msg: RetellInboundMessage;
        try {
          msg = JSON.parse(raw.toString('utf-8'));
        } catch {
          req.log.warn('retell ws: malformed frame, ignoring');
          return;
        }
        handleMessage(msg).catch((err: unknown) => {
          req.log.error({ err }, 'retell ws: error handling frame');
        });
      });

      socket.on('close', () => {
        if (!state) return;
        finalizeConversation(state).catch((err: unknown) => {
          req.log.error({ err }, 'retell ws: finalize on close failed');
        });
      });
    },
  );
}
