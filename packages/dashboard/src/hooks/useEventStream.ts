import { useEffect, useRef, useState } from 'react';
import type { DashboardEvent } from '../types/api';
import { eventsUrl } from '../lib/api';

export type ConnectionStatus = 'connecting' | 'open' | 'reconnecting';

/**
 * Thin wrapper over `EventSource` (BUILD_GUIDE §6: SSE, not WebSockets).
 * Reconnection itself is the browser's built-in `EventSource` retry — that's
 * the whole point of choosing SSE over a hand-rolled socket — this hook only
 * adds the app-level bookkeeping SSE doesn't give you for free: a
 * `connecting | open | reconnecting` status the UI can show calmly (per
 * BUILD_GUIDE's "calm until something is urgent"), and an `onOpen` callback
 * fired on every open *including reconnects*, which is what lets the caller
 * resync via `GET /dashboard/state` instead of this hook trying to buffer
 * and replay missed events itself.
 */
export function useEventStream(
  onEvent: (event: DashboardEvent) => void,
  onOpen: () => void,
): ConnectionStatus {
  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  // Refs so the effect below never needs to re-run (and re-open the
  // connection) just because the caller passed a new closure this render.
  const onEventRef = useRef(onEvent);
  const onOpenRef = useRef(onOpen);
  onEventRef.current = onEvent;
  onOpenRef.current = onOpen;

  useEffect(() => {
    const source = new EventSource(eventsUrl());
    let everOpened = false;

    source.onopen = () => {
      everOpened = true;
      setStatus('open');
      onOpenRef.current();
    };
    source.onerror = () => {
      // Fires while the browser is between automatic retry attempts, or on
      // a fatal transport failure — either way "not currently open."
      // Distinguishing the two isn't worth it for a status label the UI
      // renders identically for both ("reconnecting…").
      setStatus(everOpened ? 'reconnecting' : 'connecting');
    };
    source.onmessage = (e) => {
      try {
        onEventRef.current(JSON.parse(e.data) as DashboardEvent);
      } catch {
        // Malformed frame — the server only ever writes JSON.stringify'd
        // events, so this shouldn't happen. Drop it rather than crash the
        // whole stream over one bad line.
      }
    };

    return () => source.close();
  }, []);

  return status;
}
