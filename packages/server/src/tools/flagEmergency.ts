/**
 * flag_emergency({...}) — BUILD_GUIDE §4. Callable with partial information
 * (phone + address + reason only) on purpose: in a real gas-leak call you
 * may never get anything past that. Writes emergency_flags, emits
 * `emergency.flagged`, queues the dispatcher alert immediately.
 *
 * One flag per call is enforced twice, deliberately: the idempotency wrapper
 * (runTool) catches an exact retry, and the unique index on
 * `emergency_flags.call_id` catches a *second, different* flag attempt on
 * the same call — the actual §8.3 server-side cap, not just retry-safety.
 */
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { customers, emergencyFlags } from '../db/schema.js';
import { eventBus } from '../events/bus.js';
import { isUniqueViolation } from '../lib/pgErrors.js';
import { callIdSchema, emergencyReasonSchema, phoneSchema } from './common.js';

export const flagEmergencySchema = z
  .object({
    call_id: callIdSchema,
    phone: phoneSchema,
    address: z.string().trim().min(1).max(200),
    reason: emergencyReasonSchema,
    notes: z.string().trim().max(1000).optional(),
  })
  .strict();

export type FlagEmergencyArgs = z.infer<typeof flagEmergencySchema>;

export async function flagEmergencyService(
  args: FlagEmergencyArgs,
): Promise<Record<string, unknown>> {
  const [existingCustomer] = await db
    .select({ id: customers.id })
    .from(customers)
    .where(eq(customers.phone, args.phone))
    .limit(1);
  const customerId = existingCustomer?.id ?? null;

  try {
    const [flag] = await db
      .insert(emergencyFlags)
      .values({
        customerId,
        callId: args.call_id,
        reason: args.reason,
        addressSnapshot: args.address,
        phoneSnapshot: args.phone,
        notes: args.notes ?? null,
      })
      .returning();
    if (!flag) throw new Error('emergency flag insert returned no row');

    eventBus.publish({
      type: 'emergency.flagged',
      emergencyId: flag.id,
      callId: args.call_id,
      reason: args.reason,
      customerId,
    });
    eventBus.publish({
      type: 'sms.queued',
      kind: 'dispatcher_alert',
      to: '(dispatcher)', // resolved from DISPATCHER_ALERT_NUMBER at send time (Phase 8)
      body: `EMERGENCY (${args.reason}): ${args.address || 'address not yet given'} — ${args.phone}.`,
    });

    return {
      flagged: true,
      emergency_id: flag.id,
      message: 'Emergency logged — dispatch has been notified immediately.',
    };
  } catch (err) {
    if (isUniqueViolation(err, 'emergency_flags_call_idx')) {
      const [already] = await db
        .select()
        .from(emergencyFlags)
        .where(eq(emergencyFlags.callId, args.call_id))
        .limit(1);
      return {
        flagged: true,
        emergency_id: already?.id ?? null,
        already_flagged: true,
        message: 'This call is already flagged as an emergency — dispatch has been notified.',
      };
    }
    throw err;
  }
}
