/**
 * Scenario file schema and loader — BUILD_GUIDE §10 format (`turns` +
 * `assert`), plus three eval-only fields documented in
 * docs/IMPLEMENTATION_PLAN.md's Phase 5 section: `caller_phone` /
 * `known_customer` (which caller number drives the conversation) and
 * `xfail` (a scenario the runner is expected to fail today — see
 * evals/runner.ts's xfail handling). Zod-validated at the boundary, same
 * "validate untrusted input at the edge" discipline the tool layer uses
 * (packages/server/src/tools/*.ts) — a scenario author's typo in an
 * assertion shape should fail loudly at load time, not silently no-op deep
 * inside the runner.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

const jsonPrimitive = z.union([z.string(), z.number(), z.boolean(), z.null()]);

const assertionSchema = z.union([
  z.object({ tool_called: z.string() }).strict(),
  z.object({ tool_not_called: z.string() }).strict(),
  z
    .object({
      tool_call_count: z
        .object({ tool: z.string(), equals: z.number().int().nonnegative() })
        .strict(),
    })
    .strict(),
  z
    .object({
      tool_arg: z
        .object({
          tool: z.string(),
          key: z.string(),
          equals: jsonPrimitive.optional(),
          contains: jsonPrimitive.optional(),
        })
        .strict()
        .refine((v) => v.equals !== undefined || v.contains !== undefined, {
          message: 'tool_arg needs one of `equals` or `contains`',
        }),
    })
    .strict(),
  z.object({ response_contains_any: z.array(z.string()).min(1) }).strict(),
  z.object({ response_not_contains_any: z.array(z.string()).min(1) }).strict(),
]);

export type Assertion = z.infer<typeof assertionSchema>;

const turnSchema = z.object({ user: z.string().min(1) }).strict();

export const scenarioSchema = z
  .object({
    name: z.string().min(1),
    caller_phone: z.string().optional(),
    known_customer: z.boolean().optional(),
    xfail: z.boolean().optional(),
    turns: z.array(turnSchema).min(1),
    assert: z.array(assertionSchema).min(1),
  })
  .strict()
  .refine((v) => !(v.caller_phone && v.known_customer), {
    message: 'set at most one of `caller_phone` / `known_customer`',
  });

export type Scenario = z.infer<typeof scenarioSchema>;

/** Parses and validates one scenario file's raw text. Exported separately
 * from `loadScenarios` so evals/lib/assert.test.ts can exercise malformed
 * YAML without touching the filesystem. */
export function parseScenario(source: string, fileNameForErrors: string): Scenario {
  const raw: unknown = parseYaml(source);
  const result = scenarioSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`${fileNameForErrors}: invalid scenario:\n${issues}`);
  }
  return result.data;
}

/** Loads every `*.yaml` file in `scenariosDir`, sorted by filename for a
 * stable, reproducible run order. `filter`, when given, keeps only
 * scenarios whose `name` contains it (case-insensitive) — the substring
 * match behind `npm run eval -- <filter>`. */
export function loadScenarios(scenariosDir: string, filter?: string): Scenario[] {
  const files = readdirSync(scenariosDir)
    .filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
    .sort();

  const scenarios = files.map((file) =>
    parseScenario(readFileSync(path.join(scenariosDir, file), 'utf-8'), file),
  );

  if (!filter) return scenarios;
  const needle = filter.toLowerCase();
  return scenarios.filter((s) => s.name.toLowerCase().includes(needle));
}

/**
 * Deterministic, obviously-synthetic caller number for a scenario that
 * doesn't set `caller_phone`/`known_customer` — stable across runs (derived
 * from the scenario name, not run order) so a failure is reproducible.
 * Area code 706 (vs. the seed/demo data's 770) and the 0200-0899 range (vs.
 * db/seed.ts's reserved 0100-0199 evaluator block and
 * test/helpers/db.ts's 9999 fixture) keep eval-generated numbers from ever
 * colliding with a real seeded or fixture customer.
 */
export function generatedCallerPhone(scenarioName: string): string {
  let hash = 0;
  for (let i = 0; i < scenarioName.length; i += 1) {
    hash = (hash * 31 + scenarioName.charCodeAt(i)) >>> 0;
  }
  const suffix = 200 + (hash % 700); // 0200-0899
  return `+1706555${String(suffix).padStart(4, '0')}`;
}
