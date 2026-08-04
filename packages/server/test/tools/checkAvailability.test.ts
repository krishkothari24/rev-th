import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, seedFixtures } from '../helpers/db.js';
import { checkAvailabilitySchema, checkAvailabilityService } from '../../src/tools/checkAvailability.js';

describe('check_availability', () => {
  beforeEach(async () => {
    await resetDb();
    await seedFixtures();
  });

  it('returns concrete slots when a qualified, active tech exists', async () => {
    const args = checkAvailabilitySchema.parse({
      call_id: 'call-1',
      county: 'Cobb',
      urgency: 'routine',
      required_skills: ['gas'],
    });
    const result = await checkAvailabilityService(args);

    const slots = result.slots as { start: string; end: string; label: string }[];
    expect(slots.length).toBeGreaterThan(0);
    expect(slots.length).toBeLessThanOrEqual(3);
    for (const slot of slots) {
      expect(new Date(slot.start).toString()).not.toBe('Invalid Date');
      expect(new Date(slot.end).getTime()).toBeGreaterThan(new Date(slot.start).getTime());
      expect(slot.label).toBeTruthy();
    }
  });

  it('never returns an empty array without a speakable note — no qualified tech for the skill', async () => {
    // Only the inactive tech (Renata Kim) has 'commercial'; the active filter
    // must exclude her.
    const args = checkAvailabilitySchema.parse({
      call_id: 'call-2',
      county: 'Cobb',
      urgency: 'routine',
      required_skills: ['commercial'],
    });
    const result = await checkAvailabilityService(args);

    expect(result.slots).toEqual([]);
    expect(typeof result.note).toBe('string');
    expect((result.note as string).length).toBeGreaterThan(0);
  });

  it('never returns an empty array without a speakable note — no techs in the county at all', async () => {
    const args = checkAvailabilitySchema.parse({
      call_id: 'call-3',
      county: 'Paulding',
      urgency: 'routine',
      required_skills: [],
    });
    const result = await checkAvailabilityService(args);

    expect(result.slots).toEqual([]);
    expect(result.note).toContain('Paulding');
  });

  it('rejects an urgency value outside the enum', () => {
    const parsed = checkAvailabilitySchema.safeParse({
      call_id: 'call-4',
      county: 'Cobb',
      urgency: 'critical', // not a real value — the model cannot invent one
      required_skills: [],
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a county outside the service area', () => {
    const parsed = checkAvailabilitySchema.safeParse({
      call_id: 'call-5',
      county: 'Fulton',
      urgency: 'routine',
      required_skills: [],
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects an unrecognized field', () => {
    const parsed = checkAvailabilitySchema.safeParse({
      call_id: 'call-6',
      county: 'Cobb',
      urgency: 'routine',
      required_skills: [],
      technician_id: 'not-yours-to-set',
    });
    expect(parsed.success).toBe(false);
  });
});
