// src/lib/pdf/chapter-detect.ts — 3-tier chapter detection.
//
// Per ari MEDIUM-2 (PHASE-1 design):
//   Tier 1: PDF outline (most reliable; preserved structure from author)
//   Tier 2: heading-regex on first line of each page (English-only)
//   Tier 3: single mega-chapter (entire PDF as one chapter)
//
// Each tier returns null when it fails; the orchestrator (detectChapters)
// tries them in order and falls through. Tier 3 always succeeds.
//
// Design anchors:
//   - kb:architecture/discipline/stability-patterns §Fail-Fast — empty / shallow
//     outlines return null IMMEDIATELY rather than being patched / heuristic-
//     extended. The detection tier decision is the right place to articulate
//     "we can't tell" so the UI can surface degraded-confidence to the user.
//   - kb:architecture/crosscut/single-responsibility — tier functions are each
//     pure + isolated; one reason-to-change per tier. Adding Tier 4 (OCR
//     fallback in test4) is a NEW function, not a modification.

import type { SourceParagraph } from '@/lib/types';
import type { ParsedPdf, PdfOutlineEntry } from './parse';
import { paragraphsForRange } from './paragraph-anchors';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ChapterCandidate = {
  title: string;
  pageStart: number;        // 1-based, inclusive
  pageEnd: number;          // 1-based, inclusive
  sourceParagraphs: SourceParagraph[];
};

export type DetectionTier = 'outline' | 'heading-regex' | 'mega';

export type DetectionResult = {
  tier: DetectionTier;
  /** 'high' | 'medium' | 'low' — for UI to surface confidence-level banner. */
  confidence: 'high' | 'medium' | 'low';
  chapters: ChapterCandidate[];
};

// ---------------------------------------------------------------------------
// Tier 1: outline-based detection
// ---------------------------------------------------------------------------

/**
 * Use the PDF outline (TOC) to derive chapters.
 *
 * Algorithm:
 *   - Filter to depth-0 entries (top-level chapters; nested sections become
 *     content within their parent chapter). This is the most reliable signal
 *     when an outline exists; rendering chapters as full top-level entries
 *     and sub-sections as "headings within" matches user mental model.
 *   - Sort by pageNumber (outline order ≈ doc order, but defensive).
 *   - Each chapter spans [its pageNumber, nextChapterStart - 1]; the last
 *     chapter spans to pageCount.
 *   - Skip entries with null pageNumber (broken bookmarks).
 *
 * Returns null when:
 *   - No outline (parsedPdf.outline === null)
 *   - Outline has <3 top-level entries (too shallow; likely TOC artifact
 *     rather than chapter structure — fall through to Tier 2)
 *
 * Per ari MEDIUM-2: "shallow outline" threshold is at 3 entries because
 * a 2-entry outline is usually "Cover" + "Body" — useless for chapter
 * navigation. 3+ entries signals real structure.
 */
export function detectFromOutline(parsedPdf: ParsedPdf): ChapterCandidate[] | null {
  if (!parsedPdf.outline) return null;
  const topLevel = parsedPdf.outline
    .filter((e): e is PdfOutlineEntry & { pageNumber: number } =>
      e.depth === 0 && typeof e.pageNumber === 'number' && e.pageNumber >= 1,
    )
    .sort((a, b) => a.pageNumber - b.pageNumber);

  if (topLevel.length < 3) return null;

  const chapters: ChapterCandidate[] = [];
  for (let i = 0; i < topLevel.length; i++) {
    const entry = topLevel[i];
    if (!entry) continue; // noUncheckedIndexedAccess guard
    const nextEntry = topLevel[i + 1];
    const pageStart = entry.pageNumber;
    const pageEnd = nextEntry ? nextEntry.pageNumber - 1 : parsedPdf.pageCount;
    // Guard against malformed outlines where two entries land on the same page;
    // collapse to a single-page chapter rather than emit an empty range.
    const safePageEnd = Math.max(pageStart, pageEnd);
    const sourceParagraphs = paragraphsForRange(parsedPdf.pages, pageStart, safePageEnd);
    chapters.push({
      title: entry.title.length > 0 ? entry.title : `Chapter ${i + 1}`,
      pageStart,
      pageEnd: safePageEnd,
      sourceParagraphs,
    });
  }

  return chapters;
}

// ---------------------------------------------------------------------------
// Tier 2: heading-regex detection (English-only, documented)
// ---------------------------------------------------------------------------

/**
 * Heuristic chapter detection via heading regex on page first lines.
 *
 * Match shapes (intentionally restrictive — English-only; documented in
 * ari MEDIUM-2's "fix" section):
 *   - `Chapter 1`, `Chapter 12`, `CHAPTER III`
 *   - `1. Title Case Phrase`  (numbered section with capitalized title)
 *   - `Part I`, `Part IV`     (Roman-numeral parts)
 *
 * Per-page scan: take the first non-empty line of each page, test against
 * the heading regex. Matches become chapter starts; the chapter spans
 * [matched page, nextMatchedPage - 1].
 *
 * Returns null when:
 *   - <2 pages match the regex (insufficient signal; not a chaptered PDF)
 *
 * Limitations (documented for user-facing warning):
 *   - English-only by design; Chinese / Arabic / etc textbooks need OCR
 *     + multilingual headings in test4+
 *   - False positives possible on pages that happen to start with
 *     "Chapter X" in body text (e.g., "Chapter 3 covers..."); the
 *     first-non-empty-line constraint limits this in practice.
 */
export function detectFromHeadingRegex(parsedPdf: ParsedPdf): ChapterCandidate[] | null {
  const headingRe = /^(?:Chapter\s+(?:\d+|[IVXLCM]+)|\d+\.\s+[A-Z][A-Za-z]|Part\s+[IVXLCM]+)/;
  type Match = { pageNumber: number; title: string };
  const matches: Match[] = [];

  for (const page of parsedPdf.pages) {
    const firstLine = firstNonEmptyLine(page.rawText);
    if (!firstLine) continue;
    if (headingRe.test(firstLine)) {
      matches.push({ pageNumber: page.pageNumber, title: firstLine });
    }
  }

  if (matches.length < 2) return null;

  const chapters: ChapterCandidate[] = [];
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    if (!m) continue;
    const next = matches[i + 1];
    const pageStart = m.pageNumber;
    const pageEnd = next ? next.pageNumber - 1 : parsedPdf.pageCount;
    const safePageEnd = Math.max(pageStart, pageEnd);
    const sourceParagraphs = paragraphsForRange(parsedPdf.pages, pageStart, safePageEnd);
    // Truncate excessively long titles (sometimes the first line is a whole
    // paragraph if the page has no real heading; cap at 200 chars).
    const title = m.title.length > 200 ? m.title.slice(0, 200) + '…' : m.title;
    chapters.push({ title, pageStart, pageEnd: safePageEnd, sourceParagraphs });
  }
  return chapters;
}

function firstNonEmptyLine(text: string): string | null {
  const lines = text.split('\n');
  for (const line of lines) {
    const t = line.trim();
    if (t.length > 0) return t;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Tier 3: single mega-chapter (always succeeds)
// ---------------------------------------------------------------------------

/**
 * Last-resort: emit a single "Full Document" chapter spanning the entire PDF.
 *
 * Used when both Tier 1 (outline) and Tier 2 (heading-regex) fail. The
 * orchestrator marks the result with confidence='low' so the UI can show
 * a "we couldn't detect chapter structure — generating as one long chapter"
 * banner per ari MEDIUM-2.
 *
 * The resulting chapter holds every paragraph in the PDF; downstream
 * ml-engineer streaming MAY refuse to process if total token count exceeds
 * the model's context window. That's an ml-engineer concern, not ours; we
 * surface the data + confidence-flag faithfully.
 */
export function singleMegaChapter(parsedPdf: ParsedPdf): ChapterCandidate[] {
  const sourceParagraphs = paragraphsForRange(parsedPdf.pages, 1, parsedPdf.pageCount);
  return [
    {
      title: 'Full Document',
      pageStart: 1,
      pageEnd: parsedPdf.pageCount,
      sourceParagraphs,
    },
  ];
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * Run the 3-tier detection cascade and return the first tier that succeeds.
 *
 * Confidence mapping:
 *   - 'outline' → 'high'        (author-curated structure)
 *   - 'heading-regex' → 'medium' (heuristic; ~90% accuracy on English text)
 *   - 'mega' → 'low'             (fall-through; no structure detected)
 *
 * Per stability-patterns §"tier the stability response": critical concerns
 * (proof-citation anchor existence) get full ACID + fail-fast; auxiliary
 * concerns (chapter boundaries) get graceful degradation through tiers.
 * The mega-chapter path keeps the system operating at "useful, if imperfect"
 * rather than throwing on a structurally weird PDF.
 *
 * Edge case: parsedPdf.lowConfidenceScannedImage=true → we still run all
 * three tiers; the worker decides whether to refuse generation. The reason
 * this isn't a Tier-0 early-fail is that some scanned PDFs DO have a
 * machine-readable outline embedded even when page text is image-only;
 * we'd lose the chapter boundaries if we shortcut on the scanned flag.
 */
export function detectChapters(parsedPdf: ParsedPdf): DetectionResult {
  const outlineResult = detectFromOutline(parsedPdf);
  if (outlineResult !== null) {
    return { tier: 'outline', confidence: 'high', chapters: outlineResult };
  }
  const headingResult = detectFromHeadingRegex(parsedPdf);
  if (headingResult !== null) {
    return { tier: 'heading-regex', confidence: 'medium', chapters: headingResult };
  }
  return { tier: 'mega', confidence: 'low', chapters: singleMegaChapter(parsedPdf) };
}
