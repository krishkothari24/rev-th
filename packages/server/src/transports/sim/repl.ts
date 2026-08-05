/**
 * Text REPL over the exact conversation loop that will answer real calls
 * once Retell lands (Phase 8) — BUILD_GUIDE §10: "almost all logic
 * iteration happens here," no telephony, no minutes burned.
 *
 * Defaults to `ScriptedProvider` replaying `routineBookingDemoScript` ($0) —
 * this is a **wiring smoke test** (loop -> tools -> DB -> event bus), not a
 * conversation: a step-indexed script has no way to understand free text,
 * so it recites the canned script regardless of what you type. `--live`
 * (with `ANTHROPIC_API_KEY` set) switches to `AnthropicProvider` for the
 * real interactive demo.
 *
 * All input is read through one `readline` async-iterator loop (never mixed
 * with `.question()`, which conflicts with it and silently drops lines) —
 * the first line is treated as the caller's phone number, every line after
 * that is a caller turn.
 *
 * Also best-effort relays its own dashboard events to a `npm run dev` server
 * if one happens to be running (`relayDashboardEvent` -> events/relay.ts) —
 * this process's `eventBus` is its own in-memory instance, separate from the
 * server's, so that's the only way a sim booking lands on the dashboard live
 * (IMPLEMENTATION_PLAN Phase 7's own done-when criterion) rather than only
 * on the next manual refresh.
 */
import readline from 'node:readline';
import { config, requireEnv } from '../../config.js';
import { phoneSchema } from '../../tools/common.js';
import { finalizeConversation, startConversation } from '../../agent/context.js';
import { runTurn } from '../../agent/loop.js';
import { ScriptedProvider } from '../../agent/providers/scripted.js';
import { AnthropicProvider } from '../../agent/providers/anthropic.js';
import { routineBookingDemoScript } from './demoScript.js';
import { eventBus, type DashboardEvent } from '../../events/bus.js';
import { redactAddress, redactPhone, scrubFreeText } from '../../lib/redact.js';
import type { AgentProvider, ConversationState, ExecutedToolCall } from '../../agent/types.js';

const LIVE_MODE = process.argv.includes('--live');
const EXIT_WORDS = /^(bye|quit|exit)$/i;

/** Redacts known-PII fields by name, and last-resort scrubs everything else,
 * before a tool call ever hits stdout — full data still lands in Postgres
 * untouched via finalizeConversation. */
function redactArgsForDisplay(args: Record<string, unknown>): Record<string, unknown> {
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (typeof value !== 'string') {
      redacted[key] = value;
      continue;
    }
    if (key === 'phone') redacted[key] = redactPhone(value);
    else if (key === 'address' || key === 'address_line') redacted[key] = redactAddress(value);
    else redacted[key] = scrubFreeText(value);
  }
  return redacted;
}

function printToolCall(call: ExecutedToolCall): void {
  const marker = call.initiator === 'loop' ? '[safety-override]' : '[tool]';
  const suffix = call.intercepted ? ' (capped, not executed)' : '';
  console.log(
    `${marker} ${call.name}${suffix} -> ${JSON.stringify(redactArgsForDisplay(call.dispatchedArgs))}` +
      ` => ${JSON.stringify(redactArgsForDisplay(call.result))}`,
  );
}

function printDashboardEvent(event: DashboardEvent): void {
  console.log(`[event] ${scrubFreeText(JSON.stringify(event))}`);
}

/**
 * Best-effort bridge to a `npm run dev` server that may or may not be
 * running (events/relay.ts has the full rationale: this process and that
 * one have separate in-memory event buses). Fire-and-forget — a missing or
 * unreachable server must never slow down or break the REPL, which has to
 * keep working standalone with zero dependencies for fast iteration.
 */
function relayDashboardEvent(event: DashboardEvent): void {
  fetch(`http://localhost:${config.PORT}/events/relay`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(event),
  }).catch(() => {
    // No dashboard server listening, or it's unreachable — fine, the sim
    // works standalone. Nothing to report.
  });
}

function buildProvider(): AgentProvider {
  if (LIVE_MODE) {
    const apiKey = requireEnv('ANTHROPIC_API_KEY');
    console.log(`Live mode — talking to ${config.MODEL_VOICE}. Free text works.\n`);
    return new AnthropicProvider({ apiKey, model: config.MODEL_VOICE });
  }

  console.log(
    'Scripted mode ($0) — this replays a canned routine-booking script regardless of what you\n' +
      'type. It is a wiring smoke test (loop -> tools -> DB -> event bus), not a real\n' +
      'conversation. Pass --live (with ANTHROPIC_API_KEY set in .env) to actually talk to it.\n',
  );
  return new ScriptedProvider(routineBookingDemoScript);
}

async function main(): Promise<void> {
  const provider = buildProvider();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  let state: ConversationState | null = null;
  let unsubscribeEvents: (() => void) | null = null;

  console.log('Caller phone number, E.164 (e.g. +17705559999 for the seeded fixture customer):');
  rl.prompt();

  for await (const rawLine of rl) {
    const line = rawLine.trim();

    if (!state) {
      const parsed = phoneSchema.safeParse(line);
      if (!parsed.success) {
        console.log("That doesn't look like E.164 (e.g. +17705550100) — try again:");
        rl.prompt();
        continue;
      }
      const externalId = `sim-${Date.now()}`;
      state = await startConversation({ channel: 'voice', externalId, callerPhone: parsed.data });
      const unsubscribePrint = eventBus.subscribe(printDashboardEvent);
      const unsubscribeRelay = eventBus.subscribe(relayDashboardEvent);
      unsubscribeEvents = () => {
        unsubscribePrint();
        unsubscribeRelay();
      };
      console.log(
        `\nConversation started (externalId=${externalId}). Type 'bye' or Ctrl+D to hang up.\n`,
      );
      rl.setPrompt('Caller: ');
      rl.prompt();
      continue;
    }

    if (EXIT_WORDS.test(line)) break;

    const result = await runTurn(state, rawLine, provider);
    for (const call of result.toolCalls) printToolCall(call);
    console.log(`Josie: ${result.assistantReply}`);
    rl.prompt();
  }

  if (state) {
    unsubscribeEvents?.();
    await finalizeConversation(state);
    console.log(`\nCall ended. externalId=${state.externalId}`);
  }
  rl.close();
  // The Postgres pool holds an open socket indefinitely, which would
  // otherwise keep this process alive after the REPL loop finishes.
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
