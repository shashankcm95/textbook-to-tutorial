// src/lib/ingest/voice-extract.ts — author-voice stylometric extractor.
//
// Feature B' (Voice + Anchor profile, Wave 1). Reads a weighted sample of body
// paragraphs from a PDF and produces a `VoiceProfile` — a compact stylometric
// fingerprint (tone summary, signature moves, example phrases, humor patterns,
// preferred analogies) that downstream tutorial generation can inject as a
// "preservation guide" so the generated chapters keep the author's distinctive
// rhetorical voice instead of regressing to generic technical prose.
//
// ───────────────────────────────────────────────────────────────────────────
// T3.5 — SAMPLER v1 → v2 (weighted-rhetorical-v1)
// ───────────────────────────────────────────────────────────────────────────
// Why this rewrite:
//   Two independent round-2 reviews (Author + Professor) triangulated on the
//   same architectural concern: uniform-stride body sampling produces
//   "voice-laundering" — the same prompt + sampler yields the same tone
//   summary for any two books modulo adjective swaps, because the syntactic
//   carriers of authorial voice (pushbacks, em-dash interjections, opening
//   topic-frames) live in SPECIFIC paragraphs, not in average body prose.
//
// What changed:
//   - SAMPLER_VERSION bumped 'uniform-body-v1' → 'weighted-rhetorical-v1'.
//     This is the load-bearing signal for downstream cache invalidation;
//     on first re-generation the voice-profile cache in S3 will miss and
//     the new sampler will run. That is by design.
//   - sampleParagraphs() now weights each candidate before drawing:
//       Rule 1 — Chapter-opening boost (3.0×): paragraphs near the start of
//         a chapter section carry topic-frames and pushbacks. Sprint D
//         Phase 3 (see below) plumbs TRUE chapter-first ordinals via
//         SourceParagraph.chapterParagraphIdx; the page-top proxy
//         (`paragraphIdx <= 2`) remains as a graceful-degradation fallback
//         for pre-Phase-3 paragraphs that don't carry the new field.
//       Rule 2 — Rhetorical-marker boost (2.0×): paragraphs containing
//         "but", "however", "yet", em-dash/en-dash, or forward-pointers
//         ("we will", "next section/chapter/lesson") — the syntactic
//         carriers of the rhetorical moves we want preserved.
//       Rule 3 — Epigraph heuristic (1.5×): a short (<40 words) paragraph
//         at top-of-page (`paragraphIdx === 0`) with no terminal period
//         is often an epigraph/quote — distinctive authorial framing.
//   - Drawing uses Algorithm A-Res weighted reservoir sampling (single
//     pass over candidates; key = U^(1/w); keep top-k by key). The k
//     budget (`SAMPLE_SIZE`) is unchanged. STRATEGY CHANGE, NOT BUDGET
//     CHANGE — the LLM call sees the same number of paragraphs, just a
//     more voice-informative subset.
//   - VoiceProfile schema and all consumers (anchor-validator, narrative-only
//     prompt builder, fidelity scorer) are untouched — return shape is
//     preserved.
//
// Why a separate module (not folded into narrative-only or glossary-extract):
//   - SINGLE CHANGE-PRESSURE: voice extraction has its own prompt, its own
//     output schema, and its own retry/cost-accounting concerns. Co-locating
//     with narrative-only or glossary-extract would entangle three independent
//     prompts behind a shared function — the typical accidental-coupling smell.
//   - DIFFERENT CARDINALITY: voice runs ONCE per PDF (not per chapter). It's
//     keyed off pdfSha256 and the result is reused across every chapter the
//     book emits. Glossary is per-section; narrative is per-chunk. Each has
//     its own lifecycle. Mixing them muddies the cache key story.
//   - S3 PERSISTENCE: the caller (worker.ts integration, later wave) writes
//     the returned VoiceProfile to S3. This module deliberately stops at
//     "produce the in-memory object" — keeps it side-effect-free and trivial
//     to unit-test without a real S3 bucket.
//
// Design anchors:
//   - docs/design/feature-b-voice-and-anchor-profile.md — full spec for the
//     two-artifact Feature B' pipeline (voice profile + anchor profile).
//   - kb:architecture/crosscut/single-responsibility — one prompt, one
//     schema, one cost row, one cache key.
//   - kb:architecture/ai-systems/inference-cost-management §"Lever 1: Model
//     selection" — gpt-4o-mini is sufficient for stylometric pattern-naming
//     on a 10-paragraph sample; the work doesn't require gpt-4o's reasoning.
//   - kb:architecture/ai-systems/inference-cost-management §"Lever 5: Output
//     control" — strict-mode JSON schema (response_format with json_schema +
//     strict: true) caps drift and removes the "is the output valid?" branch
//     from the parsing path. We still defensively type-check after parse.
//   - kb:architecture/discipline/stability-patterns §Fail-Fast — JSON parse
//     errors throw `VoiceProfileParseError` (caller — via withRetry — gets
//     one parse-retry, then surfaces).
//
// ───────────────────────────────────────────────────────────────────────────
// Sprint D Phase 3 — chapter-firsts plumbing (PR following PR #24)
// ───────────────────────────────────────────────────────────────────────────
// T3.5 (above) had to use `paragraphIdx <= 2` (page-top) as a proxy for
// chapter-firsts because no chapter-boundary metadata existed on
// SourceParagraph at the voice-extract layer. PR #24's honest deviation:
//
//   "No chapterFirstParagraphIdx parameter. SourceParagraph only has
//    page-local paragraphIdx — there is no chapter-boundary metadata at
//    this layer. Used paragraphIdx <= 2 (page-top) as the available proxy."
//
// Sprint D Phase 3 closes that gap. The ingest worker now tags each
// SourceParagraph with `chapterParagraphIdx` (0-based ordinal WITHIN its
// chapter) before voice-extract is called. weighParagraph() prefers this
// field when present and falls back to the page-top proxy when absent —
// preserving backward compatibility with already-ingested tutorials whose
// source_paragraphs_json predates the new field.
//
// SAMPLER_VERSION is intentionally NOT bumped on this change. The sampling
// ALGORITHM is unchanged (same weights, same threshold, same A-Res draw);
// only the INPUT DATA QUALITY improves. Bumping the version would force-
// invalidate every cached voice profile in S3 with no behavioral change to
// justify the cost — a cache thrash for a strictly-better input signal.
//
// The proxy path is now a graceful-degradation fallback rather than the
// primary signal. After all production tutorials have been re-ingested
// (or have failed the cache-hit visibility check at worker.ts:Wave-3
// review H1) the proxy branch can be retired; tracked as future cleanup.

import { openai } from '@/lib/openai/client';
import { actualCost, isSupportedModel, UnknownModelError } from '@/lib/openai/cost';
import { withRetry } from '@/lib/openai/_retry';
import type { SourceParagraph } from '@/lib/types';

// ───────────────────────────────────────────────────────────────────────────
// Constants
// ───────────────────────────────────────────────────────────────────────────

const MODEL = 'gpt-4o-mini';
const MAX_COMPLETION_TOKENS = 1500;
const SAMPLE_SIZE = 10;
const SAMPLER_VERSION = 'weighted-rhetorical-v1' as const;

// Weight rules for sampleParagraphs (T3.5). Constants are surfaced so tests
// can assert them without re-deriving the magic numbers.
const WEIGHT_CHAPTER_OPENING = 3.0;
const WEIGHT_RHETORICAL_MARKER = 2.0;
const WEIGHT_EPIGRAPH = 1.5;
const CHAPTER_OPENING_PARAGRAPH_IDX_THRESHOLD = 2;
const EPIGRAPH_MAX_WORDS = 40;

// Regex for rhetorical markers (Rule 2). Word-boundaries on "but/however/yet"
// avoid matching mid-word ("button", "however-styled-token"). Em-dash (—)
// and en-dash (–) are unicode literals. Forward-pointers use a small
// alternation rather than enumerating every section/chapter/lesson noun.
const RHETORICAL_MARKER_REGEX =
  /\bbut\b|\bhowever\b|\byet\b|—|–|\bwe will\b|\bnext (?:section|chapter|lesson)\b/;

// Verbatim system prompt (per contract). Keep as a module constant so a
// single edit propagates; test asserts the prompt is passed unmodified.
const SYSTEM_PROMPT = `You are a literary stylometric analyst. Given 10 sample paragraphs from a non-fiction technical book, identify the author's distinct rhetorical voice. Your output will be injected into a tutorial-generation prompt as a preservation guide.

Identify:

  1. SIGNATURE MOVES (3-5): named rhetorical patterns the author uses consistently. Examples:
     - "Opens chapters with a question or a deliberate pushback"
     - "Sets up benefits then immediately qualifies with 'but...'"
     - "Names canonical incidents (leap-second bug, Knight Capital) rather than describing abstract failure classes"
     - "Cites academic papers inline by surname + year"

  2. EXAMPLE PHRASES (5-8): verbatim short quotes from the samples that sound DISTINCTIVELY like this author — phrases that would lose their identity if paraphrased. ≤15 words each. Include the page:paragraph ref for each.

  3. HUMOR PATTERNS (1-3): how the author handles failure modes / mistakes / industry hype. Dry? Self-deprecating? Bombastic? Specific named jokes if present. Each ≤25 words.

  4. PREFERRED ANALOGY TYPES (1-3): does the author reach for celestial bodies, sports, food, household-appliance metaphors? Identify the register without inventing instances. Each ≤20 words.

  5. TONE_SUMMARY: a single sentence (≤25 words) capturing the overall voice.

Output strict JSON matching the response schema.`;

// ───────────────────────────────────────────────────────────────────────────
// Strict-mode JSON schema for response_format
//
// OpenAI's structured-output strict mode requires:
//   - additionalProperties: false on every object
//   - every property listed in `required` (no optional fields)
//   - $schema NOT included (server provides it)
// We satisfy these by making the response object exhaustive. The caller-
// facing VoiceProfile interface adds the (deterministic, locally-computed)
// fields: schema_version, extracted_at, model, extraction_cost_usd,
// sample_size, sampler_version. Those are NOT part of the LLM output.
// ───────────────────────────────────────────────────────────────────────────

const VOICE_PROFILE_RESPONSE_FORMAT = {
  type: 'json_schema' as const,
  json_schema: {
    name: 'voice_profile',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      required: [
        'tone_summary',
        'signature_moves',
        'example_phrases',
        'humor_patterns',
        'preferred_analogies',
      ],
      properties: {
        tone_summary: { type: 'string' },
        signature_moves: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['name', 'description'],
            properties: {
              name: { type: 'string' },
              description: { type: 'string' },
            },
          },
        },
        example_phrases: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['phrase', 'ref'],
            properties: {
              phrase: { type: 'string' },
              ref: { type: 'string' },
            },
          },
        },
        humor_patterns: {
          type: 'array',
          items: { type: 'string' },
        },
        preferred_analogies: {
          type: 'array',
          items: { type: 'string' },
        },
      },
    },
  },
} as const;

// ───────────────────────────────────────────────────────────────────────────
// Public types
// ───────────────────────────────────────────────────────────────────────────

export interface VoiceProfile {
  schema_version: 1;
  extracted_at: string; // ISO timestamp
  model: string; // "gpt-4o-mini"
  extraction_cost_usd: number;
  sample_size: number; // 10 by default
  sampler_version: 'weighted-rhetorical-v1';
  tone_summary: string; // single sentence, ≤25 words
  signature_moves: Array<{ name: string; description: string }>; // 3-5 entries
  example_phrases: Array<{ phrase: string; ref: string }>; // 5-8 entries
  humor_patterns: string[]; // 1-3 entries
  preferred_analogies: string[]; // 1-3 entries
}

export interface ExtractVoiceProfileArgs {
  pdfSha256: string;
  bodyParagraphs: SourceParagraph[]; // ONLY body chunks; caller filters
  abortSignal?: AbortSignal;
}

/**
 * Caller-friendly parse error class. Recognized by withRetry's
 * `isParseError` predicate as parse-retryable (one retry, no backoff —
 * matches the legacy NarrativeParseError shape in narrative-only.ts).
 *
 * The `rawText` field carries the offending LLM output for diagnostics —
 * useful when the strict-mode schema fails open in some edge case (a
 * malformed string slipped past server-side validation).
 */
export class VoiceProfileParseError extends Error {
  constructor(message: string, public readonly rawText: string) {
    super(message);
    this.name = 'VoiceProfileParseError';
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Sampling — pure helpers, exported for unit-test visibility
//
// T3.5 — weighted-rhetorical sampling. See the header comment block for the
// motivation; the rules implemented here are:
//   - Chapter-opening (Sprint D Phase 3: TRUE chapterParagraphIdx <= 2 when
//     available; PR #24 page-top proxy paragraphIdx <= 2 as fallback): 3.0×
//   - Rhetorical-marker (but/however/yet/em-dash/forward-pointer):  2.0×
//   - Epigraph (page-top, <40 words, no terminal period):           1.5×
//
// Weights are multiplicative; a paragraph qualifying for all three rules
// reaches 9.0× weight relative to the 1.0× baseline.
// ───────────────────────────────────────────────────────────────────────────

/**
 * Compute the sampling weight for a single paragraph under the
 * weighted-rhetorical-v1 strategy. Exposed for direct unit testing — the
 * weighted-reservoir draw is statistical, but the weight function itself is
 * pure and deterministic and worth pinning explicitly.
 */
export function weighParagraph(p: SourceParagraph): number {
  let w = 1.0;

  // Rule 1: chapter-opening boost.
  //
  // Sprint D Phase 3 — prefer the TRUE chapter-first ordinal
  // (`chapterParagraphIdx`, populated by the ingest worker after chapter
  // splitting). When absent (pre-Sprint-D-Phase-3 paragraphs, e.g., already-
  // ingested tutorials whose source_paragraphs_json predates the new
  // field), fall back to PR #24's page-top proxy — chapters/sections
  // typically begin at a page break, so the same syntactic carriers
  // (topic-frames, pushbacks) cluster in paragraphs at idx 0-2 of a page.
  // Same threshold applies to both signals (≤ 2).
  const isChapterOpening =
    typeof p.chapterParagraphIdx === 'number'
      ? p.chapterParagraphIdx <= CHAPTER_OPENING_PARAGRAPH_IDX_THRESHOLD
      : p.paragraphIdx <= CHAPTER_OPENING_PARAGRAPH_IDX_THRESHOLD;
  if (isChapterOpening) {
    w *= WEIGHT_CHAPTER_OPENING;
  }

  // Rule 2: rhetorical-marker boost. Case-insensitive match on the
  // syntactic carriers of pushback / forward-pointer / qualification.
  if (RHETORICAL_MARKER_REGEX.test(p.text.toLowerCase())) {
    w *= WEIGHT_RHETORICAL_MARKER;
  }

  // Rule 3: epigraph heuristic. A short, page-top paragraph without a
  // terminal period — frequently a chapter epigraph or pull-quote, which
  // is distinctive authorial framing material.
  const trimmed = p.text.trim();
  const wordCount = trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length;
  if (
    p.paragraphIdx === 0 &&
    wordCount < EPIGRAPH_MAX_WORDS &&
    !/\.\s*$/.test(p.text)
  ) {
    w *= WEIGHT_EPIGRAPH;
  }

  return w;
}

/**
 * Weighted reservoir sampling (Algorithm A-Res, Efraimidis & Spirakis 2006).
 *
 * For each item, draw a uniform key U in (0, 1) and compute the score
 * `key = U^(1/w)`. Keep the top-k items by key. This yields a sample where
 * the probability of inclusion is proportional to weight, in a single pass,
 * without enumerating combinations.
 *
 * Exposed for unit testing. `Math.random()` is intentional; if a test needs
 * determinism, mock `Math.random` for that single case (see test file).
 */
export function weightedSample<T>(
  items: Array<{ item: T; weight: number }>,
  k: number,
): T[] {
  if (items.length === 0 || k <= 0) return [];
  if (items.length <= k) return items.map(({ item }) => item);

  // Algorithm A-Res. Math.max(weight, 1e-9) guards a degenerate 0-weight
  // input from a divide-by-zero in the exponent.
  const keyed = items.map(({ item, weight }) => ({
    item,
    key: Math.pow(Math.random(), 1 / Math.max(weight, 1e-9)),
  }));
  keyed.sort((a, b) => b.key - a.key);
  return keyed.slice(0, k).map(({ item }) => item);
}

/**
 * Pick up to `SAMPLE_SIZE` paragraphs from `paragraphs`, sampled
 * proportionally to per-paragraph rhetorical weight (see weighParagraph).
 *
 * Behavior:
 *   - If `paragraphs.length === 0`: return [].
 *   - If `paragraphs.length <= SAMPLE_SIZE`: return the whole list (preserve
 *     order, no duplication, no padding) — identical to v1 fallback.
 *   - Otherwise: compute per-paragraph weights, draw `SAMPLE_SIZE` via
 *     weighted reservoir sampling, then re-sort selected paragraphs by
 *     (page, paragraphIdx) so the LLM sees them in source order — same
 *     contract as v1 for the downstream prompt.
 *
 * Returned paragraphs preserve their original `page` + `paragraphIdx` so the
 * downstream prompt can attach a `pageN:paragraphM` ref to each sample.
 */
export function sampleParagraphs(paragraphs: SourceParagraph[]): SourceParagraph[] {
  if (paragraphs.length === 0) return [];
  if (paragraphs.length <= SAMPLE_SIZE) return [...paragraphs];

  const weighted = paragraphs.map((p) => ({ item: p, weight: weighParagraph(p) }));
  const drawn = weightedSample(weighted, SAMPLE_SIZE);

  // Re-sort by source order so the prompt reads naturally and pageN
  // refs are monotone — matches the v1 user-prompt expectation.
  drawn.sort((a, b) => (a.page - b.page) || (a.paragraphIdx - b.paragraphIdx));
  return drawn;
}

// ───────────────────────────────────────────────────────────────────────────
// Prompt builders — pure, exported for test assertion convenience
// ───────────────────────────────────────────────────────────────────────────

/**
 * Build the user-message body from a sampled paragraph list. Each paragraph
 * is rendered as `[pageN:paragraphM] <text>` so the LLM can echo refs in its
 * `example_phrases` output (matching the `pageN:paragraphM` SourceParagraphRef
 * convention from src/lib/types.ts).
 *
 * The paragraph count in the leading marker is dynamic (the prompt template
 * says "(10 total)" but real-world samples may be smaller if the body has
 * <10 paragraphs; we substitute the actual count for honesty).
 */
export function buildVoiceUserPrompt(samples: SourceParagraph[]): string {
  const rendered = samples
    .map((p) => `[page${p.page}:paragraph${p.paragraphIdx}] ${p.text}`)
    .join('\n\n');
  return `SAMPLE PARAGRAPHS:\n\n${rendered}\n\n... (${samples.length} total)\n\nIdentify the author's voice. Output strict JSON now.`;
}

// ───────────────────────────────────────────────────────────────────────────
// Type-guard for the LLM response object
// ───────────────────────────────────────────────────────────────────────────

interface VoiceLLMResponse {
  tone_summary: string;
  signature_moves: Array<{ name: string; description: string }>;
  example_phrases: Array<{ phrase: string; ref: string }>;
  humor_patterns: string[];
  preferred_analogies: string[];
}

function isVoiceLLMResponse(x: unknown): x is VoiceLLMResponse {
  if (typeof x !== 'object' || x === null) return false;
  const o = x as Record<string, unknown>;
  if (typeof o.tone_summary !== 'string') return false;
  if (!Array.isArray(o.signature_moves)) return false;
  for (const m of o.signature_moves) {
    if (typeof m !== 'object' || m === null) return false;
    const mm = m as Record<string, unknown>;
    if (typeof mm.name !== 'string' || typeof mm.description !== 'string') return false;
  }
  if (!Array.isArray(o.example_phrases)) return false;
  for (const ph of o.example_phrases) {
    if (typeof ph !== 'object' || ph === null) return false;
    const pp = ph as Record<string, unknown>;
    if (typeof pp.phrase !== 'string' || typeof pp.ref !== 'string') return false;
  }
  if (!Array.isArray(o.humor_patterns) || !o.humor_patterns.every((s) => typeof s === 'string')) {
    return false;
  }
  if (
    !Array.isArray(o.preferred_analogies) ||
    !o.preferred_analogies.every((s) => typeof s === 'string')
  ) {
    return false;
  }
  return true;
}

// ───────────────────────────────────────────────────────────────────────────
// Public entry point
// ───────────────────────────────────────────────────────────────────────────

/**
 * Extract an author-voice fingerprint from a weighted sample of body
 * paragraphs.
 *
 * - Samples paragraphs by rhetorical weight (Algorithm A-Res; see
 *   sampleParagraphs + weighParagraph). T3.5 strategy change vs v1.
 * - Calls gpt-4o-mini with strict-mode structured output.
 * - Wraps the call in withRetry (429 / 5xx / parse-retry budgets).
 * - Returns a fully-populated VoiceProfile (including locally-computed
 *   schema_version, extracted_at, model, extraction_cost_usd, sample_size,
 *   sampler_version).
 *
 * Does NOT write to S3. The caller (worker.ts) handles persistence.
 */
export async function extractVoiceProfile(
  args: ExtractVoiceProfileArgs,
): Promise<VoiceProfile> {
  const { bodyParagraphs, abortSignal } = args;
  if (!isSupportedModel(MODEL)) throw new UnknownModelError(MODEL);

  // Wave-1 review HIGH H-2: empty bodyParagraphs would produce a
  // hallucinated voice profile (LLM called with zero context); caller
  // would persist it to S3 and poison the cache for that pdf_sha256.
  // Surface loudly instead — this is a caller error, not a runtime case.
  if (bodyParagraphs.length === 0) {
    throw new Error(
      'extractVoiceProfile: bodyParagraphs is empty; cannot extract voice profile from zero context',
    );
  }

  const samples = sampleParagraphs(bodyParagraphs);
  const userPrompt = buildVoiceUserPrompt(samples);

  // Wrap in shared retry policy (mirrors narrative-only.ts).
  // VoiceProfileParseError is recognized as parse-retryable.
  return withRetry({
    operationName: 'voice-extract',
    abortSignal,
    isParseError: (err) => err instanceof VoiceProfileParseError,
    fn: async () => {
      const response = await openai.chat.completions.create(
        {
          model: MODEL,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: userPrompt },
          ],
          response_format: VOICE_PROFILE_RESPONSE_FORMAT,
          max_tokens: MAX_COMPLETION_TOKENS,
          temperature: 0,
        },
        { signal: abortSignal },
      );

      const raw = response.choices[0]?.message?.content ?? '';
      const promptTokens = response.usage?.prompt_tokens ?? 0;
      const completionTokens = response.usage?.completion_tokens ?? 0;

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        throw new VoiceProfileParseError(
          `JSON.parse failed: ${(err as Error).message}`,
          raw,
        );
      }

      if (!isVoiceLLMResponse(parsed)) {
        throw new VoiceProfileParseError(
          'response did not match VoiceProfile shape',
          raw,
        );
      }

      const costUsd = actualCost({
        model: MODEL,
        promptTokens,
        completionTokens,
      });

      const profile: VoiceProfile = {
        schema_version: 1,
        extracted_at: new Date().toISOString(),
        model: MODEL,
        extraction_cost_usd: costUsd,
        sample_size: samples.length,
        sampler_version: SAMPLER_VERSION,
        tone_summary: parsed.tone_summary,
        signature_moves: parsed.signature_moves,
        example_phrases: parsed.example_phrases,
        humor_patterns: parsed.humor_patterns,
        preferred_analogies: parsed.preferred_analogies,
      };
      return profile;
    },
  });
}

// ───────────────────────────────────────────────────────────────────────────
// Test-only escape hatch — lets unit tests assert prompt invariants without
// reimplementing the constants. Intentionally NOT a public API.
// ───────────────────────────────────────────────────────────────────────────

export const __TEST_ONLY = {
  MODEL,
  MAX_COMPLETION_TOKENS,
  SAMPLE_SIZE,
  SAMPLER_VERSION,
  SYSTEM_PROMPT,
  VOICE_PROFILE_RESPONSE_FORMAT,
  WEIGHT_CHAPTER_OPENING,
  WEIGHT_RHETORICAL_MARKER,
  WEIGHT_EPIGRAPH,
  CHAPTER_OPENING_PARAGRAPH_IDX_THRESHOLD,
  EPIGRAPH_MAX_WORDS,
  RHETORICAL_MARKER_REGEX,
};
