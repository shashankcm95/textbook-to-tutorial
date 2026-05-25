// src/lib/__tests__/env-max-pdf-bytes.test.ts
//
// PR-C (2026-05-25): regression test for the MAX_PDF_BYTES getter.
//
// Background: pre-PR-C, the ingest worker hardcoded `const MAX_PDF_BYTES =
// 50 * 1024 * 1024`. Operators with outsize books (CTCI 6th ed @ 52 MB,
// O'Reilly @ 80-100 MB) had to edit source. PR-C lifts the cap to env.
//
// After: MAX_PDF_BYTES is a getter on env that reads process.env fresh
// each access. Same shape as the Sprint E Tier 2 COST_CAP_USD getter.
// Invalid / blank / non-integer / non-positive values fall back to the
// boot-parsed default (50 MB).
//
// IMPORTANT: this test MUST be the first thing in this file that touches
// `process.env.MAX_PDF_BYTES`, and it MUST restore the original value in a
// finally block — other tests may rely on the boot value.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { env } from '../env';

const KEY = 'MAX_PDF_BYTES';
const DEFAULT_BYTES = 50 * 1024 * 1024;

let originalRaw: string | undefined;

beforeEach(() => {
  originalRaw = process.env[KEY];
});

afterEach(() => {
  if (originalRaw === undefined) {
    delete process.env[KEY];
  } else {
    process.env[KEY] = originalRaw;
  }
});

describe('env.MAX_PDF_BYTES getter (PR-C)', () => {
  it('reflects process.env mutation at access time', () => {
    process.env[KEY] = String(100 * 1024 * 1024); // 100 MB
    expect(env.MAX_PDF_BYTES).toBe(100 * 1024 * 1024);

    process.env[KEY] = String(80 * 1024 * 1024); // 80 MB
    expect(env.MAX_PDF_BYTES).toBe(80 * 1024 * 1024);
  });

  it('falls back to boot default (50 MB) when process.env value is removed', () => {
    process.env[KEY] = String(75 * 1024 * 1024);
    expect(env.MAX_PDF_BYTES).toBe(75 * 1024 * 1024);

    delete process.env[KEY];
    expect(env.MAX_PDF_BYTES).toBe(DEFAULT_BYTES);
  });

  it('falls back to default on empty string', () => {
    process.env[KEY] = '';
    expect(env.MAX_PDF_BYTES).toBe(DEFAULT_BYTES);
  });

  it('falls back to default on non-numeric input', () => {
    process.env[KEY] = 'banana';
    expect(env.MAX_PDF_BYTES).toBe(DEFAULT_BYTES);
  });

  it('falls back to default on zero or negative values (sentinel guard)', () => {
    // Negative / zero would short-circuit any real PDF — the getter
    // defends against operator typos that would silently brick ingest.
    process.env[KEY] = '0';
    expect(env.MAX_PDF_BYTES).toBe(DEFAULT_BYTES);

    process.env[KEY] = '-1';
    expect(env.MAX_PDF_BYTES).toBe(DEFAULT_BYTES);
  });

  it('falls back to default on non-integer (partial-byte typo)', () => {
    // 52428800.5 is nonsense; integer guard catches it.
    process.env[KEY] = '52428800.5';
    expect(env.MAX_PDF_BYTES).toBe(DEFAULT_BYTES);
  });

  it('accepts large positive integers (e.g., 200 MB)', () => {
    process.env[KEY] = String(200 * 1024 * 1024);
    expect(env.MAX_PDF_BYTES).toBe(200 * 1024 * 1024);
  });

  it('accepts the exact boot default value', () => {
    process.env[KEY] = String(DEFAULT_BYTES);
    expect(env.MAX_PDF_BYTES).toBe(DEFAULT_BYTES);
  });

  it('coexists with COST_CAP_USD getter (defineProperties parity check)', () => {
    // PR-C consolidated COST_CAP_USD + MAX_PDF_BYTES into a single
    // defineProperties call. This test guards against either getter
    // overwriting the other.
    process.env.COST_CAP_USD = '3.5';
    process.env[KEY] = String(75 * 1024 * 1024);

    expect(env.COST_CAP_USD).toBe(3.5);
    expect(env.MAX_PDF_BYTES).toBe(75 * 1024 * 1024);
  });
});
