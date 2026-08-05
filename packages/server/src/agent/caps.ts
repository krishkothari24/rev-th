/**
 * Server-side caps — BUILD_GUIDE §8.3 / CLAUDE.md: "one emergency flag per
 * conversation, bounded bookings per conversation, rate limit per phone
 * number." These sit alongside the DB-level backstops that already exist
 * (`emergency_flags_call_idx`, `appointments_tech_slot_unique`) as the
 * loop-level checks that intercept a tool call *before* it reaches the real
 * service, rather than relying only on the DB rejecting it afterward.
 */
import type { ConversationState } from './types.js';

/**
 * Chosen to cover BUILD_GUIDE's own "two separate issues in one call"
 * scenario (a repair plus a maintenance visit) while still bounding a
 * runaway or abusive call. A product judgment call, not a technical
 * constant — revisit once Phase 9 sees real call volume.
 */
export const MAX_BOOKINGS_PER_CONVERSATION = 2;

export function isBookingCapExceeded(state: ConversationState): boolean {
  return state.bookingsCount >= MAX_BOOKINGS_PER_CONVERSATION;
}

/**
 * The DB unique index on `emergency_flags.call_id` and
 * `flagEmergencyService`'s own `already_flagged` handling already make a
 * second, different flag attempt a no-op at the data layer. The loop still
 * needs this check for two things the DB layer doesn't give it: skipping a
 * repeat evacuation-directive injection every subsequent turn, and
 * short-circuiting a second `flag_emergency` tool call before it reaches
 * `dispatchTool` at all.
 */
export function hasAlreadyFlagged(state: ConversationState): boolean {
  return state.emergencyFlaggedAt !== null;
}

export interface RateLimitCheck {
  allowed: boolean;
  /** Only set when `allowed` is false. */
  retryAfterMs?: number;
}

export interface RateLimiter {
  checkAndRecord(key: string): RateLimitCheck;
}

export interface InMemoryRateLimiterOptions {
  maxPerWindow?: number;
  windowMs?: number;
  /** Injectable clock so tests don't need real timers. */
  now?: () => number;
}

/**
 * Simple in-memory sliding-window limiter, keyed by phone number, checked
 * once at `startConversation`. There is no real telephony entrypoint yet
 * (Retell/Twilio land in Phase 8), so this is exercised directly by tests
 * rather than against a live caller — expected at this stage, and ready for
 * Phase 8 to wire against real inbound calls without changing this module.
 */
export function createInMemoryPhoneRateLimiter(opts: InMemoryRateLimiterOptions = {}): RateLimiter {
  const maxPerWindow = opts.maxPerWindow ?? 5;
  const windowMs = opts.windowMs ?? 10 * 60 * 1000;
  const now = opts.now ?? (() => Date.now());
  const hits = new Map<string, number[]>();

  return {
    checkAndRecord(key: string): RateLimitCheck {
      const nowMs = now();
      const windowStart = nowMs - windowMs;
      const recent = (hits.get(key) ?? []).filter((t) => t > windowStart);

      if (recent.length >= maxPerWindow) {
        hits.set(key, recent);
        const oldest = Math.min(...recent);
        return { allowed: false, retryAfterMs: oldest + windowMs - nowMs };
      }

      recent.push(nowMs);
      hits.set(key, recent);
      return { allowed: true };
    },
  };
}
