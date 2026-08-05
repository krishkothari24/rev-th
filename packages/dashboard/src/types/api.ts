/**
 * Mirrors the backend's wire contract — `packages/server/src/events/bus.ts`
 * (`DashboardEvent`) and `packages/server/src/dashboard/state.ts`
 * (`DashboardState`). No shared-types package between the two workspaces at
 * this scope (one extra build target for two files isn't worth it yet); if
 * the two ever drift, it'll show up as a runtime shape mismatch, not a type
 * error — keep this file's shapes in sync by hand when the backend's change.
 */

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

export interface DashboardTechnician {
  id: string;
  name: string;
  homeCounty: string;
  skills: string[];
  capacity: { booked: number; total: number };
}

export interface DashboardAppointment {
  id: string;
  customerId: string;
  customerName: string;
  technicianId: string | null;
  scheduledStart: string;
  scheduledEnd: string;
  urgency: string;
  issueSummary: string;
  status: string;
}

export interface DashboardEmergency {
  id: string;
  callId: string;
  reason: string;
  addressSnapshot: string | null;
  phoneSnapshot: string | null;
  notes: string | null;
  acknowledgedAt: string | null;
  createdAt: string;
}

export interface DashboardActivityItem {
  id: string;
  callId: string | null;
  toolName: string;
  summary: string;
  createdAt: string;
  /** Only ever set on a live `tool.invoked` SSE event for an executor that
   * threw — a failed call never reaches `tool_invocations`, so this is
   * always absent on items that came from the `/dashboard/state` snapshot. */
  isError?: boolean;
}

export interface DashboardState {
  date: string;
  technicians: DashboardTechnician[];
  appointments: DashboardAppointment[];
  emergencies: DashboardEmergency[];
  activity: DashboardActivityItem[];
}
