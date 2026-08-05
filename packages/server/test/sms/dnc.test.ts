import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { customers, smsOptOuts } from '../../src/db/schema.js';
import { isDnc, setDnc } from '../../src/sms/dnc.js';
import { resetDb, seedFixtures } from '../helpers/db.js';

describe('setDnc / isDnc — known customer', () => {
  it('sets customers.dnc and isDnc reflects it', async () => {
    await resetDb();
    const fx = await seedFixtures();

    expect(await isDnc(fx.customerPhone)).toBe(false);

    await setDnc(fx.customerPhone);

    expect(await isDnc(fx.customerPhone)).toBe(true);
    const [row] = await db.select().from(customers).where(eq(customers.phone, fx.customerPhone));
    expect(row?.dnc).toBe(true);
  });
});

describe('setDnc / isDnc — unknown number', () => {
  it('records the opt-out in sms_opt_outs without creating a customers row', async () => {
    await resetDb();
    const phone = '+17705550001';

    expect(await isDnc(phone)).toBe(false);

    await setDnc(phone);

    expect(await isDnc(phone)).toBe(true);
    const [optOut] = await db.select().from(smsOptOuts).where(eq(smsOptOuts.phone, phone));
    expect(optOut).toBeDefined();
    const [customerRow] = await db.select().from(customers).where(eq(customers.phone, phone));
    expect(customerRow).toBeUndefined();
  });

  it('is idempotent — opting out twice does not throw', async () => {
    await resetDb();
    const phone = '+17705550002';
    await setDnc(phone);
    await expect(setDnc(phone)).resolves.toBeUndefined();
    expect(await isDnc(phone)).toBe(true);
  });
});

describe('isDnc — never opted out', () => {
  it('is false for a number that never appears anywhere', async () => {
    await resetDb();
    expect(await isDnc('+17705559876')).toBe(false);
  });
});
