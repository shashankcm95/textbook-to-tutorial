// src/app/api/tutorials/[id]/route.ts — GET handler for status polling.
//
// Purpose: client of /api/ingest polls this endpoint to track ingest progress.
// Returns the minimal projection needed by the client: status + advisory
// errorMessage + counts + timestamp. No chapter rows here (those stream via
// the SSE endpoint in Phase 3, owned by react-frontend + ml-engineer pair).
//
// Per ari MEDIUM-3: GET endpoints are CSRF-exempt by spec (no state change).
// The middleware's CSRF check excludes GET methods (CSRF_METHODS set in
// src/middleware.ts:46 includes only POST/PUT/PATCH/DELETE). Verified.
//
// Design anchors:
//   - kb:architecture/discipline/stability-patterns §Fail-Fast — 404 on
//     not-found is preferable to 403 "forbidden" leaking info about which
//     tutorial ids exist for OTHER users; we collapse not-found + not-owned
//     into a single 404 response. Security-by-obscurity, applied minimally.
//   - kb:architecture/crosscut/single-responsibility — this file is the read
//     projection for tutorial status. It does NOT mutate; it does NOT enqueue;
//     it does NOT stream. One reason-to-change (status-shape evolution).

import { NextResponse, type NextRequest } from 'next/server';
import { db } from '@/db/client';
import { tutorials } from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import { verifySession, SESSION_COOKIE_NAME } from '@/lib/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// GET /api/tutorials/:id
// ---------------------------------------------------------------------------

export async function GET(
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

  // ── 2. Validate id shape (defense-in-depth) ──────────────────────────
  const { id } = params;
  if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }

  // ── 3. Read row with ownership guard ──────────────────────────────────
  // Compound WHERE: id AND userId. Collapses "not found" and "not owned"
  // into a single 404 response; no info leak about row existence.
  const rows = await db
    .select({
      id: tutorials.id,
      status: tutorials.status,
      errorMessage: tutorials.errorMessage,
      totalPages: tutorials.totalPages,
      totalChapters: tutorials.totalChapters,
      createdAt: tutorials.createdAt,
    })
    .from(tutorials)
    .where(and(eq(tutorials.id, id), eq(tutorials.userId, userId)))
    .limit(1);

  if (rows.length === 0) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
  const row = rows[0]!; // length-checked above

  // ── 4. Return projection ──────────────────────────────────────────────
  // Cache-Control: no-store — polling clients should never cache the
  // status response; staleness causes UI to show "still ingesting" when
  // server has already transitioned. The middleware doesn't add caching
  // headers but downstream proxies might infer one without this.
  return NextResponse.json(
    {
      id: row.id,
      status: row.status,
      errorMessage: row.errorMessage,
      totalPages: row.totalPages,
      totalChapters: row.totalChapters,
      createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
    },
    { status: 200, headers: { 'Cache-Control': 'no-store' } },
  );
}
