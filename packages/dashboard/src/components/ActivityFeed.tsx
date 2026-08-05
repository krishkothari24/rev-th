import type { DashboardActivityItem } from '../types/api';
import { formatClock } from '../lib/format';

interface ActivityFeedProps {
  activity: DashboardActivityItem[];
}

/** BUILD_GUIDE §6: "tool invocations as they happen, human-readable." Each
 * line is the pre-rendered `summary` the backend's
 * `events/activityFormat.ts` produces — this component only lays it out. */
export function ActivityFeed({ activity }: ActivityFeedProps) {
  return (
    <div className="flex h-full flex-col rounded-lg border border-[var(--border)] bg-[var(--surface-1)]">
      <div className="border-b border-[var(--border)] px-4 py-2.5">
        <h2 className="text-sm font-semibold text-[var(--text-primary)]">Activity</h2>
      </div>
      <div className="flex-1 overflow-auto">
        {activity.length === 0 && (
          <p className="p-4 text-sm text-[var(--text-muted)]">No activity yet.</p>
        )}
        <ul>
          {activity.map((item) => (
            <li
              key={item.id}
              className="border-b border-[var(--gridline)] px-4 py-2 text-sm last:border-b-0"
            >
              <div className="flex items-baseline gap-2">
                <span className="text-xs text-[var(--text-muted)]">
                  {formatClock(item.createdAt)}
                </span>
                {item.isError && (
                  <span className="text-xs font-medium" style={{ color: 'var(--status-serious)' }}>
                    error
                  </span>
                )}
              </div>
              <p className="text-[var(--text-primary)]">{item.summary}</p>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
