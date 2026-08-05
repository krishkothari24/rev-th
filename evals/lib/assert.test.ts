/**
 * $0 unit coverage for the eval harness's own machinery — no model, no DB.
 * evals/runner.ts is what actually spends tokens; this file is what proves
 * the assertion engine and scenario parser are correct before trusting
 * either against a real run. Mirrors the rest of the repo's "validate the
 * boundary, unit-test the pure core" pattern (e.g.
 * packages/server/test/tools/registry.test.ts).
 */
import { describe, expect, it } from 'vitest';
import { evaluateAssertion, evaluateAssertions, type ScenarioRunResult } from './assert.js';
import { generatedCallerPhone, parseScenario, scenarioSchema } from './scenario.js';
import type { ExecutedToolCall } from '../../packages/server/src/agent/types.js';

function call(overrides: Partial<ExecutedToolCall> & { name: string }): ExecutedToolCall {
  return {
    modelArgs: {},
    dispatchedArgs: {},
    result: {},
    isError: false,
    initiator: 'model',
    ...overrides,
  };
}

const emptyResult: ScenarioRunResult = { toolCalls: [], assistantReplies: [] };

describe('evaluateAssertion — tool_called / tool_not_called', () => {
  it('tool_called passes only on a successful call', () => {
    const result: ScenarioRunResult = {
      toolCalls: [call({ name: 'flag_emergency' })],
      assistantReplies: [],
    };
    expect(evaluateAssertion({ tool_called: 'flag_emergency' }, result).pass).toBe(true);
    expect(evaluateAssertion({ tool_called: 'book_appointment' }, result).pass).toBe(false);
  });

  it('tool_called ignores an errored call', () => {
    const result: ScenarioRunResult = {
      toolCalls: [call({ name: 'flag_emergency', isError: true })],
      assistantReplies: [],
    };
    expect(evaluateAssertion({ tool_called: 'flag_emergency' }, result).pass).toBe(false);
  });

  it('tool_not_called passes on an empty transcript and fails once called (even if errored)', () => {
    expect(evaluateAssertion({ tool_not_called: 'book_appointment' }, emptyResult).pass).toBe(true);
    const result: ScenarioRunResult = {
      toolCalls: [call({ name: 'book_appointment', isError: true })],
      assistantReplies: [],
    };
    expect(evaluateAssertion({ tool_not_called: 'book_appointment' }, result).pass).toBe(false);
  });
});

describe('evaluateAssertion — tool_call_count', () => {
  it('counts only successful calls to the named tool', () => {
    const result: ScenarioRunResult = {
      toolCalls: [
        call({ name: 'book_appointment' }),
        call({ name: 'book_appointment', isError: true }),
        call({ name: 'check_availability' }),
      ],
      assistantReplies: [],
    };
    expect(
      evaluateAssertion({ tool_call_count: { tool: 'book_appointment', equals: 1 } }, result).pass,
    ).toBe(true);
    expect(
      evaluateAssertion({ tool_call_count: { tool: 'book_appointment', equals: 2 } }, result).pass,
    ).toBe(false);
  });
});

describe('evaluateAssertion — tool_arg', () => {
  const result: ScenarioRunResult = {
    toolCalls: [
      call({
        name: 'book_appointment',
        dispatchedArgs: { urgency: 'routine', required_skills: ['residential', 'gas'] },
      }),
    ],
    assistantReplies: [],
  };

  it('equals matches a scalar field', () => {
    expect(
      evaluateAssertion(
        { tool_arg: { tool: 'book_appointment', key: 'urgency', equals: 'routine' } },
        result,
      ).pass,
    ).toBe(true);
    expect(
      evaluateAssertion(
        { tool_arg: { tool: 'book_appointment', key: 'urgency', equals: 'emergency' } },
        result,
      ).pass,
    ).toBe(false);
  });

  it('contains matches array membership', () => {
    expect(
      evaluateAssertion(
        { tool_arg: { tool: 'book_appointment', key: 'required_skills', contains: 'gas' } },
        result,
      ).pass,
    ).toBe(true);
    expect(
      evaluateAssertion(
        { tool_arg: { tool: 'book_appointment', key: 'required_skills', contains: 'commercial' } },
        result,
      ).pass,
    ).toBe(false);
  });

  it('fails when the tool was never called successfully', () => {
    expect(
      evaluateAssertion(
        { tool_arg: { tool: 'flag_emergency', key: 'reason', equals: 'gas_smell' } },
        emptyResult,
      ).pass,
    ).toBe(false);
  });
});

describe('evaluateAssertion — response_contains_any / response_not_contains_any', () => {
  const result: ScenarioRunResult = {
    toolCalls: [],
    assistantReplies: ["Let's get you scheduled.", 'Please LEAVE the property right now.'],
  };

  it('response_contains_any is case-insensitive and checks every reply', () => {
    expect(evaluateAssertion({ response_contains_any: ['leave', 'outside'] }, result).pass).toBe(
      true,
    );
    expect(evaluateAssertion({ response_contains_any: ['rotten eggs'] }, result).pass).toBe(false);
  });

  it('response_not_contains_any fails as soon as one reply matches', () => {
    expect(evaluateAssertion({ response_not_contains_any: ['scheduled'] }, result).pass).toBe(
      false,
    );
    expect(evaluateAssertion({ response_not_contains_any: ['refund'] }, result).pass).toBe(true);
  });
});

describe('evaluateAssertions', () => {
  it('evaluates every assertion independently, in order', () => {
    const result: ScenarioRunResult = {
      toolCalls: [call({ name: 'transfer_to_human' })],
      assistantReplies: ['Connecting you now.'],
    };
    const outcomes = evaluateAssertions(
      [{ tool_called: 'transfer_to_human' }, { tool_not_called: 'book_appointment' }],
      result,
    );
    expect(outcomes.map((o) => o.pass)).toEqual([true, true]);
  });
});

describe('scenario schema', () => {
  const valid = `
name: gas_smell_midcall
turns:
  - user: "Hi, I need to schedule my annual furnace tune-up."
  - user: "Actually — hang on, I smell something like rotten eggs."
assert:
  - tool_called: flag_emergency
  - tool_arg: { tool: flag_emergency, key: reason, equals: gas_smell }
  - response_contains_any: ["leave", "get out", "outside"]
  - tool_not_called: book_appointment
`;

  it('parses a well-formed scenario matching the BUILD_GUIDE §10 example', () => {
    const scenario = parseScenario(valid, 'gas_smell_midcall.yaml');
    expect(scenario.name).toBe('gas_smell_midcall');
    expect(scenario.turns).toHaveLength(2);
    expect(scenario.assert).toHaveLength(4);
    expect(scenario.xfail).toBeUndefined();
  });

  it('rejects an unknown assertion shape rather than silently dropping it', () => {
    const bad = `
name: broken
turns:
  - user: "hi"
assert:
  - tool_wuz_called: flag_emergency
`;
    expect(() => parseScenario(bad, 'broken.yaml')).toThrow(/invalid scenario/);
  });

  it('rejects setting both caller_phone and known_customer', () => {
    const bad = scenarioSchema.safeParse({
      name: 'x',
      caller_phone: '+17065550200',
      known_customer: true,
      turns: [{ user: 'hi' }],
      assert: [{ tool_called: 'customer_lookup' }],
    });
    expect(bad.success).toBe(false);
  });

  it('requires tool_arg to supply equals or contains', () => {
    const bad = scenarioSchema.safeParse({
      name: 'x',
      turns: [{ user: 'hi' }],
      assert: [{ tool_arg: { tool: 'book_appointment', key: 'urgency' } }],
    });
    expect(bad.success).toBe(false);
  });
});

describe('generatedCallerPhone', () => {
  it('is deterministic and stays outside the reserved seed/fixture ranges', () => {
    const a = generatedCallerPhone('routine_maintenance_happy_path');
    const b = generatedCallerPhone('routine_maintenance_happy_path');
    expect(a).toBe(b);
    expect(a).toMatch(/^\+17065550[2-8]\d\d$/);
    expect(a).not.toBe('+17705559999'); // test/helpers/db.ts fixture
  });

  it('differs across scenario names (no guaranteed uniqueness, but the common case)', () => {
    expect(generatedCallerPhone('scenario_a')).not.toBe(generatedCallerPhone('scenario_b'));
  });
});
