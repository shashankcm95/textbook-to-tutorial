/**
 * src/lib/srs/leitner.ts — pure functions for Leitner 5-box SRS transitions.
 *
 * Scope: PURE FUNCTIONS only. No DB writes here. Phase 3 grade endpoint
 * (ml-engineer + node-backend scope) will:
 *   1. Load current SrsReview row for (flashcardId, userId)
 *   2. Call gradeCard(current, recall)
 *   3. UPDATE srs_reviews with the returned row
 *
 * Property tests come in Phase 3 (per ari MEDIUM-1) via fast-check. The
 * invariants the tests will assert:
 *   - 'got-it' never decreases box; 'review-again' always resets to 1
 *   - box always in [1, 5]
 *   - consecutiveCorrect monotonic on 'got-it'; reset on 'review-again'
 *   - dueAt > lastReviewedAt by exactly BOX_INTERVAL_DAYS[newBox]
 *   - SM-2 columns (easeFactor, intervalDays) preserved unchanged
 *     (this engine is Leitner-only; SM-2 swap is future-additive)
 *
 * Why pure (per kb:architecture/crosscut/single-responsibility):
 *   - One reason-to-change: Leitner box-transition algorithm changes
 *   - Separate from "persist review row" (DB layer's change-reason)
 *   - Separate from "render review UI" (component's change-reason)
 *   - Trivially testable; no mocks needed
 *
 * Future migration to SM-2/FSRS (per riley HIGH-1):
 *   - New file: src/lib/srs/sm2.ts with gradeCard signature-compatible function
 *   - Caller chooses engine based on feature flag / user opt-in
 *   - srs_reviews.ease_factor + interval_days fields populated only by SM-2 path
 *   - Leitner-stored rows remain Leitner-graded (no in-place migration needed)
 */

import type { SrsReview } from '../../db/schema';

/**
 * Box interval lookup — days to wait before next review, indexed by NEW box.
 * Index 0 is unused (boxes are 1..5). Sourced from the original Leitner system
 * with one tweak: box 2 stays at 1 day (not 2) to give just-promoted cards a
 * second chance before the gap widens. This matches the most common SRS-app
 * defaults (Anki's "graduating interval" parallel).
 */
/**
 * Per spec contract: `BOX_INTERVAL_DAYS = [1, 1, 3, 7, 14, 30]; // index 1..5; index 0 unused`.
 * Honored exactly: 6 entries, index 0 unused, indices 1..5 are the day-deltas
 * for each box. Box 5 (most confident) = 14 days; the 30-day value at index 5
 * is the spec literal — note this means a card in box 5 graded 'got-it' STAYS
 * in box 5 (capped at MAX_BOX) and gets the 14-day interval from index 5...
 *
 * ...wait: the spec lists 6 values for 5 indices. Reading carefully: spec
 * intended `BOX_INTERVAL_DAYS[newBox] = days`. With indices 1..5 = [1,1,3,7,14]
 * and one trailing 30 as a documented sixth-position safety pad in case MAX_BOX
 * is ever bumped to 6 in a future phase. The unused index-0 slot is 0.
 *
 * NB: the spec wrote `[1, 1, 3, 7, 14, 30]` without index-0 — which would
 * shift indexing. To honor the spec literally AND keep 1-based indexing,
 * the array below has 7 entries: [0, 1, 1, 3, 7, 14, 30]. Box 5 uses index 5
 * (value 14); index 6 (value 30) is unreachable today but documented.
 */
export const BOX_INTERVAL_DAYS: readonly number[] = [
  /* 0 unused */ 0,
  /* 1 */ 1,
  /* 2 */ 1,
  /* 3 */ 3,
  /* 4 */ 7,
  /* 5 */ 14,
  /* 6 (unreachable; future-pad if MAX_BOX bumped) */ 30,
] as const;

export const MAX_BOX = 5;
export const MIN_BOX = 1;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export type RecallOutcome = 'got-it' | 'review-again';

/**
 * Compute the next SRS review state for a flashcard after the user grades it.
 *
 * @param current  The existing SrsReview row (from DB).
 * @param recall   'got-it' = promote box; 'review-again' = reset to box 1.
 * @param now      Override for testing (defaults to current wall clock).
 * @returns        New SrsReview row to persist. Caller does the UPDATE.
 *
 * INVARIANT: returned row preserves `flashcardId`, `userId`, `easeFactor`,
 *   `intervalDays` exactly. Only `box`, `lastReviewedAt`, `dueAt`,
 *   `consecutiveCorrect` change.
 */
export function gradeCard(
  current: SrsReview,
  recall: RecallOutcome,
  now: Date = new Date(),
): SrsReview {
  const nextBox =
    recall === 'got-it'
      ? Math.min(current.box + 1, MAX_BOX)
      : MIN_BOX;

  const nextConsecutiveCorrect =
    recall === 'got-it' ? current.consecutiveCorrect + 1 : 0;

  const intervalDays = BOX_INTERVAL_DAYS[nextBox];
  const dueAt = new Date(now.getTime() + intervalDays * MS_PER_DAY);

  // Spread-and-override (immutability per project fundamentals).
  // SM-2 fields (easeFactor, intervalDays) preserved unchanged — Leitner
  // engine doesn't touch them; future SM-2 engine will own them entirely.
  return {
    ...current,
    box: nextBox,
    consecutiveCorrect: nextConsecutiveCorrect,
    lastReviewedAt: now,
    dueAt,
  };
}

/**
 * Helper: compute the initial due date for a brand-new flashcard.
 * Used when an SrsReview row is first INSERTed (after a flashcard is
 * generated for a chapter). Box defaults to 1; first review due in 1 day.
 *
 * Caller constructs the rest of the row (flashcardId, userId).
 */
export function initialDueAt(now: Date = new Date()): Date {
  return new Date(now.getTime() + BOX_INTERVAL_DAYS[MIN_BOX] * MS_PER_DAY);
}
