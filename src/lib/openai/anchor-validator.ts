// src/lib/openai/anchor-validator.ts — pure anchor-coverage validator.
//
// PURE FUNCTION. No I/O. No DB. No network. No LLM. Side-table persistence
// (storing per-chunk anchor-coverage scores in a future fidelity table)
// is owned by a later wave's integration step; this module is the kernel
// that the integration wraps.
//
// Design anchor: docs/design/feature-b-voice-and-anchor-profile.md
// (Feature B' — voice + anchor profile). This module IS Component 4 of
// that design (the anchor-coverage validator). Components 1-3 (anchor
// whitelist extraction, whitelist persistence, narrative prompt wiring)
// live in other modules and are owned by sibling agents in this wave.
//
// ─── What the validator does ───────────────────────────────────────────────
//
// Given:
//   - a chunk's narrative text (LLM-generated tutorial output)
//   - the chunk's source paragraphs (verbatim PDF extract)
//   - the anchor whitelist (curated load-bearing search-terms +
//     named-systems + named-papers + analogies + contrast-pairs)
//
// Compute which anchors from the whitelist:
//   1. ACTUALLY APPEAR in the source paragraphs (i.e. are eligible for
//      verification — the LLM can only fairly be expected to keep an
//      anchor that's in the source it was given).
//   2. Of those eligible, which ones the narrative kept vs dropped.
//
// The score is a chunk-level metric: fraction of eligible anchors that
// the narrative preserved. Score = 1.0 when no anchors were eligible
// (vacuously perfect — nothing to check) OR when all eligible anchors
// were kept.
//
// ─── Why word-boundary matching (risk R4 in the design doc) ────────────────
//
// A naive `narrative.toLowerCase().includes(term.toLowerCase())` produces
// false positives that silently inflate the score:
//
//   - anchor "RAID"   matches "afraid"     (substring)
//   - anchor "Brooks" matches "Brookside"  (substring)
//   - anchor "Erlang" matches "Erlangen"   (substring)
//
// These would make the validator report "anchor present" when in fact the
// concept is absent — defeating its purpose. We use a regex that requires
// a non-alphanumeric boundary (or string start/end) on each side of the
// anchor term. We do NOT use JavaScript's `\b` because `\b` treats hyphens
// as word boundaries, which would correctly match "head-of-line blocking"
// at the hyphens but would also bizarrely treat the hyphen INSIDE the
// anchor as a boundary, producing inconsistent semantics. Our custom
// `[^A-Za-z0-9]` guard is hyphen-friendly: hyphens, spaces, punctuation
// all count as boundaries — but only at the ENDS of the match, not
// internally.
//
// The same containsAnchor() helper is used for BOTH the source-side and
// narrative-side checks, so the two checks agree on what "appears" means.
// If the source contains "head-of-line" the narrative must contain
// "head-of-line"; we don't tolerate "head of line" on one side and
// "head-of-line" on the other (the design doc says verbatim match).
//
// ─── Style ─────────────────────────────────────────────────────────────────
//
// Strict TypeScript, no `any`. Small enough to read top-to-bottom in one
// sitting. Pattern follows src/lib/openai/_retry.ts (similar size, pure-fn
// classifier) and src/lib/lessons/parse-lessons.ts (small-pure-module
// pattern with header-comment-driven contract).

import type { SourceParagraph } from '@/lib/types';

// ───────────────────────────────────────────────────────────────────────────
// Public types
// ───────────────────────────────────────────────────────────────────────────

/**
 * One entry from anchor_whitelist.json — see design doc Component 2.
 *
 * - `term`: the verbatim string to look for (case-insensitive match).
 * - `category`: taxonomy of the anchor; used downstream for weighted
 *   scoring or per-category drift analysis. Not used by THIS module.
 * - `frequency_in_source`: how many times the term appears in the FULL
 *   source corpus (informational; not used by THIS module).
 * - `first_seen_at`: ISO timestamp of when the anchor was added to the
 *   whitelist (informational; not used by THIS module).
 */
export interface AnchorWhitelistEntry {
  term: string;
  category:
    | 'search-term'
    | 'named-system'
    | 'named-paper'
    | 'named-incident'
    | 'signature-analogy'
    | 'contrast-pair';
  frequency_in_source: number;
  first_seen_at: string;
}

/**
 * Result of validating a single chunk's anchor coverage.
 *
 * - `expected`: anchors that appear in the source paragraphs (eligible).
 * - `found`:    subset of `expected` that also appear in the narrative.
 * - `missing`:  `expected` minus `found`, preserving the order from
 *               `expected`. These are the violations.
 * - `score`:    found.length / expected.length, OR 1.0 when
 *               expected.length === 0 (vacuously perfect — there was
 *               nothing the narrative could have failed to mention).
 */
export interface AnchorValidatorResult {
  expected: AnchorWhitelistEntry[];
  found: AnchorWhitelistEntry[];
  missing: AnchorWhitelistEntry[];
  score: number;
}

// ───────────────────────────────────────────────────────────────────────────
// Word-boundary regex helper
// ───────────────────────────────────────────────────────────────────────────

/** Regex metacharacters that must be escaped to use a string as a literal
 *  inside a RegExp. Includes parens, brackets, braces, dots, plus, star,
 *  question-mark, caret, dollar, pipe, backslash. */
const REGEX_METACHAR_RE = /[.*+?^${}()|[\]\\]/g;

/**
 * Word-boundary, case-insensitive containment test.
 *
 * Returns true iff `haystack` contains `anchor` as a "whole token" —
 * preceded by a non-alphanumeric character or string start, and followed
 * by a non-alphanumeric character or string end.
 *
 * Examples:
 *   containsAnchor("They were afraid of RAID arrays", "RAID")    → true
 *   containsAnchor("They were afraid of arrays",      "RAID")    → false
 *   containsAnchor("uses head-of-line blocking",      "head-of-line blocking") → true
 *   containsAnchor("Chaos Monkey kills nodes",        "chaos monkey") → true
 *
 * Internally hyphens, spaces, etc. inside the anchor are matched verbatim
 * (not normalized) — the design doc explicitly requires verbatim match.
 */
export function containsAnchor(haystack: string, anchor: string): boolean {
  // Wave-1 review MEDIUM M2 fix: whitespace-padded anchors from LLM-generated
  // whitelists previously silently failed to match. Trim before checking.
  const trimmed = anchor.trim();
  if (!trimmed) return false;
  const escaped = trimmed.replace(REGEX_METACHAR_RE, '\\$&');

  // Boundary semantics (refined per Wave-1 review HIGH H1 + H2):
  //
  //   Leading lookbehind  (?<![A-Za-z0-9-])
  //     Rejects matches where the preceding character is alphanumeric
  //     OR a hyphen. The hyphen guard fixes HIGH H2: anchor "C++" must
  //     NOT match inside "Objective-C++" because the `-` would otherwise
  //     have qualified as a non-alphanumeric leading boundary under the
  //     original `[^A-Za-z0-9]` rule. Treating hyphen as part-of-token
  //     correctly rejects compound-name suffixes.
  //
  //   Trailing negative lookaheads:
  //     (?!\.\d)         — rejects `.digit` following the match. Fixes
  //                        HIGH H1: anchor "p99" must NOT match inside
  //                        "p99.9" because `.9` is a metric suffix, not
  //                        a sentence-ending period.
  //     (?![A-Za-z0-9])  — standard non-alphanumeric trailing guard.
  //
  // Vacuous-true at string boundaries: `^` has no preceding char so the
  // lookbehind is vacuously satisfied; `$` has no next char so both
  // lookaheads pass. Edge cases work as in the original consuming form.
  const re = new RegExp(`(?<![A-Za-z0-9-])${escaped}(?!\\.\\d)(?![A-Za-z0-9])`, 'i');
  return re.test(haystack);
}

// ───────────────────────────────────────────────────────────────────────────
// validateAnchors — the public surface
// ───────────────────────────────────────────────────────────────────────────

/**
 * Validate which whitelist anchors a narrative preserved relative to its
 * source paragraphs. See file header for the contract.
 *
 * Algorithm (matches design doc Component 4):
 *   1. expected = whitelist anchors that appear in ANY source paragraph
 *      (word-boundary, case-insensitive, against `.text`).
 *   2. found    = subset of `expected` that also appears in `narrative`
 *      (same word-boundary matcher).
 *   3. missing  = expected − found, preserving `expected`'s order.
 *   4. score    = expected.length === 0 ? 1.0 : found.length / expected.length.
 *
 * Edge cases:
 *   - whitelist [] → expected [], score 1.0
 *   - sourceParagraphs [] → expected [], score 1.0 (nothing to check)
 *   - narrative "" with non-empty expected → all missing, score 0
 *   - anchor with regex metachars (e.g. "Brewer's CAP (1999)") → escaped
 */
export function validateAnchors(args: {
  narrative: string;
  sourceParagraphs: SourceParagraph[];
  whitelist: AnchorWhitelistEntry[];
}): AnchorValidatorResult {
  const { narrative, sourceParagraphs, whitelist } = args;

  // Step 1: filter whitelist to anchors actually present in the source.
  // The LLM can only fairly be expected to keep anchors it was shown.
  const expected: AnchorWhitelistEntry[] = whitelist.filter((anchor) =>
    sourceParagraphs.some((p) => containsAnchor(p.text, anchor.term)),
  );

  // Step 2: of those, which ones the narrative also contains.
  const found: AnchorWhitelistEntry[] = expected.filter((anchor) =>
    containsAnchor(narrative, anchor.term),
  );

  // Step 3: set difference (preserve `expected` order). Identity is by
  // referential equality — `found` entries come from `expected.filter`,
  // so `Set` membership is a valid O(1) lookup.
  const foundSet = new Set<AnchorWhitelistEntry>(found);
  const missing: AnchorWhitelistEntry[] = expected.filter((a) => !foundSet.has(a));

  // Step 4: score. Vacuous-perfect when expected is empty.
  const score = expected.length === 0 ? 1.0 : found.length / expected.length;

  return { expected, found, missing, score };
}
