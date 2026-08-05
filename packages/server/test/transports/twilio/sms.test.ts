/**
 * Route-level integration tests for /webhooks/twilio-sms, against a minimal
 * standalone Fastify instance (formbody + the route only) so a scripted,
 * deterministic `providerFactory` can be injected — `buildApp()`'s
 * production wiring picks a real/fallback provider with no test seam,
 * exactly per the route's own `RegisterTwilioSmsRouteOptions` design.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import formbody from '@fastify/formbody';
import Twilio from 'twilio';
import { eq } from 'drizzle-orm';
import { db } from '../../../src/db/client.js';
import { conversations, customers, smsOptOuts } from '../../../src/db/schema.js';
import { config } from '../../../src/config.js';
import { registerTwilioSmsRoute } from '../../../src/transports/twilio/sms.js';
import { __resetSmsThreadsForTests } from '../../../src/transports/twilio/conversationStore.js';
import { ScriptedProvider } from '../../../src/agent/providers/scripted.js';
import type { AgentProvider } from '../../../src/agent/types.js';
import { resetDb, seedFixtures } from '../../helpers/db.js';

const authToken = config.TWILIO_AUTH_TOKEN!;
const webhookUrl = `${config.PUBLIC_BASE_URL}/webhooks/twilio-sms`;

function sign(params: Record<string, string>): string {
  return Twilio.getExpectedTwilioSignature(authToken, webhookUrl, params);
}

async function injectSms(
  app: FastifyInstance,
  params: Record<string, string>,
  opts: { signatureHeader?: string } = {},
) {
  const signatureHeader = opts.signatureHeader ?? sign(params);
  return app.inject({
    method: 'POST',
    url: '/webhooks/twilio-sms',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'x-twilio-signature': signatureHeader,
    },
    payload: new URLSearchParams(params).toString(),
  });
}

async function buildTwilioTestApp(providerFactory: () => AgentProvider): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(formbody);
  await app.register(registerTwilioSmsRoute, { providerFactory });
  return app;
}

describe('POST /webhooks/twilio-sms — signature verification', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    await resetDb();
    __resetSmsThreadsForTests();
    app = await buildTwilioTestApp(() => new ScriptedProvider({ name: 'unused', steps: [] }));
  });

  afterEach(async () => {
    await app.close();
  });

  it('rejects a tampered signature with 401', async () => {
    const params = { From: '+17705550100', Body: 'hello' };
    const res = await injectSms(app, params, { signatureHeader: 'not-a-real-signature' });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a missing signature header with 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/twilio-sms',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ From: '+17705550100', Body: 'hello' }).toString(),
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('POST /webhooks/twilio-sms — STOP opt-out', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    await resetDb();
    __resetSmsThreadsForTests();
    app = await buildTwilioTestApp(() => new ScriptedProvider({ name: 'unused', steps: [] }));
  });

  afterEach(async () => {
    await app.close();
  });

  it('sets DNC, replies with a confirmation, and never starts a conversation', async () => {
    const from = '+17705550111';
    const res = await injectSms(app, { From: from, Body: 'STOP' });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/xml');
    expect(res.body).toContain('<Message>');
    expect(res.body).toContain('unsubscribed');

    const [optOut] = await db.select().from(smsOptOuts).where(eq(smsOptOuts.phone, from));
    expect(optOut).toBeDefined();

    const rows = await db.select().from(conversations);
    expect(rows).toHaveLength(0); // the scripted provider (empty steps) was never touched
  });

  it('matches STOP-family keywords case-insensitively and exactly, not as a substring', async () => {
    await injectSms(app, { From: '+17705550122', Body: 'unsubscribe' });
    expect(
      (await db.select().from(smsOptOuts).where(eq(smsOptOuts.phone, '+17705550122'))).length,
    ).toBe(1);

    // Conversational "stop" phrasing is not a compliance keyword match — it
    // falls through to the normal conversation path instead, so this app
    // needs an actual reply queued rather than the empty-steps provider.
    await app.close();
    app = await buildTwilioTestApp(
      () => new ScriptedProvider({ name: 'not-a-stop', steps: [{ type: 'text', text: 'Sure thing!' }] }),
    );
    const res = await injectSms(app, { From: '+17705550133', Body: 'please stop calling me so much' });
    expect(res.statusCode).toBe(200);
    expect(
      (await db.select().from(smsOptOuts).where(eq(smsOptOuts.phone, '+17705550133'))).length,
    ).toBe(0);
  });

  it('sets customers.dnc for a known customer number', async () => {
    const fx = await seedFixtures();
    await injectSms(app, { From: fx.customerPhone, Body: 'STOP' });
    const [row] = await db.select().from(customers).where(eq(customers.phone, fx.customerPhone));
    expect(row?.dnc).toBe(true);
  });
});

describe('POST /webhooks/twilio-sms — conversation flow', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    await resetDb();
    __resetSmsThreadsForTests();
  });

  afterEach(async () => {
    await app.close();
  });

  it('books an appointment across two inbound messages, resuming the same thread', async () => {
    // Round semantics (see agent/loop.ts's runModelRounds): a turn keeps
    // calling the model until stopReason !== 'tool_use', and only the last
    // round's text becomes that turn's assistantReply — so each of these two
    // SMS turns needs to end on a plain `text` step, same shape as
    // transports/sim/demoScript.ts's routineBookingDemoScript.
    await seedFixtures(); // a real Cobb technician, so the booking actually succeeds
    const provider = new ScriptedProvider({
      name: 'sms-booking',
      steps: [
        { type: 'tool_use', name: 'customer_lookup', input: { phone: '+17705550144' } },
        {
          type: 'tool_use',
          name: 'check_availability',
          input: { county: 'Cobb', urgency: 'routine', required_skills: [] },
          alsoText: 'Let me check Cobb County.',
        },
        { type: 'text', text: 'Got an opening at 2pm, work for you?' },
        {
          type: 'tool_use',
          name: 'book_appointment',
          input: {
            phone: '+17705550144',
            name: 'SMS Customer',
            address_line: '200 Text Ln',
            city: 'Marietta',
            county: 'Cobb',
            property_type: 'residential',
            urgency: 'routine',
            issue_summary: 'Annual tune-up',
            required_skills: [],
            scheduled_start: '2027-06-01T14:00:00.000Z',
            source_channel: 'sms',
          },
          alsoText: "Great, I'll get that booked.",
        },
        { type: 'text', text: "You're all set — you'll get a text confirmation shortly." },
      ],
    });
    app = await buildTwilioTestApp(() => provider);

    const from = '+17705550144';
    const first = await injectSms(app, { From: from, Body: 'Need my annual tune-up, Cobb County' });
    expect(first.statusCode).toBe(200);
    expect(first.body).toContain('Got an opening at 2pm');

    const rowsAfterFirst = await db.select().from(conversations);
    expect(rowsAfterFirst).toHaveLength(1);
    const firstExternalId = rowsAfterFirst[0]?.externalId;

    const second = await injectSms(app, { From: from, Body: '2pm works' });
    expect(second.statusCode).toBe(200);
    expect(second.body).toContain('confirmation');

    const rowsAfterSecond = await db.select().from(conversations);
    expect(rowsAfterSecond).toHaveLength(1); // resumed, not a second row
    expect(rowsAfterSecond[0]?.externalId).toBe(firstExternalId);
  });

  it('starts a fresh conversation for a new thread after a prior one reached a terminal outcome', async () => {
    await seedFixtures(); // a real Cobb technician, so bookingsCount actually increments
    const bookingScript = new ScriptedProvider({
      name: 'sms-terminal',
      steps: [
        {
          type: 'tool_use',
          name: 'book_appointment',
          input: {
            phone: '+17705550155',
            name: 'SMS Customer',
            address_line: '300 Text Ln',
            city: 'Marietta',
            county: 'Cobb',
            property_type: 'residential',
            urgency: 'routine',
            issue_summary: 'Annual tune-up',
            required_skills: [],
            scheduled_start: '2027-07-01T14:00:00.000Z',
            source_channel: 'sms',
          },
          alsoText: "Great, I'll get that booked.",
        },
        { type: 'text', text: "You're all set — confirmation on the way." },
      ],
    });
    app = await buildTwilioTestApp(() => bookingScript);

    const from = '+17705550155';
    await injectSms(app, { From: from, Body: 'book my tune-up' });
    const rowsAfterBooking = await db.select().from(conversations);
    expect(rowsAfterBooking).toHaveLength(1);
    const firstExternalId = rowsAfterBooking[0]?.externalId;

    // A second, unrelated message from the same number after the thread hit
    // a terminal outcome (booked) must start a new conversation, not append
    // to the finished one.
    const secondProvider = new ScriptedProvider({
      name: 'sms-followup',
      steps: [{ type: 'text', text: 'Sure, what else can I help with?' }],
    });
    await app.close();
    app = await buildTwilioTestApp(() => secondProvider);

    await injectSms(app, { From: from, Body: 'actually one more question' });
    const rowsAfterSecondThread = await db.select().from(conversations);
    expect(rowsAfterSecondThread).toHaveLength(2);
    expect(rowsAfterSecondThread.map((r) => r.externalId)).toContain(firstExternalId);
  });
});
