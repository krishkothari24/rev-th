import type { DashboardAppointment } from '../types/api';
import { urgencyMeta } from '../lib/urgency';

interface AppointmentCardProps {
  appointment: DashboardAppointment;
  highlighted: boolean;
}

export function AppointmentCard({ appointment, highlighted }: AppointmentCardProps) {
  const meta = urgencyMeta(appointment.urgency);

  return (
    <div
      className={
        'rounded-md border-l-4 bg-[var(--surface-1)] px-2 py-1.5 text-xs shadow-sm transition-shadow duration-500' +
        (highlighted ? ' ring-2 ring-[var(--sequential-fill)] ring-offset-1' : '')
      }
      style={{ borderLeftColor: meta.color }}
    >
      <p className="truncate font-medium text-[var(--text-primary)]">{appointment.customerName}</p>
      <p className="truncate text-[var(--text-secondary)]">{appointment.issueSummary}</p>
    </div>
  );
}
