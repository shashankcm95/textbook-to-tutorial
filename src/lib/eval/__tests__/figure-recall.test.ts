// src/lib/eval/__tests__/figure-recall.test.ts
//
// Sprint E Tier 2 — unit tests for the figure-recall metric.

import { describe, it, expect } from 'vitest';

import { computeFigureRecall } from '../figure-recall';
import type { SourceParagraph } from '@/lib/types';

function p(text: string, idx = 0): SourceParagraph {
  return { page: 1, paragraphIdx: idx, text };
}

describe('computeFigureRecall', () => {
  it('returns null when source has zero figure labels (not 0.0 or 1.0)', () => {
    const result = computeFigureRecall(
      'A narrative that mentions no figures at all.',
      [p('Source paragraph with no figure references either.')],
    );
    expect(result).toBeNull();
  });

  it('returns null when source has no figures even if narrative mentions some', () => {
    // Edge case: narrative invents figure labels not in source. Source is the
    // ground truth — if source has none, the chapter is not figure-bearing.
    const result = computeFigureRecall(
      'See Figure 2-3 for the diagram.',
      [p('Plain text, no figure labels.')],
    );
    expect(result).toBeNull();
  });

  it('scores 1.0 when all source figures are mentioned in the narrative', () => {
    const result = computeFigureRecall(
      'See Figure 2-3 and Figure 4-1 for the schematic.',
      [
        p('See Figure 2-3 for the layout.'),
        p('Figure 4-1 shows the result.'),
      ],
    );
    expect(result).not.toBeNull();
    expect(result!.recall).toBe(1.0);
    expect(result!.missing).toEqual([]);
    expect(result!.sourceFigures).toEqual(['2-3', '4-1']);
  });

  it('scores 0.5 when half of source figures are preserved', () => {
    const result = computeFigureRecall(
      'See Figure 2-3 for the layout.',
      [
        p('See Figure 2-3 for the layout.'),
        p('Figure 4-1 shows the result.'),
      ],
    );
    expect(result).not.toBeNull();
    expect(result!.recall).toBe(0.5);
    expect(result!.missing).toEqual(['4-1']);
  });

  it('scores 0.0 when none of the source figures are preserved', () => {
    const result = computeFigureRecall(
      'A narrative with no figure references at all.',
      [
        p('See Figure 2-3 for the layout.'),
        p('Figure 4-1 shows the result.'),
      ],
    );
    expect(result).not.toBeNull();
    expect(result!.recall).toBe(0);
    expect(result!.missing).toEqual(['2-3', '4-1']);
  });

  it('normalizes "Figure X-Y" and "Fig. X-Y" and "Fig X-Y" to the same label', () => {
    // All three variants of the figure prefix should hit the same identifier.
    const result = computeFigureRecall(
      'See Fig. 2-3 for the diagram.',
      [
        p('Figure 2-3 shows the layout.'),
        p('Refer back to Fig 2-3 in the appendix.'),
      ],
    );
    expect(result).not.toBeNull();
    // Source de-dupes "2-3" across both paragraphs → 1 unique label.
    expect(result!.sourceFigures).toEqual(['2-3']);
    expect(result!.narrativeFigures).toEqual(['2-3']);
    expect(result!.recall).toBe(1.0);
  });

  it('de-duplicates variant forms of the same label within a single body', () => {
    // "Figure 2-3" mentioned 3 times + "Fig. 2-3" once = one unique label.
    const result = computeFigureRecall(
      'See Figure 2-3. As shown in Figure 2-3, the layout works. Fig. 2-3 again.',
      [p('Figure 2-3 demonstrates the approach.')],
    );
    expect(result).not.toBeNull();
    expect(result!.sourceFigures).toEqual(['2-3']);
    expect(result!.narrativeFigures).toEqual(['2-3']);
    expect(result!.recall).toBe(1.0);
  });

  it('handles multi-part identifiers like "10.4.7" and simple "12"', () => {
    const result = computeFigureRecall(
      'Figure 12 and Figure 10.4.7 are key.',
      [
        p('See Figure 12 for the overview.'),
        p('Figure 10.4.7 shows the nested case.'),
      ],
    );
    expect(result).not.toBeNull();
    expect(result!.sourceFigures.sort()).toEqual(['10.4.7', '12']);
    expect(result!.recall).toBe(1.0);
  });

  it('preserves first-seen order in sourceFigures + narrativeFigures', () => {
    const result = computeFigureRecall(
      'First Figure 5, then Figure 3, then Figure 1.',
      [
        p('Figure 1 is introduced first.'),
        p('Then Figure 3.'),
        p('Finally Figure 5.'),
      ],
    );
    expect(result).not.toBeNull();
    expect(result!.sourceFigures).toEqual(['1', '3', '5']);
    expect(result!.narrativeFigures).toEqual(['5', '3', '1']);
  });

  it('is case-insensitive on the FIGURE keyword', () => {
    const result = computeFigureRecall(
      'See FIGURE 2-3 in caps.',
      [p('figure 2-3 in lowercase.')],
    );
    expect(result).not.toBeNull();
    expect(result!.recall).toBe(1.0);
  });
});
