/**
 * SMS opt-out / DNC (BUILD_GUIDE §7: "Inbound STOP/UNSUBSCRIBE/CANCEL/END/
 * QUIT sets customers.dnc = true and every outbound send checks it first.
 * Legal compliance, not a nice-to-have.") IMPLEMENTATION_PLAN Phase 8.
 *
 * A phone number that opts out may or may not already be a `customers` row
 * (that table's `name`/`address_line`/etc. are `NOT NULL`, so it can't hold
 * an opt-out-only number) — `setDnc`/`isDnc` cover both cases uniformly by
 * also writing/reading the small, additive `sms_opt_outs` table.
 */
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { customers, smsOptOuts } from '../db/schema.js';

export async function isDnc(phone: string): Promise<boolean> {
  const [customer] = await db
    .select({ dnc: customers.dnc })
    .from(customers)
    .where(eq(customers.phone, phone))
    .limit(1);
  if (customer?.dnc) return true;

  const [optOut] = await db
    .select({ phone: smsOptOuts.phone })
    .from(smsOptOuts)
    .where(eq(smsOptOuts.phone, phone))
    .limit(1);
  return optOut !== undefined;
}

export async function setDnc(phone: string): Promise<void> {
  await db.update(customers).set({ dnc: true }).where(eq(customers.phone, phone));
  await db.insert(smsOptOuts).values({ phone }).onConflictDoNothing({ target: smsOptOuts.phone });
}
