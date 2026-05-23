// src/lib/ingest/__tests__/chapter-detect.test.ts — tier behavior tests.
//
// Tests the 3-tier cascade behavior:
//   - Tier 1 wins when outline exists with ≥3 entries
//   - Tier 2 wins when outline absent/shallow but heading regex matches ≥2 pages
//   - Tier 3 (mega) is the always-succeeding fall-through
//
// Synthetic ParsedPdf inputs only — no real PDF I/O here; that's an
// integration test concern (deferred). The contract this file enforces
// is the *cascade decision*, not the parse correctness.
//
// Per ari MEDIUM-2: the tier decision is load-bearing for the UI's
// confidence banner — if these tests pass we're confident the banner
// reflects the actual detection path.

import { describe, it, expect } from 'vitest';
import {
  detectFromOutline,
  detectFromHeadingRegex,
  singleMegaChapter,
  detectChapters,
} from '@/lib/pdf/chapter-detect';
import type { ParsedPdf, ParsedPage, PdfOutlineEntry } from '@/lib/pdf/parse';
import type { SourceParagraph } from '@/lib/types';

// ---------------------------------------------------------------------------
// Test helpers — build synthetic ParsedPdf inputs
// ---------------------------------------------------------------------------

function buildParagraph(page: number, idx: number, text: string): SourceParagraph {
  return { page, paragraphIdx: idx, text };
}

function buildPage(pageNumber: number, rawText: string): ParsedPage {
  // Split rawText on \n{2,} to derive paragraphs (mirrors parse.ts strategy 2).
  const paragraphs = rawText
    .split(/\n{2,}/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .map((text, idx) => buildParagraph(pageNumber, idx, text));
  return { pageNumber, rawText, paragraphs };
}

function buildParsedPdf(opts: {
  pages: ParsedPage[];
  outline?: PdfOutlineEntry[] | null;
  lowConfidenceScannedImage?: boolean;
}): ParsedPdf {
  return {
    pageCount: opts.pages.length,
    pages: opts.pages,
    outline: opts.outline ?? null,
    lowConfidenceScannedImage: opts.lowConfidenceScannedImage ?? false,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('detectFromOutline (Tier 1)', () => {
  it('returns chapters when outline has ≥3 depth-0 entries', () => {
    const outline: PdfOutlineEntry[] = [
      { title: 'Introduction', pageNumber: 1, depth: 0 },
      { title: 'Replication', pageNumber: 10, depth: 0 },
      { title: 'Synchronous vs Async', pageNumber: 12, depth: 1 }, // nested; filtered out
      { title: 'Consistency', pageNumber: 25, depth: 0 },
    ];
    const pages = [
      buildPage(1, 'Intro page text'),
      buildPage(10, 'Replication page text'),
      buildPage(25, 'Consistency page text'),
      buildPage(40, 'Trailing content'),
    ];
    const parsed = buildParsedPdf({ pages, outline });
    const result = detectFromOutline(parsed);
    expect(result).not.toBeNull();
    expect(result!.length).toBe(3);
    expect(result![0]!.title).toBe('Introduction');
    expect(result![0]!.pageStart).toBe(1);
    expect(result![0]!.pageEnd).toBe(9); // next chapter starts page 10
    expect(result![2]!.title).toBe('Consistency');
    expect(result![2]!.pageEnd).toBe(40); // last chapter spans to pageCount
  });

  it('returns null when outline has <3 top-level entries', () => {
    const outline: PdfOutlineEntry[] = [
      { title: 'Cover', pageNumber: 1, depth: 0 },
      { title: 'Body', pageNumber: 2, depth: 0 },
    ];
    const parsed = buildParsedPdf({
      pages: [buildPage(1, 'cover'), buildPage(2, 'body')],
      outline,
    });
    expect(detectFromOutline(parsed)).toBeNull();
  });

  it('returns null when outline is absent', () => {
    const parsed = buildParsedPdf({
      pages: [buildPage(1, 'no outline here')],
      outline: null,
    });
    expect(detectFromOutline(parsed)).toBeNull();
  });
});

describe('detectFromHeadingRegex (Tier 2)', () => {
  it('matches "Chapter N" pattern at page start', () => {
    const pages = [
      buildPage(1, 'Chapter 1 Introduction\n\nThe study of data systems...'),
      buildPage(5, 'continuation of chapter 1 body text'),
      buildPage(10, 'Chapter 2 Replication\n\nReplication is...'),
      buildPage(20, 'Chapter 3 Partitioning\n\nPartitioning...'),
    ];
    const parsed = buildParsedPdf({ pages, outline: null });
    const result = detectFromHeadingRegex(parsed);
    expect(result).not.toBeNull();
    expect(result!.length).toBe(3);
    expect(result![0]!.title).toContain('Chapter 1');
    expect(result![0]!.pageStart).toBe(1);
    expect(result![0]!.pageEnd).toBe(9);
    expect(result![2]!.pageEnd).toBe(20); // spans to pageCount
  });

  it('matches "Part I" and numbered "N. Title" patterns', () => {
    const pages = [
      buildPage(1, 'Part I Foundations\n\nbody'),
      buildPage(5, '1. Reliable Data Systems\n\nbody'),
      buildPage(15, 'Part II Distributed Systems\n\nbody'),
    ];
    const parsed = buildParsedPdf({ pages, outline: null });
    const result = detectFromHeadingRegex(parsed);
    expect(result).not.toBeNull();
    expect(result!.length).toBe(3);
  });

  it('returns null with fewer than 2 matches', () => {
    const pages = [
      buildPage(1, 'Just some random text starting the document'),
      buildPage(2, 'continuation page; no heading'),
      buildPage(3, 'Chapter 1 The Only One\n\nbody'), // only 1 match
    ];
    const parsed = buildParsedPdf({ pages, outline: null });
    expect(detectFromHeadingRegex(parsed)).toBeNull();
  });
});

describe('singleMegaChapter (Tier 3)', () => {
  it('returns one chapter spanning the full document', () => {
    const pages = [
      buildPage(1, 'page 1 paragraph 1\n\npage 1 paragraph 2'),
      buildPage(2, 'page 2 only paragraph'),
      buildPage(3, 'page 3 only paragraph'),
    ];
    const parsed = buildParsedPdf({ pages, outline: null });
    const result = singleMegaChapter(parsed);
    expect(result.length).toBe(1);
    expect(result[0]!.title).toBe('Full Document');
    expect(result[0]!.pageStart).toBe(1);
    expect(result[0]!.pageEnd).toBe(3);
    // 2 paragraphs on page 1 + 1 each on pages 2, 3 = 4 total
    expect(result[0]!.sourceParagraphs.length).toBe(4);
  });
});

describe('detectChapters orchestrator', () => {
  it('prefers outline (high confidence) when present', () => {
    const outline: PdfOutlineEntry[] = [
      { title: 'A', pageNumber: 1, depth: 0 },
      { title: 'B', pageNumber: 5, depth: 0 },
      { title: 'C', pageNumber: 10, depth: 0 },
    ];
    const pages = [
      // these would ALSO match Tier 2; outline wins anyway
      buildPage(1, 'Chapter 1 A\n\nbody'),
      buildPage(5, 'Chapter 2 B\n\nbody'),
      buildPage(10, 'Chapter 3 C\n\nbody'),
    ];
    const parsed = buildParsedPdf({ pages, outline });
    const result = detectChapters(parsed);
    expect(result.tier).toBe('outline');
    expect(result.confidence).toBe('high');
  });

  it('falls through to heading-regex (medium confidence) when outline absent', () => {
    const pages = [
      buildPage(1, 'Chapter 1 Intro\n\nbody'),
      buildPage(10, 'Chapter 2 More\n\nbody'),
    ];
    const parsed = buildParsedPdf({ pages, outline: null });
    const result = detectChapters(parsed);
    expect(result.tier).toBe('heading-regex');
    expect(result.confidence).toBe('medium');
  });

  it('falls through to mega chapter (low confidence) when no signal', () => {
    const pages = [
      buildPage(1, 'random text without any chapter markers'),
      buildPage(2, 'more random body content'),
    ];
    const parsed = buildParsedPdf({ pages, outline: null });
    const result = detectChapters(parsed);
    expect(result.tier).toBe('mega');
    expect(result.confidence).toBe('low');
    expect(result.chapters.length).toBe(1);
  });
});
