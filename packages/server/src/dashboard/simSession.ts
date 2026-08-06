/**
 * In-memory sessions backing the dashboard's embedded sim panel
 * (`POST /dashboard/sim/*`) — lets the exact conversation loop that answers
 * real calls (agent/loop.ts) be driven from the browser, with every event it
 * publishes landing on the same board a real call would, over the same
 * `/events` SSE stream. No new brain, no new tool layer — this is a thin
 * HTTP wrapper around `transports/sim/repl.ts`'s terminal REPL, useful for
 * two things: iterating without a second terminal window open, and (until
 * Retell/Twilio are wired up in Phase 9) the only way to watch a booking
 * land on the board live at all.
 *
 * Mirrors `transports/twilio/conversationStore.ts`'s Map-of-sessions +
 * inactivity-sweeper shape. Unlike an SMS thread, a sim session is keyed by
 * its own generated `externalId`, not the caller's phone — the same phone
 * number can drive several sim calls in a row without colliding.
 */
import { randomUUID } from 'node:crypto';
import { config, requireEnv } from '../config.js';
import { finalizeConversation, startConversation } from '../agent/context.js';
import { runTurn } from '../agent/loop.js';
import { AnthropicProvider } from '../agent/providers/anthropic.js';
import type { AgentProvider, ConversationState, ExecutedToolCall } from '../agent/types.js';

export interface SimSession {
  state: ConversationState;
  provider: AgentProvider;
  lastActivityAt: number;
}

export interface SimTurnResult {
  assistantReply: string;
  toolCalls: ExecutedToolCall[];
}

// A dashboard tab left open shouldn't hold a session (and its provider)
// alive forever; 30 minutes idle is generous for a live demo/interview
// session while still eventually finalizing an abandoned one.
const SESSION_IDLE_MS = 30 * 60 * 1000;

const sessions = new Map<string, SimSession>();

/** Test/production seam, same idiom as `conversationStore.ts`'s
 * `providerFactory` param — production always gets a real `AnthropicProvider`
 * on the same model a real voice call would use. Throws with a clear message
 * if `ANTHROPIC_API_KEY` isn't set yet; the route layer turns that into a
 * clean 503 rather than a 500. */
function defaultProviderFactory(): AgentProvider {
  return new AnthropicProvider({
    apiKey: requireEnv('ANTHROPIC_API_KEY'),
    model: config.MODEL_VOICE,
  });
}

export async function startSimSession(
  callerPhone: string,
  providerFactory: () => AgentProvider = defaultProviderFactory,
): Promise<{ externalId: string }> {
  const externalId = `dash-sim-${randomUUID()}`;
  // Constructed before startConversation so a missing API key fails fast,
  // before a conversations row (and a call.started event) exists for it.
  const provider = providerFactory();
  const state = await startConversation({ channel: 'voice', externalId, callerPhone });
  sessions.set(externalId, { state, provider, lastActivityAt: Date.now() });
  return { externalId };
}

/** Returns `null` for an unknown/already-ended `externalId` — the route
 * layer turns that into 404, same as `dashboard/routes.ts`'s acknowledge
 * endpoint on an unknown emergency id. */
export async function runSimTurn(
  externalId: string,
  callerUtterance: string,
): Promise<SimTurnResult | null> {
  const session = sessions.get(externalId);
  if (!session) return null;
  session.lastActivityAt = Date.now();
  const result = await runTurn(session.state, callerUtterance, session.provider);
  return { assistantReply: result.assistantReply, toolCalls: result.toolCalls };
}

export async function endSimSession(externalId: string): Promise<boolean> {
  const session = sessions.get(externalId);
  if (!session) return false;
  sessions.delete(externalId);
  await finalizeConversation(session.state);
  return true;
}

/** Same shape as `conversationStore.ts`'s sweeper: `unref()`d so it never
 * keeps the process alive on its own, stoppable for tests/graceful shutdown. */
export function startSimSessionSweeper(intervalMs = 5 * 60 * 1000): () => void {
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [externalId, session] of sessions) {
      if (now - session.lastActivityAt <= SESSION_IDLE_MS) continue;
      sessions.delete(externalId);
      void finalizeConversation(session.state).catch((err: unknown) => {
        console.error('[dashboard-sim] idle session finalize failed:', err);
      });
    }
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

/** Test-only escape hatch, mirrors `__resetSmsThreadsForTests`. */
export function __resetSimSessionsForTests(): void {
  sessions.clear();
}
