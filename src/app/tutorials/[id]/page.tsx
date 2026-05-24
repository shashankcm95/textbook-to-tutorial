/**
 * src/app/tutorials/[id]/page.tsx — Server Component for the tutorial reader.
 *
 * Boundary discipline (per kb:web-dev/react-essentials §"Server vs Client
 * components"): this file is RSC-only — no `'use client'`, no hooks, no event
 * handlers. It does three jobs:
 *
 *   1. Re-verify the session cookie server-side and resolve userId.
 *      (Middleware already mint-or-verified, but defense-in-depth at the route
 *       layer is the project's pattern — see src/app/api/tutorials/[id]/route.ts:38-50.)
 *
 *   2. Compound-WHERE ownership query: tutorials.id === params.id AND
 *      tutorials.user_id === session.userId. Collapses "not found" and
 *      "not owned" into one 404 → notFound() (Next.js renders not-found.tsx).
 *
 *   3. Hand the verified data to <StreamingClient> as serializable props.
 *      The CSRF token is read from cookies and forwarded so the client island
 *      can echo it back on POST /api/srs/grade (double-submit pattern; see
 *      src/middleware.ts:78-93 and mio HIGH-4 acknowledgment in the SRS
 *      route comments).
 *
 * Why a Server Component (not a Client page that fetches in useEffect):
 *   - Single network round-trip for first paint — no client-side spinner waiting
 *     on the auth+ownership check.
 *   - The DB call (better-sqlite3) is Node-only; running it server-side keeps
 *     the bundle thin (no client-side Drizzle ORM shipping to the browser).
 *   - SEO is irrelevant here (the page is auth-gated and personal), but
 *     server rendering still beats a flash-of-empty-content.
 *
 * Why we still ship StreamingClient (a Client island):
 *   - The SSE stream + cost polling + flashcard grading are inherently
 *     interactive. The composition pattern (per kb:web-dev/react-essentials
 *     §"Composition over inheritance") is: server shell + thin client island
 *     for state-bearing work. No prop-drilling, no context — the island owns
 *     its lifecycle locally.
 *
 * Folds honored explicitly here:
 *   - **mio CRITICAL-1** (Phase 3 SRS endpoint ownership): this page applies
 *     the same compound-WHERE pattern at the page-render boundary so a forged
 *     URL like /tutorials/<foreign-uuid> returns 404 BEFORE the client island
 *     mounts. The SRS endpoint enforces it again at write time; defense-in-depth.
 *   - **riley HIGH-2** (multi-dimensional completion): we hand the FULL
 *     chapters projection (including viewedAt, scrollDepthPct, lastQuizAttemptAt,
 *     lastQuizScore) to the client. The CompletionTracker reads all 4 signals.
 *
 * KB: kb:web-dev/react-essentials §"Composition over inheritance"; §"Anti-patterns"
 *     §"Don't fetch in useEffect when the data is server-resolvable".
 */

import { cookies } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { and, asc, eq, gte } from 'drizzle-orm';
import { db, schema } from '@/db/client';
import {
  verifySession,
  SESSION_COOKIE_NAME,
  CSRF_COOKIE_NAME,
} from '@/lib/session';
import { StreamingClient } from './StreamingClient';
import type { ReviewableCard } from '@/components/FlashcardReviewer';
import type { QuizQuestion, LLMFlashcard } from '@/lib/types';

// Force dynamic rendering — this page is per-user; static caching would be
// catastrophic (one user could see another's tutorial). Setting at the file
// level (vs in headers) is the Next.js-idiomatic way to opt out of SSG/ISR.
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface TutorialPageProps {
  params: { id: string };
}

export default async function TutorialPage({ params }: TutorialPageProps) {
  // ── 1. Validate id shape (defense-in-depth; sibling routes use this regex) ──
  const { id: tutorialId } = params;
  if (typeof tutorialId !== 'string' || !/^[0-9a-f-]{36}$/i.test(tutorialId)) {
    notFound();
  }

  // ── 2. Session re-verify (server-side; middleware already did this once) ──
  const secret = process.env.SESSION_SECRET ?? '';
  if (!secret) {
    // 500 surfaced as a redirect to the home — better UX than a blank page.
    // The middleware already returns 500 on this case; reaching here means a
    // race in env loading. We choose redirect-to-home so the user can retry.
    redirect('/');
  }
  const cookieStore = cookies();
  const sessionCookieValue = cookieStore.get(SESSION_COOKIE_NAME)?.value ?? '';
  const payload = await verifySession(sessionCookieValue, secret);
  if (!payload) {
    // No valid session — the middleware will mint one on the next request.
    // Redirect home so they land on the public surface, not an auth wall they
    // don't understand (this is anonymous-session, not login-gated).
    redirect('/');
  }
  const userId = payload.userId;

  // ── 3. Read CSRF token to forward to the client island ──────────────────
  const csrfToken = cookieStore.get(CSRF_COOKIE_NAME)?.value ?? '';

  // ── 4. Ownership + chapters fetch (mio CRITICAL-1 enforced at view layer) ──
  // Compound WHERE: tutorial id AND user_id. Collapses not-found + not-owned
  // into single 404, mirroring src/app/api/tutorials/[id]/route.ts:60-77.
  const tutorialRows = await db
    .select({
      id: schema.tutorials.id,
      status: schema.tutorials.status,
      totalChapters: schema.tutorials.totalChapters,
      errorMessage: schema.tutorials.errorMessage,
      // ── lazy-hybrid-chunking gating ratchet (Commit 1 / 3) ──
      maxUnlockedChapterIdx: schema.tutorials.maxUnlockedChapterIdx,
    })
    .from(schema.tutorials)
    .where(
      and(
        eq(schema.tutorials.id, tutorialId),
        eq(schema.tutorials.userId, userId),
      ),
    )
    .limit(1);
  if (tutorialRows.length === 0) {
    notFound();
  }
  const tutorial = tutorialRows[0]!;

  // ── 5. Load chapters (all fields incl. riley HIGH-2 observational columns) ──
  const initialChapters = await db
    .select()
    .from(schema.chapters)
    .where(eq(schema.chapters.tutorialId, tutorialId))
    .orderBy(asc(schema.chapters.ordinal));

  // ── 5.b. Load per-chapter questions + flashcards (UX persona Sprint A,
  //         finding T1.1). The previous implementation never hydrated these
  //         from DB on revisit — `parsedQuestions` only got populated mid-
  //         stream, so a returning user would see narrative but no quiz, and
  //         could press "Mark complete & unlock next" without ever attempting
  //         the gate. Loading them here closes the loop. Single chapter-join
  //         for both (the DB is sub-100KB; one extra scan).
  const chapterIds = initialChapters.map((c) => c.id);
  const allQuestionsRows = chapterIds.length === 0
    ? []
    : await db
        .select()
        .from(schema.questions)
        .innerJoin(
          schema.chapters,
          eq(schema.chapters.id, schema.questions.chapterId),
        )
        .where(eq(schema.chapters.tutorialId, tutorialId));
  const allChapterFlashcardsRows = chapterIds.length === 0
    ? []
    : await db
        .select({
          id: schema.flashcards.id,
          chapterId: schema.flashcards.chapterId,
          front: schema.flashcards.front,
          back: schema.flashcards.back,
          sourceParagraphRef: schema.flashcards.sourceParagraphRef,
        })
        .from(schema.flashcards)
        .innerJoin(
          schema.chapters,
          eq(schema.chapters.id, schema.flashcards.chapterId),
        )
        .where(eq(schema.chapters.tutorialId, tutorialId));

  // Group by chapterId. Parse `options_json` into the tuple shape the UI
  // expects. Reshape DB rows into the in-memory LLMFlashcard / QuizQuestion
  // contracts (camelCase + tuple-typed options).
  const initialQuestionsByChapter: Record<string, QuizQuestion[]> = {};
  for (const row of allQuestionsRows) {
    const q = row.questions;
    let parsedOptions: unknown;
    try {
      parsedOptions = JSON.parse(q.optionsJson);
    } catch {
      continue;
    }
    if (!Array.isArray(parsedOptions) || parsedOptions.length !== 4) continue;
    if (!parsedOptions.every((o) => typeof o === 'string')) continue;
    const correctIdx = q.correctIndex;
    if (correctIdx !== 0 && correctIdx !== 1 && correctIdx !== 2 && correctIdx !== 3) continue;
    const ref = q.sourceParagraphRef;
    if (!/^page\d+:paragraph\d+$/.test(ref)) continue;
    const list = initialQuestionsByChapter[q.chapterId] ?? [];
    list.push({
      prompt: q.prompt,
      options: parsedOptions as [string, string, string, string],
      correctIndex: correctIdx,
      explanation: q.explanation,
      sourceParagraphRef: ref as QuizQuestion['sourceParagraphRef'],
    });
    initialQuestionsByChapter[q.chapterId] = list;
  }
  const initialFlashcardsByChapter: Record<string, LLMFlashcard[]> = {};
  for (const f of allChapterFlashcardsRows) {
    const list = initialFlashcardsByChapter[f.chapterId] ?? [];
    const ref = f.sourceParagraphRef;
    if (!/^page\d+:paragraph\d+$/.test(ref)) continue;
    list.push({
      front: f.front,
      back: f.back,
      sourceParagraphRef: ref as LLMFlashcard['sourceParagraphRef'],
    });
    initialFlashcardsByChapter[f.chapterId] = list;
  }

  // ── 6. Load due flashcards (for FlashcardReviewer) ──────────────────────
  // Surface only cards whose dueAt is in the past OR whose review row doesn't
  // exist yet (new cards). To keep the projection simple, we issue two reads:
  //   a. All flashcards for chapters in this tutorial.
  //   b. SRS reviews keyed by (flashcardId, userId) — joined client-side
  //      (small N typical, sub-100 cards per tutorial).
  const allFlashcards = await db
    .select({
      id: schema.flashcards.id,
      chapterId: schema.flashcards.chapterId,
      front: schema.flashcards.front,
      back: schema.flashcards.back,
      sourceParagraphRef: schema.flashcards.sourceParagraphRef,
    })
    .from(schema.flashcards)
    .innerJoin(
      schema.chapters,
      eq(schema.chapters.id, schema.flashcards.chapterId),
    )
    .where(eq(schema.chapters.tutorialId, tutorialId));

  // Reviews for cards in this set, owned by this user. We do NOT filter by
  // dueAt server-side — the reviewer UI shows everything and lets the user
  // skip cards they don't want. (Cheap: <100 rows typical, single index scan.)
  const reviewRows =
    allFlashcards.length === 0
      ? []
      : await db
          .select()
          .from(schema.srsReviews)
          .where(eq(schema.srsReviews.userId, userId));

  // Build a lookup map for O(1) flashcard → review pairing.
  const reviewByFlashcardId = new Map(
    reviewRows.map((r) => [r.flashcardId, r] as const),
  );

  // Materialize the ReviewableCard[] payload the FlashcardReviewer expects.
  // Filter to cards either due (dueAt <= now) OR never reviewed (no row).
  const now = new Date();
  const initialReviewCards: ReviewableCard[] = allFlashcards
    .map((fc) => {
      const review = reviewByFlashcardId.get(fc.id) ?? null;
      const due = review === null ? true : review.dueAt <= now;
      return { flashcard: fc, review, due };
    })
    .filter((c) => c.due)
    .map(({ flashcard, review }) => ({ flashcard, review }));

  return (
    <StreamingClient
      tutorialId={tutorialId}
      initialChapters={initialChapters}
      initialReviewCards={initialReviewCards}
      initialQuestionsByChapter={initialQuestionsByChapter}
      initialFlashcardsByChapter={initialFlashcardsByChapter}
      csrfToken={csrfToken}
      maxUnlockedChapterIdx={tutorial.maxUnlockedChapterIdx}
    />
  );
}

// Suppress unused-import lint (gte may be reused later for due-only filter).
// Keeping the import readable signals intent: "due filter lives here, not in DB".
void gte;
