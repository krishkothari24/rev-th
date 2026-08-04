/**
 * Injectable second-opinion hazard check — BUILD_GUIDE §5. Keyword matching
 * alone is brittle at disambiguating some phrasings, so a cheap Haiku call
 * can catch hazard reports the deterministic indicators (indicators.ts)
 * miss. This interface lets Phase 4 drop in a real Anthropic-backed
 * provider with zero changes to classify.ts's call site — only this
 * phase's default, always-off implementation exists today, matching
 * IMPLEMENTATION_PLAN's "written now behind an injectable provider
 * interface and defaults off, so this phase stays free."
 */

export interface HazardCheckInput {
  transcript: string;
  /**
   * The text that tripped the candidate-token pre-filter, passed separately
   * so a real provider can build a cheap, targeted prompt instead of
   * resending the whole call transcript every turn.
   */
  candidateText: string;
}

export interface HazardCheckResult {
  hazard: boolean;
  /** Free-text rationale for logs/dashboard — never spoken to the caller. */
  rationale?: string;
}

export interface HazardCheckProvider {
  check(input: HazardCheckInput): Promise<HazardCheckResult>;
}

/**
 * Always-off default: no network call, no cost, resolves `hazard: false`.
 * This is what classify.ts uses when no provider is injected, and what
 * `HAZARD_CHECK_LLM_ENABLED=false` should resolve to once Phase 4 wires the
 * flag at the call site.
 */
export const disabledHazardCheckProvider: HazardCheckProvider = {
  check() {
    return Promise.resolve({ hazard: false, rationale: 'hazard-check LLM disabled' });
  },
};
