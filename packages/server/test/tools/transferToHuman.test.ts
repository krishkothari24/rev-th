import { describe, expect, it } from 'vitest';
import { transferToHumanSchema, transferToHumanService } from '../../src/tools/transferToHuman.js';
import { eventBus, type DashboardEvent } from '../../src/events/bus.js';

describe('transfer_to_human', () => {
  it('returns a transfer instruction and logs the reason', async () => {
    const events: DashboardEvent[] = [];
    const unsubscribe = eventBus.subscribe((e) => events.push(e));

    const args = transferToHumanSchema.parse({
      call_id: 'call-transfer-1',
      reason: 'caller wants to speak to a manager',
    });
    const result = await transferToHumanService(args);
    unsubscribe();

    expect(result.transfer).toBe(true);
    expect(typeof result.message).toBe('string');
    expect(events).toEqual([
      {
        type: 'transfer.requested',
        callId: 'call-transfer-1',
        reason: 'caller wants to speak to a manager',
      },
    ]);
  });

  it('rejects an empty reason', () => {
    const parsed = transferToHumanSchema.safeParse({ call_id: 'call-transfer-2', reason: '' });
    expect(parsed.success).toBe(false);
  });

  it('rejects a missing call_id', () => {
    const parsed = transferToHumanSchema.safeParse({ reason: 'billing dispute' });
    expect(parsed.success).toBe(false);
  });

  it('rejects an unrecognized field', () => {
    const parsed = transferToHumanSchema.safeParse({
      call_id: 'call-transfer-3',
      reason: 'billing dispute',
      urgency: 'emergency',
    });
    expect(parsed.success).toBe(false);
  });
});
