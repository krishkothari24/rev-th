import { describe, expect, it } from 'vitest';
import { disabledHazardCheckProvider } from '../../src/triage/hazardCheck.js';

describe('disabledHazardCheckProvider', () => {
  it('always resolves hazard: false, with no I/O', async () => {
    const result = await disabledHazardCheckProvider.check({
      transcript: 'I smell gas',
      candidateText: 'I smell gas',
    });
    expect(result.hazard).toBe(false);
  });

  it('does not throw on empty input', async () => {
    const result = await disabledHazardCheckProvider.check({ transcript: '', candidateText: '' });
    expect(result.hazard).toBe(false);
  });
});
