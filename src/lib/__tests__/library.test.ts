// src/lib/__tests__/library.test.ts
//
// Tests for the pure helpers in src/lib/library.ts.
//
// The DB-bound `loadLibrary` is NOT tested here — that path requires
// schema fixtures + a sqlite in-memory bootstrap that the existing test
// suite doesn't yet have plumbing for. Coverage at the SQL layer is
// reserved for a future integration test. The pure helpers below are
// where the bugs hide anyway (status mapping, S3 URL shape, sort
// comparator); the SQL is mostly a typed projection.

import { describe, it, expect } from 'vitest';
import {
  computeAggregateStatus,
  validateS3UrlShape,
  compareLibraryRows,
  deriveFallbackTitle,
  coerceTimestampToMs,
} from '../library';

// ─────────────────────────────────────────────────────────────────────────────
// computeAggregateStatus
// ─────────────────────────────────────────────────────────────────────────────

describe('computeAggregateStatus', () => {
  it('maps error status straight through', () => {
    expect(
      computeAggregateStatus({
        status: 'error',
        totalChapters: 10,
        completeChapters: 0,
        errorMessage: 'boom',
      }),
    ).toBe('error');
  });

  it('maps ingesting → ingesting', () => {
    expect(
      computeAggregateStatus({
        status: 'ingesting',
        totalChapters: null,
        completeChapters: 0,
        errorMessage: null,
      }),
    ).toBe('ingesting');
  });

  it('maps parsing → ingesting (same UX bucket as ingesting)', () => {
    expect(
      computeAggregateStatus({
        status: 'parsing',
        totalChapters: null,
        completeChapters: 0,
        errorMessage: null,
      }),
    ).toBe('ingesting');
  });

  it('maps ready-to-generate → generating', () => {
    expect(
      computeAggregateStatus({
        status: 'ready-to-generate',
        totalChapters: 40,
        completeChapters: 0,
        errorMessage: null,
      }),
    ).toBe('generating');
  });

  it('maps generating → generating', () => {
    expect(
      computeAggregateStatus({
        status: 'generating',
        totalChapters: 40,
        completeChapters: 5,
        errorMessage: null,
      }),
    ).toBe('generating');
  });

  it('maps complete + all chapters done → ready', () => {
    expect(
      computeAggregateStatus({
        status: 'complete',
        totalChapters: 5,
        completeChapters: 5,
        errorMessage: null,
      }),
    ).toBe('ready');
  });

  it('maps complete + some chapters left → partial', () => {
    // This is the load-bearing partial case: tutorials.status='complete'
    // means ingest+chunking is done, but the user may not have triggered
    // chapter generation for every chapter. UI nudges to resume.
    expect(
      computeAggregateStatus({
        status: 'complete',
        totalChapters: 60,
        completeChapters: 12,
        errorMessage: null,
      }),
    ).toBe('partial');
  });

  it('maps complete + zero total chapters → ready (degenerate)', () => {
    // Edge case: a tutorial with totalChapters=0 (no body chapters
    // detected) shouldn't render as 'partial' forever. Treat as ready.
    expect(
      computeAggregateStatus({
        status: 'complete',
        totalChapters: 0,
        completeChapters: 0,
        errorMessage: null,
      }),
    ).toBe('ready');
  });

  it('maps complete + null total chapters → ready (pre-parse)', () => {
    expect(
      computeAggregateStatus({
        status: 'complete',
        totalChapters: null,
        completeChapters: 0,
        errorMessage: null,
      }),
    ).toBe('ready');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// validateS3UrlShape
// ─────────────────────────────────────────────────────────────────────────────

describe('validateS3UrlShape', () => {
  it('accepts a well-formed s3:// URL', () => {
    expect(
      validateS3UrlShape('s3://textbooks-bucket/path/to/book.pdf'),
    ).toEqual({ ok: true });
  });

  it('accepts an s3:// URL with deeply-nested key path', () => {
    expect(
      validateS3UrlShape('s3://b/a/b/c/d/e/f.pdf'),
    ).toEqual({ ok: true });
  });

  it('rejects empty string', () => {
    const result = validateS3UrlShape('');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/empty/i);
  });

  it('rejects whitespace-only string', () => {
    const result = validateS3UrlShape('   ');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/empty/i);
  });

  it('rejects too-short input (under 8 chars after trim)', () => {
    const result = validateS3UrlShape('s3://a');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/too short/i);
  });

  it('rejects too-long input (over 2048 chars)', () => {
    const long = 's3://b/' + 'x'.repeat(2050);
    const result = validateS3UrlShape(long);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/too long/i);
  });

  it('rejects http:// (wrong scheme)', () => {
    const result = validateS3UrlShape('http://bucket.s3.amazonaws.com/k.pdf');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/s3:\/\//i);
  });

  it('rejects s3:// with no bucket (missing /key entirely)', () => {
    const result = validateS3UrlShape('s3:///key.pdf');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/bucket|key/i);
  });

  it('rejects s3://bucket (no /key separator)', () => {
    const result = validateS3UrlShape('s3://bucket');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/key/i);
  });

  it('rejects s3://bucket/ (trailing slash, no key)', () => {
    const result = validateS3UrlShape('s3://bucket/');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/empty|key/i);
  });

  it('trims surrounding whitespace before validating', () => {
    expect(
      validateS3UrlShape('  s3://b/k.pdf  '),
    ).toEqual({ ok: true });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// compareLibraryRows
// ─────────────────────────────────────────────────────────────────────────────

describe('compareLibraryRows', () => {
  it('sorts most-recently-viewed first', () => {
    const newer = { lastViewedAtMs: 2000, createdAtMs: 100 };
    const older = { lastViewedAtMs: 1000, createdAtMs: 200 };
    expect(compareLibraryRows(newer, older)).toBeLessThan(0);
    expect(compareLibraryRows(older, newer)).toBeGreaterThan(0);
  });

  it('treats null lastViewed as NULLS LAST', () => {
    const viewed = { lastViewedAtMs: 1000, createdAtMs: 100 };
    const never = { lastViewedAtMs: null, createdAtMs: 9999 };
    // viewed sorts BEFORE never even though never has newer createdAt.
    expect(compareLibraryRows(viewed, never)).toBeLessThan(0);
  });

  it('breaks ties on lastViewed using createdAt desc', () => {
    const a = { lastViewedAtMs: 1000, createdAtMs: 500 };
    const b = { lastViewedAtMs: 1000, createdAtMs: 200 };
    expect(compareLibraryRows(a, b)).toBeLessThan(0);
    expect(compareLibraryRows(b, a)).toBeGreaterThan(0);
  });

  it('breaks tie when both lastViewed are null', () => {
    const newer = { lastViewedAtMs: null, createdAtMs: 500 };
    const older = { lastViewedAtMs: null, createdAtMs: 200 };
    expect(compareLibraryRows(newer, older)).toBeLessThan(0);
  });

  it('returns 0 on exact equality', () => {
    const row = { lastViewedAtMs: 1000, createdAtMs: 500 };
    expect(compareLibraryRows(row, { ...row })).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// deriveFallbackTitle
// ─────────────────────────────────────────────────────────────────────────────

describe('deriveFallbackTitle', () => {
  it('extracts and de-URL-encodes a filename from a typical s3:// URL', () => {
    expect(
      deriveFallbackTitle(
        's3://textbooks-bucket/Designing+Data+Intensive+Applications.pdf',
      ),
    ).toBe('Designing Data Intensive Applications');
  });

  it('strips the .pdf extension case-insensitively', () => {
    expect(deriveFallbackTitle('s3://b/Book.PDF')).toBe('Book');
  });

  it('decodes %20 sequences', () => {
    expect(
      deriveFallbackTitle('s3://b/Hello%20World.pdf'),
    ).toBe('Hello World');
  });

  it('returns "(untitled tutorial)" for unparseable URLs', () => {
    expect(deriveFallbackTitle('not-an-s3-url')).toBe('(untitled tutorial)');
  });

  it('uses only the final path segment', () => {
    expect(
      deriveFallbackTitle('s3://b/prefix/sub/Final+Title.pdf'),
    ).toBe('Final Title');
  });

  it('survives malformed URL-encoding gracefully', () => {
    // %2 is invalid (% must be followed by 2 hex chars); decodeURIComponent
    // throws — we should fall back to the un-decoded form, not crash.
    expect(deriveFallbackTitle('s3://b/Bad%2.pdf')).toBe('Bad%2');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// coerceTimestampToMs
//
// Regression for the "Added NaN-NaN-NaN" bug observed in localhost 2026-05-27:
// `tutorials.created_at` is declared `integer mode='timestamp'` but defaults
// to SQLite's `CURRENT_TIMESTAMP` which actually stores TEXT like
// '2026-05-23 20:12:13'. Every existing row in the dev DB has `typeof = text`.
// Drizzle's coercion silently produced NaN; the card rendered NaN-NaN-NaN.
// ─────────────────────────────────────────────────────────────────────────────

describe('coerceTimestampToMs', () => {
  it('parses SQLite CURRENT_TIMESTAMP TEXT format as UTC', () => {
    const ms = coerceTimestampToMs('2026-05-23 20:12:13');
    expect(ms).not.toBeNull();
    // '2026-05-23T20:12:13Z' in ms — verified once, then compared exactly so
    // future date-engine quirks surface.
    expect(ms).toBe(Date.UTC(2026, 4, 23, 20, 12, 13));
  });

  it('accepts a Date instance', () => {
    const d = new Date('2026-01-01T00:00:00Z');
    expect(coerceTimestampToMs(d)).toBe(d.getTime());
  });

  it('treats a number under 1e12 as unix seconds and converts to ms', () => {
    // Unix seconds for 2026-01-01 ≈ 1.77e9
    const secs = 1_770_000_000;
    expect(coerceTimestampToMs(secs)).toBe(secs * 1000);
  });

  it('treats a number above 1e12 as ms already', () => {
    const ms = 1_770_000_000_000;
    expect(coerceTimestampToMs(ms)).toBe(ms);
  });

  it('returns null for null/undefined', () => {
    expect(coerceTimestampToMs(null)).toBeNull();
    expect(coerceTimestampToMs(undefined)).toBeNull();
  });

  it('returns null for unparseable strings', () => {
    expect(coerceTimestampToMs('not a date')).toBeNull();
    expect(coerceTimestampToMs('')).toBeNull();
    expect(coerceTimestampToMs('   ')).toBeNull();
  });

  it('returns null for non-finite numbers', () => {
    expect(coerceTimestampToMs(Number.NaN)).toBeNull();
    expect(coerceTimestampToMs(Number.POSITIVE_INFINITY)).toBeNull();
    expect(coerceTimestampToMs(-1)).toBeNull();
  });

  it('returns null for unsupported types', () => {
    expect(coerceTimestampToMs({})).toBeNull();
    expect(coerceTimestampToMs([])).toBeNull();
    expect(coerceTimestampToMs(true)).toBeNull();
  });

  it('returns null for an Invalid Date instance', () => {
    expect(coerceTimestampToMs(new Date('not a date'))).toBeNull();
  });

  it('handles an ISO 8601 string with explicit timezone', () => {
    const iso = '2026-05-23T20:12:13Z';
    expect(coerceTimestampToMs(iso)).toBe(Date.parse(iso));
  });
});
