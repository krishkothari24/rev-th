/**
 * In-process event bus. Tool handlers publish here as their last step
 * (BUILD_GUIDE §4: "emit an SSE dashboard event"); the SSE transport that
 * fans these out to the dashboard over `/events` is Phase 6 (IMPLEMENTATION_PLAN
 * §7). Publishing now, with no subscriber yet, keeps the tool layer's side
 * effects complete today and means Phase 6 is wiring, not rework.
 *
 * Payloads here carry PII (phone numbers, addresses) by design — the same
 * data the dashboard needs to show a live call banner. Anything that logs
 * these events to stdout later must redact via `lib/redact.ts` first; the
 * bus itself does not.
 */
import { EventEmitter } from 'node:events';

export type DashboardEvent =
  | {
      type: 'appointment.created';
      appointmentId: string;
      customerId: string;
      technicianId: string;
      technicianName: string;
      scheduledStart: string;
      urgency: string;
    }
  | {
      type: 'emergency.flagged';
      emergencyId: string;
      callId: string;
      reason: string;
      customerId: string | null;
    }
  | { type: 'transfer.requested'; callId: string; reason: string }
  | {
      type: 'sms.queued';
      kind: 'booking_confirmation' | 'dispatcher_alert' | 'safety_followup';
      to: string;
      body: string;
    };

class EventBus extends EventEmitter {
  publish(event: DashboardEvent): void {
    this.emit('event', event);
  }

  /** Returns an unsubscribe function. */
  subscribe(listener: (event: DashboardEvent) => void): () => void {
    this.on('event', listener);
    return () => this.off('event', listener);
  }
}

export const eventBus = new EventBus();
