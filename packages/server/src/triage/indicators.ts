/**
 * Gas-leak hazard indicators — BUILD_GUIDE §5. This is the safety-critical
 * core of the triage module: deterministic detection that must catch every
 * genuine gas-leak report and must not misfire on ordinary "gas" mentions
 * ("the gas company called", "I pay my gas bill online").
 *
 * Design: never match on the bare word "gas". Every indicator below pairs a
 * hazard-substance word (gas, sulfur, rotten egg) with a hazard-descriptor
 * word (smell, odor, leak, hiss, taste) within a bounded same-clause window
 * (CLAUSE_GAP excludes sentence terminators and newlines, so a hazard word in
 * one sentence can't pair with an unrelated word in a different one) — or is
 * a phrase unambiguous enough to stand alone (rotten egg, sulfur). This
 * proximity design is what defeats "the gas company called" and "I pay my
 * gas bill online" without needing an open-ended denylist of every
 * non-hazard "gas ___" phrase in English.
 *
 * classify.ts combines this deterministic signal with an injectable LLM
 * second opinion (hazardCheck.ts) — either firing counts as a hazard.
 */

export interface GasHazardIndicator {
  id: string;
  pattern: RegExp;
  description: string;
}

/**
 * Same-clause window used to bound every proximity match below: up to 30
 * characters, none of which may be a sentence terminator or newline.
 * Exported so tests can pin the exact boundary and other triage patterns
 * (classify.ts's loss-of-conditioning detection) can reuse it.
 */
export const CLAUSE_GAP = '[^.?!\\n]{0,30}';

function near(a: string, b: string): RegExp {
  return new RegExp(`(?:${a}${CLAUSE_GAP}${b}|${b}${CLAUSE_GAP}${a})`, 'i');
}

// Reusable word fragments, each already bounded on both sides so none of
// them can match as a substring inside an unrelated word (e.g. "gas" inside
// "biogas", "out" inside "about").
const GAS = '\\bgas\\b';
const SMELL = '\\bsmell\\w*';
const ODOR = '\\bodor\\b';
const LEAK = '\\bleak\\w*';
const HISS = '\\bhiss\\w*';
const TASTE = '\\btaste\\w*';
const GAS_SOURCE = '\\b(?:gas|meter|pipe|line)\\b';

export const GAS_HAZARD_INDICATORS: readonly GasHazardIndicator[] = [
  {
    id: 'smell-gas',
    pattern: near(SMELL, GAS),
    description: '"smell" near "gas" — e.g. "I smell gas", "gas smell in the kitchen"',
  },
  {
    id: 'odor-gas',
    pattern: near(ODOR, GAS),
    description: '"odor" near "gas" — e.g. "there\'s a gas odor"',
  },
  {
    id: 'rotten-egg',
    pattern: /\brotten\s+eggs?\b/i,
    description: '"rotten egg(s)" — stands alone, no "gas" token needed',
  },
  {
    id: 'sulfur',
    pattern: /\bsul(?:f|ph)ur\b/i,
    description: '"sulfur"/"sulphur" — stands alone',
  },
  {
    id: 'gas-leak',
    pattern: near(GAS, LEAK),
    description: '"gas" near "leak" — e.g. "gas leak", "there\'s a leak, it\'s gas"',
  },
  {
    id: 'hissing-near-source',
    pattern: near(HISS, GAS_SOURCE),
    description: '"hissing" near "gas"/"meter"/"pipe"/"line"',
  },
  {
    id: 'taste-gas',
    pattern: near(TASTE, GAS),
    description: '"taste" near "gas" — e.g. "I can taste gas"',
  },
];

/** Runs every indicator over `text` and returns the ones that matched. */
export function matchGasHazardIndicators(text: string): GasHazardIndicator[] {
  const normalized = normalizeText(text);
  return GAS_HAZARD_INDICATORS.filter((indicator) => indicator.pattern.test(normalized));
}

const CANDIDATE_TOKEN = /\b(?:gas|propane|sul(?:f|ph)ur)\b|\brotten\s+eggs?\b/i;

/**
 * Broad pre-filter for the (Phase 4) LLM hazard second-opinion: does this
 * text mention a hazard-relevant token at all, with no proximity
 * requirement? Deliberately broader than matchGasHazardIndicators — the
 * disambiguation call should run on any turn that could plausibly be about a
 * leak, not only ones that already passed the strict proximity check. This
 * is what gates the (currently-disabled) hazard-check call in classify.ts,
 * so a call with no hazard-relevant token at all never pays for it.
 */
export function hasHazardCandidateToken(text: string): boolean {
  return CANDIDATE_TOKEN.test(normalizeText(text));
}

/**
 * Normalizes curly apostrophes to straight ones (STT transcripts vary) and
 * collapses whitespace. Shared across triage/ so every pattern file agrees
 * on what "the same text" looks like.
 */
export function normalizeText(text: string): string {
  return text.replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim();
}
