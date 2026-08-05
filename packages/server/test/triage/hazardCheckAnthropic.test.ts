/**
 * Opt-in smoke test against the real Anthropic API — skipped entirely
 * without ANTHROPIC_API_KEY, so the default `npm test` run stays $0. Not
 * part of the CI-blocking suite.
 */
import { describe, expect, it } from 'vitest';
import { AnthropicHazardCheckProvider } from '../../src/triage/hazardCheckAnthropic.js';

const apiKey = process.env.ANTHROPIC_API_KEY;

describe.skipIf(!apiKey)('AnthropicHazardCheckProvider (opt-in, live API)', () => {
  const provider = new AnthropicHazardCheckProvider({ apiKey: apiKey!, model: 'claude-haiku-4-5' });

  it('classifies an actual gas-hazard report as a hazard', async () => {
    const result = await provider.check({
      transcript: 'I smell gas in the kitchen',
      candidateText: 'I smell gas in the kitchen',
    });
    expect(result.hazard).toBe(true);
  });

  it('classifies an unrelated "gas" mention as not a hazard', async () => {
    const result = await provider.check({
      transcript: 'the gas company called about my bill',
      candidateText: 'the gas company called about my bill',
    });
    expect(result.hazard).toBe(false);
  });
});
