// src/lib/pdf/paragraph-anchors.ts — paragraph-anchor format + range queries
//
// Pure functions ONLY. No I/O, no async, no module-level state.
// This is the *shared vocabulary* layer between parse output and
// citation-validation; keeping it pure lets us unit-test exhaustively
// and lets omar's openai/streaming.ts import validateRef() without
// pulling pdfjs-dist into the OpenAI-call codepath (SRP per
// kb:architecture/crosscut/single-responsibility §"at module level").
//
// The format `page{N}:paragraph{M}` is the single source of truth for
// the proof-citation key. See src/lib/types.ts:SourceParagraphRef for
// the typed shape. Validators here MUST match that template literal.
//
// Design anchor:
//   - kb:architecture/crosscut/single-responsibility — anchor primitives
//     have ONE reason to change (the format spec); parse/detect/worker
//     each take a separate change-reason. Folding any of those into this
//     file would conflate concerns per Clean Code ch 10's "actor" test.

import type { SourceParagraph, SourceParagraphRef } from '@/lib/types';

// ---------------------------------------------------------------------------
// Format primitives
// ---------------------------------------------------------------------------

/**
 * Build a paragraph-ref string from a (page, paragraphIdx) tuple.
 *
 * Page is 1-based (matches PDF page numbering convention); paragraphIdx
 * is 0-based ordinal within the page (matches array indexing). Both
 * non-negative integers; the function does NOT validate (call sites are
 * trusted: parser emits, no user input flows in).
 *
 * Example: formatRef(42, 3) → "page42:paragraph3"
 */
export function formatRef(page: number, paragraphIdx: number): SourceParagraphRef {
  return `page${page}:paragraph${paragraphIdx}`;
}

/**
 * Parse a paragraph-ref string back to its (page, paragraphIdx) tuple.
 * Returns null on any shape failure — the caller treats null as "invalid
 * ref" (per kb:architecture/discipline/error-handling-discipline §"define
 * errors out of existence": invalid input returns null, not throws).
 *
 * Strict shape: /^page(\d+):paragraph(\d+)$/. No leading-zero tolerance;
 * no whitespace. The format is machine-emitted-and-machine-consumed; loose
 * parsing would hide bugs in the emit side.
 */
export function parseRef(ref: string): { page: number; paragraphIdx: number } | null {
  if (typeof ref !== 'string') return null;
  const match = /^page(\d+):paragraph(\d+)$/.exec(ref);
  if (!match) return null;
  // match[1] and match[2] are guaranteed by the regex (\d+ groups present)
  const page = Number(match[1]);
  const paragraphIdx = Number(match[2]);
  if (!Number.isInteger(page) || !Number.isInteger(paragraphIdx)) return null;
  if (page < 1 || paragraphIdx < 0) return null;
  return { page, paragraphIdx };
}

// ---------------------------------------------------------------------------
// Range queries — used by chapter-detect to slice page ranges into the
// paragraph list owned by each chapter.
// ---------------------------------------------------------------------------

/**
 * Minimal ParsedPdf shape this module needs. We DO NOT import the full
 * ParsedPdf type from `./parse` to keep this file dependency-free at the
 * module level (parse.ts pulls pdfjs-dist; this file should not).
 * Anchor: kb:architecture/crosscut/single-responsibility §"at module
 * level — what change pressure does this module exist to absorb?"
 */
export type PdfPageView = {
  pageNumber: number;            // 1-based
  paragraphs: SourceParagraph[]; // ordered top-to-bottom
};

/**
 * Return the flat list of paragraphs falling within [pageStart, pageEnd]
 * inclusive. Pages outside the range are skipped; pages within but missing
 * (gap-pages) silently contribute zero paragraphs.
 *
 * Stable order: pages are iterated by ascending pageNumber, then paragraphs
 * by ascending paragraphIdx (the natural order parsers produce them in).
 */
export function paragraphsForRange(
  pages: PdfPageView[],
  pageStart: number,
  pageEnd: number,
): SourceParagraph[] {
  if (pageStart > pageEnd) return [];
  const out: SourceParagraph[] = [];
  // Linear scan is fine: pages.length ~ 100-1000 for typical textbooks.
  // Sorting upfront would add O(n log n) for a use case that's already O(n).
  for (const p of pages) {
    if (p.pageNumber < pageStart || p.pageNumber > pageEnd) continue;
    for (const para of p.paragraphs) out.push(para);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Validation — used by omar's openai/streaming.ts to reject hallucinated
// refs (ari HIGH-3 absorb). Pure boolean: does the ref's (page, paraIdx)
// resolve to an extant paragraph in this paragraph set?
// ---------------------------------------------------------------------------

/**
 * Return true if `ref` (a) parses to a valid shape AND (b) resolves to
 * an actual paragraph in `paragraphs`. Used after OpenAI returns to drop
 * hallucinated source citations.
 *
 * Per ari HIGH-3 design: refs that fail validation cause the question/
 * flashcard to be DROPPED at insert time (not failed-but-stored); the
 * count is logged to parses_cost.validation_drop_count.
 *
 * Behavior on edge cases:
 *   - ref shape malformed → false
 *   - page out of range → false
 *   - paragraphIdx out of range for that page → false
 *   - empty paragraphs[] → false for any ref
 *
 * Performance: O(paragraphs.length) per call. For a typical chapter
 * (~50-200 paragraphs) called once per quiz question (~10/chapter), this
 * is ~2000 comparisons per chapter. Fine. If quizzes balloon to 1000+
 * questions/chapter we'd index paragraphs by (page, idx) once per
 * chapter; for now linear is simpler.
 */
export function validateRef(ref: string, paragraphs: SourceParagraph[]): boolean {
  const parsed = parseRef(ref);
  if (parsed === null) return false;
  for (const p of paragraphs) {
    if (p.page === parsed.page && p.paragraphIdx === parsed.paragraphIdx) {
      return true;
    }
  }
  return false;
}
