'use client';

/**
 * src/components/CompletionTracker.tsx — multi-signal completion dashboard.
 *
 * LOAD-BEARING ABSORB: riley HIGH-2 + HIGH-3 (Phase 1 synthesis).
 *
 *   HIGH-2: "CompletionTracker reads `chapters.viewed_at, scroll_depth_pct,
 *            last_quiz_attempt_at, last_quiz_score` — multi-signal, not binary."
 *
 *   HIGH-3: "Completion is multi-dimensional (read + scrolled + quizzed +
 *            mastered) — UI must surface ALL 4."
 *
 * The point of multi-signal completion is to expose the gap between "I
 * scrolled past it" and "I actually mastered it". Binary completion (just
 * `is_read`) lets the user cheat themselves; surfacing 4 sub-signals creates
 * an honest mirror.
 *
 * The four signals per chapter:
 *
 *   1. Read       — `viewed_at IS NOT NULL`
 *                   Set when the chapter is first opened in the UI.
 *
 *   2. Scrolled   — `scroll_depth_pct >= 0.80`
 *                   Set when the user has scrolled through ≥80% of the
 *                   narrative. (0.80 chosen because the bottom of long
 *                   content is rarely the goal — references, exercises;
 *                   80% covers the substantive body.)
 *
 *   3. Quizzed    — `last_quiz_attempt_at IS NOT NULL`
 *                   Set when the user submits any quiz answer for the
 *                   chapter (right or wrong).
 *
 *   4. Mastered   — `last_quiz_score >= 0.70`
 *                   Set when the most-recent quiz attempt scored at least
 *                   70%. (Per spec: 0.7 threshold.)
 *
 * Tutorial-level completion: avg across chapters of "all 4 signals true".
 *
 *   Each chapter contributes 1.0 to the numerator iff all 4 signals are true;
 *   else it contributes 0. Denominator is the chapter count. A chapter where
 *   3 of 4 signals are true contributes ZERO — the design is intentional:
 *   "feels complete but missed a signal" is exactly what HIGH-3 wanted to
 *   surface, NOT smooth over.
 *
 *   (An alternative weighted-average — count each signal as 0.25 — would
 *   reward shallow progress. The strict-AND model prioritizes truthfulness.)
 *
 * a11y discipline:
 *   - Per-chapter row uses <ul>/<li> for the checklist semantics.
 *   - Each signal has an <output>-style status badge with title/text label
 *     so screen readers say "Read: yes, Scrolled: no" rather than just
 *     "green check, gray check".
 *   - Color is paired with a textual indicator (✓ / —) for color-vision
 *     accessibility (WCAG 1.4.1).
 *
 * Anchors:
 *   - kb:web-dev/react-essentials §"Accessibility" — semantic HTML first.
 *   - kb:web-dev/react-essentials §"Stable list keys" — chapters are keyed
 *     by id (UUID), not array index. List order is stable but defensive
 *     keying matters once filter/sort lands.
 */

import { useMemo, useState } from 'react';
import type { Chapter } from '@/db/schema';

// ───────────────────────────────────────────────────────────────────────────
// Thresholds (constants, not literals scattered — easy to tune in one place)
// ───────────────────────────────────────────────────────────────────────────

export const SCROLL_THRESHOLD = 0.8;
export const MASTERY_THRESHOLD = 0.7;

// ───────────────────────────────────────────────────────────────────────────
// Public types
// ───────────────────────────────────────────────────────────────────────────

export interface CompletionTrackerProps {
  /** All chapters for the tutorial. Order = display order (by ordinal). */
  chapters: Chapter[];
}

/** Per-signal evaluation — exported for testability. */
export interface ChapterSignals {
  chapterId: string;
  ordinal: number;
  title: string;
  read: boolean;
  scrolled: boolean;
  quizzed: boolean;
  mastered: boolean;
  /** All 4 signals true — drives the strict-AND tutorial percentage. */
  allComplete: boolean;
}

// ───────────────────────────────────────────────────────────────────────────
// Pure helpers — testable in isolation
// ───────────────────────────────────────────────────────────────────────────

/**
 * Evaluate the 4 completion signals for one chapter. Pure function.
 *
 * Robust to null/undefined — the schema fields are nullable for HIGH-2;
 * nullity means "not observed yet" which maps to `false` for the signal.
 */
export function evaluateChapter(chapter: Chapter): ChapterSignals {
  const read = chapter.viewedAt !== null && chapter.viewedAt !== undefined;
  // scroll_depth_pct is 0.0..1.0; null means never reported.
  const scrolled =
    chapter.scrollDepthPct !== null &&
    chapter.scrollDepthPct !== undefined &&
    chapter.scrollDepthPct >= SCROLL_THRESHOLD;
  const quizzed =
    chapter.lastQuizAttemptAt !== null && chapter.lastQuizAttemptAt !== undefined;
  const mastered =
    chapter.lastQuizScore !== null &&
    chapter.lastQuizScore !== undefined &&
    chapter.lastQuizScore >= MASTERY_THRESHOLD;
  return {
    chapterId: chapter.id,
    ordinal: chapter.ordinal,
    title: chapter.title,
    read,
    scrolled,
    quizzed,
    mastered,
    allComplete: read && scrolled && quizzed && mastered,
  };
}

/**
 * Tutorial-level percentage: strict-AND across chapters.
 *
 * Returns a value in [0, 1]. If `chapters` is empty, returns 0 (nothing to
 * complete = 0% complete is more honest than 100%; an empty tutorial is a
 * broken tutorial, not a finished one).
 */
export function computeTutorialCompletionPct(signals: ChapterSignals[]): number {
  if (signals.length === 0) return 0;
  const completed = signals.filter((s) => s.allComplete).length;
  return completed / signals.length;
}

// ───────────────────────────────────────────────────────────────────────────
// Component
// ───────────────────────────────────────────────────────────────────────────

export function CompletionTracker({ chapters }: CompletionTrackerProps) {
  // Memoize signal evaluation — chapters can be a long array. Re-runs only
  // when chapters identity changes (parent should keep it stable).
  const signals = useMemo(
    () => chapters.map((c) => evaluateChapter(c)),
    [chapters],
  );

  const tutorialPct = useMemo(
    () => computeTutorialCompletionPct(signals),
    [signals],
  );

  // Persona-Sprint-A T2.2 fix: collapse the per-chapter list by default.
  // The previous render produced a 124-row × 4-dash grid that was visually
  // overwhelming on long books like DDIA (UX persona flagged HIGH; Student
  // flagged "demoralizing"). We preserve the riley HIGH-2/HIGH-3 multi-
  // signal model, but surface a 1-line summary by default + a disclosure
  // for the full list.
  const [expanded, setExpanded] = useState(false);

  const completedCount = signals.filter((s) => s.allComplete).length;
  const readCount = signals.filter((s) => s.read).length;
  const quizzedCount = signals.filter((s) => s.quizzed).length;
  const masteredCount = signals.filter((s) => s.mastered).length;
  const tutorialPctRounded = Math.round(tutorialPct * 100);

  return (
    <section
      aria-labelledby="completion-heading"
      className="rounded-lg border border-border bg-card text-card-foreground p-4"
    >
      <header className="mb-3 flex items-baseline justify-between">
        <h2 id="completion-heading" className="text-sm font-semibold">
          Progress
        </h2>
        <span className="text-xs text-muted-foreground">
          {completedCount} of {signals.length} chapters fully complete
        </span>
      </header>

      {/* Tutorial-level progress bar */}
      <div
        role="progressbar"
        aria-valuenow={tutorialPctRounded}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`Tutorial completion: ${tutorialPctRounded} percent`}
        className="mb-3 h-2 w-full overflow-hidden rounded-full bg-muted"
      >
        <div
          className="h-full bg-primary transition-all"
          style={{ width: `${tutorialPctRounded}%` }}
        />
      </div>

      {/* T2.2: 1-line summary — surfaces the riley HIGH-2 multi-signal model
          without the 124-row grid noise. */}
      {signals.length === 0 ? (
        <p className="text-sm italic text-muted-foreground">
          No chapters yet — the tutorial is still generating.
        </p>
      ) : (
        <>
          <p className="text-xs text-muted-foreground tabular-nums">
            <span className="font-medium text-foreground">{readCount}</span> read
            <span aria-hidden="true"> · </span>
            <span className="font-medium text-foreground">{quizzedCount}</span> quizzed
            <span aria-hidden="true"> · </span>
            <span className="font-medium text-foreground">{masteredCount}</span> mastered
            <span aria-hidden="true"> · </span>
            <span>{signals.length} total</span>
          </p>

          {/* Collapsible per-chapter detail — preserves the riley HIGH-3
              "surface all 4 signals" requirement on demand without leaking
              a wall of dashes onto every page-load. */}
          <button
            type="button"
            onClick={() => setExpanded((e) => !e)}
            aria-expanded={expanded}
            aria-controls="completion-detail-list"
            className="mt-3 text-xs font-medium text-primary hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring rounded"
          >
            {expanded
              ? `Hide per-chapter signals`
              : `Show per-chapter signals (${signals.length} chapters) →`}
          </button>

          {expanded ? (
            <ul id="completion-detail-list" className="mt-3 space-y-2">
              {signals.map((s) => (
                <li
                  key={s.chapterId}
                  className="flex items-center justify-between gap-3 rounded border border-border/50 bg-background px-3 py-2"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">
                      {s.ordinal + 1}. {s.title}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5" role="group" aria-label={`Signals for ${s.title}`}>
                    <SignalBadge label="Read" on={s.read} />
                    <SignalBadge label="Scrolled" on={s.scrolled} />
                    <SignalBadge label="Quizzed" on={s.quizzed} />
                    <SignalBadge label="Mastered" on={s.mastered} />
                  </div>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      )}
    </section>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Sub-component: per-signal badge
// ───────────────────────────────────────────────────────────────────────────

interface SignalBadgeProps {
  label: string;
  on: boolean;
}

/**
 * Single signal badge. Color + glyph + textual title to satisfy WCAG 1.4.1
 * (information must not rely on color alone).
 *
 * We avoid emoji here because some screen-reader voices announce emojis
 * inconsistently across platforms; "✓" (U+2713) and "—" (U+2014) are read
 * predictably as "check mark" and "em dash" respectively.
 */
function SignalBadge({ label, on }: SignalBadgeProps) {
  const ariaLabel = `${label}: ${on ? 'yes' : 'no'}`;
  const className = on
    ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300'
    : 'bg-muted text-muted-foreground';
  return (
    <span
      role="img"
      aria-label={ariaLabel}
      title={ariaLabel}
      className={`inline-flex h-5 min-w-[2.5rem] items-center justify-center rounded px-1 text-[10px] font-medium uppercase tracking-wide ${className}`}
    >
      <span aria-hidden="true">{on ? '✓' : '—'}</span>
      <span className="sr-only">{ariaLabel}</span>
    </span>
  );
}
