/**
 * check_availability(county, urgency, required_skills[]) — BUILD_GUIDE §4.
 * Returns 2-3 concrete slots, nearest first. Never an empty array without an
 * explanatory `note` the agent can speak — silence here reads on a call as
 * the agent going blank, so a no-availability result is always paired with
 * something sayable.
 */
import { z } from 'zod';
import { callIdSchema, countySchema, requiredSkillsSchema, urgencySchema } from './common.js';
import { findAvailableSlots, formatSlotLabel, SEARCH_DAYS } from './availability.js';

export const checkAvailabilitySchema = z
  .object({
    call_id: callIdSchema,
    county: countySchema,
    urgency: urgencySchema,
    required_skills: requiredSkillsSchema,
  })
  .strict();

export type CheckAvailabilityArgs = z.infer<typeof checkAvailabilitySchema>;

export async function checkAvailabilityService(args: CheckAvailabilityArgs): Promise<Record<string, unknown>> {
  const slots = await findAvailableSlots({
    county: args.county,
    requiredSkills: args.required_skills,
    limit: 3,
  });

  if (slots.length === 0) {
    const skillNote = args.required_skills.length > 0 ? ` with ${args.required_skills.join('/')} certification` : '';
    return {
      slots: [],
      note: `No technicians${skillNote} are open in ${args.county} County in the next ${SEARCH_DAYS} days — I can flag this for a callback or check a neighboring county.`,
    };
  }

  return {
    slots: slots.map((s) => ({
      start: s.start.toISOString(),
      end: s.end.toISOString(),
      label: formatSlotLabel(s.start, s.end),
    })),
    note: args.urgency === 'emergency' ? 'These are the earliest available dispatch windows.' : undefined,
  };
}
