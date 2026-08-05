import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { appointments, conversations, emergencyFlags } from '../../src/db/schema.js';
import { BUSINESS_HOURS } from '../../src/domain/constants.js';
import {
  acknowledgeEmergency,
  getDashboardState,
  resolveBoardDate,
} from '../../src/dashboard/state.js';
import { eventBus, type DashboardEvent } from '../../src/events/bus.js';
import { runTool } from '../../src/tools/runTool.js';
import { customerLookupService } from '../../src/tools/customerLookup.js';
import { resetDb, seedFixtures, type Fixtures } from '../helpers/db.js';

describe('resolveBoardDate', () => {
  it('defaults to today when no param is given', () => {
    const today = new Date();
    const { date } = resolveBoardDate();
    const expected = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    expect(date).toBe(expected);
  });

  it('parses an explicit YYYY-MM-DD param as a local calendar day', () => {
    const { date, start, end } = resolveBoardDate('2027-06-01');
    expect(date).toBe('2027-06-01');
    expect(start.getFullYear()).toBe(2027);
    expect(start.getMonth()).toBe(5); // 0-indexed
    expect(start.getDate()).toBe(1);
    expect(end.getTime() - start.getTime()).toBe(24 * 60 * 60 * 1000);
  });

  it('falls back to today on a malformed param instead of throwing', () => {
    const { date } = resolveBoardDate('not-a-date');
    expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('getDashboardState', () => {
  let fx: Fixtures;

  beforeEach(async () => {
    await resetDb();
    fx = await seedFixtures();
  });

  it('lists only active technicians, ordered by county then name, each with capacity', async () => {
    const state = await getDashboardState('2027-06-01');
    const names = state.technicians.map((t) => t.name);
    expect(names).not.toContain('Renata Kim'); // inactive fixture tech
    expect(names).toContain('Marcus Webb');
    for (const tech of state.technicians) {
      expect(tech.capacity.total).toBeGreaterThan(0);
      expect(tech.capacity.booked).toBe(0);
    }
  });

  it('includes an appointment on the requested date and reflects it in technician capacity', async () => {
    const { start } = resolveBoardDate('2027-06-01');
    const scheduledStart = new Date(start);
    scheduledStart.setHours(BUSINESS_HOURS.startHour, 0, 0, 0);
    const scheduledEnd = new Date(scheduledStart);
    scheduledEnd.setHours(scheduledEnd.getHours() + 2);

    await db.insert(appointments).values({
      customerId: fx.customerId,
      technicianId: fx.techCobbGasId,
      scheduledStart,
      scheduledEnd,
      urgency: 'routine',
      issueSummary: 'Annual tune-up',
      requiredSkills: ['gas'],
      status: 'booked',
      sourceChannel: 'voice',
      sourceCallId: 'state-test-1',
    });

    const state = await getDashboardState('2027-06-01');
    expect(state.appointments).toHaveLength(1);
    expect(state.appointments[0]?.customerName).toBe('Test Customer');
    const tech = state.technicians.find((t) => t.id === fx.techCobbGasId);
    expect(tech?.capacity.booked).toBe(1);
  });

  it('excludes a cancelled appointment from the board', async () => {
    const { start } = resolveBoardDate('2027-06-02');
    const scheduledStart = new Date(start);
    scheduledStart.setHours(BUSINESS_HOURS.startHour, 0, 0, 0);
    const scheduledEnd = new Date(scheduledStart);
    scheduledEnd.setHours(scheduledEnd.getHours() + 2);

    await db.insert(appointments).values({
      customerId: fx.customerId,
      technicianId: fx.techCobbGasId,
      scheduledStart,
      scheduledEnd,
      urgency: 'routine',
      issueSummary: 'Cancelled job',
      requiredSkills: [],
      status: 'cancelled',
      sourceChannel: 'voice',
      sourceCallId: 'state-test-cancelled',
    });

    const state = await getDashboardState('2027-06-02');
    expect(state.appointments).toHaveLength(0);
  });

  it('sorts emergencies unacknowledged-first, newest-first within each group', async () => {
    const [older] = await db
      .insert(emergencyFlags)
      .values({
        callId: 'state-emg-older',
        reason: 'gas_smell',
        addressSnapshot: '1 Test Way',
        phoneSnapshot: '+17705550100',
      })
      .returning();
    const [newerAcked] = await db
      .insert(emergencyFlags)
      .values({
        callId: 'state-emg-newer-acked',
        reason: 'no_heat_vulnerable',
        addressSnapshot: '2 Test Way',
        phoneSnapshot: '+17705550100',
        acknowledgedAt: new Date(),
      })
      .returning();
    const [newestUnacked] = await db
      .insert(emergencyFlags)
      .values({
        callId: 'state-emg-newest-unacked',
        reason: 'other',
        addressSnapshot: '3 Test Way',
        phoneSnapshot: '+17705550100',
      })
      .returning();

    const state = await getDashboardState();
    const ids = state.emergencies.map((e) => e.id);
    // Both unacknowledged flags precede the acknowledged one; within the
    // unacknowledged group, newest (newestUnacked) comes before older.
    expect(ids.indexOf(newestUnacked!.id)).toBeLessThan(ids.indexOf(older!.id));
    expect(ids.indexOf(older!.id)).toBeLessThan(ids.indexOf(newerAcked!.id));
  });

  it('formats activity from persisted tool_invocations using describeToolInvocation', async () => {
    // runTool joins tool_invocations to conversations by call_id to set
    // conversationId — a real caller always has a conversations row by the
    // time a tool runs (agent/context.ts's startConversation), so this test
    // creates one directly rather than pulling in the whole conversation
    // lifecycle just to get a callId onto the activity line.
    await db.insert(conversations).values({ channel: 'voice', externalId: 'state-activity-1' });
    await runTool('customer_lookup', { call_id: 'state-activity-1', phone: fx.customerPhone }, () =>
      customerLookupService({ call_id: 'state-activity-1', phone: fx.customerPhone }),
    );

    const state = await getDashboardState();
    const line = state.activity.find((a) => a.callId === 'state-activity-1');
    expect(line?.summary).toContain('Recognized');
  });
});

describe('acknowledgeEmergency', () => {
  beforeEach(async () => {
    await resetDb();
    await seedFixtures();
  });

  it('acknowledges an unacknowledged flag and publishes emergency.acknowledged', async () => {
    const [flag] = await db
      .insert(emergencyFlags)
      .values({
        callId: 'ack-test-1',
        reason: 'gas_smell',
        addressSnapshot: '1 Test Way',
        phoneSnapshot: '+17705550100',
      })
      .returning();

    const events: DashboardEvent[] = [];
    const unsubscribe = eventBus.subscribe((e) => events.push(e));
    const result = await acknowledgeEmergency(flag!.id);
    unsubscribe();

    expect(result).toMatchObject({ ok: true, alreadyAcknowledged: false });
    expect(events.filter((e) => e.type === 'emergency.acknowledged')).toHaveLength(1);
  });

  it('is idempotent on a second acknowledge and does not republish', async () => {
    const [flag] = await db
      .insert(emergencyFlags)
      .values({
        callId: 'ack-test-2',
        reason: 'gas_smell',
        addressSnapshot: '1 Test Way',
        phoneSnapshot: '+17705550100',
      })
      .returning();

    await acknowledgeEmergency(flag!.id);

    const events: DashboardEvent[] = [];
    const unsubscribe = eventBus.subscribe((e) => events.push(e));
    const second = await acknowledgeEmergency(flag!.id);
    unsubscribe();

    expect(second).toMatchObject({ ok: true, alreadyAcknowledged: true });
    expect(events.filter((e) => e.type === 'emergency.acknowledged')).toHaveLength(0);
  });

  it('returns notFound for an unknown id', async () => {
    const result = await acknowledgeEmergency('00000000-0000-0000-0000-000000000000');
    expect(result).toEqual({ ok: false, notFound: true });
  });
});
