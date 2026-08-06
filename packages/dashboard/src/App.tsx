import { useCallback, useEffect, useRef, useState } from 'react';
import type { DashboardEvent, DashboardState } from './types/api';
import type { LiveCallInfo } from './types/ui';
import { acknowledgeEmergency, fetchDashboardState } from './lib/api';
import { toLocalDateParam } from './lib/format';
import { useEventStream, type ConnectionStatus } from './hooks/useEventStream';
import { LiveCallBanner } from './components/LiveCallBanner';
import { DispatchBoard } from './components/DispatchBoard';
import { EmergencyRail } from './components/EmergencyRail';
import { ActivityFeed } from './components/ActivityFeed';
import { SimPanel } from './components/SimPanel';

const HIGHLIGHT_MS = 3000;
const ACTIVITY_LIMIT = 50;

const CONNECTION_LABEL: Record<ConnectionStatus, string> = {
  connecting: 'Connecting…',
  open: 'Live',
  reconnecting: 'Reconnecting…',
};

const CONNECTION_COLOR: Record<ConnectionStatus, string> = {
  connecting: 'var(--text-muted)',
  open: 'var(--status-good)',
  reconnecting: 'var(--status-warning)',
};

export function App() {
  const [board, setBoard] = useState<DashboardState | null>(null);
  const [viewedDate, setViewedDate] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [liveCall, setLiveCall] = useState<LiveCallInfo | null>(null);
  const [highlightAppointmentId, setHighlightAppointmentId] = useState<string | null>(null);
  const [acknowledging, setAcknowledging] = useState<Set<string>>(new Set());

  // Read inside the SSE handlers below without re-subscribing the stream —
  // see useEventStream's own comment on why onEvent is captured in a ref.
  const viewedDateRef = useRef<string | null>(null);
  viewedDateRef.current = viewedDate;

  const refresh = useCallback(async (date?: string) => {
    try {
      const state = await fetchDashboardState(date);
      setBoard(state);
      setViewedDate(state.date);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load dashboard state.');
    }
  }, []);

  const handleEvent = useCallback(
    (event: DashboardEvent) => {
      switch (event.type) {
        case 'call.started':
          setLiveCall({
            callId: event.callId,
            channel: event.channel,
            callerPhone: event.callerPhone,
            recognitionLine: null,
            urgency: null,
            requiredSkills: [],
          });
          return;
        case 'call.ended':
          setLiveCall((prev) => (prev?.callId === event.callId ? null : prev));
          return;
        case 'triage.updated':
          setLiveCall((prev) =>
            prev?.callId === event.callId
              ? { ...prev, urgency: event.urgency, requiredSkills: event.requiredSkills }
              : prev,
          );
          return;
        case 'tool.invoked':
          setBoard((prev) => {
            if (!prev) return prev;
            const item = {
              id: crypto.randomUUID(),
              callId: event.callId,
              toolName: event.toolName,
              summary: event.summary,
              createdAt: new Date().toISOString(),
              isError: event.isError,
            };
            return { ...prev, activity: [item, ...prev.activity].slice(0, ACTIVITY_LIMIT) };
          });
          if (event.toolName === 'customer_lookup') {
            setLiveCall((prev) =>
              prev?.callId === event.callId ? { ...prev, recognitionLine: event.summary } : prev,
            );
          }
          return;
        case 'appointment.created':
          setHighlightAppointmentId(event.appointmentId);
          // Also re-navigates the board to this date — the fix for the
          // scripted sim demo's fixed far-future booking date (see
          // DispatchBoard.tsx's docblock).
          void refresh(toLocalDateParam(event.scheduledStart));
          return;
        case 'emergency.flagged':
        case 'emergency.acknowledged':
          // Emergencies aren't date-scoped on the backend; refresh whatever
          // day is currently on screen rather than changing it.
          void refresh(viewedDateRef.current ?? undefined);
          return;
        case 'transfer.requested':
        case 'sms.queued':
          // Not rendered anywhere in this layout — transfer_to_human already
          // shows up via its own tool.invoked activity line.
          return;
      }
    },
    [refresh],
  );

  const handleOpen = useCallback(() => {
    void refresh(viewedDateRef.current ?? undefined);
  }, [refresh]);

  const connectionStatus = useEventStream(handleEvent, handleOpen);

  useEffect(() => {
    if (!highlightAppointmentId) return;
    const timer = setTimeout(() => setHighlightAppointmentId(null), HIGHLIGHT_MS);
    return () => clearTimeout(timer);
  }, [highlightAppointmentId]);

  const handleDateChange = useCallback(
    (date: string) => {
      void refresh(date);
    },
    [refresh],
  );

  const handleAcknowledge = useCallback((id: string) => {
    setAcknowledging((prev) => new Set(prev).add(id));
    acknowledgeEmergency(id)
      .catch((err: unknown) => {
        console.error('Failed to acknowledge emergency', err);
      })
      .finally(() => {
        setAcknowledging((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      });
  }, []);

  return (
    <div className="flex h-screen flex-col gap-4 p-4">
      <header className="flex items-center gap-3">
        <h1 className="text-lg font-semibold text-[var(--text-primary)]">Summit Air — Dispatch</h1>
        <span
          className="flex items-center gap-1.5 text-xs text-[var(--text-secondary)]"
          aria-live="polite"
        >
          <span
            className="h-1.5 w-1.5 rounded-full"
            style={{ background: CONNECTION_COLOR[connectionStatus] }}
            aria-hidden="true"
          />
          {CONNECTION_LABEL[connectionStatus]}
        </span>
        <div className="ml-auto">
          <SimPanel />
        </div>
      </header>

      {error && (
        <div
          className="rounded-md border px-3 py-2 text-sm"
          style={{ borderColor: 'var(--status-serious)', color: 'var(--text-primary)' }}
        >
          {error}
        </div>
      )}

      <LiveCallBanner call={liveCall} />

      {!board ? (
        <p className="text-sm text-[var(--text-muted)]">Loading dispatch board…</p>
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-[1fr_20rem] gap-4">
          <div className="min-h-0 min-w-0">
            <DispatchBoard
              date={viewedDate ?? board.date}
              technicians={board.technicians}
              appointments={board.appointments}
              highlightAppointmentId={highlightAppointmentId}
              onDateChange={handleDateChange}
            />
          </div>
          <div className="flex min-h-0 flex-col gap-4">
            <div className="max-h-[45%] min-h-0">
              <EmergencyRail
                emergencies={board.emergencies}
                onAcknowledge={handleAcknowledge}
                acknowledging={acknowledging}
              />
            </div>
            <div className="min-h-0 flex-1">
              <ActivityFeed activity={board.activity} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
