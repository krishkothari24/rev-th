/**
 * Conversation lifecycle — creates/finalizes the `conversations` row a
 * `ConversationState` is tied to, resolves season and the hazard-check
 * provider, and enforces the per-phone rate limit before a conversation
 * starts. Deliberately separate from agent/loop.ts: loop.ts stays focused on
 * message/tool mechanics and is unit-testable with no Postgres access; this
 * file owns "tie a ConversationState to a persisted row and the process's
 * dynamic/environmental inputs" (season, rate limiting, hazard-provider
 * selection).
 *
 * `startConversation` also fixes a latent gap from Phases 1-3: nothing has
 * ever inserted into `conversations` before now, so `runTool`'s existing
 * `SELECT ... WHERE externalId = call_id` always missed and every
 * `tool_invocations.conversationId` was `null`. Inserting the row up front
 * (idempotently — Retell/Twilio retries on a call-start are expected) turns
 * that into a working foreign key from turn one, with no change to
 * runTool.ts itself.
 */
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../db/client.js';
import { conversations } from '../db/schema.js';
import type { Channel, conversationOutcomeEnum } from '../db/schema.js';
import { config } from '../config.js';
import { resolveSeason } from '../domain/season.js';
import { disabledHazardCheckProvider, type HazardCheckProvider } from '../triage/hazardCheck.js';
import { AnthropicHazardCheckProvider } from '../triage/hazardCheckAnthropic.js';
import { eventBus } from '../events/bus.js';
import { createInMemoryPhoneRateLimiter, type RateLimiter } from './caps.js';
import type { ConversationState } from './types.js';

type ConversationOutcome = (typeof conversationOutcomeEnum.enumValues)[number];

export class RateLimitExceededError extends Error {
  constructor(public readonly retryAfterMs: number) {
    super(`Rate limit exceeded for this phone number — retry after ${retryAfterMs}ms.`);
    this.name = 'RateLimitExceededError';
  }
}

// Module-level singleton: there's no per-request lifecycle yet (Retell/
// Twilio webhooks are Phase 8), so one process-wide limiter is the right
// scope — every call from a given phone number, regardless of channel,
// shares one budget.
const defaultPhoneRateLimiter: RateLimiter = createInMemoryPhoneRateLimiter();

/**
 * Pure decision function, independently testable: given the flag and
 * credentials, which provider should `classifyUrgency` receive? Stays $0 by
 * default (`HAZARD_CHECK_LLM_ENABLED=false`) — this is the one place in the
 * codebase that flag is read.
 */
export function selectHazardCheckProvider(
  enabled: boolean,
  apiKey: string | undefined,
  model: string,
): HazardCheckProvider {
  if (!enabled) return disabledHazardCheckProvider;
  if (!apiKey) {
    throw new Error(
      'HAZARD_CHECK_LLM_ENABLED is true but ANTHROPIC_API_KEY is not set. Add it to .env — see .env.example.',
    );
  }
  return new AnthropicHazardCheckProvider({ apiKey, model });
}

export interface StartConversationOptions {
  channel: Channel;
  /** Retell call_id, a Twilio conversation id, or a sim-chosen token. */
  externalId: string;
  /** ANI for voice, the From number for SMS, operator-entered in the sim —
   * never derived from the model. */
  callerPhone: string;
  /** Test seam; defaults to the module-level limiter. */
  rateLimiter?: RateLimiter;
}

export async function startConversation(
  opts: StartConversationOptions,
): Promise<ConversationState> {
  const rateLimiter = opts.rateLimiter ?? defaultPhoneRateLimiter;
  const check = rateLimiter.checkAndRecord(opts.callerPhone);
  if (!check.allowed) {
    throw new RateLimitExceededError(check.retryAfterMs ?? 0);
  }

  // onConflictDoNothing makes this idempotent against a retried call-start
  // for the same externalId (Retell retries on timeout, same as every tool
  // call) — the row is created at most once regardless of how many times
  // this is invoked for the same conversation. `.returning()` on an
  // onConflictDoNothing insert comes back empty on the no-op branch, which
  // is exactly the signal used below to decide whether this is a genuinely
  // new call (publish `call.started`) or a retry (must not re-open the
  // dashboard's live-call banner a second time).
  const inserted = await db
    .insert(conversations)
    .values({ channel: opts.channel, externalId: opts.externalId })
    .onConflictDoNothing({
      target: conversations.externalId,
    })
    .returning({ id: conversations.id });

  let row = inserted[0];
  if (row) {
    eventBus.publish({
      type: 'call.started',
      callId: opts.externalId,
      channel: opts.channel,
      callerPhone: opts.callerPhone,
    });
  } else {
    [row] = await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(eq(conversations.externalId, opts.externalId))
      .limit(1);
  }
  if (!row)
    throw new Error(
      'conversation row missing immediately after insert — this should be unreachable',
    );

  return {
    externalId: opts.externalId,
    channel: opts.channel,
    conversationDbId: row.id,
    callerPhone: opts.callerPhone,
    knownName: null,
    knownAddressLine: null,
    knownCity: null,
    knownCounty: null,
    propertyType: null,
    customerLookupAttempted: false,
    recognizedCustomerSummary: null,
    knownMembershipTier: null,
    season: resolveSeason(new Date(), config.SEASON_OVERRIDE),
    messages: [],
    transcriptAccumulator: '',
    lastTriage: null,
    emergencyFlaggedAt: null,
    emergencyFlagReason: null,
    bookingsCount: 0,
    transferRequested: false,
    hazardCheckProvider: selectHazardCheckProvider(
      config.HAZARD_CHECK_LLM_ENABLED,
      config.ANTHROPIC_API_KEY,
      config.MODEL_FAST,
    ),
    startedAt: new Date(),
  };
}

export interface FinalizeConversationOptions {
  outcome?: ConversationOutcome;
}

/**
 * There's still no explicit disconnect-reason signal from Retell wired in
 * (the WS `close` handler fires on any socket close, clean or not — see
 * transports/retell/websocket.ts), so this is a heuristic, not a true
 * "the caller hung up mid-sentence" detector: a voice call that never
 * reached a terminal outcome counts as abandoned only if there's evidence
 * the caller was actually mid-intake — either a recognized-caller lookup or
 * a `book_appointment` attempt already wrote back a name/address (see
 * `applySideEffects` in agent/sideEffects.ts), or they'd gotten past a couple of
 * exchanges. A call that ends after one exchange (a quick question, a wrong
 * number) intentionally does *not* count — PRD §3 scopes recovery to "before
 * intake is complete," and there's nothing to "pick up where it left off"
 * for a caller who never engaged. Known false-negative: a caller who
 * genuinely decides not to book after a full conversation looks identical
 * to one who got cut off — see docs/KNOWN_LIMITATIONS.md.
 */
function looksLikeAbandonedIntake(state: ConversationState): boolean {
  if (state.channel !== 'voice') return false;
  if (state.knownName || state.knownAddressLine) return true;
  const userTurns = state.messages.filter((m) => m.role === 'user').length;
  return userTurns >= 2;
}

/**
 * Derives an outcome when the caller doesn't supply one explicitly.
 * `finalizeConversation` is always called deliberately (sim exit, the
 * Retell WS `close` handler, the SMS inactivity sweeper) rather than on some
 * separate "did this end cleanly" signal, so a conversation that never
 * booked/flagged/transferred falls through to `looksLikeAbandonedIntake`
 * before defaulting to `info_only`.
 */
function deriveOutcome(state: ConversationState): ConversationOutcome {
  if (state.emergencyFlaggedAt) return 'flagged';
  if (state.bookingsCount > 0) return 'booked';
  if (state.transferRequested) return 'transferred';
  if (looksLikeAbandonedIntake(state)) return 'abandoned';
  return 'info_only';
}

/**
 * PRD §3 stretch: "if a call disconnects before intake is complete, auto-
 * send a follow-up SMS picking up where it left off, rather than losing the
 * lead entirely." Deliberately generic — nothing here invents specifics
 * (issue, address) the caller didn't confirm with a human on a callback, the
 * same "never invent" discipline the live agent follows. Personalizes with a
 * first name only when one is actually known (recognized caller, or a
 * `book_appointment` attempt got that far before things fell over).
 */
function buildAbandonedFollowupBody(state: ConversationState): string {
  const firstName = state.knownName?.trim().split(/\s+/)[0];
  const greeting = firstName ? `Hi ${firstName}` : 'Hi';
  return (
    `Summit Air: ${greeting}, looks like we got disconnected. Reply here or call us back ` +
    'and we’ll pick up right where we left off. Reply STOP to opt out.'
  );
}

/**
 * Idempotent (IMPLEMENTATION_PLAN Phase 8): the Retell WS socket's `close`
 * handler and a later webhook path, or the SMS inactivity sweeper racing a
 * just-arrived message, can each plausibly try to finalize the same
 * conversation. The `endedAt IS NULL` guard means only the first caller's
 * update actually lands — `.returning()` coming back empty is the signal
 * this call was a no-op, same idiom `startConversation` already uses for
 * `call.started`. A second finalize call must not double-publish
 * `call.ended` or double-queue the safety follow-up text below.
 */
export async function finalizeConversation(
  state: ConversationState,
  opts: FinalizeConversationOptions = {},
): Promise<void> {
  const outcome = opts.outcome ?? deriveOutcome(state);
  const updated = await db
    .update(conversations)
    .set({
      endedAt: new Date(),
      outcome,
      transcript: state.messages,
    })
    .where(and(eq(conversations.id, state.conversationDbId), isNull(conversations.endedAt)))
    .returning({ id: conversations.id });

  if (updated.length === 0) return;

  // The one `sms.queued` kind nothing fired before Phase 8 (BUILD_GUIDE §7:
  // "customer-facing safety follow-up on emergency, as a backup if the call
  // drops"). Channel-agnostic and lives here, not in transport code, since
  // every conversation — voice or SMS — passes through finalizeConversation
  // exactly once (guarded above).
  if (state.emergencyFlaggedAt) {
    eventBus.publish({
      type: 'sms.queued',
      kind: 'safety_followup',
      to: state.callerPhone,
      body:
        "Summit Air: if you're still smelling gas or feel unsafe, leave the property now and " +
        'call 911 or your gas utility. We’ve already notified dispatch.',
    });
  }

  // Voice-only (PRD §3) — a texter who goes quiet is already handled by the
  // SMS thread simply resuming later (BUILD_GUIDE §7); proactively texting
  // an SMS conversation that timed out would be the unsolicited-message
  // pattern §7's compliance section warns against, not a recovery.
  if (outcome === 'abandoned' && state.channel === 'voice') {
    eventBus.publish({
      type: 'sms.queued',
      kind: 'abandoned_followup',
      to: state.callerPhone,
      body: buildAbandonedFollowupBody(state),
    });
  }

  eventBus.publish({ type: 'call.ended', callId: state.externalId, outcome });
}
