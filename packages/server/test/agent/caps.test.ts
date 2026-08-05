import { describe, expect, it } from 'vitest';
import {
  MAX_BOOKINGS_PER_CONVERSATION,
  createInMemoryPhoneRateLimiter,
  hasAlreadyFlagged,
  isBookingCapExceeded,
} from '../../src/agent/caps.js';
import { makeTestConversationState } from '../helpers/agentState.js';

describe('isBookingCapExceeded', () => {
  it('is false below the cap', () => {
    const state = makeTestConversationState({ bookingsCount: MAX_BOOKINGS_PER_CONVERSATION - 1 });
    expect(isBookingCapExceeded(state)).toBe(false);
  });

  it('is true at and above the cap', () => {
    expect(
      isBookingCapExceeded(
        makeTestConversationState({ bookingsCount: MAX_BOOKINGS_PER_CONVERSATION }),
      ),
    ).toBe(true);
    expect(
      isBookingCapExceeded(
        makeTestConversationState({ bookingsCount: MAX_BOOKINGS_PER_CONVERSATION + 1 }),
      ),
    ).toBe(true);
  });
});

describe('hasAlreadyFlagged', () => {
  it('is false when never flagged', () => {
    expect(hasAlreadyFlagged(makeTestConversationState())).toBe(false);
  });

  it('is true once emergencyFlaggedAt is set', () => {
    expect(hasAlreadyFlagged(makeTestConversationState({ emergencyFlaggedAt: new Date() }))).toBe(
      true,
    );
  });
});

describe('createInMemoryPhoneRateLimiter', () => {
  it('allows up to maxPerWindow calls, then denies', () => {
    const now = { value: 0 };
    const limiter = createInMemoryPhoneRateLimiter({
      maxPerWindow: 2,
      windowMs: 1000,
      now: () => now.value,
    });
    expect(limiter.checkAndRecord('+17705550100').allowed).toBe(true);
    expect(limiter.checkAndRecord('+17705550100').allowed).toBe(true);
    const third = limiter.checkAndRecord('+17705550100');
    expect(third.allowed).toBe(false);
    expect(third.retryAfterMs).toBeGreaterThan(0);
  });

  it('is keyed independently per phone number', () => {
    const limiter = createInMemoryPhoneRateLimiter({
      maxPerWindow: 1,
      windowMs: 1000,
      now: () => 0,
    });
    expect(limiter.checkAndRecord('+17705550100').allowed).toBe(true);
    expect(limiter.checkAndRecord('+17705550200').allowed).toBe(true);
  });

  it('allows again once the window has passed', () => {
    const now = { value: 0 };
    const limiter = createInMemoryPhoneRateLimiter({
      maxPerWindow: 1,
      windowMs: 1000,
      now: () => now.value,
    });
    expect(limiter.checkAndRecord('+17705550100').allowed).toBe(true);
    expect(limiter.checkAndRecord('+17705550100').allowed).toBe(false);
    now.value = 1001;
    expect(limiter.checkAndRecord('+17705550100').allowed).toBe(true);
  });
});
