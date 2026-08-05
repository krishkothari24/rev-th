/** Client-only view state — not part of the backend wire contract. */
export interface LiveCallInfo {
  callId: string;
  channel: 'voice' | 'sms';
  callerPhone: string;
  /** Filled in once a `tool.invoked` event for this call's `customer_lookup`
   * lands — the tool's own pre-rendered summary line, shown as-is (never
   * parsed apart client-side; see events/activityFormat.ts on the backend). */
  recognitionLine: string | null;
  urgency: string | null;
  requiredSkills: string[];
}
