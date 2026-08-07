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
import { and, asc, desc, eq, gte, ne } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { appointments, customers, equipment, technicians, type Equipment } from '../db/schema.js';
import { callIdSchema, phoneSchema } from './common.js';
import { formatSlotLabel } from './availability.js';

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
  const serviced = e.lastServiceAt
    ? `, last serviced ${MONTH_FMT.format(e.lastServiceAt)}`
    : ', never serviced';
  return `${kind}${installed}${serviced}`;
}

const MEMBERSHIP_LABEL: Record<string, string> = {
  comfort_club: 'Comfort Club member',
  basic: 'Basic plan member',
};

export async function customerLookupService(
  args: CustomerLookupArgs,
): Promise<Record<string, unknown>> {
  const [customer] = await db
    .select()
    .from(customers)
    .where(eq(customers.phone, args.phone))
    .limit(1);
  if (!customer) return { found: false };

  const equipmentRows = await db
    .select()
    .from(equipment)
    .where(eq(equipment.customerId, customer.id))
    .orderBy(desc(equipment.installYear));

  // So "can you confirm my appointment" doesn't dead-end in
  // transfer_to_human — the agent needs the fact, not just better phrasing
  // for not having it. Nearest upcoming, booked-or-dispatched only.
  const [nextAppt] = await db
    .select({
      id: appointments.id,
      scheduledStart: appointments.scheduledStart,
      scheduledEnd: appointments.scheduledEnd,
      status: appointments.status,
      technicianName: technicians.name,
    })
    .from(appointments)
    .leftJoin(technicians, eq(appointments.technicianId, technicians.id))
    .where(
      and(
        eq(appointments.customerId, customer.id),
        gte(appointments.scheduledStart, new Date()),
        ne(appointments.status, 'cancelled'),
      ),
    )
    .orderBy(asc(appointments.scheduledStart))
    .limit(1);

  const summaryParts = [
    customer.name,
    `${customer.addressLine}, ${customer.county} County`,
    customer.membershipTier ? MEMBERSHIP_LABEL[customer.membershipTier] : null,
    ...equipmentRows.map(describeEquipment),
    nextAppt
      ? `Upcoming appointment: ${formatSlotLabel(nextAppt.scheduledStart, nextAppt.scheduledEnd)}${nextAppt.technicianName ? ` with ${nextAppt.technicianName.split(' ')[0]}` : ''} (${nextAppt.status}).`
      : null,
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
      next_appointment: nextAppt
        ? {
            id: nextAppt.id,
            scheduled_start: nextAppt.scheduledStart.toISOString(),
            scheduled_end: nextAppt.scheduledEnd.toISOString(),
            status: nextAppt.status,
            technician_first_name: nextAppt.technicianName
              ? nextAppt.technicianName.split(' ')[0]
              : null,
          }
        : null,
    },
  };
}
