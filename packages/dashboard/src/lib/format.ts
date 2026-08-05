const TIME_FMT = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' });
const DAY_FMT = new Intl.DateTimeFormat('en-US', {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
});

function formatDateParam(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Local calendar day, `YYYY-MM-DD` — matches the backend's `resolveBoardDate`
 * (`packages/server/src/dashboard/state.ts`), so "today" always agrees. */
export function toLocalDateParam(iso: string): string {
  return formatDateParam(new Date(iso));
}

export function todayDateParam(): string {
  return formatDateParam(new Date());
}

export function shiftDateParam(dateParam: string, deltaDays: number): string {
  const [y, m, d] = dateParam.split('-').map(Number);
  const dt = new Date(y as number, (m as number) - 1, d as number);
  dt.setDate(dt.getDate() + deltaDays);
  return formatDateParam(dt);
}

/** e.g. "Tue, Aug 5" */
export function formatDayLabel(dateParam: string): string {
  const [y, m, d] = dateParam.split('-').map(Number);
  return DAY_FMT.format(new Date(y as number, (m as number) - 1, d as number));
}

/** e.g. "2:00 PM" */
export function formatClock(iso: string): string {
  return TIME_FMT.format(new Date(iso));
}
