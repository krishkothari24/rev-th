/**
 * Proves the in-process registry path (dispatchTool, used by agent/loop.ts)
 * and the HTTP path (routes.ts, used by everything else) are the same path,
 * not two forks of it — plus a drift check between the hand-written
 * Anthropic tool schemas and the Zod schemas that actually validate them.
 */
import { describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { buildApp } from '../../src/app.js';
import { resetDb, seedFixtures, type Fixtures } from '../helpers/db.js';
import { db } from '../../src/db/client.js';
import { toolInvocations } from '../../src/db/schema.js';
import { dispatchTool, TOOL_ENTRIES } from '../../src/tools/registry.js';

describe('dispatchTool vs HTTP — same path, not two forks', () => {
  it('in-process dispatch and an HTTP call with the same call_id+args share one tool_invocations row', async () => {
    await resetDb();
    const fx: Fixtures = await seedFixtures();
    const app: FastifyInstance = await buildApp();

    const args = { call_id: 'registry-parity-1', phone: fx.customerPhone };

    const viaRegistry = await dispatchTool('customer_lookup', args);
    expect(viaRegistry.ok).toBe(true);
    if (!viaRegistry.ok) throw new Error('unreachable');

    const viaHttp = await app.inject({
      method: 'POST',
      url: '/tools/customer_lookup',
      payload: args,
    });
    expect(viaHttp.statusCode).toBe(200);
    expect(viaHttp.json()).toEqual(viaRegistry.result);

    const rows = await db
      .select()
      .from(toolInvocations)
      .where(eq(toolInvocations.toolName, 'customer_lookup'));
    expect(rows).toHaveLength(1); // the HTTP call replayed the registry call's stored result

    await app.close();
  });

  it('unknown tool name is a typed result, not a throw', async () => {
    const result = await dispatchTool('nonexistent_tool', { call_id: 'x' });
    expect(result).toEqual({ ok: false, kind: 'unknown_tool', toolName: 'nonexistent_tool' });
  });

  it('invalid arguments are a typed result, not a throw', async () => {
    const result = await dispatchTool('customer_lookup', { call_id: 'x', phone: 'not-a-phone' });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.kind).toBe('invalid_arguments');
  });
});

describe('hand-written Anthropic tool schemas match their Zod schemas', () => {
  // Builds a minimal args object satisfying every `required` field in the
  // hand-written JSON schema, then confirms the paired Zod schema accepts it
  // (plus call_id, which the JSON schema deliberately omits — see
  // registry.ts's docblock). Catches the two schemas silently drifting.
  function minimalValueFor(propSchema: Record<string, unknown>): unknown {
    if (Array.isArray(propSchema.enum) && propSchema.enum.length > 0) return propSchema.enum[0];
    if (propSchema.type === 'array') return [];
    if (propSchema.type === 'string') return 'placeholder value';
    throw new Error(
      `registry.test.ts doesn't know how to build a value for ${JSON.stringify(propSchema)}`,
    );
  }

  it.each(TOOL_ENTRIES.map((e) => e.name))('%s: required fields round-trip through Zod', (name) => {
    const toolEntry = TOOL_ENTRIES.find((e) => e.name === name);
    if (!toolEntry) throw new Error('unreachable');

    const { properties, required } = toolEntry.anthropicTool.input_schema as {
      properties: Record<string, Record<string, unknown>>;
      required: string[];
    };

    const args: Record<string, unknown> = { call_id: 'schema-drift-check' };
    // scheduled_start/phone need real ISO-datetime/E.164 values, not a
    // generic placeholder string, or the Zod schema's own format checks fail
    // for a reason unrelated to what this test is checking.
    const OVERRIDES: Record<string, unknown> = {
      scheduled_start: '2027-01-01T10:00:00.000Z',
      phone: '+17705550100',
    };
    for (const key of required) {
      args[key] = key in OVERRIDES ? OVERRIDES[key] : minimalValueFor(properties[key]!);
    }

    const parsed = toolEntry.schema.safeParse(args);
    expect(parsed.success, parsed.success ? undefined : JSON.stringify(parsed.error.issues)).toBe(
      true,
    );
  });
});
