/**
 * Slot search shared by check_availability (display) and book_appointment
 * (assignment). BUILD_GUIDE §4: "technician_id is not a model-settable
 * field — matching happens server-side." check_availability shows the model
 * concrete times; book_appointment re-derives the technician for whichever
 * time the model comes back with, from scratch, rather than trusting
 * anything echoed back from the earlier call. See findTechnicianForSlot.
 */
import { and, eq, gte, inArray, lt, ne } from 'drizzle-orm';
import { db } from '../db/client.js';
import { appointments, technicians } from '../db/schema.js';
import { BUSINESS_HOURS, SLOT_HOURS, type County, type Skill } from '../domain/constants.js';
import { BUSINESS_TIMEZONE, shiftDateParam, zonedDateParam, zonedWallTimeToUtc } from '../lib/timezone.js';

/** 8, 10, 12, 14, 16 — mirrors the seed's SLOTS grid (src/db/seed.ts). */
const SLOT_START_HOURS = Array.from(
  { length: (BUSINESS_HOURS.endHour - BUSINESS_HOURS.startHour) / SLOT_HOURS },
  (_, i) => BUSINESS_HOURS.startHour + i * SLOT_HOURS,
);

/** How many days ahead availability search looks — matches the seeded board window. */
export const SEARCH_DAYS = 6;

export interface SlotCandidate {
  technicianId: string;
  technicianName: string;
  start: Date;
  end: Date;
}

async function getEligibleTechnicians(county: County, requiredSkills: readonly Skill[]) {
  const inCounty = await db
    .select()
    .from(technicians)
    .where(and(eq(technicians.homeCounty, county), eq(technicians.active, true)));
  return inCounty.filter((t) => requiredSkills.every((s) => t.skills.includes(s)));
}

/**
 * Concrete open slots, nearest first. For an emergency urgency this doubles
 * as "immediate dispatch" — the search order already surfaces today's
 * openings before any later day, so no separate code path is needed.
 */
export async function findAvailableSlots(opts: {
  county: County;
  requiredSkills: readonly Skill[];
  now?: Date;
  limit?: number;
}): Promise<SlotCandidate[]> {
  const now = opts.now ?? new Date();
  const limit = opts.limit ?? 3;

  const eligible = await getEligibleTechnicians(opts.county, opts.requiredSkills);
  if (eligible.length === 0) return [];

  const techIds = eligible.map((t) => t.id);
  const horizon = new Date(now);
  horizon.setDate(horizon.getDate() + SEARCH_DAYS);

  const existing = await db
    .select({
      technicianId: appointments.technicianId,
      scheduledStart: appointments.scheduledStart,
    })
    .from(appointments)
    .where(
      and(
        inArray(appointments.technicianId, techIds),
        gte(appointments.scheduledStart, now),
        lt(appointments.scheduledStart, horizon),
        ne(appointments.status, 'cancelled'),
      ),
    );

  const bookedByTech = new Map<string, Set<number>>();
  for (const appt of existing) {
    if (!appt.technicianId) continue;
    const set = bookedByTech.get(appt.technicianId) ?? new Set<number>();
    set.add(appt.scheduledStart.getTime());
    bookedByTech.set(appt.technicianId, set);
  }

  const nowDateParam = zonedDateParam(now);

  const candidates: SlotCandidate[] = [];
  for (let dayOffset = 0; dayOffset < SEARCH_DAYS && candidates.length < limit; dayOffset++) {
    const dateParam = shiftDateParam(nowDateParam, dayOffset);

    for (const hour of SLOT_START_HOURS) {
      if (candidates.length >= limit) break;

      // Wall-clock hour in Summit Air's own timezone, not the server
      // process's — see lib/timezone.ts. Getting this wrong means a slot
      // quoted as "2 to 4" on the call lands on the board hours off.
      const start = zonedWallTimeToUtc(dateParam, hour);
      if (start.getTime() < now.getTime()) continue;

      const end = new Date(start.getTime() + SLOT_HOURS * 60 * 60 * 1000);

      const free = eligible.find((t) => !bookedByTech.get(t.id)?.has(start.getTime()));
      if (free) candidates.push({ technicianId: free.id, technicianName: free.name, start, end });
    }
  }

  return candidates;
}

/**
 * Re-checked at booking time for one exact slot. This is the actual
 * server-side assignment; the check-then-insert race that remains is closed
 * by the `appointments_tech_slot_unique` partial index, not by this query.
 */
export async function findTechnicianForSlot(opts: {
  county: County;
  requiredSkills: readonly Skill[];
  start: Date;
}): Promise<{ id: string; name: string } | null> {
  const eligible = await getEligibleTechnicians(opts.county, opts.requiredSkills);
  if (eligible.length === 0) return null;

  const techIds = eligible.map((t) => t.id);
  const conflicts = await db
    .select({ technicianId: appointments.technicianId })
    .from(appointments)
    .where(
      and(
        inArray(appointments.technicianId, techIds),
        eq(appointments.scheduledStart, opts.start),
        ne(appointments.status, 'cancelled'),
      ),
    );
  const busy = new Set(conflicts.map((c) => c.technicianId));
  const free = eligible.find((t) => !busy.has(t.id));
  return free ? { id: free.id, name: free.name } : null;
}

const DAY_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: BUSINESS_TIMEZONE,
  weekday: 'short',
  month: 'short',
  day: 'numeric',
});
const TIME_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: BUSINESS_TIMEZONE,
  hour: 'numeric',
  minute: '2-digit',
});

/** e.g. "Tue, Aug 5, 2:00 PM–4:00 PM" — speakable, not a raw ISO timestamp. */
export function formatSlotLabel(start: Date, end: Date): string {
  return `${DAY_FMT.format(start)}, ${TIME_FMT.format(start)}–${TIME_FMT.format(end)}`;
}
