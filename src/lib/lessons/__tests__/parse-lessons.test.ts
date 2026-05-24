// src/lib/lessons/__tests__/parse-lessons.test.ts
//
// Tests for the lesson parser (Feature A — multipage chapters).
//
// The load-bearing invariant: every input — well-formed, malformed, or
// pre-Feature-A — must produce a non-empty Lesson[] so the UI never
// receives an empty array. The fallback ("one chapter = one lesson") is
// the contract that lets us deploy Feature A without migrating existing
// chapter rows.

import { describe, it, expect } from 'vitest';
import { parseLessons, countLessons } from '../parse-lessons';

describe('parseLessons — happy path (3-5 lessons)', () => {
  it('splits a 3-lesson narrative on header boundaries', () => {
    const narrative = [
      '## Lesson 1: Motivating the Problem',
      '',
      'First lesson body explaining the why.',
      '',
      '## Lesson 2: Measuring Performance',
      '',
      'Second lesson body about percentiles.',
      'With multiple paragraphs.',
      '',
      '## Lesson 3: Tradeoffs and Synthesis',
      '',
      'Third lesson body wrapping it up.',
    ].join('\n');

    const result = parseLessons(narrative);
    expect(result).toHaveLength(3);
    expect(result[0]?.ordinal).toBe(1);
    expect(result[0]?.title).toBe('Motivating the Problem');
    expect(result[0]?.body).toBe('First lesson body explaining the why.');
    expect(result[1]?.ordinal).toBe(2);
    expect(result[1]?.title).toBe('Measuring Performance');
    expect(result[1]?.body).toContain('percentiles');
    expect(result[1]?.body).toContain('multiple paragraphs');
    expect(result[2]?.title).toBe('Tradeoffs and Synthesis');
    expect(result[2]?.body).toBe('Third lesson body wrapping it up.');
  });

  it('preserves ### subheadings, lists, and citations within lesson bodies', () => {
    const narrative = [
      '## Lesson 1: Concrete Anchors',
      '',
      '### A subsection',
      '',
      'Body text with [ref:page12:paragraph3] citation.',
      '- item 1',
      '- item 2',
      '',
      '## Lesson 2: More',
      '',
      'Second body.',
    ].join('\n');

    const result = parseLessons(narrative);
    expect(result).toHaveLength(2);
    expect(result[0]?.body).toContain('### A subsection');
    expect(result[0]?.body).toContain('[ref:page12:paragraph3]');
    expect(result[0]?.body).toContain('- item 1');
  });
});

describe('parseLessons — fallback contract (the load-bearing invariant)', () => {
  it('returns single-lesson when narrative has zero markers (pre-Feature-A v3 chapters)', () => {
    const narrative = [
      'A plain chapter narrative without lesson markers.',
      '',
      '## Some Other Heading',
      '',
      'This was generated under the v3 prompt that did not require lessons.',
    ].join('\n');

    const result = parseLessons(narrative);
    expect(result).toHaveLength(1);
    expect(result[0]?.ordinal).toBe(1);
    expect(result[0]?.title).toBe('Chapter');
    expect(result[0]?.body).toContain('plain chapter narrative');
    expect(result[0]?.body).toContain('## Some Other Heading');
  });

  it('returns single-lesson when narrative has exactly ONE marker (no benefit to splitting)', () => {
    // Defensive: 1 marker means we have no boundary to split on usefully —
    // the prompt was supposed to emit 3-5. Treat as malformed; fall back.
    const narrative = [
      '## Lesson 1: Only One',
      '',
      'A solo lesson body — but no second marker to define the end.',
    ].join('\n');

    const result = parseLessons(narrative);
    expect(result).toHaveLength(1);
    // Fallback returns the WHOLE narrative under the synthetic "Chapter" title
    expect(result[0]?.title).toBe('Chapter');
    expect(result[0]?.body).toContain('## Lesson 1: Only One');
  });

  it('returns single-lesson for empty narrative', () => {
    const result = parseLessons('');
    expect(result).toHaveLength(1);
    expect(result[0]?.body).toBe('');
  });

  it('discards prose before the first lesson header (no lesson-zero leak)', () => {
    const narrative = [
      'Some accidental preamble the LLM emitted despite the prompt forbidding it.',
      '',
      '## Lesson 1: Real Start',
      '',
      'Real lesson body.',
      '',
      '## Lesson 2: Continued',
      '',
      'Second lesson body.',
    ].join('\n');

    const result = parseLessons(narrative);
    expect(result).toHaveLength(2);
    expect(result[0]?.body).not.toContain('accidental preamble');
    expect(result[0]?.body).toBe('Real lesson body.');
  });
});

describe('parseLessons — adversarial input', () => {
  it('tolerates non-sequential ordinals (e.g., Lesson 1, Lesson 3, Lesson 4)', () => {
    // The LLM mis-numbers but we preserve order — UI navigates by array
    // index, not by `ordinal` field.
    const narrative = [
      '## Lesson 1: First',
      '',
      'one',
      '',
      '## Lesson 3: Skipped Two',
      '',
      'three',
      '',
      '## Lesson 4: Continued',
      '',
      'four',
    ].join('\n');

    const result = parseLessons(narrative);
    expect(result).toHaveLength(3);
    expect(result.map((l) => l.ordinal)).toEqual([1, 3, 4]);
    expect(result.map((l) => l.title)).toEqual(['First', 'Skipped Two', 'Continued']);
  });

  it('ignores lines that look like lesson headers but are mid-paragraph (no false matches)', () => {
    // `## Lesson` at start-of-line is the contract; mid-paragraph occurrences
    // do not split. The `^` anchor in the regex enforces this.
    const narrative = [
      '## Lesson 1: Real',
      '',
      'Body mentioning "see ## Lesson 2: hypothetical" inline; this should NOT split.',
      '',
      '## Lesson 2: Actually Second',
      '',
      'Real second lesson.',
    ].join('\n');

    const result = parseLessons(narrative);
    expect(result).toHaveLength(2);
    expect(result[0]?.body).toContain('hypothetical');
    expect(result[1]?.body).toBe('Real second lesson.');
  });

  it('handles trailing whitespace + extra blank lines between lessons', () => {
    const narrative = [
      '## Lesson 1: A   ',  // trailing spaces in header
      '',
      '',
      'body a',
      '',
      '',
      '## Lesson 2: B',
      '',
      'body b   ',  // trailing spaces in body
      '',
      '',
    ].join('\n');

    const result = parseLessons(narrative);
    expect(result).toHaveLength(2);
    expect(result[0]?.title).toBe('A');
    expect(result[0]?.body).toBe('body a');
    expect(result[1]?.body).toBe('body b');
  });
});

describe('countLessons', () => {
  it('counts the lesson markers without allocating Lesson[]', () => {
    const narrative = [
      '## Lesson 1: A',
      'body',
      '## Lesson 2: B',
      'body',
      '## Lesson 3: C',
      'body',
    ].join('\n');
    expect(countLessons(narrative)).toBe(3);
  });

  it('returns 1 when zero markers (matches parseLessons fallback)', () => {
    expect(countLessons('plain text')).toBe(1);
  });

  it('returns 1 when exactly one marker (matches parseLessons fallback)', () => {
    expect(countLessons('## Lesson 1: alone\nbody')).toBe(1);
  });

  it('returns 1 for empty input', () => {
    expect(countLessons('')).toBe(1);
  });
});
