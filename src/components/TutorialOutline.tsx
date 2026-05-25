'use client';

/**
 * src/components/TutorialOutline.tsx — Sprint C Phase 1.
 *
 * A book-style Table of Contents that replaces the inline 124-row chapter
 * dump in StreamingClient (which had become a navigation dead zone — the
 * UX Designer round-2 "UX-CRITICAL #1" finding). This component renders
 * the *navigation*; the existing inline `<section>` chapter bodies in
 * StreamingClient remain as the *content*.
 *
 * Design intent:
 *
 *   1. PART GROUPING WITH FALLBACK. DDIA-style books prefix chapter titles
 *      with `Part I.`, `Part II.`, etc. When ≥2 distinct Parts are detected
 *      (regex below) the chapters are grouped under collapsible Part
 *      headings. Otherwise we render a flat list under "All chapters" —
 *      the Cormen / Bishop / single-Part case.
 *
 *   2. STATUS + LOCK SIGNALS. Each row carries a small status pill
 *      (locked / pending / streaming / complete) and a visited-check
 *      when the server-side `completionCriteriaMet` is true. Locked rows
 *      (ordinal > maxUnlocked) are visually de-emphasized + non-clickable
 *      — clicking them does nothing because the anchor target doesn't
 *      exist yet (the chapter section in StreamingClient renders a
 *      LockedChapterCard at a different id).
 *
 *   3. ANCHOR LINK FORM. Hrefs match the existing `id={`ch-${c.id}-title`}`
 *      attribute that StreamingClient already emits at line 695 — so this
 *      component is purely additive; no body-side wiring change required.
 *
 *   4. STICKY-LEFT SIDEBAR ON DESKTOP. `sticky top-[var(--header-h,4rem)]`
 *      so the TOC tracks alongside the scrolling lesson canvas. Hidden on
 *      mobile (the inline chapter body is the navigation there); shows as
 *      a collapse-to-button affordance on tablet.
 *
 * No emoji, no decorative icons that compete with the citation-gold or
 * brand-indigo accents — this is a calm navigation surface, not a
 * dashboard. Status pills use the semantic tokens defined in globals.css
 * (success / warn / info / ink-faint).
 */

import { CheckCircle2, Circle, Lock, Loader2, ChevronRight } from 'lucide-react';

// ───────────────────────────────────────────────────────────────────────────
// Public types
// ───────────────────────────────────────────────────────────────────────────

export interface TutorialOutlineChapter {
  id: string;
  ordinal: number; // 0-based
  title: string;
  /**
   * Free-form status string from the streaming projection (`'complete' |
   * 'streaming' | 'pending' | 'failed' | ...`). The component normalises
   * to one of four display states; unknown values render as "pending".
   */
  status: string;
  /**
   * Server-side completion gate result. When true AND status is complete,
   * the row gets a visited-checkmark instead of just a completed pill.
   */
  completionCriteriaMet?: boolean;
}

export interface TutorialOutlineProps {
  chapters: TutorialOutlineChapter[];
  /** Currently-visible chapter ordinal (for the "Jump to current" affordance). */
  currentChapterOrdinal?: number;
  /** Tutorial id — reserved for future per-chapter deep links. */
  tutorialId: string;
  /** Highest chapter ordinal currently unlocked by the ratchet (inclusive). */
  maxUnlocked: number;
}

// ───────────────────────────────────────────────────────────────────────────
// Part-grouping helper
// ───────────────────────────────────────────────────────────────────────────

// Sprint E Tier 1: accept BOTH the "Part I." prefix (DDIA convention)
// AND bare-Roman ("I. The Interview Process" — CTCI convention). The
// CTCI ingest audit found CTCI fell back to flat "All chapters" because
// the original regex required the literal "Part " prefix. The bare-Roman
// branch normalizes the captured numeral (group 2) into a synthetic
// "Part <NUMERAL>" label so groups render consistently regardless of
// source convention. False-positive safeguard ("Iota", "Ivory") is the
// trailing `[.\s:]` character class — a single Roman letter that begins
// a regular English word never has that separator immediately after it.
// The grouping logic's existing `distinctParts.size >= 2` guard remains
// the second line of defense against books that use neither convention.
export const PART_PREFIX_RE = /^(?:(Part\s+([IVXLCDM]+))|([IVXLCDM]+))[\.\s:]/i;

interface PartGroup {
  label: string; // e.g., "Part I", or "All chapters" for the fallback
  chapters: TutorialOutlineChapter[];
}

function groupByPart(chapters: TutorialOutlineChapter[]): PartGroup[] {
  // First pass: tag each chapter with its detected Part (or null). When the
  // bare-Roman branch fires (group 3), synthesize a "Part <NUMERAL>" label so
  // the rendered group heading is consistent with the explicit-Part case.
  const tagged = chapters.map((c) => {
    const match = c.title.match(PART_PREFIX_RE);
    if (!match) return { chapter: c, part: null };
    const explicitPart = match[1]; // "Part I" (full)
    const bareNumeral = match[3]; // "I" (when no "Part " prefix)
    const part =
      explicitPart ??
      (bareNumeral ? `Part ${bareNumeral.toUpperCase()}` : null);
    return { chapter: c, part };
  });
  const distinctParts = new Set(tagged.map((t) => t.part).filter((p): p is string => p !== null));
  // Fallback path: when fewer than two distinct Part prefixes are present,
  // render a single "All chapters" group. Avoids the awkward "Part I" +
  // "(no part)" split on single-Part books like Cormen.
  if (distinctParts.size < 2) {
    return [{ label: 'All chapters', chapters }];
  }
  // Group, preserving the chapters' ordinal order within each group.
  const groups = new Map<string, TutorialOutlineChapter[]>();
  for (const { chapter, part } of tagged) {
    const key = part ?? 'Other';
    const existing = groups.get(key) ?? [];
    existing.push(chapter);
    groups.set(key, existing);
  }
  return Array.from(groups.entries()).map(([label, chs]) => ({ label, chapters: chs }));
}

// ───────────────────────────────────────────────────────────────────────────
// Display-state normalisation
// ───────────────────────────────────────────────────────────────────────────

type DisplayState = 'locked' | 'pending' | 'streaming' | 'complete';

function displayStateFor(
  chapter: TutorialOutlineChapter,
  maxUnlocked: number,
): DisplayState {
  if (chapter.ordinal > maxUnlocked) return 'locked';
  if (chapter.status === 'complete') return 'complete';
  if (chapter.status === 'streaming') return 'streaming';
  return 'pending';
}

const STATE_PILL_CLASSES: Record<DisplayState, string> = {
  locked: 'border-paper-edge bg-paper-deep/40 text-ink-faint',
  pending: 'border-paper-edge bg-paper text-ink-muted',
  streaming: 'border-info/40 bg-info-fade text-info',
  complete: 'border-success/40 bg-success-fade text-success',
};

const STATE_LABEL: Record<DisplayState, string> = {
  locked: 'Locked',
  pending: 'Pending',
  streaming: 'Streaming',
  complete: 'Complete',
};

// ───────────────────────────────────────────────────────────────────────────
// Component
// ───────────────────────────────────────────────────────────────────────────

export function TutorialOutline({
  chapters,
  currentChapterOrdinal,
  // tutorialId is reserved for future per-chapter deep links; kept in the
  // contract so callers don't churn when that lands.
  tutorialId: _tutorialId,
  maxUnlocked,
}: TutorialOutlineProps) {
  const groups = groupByPart(chapters);
  const showJumpToCurrent = typeof currentChapterOrdinal === 'number';
  const currentChapter =
    typeof currentChapterOrdinal === 'number'
      ? chapters.find((c) => c.ordinal === currentChapterOrdinal)
      : undefined;

  return (
    <nav
      aria-label="Tutorial outline"
      className="hidden lg:block sticky top-[var(--header-h,4rem)] max-h-[calc(100vh-var(--header-h,4rem))] overflow-y-auto pr-2 text-ui"
    >
      {/* "Jump to current" affordance — quietly placed at the top so the
          reader can return to where they were after browsing the TOC. */}
      {showJumpToCurrent && currentChapter ? (
        <a
          href={`#ch-${currentChapter.id}-title`}
          className="mb-stanza inline-flex items-center gap-1.5 rounded-md border border-paper-edge bg-paper px-2.5 py-1.5 font-sans text-caption text-ink-muted shadow-paper-sm hover:bg-brand-fade hover:text-brand focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand"
        >
          <ChevronRight aria-hidden="true" className="h-3 w-3" />
          Jump to current
        </a>
      ) : null}

      {groups.map((group) => (
        <section key={group.label} className="mb-section">
          <h3 className="mb-lead font-display text-caption font-medium uppercase tracking-wide text-ink-faint">
            {group.label}
          </h3>
          <ol className="space-y-1">
            {group.chapters.map((c) => {
              const state = displayStateFor(c, maxUnlocked);
              const isLocked = state === 'locked';
              const isCurrent = c.ordinal === currentChapterOrdinal;
              const visited = state === 'complete' && c.completionCriteriaMet === true;
              return (
                <li key={c.id}>
                  {isLocked ? (
                    <span
                      aria-disabled="true"
                      title={`Locked — finish chapter ${maxUnlocked + 1} to unlock`}
                      className="flex cursor-not-allowed items-start gap-2 rounded-md px-2 py-1.5 text-ink-faint opacity-70"
                    >
                      <Lock aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-sans text-ui">
                          {c.ordinal + 1}. {c.title}
                        </span>
                        <StatusPill state={state} />
                      </span>
                    </span>
                  ) : (
                    <a
                      href={`#ch-${c.id}-title`}
                      aria-current={isCurrent ? 'location' : undefined}
                      className={[
                        'group flex items-start gap-2 rounded-md px-2 py-1.5 font-sans transition-colors',
                        'hover:bg-brand-fade focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand',
                        isCurrent ? 'bg-brand-fade text-brand' : 'text-ink',
                      ].join(' ')}
                    >
                      {visited ? (
                        <CheckCircle2
                          aria-hidden="true"
                          className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success"
                        />
                      ) : state === 'streaming' ? (
                        <Loader2
                          aria-hidden="true"
                          className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin text-info"
                        />
                      ) : (
                        <Circle
                          aria-hidden="true"
                          className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ink-faint"
                        />
                      )}
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-ui">
                          {c.ordinal + 1}. {c.title}
                        </span>
                        <StatusPill state={state} />
                      </span>
                    </a>
                  )}
                </li>
              );
            })}
          </ol>
        </section>
      ))}
    </nav>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Sub-component (file-private)
// ───────────────────────────────────────────────────────────────────────────

function StatusPill({ state }: { state: DisplayState }) {
  return (
    <span
      className={`mt-1 inline-flex items-center rounded-sm border px-1.5 py-px font-mono text-micro uppercase tracking-wide ${STATE_PILL_CLASSES[state]}`}
    >
      {STATE_LABEL[state]}
    </span>
  );
}
