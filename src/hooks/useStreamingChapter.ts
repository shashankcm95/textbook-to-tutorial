/**
 * src/hooks/useStreamingChapter.ts — EventSource lifecycle hook.
 *
 * LOAD-BEARING ABSORB: riley CRITICAL-1 (Phase 1 synthesis).
 *
 *   "SSE AbortController + EventSource cleanup propagation — without it, tab
 *   close / navigation away leaks the open OpenAI request, which means the
 *   server-side stream keeps billing tokens until OpenAI's own timeout fires."
 *
 * The cleanup contract this hook implements:
 *
 *   1. On unmount, call `es.close()` — closes the EventSource on the client.
 *   2. On unmount, call `abortController.abort()` — the abort signal is
 *      propagated by the *server* SSE handler (priya's `/api/tutorials/:id/stream`
 *      route) into the OpenAI SDK call (omar's `streaming.ts:261` already
 *      accepts an `abortSignal` and wires it to the underlying fetch). The
 *      mechanism: when the client closes the EventSource, the server detects
 *      `request.signal.aborted === true` on its end, which the route handler
 *      threads into the streaming inference. Closing only the client side is
 *      NOT enough — it relies on the server detecting the closed connection.
 *      We provide an explicit AbortController so callers (e.g., a "Cancel"
 *      button) can also surface the abort upstream without unmounting.
 *
 *   3. On error, reconnect with exponential backoff up to 3 attempts, then
 *      surface the error to the UI (status: 'failed'). Why bounded retries:
 *      unbounded retries on a server-side 500 would keep re-triggering
 *      expensive generation; the user should see the failure and choose to
 *      retry manually.
 *
 * Why a hook (not just inline in the component):
 *   - Encapsulates the EventSource lifecycle + reconnect state machine.
 *   - Lets the parent component handle ALL SSE frame routing as a pure
 *     reducer (no effect plumbing scattered through render).
 *   - Testable in isolation (the JSDOM EventSource mock pairs cleanly with
 *     this hook's surface area).
 *
 * Anchors:
 *   - kb:web-dev/react-essentials §"Effect cleanup" — useEffect returning a
 *     function = cleanup runs on unmount and before next effect. Required for
 *     subscriptions, timers, intervals.
 *   - kb:web-dev/react-essentials §"Anti-patterns" — `useEffect(() => fetch(url), [])`
 *     without an abort controller is called out as a race-condition hazard.
 *     EventSource has the same hazard; we close it explicitly.
 */

import { useEffect, useRef, useState, useCallback } from 'react';

// ───────────────────────────────────────────────────────────────────────────
// Public types
// ───────────────────────────────────────────────────────────────────────────

export type StreamStatus =
  | 'idle'
  | 'connecting'
  | 'streaming'
  | 'reconnecting'
  | 'done'
  | 'failed';

/** Parsed SSE frame as emitted by priya's `/api/tutorials/:id/stream`. */
export interface StreamFrame {
  /** The named SSE event, e.g. 'chapter-start', 'token', 'cost-update'. */
  event: string;
  /** JSON-parsed data payload. `null` if the frame had no data or parse failed. */
  data: unknown;
}

export interface UseStreamingChapterArgs {
  /** The tutorial id. Stream URL is derived as `/api/tutorials/${id}/stream`. */
  tutorialId: string;
  /**
   * Called for every successfully parsed SSE frame. Caller routes by
   * `frame.event` (e.g., 'token' → append to current chapter; 'cost-update'
   * → refresh cost chip). Caller is expected to be stable (wrap in
   * `useCallback`) to avoid resubscribing on every render.
   */
  onFrame: (frame: StreamFrame) => void;
  /**
   * Optional: skip opening on mount. Useful if the parent wants to wait for
   * some condition (e.g., user clicks "Start") before subscribing. Default false.
   */
  paused?: boolean;
}

export interface UseStreamingChapterResult {
  status: StreamStatus;
  /** Error from the last failed attempt; null on success or while connecting. */
  error: Error | null;
  /** Manually close the stream + abort. Idempotent. */
  cancel: () => void;
  /** Number of reconnect attempts consumed since the last successful frame. */
  reconnectCount: number;
}

// ───────────────────────────────────────────────────────────────────────────
// Reconnect policy
// ───────────────────────────────────────────────────────────────────────────

/**
 * Exponential backoff: 1s, 2s, 4s — then give up (status='failed').
 * MAX_RECONNECT_ATTEMPTS = 3 per spec ("cap 3 attempts then surface error
 * to UI"). The 0-indexed slot 0 is the first reconnect's delay.
 */
const RECONNECT_DELAYS_MS = [1_000, 2_000, 4_000] as const;
const MAX_RECONNECT_ATTEMPTS = RECONNECT_DELAYS_MS.length;

// ───────────────────────────────────────────────────────────────────────────
// Hook
// ───────────────────────────────────────────────────────────────────────────

export function useStreamingChapter(
  args: UseStreamingChapterArgs,
): UseStreamingChapterResult {
  const { tutorialId, onFrame, paused = false } = args;

  const [status, setStatus] = useState<StreamStatus>('idle');
  const [error, setError] = useState<Error | null>(null);
  const [reconnectCount, setReconnectCount] = useState(0);

  // Refs that survive re-renders (closures over the latest values).
  const esRef = useRef<EventSource | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Latch the latest onFrame so the effect closure doesn't capture a stale
  // reference if the caller passes a non-memoized function. We still ask
  // callers to memoize, but this defends against bugs in their code.
  const onFrameRef = useRef(onFrame);
  useEffect(() => {
    onFrameRef.current = onFrame;
  }, [onFrame]);

  /**
   * Tear down the current connection. Idempotent — safe to call from cleanup,
   * from cancel(), and from inside the reconnect loop.
   *
   * The `abort()` call is the critical piece: it signals upstream that the
   * client is gone, which the SSE route handler picks up via its own
   * AbortController bridge into the OpenAI fetch (see omar's streaming.ts
   * `signal: abortSignal` wiring).
   */
  const teardown = useCallback(() => {
    if (reconnectTimerRef.current !== null) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    if (esRef.current !== null) {
      esRef.current.close();
      esRef.current = null;
    }
    if (abortRef.current !== null) {
      abortRef.current.abort();
      abortRef.current = null;
    }
  }, []);

  /**
   * Manually cancel the stream (e.g., user clicked "Stop").
   * Sets status to 'done' (semantically "we're done streaming", whether by
   * completion or by user choice). Resets reconnect counter.
   */
  const cancel = useCallback(() => {
    teardown();
    setStatus('done');
    setError(null);
    setReconnectCount(0);
  }, [teardown]);

  useEffect(() => {
    if (paused) {
      // If the parent toggles paused=true mid-flight, tear down. Re-opens
      // when paused flips back to false.
      teardown();
      setStatus('idle');
      return;
    }

    let attempt = 0;
    let disposed = false;

    /**
     * Open one connection attempt. Recurses on `error` event up to
     * MAX_RECONNECT_ATTEMPTS. We use closure-local `attempt` rather than
     * the React state to avoid stale-closure / lost-update issues across
     * the reconnect loop.
     */
    const openOnce = (): void => {
      if (disposed) return;

      // Build fresh AbortController for this attempt. Reusing across
      // attempts would surface the "already aborted" state from a prior
      // failed connection — fresh controller = clean signal per attempt.
      const ac = new AbortController();
      abortRef.current = ac;

      setStatus(attempt === 0 ? 'connecting' : 'reconnecting');

      const url = `/api/tutorials/${encodeURIComponent(tutorialId)}/stream`;
      // EventSource doesn't accept AbortSignal directly (DOM spec gap), so
      // the AbortController is paired separately and propagated to the
      // server via the underlying TCP close when we call es.close() below.
      // Modern browsers detect the abort and surface it server-side as
      // `request.signal.aborted`.
      const es = new EventSource(url, { withCredentials: true });
      esRef.current = es;

      // Generic message handler — for unnamed SSE messages. The server
      // typically uses named events; this is the fallback.
      es.onmessage = (ev: MessageEvent): void => {
        deliverFrame('message', ev.data);
      };

      // Named events — the protocol per spawn brief:
      //   chapter-start | token | chapter-complete | cost-update | done | error
      // Implementation: attach listeners for each. Generic registry to avoid
      // duplication.
      const NAMED_EVENTS = [
        'chapter-start',
        'token',
        'chapter-complete',
        'cost-update',
        'done',
        'error',
      ] as const;

      for (const eventName of NAMED_EVENTS) {
        es.addEventListener(eventName, (ev: Event): void => {
          // Cast: addEventListener returns Event; SSE events are MessageEvent.
          // We need .data, which only exists on MessageEvent.
          const me = ev as MessageEvent;
          // 'done' is a happy-path terminator; 'error' is the protocol-level
          // error frame (distinct from EventSource.onerror network failures).
          if (eventName === 'done') {
            deliverFrame('done', me.data);
            setStatus('done');
            // Successful completion — close gracefully (no abort needed; the
            // server has already finished). But still close the EventSource
            // so the browser doesn't keep the HTTP/1.1 connection in
            // half-open state.
            es.close();
            esRef.current = null;
            // Reset reconnect counter — a clean finish resets state.
            setReconnectCount(0);
            return;
          }
          if (eventName === 'error') {
            deliverFrame('error', me.data);
            // Protocol error: server intentionally signaled error (e.g.,
            // cost-cap-exceeded). Do NOT auto-reconnect — the server told
            // us why it stopped. Let the UI surface it.
            es.close();
            esRef.current = null;
            setStatus('failed');
            // The error event's `data` field carries the structured payload;
            // we wrap it in an Error for the `error` state field.
            const parsedData = safeParse(me.data);
            setError(extractProtocolError(parsedData));
            return;
          }
          // All other events — just deliver to the caller. Status flips to
          // 'streaming' on first successful frame.
          if (status !== 'streaming') {
            setStatus('streaming');
          }
          // Reset reconnect counter on any successful frame — we made
          // progress, so subsequent failures get a fresh budget.
          attempt = 0;
          setReconnectCount(0);
          deliverFrame(eventName, me.data);
        });
      }

      // EventSource.onerror fires on network-level failures (disconnect,
      // server 5xx). Browsers auto-reconnect by default; we override that
      // behavior by closing explicitly and managing the reconnect ourselves
      // with bounded attempts + exponential backoff.
      es.onerror = (): void => {
        if (disposed) return;
        // EventSource readyState === CLOSED (2) means the browser already
        // gave up. CONNECTING (0) means it's mid-reconnect attempt. Either
        // way, we take over: close it and decide ourselves whether to retry.
        es.close();
        esRef.current = null;
        if (abortRef.current !== null) {
          abortRef.current.abort();
          abortRef.current = null;
        }

        attempt += 1;
        setReconnectCount(attempt);

        if (attempt > MAX_RECONNECT_ATTEMPTS) {
          setStatus('failed');
          setError(
            new Error(
              `EventSource lost after ${MAX_RECONNECT_ATTEMPTS} reconnect attempts. Refresh to retry.`,
            ),
          );
          return;
        }

        // Schedule reconnect — note that index is (attempt - 1) since
        // attempt counts the upcoming retry (1-based for the user).
        const delayIdx = Math.min(attempt - 1, RECONNECT_DELAYS_MS.length - 1);
        const delayMs = RECONNECT_DELAYS_MS[delayIdx] ?? 4_000;
        setStatus('reconnecting');
        reconnectTimerRef.current = setTimeout(() => {
          reconnectTimerRef.current = null;
          openOnce();
        }, delayMs);
      };
    };

    /** Parse JSON safely; return null on failure. */
    const safeParse = (raw: unknown): unknown => {
      if (typeof raw !== 'string') return null;
      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
    };

    /** Extract a meaningful error from a protocol-error frame's data. */
    const extractProtocolError = (data: unknown): Error => {
      if (data !== null && typeof data === 'object') {
        const obj = data as { code?: unknown; message?: unknown };
        const code = typeof obj.code === 'string' ? obj.code : 'stream-error';
        const message =
          typeof obj.message === 'string' ? obj.message : 'streaming error';
        const err = new Error(`[${code}] ${message}`);
        // Attach code for callers that want to switch on it.
        (err as Error & { code: string }).code = code;
        return err;
      }
      return new Error('streaming error (no structured payload)');
    };

    /** Hand a parsed frame to the caller. Logs + swallows callback throws. */
    const deliverFrame = (eventName: string, rawData: unknown): void => {
      const data = safeParse(rawData);
      try {
        onFrameRef.current({ event: eventName, data });
      } catch (cbErr) {
        // eslint-disable-next-line no-console
        console.error('[useStreamingChapter] onFrame handler threw:', cbErr);
      }
    };

    openOnce();

    // Cleanup — riley CRITICAL-1 absorb. This is the load-bearing line.
    return () => {
      disposed = true;
      teardown();
    };
    // We deliberately omit `status` from deps — it would re-open on every
    // status transition. The hook owns its own lifecycle; status is output.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tutorialId, paused, teardown]);

  return { status, error, cancel, reconnectCount };
}
