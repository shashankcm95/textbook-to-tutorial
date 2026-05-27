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
import { extractDiagrams } from '@/lib/openai/extract-diagrams';
import { weaveDiagrams } from '@/lib/diagrams/weave';
import { estimateCost } from '@/lib/openai/cost';
import { assertCostBudget } from '@/lib/openai/cost-cap';
import { EXTRACT_SYSTEM_PROMPT } from '@/lib/prompts/extract-diagrams';
import type { OnDiagramsExtracted } from './diagrams-extracted-event';
import {
  readChunk,
  resolveChunksBucket,
  // Feature B' Wave 3 — voice + anchor profile loaders. Provided by Wave-3A's
  // s3-chunks.ts extension. Both return null on S3 miss (tutorials ingested
  // before Feature B' shipped have no artifacts → graceful degradation path).
  readVoiceProfile,
  readAnchorWhitelist,
  // Sprint J — glossary loader. Note: unlike readVoiceProfile /
  // readAnchorWhitelist which return null on miss, readGlossary THROWS on
  // miss (legacy contract from PR #20). We wrap it with try/catch in
  // loadVoiceAndAnchor for fail-open parity.
  readGlossary,
  type GlossaryArtifact,
} from '@/lib/s3-chunks';
import { validateAnchors, type AnchorWhitelistEntry } from '@/lib/openai/anchor-validator';
import { detectAdjacentPairViolations } from '@/lib/citations/adjacent-pair-gate';
import type { VoiceProfile } from '@/lib/ingest/voice-extract';
import type { SourceParagraph } from '@/lib/types';

// Sprint H Wave 1 (Builder D): the extract-diagrams call uses gpt-4o-mini
// with `max_tokens: 2048` (mirrored from extract-diagrams.ts). Keeping the
// cap constants here makes the pre-call cost projection visible at the
// integration boundary — per-chapter is the cost-budget authority for the
// lazy-hybrid pipeline (the extractor module deliberately stays out of it
// to preserve the bulkhead between compute and budget).
const EXTRACT_MODEL = 'gpt-4o-mini';
const EXTRACT_MAX_COMPLETION_TOKENS = 2048;

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
  /**
   * Sprint H Wave 1 (Builder D) — emit after the 4o-mini diagram extractor
   * finishes successfully. Synchronous + fire-and-forget; the SSE route
   * uses it to send a `diagrams-extracted` frame. NOT invoked on the
   * fail-open path (extractor error / cost-cap rejection). See
   * `./diagrams-extracted-event.ts` for the contract.
   */
  onDiagramsExtracted?: OnDiagramsExtracted;
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
  const {
    tutorialId,
    chapterIdx,
    abortSignal,
    onNarrativeToken,
    onNarrativeComplete,
    onChapterComplete,
    onDiagramsExtracted,
  } = args;

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

  // ── 3.5. Load Feature B' voice + anchor + (Sprint J) glossary (fail-open) ─
  // All three may be null for legacy tutorials ingested before the relevant
  // feature shipped. When null, generateNarrativeOnly + scoreFidelity
  // gracefully fall back to their pre-injection behavior; no rows land in
  // chapter_anchor_violations and no glossary section is prepended to the
  // narrative prompt.
  const { voiceProfile, anchorWhitelist, glossary } = await loadVoiceAndAnchor(tutorial);

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
      // Sprint J — glossary injection. Null when neither the labeled-
      // section path nor the NP-fallback produced any terms; the generator
      // omits the GLOSSARY prompt section in that case.
      glossary: glossary ?? undefined,
    });
  } catch (err) {
    await markFailed(chapter.id, `narrative: ${(err as Error).message}`);
    throw err;
  }
  onNarrativeComplete?.(narrativeResult.narrative);

  // ── 4.25. Extract structured diagrams from the prose (Sprint H Wave 1) ─
  //
  // Shape A "2-pass" extraction: a dedicated gpt-4o-mini call reads the
  // completed narrative and emits validated DiagramPayload[] which we
  // weave into the narrative as ```diagram fences. Background: PR #36's
  // prompt-teeth-alone approach showed 0/5 emission across diverse DDIA
  // chapters; Sprint H adds this extractor + the pure weaveDiagrams
  // splice path. See `_inspect/sprint-h/response-format-rfc.md`.
  //
  // Fail-open semantics (LOAD-BEARING): extractor failure (network,
  // refusal, cost-cap rejection, parse error) MUST NOT block chapter
  // completion. The narrative without diagrams is still a valid result.
  // See `kb:architecture/discipline/stability-patterns` §Bulkhead.
  //
  // Cost-cap gating lives HERE (not in extract-diagrams.ts) per the
  // bulkhead Builder A documented: extract-diagrams owns compute,
  // per-chapter owns the per-tutorial budget envelope.
  //
  // The extractor's structured emission cannot introduce new
  // `[ref:pageN:paragraphM]` citations (it only emits fenced JSON), so the
  // anchor validator's behavior is unchanged whether it reads the original
  // or the woven narrative. We persist the WOVEN narrative so downstream
  // readers (renderer, density metric, eval-harness) see the diagrams.
  let wovenNarrative = narrativeResult.narrative;
  let extractCostUsd = 0;
  let extractParseCostRow: {
    model: string;
    promptTokens: number;
    completionTokens: number;
    costUsd: number;
  } | null = null;
  try {
    // Pre-call cost-cap gate — mirrors streaming.ts's pattern. Use the
    // EXTRACT_SYSTEM_PROMPT + the narrative as the prompt-text envelope.
    const extractEstimate = estimateCost({
      model: EXTRACT_MODEL,
      promptText: EXTRACT_SYSTEM_PROMPT + narrativeResult.narrative,
      maxCompletionTokens: EXTRACT_MAX_COMPLETION_TOKENS,
    });
    await assertCostBudget(tutorialId, extractEstimate.estimatedCostUsd);

    const extractResult = await extractDiagrams({
      narrative: narrativeResult.narrative,
      abortSignal,
    });
    extractCostUsd = extractResult.costUsd;
    extractParseCostRow = {
      model: extractResult.model,
      promptTokens: extractResult.promptTokens,
      completionTokens: extractResult.completionTokens,
      costUsd: extractResult.costUsd,
    };

    if (extractResult.diagrams.length > 0) {
      // No anchor hints today — extract-diagrams emits payloads only; the
      // weaver falls through to its 30%-position deterministic fallback
      // (strategy 3). Future enhancement: surface heading/citation anchor
      // hints from the extractor; weave already accepts them.
      wovenNarrative = weaveDiagrams(
        narrativeResult.narrative,
        extractResult.diagrams.map((payload) => ({ payload })),
      );
    }

    // SSE callback (synchronous; fire-and-forget; see contract module).
    onDiagramsExtracted?.({
      count: extractResult.diagrams.length,
      droppedCount: extractResult.droppedCount,
      costUsd: extractResult.costUsd,
    });
  } catch (err) {
    // Fail-open: log + continue with the unmodified narrative. The
    // bulkhead means extractor failure (CostCapExceeded, parse error,
    // network, refusal) cannot fail the chapter. The SSE route sees the
    // absence of a `diagrams-extracted` frame and the streaming hook
    // treats it as "extraction skipped" (cosmetic; UX still correct).
    // eslint-disable-next-line no-console
    console.error(
      `[per-chapter] diagram extraction failed for ${chapter.id}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // ── 4.5. Validate whitelist-anchor coverage (Feature B' Wave 3) ──────
  //
  // Wave-3 review HIGH 3B-H1 fix: moved from Step 6.5 to Step 4.5 — runs
  // AFTER narrative generation but BEFORE quiz generation, matching the
  // design doc §Component 4 ordering. This lets a future regen-with-
  // feedback path (Open Decision D4, currently log-and-continue) regenerate
  // the narrative with anchor-aware feedback BEFORE the quiz consumes it.
  // Today's behavior is identical either way (log-and-continue is a
  // no-op for ordering); the move is a forward-compat correctness fix.
  //
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
      // Sprint H Wave 1: validate against the WOVEN narrative. ```diagram
      // fences don't carry [ref:pageN:paragraphM] citations, so behavior
      // is unchanged whether we pass the original or woven string — but
      // the variable name reflects the post-extract pipeline state.
      const validation = validateAnchors({
        narrative: wovenNarrative,
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
        `[per-chapter] anchor validation failed for ${chapter.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

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
    //
    // Sprint H Wave 3 fix (Rev D HIGH-1): pass the WOVEN narrative so any
    // diagrams the extractor already produced survive the partial-state path.
    // Also pass the extract cost row so the spend is accounted for even when
    // quiz failed (extract billed regardless).
    await persistNarrativeOnly(
      chapter.id,
      tutorialId,
      { ...narrativeResult, narrative: wovenNarrative },
      sourceParagraphs,
      extractParseCostRow,
    );
    throw err;
  }

  // ── 6. Persist (transactional) ─────────────────────────────────────────
  const finalStatus = quizResult.validationDropCount > 0 ? 'partial' : 'complete';
  db.transaction((tx) => {
    tx.update(chapters)
      .set({
        // Sprint H Wave 1: persist the WOVEN narrative so the renderer +
        // density metric + eval-harness see structured ```diagram fences.
        // When extraction returned 0 diagrams OR fail-opened, this is
        // identical to narrativeResult.narrative (weave is idempotent with
        // an empty diagrams array).
        narrative: wovenNarrative,
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
    // parses_cost rows — one per LLM call.
    // Sprint H Wave 3 (Rev D HIGH-2): `stage` discriminator added via
    // migration 0006. Quiz + extract both use gpt-4o-mini; before the
    // column rows were indistinguishable at query time.
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
        stage: 'narrative',
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
        stage: 'quiz',
      })
      .run();
    // Sprint H Wave 1 (Builder D): third parses_cost row for the
    // diagram-extraction call. Only inserted when extract succeeded
    // (fail-open path skips it — there's nothing to account for).
    if (extractParseCostRow) {
      tx.insert(parsesCost)
        .values({
          id: crypto.randomUUID(),
          tutorialId,
          chapterId: chapter.id,
          model: extractParseCostRow.model,
          promptTokens: extractParseCostRow.promptTokens,
          completionTokens: extractParseCostRow.completionTokens,
          costUsd: extractParseCostRow.costUsd,
          validationDropCount: 0,
          stage: 'extract-diagrams',
        })
        .run();
    }
  });

  // ── 6.5. Adjacent-pair citation gate (Q3 v3 — soft metric) ─────────────
  // Pure function. Detects two violation kinds in the woven narrative:
  //   - 'cross-page'         (likely span hallucination, ch56 case)
  //   - 'same-page-gap-gt-2' (range-ban laundering, ch36/ch40 case)
  // OBSERVABILITY-only in v1 — we log + persist the count + penalty score,
  // but DO NOT reject or retry. A later PR (Q3 v4) will promote this to a
  // hard gate once we have production traffic data to set thresholds with
  // confidence. See SI-citation-pair-laundering-001.
  const adjPairGate = detectAdjacentPairViolations(wovenNarrative);
  // eslint-disable-next-line no-console
  console.log(
    `[adj-pair-gate] chapter=${chapter.id} ord=${chapterIdx} ` +
      `totalRefs=${adjPairGate.totalRefs} adjacentPairs=${adjPairGate.adjacentPairs} ` +
      `violations=${adjPairGate.violations.length} ` +
      `penalty=${adjPairGate.penaltyScore.toFixed(3)}`,
  );

  // ── 7. Score narrative-vs-source fidelity (DRIFT-test3-022) ──────────
  // Run a separate 4o-mini call to count preserved concrete anchors. Fail-
  // open: if the scorer errors, we proceed without a score (the chapter is
  // already persisted as complete/partial; absent score = "unknown
  // fidelity" rather than blocking the read path).
  let fidelityCostUsd = 0;
  try {
    // Feature B' Wave 3 — pass the whitelist so the scorer can populate
    // whitelistAnchorsPreserved + whitelistAnchorsMissing columns (added
    // to chapter_fidelity_scores by Wave 1C migration 0004). Wave 3C
    // landed; FidelityCheckArgs accepts this optional field natively
    // (cast removed during Wave-3 fix-up — honesty-auditor MINOR finding).
    const fidelity = await scoreFidelity({
      chapterTitle: chapter.title,
      narrative: narrativeResult.narrative,
      sourceParagraphs,
      abortSignal,
      ...(anchorWhitelist ? { anchorWhitelist } : {}),
    });
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
          // Wave-3 fix-up (honesty-auditor MINOR promoted to HIGH):
          // wire the new anchor-aware fields into chapter_fidelity_scores.
          // Migration 0004 added these as nullable; null when the scorer
          // ran without a whitelist (pre-Feature-B' tutorials).
          whitelistAnchorsPreserved: fidelity.whitelistAnchorsPreserved,
          whitelistAnchorsMissing: fidelity.whitelistAnchorsMissing,
          // Q3 v3 adjacent-pair soft metric (migration 0007). Soft = persisted
          // but NOT used as a rejection signal in v1; promotion to hard gate
          // is queued as Q3 v4 after we have production-traffic baselines.
          adjacentPairCount: adjPairGate.adjacentPairs,
          adjacentPairPenalty: adjPairGate.penaltyScore,
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
    // Sprint H Wave 1: return the woven narrative so callers reading the
    // result in-memory see what's persisted (and what the renderer will
    // see). On the fail-open path this equals narrativeResult.narrative.
    narrative: wovenNarrative,
    questionsCount: quizResult.questions.length,
    flashcardsCount: quizResult.flashcards.length,
    validationDropCount: quizResult.validationDropCount,
    totalCostUsd:
      narrativeResult.costUsd + quizResult.costUsd + fidelityCostUsd + extractCostUsd,
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
  /**
   * Sprint J — the persisted GlossaryArtifact, or null on cache miss /
   * S3-read failure. The narrative prompt builder accepts the artifact's
   * `terms` array; we pass `glossary.terms` through when non-empty.
   */
  glossary: GlossaryArtifact['terms'] | null;
}> {
  if (!tutorial.sourcePdfSha256) {
    return { voiceProfile: null, anchorWhitelist: null, glossary: null };
  }
  const bucket = resolveChunksBucket(tutorial.sourceS3Url);
  const pdfSha256 = tutorial.sourcePdfSha256;
  // Sprint J — readGlossary throws on cache miss (S3 404 / NoSuchKey).
  // We catch inside the Promise.allSettled boundary so the throw is treated
  // identically to a transient read failure — both fail-open to null.
  const [voiceResult, anchorResult, glossaryResult] = await Promise.allSettled([
    readVoiceProfile({ bucket, pdfSha256 }),
    readAnchorWhitelist({ bucket, pdfSha256 }),
    readGlossary(bucket, pdfSha256),
  ]);
  const voiceProfile =
    voiceResult.status === 'fulfilled' ? voiceResult.value : null;
  const anchorWhitelist =
    anchorResult.status === 'fulfilled' ? anchorResult.value : null;
  // Glossary: a successful read with zero terms is treated as "no glossary"
  // (null) so the prompt-builder's empty-array no-op stays a no-op. A non-
  // empty terms array is passed through. The artifact's `schemaVersion` is
  // dropped at this layer — the prompt-builder consumes only the terms.
  const glossary =
    glossaryResult.status === 'fulfilled' &&
    glossaryResult.value.terms.length > 0
      ? glossaryResult.value.terms
      : null;
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
  // Glossary read failure is COMMON (most tutorials lacked a glossary in
  // pre-Sprint-J ingests; cache-hit fast-path may not have an artifact).
  // Log at debug level only — the success rate is intentionally low.
  if (glossaryResult.status === 'rejected') {
    // eslint-disable-next-line no-console
    console.debug(
      `[per-chapter] readGlossary failed (continuing without glossary): ${(glossaryResult.reason as Error).message}`,
    );
  }
  return { voiceProfile, anchorWhitelist, glossary };
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
  extractParseCostRow: {
    model: string;
    promptTokens: number;
    completionTokens: number;
    costUsd: number;
  } | null = null,
): Promise<void> {
  db.transaction((tx) => {
    tx.update(chapters)
      .set({
        // Sprint H Wave 3 fix (Rev D HIGH-1): caller passes wovenNarrative
        // (with ```diagram fences) when extraction succeeded so partial-state
        // chapters preserve the structured content. When extraction failed or
        // returned 0 diagrams, this equals narrativeResult.narrative.
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
        stage: 'narrative',
      })
      .run();
    // Sprint H Wave 3 (Rev D HIGH-1): record extract cost on the partial-
    // state path too. Extract already billed before quiz failed; dropping
    // the row would underreport spend.
    if (extractParseCostRow) {
      tx.insert(parsesCost)
        .values({
          id: crypto.randomUUID(),
          tutorialId,
          chapterId,
          model: extractParseCostRow.model,
          promptTokens: extractParseCostRow.promptTokens,
          completionTokens: extractParseCostRow.completionTokens,
          costUsd: extractParseCostRow.costUsd,
          validationDropCount: 0,
          stage: 'extract-diagrams',
        })
        .run();
    }
  });
}
