// src/lib/openai/fidelity-check.ts — narrative-vs-source fidelity scorer.
//
// Closes DRIFT-test3-022. After narrative generation, this scorer runs a
// 4o-mini comparison call against the source paragraphs to count how many of
// the source's load-bearing concrete anchors (numbers, named examples,
// terminological contrasts) survived into the narrative.
//
// Cost: ~$0.0005 per chapter (one short 4o-mini call). Negligible vs.
// the $0.011 narrative + $0.001 quiz generation. Worth it for the quality
// signal — flagged narratives can be regenerated, and aggregate scores show
// whether prompt changes actually improved fidelity.
//
// Why split from per-chapter.ts:
//   - SRP: scoring is a separate change-reason from generation.
//   - Allows retrofitting scores onto already-generated chapters without
//     re-running the expensive 4o narrative call.

import { openai } from './client';
import { actualCost } from './cost';
import { withRetry } from './_retry';
import { containsAnchor, type AnchorWhitelistEntry } from './anchor-validator';
import type { SourceParagraph } from '@/lib/types';

const MODEL = 'gpt-4o-mini';
const MAX_COMPLETION_TOKENS = 1200;

// ─── Anchor-aware prompt addendum (Wave 3C / Feature B' Component 5) ───────
//
// When the scorer is invoked WITH a non-empty anchor whitelist AND there is
// at least one chunk-relevant anchor (i.e. a whitelist anchor that actually
// appears in this chunk's source paragraphs), we append a deterministic
// instruction block to the system prompt asking the LLM to count preserved
// vs missing whitelist anchors. The list of relevant anchors is injected
// into the USER prompt (because it is per-chunk data, not per-call policy).
//
// The two new response fields are required ONLY when this addendum is
// active — when no whitelist (or no chunk-relevant anchors) is in play, the
// scorer's prompt + response schema are byte-for-byte unchanged from the
// pre-Wave-3 path, and the result's whitelist counts are null.
const ANCHOR_AWARE_SYSTEM_SUFFIX = `

WHITELIST ANCHORS (Wave 3 / Feature B'):
You will also receive a section in the user message titled "WHITELIST ANCHORS PRESENT IN THIS CHUNK'S SOURCE" listing curated load-bearing terms that the editor pre-extracted from the SOURCE. These terms MUST appear verbatim in any faithful narrative.

For each whitelist anchor in that list, check whether it appears VERBATIM (case-insensitive, whole-token) in the NARRATIVE. Then emit two additional integer fields in your JSON response:
  - "whitelist_anchors_preserved": count of whitelist terms found in the narrative.
  - "whitelist_anchors_missing":   count of whitelist terms absent from the narrative.

These two counts must sum to the total number of whitelist anchors you were given.`;

const SYSTEM_PROMPT = `You score how faithfully a tutorial narrative preserves the load-bearing concrete anchors from its source text. The narrative was AI-generated FROM the source; your job is to detect compression-induced loss.

You are given two inputs:
  1. NARRATIVE — the generated tutorial markdown
  2. SOURCE — the original paragraphs the narrative was based on

Identify, in the SOURCE, each instance of:
  - SPECIFIC NUMBERS: concrete quantities (e.g., "10,000 disks", "70% of outages", "1 disk per day", "20 milliseconds").
  - NAMED EXAMPLES: incidents, products, papers, or memorable analogies (e.g., "the leap-second bug", "Knight Capital outage", "swallowed by a black hole", "Chaos Monkey", "Memcached + Elasticsearch").
  - TERMINOLOGICAL CONTRASTS: precise definitional contrasts between two terms (e.g., "fault is one component deviating; failure is system stops providing service", "scaling up vs scaling out", "synchronous vs asynchronous replication").

Then check each one against the NARRATIVE. Did it survive (verbatim or with equivalent precision)?

Score 0-100 = (preserved_count / total_count) * 100, weighted by category:
  - specific_numbers: 30% of score
  - named_examples: 30% of score
  - terminological_contrasts: 40% of score (most load-bearing)

If a category has zero source items, distribute its weight proportionally to the others.

EDGE CASE — NO ANCHORS IN SOURCE (DRIFT-test3-026):
If you identify ZERO items across ALL three categories combined (i.e., the source contains no concrete anchors, no named examples, AND no terminological contrasts — common for summary chapters, prefaces, introductions that only forward-reference later material), you MUST:
  - set overall_score to 100 (N/A — nothing to lose, so nothing was lost)
  - make the FIRST entry in "notes" exactly the string "NO_ANCHORS_IN_SOURCE" (uppercase, underscore-separated)
  - optionally include 1-2 follow-up notes describing the chapter's nature ("preface forwards to later chapters", etc.)
The downstream UI uses notes[0] === "NO_ANCHORS_IN_SOURCE" as the N/A sentinel; do NOT use any other phrasing for that first note.

Output strict JSON:
{
  "specific_numbers_preserved": <int>,
  "named_examples_preserved": <int>,
  "terminological_contrasts_preserved": <int>,
  "specific_numbers_missing": <int>,
  "named_examples_missing": <int>,
  "terminological_contrasts_missing": <int>,
  "overall_score": <int 0-100>,
  "notes": [<short string>, ...]  // 3-5 brief notes naming specific dropped items
}`;

const BASE_PROPERTIES = {
  specific_numbers_preserved: { type: 'integer', minimum: 0 },
  named_examples_preserved: { type: 'integer', minimum: 0 },
  terminological_contrasts_preserved: { type: 'integer', minimum: 0 },
  specific_numbers_missing: { type: 'integer', minimum: 0 },
  named_examples_missing: { type: 'integer', minimum: 0 },
  terminological_contrasts_missing: { type: 'integer', minimum: 0 },
  overall_score: { type: 'integer', minimum: 0, maximum: 100 },
  notes: {
    type: 'array',
    items: { type: 'string' },
    maxItems: 8,
  },
} as const;

const BASE_REQUIRED = [
  'specific_numbers_preserved',
  'named_examples_preserved',
  'terminological_contrasts_preserved',
  'specific_numbers_missing',
  'named_examples_missing',
  'terminological_contrasts_missing',
  'overall_score',
  'notes',
] as const;

const RESPONSE_FORMAT = {
  type: 'json_schema' as const,
  json_schema: {
    name: 'fidelity_score',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      required: [...BASE_REQUIRED],
      properties: { ...BASE_PROPERTIES },
    },
  },
} as const;

/**
 * Anchor-aware variant of the response schema (Wave 3C). Adds the two
 * whitelist-anchor count fields to `required` and `properties`. Used only
 * when scoreFidelity() is called with a non-empty, chunk-relevant
 * anchorWhitelist; otherwise the base schema is used so the pre-Feature-B'
 * code path is byte-for-byte preserved.
 */
const RESPONSE_FORMAT_WITH_ANCHORS = {
  type: 'json_schema' as const,
  json_schema: {
    name: 'fidelity_score_with_anchors',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      required: [
        ...BASE_REQUIRED,
        'whitelist_anchors_preserved',
        'whitelist_anchors_missing',
      ],
      properties: {
        ...BASE_PROPERTIES,
        whitelist_anchors_preserved: { type: 'integer', minimum: 0 },
        whitelist_anchors_missing: { type: 'integer', minimum: 0 },
      },
    },
  },
} as const;

export interface FidelityCheckArgs {
  chapterTitle: string;
  narrative: string;
  sourceParagraphs: SourceParagraph[];
  abortSignal?: AbortSignal;
  /** NEW (Wave 3C / Feature B' Component 5): optional anchor whitelist.
   *  When provided AND non-empty AND at least one whitelist anchor actually
   *  appears in `sourceParagraphs`, the scorer becomes anchor-aware: it
   *  injects the chunk-relevant whitelist slice into the prompt and asks
   *  the LLM to deterministically count preserved vs missing anchors
   *  (rather than re-discovering anchors per call).
   *
   *  When omitted, empty, or no whitelist anchor appears in the source,
   *  the scorer's prompt + response schema are byte-for-byte unchanged
   *  from the pre-Wave-3 path, and the two new result fields are null. */
  anchorWhitelist?: AnchorWhitelistEntry[];
}

export interface FidelityCheckResult {
  specificNumbersPreserved: number;
  namedExamplesPreserved: number;
  terminologicalContrastsPreserved: number;
  specificNumbersMissing: number;
  namedExamplesMissing: number;
  terminologicalContrastsMissing: number;
  overallScore: number;     // 0-100
  notes: string[];
  /** NEW (Wave 3C): count of whitelist anchors PRESERVED in the narrative.
   *  Null when no anchorWhitelist was supplied, the whitelist was empty,
   *  or no whitelist anchor was present in this chunk's source. */
  whitelistAnchorsPreserved: number | null;
  /** NEW (Wave 3C): count of whitelist anchors MISSING from the narrative.
   *  Null under the same conditions as whitelistAnchorsPreserved. */
  whitelistAnchorsMissing: number | null;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  model: string;
}

export class FidelityCheckError extends Error {
  constructor(message: string, public readonly rawText: string) {
    super(message);
    this.name = 'FidelityCheckError';
  }
}

/**
 * Run fidelity scoring. Fails closed — if the scorer call errors, we throw;
 * the caller (per-chapter.ts) decides whether to mark the chapter complete
 * without a score, or block. v1 policy: mark complete anyway; absent score
 * is treated as "unknown fidelity" rather than blocking the read path.
 */
export async function scoreFidelity(args: FidelityCheckArgs): Promise<FidelityCheckResult> {
  const { chapterTitle, narrative, sourceParagraphs, abortSignal, anchorWhitelist } = args;

  // ─── Wave 3C: chunk-relevant anchor filter ─────────────────────────────
  // Of the supplied whitelist (if any), keep only anchors that actually
  // appear in THIS chunk's source paragraphs. The LLM can only fairly be
  // asked to preserve anchors the source actually contained. An empty
  // whitelist OR no source-side hits collapses to the pre-Wave-3 path
  // (prompt + schema byte-for-byte preserved, result fields null).
  const chunkRelevantAnchors: AnchorWhitelistEntry[] =
    anchorWhitelist && anchorWhitelist.length > 0
      ? anchorWhitelist.filter((anchor) =>
          sourceParagraphs.some((p) => containsAnchor(p.text, anchor.term)),
        )
      : [];
  const isAnchorAware = chunkRelevantAnchors.length > 0;

  // Compact source for the comparison call — include only the indexed text,
  // capped to keep token budget bounded.
  const sourceText = sourceParagraphs
    .map((p) => `[page${p.page}:paragraph${p.paragraphIdx}] ${p.text}`)
    .join('\n\n');
  // Hard cap at ~30K chars to stay under per-request TPM for 4o-mini.
  const capped = sourceText.length > 30000 ? sourceText.slice(0, 30000) + '\n…[truncated]' : sourceText;

  // Build the user prompt. When anchor-aware, insert the chunk-relevant
  // whitelist section between SOURCE and the final instruction; when NOT,
  // the prompt is byte-for-byte identical to the pre-Wave-3 version.
  const userPromptSections: string[] = [
    `SECTION TITLE: ${chapterTitle}`,
    '',
    'NARRATIVE (what the tutorial generated):',
    narrative,
    '',
    'SOURCE PARAGRAPHS (what it was based on):',
    capped,
    '',
  ];

  if (isAnchorAware) {
    const anchorList = chunkRelevantAnchors
      .map((a) => `  - "${a.term}" (${a.category})`)
      .join('\n');
    userPromptSections.push(
      "WHITELIST ANCHORS PRESENT IN THIS CHUNK'S SOURCE (these MUST appear verbatim in a faithful narrative):",
      anchorList,
      '',
      'For each whitelist anchor above, check if it appears VERBATIM in the NARRATIVE. Count preserved and missing. The two counts MUST sum to the total number of whitelist anchors listed above.',
      '',
    );
  }

  userPromptSections.push('Score the fidelity now.');
  const userPrompt = userPromptSections.join('\n');

  // System prompt + response schema swap depending on anchor-aware mode.
  // Pre-Wave-3 path (no whitelist or no chunk-relevant anchors) sees both
  // unchanged byte-for-byte.
  const systemPrompt = isAnchorAware ? SYSTEM_PROMPT + ANCHOR_AWARE_SYSTEM_SUFFIX : SYSTEM_PROMPT;
  const responseFormat = isAnchorAware ? RESPONSE_FORMAT_WITH_ANCHORS : RESPONSE_FORMAT;

  // DRIFT-test3-032: wrap in shared retry. Caller (per-chapter.ts) keeps
  // fail-open semantics — if all retries exhaust, the FidelityCheckError
  // propagates and per-chapter.ts swallows it (score=null is logged as
  // 'unknown' rather than blocking the read path). The retry just gives
  // transient 429s a chance to succeed before falling back to fail-open.
  return withRetry({
    operationName: 'fidelity-check',
    abortSignal,
    isParseError: (err) => err instanceof FidelityCheckError,
    fn: async () => {
      const response = await openai.chat.completions.create(
        {
          model: MODEL,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          response_format: responseFormat,
          max_tokens: MAX_COMPLETION_TOKENS,
          temperature: 0,
        },
        { signal: abortSignal },
      );

      const text = response.choices[0]?.message?.content ?? '';
      const promptTokens = response.usage?.prompt_tokens ?? 0;
      const completionTokens = response.usage?.completion_tokens ?? 0;

      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch (err) {
        throw new FidelityCheckError(`JSON.parse failed: ${(err as Error).message}`, text);
      }
      if (!isFidelityShape(parsed, isAnchorAware)) {
        throw new FidelityCheckError('response did not match fidelity schema', text);
      }

      const costUsd = actualCost({ model: MODEL, promptTokens, completionTokens });
      return {
        specificNumbersPreserved: parsed.specific_numbers_preserved,
        namedExamplesPreserved: parsed.named_examples_preserved,
        terminologicalContrastsPreserved: parsed.terminological_contrasts_preserved,
        specificNumbersMissing: parsed.specific_numbers_missing,
        namedExamplesMissing: parsed.named_examples_missing,
        terminologicalContrastsMissing: parsed.terminological_contrasts_missing,
        overallScore: parsed.overall_score,
        notes: parsed.notes,
        whitelistAnchorsPreserved: isAnchorAware
          ? (parsed.whitelist_anchors_preserved ?? null)
          : null,
        whitelistAnchorsMissing: isAnchorAware
          ? (parsed.whitelist_anchors_missing ?? null)
          : null,
        promptTokens,
        completionTokens,
        costUsd,
        model: MODEL,
      };
    },
  });
}

interface FidelityParsedShape {
  specific_numbers_preserved: number;
  named_examples_preserved: number;
  terminological_contrasts_preserved: number;
  specific_numbers_missing: number;
  named_examples_missing: number;
  terminological_contrasts_missing: number;
  overall_score: number;
  notes: string[];
  whitelist_anchors_preserved?: number;
  whitelist_anchors_missing?: number;
}

function isFidelityShape(x: unknown, requireWhitelistFields: boolean): x is FidelityParsedShape {
  if (typeof x !== 'object' || x === null) return false;
  const o = x as Record<string, unknown>;
  const baseOk =
    typeof o.specific_numbers_preserved === 'number' &&
    typeof o.named_examples_preserved === 'number' &&
    typeof o.terminological_contrasts_preserved === 'number' &&
    typeof o.specific_numbers_missing === 'number' &&
    typeof o.named_examples_missing === 'number' &&
    typeof o.terminological_contrasts_missing === 'number' &&
    typeof o.overall_score === 'number' &&
    Array.isArray(o.notes);
  if (!baseOk) return false;
  if (requireWhitelistFields) {
    return (
      typeof o.whitelist_anchors_preserved === 'number' &&
      typeof o.whitelist_anchors_missing === 'number'
    );
  }
  return true;
}
