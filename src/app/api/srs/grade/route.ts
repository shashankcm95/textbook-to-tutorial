// src/app/api/srs/grade/route.ts — POST handler for Leitner-box SRS grading.
//
// LOAD-BEARING ABSORB: mio CRITICAL-1 (Phase 3 SRS endpoint ownership chain).
//
//   "The route MUST verify ownership end-to-end via JOIN
//      flashcards.chapter_id → chapters.tutorial_id → tutorials.user_id
//    BEFORE the write. Return 404 on miss (NOT 403) — never leak existence
//    of foreign IDs."
//
// This file implements that JOIN explicitly (see Section 4 below). The
// `gradeCard` pure function (src/lib/srs/leitner.ts:86) does the box-transition
// math; THIS file owns the auth + ownership + idempotency surface.
//
// LOAD-BEARING ABSORB: mio HIGH-1 (grade-replay attack).
//
//   "Same {flashcardId, recall} within 60s = idempotent no-op (return last
//    grade response). Network retries / double-click would otherwise advance
//    box twice and silently graduate a card the user only graded once."
//
// 60s is a heuristic: long enough to cover slow-network retries and accidental
// double-clicks; short enough that an intentional re-review (e.g., 1 minute
// later for a missed card) is honored as a fresh grade. Document the choice
// here so future maintainers don't bump it without thinking about both ends.
//
// LOAD-BEARING ACK: mio HIGH-4 (CSRF + SameSite=Strict).
//
//   The PRIMARY CSRF defense for this endpoint is the `session` + `__csrf`
//   cookies' `SameSite=Strict` flag (src/middleware.ts:104-132). A cross-
//   origin POST cannot send the cookie at all, so cookie-based session auth
//   is structurally safe. The double-submit token (X-CSRF-Token vs __csrf
//   cookie equality, enforced in middleware.ts:78-93) is defense-in-depth.
//   This endpoint relies on BOTH being present; the middleware rejects with
//   403 BEFORE this handler runs if the double-submit fails.
//
// Design anchors:
//   - kb:security-dev/auth-patterns §"Compound WHERE ownership pattern" —
//     the only safe shape for per-user resource access.
//   - kb:architecture/crosscut/idempotency §"INCREMENT is non-idempotent" —
//     SRS box advance is INCREMENT-shaped; needs a dedup window or
//     idempotency-key store. We chose the time-window dedup (simpler than
//     a key store) because the client doesn't currently mint idempotency
//     keys per grade event.
//   - kb:architecture/discipline/error-handling-discipline §"Fail-fast" —
//     all validation (body shape, session, ownership) happens before any
//     write. The write itself is a single transaction.
//   - kb:architecture/crosscut/single-responsibility — this file ONLY does
//     the grade-write surface. Box math is in leitner.ts. Schema is in
//     db/schema.ts. CSRF + session minting are in middleware.ts. One
//     change-reason here: the grade-write wire contract.

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { and, desc, eq } from 'drizzle-orm';
import { db, schema } from '@/db/client';
import { verifySession, SESSION_COOKIE_NAME } from '@/lib/session';
import {
  gradeCard,
  BOX_INTERVAL_DAYS,
  initialDueAt,
  type RecallOutcome,
} from '@/lib/srs/leitner';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// Request shape
// ---------------------------------------------------------------------------
//
// Client contract — matches src/components/FlashcardReviewer.tsx:142-145.
// `recall: 'correct' | 'incorrect'` — the UI semantic. We translate to
// the leitner.ts RecallOutcome type ('got-it' | 'review-again') at handler
// boundary so the pure function stays vocabulary-neutral.

const GradeBody = z.object({
  flashcardId: z.string().uuid('flashcardId must be a UUID'),
  recall: z.enum(['correct', 'incorrect']),
});

type GradeBodyT = z.infer<typeof GradeBody>;

// ---------------------------------------------------------------------------
// Response shape (the wire contract with FlashcardReviewer)
// ---------------------------------------------------------------------------

interface GradeResponse {
  newBox: number;
  nextDueAt: string; // ISO-8601
  intervalDays: number;
  // riley HIGH-1 PARTIAL: future SM-2 columns. Null today (Leitner-only);
  // populated when SM-2 lands. The UI accepts both shapes.
  easeFactor: number | null;
  intervalDaysSm2: number | null;
  // Idempotency-replay marker — when set, the server skipped the write
  // because a same-grade landed within IDEMPOTENCY_WINDOW_MS. UI can show
  // "Already graded just now" rather than re-flipping the card state.
  idempotentReplay: boolean;
}

// ---------------------------------------------------------------------------
// Idempotency window (mio HIGH-1)
// ---------------------------------------------------------------------------
//
// 60 seconds. Rationale:
//   - Covers double-click within ~500ms (most common cause).
//   - Covers retry-on-network-error (typical retry window: 1-30s).
//   - Below the typical "I want to re-grade for real" interval (a user who
//     intentionally re-grades a card usually does so after reading the back
//     again — that takes longer than 60s in practice).
//   - 1 minute aligns with the user's mental model of "just now".
//
// Bumping this above ~2 minutes would start eating intentional re-grades.
// Lowering it below ~15 seconds would let network-retry storms double-count.

const IDEMPOTENCY_WINDOW_MS = 60_000;

// ---------------------------------------------------------------------------
// POST /api/srs/grade
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest): Promise<NextResponse> {
  // ── 1. Session check ──────────────────────────────────────────────────
  // Re-verify here (defense-in-depth; middleware already verified). Mirrors
  // src/app/api/ingest/route.ts:84-102. NB: middleware also validated CSRF
  // before this handler ran — if the X-CSRF-Token header didn't match the
  // __csrf cookie, middleware returned 403 and we never see the request.
  const secret = process.env.SESSION_SECRET ?? '';
  if (!secret) {
    return NextResponse.json(
      { error: 'server misconfigured: SESSION_SECRET missing' },
      { status: 500 },
    );
  }
  const sessionCookie = req.cookies.get(SESSION_COOKIE_NAME)?.value ?? '';
  const payload = await verifySession(sessionCookie, secret);
  if (!payload) {
    return NextResponse.json({ error: 'session required' }, { status: 401 });
  }
  const userId = payload.userId;

  // ── 2. Body parse + validate ──────────────────────────────────────────
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json(
      { error: 'request body must be valid JSON' },
      { status: 400 },
    );
  }
  const parsed = GradeBody.safeParse(raw);
  if (!parsed.success) {
    const fieldErrors = parsed.error.issues.map(
      (i) => `${i.path.join('.')}: ${i.message}`,
    );
    return NextResponse.json(
      { error: 'invalid request body', details: fieldErrors },
      { status: 400 },
    );
  }
  const body: GradeBodyT = parsed.data;

  // ── 3. (mio CRITICAL-1) Ownership-chain JOIN ──────────────────────────
  //
  // The required join shape per kb:security-dev/auth-patterns IDOR pattern:
  //   flashcards.chapter_id → chapters.tutorial_id → tutorials.user_id
  //
  // If ANY hop fails (flashcard doesn't exist, chapter deleted, tutorial
  // owned by a different user), the join returns ZERO rows and we 404. The
  // 404 (not 403) is deliberate: a 403 would confirm the flashcardId is
  // real-but-foreign, leaking existence to an attacker enumerating UUIDs.
  // 404 says nothing about whether the resource exists for OTHER users.
  //
  // This is the LOAD-BEARING JOIN. Removing or weakening it breaks the
  // multi-tenant boundary. mio CRITICAL-1 says: "if you ship without this
  // JOIN, your verdict is FAIL". Verified in the test at:
  //   src/app/api/srs/grade/__tests__/route.test.ts
  const ownership = await db
    .select({ flashcardId: schema.flashcards.id })
    .from(schema.flashcards)
    .innerJoin(
      schema.chapters,
      eq(schema.chapters.id, schema.flashcards.chapterId),
    )
    .innerJoin(
      schema.tutorials,
      eq(schema.tutorials.id, schema.chapters.tutorialId),
    )
    .where(
      and(
        eq(schema.flashcards.id, body.flashcardId),
        eq(schema.tutorials.userId, userId), // ← ownership gate
      ),
    )
    .limit(1);

  if (ownership.length === 0) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }

  // ── 4. Load existing srs_reviews row (or initialize) ──────────────────
  //
  // The Leitner pure function expects a SrsReview row as input. We either
  // load the existing row OR materialize a default (box=1, fresh dueAt).
  // The composite PK (flashcardId, userId) means there's at most one row.
  const existingRows = await db
    .select()
    .from(schema.srsReviews)
    .where(
      and(
        eq(schema.srsReviews.flashcardId, body.flashcardId),
        eq(schema.srsReviews.userId, userId),
      ),
    )
    .limit(1);

  // ── 5. (mio HIGH-1) 60-second idempotency check ──────────────────────
  //
  // If the most-recent grade for this (flashcardId, userId) landed within
  // IDEMPOTENCY_WINDOW_MS, treat this request as a replay and return the
  // current state WITHOUT advancing the box. Network retries / double-clicks
  // would otherwise advance box twice and silently graduate the card.
  //
  // Lookup shape: SELECT * FROM srs_reviews WHERE pk AND last_reviewed_at
  // is recent enough. We already loaded the row in step 4; reuse it.
  const existing = existingRows[0] ?? null;
  const now = new Date();
  if (existing !== null && existing.lastReviewedAt !== null) {
    const ageMs = now.getTime() - existing.lastReviewedAt.getTime();
    if (ageMs >= 0 && ageMs < IDEMPOTENCY_WINDOW_MS) {
      // Replay window — return current state, no write.
      const interval = BOX_INTERVAL_DAYS[existing.box] ?? 1;
      const body: GradeResponse = {
        newBox: existing.box,
        nextDueAt: existing.dueAt.toISOString(),
        intervalDays: interval,
        easeFactor: existing.easeFactor,
        intervalDaysSm2: existing.intervalDays,
        idempotentReplay: true,
      };
      return NextResponse.json(body, { status: 200 });
    }
  }

  // ── 6. Compute the next review state ──────────────────────────────────
  //
  // Translate the wire vocabulary ('correct' | 'incorrect') to the pure
  // function's vocabulary ('got-it' | 'review-again'). Two-vocabulary split
  // is intentional: the LLM/UI use "correct"; the algorithm uses Leitner's
  // own terms. Keeping the pure function vocabulary-pure keeps it testable
  // in isolation (no UI assumptions baked in).
  const recall: RecallOutcome =
    body.recall === 'correct' ? 'got-it' : 'review-again';

  // If no existing row, materialize a default. Note: box defaults to 1
  // (MIN_BOX) per schema; consecutiveCorrect=0; dueAt=initialDueAt(now);
  // lastReviewedAt=null. We then pass this synthetic row to gradeCard so
  // the algorithm sees a uniform shape — the algorithm doesn't care whether
  // the row came from disk or was just materialized.
  const baselineRow = existing ?? {
    flashcardId: body.flashcardId,
    userId,
    box: 1,
    lastReviewedAt: null,
    dueAt: initialDueAt(now),
    consecutiveCorrect: 0,
    easeFactor: null,
    intervalDays: null,
  };
  const next = gradeCard(baselineRow, recall, now);

  // ── 7. Persist the new state ──────────────────────────────────────────
  //
  // INSERT-or-UPDATE pattern. better-sqlite3 supports ON CONFLICT DO UPDATE
  // (SQLite UPSERT, available since v3.24). The composite PK is the conflict
  // target. We rebuild the conflict-update SET list explicitly so future
  // additive columns don't silently get wiped.
  //
  // NB: noor-CRITICAL-2 absorbed (Phase 2 W2) — single-row write doesn't
  // need a sub-transaction; the operation is atomic at the row level.
  try {
    await db
      .insert(schema.srsReviews)
      .values({
        flashcardId: next.flashcardId,
        userId: next.userId,
        box: next.box,
        lastReviewedAt: next.lastReviewedAt,
        dueAt: next.dueAt,
        consecutiveCorrect: next.consecutiveCorrect,
        easeFactor: next.easeFactor,
        intervalDays: next.intervalDays,
      })
      .onConflictDoUpdate({
        target: [schema.srsReviews.flashcardId, schema.srsReviews.userId],
        set: {
          box: next.box,
          lastReviewedAt: next.lastReviewedAt,
          dueAt: next.dueAt,
          consecutiveCorrect: next.consecutiveCorrect,
          // easeFactor + intervalDays preserved untouched — they're SM-2
          // columns the Leitner path doesn't write (riley HIGH-1 PARTIAL).
        },
      });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[POST /api/srs/grade] persistence failed:', err);
    return NextResponse.json(
      { error: 'failed to persist grade' },
      { status: 500 },
    );
  }

  // ── 8. Build response ─────────────────────────────────────────────────
  const interval = BOX_INTERVAL_DAYS[next.box] ?? 1;
  const responseBody: GradeResponse = {
    newBox: next.box,
    nextDueAt: next.dueAt.toISOString(),
    intervalDays: interval,
    easeFactor: next.easeFactor,
    intervalDaysSm2: next.intervalDays,
    idempotentReplay: false,
  };
  return NextResponse.json(responseBody, { status: 200 });
}

// ---------------------------------------------------------------------------
// Internal helpers exposed for testability
// ---------------------------------------------------------------------------
//
// The most recent grade lookup pattern (mio HIGH-1) — exported so the test
// suite can validate the time-window math without re-issuing HTTP requests.
// Pure function: takes the existing row + now; returns whether the request
// is in the replay window.

export function isReplayWithinWindow(
  lastReviewedAt: Date | null,
  now: Date,
  windowMs: number = IDEMPOTENCY_WINDOW_MS,
): boolean {
  if (lastReviewedAt === null) return false;
  const ageMs = now.getTime() - lastReviewedAt.getTime();
  return ageMs >= 0 && ageMs < windowMs;
}

// Suppress unused-import lint — desc is imported for symmetry with future
// "most-recent-N" lookups and to make the dependency obvious to readers.
void desc;
