/**
 * Call-start `customer_lookup` (IMPLEMENTATION_PLAN Phase 6/11, BUILD_GUIDE
 * §3) — extracted out of agent/loop.ts's `runTurn` so it has one
 * implementation shared by every voice driver. Fires at most once per
 * conversation (`state.customerLookupAttempted` gates it), before any caller
 * utterance is even recorded, so a known customer's propertyType/membership
 * are already in state by the time triage — and, for the OpenAI Realtime
 * adapter, the accept-time `instructions` string — are built.
 *
 * Code-initiated, not the model's decision — same shape as the
 * safety-override auto-fire (agent/safetyOverride.ts).
 */
import { dispatchTool } from '../tools/registry.js';
import { applySideEffects } from './sideEffects.js';
import type { ConversationState, ExecutedToolCall } from './types.js';

/** Returns the executed `customer_lookup` call, or `null` if one was already
 * attempted on this conversation (repeat calls are a no-op, not an error). */
export async function runCallStartRecognition(
  state: ConversationState,
): Promise<ExecutedToolCall | null> {
  if (state.customerLookupAttempted) return null;
  state.customerLookupAttempted = true;

  const dispatchArgs = { call_id: state.externalId, phone: state.callerPhone };
  const dispatch = await dispatchTool('customer_lookup', dispatchArgs);
  const result = dispatch.ok ? dispatch.result : { found: false, error: dispatch.kind };
  if (dispatch.ok) applySideEffects(state, 'customer_lookup', dispatchArgs, dispatch.result);

  return {
    name: 'customer_lookup',
    modelArgs: {},
    dispatchedArgs: dispatchArgs,
    result,
    isError: !dispatch.ok,
    initiator: 'loop',
  };
}
