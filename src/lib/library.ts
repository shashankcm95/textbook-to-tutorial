/**
 * src/lib/library.ts — pure helpers + the loader for the home library page.
 *
 * Three responsibilities:
 *
 *   1. `loadLibrary(userId)` — one Drizzle query that joins tutorials ←
 *      chapters and aggregates per-tutorial counts + max viewed_at.
 *      Returns the projection the library page renders.
 *
 *   2. `computeAggregateStatus(row)` — pure mapping from the persisted
 *      tutorial status + chapter completion counts to a display-friendly
 *      enum the UI uses to pick a color/label. Split from the loader so
 *      it can be tested without a DB.
 *
 *   3. `validateS3UrlShape(input)` — pure client-side pre-validator for
 *      the "Add tutorial" form. The authoritative validator lives in
 *      the POST /api/ingest zod schema; this exists to surface obvious
 *      shape mistakes before the network round-trip.
 *
 * Why not a stored `tutorials.last_viewed_at`: chapters.viewed_at is
 * already populated by the riley HIGH-2 absorb tracker. Deriving via
 * SQL MAX avoids a migration + a parallel write path. One JOIN line at
 * read time vs five migration files.
 *
 * Single-responsibility: this module owns the LIBRARY READ projection.
 * It does NOT own per-tutorial detail (that's tutorials/[id]/page.tsx)
 * and does NOT own ingest (api/ingest/route.ts).
 */

import { desc, eq, sql } from 'drizzle-orm';
import { db, schema } from '@/db/client';
import type { TutorialStatus } from '@/db/schema';

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The shape the library page renders. NOT a 1:1 of the tutorials row —
 * carries the per-tutorial aggregates (chapter completion counts, last
 * viewed) computed at query time.
 */
export interface LibraryTutorialRow {
  id: string;
  /** Book title from PDF metadata. NULL → derive from sourceS3Url. */
  bookTitle: string | null;
  bookAuthor: string | null;
  /** 'pdf-info' | 'pdf-xmp' | 'filename' | 'none' | null — drives the
   *  "Auto-detected" warning badge in the tutorial reader; here it's
   *  also useful for showing the user when a title is best-effort. */
  metadataSource: string | null;
  sourceS3Url: string;
  status: TutorialStatus;
  errorMessage: string | null;
  totalChapters: number | null;
  /** COUNT(chapters WHERE status='complete') aggregated at query time. */
  completeChapters: number;
  /** One-way ratchet from the tutorials row; not an aggregate. */
  maxUnlockedChapterIdx: number;
  /** MAX(chapters.viewed_at) in milliseconds; null when no chapter viewed. */
  lastViewedAtMs: number | null;
  createdAtMs: number;
}

/**
 * Display-side status enum. Distinct from the persisted `TutorialStatus`
 * because the UI cares about post-generation distinctions (partial vs
 * fully-complete) that the DB collapses into `status='complete'`.
 */
export type AggregateStatus =
  | 'ingesting'
  | 'generating'
  | 'partial'
  | 'ready'
  | 'error';

export type S3ValidationResult =
  | { ok: true }
  | { ok: false; reason: string };

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers (testable without DB)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Map the persisted state + per-tutorial completion counts to the
 * display-side status the UI renders.
 *
 * Mappings:
 *   - error                          → 'error'
 *   - ingesting | parsing            → 'ingesting' (still in PDF-parse phase)
 *   - ready-to-generate              → 'generating' (user just hit start)
 *   - generating                     → 'generating'
 *   - complete + all chapters done   → 'ready'
 *   - complete + some chapters left  → 'partial' (UI nudges to resume)
 */
export function computeAggregateStatus(
  row: Readonly<
    Pick<
      LibraryTutorialRow,
      'status' | 'totalChapters' | 'completeChapters' | 'errorMessage'
    >
  >,
): AggregateStatus {
  if (row.status === 'error') return 'error';
  if (row.status === 'ingesting' || row.status === 'parsing') return 'ingesting';
  if (row.status === 'ready-to-generate' || row.status === 'generating') {
    return 'generating';
  }
  // status === 'complete' below
  if (
    row.totalChapters != null &&
    row.totalChapters > 0 &&
    row.completeChapters < row.totalChapters
  ) {
    return 'partial';
  }
  return 'ready';
}

/**
 * Surface-level shape validator for the "Add tutorial" form input. The
 * authoritative validator lives in the POST /api/ingest zod schema; this
 * runs client-side to surface the obvious mistakes faster than a round
 * trip.
 *
 * Accepted shape: `s3://<bucket>/<key>` where bucket has ≥1 char, key
 * has ≥1 char (key allowed to contain slashes; folders in S3 are just
 * key prefixes), no whitespace, total length 8..2048.
 */
export function validateS3UrlShape(input: string): S3ValidationResult {
  if (typeof input !== 'string') return { ok: false, reason: 'not a string' };
  const trimmed = input.trim();
  if (trimmed.length === 0) return { ok: false, reason: 'empty' };
  if (trimmed.length < 8) return { ok: false, reason: 'too short' };
  if (trimmed.length > 2048) return { ok: false, reason: 'too long (max 2048)' };
  if (!trimmed.startsWith('s3://')) {
    return { ok: false, reason: 'must start with s3://' };
  }
  if (/\s/.test(trimmed)) {
    // Spaces are LEGAL in S3 keys but break URL handling enough downstream
    // that we surface this early. The /api/ingest path normalizes via
    // URL encoding; UX-wise we want the user to paste a clean s3:// URL.
    // (Detected = warn-and-allow at server; here we just warn-and-allow
    // by NOT failing — but flag whitespace at start/end as a real issue.)
  }
  const rest = trimmed.slice('s3://'.length);
  if (rest.length === 0) {
    return { ok: false, reason: 'expected s3://bucket/key (missing bucket)' };
  }
  const firstSlash = rest.indexOf('/');
  if (firstSlash <= 0) {
    return { ok: false, reason: 'expected s3://bucket/key (missing /key)' };
  }
  if (firstSlash === rest.length - 1) {
    return {
      ok: false,
      reason: 'expected s3://bucket/key (key is empty after final /)',
    };
  }
  return { ok: true };
}

/**
 * Sort comparator: most-recently-viewed first, then most-recently-created
 * first as tiebreak. Pure; used both at query level (ORDER BY) and as a
 * defensive client-side re-sort if the caller hands an unordered array.
 */
export function compareLibraryRows(
  a: Pick<LibraryTutorialRow, 'lastViewedAtMs' | 'createdAtMs'>,
  b: Pick<LibraryTutorialRow, 'lastViewedAtMs' | 'createdAtMs'>,
): number {
  // null lastViewed sorts AFTER any timestamp (NULLS LAST semantics).
  const aV = a.lastViewedAtMs ?? -Infinity;
  const bV = b.lastViewedAtMs ?? -Infinity;
  if (aV !== bV) return bV - aV;
  return b.createdAtMs - a.createdAtMs;
}

/**
 * Resolve a display title when bookTitle is null. Strips the s3://bucket/
 * prefix + the .pdf extension and decodes %20 / + to spaces.
 *
 * Falls back to "(untitled tutorial)" if extraction yields an empty string.
 */
export function deriveFallbackTitle(sourceS3Url: string): string {
  try {
    // Match s3://<bucket>/<rest> and use <rest>'s final path segment.
    const m = /^s3:\/\/[^/]+\/(.+)$/.exec(sourceS3Url);
    if (!m || !m[1]) return '(untitled tutorial)';
    const key = m[1];
    const lastSlash = key.lastIndexOf('/');
    const filename = lastSlash >= 0 ? key.slice(lastSlash + 1) : key;
    const stripped = filename
      .replace(/\.pdf$/i, '')
      .replace(/\+/g, ' ');
    const decoded = (() => {
      try {
        return decodeURIComponent(stripped);
      } catch {
        return stripped;
      }
    })();
    const cleaned = decoded.trim();
    return cleaned.length > 0 ? cleaned : '(untitled tutorial)';
  } catch {
    return '(untitled tutorial)';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Loader (DB-bound)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Load every tutorial owned by `userId` plus per-tutorial aggregates
 * needed for the library page. One round-trip; ORDER BY at the SQL
 * layer so the caller doesn't re-sort.
 *
 * The aggregate query joins `chapters` LEFT so a tutorial with zero
 * chapter rows (rare — only the very-early ingesting state) still
 * appears in the result.
 */
export async function loadLibrary(
  userId: string,
): Promise<LibraryTutorialRow[]> {
  if (typeof userId !== 'string' || userId.length === 0) return [];

  // Use Drizzle's `sql` helper for the aggregates. Drizzle's typed-builder
  // path doesn't yet expose MAX/COUNT FILTER cleanly enough; the raw
  // expressions stay readable and SQL-injection-safe (userId is bound).
  const rows = await db
    .select({
      id: schema.tutorials.id,
      bookTitle: schema.tutorials.bookTitle,
      bookAuthor: schema.tutorials.bookAuthor,
      metadataSource: schema.tutorials.metadataSource,
      sourceS3Url: schema.tutorials.sourceS3Url,
      status: schema.tutorials.status,
      errorMessage: schema.tutorials.errorMessage,
      totalChapters: schema.tutorials.totalChapters,
      maxUnlockedChapterIdx: schema.tutorials.maxUnlockedChapterIdx,
      createdAt: schema.tutorials.createdAt,
      completeChaptersRaw: sql<number>`
        COALESCE(SUM(CASE WHEN ${schema.chapters.status} = 'complete' THEN 1 ELSE 0 END), 0)
      `,
      // chapters.viewed_at is stored as unix-seconds via the timestamp mode;
      // MAX returns the same unit. Convert to ms in the projection step.
      lastViewedAtSecondsRaw: sql<number | null>`MAX(${schema.chapters.viewedAt})`,
    })
    .from(schema.tutorials)
    .leftJoin(
      schema.chapters,
      eq(schema.chapters.tutorialId, schema.tutorials.id),
    )
    .where(eq(schema.tutorials.userId, userId))
    .groupBy(schema.tutorials.id)
    .orderBy(
      desc(sql`MAX(${schema.chapters.viewedAt})`),
      desc(schema.tutorials.createdAt),
    );

  return rows.map((r) => ({
    id: r.id,
    bookTitle: r.bookTitle,
    bookAuthor: r.bookAuthor,
    metadataSource: r.metadataSource,
    sourceS3Url: r.sourceS3Url,
    status: r.status,
    errorMessage: r.errorMessage,
    totalChapters: r.totalChapters,
    completeChapters: Number(r.completeChaptersRaw ?? 0),
    maxUnlockedChapterIdx: r.maxUnlockedChapterIdx,
    lastViewedAtMs:
      r.lastViewedAtSecondsRaw != null
        ? Number(r.lastViewedAtSecondsRaw) * 1000
        : null,
    createdAtMs:
      r.createdAt instanceof Date
        ? r.createdAt.getTime()
        : Number(r.createdAt ?? 0) * 1000,
  }));
}

