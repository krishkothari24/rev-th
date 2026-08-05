import { Fragment, useMemo } from 'react';
import type { DashboardAppointment, DashboardTechnician } from '../types/api';
import { formatDayLabel, shiftDateParam, todayDateParam } from '../lib/format';
import { SLOT_START_HOURS } from '../lib/schedule';
import { CapacityMeter } from './CapacityMeter';
import { AppointmentCard } from './AppointmentCard';

interface DispatchBoardProps {
  date: string;
  technicians: DashboardTechnician[];
  appointments: DashboardAppointment[];
  highlightAppointmentId: string | null;
  onDateChange: (date: string) => void;
}

function slotKey(technicianId: string, hour: number): string {
  return `${technicianId}-${hour}`;
}

function slotHourLabel(hour: number): string {
  const h = hour % 12 === 0 ? 12 : hour % 12;
  return `${h}${hour < 12 ? 'a' : 'p'}`;
}

/**
 * BUILD_GUIDE §6: "technicians as columns, today's timeline as rows,
 * appointment cards in place, capacity per tech." Auto-navigates to whatever
 * date a new booking lands on — see App.tsx's handling of
 * `appointment.created` — rather than hard-pinning to today, since the
 * scripted sim demo books at a fixed far-future date on purpose
 * (transports/sim/demoScript.ts) and a today-only board would never show it.
 */
export function DispatchBoard({
  date,
  technicians,
  appointments,
  highlightAppointmentId,
  onDateChange,
}: DispatchBoardProps) {
  const byTechAndHour = useMemo(() => {
    const map = new Map<string, DashboardAppointment>();
    for (const appt of appointments) {
      if (!appt.technicianId) continue;
      const hour = new Date(appt.scheduledStart).getHours();
      map.set(slotKey(appt.technicianId, hour), appt);
    }
    return map;
  }, [appointments]);

  const isToday = date === todayDateParam();

  return (
    <div className="flex h-full flex-col rounded-lg border border-[var(--border)] bg-[var(--surface-1)]">
      <div className="flex items-center gap-2 border-b border-[var(--border)] px-4 py-2.5">
        <h2 className="text-sm font-semibold text-[var(--text-primary)]">Dispatch board</h2>
        <div className="ml-auto flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => onDateChange(shiftDateParam(date, -1))}
            className="rounded border border-[var(--border)] px-2 py-1 text-xs text-[var(--text-secondary)] hover:bg-[var(--surface-page)]"
            aria-label="Previous day"
          >
            ‹
          </button>
          <span className="min-w-[8rem] text-center text-sm text-[var(--text-primary)]">
            {formatDayLabel(date)}
          </span>
          <button
            type="button"
            onClick={() => onDateChange(shiftDateParam(date, 1))}
            className="rounded border border-[var(--border)] px-2 py-1 text-xs text-[var(--text-secondary)] hover:bg-[var(--surface-page)]"
            aria-label="Next day"
          >
            ›
          </button>
          {!isToday && (
            <button
              type="button"
              onClick={() => onDateChange(todayDateParam())}
              className="rounded border border-[var(--border)] px-2 py-1 text-xs text-[var(--text-secondary)] hover:bg-[var(--surface-page)]"
            >
              Today
            </button>
          )}
        </div>
      </div>

      <div className="overflow-auto">
        {technicians.length === 0 ? (
          <p className="p-4 text-sm text-[var(--text-muted)]">No active technicians.</p>
        ) : (
          <div
            className="grid"
            style={{
              gridTemplateColumns: `3.5rem repeat(${technicians.length}, minmax(9.5rem, 1fr))`,
            }}
          >
            <div className="sticky top-0 z-10 border-b border-[var(--gridline)] bg-[var(--surface-1)]" />
            {technicians.map((tech) => (
              <div
                key={tech.id}
                className="sticky top-0 z-10 border-b border-l border-[var(--gridline)] bg-[var(--surface-1)] px-2 py-2"
              >
                <p className="truncate text-xs font-semibold text-[var(--text-primary)]">
                  {tech.name}
                </p>
                <p className="truncate text-[10px] uppercase tracking-wide text-[var(--text-muted)]">
                  {tech.homeCounty}
                </p>
                <div className="mt-1">
                  <CapacityMeter booked={tech.capacity.booked} total={tech.capacity.total} />
                </div>
              </div>
            ))}

            {SLOT_START_HOURS.map((hour) => (
              <Fragment key={hour}>
                <div className="border-b border-[var(--gridline)] px-1 py-2 text-right text-[10px] text-[var(--text-muted)]">
                  {slotHourLabel(hour)}
                </div>
                {technicians.map((tech) => {
                  const appt = byTechAndHour.get(slotKey(tech.id, hour));
                  return (
                    <div
                      key={`${tech.id}-${hour}`}
                      className="border-b border-l border-[var(--gridline)] p-1"
                    >
                      {appt && (
                        <AppointmentCard
                          appointment={appt}
                          highlighted={appt.id === highlightAppointmentId}
                        />
                      )}
                    </div>
                  );
                })}
              </Fragment>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
