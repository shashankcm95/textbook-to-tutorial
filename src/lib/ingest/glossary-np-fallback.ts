// src/lib/ingest/glossary-np-fallback.ts — Sprint J frequent-NP glossary bootstrap.
//
// Half-the-other-half of the Sprint J completion. Books like DDIA carry a
// labeled "Glossary" outline section the chunker hands to
// `extractGlossaryFromSections` — but the majority of technical books (CTCI,
// most O'Reilly titles) ship without any labeled glossary AT ALL. Those
// tutorials reach the per-chapter generator with zero canonical definitions,
// and the narrative prompt has no `glossary` argument to inject.
//
// This module provides the FALLBACK: when the chunker detects no glossary
// sections, the worker calls `runGlossaryNPBootstrap` over the body
// paragraphs, which:
//
//   1. Tokenizes + extracts multi-word capitalized phrases (heuristic-only,
//      free; mirrors the anchor-prefilter style with looser thresholds).
//   2. Frequency-ranks the candidates + filters stopwords.
//   3. Sends the top-K candidates plus short source-context excerpts to
//      gpt-4o-mini, which filters genuine technical terms and assigns a
//      one-sentence definition each.
//   4. Returns a `GlossaryArtifact` (same schema as the labeled-section
//      path) so the caller can persist with the existing `writeGlossary`.
//
// Why ONLY a frequent-NP heuristic (no per-paragraph LLM call):
//   - The labeled-section path already costs ~$0.001 per book at 4o-mini.
//     A per-paragraph fallback would scale linearly with book size and blow
//     past $0.10/book on a 600-page CS textbook.
//   - The heuristic-then-LLM-filter pattern caps the LLM cost at ~$0.05/book
//     regardless of book length — 1-2K input tokens of context, ~500-1K
//     output tokens of filtered terms. Bounded.
//
// Fail-open semantics: identical to `extractGlossaryFromSections`. Empty
// body paragraphs → empty terms. LLM error / parse error → empty terms +
// log warning. The caller decides whether to call `writeGlossary` based
// on the `terms.length > 0` check.
//
// Design anchors:
//   - kb:architecture/crosscut/single-responsibility — this module owns the
//     "no labeled glossary; manufacture one from body NPs" change-pressure.
//     The labeled path (glossary-extract.ts) and the orchestration
//     (worker.ts) each own their own.
//   - kb:architecture/ai-systems/inference-cost-management §Lever 1 — pick
//     the cheapest model (gpt-4o-mini) for shallow classification work.
//   - kb:architecture/discipline/stability-patterns §Bulkhead — bounded
//     async with explicit fail-open at the caller boundary; an LLM hiccup
//     during ingest cannot fail the whole ingest path.
//
// What this is NOT: it is NOT an anchor scorer (anchor-prefilter +
// anchor-scorer already do that and feed a separate side-asset). The
// glossary is `{term, definition}` pairs for narrative prompt injection;
// the anchor whitelist is `{term, category}` entries for verbatim
// preservation. Different teaching primitives; different consumers.

import { openai } from '@/lib/openai/client';
import { withRetry } from '@/lib/openai/_retry';
import type { SourceParagraph } from '@/lib/types';
import { formatRef } from '@/lib/pdf/paragraph-anchors';
import type { GlossaryArtifact } from '@/lib/s3-chunks';

const NP_FALLBACK_MODEL = 'gpt-4o-mini';

// ---------------------------------------------------------------------------
// Heuristic configuration
// ---------------------------------------------------------------------------

/**
 * Multi-word capitalized phrase detector — 2-5 capitalized words joined by
 * spaces or hyphens, optionally bridged by lowercase connector words ("of",
 * "the", "and", "for", "in", "on", "to"). Mirrors `anchor-prefilter.ts`'s
 * `CAPITALIZED_MULTIWORD_RE` so the linguistic class of matches is the same
 * — divergence between the two surfaces would create cross-cutting drift.
 *
 * Examples that match: "Hash Table", "Binary Search Tree", "Out-of-the-Box",
 * "Bloom Filter", "Test-Driven Development".
 */
const CAPITALIZED_MULTIWORD_RE =
  /\b[A-Z][a-z]+(?:[\s-](?:[A-Z][a-z]+|of|the|and|for|in|on|to)){0,4}[\s-][A-Z][a-z]+\b/g;

/**
 * Sentence-start stopwords. Pure title-case English connectors that would
 * dominate the frequency table if not filtered. Identical philosophy to
 * `anchor-prefilter.ts`'s `COMMON_SENTENCE_START_STOPLIST` — kept local
 * because the cardinality-vs-cost tradeoff is slightly different for the
 * NP-fallback (we want a stricter filter; the LLM filter step will reject
 * stragglers, but cheaper to keep them out of the prompt).
 */
const NP_STOPWORDS = new Set<string>([
  'The', 'A', 'An', 'I', 'We', 'You', 'It', 'He', 'She', 'They',
  'This', 'That', 'These', 'Those',
  'What', 'When', 'Where', 'Why', 'How', 'Who', 'Which',
  'But', 'And', 'Or', 'So', 'Yet', 'Nor',
  'In', 'At', 'With', 'For', 'If', 'As', 'By', 'From', 'On', 'To', 'Of',
  'Is', 'Was', 'Are', 'Were', 'Be', 'Been', 'Being',
  'Has', 'Have', 'Had', 'Do', 'Does', 'Did',
]);

/**
 * Default options. Exposed via `runGlossaryNPBootstrap`'s `options` arg for
 * tests + future tuning. Defaults sized for a typical textbook chapter
 * sample (~300-1500 body paragraphs).
 */
export interface GlossaryNPBootstrapOptions {
  /** Min frequency for an NP to qualify as a candidate. Default 3. */
  minFrequency?: number;
  /** Max candidates passed to the LLM filter. Default 60. */
  topK?: number;
  /** Max body paragraphs sampled for source context. Default 30. */
  contextSampleSize?: number;
  /** AbortSignal forwarded to the LLM call. */
  abortSignal?: AbortSignal;
}

const DEFAULTS = {
  minFrequency: 3,
  topK: 60,
  contextSampleSize: 30,
} as const;

// ---------------------------------------------------------------------------
// Step 1 — pure NP extraction + frequency ranking
// ---------------------------------------------------------------------------

/**
 * A frequency-ranked NP candidate, sorted descending by `count`.
 *
 * `firstParagraphRef` is included as a debug aid + to give the LLM step a
 * "where to look" pointer — but the LLM step does not require it for
 * correctness (it can ignore the ref).
 */
export interface NPCandidate {
  term: string;
  count: number;
  firstParagraphRef: string;
}

/**
 * Pure function: scan body paragraphs, extract multi-word capitalized
 * phrases, drop stopword-only matches, count occurrences case-insensitively
 * with word boundaries, return a frequency-ranked list capped to the
 * top-K (default 60).
 *
 * No LLM call. No I/O. Deterministic.
 *
 * Why case-insensitive count + case-preserving display:
 *   - "Bloom Filter" and "bloom filter" should fold into one count, but
 *     the canonical display form (first-seen casing) is what reaches the
 *     LLM filter — capitalization is the only signal the heuristic uses
 *     to flag a phrase as candidate-worthy in the first place.
 */
export function extractFrequentNPs(
  paragraphs: SourceParagraph[],
  options: Pick<GlossaryNPBootstrapOptions, 'minFrequency' | 'topK'> = {},
): NPCandidate[] {
  const minFrequency = options.minFrequency ?? DEFAULTS.minFrequency;
  const topK = options.topK ?? DEFAULTS.topK;

  // Map of lowercased-term → {displayTerm, count, firstParagraphRef}
  const counts = new Map<
    string,
    { displayTerm: string; count: number; firstParagraphRef: string }
  >();

  for (const p of paragraphs) {
    CAPITALIZED_MULTIWORD_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = CAPITALIZED_MULTIWORD_RE.exec(p.text)) !== null) {
      let term = m[0];

      // Strip leading sentence-start stopwords + lowercase connector words
      // that the regex glued onto a real candidate. Common case at
      // sentence boundaries: "When the Hash Table" → strip "When the " →
      // "Hash Table". Without this stripping, the case-folding step can't
      // unify "When the Hash Table" with the in-mid-sentence "Hash Table".
      // The stripping is a no-op for clean matches that don't begin with a
      // stopword (the vast majority).
      while (true) {
        const firstWord = term.split(/[\s-]/)[0] ?? '';
        if (NP_STOPWORDS.has(firstWord) || /^(?:of|the|and|for|in|on|to)$/i.test(firstWord)) {
          // Strip the leading word + its trailing separator.
          const sepIdx = term.search(/[\s-]/);
          if (sepIdx < 0) {
            term = '';
            break;
          }
          term = term.slice(sepIdx + 1);
        } else {
          break;
        }
      }
      // After stripping, the remainder must still be a multi-word phrase
      // (i.e., contain at least one internal separator with a capitalized
      // continuation). If the strip-down collapsed it to a single word or
      // empty, skip.
      if (term.length === 0 || !/[A-Z][a-z]+[\s-][A-Z][a-z]+/.test(term)) {
        continue;
      }

      const key = term.toLowerCase();
      const existing = counts.get(key);
      if (existing) {
        existing.count += 1;
      } else {
        counts.set(key, {
          displayTerm: term,
          count: 1,
          firstParagraphRef: formatRef(p.page, p.paragraphIdx),
        });
      }
    }
  }

  const ranked: NPCandidate[] = [];
  for (const { displayTerm, count, firstParagraphRef } of counts.values()) {
    if (count >= minFrequency) {
      ranked.push({ term: displayTerm, count, firstParagraphRef });
    }
  }
  // Stable sort: count desc, then term asc. The deterministic ordering
  // keeps test fixtures + cache audits diff-friendly.
  ranked.sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return a.term.localeCompare(b.term);
  });
  return ranked.slice(0, topK);
}

// ---------------------------------------------------------------------------
// Step 2 — LLM refinement (filter + definitions)
// ---------------------------------------------------------------------------

const REFINE_SYSTEM_PROMPT = `You are filtering candidate noun phrases from a technical book to build a glossary.

Input: a list of multi-word capitalized phrases extracted from the book by a heuristic, plus a small sample of source paragraphs for context.

Task: for each candidate, decide if it is a GENUINE TECHNICAL TERM whose definition the reader would benefit from having available while reading the chapters. If yes, write a ONE-SENTENCE definition grounded in the source context. If the candidate is a person name, a place name, a chapter title, a book title, a generic English phrase, or a heading-style label without a definable concept behind it, OMIT it.

Output STRICT JSON of shape {"terms": [{term, definition, source_paragraph_ref}]} where:
- term: the canonical form of the technical term (preserve the candidate's casing; lowercase only if it's not a proper noun).
- definition: a one-sentence definition (max 200 chars).
- source_paragraph_ref: the paragraph_ref the candidate was first seen at (provided in the candidate list as "first_seen=pageN:paragraphM").

If NONE of the candidates are genuine technical terms, output {"terms": []}.`;

interface RefinedTerm {
  term: string;
  definition: string;
  sourceParagraphRef: string;
}

/**
 * Build the user-prompt that follows the system prompt — candidate list +
 * context-paragraph excerpts. The shape is deliberately simple text rather
 * than nested JSON to keep gpt-4o-mini's parser happy at low cost.
 *
 * Public-ish so tests can assert the candidate + context interleave.
 */
export function buildRefineUserPrompt(
  candidates: NPCandidate[],
  contextParagraphs: SourceParagraph[],
): string {
  const candidateLines = candidates
    .map(
      (c) =>
        `- "${c.term}" (count=${c.count}, first_seen=${c.firstParagraphRef})`,
    )
    .join('\n');

  const contextLines = contextParagraphs
    .map((p) => {
      const ref = formatRef(p.page, p.paragraphIdx);
      // Truncate long paragraphs — context only needs to hint at the
      // term's domain, not provide the full source.
      const text = p.text.length > 400 ? p.text.slice(0, 400) + '…' : p.text;
      return `[${ref}] ${text}`;
    })
    .join('\n');

  return [
    'Candidate terms (frequency-ranked):',
    candidateLines || '(none)',
    '',
    'Source-context paragraph samples:',
    contextLines || '(none)',
    '',
    'Filter to genuine technical terms and emit {term, definition, source_paragraph_ref} for each.',
  ].join('\n');
}

/**
 * Pick a small sample of context paragraphs for the LLM. We grab evenly-
 * spaced paragraphs across the body so the context spans the full book
 * (not just the first chapter). Pure function — uses index arithmetic, no
 * randomness, so the test output is stable across runs.
 */
function pickContextSample(
  paragraphs: SourceParagraph[],
  size: number,
): SourceParagraph[] {
  if (paragraphs.length <= size) return [...paragraphs];
  const step = paragraphs.length / size;
  const out: SourceParagraph[] = [];
  for (let i = 0; i < size; i++) {
    const idx = Math.floor(i * step);
    const p = paragraphs[idx];
    if (p) out.push(p);
  }
  return out;
}

/**
 * Call gpt-4o-mini with the candidate list + context sample, parse the
 * response, return a validated list of `{term, definition, sourceParagraphRef}`.
 *
 * Failure semantics: fail-open. Any LLM/parse error returns an empty list
 * and logs to stderr. Mirrors `extractGlossaryFromSections` so the worker
 * sees the same "missing glossary is fine" contract regardless of which
 * path produced (or failed to produce) the artifact.
 */
export async function refineCandidatesWithLLM(
  candidates: NPCandidate[],
  contextParagraphs: SourceParagraph[],
  options: Pick<GlossaryNPBootstrapOptions, 'abortSignal'> = {},
): Promise<RefinedTerm[]> {
  if (candidates.length === 0) return [];

  const userPrompt = buildRefineUserPrompt(candidates, contextParagraphs);

  let raw = '';
  try {
    const response = await withRetry({
      operationName: 'glossary-np-refine',
      abortSignal: options.abortSignal,
      fn: async () =>
        openai.chat.completions.create(
          {
            model: NP_FALLBACK_MODEL,
            messages: [
              { role: 'system', content: REFINE_SYSTEM_PROMPT },
              { role: 'user', content: userPrompt },
            ],
            response_format: { type: 'json_object' },
            max_tokens: 4096,
            temperature: 0,
          },
          { signal: options.abortSignal },
        ),
    });
    raw = response.choices[0]?.message?.content ?? '';
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      '[glossary-np-fallback] LLM refine call failed (fail-open):',
      (err as Error).message,
    );
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      '[glossary-np-fallback] JSON parse failed (fail-open):',
      (err as Error).message,
    );
    return [];
  }

  const refined: RefinedTerm[] = [];
  const o = parsed as { terms?: unknown };
  if (Array.isArray(o.terms)) {
    for (const t of o.terms as Array<Partial<RefinedTerm>>) {
      if (
        typeof t?.term === 'string' &&
        typeof t?.definition === 'string' &&
        typeof t?.sourceParagraphRef === 'string' &&
        t.term.length > 0 &&
        t.definition.length > 0 &&
        // Match the ref-shape guard from glossary-extract.ts for parity.
        /^page\d+:paragraph\d+$/.test(t.sourceParagraphRef)
      ) {
        refined.push({
          term: t.term.slice(0, 200),
          definition: t.definition.slice(0, 500),
          sourceParagraphRef: t.sourceParagraphRef,
        });
      }
    }
  }
  return refined;
}

// ---------------------------------------------------------------------------
// Step 3 — orchestrator (heuristic → LLM filter → GlossaryArtifact)
// ---------------------------------------------------------------------------

/**
 * Run the full Sprint-J NP-bootstrap pipeline over a book's body paragraphs.
 *
 * Returns a `GlossaryArtifact` ready for the caller (worker.ts) to feed to
 * `writeGlossary`. The shape matches `extractGlossaryFromSections` so the
 * downstream consumers (glossary_terms DB rows; the narrative prompt
 * injection) cannot tell which path produced the artifact.
 *
 * Fail-open contract: empty body paragraphs OR an LLM failure → returns
 * `{schemaVersion: 1, terms: []}`. The caller's existing
 * `glossary.terms.length > 0` gate around `writeGlossary` already covers
 * the no-write case; we don't need to surface a separate "failed" signal.
 */
export async function runGlossaryNPBootstrap(
  bodyParagraphs: SourceParagraph[],
  options: GlossaryNPBootstrapOptions = {},
): Promise<GlossaryArtifact> {
  if (bodyParagraphs.length === 0) {
    return { schemaVersion: 1, terms: [] };
  }

  // Step 1: pure heuristic NP extraction + frequency ranking.
  const candidates = extractFrequentNPs(bodyParagraphs, {
    minFrequency: options.minFrequency,
    topK: options.topK,
  });

  if (candidates.length === 0) {
    return { schemaVersion: 1, terms: [] };
  }

  // Step 2: pick context-paragraph sample for the LLM filter step.
  const contextSampleSize = options.contextSampleSize ?? DEFAULTS.contextSampleSize;
  const contextSample = pickContextSample(bodyParagraphs, contextSampleSize);

  // Step 3: LLM refine call (fail-open inside).
  const refined = await refineCandidatesWithLLM(candidates, contextSample, {
    abortSignal: options.abortSignal,
  });

  return { schemaVersion: 1, terms: refined };
}

// Convenience used in unit tests — avoids string drift on the prompts +
// model identifier. NOT a public API beyond tests.
export const __TEST_ONLY = {
  NP_FALLBACK_MODEL,
  REFINE_SYSTEM_PROMPT,
  NP_STOPWORDS,
};
