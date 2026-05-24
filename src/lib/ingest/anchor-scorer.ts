// src/lib/ingest/anchor-scorer.ts — LLM anchor categorizer + top-30 selector.
//
// Feature B' (Voice + Anchor profile, Wave 2). Consumes the deterministic
// candidate list produced by `src/lib/ingest/anchor-prefilter.ts` and uses
// gpt-4o-mini to:
//   1. categorize each candidate into one of the 6 final anchor categories
//      (search-term / named-system / named-paper / named-incident /
//       signature-analogy / contrast-pair), and
//   2. filter the list down to the top-30 by frequency + category-priority,
//      respecting a glossary-priority boost (D8 in the design doc).
//
// Output is a final `AnchorWhitelistEntry[]` — the exact shape consumed by
// Wave 1D's `src/lib/openai/anchor-validator.ts`. The caller (worker.ts,
// Wave 3) is responsible for S3 persistence; THIS module is pure compute +
// one bounded LLM call.
//
// Why a separate module (not folded into anchor-prefilter):
//   - SINGLE CHANGE-PRESSURE: deterministic pre-filtering and stochastic LLM
//     categorization have different testability + cost profiles. Pre-filter
//     is pure + free; scorer is async + costs money. Mixing them entangles
//     the change cadences (a regex tweak shouldn't bust an LLM contract test).
//   - CARDINALITY: pre-filter runs over the whole PDF once. Scorer runs once
//     per PDF too, but its retry/cost-accounting story is distinct (matches
//     voice-extract.ts).
//   - COST ISOLATION: the scorer is the only place we cap whitelist size at
//     30, which is the load-bearing knob for downstream anchor-validator
//     budget. Keeping it in one module makes the cap auditable.
//
// Design anchors:
//   - docs/design/feature-b-voice-and-anchor-profile.md §D3 (top-30 cap)
//     and §D8 (glossary priority boost).
//   - kb:architecture/crosscut/single-responsibility — one prompt, one
//     schema, one cost row, one cache key (same pattern as voice-extract).
//   - kb:architecture/ai-systems/inference-cost-management §"Lever 5: Output
//     control" — strict-mode JSON schema removes the "is the output valid?"
//     branch from the parsing path.
//   - kb:architecture/discipline/stability-patterns §Fail-Fast — JSON parse
//     errors throw `AnchorScorerParseError` (caller — via withRetry — gets
//     one parse-retry, then surfaces).

import { openai } from '@/lib/openai/client';
import { actualCost, isSupportedModel, UnknownModelError } from '@/lib/openai/cost';
import { withRetry } from '@/lib/openai/_retry';
import type { AnchorCandidate } from './anchor-prefilter';
import type { AnchorWhitelistEntry } from '@/lib/openai/anchor-validator';

// ───────────────────────────────────────────────────────────────────────────
// Constants
// ───────────────────────────────────────────────────────────────────────────

const MODEL = 'gpt-4o-mini';
const MAX_COMPLETION_TOKENS = 2500;
const TOP_N_CAP = 30;

/**
 * Final anchor categories the LLM is allowed to return. Order is significant:
 * lower index = higher priority for tie-break when two candidates share the
 * same frequency in the top-N selection step.
 *
 *   contrast-pair > named-paper > named-system > named-incident >
 *     search-term > signature-analogy
 *
 * Rationale: contrast-pairs are the rarest, most-author-distinctive anchors
 * (a precise terminology pair the author distinguishes — losing it destroys
 * the author's argument). Named papers/systems/incidents are concrete and
 * load-bearing for verifiability. Search-terms and signature-analogies are
 * more diffuse and survive paraphrase better, so they yield to the rarer
 * categories on ties.
 */
const CATEGORY_PRIORITY: Record<AnchorWhitelistEntry['category'], number> = {
  'contrast-pair': 0,
  'named-paper': 1,
  'named-system': 2,
  'named-incident': 3,
  'search-term': 4,
  'signature-analogy': 5,
};

const VALID_CATEGORIES = new Set<AnchorWhitelistEntry['category']>([
  'search-term',
  'named-system',
  'named-paper',
  'named-incident',
  'signature-analogy',
  'contrast-pair',
]);

// Verbatim system prompt (per contract). Keep as a module constant so a
// single edit propagates; test asserts the prompt is passed unmodified.
const SYSTEM_PROMPT = `You are filtering a candidate list of TECHNICAL ANCHOR TERMS extracted from a non-fiction technical book. The downstream tutorial-generation prompt will be instructed to preserve every term on this whitelist VERBATIM when it appears in source paragraphs. Your job: filter the candidates to keep ONLY terms that:

  - Are search-term-anchors: a curious reader can web-search them and find further literature (e.g., "head-of-line blocking", "t-digest")
  - Are named systems / papers / people / incidents (e.g., "Chaos Monkey", "Out of the Tar Pit", "Knight Capital outage")
  - Are signature analogies the author uses across multiple sections ("swallowed by a black hole", "big ball of mud")
  - Are precise terminology pairs the author distinguishes ("fault vs failure", "latency vs response time")

REJECT candidates that:
  - Are generic English nouns capitalized only because they start a sentence
  - Are chapter / section names (the outline already covers those)
  - Are person names mentioned once incidentally
  - Are place names without technical relevance

Output strict JSON: {
  "anchors": [
    {
      "term": str (verbatim, exactly as in source),
      "category": "search-term" | "named-system" | "named-paper" | "named-incident" | "signature-analogy" | "contrast-pair",
      "keep": true
    },
    ...
  ]
}

The "term" field MUST exactly match a candidate term provided in the user message. Terms you reject simply don't appear in the output array.`;

// ───────────────────────────────────────────────────────────────────────────
// Strict-mode JSON schema for response_format
//
// OpenAI's structured-output strict mode requires:
//   - additionalProperties: false on every object
//   - every property listed in `required` (no optional fields)
// We include `keep` (always true) because the prompt asks for it; the field
// is informational — rejection is signaled by omission from the array, not
// by `keep: false`.
// ───────────────────────────────────────────────────────────────────────────

const ANCHOR_SCORER_RESPONSE_FORMAT = {
  type: 'json_schema' as const,
  json_schema: {
    name: 'anchor_scorer_response',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['anchors'],
      properties: {
        anchors: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['term', 'category', 'keep'],
            properties: {
              term: { type: 'string' },
              category: {
                type: 'string',
                enum: [
                  'search-term',
                  'named-system',
                  'named-paper',
                  'named-incident',
                  'signature-analogy',
                  'contrast-pair',
                ],
              },
              keep: { type: 'boolean' },
            },
          },
        },
      },
    },
  },
} as const;

// ───────────────────────────────────────────────────────────────────────────
// Public types
// ───────────────────────────────────────────────────────────────────────────

export interface ScoreAnchorCandidatesArgs {
  pdfSha256: string;
  /** Output of `extractAnchorCandidates()` — uncapped, sorted by freq desc. */
  candidates: AnchorCandidate[];
  abortSignal?: AbortSignal;
}

export interface ScoreAnchorCandidatesResult {
  /** Top-30, categorized — the shape Wave 1D's anchor-validator consumes. */
  whitelist: AnchorWhitelistEntry[];
  /** Input candidate count (for telemetry / cost analysis). */
  candidateCount: number;
  /** == whitelist.length (could be < 30 if LLM rejected most candidates). */
  acceptedCount: number;
  extractionCostUsd: number;
  model: string;
  promptTokens: number;
  completionTokens: number;
}

/**
 * Caller-friendly parse error. Recognized by withRetry's `isParseError`
 * predicate as parse-retryable (one retry, no backoff — matches the
 * VoiceProfileParseError pattern).
 */
export class AnchorScorerParseError extends Error {
  constructor(message: string, public readonly rawText: string) {
    super(message);
    this.name = 'AnchorScorerParseError';
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Prompt builder — pure, exported for test assertion convenience
// ───────────────────────────────────────────────────────────────────────────

/**
 * Render the candidate list as a numbered text block. Each line includes the
 * verbatim term, the surfacing heuristic, the deterministic frequency, the
 * first-seen ref, and the glossary flag (so the LLM can — but isn't required
 * to — give canonical glossary terms a leg up; we also enforce a hard
 * post-LLM glossary-priority boost).
 */
export function buildScorerUserPrompt(candidates: AnchorCandidate[]): string {
  const lines = candidates
    .map((c, i) => {
      const idx = i + 1;
      const glossary = c.glossary_priority ? 'true' : 'false';
      return `[${idx}] term: "${c.term}", source: ${c.source}, frequency: ${c.frequency}, first_seen: ${c.first_seen_at}, glossary: ${glossary}`;
    })
    .join('\n');
  return `Candidates (filter to keep load-bearing technical anchors only):

${lines}

Output the filtered whitelist as strict JSON now.`;
}

// ───────────────────────────────────────────────────────────────────────────
// Type-guard for the LLM response object
// ───────────────────────────────────────────────────────────────────────────

interface LLMAnchor {
  term: string;
  category: string;
  keep: boolean;
}

interface LLMResponse {
  anchors: LLMAnchor[];
}

function isLLMResponse(x: unknown): x is LLMResponse {
  if (typeof x !== 'object' || x === null) return false;
  const o = x as Record<string, unknown>;
  if (!Array.isArray(o.anchors)) return false;
  for (const a of o.anchors) {
    if (typeof a !== 'object' || a === null) return false;
    const aa = a as Record<string, unknown>;
    if (typeof aa.term !== 'string') return false;
    if (typeof aa.category !== 'string') return false;
    if (typeof aa.keep !== 'boolean') return false;
  }
  return true;
}

// ───────────────────────────────────────────────────────────────────────────
// Selection helpers — pure, exported for unit-test visibility
// ───────────────────────────────────────────────────────────────────────────

/**
 * Stable sort key: higher frequency first; on ties, lower category-priority
 * rank first (contrast-pair before search-term, etc.); final tie-break by
 * lowercase term for full determinism.
 */
export function compareForTopN(
  a: AnchorWhitelistEntry,
  b: AnchorWhitelistEntry,
): number {
  if (a.frequency_in_source !== b.frequency_in_source) {
    return b.frequency_in_source - a.frequency_in_source;
  }
  const pa = CATEGORY_PRIORITY[a.category];
  const pb = CATEGORY_PRIORITY[b.category];
  if (pa !== pb) return pa - pb;
  return a.term.toLowerCase().localeCompare(b.term.toLowerCase());
}

/**
 * Cap to TOP_N_CAP after applying the glossary-priority boost.
 *
 * Algorithm (per design doc §D8):
 *   1. Sort all accepted entries by (frequency desc, category priority,
 *      term alpha).
 *   2. Take the top-N as the "natural" cut.
 *   3. For each glossary-priority candidate that was rejected by the natural
 *      cut: if its frequency >= the 30th-place threshold (i.e., the freq of
 *      the last entry currently in the cut), promote it. Concretely: each
 *      qualifying glossary candidate displaces the LOWEST-priority non-
 *      glossary entry in the current cut whose frequency is <= the glossary
 *      candidate's frequency.
 *
 * The simple invariant: glossary-sourced candidates auto-survive into the
 * top-30 whenever any non-glossary candidate with equal-or-lower frequency
 * would otherwise displace them.
 */
export function selectTopNWithGlossaryBoost(
  entries: ReadonlyArray<AnchorWhitelistEntry & { isGlossary: boolean }>,
): AnchorWhitelistEntry[] {
  // Sort whole list once.
  const sorted = [...entries].sort(compareForTopN);

  // Fast path: fewer than the cap → return all entries (strip flag).
  if (sorted.length <= TOP_N_CAP) {
    return sorted.map(stripGlossaryFlag);
  }

  // Natural cut + tail (rejected by the natural cut).
  const cut = sorted.slice(0, TOP_N_CAP);
  const tail = sorted.slice(TOP_N_CAP);

  // Glossary entries in the tail that should be boosted.
  const glossaryInTail = tail.filter((e) => e.isGlossary);
  if (glossaryInTail.length === 0) {
    return cut.map(stripGlossaryFlag);
  }

  // Mutable working copy of the cut.
  const working = [...cut];

  for (const g of glossaryInTail) {
    // Find the lowest-ranked NON-glossary entry in the working cut. "Lowest-
    // ranked" means the last one in the current sorted order (already sorted
    // by compareForTopN, but we re-derive each iteration to honor any prior
    // displacement).
    //
    // Per the design §D8 simple-version rule: glossary-sourced candidates
    // auto-survive into the top-30 if any non-glossary candidate would
    // otherwise displace them. Concretely: since the glossary candidate was
    // pushed into the tail by a non-glossary candidate in the cut, that
    // non-glossary is by definition "displacing" the glossary entry — so
    // the glossary wins regardless of relative frequency (canonical author
    // intent overrides the deterministic freq sort).
    let displaceIdx = -1;
    for (let i = working.length - 1; i >= 0; i--) {
      const e = working[i];
      if (!e) continue;
      if (e.isGlossary) continue;
      displaceIdx = i;
      break;
    }
    if (displaceIdx < 0) {
      // The cut is already all-glossary. Nothing to displace — drop this
      // tail-glossary on the floor (the cap is the cap).
      continue;
    }
    // Replace + re-sort to maintain invariant for next iteration.
    working[displaceIdx] = g;
    working.sort(compareForTopN);
  }

  return working.map(stripGlossaryFlag);
}

function stripGlossaryFlag(
  e: AnchorWhitelistEntry & { isGlossary: boolean },
): AnchorWhitelistEntry {
  return {
    term: e.term,
    category: e.category,
    frequency_in_source: e.frequency_in_source,
    first_seen_at: e.first_seen_at,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Public entry point
// ───────────────────────────────────────────────────────────────────────────

/**
 * Score + categorize + cap an anchor-candidate list.
 *
 *  - Empty candidates → returns early with empty whitelist, no LLM call.
 *  - Otherwise: calls gpt-4o-mini with strict-mode JSON, drops LLM
 *    hallucinations + invalid categories, applies glossary-priority boost,
 *    caps to top-30 by (frequency desc, category priority, term alpha).
 *  - Wraps in withRetry (operationName 'anchor-scorer').
 *
 * Does NOT write to S3. The caller (worker.ts) handles persistence.
 */
export async function scoreAnchorCandidates(
  args: ScoreAnchorCandidatesArgs,
): Promise<ScoreAnchorCandidatesResult> {
  const { candidates, abortSignal } = args;

  if (!isSupportedModel(MODEL)) throw new UnknownModelError(MODEL);

  // Early return: nothing to score. No LLM call, zero cost.
  if (candidates.length === 0) {
    return {
      whitelist: [],
      candidateCount: 0,
      acceptedCount: 0,
      extractionCostUsd: 0,
      model: MODEL,
      promptTokens: 0,
      completionTokens: 0,
    };
  }

  // Lookup table for hallucination guard: lowercase term → original candidate.
  // Lowercase because the LLM may echo casing inconsistently; the candidate
  // term carries the authoritative verbatim casing.
  const byLowerTerm = new Map<string, AnchorCandidate>();
  for (const c of candidates) {
    byLowerTerm.set(c.term.toLowerCase(), c);
  }

  const userPrompt = buildScorerUserPrompt(candidates);

  return withRetry({
    operationName: 'anchor-scorer',
    abortSignal,
    isParseError: (err) => err instanceof AnchorScorerParseError,
    fn: async () => {
      const response = await openai.chat.completions.create(
        {
          model: MODEL,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: userPrompt },
          ],
          response_format: ANCHOR_SCORER_RESPONSE_FORMAT,
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
        throw new AnchorScorerParseError(
          `JSON.parse failed: ${(err as Error).message}`,
          raw,
        );
      }

      if (!isLLMResponse(parsed)) {
        throw new AnchorScorerParseError(
          'response did not match {anchors: [...]} shape',
          raw,
        );
      }

      // Build accepted entries with defensive guards:
      //   - Drop hallucinated terms (not in input candidates).
      //   - Drop invalid categories.
      //   - De-dup on lowercase term (LLM may echo the same term twice).
      const acceptedKeys = new Set<string>();
      const accepted: Array<AnchorWhitelistEntry & { isGlossary: boolean }> = [];
      for (const a of parsed.anchors) {
        const key = a.term.toLowerCase();
        const candidate = byLowerTerm.get(key);
        if (!candidate) continue; // hallucinated
        if (!VALID_CATEGORIES.has(a.category as AnchorWhitelistEntry['category'])) {
          continue;
        }
        if (acceptedKeys.has(key)) continue; // de-dup
        acceptedKeys.add(key);
        accepted.push({
          term: candidate.term, // verbatim from candidate, not LLM echo
          category: a.category as AnchorWhitelistEntry['category'],
          frequency_in_source: candidate.frequency,
          first_seen_at: candidate.first_seen_at,
          isGlossary: candidate.glossary_priority === true,
        });
      }

      // Glossary-priority boost (§D8): glossary candidates that were
      // REJECTED by the LLM (not in `accepted`) but have non-zero frequency
      // should still get a shot at the top-30. We assign them the
      // 'search-term' fallback category — they're canonical author intent
      // and the LLM rejecting them is often a false-negative (e.g., the
      // glossary defines an acronym the LLM didn't recognize as load-bearing).
      //
      // This is the "auto-survive" branch of the spec: glossary-sourced
      // candidates ride into the top-30 even when the LLM said no.
      for (const c of candidates) {
        if (c.glossary_priority !== true) continue;
        const key = c.term.toLowerCase();
        if (acceptedKeys.has(key)) continue;
        acceptedKeys.add(key);
        accepted.push({
          term: c.term,
          category: 'search-term',
          frequency_in_source: c.frequency,
          first_seen_at: c.first_seen_at,
          isGlossary: true,
        });
      }

      // Cap to top-30 with glossary-priority boost.
      const whitelist = selectTopNWithGlossaryBoost(accepted);

      const costUsd = actualCost({
        model: MODEL,
        promptTokens,
        completionTokens,
      });

      return {
        whitelist,
        candidateCount: candidates.length,
        acceptedCount: whitelist.length,
        extractionCostUsd: costUsd,
        model: MODEL,
        promptTokens,
        completionTokens,
      };
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
  TOP_N_CAP,
  SYSTEM_PROMPT,
  ANCHOR_SCORER_RESPONSE_FORMAT,
  CATEGORY_PRIORITY,
};
