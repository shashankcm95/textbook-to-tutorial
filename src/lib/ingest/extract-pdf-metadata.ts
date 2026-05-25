// src/lib/ingest/extract-pdf-metadata.ts — best-effort metadata extraction
// from a PDF buffer using pdfjs-dist's getMetadata() API.
//
// Why this exists: filename-heuristic attribution (see book-metadata.ts) is
// vulnerable to rename attacks — uploading "Some Other Book - Martin
// Kleppmann.pdf" silently misattributes authorship. The proper signal lives
// in the PDF's embedded metadata:
//
//   1. /Info dictionary  — pre-XMP standard, present in nearly every PDF
//      authored by Word/LaTeX/InDesign/etc. Keys: Title, Author, Subject,
//      Keywords, Creator, Producer.
//
//   2. XMP metadata stream — Adobe XMP (XML; rdf:Description). Keys:
//      dc:title, dc:creator, dc:description, etc. Preferred by modern
//      authoring tools but not universal in older PDFs.
//
// Strategy: try /Info first (highest hit rate), fall back to XMP, give up
// gracefully if neither yields usable values. Reject obvious garbage
// (cid: artifacts from missing-font glyphs, "Untitled" placeholder,
// whitespace-only) so callers can confidently flag the source as
// 'pdf-info' / 'pdf-xmp' for high-confidence attribution.
//
// Contract: NEVER throws. Best-effort path; ingest continues regardless.
//
// Design anchors:
//   - kb:architecture/discipline/stability-patterns §Fail-Open — metadata is
//     a quality-of-attribution signal, not a correctness signal. Throwing
//     here would break ingest for a quality bonus.
//   - kb:architecture/crosscut/single-responsibility — this module does
//     one thing: lift Title + Author from PDF metadata. It does NOT decide
//     how to display them (book-metadata.ts) and does NOT persist them
//     (worker.ts).

import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { join } from 'node:path';

// pdfjs-dist requires workerSrc set even on Node. parse.ts already configures
// this at module load, but this file may be imported in isolation (tests,
// scripts), so we self-configure idempotently. Setting twice is a no-op.
if (!GlobalWorkerOptions.workerSrc) {
  GlobalWorkerOptions.workerSrc = join(
    process.cwd(),
    'node_modules',
    'pdfjs-dist',
    'legacy',
    'build',
    'pdf.worker.mjs',
  );
}

export interface PdfMetadata {
  /** Trimmed, sanitized title — or null if no usable value found. */
  title: string | null;
  /** Trimmed, sanitized author — or null if no usable value found. */
  author: string | null;
  /**
   * Origin of the values:
   *   - 'pdf-info' — extracted from the /Info dictionary
   *   - 'pdf-xmp'  — extracted from the XMP metadata stream
   *   - 'none'     — no usable metadata; both fields are null
   */
  source: 'pdf-info' | 'pdf-xmp' | 'none';
}

// ---------------------------------------------------------------------------
// Sanitization helpers (exported for test reuse)
// ---------------------------------------------------------------------------

/**
 * Patterns that indicate a metadata value is junk and should be rejected:
 *   - `(cid:NNN)` artifacts from PDFs with missing font tables
 *   - Authoring-tool default placeholders ("Untitled", "Microsoft Word - ...")
 *   - Lone version strings or filenames the tool put there by default
 */
const GARBAGE_VALUE_PATTERNS: ReadonlyArray<RegExp> = [
  /\(cid:\d+\)/i,
  /^untitled$/i,
  /^microsoft\s+word\b/i,            // "Microsoft Word - document1.doc"
  /^document\d*$/i,                  // Word's "Document1" default
  /^\s*$/,                           // empty / whitespace-only
];

/**
 * Sanitize a raw metadata value:
 *   - Coerce non-string inputs to null (pdfjs sometimes returns undefined / objects)
 *   - Normalize unicode (NFC) to fold combining marks consistently
 *   - Trim outer whitespace and collapse runs of internal whitespace
 *   - Reject if matching a known-garbage pattern
 *
 * Returns null when the value is unusable; otherwise the cleaned string.
 */
export function sanitizeMetadataValue(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  // NFC normalization: PDFs from some sources encode accented chars as
  // base + combining mark; NFC composes them for stable comparison.
  const normalized = raw.normalize('NFC').replace(/\s+/g, ' ').trim();
  if (normalized.length === 0) return null;
  for (const pattern of GARBAGE_VALUE_PATTERNS) {
    if (pattern.test(normalized)) return null;
  }
  return normalized;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Extract title + author from a PDF buffer's embedded metadata.
 *
 * @param pdfBuffer  the raw PDF bytes (typically from `fetchPdfFromS3`)
 * @returns          `{title, author, source}` — values are null when not
 *                   derivable; `source` describes where the values came from.
 *
 * NEVER throws. On malformed PDF / unreadable metadata / pdfjs error,
 * returns `{title: null, author: null, source: 'none'}`.
 */
export async function extractPdfMetadata(pdfBuffer: Buffer): Promise<PdfMetadata> {
  // Defense: bad input → no metadata. Don't surface buffer-shape errors.
  if (!Buffer.isBuffer(pdfBuffer) || pdfBuffer.length === 0) {
    return { title: null, author: null, source: 'none' };
  }

  let pdfDoc;
  try {
    const data = new Uint8Array(
      pdfBuffer.buffer,
      pdfBuffer.byteOffset,
      pdfBuffer.byteLength,
    );
    const loadingTask = getDocument({
      data,
      verbosity: 0,
      disableFontFace: true,
      useSystemFonts: false,
      isEvalSupported: false,
    });
    pdfDoc = await loadingTask.promise;
  } catch {
    // Unreadable PDF — caller (worker) will hit the same failure in
    // parsePdfBuffer() and surface it through the normal error path.
    return { title: null, author: null, source: 'none' };
  }

  let raw: { info?: unknown; metadata?: unknown };
  try {
    // pdfjs-dist getMetadata() returns:
    //   { info: { Title?, Author?, ... }, metadata: Metadata | null }
    // where `metadata` (when present) is a Metadata object exposing
    // .get('dc:title'), .get('dc:creator'), etc.
    raw = (await pdfDoc.getMetadata()) as { info?: unknown; metadata?: unknown };
  } catch {
    return { title: null, author: null, source: 'none' };
  } finally {
    // Best-effort cleanup; pdfjs holds the parsed document in memory.
    // destroy() returns a promise but we don't need to await it here —
    // any GC-pressure tuning lives at the worker level.
    try {
      void pdfDoc.destroy?.();
    } catch {
      // ignore
    }
  }

  // ── Tier 1: /Info dictionary ────────────────────────────────────────────
  const infoTitle = extractFromInfo(raw.info, 'Title');
  const infoAuthor = extractFromInfo(raw.info, 'Author');
  if (infoTitle !== null || infoAuthor !== null) {
    return { title: infoTitle, author: infoAuthor, source: 'pdf-info' };
  }

  // ── Tier 2: XMP metadata stream ─────────────────────────────────────────
  const xmpTitle = extractFromXmp(raw.metadata, 'dc:title');
  const xmpAuthor = extractFromXmp(raw.metadata, 'dc:creator');
  if (xmpTitle !== null || xmpAuthor !== null) {
    return { title: xmpTitle, author: xmpAuthor, source: 'pdf-xmp' };
  }

  return { title: null, author: null, source: 'none' };
}

// ---------------------------------------------------------------------------
// Tier-specific extractors (file-private; one reason to change each)
// ---------------------------------------------------------------------------

/**
 * Pull a key from pdfjs's /Info dict shape. The `info` value is an opaque
 * object on the pdfjs side (no public type); we duck-type defensively.
 */
function extractFromInfo(info: unknown, key: string): string | null {
  if (info === null || typeof info !== 'object') return null;
  const value = (info as Record<string, unknown>)[key];
  return sanitizeMetadataValue(value);
}

/**
 * Pull a key from the XMP metadata stream. pdfjs's Metadata exposes
 * `.get(name)` and `.getAll()`. We try .get first; XMP arrays (e.g.
 * dc:creator can be an rdf:Seq of multiple authors) collapse to a single
 * comma-joined string for display parity with the /Info path.
 */
function extractFromXmp(metadata: unknown, key: string): string | null {
  if (metadata === null || typeof metadata !== 'object') return null;
  const m = metadata as { get?: (k: string) => unknown };
  if (typeof m.get !== 'function') return null;
  let raw: unknown;
  try {
    raw = m.get(key);
  } catch {
    return null;
  }
  // XMP values can be strings, arrays (rdf:Seq), or { 'x-default': '...' }
  // language-tagged maps. Flatten to a single string before sanitizing.
  let flattened: string | null = null;
  if (typeof raw === 'string') {
    flattened = raw;
  } else if (Array.isArray(raw)) {
    flattened = raw.filter((v) => typeof v === 'string' && v.trim().length > 0).join(', ');
  } else if (raw !== null && typeof raw === 'object') {
    const lang = (raw as Record<string, unknown>)['x-default'];
    if (typeof lang === 'string') flattened = lang;
  }
  return sanitizeMetadataValue(flattened);
}
