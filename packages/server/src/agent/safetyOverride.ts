/**
 * The deterministic safety-override *dispatch* sequence — extracted out of
 * agent/loop.ts (IMPLEMENTATION_PLAN Phase 11) so it has exactly one
 * implementation shared by every voice driver, not just the Claude/Retell
 * `runTurn` loop. `runTurn`'s per-turn control flow (build a request, await
 * one model response) is specific to that loop and doesn't carry over to an
 * event-driven adapter like OpenAI Realtime's — but the policy underneath it
 * must not fork: same `flag_emergency` args shape, same directive text,
 * same "already flagged" guard, regardless of which vendor is on the call.
 *
 * Deliberately does *not* own telling the transport to route this turn's
 * output as an interrupt (Retell's `agent_interrupt`, OpenAI Realtime's
 * `response.cancel`/truncate) — that's a real per-vendor wire concern, kept
 * in each transport (see agent/loop.ts's `opts.onSafetyOverrideFired` and,
 * for Realtime, the equivalent hook in transports/openai-realtime).
 */
import { dispatchTool } from '../tools/registry.js';
import { hasAlreadyFlagged } from './caps.js';
import type { ClassifyUrgencyResult } from '../triage/classify.js';
import type { ConversationState, ExecutedToolCall } from './types.js';

export const SAFETY_DIRECTIVE = (emergencyId: unknown): string =>
  '[SAFETY OVERRIDE — SYSTEM INJECTED, NOT CALLER SPEECH]: A gas-hazard indicator was ' +
  `detected on this call. Emergency dispatch has already been notified automatically ` +
  `(reference: ${String(emergencyId)}). Tell the caller now, clearly and calmly, to leave ` +
  'the property immediately, avoid light switches and anything electrical, and call the ' +
  'gas utility or 911 once safely outside. Do not continue with routine booking on this ' +
  'call. Stay on the line, keep them calm, and confirm they are safely out.';

export interface SafetyOverrideOutcome {
  toolCall: ExecutedToolCall;
  /** The text the model must be made to say — null when the `flag_emergency`
   * dispatch itself failed, in which case there's nothing safe to narrate
   * yet (the caller has not actually been protected by anything real). */
  directive: string | null;
  flagged: boolean;
}

/**
 * Auto-fires `flag_emergency` directly (not via the model) and mutates
 * `state.emergencyFlaggedAt`/`emergencyFlagReason` on success — same
 * "the control has already happened by the time the model is even asked"
 * contract agent/loop.ts's docblock describes. Returns `null` when there's
 * nothing to do this call (no override fired, or this conversation already
 * flagged), so a caller can unconditionally invoke this once per turn/event
 * without its own `hasAlreadyFlagged` gate.
 */
export async function fireSafetyOverride(
  state: ConversationState,
  triage: ClassifyUrgencyResult,
): Promise<SafetyOverrideOutcome | null> {
  if (!triage.safetyOverride.fired || hasAlreadyFlagged(state)) return null;

  const reason = triage.safetyOverride.reason;
  const dispatchArgs = {
    call_id: state.externalId,
    phone: state.callerPhone,
    address: state.knownAddressLine ?? 'address not yet given',
    reason,
    notes: 'Auto-flagged by the deterministic safety override, independent of the model.',
  };
  const dispatch = await dispatchTool('flag_emergency', dispatchArgs);
  const result = dispatch.ok ? dispatch.result : { flagged: false, error: dispatch.kind };
  const toolCall: ExecutedToolCall = {
    name: 'flag_emergency',
    modelArgs: {},
    dispatchedArgs: dispatchArgs,
    result,
    isError: !dispatch.ok,
    initiator: 'loop',
  };

  if (!dispatch.ok) return { toolCall, directive: null, flagged: false };

  state.emergencyFlaggedAt = new Date();
  state.emergencyFlagReason = reason;
  return { toolCall, directive: SAFETY_DIRECTIVE(dispatch.result.emergency_id), flagged: true };
}
