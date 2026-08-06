import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { db } from '../../src/db/client.js';
import { emergencyFlags } from '../../src/db/schema.js';
import { resetDb, seedFixtures } from '../helpers/db.js';

describe('GET /dashboard/state', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
  });

  beforeEach(async () => {
    await resetDb();
    await seedFixtures();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('200s with today’s snapshot when no date is given', async () => {
    const res = await app.inject({ method: 'GET', url: '/dashboard/state' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Array.isArray(body.technicians)).toBe(true);
    expect(Array.isArray(body.appointments)).toBe(true);
    expect(Array.isArray(body.emergencies)).toBe(true);
    expect(Array.isArray(body.activity)).toBe(true);
  });

  it('accepts an explicit ?date=YYYY-MM-DD', async () => {
    const res = await app.inject({ method: 'GET', url: '/dashboard/state?date=2027-06-01' });
    expect(res.statusCode).toBe(200);
    expect(res.json().date).toBe('2027-06-01');
  });

  it('400s on a malformed date param', async () => {
    const res = await app.inject({ method: 'GET', url: '/dashboard/state?date=06-01-2027' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_query');
  });

  it('reflects the seeded fixture roster (technician-level coverage lives in dashboard/state.test.ts)', async () => {
    const res = await app.inject({ method: 'GET', url: '/dashboard/state' });
    const names = res.json().technicians.map((t: { name: string }) => t.name);
    expect(names).toContain('Marcus Webb');
  });
});

describe('POST /dashboard/emergencies/:id/acknowledge', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
  });

  beforeEach(async () => {
    await resetDb();
    await seedFixtures();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('acknowledges an existing unacknowledged flag', async () => {
    const [flag] = await db
      .insert(emergencyFlags)
      .values({
        callId: 'route-ack-1',
        reason: 'gas_smell',
        addressSnapshot: '1 Test Way',
        phoneSnapshot: '+17705550100',
      })
      .returning();

    const res = await app.inject({
      method: 'POST',
      url: `/dashboard/emergencies/${flag!.id}/acknowledge`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, alreadyAcknowledged: false });
  });

  it('400s on a non-uuid id', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/dashboard/emergencies/not-a-uuid/acknowledge',
    });
    expect(res.statusCode).toBe(400);
  });

  it('404s on a well-formed but unknown id', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/dashboard/emergencies/00000000-0000-0000-0000-000000000000/acknowledge',
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('POST /dashboard/sim/*', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
  });

  beforeEach(async () => {
    await resetDb();
    await seedFixtures();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('400s /sim/start on a malformed phone number', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/dashboard/sim/start',
      payload: { callerPhone: 'not-a-phone' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_body');
  });

  // No ANTHROPIC_API_KEY in the test environment (evals/CI stay $0) — this
  // is the exact path a fresh clone hits before Phase 9's account setup, and
  // is the behavior worth pinning: a clean 503, not a bare crash.
  it('503s /sim/start when no ANTHROPIC_API_KEY is configured', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/dashboard/sim/start',
      payload: { callerPhone: '+17705550310' },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe('sim_unavailable');
  });

  it('400s /sim/turn on a missing message', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/dashboard/sim/turn',
      payload: { externalId: 'whatever' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('404s /sim/turn against an unknown externalId', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/dashboard/sim/turn',
      payload: { externalId: 'does-not-exist', message: 'hello' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('404s /sim/end against an unknown externalId', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/dashboard/sim/end',
      payload: { externalId: 'does-not-exist' },
    });
    expect(res.statusCode).toBe(404);
  });
});
