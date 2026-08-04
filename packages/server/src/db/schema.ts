import {
  pgTable,
  pgEnum,
  uuid,
  text,
  boolean,
  integer,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/**
 * Schema per BUILD_GUIDE §2.
 *
 * Enums are database-level enums on purpose. The tool layer validates with Zod
 * at the boundary, but urgency and status are also constrained here so a bug in
 * an unvalidated code path still cannot write a bogus urgency into the board.
 */

export const propertyTypeEnum = pgEnum('property_type', ['residential', 'commercial']);
export const membershipTierEnum = pgEnum('membership_tier', ['basic', 'comfort_club']);
export const equipmentKindEnum = pgEnum('equipment_kind', [
  'furnace',
  'central_ac',
  'heat_pump',
  'mini_split',
  'rooftop_unit',
  'boiler',
]);
export const urgencyEnum = pgEnum('urgency', ['routine', 'priority', 'emergency']);
export const appointmentStatusEnum = pgEnum('appointment_status', [
  'booked',
  'dispatched',
  'complete',
  'cancelled',
]);
export const emergencyReasonEnum = pgEnum('emergency_reason', [
  'gas_smell',
  'no_heat_vulnerable',
  'no_ac_vulnerable',
  'no_heat_general',
  'no_ac_general',
  'other',
]);
export const channelEnum = pgEnum('channel', ['voice', 'sms']);
export const conversationOutcomeEnum = pgEnum('conversation_outcome', [
  'booked',
  'flagged',
  'transferred',
  'abandoned',
  'info_only',
]);

export const customers = pgTable(
  'customers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    phone: text('phone').notNull().unique(),
    name: text('name').notNull(),
    addressLine: text('address_line').notNull(),
    city: text('city').notNull(),
    county: text('county').notNull(),
    propertyType: propertyTypeEnum('property_type').notNull().default('residential'),
    membershipTier: membershipTierEnum('membership_tier'),
    dnc: boolean('dnc').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('customers_county_idx').on(t.county)],
);

export const equipment = pgTable(
  'equipment',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'cascade' }),
    kind: equipmentKindEnum('kind').notNull(),
    installYear: integer('install_year'),
    lastServiceAt: timestamp('last_service_at', { withTimezone: true }),
    notes: text('notes'),
  },
  (t) => [index('equipment_customer_idx').on(t.customerId)],
);

export const technicians = pgTable('technicians', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  homeCounty: text('home_county').notNull(),
  skills: text('skills').array().notNull().default([]),
  active: boolean('active').notNull().default(true),
});

export const appointments = pgTable(
  'appointments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'cascade' }),
    technicianId: uuid('technician_id').references(() => technicians.id, { onDelete: 'set null' }),
    scheduledStart: timestamp('scheduled_start', { withTimezone: true }).notNull(),
    scheduledEnd: timestamp('scheduled_end', { withTimezone: true }).notNull(),
    urgency: urgencyEnum('urgency').notNull().default('routine'),
    issueSummary: text('issue_summary').notNull(),
    equipmentId: uuid('equipment_id').references(() => equipment.id, { onDelete: 'set null' }),
    requiredSkills: text('required_skills').array().notNull().default([]),
    status: appointmentStatusEnum('status').notNull().default('booked'),
    sourceChannel: channelEnum('source_channel').notNull(),
    sourceCallId: text('source_call_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('appointments_tech_start_idx').on(t.technicianId, t.scheduledStart),
    index('appointments_start_idx').on(t.scheduledStart),
    index('appointments_customer_idx').on(t.customerId),
    // The real double-booking guard. book_appointment re-checks the chosen
    // slot before inserting, but that check-then-insert has a race window;
    // this partial unique index is what actually makes two concurrent
    // bookings for the same tech/slot impossible rather than just unlikely.
    // Cancelled appointments are excluded so a freed slot can be rebooked,
    // and multiple NULL technician_id rows are unaffected (Postgres treats
    // each NULL as distinct in a unique index).
    uniqueIndex('appointments_tech_slot_unique')
      .on(t.technicianId, t.scheduledStart)
      .where(sql`${t.status} <> 'cancelled'`),
  ],
);

/**
 * customerId is nullable and the address/phone are snapshotted as free text:
 * in a real gas-leak call you may flag before you ever identify the caller,
 * and the snapshot has to survive even if the customer record changes later.
 */
export const emergencyFlags = pgTable(
  'emergency_flags',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    customerId: uuid('customer_id').references(() => customers.id, { onDelete: 'set null' }),
    callId: text('call_id').notNull(),
    reason: emergencyReasonEnum('reason').notNull(),
    addressSnapshot: text('address_snapshot'),
    phoneSnapshot: text('phone_snapshot'),
    notes: text('notes'),
    acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('emergency_flags_created_idx').on(t.createdAt),
    // One flag per call. The server-side cap in §8.3 is enforced in code, but
    // this makes a double-flag impossible even if that check is bypassed.
    uniqueIndex('emergency_flags_call_idx').on(t.callId),
  ],
);

export const conversations = pgTable(
  'conversations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    channel: channelEnum('channel').notNull(),
    externalId: text('external_id').notNull().unique(),
    customerId: uuid('customer_id').references(() => customers.id, { onDelete: 'set null' }),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    outcome: conversationOutcomeEnum('outcome'),
    transcript: jsonb('transcript'),
    dispositionSummary: text('disposition_summary'),
  },
  (t) => [index('conversations_started_idx').on(t.startedAt)],
);

/**
 * idempotencyKey is sha256(call_id + tool_name + canonical_json(args)).
 * Retell retries on timeout; without the unique constraint you double-book.
 */
export const toolInvocations = pgTable(
  'tool_invocations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversationId: uuid('conversation_id').references(() => conversations.id, {
      onDelete: 'cascade',
    }),
    toolName: text('tool_name').notNull(),
    args: jsonb('args').notNull(),
    result: jsonb('result'),
    idempotencyKey: text('idempotency_key').notNull().unique(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('tool_invocations_conversation_idx').on(t.conversationId)],
);

export type Customer = typeof customers.$inferSelect;
export type NewCustomer = typeof customers.$inferInsert;
export type Equipment = typeof equipment.$inferSelect;
export type Technician = typeof technicians.$inferSelect;
export type Appointment = typeof appointments.$inferSelect;
export type NewAppointment = typeof appointments.$inferInsert;
export type EmergencyFlag = typeof emergencyFlags.$inferSelect;
export type Conversation = typeof conversations.$inferSelect;
export type ToolInvocation = typeof toolInvocations.$inferSelect;

export type Urgency = (typeof urgencyEnum.enumValues)[number];
export type EmergencyReason = (typeof emergencyReasonEnum.enumValues)[number];
export type Channel = (typeof channelEnum.enumValues)[number];
export type PropertyType = (typeof propertyTypeEnum.enumValues)[number];
export type EquipmentKind = (typeof equipmentKindEnum.enumValues)[number];
export type MembershipTier = (typeof membershipTierEnum.enumValues)[number];
