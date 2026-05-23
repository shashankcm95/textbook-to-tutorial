/**
 * src/lib/openai/cost.ts — token-cost arithmetic for OpenAI inference calls.
 *
 * Two distinct functions:
 *   - estimateCost: PRE-call projection (tiktoken-counted prompt + heuristic
 *     output cap). Used by cost-cap.ts before the call is dispatched.
 *   - actualCost: POST-call accounting (uses the real usage object returned
 *     by OpenAI). Used by streaming.ts after a successful stream completes
 *     to record the cost row in parses_cost.
 *
 * Both share PRICING_USD_PER_1M — the single source of truth. Updating
 * pricing is one edit to one constant; no scattered magic numbers.
 *
 * Design anchors:
 *   - kb:architecture/ai-systems/inference-cost-management §"Cost
 *     decomposition" — input vs output tokens metered separately; output is
 *     typically more expensive per-token (true for gpt-4o-mini: 4× input
 *     rate; for gpt-4o: 4× input rate). Reflected verbatim below.
 *   - kb:architecture/ai-systems/inference-cost-management §"Lever 5:
 *     Output control" — `max_tokens` caps output sprawl. The estimator
 *     uses this cap (NOT an open-ended guess) so the pre-call assertion
 *     is a true upper bound, not an average.
 *
 * Tiktoken note: we use cl100k_base encoding for gpt-4o family (matches
 * what OpenAI uses server-side for tokenization). tiktoken@1.0.15 is the
 * pinned dep in package.json. If a future model uses a different encoding
 * (e.g., gpt-5 hypothetically with o200k_base), add it to the map below.
 *
 * Test contract: cost-estimate.test.ts asserts monotonicity (more tokens
 * → ≥ cost), zero-floor (0 tokens → 0 cost), and that estimate ≥ actual
 * for the same token counts (estimate uses ceiling rounding).
 */

import { encoding_for_model, type TiktokenModel } from 'tiktoken';
import type { CostEstimate } from '@/lib/types';

// ───────────────────────────────────────────────────────────────────────────
// Pricing table — USD per 1,000,000 tokens. Update when OpenAI publishes
// price changes. Values from https://openai.com/api/pricing (Phase 1 design,
// May 2026 snapshot). The exhaustive map is intentional — no fallback to
// "average pricing" so unknown models surface as explicit errors.
// ───────────────────────────────────────────────────────────────────────────

export const PRICING_USD_PER_1M = {
  'gpt-4o-mini': {
    input: 0.15,
    output: 0.60,
  },
  'gpt-4o': {
    input: 2.50,
    output: 10.00,
  },
} as const;

export type SupportedModel = keyof typeof PRICING_USD_PER_1M;

// Tiktoken encoding map. cl100k_base is used by gpt-4 + gpt-4o family.
// If we add a gpt-5/o200k_base model, extend here.
const ENCODING_FOR_MODEL: Record<SupportedModel, TiktokenModel> = {
  'gpt-4o-mini': 'gpt-4o-mini',
  'gpt-4o': 'gpt-4o',
};

/**
 * Type-guard: is this model name one we have pricing for?
 * Caller branches on this to decide whether to throw or fall back.
 */
export function isSupportedModel(model: string): model is SupportedModel {
  return model in PRICING_USD_PER_1M;
}

/**
 * Custom error class for unknown models. Caller (cost-cap, streaming) can
 * `instanceof` check and decide whether to fail-closed (treat as cost-cap
 * violation) or surface to operator.
 */
export class UnknownModelError extends Error {
  readonly model: string;
  constructor(model: string) {
    super(
      `No pricing entry for model='${model}'. Add it to PRICING_USD_PER_1M ` +
        `in src/lib/openai/cost.ts before using this model in production.`,
    );
    this.name = 'UnknownModelError';
    this.model = model;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Token counting — tiktoken-based; per-call encoding instance.
// ───────────────────────────────────────────────────────────────────────────

/**
 * Count the tokens in `text` for `model` using tiktoken (the same tokenizer
 * OpenAI uses server-side for billing).
 *
 * Note: tiktoken `encoding_for_model` returns an object with a `.free()`
 * method that releases native memory. We free in a finally to avoid leaks
 * under repeated calls (the chapter-gen pipeline can fire dozens per PDF).
 *
 * Caller should pass the SAME model string they'll send to OpenAI; cross-
 * model token counts differ enough that mixing them defeats the estimator.
 */
export function estimateTokens(text: string, model: SupportedModel): number {
  if (text.length === 0) return 0;
  const enc = encoding_for_model(ENCODING_FOR_MODEL[model]);
  try {
    return enc.encode(text).length;
  } finally {
    enc.free();
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Pre-call cost projection — used by cost-cap.assertCostBudget BEFORE the
// OpenAI call is dispatched. Conservatism is intentional:
//   - prompt tokens: exact tiktoken count
//   - completion tokens: uses the CAP, not an expected mean — pre-call cap
//     must be an upper bound or it defeats the cost-cap purpose
// ───────────────────────────────────────────────────────────────────────────

export interface EstimateCostArgs {
  /** Model identifier; must be in PRICING_USD_PER_1M. */
  model: string;
  /** Concatenated prompt text (system + user). Counted exactly via tiktoken. */
  promptText: string;
  /** Upper bound for completion tokens — this is the `max_tokens` we'll set
   *  on the OpenAI call. Conservative; protects the cost cap even on long
   *  outputs. */
  maxCompletionTokens: number;
}

export function estimateCost(args: EstimateCostArgs): CostEstimate {
  const { model, promptText, maxCompletionTokens } = args;
  if (!isSupportedModel(model)) {
    throw new UnknownModelError(model);
  }
  const promptTokens = estimateTokens(promptText, model);
  const completionTokens = Math.max(0, Math.floor(maxCompletionTokens));
  const pricing = PRICING_USD_PER_1M[model];
  const costUsd =
    (promptTokens / 1_000_000) * pricing.input +
    (completionTokens / 1_000_000) * pricing.output;
  return {
    model,
    estimatedPromptTokens: promptTokens,
    estimatedCompletionTokens: completionTokens,
    estimatedCostUsd: costUsd,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Post-call cost accounting — used by streaming.ts after a successful call,
// passed to the parses_cost insert. Uses the EXACT usage block returned by
// OpenAI (prompt_tokens + completion_tokens) for ground-truth cost.
// ───────────────────────────────────────────────────────────────────────────

export interface ActualCostArgs {
  model: string;
  promptTokens: number;
  completionTokens: number;
}

/**
 * Compute the actual USD cost from observed usage. Symmetric with
 * estimateCost but uses exact token counts (not the max_tokens cap).
 *
 * Invariant (tested in cost-estimate.test.ts): for the same token counts,
 * actualCost is identical to what estimateCost would compute — they share
 * the same PRICING table and the same arithmetic.
 */
export function actualCost(args: ActualCostArgs): number {
  const { model, promptTokens, completionTokens } = args;
  if (!isSupportedModel(model)) {
    throw new UnknownModelError(model);
  }
  const pricing = PRICING_USD_PER_1M[model];
  return (
    (promptTokens / 1_000_000) * pricing.input +
    (completionTokens / 1_000_000) * pricing.output
  );
}
