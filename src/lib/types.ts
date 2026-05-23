// src/lib/types.ts — shared coherence-handoff types for TB_to_Tutorial_converter
//
// This file is THE coherence-handoff anchor per ari's design (Phase 1
// synthesis): the same type names are imported by:
//   - data-engineer (rae): drizzle schema row → SourceParagraph mapping
//   - ml-engineer (mira): OpenAI structured-output JSON schema generator
//   - frontend (mae):   tutorial render + proof-citation overlay
//
// Changing field names here is a CROSS-CUTTING change and must be
// coordinated. Adding fields is safe (additive); renaming is breaking.
//
// Design anchor: this is the "shared vocabulary" layer per
// kb:architecture/discipline/error-handling-discipline §"Define errors
// out of existence" — by encoding the proof-citation key shape
// (`pageN:paragraphM`) as a documented string convention with a single
// validator, we eliminate the class of bugs where ml-engineer's prompt
// emits a ref the renderer can't resolve.

// ---------------------------------------------------------------------------
// Source-paragraph anchoring (PDF parse output → proof-citation target)
// ---------------------------------------------------------------------------

/**
 * A single paragraph extracted from the source PDF.
 *
 * Stored as JSON-serialized array in chapters.source_paragraphs_json
 * (per ari's schema design). Used by the renderer to show the cited
 * paragraph in a side-popover when the user hovers a question/flashcard.
 *
 * @property page         - 1-based page number from the PDF
 * @property paragraphIdx - 0-based ordinal within the page (top-to-bottom)
 * @property text         - full paragraph text (UTF-8); used verbatim in the
 *                          proof-citation popover. May contain newlines.
 */
export type SourceParagraph = {
  page: number;
  paragraphIdx: number;
  text: string;
};

/**
 * The paragraph index for one chapter.
 *
 * pageStart/pageEnd are inclusive bounds (e.g., chapter 2 spans pp. 23-47
 * → pageStart=23, pageEnd=47). `paragraphs` is the flat list of every
 * SourceParagraph within that range, in document order.
 */
export type ChapterSourceRange = {
  pageStart: number;
  pageEnd: number;
  paragraphs: SourceParagraph[];
};

/**
 * Source-paragraph reference, used in question/flashcard payloads to
 * cite the originating paragraph.
 *
 * Format: `page{N}:paragraph{M}` where N is 1-based page and M is 0-based
 * paragraphIdx within that page. Example: `page42:paragraph3` =
 * the 4th paragraph (0-indexed) on page 42.
 *
 * Validators (in ml-engineer + renderer):
 *   - shape: /^page\d+:paragraph\d+$/
 *   - resolution: page N exists in ChapterSourceRange AND paragraphIdx M
 *     exists in that page's paragraph list.
 *
 * The shape is intentionally human-readable so failures show up clearly
 * in OpenAI's structured-output validation logs.
 */
export type SourceParagraphRef = `page${number}:paragraph${number}`;

// ---------------------------------------------------------------------------
// Chapter generation result (ml-engineer's OpenAI output contract)
// ---------------------------------------------------------------------------

export type QuizQuestion = {
  /** The question prompt. Plain text; markdown OK but rendered as-is. */
  prompt: string;
  /** Exactly 4 options. Tuple type enforces arity at compile time. */
  options: [string, string, string, string];
  /** Index (0-3) of the correct option in `options`. */
  correctIndex: 0 | 1 | 2 | 3;
  /**
   * Brief explanation shown after the user answers (right or wrong).
   * Should reference the source paragraph for credibility.
   */
  explanation: string;
  /**
   * Reference to the source paragraph this question is derived from.
   * Validated at OpenAI-output-parse time against the ChapterSourceRange.
   */
  sourceParagraphRef: SourceParagraphRef;
};

/**
 * LLM-payload flashcard (NOT the DB row).
 *
 * NAMED-WITH-`LLM`-PREFIX to disambiguate from `Flashcard` exported by
 * `src/db/schema.ts` (which is the Drizzle `$inferSelect` row type with
 * `id`, `chapter_id`, `created_at`, etc.).
 *
 * - `LLMFlashcard`  → ml-engineer's OpenAI output contract (this file).
 * - `Flashcard`     → DB row from `flashcards` table (db/schema.ts).
 *
 * The ingest worker converts `LLMFlashcard[]` → `NewFlashcard[]` before
 * insertion. Never import both into the same module to avoid confusion.
 */
export type LLMFlashcard = {
  /** Front (the prompt shown first). Plain text. */
  front: string;
  /** Back (the answer shown after flip). Plain text; markdown OK. */
  back: string;
  /** Reference to the source paragraph this flashcard is derived from. */
  sourceParagraphRef: SourceParagraphRef;
};

/**
 * The full ml-engineer chapter-generation result. Enforced by OpenAI's
 * structured-output JSON schema (per mira's prompt-builder output).
 *
 * `narrative` is markdown — rendered via react-markdown in the UI.
 * `questions` and `flashcards` arrays size enforced by prompt (5-10
 * questions, 15-25 flashcards) but NOT by this type — runtime validation
 * lives in the prompt's response_format.
 */
export type ChapterGenerationResult = {
  narrative: string;
  questions: QuizQuestion[];
  flashcards: LLMFlashcard[];
};

// ---------------------------------------------------------------------------
// Cost estimation (pre-call budget assertion)
// ---------------------------------------------------------------------------

/**
 * Estimated cost of a planned OpenAI call. Computed BEFORE the call by
 * the cost-estimator (tiktoken-based prompt token count + heuristic
 * completion-token estimate based on prompt shape). Compared against
 * env.COST_CAP_USD; aborts if exceeded.
 *
 * The estimate is deliberately PRE-CALL — once the call is made the cost
 * is sunk. We block at the gate, not after.
 *
 * Anchor: kb:architecture/ai-systems/inference-cost-management §"pre-call
 * cost budget" pattern (referenced by ari's design).
 */
export type CostEstimate = {
  /** Model identifier, e.g., 'gpt-4o-mini' */
  model: string;
  /** Token count for the input prompt (via tiktoken) */
  estimatedPromptTokens: number;
  /** Heuristic estimate of completion tokens based on prompt+schema shape */
  estimatedCompletionTokens: number;
  /** Total estimated USD cost (prompt + completion × per-token rates) */
  estimatedCostUsd: number;
};
