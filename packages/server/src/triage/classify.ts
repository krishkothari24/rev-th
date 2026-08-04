/**
 * classifyUrgency — BUILD_GUIDE §5. The deterministic triage core: urgency
 * and required-skill classification run as code, not model judgment, and
 * the gas-leak safety override is what forces the emergency path
 * regardless of what a model concluded. This module is pure — no DB, no
 * Fastify route, no event bus. Phase 4's agent core is what turns
 * `safetyOverride.fired` into an actual `flag_emergency` call and a hard
 * interrupt; this phase's job is only to produce that signal correctly.
 */
import type { EmergencyReason, PropertyType, Urgency } from '../db/schema.js';
import type { Skill } from '../domain/constants.js';
import {
  CLAUSE_GAP,
  hasHazardCandidateToken,
  matchGasHazardIndicators,
  normalizeText,
} from './indicators.js';
import { disabledHazardCheckProvider, type HazardCheckProvider } from './hazardCheck.js';
import { deriveRequiredSkills } from './skills.js';

export type Season = 'heating' | 'cooling' | 'shoulder';

export interface ClassifyUrgencyInput {
  transcript: string;
  statedIssue: string;
  vulnerablePersonPresent: boolean | null;
  season: Season;
  propertyType: PropertyType;
}

export type SafetyOverride =
  | { fired: false }
  | {
      fired: true;
      reason: EmergencyReason;
      signal: 'keyword' | 'llm' | 'both';
      matchedIndicatorIds: readonly string[];
    };

export interface ClassifyUrgencyResult {
  urgency: Urgency;
  requiredSkills: Skill[];
  safetyOverride: SafetyOverride;
}

export interface ClassifyUrgencyOptions {
  /**
   * Defaults to a disabled no-op. HAZARD_CHECK_LLM_ENABLED gates a real,
   * Anthropic-backed provider starting Phase 4 — this module never reads
   * config itself, so it stays free and dependency-free this phase.
   */
  hazardCheckProvider?: HazardCheckProvider;
}

/**
 * Async even though BUILD_GUIDE's pseudocode reads sync: it has to await
 * the injectable hazard-check provider once Phase 4 enables it, and the
 * goal is that Phase 4 changes zero lines at the call site. Making it async
 * later would be the breaking change instead; doing it now costs nothing —
 * this phase's default provider resolves with no I/O.
 */
export async function classifyUrgency(
  input: ClassifyUrgencyInput,
  opts: ClassifyUrgencyOptions = {},
): Promise<ClassifyUrgencyResult> {
  const provider = opts.hazardCheckProvider ?? disabledHazardCheckProvider;
  const safetyOverride = await computeSafetyOverride(input.transcript, provider);

  const requiredSkills = deriveRequiredSkills({
    statedIssue: input.statedIssue,
    transcript: input.transcript,
    propertyType: input.propertyType,
  });

  const urgency = safetyOverride.fired ? 'emergency' : deriveNonEmergencyUrgency(input);

  return { urgency, requiredSkills, safetyOverride };
}

/**
 * Reads the raw transcript only, never `statedIssue` — a model-summarized
 * field is exactly the kind of thing that must not be trusted to gate a
 * safety override. Pure OR logic between the keyword and LLM signals is
 * correct even though BUILD_GUIDE calls keyword-matching "brittle": the
 * false-positive protection lives in the *proximity design* of the
 * indicators (indicators.ts), not in the LLM vetoing a keyword hit. The LLM
 * is an additive catch-net for phrasings the keyword list misses, matching
 * the project's stated bias ("lean priority... a missed emergency is much
 * worse than one extra flagged call"). With the disabled default provider,
 * `fired === keywordFired` — the model is fully out of the loop.
 */
async function computeSafetyOverride(
  transcript: string,
  provider: HazardCheckProvider,
): Promise<SafetyOverride> {
  const keywordMatches = matchGasHazardIndicators(transcript);
  const keywordFired = keywordMatches.length > 0;

  let llmFired = false;
  if (hasHazardCandidateToken(transcript)) {
    const result = await provider.check({ transcript, candidateText: transcript });
    llmFired = result.hazard === true;
  }

  if (!keywordFired && !llmFired) return { fired: false };

  const reason: EmergencyReason = 'gas_smell';
  return {
    fired: true,
    reason,
    signal: keywordFired && llmFired ? 'both' : keywordFired ? 'keyword' : 'llm',
    matchedIndicatorIds: keywordMatches.map((m) => m.id),
  };
}

function near(a: string, b: string): RegExp {
  return new RegExp(`(?:${a}${CLAUSE_GAP}${b}|${b}${CLAUSE_GAP}${a})`, 'i');
}

// Deliberately separate from indicators.ts: that file's namesake purpose is
// specifically the safety-override set, and conflating it with general
// severity phrases would blur a distinction that matters — only a gas
// hazard forces a code-level override.
const HEAT_EQUIPMENT = '\\b(?:furnace|heater|heat\\s*pump|heat)\\b';
const COOLING_EQUIPMENT = '\\b(?:a/?c|air\\s*conditioner|air\\s*conditioning|cooling)\\b';
const BROKEN_STATE = '\\b(?:out|down|dead|died|broken|quit|stopped)\\b';
const SHORT_CYCLE = '\\bshort[- ]cycl\\w*';
const NOT_HEATING = "\\b(?:won't|isn't|not)\\s+(?:heat\\w*|work\\w*|turn\\w*\\s+on|start\\w*)";
const NOT_COOLING = "\\b(?:won't|isn't|not)\\s+(?:cool\\w*|work\\w*|turn\\w*\\s+on|start\\w*)";

const HEAT_LOSS_PATTERNS: RegExp[] = [
  /\bno\s+heat(?:ing)?\b/i,
  near(HEAT_EQUIPMENT, BROKEN_STATE),
  near(HEAT_EQUIPMENT, NOT_HEATING),
  near(SHORT_CYCLE, HEAT_EQUIPMENT),
  /\bno\s+warm\s+air\b/i,
];

// Deliberately excludes "blowing warm"/degraded-performance phrasing —
// cross-checked against db/seed.ts's own ROUTINE_ISSUES ("AC blowing warm
// on hot afternoons, minor") vs. PRIORITY_ISSUES ("Furnace short-cycling
// during cold snap"). Degraded performance is not a total loss.
const COOLING_LOSS_PATTERNS: RegExp[] = [
  /\bno\s+(?:ac|a\/c|air\s+conditioning)\b/i,
  near(COOLING_EQUIPMENT, BROKEN_STATE),
  near(COOLING_EQUIPMENT, NOT_COOLING),
  near(SHORT_CYCLE, COOLING_EQUIPMENT),
  /\b(?:not|isn't|is\s+not)\s+cooling\b/i,
  /\bno\s+cool\s+air\b/i,
];

type LossType = 'heat' | 'cooling' | 'both' | null;

function detectLossType(text: string): LossType {
  const heat = HEAT_LOSS_PATTERNS.some((p) => p.test(text));
  const cooling = COOLING_LOSS_PATTERNS.some((p) => p.test(text));
  if (heat && cooling) return 'both';
  if (heat) return 'heat';
  if (cooling) return 'cooling';
  return null;
}

// Shoulder season counts as relevant for both heat and cooling loss:
// shoulder-season swings can still produce cold nights or warm days, and
// it's the conservative ("lean priority when unsure") choice the docs
// repeatedly favor.
function isSeasonRelevant(loss: Exclude<LossType, null>, season: Season): boolean {
  if (loss === 'both') return true;
  if (loss === 'heat') return season === 'heating' || season === 'shoulder';
  return season === 'cooling' || season === 'shoulder';
}

/**
 * `'emergency'` is reserved exclusively for `safetyOverride.fired` (checked
 * by the caller before this runs). Otherwise: no loss-of-conditioning
 * language → routine. A season-relevant total loss → priority regardless of
 * `vulnerablePersonPresent` (system prompt: "even without a vulnerable
 * person present — still treat as urgent"). A season-irrelevant total loss
 * (e.g. furnace out in June) → priority only if a vulnerable person is
 * present, else routine. `vulnerablePersonPresent`'s one causal effect: it
 * can rescue an otherwise season-irrelevant report, but never manufactures
 * urgency out of nothing and never reaches emergency.
 */
function deriveNonEmergencyUrgency(input: ClassifyUrgencyInput): Urgency {
  const text = normalizeText(`${input.statedIssue} ${input.transcript}`);
  const loss = detectLossType(text);

  if (loss === null) return 'routine';
  if (isSeasonRelevant(loss, input.season)) return 'priority';
  return input.vulnerablePersonPresent === true ? 'priority' : 'routine';
}
