/**
 * Mirrors `packages/server/src/domain/constants.ts` (`BUSINESS_HOURS`,
 * `SLOT_HOURS`) and the slot-hour derivation in
 * `packages/server/src/tools/availability.ts` — the board's row grid has to
 * line up with the exact hours the backend actually books against, or a
 * real appointment could render off-grid.
 */
export const BUSINESS_HOURS = { startHour: 8, endHour: 18 } as const;
export const SLOT_HOURS = 2;

export const SLOT_START_HOURS = Array.from(
  { length: (BUSINESS_HOURS.endHour - BUSINESS_HOURS.startHour) / SLOT_HOURS },
  (_, i) => BUSINESS_HOURS.startHour + i * SLOT_HOURS,
);
