/**
 * Shared types for the channel-agnostic agent loop (BUILD_GUIDE §1: "Retell
 * owns the realtime audio loop; we own all business logic" — one loop serves
 * voice, SMS, the simulator, and (Phase 5) the eval suite). The provider
 * surface (`ContentBlock`/`ProviderMessage`/`AgentProvider`) is deliberately
 * independent of `@anthropic-ai/sdk` so `ScriptedProvider` has zero
 * dependency on it; `AnthropicProvider` is what translates to/from these
 * shapes and the real SDK types.
 */
import type { Channel, EmergencyReason, MembershipTier, PropertyType } from '../db/schema.js';
import type { County } from '../domain/constants.js';
import type { Season } from '../domain/season.js';
import type { ClassifyUrgencyResult } from '../triage/classify.js';
import type { HazardCheckProvider } from '../triage/hazardCheck.js';

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };

export interface ProviderMessage {
  role: 'user' | 'assistant';
  content: ContentBlock[];
}

export interface ToolSpec {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface ProviderRequest {
  systemPrompt: string;
  messages: ProviderMessage[];
  tools: ToolSpec[];
}

export type ProviderStopReason = 'end_turn' | 'tool_use' | 'max_tokens';

export interface ProviderResponse {
  /** Text and/or tool_use blocks only — a provider never returns tool_result. */
  content: ContentBlock[];
  stopReason: ProviderStopReason;
}

/** Invoked with each incremental piece of assistant-generated *text* (never
 * tool-input JSON) as a provider produces it. Purely additive: a caller that
 * omits it gets today's request/response behavior unchanged — see
 * agent/providers/anthropic.ts and agent/providers/scripted.ts. */
export type OnAssistantTextDelta = (delta: string) => void;

export interface AgentProvider {
  send(request: ProviderRequest, onTextDelta?: OnAssistantTextDelta): Promise<ProviderResponse>;
}

export interface ExecutedToolCall {
  name: string;
  /** What the model's tool_use block actually contained, before any
   * server-owned-field override — kept for observability even though it's
   * never trusted (see agent/serverOwnedFields.ts). */
  modelArgs: Record<string, unknown>;
  /** What was actually sent to dispatchTool, after overrides/injection. */
  dispatchedArgs: Record<string, unknown>;
  result: Record<string, unknown>;
  isError: boolean;
  /** 'model' = the model itself emitted this tool_use block; 'loop' = the
   * loop dispatched it directly, independent of the model (currently only
   * the safety-override auto-fire — see agent/loop.ts). */
  initiator: 'model' | 'loop';
  /** True when a cap (booking limit, already-flagged) short-circuited the
   * real service and this result was synthesized instead of executed. */
  intercepted?: boolean;
}

export interface TurnResult {
  assistantReply: string;
  toolCalls: ExecutedToolCall[];
  safetyOverrideFired: boolean;
  emergencyFlaggedThisTurn: boolean;
}

export interface ConversationState {
  externalId: string;
  channel: Channel;
  conversationDbId: string;
  /** Known immediately at conversation start (ANI for voice, the From number
   * for SMS, operator-entered in the sim) — never derived from the model. */
  callerPhone: string;
  knownName: string | null;
  knownAddressLine: string | null;
  knownCity: string | null;
  knownCounty: County | null;
  propertyType: PropertyType | null;
  /** True once the call-start `customer_lookup` dispatch has been attempted
   * (found or not) — gates it to fire at most once per conversation. See
   * agent/loop.ts's runTurn. */
  customerLookupAttempted: boolean;
  /** The speakable `summary` string from a successful call-start
   * `customer_lookup`, reused as-is in the prompt appendix (BUILD_GUIDE §3:
   * inject a pre-rendered summary, not the raw record) — null when the
   * caller isn't recognized. */
  recognizedCustomerSummary: string | null;
  /** From the same lookup — drives the membership-upsell permission line in
   * the prompt appendix (see agent/prompts.ts). Null for an unrecognized
   * caller, not the same as `'basic'`. */
  knownMembershipTier: MembershipTier | null;
  season: Season;
  messages: ProviderMessage[];
  /** Caller-sourced text only. Assistant replies and injected directives
   * never feed this accumulator, so nothing but the caller's own words can
   * gate the safety override (mirrors triage/classify.ts's own contract that
   * a model-summarized field must never gate safety). */
  transcriptAccumulator: string;
  lastTriage: ClassifyUrgencyResult | null;
  emergencyFlaggedAt: Date | null;
  emergencyFlagReason: EmergencyReason | null;
  bookingsCount: number;
  transferRequested: boolean;
  hazardCheckProvider: HazardCheckProvider;
  /** Test/live-hardening hook only — unset in normal operation. When set,
   * the loop uses this instead of the file loaded from prompts/. This is
   * exactly the seam the sabotage test uses to run with the safety section
   * stripped out. */
  systemPromptOverride?: string;
  startedAt: Date;
}
