import type { LiveCallInfo } from '../types/ui';
import { urgencyMeta } from '../lib/urgency';

interface LiveCallBannerProps {
  call: LiveCallInfo | null;
}

/**
 * BUILD_GUIDE §6: "appears on call.started, shows caller name if recognized,
 * live triage state as it resolves." Always occupies its slot (a calm empty
 * state when idle, not a banner that pops in/out) so the layout doesn't jump
 * mid-demo.
 */
export function LiveCallBanner({ call }: LiveCallBannerProps) {
  if (!call) {
    return (
      <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-1)] px-4 py-3 text-sm text-[var(--text-muted)]">
        No active call.
      </div>
    );
  }

  const urgency = call.urgency ? urgencyMeta(call.urgency) : null;

  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-1)] px-4 py-3">
      <div className="flex items-center gap-3">
        <span
          className="h-2.5 w-2.5 shrink-0 rounded-full bg-[var(--status-good)]"
          aria-hidden="true"
        />
        <span className="text-sm font-semibold text-[var(--text-primary)]">Live call</span>
        <span className="rounded border border-[var(--border)] px-1.5 py-0.5 text-xs uppercase tracking-wide text-[var(--text-secondary)]">
          {call.channel}
        </span>
        <span className="font-mono text-sm text-[var(--text-secondary)]">{call.callerPhone}</span>
        {urgency && (
          <span
            className="ml-auto flex items-center gap-1.5 text-xs font-medium"
            style={{ color: urgency.color }}
          >
            <span
              className="h-2 w-2 rounded-full"
              style={{ background: urgency.color }}
              aria-hidden="true"
            />
            {urgency.label}
          </span>
        )}
      </div>
      <p className="mt-1.5 text-sm text-[var(--text-secondary)]">
        {call.recognitionLine ?? 'Looking up caller…'}
      </p>
    </div>
  );
}
