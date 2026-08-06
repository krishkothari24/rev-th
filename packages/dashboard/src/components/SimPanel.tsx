import { useCallback, useRef, useState } from 'react';
import {
  SimApiError,
  endSimCall,
  sendSimTurn,
  startSimCall,
  type SimChannel,
  type SimToolCall,
} from '../lib/simApi';

type SimEntry =
  | { kind: 'caller'; id: string; text: string }
  | { kind: 'josie'; id: string; text: string }
  | { kind: 'tool'; id: string; call: SimToolCall }
  | { kind: 'system'; id: string; text: string };

function newId(): string {
  return crypto.randomUUID();
}

/** Short, human-readable line for a tool call — same spirit as the backend's
 * events/activityFormat.ts, kept independent since this only needs to be
 * legible inline in a chat transcript, not a full activity-feed entry (the
 * real one already shows up there, on the same screen, as this fires). */
function describeToolCall(call: SimToolCall): string {
  if (call.isError) return `${call.name} — error`;
  switch (call.name) {
    case 'customer_lookup':
      return call.result.found === true ? 'Recognized returning caller' : 'New caller, no record found';
    case 'check_availability': {
      const slots = Array.isArray(call.result.slots) ? call.result.slots.length : 0;
      return `Checked availability — ${slots} slot${slots === 1 ? '' : 's'}`;
    }
    case 'book_appointment':
      return call.result.booked === true ? 'Booked appointment' : 'Booking did not complete';
    case 'flag_emergency':
      return call.result.flagged === true ? 'Emergency flagged' : 'Emergency flag failed';
    case 'transfer_to_human':
      return 'Transfer to human requested';
    default:
      return call.name;
  }
}

/**
 * "Cool features" follow-up (IMPLEMENTATION_PLAN): a text-chat drawer over
 * `POST /dashboard/sim/*`, which is itself a thin wrapper around the exact
 * loop a real call runs (see dashboard/simSession.ts). This is not a second
 * agent — no new brain, no new tool layer. It exists so a full booking can
 * be driven and watched land on the board live from inside this one screen,
 * before Retell/Twilio are wired up, without a second terminal window open.
 *
 * Self-contained: owns its own open/closed state and transcript, and never
 * touches the dispatch board's own state directly — everything the sim loop
 * does publishes through the normal event bus, so it shows up on the board
 * and activity feed via the existing `/events` stream exactly as a real
 * call would.
 */
export function SimPanel() {
  const [isOpen, setIsOpen] = useState(false);
  const [phone, setPhone] = useState('+17705559999');
  const [channel, setChannel] = useState<SimChannel>('voice');
  const [externalId, setExternalId] = useState<string | null>(null);
  const [entries, setEntries] = useState<SimEntry[]>([]);
  const [draft, setDraft] = useState('');
  const [starting, setStarting] = useState(false);
  const [sending, setSending] = useState(false);
  const [ending, setEnding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);

  const scrollToBottom = useCallback(() => {
    requestAnimationFrame(() => {
      const el = transcriptRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    });
  }, []);

  const handleStart = useCallback(async () => {
    setError(null);
    setStarting(true);
    try {
      const { externalId: id } = await startSimCall(phone, channel);
      setExternalId(id);
      setEntries([
        {
          kind: 'system',
          id: newId(),
          text: `Test ${channel === 'sms' ? 'text' : 'call'} started — externalId ${id}.`,
        },
      ]);
      scrollToBottom();
    } catch (err) {
      if (err instanceof SimApiError && err.status === 503) {
        setError('ANTHROPIC_API_KEY isn’t configured on the server yet — set it in .env to use this.');
      } else {
        setError(err instanceof Error ? err.message : 'Failed to start test call.');
      }
    } finally {
      setStarting(false);
    }
  }, [phone, channel, scrollToBottom]);

  const handleSend = useCallback(async () => {
    const message = draft.trim();
    if (!message || !externalId || sending) return;
    setDraft('');
    setError(null);
    setEntries((prev) => [...prev, { kind: 'caller', id: newId(), text: message }]);
    setSending(true);
    scrollToBottom();
    try {
      const result = await sendSimTurn(externalId, message);
      setEntries((prev) => [
        ...prev,
        ...result.toolCalls.map((call): SimEntry => ({ kind: 'tool', id: newId(), call })),
        { kind: 'josie', id: newId(), text: result.assistantReply },
      ]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send message.');
    } finally {
      setSending(false);
      scrollToBottom();
    }
  }, [draft, externalId, sending, scrollToBottom]);

  const handleEnd = useCallback(async () => {
    if (!externalId) return;
    setEnding(true);
    try {
      await endSimCall(externalId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to end test call.');
    } finally {
      setExternalId(null);
      setEntries([]);
      setEnding(false);
    }
  }, [externalId]);

  return (
    <>
      <button
        type="button"
        onClick={() => setIsOpen(true)}
        className="flex items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--surface-1)] px-2.5 py-1 text-xs font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
      >
        <span className="h-1.5 w-1.5 rounded-full bg-[var(--sequential-fill)]" aria-hidden="true" />
        Test call
      </button>

      {isOpen && (
        <div
          className="fixed inset-0 z-40 flex justify-end bg-black/20"
          onClick={() => setIsOpen(false)}
        >
          <div
            className="flex h-full w-full max-w-md flex-col border-l border-[var(--border)] bg-[var(--surface-1)] shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 border-b border-[var(--border)] px-4 py-3">
              <h2 className="text-sm font-semibold text-[var(--text-primary)]">
                Test {channel === 'sms' ? 'text' : 'call'}
              </h2>
              <span className="text-xs text-[var(--text-muted)]">
                drives the real {channel === 'sms' ? 'SMS' : 'voice'} prompt/model — no telephony needed
              </span>
              <button
                type="button"
                onClick={() => setIsOpen(false)}
                className="ml-auto text-sm text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                aria-label="Close test call panel"
              >
                ✕
              </button>
            </div>

            {!externalId ? (
              <div className="flex flex-col gap-3 p-4">
                <span className="text-xs text-[var(--text-secondary)]">Channel</span>
                <div className="flex gap-1.5">
                  {(['voice', 'sms'] as const).map((c) => (
                    <button
                      key={c}
                      type="button"
                      onClick={() => setChannel(c)}
                      className={`rounded-md border px-2.5 py-1 text-xs font-medium ${
                        channel === c
                          ? 'border-[var(--sequential-fill)] bg-[var(--sequential-fill)] text-white'
                          : 'border-[var(--border)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                      }`}
                    >
                      {c === 'voice' ? 'Voice (Realtime prompt)' : 'SMS (Haiku prompt)'}
                    </button>
                  ))}
                </div>
                <label className="text-xs text-[var(--text-secondary)]" htmlFor="sim-phone">
                  Caller phone (E.164) — use a seeded number to demo recognition
                </label>
                <input
                  id="sim-phone"
                  type="text"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  className="rounded-md border border-[var(--border)] bg-[var(--surface-page)] px-2.5 py-1.5 font-mono text-sm text-[var(--text-primary)]"
                />
                <button
                  type="button"
                  onClick={() => void handleStart()}
                  disabled={starting}
                  className="rounded-md bg-[var(--sequential-fill)] px-3 py-1.5 text-sm font-medium text-white disabled:opacity-60"
                >
                  {starting ? 'Starting…' : `Start test ${channel === 'sms' ? 'text' : 'call'}`}
                </button>
                {error && (
                  <p className="text-sm" style={{ color: 'var(--status-serious)' }}>
                    {error}
                  </p>
                )}
              </div>
            ) : (
              <>
                <div ref={transcriptRef} className="flex-1 overflow-auto px-4 py-3">
                  {entries.map((entry) => {
                    if (entry.kind === 'system') {
                      return (
                        <p key={entry.id} className="mb-2 text-xs text-[var(--text-muted)]">
                          {entry.text}
                        </p>
                      );
                    }
                    if (entry.kind === 'tool') {
                      return (
                        <p
                          key={entry.id}
                          className="mb-2 flex items-center gap-1.5 text-xs text-[var(--text-muted)]"
                        >
                          <span aria-hidden="true">🔧</span>
                          {describeToolCall(entry.call)}
                        </p>
                      );
                    }
                    const isCaller = entry.kind === 'caller';
                    return (
                      <div key={entry.id} className={`mb-2 flex ${isCaller ? 'justify-end' : 'justify-start'}`}>
                        <div
                          className={`max-w-[85%] rounded-lg px-3 py-1.5 text-sm ${
                            isCaller
                              ? 'bg-[var(--sequential-fill)] text-white'
                              : 'border border-[var(--border)] text-[var(--text-primary)]'
                          }`}
                        >
                          {!isCaller && (
                            <span className="block text-xs font-medium text-[var(--text-muted)]">Josie</span>
                          )}
                          {entry.text}
                        </div>
                      </div>
                    );
                  })}
                  {sending && <p className="text-xs text-[var(--text-muted)]">Josie is typing…</p>}
                </div>

                {error && (
                  <p className="px-4 text-sm" style={{ color: 'var(--status-serious)' }}>
                    {error}
                  </p>
                )}

                <div className="flex items-center gap-2 border-t border-[var(--border)] p-3">
                  <input
                    type="text"
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        void handleSend();
                      }
                    }}
                    placeholder="Type what the caller says…"
                    disabled={sending}
                    className="flex-1 rounded-md border border-[var(--border)] bg-[var(--surface-page)] px-2.5 py-1.5 text-sm text-[var(--text-primary)] disabled:opacity-60"
                  />
                  <button
                    type="button"
                    onClick={() => void handleSend()}
                    disabled={sending || !draft.trim()}
                    className="rounded-md bg-[var(--sequential-fill)] px-3 py-1.5 text-sm font-medium text-white disabled:opacity-60"
                  >
                    Send
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleEnd()}
                    disabled={ending}
                    className="rounded-md border border-[var(--border)] px-3 py-1.5 text-sm text-[var(--text-secondary)] disabled:opacity-60"
                  >
                    {ending ? 'Ending…' : 'End call'}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
