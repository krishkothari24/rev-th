/**
 * Deterministic, $0 stand-in for a real model — what every CI test drives,
 * including the sabotage test (IMPLEMENTATION_PLAN Phase 4: "drives all CI").
 * A "script" is a flat, ordered list of steps, one consumed per `send()`
 * call — not matched against caller text. One caller turn can trigger
 * multiple `send()` calls (tool round-trips inside agent/loop.ts), so a
 * step-index sequence gives a fully deterministic, order-exact fixture: the
 * test author controls both sides of the conversation (the driving
 * utterances *and* the script), so this loses no expressiveness for a
 * golden-path fixture — a "well-behaved model" script is a `steps` array
 * that calls the expected tools in order; a "model that never calls
 * flag_emergency" sabotage script is simply a `steps` array that never
 * contains a `tool_use` step naming `flag_emergency`, regardless of what the
 * caller said.
 */
import type {
  AgentProvider,
  ContentBlock,
  OnAssistantTextDelta,
  ProviderRequest,
  ProviderResponse,
} from '../types.js';

export type ScriptedStep =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; name: string; input: Record<string, unknown>; alsoText?: string };

export interface ScriptedProviderScript {
  name: string;
  steps: ScriptedStep[];
}

let toolUseIdCounter = 0;

export class ScriptedProvider implements AgentProvider {
  private readonly script: ScriptedProviderScript;
  private cursor = 0;

  constructor(script: ScriptedProviderScript) {
    this.script = script;
  }

  // Declared `async` (not just Promise-returning) so a synchronous "script
  // exhausted" throw surfaces as a rejected promise, matching a real
  // provider's failure mode instead of throwing before the caller awaits.
  //
  // `onTextDelta`, when given, fires once with the step's full text (no
  // chunking — a scripted fixture has no meaningful sub-token granularity to
  // simulate) before returning, so the streaming path is exercisable in
  // tests without a live model. A pure `tool_use` step with no `alsoText`
  // fires zero deltas, matching a real provider that goes straight to a tool
  // call with no preamble.
  async send(_request: ProviderRequest, onTextDelta?: OnAssistantTextDelta): Promise<ProviderResponse> {
    const step = this.script.steps[this.cursor];
    if (!step) {
      throw new Error(
        `ScriptedProvider "${this.script.name}" script exhausted after ${this.cursor} step(s) — ` +
          'the loop asked for another turn but the fixture has no more steps.',
      );
    }
    this.cursor += 1;

    if (step.type === 'text') {
      onTextDelta?.(step.text);
      const content: ContentBlock[] = [{ type: 'text', text: step.text }];
      return { content, stopReason: 'end_turn' };
    }

    const content: ContentBlock[] = [];
    if (step.alsoText) {
      onTextDelta?.(step.alsoText);
      content.push({ type: 'text', text: step.alsoText });
    }
    content.push({
      type: 'tool_use',
      id: `scripted-${(toolUseIdCounter += 1)}`,
      name: step.name,
      input: step.input,
    });
    return { content, stopReason: 'tool_use' };
  }
}
