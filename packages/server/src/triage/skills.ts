/**
 * Deterministic requiredSkills derivation — BUILD_GUIDE §5: "gas furnace /
 * gas smell → gas; commercial → commercial; refrigerant work →
 * refrigerant_epa."
 *
 * `requiredSkills` is an AND filter downstream — tools/availability.ts's
 * getEligibleTechnicians requires `requiredSkills.every((s) =>
 * t.skills.includes(s))` — so over-including a skill silently zeroes out the
 * eligible technician pool rather than degrading gracefully. Concretely:
 * Cherokee's only gas-certified technician (Sofia Reyes, db/seed.ts) has
 * `skills: ['residential', 'gas', 'install']` — no `'diagnostics'`. So
 * `'diagnostics'`, `'electrical'`, and `'install'` are never derived here:
 * no textual signal is specified for any of them in BUILD_GUIDE, and
 * defaulting `'diagnostics'` on would break the seed's deliberately-tight
 * Cherokee gas scenario.
 */
import type { PropertyType } from '../db/schema.js';
import type { Skill } from '../domain/constants.js';
import { matchGasHazardIndicators, normalizeText } from './indicators.js';

export interface DeriveRequiredSkillsInput {
  statedIssue: string;
  transcript: string;
  propertyType: PropertyType;
}

// Appliance-specific phrases only — a bare "is gas cheaper than electric"
// must not add the gas skill.
const GAS_EQUIPMENT_PATTERN =
  /\bgas\s+(?:furnace|heaters?|boiler|fireplace|water\s+heater|line)\b|\bnatural\s+gas\b|\bpropane\s+furnace\b/i;

// Deliberately broad: EPA 608 certification is a legal requirement to open a
// sealed refrigerant circuit, so over-routing to a certified tech on an
// ordinary AC call is the safe failure direction.
const REFRIGERANT_PATTERN =
  /\bair\s+conditioners?\b|\bair\s+conditioning\b|\bcentral\s+air\b|\bcentral\s+a\/?c\b|\ba\/?c\b|\bmini[- ]split\b|\brooftop\s+unit\b|\bheat\s+pump\b|\brefrigerant\b|\bfreon\b|\bcoolant\b|\bcompressor\b|\bcondenser\b|\bcoil\b/i;

export function deriveRequiredSkills(input: DeriveRequiredSkillsInput): Skill[] {
  const text = normalizeText(`${input.statedIssue} ${input.transcript}`);
  const skills: Skill[] = [input.propertyType === 'commercial' ? 'commercial' : 'residential'];

  // A gas-hazard call needs a gas-certified tech too — the one intentional
  // cross-import from indicators.ts.
  if (GAS_EQUIPMENT_PATTERN.test(text) || matchGasHazardIndicators(text).length > 0) {
    skills.push('gas');
  }
  if (REFRIGERANT_PATTERN.test(text)) {
    skills.push('refrigerant_epa');
  }

  return skills;
}
