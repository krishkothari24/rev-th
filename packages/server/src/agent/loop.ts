/**
 * The channel-agnostic conversation loop — BUILD_GUIDE §1/§5, IMPLEMENTATION_PLAN
 * Phase 4. `runTurn` is the one function voice, SMS, the simulator, and
 * (Phase 5) the eval suite all drive. Per turn:
 *
 *   1. Record the caller's utterance (user-role message + transcript accumulator).
 *   2. Run `classifyUrgency` on the accumulated *caller-sourced* transcript,
 *      before any model call — safety is decided in code, not by the model.
 *   3. If the safety override fires, dispatch `flag_emergency` directly (not
 *      via the model) and inject a narration-only directive so the model
 *      says the right things — the control itself already happened by the
 *      time the model is even asked.
 *   4. Round-trip with the model (bounded by MAX_TOOL_ROUNDS_PER_TURN),
 *      applying server-owned-field overrides and cap checks before every
 *      tool dispatch.
 *
 * This is what makes the sabotage test (test/agent/sabotage.test.ts) a real
 * proof: step 3 does not depend on the model reading or obeying anything.
 *
 * Step 2 also publishes `triage.updated` on the event bus every turn — the
 * dashboard's live-call banner (IMPLEMENTATION_PLAN Phase 7) reads urgency
 * off this, not off any model output, same trust boundary as everything else
 * triage decides.
 */
import { classifyUrgency } from '../triage/classify.js';
import { detectVulnerablePerson } from '../triage/vulnerability.js';
import { dispatchTool, getAnthropicToolDefinitions } from '../tools/registry.js';
import { eventBus } from '../events/bus.js';
import { runCallStartRecognition } from './callStartRecognition.js';
import { applyServerOwnedOverrides } from './serverOwnedFields.js';
import { applySideEffects } from './sideEffects.js';
import { buildSystemPromptForTurn } from './prompts.js';
import { fireSafetyOverride } from './safetyOverride.js';
import { hasAlreadyFlagged, isBookingCapExceeded } from './caps.js';
import type { EmergencyReason } from '../db/schema.js';
import type { ClassifyUrgencyResult } from '../triage/classify.js';
import type {
  AgentProvider,
  ContentBlock,
  ConversationState,
  ExecutedToolCall,
  OnAssistantTextDelta,
  ProviderRequest,
  TurnResult,
} from './types.js';

/** Hard circuit breaker — a misbehaving live model must not loop forever
 * against a paid API. On hitting this, the loop stops calling the model
 * entirely and returns a safe fallback reply rather than a 5th round-trip. */
export const MAX_TOOL_ROUNDS_PER_TURN = 4;

const REMINDER_DIRECTIVE =
  '[SYSTEM REMINDER — NOT CALLER SPEECH]: The caller has gone quiet. Briefly check in or offer ' +
  'to continue; do not restate everything already covered.';

/** Used by `runReminderTurn` when a reminder fires before the caller has said
 * anything yet this conversation (`state.lastTriage` is still null) — a
 * neutral, non-firing triage so the model-round helper has something to pass
 * to `applyServerOwnedOverrides` without running a fresh classification (a
 * reminder carries no new caller speech, so there's nothing to classify).
 * Exported for the same reason (IMPLEMENTATION_PLAN Phase 11): the OpenAI
 * Realtime adapter's function-call handler needs an identical "nothing
 * classified yet" fallback for a tool call that arrives before any caller
 * transcript has landed. */
export const ROUTINE_NO_OVERRIDE_TRIAGE: ClassifyUrgencyResult = {
  urgency: 'routine',
  requiredSkills: [],
  safetyOverride: { fired: false },
};

export interface RunTurnOptions {
  /** Forwarded to the provider on every model round this turn — see
   * agent/types.ts's `OnAssistantTextDelta` docblock. */
  onAssistantTextDelta?: OnAssistantTextDelta;
  /** Fires synchronously the moment the deterministic safety override trips
   * for this turn — before any model call is made. A transport (the Retell
   * WS route) uses this to decide, ahead of generation, to route this turn's
   * deltas as an `agent_interrupt` rather than a normal `response` frame,
   * rather than only finding out after the whole turn (including
   * generation) has already completed via `TurnResult.safetyOverrideFired`. */
  onSafetyOverrideFired?: (reason: EmergencyReason) => void;
}

export async function runTurn(
  state: ConversationState,
  callerUtterance: string,
  provider: AgentProvider,
  opts: RunTurnOptions = {},
): Promise<TurnResult> {
  const toolCalls: ExecutedToolCall[] = [];

  // Call-start recognition (IMPLEMENTATION_PLAN Phase 6/11, BUILD_GUIDE §3):
  // fires at most once per conversation, before the caller's first utterance
  // is even recorded, so a known customer's propertyType/membership are
  // already in state by the time triage and the model run on turn one. This
  // is code-initiated, not the model's decision — same shape as the
  // safety-override auto-fire below.
  const recognitionCall = await runCallStartRecognition(state);
  if (recognitionCall) toolCalls.push(recognitionCall);

  appendUserText(state, callerUtterance);
  state.transcriptAccumulator = state.transcriptAccumulator
    ? `${state.transcriptAccumulator}\n${callerUtterance}`
    : callerUtterance;

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

  const safetyOverrideFired = triage.safetyOverride.fired;
  let emergencyFlaggedThisTurn = false;

  if (triage.safetyOverride.fired && !hasAlreadyFlagged(state)) {
    opts.onSafetyOverrideFired?.(triage.safetyOverride.reason);
    const outcome = await fireSafetyOverride(state, triage);
    if (outcome) {
      toolCalls.push(outcome.toolCall);
      if (outcome.flagged && outcome.directive) {
        emergencyFlaggedThisTurn = true;
        appendUserText(state, outcome.directive);
      }
    }
  }

  const rounds = await runModelRounds(state, provider, triage, opts);
  toolCalls.push(...rounds.toolCalls);
  emergencyFlaggedThisTurn = emergencyFlaggedThisTurn || rounds.emergencyFlaggedThisTurn;

  return {
    assistantReply: rounds.finalText,
    toolCalls,
    safetyOverrideFired,
    emergencyFlaggedThisTurn,
  };
}

/**
 * Retell's `reminder_required` (the caller has gone quiet) has no new caller
 * utterance to feed `runTurn` — and must not touch `transcriptAccumulator`,
 * whose contract (see `ConversationState`) is caller-sourced text only, since
 * that's what gates the safety override. Injects a system-authored,
 * non-caller `user`-role message (same pattern as `SAFETY_DIRECTIVE`) and
 * reuses whatever triage already ran on this conversation rather than
 * running a fresh `classifyUrgency` — nothing new was said, so there's
 * nothing new to classify, and no `triage.updated` republish.
 */
export async function runReminderTurn(
  state: ConversationState,
  provider: AgentProvider,
  opts: RunTurnOptions = {},
): Promise<TurnResult> {
  appendUserText(state, REMINDER_DIRECTIVE);
  const triage = state.lastTriage ?? ROUTINE_NO_OVERRIDE_TRIAGE;
  const rounds = await runModelRounds(state, provider, triage, opts);
  return {
    assistantReply: rounds.finalText,
    toolCalls: rounds.toolCalls,
    safetyOverrideFired: false,
    emergencyFlaggedThisTurn: rounds.emergencyFlaggedThisTurn,
  };
}

interface ModelRoundsResult {
  finalText: string;
  toolCalls: ExecutedToolCall[];
  emergencyFlaggedThisTurn: boolean;
}

/**
 * The bounded model round-trip loop (BUILD_GUIDE §5, capped by
 * `MAX_TOOL_ROUNDS_PER_TURN`) — extracted out of `runTurn` so both it and
 * `runReminderTurn` share one implementation. Takes the turn's
 * already-computed `triage` (a reminder reuses the conversation's last real
 * one rather than classifying anything new) and threads
 * `opts.onAssistantTextDelta` through every `provider.send()` call this turn
 * may make — purely additive over the non-streaming path when omitted.
 */
async function runModelRounds(
  state: ConversationState,
  provider: AgentProvider,
  triage: ClassifyUrgencyResult,
  opts: RunTurnOptions,
): Promise<ModelRoundsResult> {
  const toolCalls: ExecutedToolCall[] = [];
  let emergencyFlaggedThisTurn = false;
  let finalText = '';

  for (let round = 0; round < MAX_TOOL_ROUNDS_PER_TURN; round += 1) {
    const request: ProviderRequest = {
      systemPrompt: buildSystemPromptForTurn(state),
      messages: state.messages,
      tools: getAnthropicToolDefinitions(),
    };
    const response = await provider.send(request, opts.onAssistantTextDelta);
    state.messages.push({ role: 'assistant', content: response.content });

    finalText = textOf(response.content) || finalText;
    if (response.stopReason === 'max_tokens') {
      // A truncated tool call or reply is a real prompt/latency issue worth
      // noticing, not silently swallowing.
      console.warn(
        `[agent] provider response truncated at max_tokens (call_id=${state.externalId})`,
      );
    }

    if (response.stopReason !== 'tool_use') break;

    const toolUseBlocks = response.content.filter(
      (block): block is Extract<ContentBlock, { type: 'tool_use' }> => block.type === 'tool_use',
    );
    const resultBlocks: ContentBlock[] = [];

    for (const block of toolUseBlocks) {
      const withCallId = { ...block.input, call_id: state.externalId };
      const dispatchedArgs = applyServerOwnedOverrides(block.name, withCallId, triage);

      if (block.name === 'book_appointment' && isBookingCapExceeded(state)) {
        const synthetic = {
          booked: false,
          note: "We've booked as much as I can on this call — let's get a dispatcher to help with anything else.",
        };
        toolCalls.push({
          name: block.name,
          modelArgs: block.input,
          dispatchedArgs,
          result: synthetic,
          isError: false,
          initiator: 'model',
          intercepted: true,
        });
        resultBlocks.push(toolResultBlock(block.id, synthetic, false));
        continue;
      }

      if (block.name === 'flag_emergency' && hasAlreadyFlagged(state)) {
        const synthetic = {
          flagged: true,
          already_flagged: true,
          message: 'This call is already flagged as an emergency — dispatch has been notified.',
        };
        toolCalls.push({
          name: block.name,
          modelArgs: block.input,
          dispatchedArgs,
          result: synthetic,
          isError: false,
          initiator: 'model',
          intercepted: true,
        });
        resultBlocks.push(toolResultBlock(block.id, synthetic, false));
        continue;
      }

      const dispatch = await dispatchTool(block.name, dispatchedArgs);
      if (dispatch.ok) {
        toolCalls.push({
          name: block.name,
          modelArgs: block.input,
          dispatchedArgs,
          result: dispatch.result,
          isError: false,
          initiator: 'model',
        });
        resultBlocks.push(toolResultBlock(block.id, dispatch.result, false));
        applySideEffects(state, block.name, dispatchedArgs, dispatch.result);
        if (block.name === 'flag_emergency' && dispatch.result.flagged === true) {
          emergencyFlaggedThisTurn = emergencyFlaggedThisTurn || !dispatch.result.already_flagged;
        }
      } else {
        toolCalls.push({
          name: block.name,
          modelArgs: block.input,
          dispatchedArgs,
          result: dispatch as unknown as Record<string, unknown>,
          isError: true,
          initiator: 'model',
        });
        resultBlocks.push(toolResultBlock(block.id, dispatch, true));
      }
    }

    state.messages.push({ role: 'user', content: resultBlocks });

    if (round === MAX_TOOL_ROUNDS_PER_TURN - 1) {
      // Circuit breaker: never make a 5th model call. Stop and hand back a
      // safe fallback instead of looping indefinitely against a live model.
      console.warn(`[agent] MAX_TOOL_ROUNDS_PER_TURN hit (call_id=${state.externalId})`);
      finalText = 'Let me get a dispatcher on the line to finish this up for you.';
    }
  }

  return { finalText, toolCalls, emergencyFlaggedThisTurn };
}

function appendUserText(state: ConversationState, text: string): void {
  state.messages.push({ role: 'user', content: [{ type: 'text', text }] });
}

function textOf(content: ContentBlock[]): string {
  return content
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join(' ')
    .trim();
}

function toolResultBlock(
  toolUseId: string,
  result: Record<string, unknown>,
  isError: boolean,
): ContentBlock {
  return {
    type: 'tool_result',
    tool_use_id: toolUseId,
    content: JSON.stringify(result),
    is_error: isError,
  };
}

