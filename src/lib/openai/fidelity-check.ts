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
import type { SourceParagraph } from '@/lib/types';

const MODEL = 'gpt-4o-mini';
const MAX_COMPLETION_TOKENS = 1200;

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

const RESPONSE_FORMAT = {
  type: 'json_schema' as const,
  json_schema: {
    name: 'fidelity_score',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      required: [
        'specific_numbers_preserved',
        'named_examples_preserved',
        'terminological_contrasts_preserved',
        'specific_numbers_missing',
        'named_examples_missing',
        'terminological_contrasts_missing',
        'overall_score',
        'notes',
      ],
      properties: {
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
      },
    },
  },
} as const;

export interface FidelityCheckArgs {
  chapterTitle: string;
  narrative: string;
  sourceParagraphs: SourceParagraph[];
  abortSignal?: AbortSignal;
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
  const { chapterTitle, narrative, sourceParagraphs, abortSignal } = args;

  // Compact source for the comparison call — include only the indexed text,
  // capped to keep token budget bounded.
  const sourceText = sourceParagraphs
    .map((p) => `[page${p.page}:paragraph${p.paragraphIdx}] ${p.text}`)
    .join('\n\n');
  // Hard cap at ~30K chars to stay under per-request TPM for 4o-mini.
  const capped = sourceText.length > 30000 ? sourceText.slice(0, 30000) + '\n…[truncated]' : sourceText;

  const userPrompt = [
    `SECTION TITLE: ${chapterTitle}`,
    '',
    'NARRATIVE (what the tutorial generated):',
    narrative,
    '',
    'SOURCE PARAGRAPHS (what it was based on):',
    capped,
    '',
    'Score the fidelity now.',
  ].join('\n');

  const response = await openai.chat.completions.create(
    {
      model: MODEL,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      response_format: RESPONSE_FORMAT,
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
  if (!isFidelityShape(parsed)) {
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
    promptTokens,
    completionTokens,
    costUsd,
    model: MODEL,
  };
}

function isFidelityShape(x: unknown): x is {
  specific_numbers_preserved: number;
  named_examples_preserved: number;
  terminological_contrasts_preserved: number;
  specific_numbers_missing: number;
  named_examples_missing: number;
  terminological_contrasts_missing: number;
  overall_score: number;
  notes: string[];
} {
  if (typeof x !== 'object' || x === null) return false;
  const o = x as Record<string, unknown>;
  return (
    typeof o.specific_numbers_preserved === 'number' &&
    typeof o.named_examples_preserved === 'number' &&
    typeof o.terminological_contrasts_preserved === 'number' &&
    typeof o.specific_numbers_missing === 'number' &&
    typeof o.named_examples_missing === 'number' &&
    typeof o.terminological_contrasts_missing === 'number' &&
    typeof o.overall_score === 'number' &&
    Array.isArray(o.notes)
  );
}
