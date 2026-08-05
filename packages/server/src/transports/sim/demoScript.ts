/**
 * A canned, fully deterministic "well-behaved model" script: customer_lookup
 * → check_availability → book_appointment → confirmation. Doubles as both
 * the sim REPL's default ($0, non-`--live`) content and the fixture
 * test/agent/loop.test.ts drives to prove a full routine booking completes
 * end to end (IMPLEMENTATION_PLAN Phase 4's first Done-When criterion).
 *
 * The phone number matches test/helpers/db.ts's fixture customer exactly on
 * purpose, so the test path exercises the "existing customer" branch of
 * bookAppointmentService; against a fresh (non-fixture) database — e.g. a
 * real `npm run sim` run — bookAppointmentService just creates a new
 * customer at that phone instead, which is equally valid.
 */
import type { ScriptedProviderScript } from '../../agent/providers/scripted.js';

export const DEMO_CUSTOMER_PHONE = '+17705559999';
export const DEMO_SCHEDULED_START = '2027-06-01T14:00:00.000Z';

export const routineBookingDemoScript: ScriptedProviderScript = {
  name: 'routine-booking-demo',
  steps: [
    {
      type: 'tool_use',
      name: 'customer_lookup',
      input: { phone: DEMO_CUSTOMER_PHONE },
    },
    {
      type: 'tool_use',
      name: 'check_availability',
      input: { county: 'Cobb', urgency: 'routine', required_skills: [] },
      alsoText: 'Let me check what we have open in Cobb County.',
    },
    {
      type: 'text',
      text: "I've got an opening at 2 PM — does that work for you?",
    },
    {
      type: 'tool_use',
      name: 'book_appointment',
      input: {
        phone: DEMO_CUSTOMER_PHONE,
        name: 'Test Customer',
        address_line: '100 Test Ln',
        city: 'Marietta',
        county: 'Cobb',
        property_type: 'residential',
        urgency: 'routine',
        issue_summary: 'Annual furnace tune-up',
        required_skills: [],
        scheduled_start: DEMO_SCHEDULED_START,
        source_channel: 'voice',
      },
      alsoText: "Great, I'll get that booked.",
    },
    {
      type: 'text',
      text: "You're all set for your annual tune-up. You'll get a text confirmation shortly. Anything else?",
    },
  ],
};

/** The caller side of the same conversation, for driving the sim/loop turn by turn. */
export const routineBookingCallerTurns = [
  "Hi, I'd like to schedule my annual furnace tune-up. I'm in Cobb County.",
  '2 PM works great, thanks.',
];
