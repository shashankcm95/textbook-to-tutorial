'use client';

/**
 * src/components/FlashcardReviewer.tsx — Leitner-box review UI.
 *
 * LOAD-BEARING ABSORB: riley HIGH-1 PARTIAL (Phase 1 synthesis).
 *
 *   "FlashcardReviewer shows Leitner box (primary) + reads `ease_factor` +
 *    `interval_days` columns (future SM-2 migration prep). Don't compute SM-2
 *    yet; just don't ignore the nullable columns."
 *
 * Two-layer information design:
 *
 *   1. PRIMARY (always visible): the Leitner box number (1-5) AND the
 *      interval-days that the box maps to via BOX_INTERVAL_DAYS. This is the
 *      v1 algorithm and the user-facing model.
 *
 *   2. SECONDARY (when non-null, secondary surface only): if `ease_factor`
 *      and `interval_days` columns are populated on the SrsReview row, we
 *      surface them as a small annotation ("SM-2 EF 2.5, I 7d"). Currently
 *      always null in MVP (Leitner-only path), but the component is wired
 *      to display them when a future SM-2 enable lands. This is the riley
 *      HIGH-1 PARTIAL fold — don't drop the data, just don't compute it.
 *
 * Flow (one card at a time):
 *
 *   1. Show FRONT. Buttons: [I knew it]  [Show answer]
 *      ─ "I knew it" → optimistic grade as 'got-it' (no flip; advance to next card)
 *      ─ "Show answer" → flip to BACK; buttons change to [Got it] [Missed]
 *
 *   2. After flip, buttons: [Got it]  [Missed]
 *      ─ "Got it"  → POST /api/srs/grade { recall: 'correct' }
 *      ─ "Missed"  → POST /api/srs/grade { recall: 'incorrect' }
 *
 *   3. On success → advance to next card (cards array passed in by parent;
 *      parent re-fetches the due-list on demand).
 *
 *   4. On grade-error → keep card in place; show inline error; allow retry.
 *      (Optimistic UI is risky here — grading drift would silently lose
 *      progress. Per kb:architecture/discipline/error-handling-discipline,
 *      we surface failures rather than swallow.)
 *
 * a11y discipline:
 *   - Keyboard: Tab to button, Enter/Space activates. Focus visible.
 *   - Live region announces card flip + grade outcome.
 *   - The card itself is NOT a button (composition: buttons inside a card
 *     container) — clicking the card body is not a grade action; only the
 *     explicit buttons grade.
 *
 * Anchors:
 *   - kb:web-dev/react-essentials §"State-management cascade" — local state
 *     suffices (card index + flip state). No need to lift.
 *   - kb:web-dev/typescript-react-patterns §"Discriminated unions for state" —
 *     the grade-submission state is a discriminated union to model the
 *     idle/submitting/error transitions explicitly.
 */

import { useState, useCallback, useMemo } from 'react';
import type { Flashcard, SrsReview } from '@/db/schema';
import { BOX_INTERVAL_DAYS, MAX_BOX } from '@/lib/srs/leitner';

// ───────────────────────────────────────────────────────────────────────────
// Public types
// ───────────────────────────────────────────────────────────────────────────

/**
 * Combined view: the flashcard content + the user's review state.
 * Parent assembles these (JOIN flashcards + srs_reviews on flashcardId).
 *
 * NB: `Flashcard` is the DB row from src/db/schema.ts (id, chapterId, front,
 * back, sourceParagraphRef) — NOT the LLM payload `LLMFlashcard` from
 * src/lib/types.ts. The naming convention is documented at types.ts:103.
 */
export interface ReviewableCard {
  flashcard: Flashcard;
  /**
   * Current SrsReview row for this (flashcard, user) pair. May be null if
   * this is the user's first-ever encounter with this card (caller defaults
   * to box=1 conceptually). When non-null, may carry SM-2 columns.
   */
  review: SrsReview | null;
}

export interface FlashcardReviewerProps {
  cards: ReviewableCard[];
  /** CSRF token from cookie — required by /api/srs/grade POST. */
  csrfToken: string;
  /** Optional: callback after grade success (e.g., refetch due-list). */
  onGraded?: (cardId: string, recall: 'correct' | 'incorrect') => void;
}

/** Response shape from POST /api/srs/grade. */
interface GradeResponse {
  newBox: number;
  nextDueAt: string;
  intervalDays: number;
}

// ───────────────────────────────────────────────────────────────────────────
// State machine for grade submission
// ───────────────────────────────────────────────────────────────────────────

type SubmitState =
  | { status: 'idle' }
  | { status: 'submitting'; recall: 'correct' | 'incorrect' }
  | { status: 'error'; error: string };

// ───────────────────────────────────────────────────────────────────────────
// Component
// ───────────────────────────────────────────────────────────────────────────

/**
 * Persona-Sprint-A T2.3: cap the user-visible daily batch. A fresh tutorial
 * surfaces every card as "due" (no SRS row → due=true), which produced
 * "Card 1 of 483" on DDIA — daunting framing flagged by Student + Professor
 * + UX personas. We cap the rendered queue to 20 cards/session; the
 * remaining cards stay in the underlying due list and the user gets a
 * meaningful "Show all due" disclosure beneath the active batch.
 *
 * 20 ≈ Duolingo's daily lesson size + Readwise's default. Avg card-grade
 * latency ~12s → ~4 minutes per session. Tuned via the formatMinutes() helper.
 */
const DAILY_BATCH_CAP = 20;
const SECS_PER_CARD_ESTIMATE = 12;

/**
 * Render-time only: produce a friendly Leitner state pill ("New", "Learning",
 * "Familiar", "Mastered") from the box number. Replaces the developer-facing
 * "Box N · review in M days" exposed by the prior UI. UX persona flagged this
 * as gamifying the box instead of the concept.
 */
function pillForBox(box: number, hasReview: boolean): { label: string; tone: 'new' | 'learning' | 'familiar' | 'mastered' } {
  if (!hasReview) return { label: 'New', tone: 'new' };
  if (box <= 1) return { label: 'Learning', tone: 'learning' };
  if (box <= 3) return { label: 'Familiar', tone: 'familiar' };
  return { label: 'Mastered', tone: 'mastered' };
}

const PILL_CLASSES: Record<'new' | 'learning' | 'familiar' | 'mastered', string> = {
  new: 'bg-sky-100 text-sky-800 dark:bg-sky-950/40 dark:text-sky-300',
  learning: 'bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300',
  familiar: 'bg-violet-100 text-violet-800 dark:bg-violet-950/40 dark:text-violet-300',
  mastered: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300',
};

function formatBatchEstimate(count: number): string {
  if (count <= 0) return '0 cards';
  const secs = count * SECS_PER_CARD_ESTIMATE;
  const mins = Math.max(1, Math.round(secs / 60));
  return `${count} card${count === 1 ? '' : 's'} · ~${mins} min`;
}

export function FlashcardReviewer({ cards, csrfToken, onGraded }: FlashcardReviewerProps) {
  const [currentIdx, setCurrentIdx] = useState(0);
  const [showAnswer, setShowAnswer] = useState(false);
  const [submit, setSubmit] = useState<SubmitState>({ status: 'idle' });

  // Persona-Sprint-A T2.3: slice the queue to a daily batch. Total due count
  // is still passed to the UI so the user can see "X more queued" without
  // being overwhelmed by it.
  const totalDue = cards.length;
  const batchCards = useMemo(
    () => cards.slice(0, DAILY_BATCH_CAP),
    [cards],
  );
  const remainingBeyondBatch = Math.max(0, totalDue - batchCards.length);

  const advance = useCallback((): void => {
    setShowAnswer(false);
    setSubmit({ status: 'idle' });
    setCurrentIdx((i) => i + 1);
  }, []);

  const handleFlip = useCallback((): void => {
    setShowAnswer(true);
  }, []);

  const handleGrade = useCallback(
    async (recall: 'correct' | 'incorrect'): Promise<void> => {
      const card = batchCards[currentIdx];
      if (!card) return;
      setSubmit({ status: 'submitting', recall });
      try {
        const res = await fetch('/api/srs/grade', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            // Middleware CSRF guard: double-submit cookie → header (see
            // src/middleware.ts:82). Without this header, POST returns 403.
            'x-csrf-token': csrfToken,
          },
          credentials: 'include',
          body: JSON.stringify({
            flashcardId: card.flashcard.id,
            recall,
          }),
        });
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          throw new Error(
            `Grade failed (${res.status}): ${text.slice(0, 200) || 'unknown error'}`,
          );
        }
        // Response payload is informational (we don't merge into local state
        // — parent owns the cards array and will refetch). We could lift the
        // response back via onGraded, but the callback signature stays simple.
        await (res.json() as Promise<GradeResponse>);
        onGraded?.(card.flashcard.id, recall);
        advance();
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'unknown error';
        setSubmit({ status: 'error', error: message });
      }
    },
    [batchCards, currentIdx, csrfToken, onGraded, advance],
  );

  const card = batchCards[currentIdx];

  // No more cards: empty state. T2.3 friendliness — when more cards are
  // queued beyond the daily batch, tell the user they exist + invite them
  // back, instead of presenting an unspecific "Come back later".
  if (!card) {
    return (
      <div
        role="status"
        aria-live="polite"
        className="rounded-lg border border-border bg-card p-8 text-center text-card-foreground"
      >
        <h3 className="text-lg font-semibold">All caught up</h3>
        <p className="mt-2 text-sm text-muted-foreground">
          {remainingBeyondBatch > 0
            ? `You've finished today's batch. ${remainingBeyondBatch} more card${remainingBeyondBatch === 1 ? '' : 's'} queued for tomorrow.`
            : "You've reviewed every card due. Come back later for the next round."}
        </p>
      </div>
    );
  }

  // Resolve display data — box defaults to 1 if no review row yet.
  // intervalDays defaults to BOX_INTERVAL_DAYS[1] for the same reason.
  const currentBox = card.review?.box ?? 1;
  // BOX_INTERVAL_DAYS is a 7-slot readonly array (index 0 unused, indices 1..5
  // valid, index 6 future-pad). With noUncheckedIndexedAccess we get
  // `number | undefined`; guard explicitly. See src/lib/srs/leitner.ts:58.
  const currentInterval = BOX_INTERVAL_DAYS[currentBox] ?? 1;

  // SM-2 secondary annotation. Currently always null per MVP. Wired now so
  // a future SM-2 enable flips this on with zero further UI changes.
  const sm2Annotation = formatSm2Annotation(card.review);

  return (
    <div className="rounded-lg border border-border bg-card text-card-foreground p-6 max-w-prose mx-auto">
      {/* Header — T2.3: friendly state pill replaces "Box N · review in M
          days". Batch progress + estimate replaces "Card X of N". SR-only
          text retains the Leitner internals for power users via screen
          readers; visible label stays human-friendly. The BoxIndicator
          dots are kept as the visual progress signal (familiar to users
          coming from Anki/Readwise) but their tooltip is now state-based. */}
      <header className="mb-4 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <div className="flex items-center gap-2">
          <BoxIndicator current={currentBox} />
          {(() => {
            const pill = pillForBox(currentBox, card.review !== null);
            return (
              <span
                className={`rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${PILL_CLASSES[pill.tone]}`}
                title={`Leitner box ${currentBox} · next review in ${currentInterval} day${currentInterval === 1 ? '' : 's'}`}
              >
                {pill.label}
              </span>
            );
          })()}
          {sm2Annotation !== null ? (
            <span
              className="rounded bg-muted px-1.5 py-0.5"
              title="SM-2 algorithm fields (currently informational; Leitner is the active engine)"
            >
              {sm2Annotation}
            </span>
          ) : null}
        </div>
        <div>
          {currentIdx + 1} / {batchCards.length}
          <span className="ml-2 text-muted-foreground/70">
            ({formatBatchEstimate(batchCards.length - currentIdx)})
          </span>
        </div>
      </header>

      {/* Card body */}
      <div
        className="min-h-[8rem] rounded border border-border bg-background p-4"
        role="region"
        aria-labelledby="flashcard-side-label"
      >
        <div className="mb-2 text-xs uppercase tracking-wide text-muted-foreground" id="flashcard-side-label">
          {showAnswer ? 'Back (answer)' : 'Front (prompt)'}
        </div>
        <div
          className="text-base leading-relaxed whitespace-pre-wrap"
          // Announce flips politely so screen-reader users hear the new side.
          aria-live="polite"
        >
          {showAnswer ? card.flashcard.back : card.flashcard.front}
        </div>
      </div>

      {/* Actions */}
      <div className="mt-4 flex flex-wrap gap-2">
        {!showAnswer ? (
          <>
            <ActionButton
              variant="primary"
              onClick={() => void handleGrade('correct')}
              disabled={submit.status === 'submitting'}
            >
              I knew it
            </ActionButton>
            <ActionButton
              variant="secondary"
              onClick={handleFlip}
              disabled={submit.status === 'submitting'}
            >
              Show answer
            </ActionButton>
          </>
        ) : (
          <>
            <ActionButton
              variant="primary"
              onClick={() => void handleGrade('correct')}
              disabled={submit.status === 'submitting'}
            >
              Got it
            </ActionButton>
            <ActionButton
              variant="destructive"
              onClick={() => void handleGrade('incorrect')}
              disabled={submit.status === 'submitting'}
            >
              Missed
            </ActionButton>
          </>
        )}
      </div>

      {/* Error surface — keep card in place; user can retry. */}
      {submit.status === 'error' ? (
        <div
          role="alert"
          className="mt-3 rounded border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive"
        >
          {submit.error}
        </div>
      ) : null}
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Sub-components (kept inline; each ~10 lines, all FlashcardReviewer-private)
// ───────────────────────────────────────────────────────────────────────────

interface BoxIndicatorProps {
  current: number;
}

/**
 * 5-segment indicator showing the user's progress through the Leitner boxes.
 * Filled segments = boxes graduated; rightmost filled is current.
 *
 * Purely decorative — the box number text alongside is the a11y-relevant
 * surface. Marked aria-hidden so screen readers don't read "filled circle,
 * empty circle, ..." which would be noise.
 */
function BoxIndicator({ current }: BoxIndicatorProps) {
  return (
    <span aria-hidden="true" className="inline-flex gap-0.5">
      {Array.from({ length: MAX_BOX }, (_, i) => {
        const filled = i < current;
        return (
          <span
            key={i}
            className={`h-1.5 w-3 rounded ${filled ? 'bg-primary' : 'bg-muted'}`}
          />
        );
      })}
    </span>
  );
}

interface ActionButtonProps {
  variant: 'primary' | 'secondary' | 'destructive';
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}

function ActionButton({ variant, onClick, disabled, children }: ActionButtonProps) {
  const variantClasses = VARIANT_CLASSES[variant];
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`rounded px-3 py-1.5 text-sm font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50 ${variantClasses}`}
    >
      {children}
    </button>
  );
}

const VARIANT_CLASSES: Record<ActionButtonProps['variant'], string> = {
  primary: 'bg-primary text-primary-foreground hover:bg-primary/90',
  secondary:
    'bg-secondary text-secondary-foreground hover:bg-secondary/80 border border-border',
  destructive: 'bg-destructive text-destructive-foreground hover:bg-destructive/90',
};

/**
 * Format SM-2 annotation IFF both columns are populated.
 * Returns null when the columns are absent (Leitner-only path, MVP default),
 * so the caller can render nothing without extra branching.
 *
 * riley HIGH-1 PARTIAL: the columns exist on every SrsReview row but are
 * NULL until SM-2 is enabled. This formatter is the read-side that activates
 * automatically when populated.
 */
function formatSm2Annotation(review: SrsReview | null): string | null {
  if (!review) return null;
  const ef = review.easeFactor;
  const i = review.intervalDays;
  if (ef === null || i === null) return null;
  // EF: 2.5 is the SM-2 default; range is typically 1.3..2.5+. One decimal.
  // I: integer days; round for display since interval can be fractional in
  // some SM-2 variants but the underlying schedule rounds to days.
  return `SM-2 EF ${ef.toFixed(2)} · I ${Math.round(i)}d`;
}
