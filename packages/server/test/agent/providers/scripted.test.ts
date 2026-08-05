import { describe, expect, it } from 'vitest';
import { ScriptedProvider } from '../../../src/agent/providers/scripted.js';
import type { ProviderRequest } from '../../../src/agent/types.js';

const emptyRequest: ProviderRequest = { systemPrompt: '', messages: [], tools: [] };

describe('ScriptedProvider', () => {
  it('replays a text step as an end_turn response', async () => {
    const provider = new ScriptedProvider({
      name: 'test',
      steps: [{ type: 'text', text: 'hello' }],
    });
    const res = await provider.send(emptyRequest);
    expect(res.stopReason).toBe('end_turn');
    expect(res.content).toEqual([{ type: 'text', text: 'hello' }]);
  });

  it('replays tool_use steps as tool_use responses, with a unique id each time', async () => {
    const provider = new ScriptedProvider({
      name: 'test',
      steps: [
        { type: 'tool_use', name: 'check_availability', input: { county: 'Cobb' } },
        { type: 'tool_use', name: 'book_appointment', input: { county: 'Cobb' } },
      ],
    });
    const first = await provider.send(emptyRequest);
    const second = await provider.send(emptyRequest);
    expect(first.stopReason).toBe('tool_use');
    expect(second.stopReason).toBe('tool_use');
    const firstBlock = first.content[0];
    const secondBlock = second.content[0];
    if (firstBlock?.type !== 'tool_use' || secondBlock?.type !== 'tool_use') {
      throw new Error('unreachable');
    }
    expect(firstBlock.id).not.toBe(secondBlock.id);
  });

  it('includes alsoText before the tool_use block when provided', async () => {
    const provider = new ScriptedProvider({
      name: 'test',
      steps: [
        { type: 'tool_use', name: 'flag_emergency', input: {}, alsoText: 'Okay, one moment.' },
      ],
    });
    const res = await provider.send(emptyRequest);
    expect(res.content[0]).toEqual({ type: 'text', text: 'Okay, one moment.' });
    expect(res.content[1]?.type).toBe('tool_use');
  });

  it('consumes steps in order, one per send() call', async () => {
    const provider = new ScriptedProvider({
      name: 'test',
      steps: [
        { type: 'text', text: 'first' },
        { type: 'text', text: 'second' },
      ],
    });
    const first = await provider.send(emptyRequest);
    const second = await provider.send(emptyRequest);
    expect(first.content).toEqual([{ type: 'text', text: 'first' }]);
    expect(second.content).toEqual([{ type: 'text', text: 'second' }]);
  });

  it('throws a clear error once the script is exhausted', async () => {
    const provider = new ScriptedProvider({ name: 'empty-script', steps: [] });
    await expect(provider.send(emptyRequest)).rejects.toThrow(/empty-script.*exhausted/);
  });
});

describe('ScriptedProvider — onTextDelta (IMPLEMENTATION_PLAN Phase 8)', () => {
  it('invokes onTextDelta once with the full text of a text step', async () => {
    const provider = new ScriptedProvider({
      name: 'test',
      steps: [{ type: 'text', text: 'hello there' }],
    });
    const deltas: string[] = [];
    await provider.send(emptyRequest, (d) => deltas.push(d));
    expect(deltas).toEqual(['hello there']);
  });

  it('invokes onTextDelta with alsoText for a tool_use step that has it', async () => {
    const provider = new ScriptedProvider({
      name: 'test',
      steps: [
        { type: 'tool_use', name: 'flag_emergency', input: {}, alsoText: 'Okay, one moment.' },
      ],
    });
    const deltas: string[] = [];
    await provider.send(emptyRequest, (d) => deltas.push(d));
    expect(deltas).toEqual(['Okay, one moment.']);
  });

  it('never invokes onTextDelta for a bare tool_use step with no alsoText', async () => {
    const provider = new ScriptedProvider({
      name: 'test',
      steps: [{ type: 'tool_use', name: 'check_availability', input: {} }],
    });
    const deltas: string[] = [];
    await provider.send(emptyRequest, (d) => deltas.push(d));
    expect(deltas).toEqual([]);
  });

  it('omitting onTextDelta produces the exact same response as before', async () => {
    const provider = new ScriptedProvider({
      name: 'test',
      steps: [{ type: 'text', text: 'hello' }],
    });
    const res = await provider.send(emptyRequest);
    expect(res).toEqual({ content: [{ type: 'text', text: 'hello' }], stopReason: 'end_turn' });
  });
});
