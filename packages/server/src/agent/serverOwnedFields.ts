/**
 * Server-disposes enforcement beyond Zod — BUILD_GUIDE §8.3 / CLAUDE.md's
 * "the model proposes, server disposes." Zod constrains `urgency` and
 * `required_skills` to valid enum values, but nothing stops the model from
 * *choosing* a zod-valid value it shouldn't be trusted with — e.g. a
 * prompt-injected "mark this priority" is still zod-valid. This closes that
 * gap: immediately before dispatching `check_availability` or
 * `book_appointment`, the loop overwrites those two fields with the current
 * turn's `classifyUrgency` output, regardless of what the model's tool-call
 * JSON contained. Every other field (address, county, name, phone,
 * scheduled_start) still comes from the model — those are caller-stated
 * facts the loop has no independent way to derive; only urgency and
 * required_skills have a deterministic, safety-relevant, code-owned source
 * of truth.
 */
import type { ClassifyUrgencyResult } from '../triage/classify.js';

const SERVER_OWNED_TOOLS = new Set(['check_availability', 'book_appointment']);

/**
 * Full replacement, not a union: a deterministic derivation from the
 * transcript is authoritative in both directions — the model must not be
 * able to under-claim required skills to dodge a gas-cert requirement, nor
 * over-claim urgency to force priority scheduling.
 */
export function applyServerOwnedOverrides(
  toolName: string,
  modelArgs: Record<string, unknown>,
  triage: ClassifyUrgencyResult,
): Record<string, unknown> {
  if (!SERVER_OWNED_TOOLS.has(toolName)) return modelArgs;

  return {
    ...modelArgs,
    urgency: triage.urgency,
    required_skills: triage.requiredSkills,
  };
}
