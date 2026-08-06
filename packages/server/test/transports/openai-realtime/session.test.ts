/**
 * Fake-OpenAI-server integration test for `runRealtimeSession` — inverted
 * from `retell/websocket.test.ts`'s "fake client drives our server" shape,
 * since here *we* are the WebSocket client and OpenAI's Realtime session is
 * the server. A real `ws` `WebSocketServer` stands in for it, driven by
 * hand-sent fixture frames matching the documented event shapes (see
 * session.ts's docblock for the "confirm against real traffic" caveat).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { eq } from 'drizzle-orm';
import { db } from '../../../src/db/client.js';
import { appointments, conversations, emergencyFlags } from '../../../src/db/schema.js';
import { startConversation } from '../../../src/agent/context.js';
import { runRealtimeSession } from '../../../src/transports/openai-realtime/session.js';
import { eventBus, type DashboardEvent } from '../../../src/events/bus.js';
import { resetDb, seedFixtures } from '../../helpers/db.js';

interface Frame {
  type: string;
  [key: string]: unknown;
}

async function startFakeServer(): Promise<{ wss: WebSocketServer; port: number }> {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>((resolve) => wss.once('listening', () => resolve()));
  const address = wss.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { wss, port };
}

/** Connects a client and returns both sockets once the server side has
 * accepted the connection — mirrors `retell/websocket.test.ts`'s `connect`
 * helper, just for a connection our own code initiates rather than one it
 * accepts. */
async function connectPair(
  wss: WebSocketServer,
  port: number,
): Promise<{ client: WebSocket; server: WebSocket }> {
  const serverConnection = new Promise<WebSocket>((resolve) => {
    wss.once('connection', (serverSocket) => resolve(serverSocket));
  });
  const client = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise<void>((resolve, reject) => {
    client.once('open', () => resolve());
    client.once('error', reject);
  });
  const server = await serverConnection;
  return { client, server };
}

function makeCollector(socket: WebSocket) {
  const frames: Frame[] = [];
  socket.on('message', (raw) => {
    frames.push(JSON.parse(raw.toString()) as Frame);
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

async function waitForEvent(
  predicate: (e: DashboardEvent) => boolean,
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
  });
}

describe('OpenAI Realtime session — runRealtimeSession', () => {
  let wss: WebSocketServer | undefined;

  beforeEach(async () => {
    await resetDb();
  });

  afterEach(async () => {
    wss?.close();
    wss = undefined;
  });

  it('drives a full routine booking end to end via a function_call round trip', async () => {
    const fx = await seedFixtures();
    const started = await startFakeServer();
    wss = started.wss;
    const { client, server } = await connectPair(started.wss, started.port);
    const collector = makeCollector(server);

    const callId = 'rt-session-booking-1';
    const state = await startConversation({
      channel: 'voice',
      externalId: callId,
      callerPhone: fx.customerPhone,
    });
    runRealtimeSession(state, client, 'initial instructions');

    const toolCallId = 'fc_1';
    server.send(
      JSON.stringify({
        type: 'response.function_call_arguments.done',
        call_id: toolCallId,
        name: 'book_appointment',
        arguments: JSON.stringify({
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
        }),
      }),
    );

    const output = await collector.waitFor(
      (f) =>
        f.type === 'conversation.item.create' &&
        (f.item as { type?: string } | undefined)?.type === 'function_call_output',
    );
    const item = output.item as { call_id: string; output: string };
    expect(item.call_id).toBe(toolCallId);
    expect(JSON.parse(item.output).booked).toBe(true);

    await collector.waitFor((f) => f.type === 'response.create');

    const rows = await db
      .select()
      .from(appointments)
      .where(eq(appointments.customerId, fx.customerId));
    expect(rows).toHaveLength(1);

    client.close();
  });

  it('short-circuits a second flag_emergency function call once already flagged, without a second DB write', async () => {
    const started = await startFakeServer();
    wss = started.wss;
    const { client, server } = await connectPair(started.wss, started.port);
    const collector = makeCollector(server);

    const callId = 'rt-session-flag-twice-1';
    const state = await startConversation({
      channel: 'voice',
      externalId: callId,
      callerPhone: '+17705550177',
    });
    state.emergencyFlaggedAt = new Date();
    state.emergencyFlagReason = 'gas_smell';
    runRealtimeSession(state, client, 'initial instructions');

    server.send(
      JSON.stringify({
        type: 'response.function_call_arguments.done',
        call_id: 'fc_flag_2',
        name: 'flag_emergency',
        arguments: JSON.stringify({ phone: '+17705550177', address: '1 Test St', reason: 'other' }),
      }),
    );

    const output = await collector.waitFor(
      (f) =>
        f.type === 'conversation.item.create' &&
        (f.item as { type?: string } | undefined)?.type === 'function_call_output',
    );
    const result = JSON.parse((output.item as { output: string }).output);
    expect(result.already_flagged).toBe(true);

    const flags = await db.select().from(emergencyFlags);
    expect(flags).toHaveLength(0); // the pre-set state, not a real dispatch, so nothing to find

    client.close();
  });

  it('forces a safety-override interrupt on a gas-smell transcript, cancelling any active response', async () => {
    const started = await startFakeServer();
    wss = started.wss;
    const { client, server } = await connectPair(started.wss, started.port);
    const collector = makeCollector(server);

    const callId = 'rt-session-gas-1';
    const state = await startConversation({
      channel: 'voice',
      externalId: callId,
      callerPhone: '+17705550188',
    });
    runRealtimeSession(state, client, 'initial instructions');

    // A response already in progress, so the forced interrupt has something
    // to response.cancel — the equivalent of Retell's agent_interrupt firing
    // mid-utterance rather than between turns.
    server.send(JSON.stringify({ type: 'response.created', response: { id: 'resp_1' } }));

    const flaggedEventPromise = waitForEvent(
      (e) => e.type === 'emergency.flagged' && e.callId === callId,
    );

    server.send(
      JSON.stringify({
        type: 'conversation.item.input_audio_transcription.completed',
        transcript: 'I smell gas near the furnace',
      }),
    );

    await flaggedEventPromise;

    const cancelFrame = await collector.waitFor((f) => f.type === 'response.cancel');
    expect(cancelFrame.response_id).toBe('resp_1');

    const directiveFrame = await collector.waitFor(
      (f) =>
        f.type === 'conversation.item.create' &&
        (f.item as { type?: string } | undefined)?.type === 'message',
    );
    const item = directiveFrame.item as { content: { text: string }[] };
    expect(item.content[0]?.text).toContain('SAFETY OVERRIDE');
    expect(item.content[0]?.text.toLowerCase()).toContain('leave');

    await collector.waitFor((f) => f.type === 'response.create');

    const flags = await db.select().from(emergencyFlags);
    expect(flags).toHaveLength(1);
    expect(flags[0]?.reason).toBe('gas_smell');

    client.close();
  });

  it('finalizes the conversation when the socket closes', async () => {
    const started = await startFakeServer();
    wss = started.wss;
    const { client } = await connectPair(started.wss, started.port);

    const callId = 'rt-session-close-1';
    const state = await startConversation({
      channel: 'voice',
      externalId: callId,
      callerPhone: '+17705550199',
    });
    runRealtimeSession(state, client, 'initial instructions');

    const endedPromise = waitForEvent((e) => e.type === 'call.ended' && e.callId === callId);
    client.close();
    await endedPromise;

    const [row] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.externalId, callId));
    expect(row?.endedAt).not.toBeNull();
  });
});
