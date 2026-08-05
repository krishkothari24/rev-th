/**
 * Opt-in smoke test against the real Anthropic API — skipped entirely
 * without ANTHROPIC_API_KEY, so the default `npm test` run stays $0 and
 * doesn't require an internet connection. Not part of the CI-blocking
 * suite; run manually with a key set to sanity-check the live wiring.
 */
import { describe, expect, it } from 'vitest';
import { AnthropicProvider } from '../../../src/agent/providers/anthropic.js';

const apiKey = process.env.ANTHROPIC_API_KEY;

describe.skipIf(!apiKey)('AnthropicProvider (opt-in, live API)', () => {
  it('returns a text response for a simple prompt', async () => {
    const provider = new AnthropicProvider({ apiKey: apiKey!, model: 'claude-sonnet-5' });
    const res = await provider.send({
      systemPrompt: 'Respond with exactly one word: pong',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
      tools: [],
    });
    expect(res.stopReason).toBe('end_turn');
    expect(res.content.some((b) => b.type === 'text')).toBe(true);
  });

  it('emits a tool_use block when a matching tool is provided', async () => {
    const provider = new AnthropicProvider({ apiKey: apiKey!, model: 'claude-sonnet-5' });
    const res = await provider.send({
      systemPrompt:
        'You must call the get_time tool whenever asked what time it is. Never answer that question directly.',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'What time is it right now?' }] }],
      tools: [
        {
          name: 'get_time',
          description:
            'Returns the current time. Call this whenever the user asks what time it is.',
          input_schema: { type: 'object', properties: {}, additionalProperties: false },
        },
      ],
    });
    expect(res.stopReason).toBe('tool_use');
    expect(res.content.some((b) => b.type === 'tool_use' && b.name === 'get_time')).toBe(true);
  });
});
