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
      voice: call.voice,
      instructions: call.instructions,
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
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry-with-backoff around the first connect: OpenAI Realtime's `accept`
 * has been reported (community bug reports, not official docs — see
 * BUILD_GUIDE §12/IMPLEMENTATION_PLAN Phase 11) to occasionally return 200
 * fractionally before the WS endpoint for that call_id is actually live,
 * 404ing an immediate connect attempt. A short retry absorbs that instead of
 * treating one failed connect as a fatal, un-answerable call.
 */
export async function connectRealtimeSessionWithRetry(
  callId: string,
  client: RealtimeClientConfig,
  retry: ConnectRetryOptions = {},
): Promise<WebSocket> {
  const attempts = retry.attempts ?? 3;
  const delayMs = retry.delayMs ?? 300;
  let lastErr: unknown;

  for (let i = 0; i < attempts; i += 1) {
    try {
      return await new Promise<WebSocket>((resolve, reject) => {
        const socket = connectRealtimeSession(callId, client);
        const onOpen = (): void => {
          cleanup();
          resolve(socket);
        };
        const onError = (err: unknown): void => {
          cleanup();
          reject(err instanceof Error ? err : new Error(String(err)));
        };
        function cleanup(): void {
          socket.off('open', onOpen);
          socket.off('error', onError);
        }
        socket.once('open', onOpen);
        socket.once('error', onError);
      });
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) await sleep(delayMs);
    }
  }

  throw lastErr instanceof Error
    ? lastErr
    : new Error(`Failed to connect OpenAI Realtime session for call ${callId}`);
}
