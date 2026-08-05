import { describe, expect, it } from 'vitest';
import { resolveSeason } from '../../src/domain/season.js';

function dateInMonth(month: number): Date {
  // day 15 avoids any month-boundary/timezone edge case
  return new Date(2026, month, 15);
}

describe('resolveSeason', () => {
  const heatingMonths = [10, 11, 0, 1]; // Nov, Dec, Jan, Feb
  const coolingMonths = [4, 5, 6, 7, 8]; // May-Sep
  const shoulderMonths = [2, 3, 9]; // Mar, Apr, Oct

  it.each(heatingMonths)('month index %i resolves to heating', (month) => {
    expect(resolveSeason(dateInMonth(month))).toBe('heating');
  });

  it.each(coolingMonths)('month index %i resolves to cooling', (month) => {
    expect(resolveSeason(dateInMonth(month))).toBe('cooling');
  });

  it.each(shoulderMonths)('month index %i resolves to shoulder', (month) => {
    expect(resolveSeason(dateInMonth(month))).toBe('shoulder');
  });

  it('defaults to auto (calendar-derived) when no override is given', () => {
    expect(resolveSeason(dateInMonth(0))).toBe('heating');
  });

  it.each(['heating', 'cooling', 'shoulder'] as const)(
    'override %s short-circuits the calendar regardless of month',
    (override) => {
      expect(resolveSeason(dateInMonth(6), override)).toBe(override); // June, would otherwise be cooling
      expect(resolveSeason(dateInMonth(0), override)).toBe(override); // January, would otherwise be heating
    },
  );

  it('override "auto" is equivalent to omitting the override', () => {
    expect(resolveSeason(dateInMonth(6), 'auto')).toBe('cooling');
  });
});
