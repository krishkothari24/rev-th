import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { appointments, emergencyFlags } from '../../src/db/schema.js';
import { startConversation } from '../../src/agent/context.js';
import { MAX_TOOL_ROUNDS_PER_TURN, runTurn } from '../../src/agent/loop.js';
import { MAX_BOOKINGS_PER_CONVERSATION } from '../../src/agent/caps.js';
import { ScriptedProvider, type ScriptedStep } from '../../src/agent/providers/scripted.js';
import type { RateLimiter } from '../../src/agent/caps.js';
import {
  routineBookingCallerTurns,
  routineBookingDemoScript,
} from '../../src/transports/sim/demoScript.js';
import { eventBus, type DashboardEvent } from '../../src/events/bus.js';
import { resetDb, seedFixtures } from '../helpers/db.js';

const alwaysAllow: RateLimiter = { checkAndRecord: () => ({ allowed: true }) };

describe('runTurn — routine booking (Done-When #1)', () => {
  it('completes a full routine booking end to end: customer_lookup -> check_availability -> book_appointment -> confirmation', async () => {
    await resetDb();
    const fx = await seedFixtures();
    const state = await startConversation({
      channel: 'voice',
      externalId: 'loop-routine-1',
      callerPhone: fx.customerPhone,
      rateLimiter: alwaysAllow,
    });
    const provider = new ScriptedProvider(routineBookingDemoScript);

    let lastResult;
    for (const utterance of routineBookingCallerTurns) {
      lastResult = await runTurn(state, utterance, provider);
    }

    expect(lastResult?.assistantReply).toMatch(/confirmation/i);

    const rows = await db
      .select()
      .from(appointments)
      .where(eq(appointments.customerId, fx.customerId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('booked');
    expect(state.bookingsCount).toBe(1);
  });
});

describe('runTurn — server-disposes override', () => {
  it('overrides a model-injected urgency/required_skills on check_availability regardless of the tool call', async () => {
    await resetDb();
    await seedFixtures();
    const state = await startConversation({
      channel: 'voice',
      externalId: 'loop-override-1',
      callerPhone: '+17705550111',
      rateLimiter: alwaysAllow,
    });
    const provider = new ScriptedProvider({
      name: 'injection-attempt',
      steps: [
        {
          type: 'tool_use',
          name: 'check_availability',
          input: { county: 'Cobb', urgency: 'emergency', required_skills: ['electrical'] },
        },
        { type: 'text', text: 'okay' },
      ],
    });

    const result = await runTurn(state, 'just a routine thermostat question', provider);
    const call = result.toolCalls.find((c) => c.name === 'check_availability');
    expect(call?.modelArgs.urgency).toBe('emergency'); // preserved for observability, never trusted
    expect(call?.dispatchedArgs.urgency).toBe('routine'); // overridden by triage
    expect(call?.dispatchedArgs.required_skills).toEqual(['residential']);
  });
});

describe('runTurn — booking cap', () => {
  it('intercepts book_appointment once the cap is reached, without touching the DB or bumping the counter', async () => {
    await resetDb();
    const fx = await seedFixtures();
    const state = await startConversation({
      channel: 'voice',
      externalId: 'loop-cap-1',
      callerPhone: fx.customerPhone,
      rateLimiter: alwaysAllow,
    });
    state.bookingsCount = MAX_BOOKINGS_PER_CONVERSATION;

    const provider = new ScriptedProvider({
      name: 'cap-test',
      steps: [
        {
          type: 'tool_use',
          name: 'book_appointment',
          input: {
            phone: fx.customerPhone,
            name: 'Test Customer',
            address_line: '100 Test Ln',
            city: 'Marietta',
            county: 'Cobb',
            property_type: 'residential',
            urgency: 'routine',
            issue_summary: 'one more thing',
            required_skills: [],
            scheduled_start: '2027-07-01T14:00:00.000Z',
            source_channel: 'voice',
          },
        },
        { type: 'text', text: 'done' },
      ],
    });

    const result = await runTurn(state, 'one more thing please', provider);
    const call = result.toolCalls.find((c) => c.name === 'book_appointment');
    expect(call?.intercepted).toBe(true);
    expect(call?.result.booked).toBe(false);

    const rows = await db
      .select()
      .from(appointments)
      .where(eq(appointments.customerId, fx.customerId));
    expect(rows).toHaveLength(0);
    expect(state.bookingsCount).toBe(MAX_BOOKINGS_PER_CONVERSATION);
  });
});

describe('runTurn — MAX_TOOL_ROUNDS_PER_TURN circuit breaker', () => {
  it('stops after MAX_TOOL_ROUNDS_PER_TURN rounds and returns a safe fallback instead of looping forever', async () => {
    await resetDb();
    const state = await startConversation({
      channel: 'voice',
      externalId: 'loop-runaway-rounds',
      callerPhone: '+17705550122',
      rateLimiter: alwaysAllow,
    });
    const steps: ScriptedStep[] = Array.from({ length: MAX_TOOL_ROUNDS_PER_TURN + 3 }, () => ({
      type: 'tool_use',
      name: 'transfer_to_human',
      input: { reason: 'testing runaway tool use' },
    }));
    const provider = new ScriptedProvider({ name: 'runaway', steps });

    const result = await runTurn(state, 'hello', provider);
    // +1 for the call-start customer_lookup dispatch (Phase 6), which fires
    // once before the model round-trip loop and isn't itself a "round."
    const transferCalls = result.toolCalls.filter((c) => c.name === 'transfer_to_human');
    expect(transferCalls).toHaveLength(MAX_TOOL_ROUNDS_PER_TURN);
    expect(result.assistantReply.toLowerCase()).toContain('dispatcher');
  });
});

describe('runTurn — unknown tool name', () => {
  it('handles a hallucinated tool name as a graceful is_error instead of crashing', async () => {
    await resetDb();
    const state = await startConversation({
      channel: 'voice',
      externalId: 'loop-unknown-tool',
      callerPhone: '+17705550133',
      rateLimiter: alwaysAllow,
    });
    const provider = new ScriptedProvider({
      name: 'hallucinated-tool',
      steps: [
        { type: 'tool_use', name: 'does_not_exist', input: {} },
        { type: 'text', text: 'sorted' },
      ],
    });

    const result = await runTurn(state, 'hello', provider);
    const call = result.toolCalls.find((c) => c.name === 'does_not_exist');
    expect(call?.isError).toBe(true);
    expect(result.assistantReply).toBe('sorted');
  });
});

describe('runTurn — call-start customer recognition (Phase 6)', () => {
  it('dispatches customer_lookup once, before the model, and populates recognition fields on a match', async () => {
    await resetDb();
    const fx = await seedFixtures();
    const state = await startConversation({
      channel: 'voice',
      externalId: 'loop-recognition-found',
      callerPhone: fx.customerPhone,
      rateLimiter: alwaysAllow,
    });
    const provider = new ScriptedProvider({
      name: 'recognition-found',
      steps: [{ type: 'text', text: 'Hi there!' }],
    });

    const result = await runTurn(state, 'hey, my heat pump is acting up again', provider);

    const lookupCall = result.toolCalls.find((c) => c.name === 'customer_lookup');
    expect(lookupCall?.initiator).toBe('loop');
    expect(lookupCall?.dispatchedArgs.phone).toBe(fx.customerPhone);
    expect(lookupCall?.result.found).toBe(true);

    expect(state.customerLookupAttempted).toBe(true);
    expect(state.knownName).toBe('Test Customer');
    expect(state.knownMembershipTier).toBe('comfort_club');
    expect(state.recognizedCustomerSummary).toContain('Test Customer');
  });

  it('dispatches customer_lookup for an unrecognized number without erroring or setting known fields', async () => {
    await resetDb();
    await seedFixtures();
    const state = await startConversation({
      channel: 'voice',
      externalId: 'loop-recognition-not-found',
      callerPhone: '+17705559000',
      rateLimiter: alwaysAllow,
    });
    const provider = new ScriptedProvider({
      name: 'recognition-not-found',
      steps: [{ type: 'text', text: 'Sure, happy to help.' }],
    });

    const result = await runTurn(state, 'my AC is out', provider);

    const lookupCall = result.toolCalls.find((c) => c.name === 'customer_lookup');
    expect(lookupCall?.isError).toBe(false);
    expect(lookupCall?.result.found).toBe(false);
    expect(state.knownName).toBeNull();
    expect(state.recognizedCustomerSummary).toBeNull();
    expect(state.knownMembershipTier).toBeNull();
  });

  it('does not re-dispatch customer_lookup on a second turn in the same conversation', async () => {
    await resetDb();
    const fx = await seedFixtures();
    const state = await startConversation({
      channel: 'voice',
      externalId: 'loop-recognition-once',
      callerPhone: fx.customerPhone,
      rateLimiter: alwaysAllow,
    });
    const provider = new ScriptedProvider({
      name: 'recognition-once',
      steps: [
        { type: 'text', text: 'okay' },
        { type: 'text', text: 'sure' },
      ],
    });

    await runTurn(state, 'first turn', provider);
    const secondResult = await runTurn(state, 'second turn', provider);

    expect(secondResult.toolCalls.find((c) => c.name === 'customer_lookup')).toBeUndefined();
  });
});

describe('runTurn — already-flagged short-circuit', () => {
  it("short-circuits the model's own second flag_emergency call without a second DB row", async () => {
    await resetDb();
    const state = await startConversation({
      channel: 'voice',
      externalId: 'loop-double-flag',
      callerPhone: '+17705550144',
      rateLimiter: alwaysAllow,
    });
    state.emergencyFlaggedAt = new Date(); // simulate: already flagged earlier this conversation

    const provider = new ScriptedProvider({
      name: 'double-flag',
      steps: [
        {
          type: 'tool_use',
          name: 'flag_emergency',
          input: { phone: '+17705550144', address: '1 Test Way', reason: 'gas_smell' },
        },
        { type: 'text', text: 'okay' },
      ],
    });

    const result = await runTurn(state, 'still smell gas', provider);
    const call = result.toolCalls.find((c) => c.name === 'flag_emergency');
    expect(call?.intercepted).toBe(true);
    expect(call?.result.already_flagged).toBe(true);

    const rows = await db
      .select()
      .from(emergencyFlags)
      .where(eq(emergencyFlags.callId, state.externalId));
    expect(rows).toHaveLength(0); // the interception never reached dispatchTool this turn
  });
});

describe('runTurn — triage.updated publish (IMPLEMENTATION_PLAN Phase 7)', () => {
  it('publishes triage.updated with the urgency the loop just classified', async () => {
    await resetDb();
    const state = await startConversation({
      channel: 'voice',
      externalId: 'loop-triage-event',
      callerPhone: '+17705550155',
      rateLimiter: alwaysAllow,
    });
    const provider = new ScriptedProvider({
      name: 'triage-event',
      steps: [{ type: 'text', text: 'Sorry to hear that — let’s get someone out.' }],
    });

    const events: DashboardEvent[] = [];
    const unsubscribe = eventBus.subscribe((e) => events.push(e));
    await runTurn(state, 'my furnace is dead and it is freezing, no heat at all', provider);
    unsubscribe();

    const published = events.filter((e) => e.type === 'triage.updated');
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({ callId: 'loop-triage-event' });
    expect((published[0] as Extract<DashboardEvent, { type: 'triage.updated' }>).urgency).toBe(
      state.lastTriage?.urgency,
    );
  });
});
