// src/app/api/ingest/route.ts — POST handler for tutorial ingest.
//
// Per ari HIGH-1: this route MUST return in <50ms. It does NOT await the
// worker. It writes the row, fires setImmediate, returns. Client polls
// /api/tutorials/:id for status changes.
//
// Why setImmediate (not setTimeout(fn,0) and not a real queue):
//   - setImmediate runs the callback in the next event-loop iteration's
//     check phase, AFTER any pending I/O callbacks. Safer than setTimeout(0)
//     which goes into the timer queue (subject to throttling).
//   - For single-user MVP, in-process is correct (see ari "Trade-offs"
//     in design doc). When test4 introduces multi-user, swap setImmediate
//     for a BullMQ enqueue — see report Finding HIGH on the migration path.
//
// Design anchors:
//   - kb:architecture/discipline/stability-patterns §Fail-Fast — validate
//     the request body shape FIRST (zod); reject malformed inputs immediately
//     rather than wasting a DB write on a body we'll have to roll back.
//   - kb:architecture/discipline/stability-patterns §Bulkhead — the
//     setImmediate is wrapped in .catch() so an unhandled worker rejection
//     cannot crash the Node process (which would take down ALL routes,
//     not just this one).

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { db } from '@/db/client';
import { tutorials, users } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { verifySession, SESSION_COOKIE_NAME } from '@/lib/session';
import { ingestWorker } from '@/lib/ingest/worker';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// Request schema
// ---------------------------------------------------------------------------

const IngestBody = z.object({
  s3Url: z
    .string()
    .min(8)               // smallest valid: s3://a/b
    .max(2048)            // sane upper bound
    .startsWith('s3://', { message: 's3Url must start with s3:// (https URLs deferred)' }),
});

// ---------------------------------------------------------------------------
// Rate-limit — in-memory Map, per-session.
// ---------------------------------------------------------------------------
//
// 10 ingests per session per rolling hour. The Map is process-local: a
// Node restart wipes it (acknowledged staleness — see report Finding MEDIUM).
// For MVP single-user this is fine; test4's multi-user phase swaps to a
// shared store (Redis or DB-row counter).
//
// Map shape: userId → Array<ingestTimestampMs>; on each request we drop
// timestamps older than the window and check length. Bounded growth: 10
// entries per user (clipped at insert time).

const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const RATE_LIMIT_MAX_REQUESTS = 10;

type RateLimitState = { timestamps: number[] };
const rateLimitStore = new Map<string, RateLimitState>();

function checkAndRecordRateLimit(userId: string): { allowed: boolean; remaining: number } {
  const now = Date.now();
  const state = rateLimitStore.get(userId) ?? { timestamps: [] };
  // Drop timestamps outside the window.
  const fresh = state.timestamps.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  if (fresh.length >= RATE_LIMIT_MAX_REQUESTS) {
    rateLimitStore.set(userId, { timestamps: fresh });
    return { allowed: false, remaining: 0 };
  }
  fresh.push(now);
  rateLimitStore.set(userId, { timestamps: fresh });
  return { allowed: true, remaining: RATE_LIMIT_MAX_REQUESTS - fresh.length };
}

// ---------------------------------------------------------------------------
// POST /api/ingest
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest): Promise<NextResponse> {
  // ── 1. Session check ──────────────────────────────────────────────────
  // The middleware has already mint-or-verified the session cookie. We
  // re-verify here to extract userId (middleware sets the cookie on the
  // response, but the request object hasn't been mutated; cookie value
  // in req.cookies is whatever the client sent).
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

  // ── 2. Body validation ─────────────────────────────────────────────────
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'request body must be valid JSON' }, { status: 400 });
  }
  const parsed = IngestBody.safeParse(body);
  if (!parsed.success) {
    const fieldErrors = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    return NextResponse.json(
      { error: 'invalid request body', details: fieldErrors },
      { status: 400 },
    );
  }
  const { s3Url } = parsed.data;

  // ── 3. Rate limit ─────────────────────────────────────────────────────
  const rl = checkAndRecordRateLimit(userId);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: 'rate limit: 10 ingests per hour' },
      { status: 429, headers: { 'Retry-After': '3600' } },
    );
  }

  // ── 4. Ensure user row exists (FK target) ─────────────────────────────
  // The middleware mints a userId in the session cookie but does NOT insert
  // a users row (it's edge-runtime; no DB access). The first state-changing
  // route to need the FK target inserts the row. This is the canonical
  // place. Idempotent: ON CONFLICT-style guard via SELECT-then-INSERT.
  try {
    await ensureUserRow(userId);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[POST /api/ingest] ensureUserRow failed:', err);
    return NextResponse.json({ error: 'failed to create user row' }, { status: 500 });
  }

  // ── 5. Insert tutorial row ─────────────────────────────────────────────
  const tutorialId = crypto.randomUUID();
  try {
    await db.insert(tutorials).values({
      id: tutorialId,
      userId,
      sourceS3Url: s3Url,
      status: 'ingesting',
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[POST /api/ingest] tutorial insert failed:', err);
    return NextResponse.json({ error: 'failed to create tutorial row' }, { status: 500 });
  }

  // ── 6. Fire-and-forget worker ─────────────────────────────────────────
  // CRITICAL: this is the load-bearing async boundary. We MUST NOT await.
  // The .catch is the bulkhead: ingestWorker is contracted not to throw,
  // but defense-in-depth keeps a slip-up from killing the Node process.
  setImmediate(() => {
    ingestWorker(tutorialId).catch((err) => {
      // eslint-disable-next-line no-console
      console.error(`[POST /api/ingest] worker rejected for ${tutorialId}:`, err);
    });
  });

  // ── 7. Return immediately ─────────────────────────────────────────────
  return NextResponse.json(
    { id: tutorialId, status: 'ingesting' },
    { status: 202, headers: { Location: `/api/tutorials/${tutorialId}` } },
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Ensure a users row exists for `userId`. Idempotent: SELECT-then-INSERT
 * pattern (better-sqlite3 lacks atomic upsert in drizzle 0.32 API; the
 * race window is small because each session has one process touching it).
 *
 * The session_cookie_hash column is sha256 of the session cookie value;
 * we hash the userId itself (it's a UUID inside a longer signed token,
 * but the userId portion is sufficient for the hash field's purpose:
 * uniqueness + cookie-to-user reverse-lookup index).
 */
async function ensureUserRow(userId: string): Promise<void> {
  const existing = await db.select({ id: users.id })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (existing.length > 0) return;
  const hash = await sha256Hex(userId);
  try {
    await db.insert(users).values({
      id: userId,
      sessionCookieHash: hash,
    });
  } catch (err) {
    // Unique-violation on concurrent insert is benign (idempotent target);
    // any other error rethrows.
    if (err instanceof Error && /UNIQUE constraint/.test(err.message)) return;
    throw err;
  }
}

async function sha256Hex(input: string): Promise<string> {
  const enc = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest('SHA-256', enc);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
