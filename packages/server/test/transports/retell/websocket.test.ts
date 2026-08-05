/**
 * Fake-Retell-client integration test — a real listening socket
 * (`app.listen({port:0})`) plus Node's built-in global `WebSocket` as the
 * client, driving the route over actual bytes on the wire. The literal
 * IMPLEMENTATION_PLAN Phase 8 "Done when": a fake Retell client drives a
 * full booking over the local WebSocket, and a gas-smell script proves
 * `agent_interrupt` framing.
 *
 * `@fastify/websocket`'s own `injectWS()` helper (which fakes the upgrade
 * in-process, no real socket) was tried first, but is incompatible with the
 * installed fastify@5.11.2 (`preParsingHookRunner` throws on a fake-request
 * shape `injectWS` constructs — a test-harness bug, not anything in this
 * route). A real listener sidesteps it entirely and is arguably the more
 * faithful fixture anyway: Retell's real client always does a normal HTTP
 * Upgrade handshake over the wire, never an in-process fake one.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import websocketPlugin from '@fastify/websocket';
import { eq } from 'drizzle-orm';
import { db } from '../../../src/db/client.js';
import { appointments, conversations, emergencyFlags } from '../../../src/db/schema.js';
import { registerRetellWebsocketRoute } from '../../../src/transports/retell/websocket.js';
import { ScriptedProvider } from '../../../src/agent/providers/scripted.js';
import type { AgentProvider } from '../../../src/agent/types.js';
import { eventBus, type DashboardEvent } from '../../../src/events/bus.js';
import { resetDb, seedFixtures } from '../../helpers/db.js';

interface Frame {
  response_type: string;
  [key: string]: unknown;
}

async function buildRetellWsTestApp(
  providerFactory: () => AgentProvider,
): Promise<{ app: FastifyInstance; wsUrl: (callId: string) => string }> {
  const app = Fastify({ logger: false });
  await app.register(websocketPlugin);
  await app.register(registerRetellWebsocketRoute, { providerFactory });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { app, wsUrl: (callId: string) => `ws://127.0.0.1:${port}/llm-websocket/${callId}` };
}

function makeCollector(ws: WebSocket) {
  const frames: Frame[] = [];
  ws.addEventListener('message', (event: MessageEvent) => {
    frames.push(JSON.parse(String(event.data)) as Frame);
  });
  return {
    frames,
    async waitFor(predicate: (f: Frame) => boolean, timeoutMs = 5000): Promise<Frame> {
      const start = Date.now();
      for (;;) {
        const found = frames.find(predicate);
        if (found) return found;
        if (Date.now() - start > timeoutMs) {
          throw new Error(`timed out waiting for a matching frame; got: ${JSON.stringify(frames)}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    },
  };
}

async function connect(url: string): Promise<WebSocket> {
  const ws = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve());
    ws.addEventListener('error', (event) => reject(new Error(`ws connect failed: ${String(event)}`)));
  });
  return ws;
}

/** Subscribes first, then synchronously fires `trigger` — avoids a race
 * where the event could publish before the subscription is in place. */
async function waitForEvent(
  predicate: (e: DashboardEvent) => boolean,
  trigger: () => void,
  timeoutMs = 5000,
): Promise<DashboardEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error('timed out waiting for event'));
    }, timeoutMs);
    const unsubscribe = eventBus.subscribe((e) => {
      if (!predicate(e)) return;
      clearTimeout(timer);
      unsubscribe();
      resolve(e);
    });
    trigger();
  });
}

describe('Retell Custom LLM WebSocket — /llm-websocket/:call_id', () => {
  let app: FastifyInstance | undefined;

  beforeEach(async () => {
    await resetDb();
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('drives a full routine booking end to end over the socket, with streamed frames and tool frames', async () => {
    const fx = await seedFixtures();
    const provider = new ScriptedProvider({
      name: 'ws-routine-booking',
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
            issue_summary: 'Annual tune-up',
            required_skills: [],
            scheduled_start: '2027-06-01T14:00:00.000Z',
            source_channel: 'voice',
          },
          alsoText: 'Booking that now.',
        },
        { type: 'text', text: "You're all set — confirmation coming your way." },
      ],
    });
    const built = await buildRetellWsTestApp(() => provider);
    app = built.app;
    const callId = 'ws-routine-1';
    const ws = await connect(built.wsUrl(callId));
    const collector = makeCollector(ws);

    await waitForEvent(
      (e) => e.type === 'call.started' && e.callId === callId,
      () => {
        ws.send(
          JSON.stringify({
            interaction_type: 'call_details',
            call: { call_id: callId, from_number: fx.customerPhone },
          }),
        );
      },
    );

    ws.send(
      JSON.stringify({
        interaction_type: 'response_required',
        response_id: 1,
        transcript: [{ role: 'user', content: 'Book my annual tune-up in Cobb County' }],
      }),
    );

    const finalFrame = await collector.waitFor(
      (f) => f.response_type === 'response' && f.response_id === 1 && f.content_complete === true,
    );
    expect(finalFrame).toBeDefined();

    const responseDeltas = collector.frames.filter(
      (f) => f.response_type === 'response' && f.content_complete === false,
    );
    expect(responseDeltas.length).toBeGreaterThan(0);

    const invocations = collector.frames.filter((f) => f.response_type === 'tool_call_invocation');
    const results = collector.frames.filter((f) => f.response_type === 'tool_call_result');
    expect(invocations.length).toBe(results.length);
    expect(invocations.some((f) => f.name === 'book_appointment')).toBe(true);
    expect(invocations.some((f) => f.name === 'customer_lookup')).toBe(true);

    const rows = await db
      .select()
      .from(appointments)
      .where(eq(appointments.customerId, fx.customerId));
    expect(rows).toHaveLength(1);

    ws.close();
  });

  it('routes a gas-smell turn through agent_interrupt frames instead of normal response frames', async () => {
    const provider = new ScriptedProvider({
      name: 'ws-gas-smell',
      steps: [{ type: 'text', text: 'Please leave the property right now and call 911 outside.' }],
    });
    const built = await buildRetellWsTestApp(() => provider);
    app = built.app;
    const callId = 'ws-gas-smell-1';
    const ws = await connect(built.wsUrl(callId));
    const collector = makeCollector(ws);

    await waitForEvent(
      (e) => e.type === 'call.started' && e.callId === callId,
      () => {
        ws.send(
          JSON.stringify({
            interaction_type: 'call_details',
            call: { call_id: callId, from_number: '+17705550188' },
          }),
        );
      },
    );

    ws.send(
      JSON.stringify({
        interaction_type: 'response_required',
        response_id: 1,
        transcript: [{ role: 'user', content: 'I smell gas near the furnace' }],
      }),
    );

    const finalInterrupt = await collector.waitFor(
      (f) => f.response_type === 'agent_interrupt' && f.content_complete === true,
    );
    expect(finalInterrupt).toBeDefined();
    expect(collector.frames.some((f) => f.response_type === 'response')).toBe(false);

    const invocations = collector.frames.filter(
      (f) => f.response_type === 'tool_call_invocation' && f.name === 'flag_emergency',
    );
    expect(invocations).toHaveLength(1);

    const flags = await db.select().from(emergencyFlags);
    expect(flags).toHaveLength(1);
    expect(flags[0]?.reason).toBe('gas_smell');

    ws.close();
  });

  it('finalizes the conversation on socket close', async () => {
    const provider = new ScriptedProvider({ name: 'ws-close', steps: [] });
    const built = await buildRetellWsTestApp(() => provider);
    app = built.app;
    const callId = 'ws-close-1';
    const ws = await connect(built.wsUrl(callId));

    await waitForEvent(
      (e) => e.type === 'call.started' && e.callId === callId,
      () => {
        ws.send(
          JSON.stringify({
            interaction_type: 'call_details',
            call: { call_id: callId, from_number: '+17705550199' },
          }),
        );
      },
    );

    await waitForEvent(
      (e) => e.type === 'call.ended' && e.callId === callId,
      () => {
        ws.close();
      },
    );

    const [row] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.externalId, callId));
    expect(row?.endedAt).not.toBeNull();
  });
});
