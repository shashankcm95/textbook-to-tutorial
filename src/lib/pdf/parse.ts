// src/lib/pdf/parse.ts — pdfjs-dist wrapper for Node-side PDF parsing.
//
// Scope:
//   - Accept a Buffer (from S3 fetch) and return a structured ParsedPdf.
//   - Extract per-page text → paragraphs (split on blank-line runs).
//   - Extract document outline (TOC) when present.
//   - Surface a low-confidence flag when >25% of pages are near-empty
//     (heuristic: scanned-image PDF without OCR layer).
//
// Library choice — pdfjs-dist over alternatives:
//   - pdfjs-dist (Mozilla's pdf.js, Node-side via /legacy/build/pdf): supports
//     getOutline(), text extraction with positioning, used in production by
//     hundreds of services. Heavyweight (~2 MB) but battle-tested.
//   - pdf-parse: simpler API but NO outline access; we'd lose Tier 1 of
//     ari MEDIUM-2's chapter detection. Reject.
//   - unpdf: newer, faster, but stripped down (no outline). Reject for same
//     reason as pdf-parse.
//
// Node-side bundling caveats (worth surfacing — see report Finding HIGH):
//   1. We import from 'pdfjs-dist/legacy/build/pdf.mjs' (or .js) — the
//      "legacy" build skips the worker abstraction (Node has no Web Worker;
//      pdfjs-dist auto-detects and runs main-thread).
//   2. pdfjs-dist 4.x is ESM-only; package.json sets type:module is NOT set
//      for this project, so we import the CJS-compatible build path. If
//      build errors fire on .mjs resolution, fall back to pdfjs-dist@3.x.
//   3. The `verbosity` option to getDocument silences "Warning:" noise that
//      pdfjs-dist emits to stderr on malformed-but-recoverable PDFs.
//
// Design anchors:
//   - kb:architecture/crosscut/single-responsibility — parse.ts does parse;
//     does NOT detect chapters (that's chapter-detect.ts); does NOT fetch
//     bytes (that's s3.ts). Three modules, three reasons to change.
//   - kb:architecture/discipline/stability-patterns §Fail-Fast — bad PDFs
//     throw immediately (PdfParseError) rather than returning empty results;
//     the caller (worker) decides whether to mark tutorial='error' or retry.

import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { join } from 'node:path';
import type { SourceParagraph } from '@/lib/types';
import { isMonospaceFontFamily, classifyParagraphKind } from './font-class';

// pdfjs-dist 4.x requires a worker file path even on Node — the legacy build
// uses a "fake worker" that runs on the main thread, but the spin-up code
// still resolves `workerSrc` and errors out if it's empty.
//
// We can NOT use `require.resolve('pdfjs-dist/.../pdf.worker.mjs')` because
// webpack statically analyzes that and tries to bundle the worker as ESM,
// failing with "ESM packages need to be imported." Instead, build the path
// at runtime from process.cwd() so webpack sees only an opaque string.
//
// CWD is the project root in both `next dev` and `next start`, so the
// node_modules walk is stable. See PHASE-5 FINDING-PDF-1.
GlobalWorkerOptions.workerSrc = join(
  process.cwd(),
  'node_modules',
  'pdfjs-dist',
  'legacy',
  'build',
  'pdf.worker.mjs',
);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ParsedPage = {
  /** 1-based PDF page number. */
  pageNumber: number;
  /** Concatenated raw text for the page; preserved for debug + Tier-2 detect. */
  rawText: string;
  /** Paragraphs split from rawText (see paragraph-extraction logic below). */
  paragraphs: SourceParagraph[];
};

export type PdfOutlineEntry = {
  /** Outline-entry title (chapter / section name). */
  title: string;
  /**
   * 1-based page number the entry resolves to. Null when pdfjs returns
   * an outline entry whose destination doesn't resolve (broken bookmark).
   */
  pageNumber: number | null;
  /** Nesting depth, 0-based (root entries are depth 0). */
  depth: number;
};

export type ParsedPdf = {
  pageCount: number;
  pages: ParsedPage[];
  /** Flat list of outline entries in DFS order; null if PDF has no outline. */
  outline: PdfOutlineEntry[] | null;
  /**
   * True when >25% of pages have <50 chars of text — strong signal the PDF
   * is scanned images without an OCR layer. Worker should surface this in
   * the error_message or partial-success path.
   */
  lowConfidenceScannedImage: boolean;
};

export class PdfParseError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(`pdf parse failed: ${message}`);
    this.name = 'PdfParseError';
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse a PDF buffer into structured pages + paragraphs + outline.
 *
 * @param buffer  raw PDF bytes (from fetchPdfFromS3 or similar)
 * @throws        PdfParseError on unreadable PDF; the worker handles by
 *                marking tutorial status='error'.
 *
 * Memory profile: pdfjs-dist holds the full document in memory while
 * extracting; for a 50 MB PDF expect ~150-200 MB resident during parse.
 * The worker layer caps S3 fetch at 50 MB to bound this. See report
 * Finding HIGH on memory pressure.
 */
export async function parsePdfBuffer(buffer: Buffer): Promise<ParsedPdf> {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new PdfParseError('input is not a non-empty Buffer');
  }

  // pdfjs-dist getDocument accepts a Uint8Array (or TypedArrayInit object).
  // We pass the underlying buffer as a Uint8Array view — copy-free.
  const data = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);

  let pdfDoc;
  try {
    const loadingTask = getDocument({
      data,
      verbosity: 0,            // suppress pdfjs warnings to stderr
      disableFontFace: true,   // Node has no font rendering; skip the work
      useSystemFonts: false,   // same
      isEvalSupported: false,  // Node-side: avoid worker eval path entirely
    });
    pdfDoc = await loadingTask.promise;
  } catch (err) {
    throw new PdfParseError(`getDocument rejected: ${(err as Error).message}`, err);
  }

  const pageCount = pdfDoc.numPages;
  if (pageCount === 0) {
    throw new PdfParseError('pdf has zero pages');
  }

  // Sequential per-page processing. pdfjs-dist's per-page API IS already
  // async I/O against the in-memory buffer (font decode, glyph mapping, etc),
  // so awaiting one-at-a-time keeps memory bounded — parallelizing would
  // double the resident-page set. For 1000-page PDFs this matters.
  const pages: ParsedPage[] = [];
  let nearEmptyCount = 0;
  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber++) {
    const parsedPage = await extractPage(pdfDoc, pageNumber);
    pages.push(parsedPage);
    if (parsedPage.rawText.length < 50) nearEmptyCount++;
  }

  const outline = await extractOutline(pdfDoc);
  const lowConfidenceScannedImage = nearEmptyCount / pageCount > 0.25;

  return { pageCount, pages, outline, lowConfidenceScannedImage };
}

// ---------------------------------------------------------------------------
// Helpers (file-private)
// ---------------------------------------------------------------------------

/**
 * Extract a single page's text + paragraphs.
 *
 * pdfjs-dist's getTextContent returns `items: Array<{ str, hasEOL, ... }>`.
 * The `hasEOL` field marks end-of-line per the underlying text-content stream;
 * we use it to detect paragraph breaks (consecutive EOLs = paragraph end).
 *
 * Paragraph extraction strategy (in priority order):
 *   1. Group items by hasEOL boundaries; collapse multiple EOLs to paragraph
 *      breaks (≥2 consecutive EOLs = paragraph break).
 *   2. Fall back to splitting concatenated text on /\n{2,}/ when item-level
 *      EOLs are absent (some PDFs encode all text as one big block).
 *   3. If both yield zero paragraphs but rawText is non-empty, return a
 *      single-paragraph view (paragraphIdx=0). Avoids losing the page entirely.
 */
async function extractPage(pdfDoc: any, pageNumber: number): Promise<ParsedPage> {
  let page: any;
  try {
    page = await pdfDoc.getPage(pageNumber);
  } catch (err) {
    throw new PdfParseError(`getPage(${pageNumber}) failed: ${(err as Error).message}`, err);
  }

  // PR-D: force font resolution before reading text content. pdfjs lazy-loads
  // embedded fonts; until getOperatorList() (or render()) triggers the load,
  // page.commonObjs.get(fontName) throws "object isn't resolved yet" — and
  // content.styles[fontName].fontFamily ends up as a coarse CSS generic
  // ("sans-serif" / "serif" / "monospace") that masks the actual embedded
  // font name. Empirical (CTCI fresh-parse 2026-05-25): 100% of items got
  // "sans-serif" even on code-dense pages where multiple distinct fonts ARE
  // embedded (per-font ascent values differ by 0.05+, proving variation).
  // Loading the operator list resolves the fonts so commonObjs.get(fontName)
  // returns the real Font object with its .name = PostScript name (e.g.,
  // CourierNewPSMT). Side effect: parses the page's content stream once.
  // Cost is similar to getTextContent's already-existing parse, so the
  // marginal overhead is ~1× current (not 2×) — both ops walk the same data.
  // The OperatorList is itself a side effect we don't use; we drop the
  // returned promise after awaiting it (its purpose is just to drive
  // commonObjs resolution).
  try {
    await page.getOperatorList();
  } catch (err) {
    // Non-fatal: if operator-list parsing fails for a malformed page, we can
    // still proceed with getTextContent's text — we'll just fall back to the
    // unresolved fontFamily path (commonObjs.get will throw; resolveFontName
    // catches and returns the styles-fallback string).
    // eslint-disable-next-line no-console
    console.warn(
      `[parse:page${pageNumber}] getOperatorList failed (continuing with unresolved fonts): ` +
        (err as Error).message,
    );
  }

  let content: any;
  try {
    content = await page.getTextContent();
  } catch (err) {
    throw new PdfParseError(`getTextContent(${pageNumber}) failed: ${(err as Error).message}`, err);
  }

  // PR-D: build a fontName → resolved-family map. For each item's fontName,
  // try commonObjs.get(fontName).name first (the real PostScript name); fall
  // back to content.styles[fontName].fontFamily on lookup failure.
  const styles: Record<string, { fontFamily?: string }> = content.styles ?? {};
  const items: Array<PdfTextItem> = content.items ?? [];
  const fontNameToFamily = new Map<string, string | null>();
  const uniqueFontNames = new Set<string>();
  for (const it of items) {
    if (it.fontName) uniqueFontNames.add(it.fontName);
  }
  for (const fontName of uniqueFontNames) {
    let resolved: string | null = null;
    try {
      const fontObj = page.commonObjs.get(fontName);
      if (fontObj && typeof fontObj === 'object') {
        const name = (fontObj as { name?: string }).name;
        if (typeof name === 'string' && name.length > 0) {
          resolved = name;
        }
      }
    } catch {
      // Object not resolved — fall through to styles-based fallback.
    }
    if (!resolved) {
      const family = styles[fontName]?.fontFamily;
      if (typeof family === 'string' && family.length > 0) {
        resolved = family;
      }
    }
    fontNameToFamily.set(fontName, resolved);
  }

  return extractPageFromContent(pageNumber, items, fontNameToFamily);
}

/**
 * Pure variant of extractPage: takes raw pdfjs items + styles map (no
 * pdfDoc/page side effects) and returns the ParsedPage. Exported for unit
 * testing — production code should call extractPage with a real pdfDoc.
 *
 * PR-B: resolves per-item monospace flag from a fontName-to-family map,
 * then emits each paragraph with its kind classification. Items missing
 * fontName, items with no entry in the map, or items whose map entry is
 * null default to non-monospace (fail-open).
 *
 * PR-D (2026-05-25): signature changed from
 *   (pageNumber, items, styles: Record<string, {fontFamily?}>)
 * to
 *   (pageNumber, items, fontNameToFamily: Map<string, string|null>)
 * so callers can supply real PostScript font names (resolved via
 * page.commonObjs.get(fontName).name in extractPage) instead of pdfjs's
 * coarse CSS-generic fontFamily output. Empirical impetus: CTCI fresh-
 * parse showed every fontFamily collapsed to "sans-serif" — useless for
 * monospace classification. The Map shape lets callers fill in real font
 * names where pdfjs can't.
 */
export function extractPageFromContent(
  pageNumber: number,
  items: ReadonlyArray<PdfTextItem>,
  fontNameToFamily: ReadonlyMap<string, string | null>,
): ParsedPage {
  const enriched: EnrichedItem[] = items.map((it) => {
    const fontName = it.fontName ?? '';
    const fontFamily = fontName ? fontNameToFamily.get(fontName) ?? null : null;
    return {
      str: it.str ?? '',
      hasEOL: !!it.hasEOL,
      isMonospace: isMonospaceFontFamily(fontFamily),
    };
  });

  // Strategy 1: group by hasEOL boundaries — both string + monospace flags
  const paragraphsByEOL = groupParagraphsByEOL(enriched);
  const rawText = enriched.map((i) => i.str).join('');

  let paragraphs: SourceParagraph[];
  if (paragraphsByEOL.length >= 2) {
    paragraphs = paragraphsByEOL.map((group, idx) => ({
      page: pageNumber,
      paragraphIdx: idx,
      text: group.text,
      kind: classifyParagraphKind(group.items),
    }));
  } else {
    // Strategy 2 fallback: split rawText on blank-line runs. We've lost
    // per-item font info at this point, so default to 'prose' (fail-open).
    const splits = rawText.split(/\n{2,}/).map((s) => s.trim()).filter((s) => s.length > 0);
    if (splits.length > 0) {
      paragraphs = splits.map((text, idx) => ({
        page: pageNumber,
        paragraphIdx: idx,
        text,
        kind: 'prose' as const,
      }));
    } else if (rawText.trim().length > 0) {
      // Strategy 3 last-resort: one paragraph for the whole page. Same
      // fail-open default. Page-level mono ratio could be applied here
      // as a coarser signal, but Strategy 3 fires on degenerate inputs
      // (no EOLs, no blank lines) where any classification is suspect.
      paragraphs = [{ page: pageNumber, paragraphIdx: 0, text: rawText.trim(), kind: 'prose' }];
    } else {
      paragraphs = [];
    }
  }

  return { pageNumber, rawText, paragraphs };
}

/** Raw pdfjs text item. Field set is a subset of the pdfjs API. */
type PdfTextItem = { str?: string; hasEOL?: boolean; fontName?: string };

/**
 * Item enriched with the monospace flag derived from styles[fontName].
 * Internal-only — the public SourceParagraph carries only the per-paragraph
 * `kind` distillation, not the per-item flags.
 */
type EnrichedItem = { str: string; hasEOL: boolean; isMonospace: boolean };

/**
 * One paragraph emitted by the EOL grouper: its text + the per-item flags
 * that contributed to it. The flags feed the PR-B monospace classifier.
 */
type ParagraphGroup = {
  text: string;
  items: Array<{ str: string; isMonospace: boolean }>;
};

/**
 * Group pdfjs items into paragraphs by EOL run.
 *
 * Algorithm:
 *   - Build the current paragraph by concatenating item.str values.
 *   - When an item has hasEOL=true, push a single space.
 *   - When TWO consecutive items have hasEOL=true (with no non-empty
 *     content between), the current paragraph closes and a new one begins.
 *
 * Returns ParagraphGroup[] — each carries both the concatenated text and
 * the per-item (str, isMonospace) tuples so callers can derive paragraph-
 * level signal (PR-B paragraph kind classification, etc.).
 */
function groupParagraphsByEOL(items: ReadonlyArray<EnrichedItem>): ParagraphGroup[] {
  const paragraphs: ParagraphGroup[] = [];
  let currentText = '';
  let currentItems: ParagraphGroup['items'] = [];
  let prevWasEOL = false;
  for (const item of items) {
    const str = item.str ?? '';
    if (item.hasEOL) {
      if (prevWasEOL && currentText.trim().length > 0) {
        // paragraph break
        paragraphs.push({ text: currentText.trim(), items: currentItems });
        currentText = '';
        currentItems = [];
      }
      // single EOL: collapse to space for in-paragraph wrap
      currentText += str + ' ';
      // Preserve the item itself + a single-char space stand-in (str+' ')
      // for ratio bookkeeping; computeMonospaceRatio trims whitespace, so
      // the trailing space doesn't skew either way.
      if (str.length > 0) currentItems.push({ str, isMonospace: item.isMonospace });
      prevWasEOL = true;
    } else {
      currentText += str;
      if (str.length > 0) currentItems.push({ str, isMonospace: item.isMonospace });
      prevWasEOL = false;
    }
  }
  if (currentText.trim().length > 0) {
    paragraphs.push({ text: currentText.trim(), items: currentItems });
  }
  return paragraphs.filter((p) => p.text.length > 0);
}

/**
 * Extract the document outline (TOC) and flatten to a list of entries.
 *
 * pdfjs-dist's getOutline() returns a nested tree: `[{ title, dest, items }]`.
 * We DFS-flatten, recording depth. Each entry's `dest` is resolved to a
 * concrete page index via getPageIndex() (returns 0-based; we +1 for 1-based
 * pageNumber convention).
 *
 * Returns null when the PDF has no outline at all (most public-domain
 * scans + many self-published PDFs lack one); the caller falls through
 * to Tier 2 (heading-regex) or Tier 3 (single mega-chapter).
 */
async function extractOutline(pdfDoc: any): Promise<PdfOutlineEntry[] | null> {
  let outline: any;
  try {
    outline = await pdfDoc.getOutline();
  } catch {
    return null;
  }
  if (!outline || outline.length === 0) return null;

  const flat: PdfOutlineEntry[] = [];

  // DFS via a stack to avoid recursion stack issues on deep outlines.
  // Each stack entry: { node, depth }. We push children in reverse so
  // they pop in original order (DFS pre-order).
  const stack: Array<{ node: any; depth: number }> = [];
  for (let i = outline.length - 1; i >= 0; i--) stack.push({ node: outline[i], depth: 0 });

  while (stack.length > 0) {
    const popped = stack.pop();
    if (!popped) break; // type guard for noUncheckedIndexedAccess
    const { node, depth } = popped;
    const pageNumber = await resolveOutlineDest(pdfDoc, node);
    flat.push({
      title: typeof node.title === 'string' ? node.title.trim() : '',
      pageNumber,
      depth,
    });
    if (Array.isArray(node.items) && node.items.length > 0) {
      for (let i = node.items.length - 1; i >= 0; i--) {
        stack.push({ node: node.items[i], depth: depth + 1 });
      }
    }
  }

  return flat;
}

/**
 * Resolve a pdfjs outline node's destination to a 1-based page number.
 * Returns null on any resolution failure (broken bookmark, unsupported dest).
 */
async function resolveOutlineDest(pdfDoc: any, node: any): Promise<number | null> {
  try {
    let dest = node.dest;
    if (typeof dest === 'string') {
      dest = await pdfDoc.getDestination(dest);
    }
    if (!Array.isArray(dest) || dest.length === 0) return null;
    const ref = dest[0];
    const pageIndex0 = await pdfDoc.getPageIndex(ref);
    if (typeof pageIndex0 !== 'number' || pageIndex0 < 0) return null;
    return pageIndex0 + 1; // 0-based → 1-based
  } catch {
    return null;
  }
}
