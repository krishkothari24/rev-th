import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, seedFixtures, type Fixtures } from '../helpers/db.js';
import { customerLookupSchema, customerLookupService } from '../../src/tools/customerLookup.js';

describe('customer_lookup', () => {
  let fx: Fixtures;

  beforeEach(async () => {
    await resetDb();
    fx = await seedFixtures();
  });

  it('returns a compact, speakable summary for a known customer', async () => {
    const args = customerLookupSchema.parse({ call_id: 'call-1', phone: fx.customerPhone });
    const result = await customerLookupService(args);

    expect(result.found).toBe(true);
    expect(result.summary).toContain('Test Customer');
    expect(result.summary).toContain('Cobb County');
    expect(result.summary).toContain('Comfort Club');
    expect(result.summary).toContain('heat pump');

    const customer = result.customer as Record<string, unknown>;
    expect(customer.id).toBe(fx.customerId);
    // Internal-use fields are present for booking, unconfirmed-readback is a
    // prompt-layer rule (§8.2), not something this tool enforces.
    expect(customer.address_line).toBe('100 Test Ln');
    // No payment data anywhere in the shape — there is none in the schema.
    expect(JSON.stringify(result)).not.toMatch(/payment|card|invoice_total/i);
  });

  it('returns {found: false} for an unrecognized number', async () => {
    const args = customerLookupSchema.parse({ call_id: 'call-2', phone: '+17705550000' });
    const result = await customerLookupService(args);
    expect(result).toEqual({ found: false });
  });

  it('rejects a malformed phone number', () => {
    const parsed = customerLookupSchema.safeParse({ call_id: 'call-3', phone: '404-555-1234' });
    expect(parsed.success).toBe(false);
  });

  it('rejects a missing call_id', () => {
    const parsed = customerLookupSchema.safeParse({ phone: fx.customerPhone });
    expect(parsed.success).toBe(false);
  });

  it('rejects an unrecognized field rather than silently ignoring it', () => {
    const parsed = customerLookupSchema.safeParse({
      call_id: 'call-4',
      phone: fx.customerPhone,
      membership_tier: 'comfort_club', // not this tool's to set
    });
    expect(parsed.success).toBe(false);
  });
});
