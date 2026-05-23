/**
 * src/lib/openai/cost-cap.ts — pre-call cost budget enforcement.
 *
 * Implements ari design CRITICAL-1 (pre-call cap): before any chapter-gen
 * OpenAI call, sum the existing parses_cost rows for this tutorial and add
 * the projected cost. If that total exceeds env.COST_CAP_USD, throw
 * CostCapExceeded — the call is aborted BEFORE the API spend.
 *
 * Design anchors:
 *   - kb:architecture/ai-systems/inference-cost-management §"Failure mode:
 *     defaulting to the largest model on every call" — this gate is the
 *     operational backstop for that anti-pattern + general spend-creep.
 *   - kb:architecture/ai-systems/inference-cost-management §"Apply when:
 *     Building agent loops" — budget step count + context size; this gate
 *     enforces the budget per-tutorial (not per-step, but the
 *     tutorial-level cap implicitly caps step accumulation).
 *   - kb:architecture/discipline/error-handling-discipline §"Pattern 7:
 *     Crash" — when a known-fatal precondition fails (budget exceeded),
 *     throw rather than silently proceed. The outer layer (streaming
 *     SSE handler) catches and converts to a user-visible terminal event.
 *
 * Race condition acknowledgment: SQL SUM is read-only, so two concurrent
 * chapter-gen calls could both pass the gate, then both commit, exceeding
 * the cap by ~one chapter's cost. Mitigation options considered:
 *   1. SELECT FOR UPDATE — not supported in SQLite (no row-level locks).
 *   2. Application-level mutex — adds latency for the common single-call
 *      case; brittle under multi-process deploys.
 *   3. Accept the overrun — bounded to ~one extra chapter (~$0.001-$0.01
 *      depending on model). MVP choice; documented here for future revisit.
 * The over-budget signal still surfaces (next call throws); we just don't
 * abort the in-flight concurrent call. See finding HIGH-1 in this report.
 */

import { sql, eq } from 'drizzle-orm';
import { db, schema } from '@/db/client';
import { env } from '@/lib/env';

/**
 * Thrown when projected total cost would exceed env.COST_CAP_USD.
 *
 * Properties enable the outer layer to render a precise user-facing message:
 *   - tutorialId / capUsd / projectedTotalUsd / spentUsd
 * The error message itself is operator-friendly; the SSE handler should
 * format a user-friendly variant for the client.
 */
export class CostCapExceeded extends Error {
  readonly tutorialId: string;
  readonly capUsd: number;
  readonly spentUsd: number;
  readonly projectedTotalUsd: number;

  constructor(args: {
    tutorialId: string;
    capUsd: number;
    spentUsd: number;
    projectedTotalUsd: number;
  }) {
    super(
      `Cost cap exceeded for tutorial=${args.tutorialId}: ` +
        `spent=$${args.spentUsd.toFixed(4)} + projected=$${(
          args.projectedTotalUsd - args.spentUsd
        ).toFixed(4)} = $${args.projectedTotalUsd.toFixed(4)} > cap=$${args.capUsd.toFixed(2)}`,
    );
    this.name = 'CostCapExceeded';
    this.tutorialId = args.tutorialId;
    this.capUsd = args.capUsd;
    this.spentUsd = args.spentUsd;
    this.projectedTotalUsd = args.projectedTotalUsd;
  }
}

/**
 * Read the total spend so far for `tutorialId` from parses_cost.
 *
 * Returns 0 if no rows exist (new tutorial; first chapter gen). Uses
 * COALESCE so an empty SUM doesn't return null.
 *
 * Why a single SUM rather than caching: cheap (indexed by tutorial_id),
 * always fresh (no cache-invalidation bugs), survives multi-process by
 * the DB being the source of truth. Acceptable cost for an op that runs
 * once per chapter.
 */
export async function spentSoFar(tutorialId: string): Promise<number> {
  const rows = await db
    .select({
      total: sql<number>`COALESCE(SUM(${schema.parsesCost.costUsd}), 0)`,
    })
    .from(schema.parsesCost)
    .where(eq(schema.parsesCost.tutorialId, tutorialId));
  // SQLite returns the SUM as a number through better-sqlite3; defensive
  // Number() coercion in case the driver hands back a string.
  return Number(rows[0]?.total ?? 0);
}

/**
 * Assert that adding `projectedCostUsd` to the existing spend for
 * `tutorialId` would not exceed env.COST_CAP_USD. Throws CostCapExceeded
 * if it would.
 *
 * Idempotent: pure read + comparison, no writes. Safe to call repeatedly.
 *
 * Test-friendly: the env.COST_CAP_USD value is read fresh each call (env
 * is parsed once at boot but tests can mutate `env.COST_CAP_USD` if they
 * really need a different cap — though most tests should override via
 * NODE_ENV-specific .env loading).
 */
export async function assertCostBudget(
  tutorialId: string,
  projectedCostUsd: number,
): Promise<void> {
  const cap = env.COST_CAP_USD;
  const spent = await spentSoFar(tutorialId);
  const projectedTotal = spent + projectedCostUsd;
  if (projectedTotal > cap) {
    throw new CostCapExceeded({
      tutorialId,
      capUsd: cap,
      spentUsd: spent,
      projectedTotalUsd: projectedTotal,
    });
  }
}
