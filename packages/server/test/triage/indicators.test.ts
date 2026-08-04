import { describe, expect, it } from 'vitest';
import { hasHazardCandidateToken, matchGasHazardIndicators } from '../../src/triage/indicators.js';

describe('matchGasHazardIndicators — true positives', () => {
  const cases: Array<{ text: string; id: string }> = [
    { text: 'I smell gas', id: 'smell-gas' },
    { text: 'There is a gas smell in the kitchen', id: 'smell-gas' },
    { text: 'It smells like rotten eggs', id: 'rotten-egg' },
    { text: 'There is a sulfur smell coming from the basement', id: 'sulfur' },
    { text: 'There is a sulphur smell too', id: 'sulfur' },
    { text: 'I think there is a gas leak somewhere', id: 'gas-leak' },
    { text: 'I hear hissing right by the gas meter', id: 'hissing-near-source' },
    { text: 'The gas line is hissing', id: 'hissing-near-source' },
    { text: 'I can taste gas in the air', id: 'taste-gas' },
    { text: 'there is an odor of gas near the water heater', id: 'odor-gas' },
  ];

  it.each(cases)('fires $id for "$text"', ({ text, id }) => {
    const ids = matchGasHazardIndicators(text).map((m) => m.id);
    expect(ids).toContain(id);
  });

  it('scans the whole transcript, not just the last turn', () => {
    const transcript = [
      "Caller: Hi, I'd like to schedule my annual furnace tune-up.",
      'Agent: Sure, when works for you?',
      'Caller: Actually, hang on — I smell gas.',
    ].join('\n');
    expect(matchGasHazardIndicators(transcript).map((m) => m.id)).toContain('smell-gas');
  });

  it('is case-insensitive', () => {
    expect(matchGasHazardIndicators('I SMELL GAS!!').map((m) => m.id)).toContain('smell-gas');
  });

  it('fires within a same-clause gap under the CLAUSE_GAP bound', () => {
    const text = 'I smell something faintly like gas';
    expect(matchGasHazardIndicators(text).map((m) => m.id)).toContain('smell-gas');
  });
});

describe('matchGasHazardIndicators — false positives (must not fire)', () => {
  const cases = [
    'the gas company called about my bill',
    'I pay my gas bill online',
    'I stopped by the gas station',
    'my gas furnace needs a tune-up',
    'looking for a gas fireplace installation quote',
    'I smell something odd in the garage',
    'the furnace runs on gas and needs annual maintenance',
    'is gas cheaper than electric heat',
  ];

  it.each(cases)('does not fire for "%s"', (text) => {
    expect(matchGasHazardIndicators(text)).toHaveLength(0);
  });

  it('does not bridge across a sentence boundary', () => {
    const text = 'I smell something odd. Anyway, we pay our gas bill online.';
    expect(matchGasHazardIndicators(text)).toHaveLength(0);
  });

  it('does not bridge a gap wider than CLAUSE_GAP', () => {
    const text = `I smell ${'something '.repeat(5)}gas`; // well over 30 chars between the words
    expect(matchGasHazardIndicators(text)).toHaveLength(0);
  });

  it('does not throw on empty or whitespace input', () => {
    expect(matchGasHazardIndicators('')).toHaveLength(0);
    expect(matchGasHazardIndicators('   ')).toHaveLength(0);
  });
});

describe('hasHazardCandidateToken', () => {
  it('is broader than matchGasHazardIndicators — bare "gas" alone counts', () => {
    expect(hasHazardCandidateToken('I smell gas')).toBe(true);
    expect(hasHazardCandidateToken('the gas company called about my bill')).toBe(true);
  });

  it('is false when there is no hazard-relevant token at all', () => {
    expect(hasHazardCandidateToken('I smell something odd in the garage')).toBe(false);
    expect(hasHazardCandidateToken('annual maintenance tune-up')).toBe(false);
    expect(hasHazardCandidateToken('')).toBe(false);
  });
});
