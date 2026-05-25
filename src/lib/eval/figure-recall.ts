/**
 * src/lib/eval/figure-recall.ts — Sprint E Tier 2 figure-recall metric.
 *
 * Per-chapter score: did the generated narrative mention the figures that the
 * source paragraphs labeled? Counts unique "Figure X-Y" / "Fig. X-Y" labels
 * appearing in the narrative ÷ count appearing in the source paragraphs.
 *
 * Empirical baseline (image-handling audit, 2026-05-24):
 *   - 170 source-side figure labels across 588 chapter rows
 *   - 0 narrative-side mentions
 *   - 100% drop rate
 *
 * Sprint E Tier 1 just shipped FIDELITY rule 8 ("preserve figure references"
 * in narrative prompts). This metric closes the empirical loop: measure
 * recall on every regen post-Tier-1 to verify the rule is taking effect.
 *
 * Returns `null` when source has zero figure labels (chapter is not
 * figure-bearing — a 0.0 or 1.0 score would be misleading).
 *
 * Standalone-useful via direct invocation; not yet wired into runner.ts
 * report aggregation (RUBRIC.md's aggregation contract is locked — wiring
 * would be a follow-up PR with rubric-versioning).
 */

import type { SourceParagraph } from '@/lib/types';

/**
 * Match a figure label and capture the numeric identifier. Accepts:
 *   "Figure 2-3"   "Figure 2.3"   "Figure 12"
 *   "Fig. 2-3"     "Fig 2-3"      "FIGURE 2-3"
 *
 * Variants normalize to the captured group (the "2-3" or "12" part).
 * "Figure 2-3" and "Fig. 2-3" and "Fig 2-3" all yield the same key "2-3".
 *
 * Identifier shape: one or more digits, optionally followed by ([.-]<digits>)
 * groups — e.g. "12", "2-3", "10.4.7". Anchored via \b on the word "Figure".
 */
const FIGURE_RE = /\b(?:Figure|Fig\.?)\s+(\d+(?:[-.]\d+)*)/gi;

export interface FigureRecallScore {
  /** Unique figure labels found in the source paragraphs, in first-seen order. */
  sourceFigures: string[];
  /** Unique figure labels found in the narrative, in first-seen order. */
  narrativeFigures: string[];
  /**
   * |source ∩ narrative| / |source| — never null because we return null
   * from `computeFigureRecall()` when source is empty (so this is safe).
   */
  recall: number;
  /** Source-side labels that were NOT mentioned in the narrative. */
  missing: string[];
}

/**
 * Compute the figure-recall score for one chapter.
 *
 * @param narrative          The generated chapter narrative (markdown).
 * @param sourceParagraphs   The source paragraphs the chapter was derived from.
 * @returns score object, or `null` when source has zero figure labels.
 */
export function computeFigureRecall(
  narrative: string,
  sourceParagraphs: readonly SourceParagraph[],
): FigureRecallScore | null {
  const sourceText = sourceParagraphs.map((p) => p.text).join(' ');
  const sourceFigures = uniqueFigures(sourceText);
  if (sourceFigures.length === 0) return null;

  const narrativeFigures = uniqueFigures(narrative);
  const narrativeSet = new Set(narrativeFigures);

  const overlap = sourceFigures.filter((f) => narrativeSet.has(f));
  const missing = sourceFigures.filter((f) => !narrativeSet.has(f));

  return {
    sourceFigures,
    narrativeFigures,
    recall: overlap.length / sourceFigures.length,
    missing,
  };
}

/**
 * Extract unique figure labels from a body of text, preserving first-seen
 * order. The regex is global + case-insensitive; we de-dupe via Set but
 * iterate to keep insertion order for stable downstream reporting.
 */
function uniqueFigures(text: string): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const match of text.matchAll(FIGURE_RE)) {
    const id = match[1];
    if (id && !seen.has(id)) {
      seen.add(id);
      ordered.push(id);
    }
  }
  return ordered;
}
