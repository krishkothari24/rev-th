/**
 * The sabotage test, ported to the OpenAI Realtime adapter (IMPLEMENTATION_
 * PLAN Phase 11's explicit "done when" gate — see docs/BUILD_GUIDE.md §12
 * and test/agent/sabotage.test.ts, which this mirrors). The Retell version
 * proves the safety override doesn't depend on our own driven model reading
 * the safety section. This version proves something one layer further out:
 * the override doesn't depend on *anything OpenAI's Realtime model does or
 * doesn't do* — no `function_call` for `flag_emergency` is ever sent by the
 * fake server in this test, and the `instructions` handed to the session at
 * accept time have the safety section physically stripped out. The flag
 * still fires, sourced entirely from `runRealtimeSession`'s own transcript
 * listener + `classifyUrgency` + `fireSafetyOverride` — the vendor's model
 * is never in that loop at all for this control, regardless of which vendor
 * it is.
 */
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { db } from '../../../src/db/client.js';
import { emergencyFlags } from '../../../src/db/schema.js';
import { eventBus, type DashboardEvent } from '../../../src/events/bus.js';
import { loadAgentSystemPrompt } from '../../../src/agent/prompts.js';
import { startConversation } from '../../../src/agent/context.js';
import { runRealtimeSession } from '../../../src/transports/openai-realtime/session.js';
import { resetDb } from '../../helpers/db.js';
import { stripSafetyProtocolSection } from '../../helpers/prompts.js';

interface Frame {
  type: string;
  [key: string]: unknown;
}

describe('sabotage test (OpenAI Realtime) — safety fires with the safety section stripped from instructions, and no function_call from the vendor model at all', () => {
  it('flags the gas-smell call from the transcript listener alone', async () => {
    await resetDb();

    const sabotagedInstructions = stripSafetyProtocolSection(loadAgentSystemPrompt());
    expect(sabotagedInstructions).not.toContain('Safety protocol');
    expect(sabotagedInstructions).not.toContain('leave the property');

    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise<void>((resolve) => wss.once('listening', () => resolve()));
    const address = wss.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    try {
      const serverConnection = new Promise<WebSocket>((resolve) => {
        wss.once('connection', (serverSocket) => resolve(serverSocket));
      });
      const client = new WebSocket(`ws://127.0.0.1:${port}`);
      await new Promise<void>((resolve, reject) => {
        client.once('open', () => resolve());
        client.once('error', reject);
      });
      const server = await serverConnection;

      const frames: Frame[] = [];
      server.on('message', (raw) => frames.push(JSON.parse(raw.toString()) as Frame));

      const callId = 'sabotage-openai-realtime-1';
      const state = await startConversation({
        channel: 'voice',
        externalId: callId,
        callerPhone: '+17705550199',
      });

      // The instructions the (real, unsabotaged-by-us) OpenAI model would
      // have been configured with — safety section physically absent.
      runRealtimeSession(state, client, sabotagedInstructions);

      const events: DashboardEvent[] = [];
      const unsubscribe = eventBus.subscribe((event) => events.push(event));

      try {
        // Only a caller-transcript event — never a function_call frame for
        // flag_emergency. If the control depended on the (sabotaged) model
        // deciding to call the tool, nothing would fire here at all.
        server.send(
          JSON.stringify({
            type: 'conversation.item.input_audio_transcription.completed',
            transcript: 'I think I smell gas near the furnace',
          }),
        );

        const start = Date.now();
        while (!events.some((e) => e.type === 'emergency.flagged')) {
          if (Date.now() - start > 5000) throw new Error('timed out waiting for emergency.flagged');
          await new Promise((resolve) => setTimeout(resolve, 10));
        }

        const rows = await db
          .select()
          .from(emergencyFlags)
          .where(eq(emergencyFlags.callId, callId));
        expect(rows).toHaveLength(1);
        expect(rows[0]?.reason).toBe('gas_smell');

        const flaggedEvents = events.filter((e) => e.type === 'emergency.flagged');
        expect(flaggedEvents).toHaveLength(1);
        expect(flaggedEvents[0]).toMatchObject({ callId, reason: 'gas_smell' });

        // The forced directive went out over the socket — the caller is
        // actually told to leave, not just silently flagged in the DB —
        // even though no function_call ever arrived from "the model".
        expect(
          frames.some(
            (f) =>
              f.type === 'conversation.item.create' &&
              (f.item as { type?: string } | undefined)?.type === 'message',
          ),
        ).toBe(true);
      } finally {
        unsubscribe();
      }

      client.close();
    } finally {
      wss.close();
    }
  });
});
