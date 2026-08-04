/**
 * HTTP-level smoke tests — the automated equivalent of the curl checks
 * IMPLEMENTATION_PLAN Phase 2 calls for: valid, invalid, and repeated calls
 * against each endpoint, through the real Fastify app rather than the bare
 * service functions.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { buildApp } from '../../src/app.js';
import { resetDb, seedFixtures, type Fixtures } from '../helpers/db.js';
import { db } from '../../src/db/client.js';
import { appointments } from '../../src/db/schema.js';

describe('POST /tools/*', () => {
  let app: FastifyInstance;
  let fx: Fixtures;

  beforeAll(async () => {
    app = await buildApp();
  });

  beforeEach(async () => {
    await resetDb();
    fx = await seedFixtures();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('customer_lookup: 200 with a compact summary for a valid, known number', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/tools/customer_lookup',
      payload: { call_id: 'http-1', phone: fx.customerPhone },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().found).toBe(true);
  });

  it('customer_lookup: 400 on a malformed phone number', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/tools/customer_lookup',
      payload: { call_id: 'http-2', phone: 'not-a-phone' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_arguments');
  });

  it('check_availability: 200 with concrete slots', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/tools/check_availability',
      payload: { call_id: 'http-3', county: 'Cobb', urgency: 'routine', required_skills: [] },
    });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json().slots)).toBe(true);
  });

  it('book_appointment: 200, then a repeated call replays the same booking instead of double-booking', async () => {
    const payload = {
      call_id: 'http-book-1',
      phone: fx.customerPhone,
      name: 'Test Customer',
      address_line: '100 Test Ln',
      city: 'Marietta',
      county: 'Cobb',
      property_type: 'residential',
      urgency: 'routine',
      issue_summary: 'Annual tune-up',
      required_skills: ['gas'],
      scheduled_start: '2027-04-01T14:00:00.000Z',
      source_channel: 'voice',
    };

    const first = await app.inject({ method: 'POST', url: '/tools/book_appointment', payload });
    expect(first.statusCode).toBe(200);
    expect(first.json().booked).toBe(true);

    const second = await app.inject({ method: 'POST', url: '/tools/book_appointment', payload });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());

    const rows = await db
      .select()
      .from(appointments)
      .where(eq(appointments.customerId, fx.customerId));
    expect(rows).toHaveLength(1);
  });

  it('book_appointment: 400 when technician_id is passed — server-owned field', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/tools/book_appointment',
      payload: {
        call_id: 'http-book-2',
        phone: fx.customerPhone,
        name: 'Test Customer',
        address_line: '100 Test Ln',
        city: 'Marietta',
        county: 'Cobb',
        urgency: 'routine',
        issue_summary: 'Annual tune-up',
        required_skills: [],
        scheduled_start: '2027-04-01T14:00:00.000Z',
        source_channel: 'voice',
        technician_id: fx.techCobbGasId,
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('flag_emergency: 200 with partial information only', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/tools/flag_emergency',
      payload: {
        call_id: 'http-emg-1',
        phone: fx.customerPhone,
        address: '100 Test Ln',
        reason: 'gas_smell',
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().flagged).toBe(true);
  });

  it('transfer_to_human: 200 with a transfer instruction', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/tools/transfer_to_human',
      payload: { call_id: 'http-transfer-1', reason: 'caller asked for a manager' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().transfer).toBe(true);
  });
});
