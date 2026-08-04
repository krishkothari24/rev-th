import { describe, expect, it } from 'vitest';
import { deriveRequiredSkills } from '../../src/triage/skills.js';

describe('deriveRequiredSkills', () => {
  const cases: Array<{
    statedIssue: string;
    propertyType: 'residential' | 'commercial';
    expected: string[];
  }> = [
    { statedIssue: 'thermostat acting up', propertyType: 'residential', expected: ['residential'] },
    {
      statedIssue: 'rooftop unit needs service',
      propertyType: 'commercial',
      expected: ['commercial', 'refrigerant_epa'],
    },
    {
      statedIssue: 'my gas furnace needs a tune-up',
      propertyType: 'residential',
      expected: ['residential', 'gas'],
    },
    {
      statedIssue: 'smells like gas near the furnace',
      propertyType: 'residential',
      expected: ['residential', 'gas'],
    },
    {
      statedIssue: 'central AC is not cooling',
      propertyType: 'residential',
      expected: ['residential', 'refrigerant_epa'],
    },
    {
      statedIssue: 'heat pump making a weird noise',
      propertyType: 'residential',
      expected: ['residential', 'refrigerant_epa'],
    },
    {
      statedIssue: 'gas furnace and central air both need service',
      propertyType: 'residential',
      expected: ['residential', 'gas', 'refrigerant_epa'],
    },
    {
      statedIssue: 'electrical panel tripped',
      propertyType: 'residential',
      expected: ['residential'],
    },
    { statedIssue: '', propertyType: 'residential', expected: ['residential'] },
    {
      statedIssue: 'is gas cheaper than electric heat',
      propertyType: 'residential',
      expected: ['residential'],
    },
  ];

  it.each(cases)(
    'derives $expected for "$statedIssue" ($propertyType)',
    ({ statedIssue, propertyType, expected }) => {
      const skills = deriveRequiredSkills({ statedIssue, transcript: '', propertyType });
      expect([...skills].sort()).toEqual([...expected].sort());
    },
  );

  it('never derives diagnostics, electrical, or install — Sofia Reyes (Cherokee gas) regression guard', () => {
    for (const { statedIssue, propertyType } of cases) {
      const skills = deriveRequiredSkills({ statedIssue, transcript: '', propertyType });
      expect(skills).not.toContain('diagnostics');
      expect(skills).not.toContain('electrical');
      expect(skills).not.toContain('install');
    }
  });

  it('reads the transcript too, not just statedIssue', () => {
    const skills = deriveRequiredSkills({
      statedIssue: 'routine maintenance',
      transcript: 'the gas furnace needs a new igniter',
      propertyType: 'residential',
    });
    expect(skills).toContain('gas');
  });
});
