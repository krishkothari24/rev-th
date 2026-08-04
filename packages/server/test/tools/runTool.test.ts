import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { resetDb } from '../helpers/db.js';
import { runTool, computeIdempotencyKey } from '../../src/tools/runTool.js';
import { db } from '../../src/db/client.js';
import { toolInvocations } from '../../src/db/schema.js';

describe('runTool idempotency wrapper', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('runs the executor once and returns its result', async () => {
    let calls = 0;
    const result = await runTool('noop', { call_id: 'call-1', x: 1 }, async () => {
      calls += 1;
      return { ok: true, calls };
    });
    expect(result).toEqual({ ok: true, calls: 1 });
    expect(calls).toBe(1);
  });

  it('replays the cached result for a repeated call_id + tool + args, without re-running the executor', async () => {
    let calls = 0;
    const args = { call_id: 'call-2', x: 1 };
    const execute = async () => {
      calls += 1;
      return { ok: true, calls };
    };

    const first = await runTool('noop', args, execute);
    const second = await runTool('noop', args, execute);

    expect(calls).toBe(1); // executor only ran once
    expect(second).toEqual(first);
  });

  it('treats different args on the same call_id as a distinct invocation', async () => {
    let calls = 0;
    const execute = async () => {
      calls += 1;
      return { calls };
    };

    await runTool('noop', { call_id: 'call-3', x: 1 }, execute);
    await runTool('noop', { call_id: 'call-3', x: 2 }, execute);

    expect(calls).toBe(2);
  });

  it('is insensitive to key order in the args object', () => {
    const a = computeIdempotencyKey('call-4', 'noop', { a: 1, b: 2 });
    const b = computeIdempotencyKey('call-4', 'noop', { b: 2, a: 1 });
    expect(a).toBe(b);
  });

  it('persists one tool_invocations row per logical call', async () => {
    const args = { call_id: 'call-5', x: 1 };
    await runTool('noop', args, async () => ({ ok: true }));
    await runTool('noop', args, async () => ({ ok: true }));

    const rows = await db.select().from(toolInvocations).where(eq(toolInvocations.toolName, 'noop'));
    expect(rows).toHaveLength(1);
  });
});
