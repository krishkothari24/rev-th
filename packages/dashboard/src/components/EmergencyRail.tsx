import type { DashboardEmergency } from '../types/api';
import { formatClock } from '../lib/format';
import { humanizeEmergencyReason } from '../lib/urgency';

interface EmergencyRailProps {
  emergencies: DashboardEmergency[];
  onAcknowledge: (id: string) => void;
  acknowledging: Set<string>;
}

/**
 * BUILD_GUIDE §6: "flagged items, unmistakably styled, with acknowledge
 * button, newest first." Unmistakable = the one place on the board that
 * uses the critical status color as a filled surface, not just an accent —
 * everything else on the dashboard stays deliberately calm so this reads as
 * the exception.
 */
export function EmergencyRail({ emergencies, onAcknowledge, acknowledging }: EmergencyRailProps) {
  return (
    <div className="flex h-full flex-col rounded-lg border border-[var(--border)] bg-[var(--surface-1)]">
      <div className="border-b border-[var(--border)] px-4 py-2.5">
        <h2 className="text-sm font-semibold text-[var(--text-primary)]">Emergencies</h2>
      </div>
      <div className="flex-1 space-y-2 overflow-auto p-2">
        {emergencies.length === 0 && (
          <p className="p-2 text-sm text-[var(--text-muted)]">No emergencies flagged.</p>
        )}
        {emergencies.map((e) => {
          const acknowledged = Boolean(e.acknowledgedAt);
          return (
            <div
              key={e.id}
              className="rounded-md border px-3 py-2 text-sm"
              style={
                acknowledged
                  ? { borderColor: 'var(--border)', opacity: 0.65 }
                  : {
                      borderColor: 'var(--status-critical)',
                      background:
                        'color-mix(in srgb, var(--status-critical) 10%, var(--surface-1))',
                    }
              }
            >
              <div className="flex items-center gap-1.5">
                <span
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ background: 'var(--status-critical)' }}
                  aria-hidden="true"
                />
                <span className="font-medium text-[var(--text-primary)]">
                  {humanizeEmergencyReason(e.reason)}
                </span>
                <span className="ml-auto text-xs text-[var(--text-muted)]">
                  {formatClock(e.createdAt)}
                </span>
              </div>
              {e.addressSnapshot && (
                <p className="mt-1 text-xs text-[var(--text-secondary)]">{e.addressSnapshot}</p>
              )}
              {e.phoneSnapshot && (
                <p className="font-mono text-xs text-[var(--text-secondary)]">{e.phoneSnapshot}</p>
              )}
              <button
                type="button"
                disabled={acknowledged || acknowledging.has(e.id)}
                onClick={() => onAcknowledge(e.id)}
                className="mt-2 rounded border border-[var(--border)] px-2 py-1 text-xs font-medium text-[var(--text-primary)] hover:bg-[var(--surface-page)] disabled:cursor-default disabled:opacity-60"
              >
                {acknowledged ? 'Acknowledged' : 'Acknowledge'}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
