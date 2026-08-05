/**
 * Season resolution — BUILD_GUIDE §3: "current date/time, season (drives
 * whether 'no heat' is urgent)" is injected into the agent's dynamic context
 * at conversation start, and triage/classify.ts's `deriveNonEmergencyUrgency`
 * uses season to decide whether a loss-of-heat/cooling report is urgent
 * regardless of a vulnerable person being present.
 *
 * Deliberately its own file rather than folded into agent/context.ts: this is
 * a plain calendar fact (same tier as BUSINESS_HOURS/SLOT_HOURS in
 * constants.ts), reusable by anything that needs "what season is it" without
 * pulling in the agent layer. Defines its own `Season` union rather than
 * importing triage/classify.ts's — the two are structurally identical, so
 * this file changes zero lines in classify.ts.
 */
export type Season = 'heating' | 'cooling' | 'shoulder';

export type SeasonOverride = 'auto' | Season;

// getMonth() is 0-indexed: Nov/Dec/Jan/Feb -> heating, May-Sep -> cooling,
// Mar/Apr/Oct -> shoulder. Shoulder months can still swing cold or hot, which
// is why classify.ts treats shoulder as season-relevant for both heat and
// cooling loss (see that file's isSeasonRelevant).
const HEATING_MONTHS = new Set([10, 11, 0, 1]); // Nov, Dec, Jan, Feb
const COOLING_MONTHS = new Set([4, 5, 6, 7, 8]); // May-Sep

/**
 * `override` short-circuits the calendar entirely — this is what
 * `config.SEASON_OVERRIDE` is for (demo control: force a "no heat in June"
 * scenario without waiting for winter).
 */
export function resolveSeason(now: Date, override: SeasonOverride = 'auto'): Season {
  if (override !== 'auto') return override;

  const month = now.getMonth();
  if (HEATING_MONTHS.has(month)) return 'heating';
  if (COOLING_MONTHS.has(month)) return 'cooling';
  return 'shoulder';
}
