/**
 * src/app/api/tutorials/[id]/cost/route.ts — JSON polling endpoint for
 * the cost-chip UI component (casey).
 *
 * Purpose: lightweight slow-poll (~15s cadence) of per-tutorial spend
 * accounting. The SSE stream emits cost-update frames at chapter
 * boundaries during generation; this endpoint is the AT-REST view —
 * a user landing on a complete tutorial sees the final spend without
 * needing to re-open the stream.
 *
 * Design anchors:
 *   - kb:architecture/ai-systems/inference-cost-management §"budget-tracker
 *     per-spawn accounting" — the spend ledger (parses_cost) is the single
 *     source of truth for cost questions; this endpoint just aggregates.
 *   - kb:ml-dev/training-vs-inference §"Drift monitoring" — the spend
 *     ledger is ALSO our cost-drift signal. If average $-per-tutorial
 *     creeps up over time, we'll see it via aggregation queries against
 *     parses_cost. Per-tutorial visibility (this endpoint) is the unit
 *     of operational observability.
 *   - kb:architecture/discipline/error-handling-discipline §"Pattern 3:
 *     Define errors out of existence" — COALESCE in spentSoFar means
 *     "no rows yet" returns 0 instead of null; no NPE risk downstream.
 *
 * SRP boundary: this file is a READ projection of parses_cost. It does
 * NOT enforce policy (cost-cap.ts), compute estimates (cost.ts), or
 * emit events (stream/route.ts). One change-reason: the cost-chip's
 * wire shape evolved.
 *
 * Cache discipline: NO caching (no-store) for the same reason as the
 * sibling status route — staleness here would make the chip lie. The
 * underlying SUM is a cheap indexed read.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { eq, and, sql } from 'drizzle-orm';
import { db, schema } from '@/db/client';
import { verifySession, SESSION_COOKIE_NAME } from '@/lib/session';
import { env } from '@/lib/env';
import { spentSoFar } from '@/lib/openai/cost-cap';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ───────────────────────────────────────────────────────────────────────────
// Response shape (the wire contract with casey's CostChip)
// ───────────────────────────────────────────────────────────────────────────

interface CostResponse {
  /** Total spent so far on THIS tutorial, USD. */
  spentUsd: number;
  /** The configured per-tutorial cap, USD. From env.COST_CAP_USD. */
  capUsd: number;
  /** 0-100, rounded. UI renders as cost-chip fill bar. */
  pct: number;
  /**
   * ISO-8601 timestamp of the most recent parses_cost row for this
   * tutorial. Null if no spend has happened yet (fresh tutorial).
   * The UI uses this for "last updated 12s ago" microcopy.
   */
  lastUpdatedAt: string | null;
  /** Total number of OpenAI calls billed against this tutorial. */
  callCount: number;
}

// ───────────────────────────────────────────────────────────────────────────
// GET /api/tutorials/:id/cost
// ───────────────────────────────────────────────────────────────────────────

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } },
): Promise<NextResponse> {
  // ── 1. Session check (mirrors stream route + status route) ────────────
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

  // ── 2. Validate id shape ───────────────────────────────────────────────
  const { id: tutorialId } = params;
  if (typeof tutorialId !== 'string' || !/^[0-9a-f-]{36}$/i.test(tutorialId)) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }

  // ── 3. Ownership check (compound WHERE; 404 on miss-or-foreign) ────────
  const ownershipRows = await db
    .select({ id: schema.tutorials.id })
    .from(schema.tutorials)
    .where(
      and(
        eq(schema.tutorials.id, tutorialId),
        eq(schema.tutorials.userId, userId),
      ),
    )
    .limit(1);
  if (ownershipRows.length === 0) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }

  // ── 4. Aggregate the cost ledger ───────────────────────────────────────
  // Three small reads (SUM, MAX, COUNT). Each is indexed on tutorial_id
  // per schema.ts:283. Could be folded into one SELECT with multiple
  // aggregates; kept separate for readability and because spentSoFar is
  // already a shared helper (avoid duplicating its COALESCE logic).
  const spent = await spentSoFar(tutorialId);

  // Use sql<T>`...` template form — matches the in-project precedent
  // (src/lib/openai/cost-cap.ts:85-89) and avoids a drizzle-version risk
  // on the `max`/`count` helper export shape. SQLite returns a single row
  // with both aggregates regardless of how many parses_cost rows exist.
  const aggRows = await db
    .select({
      lastAt: sql<number | null>`MAX(${schema.parsesCost.createdAt})`,
      callCount: sql<number>`COUNT(${schema.parsesCost.id})`,
    })
    .from(schema.parsesCost)
    .where(eq(schema.parsesCost.tutorialId, tutorialId));

  const agg = aggRows[0];
  // SQLite stores timestamps as integer epoch seconds (per Drizzle's
  // { mode: 'timestamp' } column config — schema.ts:280). When read via
  // the raw `sql<>` template (vs. the column reference), the type system
  // sees the raw number; we convert to Date below.
  const lastAtRaw = agg?.lastAt ?? null;
  const callCount = Number(agg?.callCount ?? 0);

  // ── 5. Build response payload ──────────────────────────────────────────
  const cap = env.COST_CAP_USD;
  const pct = cap > 0 ? Math.round((spent / cap) * 100) : 0;

  // lastUpdatedAt: when read via raw sql template, MAX(timestamp) comes
  // back as an integer (epoch seconds — SQLite native storage for the
  // { mode: 'timestamp' } column). Convert: secs → ms → ISO string.
  // If null (no rows yet), we send null — UI shows "—" placeholder.
  const lastUpdatedAt =
    typeof lastAtRaw === 'number'
      ? new Date(lastAtRaw * 1000).toISOString()
      : lastAtRaw instanceof Date
        ? lastAtRaw.toISOString()
        : null;

  const body: CostResponse = {
    spentUsd: round4(spent),
    capUsd: cap,
    pct,
    lastUpdatedAt,
    callCount,
  };

  return NextResponse.json(body, {
    status: 200,
    // no-store: same reasoning as sibling status route. Polling clients
    // MUST NOT cache; staleness would make the cost-chip lie.
    headers: { 'Cache-Control': 'no-store' },
  });
}

// ───────────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────────

/** Round to 4 decimal places (USD precision for the UI cost-chip). */
function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}
