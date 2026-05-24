// src/lib/ingest/voice-extract.ts — author-voice stylometric extractor.
//
// Feature B' (Voice + Anchor profile, Wave 1). Reads a uniform sample of body
// paragraphs from a PDF and produces a `VoiceProfile` — a compact stylometric
// fingerprint (tone summary, signature moves, example phrases, humor patterns,
// preferred analogies) that downstream tutorial generation can inject as a
// "preservation guide" so the generated chapters keep the author's distinctive
// rhetorical voice instead of regressing to generic technical prose.
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
const SAMPLER_VERSION = 'uniform-body-v1' as const;

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
  sampler_version: 'uniform-body-v1';
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
// Sampling — pure helper, exported for unit-test visibility
// ───────────────────────────────────────────────────────────────────────────

/**
 * Pick up to `SAMPLE_SIZE` paragraphs evenly spaced across `paragraphs`.
 *
 * Behavior:
 *   - If `paragraphs.length <= SAMPLE_SIZE`: return the whole list (preserve
 *     order, no duplication, no padding).
 *   - Otherwise: stride = floor(length / SAMPLE_SIZE). Pick indices
 *     0, stride, 2*stride, ... until SAMPLE_SIZE collected.
 *
 * Returned paragraphs preserve their original `page` + `paragraphIdx` so the
 * downstream prompt can attach a `pageN:paragraphM` ref to each sample.
 */
export function sampleParagraphs(paragraphs: SourceParagraph[]): SourceParagraph[] {
  if (paragraphs.length === 0) return [];
  if (paragraphs.length <= SAMPLE_SIZE) return [...paragraphs];

  const stride = Math.floor(paragraphs.length / SAMPLE_SIZE);
  // Guard: with paragraphs.length > SAMPLE_SIZE, stride >= 1 by definition;
  // belt-and-suspenders for any future change that loosens the threshold.
  const effectiveStride = stride < 1 ? 1 : stride;

  const out: SourceParagraph[] = [];
  for (let i = 0; out.length < SAMPLE_SIZE && i < paragraphs.length; i += effectiveStride) {
    const p = paragraphs[i];
    if (p !== undefined) out.push(p);
  }
  return out;
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
 * Extract an author-voice fingerprint from a uniform sample of body
 * paragraphs.
 *
 * - Samples paragraphs deterministically (uniform stride; see sampleParagraphs).
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
};
