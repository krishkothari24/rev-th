import { describe, expect, it } from 'vitest';
import { applyServerOwnedOverrides } from '../../src/agent/serverOwnedFields.js';
import type { ClassifyUrgencyResult } from '../../src/triage/classify.js';

const triage: ClassifyUrgencyResult = {
  urgency: 'priority',
  requiredSkills: ['gas'],
  safetyOverride: { fired: false },
};

describe('applyServerOwnedOverrides', () => {
  it('overrides urgency and required_skills on check_availability, leaving other fields alone', () => {
    const result = applyServerOwnedOverrides(
      'check_availability',
      { county: 'Cobb', urgency: 'routine', required_skills: [] },
      triage,
    );
    expect(result.urgency).toBe('priority');
    expect(result.required_skills).toEqual(['gas']);
    expect(result.county).toBe('Cobb');
  });

  it('overrides urgency and required_skills on book_appointment, leaving other fields alone', () => {
    const result = applyServerOwnedOverrides(
      'book_appointment',
      { urgency: 'routine', required_skills: [], name: 'Jane' },
      triage,
    );
    expect(result.urgency).toBe('priority');
    expect(result.required_skills).toEqual(['gas']);
    expect(result.name).toBe('Jane');
  });

  it('leaves tools outside the server-owned set untouched', () => {
    const args = { phone: '+17705550100', address: '1 Test Way', reason: 'gas_smell' };
    const result = applyServerOwnedOverrides('flag_emergency', args, triage);
    expect(result).toEqual(args);
  });

  it('a model-supplied urgency/required_skills attempt is discarded outright, not merged', () => {
    const result = applyServerOwnedOverrides(
      'book_appointment',
      { urgency: 'emergency', required_skills: ['electrical'] },
      triage,
    );
    expect(result.urgency).toBe('priority');
    expect(result.required_skills).toEqual(['gas']);
  });
});
