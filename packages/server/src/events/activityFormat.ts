/**
 * Renders a tool call into one short, human-readable line for the dashboard
 * activity feed — the same "speakable, not a JSON dump" principle
 * BUILD_GUIDE §4 applies to tool results, applied here to the feed instead
 * of the model's ear. Lives in `events/` (not `tools/`) because its only
 * caller is the dashboard fan-out (`tools/runTool.ts`'s `tool.invoked`
 * publish, `dashboard/state.ts`'s activity backfill) — it has no bearing on
 * what a tool returns to the agent loop.
 *
 * Reuses each service's own pre-rendered `summary`/`note` fields where they
 * exist (`customer_lookup`, `book_appointment`, `check_availability` already
 * produce a speakable string for the model) instead of re-deriving one, so
 * there is exactly one place per tool that decides how to phrase its outcome
 * in English.
 */
type ToolArgs = Record<string, unknown>;
type ToolResult = Record<string, unknown>;

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function describeCustomerLookup(_args: ToolArgs, result: ToolResult): string {
  if (result.found === true) {
    return `Recognized: ${str(result.summary) ?? 'existing customer.'}`;
  }
  return 'New caller — no existing account found.';
}

function describeCheckAvailability(args: ToolArgs, result: ToolResult): string {
  const slots = Array.isArray(result.slots) ? result.slots : [];
  const county = str(args.county) ?? 'the requested county';
  if (slots.length === 0) {
    return str(result.note) ?? `No availability found in ${county}.`;
  }
  return `Checked availability in ${county} — ${slots.length} slot${slots.length === 1 ? '' : 's'} open.`;
}

function describeBookAppointment(args: ToolArgs, result: ToolResult): string {
  const name = str(args.name) ?? 'Caller';
  if (result.booked === true) {
    return `${name}: ${str(result.summary) ?? 'booked.'}`;
  }
  return `${name}: ${str(result.note) ?? 'booking did not complete.'}`;
}

function describeFlagEmergency(args: ToolArgs, result: ToolResult): string {
  if (result.flagged !== true) {
    return `Emergency flag failed for ${str(args.reason) ?? 'unspecified reason'}.`;
  }
  if (result.already_flagged === true) {
    return 'Emergency already flagged on this call.';
  }
  const reason = str(args.reason) ?? 'unspecified reason';
  const address = str(args.address) ?? 'address not yet given';
  return `Emergency flagged (${reason}) — ${address}.`;
}

function describeTransferToHuman(args: ToolArgs): string {
  return `Transfer requested — ${str(args.reason) ?? 'no reason given'}.`;
}

/** Falls back to a bare tool name for any future tool this isn't updated for. */
export function describeToolInvocation(
  toolName: string,
  args: ToolArgs,
  result: ToolResult,
): string {
  switch (toolName) {
    case 'customer_lookup':
      return describeCustomerLookup(args, result);
    case 'check_availability':
      return describeCheckAvailability(args, result);
    case 'book_appointment':
      return describeBookAppointment(args, result);
    case 'flag_emergency':
      return describeFlagEmergency(args, result);
    case 'transfer_to_human':
      return describeTransferToHuman(args);
    default:
      return `${toolName} called.`;
  }
}
