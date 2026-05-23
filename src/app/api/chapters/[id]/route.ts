// src/app/api/chapters/[id]/route.ts — PATCH handler for chapter observational fields.
//
// Purpose: client-side IntersectionObserver / scroll tracker reports
// engagement signals back to the server. The 4 fields this endpoint accepts
// (viewed_at, scroll_depth_pct, last_quiz_attempt_at, last_quiz_score) are
// the riley HIGH-2 "multi-dimensional completion" inputs that feed into
// CompletionTracker.
//
// LOAD-BEARING ABSORB: mio CRITICAL-1 — same ownership-chain pattern as
// the SRS grade endpoint, applied to a different join:
//
//   chapters.tutorial_id → tutorials.user_id === session.userId
//
// Two hops here (no flashcards in the chain). The route MUST verify before
// the UPDATE; otherwise an attacker with a known chapterId from another
// user's tutorial could corrupt their progress fields.
//
// LOAD-BEARING ACK: mio HIGH-4 (CSRF + SameSite=Strict) — same posture as
// the grade endpoint. Middleware enforces double-submit CSRF on PATCH (see
// src/middleware.ts:46, where CSRF_METHODS includes PATCH). SameSite=Strict
// is the primary defense; double-submit is defense-in-depth.
//
// Design anchors:
//   - kb:security-dev/auth-patterns §"IDOR via direct object reference" —
//     compound WHERE with userId is the only safe shape.
//   - kb:architecture/discipline/error-handling-discipline §"Pattern 3:
//     Define errors out of existence" — Zod schema accepts each field as
//     optional; the handler updates ONLY the provided fields, never the
//     omitted ones. Partial-update semantics encoded in the schema, not
//     scattered through if/else branches.
//   - kb:architecture/crosscut/single-responsibility — one change-reason:
//     the chapter-observational-fields wire contract evolves.

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { and, eq, sql } from 'drizzle-orm';
import { db, schema } from '@/db/client';
import { verifySession, SESSION_COOKIE_NAME } from '@/lib/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// Request shape
// ---------------------------------------------------------------------------
//
// Each field is independently optional. The handler reads which fields were
// actually provided (vs. omitted-as-undefined) and writes ONLY those. Zod's
// .optional() lets undefined pass through; we filter at write time.
//
// viewedAt + lastQuizAttemptAt are ISO-8601 strings on the wire (JSON has
// no Date type). We coerce to Date at handler boundary so the Drizzle
// timestamp columns get the correct shape.
//
// scrollDepthPct: 0.0..1.0 (per schema.ts:148 comment).
// lastQuizScore: 0.0..1.0.

const PatchBody = z
  .object({
    viewedAt: z
      .string()
      .datetime({ offset: true, message: 'viewedAt must be ISO-8601 datetime' })
      .optional(),
    scrollDepthPct: z
      .number()
      .min(0, 'scrollDepthPct must be >= 0')
      .max(1, 'scrollDepthPct must be <= 1')
      .optional(),
    lastQuizAttemptAt: z
      .string()
      .datetime({
        offset: true,
        message: 'lastQuizAttemptAt must be ISO-8601 datetime',
      })
      .optional(),
    lastQuizScore: z
      .number()
      .min(0, 'lastQuizScore must be >= 0')
      .max(1, 'lastQuizScore must be <= 1')
      .optional(),
    /**
     * Optional: monotonic increment of time-spent-seconds. The client tracks
     * focused-time and POSTs deltas; the server accumulates server-side.
     * Reject negative deltas (would mean a clock-skew bug or a tampered req).
     */
    timeSpentSecondsDelta: z
      .number()
      .int('timeSpentSecondsDelta must be integer')
      .min(0, 'timeSpentSecondsDelta must be >= 0')
      .max(86_400, 'timeSpentSecondsDelta must be <= one day') // sanity cap
      .optional(),
  })
  // Reject "no fields provided" — a PATCH with empty body is wasted work
  // and probably indicates a client bug. Refuse loudly.
  .refine(
    (b) =>
      b.viewedAt !== undefined ||
      b.scrollDepthPct !== undefined ||
      b.lastQuizAttemptAt !== undefined ||
      b.lastQuizScore !== undefined ||
      b.timeSpentSecondsDelta !== undefined,
    { message: 'at least one field must be provided' },
  );

type PatchBodyT = z.infer<typeof PatchBody>;

// ---------------------------------------------------------------------------
// PATCH /api/chapters/[id]
// ---------------------------------------------------------------------------

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } },
): Promise<NextResponse> {
  // ── 1. Session check ──────────────────────────────────────────────────
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

  // ── 2. Validate chapter id shape ──────────────────────────────────────
  const { id: chapterId } = params;
  if (typeof chapterId !== 'string' || !/^[0-9a-f-]{36}$/i.test(chapterId)) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }

  // ── 3. Body parse + validate ──────────────────────────────────────────
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json(
      { error: 'request body must be valid JSON' },
      { status: 400 },
    );
  }
  const parsed = PatchBody.safeParse(raw);
  if (!parsed.success) {
    const fieldErrors = parsed.error.issues.map(
      (i) => `${i.path.join('.')}: ${i.message}`,
    );
    return NextResponse.json(
      { error: 'invalid request body', details: fieldErrors },
      { status: 400 },
    );
  }
  const body: PatchBodyT = parsed.data;

  // ── 4. (mio CRITICAL-1) Ownership-chain JOIN ──────────────────────────
  //
  // chapters.tutorial_id → tutorials.user_id. If the chapter doesn't exist
  // or belongs to a tutorial owned by a different user, return 404 (not 403)
  // to avoid leaking existence of foreign IDs.
  //
  // We select the chapter id (not just the join result) because the UPDATE
  // below needs a guaranteed-present chapter id; the join confirms both
  // existence AND ownership in a single round-trip.
  const ownership = await db
    .select({ chapterId: schema.chapters.id })
    .from(schema.chapters)
    .innerJoin(
      schema.tutorials,
      eq(schema.tutorials.id, schema.chapters.tutorialId),
    )
    .where(
      and(
        eq(schema.chapters.id, chapterId),
        eq(schema.tutorials.userId, userId), // ← ownership gate
      ),
    )
    .limit(1);

  if (ownership.length === 0) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }

  // ── 5. Build partial-update object ────────────────────────────────────
  //
  // Walk the parsed body and assemble a Drizzle SET payload that contains
  // ONLY the fields the client provided. Omitted fields stay untouched
  // (the column keeps its prior value). This is the per-field-PATCH
  // semantic that lets the client send one field at a time without
  // accidentally nulling the others.
  //
  // Why not just spread `body`? Two reasons:
  //   - Date coercion: ISO strings → Date objects for the timestamp columns.
  //   - Delta accumulation: timeSpentSecondsDelta is NOT a column; it's an
  //     instruction to increment time_spent_seconds. SQL increment via the
  //     `sql\`... + ?\`` template (vs a SELECT-then-UPDATE) avoids the
  //     read-modify-write race.

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const updateValues: Record<string, any> = {};
  if (body.viewedAt !== undefined) {
    updateValues.viewedAt = new Date(body.viewedAt);
  }
  if (body.scrollDepthPct !== undefined) {
    updateValues.scrollDepthPct = body.scrollDepthPct;
  }
  if (body.lastQuizAttemptAt !== undefined) {
    updateValues.lastQuizAttemptAt = new Date(body.lastQuizAttemptAt);
  }
  if (body.lastQuizScore !== undefined) {
    updateValues.lastQuizScore = body.lastQuizScore;
  }
  if (body.timeSpentSecondsDelta !== undefined) {
    // Atomic accumulator: time_spent_seconds = time_spent_seconds + delta.
    // Done at the SQL layer to avoid the read-modify-write race where two
    // concurrent PATCH requests would each compute next = prev + delta from
    // a stale prev and overwrite each other.
    updateValues.timeSpentSeconds = sql`${schema.chapters.timeSpentSeconds} + ${body.timeSpentSecondsDelta}`;
  }

  // ── 6. Apply update ───────────────────────────────────────────────────
  try {
    await db
      .update(schema.chapters)
      .set(updateValues)
      .where(eq(schema.chapters.id, chapterId));
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[PATCH /api/chapters/[id]] update failed:', err);
    return NextResponse.json(
      { error: 'failed to update chapter' },
      { status: 500 },
    );
  }

  // ── 7. Return success ─────────────────────────────────────────────────
  // 204 No Content would be more REST-pure, but 200 with the updated-fields
  // echo helps the client reconcile its local state without an extra GET.
  return NextResponse.json(
    {
      ok: true,
      updated: Object.keys(updateValues),
    },
    { status: 200, headers: { 'Cache-Control': 'no-store' } },
  );
}
