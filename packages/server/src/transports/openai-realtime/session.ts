/**
 * OpenAI Realtime session event loop (IMPLEMENTATION_PLAN Phase 11,
 * BUILD_GUIDE §12) — the realtime side of the voice channel once a call has
 * been accepted (webhook.ts) and its WebSocket connected. OpenAI's own
 * Realtime model owns turn-taking, TTS, and deciding when to call a tool
 * once `instructions`/`tools` are configured (see client.ts's `acceptCall`)
 * — this is **not** the Custom-LLM shape `agent/loop.ts` drives for Retell,
 * where our backend generates every reply. There is no discrete "send
 * request, get one response" cycle to hook `runTurn` into, so this module
 * reimplements the same *policy* `runTurn` enforces — driven by Realtime's
 * event stream instead — reusing every shared building block rather than
 * forking it:
 *
 *   - `triage/classify.ts` for the deterministic safety override (identical
 *     module, third consumer after voice/Claude and SMS/Haiku)
 *   - `agent/safetyOverride.ts`'s `fireSafetyOverride` for the auto-dispatch
 *     + directive text (same function `agent/loop.ts` calls)
 *   - `agent/serverOwnedFields.ts`/`agent/caps.ts` for the model-proposes/
 *     server-disposes tool-argument overrides and per-conversation caps
 *   - `agent/sideEffects.ts` for keeping `ConversationState`'s derived
 *     fields in sync
 *   - `tools/registry.ts`'s `dispatchTool` — the same in-process path
 *     `routes.ts` and `agent/loop.ts` both use, so idempotency and dashboard
 *     fanout (which the individual tool services publish themselves) are
 *     unchanged by which vendor is on the call
 *
 * Event/field names below (`conversation.item.input_audio_transcription.
 * completed`, `response.function_call_arguments.done`, `response.created`)
 * are per OpenAI's current Realtime docs as of this migration's research
 * pass — re-verify against real traffic before Phase 11 step 4 (accounts).
 */
import type { RawData, default as WebSocket } from 'ws';
import { classifyUrgency } from '../../triage/classify.js';
import { detectVulnerablePerson } from '../../triage/vulnerability.js';
import { dispatchTool } from '../../tools/registry.js';
import { eventBus } from '../../events/bus.js';
import { finalizeConversation } from '../../agent/context.js';
import { buildSystemPromptForTurn } from '../../agent/prompts.js';
import { fireSafetyOverride } from '../../agent/safetyOverride.js';
import { applySideEffects } from '../../agent/sideEffects.js';
import { applyServerOwnedOverrides } from '../../agent/serverOwnedFields.js';
import { hasAlreadyFlagged, isBookingCapExceeded } from '../../agent/caps.js';
import { ROUTINE_NO_OVERRIDE_TRIAGE } from '../../agent/loop.js';
import type { ConversationState } from '../../agent/types.js';

function send(socket: WebSocket, frame: Record<string, unknown>): void {
  socket.send(JSON.stringify(frame));
}

/**
 * Drives one call's session for as long as `socket` stays open. Fire-and-
 * forget from the caller's perspective (webhook.ts) — everything happens
 * off event handlers; `finalizeConversation` fires on `close`, mirroring
 * `retell/websocket.ts`'s own `close` handler.
 */
export function runRealtimeSession(
  state: ConversationState,
  socket: WebSocket,
  initialInstructions: string,
): void {
  let lastPushedInstructions = initialInstructions;
  /** Tracks whether a response is currently being generated, so a forced
   * safety interrupt knows whether there's anything to `response.cancel`. */
  let activeResponseId: string | null = null;

  // Serializes event handling in arrival order — classifyUrgency and tool
  // dispatch are both async, and two events landing close together must not
  // interleave (transcript accumulation order feeds the safety override).
  let queue: Promise<void> = Promise.resolve();
  function enqueue(fn: () => Promise<void>): void {
    queue = queue.then(fn).catch((err: unknown) => {
      console.error('[openai-realtime] event handling failed', err);
    });
  }

  async function pushInstructionsIfChanged(): Promise<void> {
    const next = buildSystemPromptForTurn(state);
    if (next === lastPushedInstructions) return;
    lastPushedInstructions = next;
    send(socket, { type: 'session.update', session: { instructions: next } });
  }

  async function forceEmergencyInterrupt(directive: string): Promise<void> {
    if (activeResponseId) {
      send(socket, { type: 'response.cancel', response_id: activeResponseId });
      // Deliberately does not also send `conversation.item.truncate` to trim
      // already-buffered output audio — that needs the active item id/
      // content index, which isn't tracked yet (would come off
      // `response.output_item.added`). The actual safety control —
      // `flag_emergency` — has already been dispatched by
      // `fireSafetyOverride` before this function ever runs, independent of
      // anything on this socket; what's imperfect here is at most a
      // fraction of a second of already-buffered audio finishing before the
      // forced directive starts, not the control itself. Close this gap
      // before Phase 11 step 6's live safety re-test.
    }
    send(socket, {
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: directive }],
      },
    });
    send(socket, { type: 'response.create' });
  }

  async function handleCallerTranscript(text: string): Promise<void> {
    state.transcriptAccumulator = state.transcriptAccumulator
      ? `${state.transcriptAccumulator}\n${text}`
      : text;

    const triage = await classifyUrgency(
      {
        transcript: state.transcriptAccumulator,
        statedIssue: state.transcriptAccumulator,
        vulnerablePersonPresent: detectVulnerablePerson(state.transcriptAccumulator),
        season: state.season,
        propertyType: state.propertyType ?? 'residential',
      },
      { hazardCheckProvider: state.hazardCheckProvider },
    );
    state.lastTriage = triage;
    eventBus.publish({
      type: 'triage.updated',
      callId: state.externalId,
      urgency: triage.urgency,
      requiredSkills: triage.requiredSkills,
    });

    if (triage.safetyOverride.fired && !hasAlreadyFlagged(state)) {
      const outcome = await fireSafetyOverride(state, triage);
      if (outcome?.flagged && outcome.directive) {
        await forceEmergencyInterrupt(outcome.directive);
        return;
      }
    }

    await pushInstructionsIfChanged();
  }

  async function sendFunctionResult(
    toolCallId: string,
    result: Record<string, unknown>,
  ): Promise<void> {
    send(socket, {
      type: 'conversation.item.create',
      item: { type: 'function_call_output', call_id: toolCallId, output: JSON.stringify(result) },
    });
    send(socket, { type: 'response.create' });
  }

  // NOTE: `toolCallId` here is OpenAI's function-call routing id — a
  // different value from `state.externalId` (the SIP call_id this whole
  // session is keyed on). Easy to conflate since both are called "call_id"
  // in their respective event payloads; kept as distinctly-named locals
  // throughout this file on purpose.
  async function handleFunctionCall(
    toolCallId: string,
    name: string,
    argumentsJson: string,
  ): Promise<void> {
    let modelArgs: Record<string, unknown> = {};
    try {
      modelArgs = JSON.parse(argumentsJson) as Record<string, unknown>;
    } catch {
      // Malformed tool-call JSON from the model — dispatch with an empty
      // object and let Zod reject it at the boundary, same failure mode as
      // any other invalid tool call (routes.ts, agent/loop.ts).
    }

    const withCallId = { ...modelArgs, call_id: state.externalId };
    const triage = state.lastTriage ?? ROUTINE_NO_OVERRIDE_TRIAGE;
    const dispatchedArgs = applyServerOwnedOverrides(name, withCallId, triage);

    if (name === 'book_appointment' && isBookingCapExceeded(state)) {
      await sendFunctionResult(toolCallId, {
        booked: false,
        note: "We've booked as much as I can on this call — let's get a dispatcher to help with anything else.",
      });
      return;
    }
    if (name === 'flag_emergency' && hasAlreadyFlagged(state)) {
      await sendFunctionResult(toolCallId, {
        flagged: true,
        already_flagged: true,
        message: 'This call is already flagged as an emergency — dispatch has been notified.',
      });
      return;
    }

    const dispatch = await dispatchTool(name, dispatchedArgs);
    if (dispatch.ok) {
      applySideEffects(state, name, dispatchedArgs, dispatch.result);
      await sendFunctionResult(toolCallId, dispatch.result);
    } else {
      await sendFunctionResult(toolCallId, dispatch as unknown as Record<string, unknown>);
    }
  }

  socket.on('message', (raw: RawData) => {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(raw.toString());
    } catch {
      return; // malformed frame — nothing to act on
    }

    switch (event.type) {
      case 'response.created': {
        const response = event.response as { id?: string } | undefined;
        activeResponseId = response?.id ?? null;
        return;
      }
      case 'response.done':
      case 'response.cancelled': {
        activeResponseId = null;
        return;
      }
      case 'conversation.item.input_audio_transcription.completed': {
        const transcript = typeof event.transcript === 'string' ? event.transcript : '';
        if (transcript) enqueue(() => handleCallerTranscript(transcript));
        return;
      }
      case 'response.function_call_arguments.done': {
        const toolCallId = typeof event.call_id === 'string' ? event.call_id : '';
        const name = typeof event.name === 'string' ? event.name : '';
        const argumentsJson = typeof event.arguments === 'string' ? event.arguments : '{}';
        if (toolCallId && name) enqueue(() => handleFunctionCall(toolCallId, name, argumentsJson));
        return;
      }
      default:
        return;
    }
  });

  // Per OpenAI's Realtime-SIP docs, nothing greets the caller automatically
  // — the model only speaks once something sends `response.create`. Without
  // this, a real call connects successfully (WS open, session live) and
  // then just sits in silence forever: the caller waits for the agent to
  // speak first, the agent waits for the caller, neither side ever sends
  // anything, and there's no timeout to break the deadlock. Fire the
  // opening turn ourselves as soon as the session is live; `instructions`
  // (set at accept()) already cover the greeting behavior, so this just
  // needs to trigger a response, not restate what to say.
  send(socket, { type: 'response.create' });

  socket.on('close', () => {
    finalizeConversation(state).catch((err: unknown) => {
      console.error('[openai-realtime] finalize on close failed', err);
    });
  });
}
