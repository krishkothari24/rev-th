/**
 * Consumes `sms.queued` off the event bus and actually sends it (BUILD_GUIDE
 * §7 / tools/bookAppointment.ts, tools/flagEmergency.ts: "Queued, not sent —
 * the actual Twilio send is Phase 8"). IMPLEMENTATION_PLAN Phase 8.
 *
 * `dispatcher_alert` targets `config.DISPATCHER_ALERT_NUMBER` (an internal
 * number, resolved here rather than at publish time — the tool layer only
 * knows "this needs a dispatcher alert," not which number that is) and is
 * never DNC-checked, since DNC is a customer's own opt-out of *being texted*,
 * not a block on notifying dispatch about them. `booking_confirmation`/
 * `safety_followup` are customer-facing and always checked against
 * `isDnc(event.to)` first.
 */
import { eventBus, type DashboardEvent } from '../events/bus.js';
import { config } from '../config.js';
import { redactPhone } from '../lib/redact.js';
import { isDnc } from './dnc.js';
import { resolveSmsSender, type SmsSender } from './sender.js';

type SmsQueuedEvent = Extract<DashboardEvent, { type: 'sms.queued' }>;

async function handle(event: SmsQueuedEvent, sender: SmsSender): Promise<void> {
  if (event.kind === 'dispatcher_alert') {
    if (!config.DISPATCHER_ALERT_NUMBER) {
      console.warn('[sms] dispatcher_alert dropped — DISPATCHER_ALERT_NUMBER is not set');
      return;
    }
    await sender.send({ to: config.DISPATCHER_ALERT_NUMBER, body: event.body });
    return;
  }

  if (await isDnc(event.to)) {
    console.log(`[sms] suppressed (${event.kind}) to ${redactPhone(event.to)} — DNC`);
    return;
  }
  await sender.send({ to: event.to, body: event.body });
}

/**
 * Registered once per `buildApp()` call (several existing tests call
 * `buildApp()` more than once per process), torn down via the returned
 * unsubscribe function on `onClose`. Fire-and-forget with a caught
 * rejection — same pattern as `transports/sim/repl.ts`'s dashboard relay — a
 * send failure must never crash the process or block whatever request
 * triggered the `sms.queued` publish.
 */
export function registerSmsOutboundSubscriber(sender: SmsSender = resolveSmsSender()): () => void {
  return eventBus.subscribe((event) => {
    if (event.type !== 'sms.queued') return;
    void handle(event, sender).catch((err: unknown) => {
      console.error('[sms] outbound send failed:', err);
    });
  });
}
