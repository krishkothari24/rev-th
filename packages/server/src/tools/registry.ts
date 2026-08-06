/**
 * In-process tool registry — makes concrete the design routes.ts's own
 * docblock already called out: "the voice agent loop... calls the *Service
 * functions in-process for latency, rather than looping back through HTTP".
 * Builds a name -> {schema, service, anthropicTool} map from the five
 * existing tool modules (no changes to any of them) and exposes
 * `dispatchTool`, which does exactly what routes.ts's `handleTool` does —
 * Zod parse -> runTool (idempotency) -> result — so a call arriving here
 * (agent/loop.ts) and a call arriving over HTTP (routes.ts) hit the
 * identical path and share the same tool_invocations idempotency key. There
 * is no second idempotency implementation.
 *
 * `call_id` is deliberately absent from every `anthropicTool.input_schema`
 * below: it is not something the model chooses, it's the conversation's own
 * external id, injected by the caller (agent/loop.ts) before `dispatchTool`
 * ever runs — consistent with "the model proposes, server disposes" for
 * every field the model has no business owning.
 *
 * `anthropicTool` JSON schemas are hand-written rather than generated from
 * the Zod schemas via a codegen dependency: there are only five tools, and
 * each description doubles as prompt-quality guidance for *when* to call the
 * tool (shared/tool-use-concepts.md: "be prescriptive about when to call
 * it") — something a mechanical Zod->JSON-schema conversion wouldn't add.
 * test/tools/registry.test.ts keeps these schemas honest by checking each
 * one's `required` list against a minimal object the paired Zod schema
 * accepts, so the two can't silently drift.
 */
import type { z } from 'zod';
import { runTool } from './runTool.js';
import { customerLookupSchema, customerLookupService } from './customerLookup.js';
import { checkAvailabilitySchema, checkAvailabilityService } from './checkAvailability.js';
import { bookAppointmentSchema, bookAppointmentService } from './bookAppointment.js';
import { flagEmergencySchema, flagEmergencyService } from './flagEmergency.js';
import { transferToHumanSchema, transferToHumanService } from './transferToHuman.js';
import { COUNTIES, SKILLS } from '../domain/constants.js';
import { urgencyEnum } from '../db/schema.js';

export interface AnthropicToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface ToolEntry<
  TArgs extends { call_id: string } = { call_id: string },
  TResult extends Record<string, unknown> = Record<string, unknown>,
> {
  name: string;
  schema: z.ZodType<TArgs, z.ZodTypeDef, unknown>;
  service: (args: TArgs) => Promise<TResult>;
  anthropicTool: AnthropicToolDefinition;
}

// TOOL_ENTRIES is deliberately heterogeneous — five distinct arg shapes — so
// each entry's element type is widened to this common `{call_id}` shape at
// insertion. dispatchTool always reads `schema`/`service` back together off
// a single matched entry (never mixes fields across entries), so the
// widening is safe: TypeScript can't see `schema` and `service` still agree,
// but they do by construction, since `entry()` only ever widens a
// same-TArgs/TResult pair produced by a single object literal.
type AnyToolEntry = ToolEntry<{ call_id: string }, Record<string, unknown>>;

function entry<TArgs extends { call_id: string }, TResult extends Record<string, unknown>>(
  e: ToolEntry<TArgs, TResult>,
): AnyToolEntry {
  return e as unknown as AnyToolEntry;
}

export const TOOL_ENTRIES: readonly AnyToolEntry[] = [
  entry({
    name: 'customer_lookup',
    schema: customerLookupSchema,
    service: customerLookupService,
    anthropicTool: {
      name: 'customer_lookup',
      description:
        "Look up a caller's account by phone number. Call this early in the call when the caller's number is known, to check whether they're an existing customer before asking for information you might already have. Returns {found: false} for an unknown number — that's a normal result, not an error.",
      input_schema: {
        type: 'object',
        properties: {
          phone: {
            type: 'string',
            description: 'Caller phone number, E.164 format, e.g. +17705550100',
          },
        },
        required: ['phone'],
        additionalProperties: false,
      },
    },
  }),
  entry({
    name: 'check_availability',
    schema: checkAvailabilitySchema,
    service: checkAvailabilityService,
    anthropicTool: {
      name: 'check_availability',
      description:
        'Look up open appointment slots for a county and urgency level. Call this once you know the county/area and urgency, before offering the caller any specific time — never invent or guess a time.',
      input_schema: {
        type: 'object',
        properties: {
          county: {
            type: 'string',
            enum: [...COUNTIES],
            description: 'Service county the caller is in',
          },
          urgency: {
            type: 'string',
            enum: [...urgencyEnum.enumValues],
            description: 'Urgency level for this job, based on your triage of the call so far',
          },
          required_skills: {
            type: 'array',
            items: { type: 'string', enum: [...SKILLS] },
            description: 'Technician skills this job requires, if any (e.g. gas, refrigerant_epa)',
          },
        },
        required: ['county', 'urgency'],
        additionalProperties: false,
      },
    },
  }),
  entry({
    name: 'book_appointment',
    schema: bookAppointmentSchema,
    service: bookAppointmentService,
    anthropicTool: {
      name: 'book_appointment',
      description:
        'Book a specific appointment slot once the caller has confirmed a time from check_availability. Requires the dispatcher information collected during intake — never invent any of these fields.',
      input_schema: {
        type: 'object',
        properties: {
          phone: { type: 'string', description: "Caller's callback number, E.164 format" },
          name: { type: 'string', description: "Caller's full name" },
          address_line: { type: 'string', description: 'Street address of the service location' },
          city: { type: 'string', description: 'City of the service location' },
          county: { type: 'string', enum: [...COUNTIES], description: 'Service county' },
          property_type: {
            type: 'string',
            enum: ['residential', 'commercial'],
            description: 'Whether the property is residential or commercial (default residential)',
          },
          urgency: {
            type: 'string',
            enum: [...urgencyEnum.enumValues],
            description: 'Urgency level for this job',
          },
          issue_summary: {
            type: 'string',
            description: "Brief summary of the issue, in the caller's words",
          },
          required_skills: {
            type: 'array',
            items: { type: 'string', enum: [...SKILLS] },
            description: 'Technician skills this job requires, if any',
          },
          scheduled_start: {
            type: 'string',
            description:
              'Start time of the confirmed slot, ISO 8601 with offset (must be one of the times check_availability returned)',
          },
          source_channel: {
            type: 'string',
            enum: ['voice', 'sms'],
            description: 'Channel this booking is being made on',
          },
        },
        required: [
          'phone',
          'name',
          'address_line',
          'city',
          'county',
          'urgency',
          'issue_summary',
          'scheduled_start',
          'source_channel',
        ],
        additionalProperties: false,
      },
    },
  }),
  entry({
    name: 'flag_emergency',
    schema: flagEmergencySchema,
    service: flagEmergencyService,
    anthropicTool: {
      name: 'flag_emergency',
      description:
        'File an emergency with dispatch immediately. Callable with only phone, address, and reason — call it as soon as you have those, even mid-call and even if you never collect anything else. Do not wait until the end of the call.',
      input_schema: {
        type: 'object',
        properties: {
          phone: { type: 'string', description: "Caller's callback number, E.164 format" },
          address: {
            type: 'string',
            description:
              'Service address if known; use "address not yet given" if the caller hasn\'t said it yet',
          },
          reason: {
            type: 'string',
            enum: [
              'gas_smell',
              'no_heat_vulnerable',
              'no_ac_vulnerable',
              'no_heat_general',
              'no_ac_general',
              'other',
            ],
            description: 'Reason for the emergency flag',
          },
          notes: { type: 'string', description: 'Any additional context dispatch should know' },
        },
        required: ['phone', 'address', 'reason'],
        additionalProperties: false,
      },
    },
  }),
  entry({
    name: 'transfer_to_human',
    schema: transferToHumanSchema,
    service: transferToHumanService,
    anthropicTool: {
      name: 'transfer_to_human',
      description:
        "Transfer the call to a human dispatcher. Use this when the caller wants something outside your scope: price negotiation, a complaint about a past visit, a manager, or anything you're not confident handling.",
      input_schema: {
        type: 'object',
        properties: {
          reason: { type: 'string', description: 'Short reason for the transfer' },
        },
        required: ['reason'],
        additionalProperties: false,
      },
    },
  }),
];

export const TOOL_REGISTRY: Readonly<Record<string, AnyToolEntry>> = Object.fromEntries(
  TOOL_ENTRIES.map((e) => [e.name, e]),
);

export function getAnthropicToolDefinitions(): AnthropicToolDefinition[] {
  return TOOL_ENTRIES.map((e) => e.anthropicTool);
}

/**
 * OpenAI Realtime's function-tool shape (IMPLEMENTATION_PLAN Phase 11): flat
 * `{type: 'function', name, description, parameters}` rather than Anthropic's
 * `{name, description, input_schema}`. Same JSON Schema content either way,
 * so this is a mechanical re-shape of `anthropicTool` rather than a second
 * hand-authored copy — there is still exactly one schema per tool, just two
 * wire representations of it. Keeps `test/tools/registry.test.ts`'s existing
 * drift check (against the Zod schemas) covering this shape too, with no
 * second test needed.
 */
export interface OpenAIRealtimeToolDefinition {
  type: 'function';
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export function getOpenAIRealtimeToolDefinitions(): OpenAIRealtimeToolDefinition[] {
  return TOOL_ENTRIES.map((e) => ({
    type: 'function',
    name: e.anthropicTool.name,
    description: e.anthropicTool.description,
    parameters: e.anthropicTool.input_schema,
  }));
}

export type ToolDispatchResult =
  | { ok: true; result: Record<string, unknown> }
  | { ok: false; kind: 'invalid_arguments'; issues: { path: string; message: string }[] }
  | { ok: false; kind: 'unknown_tool'; toolName: string }
  | { ok: false; kind: 'execution_error'; message: string };

/**
 * In-process equivalent of a `POST /tools/:name` request. `rawArgs` must
 * already include `call_id` — the caller (agent/loop.ts) is responsible for
 * injecting it from the conversation's external id before dispatch.
 */
export async function dispatchTool(
  toolName: string,
  rawArgs: unknown,
): Promise<ToolDispatchResult> {
  const found = TOOL_REGISTRY[toolName];
  if (!found) {
    return { ok: false, kind: 'unknown_tool', toolName };
  }

  const parsed = found.schema.safeParse(rawArgs);
  if (!parsed.success) {
    return {
      ok: false,
      kind: 'invalid_arguments',
      issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    };
  }

  try {
    const result = await runTool(found.name, parsed.data, () => found.service(parsed.data));
    return { ok: true, result };
  } catch (err) {
    return {
      ok: false,
      kind: 'execution_error',
      message: err instanceof Error ? err.message : 'unknown error dispatching tool',
    };
  }
}
