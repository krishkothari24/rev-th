/**
 * Pure assertion evaluator over one scenario's recorded turns — no model, no
 * DB, no filesystem, so evals/lib/assert.test.ts can drive it entirely with
 * hand-built fixtures and stay $0/CI-safe even though the runner itself
 * (evals/runner.ts) always talks to a real model.
 *
 * Assertions read `dispatchedArgs`, never `modelArgs` — see
 * agent/serverOwnedFields.ts's own docblock ("the model proposes, server
 * disposes"). Checking what the model *tried* to send would make the
 * prompt-injection scenario meaningless; checking what actually reached the
 * tool is the only check that reflects the real, enforced boundary.
 */
import type { ExecutedToolCall } from '../../packages/server/src/agent/types.js';
import type { Assertion } from './scenario.js';

export interface ScenarioRunResult {
  toolCalls: ExecutedToolCall[];
  assistantReplies: string[];
}

export interface AssertionOutcome {
  assertion: Assertion;
  pass: boolean;
  detail: string;
}

/** Successful (non-error) calls to `toolName`, in the order they happened —
 * the only calls that represent something that actually reached the tool
 * layer and returned real effects. */
function successfulCalls(result: ScenarioRunResult, toolName: string): ExecutedToolCall[] {
  return result.toolCalls.filter((c) => c.name === toolName && !c.isError);
}

function describeArgs(calls: ExecutedToolCall[]): string {
  if (calls.length === 0) return '(no successful calls)';
  return calls.map((c) => JSON.stringify(c.dispatchedArgs)).join('; ');
}

function jsonEquals(actual: unknown, expected: unknown): boolean {
  if (actual === expected) return true;
  // Both sides are JSON-primitive-or-array-shaped by construction (the
  // scenario schema only ever supplies a JSON primitive as `equals`); a
  // stringified compare covers the array-of-primitives case (e.g.
  // required_skills: ['residential']) without pulling in a deep-equal dep.
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function jsonContains(actual: unknown, needle: unknown): boolean {
  if (Array.isArray(actual)) return actual.some((v) => jsonEquals(v, needle));
  if (typeof actual === 'string' && typeof needle === 'string') {
    return actual.toLowerCase().includes(needle.toLowerCase());
  }
  return false;
}

function repliesContainAny(replies: string[], needles: string[]): boolean {
  return replies.some((reply) => {
    const lower = reply.toLowerCase();
    return needles.some((needle) => lower.includes(needle.toLowerCase()));
  });
}

export function evaluateAssertion(
  assertion: Assertion,
  result: ScenarioRunResult,
): AssertionOutcome {
  if ('tool_called' in assertion) {
    const calls = successfulCalls(result, assertion.tool_called);
    return {
      assertion,
      pass: calls.length > 0,
      detail:
        calls.length > 0
          ? `${assertion.tool_called} called successfully ${calls.length}x`
          : `${assertion.tool_called} was never called successfully`,
    };
  }

  if ('tool_not_called' in assertion) {
    const calls = result.toolCalls.filter((c) => c.name === assertion.tool_not_called);
    return {
      assertion,
      pass: calls.length === 0,
      detail:
        calls.length === 0
          ? `${assertion.tool_not_called} was never called, as expected`
          : `${assertion.tool_not_called} was called ${calls.length}x (expected zero)`,
    };
  }

  if ('tool_call_count' in assertion) {
    const { tool, equals } = assertion.tool_call_count;
    const calls = successfulCalls(result, tool);
    return {
      assertion,
      pass: calls.length === equals,
      detail: `${tool} called successfully ${calls.length}x (expected ${equals})`,
    };
  }

  if ('tool_arg' in assertion) {
    const { tool, key, equals, contains } = assertion.tool_arg;
    const calls = successfulCalls(result, tool);
    const matched = calls.some((c) => {
      const actual = c.dispatchedArgs[key];
      if (equals !== undefined) return jsonEquals(actual, equals);
      return jsonContains(actual, contains);
    });
    const expectedDesc =
      equals !== undefined
        ? `equals ${JSON.stringify(equals)}`
        : `contains ${JSON.stringify(contains)}`;
    return {
      assertion,
      pass: matched,
      detail: matched
        ? `${tool}.${key} ${expectedDesc} (found in: ${describeArgs(calls)})`
        : `${tool}.${key} never ${expectedDesc} — actual call(s): ${describeArgs(calls)}`,
    };
  }

  if ('response_contains_any' in assertion) {
    const pass = repliesContainAny(result.assistantReplies, assertion.response_contains_any);
    return {
      assertion,
      pass,
      detail: pass
        ? `a reply matched one of ${JSON.stringify(assertion.response_contains_any)}`
        : `no reply matched any of ${JSON.stringify(assertion.response_contains_any)} — replies: ${JSON.stringify(result.assistantReplies)}`,
    };
  }

  // response_not_contains_any
  const matched = repliesContainAny(result.assistantReplies, assertion.response_not_contains_any);
  return {
    assertion,
    pass: !matched,
    detail: !matched
      ? `no reply matched any of ${JSON.stringify(assertion.response_not_contains_any)}, as expected`
      : `a reply unexpectedly matched one of ${JSON.stringify(assertion.response_not_contains_any)} — replies: ${JSON.stringify(result.assistantReplies)}`,
  };
}

export function evaluateAssertions(
  assertions: Assertion[],
  result: ScenarioRunResult,
): AssertionOutcome[] {
  return assertions.map((a) => evaluateAssertion(a, result));
}
