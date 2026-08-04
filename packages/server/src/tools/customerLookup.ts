/**
 * customer_lookup(phone) — BUILD_GUIDE §4. Returns a compact, speakable
 * summary or `{found: false}`. Never returns payment data — there is none in
 * the schema, by design (PRD: no real pricebook/payment integration).
 *
 * The `customer` object below (address, county, equipment) is for internal
 * use in booking, not for the model to read aloud unconfirmed — that
 * disclosure rule (§8.2) lives in the prompt layer, not here. This tool's
 * job is to return the facts; deciding what's safe to say out loud is a
 * Phase 4+ prompt concern.
 */
import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { customers, equipment, type Equipment } from '../db/schema.js';
import { callIdSchema, phoneSchema } from './common.js';

export const customerLookupSchema = z
  .object({
    call_id: callIdSchema,
    phone: phoneSchema,
  })
  .strict();

export type CustomerLookupArgs = z.infer<typeof customerLookupSchema>;

const MONTH_FMT = new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric' });

function describeEquipment(e: Equipment): string {
  const kind = e.kind.replace(/_/g, ' ');
  const installed = e.installYear ? ` installed ${e.installYear}` : '';
  const serviced = e.lastServiceAt ? `, last serviced ${MONTH_FMT.format(e.lastServiceAt)}` : ', never serviced';
  return `${kind}${installed}${serviced}`;
}

const MEMBERSHIP_LABEL: Record<string, string> = {
  comfort_club: 'Comfort Club member',
  basic: 'Basic plan member',
};

export async function customerLookupService(args: CustomerLookupArgs): Promise<Record<string, unknown>> {
  const [customer] = await db.select().from(customers).where(eq(customers.phone, args.phone)).limit(1);
  if (!customer) return { found: false };

  const equipmentRows = await db
    .select()
    .from(equipment)
    .where(eq(equipment.customerId, customer.id))
    .orderBy(desc(equipment.installYear));

  const summaryParts = [
    customer.name,
    `${customer.addressLine}, ${customer.county} County`,
    customer.membershipTier ? MEMBERSHIP_LABEL[customer.membershipTier] : null,
    ...equipmentRows.map(describeEquipment),
  ].filter((p): p is string => Boolean(p));

  return {
    found: true,
    summary: `${summaryParts.join('. ')}.`,
    customer: {
      id: customer.id,
      name: customer.name,
      phone: customer.phone,
      address_line: customer.addressLine,
      city: customer.city,
      county: customer.county,
      property_type: customer.propertyType,
      membership_tier: customer.membershipTier,
      equipment: equipmentRows.map((e) => ({
        id: e.id,
        kind: e.kind,
        install_year: e.installYear,
        last_service_at: e.lastServiceAt ? e.lastServiceAt.toISOString() : null,
      })),
    },
  };
}
