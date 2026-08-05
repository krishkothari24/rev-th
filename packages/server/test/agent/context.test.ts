import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { conversations } from '../../src/db/schema.js';
import {
  RateLimitExceededError,
  finalizeConversation,
  selectHazardCheckProvider,
  startConversation,
} from '../../src/agent/context.js';
import type { RateLimiter } from '../../src/agent/caps.js';
import { disabledHazardCheckProvider } from '../../src/triage/hazardCheck.js';
import { eventBus, type DashboardEvent } from '../../src/events/bus.js';
import { resetDb } from '../helpers/db.js';

// The production default rate limiter is a module-level singleton shared
// across the whole process — reusing one phone number across many `it()`
// blocks in this file would otherwise trip it after 5 calls. Tests that
// aren't specifically exercising rate-limiting behavior inject this
// always-allow limiter instead, so they're isolated from that shared state.
const alwaysAllow: RateLimiter = { checkAndRecord: () => ({ allowed: true }) };

describe('startConversation', () => {
  it('creates a conversations row and returns a matching conversationDbId', async () => {
    await resetDb();
    const state = await startConversation({
      channel: 'voice',
      externalId: 'ctx-test-1',
      callerPhone: '+17705550100',
      rateLimiter: alwaysAllow,
    });

    const [row] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, state.conversationDbId));
    expect(row?.externalId).toBe('ctx-test-1');
    expect(row?.channel).toBe('voice');
  });

  it('is idempotent: starting the same externalId twice does not create a second row', async () => {
    await resetDb();
    const first = await startConversation({
      channel: 'voice',
      externalId: 'ctx-test-2',
      callerPhone: '+17705550100',
      rateLimiter: alwaysAllow,
    });
    const second = await startConversation({
      channel: 'voice',
      externalId: 'ctx-test-2',
      callerPhone: '+17705550100',
      rateLimiter: alwaysAllow,
    });
    expect(second.conversationDbId).toBe(first.conversationDbId);

    const rows = await db
      .select()
      .from(conversations)
      .where(eq(conversations.externalId, 'ctx-test-2'));
    expect(rows).toHaveLength(1);
  });

  it('defaults to the disabled hazard-check provider (HAZARD_CHECK_LLM_ENABLED is false)', async () => {
    await resetDb();
    const state = await startConversation({
      channel: 'voice',
      externalId: 'ctx-test-3',
      callerPhone: '+17705550100',
      rateLimiter: alwaysAllow,
    });
    expect(state.hazardCheckProvider).toBe(disabledHazardCheckProvider);
  });

  it('resolves a season from the current date', async () => {
    await resetDb();
    const state = await startConversation({
      channel: 'voice',
      externalId: 'ctx-test-4',
      callerPhone: '+17705550100',
      rateLimiter: alwaysAllow,
    });
    expect(['heating', 'cooling', 'shoulder']).toContain(state.season);
  });

  it('initializes call-start recognition fields unset (Phase 6 — populated by runTurn, not here)', async () => {
    await resetDb();
    const state = await startConversation({
      channel: 'voice',
      externalId: 'ctx-test-recognition-init',
      callerPhone: '+17705550100',
      rateLimiter: alwaysAllow,
    });
    expect(state.customerLookupAttempted).toBe(false);
    expect(state.recognizedCustomerSummary).toBeNull();
    expect(state.knownMembershipTier).toBeNull();
  });

  it('publishes call.started exactly once for a genuinely new externalId (IMPLEMENTATION_PLAN Phase 7)', async () => {
    await resetDb();
    const events: DashboardEvent[] = [];
    const unsubscribe = eventBus.subscribe((e) => events.push(e));

    await startConversation({
      channel: 'voice',
      externalId: 'ctx-test-call-started',
      callerPhone: '+17705550100',
      rateLimiter: alwaysAllow,
    });
    unsubscribe();

    const published = events.filter((e) => e.type === 'call.started');
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({
      callId: 'ctx-test-call-started',
      channel: 'voice',
      callerPhone: '+17705550100',
    });
  });

  it('does not re-publish call.started on a retried/duplicate call-start', async () => {
    await resetDb();
    await startConversation({
      channel: 'voice',
      externalId: 'ctx-test-call-started-retry',
      callerPhone: '+17705550100',
      rateLimiter: alwaysAllow,
    });

    const events: DashboardEvent[] = [];
    const unsubscribe = eventBus.subscribe((e) => events.push(e));
    await startConversation({
      channel: 'voice',
      externalId: 'ctx-test-call-started-retry',
      callerPhone: '+17705550100',
      rateLimiter: alwaysAllow,
    });
    unsubscribe();

    expect(events.filter((e) => e.type === 'call.started')).toHaveLength(0);
  });

  it('rejects when the injected rate limiter denies the phone number', async () => {
    await resetDb();
    const denyingLimiter: RateLimiter = {
      checkAndRecord: () => ({ allowed: false, retryAfterMs: 5000 }),
    };
    await expect(
      startConversation({
        channel: 'voice',
        externalId: 'ctx-test-5',
        callerPhone: '+17705550100',
        rateLimiter: denyingLimiter,
      }),
    ).rejects.toThrow(RateLimitExceededError);
  });

  it('allows starts under the injected rate limiter and denies over it', async () => {
    await resetDb();
    let count = 0;
    const limiter: RateLimiter = {
      checkAndRecord: () => {
        count += 1;
        return count <= 2 ? { allowed: true } : { allowed: false, retryAfterMs: 1000 };
      },
    };
    await startConversation({
      channel: 'voice',
      externalId: 'ctx-test-6a',
      callerPhone: '+17705550100',
      rateLimiter: limiter,
    });
    await startConversation({
      channel: 'voice',
      externalId: 'ctx-test-6b',
      callerPhone: '+17705550100',
      rateLimiter: limiter,
    });
    await expect(
      startConversation({
        channel: 'voice',
        externalId: 'ctx-test-6c',
        callerPhone: '+17705550100',
        rateLimiter: limiter,
      }),
    ).rejects.toThrow(RateLimitExceededError);
  });
});

describe('selectHazardCheckProvider', () => {
  it('returns the disabled provider when not enabled', () => {
    expect(selectHazardCheckProvider(false, 'sk-test', 'claude-haiku-4-5')).toBe(
      disabledHazardCheckProvider,
    );
    expect(selectHazardCheckProvider(false, undefined, 'claude-haiku-4-5')).toBe(
      disabledHazardCheckProvider,
    );
  });

  it('throws a clear error when enabled but no API key is configured', () => {
    expect(() => selectHazardCheckProvider(true, undefined, 'claude-haiku-4-5')).toThrow(
      /ANTHROPIC_API_KEY/,
    );
  });

  it('constructs a real provider when enabled with an API key', () => {
    const provider = selectHazardCheckProvider(true, 'sk-test', 'claude-haiku-4-5');
    expect(provider).not.toBe(disabledHazardCheckProvider);
    expect(typeof provider.check).toBe('function');
  });
});

describe('finalizeConversation — outcome derivation', () => {
  it('derives "flagged" when an emergency was flagged', async () => {
    await resetDb();
    const state = await startConversation({
      channel: 'voice',
      externalId: 'ctx-outcome-flagged',
      callerPhone: '+17705550100',
      rateLimiter: alwaysAllow,
    });
    state.emergencyFlaggedAt = new Date();
    await finalizeConversation(state);
    const [row] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, state.conversationDbId));
    expect(row?.outcome).toBe('flagged');
    expect(row?.endedAt).not.toBeNull();
  });

  it('derives "booked" when a booking happened and nothing was flagged', async () => {
    await resetDb();
    const state = await startConversation({
      channel: 'voice',
      externalId: 'ctx-outcome-booked',
      callerPhone: '+17705550100',
      rateLimiter: alwaysAllow,
    });
    state.bookingsCount = 1;
    await finalizeConversation(state);
    const [row] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, state.conversationDbId));
    expect(row?.outcome).toBe('booked');
  });

  it('derives "transferred" when a transfer happened and nothing else did', async () => {
    await resetDb();
    const state = await startConversation({
      channel: 'voice',
      externalId: 'ctx-outcome-transferred',
      callerPhone: '+17705550100',
      rateLimiter: alwaysAllow,
    });
    state.transferRequested = true;
    await finalizeConversation(state);
    const [row] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, state.conversationDbId));
    expect(row?.outcome).toBe('transferred');
  });

  it('defaults to "info_only" when nothing happened', async () => {
    await resetDb();
    const state = await startConversation({
      channel: 'voice',
      externalId: 'ctx-outcome-info',
      callerPhone: '+17705550100',
      rateLimiter: alwaysAllow,
    });
    await finalizeConversation(state);
    const [row] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, state.conversationDbId));
    expect(row?.outcome).toBe('info_only');
  });

  it('an explicit outcome overrides the derived one', async () => {
    await resetDb();
    const state = await startConversation({
      channel: 'voice',
      externalId: 'ctx-outcome-explicit',
      callerPhone: '+17705550100',
      rateLimiter: alwaysAllow,
    });
    await finalizeConversation(state, { outcome: 'abandoned' });
    const [row] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, state.conversationDbId));
    expect(row?.outcome).toBe('abandoned');
  });

  it('persists the full transcript', async () => {
    await resetDb();
    const state = await startConversation({
      channel: 'voice',
      externalId: 'ctx-outcome-transcript',
      callerPhone: '+17705550100',
      rateLimiter: alwaysAllow,
    });
    state.messages = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }];
    await finalizeConversation(state);
    const [row] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, state.conversationDbId));
    expect(row?.transcript).toEqual(state.messages);
  });

  it('publishes call.ended with the derived outcome (IMPLEMENTATION_PLAN Phase 7)', async () => {
    await resetDb();
    const state = await startConversation({
      channel: 'voice',
      externalId: 'ctx-outcome-call-ended',
      callerPhone: '+17705550100',
      rateLimiter: alwaysAllow,
    });
    state.bookingsCount = 1;

    const events: DashboardEvent[] = [];
    const unsubscribe = eventBus.subscribe((e) => events.push(e));
    await finalizeConversation(state);
    unsubscribe();

    const published = events.filter((e) => e.type === 'call.ended');
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({ callId: 'ctx-outcome-call-ended', outcome: 'booked' });
  });
});
