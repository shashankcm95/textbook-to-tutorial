// src/lib/generation/per-chapter.ts — orchestrator for one chapter's
// hybrid-model generation. Designed to be called either inline by the SSE
// stream route (foreground, user is watching) OR fire-and-forget by the
// prefetch path (background, populating cache ahead of the user).
//
// Pipeline per chapter:
//   1. Load the chapter row from DB; verify it exists + classification is
//      'body' or 'appendix' + not already complete.
//   2. Resolve source paragraphs:
//        a. If chapters.source_paragraphs_json is non-empty, use that (fast
//           path; populated by the ingest worker on cache-miss).
//        b. Else fetch the chunk artifact from S3 by chapters.chunk_s3_key
//           (cache-hit ingest path; chunks live in S3 only).
//   3. Mark chapter status='generating'.
//   4. Call narrative-only (4o, streaming). Forward token deltas via onToken.
//   5. Call quiz-from-narrative (4o-mini, non-streaming).
//   6. Persist: chapter.narrative, questions rows, flashcards rows, parses_cost
//      rows (one per LLM call), source_paragraphs_json (lazy populate from S3).
//   7. Mark status='complete' (or 'partial' if validationDropCount > 0).
//   8. Caller decides max_unlocked bump (Commit 3 gating policy).
//
// Idempotency: locking is via the chapters.status='generating' precondition —
// if a second concurrent call sees status='generating' it bails out. Atomic
// via UPDATE … WHERE status='pending' RETURNING (better-sqlite3 emulates).
//
// Cancellation: caller passes AbortSignal; both LLM calls honor it. On abort
// before persist, we revert status back to 'pending' so a future call can
// retry. After persist, abort is a no-op.

import { eq, and } from 'drizzle-orm';
import { db, rawDb } from '@/db/client';
import {
  chapters,
  questions as questionsTable,
  flashcards as flashcardsTable,
  parsesCost,
  tutorials,
  chapterFidelityScores,
  chapterAnchorViolations,
} from '@/db/schema';
import { generateNarrativeOnly } from '@/lib/openai/narrative-only';
import { generateQuizFromNarrative } from '@/lib/openai/quiz-from-narrative';
import { scoreFidelity } from '@/lib/openai/fidelity-check';
import {
  readChunk,
  resolveChunksBucket,
  // Feature B' Wave 3 — voice + anchor profile loaders. Provided by Wave-3A's
  // s3-chunks.ts extension. Both return null on S3 miss (tutorials ingested
  // before Feature B' shipped have no artifacts → graceful degradation path).
  readVoiceProfile,
  readAnchorWhitelist,
} from '@/lib/s3-chunks';
import { validateAnchors, type AnchorWhitelistEntry } from '@/lib/openai/anchor-validator';
import type { VoiceProfile } from '@/lib/ingest/voice-extract';
import type { SourceParagraph } from '@/lib/types';

export interface GenerateChapterArgs {
  tutorialId: string;
  chapterIdx: number;
  abortSignal?: AbortSignal;
  /** Emit per-token deltas during narrative generation (SSE bridge). */
  onNarrativeToken?: (delta: string) => void;
  /** Emit when the narrative phase completes (before quiz starts). */
  onNarrativeComplete?: (narrative: string) => void;
  /** Emit when the whole chapter (narrative + quiz + flashcards) is done. */
  onChapterComplete?: () => void;
}

export interface GenerateChapterResult {
  chapterId: string;
  narrative: string;
  questionsCount: number;
  flashcardsCount: number;
  validationDropCount: number;
  totalCostUsd: number;
  status: 'complete' | 'partial';
}

export class ChapterGenerationError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = 'ChapterGenerationError';
  }
}

export async function generateChapter(
  args: GenerateChapterArgs,
): Promise<GenerateChapterResult> {
  const { tutorialId, chapterIdx, abortSignal, onNarrativeToken, onNarrativeComplete, onChapterComplete } = args;

  // ── 1. Load chapter row + tutorial (for chunk-bucket resolution) ───────
  const chRows = await db
    .select()
    .from(chapters)
    .where(and(eq(chapters.tutorialId, tutorialId), eq(chapters.ordinal, chapterIdx)))
    .limit(1);
  const chapter = chRows[0];
  if (!chapter) {
    throw new ChapterGenerationError(`chapter ordinal=${chapterIdx} not found`, 'not-found');
  }
  if (chapter.status === 'complete' || chapter.status === 'partial') {
    // Already done. Caller should read existing data; return a no-op result.
    return {
      chapterId: chapter.id,
      narrative: chapter.narrative ?? '',
      questionsCount: 0,
      flashcardsCount: 0,
      validationDropCount: 0,
      totalCostUsd: 0,
      status: chapter.status,
    };
  }
  if (chapter.classification !== 'body' && chapter.classification !== 'appendix') {
    throw new ChapterGenerationError(
      `chapter classification=${chapter.classification} not generable`,
      'not-generable',
    );
  }
  const tutRows = await db.select().from(tutorials).where(eq(tutorials.id, tutorialId)).limit(1);
  const tutorial = tutRows[0];
  if (!tutorial) throw new ChapterGenerationError('tutorial not found', 'not-found');

  // ── 2. Atomic state transition pending|failed → generating ─────────────
  // Returns the rows affected — if 0, another runner already grabbed it.
  const claim = rawDb
    .prepare(
      "UPDATE chapters SET status='generating' WHERE id = ? AND status IN ('pending','failed')",
    )
    .run(chapter.id);
  if (claim.changes === 0) {
    throw new ChapterGenerationError(
      `chapter already in progress or in a non-claimable status`,
      'already-running',
    );
  }

  // ── 3. Resolve source paragraphs ───────────────────────────────────────
  const sourceParagraphs = await resolveSourceParagraphs(chapter, tutorial);
  if (sourceParagraphs.length === 0) {
    await markFailed(chapter.id, 'no source paragraphs available');
    throw new ChapterGenerationError('no source paragraphs', 'no-source');
  }

  // ── 3.5. Load Feature B' voice + anchor artifacts (fail-open) ──────────
  // Both may be null for legacy tutorials ingested before Feature B' shipped.
  // When null, generateNarrativeOnly + scoreFidelity gracefully fall back to
  // their pre-B' behavior; no rows land in chapter_anchor_violations.
  const { voiceProfile, anchorWhitelist } = await loadVoiceAndAnchor(tutorial);

  // ── 4. Generate narrative (4o, streaming) ──────────────────────────────
  let narrativeResult;
  try {
    narrativeResult = await generateNarrativeOnly({
      chapterTitle: chapter.title,
      sourceParagraphs,
      abortSignal,
      onToken: onNarrativeToken ?? (() => {}),
      // Feature B' Wave 3 — wire voice + anchor profile through to the
      // narrative prompt. Both args are optional on the generator side.
      voiceProfile: voiceProfile ?? undefined,
      anchorWhitelist: anchorWhitelist ?? undefined,
    });
  } catch (err) {
    await markFailed(chapter.id, `narrative: ${(err as Error).message}`);
    throw err;
  }
  onNarrativeComplete?.(narrativeResult.narrative);

  // ── 5. Generate quiz + flashcards (4o-mini, non-streaming) ─────────────
  let quizResult;
  try {
    quizResult = await generateQuizFromNarrative({
      chapterTitle: chapter.title,
      narrative: narrativeResult.narrative,
      sourceParagraphs,
      abortSignal,
    });
  } catch (err) {
    // Narrative succeeded but quiz failed. Persist narrative-only as 'partial'
    // so the user can still read; mark quiz failure in error_message.
    await persistNarrativeOnly(
      chapter.id,
      tutorialId,
      narrativeResult,
      sourceParagraphs,
    );
    throw err;
  }

  // ── 6. Persist (transactional) ─────────────────────────────────────────
  const finalStatus = quizResult.validationDropCount > 0 ? 'partial' : 'complete';
  db.transaction((tx) => {
    tx.update(chapters)
      .set({
        narrative: narrativeResult.narrative,
        status: finalStatus,
        sourceParagraphsJson: JSON.stringify(sourceParagraphs),
      })
      .where(eq(chapters.id, chapter.id))
      .run();

    // questions
    for (const q of quizResult.questions) {
      tx.insert(questionsTable)
        .values({
          id: crypto.randomUUID(),
          chapterId: chapter.id,
          prompt: q.prompt,
          optionsJson: JSON.stringify(q.options),
          correctIndex: q.correctIndex,
          explanation: q.explanation,
          sourceParagraphRef: q.sourceParagraphRef,
        })
        .run();
    }
    // flashcards
    for (const f of quizResult.flashcards) {
      tx.insert(flashcardsTable)
        .values({
          id: crypto.randomUUID(),
          chapterId: chapter.id,
          front: f.front,
          back: f.back,
          sourceParagraphRef: f.sourceParagraphRef,
        })
        .run();
    }
    // parses_cost rows — one per LLM call
    tx.insert(parsesCost)
      .values({
        id: crypto.randomUUID(),
        tutorialId,
        chapterId: chapter.id,
        model: narrativeResult.model,
        promptTokens: narrativeResult.promptTokens,
        completionTokens: narrativeResult.completionTokens,
        costUsd: narrativeResult.costUsd,
        validationDropCount: 0,
      })
      .run();
    tx.insert(parsesCost)
      .values({
        id: crypto.randomUUID(),
        tutorialId,
        chapterId: chapter.id,
        model: quizResult.model,
        promptTokens: quizResult.promptTokens,
        completionTokens: quizResult.completionTokens,
        costUsd: quizResult.costUsd,
        validationDropCount: quizResult.validationDropCount,
      })
      .run();
  });

  // ── 6.5. Validate whitelist-anchor coverage (Feature B' Wave 3) ──────
  // Pure-function validator from anchor-validator.ts. Only runs when we have
  // an anchor_whitelist artifact in S3 (i.e., the tutorial was ingested with
  // Feature B' active). When violations are detected, persist ONE row to
  // chapter_anchor_violations (policy: log-and-continue per design §D4 —
  // no forced regeneration in v1). When all anchors are preserved, the
  // ABSENCE of a row IS the success signal — no DB write needed.
  //
  // Fail-open semantics: validateAnchors is pure (can't throw under normal
  // conditions), but if the violations INSERT fails for any reason
  // (transient SQLite lock, etc.), we log + continue. Chapter completion
  // takes priority over audit-row persistence.
  if (anchorWhitelist && anchorWhitelist.length > 0) {
    try {
      const validation = validateAnchors({
        narrative: narrativeResult.narrative,
        sourceParagraphs,
        whitelist: anchorWhitelist,
      });
      if (validation.missing.length > 0) {
        const missingTerms = validation.missing.map((m) => m.term);
        // eslint-disable-next-line no-console
        console.warn(
          `[per-chapter] anchor coverage violation for ${chapter.id}: ` +
            `${validation.missing.length}/${validation.expected.length} dropped ` +
            `(score=${validation.score.toFixed(3)}); missing=${JSON.stringify(missingTerms)}`,
        );
        db.insert(chapterAnchorViolations)
          .values({
            id: crypto.randomUUID(),
            chapterId: chapter.id,
            expectedCount: validation.expected.length,
            foundCount: validation.found.length,
            missingAnchorsJson: JSON.stringify(missingTerms),
            score: validation.score,
            policyApplied: 'log-and-continue',
            regenTriggered: 0,
          })
          .run();
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(
        `[per-chapter] anchor validation failed for ${chapter.id}: ${(err as Error).message}`,
      );
    }
  }

  // ── 7. Score narrative-vs-source fidelity (DRIFT-test3-022) ──────────
  // Run a separate 4o-mini call to count preserved concrete anchors. Fail-
  // open: if the scorer errors, we proceed without a score (the chapter is
  // already persisted as complete/partial; absent score = "unknown
  // fidelity" rather than blocking the read path).
  let fidelityCostUsd = 0;
  try {
    const fidelity = await scoreFidelity({
      chapterTitle: chapter.title,
      narrative: narrativeResult.narrative,
      sourceParagraphs,
      abortSignal,
      // Feature B' Wave 3 — pass the whitelist so the scorer can populate
      // whitelistAnchorsPreserved + whitelistAnchorsMissing columns (added
      // to chapter_fidelity_scores by Wave 1C migration). Wave 3C extends
      // FidelityCheckArgs to accept this optional field; until that lands
      // upstream, the assertion below keeps TypeScript green. The runtime
      // value flows through unmodified on either side of the merge.
      ...(anchorWhitelist ? { anchorWhitelist } : {}),
    } as Parameters<typeof scoreFidelity>[0]);
    fidelityCostUsd = fidelity.costUsd;
    db.transaction((tx) => {
      tx.insert(chapterFidelityScores)
        .values({
          id: crypto.randomUUID(),
          chapterId: chapter.id,
          specificNumbersPreserved: fidelity.specificNumbersPreserved,
          namedExamplesPreserved: fidelity.namedExamplesPreserved,
          terminologicalContrastsPreserved: fidelity.terminologicalContrastsPreserved,
          specificNumbersMissing: fidelity.specificNumbersMissing,
          namedExamplesMissing: fidelity.namedExamplesMissing,
          terminologicalContrastsMissing: fidelity.terminologicalContrastsMissing,
          overallScore: fidelity.overallScore,
          notesJson: JSON.stringify(fidelity.notes),
          model: fidelity.model,
          promptTokens: fidelity.promptTokens,
          completionTokens: fidelity.completionTokens,
          costUsd: fidelity.costUsd,
        })
        .run();
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      `[per-chapter] fidelity scoring failed for ${chapter.id}: ${(err as Error).message}`,
    );
  }

  onChapterComplete?.();
  return {
    chapterId: chapter.id,
    narrative: narrativeResult.narrative,
    questionsCount: quizResult.questions.length,
    flashcardsCount: quizResult.flashcards.length,
    validationDropCount: quizResult.validationDropCount,
    totalCostUsd: narrativeResult.costUsd + quizResult.costUsd + fidelityCostUsd,
    status: finalStatus,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────────

async function resolveSourceParagraphs(
  chapter: { sourceParagraphsJson: string; chunkS3Key: string | null },
  tutorial: { sourceS3Url: string; sourcePdfSha256: string | null },
): Promise<SourceParagraph[]> {
  // Fast path: cached in DB column
  if (chapter.sourceParagraphsJson && chapter.sourceParagraphsJson !== '[]') {
    try {
      const parsed = JSON.parse(chapter.sourceParagraphsJson) as unknown;
      if (Array.isArray(parsed) && parsed.length > 0) return parsed as SourceParagraph[];
    } catch {
      // fall through to S3
    }
  }
  // Slow path: read chunk from S3 (cache-hit ingest path leaves DB column empty)
  if (!chapter.chunkS3Key || !tutorial.sourcePdfSha256) return [];
  const bucket = resolveChunksBucket(tutorial.sourceS3Url);
  // chunkS3Key is the full path; parse out the index from the filename
  // for readChunk(idx) — pattern: parsed/<sha>/chapters/NN.json
  const match = /chapters\/(\d+)\.json$/.exec(chapter.chunkS3Key);
  if (!match) return [];
  const idx = Number(match[1]);
  if (!Number.isFinite(idx)) return [];
  try {
    const artifact = await readChunk(bucket, tutorial.sourcePdfSha256, idx);
    return artifact.paragraphs;
  } catch {
    return [];
  }
}

async function markFailed(chapterId: string, message: string): Promise<void> {
  try {
    rawDb
      .prepare("UPDATE chapters SET status='failed' WHERE id = ?")
      .run(chapterId);
    // eslint-disable-next-line no-console
    console.error(`[per-chapter] chapter ${chapterId} failed: ${message}`);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[per-chapter] CRITICAL: failed to mark chapter failed:`, err);
  }
}

/**
 * Feature B' Wave 3 — load voice_profile + anchor_whitelist from S3 in
 * parallel. Both helpers are provided by Wave-3A's s3-chunks.ts extension
 * and return null on cache miss (legacy tutorials, partial Feature B'
 * rollout, or transient S3 read failures swallowed inside the helpers).
 *
 * This wrapper exists for THREE reasons:
 *   1. Single dependency for tests to mock (one `vi.mock` covers both
 *      reads regardless of how Wave-3A's helpers evolve).
 *   2. Fail-open: if either helper throws (the brief says they shouldn't,
 *      but defensive coding for the integration boundary), log + return
 *      null rather than blocking chapter generation. The chapter is
 *      load-bearing; the voice/anchor artifacts are quality enhancements.
 *   3. Skip the S3 round-trip cleanly when the tutorial pre-dates the
 *      lazy-chunking pipeline (no sourcePdfSha256 → no parsed/<sha>/
 *      prefix → nothing to load).
 */
async function loadVoiceAndAnchor(
  tutorial: { sourceS3Url: string; sourcePdfSha256: string | null },
): Promise<{
  voiceProfile: VoiceProfile | null;
  anchorWhitelist: AnchorWhitelistEntry[] | null;
}> {
  if (!tutorial.sourcePdfSha256) {
    return { voiceProfile: null, anchorWhitelist: null };
  }
  const bucket = resolveChunksBucket(tutorial.sourceS3Url);
  const pdfSha256 = tutorial.sourcePdfSha256;
  const [voiceResult, anchorResult] = await Promise.allSettled([
    readVoiceProfile({ bucket, pdfSha256 }),
    readAnchorWhitelist({ bucket, pdfSha256 }),
  ]);
  const voiceProfile =
    voiceResult.status === 'fulfilled' ? voiceResult.value : null;
  const anchorWhitelist =
    anchorResult.status === 'fulfilled' ? anchorResult.value : null;
  if (voiceResult.status === 'rejected') {
    // eslint-disable-next-line no-console
    console.warn(
      `[per-chapter] readVoiceProfile failed (continuing without voice): ${(voiceResult.reason as Error).message}`,
    );
  }
  if (anchorResult.status === 'rejected') {
    // eslint-disable-next-line no-console
    console.warn(
      `[per-chapter] readAnchorWhitelist failed (continuing without anchors): ${(anchorResult.reason as Error).message}`,
    );
  }
  return { voiceProfile, anchorWhitelist };
}

async function persistNarrativeOnly(
  chapterId: string,
  tutorialId: string,
  narrativeResult: {
    narrative: string;
    model: string;
    promptTokens: number;
    completionTokens: number;
    costUsd: number;
  },
  sourceParagraphs: SourceParagraph[],
): Promise<void> {
  db.transaction((tx) => {
    tx.update(chapters)
      .set({
        narrative: narrativeResult.narrative,
        status: 'partial',
        sourceParagraphsJson: JSON.stringify(sourceParagraphs),
      })
      .where(eq(chapters.id, chapterId))
      .run();
    tx.insert(parsesCost)
      .values({
        id: crypto.randomUUID(),
        tutorialId,
        chapterId,
        model: narrativeResult.model,
        promptTokens: narrativeResult.promptTokens,
        completionTokens: narrativeResult.completionTokens,
        costUsd: narrativeResult.costUsd,
        validationDropCount: 0,
      })
      .run();
  });
}
