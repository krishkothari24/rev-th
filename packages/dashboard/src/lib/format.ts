/**
 * All times displayed on the board are Summit Air's own timezone (GA), not
 * the viewing browser's — an evaluator pulling up the dashboard from a
 * different timezone must see the same slot the caller heard on the phone.
 * Mirrors `packages/server/src/lib/timezone.ts`.
 */
const BUSINESS_TIMEZONE = 'America/New_York';

const TIME_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: BUSINESS_TIMEZONE,
  hour: 'numeric',
  minute: '2-digit',
});
const DAY_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: BUSINESS_TIMEZONE,
  weekday: 'short',
  month: 'short',
  day: 'numeric',
});

function formatDateParam(d: Date): string {
  return d.toLocaleDateString('en-CA', { timeZone: BUSINESS_TIMEZONE });
}

/** Business-timezone calendar day, `YYYY-MM-DD` — matches the backend's
 * `resolveBoardDate` (`packages/server/src/dashboard/state.ts`), so "today"
 * always agrees regardless of which timezone either side happens to run in. */
export function toLocalDateParam(iso: string): string {
  return formatDateParam(new Date(iso));
}

export function todayDateParam(): string {
  return formatDateParam(new Date());
}

export function shiftDateParam(dateParam: string, deltaDays: number): string {
  const [y, m, d] = dateParam.split('-').map(Number);
  // UTC-anchored calendar math — deltaDays never touches wall-clock hours,
  // so this stays correct across a DST boundary too.
  const dt = new Date(Date.UTC(y as number, (m as number) - 1, d as number));
  dt.setUTCDate(dt.getUTCDate() + deltaDays);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

/** e.g. "Tue, Aug 5" */
export function formatDayLabel(dateParam: string): string {
  const [y, m, d] = dateParam.split('-').map(Number);
  return DAY_FMT.format(new Date(Date.UTC(y as number, (m as number) - 1, d as number, 12)));
}

/** e.g. "2:00 PM" */
export function formatClock(iso: string): string {
  return TIME_FMT.format(new Date(iso));
}
