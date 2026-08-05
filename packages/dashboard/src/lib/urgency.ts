/**
 * Status-color mapping — dataviz skill's reserved status palette
 * (good/warning/serious/critical), never reused as a categorical color.
 * `routine` deliberately gets no status color at all (muted ink only): the
 * board should stay calm until something is actually urgent, not paint every
 * card a color.
 */
export interface UrgencyMeta {
  label: string;
  color: string;
}

const URGENCY_META: Record<string, UrgencyMeta> = {
  routine: { label: 'Routine', color: 'var(--text-muted)' },
  priority: { label: 'Priority', color: 'var(--status-warning)' },
  emergency: { label: 'Emergency', color: 'var(--status-critical)' },
};

export function urgencyMeta(urgency: string): UrgencyMeta {
  return URGENCY_META[urgency] ?? { label: urgency, color: 'var(--text-muted)' };
}

const REASON_LABELS: Record<string, string> = {
  gas_smell: 'Gas smell',
  no_heat_vulnerable: 'No heat — vulnerable occupant',
  no_ac_vulnerable: 'No AC — vulnerable occupant',
  no_heat_general: 'No heat',
  no_ac_general: 'No AC',
  other: 'Other emergency',
};

export function humanizeEmergencyReason(reason: string): string {
  return REASON_LABELS[reason] ?? reason.replace(/_/g, ' ');
}
