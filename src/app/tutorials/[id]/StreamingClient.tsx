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
import { useRouter } from 'next/navigation';
import type { Chapter } from '@/db/schema';
import type { SourceParagraph, QuizQuestion, LLMFlashcard } from '@/lib/types';
import { useStreamingChapter, type StreamFrame } from '@/hooks/useStreamingChapter';
import { ChapterLessons } from '@/components/ChapterLessons';
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
  /**
   * Quiz questions per chapter, loaded from DB at SSR time. Persona-Sprint-A
   * fix (T1.1): without this, a returning user never saw the quiz that was
   * generated mid-stream — `parsedQuestions` only got populated from the live
   * stream, never from DB. Now the page-server hydrates these and the client
   * uses them to seed `ChapterStreamState.parsedQuestions`.
   *
   * Keyed by chapter.id. Empty for chapters that haven't been generated yet.
   */
  initialQuestionsByChapter?: Record<string, QuizQuestion[]>;
  /**
   * Flashcards per chapter, loaded from DB at SSR time. Mirror of
   * `initialQuestionsByChapter` for the per-chapter flashcards inline
   * surface (the FlashcardReviewer's `initialReviewCards` is a separate
   * "due today" stream and remains its own panel).
   */
  initialFlashcardsByChapter?: Record<string, LLMFlashcard[]>;
  /** CSRF token read from cookie server-side; safe to pass to client island. */
  csrfToken: string;
  /**
   * Lazy-hybrid-chunking gating ratchet (Commit 3). Chapters with
   * ordinal < this value are released for reading; chapters at or above
   * this value are locked behind the preceding chapter's completion.
   * Initialized to 0 at ingest (chapter 0 visible only).
   */
  maxUnlockedChapterIdx: number;
}

// ───────────────────────────────────────────────────────────────────────────
// Client-side streaming state
// ───────────────────────────────────────────────────────────────────────────

interface ChapterStreamState {
  /** Stable id from chapters table. */
  id: string;
  ordinal: number;
  title: string;
  /** Accumulated narrative text — grows as tokens stream in. Holds raw JSON
   *  while the LLM emits structured output; parsed into parsedNarrative on
   *  chapter-complete. See FINDING-RENDER-1 fix. */
  narrative: string;
  /** Status: 'streaming' until chapter-complete, then 'complete'. */
  status: 'streaming' | 'complete' | 'failed';
  /** SourceParagraph index for citation resolution. */
  sourceParagraphs: SourceParagraph[];
  /** Markdown narrative parsed out of the structured-output JSON. Only set
   *  once the chapter completes and the JSON parses cleanly. */
  parsedNarrative?: string;
  /** Quiz questions parsed out of the structured-output JSON. */
  parsedQuestions?: QuizQuestion[];
  /** Flashcards parsed out of the structured-output JSON. */
  parsedFlashcards?: LLMFlashcard[];
}

/**
 * Parse the accumulated streaming JSON into typed parts.
 * Returns null if the text isn't valid JSON yet (mid-stream) or if the shape
 * doesn't match the expected chapter-gen contract.
 * FINDING-RENDER-1 (Phase 5).
 */
function parseStructuredChapter(text: string): {
  narrative: string;
  questions: QuizQuestion[];
  flashcards: LLMFlashcard[];
} | null {
  if (!text || text[0] !== '{') return null;
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof obj !== 'object' || obj === null) return null;
  const o = obj as Record<string, unknown>;
  if (typeof o.narrative !== 'string') return null;
  const questions = Array.isArray(o.questions) ? (o.questions as QuizQuestion[]) : [];
  const flashcards = Array.isArray(o.flashcards) ? (o.flashcards as LLMFlashcard[]) : [];
  return { narrative: o.narrative, questions, flashcards };
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

function chapterRowToStreamState(
  c: Chapter,
  hydratedQuestions?: QuizQuestion[],
  hydratedFlashcards?: LLMFlashcard[],
): ChapterStreamState {
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
  // For SSR-hydrated rows that are already complete, the worker persists the
  // narrative-only markdown (NOT the full JSON), and questions/flashcards
  // land in their own tables. The parent page.tsx (post-T1.1) loads them
  // and hands them in via `hydratedQuestions` / `hydratedFlashcards`.
  //
  // Fallback chain for questions/flashcards:
  //   1. hydrated* (from DB-load at SSR) — the new path
  //   2. parseStructuredChapter(raw) — legacy path for rows where the
  //      worker stashed the full JSON under chapter.narrative
  //   3. undefined — fresh chapter, nothing to render yet
  const raw = c.narrative ?? '';
  const parsedFromJson = c.status === 'complete' ? parseStructuredChapter(raw) : null;
  const isReadable = c.status === 'complete' || c.status === 'partial';
  const parsedNarrative =
    parsedFromJson?.narrative ??
    (isReadable ? raw : undefined);
  const questions =
    hydratedQuestions && hydratedQuestions.length > 0
      ? hydratedQuestions
      : parsedFromJson?.questions;
  const flashcards =
    hydratedFlashcards && hydratedFlashcards.length > 0
      ? hydratedFlashcards
      : parsedFromJson?.flashcards;
  return {
    id: c.id,
    ordinal: c.ordinal,
    title: c.title,
    narrative: raw,
    status: isReadable ? 'complete' : c.status === 'failed' ? 'failed' : 'streaming',
    sourceParagraphs: sp,
    parsedNarrative,
    parsedQuestions: questions,
    parsedFlashcards: flashcards,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Component
// ───────────────────────────────────────────────────────────────────────────

export function StreamingClient(props: StreamingClientProps) {
  const {
    tutorialId,
    initialChapters,
    initialReviewCards,
    initialQuestionsByChapter,
    initialFlashcardsByChapter,
    csrfToken,
    maxUnlockedChapterIdx,
  } = props;
  const router = useRouter();

  // Map<chapterId, ChapterStreamState> — seeded from SSR.
  // Persona-Sprint-A T1.1 fix: questions + flashcards now come in via
  // initialQuestionsByChapter / initialFlashcardsByChapter (loaded from
  // DB by page.tsx). Without this, a returning user never saw the quiz
  // that was generated during the prior live stream.
  const [chapterMap, setChapterMap] = useState<Map<string, ChapterStreamState>>(() => {
    const m = new Map<string, ChapterStreamState>();
    for (const c of initialChapters) {
      m.set(
        c.id,
        chapterRowToStreamState(
          c,
          initialQuestionsByChapter?.[c.id],
          initialFlashcardsByChapter?.[c.id],
        ),
      );
    }
    return m;
  });
  const [costUsdLive, setCostUsdLive] = useState<number | undefined>(undefined);
  const [protocolError, setProtocolError] = useState<{ code: string; message?: string } | null>(
    null,
  );

  // Persona-Sprint-A T2.6: quiz-attempt tracking. Keyed by chapterId; true
  // means the user has clicked "Check answers" at least once for that
  // chapter's quiz. Gates the Mark Complete button.
  //
  // Why client-only (not persisted to DB): the server already enforces
  // chapter completion semantics via release-policy.ts when the user
  // actually clicks Mark Complete. Persisting attempt-state is Sprint B
  // (last_quiz_attempt_at is already in the schema; wiring it through
  // the per-attempt POST is a separate change).
  const [quizAttemptedByChapter, setQuizAttemptedByChapter] = useState<Map<string, boolean>>(
    () => new Map(),
  );
  const markQuizAttempted = useCallback((chapterId: string) => {
    setQuizAttemptedByChapter((prev) => {
      if (prev.get(chapterId) === true) return prev;
      const next = new Map(prev);
      next.set(chapterId, true);
      return next;
    });
  }, []);

  /**
   * Stable frame handler — passed to useStreamingChapter. Memoized to avoid
   * triggering the hook's effect on every render.
   */
  const handleFrame = useCallback((frame: StreamFrame): void => {
    // DRIFT-test3-021 fix: clear any stale protocolError as soon as a
    // successful frame (anything that's not 'error') arrives. This handles
    // the common case where the EventSource hit a 409 during the tutorial-
    // is-still-ingesting window, synthesized a Protocol Error, then
    // reconnected and got a healthy stream — without this reset, the red
    // banner would persist for the rest of the session.
    if (frame.event !== 'error') {
      setProtocolError((prev) => (prev === null ? prev : null));
    }
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
          const parsed = parseStructuredChapter(existing.narrative);
          next.set(payload.chapterId, {
            ...existing,
            status: 'complete',
            parsedNarrative: parsed?.narrative,
            parsedQuestions: parsed?.questions,
            parsedFlashcards: parsed?.flashcards,
          });
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

  // ── DRIFT-test3-019: per-chapter SSE ───────────────────────────────
  //
  // Compute the currently-active chapter ordinal: the lowest-ordinal chapter
  // that is BOTH (a) unlocked per the server-side ratchet
  // (ordinal <= maxUnlockedChapterIdx) AND (b) not yet complete from the
  // reader's perspective.
  //
  // There is at most ONE active chapter at a time because the ratchet is
  // monotonic and gating is one-way. When the active chapter completes and
  // the user clicks Mark Complete, the server bumps the ratchet and
  // router.refresh() re-runs the parent Server Component; that re-render
  // hands us a new maxUnlockedChapterIdx and an updated initialChapters row
  // marked complete, so activeChapterIdx flips to the next ordinal.
  //
  // useStreamingChapter sees chapterIdx change in deps → tears down the old
  // EventSource and opens a fresh one targeted at the new chapter. No clean
  // navigation required (the old failure mode this fix addresses).
  //
  // If no chapter is currently active (all unlocked chapters complete, or
  // user hasn't started yet), pass paused=true so the hook holds idle and
  // doesn't open a stream. The "all unlocked chapters complete" state is
  // the natural waiting room for the next Mark Complete.
  const activeChapterIdx = useMemo<number | undefined>(() => {
    const sorted = Array.from(chapterMap.values()).sort((a, b) => a.ordinal - b.ordinal);
    for (const c of sorted) {
      if (c.ordinal > maxUnlockedChapterIdx) break; // ratchet boundary
      const initialRow = initialChapters.find((ic) => ic.id === c.id);
      const isComplete =
        c.status === 'complete' ||
        (initialRow?.status === 'complete' || initialRow?.status === 'partial');
      if (!isComplete) return c.ordinal;
    }
    return undefined;
  }, [chapterMap, initialChapters, maxUnlockedChapterIdx]);

  const { status, error, cancel, reconnectCount } = useStreamingChapter({
    tutorialId,
    chapterIdx: activeChapterIdx,
    onFrame: handleFrame,
    paused: activeChapterIdx === undefined,
  });

  // Reflect hook-level errors into the protocol-error surface too (so the
  // user sees a clear failure on EventSource exhaustion).
  //
  // DRIFT-test3-021 fix: only surface the hook's error when the connection
  // is ACTUALLY in a failure state (status='failed') — not during a
  // transient reconnect that may have already recovered. The frame handler
  // resets protocolError when healthy frames arrive; that reset would be
  // immediately undone by this effect if it weren't gated on status.
  useEffect(() => {
    if (status !== 'failed') return;
    if (error !== null && protocolError === null) {
      // The hook sets a generic Error; encode it into our shape.
      const code = (error as Error & { code?: string }).code ?? 'stream-failed';
      setProtocolError({ code, message: error.message });
    }
  }, [error, protocolError, status]);

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
          // ── lazy-hybrid-chunking (0001 migration) defaults for the synthetic
          // projection. Real values land server-side; these stub-defaults keep
          // the CompletionTracker type-safe during streaming hydration.
          classification: 'body' as const,
          chunkS3Key: null,
          parentChapterId: null,
          depth: 0,
          releasedAt: c.status === 'complete' ? new Date() : null,
          completionCriteriaMet: false,
          paragraphCount: 0,
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
            orderedChapters.map((c) => {
              // ── Commit 3 gating: chapters above the ratchet are LOCKED ──
              // The ratchet is server-side; client-side gating is UX, not
              // security. The server's stream endpoint filters by released_at
              // so locked chapters' content is never generated either.
              const isLocked = c.ordinal >= maxUnlockedChapterIdx + 1;
              if (isLocked) {
                return (
                  <LockedChapterCard
                    key={c.id}
                    ordinal={c.ordinal}
                    title={c.title}
                    completePrevOrdinal={maxUnlockedChapterIdx}
                  />
                );
              }
              // Find the corresponding original chapter row for completion
              // metadata (completionCriteriaMet — used to decide Mark Complete
              // CTA visibility).
              const initialRow = initialChapters.find((ic) => ic.id === c.id);
              const alreadyMarkedComplete = initialRow?.completionCriteriaMet === true;
              const canMarkComplete =
                (c.status === 'complete' || c.parsedNarrative !== undefined) &&
                !alreadyMarkedComplete;
              return (
                <section key={c.id} aria-labelledby={`ch-${c.id}-title`}>
                  <h2
                    id={`ch-${c.id}-title`}
                    className="mb-3 text-xl font-semibold tracking-tight"
                  >
                    {c.ordinal + 1}. {c.title}
                  </h2>
                  {c.status === 'streaming' ? (
                    <StreamingProgressIndicator receivedChars={c.narrative.length} />
                  ) : c.parsedNarrative !== undefined ? (
                    // Feature A — multipage chapters. ChapterLessons parses
                    // the narrative into lessons and renders one at a time.
                    // The quiz / flashcards / Mark Complete are passed as a
                    // render-prop and only appear on the LAST lesson (or
                    // immediately, for pre-Feature-A chapters with no
                    // lesson markers — graceful degradation via single-
                    // lesson fallback in parseLessons).
                    <ChapterLessons
                      narrative={c.parsedNarrative}
                      sourceParagraphs={c.sourceParagraphs}
                      renderLastLessonExtras={() => {
                        // T2.6 gate: Mark Complete is blocked until the user
                        // has clicked "Check answers" on the chapter's quiz
                        // (or there is no quiz to attempt). Per the Sprint A
                        // user-pick: "attempted, no pass required".
                        const hasQuiz =
                          (c.parsedQuestions?.length ?? 0) > 0;
                        const quizAttempted =
                          quizAttemptedByChapter.get(c.id) === true;
                        const quizGateOk = !hasQuiz || quizAttempted;
                        return (
                          <>
                            {c.parsedQuestions && c.parsedQuestions.length > 0 ? (
                              <QuizQuestions
                                questions={c.parsedQuestions}
                                sourceParagraphs={c.sourceParagraphs}
                                onAttempt={() => markQuizAttempted(c.id)}
                              />
                            ) : null}
                            {c.parsedFlashcards && c.parsedFlashcards.length > 0 ? (
                              <ChapterFlashcards flashcards={c.parsedFlashcards} />
                            ) : null}
                            {canMarkComplete ? (
                              <MarkCompleteButton
                                tutorialId={tutorialId}
                                chapterOrdinal={c.ordinal}
                                csrfToken={csrfToken}
                                onSuccess={() => router.refresh()}
                                disabled={!quizGateOk}
                                disabledReason={
                                  hasQuiz && !quizAttempted
                                    ? 'Attempt the quiz above to unlock'
                                    : undefined
                                }
                              />
                            ) : alreadyMarkedComplete ? (
                              <p className="mt-4 inline-flex items-center gap-1 rounded-full bg-emerald-100 px-3 py-1 text-xs font-medium text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300">
                                ✓ Chapter complete
                              </p>
                            ) : null}
                          </>
                        );
                      }}
                    />
                  ) : c.status === 'failed' ? (
                    <p className="rounded border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                      This chapter failed to generate. Retry the tutorial to regenerate.
                    </p>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      Chapter complete, but the response could not be parsed.
                    </p>
                  )}
                </section>
              );
            })
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
  // Persona-Sprint-A T2.5 fix: hide the badge entirely when the stream is
  // idle. Showing `IDLE` to a reader on a fully-loaded tutorial is opaque
  // developer-state leaking into the UX. We still render — with the
  // appropriate label — for streaming / reconnecting / completed / errored
  // states where the status carries information the user actually wants.
  if (status === 'idle') {
    return null;
  }
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

// ───────────────────────────────────────────────────────────────────────────
// Per-chapter inline surfaces (FINDING-RENDER-1 fix, Phase 5)
// ───────────────────────────────────────────────────────────────────────────

function StreamingProgressIndicator({ receivedChars }: { receivedChars: number }) {
  // Show progress as a friendly chip while the LLM emits structured JSON.
  // We deliberately do NOT show the raw JSON — it's visually noisy and
  // unhelpful to the reader. Once chapter-complete fires, the parent
  // re-renders this section as markdown + questions + flashcards.
  return (
    <div className="rounded-md border border-dashed border-border bg-muted/30 px-4 py-6 text-center">
      <p
        aria-live="polite"
        className="text-sm italic text-muted-foreground"
      >
        Generating chapter…
      </p>
      <p className="mt-1 text-xs text-muted-foreground/70">
        {receivedChars.toLocaleString()} chars received
      </p>
    </div>
  );
}

interface QuizQuestionsProps {
  questions: QuizQuestion[];
  sourceParagraphs: SourceParagraph[];
}

/**
 * Persona-Sprint-A T2.6: make the quiz interactive + report attempt status.
 *
 * Pre-Sprint-A behavior was an inert answer key in a `<details>` block —
 * users could click "Mark complete" without engaging with the questions
 * at all. That defeated the lazy-hybrid-chunking gate's pedagogical
 * intent (release-policy.ts requires meaningful chapter completion; the
 * UI undermined it).
 *
 * New behavior:
 *   - Render radio inputs per question.
 *   - User selects answers; clicking "Check answers" reveals correctness
 *     + computes a score.
 *   - Calling `onAttempt(true)` propagates to the parent so the Mark
 *     Complete button can ungate. Attempt-once, not pass-required (per
 *     user-pick during Sprint A planning: "Block until quiz attempted,
 *     no pass required").
 *
 * Why <details> wrapper retained: keeps the quiz collapsible so it
 * doesn't dominate the lesson canvas, but unlike before, opening it
 * exposes interactive controls rather than a cheat sheet.
 */
interface QuizQuestionsInteractiveProps extends QuizQuestionsProps {
  onAttempt?: () => void;
}

function QuizQuestions({ questions, onAttempt }: QuizQuestionsInteractiveProps) {
  // Per-question selected option index. -1 = unselected.
  const [selected, setSelected] = useState<number[]>(() =>
    questions.map(() => -1),
  );
  const [checked, setChecked] = useState(false);

  // T2.6 hook: fire `onAttempt` exactly once, when the user first reveals
  // the answers. Subsequent clicks (e.g., re-checks after changing a
  // selection) don't refire because the parent only cares whether the
  // chapter has been engaged with at all.
  const handleCheck = useCallback(() => {
    if (checked) return;
    setChecked(true);
    onAttempt?.();
  }, [checked, onAttempt]);

  const handleSelect = useCallback((qIdx: number, optIdx: number) => {
    setSelected((prev) => {
      const next = [...prev];
      next[qIdx] = optIdx;
      return next;
    });
  }, []);

  // Score is only shown after the user checks. Counts items where the
  // user selected the correct option index.
  const correctCount = checked
    ? selected.reduce<number>(
        (acc, optIdx, qIdx) =>
          acc + (optIdx === questions[qIdx]?.correctIndex ? 1 : 0),
        0,
      )
    : 0;
  const answeredCount = selected.filter((s) => s >= 0).length;

  return (
    <details className="mt-6 rounded border border-border bg-card/40" open={checked}>
      <summary className="cursor-pointer px-4 py-2 text-sm font-medium hover:bg-accent/30">
        Quiz · {questions.length} question{questions.length === 1 ? '' : 's'}
        {checked ? (
          <span className="ml-2 text-xs font-normal text-muted-foreground">
            (you scored {correctCount} / {questions.length})
          </span>
        ) : null}
      </summary>
      <ol className="space-y-5 px-4 py-3 text-sm">
        {questions.map((q, i) => {
          const userPick = selected[i] ?? -1;
          return (
            <li key={i} className="space-y-2">
              <p className="font-medium">
                {i + 1}. {q.prompt}
              </p>
              <ul className="ml-1 space-y-1.5">
                {q.options.map((opt, j) => {
                  const isUserPick = userPick === j;
                  const isCorrect = j === q.correctIndex;
                  // Highlight: only after check. Before check: just the
                  // selected radio. After check: green = correct,
                  // red = user's wrong pick.
                  let tone = '';
                  if (checked) {
                    if (isCorrect)
                      tone = 'text-emerald-700 dark:text-emerald-300';
                    else if (isUserPick)
                      tone = 'text-destructive line-through opacity-70';
                  }
                  return (
                    <li key={j}>
                      <label className={`flex items-start gap-2 cursor-pointer rounded px-2 py-1 hover:bg-accent/20 ${tone}`}>
                        <input
                          type="radio"
                          name={`q-${i}`}
                          value={j}
                          checked={isUserPick}
                          disabled={checked}
                          onChange={() => handleSelect(i, j)}
                          className="mt-0.5"
                        />
                        <span>{opt}</span>
                        {checked && isCorrect ? <span aria-label="Correct answer">✓</span> : null}
                      </label>
                    </li>
                  );
                })}
              </ul>
              {checked && q.explanation ? (
                <p className="text-xs italic text-muted-foreground border-l-2 border-border pl-2">
                  {q.explanation}
                </p>
              ) : null}
            </li>
          );
        })}
      </ol>
      <div className="border-t border-border px-4 py-2 flex items-center justify-between">
        {!checked ? (
          <>
            <span className="text-xs text-muted-foreground">
              {answeredCount} / {questions.length} answered
            </span>
            <button
              type="button"
              onClick={handleCheck}
              disabled={answeredCount === 0}
              className="rounded bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Check answers
            </button>
          </>
        ) : (
          <span className="text-xs text-muted-foreground">
            You scored <strong className="text-foreground">{correctCount} / {questions.length}</strong>
            {correctCount === questions.length ? ' — perfect!' : null}
          </span>
        )}
      </div>
    </details>
  );
}

function ChapterFlashcards({ flashcards }: { flashcards: LLMFlashcard[] }) {
  return (
    <details className="mt-3 rounded border border-border bg-card/40">
      <summary className="cursor-pointer px-4 py-2 text-sm font-medium hover:bg-accent/30">
        Flashcards · {flashcards.length}
      </summary>
      <ul className="grid gap-2 px-4 py-3 text-sm sm:grid-cols-2">
        {flashcards.map((f, i) => (
          <li
            key={i}
            className="rounded border border-border/60 bg-background px-3 py-2"
          >
            <p className="font-medium">{f.front}</p>
            <p className="mt-1 text-xs text-muted-foreground">{f.back}</p>
          </li>
        ))}
      </ul>
    </details>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Gating UI (Commit 3) — locked card + mark-complete button
// ───────────────────────────────────────────────────────────────────────────

interface LockedChapterCardProps {
  ordinal: number;
  title: string;
  completePrevOrdinal: number;
}

function LockedChapterCard({ ordinal, title, completePrevOrdinal }: LockedChapterCardProps) {
  return (
    <section
      aria-label={`Chapter ${ordinal + 1} locked`}
      className="rounded-md border border-dashed border-border bg-muted/20 px-4 py-5"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Locked</p>
          <h3 className="mt-1 truncate text-base font-medium text-muted-foreground">
            {ordinal + 1}. {title}
          </h3>
        </div>
        <span aria-hidden className="text-muted-foreground" title="Locked">
          🔒
        </span>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        Complete Chapter {completePrevOrdinal + 1} to unlock.
      </p>
    </section>
  );
}

interface MarkCompleteButtonProps {
  tutorialId: string;
  chapterOrdinal: number;
  csrfToken: string;
  onSuccess: () => void;
  /** When true, the button is rendered disabled (e.g., quiz gate). */
  disabled?: boolean;
  /** Human-readable reason for the disabled state; shown alongside the button. */
  disabledReason?: string;
}

function MarkCompleteButton({
  tutorialId,
  chapterOrdinal,
  csrfToken,
  onSuccess,
  disabled,
  disabledReason,
}: MarkCompleteButtonProps) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleClick() {
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch(
        `/api/tutorials/${tutorialId}/chapters/${chapterOrdinal}/complete`,
        {
          method: 'POST',
          credentials: 'same-origin',
          headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': csrfToken,
          },
          body: JSON.stringify({ signal: 'manual-override' }),
        },
      );
      if (!res.ok) {
        const body = await res.text().catch(() => '<unreadable>');
        setError(`HTTP ${res.status}: ${body.slice(0, 200)}`);
        return;
      }
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'network error');
    } finally {
      setSubmitting(false);
    }
  }

  const isDisabled = submitting || disabled === true;
  return (
    <div className="mt-4 flex items-center gap-3">
      <button
        type="button"
        onClick={handleClick}
        disabled={isDisabled}
        // T2.6: pair the visual disable with an aria-disabled signal +
        // tooltip text when blocked by the quiz gate. Keyboard + assistive-
        // tech users get the same information as sighted users.
        aria-disabled={isDisabled}
        title={disabled === true && disabledReason ? disabledReason : undefined}
        className="rounded bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {submitting ? 'Marking complete…' : 'Mark complete & unlock next'}
      </button>
      {disabled === true && disabledReason ? (
        <p className="text-xs text-muted-foreground">{disabledReason}</p>
      ) : null}
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

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
