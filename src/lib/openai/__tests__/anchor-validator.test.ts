// src/lib/openai/__tests__/anchor-validator.test.ts
//
// Tests for the pure anchor-coverage validator (Feature B', Component 4).
//
// The validator is load-bearing for the fidelity-scoring path: a false
// positive (validator reports "anchor kept" when it wasn't) silently
// inflates the score and lets drift accumulate; a false negative
// (validator reports "anchor missing" when it was actually kept under
// trivially different casing) triggers spurious regeneration and burns
// tokens. Both regressions land here as test failures.
//
// See src/lib/openai/anchor-validator.ts for the contract.

import { describe, it, expect } from 'vitest';
import {
  validateAnchors,
  containsAnchor,
  type AnchorWhitelistEntry,
} from '../anchor-validator';
import type { SourceParagraph } from '@/lib/types';

// ───────────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────────

function mkAnchor(
  term: string,
  category: AnchorWhitelistEntry['category'] = 'search-term',
  frequency = 1,
): AnchorWhitelistEntry {
  return {
    term,
    category,
    frequency_in_source: frequency,
    first_seen_at: '2026-05-24T00:00:00.000Z',
  };
}

function mkParagraph(text: string, page = 1, idx = 0): SourceParagraph {
  return { page, paragraphIdx: idx, text };
}

// ───────────────────────────────────────────────────────────────────────────
// containsAnchor — the word-boundary helper
// ───────────────────────────────────────────────────────────────────────────

describe('containsAnchor — word-boundary semantics', () => {
  it('matches a standalone word case-insensitively', () => {
    expect(containsAnchor('We deploy RAID arrays', 'RAID')).toBe(true);
    expect(containsAnchor('we deploy raid arrays', 'RAID')).toBe(true);
    expect(containsAnchor('We deploy RAID arrays', 'raid')).toBe(true);
  });

  it('rejects substring matches inside a larger word', () => {
    // The classic "RAID inside afraid" false-positive.
    expect(containsAnchor('They were afraid of arrays', 'RAID')).toBe(false);
    // Substring "Brooks" inside "Brookside".
    expect(containsAnchor('Visit Brookside today', 'Brooks')).toBe(false);
    // Contrived but exercises the rule: "yQL" inside "MySQL" must NOT match.
    expect(containsAnchor('We use MySQL in prod', 'yQL')).toBe(false);
  });

  it('matches at the start and end of the string', () => {
    expect(containsAnchor('RAID is great', 'RAID')).toBe(true);
    expect(containsAnchor('we love RAID', 'RAID')).toBe(true);
    expect(containsAnchor('RAID', 'RAID')).toBe(true);
  });

  it('treats punctuation as a word boundary', () => {
    expect(containsAnchor('RAID, however, has tradeoffs.', 'RAID')).toBe(true);
    expect(containsAnchor('(RAID)', 'RAID')).toBe(true);
    expect(containsAnchor('"RAID"', 'RAID')).toBe(true);
  });

  it('matches multi-word anchors verbatim', () => {
    expect(
      containsAnchor('uses head-of-line blocking semantics', 'head-of-line blocking'),
    ).toBe(true);
    expect(containsAnchor('the Chaos Monkey killed it', 'chaos monkey')).toBe(true);
  });

  it('escapes regex metacharacters in the anchor term', () => {
    // Anchor with parens, apostrophe, period, digits — all metachars.
    const haystack = "We cite Brewer's CAP (1999) here.";
    expect(containsAnchor(haystack, "Brewer's CAP (1999)")).toBe(true);
    // And ensure absence is correctly reported.
    expect(containsAnchor('We cite the CAP theorem here.', "Brewer's CAP (1999)")).toBe(
      false,
    );
  });

  it('returns false for empty anchor', () => {
    expect(containsAnchor('any text', '')).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// validateAnchors — main contract
// ───────────────────────────────────────────────────────────────────────────

describe('validateAnchors — happy path', () => {
  it('5 anchors in source, narrative drops 2 → score 0.6', () => {
    const whitelist = [
      mkAnchor('RAID'),
      mkAnchor('Chaos Monkey'),
      mkAnchor('head-of-line blocking'),
      mkAnchor('Paxos'),
      mkAnchor('Bigtable'),
    ];
    const sourceParagraphs = [
      mkParagraph('RAID gives durability; Chaos Monkey tests it.'),
      mkParagraph('head-of-line blocking is a tail-latency cause.'),
      mkParagraph('Paxos and Bigtable are landmark systems.'),
    ];
    // Narrative keeps RAID, Chaos Monkey, Paxos — drops head-of-line blocking + Bigtable.
    const narrative =
      'RAID supplies durability. Chaos Monkey verifies failure modes. ' +
      'Paxos is the consensus reference point.';

    const result = validateAnchors({ narrative, sourceParagraphs, whitelist });

    expect(result.expected.map((a) => a.term)).toEqual([
      'RAID',
      'Chaos Monkey',
      'head-of-line blocking',
      'Paxos',
      'Bigtable',
    ]);
    expect(result.found.map((a) => a.term)).toEqual(['RAID', 'Chaos Monkey', 'Paxos']);
    expect(result.missing.map((a) => a.term)).toEqual([
      'head-of-line blocking',
      'Bigtable',
    ]);
    expect(result.score).toBeCloseTo(0.6, 10);
  });
});

describe('validateAnchors — vacuous-perfect cases', () => {
  it('empty whitelist → score 1.0, empty arrays', () => {
    const result = validateAnchors({
      narrative: 'anything',
      sourceParagraphs: [mkParagraph('anything')],
      whitelist: [],
    });
    expect(result.expected).toEqual([]);
    expect(result.found).toEqual([]);
    expect(result.missing).toEqual([]);
    expect(result.score).toBe(1.0);
  });

  it('whitelist non-empty but none appear in source → score 1.0', () => {
    const result = validateAnchors({
      narrative: 'a narrative with no anchors at all',
      sourceParagraphs: [mkParagraph('source text without any anchors')],
      whitelist: [mkAnchor('Paxos'), mkAnchor('Bigtable')],
    });
    expect(result.expected).toEqual([]);
    expect(result.found).toEqual([]);
    expect(result.missing).toEqual([]);
    expect(result.score).toBe(1.0);
  });

  it('empty sourceParagraphs → score 1.0 regardless of whitelist', () => {
    const result = validateAnchors({
      narrative: 'a narrative mentioning RAID and Paxos',
      sourceParagraphs: [],
      whitelist: [mkAnchor('RAID'), mkAnchor('Paxos')],
    });
    expect(result.expected).toEqual([]);
    expect(result.score).toBe(1.0);
  });
});

describe('validateAnchors — extreme coverage', () => {
  it('all anchors present in source AND narrative → score 1.0, no missing', () => {
    const whitelist = [mkAnchor('RAID'), mkAnchor('Paxos'), mkAnchor('Bigtable')];
    const sourceParagraphs = [
      mkParagraph('RAID + Paxos + Bigtable are all in here.'),
    ];
    const narrative = 'We discuss RAID, then Paxos, then Bigtable in detail.';

    const result = validateAnchors({ narrative, sourceParagraphs, whitelist });

    expect(result.expected).toHaveLength(3);
    expect(result.found).toHaveLength(3);
    expect(result.missing).toEqual([]);
    expect(result.score).toBe(1.0);
  });

  it('all source anchors absent from narrative → score 0, all missing', () => {
    const whitelist = [mkAnchor('RAID'), mkAnchor('Paxos'), mkAnchor('Bigtable')];
    const sourceParagraphs = [
      mkParagraph('RAID + Paxos + Bigtable are all in here.'),
    ];
    const narrative = 'A vague narrative about distributed systems generally.';

    const result = validateAnchors({ narrative, sourceParagraphs, whitelist });

    expect(result.expected.map((a) => a.term)).toEqual(['RAID', 'Paxos', 'Bigtable']);
    expect(result.found).toEqual([]);
    expect(result.missing.map((a) => a.term)).toEqual(['RAID', 'Paxos', 'Bigtable']);
    expect(result.score).toBe(0);
  });

  it('empty narrative with non-empty expected → score 0', () => {
    const whitelist = [mkAnchor('RAID')];
    const sourceParagraphs = [mkParagraph('RAID is mentioned in source.')];
    const result = validateAnchors({
      narrative: '',
      sourceParagraphs,
      whitelist,
    });
    expect(result.expected).toHaveLength(1);
    expect(result.missing).toHaveLength(1);
    expect(result.score).toBe(0);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Word-boundary correctness in the full validator (not just the helper)
// ───────────────────────────────────────────────────────────────────────────

describe('validateAnchors — word-boundary correctness', () => {
  it('narrative containing "afraid" does NOT count as containing anchor "RAID"', () => {
    const whitelist = [mkAnchor('RAID')];
    const sourceParagraphs = [
      mkParagraph('RAID is the canonical durability mechanism.'),
    ];
    // Narrative mentions "afraid" but never the standalone token "RAID".
    const narrative = 'Engineers were afraid of disk failures and built redundancy.';

    const result = validateAnchors({ narrative, sourceParagraphs, whitelist });

    expect(result.expected.map((a) => a.term)).toEqual(['RAID']);
    expect(result.found).toEqual([]);
    expect(result.missing.map((a) => a.term)).toEqual(['RAID']);
    expect(result.score).toBe(0);
  });

  it('narrative containing "MySQL" does NOT count as containing anchor "yQL"', () => {
    // Source must contain the anchor too (otherwise it'd be filtered out
    // at step 1). We construct source text where "yQL" appears as a
    // standalone token so it lands in `expected`.
    const whitelist = [mkAnchor('yQL')];
    const sourceParagraphs = [mkParagraph('the yQL dialect is documented here.')];
    const narrative = 'We deploy MySQL in production.';

    const result = validateAnchors({ narrative, sourceParagraphs, whitelist });

    expect(result.expected).toHaveLength(1);
    expect(result.found).toEqual([]);
    expect(result.missing).toHaveLength(1);
  });

  it('hyphenated multi-word anchor matches verbatim across hyphens + space', () => {
    const whitelist = [mkAnchor('head-of-line blocking')];
    const sourceParagraphs = [
      mkParagraph('Tail latency comes from head-of-line blocking on shared queues.'),
    ];
    const narrative = 'The chapter explains head-of-line blocking in TCP.';

    const result = validateAnchors({ narrative, sourceParagraphs, whitelist });

    expect(result.expected).toHaveLength(1);
    expect(result.found).toHaveLength(1);
    expect(result.missing).toEqual([]);
    expect(result.score).toBe(1.0);
  });

  it('case-insensitive: narrative "Chaos Monkey" matches anchor "chaos monkey"', () => {
    const whitelist = [mkAnchor('chaos monkey')];
    const sourceParagraphs = [
      mkParagraph('Netflix runs chaos monkey across its fleet.'),
    ];
    const narrative = 'The Chaos Monkey program injects failures.';

    const result = validateAnchors({ narrative, sourceParagraphs, whitelist });

    expect(result.expected).toHaveLength(1);
    expect(result.found).toHaveLength(1);
    expect(result.score).toBe(1.0);
  });

  it('anchor with regex metacharacters does not blow up the regex compile', () => {
    const anchor = "Brewer's CAP (1999)";
    const whitelist = [mkAnchor(anchor, 'named-paper')];
    const sourceParagraphs = [
      mkParagraph("The canonical reference is Brewer's CAP (1999) keynote."),
    ];
    const narrative = "We anchor on Brewer's CAP (1999) throughout this chapter.";

    // The bug we're guarding against: an unescaped `(` would either throw
    // SyntaxError at RegExp construction or silently change semantics
    // (capture group + alternation). We assert it neither throws nor
    // mis-classifies.
    expect(() =>
      validateAnchors({ narrative, sourceParagraphs, whitelist }),
    ).not.toThrow();

    const result = validateAnchors({ narrative, sourceParagraphs, whitelist });
    expect(result.expected).toHaveLength(1);
    expect(result.found).toHaveLength(1);
    expect(result.score).toBe(1.0);
  });

  // Wave-1 review HIGH H1: digit-as-non-boundary false positive
  it('anchor "p99" does NOT match haystack containing only "p99.9" (digit-suffix guard)', () => {
    // Both anchors appear in DDIA literature as distinct metrics:
    //   p99   = 99th percentile latency
    //   p99.9 = 99.9th percentile latency ("three nines")
    // A narrative mentioning only p99.9 must NOT be credited with mentioning p99.
    expect(containsAnchor('tail p99.9 latency is 500ms', 'p99')).toBe(false);
    // But p99 alone (no .digit) SHOULD match.
    expect(containsAnchor('tail p99 latency is 500ms', 'p99')).toBe(true);
    // And p99.9 anchor against p99.9 haystack should match (full literal).
    expect(containsAnchor('tail p99.9 latency is 500ms', 'p99.9')).toBe(true);
  });

  // Wave-1 review HIGH H2: hyphen-as-non-boundary false positive
  it('anchor "C++" does NOT match haystack containing only "Objective-C++" (hyphen-prefix guard)', () => {
    // Objective-C++ is a distinct language from C++; a narrative about
    // Objective-C++ must NOT be credited with mentioning C++.
    expect(containsAnchor('Objective-C++ programming', 'C++')).toBe(false);
    // But C++ alone (no hyphen-prefix) SHOULD match.
    expect(containsAnchor('C++ programming', 'C++')).toBe(true);
    // Sanity: anchor with leading space is now trimmed (M2 fix); still matches.
    expect(containsAnchor('C++ programming', '  C++  ')).toBe(true);
  });

  // Wave-1 review MEDIUM M2: whitespace-padded anchor regression guard
  it('whitespace-padded anchor terms still match (trim applied internally)', () => {
    expect(containsAnchor('the RAID array', '  RAID  ')).toBe(true);
    expect(containsAnchor('Chaos Monkey kills nodes', '\tChaos Monkey\n')).toBe(true);
    // All-whitespace anchor is treated as empty.
    expect(containsAnchor('any haystack', '   ')).toBe(false);
  });

  // Wave-1 review MEDIUM M4: explicit coverage of dangerous regex metacharacters
  it('anchor with pipe (|) does not create false alternation matches', () => {
    // If `|` were not escaped, `R|W` anchor would match `R` OR `W` anywhere.
    // The escape must keep it as a literal `R|W`.
    const result = validateAnchors({
      narrative: 'discusses R reads and W writes separately',
      sourceParagraphs: [mkParagraph('the R|W ratio for this workload is 90:10')],
      whitelist: [mkAnchor('R|W')],
    });
    // R|W is in source but the narrative doesn't contain the literal
    // "R|W" — only "R" and "W" separately. Verbatim match must fail.
    expect(result.found).toHaveLength(0);
    expect(result.missing.map((a) => a.term)).toEqual(['R|W']);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Output shape / invariants
// ───────────────────────────────────────────────────────────────────────────

describe('validateAnchors — invariants', () => {
  it('expected = found ∪ missing (disjoint partition, order preserved)', () => {
    const whitelist = [
      mkAnchor('A'),
      mkAnchor('B'),
      mkAnchor('C'),
      mkAnchor('D'),
    ];
    const sourceParagraphs = [mkParagraph('A B C D all here.')];
    const narrative = 'A and C only.';

    const result = validateAnchors({ narrative, sourceParagraphs, whitelist });

    expect(result.expected.map((a) => a.term)).toEqual(['A', 'B', 'C', 'D']);
    expect(result.found.map((a) => a.term)).toEqual(['A', 'C']);
    expect(result.missing.map((a) => a.term)).toEqual(['B', 'D']);
    // Partition: every expected entry is in exactly one of found / missing.
    const reconstituted = [...result.found, ...result.missing];
    expect(reconstituted).toHaveLength(result.expected.length);
    for (const a of result.expected) {
      const inFound = result.found.includes(a);
      const inMissing = result.missing.includes(a);
      expect(inFound !== inMissing).toBe(true); // XOR
    }
  });

  it('score is always in [0, 1]', () => {
    const whitelist = [mkAnchor('A'), mkAnchor('B'), mkAnchor('C')];
    const sourceParagraphs = [mkParagraph('A B C all here.')];
    for (const narrative of ['', 'A', 'A B', 'A B C', 'A B C plus extras', 'nothing']) {
      const { score } = validateAnchors({ narrative, sourceParagraphs, whitelist });
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    }
  });
});
