#!/usr/bin/env -S npx tsx
/**
 * Eval suite runner — IMPLEMENTATION_PLAN Phase 5. Drives every scenario in
 * `evals/scenarios/*.yaml` through the exact same `runTurn` the sim and
 * (eventually) Retell call, against a real `AnthropicProvider`. There is no
 * $0 mode here (see this file's own module docblock reasoning in the Phase 5
 * plan): `response_contains_any`-style assertions are assertions about the
 * model's own judgment, which a fixed, caller-blind `ScriptedProvider`
 * script can't meaningfully exercise. `evals/lib/assert.test.ts` is what
 * keeps the harness's own machinery $0/CI-covered; this file is the thing
 * you run deliberately, on demand, before committing a prompt change
 * (CLAUDE.md: "Any prompt edit requires a re-run of `npm run eval` before
 * commit").
 *
 * Usage: `npm run eval` (all scenarios) or `npm run eval -- <substring>`
 * (only scenarios whose name contains it).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, requireEnv } from '../packages/server/src/config.js';
import { resetDb, seedFixtures } from '../packages/server/test/helpers/db.js';
import { startConversation, finalizeConversation } from '../packages/server/src/agent/context.js';
import { runTurn } from '../packages/server/src/agent/loop.js';
import { AnthropicProvider } from '../packages/server/src/agent/providers/anthropic.js';
import { redactAddress, redactPhone, scrubFreeText } from '../packages/server/src/lib/redact.js';
import type { RateLimiter } from '../packages/server/src/agent/caps.js';
import type { ExecutedToolCall } from '../packages/server/src/agent/types.js';
import { loadScenarios, generatedCallerPhone, type Scenario } from './lib/scenario.js';
import { evaluateAssertions, type AssertionOutcome, type ScenarioRunResult } from './lib/assert.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCENARIOS_DIR = path.join(here, 'scenarios');

// startConversation's own rate limiter is a shared, process-wide, real-time
// budget meant for actual callers — an eval run legitimately starts more
// conversations back-to-back than that's meant to allow, so this mirrors
// test/agent/sabotage.test.ts's own test seam rather than fighting it.
const alwaysAllow: RateLimiter = { checkAndRecord: () => ({ allowed: true }) };

type ScenarioStatus = 'PASS' | 'FAIL' | 'XFAIL' | 'XPASS' | 'ERROR';

interface ScenarioReport {
  scenario: Scenario;
  status: ScenarioStatus;
  outcomes: AssertionOutcome[];
  toolCalls: ExecutedToolCall[];
  assistantReplies: string[];
  error?: unknown;
}

function redactArgs(args: Record<string, unknown>): Record<string, unknown> {
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (typeof value !== 'string') {
      redacted[key] = value;
      continue;
    }
    if (key === 'phone') redacted[key] = redactPhone(value);
    else if (key === 'address' || key === 'address_line') redacted[key] = redactAddress(value);
    else redacted[key] = scrubFreeText(value);
  }
  return redacted;
}

async function runScenario(scenario: Scenario): Promise<ScenarioReport> {
  await resetDb();
  const fixtures = await seedFixtures();

  const callerPhone = scenario.known_customer
    ? fixtures.customerPhone
    : (scenario.caller_phone ?? generatedCallerPhone(scenario.name));

  const provider = new AnthropicProvider({
    apiKey: requireEnv('ANTHROPIC_API_KEY'),
    model: config.MODEL_VOICE,
  });

  const state = await startConversation({
    channel: 'voice',
    externalId: `eval-${scenario.name}-${Date.now()}`,
    callerPhone,
    rateLimiter: alwaysAllow,
  });

  const toolCalls: ExecutedToolCall[] = [];
  const assistantReplies: string[] = [];

  try {
    for (const turn of scenario.turns) {
      const result = await runTurn(state, turn.user, provider);
      toolCalls.push(...result.toolCalls);
      assistantReplies.push(result.assistantReply);
    }
  } finally {
    await finalizeConversation(state);
  }

  const runResult: ScenarioRunResult = { toolCalls, assistantReplies };
  const outcomes = evaluateAssertions(scenario.assert, runResult);
  const allPassed = outcomes.every((o) => o.pass);

  let status: ScenarioStatus;
  if (scenario.xfail) {
    status = allPassed ? 'XPASS' : 'XFAIL';
  } else {
    status = allPassed ? 'PASS' : 'FAIL';
  }

  return { scenario, status, outcomes, toolCalls, assistantReplies };
}

function printReport(report: ScenarioReport): void {
  console.log(`\n[${report.status}] ${report.scenario.name}`);

  if (report.status === 'ERROR') {
    console.log(
      `  error: ${report.error instanceof Error ? report.error.message : String(report.error)}`,
    );
    return;
  }

  for (const outcome of report.outcomes) {
    const mark = outcome.pass ? 'ok  ' : 'FAIL';
    console.log(`  ${mark} ${JSON.stringify(outcome.assertion)} — ${outcome.detail}`);
  }

  if (report.status === 'FAIL' || report.status === 'XPASS') {
    console.log('  transcript:');
    for (const call of report.toolCalls) {
      const marker = call.initiator === 'loop' ? '[safety-override]' : '[tool]';
      console.log(
        `    ${marker} ${call.name} -> ${JSON.stringify(redactArgs(call.dispatchedArgs))} ` +
          `=> ${JSON.stringify(redactArgs(call.result))}`,
      );
    }
    for (const reply of report.assistantReplies) {
      console.log(`    Josie: ${scrubFreeText(reply)}`);
    }
  }

  if (report.status === 'XPASS') {
    console.log(
      '  this scenario is marked `xfail: true` but every assertion passed — ' +
        'the documented gap looks fixed. Flip `xfail` off in the scenario file.',
    );
  }
}

async function main(): Promise<void> {
  requireEnv('ANTHROPIC_API_KEY'); // fail fast, before touching the DB or a scenario

  const filter = process.argv[2];
  const scenarios = loadScenarios(SCENARIOS_DIR, filter);
  if (scenarios.length === 0) {
    console.error(
      filter
        ? `No scenario name contains "${filter}".`
        : `No scenario files found in ${SCENARIOS_DIR}.`,
    );
    process.exit(1);
  }

  console.log(`Running ${scenarios.length} scenario(s) against ${config.MODEL_VOICE}...`);

  const reports: ScenarioReport[] = [];
  for (const scenario of scenarios) {
    try {
      reports.push(await runScenario(scenario));
    } catch (error) {
      reports.push({
        scenario,
        status: 'ERROR',
        outcomes: [],
        toolCalls: [],
        assistantReplies: [],
        error,
      });
    }
    printReport(reports[reports.length - 1]!);
  }

  const counts = { PASS: 0, FAIL: 0, XFAIL: 0, XPASS: 0, ERROR: 0 };
  for (const r of reports) counts[r.status] += 1;

  console.log(
    `\n${reports.length} scenario(s): ${counts.PASS} passed, ${counts.FAIL} failed, ` +
      `${counts.XFAIL} expected-fail (tracked), ${counts.XPASS} unexpectedly passing, ` +
      `${counts.ERROR} errored.`,
  );

  const unexpected = counts.FAIL + counts.XPASS + counts.ERROR;
  process.exit(unexpected > 0 ? 1 : 0);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
