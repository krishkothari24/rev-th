/**
 * Thin wrapper around the two network calls the OpenAI Realtime SIP flow
 * needs (IMPLEMENTATION_PLAN Phase 11, BUILD_GUIDE §12): accept an incoming
 * call via REST, then open a WebSocket for that call's session. Both take an
 * explicit `RealtimeClientConfig` (including overridable base URLs) rather
 * than reading `config`/`process.env` directly, so fixture tests can point
 * both calls at a local server instead of the real OpenAI hosts — same
 * "injectable dependency, not a hardcoded host" shape as
 * `retell/websocket.ts`'s `providerFactory` test seam.
 *
 * Exact request/response shapes below (the `accept` body, the WS URL) were
 * confirmed against OpenAI's live docs during this migration's research
 * pass, not carried over from Retell's protocol — re-verify against a real
 * account before Phase 11 step 4 in case the GA surface has moved since.
 */
import WebSocket from 'ws';
import type { OpenAIRealtimeToolDefinition } from '../../tools/registry.js';

export interface RealtimeClientConfig {
  apiKey: string;
  /** Defaults to the real OpenAI hosts — overridden in tests only. */
  apiBaseUrl?: string;
  wsBaseUrl?: string;
}

export interface AcceptCallConfig {
  model: string;
  voice: string;
  instructions: string;
  tools: OpenAIRealtimeToolDefinition[];
}

const DEFAULT_API_BASE_URL = 'https://api.openai.com';
const DEFAULT_WS_BASE_URL = 'wss://api.openai.com';

/**
 * `POST /v1/realtime/calls/{call_id}/accept` — must succeed before a
 * WebSocket for this call_id can be opened. Configures the session's model,
 * voice, instructions, and tools in one call; there is no separate "create
 * session" step for a SIP-originated call the way there is for a
 * browser/WebRTC client.
 *
 * `voice` lives under `audio.output.voice` per the current Realtime Calls
 * API reference — earlier revisions of this file sent it as a flat
 * top-level field, which the API silently ignores rather than rejecting
 * (accept() still returns 200 with no `audio` config applied at all).
 * Found by comparing our request against OpenAI's documented schema after
 * every real phone call was ringing once and dying with the WS handshake
 * 404ing for a fixed ~5.2s on every attempt — consistent with the realtime
 * session never actually finishing setup, not just being slow to start.
 */
export async function acceptRealtimeCall(
  callId: string,
  call: AcceptCallConfig,
  client: RealtimeClientConfig,
): Promise<void> {
  const base = client.apiBaseUrl ?? DEFAULT_API_BASE_URL;
  const res = await fetch(`${base}/v1/realtime/calls/${encodeURIComponent(callId)}/accept`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${client.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      type: 'realtime',
      model: call.model,
      instructions: call.instructions,
      audio: { output: { voice: call.voice } },
      tools: call.tools,
    }),
  });

  if (!res.ok) {
    const bodyText = await res.text().catch(() => '');
    throw new Error(
      `OpenAI Realtime accept failed for call ${callId}: ${res.status} ${res.statusText} ${bodyText}`,
    );
  }
}

/** Opens (but does not wait for) the WebSocket for an already-accepted
 * call_id. `ws`'s client (unlike the browser/WHATWG `WebSocket` global)
 * accepts a custom `Authorization` header on the handshake, which a
 * SIP-originated session needs — there is no ephemeral client-secret step
 * here the way there is for a browser-originated Realtime session. */
export function connectRealtimeSession(callId: string, client: RealtimeClientConfig): WebSocket {
  const base = client.wsBaseUrl ?? DEFAULT_WS_BASE_URL;
  return new WebSocket(`${base}/v1/realtime?call_id=${encodeURIComponent(callId)}`, undefined, {
    headers: { Authorization: `Bearer ${client.apiKey}` },
  });
}

export interface ConnectRetryOptions {
  attempts?: number;
  delayMs?: number;
  /** Optional per-attempt diagnostic hook — a full pino logger isn't
   * threaded through the test seam, so this stays a minimal structural
   * type rather than importing FastifyBaseLogger here. */
  logger?: { info: (obj: Record<string, unknown>, msg: string) => void };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry-with-backoff around the first connect: OpenAI Realtime's `accept`
 * returns 200 once "the SIP leg is ringing and the realtime session is being
 * established" (per OpenAI's docs) — that's a 200 for the *acceptance*, not
 * a guarantee the WS endpoint for that call_id is live yet. On a real phone
 * call (unlike the fixture tests, which stub both calls) that gap has been
 * observed to run several seconds, not fractions of one: a 300ms/3-attempt
 * budget (~1s total) 404s every attempt and the call is never answered. Use
 * exponential backoff with a wider budget (~13s across 6 attempts) so a slow
 * session-establish doesn't read as a fatal, un-answerable call — still well
 * inside a caller's ring-timeout tolerance.
 */
export async function connectRealtimeSessionWithRetry(
  callId: string,
  client: RealtimeClientConfig,
  retry: ConnectRetryOptions = {},
): Promise<WebSocket> {
  const attempts = retry.attempts ?? 6;
  const initialDelayMs = retry.delayMs ?? 500;
  let lastErr: unknown;

  for (let i = 0; i < attempts; i += 1) {
    const attemptStart = Date.now();
    try {
      const socket = await new Promise<WebSocket>((resolve, reject) => {
        const ws = connectRealtimeSession(callId, client);
        const onOpen = (): void => {
          cleanup();
          resolve(ws);
        };
        const onError = (err: unknown): void => {
          cleanup();
          reject(err instanceof Error ? err : new Error(String(err)));
        };
        function cleanup(): void {
          ws.off('open', onOpen);
          ws.off('error', onError);
        }
        ws.once('open', onOpen);
        ws.once('error', onError);
      });
      retry.logger?.info(
        { callId, attempt: i + 1, attempts, elapsedMs: Date.now() - attemptStart },
        'openai-realtime: WS connect attempt succeeded',
      );
      return socket;
    } catch (err) {
      lastErr = err;
      retry.logger?.info(
        {
          callId,
          attempt: i + 1,
          attempts,
          elapsedMs: Date.now() - attemptStart,
          err: err instanceof Error ? err.message : String(err),
        },
        'openai-realtime: WS connect attempt failed',
      );
      if (i < attempts - 1) {
        const backoffMs = Math.min(initialDelayMs * 2 ** i, 3000);
        await sleep(backoffMs);
      }
    }
  }

  throw lastErr instanceof Error
    ? lastErr
    : new Error(`Failed to connect OpenAI Realtime session for call ${callId}`);
}
