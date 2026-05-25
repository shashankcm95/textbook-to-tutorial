// src/components/__tests__/TutorialOutline.part-prefix-regex.test.ts
//
// Pure unit test for the PART_PREFIX_RE regex exported from TutorialOutline.
//
// The regex is the gating signal for the Part-grouping branch of the outline
// sidebar. A regression here silently collapses Part-grouped books back into
// the "All chapters" flat-list fallback — the exact UX regression CTCI hit
// before Sprint E Tier 1 fixed the bare-Roman case.
//
// Sprint E Tier 1 contract:
//   - "Part I." (DDIA convention)                  → matches, captures "Part I"
//   - "I. The Interview Process" (CTCI convention) → matches, bare-numeral "I"
//   - "II. Bar" (bare-Roman, multi-letter)         → matches, bare-numeral "II"
//   - "Chapter 1" (Arabic + word)                  → MUST NOT match
//   - "Iota" (Roman letter starts an English word) → MUST NOT match (no separator)
//   - "Ivory tower"                                → MUST NOT match (no separator)
//
// Why pure regex test (no React rendering): the harness-level OS file-block
// on better-sqlite3/openai bindings makes any test that loads the full app
// graph wedge. This test imports only the regex constant.

import { describe, it, expect } from 'vitest';
import { PART_PREFIX_RE } from '../TutorialOutline';

describe('PART_PREFIX_RE — explicit "Part I." prefix (DDIA convention)', () => {
  it('matches "Part I. Foundations of Data Systems"', () => {
    const m = 'Part I. Foundations of Data Systems'.match(PART_PREFIX_RE);
    expect(m).not.toBeNull();
    expect(m?.[1]).toBe('Part I');
  });

  it('matches "Part II. Distributed Data"', () => {
    const m = 'Part II. Distributed Data'.match(PART_PREFIX_RE);
    expect(m).not.toBeNull();
    expect(m?.[1]).toBe('Part II');
  });

  it('matches "Part III. Derived Data"', () => {
    const m = 'Part III. Derived Data'.match(PART_PREFIX_RE);
    expect(m).not.toBeNull();
    expect(m?.[1]).toBe('Part III');
  });
});

describe('PART_PREFIX_RE — bare-Roman prefix (CTCI convention, Sprint E Tier 1)', () => {
  it('matches "I. The Interview Process"', () => {
    const m = 'I. The Interview Process'.match(PART_PREFIX_RE);
    expect(m).not.toBeNull();
    // bare-Roman branch — explicit Part group undefined; numeral captured in group 3.
    expect(m?.[1]).toBeUndefined();
    expect(m?.[3]).toBe('I');
  });

  it('matches "II. Behind the Scenes"', () => {
    const m = 'II. Behind the Scenes'.match(PART_PREFIX_RE);
    expect(m).not.toBeNull();
    expect(m?.[3]).toBe('II');
  });

  it('matches "IV: Additional Review Problems" (colon separator)', () => {
    const m = 'IV: Additional Review Problems'.match(PART_PREFIX_RE);
    expect(m).not.toBeNull();
    expect(m?.[3]).toBe('IV');
  });
});

describe('PART_PREFIX_RE — false-positive guards', () => {
  it('does NOT match "Chapter 1: Introduction"', () => {
    expect('Chapter 1: Introduction'.match(PART_PREFIX_RE)).toBeNull();
  });

  it('does NOT match "Iota" (Roman letter starts an English word, no separator)', () => {
    expect('Iota'.match(PART_PREFIX_RE)).toBeNull();
  });

  it('does NOT match "Ivory tower" (Roman letter starts an English word)', () => {
    expect('Ivory tower'.match(PART_PREFIX_RE)).toBeNull();
  });

  it('does NOT match "Visualizing Data" (V starts an English word)', () => {
    expect('Visualizing Data'.match(PART_PREFIX_RE)).toBeNull();
  });

  it('does NOT match "1. Algorithms" (Arabic numeral)', () => {
    expect('1. Algorithms'.match(PART_PREFIX_RE)).toBeNull();
  });

  it('does NOT match "" (empty title)', () => {
    expect(''.match(PART_PREFIX_RE)).toBeNull();
  });
});
