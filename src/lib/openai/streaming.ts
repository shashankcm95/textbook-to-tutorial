/**
 * src/lib/openai/streaming.ts — chapter-generation streaming inference.
 *
 * The core inference function for Phase 2 Wave 2. Responsibilities:
 *   1. Pre-call cost-cap assertion (per ari CRIT-1; cost-cap.ts gate).
 *   2. Stream the OpenAI chat completion with structured-output JSON Schema.
 *   3. Forward token deltas to caller via onToken callback (for SSE bridge).
 *   4. Accumulate the full JSON payload, parse, validate source_paragraph_ref
 *      against the chapter's known paragraph index (per ari HIGH-3 + riley
 *      CRIT), drop invalid refs, return validationDropCount for telemetry.
 *   5. Retry per a tiered policy (429 / 5xx / json-parse failure).
 *   6. Propagate AbortSignal through to the underlying fetch (riley CRIT-1).
 *
 * Design anchors:
 *   - kb:architecture/ai-systems/inference-cost-management §"Lever 5:
 *     Output control" — max_tokens cap + structured output + the pre-call
 *     budget assertion are layered defenses against output sprawl.
 *   - kb:architecture/ai-systems/inference-cost-management §"Hidden cost:
 *     agent loop amortization" — we DO NOT loop; each chapter is a single
 *     call. Single-call cost arithmetic is straight tokens × rate.
 *   - kb:architecture/discipline/error-handling-discipline §"Pattern 2:
 *     Translate to a normal value" — invalid sourceParagraphRef does NOT
 *     fail the whole generation; we drop the bad item, count it, return
 *     a partial result with chapter.status='partial' (per schema enum).
 *
 * What this file DOES NOT do (kept thin on purpose):
 *   - Does NOT write to the database — caller (the per-chapter worker, not
 *     yet implemented in this wave) inserts to parses_cost, questions,
 *     flashcards, chapters. We return the parts; persistence is theirs.
 *   - Does NOT manage the SSE protocol — caller bridges onToken into an
 *     SSE event stream. We're a pure async function with a callback.
 *   - Does NOT batch across chapters — chapter-gen is per-chapter; batching
 *     would require switching to the OpenAI batch API (deferred).
 */

import type {
  ChapterGenerationResult,
  LLMFlashcard,
  QuizQuestion,
  SourceParagraph,
} from '@/lib/types';
import { openai, getModel } from './client';
import {
  actualCost,
  estimateCost,
  isSupportedModel,
  UnknownModelError,
} from './cost';
import { assertCostBudget } from './cost-cap';
import {
  CHAPTER_GEN_RESPONSE_FORMAT,
  buildChapterGenSystemPrompt,
  buildChapterGenUserPrompt,
} from '@/lib/prompts/chapter-gen';

// ───────────────────────────────────────────────────────────────────────────
// Public API
// ───────────────────────────────────────────────────────────────────────────

export interface GenerateChapterStreamingArgs {
  /** Tutorial ID; used by cost-cap to query prior spend. */
  tutorialId: string;
  /** Chapter title — appears in the user prompt. */
  chapterTitle: string;
  /** The chapter's source paragraphs (from chapters.source_paragraphs_json). */
  sourceParagraphs: SourceParagraph[];
  /** Cancels the underlying fetch when fired (e.g., client disconnect). */
  abortSignal?: AbortSignal;
  /**
   * Called for each streaming token delta. Caller forwards as an SSE event.
   * Receives the raw text chunk (concatenation = the full JSON payload).
   */
  onToken: (delta: string) => void;
}

export interface GenerateChapterStreamingResult {
  /** The validated chapter generation result (invalid refs dropped). */
  result: ChapterGenerationResult;
  /** Actual prompt tokens billed by OpenAI. */
  promptTokens: number;
  /** Actual completion tokens billed by OpenAI. */
  completionTokens: number;
  /** Actual USD cost (for parses_cost.cost_usd). */
  costUsd: number;
  /** Count of questions+flashcards dropped due to invalid source_paragraph_ref. */
  validationDropCount: number;
  /** The model actually used (for parses_cost.model). */
  model: string;
}

/**
 * Custom error class for "model produced JSON we couldn't structurally
 * recover even after retry". Caller (worker) marks chapter.status='failed'.
 */
export class ChapterGenParseError extends Error {
  readonly rawText: string;
  constructor(message: string, rawText: string) {
    super(message);
    this.name = 'ChapterGenParseError';
    this.rawText = rawText;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Constants (retry policy + output cap)
// ───────────────────────────────────────────────────────────────────────────

/**
 * Upper bound for completion tokens. Sized for ~1500-word narrative +
 * 10 questions × ~80 tokens each + 25 flashcards × ~40 tokens each + JSON
 * overhead ≈ 1500 + 800 + 1000 + 700 ≈ 4000 tokens, padded to 4096.
 * Used both by the OpenAI call (max_tokens) AND by estimateCost as the
 * upper-bound completion estimate (per ari CRIT-1: pre-call cap must be
 * an upper bound). See finding HIGH-2 for the strict-mode interaction.
 */
const MAX_COMPLETION_TOKENS = 4096;

/** Backoff schedules per error class. Times are in milliseconds.
 *  429 budget: 1s, 2s, 4s with ±25% jitter — total worst-case ≈ 7s wait.
 *  5xx budget: 10s, 30s — total worst-case ≈ 40s wait.
 *  parse:      single retry with stricter prompt addendum.
 */
const RETRY_BACKOFF_MS = {
  rateLimit: [1_000, 2_000, 4_000],
  serverError: [10_000, 30_000],
  parseError: [0], // immediate retry with stricter prompt
} as const;

// ───────────────────────────────────────────────────────────────────────────
// Implementation
// ───────────────────────────────────────────────────────────────────────────

export async function generateChapterStreaming(
  args: GenerateChapterStreamingArgs,
): Promise<GenerateChapterStreamingResult> {
  const { tutorialId, chapterTitle, sourceParagraphs, abortSignal, onToken } = args;
  const model = getModel();

  if (!isSupportedModel(model)) {
    // Fail-closed: if the configured model has no pricing entry, we cannot
    // enforce the cost cap. Per cost-cap.ts contract, that is unsafe; throw
    // explicitly with a clear remediation path.
    throw new UnknownModelError(model);
  }

  // ── Pre-call cost-cap gate (ari CRIT-1) ──
  const systemPrompt = buildChapterGenSystemPrompt();
  const userPrompt = buildChapterGenUserPrompt({ chapterTitle, sourceParagraphs });
  const estimate = estimateCost({
    model,
    promptText: systemPrompt + userPrompt,
    maxCompletionTokens: MAX_COMPLETION_TOKENS,
  });
  await assertCostBudget(tutorialId, estimate.estimatedCostUsd);

  // ── Build the index of valid sourceParagraphRefs for post-call validation ──
  // O(N) Set lookup beats O(N) array scan per question/flashcard.
  const validRefs = new Set(
    sourceParagraphs.map((p) => `page${p.page}:paragraph${p.paragraphIdx}`),
  );

  // ── The actual streaming call, with retry on 429/5xx/parse ──
  // Each attempt is wrapped to surface the right error class to the loop.
  let lastError: unknown = null;
  for (let attempt = 0; attempt < maxAttempts(); attempt++) {
    // Cooperative abort: check before each attempt so a fast disconnect
    // doesn't waste a retry slot.
    if (abortSignal?.aborted) {
      throw abortError(abortSignal);
    }
    try {
      // nova CRITICAL-2 (test3 Phase 3) refactor: destructure both rawText
      // and usage directly from streamOnce. The previous design smuggled
      // usage via a module-global Map keyed on accumulated content — leaked
      // on AbortError, vulnerable to string-key collision under concurrent
      // streaming from distinct tutorials producing identical output.
      const { rawText, usage } = await streamOnce({
        model,
        systemPrompt,
        userPrompt,
        abortSignal,
        onToken,
        attempt,
      });
      // Parse + validate. On JSON-parse failure we throw a recoverable
      // ChapterGenParseError that the retry loop catches and treats as a
      // parseError class. parseAndValidate is now a PURE function (no
      // module-global lookup) — see nova CRITICAL-2 refactor above.
      const parsed = parseAndValidate(rawText, validRefs);
      // ── Post-call: account actual usage from the (final) stream chunk ──
      // The streaming API returns usage in the final chunk if stream_options
      // includes_usage; streamOnce destructures it out and returns it as
      // part of the StreamOnceResult tuple.
      const { promptTokens, completionTokens } = usage;
      const costUsd = actualCost({ model, promptTokens, completionTokens });
      return {
        result: parsed.result,
        promptTokens,
        completionTokens,
        costUsd,
        validationDropCount: parsed.validationDropCount,
        model,
      };
    } catch (err: unknown) {
      lastError = err;
      if (isAbortError(err) || abortSignal?.aborted) {
        // Abort propagated from caller — do NOT retry; surface to caller.
        throw err;
      }
      const retryDelay = computeRetryDelay(err, attempt);
      if (retryDelay === null) {
        // Non-retryable (4xx other than 429, or out of retries).
        throw err;
      }
      await sleep(retryDelay, abortSignal);
    }
  }
  // Loop fell through (shouldn't happen — computeRetryDelay enforces the
  // cap — but TypeScript wants the unreachable branch).
  throw lastError ?? new Error('generateChapterStreaming: exhausted retries');
}

// ───────────────────────────────────────────────────────────────────────────
// Internal: single stream attempt
// ───────────────────────────────────────────────────────────────────────────

interface StreamOnceArgs {
  model: string;
  systemPrompt: string;
  userPrompt: string;
  abortSignal: AbortSignal | undefined;
  onToken: (delta: string) => void;
  attempt: number;
}

/**
 * Result of a single streaming attempt.
 *
 * REFACTORED per nova CRITICAL-2 (test3 Phase 3): previously this function
 * returned just `string` and smuggled usage via a module-global Map keyed by
 * the accumulated content. That Map leaked on AbortError paths AND was
 * vulnerable to string-key collision when concurrent chapters from different
 * tutorials produced identical output. The Map is gone; we now return both
 * via this tuple. Caller destructures both.
 */
interface StreamOnceResult {
  rawText: string;
  usage: { promptTokens: number; completionTokens: number };
}

async function streamOnce(args: StreamOnceArgs): Promise<StreamOnceResult> {
  const { model, systemPrompt, userPrompt, abortSignal, onToken, attempt } = args;

  // On a parse-retry, append a stricter reminder to the user prompt. This is
  // the only attempt-aware variant; 429/5xx retries reuse the original prompt.
  const effectiveUserPrompt =
    attempt > 0
      ? `${userPrompt}\n\n[RETRY NOTE: the previous attempt produced invalid JSON. Emit STRICTLY valid JSON matching the response schema; no prose outside the JSON.]`
      : userPrompt;

  const stream = await openai.chat.completions.create(
    {
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: effectiveUserPrompt },
      ],
      response_format: CHAPTER_GEN_RESPONSE_FORMAT,
      stream: true,
      // Include usage in the final stream chunk so we can record exact cost
      // without making a second API call. Requires the openai SDK to be at
      // a version that supports stream_options; openai@4.55.0 does.
      stream_options: { include_usage: true },
      max_tokens: MAX_COMPLETION_TOKENS,
      temperature: 0.3,
    },
    {
      // CRITICAL: forward AbortSignal to the underlying fetch so client
      // disconnect cancels the OpenAI request (riley CRIT-1).
      signal: abortSignal,
    },
  );

  let accumulated = '';
  // Capture usage from the final chunk; mutable so we can read after the loop.
  let promptTokens = 0;
  let completionTokens = 0;

  for await (const chunk of stream) {
    // Re-check abort on each chunk so a mid-stream disconnect cancels
    // promptly even if OpenAI's stream is still emitting.
    if (abortSignal?.aborted) {
      throw abortError(abortSignal);
    }
    const delta = chunk.choices[0]?.delta?.content;
    if (typeof delta === 'string' && delta.length > 0) {
      accumulated += delta;
      onToken(delta);
    }
    // Usage block only present in the FINAL chunk (per stream_options docs).
    if (chunk.usage) {
      promptTokens = chunk.usage.prompt_tokens;
      completionTokens = chunk.usage.completion_tokens;
    }
  }

  // nova CRITICAL-2 (test3 Phase 3) fix: return tuple directly. No sidecar
  // Map, no string-key collision, no leak on AbortError (the throw above at
  // the abort-check skips this return path naturally — usage data dies with
  // the function frame). Caller in generateChapterStreaming destructures.
  return { rawText: accumulated, usage: { promptTokens, completionTokens } };
}

// ───────────────────────────────────────────────────────────────────────────
// Internal: parse + semantic validation of source_paragraph_ref
// ───────────────────────────────────────────────────────────────────────────

interface ParseAndValidateResult {
  result: ChapterGenerationResult;
  validationDropCount: number;
  // usage REMOVED per nova CRITICAL-2 refactor — caller passes usage in
  // directly from streamOnce's tuple return. parseAndValidate is now a pure
  // function (no module-global Map lookup).
}

function parseAndValidate(
  rawText: string,
  validRefs: Set<string>,
): ParseAndValidateResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (err) {
    throw new ChapterGenParseError(
      `Failed to JSON.parse OpenAI response: ${(err as Error).message}`,
      rawText,
    );
  }

  // Defensive: even with strict structured output, validate the top-level
  // shape. Strict mode CAN fail mid-stream (e.g., the model exceeds
  // max_tokens before closing the JSON), in which case rawText is
  // incomplete and JSON.parse already threw above. This is the post-parse
  // shape check.
  if (
    !isObject(parsed) ||
    typeof parsed.narrative !== 'string' ||
    !Array.isArray(parsed.questions) ||
    !Array.isArray(parsed.flashcards)
  ) {
    throw new ChapterGenParseError(
      'OpenAI response did not match top-level chapter schema shape',
      rawText,
    );
  }

  // Validate each question / flashcard ref against the chapter's known
  // paragraph index. Drop invalids; count for telemetry.
  let droppedCount = 0;
  const validQuestions: QuizQuestion[] = [];
  for (const q of parsed.questions as QuizQuestion[]) {
    if (validRefs.has(q.sourceParagraphRef)) {
      validQuestions.push(q);
    } else {
      droppedCount++;
    }
  }
  const validFlashcards: LLMFlashcard[] = [];
  for (const f of parsed.flashcards as LLMFlashcard[]) {
    if (validRefs.has(f.sourceParagraphRef)) {
      validFlashcards.push(f);
    } else {
      droppedCount++;
    }
  }

  // vlad CRITICAL-1 (test3 Phase 4) fix: `usage` was previously read from
  // the now-removed USAGE_FROM_STREAM module-global Map. The nova CRITICAL-2
  // refactor (Phase 3) dropped the local lookup AND the field from the
  // interface but left this orphan reference here, which would crash the
  // function on every call (ReferenceError in strict mode; silent undefined
  // in non-strict). Now that usage is part of streamOnce's tuple return,
  // it does NOT belong in parseAndValidate's output — caller composes both.
  return {
    result: {
      narrative: parsed.narrative,
      questions: validQuestions,
      flashcards: validFlashcards,
    },
    validationDropCount: droppedCount,
  };
}

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

// ───────────────────────────────────────────────────────────────────────────
// Internal: retry classification + backoff math
// ───────────────────────────────────────────────────────────────────────────

function maxAttempts(): number {
  // Sum across all retry classes + 1 for the initial attempt.
  return (
    1 +
    RETRY_BACKOFF_MS.rateLimit.length +
    RETRY_BACKOFF_MS.serverError.length +
    RETRY_BACKOFF_MS.parseError.length
  );
}

/**
 * Returns the backoff delay (ms) to wait before the next attempt, or null
 * if the error is non-retryable / retries are exhausted.
 *
 * Classification:
 *   - HTTP 429 (rate limit) → consume from RETRY_BACKOFF_MS.rateLimit with jitter
 *   - HTTP 5xx              → consume from RETRY_BACKOFF_MS.serverError
 *   - ChapterGenParseError  → consume from RETRY_BACKOFF_MS.parseError
 *   - Anything else (4xx, network) → null (non-retryable)
 *
 * Per-error counters are passed via the `attempt` index by walking the
 * arrays in order. NOTE: a sequence of 429,5xx,429 will consume from each
 * array in order; we don't track per-class attempt counts separately (would
 * require carrying state across the loop). MVP behavior: total retries
 * across all classes is bounded by maxAttempts(). See finding MEDIUM-2.
 */
function computeRetryDelay(err: unknown, attempt: number): number | null {
  if (err instanceof ChapterGenParseError) {
    return RETRY_BACKOFF_MS.parseError[Math.min(attempt, RETRY_BACKOFF_MS.parseError.length - 1)] ?? null;
  }
  const status = extractStatus(err);
  if (status === 429) {
    const base = RETRY_BACKOFF_MS.rateLimit[Math.min(attempt, RETRY_BACKOFF_MS.rateLimit.length - 1)];
    return base === undefined ? null : jitter(base);
  }
  if (status !== null && status >= 500 && status < 600) {
    const base = RETRY_BACKOFF_MS.serverError[Math.min(attempt, RETRY_BACKOFF_MS.serverError.length - 1)];
    return base ?? null;
  }
  return null;
}

function extractStatus(err: unknown): number | null {
  if (typeof err === 'object' && err !== null && 'status' in err) {
    const s = (err as { status: unknown }).status;
    if (typeof s === 'number') return s;
  }
  return null;
}

/** ±25% jitter. Math.random() OK here — not security-sensitive. */
function jitter(baseMs: number): number {
  const variance = baseMs * 0.25;
  return Math.max(0, baseMs + (Math.random() * 2 - 1) * variance);
}

// ───────────────────────────────────────────────────────────────────────────
// Internal: abort plumbing
// ───────────────────────────────────────────────────────────────────────────

function isAbortError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { name?: unknown; code?: unknown };
  return e.name === 'AbortError' || e.code === 'ERR_ABORTED';
}

function abortError(signal: AbortSignal): Error {
  // Prefer the reason if provided (Node 20+ supports AbortSignal.reason).
  const reason = (signal as AbortSignal & { reason?: unknown }).reason;
  if (reason instanceof Error) return reason;
  const err = new Error('chapter generation aborted by caller');
  err.name = 'AbortError';
  return err;
}

/** Sleep that respects AbortSignal. Resolves on timeout or rejects on abort. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal));
      return;
    }
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(abortError(signal!));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
