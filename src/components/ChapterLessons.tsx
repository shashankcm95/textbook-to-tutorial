'use client';

// src/components/ChapterLessons.tsx — multipage chapter renderer (Feature A).
//
// Replaces the existing direct render of <ChapterRenderer narrative={...} /> in
// StreamingClient with a paginated view: parses the narrative into lessons
// (via parseLessons), renders one lesson at a time with Prev/Next controls,
// and gates the per-chapter "extras" (quiz, flashcards, Mark Complete button)
// to the LAST lesson via a render-prop.
//
// Why a render-prop for the last-lesson extras (not children + context):
//   - The extras are stable JSX passed once by the parent; render-prop keeps
//     the conditional render local to ChapterLessons without prop-drilling
//     `isLastLesson` back up.
//   - StreamingClient's existing quiz/flashcard/Mark-Complete state (and the
//     csrfToken / onMarkComplete callback) stays in StreamingClient; we don't
//     duplicate that ownership here.
//
// Graceful degradation (the load-bearing invariant from parse-lessons.ts):
//   - If the narrative has fewer than 2 lesson markers (pre-Feature-A
//     chapters, or LLM mis-format), parseLessons returns a single-lesson
//     array. This component then renders ONE page with no nav controls,
//     no progress bar, and the "extras" render immediately. The visual
//     result is indistinguishable from the pre-Feature-A direct render —
//     the only added cost is one regex pass.

import { useCallback, useMemo, useState } from 'react';
import { ChapterRenderer } from '@/components/ChapterRenderer';
import { parseLessons } from '@/lib/lessons/parse-lessons';
import type { SourceParagraph } from '@/lib/types';

export interface ChapterLessonsProps {
  /** The full chapter narrative (markdown with `## Lesson N: <title>` markers
   *  if generated under the Feature-A prompt; without markers if older). */
  narrative: string;
  /** Source paragraphs for citation resolution. Passed through to ChapterRenderer. */
  sourceParagraphs: SourceParagraph[];
  /** Render-prop for the extras shown ONLY on the last lesson. Typically:
   *  quiz <details>, flashcards <details>, and the Mark Complete button. */
  renderLastLessonExtras?: () => React.ReactNode;
}

export function ChapterLessons({
  narrative,
  sourceParagraphs,
  renderLastLessonExtras,
}: ChapterLessonsProps) {
  // Parse once per narrative change. Tiny regex pass; useMemo is mostly to
  // keep the array reference stable for downstream effects (the nav buttons
  // don't have deep dependencies, so even without useMemo this would be cheap).
  const lessons = useMemo(() => parseLessons(narrative), [narrative]);
  const lessonCount = lessons.length;

  // Local lesson index. Defaults to 0; URL state is a deliberate follow-up
  // (?lesson=M would let the user share/bookmark a specific lesson + survive
  // refresh, but adds searchParams plumbing that the MVP scope skips).
  const [currentIdx, setCurrentIdx] = useState(0);

  // Defensive: if `narrative` changes (regen + router.refresh) and the new
  // narrative has fewer lessons than the old one, snap back to a valid index.
  // Without this, currentIdx could point past lessons.length-1 and the
  // current-lesson lookup below would return undefined.
  const safeIdx = Math.min(currentIdx, Math.max(0, lessonCount - 1));
  const current = lessons[safeIdx];

  const isFirst = safeIdx === 0;
  const isLast = safeIdx >= lessonCount - 1;
  const isSingle = lessonCount <= 1;

  const goNext = useCallback(() => {
    setCurrentIdx((idx) => Math.min(idx + 1, lessonCount - 1));
  }, [lessonCount]);

  const goPrev = useCallback(() => {
    setCurrentIdx((idx) => Math.max(idx - 1, 0));
  }, []);

  if (!current) {
    // Should be unreachable — parseLessons guarantees ≥1 lesson, and safeIdx
    // is clamped. This branch exists for the TypeScript narrowing + as a
    // final defensive guardrail.
    return null;
  }

  // Sprint-Bv2: brand-typography header + progress bar + nav buttons.
  // The lesson title now uses Newsreader (display) at text-h3, lesson
  // counter switches to mono with tabular-nums, progress bar uses brand
  // indigo on paper-edge track, nav buttons inherit the brand button
  // style from the home form. All centered to max-w-[36em] to match
  // the LessonCanvas centering so the chrome sits on the same axis as
  // the reading column.
  return (
    <div className="mx-auto max-w-[36em] space-y-stanza">
      {/* Lesson title — only shown when the chapter is actually paginated.
          Single-lesson fallback skips this to match the pre-Feature-A look. */}
      {!isSingle ? (
        <header className="flex items-baseline justify-between gap-3">
          <h3 className="font-display text-h3 font-medium tracking-tight text-ink">
            Lesson {current.ordinal}: {current.title}
          </h3>
          <span
            className="font-mono text-caption tabular-nums text-ink-faint"
            aria-label={`Lesson ${safeIdx + 1} of ${lessonCount}`}
          >
            {safeIdx + 1} / {lessonCount}
          </span>
        </header>
      ) : null}

      {/* Progress bar — paginated-only. */}
      {!isSingle ? (
        <div
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={lessonCount}
          aria-valuenow={safeIdx + 1}
          aria-label="Lesson progress within chapter"
          className="h-[3px] w-full overflow-hidden rounded-full bg-paper-edge"
        >
          <div
            className="h-full rounded-full bg-brand transition-[width] duration-base ease-decelerate"
            style={{ width: `${((safeIdx + 1) / lessonCount) * 100}%` }}
          />
        </div>
      ) : null}

      {/* Lesson body — full ChapterRenderer with citation resolution stays
          the load-bearing renderer. We just feed it a single lesson's body
          instead of the whole narrative. */}
      <ChapterRenderer narrative={current.body} sourceParagraphs={sourceParagraphs} />

      {/* Nav controls — only when paginated. The Continue/Prev buttons use
          aria-disabled (not the `disabled` attr) so keyboard users can still
          tab through; the button's own click-handler is the no-op at bounds. */}
      {!isSingle ? (
        <nav
          aria-label="Lesson navigation"
          className="flex items-center justify-between gap-3 border-t border-paper-edge pt-stanza"
        >
          <button
            type="button"
            onClick={goPrev}
            disabled={isFirst}
            className="inline-flex items-center gap-1 rounded-md border border-paper-edge bg-paper px-3 py-1.5 font-sans text-ui font-medium text-ink-muted transition-colors duration-snap ease-decelerate hover:border-brand/40 hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-paper-edge disabled:hover:text-ink-muted"
          >
            <span aria-hidden="true">←</span> Previous lesson
          </button>
          {!isLast ? (
            <button
              type="button"
              onClick={goNext}
              className="inline-flex items-center gap-1 rounded-md bg-brand px-4 py-1.5 font-sans text-ui font-semibold text-white shadow-paper-sm transition-all duration-snap ease-decelerate hover:bg-brand-hover hover:shadow-paper active:translate-y-px focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
            >
              Next lesson <span aria-hidden="true">→</span>
            </button>
          ) : (
            <span className="font-sans text-caption italic text-ink-faint">Final lesson</span>
          )}
        </nav>
      ) : null}

      {/* Last-lesson extras (quiz, flashcards, Mark Complete) — only on the
          final lesson when paginated, or immediately on the single-lesson
          fallback (so old chapters keep the pre-Feature-A behavior). */}
      {(isSingle || isLast) && renderLastLessonExtras ? (
        <div className="mt-6 border-t border-border pt-6">{renderLastLessonExtras()}</div>
      ) : null}
    </div>
  );
}
