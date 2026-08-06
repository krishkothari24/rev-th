import { describe, expect, it, beforeEach } from 'vitest';
import { db } from '../../src/db/client.js';
import { conversations } from '../../src/db/schema.js';
import { eq } from 'drizzle-orm';
import {
  __resetSimSessionsForTests,
  endSimSession,
  runSimTurn,
  startSimSession,
} from '../../src/dashboard/simSession.js';
import { ScriptedProvider } from '../../src/agent/providers/scripted.js';
import type { AgentProvider } from '../../src/agent/types.js';
import { resetDb } from '../helpers/db.js';

function fakeProviderFactory(): (channel: 'voice' | 'sms') => AgentProvider {
  return () =>
    new ScriptedProvider({
      name: 'sim-session-test',
      steps: [{ type: 'text', text: 'Got it, thanks.' }],
    });
}

describe('dashboard sim session', () => {
  beforeEach(() => {
    __resetSimSessionsForTests();
  });

  it('starts a session, creates a conversations row, and returns a fresh externalId', async () => {
    await resetDb();
    const { externalId } = await startSimSession('+17705550301', 'voice', fakeProviderFactory());
    expect(externalId).toMatch(/^dash-sim-/);

    const [row] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.externalId, externalId));
    expect(row?.channel).toBe('voice');
  });

  it('runs a turn against the session and returns the assistant reply', async () => {
    await resetDb();
    const { externalId } = await startSimSession('+17705550302', 'voice', fakeProviderFactory());
    const result = await runSimTurn(externalId, 'Hi, my AC is out.');
    expect(result?.assistantReply).toBe('Got it, thanks.');
    // The loop auto-fires a call-start customer_lookup on turn one (Phase 6)
    // ahead of anything the (scripted) model itself does — for an unseeded
    // number that resolves to a clean "not found", same as a real new caller.
    expect(result?.toolCalls).toEqual([
      expect.objectContaining({ name: 'customer_lookup', initiator: 'loop' }),
    ]);
  });

  it('returns null for a turn against an unknown externalId', async () => {
    const result = await runSimTurn('does-not-exist', 'hello');
    expect(result).toBeNull();
  });

  it('ends a session, finalizing the conversation row', async () => {
    await resetDb();
    const { externalId } = await startSimSession('+17705550303', 'voice', fakeProviderFactory());
    const ended = await endSimSession(externalId);
    expect(ended).toBe(true);

    const [row] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.externalId, externalId));
    expect(row?.endedAt).not.toBeNull();
  });

  it('returns false ending an already-ended or unknown session', async () => {
    await resetDb();
    const { externalId } = await startSimSession('+17705550304', 'voice', fakeProviderFactory());
    await endSimSession(externalId);
    expect(await endSimSession(externalId)).toBe(false);
    expect(await endSimSession('never-existed')).toBe(false);
  });

  it('propagates a providerFactory failure (e.g. missing API key) without creating a session', async () => {
    await resetDb();
    await expect(
      startSimSession('+17705550305', 'voice', () => {
        throw new Error('ANTHROPIC_API_KEY is not set');
      }),
    ).rejects.toThrow(/ANTHROPIC_API_KEY/);

    const rows = await db
      .select()
      .from(conversations)
      .where(eq(conversations.externalId, 'dash-sim-should-not-exist'));
    expect(rows).toHaveLength(0);
  });
});
