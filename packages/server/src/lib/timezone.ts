/**
 * Summit Air operates in Cobb/Cherokee/Paulding counties, GA — all business
 * hours, slot generation, and dashboard "today" windows must be anchored to
 * this timezone. The server process is not guaranteed to run in it (Railway
 * defaults to UTC), so every wall-clock computation must go through here
 * rather than through bare `Date` methods, which use the process's local TZ.
 */
export const BUSINESS_TIMEZONE = 'America/New_York';

/** `YYYY-MM-DD` for `date` as seen in `timeZone`, not the process's local TZ. */
export function zonedDateParam(date: Date, timeZone: string = BUSINESS_TIMEZONE): string {
  return date.toLocaleDateString('en-CA', { timeZone });
}

interface YMD {
  year: number;
  month: number; // 1-12
  day: number;
}

function parseDateParam(dateParam: string): YMD {
  const [year, month, day] = dateParam.split('-').map(Number);
  return { year: year as number, month: month as number, day: day as number };
}

/** Calendar-day arithmetic, DST-safe because it never touches wall-clock hours. */
export function shiftDateParam(dateParam: string, deltaDays: number): string {
  const { year, month, day } = parseDateParam(dateParam);
  const d = new Date(Date.UTC(year, month - 1, day));
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/**
 * The UTC instant of a given wall-clock hour/minute on `dateParam`, as read
 * in `timeZone`. Standard offset-guess-and-correct: construct the instant as
 * if it were UTC, see how that instant actually reads in the target zone,
 * and shift by the difference. One correction is exact except across a DST
 * transition minute itself, which doesn't occur at Summit Air's on-the-hour
 * slot boundaries.
 */
export function zonedWallTimeToUtc(
  dateParam: string,
  hour: number,
  minute = 0,
  timeZone: string = BUSINESS_TIMEZONE,
): Date {
  const { year, month, day } = parseDateParam(dateParam);
  const guess = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));
  const offsetMs = tzOffsetMs(guess, timeZone);
  return new Date(guess.getTime() - offsetMs);
}

/** How far `timeZone`'s reading of `date` is ahead of true UTC, in ms. */
function tzOffsetMs(date: Date, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = Object.fromEntries(
    dtf.formatToParts(date).map((p) => [p.type, p.value]),
  ) as Record<string, string>;
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return asUtc - date.getTime();
}

/** Start (inclusive) / end (exclusive) instants of a calendar day in `timeZone`. */
export function zonedDayBounds(
  dateParam: string,
  timeZone: string = BUSINESS_TIMEZONE,
): { start: Date; end: Date } {
  const start = zonedWallTimeToUtc(dateParam, 0, 0, timeZone);
  const end = zonedWallTimeToUtc(shiftDateParam(dateParam, 1), 0, 0, timeZone);
  return { start, end };
}
