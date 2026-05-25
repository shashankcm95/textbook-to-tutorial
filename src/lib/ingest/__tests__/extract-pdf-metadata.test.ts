// src/lib/ingest/__tests__/extract-pdf-metadata.test.ts
//
// Coverage strategy:
//   - sanitizeMetadataValue is a pure helper: exhaustive table-driven tests
//     for trim / normalize / garbage-rejection paths. Cheap, deterministic.
//   - extractPdfMetadata: we don't have a static PDF fixture in the repo,
//     so we mock pdfjs-dist's getDocument() to return synthetic info / XMP
//     payloads. This exercises the three-way fallback (Info → XMP → none),
//     the throws-protection contract, and the empty-buffer guard.
//
// The mock is hoisted (vi.mock) so the import in extract-pdf-metadata.ts
// resolves to our fake — must be declared BEFORE the SUT import.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// pdfjs-dist mock
// ---------------------------------------------------------------------------
//
// We expose a module-level `mockMetadata` that each test sets up before
// invoking the SUT. The fake getDocument returns a promise resolving to
// a fake document whose getMetadata() yields `mockMetadata`. The
// `mockThrowOnLoad` flag simulates an unreadable PDF.

let mockInfo: Record<string, unknown> | null = null;
let mockXmpMap: Record<string, unknown> | null = null;
let mockThrowOnLoad = false;
let mockThrowOnGetMetadata = false;

// DRIFT-022 regression: capture the `data` argument that the SUT passes to
// getDocument(). Tests can assert it is a fresh copy (not a view sharing
// the caller's underlying ArrayBuffer) — the original bug used `new
// Uint8Array(buf.buffer, offset, length)` which pdfjs-dist then DETACHED,
// leaving the worker's downstream parsePdfBuffer() with an empty input.
type CapturedGetDocOpts = { data?: Uint8Array };
let capturedGetDocOpts: CapturedGetDocOpts | null = null;

vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  GlobalWorkerOptions: { workerSrc: '' },
  getDocument: (opts: CapturedGetDocOpts) => {
    // DRIFT-022 regression hook: stash the opts the SUT passed in.
    capturedGetDocOpts = opts;
    return {
    promise: mockThrowOnLoad
      ? Promise.reject(new Error('synthetic getDocument failure'))
      : Promise.resolve({
          getMetadata: () =>
            mockThrowOnGetMetadata
              ? Promise.reject(new Error('synthetic getMetadata failure'))
              : Promise.resolve({
                  info: mockInfo,
                  metadata:
                    mockXmpMap === null
                      ? null
                      : {
                          get(key: string) {
                            return mockXmpMap![key];
                          },
                        },
                }),
          destroy: () => Promise.resolve(),
        }),
    };
  },
}));

// SUT must be imported AFTER vi.mock — vitest hoists mocks but the import
// order still matters for readability + lint clarity.
import {
  extractPdfMetadata,
  sanitizeMetadataValue,
} from '@/lib/ingest/extract-pdf-metadata';

// Helper: a non-empty Buffer that satisfies the entry guard. Content
// doesn't matter because pdfjs-dist is mocked.
function makeBuffer(): Buffer {
  return Buffer.from('not actually a PDF', 'utf8');
}

beforeEach(() => {
  mockInfo = null;
  mockXmpMap = null;
  mockThrowOnLoad = false;
  mockThrowOnGetMetadata = false;
  capturedGetDocOpts = null;
});

// ---------------------------------------------------------------------------
// sanitizeMetadataValue — pure helper
// ---------------------------------------------------------------------------

describe('sanitizeMetadataValue', () => {
  it('trims surrounding whitespace', () => {
    expect(sanitizeMetadataValue('  DDIA  ')).toBe('DDIA');
  });

  it('collapses internal whitespace runs', () => {
    expect(sanitizeMetadataValue('Designing   Data\tIntensive\n\nApps')).toBe(
      'Designing Data Intensive Apps',
    );
  });

  it('returns null for whitespace-only strings', () => {
    expect(sanitizeMetadataValue('   ')).toBeNull();
    expect(sanitizeMetadataValue('\t\n')).toBeNull();
  });

  it('returns null for empty strings', () => {
    expect(sanitizeMetadataValue('')).toBeNull();
  });

  it('returns null for non-string inputs', () => {
    expect(sanitizeMetadataValue(undefined)).toBeNull();
    expect(sanitizeMetadataValue(null)).toBeNull();
    expect(sanitizeMetadataValue(42)).toBeNull();
    expect(sanitizeMetadataValue({ title: 'X' })).toBeNull();
  });

  it('rejects (cid:NNN) font artifacts', () => {
    expect(sanitizeMetadataValue('Title with (cid:0) inside')).toBeNull();
    expect(sanitizeMetadataValue('(CID:123)')).toBeNull();
  });

  it('rejects authoring-tool default placeholders', () => {
    expect(sanitizeMetadataValue('Untitled')).toBeNull();
    expect(sanitizeMetadataValue('untitled')).toBeNull();
    expect(sanitizeMetadataValue('Microsoft Word - draft.docx')).toBeNull();
    expect(sanitizeMetadataValue('Document1')).toBeNull();
  });

  it('preserves real-world titles', () => {
    expect(
      sanitizeMetadataValue('Designing Data-Intensive Applications'),
    ).toBe('Designing Data-Intensive Applications');
    expect(sanitizeMetadataValue('Introduction to Algorithms, Fourth Edition')).toBe(
      'Introduction to Algorithms, Fourth Edition',
    );
  });

  it('normalizes unicode to NFC', () => {
    // "café" composed (NFC) vs decomposed (NFD) — both should yield the
    // same string output.
    const composed = 'café';
    const decomposed = 'café';
    expect(sanitizeMetadataValue(decomposed)).toBe(composed);
  });
});

// ---------------------------------------------------------------------------
// extractPdfMetadata — input guards
// ---------------------------------------------------------------------------

describe('extractPdfMetadata — input guards', () => {
  it('returns source=none for empty Buffer (does not throw)', async () => {
    const result = await extractPdfMetadata(Buffer.alloc(0));
    expect(result).toEqual({ title: null, author: null, source: 'none' });
  });

  it('returns source=none when buffer is not a Buffer (does not throw)', async () => {
    // @ts-expect-error — intentionally passing wrong shape
    const result = await extractPdfMetadata('not a buffer');
    expect(result).toEqual({ title: null, author: null, source: 'none' });
  });
});

// ---------------------------------------------------------------------------
// extractPdfMetadata — Tier 1: /Info dictionary
// ---------------------------------------------------------------------------

describe('extractPdfMetadata — /Info dict path', () => {
  it('extracts Title + Author from /Info when present', async () => {
    mockInfo = {
      Title: 'Designing Data-Intensive Applications',
      Author: 'Martin Kleppmann',
    };
    const result = await extractPdfMetadata(makeBuffer());
    expect(result).toEqual({
      title: 'Designing Data-Intensive Applications',
      author: 'Martin Kleppmann',
      source: 'pdf-info',
    });
  });

  it('returns source=pdf-info when only Title is present', async () => {
    mockInfo = { Title: 'Some Book' };
    const result = await extractPdfMetadata(makeBuffer());
    expect(result).toEqual({
      title: 'Some Book',
      author: null,
      source: 'pdf-info',
    });
  });

  it('returns source=pdf-info when only Author is present', async () => {
    mockInfo = { Author: 'Some Person' };
    const result = await extractPdfMetadata(makeBuffer());
    expect(result).toEqual({
      title: null,
      author: 'Some Person',
      source: 'pdf-info',
    });
  });

  it('trims whitespace from /Info values', async () => {
    mockInfo = { Title: '  DDIA  ', Author: '  Kleppmann  ' };
    const result = await extractPdfMetadata(makeBuffer());
    expect(result.title).toBe('DDIA');
    expect(result.author).toBe('Kleppmann');
  });

  it('rejects (cid:N) garbage values and falls through', async () => {
    mockInfo = { Title: '(cid:0)(cid:1)', Author: '(cid:42)' };
    // Falls through to XMP (also empty) → none.
    const result = await extractPdfMetadata(makeBuffer());
    expect(result).toEqual({ title: null, author: null, source: 'none' });
  });

  it('rejects Microsoft Word placeholders', async () => {
    mockInfo = { Title: 'Microsoft Word - draft.docx', Author: 'Untitled' };
    const result = await extractPdfMetadata(makeBuffer());
    expect(result).toEqual({ title: null, author: null, source: 'none' });
  });

  it('falls through to XMP when /Info is empty object', async () => {
    mockInfo = {};
    mockXmpMap = { 'dc:title': 'XMP Title', 'dc:creator': 'XMP Author' };
    const result = await extractPdfMetadata(makeBuffer());
    expect(result).toEqual({
      title: 'XMP Title',
      author: 'XMP Author',
      source: 'pdf-xmp',
    });
  });
});

// ---------------------------------------------------------------------------
// extractPdfMetadata — Tier 2: XMP fallback
// ---------------------------------------------------------------------------

describe('extractPdfMetadata — XMP path', () => {
  it('uses XMP when /Info is null', async () => {
    mockInfo = null;
    mockXmpMap = { 'dc:title': 'XMP Title', 'dc:creator': 'XMP Author' };
    const result = await extractPdfMetadata(makeBuffer());
    expect(result.source).toBe('pdf-xmp');
    expect(result.title).toBe('XMP Title');
    expect(result.author).toBe('XMP Author');
  });

  it('flattens dc:creator array (rdf:Seq) to comma-joined string', async () => {
    mockXmpMap = {
      'dc:title': 'Multi-Author Book',
      'dc:creator': ['Alice', 'Bob', 'Carol'],
    };
    const result = await extractPdfMetadata(makeBuffer());
    expect(result.author).toBe('Alice, Bob, Carol');
    expect(result.source).toBe('pdf-xmp');
  });

  it('handles language-tagged x-default values', async () => {
    mockXmpMap = {
      'dc:title': { 'x-default': 'Localized Title' },
      'dc:creator': 'Some Author',
    };
    const result = await extractPdfMetadata(makeBuffer());
    expect(result.title).toBe('Localized Title');
  });
});

// ---------------------------------------------------------------------------
// extractPdfMetadata — throws-protection contract
// ---------------------------------------------------------------------------

describe('extractPdfMetadata — throws-protection', () => {
  it('returns source=none when getDocument rejects (malformed PDF)', async () => {
    mockThrowOnLoad = true;
    const result = await extractPdfMetadata(makeBuffer());
    expect(result).toEqual({ title: null, author: null, source: 'none' });
  });

  it('returns source=none when getMetadata throws', async () => {
    mockThrowOnGetMetadata = true;
    const result = await extractPdfMetadata(makeBuffer());
    expect(result).toEqual({ title: null, author: null, source: 'none' });
  });

  it('returns source=none when both /Info and XMP are absent', async () => {
    mockInfo = null;
    mockXmpMap = null;
    const result = await extractPdfMetadata(makeBuffer());
    expect(result).toEqual({ title: null, author: null, source: 'none' });
  });
});

// ---------------------------------------------------------------------------
// DRIFT-022 regression — extractPdfMetadata must COPY (not view) its input
// ---------------------------------------------------------------------------
//
// The original bug:
//   const data = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
//
// That Uint8Array shares the caller's underlying ArrayBuffer. pdfjs-dist's
// real getDocument() then transfers / detaches the ArrayBuffer during load
// (Mozilla's parser code path is destructive). The caller's Buffer is left
// with its ArrayBuffer detached, so the worker's subsequent
// parsePdfBuffer(buf) call fails with "input is not a non-empty Buffer".
// Caught empirically during CTCI fresh-session ingest validation 2026-05-25
// (every non-cache-hit ingest hit it; cache-hit path was fine because parse
// is skipped).
//
// The fix:
//   const data = Uint8Array.from(buf);
//
// Uint8Array.from() iterates the source and writes into a FRESH ArrayBuffer.
// pdfjs may detach the copy; the caller's buffer is untouched.
//
// These tests assert the COPY contract by capturing the opts the SUT
// passes to getDocument() (via the module mock above) and checking
// (a) the data is non-empty and (b) it does NOT share the input's
// underlying ArrayBuffer.

describe('extractPdfMetadata — DRIFT-022 buffer-detach regression', () => {
  it('passes a fresh-buffer Uint8Array to getDocument (not a view)', async () => {
    const sentinelBytes = Uint8Array.of(0x25, 0x50, 0x44, 0x46, 0xde, 0xad, 0xbe, 0xef);
    const buf = Buffer.from(sentinelBytes);

    await extractPdfMetadata(buf);

    expect(capturedGetDocOpts).not.toBeNull();
    expect(capturedGetDocOpts!.data).toBeDefined();
    expect(capturedGetDocOpts!.data!.byteLength).toBe(sentinelBytes.byteLength);
    // The load-bearing check: a fresh copy is on a DIFFERENT ArrayBuffer.
    // A view would share the same .buffer reference.
    expect(capturedGetDocOpts!.data!.buffer).not.toBe(buf.buffer);
  });

  it('preserves caller buffer contents end-to-end', async () => {
    const sentinelBytes = Uint8Array.of(0x25, 0x50, 0x44, 0x46, 0x11, 0x22, 0x33);
    const buf = Buffer.from(sentinelBytes);
    const originalFirstByte = buf[0];
    const originalLength = buf.length;

    await extractPdfMetadata(buf);

    // Buffer remains fully readable for downstream parsePdfBuffer().
    expect(buf.length).toBe(originalLength);
    expect(buf[0]).toBe(originalFirstByte);
  });

  it('mutating the captured copy does not corrupt the input buffer', async () => {
    const buf = Buffer.from(Uint8Array.of(0xa1, 0xa2, 0xa3, 0xa4));

    await extractPdfMetadata(buf);

    expect(capturedGetDocOpts?.data).toBeDefined();
    // Mutate the copy — input buffer should be unaffected.
    capturedGetDocOpts!.data![0] = 0xff;
    expect(buf[0]).toBe(0xa1);
  });
});
