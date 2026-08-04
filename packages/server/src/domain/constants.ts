/**
 * Shared vocabulary for Summit Air's service area and technician roster.
 * Triage derives required skills from these values and the seed builds the
 * roster from them, so the two can never drift apart.
 */

export const SKILLS = [
  'gas',
  'electrical',
  'commercial',
  'refrigerant_epa',
  'residential',
  'install',
  'diagnostics',
] as const;

export type Skill = (typeof SKILLS)[number];

/** Summit Air covers three counties. */
export const COUNTIES = ['Cobb', 'Cherokee', 'Paulding'] as const;

export type County = (typeof COUNTIES)[number];

export const CITIES_BY_COUNTY: Record<County, readonly string[]> = {
  Cobb: ['Marietta', 'Smyrna', 'Kennesaw', 'Austell'],
  Cherokee: ['Canton', 'Woodstock', 'Holly Springs'],
  Paulding: ['Dallas', 'Hiram', 'New Hope'],
};

export function isCounty(value: string): value is County {
  return (COUNTIES as readonly string[]).includes(value);
}

export function isSkill(value: string): value is Skill {
  return (SKILLS as readonly string[]).includes(value);
}

/**
 * Normalizes what a caller actually says into a county we can schedule
 * against. Callers say "Marietta" or "Cobb County", never "Cobb".
 */
export function resolveCounty(input: string): County | null {
  const cleaned = input.trim().toLowerCase().replace(/\s+county$/, '');
  for (const county of COUNTIES) {
    if (county.toLowerCase() === cleaned) return county;
  }
  for (const [county, cities] of Object.entries(CITIES_BY_COUNTY)) {
    if (cities.some((city) => city.toLowerCase() === cleaned)) return county as County;
  }
  return null;
}

/** Standard service-call fee. The agent may state this; it never quotes repairs. */
export const DIAGNOSTIC_FEE_USD = 89;

/** Business hours used for slot generation, local time. */
export const BUSINESS_HOURS = { startHour: 8, endHour: 18 } as const;

/** Standard appointment window length, in hours. */
export const SLOT_HOURS = 2;
