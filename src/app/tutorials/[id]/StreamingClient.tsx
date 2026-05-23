'use client';

/**
 * src/app/tutorials/[id]/StreamingClient.tsx — client island for tutorial page.
 *
 * The Server Component (page.tsx) handles auth + initial data fetch + the
 * static page shell. This client island handles:
 *
 *   1. Opening the SSE stream via useStreamingChapter (which honors the
 *      riley CRITICAL-1 AbortController cleanup contract).
 *
 *   2. Routing incoming SSE frames to the right surface:
 *        - chapter-start → append a new chapter shell to state
 *        - token        → append to the currently-streaming chapter's narrative
 *        - chapter-complete → mark chapter as complete (allows quiz/flashcard render)
 *        - cost-update  → push fresh cost into the CostChip via live prop
 *        - done         → no further work; reviewer can engage
 *        - error        → surface the failure (esp. cost-cap-exceeded)
 *
 *   3. Rendering the page surfaces:
 *        - CostChip (header) — riley CRITICAL-cost-placement
 *        - CompletionTracker (sidebar) — riley HIGH-2 + HIGH-3
 *        - ChapterRenderer per-chapter (body) — omar HIGH-3 inline citations
 *        - FlashcardReviewer (footer) — riley HIGH-1 PARTIAL SM-2 prep
 *
 * Why one client island instead of many leaf islands:
 *   - The stream is single-source: tearing down on unmount has to be a
 *     single owner. Splitting into per-component clients would leak the
 *     EventSource lifetime across the tree.
 *   - State derived from the stream (current chapter, accumulated narrative,
 *     live cost) belongs to one reducer. Lifting it to a parent ensures
 *     consistency without prop-drilling — see kb:web-dev/react-essentials
 *     §"State-management cascade".
 *
 * State shape:
 *   - chapters: Map<chapterId, ChapterStreamState> — keyed for O(1) update
 *     on token frames (we look up by chapterId from the frame payload).
 *   - costUsdLive: number | undefined — most-recent SSE-pushed cost; flows
 *     into CostChip as the override prop.
 *
 * The `chapters` Map is a React-immutable updates concern: we replace it
 * (new Map(prev) + .set(id, next)) so React's referential-equality check
 * triggers re-render. Mutating in place would silently miss the update.
 */

import { useState, useCallback, useMemo, useEffect } from 'react';
import type { Chapter } from '@/db/schema';
import type { SourceParagraph } from '@/lib/types';
import { useStreamingChapter, type StreamFrame } from '@/hooks/useStreamingChapter';
import { ChapterRenderer } from '@/components/ChapterRenderer';
import { CostChip } from '@/components/CostChip';
import { CompletionTracker } from '@/components/CompletionTracker';
import { FlashcardReviewer, type ReviewableCard } from '@/components/FlashcardReviewer';

// ───────────────────────────────────────────────────────────────────────────
// Props (passed down from the Server Component)
// ───────────────────────────────────────────────────────────────────────────

export interface StreamingClientProps {
  tutorialId: string;
  /** Initial chapters as known at SSR time — may be empty for fresh streams. */
  initialChapters: Chapter[];
  /** Initial reviewable cards (joined flashcards + srs_reviews); may be empty. */
  initialReviewCards: ReviewableCard[];
  /** CSRF token read from cookie server-side; safe to pass to client island. */
  csrfToken: string;
}

// ───────────────────────────────────────────────────────────────────────────
// Client-side streaming state
// ───────────────────────────────────────────────────────────────────────────

interface ChapterStreamState {
  /** Stable id from chapters table. */
  id: string;
  ordinal: number;
  title: string;
  /** Accumulated narrative text — grows as tokens stream in. */
  narrative: string;
  /** Status: 'streaming' until chapter-complete, then 'complete'. */
  status: 'streaming' | 'complete' | 'failed';
  /** SourceParagraph index for citation resolution. */
  sourceParagraphs: SourceParagraph[];
}

// ───────────────────────────────────────────────────────────────────────────
// Frame payload shapes (per SSE contract in spawn brief)
// ───────────────────────────────────────────────────────────────────────────

interface ChapterStartPayload {
  chapterId: string;
  ordinal: number;
  title: string;
  sourceParagraphs?: SourceParagraph[];
}

interface TokenPayload {
  chapterId: string;
  kind: 'narrative' | 'question' | 'flashcard';
  delta: string;
}

interface ChapterCompletePayload {
  chapterId: string;
}

interface CostUpdatePayload {
  costUsd: number;
}

interface ErrorPayload {
  code: string;
  message?: string;
}

// ───────────────────────────────────────────────────────────────────────────
// Helpers — narrow `unknown` SSE payloads into the typed shapes above
// ───────────────────────────────────────────────────────────────────────────

function asObject(x: unknown): Record<string, unknown> | null {
  return typeof x === 'object' && x !== null && !Array.isArray(x)
    ? (x as Record<string, unknown>)
    : null;
}

function parseChapterStart(data: unknown): ChapterStartPayload | null {
  const o = asObject(data);
  if (!o) return null;
  if (typeof o.chapterId !== 'string') return null;
  if (typeof o.ordinal !== 'number') return null;
  if (typeof o.title !== 'string') return null;
  // sourceParagraphs is optional — first frame may send it; subsequent
  // chapters in the same stream may rely on the cached server-side index.
  const sp = Array.isArray(o.sourceParagraphs)
    ? (o.sourceParagraphs as SourceParagraph[])
    : [];
  return {
    chapterId: o.chapterId,
    ordinal: o.ordinal,
    title: o.title,
    sourceParagraphs: sp,
  };
}

function parseToken(data: unknown): TokenPayload | null {
  const o = asObject(data);
  if (!o) return null;
  if (typeof o.chapterId !== 'string') return null;
  if (typeof o.delta !== 'string') return null;
  const kind =
    o.kind === 'narrative' || o.kind === 'question' || o.kind === 'flashcard'
      ? o.kind
      : 'narrative';
  return { chapterId: o.chapterId, kind, delta: o.delta };
}

function parseChapterComplete(data: unknown): ChapterCompletePayload | null {
  const o = asObject(data);
  if (!o) return null;
  if (typeof o.chapterId !== 'string') return null;
  return { chapterId: o.chapterId };
}

function parseCostUpdate(data: unknown): CostUpdatePayload | null {
  const o = asObject(data);
  if (!o) return null;
  if (typeof o.costUsd !== 'number' || !Number.isFinite(o.costUsd)) return null;
  return { costUsd: o.costUsd };
}

function parseErrorPayload(data: unknown): ErrorPayload | null {
  const o = asObject(data);
  if (!o) return null;
  if (typeof o.code !== 'string') return null;
  const message = typeof o.message === 'string' ? o.message : undefined;
  return { code: o.code, message };
}

// ───────────────────────────────────────────────────────────────────────────
// Convert an initial Chapter row into the streaming state shape
// ───────────────────────────────────────────────────────────────────────────

function chapterRowToStreamState(c: Chapter): ChapterStreamState {
  // source_paragraphs_json is a JSON-stringified SourceParagraph[]; parse
  // defensively. On parse failure, empty array = citations won't resolve
  // (CitationModal shows the "not found" empty state).
  let sp: SourceParagraph[] = [];
  try {
    const parsed = JSON.parse(c.sourceParagraphsJson) as unknown;
    if (Array.isArray(parsed)) sp = parsed as SourceParagraph[];
  } catch {
    sp = [];
  }
  return {
    id: c.id,
    ordinal: c.ordinal,
    title: c.title,
    narrative: c.narrative ?? '',
    status: c.status === 'complete' ? 'complete' : c.status === 'failed' ? 'failed' : 'streaming',
    sourceParagraphs: sp,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Component
// ───────────────────────────────────────────────────────────────────────────

export function StreamingClient(props: StreamingClientProps) {
  const { tutorialId, initialChapters, initialReviewCards, csrfToken } = props;

  // Map<chapterId, ChapterStreamState> — seeded from SSR.
  const [chapterMap, setChapterMap] = useState<Map<string, ChapterStreamState>>(() => {
    const m = new Map<string, ChapterStreamState>();
    for (const c of initialChapters) m.set(c.id, chapterRowToStreamState(c));
    return m;
  });
  const [costUsdLive, setCostUsdLive] = useState<number | undefined>(undefined);
  const [protocolError, setProtocolError] = useState<{ code: string; message?: string } | null>(
    null,
  );

  /**
   * Stable frame handler — passed to useStreamingChapter. Memoized to avoid
   * triggering the hook's effect on every render.
   */
  const handleFrame = useCallback((frame: StreamFrame): void => {
    switch (frame.event) {
      case 'chapter-start': {
        const payload = parseChapterStart(frame.data);
        if (!payload) return;
        setChapterMap((prev) => {
          const next = new Map(prev);
          // Idempotent: if chapter exists already (SSR seeded it), keep its
          // accumulated narrative but reset status to streaming.
          const existing = next.get(payload.chapterId);
          next.set(payload.chapterId, {
            id: payload.chapterId,
            ordinal: payload.ordinal,
            title: payload.title,
            narrative: existing?.narrative ?? '',
            status: 'streaming',
            // Prefer the just-arrived sourceParagraphs over the seeded value
            // when the server sends a fresh index (it usually means the
            // chapter content was regenerated and refs may have shifted).
            sourceParagraphs:
              payload.sourceParagraphs.length > 0
                ? payload.sourceParagraphs
                : existing?.sourceParagraphs ?? [],
          });
          return next;
        });
        return;
      }
      case 'token': {
        const payload = parseToken(frame.data);
        if (!payload) return;
        // Only narrative tokens append to the inline display. Question and
        // flashcard tokens stream into separate surfaces (out of scope for
        // this iteration — we collect but don't yet render them inline).
        if (payload.kind !== 'narrative') return;
        setChapterMap((prev) => {
          const existing = prev.get(payload.chapterId);
          if (!existing) {
            // Token arrived before chapter-start — defensive: create a stub
            // with the chapterId so subsequent frames have a home.
            const next = new Map(prev);
            next.set(payload.chapterId, {
              id: payload.chapterId,
              ordinal: prev.size,
              title: '(loading…)',
              narrative: payload.delta,
              status: 'streaming',
              sourceParagraphs: [],
            });
            return next;
          }
          const next = new Map(prev);
          next.set(payload.chapterId, {
            ...existing,
            narrative: existing.narrative + payload.delta,
          });
          return next;
        });
        return;
      }
      case 'chapter-complete': {
        const payload = parseChapterComplete(frame.data);
        if (!payload) return;
        setChapterMap((prev) => {
          const existing = prev.get(payload.chapterId);
          if (!existing) return prev;
          const next = new Map(prev);
          next.set(payload.chapterId, { ...existing, status: 'complete' });
          return next;
        });
        return;
      }
      case 'cost-update': {
        const payload = parseCostUpdate(frame.data);
        if (!payload) return;
        setCostUsdLive(payload.costUsd);
        return;
      }
      case 'error': {
        const payload = parseErrorPayload(frame.data);
        if (!payload) {
          setProtocolError({ code: 'unknown', message: 'stream emitted unparseable error' });
          return;
        }
        setProtocolError(payload);
        return;
      }
      case 'done':
      default:
        return;
    }
  }, []);

  const { status, error, cancel, reconnectCount } = useStreamingChapter({
    tutorialId,
    onFrame: handleFrame,
  });

  // Reflect hook-level errors into the protocol-error surface too (so the
  // user sees a clear failure on EventSource exhaustion).
  useEffect(() => {
    if (error !== null && protocolError === null) {
      // The hook sets a generic Error; encode it into our shape.
      const code = (error as Error & { code?: string }).code ?? 'stream-failed';
      setProtocolError({ code, message: error.message });
    }
  }, [error, protocolError]);

  // Sort chapters by ordinal for stable display.
  const orderedChapters = useMemo(() => {
    return Array.from(chapterMap.values()).sort((a, b) => a.ordinal - b.ordinal);
  }, [chapterMap]);

  // Convert ChapterStreamState[] back to Chapter-shaped objects for the
  // CompletionTracker. Synthesize the observational fields from what the
  // server tells us; nullable fields default to null (matches schema shape).
  // NB: this is a READ projection — we don't write back to the DB from here.
  const completionChapters = useMemo<Chapter[]>(() => {
    return orderedChapters.map(
      (c) =>
        ({
          id: c.id,
          tutorialId: tutorialId,
          ordinal: c.ordinal,
          title: c.title,
          narrative: c.narrative,
          sourcePageStart: 0,
          sourcePageEnd: 0,
          sourceParagraphsJson: '[]',
          status: c.status === 'complete' ? 'complete' : 'generating',
          isRead: c.status === 'complete',
          // riley HIGH-2 fields: read from local interaction tracker (out of
          // scope for this iteration to wire fully — for streaming-time we
          // leave them null and the CompletionTracker reflects that honestly).
          viewedAt: c.status === 'complete' ? new Date() : null,
          scrollDepthPct: null,
          timeSpentSeconds: 0,
          lastQuizAttemptAt: null,
          lastQuizScore: null,
        }) satisfies Chapter,
    );
  }, [orderedChapters, tutorialId]);

  return (
    <div className="space-y-6">
      {/* Header — CostChip is sticky-equivalent: always visible at the top
          of the tutorial body. riley CRITICAL-cost-placement compliance. */}
      <header className="sticky top-0 z-10 -mx-4 flex items-center justify-between gap-4 border-b border-border bg-background/95 px-4 py-3 backdrop-blur">
        <h1 className="truncate text-lg font-semibold">Tutorial</h1>
        <div className="flex items-center gap-3">
          <CostChip tutorialId={tutorialId} costUsdLive={costUsdLive} />
          <StreamStatusBadge status={status} reconnectCount={reconnectCount} />
          {status === 'streaming' || status === 'reconnecting' ? (
            <button
              type="button"
              onClick={cancel}
              className="text-xs text-muted-foreground hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
            >
              Stop
            </button>
          ) : null}
        </div>
      </header>

      {/* Error banner — surfaces protocol errors prominently */}
      {protocolError !== null ? (
        <ProtocolErrorBanner code={protocolError.code} message={protocolError.message} />
      ) : null}

      {/* Body — chapters + sidebar */}
      <div className="grid gap-6 lg:grid-cols-[1fr_18rem]">
        <article className="space-y-8 min-w-0">
          {orderedChapters.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Waiting for the first chapter…
            </p>
          ) : (
            orderedChapters.map((c) => (
              <section key={c.id} aria-labelledby={`ch-${c.id}-title`}>
                <h2
                  id={`ch-${c.id}-title`}
                  className="mb-3 text-xl font-semibold tracking-tight"
                >
                  {c.ordinal + 1}. {c.title}
                </h2>
                <ChapterRenderer
                  narrative={c.narrative}
                  sourceParagraphs={c.sourceParagraphs}
                />
                {c.status === 'streaming' ? (
                  <p
                    aria-live="polite"
                    className="mt-2 text-xs italic text-muted-foreground"
                  >
                    Generating…
                  </p>
                ) : null}
              </section>
            ))
          )}
        </article>

        <aside className="space-y-4">
          <CompletionTracker chapters={completionChapters} />
        </aside>
      </div>

      {/* Reviewer — appears once cards are available */}
      {initialReviewCards.length > 0 ? (
        <section aria-labelledby="reviewer-heading" className="mt-8">
          <h2 id="reviewer-heading" className="mb-3 text-lg font-semibold">
            Flashcards due
          </h2>
          <FlashcardReviewer cards={initialReviewCards} csrfToken={csrfToken} />
        </section>
      ) : null}
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Sub-components (file-private)
// ───────────────────────────────────────────────────────────────────────────

interface StreamStatusBadgeProps {
  status: ReturnType<typeof useStreamingChapter>['status'];
  reconnectCount: number;
}

function StreamStatusBadge({ status, reconnectCount }: StreamStatusBadgeProps) {
  // Mapping from machine state → user-readable label.
  const label = STATUS_LABEL[status];
  const className = STATUS_CLASSES[status];
  // Reconnecting variant: append attempt counter so the user sees we're
  // trying. We don't update aria-live for every retry — that would interrupt
  // their reading; the badge update is enough.
  const display =
    status === 'reconnecting' && reconnectCount > 0
      ? `${label} (${reconnectCount})`
      : label;
  return (
    <span
      role="status"
      aria-live="polite"
      aria-label={`Stream status: ${display}`}
      className={`inline-flex items-center rounded-full px-2 py-1 text-[10px] font-medium uppercase tracking-wide ${className}`}
    >
      {display}
    </span>
  );
}

const STATUS_LABEL: Record<ReturnType<typeof useStreamingChapter>['status'], string> = {
  idle: 'idle',
  connecting: 'connecting',
  streaming: 'streaming',
  reconnecting: 'reconnecting',
  done: 'done',
  failed: 'failed',
};

const STATUS_CLASSES: Record<ReturnType<typeof useStreamingChapter>['status'], string> = {
  idle: 'bg-muted text-muted-foreground',
  connecting: 'bg-secondary text-secondary-foreground',
  streaming: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300',
  reconnecting: 'bg-amber-100 text-amber-900 dark:bg-amber-950/40 dark:text-amber-300',
  done: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300',
  failed: 'bg-destructive/10 text-destructive',
};

interface ProtocolErrorBannerProps {
  code: string;
  message?: string;
}

function ProtocolErrorBanner({ code, message }: ProtocolErrorBannerProps) {
  // Specific copy for cost-cap exhaustion per the spawn brief.
  const text =
    code === 'cost-cap-exceeded'
      ? 'Cost cap reached — generation paused. Adjust COST_CAP_USD in .env to continue.'
      : message ?? `Stream error: ${code}`;
  return (
    <div
      role="alert"
      className="rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive"
    >
      {text}
    </div>
  );
}
