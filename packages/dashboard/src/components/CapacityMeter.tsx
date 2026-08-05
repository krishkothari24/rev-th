interface CapacityMeterProps {
  booked: number;
  total: number;
}

/**
 * dataviz skill: figures § "Meter" — fill carries magnitude (sequential
 * blue, not a status color; a full schedule isn't bad news), unfilled track
 * is a wash of the same hue so state reads across the whole bar. Value text
 * uses tabular figures — this repeats once per technician column, so digits
 * must align down the row.
 */
export function CapacityMeter({ booked, total }: CapacityMeterProps) {
  const pct = total > 0 ? Math.min(100, Math.round((booked / total) * 100)) : 0;

  return (
    <div className="flex items-center gap-1.5" title={`${booked} of ${total} slots booked today`}>
      <div
        className="h-1.5 w-10 shrink-0 overflow-hidden rounded-full"
        style={{ background: 'var(--sequential-track)' }}
      >
        <div
          className="h-full rounded-full"
          style={{ width: `${pct}%`, background: 'var(--sequential-fill)' }}
        />
      </div>
      <span
        className="text-xs text-[var(--text-secondary)]"
        style={{ fontVariantNumeric: 'tabular-nums' }}
      >
        {booked}/{total}
      </span>
    </div>
  );
}
