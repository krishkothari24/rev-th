// Talks to the embedded sim panel's backend (dashboard/routes.ts's
// `/dashboard/sim/*`) — same BASE_URL convention as lib/api.ts. Everything
// this drives publishes through the normal event bus, so a booking made
// here lands on the board over the existing /events stream exactly like a
// real call would; this file only carries the chat turn itself.
const BASE_URL = import.meta.env.VITE_API_BASE_URL || window.location.origin;

export interface SimToolCall {
  name: string;
  dispatchedArgs: Record<string, unknown>;
  result: Record<string, unknown>;
  isError: boolean;
  initiator: 'model' | 'loop';
}

export interface SimTurnResult {
  assistantReply: string;
  toolCalls: SimToolCall[];
}

class SimApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

async function parseErrorBody(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { message?: string; error?: string };
    return body.message ?? body.error ?? `request failed: ${res.status}`;
  } catch {
    return `request failed: ${res.status}`;
  }
}

export type SimChannel = 'voice' | 'sms';

export async function startSimCall(
  callerPhone: string,
  channel: SimChannel = 'voice',
): Promise<{ externalId: string }> {
  const res = await fetch(`${BASE_URL}/dashboard/sim/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callerPhone, channel }),
  });
  if (!res.ok) throw new SimApiError(await parseErrorBody(res), res.status);
  return (await res.json()) as { externalId: string };
}

export async function sendSimTurn(externalId: string, message: string): Promise<SimTurnResult> {
  const res = await fetch(`${BASE_URL}/dashboard/sim/turn`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ externalId, message }),
  });
  if (!res.ok) throw new SimApiError(await parseErrorBody(res), res.status);
  return (await res.json()) as SimTurnResult;
}

export async function endSimCall(externalId: string): Promise<void> {
  const res = await fetch(`${BASE_URL}/dashboard/sim/end`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ externalId }),
  });
  if (!res.ok) throw new SimApiError(await parseErrorBody(res), res.status);
}

export { SimApiError };
