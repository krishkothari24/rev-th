/**
 * book_appointment({...}) — BUILD_GUIDE §4. Validates, assigns a qualified
 * technician *server-side*, writes the row, emits `appointment.created`,
 * queues a confirmation SMS. Returns confirmation details including the
 * assigned tech's first name.
 *
 * `technician_id` is deliberately absent from the input schema — the model
 * proposes a time (from check_availability), the server decides who's sent.
 * Pricing and membership fields are likewise absent; `.strict()` turns any
 * attempt to smuggle one in into a 400 rather than a silent write.
 */
import { z } from 'zod';
import { db } from '../db/client.js';
import { appointments, customers } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { eventBus } from '../events/bus.js';
import { isUniqueViolation } from '../lib/pgErrors.js';
import { SLOT_HOURS, type County } from '../domain/constants.js';
import {
  callIdSchema,
  channelSchema,
  countySchema,
  phoneSchema,
  propertyTypeSchema,
  requiredSkillsSchema,
  urgencySchema,
} from './common.js';
import { findTechnicianForSlot, formatSlotLabel } from './availability.js';

export const bookAppointmentSchema = z
  .object({
    call_id: callIdSchema,
    phone: phoneSchema,
    // Required even for a known caller: the agent already has these from
    // customer_lookup and passes them through rather than re-asking, but the
    // tool boundary doesn't special-case "known customer" — see
    // findOrCreateCustomer below for why an existing record wins regardless.
    name: z.string().trim().min(1).max(120),
    address_line: z.string().trim().min(1).max(200),
    city: z.string().trim().min(1).max(100),
    county: countySchema,
    property_type: propertyTypeSchema.default('residential'),
    urgency: urgencySchema,
    issue_summary: z.string().trim().min(1).max(500),
    required_skills: requiredSkillsSchema,
    scheduled_start: z.string().datetime({ offset: true }),
    equipment_id: z.string().uuid().optional(),
    source_channel: channelSchema,
  })
  .strict();

export type BookAppointmentArgs = z.infer<typeof bookAppointmentSchema>;

function firstNameOf(fullName: string): string {
  return fullName.split(' ')[0] ?? fullName;
}

/**
 * Existing phone match wins outright — name/address/county on the call are
 * ignored in favor of the record on file, so a call that gets a phone number
 * right but the rest wrong (misheard, or a spoofed-ANI mismatch per §8.2)
 * can't quietly overwrite a real customer's address. New customers are
 * created from exactly what was collected on this call.
 */
async function findOrCreateCustomer(args: BookAppointmentArgs): Promise<{ id: string; phone: string; county: County }> {
  const [existing] = await db.select().from(customers).where(eq(customers.phone, args.phone)).limit(1);
  if (existing) return { id: existing.id, phone: existing.phone, county: existing.county as County };

  const [created] = await db
    .insert(customers)
    .values({
      phone: args.phone,
      name: args.name,
      addressLine: args.address_line,
      city: args.city,
      county: args.county,
      propertyType: args.property_type,
    })
    .returning();
  if (!created) throw new Error('customer insert returned no row');
  return { id: created.id, phone: created.phone, county: created.county as County };
}

// Small grace window, not zero, so a slot picked a few seconds ago (turn
// latency between check_availability and the model's next response) doesn't
// get rejected as "in the past."
const PAST_GRACE_MS = 5 * 60 * 1000;

export async function bookAppointmentService(args: BookAppointmentArgs): Promise<Record<string, unknown>> {
  const start = new Date(args.scheduled_start);
  const end = new Date(start.getTime() + SLOT_HOURS * 60 * 60 * 1000);

  if (start.getTime() < Date.now() - PAST_GRACE_MS) {
    return { booked: false, note: 'That time has already passed — let’s find something upcoming instead.' };
  }

  const customer = await findOrCreateCustomer(args);

  const tech = await findTechnicianForSlot({
    county: customer.county,
    requiredSkills: args.required_skills,
    start,
  });
  if (!tech) {
    return {
      booked: false,
      note: `No qualified technician is open for that time in ${customer.county} County — want the next available slot instead?`,
    };
  }

  try {
    const [appt] = await db
      .insert(appointments)
      .values({
        customerId: customer.id,
        technicianId: tech.id,
        scheduledStart: start,
        scheduledEnd: end,
        urgency: args.urgency,
        issueSummary: args.issue_summary,
        equipmentId: args.equipment_id ?? null,
        requiredSkills: args.required_skills,
        status: 'booked',
        sourceChannel: args.source_channel,
        sourceCallId: args.call_id,
      })
      .returning();
    if (!appt) throw new Error('appointment insert returned no row');

    eventBus.publish({
      type: 'appointment.created',
      appointmentId: appt.id,
      customerId: customer.id,
      technicianId: tech.id,
      technicianName: tech.name,
      scheduledStart: start.toISOString(),
      urgency: args.urgency,
    });
    // Queued, not sent — the actual Twilio send is Phase 8. This keeps the
    // side effect boundary in the right place today: the tool layer decides
    // *that* a confirmation is owed and what it says, transport wires it up.
    eventBus.publish({
      type: 'sms.queued',
      kind: 'booking_confirmation',
      to: customer.phone,
      body: `Summit Air: you're booked ${formatSlotLabel(start, end)} with ${firstNameOf(tech.name)}. Reply STOP to opt out.`,
    });

    return {
      booked: true,
      appointment_id: appt.id,
      technician_first_name: firstNameOf(tech.name),
      scheduled_start: start.toISOString(),
      scheduled_end: end.toISOString(),
      summary: `Booked with ${firstNameOf(tech.name)}, ${formatSlotLabel(start, end)}.`,
    };
  } catch (err) {
    if (isUniqueViolation(err, 'appointments_tech_slot_unique')) {
      return { booked: false, note: 'That slot was just taken — want me to find the next available time?' };
    }
    throw err;
  }
}
