/**
 * The proof that the gas-leak safety branch is a code control, not a prompt
 * suggestion (CLAUDE.md: "If the transcript matches gas-leak indicators, the
 * emergency path fires regardless of what the model decided. A prompt is
 * not a safety control."). Strips the real system prompt's safety section
 * out, drives a gas-smell utterance through a model that never calls
 * `flag_emergency`, and asserts the flag fires anyway — sourced from the
 * loop's own dispatch (`initiator: 'loop'`), never the model.
 */
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { emergencyFlags } from '../../src/db/schema.js';
import { eventBus, type DashboardEvent } from '../../src/events/bus.js';
import { loadAgentSystemPrompt } from '../../src/agent/prompts.js';
import { startConversation } from '../../src/agent/context.js';
import { runTurn } from '../../src/agent/loop.js';
import { ScriptedProvider } from '../../src/agent/providers/scripted.js';
import type { RateLimiter } from '../../src/agent/caps.js';
import { resetDb } from '../helpers/db.js';
import { stripSafetyProtocolSection } from '../helpers/prompts.js';

const alwaysAllow: RateLimiter = { checkAndRecord: () => ({ allowed: true }) };

describe('sabotage test — safety fires with the prompt stripped and a model that never calls flag_emergency', () => {
  it('flags the gas-smell call via the loop, independent of the sabotaged model', async () => {
    await resetDb();

    const sabotagedPrompt = stripSafetyProtocolSection(loadAgentSystemPrompt());
    expect(sabotagedPrompt).not.toContain('Safety protocol');
    expect(sabotagedPrompt).not.toContain('leave the property');

    const state = await startConversation({
      channel: 'voice',
      externalId: 'sabotage-1',
      callerPhone: '+17705550199',
      rateLimiter: alwaysAllow,
    });
    state.systemPromptOverride = sabotagedPrompt;

    // A model that never calls flag_emergency, no matter what the caller
    // says — the literal simulation of "a model that never saw or ignored
    // the safety section." If the control depended on the model reading the
    // stripped section, this is exactly the model that would fail to flag.
    const provider = new ScriptedProvider({
      name: 'sabotaged-model-ignores-gas-smell',
      steps: [{ type: 'text', text: "Sure, let's get that scheduled for you." }],
    });

    const events: DashboardEvent[] = [];
    const unsubscribe = eventBus.subscribe((event) => events.push(event));

    try {
      const result = await runTurn(state, 'I think I smell gas near the furnace', provider);

      expect(result.safetyOverrideFired).toBe(true);
      expect(result.emergencyFlaggedThisTurn).toBe(true);

      const flagCall = result.toolCalls.find((c) => c.name === 'flag_emergency');
      expect(flagCall?.initiator).toBe('loop'); // never 'model' — the sabotaged model never called it itself
      expect(flagCall?.isError).toBe(false);

      const rows = await db
        .select()
        .from(emergencyFlags)
        .where(eq(emergencyFlags.callId, 'sabotage-1'));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.reason).toBe('gas_smell');

      const flaggedEvents = events.filter((e) => e.type === 'emergency.flagged');
      expect(flaggedEvents).toHaveLength(1);
      expect(flaggedEvents[0]).toMatchObject({ callId: 'sabotage-1', reason: 'gas_smell' });
    } finally {
      unsubscribe();
    }
  });
});
