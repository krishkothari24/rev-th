/**
 * Prompt loading — BUILD_GUIDE §3: prompts are source files under `prompts/`,
 * loaded at boot, hot-reloadable in dev. Hot-reload is a dev convenience, not
 * a correctness requirement, so this is a cheap mtime-check-on-read rather
 * than a long-lived `fs.watch` handle: `loadAgentSystemPrompt()` is already
 * called once per turn from the loop's request-building step, so a change on
 * disk is picked up on the very next turn with no extra infrastructure or
 * cleanup story.
 */
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { repoRoot } from '../config.js';
import type { MembershipTier } from '../db/schema.js';
import type { ClassifyUrgencyResult } from '../triage/classify.js';
import type { ConversationState } from './types.js';

interface CachedPrompt {
  mtimeMs: number;
  content: string;
}

const cache = new Map<string, CachedPrompt>();

/**
 * Re-reads `filePath` from disk only when its mtime has changed since the
 * last read. Takes an absolute path (rather than a bare prompt name) so it's
 * independently testable against a scratch temp file — see
 * test/agent/prompts.test.ts — without mutating the real committed prompt.
 */
export function loadPromptFileAt(filePath: string): string {
  const mtimeMs = statSync(filePath).mtimeMs;
  const cached = cache.get(filePath);
  if (cached && cached.mtimeMs === mtimeMs) return cached.content;

  const content = readFileSync(filePath, 'utf-8');
  cache.set(filePath, { mtimeMs, content });
  return content;
}

/**
 * Loads `prompts/<name>` relative to the repo root. Building this on a
 * generic `name` (rather than hardcoding `agent_system_prompt.md`) means
 * `sms_agent_prompt.md`/`summarizer_prompt.md` (Phase 6/8/9) are one-line
 * additions later, not a redesign.
 */
export function loadPromptFile(name: string): string {
  return loadPromptFileAt(path.join(repoRoot, 'prompts', name));
}

export function loadAgentSystemPrompt(): string {
  return loadPromptFile('agent_system_prompt.md');
}

const DATE_FMT = new Intl.DateTimeFormat('en-US', {
  weekday: 'long',
  year: 'numeric',
  month: 'long',
  day: 'numeric',
});

const MEMBERSHIP_LABEL: Record<'basic' | 'comfort_club', string> = {
  basic: 'Basic plan',
  comfort_club: 'Comfort Club',
};

/**
 * Server-computed membership-upsell permission (IMPLEMENTATION_PLAN Phase 6,
 * CLAUDE.md: "Membership/plan upsell is blocked in code on any call flagged
 * urgent or safety-related, not left to the model's discretion"). There's no
 * way to censor free-text model output after the fact, so the block has to
 * happen here: whether the model is even *told* it may bring up membership
 * is a deterministic function of this turn's triage, computed before the
 * model is ever called — same pattern as SAFETY_DIRECTIVE in agent/loop.ts.
 * A gas-leak-adjacent "hey while we're at it, got a membership plan?" can't
 * pry this open, because the permission line itself refuses regardless of
 * membership status once urgency/safety fires.
 */
function membershipDirective(
  membershipTier: MembershipTier | null,
  triage: ClassifyUrgencyResult | null,
): string {
  const urgent = triage ? triage.urgency !== 'routine' || triage.safetyOverride.fired : false;
  if (urgent) {
    return (
      'Do not bring up or promote a membership plan on this call — it is urgent or ' +
      'safety-related. If the caller asks about it directly, answer in one factual sentence ' +
      'and return immediately to the issue at hand.'
    );
  }
  if (membershipTier) {
    return (
      `This caller is a ${MEMBERSHIP_LABEL[membershipTier]} member — you may reference their ` +
      'plan naturally if it is relevant (e.g. coverage for this visit).'
    );
  }
  return (
    'This caller is not a member. You may mention the membership plan once, briefly, and only ' +
    'if it fits naturally — never push it.'
  );
}

/**
 * Dynamic context appendix, per BUILD_GUIDE §3: "Inject at call start:
 * current date/time, season... and — if the caller is recognized — a
 * compact customer summary." Concatenated at request-build time only, never
 * written into the markdown file, and not caller speech — so it doesn't
 * touch the "caller transcript never enters the system prompt" rule (§8.3's
 * rule is specifically about *caller-supplied* text; this is the same
 * category of thing Retell's own dynamic-variable injection is).
 *
 * `state.systemPromptOverride`, when set, replaces the loaded file entirely
 * before the appendix is added — the seam test/agent/sabotage.test.ts uses
 * to run with the real prompt's safety section physically stripped out.
 *
 * `recognizedCustomerSummary`/`knownMembershipTier`/`lastTriage` are
 * `Partial` here (rather than required, as they are on `ConversationState`)
 * so a caller that hasn't run call-start recognition yet — or a test fixture
 * — can omit them and get the unrecognized-caller/non-urgent defaults.
 */
export function buildSystemPromptForTurn(
  state: Pick<ConversationState, 'season' | 'systemPromptOverride'> &
    Partial<
      Pick<ConversationState, 'recognizedCustomerSummary' | 'knownMembershipTier' | 'lastTriage'>
    >,
  now: Date = new Date(),
): string {
  const base = state.systemPromptOverride ?? loadAgentSystemPrompt();
  let appendix = `${base}\n\n---\nToday is ${DATE_FMT.format(now)}. It's ${state.season} season.`;

  if (state.recognizedCustomerSummary) {
    appendix +=
      `\nThis caller's phone number matches an existing customer: ${state.recognizedCustomerSummary} ` +
      'Use this to personalize the greeting and reference known equipment naturally — do not ' +
      'read back their full address, account, or payment details unless they state it first.';
  }

  appendix += `\n${membershipDirective(state.knownMembershipTier ?? null, state.lastTriage ?? null)}`;

  return appendix;
}
