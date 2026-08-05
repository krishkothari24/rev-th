import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { resetDb } from '../helpers/db.js';
import { runTool, computeIdempotencyKey } from '../../src/tools/runTool.js';
import { db } from '../../src/db/client.js';
import { toolInvocations } from '../../src/db/schema.js';
import { eventBus, type DashboardEvent } from '../../src/events/bus.js';

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

    const rows = await db
      .select()
      .from(toolInvocations)
      .where(eq(toolInvocations.toolName, 'noop'));
    expect(rows).toHaveLength(1);
  });

  describe('dashboard tool.invoked publish (IMPLEMENTATION_PLAN Phase 7)', () => {
    it('publishes tool.invoked once on a fresh execution', async () => {
      const events: DashboardEvent[] = [];
      const unsubscribe = eventBus.subscribe((e) => events.push(e));

      await runTool('noop', { call_id: 'call-6', x: 1 }, async () => ({ ok: true }));
      unsubscribe();

      const published = events.filter(
        (e): e is Extract<DashboardEvent, { type: 'tool.invoked' }> => e.type === 'tool.invoked',
      );
      expect(published).toHaveLength(1);
      expect(published[0]).toMatchObject({ callId: 'call-6', toolName: 'noop', isError: false });
    });

    it('does not publish tool.invoked on an idempotency-cache-hit replay', async () => {
      const args = { call_id: 'call-7', x: 1 };
      await runTool('noop', args, async () => ({ ok: true }));

      const events: DashboardEvent[] = [];
      const unsubscribe = eventBus.subscribe((e) => events.push(e));
      const result = await runTool('noop', args, async () => ({ ok: true }));
      unsubscribe();

      expect(result).toEqual({ ok: true });
      expect(events.filter((e) => e.type === 'tool.invoked')).toHaveLength(0);
    });

    it('publishes tool.invoked with isError: true and rethrows when the executor throws', async () => {
      const events: DashboardEvent[] = [];
      const unsubscribe = eventBus.subscribe((e) => events.push(e));

      await expect(
        runTool('noop', { call_id: 'call-8', x: 1 }, async () => {
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');
      unsubscribe();

      const published = events.filter((e) => e.type === 'tool.invoked');
      expect(published).toHaveLength(1);
      expect(published[0]).toMatchObject({ isError: true });

      const rows = await db
        .select()
        .from(toolInvocations)
        .where(eq(toolInvocations.toolName, 'noop'));
      expect(
        rows.find((r) => r.args && (r.args as { call_id: string }).call_id === 'call-8'),
      ).toBeUndefined();
    });
  });
});
