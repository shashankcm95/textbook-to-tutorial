'use client';

/**
 * src/components/TutorialHeader.tsx — sticky brand-bearing header.
 *
 * Replaces the inline `<header className="flex items-center justify-between">`
 * inside StreamingClient. Two visual jobs:
 *
 *   1. Identify the book + author (was just "Tutorial" pre-Sprint-Bv2).
 *   2. Surface tutorial-level state at a glance: ProgressRing, CostChip,
 *      stream status. The user can read for 20 minutes without losing
 *      sight of the system state.
 *
 * Per UI/UX-hybrid audit §3.2:
 *   - Two-row layout. Top: book spine thumbnail (32px) + title/author +
 *     ring + cost + status + menu slot. Bottom (only when reading a
 *     chapter): chapter eyebrow + lesson counter.
 *   - Background: paper-deep with backdrop-blur on scroll.
 *   - Sticky `top-0 z-20` so it stays above the lesson canvas.
 *
 * Book metadata source: passed in by the caller. Sprint Bv2 doesn't yet
 * load book_title / author_name from the DB (T1.3 in the synthesis plan
 * deferred to Sprint Bv2.5 because it needs a schema column + ingest
 * change). For now the caller may pass derived/heuristic values; the
 * component renders sensible fallbacks ("Untitled tutorial") if absent.
 */

import { ProgressRing } from './ProgressRing';
import { CostChip } from './CostChip';
import { ChevronRight, BookOpen } from 'lucide-react';

interface TutorialHeaderProps {
  /** Book title — when absent, falls back to "Untitled tutorial". */
  bookTitle?: string;
  /** Author name — optional second line. */
  author?: string;
  /** Optional cover image URL — when absent, a brand-fade book spine icon
   *  stands in. */
  coverSrc?: string;
  /** Tutorial completion ratio in [0, 1]. Drives the ring fill. */
  completionPct: number;
  /** Current chapter the reader is on. When absent, the second row is
   *  hidden (e.g., on the tutorial overview before opening a chapter). */
  currentChapter?: {
    ordinal: number; // 0-based
    title: string;
    lessonIdx?: number; // 0-based
    lessonCount?: number;
  };
  /** Tutorial id — passed through to CostChip. */
  tutorialId: string;
}

export function TutorialHeader({
  bookTitle,
  author,
  coverSrc,
  completionPct,
  currentChapter,
  tutorialId,
}: TutorialHeaderProps) {
  const titleText = bookTitle && bookTitle.trim().length > 0 ? bookTitle : 'Untitled tutorial';
  return (
    <header className="sticky top-0 z-20 border-b border-paper-edge bg-paper-deep/85 backdrop-blur-md">
      <div className="mx-auto flex max-w-6xl items-center gap-4 px-gutter py-3">
        {/* Book spine thumbnail — actual cover OR brand-fade placeholder */}
        {coverSrc ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={coverSrc}
            alt=""
            className="h-9 w-7 rounded-sm border border-paper-edge shadow-paper-sm object-cover"
          />
        ) : (
          <div
            aria-hidden="true"
            className="flex h-9 w-7 items-center justify-center rounded-sm border border-paper-edge bg-brand-fade shadow-paper-sm"
          >
            <BookOpen className="h-3.5 w-3.5 text-brand" aria-hidden="true" />
          </div>
        )}

        {/* Title + author */}
        <div className="min-w-0 flex-1">
          <h1 className="truncate font-display text-ui-lg font-medium leading-tight text-ink">
            {titleText}
          </h1>
          {author ? (
            <p className="truncate text-caption text-ink-muted">{author}</p>
          ) : null}
        </div>

        {/* Right-side meta cluster */}
        <div className="flex items-center gap-3">
          <ProgressRing value={completionPct} size={28} ariaLabel={`Tutorial progress: ${Math.round(completionPct * 100)} percent`} />
          <CostChip tutorialId={tutorialId} />
          {/* Stream status badge slot — StreamingClient passes its own via
              children if it wants to (kept decoupled from this header). */}
        </div>
      </div>

      {currentChapter ? (
        <div className="mx-auto flex max-w-6xl items-baseline justify-between gap-4 border-t border-paper-edge/50 px-gutter py-2">
          <p className="text-caption text-ink-muted">
            <span className="text-ink-faint">Chapter {currentChapter.ordinal + 1}</span>
            <ChevronRight aria-hidden="true" className="mx-1 inline h-3 w-3" />
            <span className="font-medium text-ink">{currentChapter.title}</span>
          </p>
          {typeof currentChapter.lessonIdx === 'number' &&
          typeof currentChapter.lessonCount === 'number' &&
          currentChapter.lessonCount > 1 ? (
            <p className="font-mono text-micro tabular-nums text-ink-muted">
              Lesson {currentChapter.lessonIdx + 1} / {currentChapter.lessonCount}
            </p>
          ) : null}
        </div>
      ) : null}
    </header>
  );
}
