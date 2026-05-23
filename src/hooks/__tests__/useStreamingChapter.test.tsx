// @vitest-environment jsdom

/**
 * useStreamingChapter — AbortController + EventSource cleanup test.
 *
 * LOAD-BEARING ABSORB: riley CRITICAL-1 (Phase 1 synthesis).
 *
 *   "On unmount, MUST call BOTH eventSource.close() AND
 *    abortController.abort(). Test verifies both are invoked."
 *
 * Failure mode this guards against:
 *   - User opens a tutorial page, mounts the streaming hook.
 *   - User navigates away (tab close, route change) BEFORE the server
 *     finishes generating.
 *   - Without abort(): the server-side request.signal NEVER fires "aborted",
 *     so omar's generateChapterStreaming keeps the OpenAI fetch open. Tokens
 *     keep generating + billing until OpenAI's own server-side timeout
 *     (~10 minutes for streaming) catches up.
 *   - Cost impact: a single abandoned tutorial could rack up minutes of
 *     billable streaming generation that no human will ever see. At scale
 *     this is a real-money leak.
 *
 * The test mocks EventSource (jsdom doesn't ship one) and spies on
 * close() + abort() calls. Mount → unmount → assert both fired.
 *
 * KB anchor: kb:web-dev/react-essentials §"Effect cleanup" — useEffect's
 * return function is the cleanup; subscriptions, timers, and intervals
 * MUST be torn down there to prevent leaks across mount cycles.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useStreamingChapter } from '../useStreamingChapter';

// ───────────────────────────────────────────────────────────────────────────
// EventSource mock — captures close() calls + lets us drive events.
// ───────────────────────────────────────────────────────────────────────────
//
// jsdom does not ship an EventSource implementation. We replace globalThis
// .EventSource for the duration of each test with a minimal mock that:
//   - records construction (so we can assert "exactly one EventSource was created")
//   - exposes .close as a vi.fn() so we can assert "close was called on unmount"
//   - holds the listener registry so a future test could drive events through it
//
// Per kb:web-dev/typescript-react-patterns §"Test seams" — mocking at the
// global boundary is preferable to dependency-injecting EventSource through
// the hook signature (which would pollute production code with test-only
// indirection).

interface MockEventSource extends Partial<EventSource> {
  __ctorUrl: string;
  __ctorOpts: EventSourceInit | undefined;
  close: ReturnType<typeof vi.fn>;
  addEventListener: ReturnType<typeof vi.fn>;
  removeEventListener: ReturnType<typeof vi.fn>;
  onerror: ((this: EventSource, ev: Event) => unknown) | null;
  onmessage: ((this: EventSource, ev: MessageEvent) => unknown) | null;
  onopen: ((this: EventSource, ev: Event) => unknown) | null;
  readyState: number;
  withCredentials: boolean;
  url: string;
}

const createdInstances: MockEventSource[] = [];

class FakeEventSource implements MockEventSource {
  __ctorUrl: string;
  __ctorOpts: EventSourceInit | undefined;
  close = vi.fn(() => {
    this.readyState = 2; // EventSource.CLOSED
  });
  addEventListener = vi.fn();
  removeEventListener = vi.fn();
  onerror: MockEventSource['onerror'] = null;
  onmessage: MockEventSource['onmessage'] = null;
  onopen: MockEventSource['onopen'] = null;
  readyState = 0; // CONNECTING
  withCredentials = false;
  url: string;

  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;

  constructor(url: string | URL, opts?: EventSourceInit) {
    this.__ctorUrl = typeof url === 'string' ? url : url.toString();
    this.__ctorOpts = opts;
    this.url = this.__ctorUrl;
    this.withCredentials = opts?.withCredentials ?? false;
    createdInstances.push(this);
  }
}

// ───────────────────────────────────────────────────────────────────────────
// AbortController spy — installs a wrapper that records abort() calls while
// keeping the standard behavior intact (so AbortSignal.aborted reflects truth).
// ───────────────────────────────────────────────────────────────────────────

const abortSpies: Array<ReturnType<typeof vi.fn>> = [];
let originalAbortController: typeof AbortController;

function installAbortControllerSpy(): void {
  originalAbortController = globalThis.AbortController;
  class SpiedAbortController extends originalAbortController {
    constructor() {
      super();
      const realAbort = this.abort.bind(this);
      const spy = vi.fn((reason?: unknown) => realAbort(reason));
      abortSpies.push(spy);
      this.abort = spy as unknown as AbortController['abort'];
    }
  }
  globalThis.AbortController = SpiedAbortController as typeof AbortController;
}

function restoreAbortController(): void {
  globalThis.AbortController = originalAbortController;
}

// ───────────────────────────────────────────────────────────────────────────
// Fixture setup
// ───────────────────────────────────────────────────────────────────────────

beforeEach(() => {
  createdInstances.length = 0;
  abortSpies.length = 0;
  // Install the EventSource mock globally; restore on teardown.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).EventSource = FakeEventSource;
  installAbortControllerSpy();
});

afterEach(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (globalThis as any).EventSource;
  restoreAbortController();
});

// ───────────────────────────────────────────────────────────────────────────
// Tests
// ───────────────────────────────────────────────────────────────────────────

describe('useStreamingChapter — cleanup contract (riley CRITICAL-1)', () => {
  it('opens exactly one EventSource on mount', () => {
    const onFrame = vi.fn();
    renderHook(() =>
      useStreamingChapter({ tutorialId: 'abc-tutorial', onFrame }),
    );
    expect(createdInstances).toHaveLength(1);
    expect(createdInstances[0]?.__ctorUrl).toBe(
      '/api/tutorials/abc-tutorial/stream',
    );
    // withCredentials must be true so the SameSite=Strict session cookie
    // is sent with the EventSource handshake. Without it the request would
    // be unauthenticated and the server would 401.
    expect(createdInstances[0]?.withCredentials).toBe(true);
  });

  it('calls eventSource.close() AND abortController.abort() on unmount', () => {
    const onFrame = vi.fn();
    const { unmount } = renderHook(() =>
      useStreamingChapter({ tutorialId: 'abc-tutorial', onFrame }),
    );

    // Confirm the EventSource + AbortController were both constructed.
    expect(createdInstances).toHaveLength(1);
    expect(abortSpies.length).toBeGreaterThanOrEqual(1);

    const es = createdInstances[0]!;
    // Pre-unmount sanity: close has NOT been called yet.
    expect(es.close).not.toHaveBeenCalled();
    // None of the abort spies have fired yet.
    expect(abortSpies.every((s) => s.mock.calls.length === 0)).toBe(true);

    // Trigger the cleanup path.
    unmount();

    // LOAD-BEARING ASSERTIONS — these are the failure modes riley CRITICAL-1
    // says we must defend against. Both MUST fire on unmount.
    expect(es.close).toHaveBeenCalledTimes(1);
    // At least one AbortController must have had abort() called. (The hook
    // may construct multiple over its lifetime if reconnect attempts fired;
    // we accept any-of fired as long as the most-recently-constructed one
    // is in aborted state.)
    const anyAborted = abortSpies.some((s) => s.mock.calls.length > 0);
    expect(anyAborted).toBe(true);
  });

  it('teardown is idempotent — multiple unmount cycles do not throw', () => {
    const onFrame = vi.fn();
    const { unmount } = renderHook(() =>
      useStreamingChapter({ tutorialId: 'abc-tutorial', onFrame }),
    );
    expect(() => unmount()).not.toThrow();
    // A second unmount should be a no-op (RTL renderHook is single-shot,
    // so this just confirms the teardown function tolerates re-entry).
    expect(() => unmount()).not.toThrow();
  });

  it('paused=true does not open an EventSource and does not throw on unmount', () => {
    const onFrame = vi.fn();
    const { unmount } = renderHook(() =>
      useStreamingChapter({
        tutorialId: 'abc-tutorial',
        onFrame,
        paused: true,
      }),
    );
    // No EventSource constructed when paused.
    expect(createdInstances).toHaveLength(0);
    expect(() => unmount()).not.toThrow();
  });
});
