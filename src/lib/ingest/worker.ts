// src/lib/ingest/worker.ts — background ingest worker for the lazy-hybrid-
// chunking pipeline.
//
// Lifecycle (post-rewrite for feat/lazy-hybrid-chunking):
//   1. Read tutorials row (verify status === 'ingesting'; idempotent guard)
//   2. Resolve chunks bucket; compute pdf sha256 by fetching PDF
//   3. Check S3 cache: if chunks/<sha>/metadata.json exists, reuse — skip all
//      LLM work, just read existing manifest and insert chapter rows.
//   4. Cache miss: parse PDF, classify outline, build chunk manifest, extract
//      glossary (LLM), write chunks + metadata + glossary to S3.
//   5. Insert chapter rows (status='pending', chunk_s3_key populated,
//      source_paragraphs_json populated for backward-compat with the existing
//      render path) + skipped_sections rows + glossary_terms rows.
//   6. Set status='ready-to-generate' + release chapter 0 (released_at=now).
//
// On any failure: status='error', errorMessage populated, no LLM work
// continues for this tutorial.
//
// Design anchors:
//   - kb:architecture/discipline/stability-patterns §Steady State — bounded
//     async outcome per stage; explicit error-write at the boundary so a
//     killed Node process leaves a recoverable signal.
//   - kb:architecture/discipline/stability-patterns §Bulkhead — worker errors
//     are caught at this layer; never propagate to setImmediate's unhandled
//     rejection path.
//   - kb:architecture/crosscut/single-responsibility — this file orchestrates;
//     classifier / chunker / glossary-extract / s3-chunks each own one stage.

import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { tutorials, chapters, glossaryTerms, skippedSections } from '@/db/schema';
import { fetchPdfFromS3 } from '@/lib/s3';
import { parsePdfBuffer } from '@/lib/pdf/parse';
import { classifyOutline } from './classifier';
import { buildChunkManifest } from './chunker';
import { extractGlossaryFromSections, hasGlossarySections } from './glossary-extract';
import { extractVoiceProfile } from './voice-extract';
import { extractAnchorCandidates } from './anchor-prefilter';
import { scoreAnchorCandidates } from './anchor-scorer';
import { extractPdfMetadata, type PdfMetadata } from './extract-pdf-metadata';
import { bookMetadataFromS3Url } from '@/lib/book-metadata';
import {
  resolveChunksBucket,
  chunksPrefix,
  chunksExist,
  readMetadata,
  readVoiceProfile,
  readAnchorWhitelist,
  writeChunk,
  writeMetadata,
  writeGlossary,
  writeVoiceProfile,
  writeAnchorWhitelist,
  chapterKey,
  type ChunkArtifact,
  type MetadataArtifact,
  type AnchorWhitelistArtifact,
} from '@/lib/s3-chunks';
import type { SourceParagraph } from '@/lib/types';

const MAX_PDF_BYTES = 50 * 1024 * 1024; // 50 MB — matches s3.ts default cap

/**
 * Run the ingest pipeline for a tutorial id.
 *
 * Contract:
 *   - NEVER throws. All errors are caught and written to tutorials.errorMessage.
 *   - Idempotent: re-invocation past 'ingesting' exits early.
 *   - Multi-user cache: if S3 has chunks for this PDF's sha256, skips parse +
 *     LLM work and reuses the existing manifest.
 */
export async function ingestWorker(tutorialId: string): Promise<void> {
  // ── Phase 1: load + idempotency check ─────────────────────────────────
  let tutorial;
  try {
    const rows = await db.select().from(tutorials).where(eq(tutorials.id, tutorialId)).limit(1);
    tutorial = rows[0];
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[ingestWorker] db read failed for ${tutorialId}:`, err);
    return;
  }
  if (!tutorial) {
    // eslint-disable-next-line no-console
    console.error(`[ingestWorker] tutorial ${tutorialId} not found`);
    return;
  }
  if (tutorial.status !== 'ingesting') return; // idempotent no-op

  // ── Phase 2: fetch + hash (always needed for sha256 cache key) ────────
  try {
    const { buffer } = await fetchPdfFromS3(tutorial.sourceS3Url, MAX_PDF_BYTES);
    const sha256 = createHash('sha256').update(buffer).digest('hex');
    const bucket = resolveChunksBucket(tutorial.sourceS3Url);

    // ── Sprint D Phase 1: per-PDF metadata extraction ──────────────────
    // Run this BEFORE the cache-hit branch so both fast-path and full-path
    // ingests populate the new tutorials.book_title / book_author /
    // metadata_source columns. extractPdfMetadata is fail-open by contract
    // (returns source='none' on any error), so it can't break ingest. When
    // both /Info and XMP yield nothing usable, we fall back to the existing
    // filename heuristic and tag the source 'filename' — the UI keeps the
    // "Auto-detected" warning badge in that case.
    const resolvedMetadata = resolveBookMetadataForIngest(
      await extractPdfMetadata(buffer),
      tutorial.sourceS3Url,
    );

    // ── Phase 3: cache check + (parse or reuse) ─────────────────────────
    let metadata: MetadataArtifact;
    let pageCount: number;
    let advisoryParts: string[] = [];

    const cacheHit = await chunksExist(bucket, sha256);
    if (cacheHit) {
      // Cache hit: read existing manifest, persist chapter rows pointing at
      // it, skip all parse + LLM work entirely.
      metadata = await readMetadata(bucket, sha256);
      pageCount = metadata.pageCount;

      // Wave-3 review HIGH 3A-H1 (visibility fix): the cache-hit fast path
      // skips voice + anchor extraction entirely. If a PRIOR ingest crashed
      // AFTER writing chunks + metadata but BEFORE writing voice_profile.json
      // OR anchor_whitelist.json (narrow window because both are written in
      // Promise.all after chunks land), the subsequent cache-hit run silently
      // degrades chapters generated from this tutorial to v3-prompt behavior
      // without surfacing the gap. Probe both artifacts and warn so operators
      // can manually invalidate the cache (remove the metadata.json) to
      // trigger a full re-ingest if they want the source-grounding signal.
      // Re-extraction inline is deliberately NOT implemented here — it
      // would require fetching all body chunks from S3, which is a heavier
      // code path than this visibility patch.
      const [vp, aw] = await Promise.all([
        readVoiceProfile({ bucket, pdfSha256: sha256 }).catch(() => null),
        readAnchorWhitelist({ bucket, pdfSha256: sha256 }).catch(() => null),
      ]);
      if (!vp || !aw) {
        // eslint-disable-next-line no-console
        console.warn(
          `[ingest:cache-hit:${sha256.slice(0, 8)}] tutorial cached without complete Feature B' artifacts ` +
            `(voice_profile=${vp ? 'present' : 'MISSING'}, anchor_whitelist=${aw ? 'present' : 'MISSING'}). ` +
            `Generated chapters will fall back to v3 prompt behavior. To re-extract, invalidate the cache ` +
            `by deleting s3://${bucket}/${sha256}/metadata.json and re-ingesting.`,
        );
      }
    } else {
      // Cache miss: full pipeline. Parse → classify → chunk → glossary →
      // write to S3 → build metadata.
      const parsed = await parsePdfBuffer(buffer);
      pageCount = parsed.pageCount;
      if (parsed.lowConfidenceScannedImage) {
        advisoryParts.push(
          'PDF appears to be scanned images without OCR; text extraction is limited.',
        );
      }

      const classified = await classifyOutline(parsed.outline ?? []);
      const manifest = buildChunkManifest(parsed, classified.entries);

      if (manifest.chunks.length === 0) {
        advisoryParts.push(
          'No chapter content could be identified (likely an outline-less PDF with no body text).',
        );
      }

      // Write chunk artifacts to S3 (parallel). One PutObject per chunk;
      // typical book has 10-40 chunks; bounded by Promise.all concurrency.
      const writtenKeys = await Promise.all(
        manifest.chunks.map((c) => writeChunkArtifact(bucket, sha256, c)),
      );

      // Glossary side-asset (LLM call); fail-open per glossary-extract.ts
      const glossary = hasGlossarySections(manifest.glossarySections)
        ? await extractGlossaryFromSections(manifest.glossarySections)
        : { schemaVersion: 1 as const, terms: [] };
      if (glossary.terms.length > 0) {
        await writeGlossary(bucket, sha256, glossary);
      }

      // Voice + anchor side-assets (Feature B' Wave 3). Both depend only on
      // the body paragraphs collected from the chunk manifest; neither
      // depends on the other → run in parallel. FAIL-OPEN: a failure in
      // either extractor logs + continues; downstream consumers
      // (per-chapter generator, fidelity scorer) handle missing artifacts
      // by falling back to v3 prompt behavior.
      const bodyParagraphs: SourceParagraph[] = manifest.chunks
        .filter((c) => c.classification === 'body')
        .flatMap((c) => c.paragraphs);
      const glossaryTermStrings: string[] = glossary.terms.map((t) => t.term);

      await Promise.all([
        runVoiceExtraction(bucket, sha256, bodyParagraphs),
        runAnchorExtraction(bucket, sha256, bodyParagraphs, glossaryTermStrings),
      ]);

      // Build + write metadata.json — the multi-user cache key.
      const skipped = manifest.skipped.map((s) => ({
        title: s.title,
        classification: s.classification,
        pageStart: s.pageStart,
        pageEnd: s.pageEnd,
      }));
      // glossary sections that were sent to the extractor are recorded as
      // 'glossary' in skipped_sections audit (UI may surface "Glossary
      // detected, X terms extracted").
      const glossarySkips = manifest.glossarySections.map((g) => ({
        title: g.title,
        classification: 'glossary' as const,
        pageStart: g.pageStart,
        pageEnd: g.pageEnd,
      }));

      metadata = {
        schemaVersion: 1,
        pdfSha256: sha256,
        parsedAt: new Date().toISOString(),
        pageCount: parsed.pageCount,
        outlinePresent: manifest.outlinePresent,
        chunkerVersion: manifest.chunkerVersion,
        classificationVersion: classified.classificationVersion,
        chunks: manifest.chunks.map((c, i) => ({
          idx: c.idx,
          title: c.title,
          classification: c.classification,
          pageStart: c.pageStart,
          pageEnd: c.pageEnd,
          paragraphCount: c.paragraphCount,
          depth: c.depth,
          parentIdx: c.parentIdx,
          s3Key: writtenKeys[i]?.s3Key ?? chapterKey(sha256, c.idx),
        })),
        skipped: [...skipped, ...glossarySkips],
        glossaryAvailable: glossary.terms.length > 0,
      };
      await writeMetadata(bucket, sha256, metadata);

      // Keep the parsed.chunks available for the inline-DB write below.
      // We attach them onto a side map keyed by idx so the DB insert can
      // populate source_paragraphs_json without re-reading from S3.
      cachedChunkParagraphs = new Map(
        manifest.chunks.map((c) => [c.idx, c.paragraphs] as const),
      );
      cachedGlossaryTerms = glossary.terms;
    }

    // ── Phase 4: persist (single transaction) ───────────────────────────
    // Insert chapters + skipped_sections + glossary_terms; update tutorials.
    // Chapter 0 (lowest body ordinal) gets released_at=now; rest stay locked.
    const now = Math.floor(Date.now() / 1000);
    const parsedPrefix = chunksPrefix(sha256);

    db.transaction((tx) => {
      tx.update(tutorials)
        .set({
          status: 'ready-to-generate',
          totalPages: pageCount,
          totalChapters: metadata.chunks.length,
          sourcePdfSha256: sha256,
          parsedS3Prefix: parsedPrefix,
          maxUnlockedChapterIdx: 0,
          outlineClassificationVersion: metadata.classificationVersion,
          // Sprint D Phase 1: persist resolved per-PDF metadata. Null-safe
          // by construction (resolveBookMetadataForIngest always returns a
          // 3-field record; values may be null but the keys exist).
          bookTitle: resolvedMetadata.title,
          bookAuthor: resolvedMetadata.author,
          metadataSource: resolvedMetadata.source,
        })
        .where(eq(tutorials.id, tutorialId))
        .run();

      // chapters rows — one per chunk
      for (const m of metadata.chunks) {
        // Source paragraphs: for cache-miss path we have them in memory; for
        // cache-hit path the chunks live only in S3. To keep the existing
        // StreamingClient render path working, we ALWAYS write
        // source_paragraphs_json. On cache hit, we'd need to fetch each chunk
        // from S3 — too slow for the transaction. For v1 cache-hit path we
        // populate with `[]` and trust the future generation pass to enrich
        // when it reads the chunk from S3. The render path tolerates `[]`
        // (citations just won't resolve until the chapter is generated).
        const paragraphs = cachedChunkParagraphs?.get(m.idx) ?? [];
        const isFirstBody = metadata.chunks.findIndex(
          (c) => c.classification === 'body',
        ) === metadata.chunks.indexOf(m);
        tx.insert(chapters)
          .values({
            id: crypto.randomUUID(),
            tutorialId,
            ordinal: m.idx,
            title: m.title,
            sourcePageStart: m.pageStart,
            sourcePageEnd: m.pageEnd,
            sourceParagraphsJson: JSON.stringify(paragraphs),
            status: 'pending',
            isRead: false,
            timeSpentSeconds: 0,
            classification: m.classification,
            chunkS3Key: m.s3Key,
            depth: m.depth,
            paragraphCount: m.paragraphCount,
            // Release chapter 0 (the first BODY chunk) immediately so the
            // user has something to read. Others remain locked.
            releasedAt: isFirstBody ? new Date(now * 1000) : null,
          })
          .run();
      }

      // skipped_sections rows (front-matter, bibliography). Glossary entries
      // are written as 'glossary' classification (already labeled in metadata).
      for (const s of metadata.skipped) {
        // PRIMARY KEY (tutorial_id, outline_title) — drop dupes silently.
        try {
          tx.insert(skippedSections)
            .values({
              tutorialId,
              outlineTitle: s.title,
              classification: s.classification,
              pageStart: s.pageStart,
              pageEnd: s.pageEnd,
            })
            .run();
        } catch {
          // duplicate title — accept silently (audit log doesn't need uniqueness)
        }
      }

      // glossary_terms rows
      if (cachedGlossaryTerms && cachedGlossaryTerms.length > 0) {
        for (const t of cachedGlossaryTerms) {
          tx.insert(glossaryTerms)
            .values({
              id: crypto.randomUUID(),
              tutorialId,
              term: t.term,
              definition: t.definition,
              sourceParagraphRef: t.sourceParagraphRef,
            })
            .run();
        }
      }
    });

    // Advisory message (cache-miss path only — cache hits inherit nothing)
    if (advisoryParts.length > 0) {
      await db.update(tutorials)
        .set({ errorMessage: advisoryParts.join(' ') })
        .where(eq(tutorials.id, tutorialId));
    }
  } catch (err) {
    await markError(tutorialId, err);
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Side-channels for the transactional insert
// ───────────────────────────────────────────────────────────────────────────
// These are module-scoped maps that hold the parsed chunk paragraphs +
// extracted glossary terms between Phase 3 (parse) and Phase 4 (persist).
// Scoped to one ingest invocation; cleared at function exit by reassignment.
// Not thread-safe (Node single-thread saves us; multi-worker would need a
// per-tutorial keyed map).

let cachedChunkParagraphs:
  | Map<number, Array<{ page: number; paragraphIdx: number; text: string }>>
  | undefined;
let cachedGlossaryTerms:
  | Array<{ term: string; definition: string; sourceParagraphRef: string }>
  | undefined;

async function writeChunkArtifact(
  bucket: string,
  sha256: string,
  chunk: ReturnType<typeof buildChunkManifest>['chunks'][number],
): Promise<{ s3Key: string }> {
  const artifact: ChunkArtifact = {
    schemaVersion: 1,
    idx: chunk.idx,
    title: chunk.title,
    classification: chunk.classification,
    pageStart: chunk.pageStart,
    pageEnd: chunk.pageEnd,
    depth: chunk.depth,
    parentIdx: chunk.parentIdx,
    paragraphs: chunk.paragraphs,
  };
  return writeChunk(bucket, sha256, artifact);
}

// ---------------------------------------------------------------------------
// Voice + anchor side-asset runners — fail-open wrappers
// ---------------------------------------------------------------------------
//
// Both wrappers swallow any error from the underlying extractor + S3 write,
// logging a warning so operators can diagnose without breaking ingest.
// Downstream consumers (Wave 3B per-chapter, Wave 3C fidelity scorer)
// handle a missing artifact by falling back to the v3 prompt behavior.
//
// Why not propagate: tutorial ingest is the gateway to ALL downstream UX
// (reading, quiz, flashcards). Voice + anchor profiles are quality-of-
// generation improvements — they raise fidelity but their absence yields
// a still-usable tutorial. Trading partial ingest failure for full ingest
// failure is the wrong cost ratio.

async function runVoiceExtraction(
  bucket: string,
  sha256: string,
  bodyParagraphs: SourceParagraph[],
): Promise<void> {
  if (bodyParagraphs.length === 0) {
    // eslint-disable-next-line no-console
    console.warn(
      `[ingestWorker] voice-extract skipped for ${sha256}: zero body paragraphs`,
    );
    return;
  }
  try {
    const profile = await extractVoiceProfile({
      pdfSha256: sha256,
      bodyParagraphs,
    });
    await writeVoiceProfile({ bucket, pdfSha256: sha256, profile });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `[ingestWorker] voice-extract failed for ${sha256} (fail-open):`,
      (err as Error).message,
    );
  }
}

async function runAnchorExtraction(
  bucket: string,
  sha256: string,
  bodyParagraphs: SourceParagraph[],
  glossaryTerms: string[],
): Promise<void> {
  if (bodyParagraphs.length === 0) {
    // eslint-disable-next-line no-console
    console.warn(
      `[ingestWorker] anchor-extract skipped for ${sha256}: zero body paragraphs`,
    );
    return;
  }
  try {
    const candidates = extractAnchorCandidates({ bodyParagraphs, glossaryTerms });
    const scored = await scoreAnchorCandidates({
      pdfSha256: sha256,
      candidates,
    });
    const artifact: AnchorWhitelistArtifact = {
      schema_version: 1,
      extracted_at: new Date().toISOString(),
      model: scored.model,
      extraction_cost_usd: scored.extractionCostUsd,
      candidate_count: scored.candidateCount,
      accepted_count: scored.acceptedCount,
      anchors: scored.whitelist,
    };
    await writeAnchorWhitelist({ bucket, pdfSha256: sha256, whitelist: artifact });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `[ingestWorker] anchor-extract failed for ${sha256} (fail-open):`,
      (err as Error).message,
    );
  }
}

// ---------------------------------------------------------------------------
// Sprint D Phase 1 — book metadata resolution at ingest
// ---------------------------------------------------------------------------
//
// Combines the PDF-embedded metadata extractor with the filename heuristic
// fallback. The result drives the new tutorials.book_title / book_author /
// metadata_source columns.
//
// Decision tree:
//   1. PDF /Info or XMP yielded ANY non-null value (title or author) →
//      use those, tag source as 'pdf-info' / 'pdf-xmp'. High-confidence.
//   2. Neither PDF source yielded anything → re-run the filename heuristic
//      on the S3 URL. If it gave us anything, tag 'filename' (low-confidence;
//      keeps the UI's "Auto-detected" warning badge active).
//   3. Filename heuristic also empty → tag 'none'.
//
// Returns 3-tuple suitable for direct insertion into the tutorials row.

interface ResolvedBookMetadata {
  title: string | null;
  author: string | null;
  source: 'pdf-info' | 'pdf-xmp' | 'filename' | 'none';
}

function resolveBookMetadataForIngest(
  pdfMetadata: PdfMetadata,
  s3Url: string,
): ResolvedBookMetadata {
  // Tier 1: PDF-embedded metadata. extractPdfMetadata only returns
  // source !== 'none' when at least one of title/author was usable.
  if (pdfMetadata.source !== 'none') {
    return {
      title: pdfMetadata.title,
      author: pdfMetadata.author,
      source: pdfMetadata.source,
    };
  }

  // Tier 2: filename heuristic — keep parity with the legacy display path.
  const fromFilename = bookMetadataFromS3Url(s3Url);
  const filenameTitle = fromFilename.bookTitle.length > 0 ? fromFilename.bookTitle : null;
  const filenameAuthor = fromFilename.author.length > 0 ? fromFilename.author : null;
  if (filenameTitle !== null || filenameAuthor !== null) {
    return {
      title: filenameTitle,
      author: filenameAuthor,
      source: 'filename',
    };
  }

  // Tier 3: nothing derivable. The UI will fall back to "Untitled tutorial".
  return { title: null, author: null, source: 'none' };
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
    // eslint-disable-next-line no-console
    console.error(
      `[ingestWorker] CRITICAL: failed to write error status for ${tutorialId}:`,
      writeErr,
      'original error:',
      err,
    );
  }
}

function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen) + '...';
}
