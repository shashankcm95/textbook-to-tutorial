// src/lib/diagrams/__tests__/weave.test.ts — Sprint H Wave 1 (Builder C).
//
// Coverage:
//   - Empty-diagrams short-circuit (input verbatim).
//   - Strategy 1 (heading match, including case-insensitive substring).
//   - Strategy 2 (citation match) — fires when no anchorHeading provided.
//   - Strategy 3 (30% fallback) — fires when no anchors at all.
//   - Idempotency: weave(weave(n, [d]), [d]) === weave(n, [d]).
//   - Multi-diagram weaving preserves order + position.
//   - Emitted fence matches the diagram-density.ts regex byte-for-byte.
//   - Emitted JSON inside the fence round-trips through DiagramPayloadSchema.
//   - Input narrative is never mutated.

import { describe, it, expect } from 'vitest';
import { weaveDiagrams, type ExtractedDiagram } from '../weave';
import { DiagramPayloadSchema, type DiagramPayload } from '../schema';

// ---------------------------------------------------------------------------
// Fixtures — minimal Zod-valid payloads (mirrors wire-schema.test.ts shapes).
// ---------------------------------------------------------------------------

const comparisonTable: DiagramPayload = {
  kind: 'ComparisonTable',
  title: 'Replication topologies',
  columns: ['Topology', 'Writes'],
  rows: [
    { Topology: 'Single-leader', Writes: 'SPOF' },
    { Topology: 'Multi-leader', Writes: 'High' },
  ],
};

const definitionList: DiagramPayload = {
  kind: 'DefinitionList',
  title: 'Concurrency control',
  items: [
    { term: 'Lock', definition: 'Mutual exclusion mechanism.' },
    { term: 'MVCC', definition: 'Multi-version concurrency control.' },
  ],
};

const diagramFlow: DiagramPayload = {
  kind: 'DiagramFlow',
  title: 'Write path',
  direction: 'LR',
  nodes: [
    { id: 'a', label: 'Client', kind: 'start' },
    { id: 'b', label: 'Leader', kind: 'process' },
    { id: 'c', label: 'Replica', kind: 'end' },
  ],
  edges: [
    { from: 'a', to: 'b', label: 'write' },
    { from: 'b', to: 'c' },
  ],
};

// The exact density-metric contract regex (`diagram-density.ts:87`). We feed
// the woven narrative through this same regex shape and assert one match per
// inserted diagram.
const DENSITY_BLOCK_RE = /^```(diagram|mermaid)[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*(?=\r?\n|$)/gm;

// ---------------------------------------------------------------------------
// Strategy 0 — empty input short-circuits.
// ---------------------------------------------------------------------------

describe('weaveDiagrams — empty diagrams', () => {
  it('returns the narrative verbatim when no diagrams are provided', () => {
    const narrative = '# Hello\n\nWorld';
    expect(weaveDiagrams(narrative, [])).toBe(narrative);
  });

  it('returns the narrative verbatim for an empty string + no diagrams', () => {
    expect(weaveDiagrams('', [])).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Strategy 1 — insertAfterHeading.
// ---------------------------------------------------------------------------

describe('weaveDiagrams — Strategy 1 (heading anchor)', () => {
  it('inserts the fence after a matching `## Lesson N:` heading', () => {
    const narrative = [
      '# Chapter',
      '',
      'Opening paragraph.',
      '',
      '## Lesson 2: Foo',
      '',
      'Body of lesson two.',
      '',
      '## Lesson 3: Bar',
      '',
      'Body of lesson three.',
    ].join('\n');

    const woven = weaveDiagrams(narrative, [
      { payload: comparisonTable, anchorHeading: 'Lesson 2' },
    ]);

    // The fence body line should appear after the Lesson 2 heading and
    // before the Lesson 3 heading.
    const lesson2Idx = woven.indexOf('## Lesson 2: Foo');
    const fenceIdx = woven.indexOf('```diagram');
    const lesson3Idx = woven.indexOf('## Lesson 3: Bar');
    expect(lesson2Idx).toBeGreaterThanOrEqual(0);
    expect(fenceIdx).toBeGreaterThan(lesson2Idx);
    expect(fenceIdx).toBeLessThan(lesson3Idx);
  });

  it('matches case-insensitively on the anchor heading substring', () => {
    const narrative = [
      '# Chapter',
      '',
      '## Lesson 2: Performance',
      '',
      'Body.',
    ].join('\n');

    const woven = weaveDiagrams(narrative, [
      { payload: comparisonTable, anchorHeading: 'lesson 2' }, // lowercase
    ]);

    expect(woven).toContain('```diagram');
    const lessonIdx = woven.indexOf('## Lesson 2: Performance');
    const fenceIdx = woven.indexOf('```diagram');
    expect(fenceIdx).toBeGreaterThan(lessonIdx);
  });
});

// ---------------------------------------------------------------------------
// Strategy 2 — insertAfterCitation.
// ---------------------------------------------------------------------------

describe('weaveDiagrams — Strategy 2 (citation anchor)', () => {
  it('inserts the fence after a line containing the citation token', () => {
    const narrative = [
      'Opening prose without headings.',
      '',
      'Detailed paragraph with a citation [ref:page105:paragraph10] right here.',
      '',
      'Closing prose.',
    ].join('\n');

    const woven = weaveDiagrams(narrative, [
      {
        payload: definitionList,
        anchorCitation: '[ref:page105:paragraph10]',
      },
    ]);

    const citationLineEnd = woven.indexOf('right here.') + 'right here.'.length;
    const fenceIdx = woven.indexOf('```diagram');
    expect(fenceIdx).toBeGreaterThan(citationLineEnd);
    const closingIdx = woven.indexOf('Closing prose.');
    expect(fenceIdx).toBeLessThan(closingIdx);
  });
});

// ---------------------------------------------------------------------------
// Strategy 3 — 30% fallback.
// ---------------------------------------------------------------------------

describe('weaveDiagrams — Strategy 3 (30% fallback)', () => {
  it('inserts past the 30% character-position mark when no anchors match', () => {
    // 200-char narrative with paragraph boundaries every ~50 chars.
    const para = 'x'.repeat(48);
    const narrative = [para, para, para, para].join('\n\n'); // ~200 chars

    const woven = weaveDiagrams(narrative, [{ payload: diagramFlow }]);
    const fenceIdx = woven.indexOf('```diagram');
    expect(fenceIdx).toBeGreaterThan(60); // > 30% of 200
  });

  it('inserts after a paragraph boundary, not mid-paragraph', () => {
    const para = 'sentence. '.repeat(20).trim(); // ~200 chars, no \n
    const narrative = [para, para, para].join('\n\n');
    const woven = weaveDiagrams(narrative, [{ payload: diagramFlow }]);
    // Fence should land on its own block — there should be a `\n\n` (or
    // start-of-string) immediately before the fence open.
    const fenceIdx = woven.indexOf('```diagram');
    const charBeforeFence = fenceIdx >= 2 ? woven.slice(fenceIdx - 2, fenceIdx) : '';
    expect(['\n\n', '']).toContain(charBeforeFence);
  });

  // Sprint H Wave 3 fix (Rev C HIGH-1): degenerate narrative with NO
  // paragraph boundary past the 30% mark used to splice mid-word at the
  // threshold offset. Now appends at end-of-string so the prose stays
  // intact even when the fallback strategy fires on a pathological input.
  it('appends at end-of-string when no paragraph boundary exists past the 30% mark', () => {
    // Single dense paragraph — no \n\n anywhere.
    const narrative = 'Just a single short paragraph with no breaks.';
    const woven = weaveDiagrams(narrative, [{ payload: diagramFlow }]);
    // Prose text must survive intact — verify the original sentence is
    // present verbatim, not split mid-word.
    expect(woven).toContain(narrative);
    // Fence must follow the prose, not interrupt it.
    const fenceIdx = woven.indexOf('```diagram');
    const proseEndIdx = woven.indexOf(narrative) + narrative.length;
    expect(fenceIdx).toBeGreaterThan(proseEndIdx);
  });
});

// ---------------------------------------------------------------------------
// Idempotency — the load-bearing invariant.
// ---------------------------------------------------------------------------

describe('weaveDiagrams — idempotency', () => {
  it('weave(weave(n, [d]), [d]) === weave(n, [d]) for a heading anchor', () => {
    const narrative = [
      '# Chapter',
      '',
      '## Lesson 2: Foo',
      '',
      'Body.',
    ].join('\n');
    const d: ExtractedDiagram = { payload: comparisonTable, anchorHeading: 'Lesson 2' };
    const once = weaveDiagrams(narrative, [d]);
    const twice = weaveDiagrams(once, [d]);
    expect(twice).toBe(once);
  });

  it('weave(weave(n, [d]), [d]) === weave(n, [d]) for a fallback anchor', () => {
    const narrative = ['Para A.', 'Para B.', 'Para C.'].join('\n\n');
    const d: ExtractedDiagram = { payload: diagramFlow };
    const once = weaveDiagrams(narrative, [d]);
    const twice = weaveDiagrams(once, [d]);
    expect(twice).toBe(once);
  });

  // Sprint H Wave 3 fix (Rev C HIGH-2): idempotency under citation-anchor
  // strategy was untested. The dedup logic is canonical-JSON keyed and shared
  // across strategies, but the explicit test asserts the load-bearing
  // invariant for the path most likely to fire on real DDIA narratives
  // (citations are dense; headings are sparse).
  it('weave(weave(n, [d]), [d]) === weave(n, [d]) for a citation anchor', () => {
    const narrative = [
      'Opening paragraph.',
      '',
      'Body with [ref:page42:paragraph3] in it.',
      '',
      'Closing paragraph.',
    ].join('\n');
    const d: ExtractedDiagram = {
      payload: comparisonTable,
      anchorCitation: '[ref:page42:paragraph3]',
    };
    const once = weaveDiagrams(narrative, [d]);
    const twice = weaveDiagrams(once, [d]);
    expect(twice).toBe(once);
    // Sanity: the fence is actually present once after the first weave.
    expect((once.match(/```diagram\b/g) ?? []).length).toBe(1);
  });

  it('counts exactly one fence after a double-weave', () => {
    const narrative = '# C\n\n## Lesson 2: X\n\nBody.';
    const d: ExtractedDiagram = { payload: comparisonTable, anchorHeading: 'Lesson 2' };
    const twice = weaveDiagrams(weaveDiagrams(narrative, [d]), [d]);
    // Count ```diagram occurrences.
    const matches = twice.match(/```diagram\b/g) ?? [];
    expect(matches.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Multi-diagram weaving — three diagrams, five-section narrative.
// ---------------------------------------------------------------------------

describe('weaveDiagrams — multiple diagrams', () => {
  it('weaves three diagrams into the correct heading anchors in order', () => {
    const narrative = [
      '# Chapter',
      '',
      '## Lesson 1: Intro',
      '',
      'Intro body.',
      '',
      '## Lesson 2: Foo',
      '',
      'Foo body.',
      '',
      '## Lesson 3: Bar',
      '',
      'Bar body.',
      '',
      '## Lesson 4: Baz',
      '',
      'Baz body.',
      '',
      '## Lesson 5: Outro',
      '',
      'Outro body.',
    ].join('\n');

    const woven = weaveDiagrams(narrative, [
      { payload: comparisonTable, anchorHeading: 'Lesson 1' },
      { payload: definitionList, anchorHeading: 'Lesson 3' },
      { payload: diagramFlow, anchorHeading: 'Lesson 5' },
    ]);

    // Three distinct fences emitted.
    const fenceMatches = woven.match(/```diagram\b/g) ?? [];
    expect(fenceMatches.length).toBe(3);

    // Each fence falls under the expected lesson heading.
    const findHeading = (heading: string) => woven.indexOf(heading);
    const findNthFence = (n: number) => {
      let idx = -1;
      for (let i = 0; i <= n; i += 1) idx = woven.indexOf('```diagram', idx + 1);
      return idx;
    };

    const fence1 = findNthFence(0);
    const fence2 = findNthFence(1);
    const fence3 = findNthFence(2);

    expect(fence1).toBeGreaterThan(findHeading('## Lesson 1: Intro'));
    expect(fence1).toBeLessThan(findHeading('## Lesson 2: Foo'));
    expect(fence2).toBeGreaterThan(findHeading('## Lesson 3: Bar'));
    expect(fence2).toBeLessThan(findHeading('## Lesson 4: Baz'));
    expect(fence3).toBeGreaterThan(findHeading('## Lesson 5: Outro'));
  });
});

// ---------------------------------------------------------------------------
// Contract test — emitted fences match diagram-density.ts regex.
// ---------------------------------------------------------------------------

describe('weaveDiagrams — density-metric regex contract', () => {
  it('emits fences that match the density-metric BLOCK_RE shape', () => {
    const narrative = '# C\n\n## Lesson 2: X\n\nBody.\n';
    const woven = weaveDiagrams(narrative, [
      { payload: comparisonTable, anchorHeading: 'Lesson 2' },
      { payload: definitionList, anchorHeading: 'Lesson 2' },
    ]);

    DENSITY_BLOCK_RE.lastIndex = 0;
    const matches: RegExpExecArray[] = [];
    let m: RegExpExecArray | null;
    while ((m = DENSITY_BLOCK_RE.exec(woven)) !== null) {
      matches.push(m);
    }

    expect(matches.length).toBe(2);
    for (const match of matches) {
      expect(match[1]).toBe('diagram');
      const body = match[2] ?? '';
      // JSON inside the fence must round-trip through the F.1 schema.
      const parsed: unknown = JSON.parse(body);
      const zod = DiagramPayloadSchema.safeParse(parsed);
      expect(zod.success).toBe(true);
    }
  });

  it('emits a fence at end-of-string that still matches the regex (EOF lookahead)', () => {
    const narrative = 'Just a single short paragraph.';
    const woven = weaveDiagrams(narrative, [{ payload: diagramFlow }]);
    DENSITY_BLOCK_RE.lastIndex = 0;
    const match = DENSITY_BLOCK_RE.exec(woven);
    expect(match).not.toBeNull();
    expect(match?.[1]).toBe('diagram');
  });
});

// ---------------------------------------------------------------------------
// Immutability — input narrative is never the same string as output.
// ---------------------------------------------------------------------------

describe('weaveDiagrams — immutability', () => {
  it('returns a new string when a diagram is inserted', () => {
    const narrative = '# C\n\n## Lesson 2: X\n\nBody.';
    const woven = weaveDiagrams(narrative, [
      { payload: comparisonTable, anchorHeading: 'Lesson 2' },
    ]);
    expect(woven).not.toBe(narrative);
    expect(woven.length).toBeGreaterThan(narrative.length);
    // The original narrative is still intact (string is immutable in JS,
    // but assert defensively that no leakage occurred).
    expect(narrative).toBe('# C\n\n## Lesson 2: X\n\nBody.');
  });

  it('returns the same string instance when diagrams array is empty', () => {
    const narrative = '# Hello';
    expect(weaveDiagrams(narrative, [])).toBe(narrative);
  });
});
