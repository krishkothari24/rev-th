/**
 * Shared minimal `ConversationState` factory for agent-layer unit tests that
 * don't need a real conversation lifecycle (that's agent/context.test.ts's
 * job). Keeps every agent test from having to restate the full interface.
 */
import { randomUUID } from 'node:crypto';
import { disabledHazardCheckProvider } from '../../src/triage/hazardCheck.js';
import type { ConversationState } from '../../src/agent/types.js';

export function makeTestConversationState(
  overrides: Partial<ConversationState> = {},
): ConversationState {
  return {
    externalId: `test-${randomUUID()}`,
    channel: 'voice',
    conversationDbId: randomUUID(),
    callerPhone: '+17705559999',
    knownName: null,
    knownAddressLine: null,
    knownCity: null,
    knownCounty: null,
    propertyType: null,
    customerLookupAttempted: false,
    recognizedCustomerSummary: null,
    knownMembershipTier: null,
    season: 'shoulder',
    messages: [],
    transcriptAccumulator: '',
    lastTriage: null,
    emergencyFlaggedAt: null,
    emergencyFlagReason: null,
    bookingsCount: 0,
    transferRequested: false,
    hazardCheckProvider: disabledHazardCheckProvider,
    startedAt: new Date(),
    ...overrides,
  };
}
