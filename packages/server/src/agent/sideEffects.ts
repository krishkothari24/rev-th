/**
 * Opportunistic internal bookkeeping from a successful tool result — extracted
 * out of agent/loop.ts (IMPLEMENTATION_PLAN Phase 11) so every voice driver
 * keeps `ConversationState`'s derived fields (`knownName`, `knownAddressLine`,
 * `knownMembershipTier`, `propertyType`, booking/flag/transfer bookkeeping)
 * in sync the same way, not just the Claude/Retell `runTurn` loop. Those
 * fields feed the membership directive, the returning-caller prompt
 * appendix, skill derivation, and the abandoned-call heuristic
 * (agent/context.ts) — all channel-agnostic concerns this must stay correct
 * for regardless of which vendor is driving the call.
 *
 * Never used to decide what's safe to *say* aloud (that's a prompt/§8.2
 * concern) — only to keep the loop's own state (booking count, known facts
 * for a future flag_emergency call) current.
 */
import { emergencyReasonEnum } from '../db/schema.js';
import { isCounty } from '../domain/constants.js';
import type { EmergencyReason } from '../db/schema.js';
import type { ConversationState } from './types.js';

function isEmergencyReason(value: unknown): value is EmergencyReason {
  return (
    typeof value === 'string' &&
    (emergencyReasonEnum.enumValues as readonly string[]).includes(value)
  );
}

export function applySideEffects(
  state: ConversationState,
  toolName: string,
  dispatchedArgs: Record<string, unknown>,
  result: Record<string, unknown>,
): void {
  switch (toolName) {
    case 'customer_lookup': {
      if (result.found === true && result.customer && typeof result.customer === 'object') {
        const customer = result.customer as Record<string, unknown>;
        if (typeof customer.name === 'string') state.knownName = customer.name;
        if (typeof customer.address_line === 'string')
          state.knownAddressLine = customer.address_line;
        if (typeof customer.city === 'string') state.knownCity = customer.city;
        if (typeof customer.county === 'string' && isCounty(customer.county))
          state.knownCounty = customer.county;
        if (customer.property_type === 'commercial' || customer.property_type === 'residential') {
          state.propertyType = customer.property_type;
        }
        if (customer.membership_tier === 'basic' || customer.membership_tier === 'comfort_club') {
          state.knownMembershipTier = customer.membership_tier;
        }
        if (typeof result.summary === 'string') state.recognizedCustomerSummary = result.summary;
      }
      break;
    }
    case 'book_appointment': {
      if (result.booked === true) {
        state.bookingsCount += 1;
        if (typeof dispatchedArgs.name === 'string') state.knownName = dispatchedArgs.name;
        if (typeof dispatchedArgs.address_line === 'string')
          state.knownAddressLine = dispatchedArgs.address_line;
        if (typeof dispatchedArgs.city === 'string') state.knownCity = dispatchedArgs.city;
        if (typeof dispatchedArgs.county === 'string' && isCounty(dispatchedArgs.county)) {
          state.knownCounty = dispatchedArgs.county;
        }
        if (
          dispatchedArgs.property_type === 'commercial' ||
          dispatchedArgs.property_type === 'residential'
        ) {
          state.propertyType = dispatchedArgs.property_type;
        }
      }
      break;
    }
    case 'flag_emergency': {
      if (result.flagged === true) {
        state.emergencyFlaggedAt = state.emergencyFlaggedAt ?? new Date();
        if (isEmergencyReason(dispatchedArgs.reason))
          state.emergencyFlagReason = dispatchedArgs.reason;
      }
      break;
    }
    case 'transfer_to_human': {
      if (result.transfer === true) state.transferRequested = true;
      break;
    }
    default:
      break;
  }
}
