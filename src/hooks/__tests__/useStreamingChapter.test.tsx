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
import { renderHook, act } from '@testing-library/react';
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

// ───────────────────────────────────────────────────────────────────────────
// DRIFT-test3-019 — per-chapter SSE rewire
// ───────────────────────────────────────────────────────────────────────────
//
// When chapterIdx is provided, the hook targets the per-chapter route and
// must re-open a fresh EventSource whenever chapterIdx changes — that is the
// load-bearing mechanism that removes the "need-clean-nav after Mark
// Complete" UX caveat. The parent recomputes the active chapter ordinal
// after the ratchet bumps; the hook follows.

describe('useStreamingChapter — per-chapter URL + re-open on chapterIdx change (DRIFT-019)', () => {
  it('targets the per-chapter route when chapterIdx is provided', () => {
    const onFrame = vi.fn();
    renderHook(() =>
      useStreamingChapter({ tutorialId: 'abc-tutorial', chapterIdx: 3, onFrame }),
    );
    expect(createdInstances).toHaveLength(1);
    expect(createdInstances[0]?.__ctorUrl).toBe(
      '/api/tutorials/abc-tutorial/chapters/3/stream',
    );
  });

  it('tears down the old EventSource and opens a fresh one when chapterIdx changes', () => {
    const onFrame = vi.fn();
    const { rerender } = renderHook(
      ({ chapterIdx }: { chapterIdx: number }) =>
        useStreamingChapter({ tutorialId: 'abc-tutorial', chapterIdx, onFrame }),
      { initialProps: { chapterIdx: 0 } },
    );

    // First mount opens stream for chapter 0.
    expect(createdInstances).toHaveLength(1);
    const first = createdInstances[0]!;
    expect(first.__ctorUrl).toBe('/api/tutorials/abc-tutorial/chapters/0/stream');
    expect(first.close).not.toHaveBeenCalled();

    // Simulate the Mark-Complete + router.refresh() cycle: parent recomputes
    // activeChapterIdx → passes a new chapterIdx → hook should switch streams.
    rerender({ chapterIdx: 1 });

    // First stream closed; second stream opened with the new URL.
    expect(first.close).toHaveBeenCalledTimes(1);
    expect(createdInstances).toHaveLength(2);
    expect(createdInstances[1]?.__ctorUrl).toBe(
      '/api/tutorials/abc-tutorial/chapters/1/stream',
    );
    // Each per-chapter open gets its own AbortController; the previous one
    // should have been aborted by the teardown path so the server-side
    // OpenAI fetch tied to chapter 0 stops generating tokens.
    expect(abortSpies.some((s) => s.mock.calls.length > 0)).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Sprint H Wave 1 (Builder E) — diagrams-extracted state plumbing
// ───────────────────────────────────────────────────────────────────────────
//
// The hook exposes isExtracting / extractedDiagramCount / extractedDroppedCount
// driven by two new SSE frames:
//   - 'narrative-stream-complete' → isExtracting = true
//   - 'diagrams-extracted'        → isExtracting = false; counts populated
//
// FakeEventSource's `addEventListener` is a vi.fn(); we drive frames by
// finding the registered listener from the mock's call args and invoking it
// with a synthetic MessageEvent. Wrapping in `act()` is required so React 18
// flushes the state updates before our assertion runs.

/** Find the listener registered for `eventName` on the freshest mock. */
function findListener(
  instance: MockEventSource,
  eventName: string,
): ((ev: Event) => void) | null {
  const calls = instance.addEventListener.mock.calls as Array<
    [string, (ev: Event) => void]
  >;
  for (let i = calls.length - 1; i >= 0; i -= 1) {
    const [name, fn] = calls[i] ?? [];
    if (name === eventName && typeof fn === 'function') return fn;
  }
  return null;
}

/** Synthesize a MessageEvent with the given JSON-stringified data payload. */
function fakeMessageEvent(data: unknown): MessageEvent {
  // jsdom's MessageEvent constructor accepts a MessageEventInit; we encode
  // the data string per the SSE wire shape (the hook parses with JSON.parse
  // inside its safeParse helper).
  return new MessageEvent('message', { data: JSON.stringify(data) });
}

describe('useStreamingChapter — diagrams-extracted state (Sprint H Wave 1)', () => {
  it('exposes isExtracting=false / counts=null on initial mount', () => {
    const onFrame = vi.fn();
    const { result } = renderHook(() =>
      useStreamingChapter({ tutorialId: 'abc', chapterIdx: 0, onFrame }),
    );
    expect(result.current.isExtracting).toBe(false);
    expect(result.current.extractedDiagramCount).toBeNull();
    expect(result.current.extractedDroppedCount).toBeNull();
  });

  it('flips isExtracting=true on narrative-stream-complete frame', () => {
    const onFrame = vi.fn();
    const { result } = renderHook(() =>
      useStreamingChapter({ tutorialId: 'abc', chapterIdx: 0, onFrame }),
    );
    const es = createdInstances[0]!;
    const listener = findListener(es, 'narrative-stream-complete');
    expect(listener).not.toBeNull();
    act(() => {
      listener!(fakeMessageEvent({ chapterId: 'ch-abc' }));
    });
    expect(result.current.isExtracting).toBe(true);
    // onFrame still receives the frame as an opaque delivery — existing
    // consumers are not broken by the new frame.
    expect(onFrame).toHaveBeenCalledWith({
      event: 'narrative-stream-complete',
      data: { chapterId: 'ch-abc' },
    });
  });

  it('flips isExtracting=false and populates counts on diagrams-extracted frame', () => {
    const onFrame = vi.fn();
    const { result } = renderHook(() =>
      useStreamingChapter({ tutorialId: 'abc', chapterIdx: 0, onFrame }),
    );
    const es = createdInstances[0]!;

    // First: narrative-stream-complete to set isExtracting=true.
    const onStreamComplete = findListener(es, 'narrative-stream-complete');
    act(() => {
      onStreamComplete!(fakeMessageEvent({ chapterId: 'ch-abc' }));
    });
    expect(result.current.isExtracting).toBe(true);

    // Then: diagrams-extracted with a real payload.
    const onDiagrams = findListener(es, 'diagrams-extracted');
    expect(onDiagrams).not.toBeNull();
    act(() => {
      onDiagrams!(
        fakeMessageEvent({ count: 3, droppedCount: 1, costUsd: 0.0006 }),
      );
    });
    expect(result.current.isExtracting).toBe(false);
    expect(result.current.extractedDiagramCount).toBe(3);
    expect(result.current.extractedDroppedCount).toBe(1);
  });

  it('clears isExtracting on chapter-complete even when diagrams-extracted never arrives (fail-open path)', () => {
    const onFrame = vi.fn();
    const { result } = renderHook(() =>
      useStreamingChapter({ tutorialId: 'abc', chapterIdx: 0, onFrame }),
    );
    const es = createdInstances[0]!;
    act(() => {
      findListener(es, 'narrative-stream-complete')!(
        fakeMessageEvent({ chapterId: 'ch-abc' }),
      );
    });
    expect(result.current.isExtracting).toBe(true);

    // Extraction fail-open: no diagrams-extracted frame arrives; the
    // chapter-complete frame is the bulkhead-safe place to clear the
    // indicator. Counts stay null (no structured diagrams this run).
    act(() => {
      findListener(es, 'chapter-complete')!(
        fakeMessageEvent({ chapterId: 'ch-abc', questionsCount: 5 }),
      );
    });
    expect(result.current.isExtracting).toBe(false);
    expect(result.current.extractedDiagramCount).toBeNull();
    expect(result.current.extractedDroppedCount).toBeNull();
  });

  it('resets extraction-indicator state when chapterIdx changes', () => {
    const onFrame = vi.fn();
    const { result, rerender } = renderHook(
      ({ chapterIdx }: { chapterIdx: number }) =>
        useStreamingChapter({ tutorialId: 'abc', chapterIdx, onFrame }),
      { initialProps: { chapterIdx: 0 } },
    );
    const firstEs = createdInstances[0]!;
    act(() => {
      findListener(firstEs, 'narrative-stream-complete')!(
        fakeMessageEvent({ chapterId: 'ch-0' }),
      );
      findListener(firstEs, 'diagrams-extracted')!(
        fakeMessageEvent({ count: 2, droppedCount: 0, costUsd: 0.0005 }),
      );
    });
    expect(result.current.extractedDiagramCount).toBe(2);

    // Swap to a new chapter — counts must reset so the previous chapter's
    // numbers don't leak into the new chapter's UX before its own
    // diagrams-extracted frame arrives.
    rerender({ chapterIdx: 1 });
    expect(result.current.isExtracting).toBe(false);
    expect(result.current.extractedDiagramCount).toBeNull();
    expect(result.current.extractedDroppedCount).toBeNull();
  });

  it('handles a malformed diagrams-extracted payload without throwing or corrupting state', () => {
    const onFrame = vi.fn();
    const { result } = renderHook(() =>
      useStreamingChapter({ tutorialId: 'abc', chapterIdx: 0, onFrame }),
    );
    const es = createdInstances[0]!;
    const listener = findListener(es, 'diagrams-extracted')!;
    // Data is not valid JSON — safeParse returns null; the count branch is
    // a no-op. isExtracting is still cleared (it's set unconditionally).
    expect(() => {
      act(() => {
        listener(new MessageEvent('message', { data: 'not-json-at-all' }));
      });
    }).not.toThrow();
    expect(result.current.isExtracting).toBe(false);
    expect(result.current.extractedDiagramCount).toBeNull();
    expect(result.current.extractedDroppedCount).toBeNull();
  });
});
