import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { resetDb, seedFixtures, type Fixtures } from '../helpers/db.js';
import { flagEmergencySchema, flagEmergencyService } from '../../src/tools/flagEmergency.js';
import { runTool } from '../../src/tools/runTool.js';
import { db } from '../../src/db/client.js';
import { emergencyFlags } from '../../src/db/schema.js';

describe('flag_emergency', () => {
  let fx: Fixtures;

  beforeEach(async () => {
    await resetDb();
    fx = await seedFixtures();
  });

  it('is callable with only phone + address + reason, and links a known customer', async () => {
    const args = flagEmergencySchema.parse({
      call_id: 'call-emg-1',
      phone: fx.customerPhone,
      address: '100 Test Ln',
      reason: 'gas_smell',
    });
    const result = await flagEmergencyService(args);
    expect(result.flagged).toBe(true);

    const [row] = await db
      .select()
      .from(emergencyFlags)
      .where(eq(emergencyFlags.callId, 'call-emg-1'));
    expect(row?.customerId).toBe(fx.customerId);
    expect(row?.reason).toBe('gas_smell');
  });

  it('works for an unrecognized caller — customerId stays null, doesn’t block the flag', async () => {
    const args = flagEmergencySchema.parse({
      call_id: 'call-emg-2',
      phone: '+17705550000',
      address: 'unknown, caller mid-sentence',
      reason: 'no_heat_vulnerable',
    });
    const result = await flagEmergencyService(args);
    expect(result.flagged).toBe(true);

    const [row] = await db
      .select()
      .from(emergencyFlags)
      .where(eq(emergencyFlags.callId, 'call-emg-2'));
    expect(row?.customerId).toBeNull();
  });

  it('enforces one emergency flag per call, even for a second distinct attempt', async () => {
    const first = flagEmergencySchema.parse({
      call_id: 'call-emg-3',
      phone: fx.customerPhone,
      address: '100 Test Ln',
      reason: 'gas_smell',
    });
    await flagEmergencyService(first);

    // Same call, different reason — not a retry, a second attempt to flag.
    const second = flagEmergencySchema.parse({
      call_id: 'call-emg-3',
      phone: fx.customerPhone,
      address: '100 Test Ln',
      reason: 'other',
    });
    const secondResult = await flagEmergencyService(second);
    expect(secondResult.already_flagged).toBe(true);

    const rows = await db
      .select()
      .from(emergencyFlags)
      .where(eq(emergencyFlags.callId, 'call-emg-3'));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.reason).toBe('gas_smell'); // the original flag, unchanged
  });

  it('is idempotent through runTool for an exact retry', async () => {
    const args = flagEmergencySchema.parse({
      call_id: 'call-emg-4',
      phone: fx.customerPhone,
      address: '100 Test Ln',
      reason: 'gas_smell',
    });

    const first = await runTool('flag_emergency', args, () => flagEmergencyService(args));
    const second = await runTool('flag_emergency', args, () => flagEmergencyService(args));
    expect(second).toEqual(first);

    const rows = await db
      .select()
      .from(emergencyFlags)
      .where(eq(emergencyFlags.callId, 'call-emg-4'));
    expect(rows).toHaveLength(1);
  });

  it('rejects a reason outside the enum', () => {
    const parsed = flagEmergencySchema.safeParse({
      call_id: 'call-emg-5',
      phone: fx.customerPhone,
      address: '100 Test Ln',
      reason: 'smells_weird', // not a real value
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a missing address', () => {
    const parsed = flagEmergencySchema.safeParse({
      call_id: 'call-emg-6',
      phone: fx.customerPhone,
      reason: 'gas_smell',
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects an unrecognized field', () => {
    const parsed = flagEmergencySchema.safeParse({
      call_id: 'call-emg-7',
      phone: fx.customerPhone,
      address: '100 Test Ln',
      reason: 'gas_smell',
      urgency: 'emergency', // urgency isn't part of this tool's contract
    });
    expect(parsed.success).toBe(false);
  });
});
