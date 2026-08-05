/**
 * In-memory SMS thread store (IMPLEMENTATION_PLAN Phase 8 — deliberate scope
 * decision, not an oversight): a texter who goes quiet and comes back hours
 * later resumes the same `ConversationState`/`conversations` row rather than
 * restarting, for as long as this process keeps running. A process restart
 * loses any open thread's in-memory state — the next inbound message starts
 * a fresh conversation instead of resuming. See the project's
 * known-limitations note.
 *
 * `externalId` is derived from the phone plus the thread's start time
 * (`sms-{phone}-{epoch}`), not a bare, permanently-reused phone number — a
 * fresh thread after a terminal outcome gets a fresh `conversations` row and
 * a fresh idempotency namespace for its tool calls, rather than silently
 * extending the previous booking's row forever.
 */
import { finalizeConversation, startConversation } from '../../agent/context.js';
import type { AgentProvider, ConversationState } from '../../agent/types.js';

export interface SmsThreadEntry {
  state: ConversationState;
  provider: AgentProvider;
  lastActivityAt: number;
}

// "A texter... returns tomorrow should be picked up mid-thread" (BUILD_GUIDE
// §7) sets the floor; a few hours is generous slack under that while still
// eventually closing out a thread nobody's coming back to today.
const THREAD_INACTIVITY_MS = 4 * 60 * 60 * 1000;

const threads = new Map<string, SmsThreadEntry>();

function normalizePhone(phone: string): string {
  return phone.trim();
}

function isThreadClosed(entry: SmsThreadEntry, now: number): boolean {
  const s = entry.state;
  if (s.emergencyFlaggedAt || s.bookingsCount > 0 || s.transferRequested) return true;
  return now - entry.lastActivityAt > THREAD_INACTIVITY_MS;
}

/**
 * Returns the open thread for `phone`, reusing it if one exists and isn't
 * closed; otherwise finalizes any stale entry and starts a fresh one.
 * `providerFactory` is a test seam (mirrors `startConversation`'s
 * `rateLimiter` option and the Retell WS route's own `providerFactory`) —
 * production wiring omits it. The provider is constructed once per thread,
 * not per message: `ScriptedProvider` is a stateful, cursor-based fixture,
 * so a fresh instance per message would break a multi-message scripted test.
 */
export async function getOrCreateSmsThread(
  phone: string,
  providerFactory: () => AgentProvider,
  now: number = Date.now(),
): Promise<SmsThreadEntry> {
  const key = normalizePhone(phone);
  const existing = threads.get(key);
  if (existing && !isThreadClosed(existing, now)) {
    existing.lastActivityAt = now;
    return existing;
  }

  if (existing) {
    threads.delete(key);
    await finalizeConversation(existing.state).catch((err: unknown) => {
      console.error('[sms] finalize stale thread failed:', err);
    });
  }

  const externalId = `sms-${key}-${now}`;
  const state = await startConversation({ channel: 'sms', externalId, callerPhone: phone });
  const entry: SmsThreadEntry = { state, provider: providerFactory(), lastActivityAt: now };
  threads.set(key, entry);
  return entry;
}

/**
 * Periodically finalizes+evicts closed threads so the dashboard doesn't show
 * a conversation as perpetually open once it's actually gone quiet for good.
 * Returns a stop function; `unref()`s its timer so it never keeps the
 * process alive on its own (matters for tests and graceful shutdown).
 */
export function startSmsInactivitySweeper(intervalMs = 15 * 60 * 1000): () => void {
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of threads) {
      if (!isThreadClosed(entry, now)) continue;
      threads.delete(key);
      void finalizeConversation(entry.state).catch((err: unknown) => {
        console.error('[sms] inactivity sweeper finalize failed:', err);
      });
    }
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

/** Test-only escape hatch — clears all in-memory threads without finalizing
 * them, so test files don't leak thread state into one another. */
export function __resetSmsThreadsForTests(): void {
  threads.clear();
}
