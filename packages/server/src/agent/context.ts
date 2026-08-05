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
import { eq } from 'drizzle-orm';
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
 * Derives an outcome when the caller doesn't supply one explicitly. There's
 * no real disconnect signal yet (Phase 8 telephony), so a conversation that
 * ends without booking/flagging/transferring defaults to `info_only` rather
 * than `abandoned` — `finalizeConversation` is always called deliberately
 * (sim exit, later a call-ended webhook), not on an unexpected drop, so
 * "the caller got through the call without needing any of those" is the
 * more accurate default. A future telephony adapter can pass
 * `{outcome: 'abandoned'}` explicitly on a genuine mid-intake disconnect.
 */
function deriveOutcome(state: ConversationState): ConversationOutcome {
  if (state.emergencyFlaggedAt) return 'flagged';
  if (state.bookingsCount > 0) return 'booked';
  if (state.transferRequested) return 'transferred';
  return 'info_only';
}

export async function finalizeConversation(
  state: ConversationState,
  opts: FinalizeConversationOptions = {},
): Promise<void> {
  const outcome = opts.outcome ?? deriveOutcome(state);
  await db
    .update(conversations)
    .set({
      endedAt: new Date(),
      outcome,
      transcript: state.messages,
    })
    .where(eq(conversations.id, state.conversationDbId));

  eventBus.publish({ type: 'call.ended', callId: state.externalId, outcome });
}
