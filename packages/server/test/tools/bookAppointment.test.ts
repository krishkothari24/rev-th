import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { resetDb, seedFixtures, type Fixtures } from '../helpers/db.js';
import { bookAppointmentSchema, bookAppointmentService } from '../../src/tools/bookAppointment.js';
import { runTool } from '../../src/tools/runTool.js';
import { db } from '../../src/db/client.js';
import { appointments, customers } from '../../src/db/schema.js';
import { eventBus, type DashboardEvent } from '../../src/events/bus.js';

// Well in the future so tests never depend on wall-clock "today" — findTechnicianForSlot
// only checks for conflicts at the exact instant, not grid alignment or "is it today".
const FUTURE_SLOT = '2027-03-15T14:00:00.000Z';

function baseArgs(overrides: Record<string, unknown> = {}) {
  return {
    call_id: 'call-book-1',
    phone: '+17705559999',
    name: 'Test Customer',
    address_line: '100 Test Ln',
    city: 'Marietta',
    county: 'Cobb',
    property_type: 'residential',
    urgency: 'routine',
    issue_summary: 'Annual tune-up',
    required_skills: ['gas'],
    scheduled_start: FUTURE_SLOT,
    source_channel: 'voice',
    ...overrides,
  };
}

describe('book_appointment', () => {
  let fx: Fixtures;

  beforeEach(async () => {
    await resetDb();
    fx = await seedFixtures();
  });

  it('books an existing customer with a qualified, server-assigned technician', async () => {
    const events: DashboardEvent[] = [];
    const unsubscribe = eventBus.subscribe((e) => events.push(e));

    // County is deliberately wrong here — the customer's own record (Cobb) must win.
    const args = bookAppointmentSchema.parse(baseArgs({ county: 'Cherokee', call_id: 'call-book-2' }));
    const result = await bookAppointmentService(args);
    unsubscribe();

    expect(result.booked).toBe(true);
    expect(result.technician_first_name).toBe('Marcus'); // the only Cobb tech with 'gas'
    expect(typeof result.appointment_id).toBe('string');

    const [appt] = await db.select().from(appointments).where(eq(appointments.customerId, fx.customerId));
    expect(appt?.technicianId).toBe(fx.techCobbGasId);
    expect(appt?.status).toBe('booked');

    expect(events.some((e) => e.type === 'appointment.created')).toBe(true);
    expect(events.some((e) => e.type === 'sms.queued' && e.kind === 'booking_confirmation')).toBe(true);
  });

  it('creates a new customer record when the phone is unrecognized', async () => {
    const args = bookAppointmentSchema.parse(
      baseArgs({
        call_id: 'call-book-3',
        phone: '+17705551234',
        name: 'Brand New Caller',
        address_line: '55 New St',
        city: 'Kennesaw',
        county: 'Cobb',
      }),
    );
    const result = await bookAppointmentService(args);
    expect(result.booked).toBe(true);

    const [created] = await db.select().from(customers).where(eq(customers.phone, '+17705551234'));
    expect(created?.name).toBe('Brand New Caller');
  });

  it('returns booked:false with a speakable note when no qualified tech is free', async () => {
    const args = bookAppointmentSchema.parse(
      baseArgs({ call_id: 'call-book-4', required_skills: ['refrigerant_epa'] }), // no fixture tech has this
    );
    const result = await bookAppointmentService(args);
    expect(result.booked).toBe(false);
    expect(typeof result.note).toBe('string');
  });

  it('will not double-book the same technician and slot on a second, distinct call', async () => {
    const first = bookAppointmentSchema.parse(baseArgs({ call_id: 'call-book-5' }));
    const firstResult = await bookAppointmentService(first);
    expect(firstResult.booked).toBe(true);

    // Different call_id, same technician-qualifying slot — a second real
    // caller, not a retry. Cobb has exactly one gas tech in the fixture, so
    // this must fail cleanly rather than double-book Marcus.
    const second = bookAppointmentSchema.parse(baseArgs({ call_id: 'call-book-6' }));
    const secondResult = await bookAppointmentService(second);
    expect(secondResult.booked).toBe(false);

    const rows = await db.select().from(appointments);
    expect(rows).toHaveLength(1);
  });

  it('is idempotent: a retried call_id + identical args books exactly once', async () => {
    const args = bookAppointmentSchema.parse(baseArgs({ call_id: 'call-book-7' }));

    const first = await runTool('book_appointment', args, () => bookAppointmentService(args));
    const second = await runTool('book_appointment', args, () => bookAppointmentService(args));

    expect(second).toEqual(first);
    const rows = await db.select().from(appointments);
    expect(rows).toHaveLength(1);
  });

  it('rejects a scheduled_start well in the past', async () => {
    const args = bookAppointmentSchema.parse(baseArgs({ call_id: 'call-book-8', scheduled_start: '2020-01-01T14:00:00.000Z' }));
    const result = await bookAppointmentService(args);
    expect(result.booked).toBe(false);
  });

  it('rejects a malformed scheduled_start at the schema boundary', () => {
    const parsed = bookAppointmentSchema.safeParse(baseArgs({ scheduled_start: 'next Tuesday afternoon' }));
    expect(parsed.success).toBe(false);
  });

  it('rejects an unknown required_skills value', () => {
    const parsed = bookAppointmentSchema.safeParse(baseArgs({ required_skills: ['plumbing'] }));
    expect(parsed.success).toBe(false);
  });

  it('rejects an attempt to set technician_id directly — server-owned field', () => {
    const parsed = bookAppointmentSchema.safeParse(baseArgs({ technician_id: fx.techCobbGasId }));
    expect(parsed.success).toBe(false);
  });

  it('rejects an attempt to set a price or membership field — server-owned', () => {
    const parsed = bookAppointmentSchema.safeParse(baseArgs({ price: 0, membership_tier: 'comfort_club' }));
    expect(parsed.success).toBe(false);
  });
});
