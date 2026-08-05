import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { eventBus, type DashboardEvent } from '../../src/events/bus.js';

describe('POST /events/relay', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('re-publishes a valid event on this process’s event bus', async () => {
    const seen: DashboardEvent[] = [];
    const unsubscribe = eventBus.subscribe((e) => seen.push(e));

    const res = await app.inject({
      method: 'POST',
      url: '/events/relay',
      payload: {
        type: 'call.started',
        callId: 'relay-test-1',
        channel: 'voice',
        callerPhone: '+17705550100',
      },
    });
    unsubscribe();

    expect(res.statusCode).toBe(204);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ type: 'call.started', callId: 'relay-test-1' });
  });

  it('400s on a payload that does not match any DashboardEvent variant', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/events/relay',
      payload: { type: 'not.a.real.event' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('400s on a known type with a missing required field', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/events/relay',
      payload: { type: 'call.started', callId: 'relay-test-2' },
    });
    expect(res.statusCode).toBe(400);
  });
});
