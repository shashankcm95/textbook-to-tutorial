/**
 * src/lib/openai/__tests__/cost-estimate.test.ts — property tests for cost math.
 *
 * Vitest + fast-check. Five fast tests; should run in <1s on CI.
 *
 * Properties asserted:
 *   1. Zero-floor: zero tokens → zero cost.
 *   2. Monotonicity: more tokens → ≥ cost (no negative-cost edge cases).
 *   3. Pricing table determinism: estimateCost and actualCost agree on
 *      identical token counts (single source of truth for pricing).
 *   4. Unknown-model error: cost functions throw UnknownModelError, not
 *      silent-return-zero.
 *   5. Estimate uses the max_tokens cap (conservative upper bound), so
 *      estimate ≥ actual for any actual completion ≤ cap. Critical for
 *      cost-cap correctness — the gate would leak if estimate < actual.
 *
 * Why fast-check: cost math has many edge cases (very-large counts,
 * floating-point precision, model-name strings). Property tests catch
 * what example tests miss; 100 random inputs per property is fast and
 * surfaces precision issues at the boundary.
 */

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  actualCost,
  estimateCost,
  PRICING_USD_PER_1M,
  UnknownModelError,
  type SupportedModel,
} from '../cost';

const SUPPORTED_MODELS = Object.keys(PRICING_USD_PER_1M) as SupportedModel[];

describe('estimateCost / actualCost — property tests', () => {
  it('zero-floor: empty prompt + zero completion cap → estimated cost == 0', () => {
    for (const model of SUPPORTED_MODELS) {
      const est = estimateCost({ model, promptText: '', maxCompletionTokens: 0 });
      expect(est.estimatedPromptTokens).toBe(0);
      expect(est.estimatedCompletionTokens).toBe(0);
      expect(est.estimatedCostUsd).toBe(0);
    }
  });

  it('zero-floor: actualCost with zero token counts → 0', () => {
    for (const model of SUPPORTED_MODELS) {
      const cost = actualCost({ model, promptTokens: 0, completionTokens: 0 });
      expect(cost).toBe(0);
    }
  });

  it('monotonicity: actualCost is non-decreasing in token counts', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...SUPPORTED_MODELS),
        fc.nat({ max: 10_000 }),
        fc.nat({ max: 10_000 }),
        fc.nat({ max: 10_000 }),
        (model, p1, addP, addC) => {
          const baseline = actualCost({ model, promptTokens: p1, completionTokens: 0 });
          const moreP = actualCost({ model, promptTokens: p1 + addP, completionTokens: 0 });
          const moreC = actualCost({
            model,
            promptTokens: p1,
            completionTokens: addC,
          });
          // Adding tokens cannot reduce cost (and cannot go negative).
          expect(moreP).toBeGreaterThanOrEqual(baseline);
          expect(moreC).toBeGreaterThanOrEqual(baseline);
          expect(baseline).toBeGreaterThanOrEqual(0);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('estimateCost completion uses the cap, NOT a guess (upper-bound discipline)', () => {
    // For any prompt + cap, the estimated completion tokens == cap (floored
    // to int). This is the property cost-cap.ts relies on: the estimate is
    // a true upper bound, not an expected mean.
    fc.assert(
      fc.property(
        fc.constantFrom(...SUPPORTED_MODELS),
        fc.string({ maxLength: 200 }),
        fc.nat({ max: 8192 }),
        (model, promptText, cap) => {
          const est = estimateCost({
            model,
            promptText,
            maxCompletionTokens: cap,
          });
          expect(est.estimatedCompletionTokens).toBe(cap);
          // And: actualCost with completionTokens = cap == estimateCost's
          // completion contribution (single source of truth, no drift).
          const actualSame = actualCost({
            model,
            promptTokens: est.estimatedPromptTokens,
            completionTokens: cap,
          });
          // Floating-point equality: cost arithmetic uses /1_000_000 so values
          // can have tiny precision drift; assert within a tight tolerance.
          expect(Math.abs(actualSame - est.estimatedCostUsd)).toBeLessThan(1e-9);
        },
      ),
      { numRuns: 50 },
    );
  });

  it('unknown model throws UnknownModelError (not silent-return-zero)', () => {
    expect(() =>
      estimateCost({ model: 'gpt-9-nonexistent', promptText: 'x', maxCompletionTokens: 1 }),
    ).toThrow(UnknownModelError);
    expect(() =>
      actualCost({ model: 'gpt-9-nonexistent', promptTokens: 1, completionTokens: 1 }),
    ).toThrow(UnknownModelError);
  });
});
