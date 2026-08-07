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

// Observability, not correctness — same reasoning and the same
// `[latency]`-prefixed, console-based, threshold-only pattern as
// `agent/providers/anthropic.ts`'s `SLOW_FIRST_TOKEN_MS`. This path had zero
// latency instrumentation until now (nothing to grep if choppiness resurfaces
// after the turn_detection fix in client.ts); this measures the gap between
// the caller finishing speaking (`input_audio_buffer.speech_stopped`) and the
// agent starting its next response (`response.created`) — the turn-taking
// latency a caller actually feels as a pause or a cut-off.
const SLOW_TURN_START_MS = 1200;

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
  /** Realtime rejects a `response.create` sent while another response is
   * still active (`conversation_already_has_active_response`) — observed on
   * a real call where the tool-result confirmation and the safety-interrupt
   * directive both raced an in-flight response and were silently dropped by
   * the server (logged as a socket-level `error` event, invisible to the
   * caller as anything but dead air / a stalled turn). Every call site that
   * wants a new turn goes through `requestResponse()` instead of sending
   * `response.create` directly; if one is already active, the request is
   * deferred until `response.done`/`response.cancelled` confirms it's clear. */
  let responseCreatePending = false;
  /** Set on `input_audio_buffer.speech_stopped`, read (and cleared) on the
   * next `response.created` — see `SLOW_TURN_START_MS` above. */
  let lastSpeechStoppedAt: number | null = null;

  function requestResponse(): void {
    if (activeResponseId) {
      responseCreatePending = true;
      return;
    }
    send(socket, { type: 'response.create' });
  }

  function clearActiveResponse(): void {
    activeResponseId = null;
    if (responseCreatePending) {
      responseCreatePending = false;
      send(socket, { type: 'response.create' });
    }
  }

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
    // `session` requires its own `type` discriminator (same 'realtime' value
    // as the accept() body) — omitting it errors every single call with
    // `missing_required_parameter: session.type` (confirmed against a real
    // call's server `error` event), which meant mid-call instruction
    // updates — refreshed customer context, triage state — were silently
    // failing on every real call since accept()'s payload shape changed.
    send(socket, { type: 'session.update', session: { type: 'realtime', instructions: next } });
  }

  async function forceEmergencyInterrupt(directive: string): Promise<void> {
    if (activeResponseId) {
      send(socket, { type: 'response.cancel', response_id: activeResponseId });
      // Deliberately does not also send `conversation.item.truncate` to trim
      // already-buffered output audio. Confirmed against OpenAI's Realtime
      // docs (not assumed): "In WebRTC and SIP connections the server
      // manages a buffer of output audio, and thus knows how much audio has
      // been played at a given moment. The server will automatically
      // truncate unplayed audio when there's a user interruption." This
      // call is SIP-trunked end to end (client.ts / docs/PHASE_11_RUNBOOK.md)
      // — the truncation this comment used to flag as an open gap is already
      // handled server-side. `response.cancel` above is still needed (it
      // stops the *generation*, which the server's auto-truncate doesn't do
      // on its own); nothing further to add here.
    }
    send(socket, {
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: directive }],
      },
    });
    // `requestResponse`, not a raw `response.create` — the `response.cancel`
    // above is a request, not a confirmation; the response it targets is
    // still nominally active until the server's own `response.cancelled`
    // event lands. Sending `response.create` unconditionally right after,
    // as this used to, raced that in-flight cancel and got rejected with
    // `conversation_already_has_active_response` on a real call, which
    // silently ate the forced safety directive's spoken turn — the one
    // path in this file that's actually safety-critical.
    requestResponse();
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
    requestResponse();
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
      case 'input_audio_buffer.speech_stopped': {
        lastSpeechStoppedAt = Date.now();
        return;
      }
      case 'response.created': {
        const response = event.response as { id?: string } | undefined;
        activeResponseId = response?.id ?? null;
        if (lastSpeechStoppedAt !== null) {
          const gapMs = Date.now() - lastSpeechStoppedAt;
          lastSpeechStoppedAt = null;
          if (gapMs > SLOW_TURN_START_MS) {
            console.warn(`[latency] slow turn start: ${gapMs}ms (callId=${state.externalId})`);
          }
        }
        return;
      }
      case 'response.cancelled': {
        clearActiveResponse();
        return;
      }
      case 'response.done': {
        clearActiveResponse();
        const response = event.response as
          | { status?: string; status_details?: unknown }
          | undefined;
        if (response?.status && response.status !== 'completed') {
          // Not fatal to the call — the session stays open — but a response
          // that failed/was incomplete is exactly the kind of thing that
          // silently degrades the conversation without any caller-visible
          // signal (see this session's own accept/connect debugging: the
          // API tends to fail quietly rather than loudly). Surface it.
          console.error('[openai-realtime] response finished abnormally', {
            callId: state.externalId,
            status: response.status,
            statusDetails: response.status_details,
          });
        }
        return;
      }
      // The Realtime API reports malformed client events, invalid tool
      // calls, and server-side failures via a distinct `error` event rather
      // than closing the socket — dropped silently before this, which is
      // exactly the kind of thing that would have hidden the real cause of
      // this session's accept/connect bug for even longer. Always surface
      // it; it's never a normal-path event.
      case 'error': {
        console.error('[openai-realtime] server error event', {
          callId: state.externalId,
          error: event.error,
        });
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
  requestResponse();

  socket.on('close', () => {
    finalizeConversation(state).catch((err: unknown) => {
      console.error('[openai-realtime] finalize on close failed', err);
    });
  });
}
