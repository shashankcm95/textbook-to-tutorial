// src/lib/ingest/worker.ts — background ingest worker (NOT request-bound).
//
// Per ari HIGH-1 absorb: /api/ingest route MUST NOT block on parse. The
// route writes a `tutorials` row with status='ingesting' and fires this
// worker via setImmediate(); the worker does the heavy I/O off the
// request path. Client polls /api/tutorials/:id for status changes.
//
// Lifecycle:
//   1. Read tutorials row (verify status === 'ingesting'; idempotent guard)
//   2. fetchPdfFromS3(url, 50MB cap)
//   3. Compute sha256 (for future dedupe)
//   4. parsePdfBuffer
//   5. detectChapters
//   6. Single transaction:
//        UPDATE tutorials SET status='ready-to-generate' + counts
//        INSERT chapters rows (status='pending', source_paragraphs_json populated)
//   7. On any failure: UPDATE tutorials SET status='error', error_message
//
// Design anchors:
//   - kb:architecture/discipline/stability-patterns §Steady State — every
//     async operation has a bounded outcome (success OR error-status write);
//     no operation leaves tutorials.status='ingesting' indefinitely. If the
//     Node process dies mid-parse, the row stays 'ingesting' — see report
//     Finding HIGH (recovery on restart deferred to test4).
//   - kb:architecture/discipline/stability-patterns §Bulkhead — worker errors
//     are CAUGHT inside ingestWorker; never propagate to setImmediate's
//     unhandled rejection path. (setImmediate(() => promise) without .catch
//     IS an unhandled-rejection vector; we defend at the boundary.)
//   - kb:architecture/crosscut/single-responsibility — this file does
//     orchestration; parse.ts does parse; chapter-detect.ts does detection;
//     s3.ts does fetch. Folding any of those here would conflate change-
//     reasons (per "actor test").

import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { tutorials, chapters } from '@/db/schema';
import { fetchPdfFromS3 } from '@/lib/s3';
import { parsePdfBuffer } from '@/lib/pdf/parse';
import { detectChapters } from '@/lib/pdf/chapter-detect';

const MAX_PDF_BYTES = 50 * 1024 * 1024; // 50 MB — matches s3.ts default cap

/**
 * Run the ingest pipeline for a tutorial id.
 *
 * Contract:
 *   - NEVER throws. All errors are caught and written to tutorials.errorMessage.
 *     The caller (setImmediate from /api/ingest) does not await; an unhandled
 *     rejection here would crash the Node process. The boundary is here.
 *   - Idempotent: re-invocation on a tutorial whose status is past 'ingesting'
 *     exits early without modification. Handles the "Node restarted; on
 *     boot, requeue stuck ingests" scenario the operator would write later.
 *
 * @param tutorialId   the tutorials.id to process; resolves the s3 URL itself
 */
export async function ingestWorker(tutorialId: string): Promise<void> {
  // ── Phase 1: load + idempotency check ─────────────────────────────────
  let tutorial;
  try {
    const rows = await db.select().from(tutorials).where(eq(tutorials.id, tutorialId)).limit(1);
    tutorial = rows[0];
  } catch (err) {
    // DB unreachable — log and bail. Cannot even write error status.
    // eslint-disable-next-line no-console
    console.error(`[ingestWorker] db read failed for ${tutorialId}:`, err);
    return;
  }
  if (!tutorial) {
    // eslint-disable-next-line no-console
    console.error(`[ingestWorker] tutorial ${tutorialId} not found`);
    return;
  }
  if (tutorial.status !== 'ingesting') {
    // Already past the ingest phase — idempotent no-op. Re-invocation safe.
    return;
  }

  // ── Phase 2: pipeline (fetch → parse → detect) ────────────────────────
  try {
    const { buffer } = await fetchPdfFromS3(tutorial.sourceS3Url, MAX_PDF_BYTES);
    const sha256 = createHash('sha256').update(buffer).digest('hex');
    const parsed = await parsePdfBuffer(buffer);
    const detected = detectChapters(parsed);

    // ── Phase 3: persist (single transaction) ───────────────────────────
    // better-sqlite3's drizzle adapter exposes `db.transaction(cb)` which
    // runs the callback synchronously inside a SAVEPOINT. All UPDATE/
    // INSERT calls inside must use the inner `tx` handle.
    //
    // Note: better-sqlite3 transactions are SYNCHRONOUS — the callback
    // does NOT accept an async fn. The pipeline above is async (S3 +
    // pdfjs); the transaction starts only AFTER all async work completes.
    // This is the correct boundary: we transact only the durable writes,
    // not the I/O that could fail mid-flight.
    db.transaction((tx) => {
      tx.update(tutorials)
        .set({
          status: 'ready-to-generate',
          totalPages: parsed.pageCount,
          totalChapters: detected.chapters.length,
          sourcePdfSha256: sha256,
        })
        .where(eq(tutorials.id, tutorialId))
        .run();

      // Build chapter inserts. Each chapter's sourceParagraphsJson is a
      // JSON-serialized SourceParagraph[] (per ari HIGH-3 schema design).
      // Stable id via crypto.randomUUID (matches users.id pattern in
      // src/lib/session.ts:131).
      for (let ordinal = 0; ordinal < detected.chapters.length; ordinal++) {
        const c = detected.chapters[ordinal];
        if (!c) continue; // noUncheckedIndexedAccess guard
        tx.insert(chapters)
          .values({
            id: crypto.randomUUID(),
            tutorialId,
            ordinal,
            title: c.title,
            sourcePageStart: c.pageStart,
            sourcePageEnd: c.pageEnd,
            sourceParagraphsJson: JSON.stringify(c.sourceParagraphs),
            status: 'pending',
            isRead: false,
            timeSpentSeconds: 0,
          })
          .run();
      }
    });

    // Surface the low-confidence flag through error_message even on success;
    // the UI can pick it up alongside status='ready-to-generate' to display
    // a banner. Empty error_message means "no warnings"; populated means
    // "advisory" when status is non-error.
    if (parsed.lowConfidenceScannedImage || detected.confidence === 'low') {
      const advisory = buildAdvisoryMessage(parsed, detected);
      await db.update(tutorials)
        .set({ errorMessage: advisory })
        .where(eq(tutorials.id, tutorialId));
    }
  } catch (err) {
    await markError(tutorialId, err);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function markError(tutorialId: string, err: unknown): Promise<void> {
  const message =
    err instanceof Error
      ? truncate(err.message, 1000)
      : `unknown error: ${truncate(String(err), 1000)}`;
  try {
    await db.update(tutorials)
      .set({ status: 'error', errorMessage: message })
      .where(eq(tutorials.id, tutorialId));
  } catch (writeErr) {
    // If even the error-write fails, the tutorial row is stuck at 'ingesting'.
    // We log loudly; recovery is operator-manual (DELETE the row + retry).
    // eslint-disable-next-line no-console
    console.error(
      `[ingestWorker] CRITICAL: failed to write error status for ${tutorialId}:`,
      writeErr,
      'original error:',
      err,
    );
  }
}

function buildAdvisoryMessage(
  parsed: { lowConfidenceScannedImage: boolean },
  detected: { tier: string; confidence: string },
): string {
  const parts: string[] = [];
  if (parsed.lowConfidenceScannedImage) {
    parts.push('PDF appears to be scanned images without OCR; text extraction is limited.');
  }
  if (detected.confidence === 'low') {
    parts.push(
      `Chapter structure could not be detected (tier=${detected.tier}); generated as one long chapter.`,
    );
  }
  return parts.join(' ');
}

function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen) + '...';
}
