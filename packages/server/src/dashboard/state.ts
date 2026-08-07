/**
 * Data access for the dashboard's REST surface (IMPLEMENTATION_PLAN Phase
 * 7). `GET /dashboard/state` is the snapshot a freshly (re)opened dashboard
 * loads before layering live `/events` deltas on top — without it the board
 * is empty white space until the next event fires, which looks broken
 * through most of a demo.
 *
 * Capacity math (`booked`/`total` slots per technician) is computed here,
 * not in the frontend, same "server owns the business logic, client just
 * renders" split the tool layer already follows — `tools/availability.ts`
 * derives its slot grid from the same `BUSINESS_HOURS`/`SLOT_HOURS`
 * constants, so the two can't drift apart.
 */
import { and, desc, eq, gte, lt, ne, isNull } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  appointments,
  customers,
  emergencyFlags,
  technicians,
  toolInvocations,
  conversations,
} from '../db/schema.js';
import { BUSINESS_HOURS, SLOT_HOURS } from '../domain/constants.js';
import { describeToolInvocation } from '../events/activityFormat.js';
import { eventBus } from '../events/bus.js';
import { zonedDateParam, zonedDayBounds } from '../lib/timezone.js';

const SLOTS_PER_DAY = (BUSINESS_HOURS.endHour - BUSINESS_HOURS.startHour) / SLOT_HOURS;
const ACTIVITY_LIMIT = 50;
const EMERGENCY_LIMIT = 20;
const DATE_PARAM = /^\d{4}-\d{2}-\d{2}$/;

export interface ResolvedBoardDate {
  date: string;
  start: Date;
  end: Date;
}

/**
 * `dateParam` is calendar-day granularity in Summit Air's own timezone
 * (`lib/timezone.ts`), not the server process's — matches how
 * `tools/availability.ts` generates slots, so "today" here and "today" a
 * booking landed on always agree regardless of which timezone the process
 * happens to run in. Falls back to the current day on a missing/malformed
 * param rather than rejecting the request — the dashboard's own date-nav
 * always sends a valid one, and a bad query param shouldn't blank the board.
 */
export function resolveBoardDate(dateParam?: string): ResolvedBoardDate {
  const date = dateParam && DATE_PARAM.test(dateParam) ? dateParam : zonedDateParam(new Date());
  const { start, end } = zonedDayBounds(date);
  return { date, start, end };
}

export interface DashboardTechnician {
  id: string;
  name: string;
  homeCounty: string;
  skills: string[];
  capacity: { booked: number; total: number };
}

export interface DashboardAppointment {
  id: string;
  customerId: string;
  customerName: string;
  technicianId: string | null;
  scheduledStart: string;
  scheduledEnd: string;
  urgency: string;
  issueSummary: string;
  status: string;
}

export interface DashboardEmergency {
  id: string;
  callId: string;
  reason: string;
  addressSnapshot: string | null;
  phoneSnapshot: string | null;
  notes: string | null;
  acknowledgedAt: string | null;
  createdAt: string;
}

export interface DashboardActivityItem {
  id: string;
  callId: string | null;
  toolName: string;
  summary: string;
  createdAt: string;
}

export interface DashboardState {
  date: string;
  technicians: DashboardTechnician[];
  appointments: DashboardAppointment[];
  emergencies: DashboardEmergency[];
  activity: DashboardActivityItem[];
}

export async function getDashboardState(dateParam?: string): Promise<DashboardState> {
  const { date, start, end } = resolveBoardDate(dateParam);

  const techRows = await db
    .select()
    .from(technicians)
    .where(eq(technicians.active, true))
    .orderBy(technicians.homeCounty, technicians.name);

  const apptRows = await db
    .select({
      id: appointments.id,
      customerId: appointments.customerId,
      customerName: customers.name,
      technicianId: appointments.technicianId,
      scheduledStart: appointments.scheduledStart,
      scheduledEnd: appointments.scheduledEnd,
      urgency: appointments.urgency,
      issueSummary: appointments.issueSummary,
      status: appointments.status,
    })
    .from(appointments)
    .innerJoin(customers, eq(appointments.customerId, customers.id))
    .where(
      and(
        gte(appointments.scheduledStart, start),
        lt(appointments.scheduledStart, end),
        ne(appointments.status, 'cancelled'),
      ),
    );

  const bookedByTech = new Map<string, number>();
  for (const appt of apptRows) {
    if (!appt.technicianId) continue;
    bookedByTech.set(appt.technicianId, (bookedByTech.get(appt.technicianId) ?? 0) + 1);
  }

  const emergencyRows = await db
    .select()
    .from(emergencyFlags)
    .orderBy(desc(emergencyFlags.createdAt))
    .limit(EMERGENCY_LIMIT);
  // Unacknowledged first (what the rail is for), newest-first within each
  // group — a resolved flag scrolling below active ones instead of a strict
  // single timestamp sort.
  const sortedEmergencies = [...emergencyRows].sort((a, b) => {
    const ackWeight = (Number(Boolean(a.acknowledgedAt)) - Number(Boolean(b.acknowledgedAt))) as
      -1 | 0 | 1;
    if (ackWeight !== 0) return ackWeight;
    return b.createdAt.getTime() - a.createdAt.getTime();
  });

  const activityRows = await db
    .select({
      id: toolInvocations.id,
      toolName: toolInvocations.toolName,
      args: toolInvocations.args,
      result: toolInvocations.result,
      createdAt: toolInvocations.createdAt,
      callId: conversations.externalId,
    })
    .from(toolInvocations)
    .leftJoin(conversations, eq(toolInvocations.conversationId, conversations.id))
    .orderBy(desc(toolInvocations.createdAt))
    .limit(ACTIVITY_LIMIT);

  return {
    date,
    technicians: techRows.map((t) => ({
      id: t.id,
      name: t.name,
      homeCounty: t.homeCounty,
      skills: t.skills,
      capacity: { booked: bookedByTech.get(t.id) ?? 0, total: SLOTS_PER_DAY },
    })),
    appointments: apptRows.map((a) => ({
      id: a.id,
      customerId: a.customerId,
      customerName: a.customerName,
      technicianId: a.technicianId,
      scheduledStart: a.scheduledStart.toISOString(),
      scheduledEnd: a.scheduledEnd.toISOString(),
      urgency: a.urgency,
      issueSummary: a.issueSummary,
      status: a.status,
    })),
    emergencies: sortedEmergencies.map((e) => ({
      id: e.id,
      callId: e.callId,
      reason: e.reason,
      addressSnapshot: e.addressSnapshot,
      phoneSnapshot: e.phoneSnapshot,
      notes: e.notes,
      acknowledgedAt: e.acknowledgedAt ? e.acknowledgedAt.toISOString() : null,
      createdAt: e.createdAt.toISOString(),
    })),
    activity: activityRows.map((r) => ({
      id: r.id,
      callId: r.callId ?? null,
      toolName: r.toolName,
      summary: describeToolInvocation(
        r.toolName,
        (r.args as Record<string, unknown>) ?? {},
        (r.result as Record<string, unknown>) ?? {},
      ),
      createdAt: r.createdAt.toISOString(),
    })),
  };
}

export type AcknowledgeResult =
  | { ok: true; alreadyAcknowledged: boolean; acknowledgedAt: string }
  | { ok: false; notFound: true };

/**
 * Idempotent on purpose — a dashboard double-click (or two operators acking
 * the same flag) must not error, and must not stomp an earlier
 * `acknowledgedAt` with a later one.
 */
export async function acknowledgeEmergency(id: string): Promise<AcknowledgeResult> {
  const [existing] = await db
    .select({ id: emergencyFlags.id, acknowledgedAt: emergencyFlags.acknowledgedAt })
    .from(emergencyFlags)
    .where(eq(emergencyFlags.id, id))
    .limit(1);
  if (!existing) return { ok: false, notFound: true };

  if (existing.acknowledgedAt) {
    return {
      ok: true,
      alreadyAcknowledged: true,
      acknowledgedAt: existing.acknowledgedAt.toISOString(),
    };
  }

  const acknowledgedAt = new Date();
  await db
    .update(emergencyFlags)
    .set({ acknowledgedAt })
    .where(and(eq(emergencyFlags.id, id), isNull(emergencyFlags.acknowledgedAt)));

  eventBus.publish({
    type: 'emergency.acknowledged',
    emergencyId: id,
    acknowledgedAt: acknowledgedAt.toISOString(),
  });

  return { ok: true, alreadyAcknowledged: false, acknowledgedAt: acknowledgedAt.toISOString() };
}
