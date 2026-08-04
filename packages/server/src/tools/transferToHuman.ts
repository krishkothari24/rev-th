/**
 * transfer_to_human({reason}) — BUILD_GUIDE §4. Logs the reason (via the
 * generic tool_invocations record every tool call gets — see runTool),
 * emits an event for the dashboard, and returns a transfer instruction.
 * Pairs with Retell's native call-transfer action in the voice transport
 * (Phase 8); this tool's job stops at "yes, transfer, here's why."
 */
import { z } from 'zod';
import { eventBus } from '../events/bus.js';
import { callIdSchema } from './common.js';

export const transferToHumanSchema = z
  .object({
    call_id: callIdSchema,
    reason: z.string().trim().min(1).max(300),
  })
  .strict();

export type TransferToHumanArgs = z.infer<typeof transferToHumanSchema>;

export function transferToHumanService(
  args: TransferToHumanArgs,
): Promise<Record<string, unknown>> {
  eventBus.publish({ type: 'transfer.requested', callId: args.call_id, reason: args.reason });
  return Promise.resolve({
    transfer: true,
    message: 'Connecting you with a dispatcher now — one moment.',
  });
}
