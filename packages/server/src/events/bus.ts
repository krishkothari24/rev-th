/**
 * In-process event bus. Tool handlers publish here as their last step
 * (BUILD_GUIDE §4: "emit an SSE dashboard event"); `events/sse.ts` fans
 * these out to the dashboard over `/events` (IMPLEMENTATION_PLAN Phase 7).
 *
 * `call.*`/`triage.updated`/`tool.invoked`/`emergency.acknowledged` are
 * Phase 7 additions on top of the four tool-layer business events that
 * existed before it — added here, not in a second bus, so the dashboard has
 * one channel to subscribe to. `tool.invoked` is generic (published once by
 * `tools/runTool.ts` for every tool, on fresh execution only — never on an
 * idempotency replay) rather than each tool hand-rolling its own; the
 * activity feed and the live-call banner's "recognized caller" fill-in both
 * key off it instead of adding a dedicated event per concern.
 *
 * Payloads here carry PII (phone numbers, addresses) by design — the same
 * data the dashboard needs to show a live call banner. Anything that logs
 * these events to stdout later must redact via `lib/redact.ts` first; the
 * bus itself does not, and the SSE fan-out doesn't either — the dashboard is
 * a trusted internal ops view, not a log stream (see BUILD_GUIDE §8.5 on the
 * demo's no-auth scope).
 */
import { EventEmitter } from 'node:events';
import { z } from 'zod';

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
    }
  | { type: 'call.started'; callId: string; channel: 'voice' | 'sms'; callerPhone: string }
  | { type: 'call.ended'; callId: string; outcome: string | null }
  | { type: 'triage.updated'; callId: string; urgency: string; requiredSkills: string[] }
  | { type: 'tool.invoked'; callId: string; toolName: string; summary: string; isError: boolean }
  | { type: 'emergency.acknowledged'; emergencyId: string; acknowledgedAt: string };

/**
 * Structural mirror of `DashboardEvent`, kept in sync by hand (same
 * trade-off as the dashboard frontend's `types/api.ts`). Only real consumer
 * today is `events/relay.ts` — the local-only bridge that lets `npm run sim`
 * (a separate OS process with its own in-memory bus, see that file's
 * docblock for why) publish onto *this* process's bus so its events reach
 * connected dashboard clients.
 */
export const dashboardEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('appointment.created'),
    appointmentId: z.string(),
    customerId: z.string(),
    technicianId: z.string(),
    technicianName: z.string(),
    scheduledStart: z.string(),
    urgency: z.string(),
  }),
  z.object({
    type: z.literal('emergency.flagged'),
    emergencyId: z.string(),
    callId: z.string(),
    reason: z.string(),
    customerId: z.string().nullable(),
  }),
  z.object({ type: z.literal('transfer.requested'), callId: z.string(), reason: z.string() }),
  z.object({
    type: z.literal('sms.queued'),
    kind: z.enum(['booking_confirmation', 'dispatcher_alert', 'safety_followup']),
    to: z.string(),
    body: z.string(),
  }),
  z.object({
    type: z.literal('call.started'),
    callId: z.string(),
    channel: z.enum(['voice', 'sms']),
    callerPhone: z.string(),
  }),
  z.object({
    type: z.literal('call.ended'),
    callId: z.string(),
    outcome: z.string().nullable(),
  }),
  z.object({
    type: z.literal('triage.updated'),
    callId: z.string(),
    urgency: z.string(),
    requiredSkills: z.array(z.string()),
  }),
  z.object({
    type: z.literal('tool.invoked'),
    callId: z.string(),
    toolName: z.string(),
    summary: z.string(),
    isError: z.boolean(),
  }),
  z.object({
    type: z.literal('emergency.acknowledged'),
    emergencyId: z.string(),
    acknowledgedAt: z.string(),
  }),
]);

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
