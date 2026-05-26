// src/lib/openai/extract-diagrams.ts — Sprint H Wave 1 (Builder A).
//
// Shape A "2-pass" structured-diagram extractor. After narrative-only.ts
// finishes streaming the chapter prose (gpt-4o), this module fires a SECOND
// dedicated call (gpt-4o-mini) whose only job is "given this narrative,
// emit the diagrams it enumerates" — under strict-mode response_format
// using WIRE_SCHEMA from src/lib/diagrams/wire-schema.ts (Builder B).
//
// Why a separate call instead of folding emission into the prose pass:
// empirical 0/5 baseline (2026-05-26 DDIA sweep) — the prose attractor in
// the 4o narrative call crowds out conditional structured emission. Shape A
// removes the conditional entirely from the prose path. See RFC at
// `_inspect/sprint-h/response-format-rfc.md` §"Recommended shape".
//
// Cost-cap gating: this module does NOT call assertCostBudget. The
// convention in the lazy-hybrid path (narrative-only.ts +
// quiz-from-narrative.ts) is that cost-cap is enforced UPSTREAM by
// per-chapter.ts (Builder D will add the second parses_cost row + run the
// gate). Keeping cost-cap out of this module preserves the bulkhead between
// "compute" and "budget"; the gate is a per-tutorial concept and tutorialId
// does not belong on this call's argument surface.
//
// Design anchors:
//   - kb:architecture/discipline/stability-patterns §Bulkhead — extractor
//     failure does NOT kill the chapter; per-chapter.ts (Builder D)
//     fail-opens to the unmodified narrative. This module's job is just to
//     surface clean errors when something goes wrong.
//   - kb:architecture/discipline/error-handling-discipline §"Pattern 1:
//     Fail fast on programmer errors" — refusal flag = the model refused;
//     not a transient retryable parse problem; surface immediately.
//   - kb:architecture/ai-systems/inference-cost-management §"Lever 1:
//     Model selection" — 4o-mini for derivative structured extraction.
//   - kb:architecture/crosscut/idempotency — the function is deterministic
//     modulo LLM stochasticity: same `narrative` input, same `temperature`
//     (0.2), same `model`. Callers can cache by `narrative` hash safely.

import { openai } from './client';
import { actualCost } from './cost';
import { withRetry } from './_retry';
import { WIRE_SCHEMA, fromWire } from '@/lib/diagrams/wire-schema';
import { EXTRACT_SYSTEM_PROMPT } from '@/lib/prompts/extract-diagrams';
import type { DiagramPayload } from '@/lib/diagrams/schema';

const MODEL = 'gpt-4o-mini';
const MAX_COMPLETION_TOKENS = 2048;
const TEMPERATURE = 0.2;

// ───────────────────────────────────────────────────────────────────────────
// Public types
// ───────────────────────────────────────────────────────────────────────────

export interface ExtractDiagramsArgs {
  /** The chapter narrative just produced by narrative-only.ts. */
  narrative: string;
  /** Cooperative abort. Honored between attempts and propagated to fetch. */
  abortSignal?: AbortSignal;
}

export interface ExtractDiagramsResult {
  /** Wire entries that successfully translated AND passed Zod validation. */
  diagrams: DiagramPayload[];
  /** Wire entries that failed fromWire (shape-invalid OR Zod-invalid). The
   *  caller (per-chapter.ts) will persist this for telemetry. */
  droppedCount: number;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  model: string;
}

/**
 * Thrown when the OpenAI response can't be parsed or is structurally
 * malformed. Registered as parse-retryable with withRetry so a single bad
 * response gets exactly one retry before bubbling up.
 *
 * NOT thrown on refusal — refusal is a deliberate model decision; retrying
 * just repeats the refusal and burns spend. Refusal surfaces as a plain
 * Error (non-retryable).
 */
export class ExtractParseError extends Error {
  public readonly rawText: string | undefined;
  constructor(message: string, rawText?: string) {
    super(message);
    this.name = 'ExtractParseError';
    this.rawText = rawText;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Public function
// ───────────────────────────────────────────────────────────────────────────

export async function extractDiagrams(
  args: ExtractDiagramsArgs,
): Promise<ExtractDiagramsResult> {
  const { narrative, abortSignal } = args;

  return withRetry({
    operationName: 'extract-diagrams',
    abortSignal,
    isParseError: (err) => err instanceof ExtractParseError,
    fn: async () => {
      const response = await openai.chat.completions.create(
        {
          model: MODEL,
          messages: [
            { role: 'system', content: EXTRACT_SYSTEM_PROMPT },
            { role: 'user', content: narrative },
          ],
          response_format: {
            type: 'json_schema',
            json_schema: {
              name: 'extracted_diagrams',
              strict: true,
              // `as unknown as Record<string, unknown>` — WIRE_SCHEMA is
              // declared `as const` (deep readonly literals) but the SDK
              // types accept a plain object. The shape is identical; the
              // cast is purely to satisfy variance.
              schema: WIRE_SCHEMA as unknown as Record<string, unknown>,
            },
          },
          stream: false,
          max_tokens: MAX_COMPLETION_TOKENS,
          temperature: TEMPERATURE,
        },
        { signal: abortSignal },
      );

      const choice = response.choices[0];
      if (!choice) {
        throw new ExtractParseError('no choices in response');
      }

      // Refusal channel: when the model declines, the SDK exposes a
      // `refusal` string on the message. This is INTENTIONAL by the model
      // (e.g., a safety refusal). Retrying just burns tokens, so we surface
      // as a plain Error (non-retryable — withRetry's isParseError predicate
      // only matches ExtractParseError).
      const refusal = (choice.message as { refusal?: unknown }).refusal;
      if (typeof refusal === 'string' && refusal.length > 0) {
        throw new Error(`extract-diagrams: model refused (${refusal})`);
      }

      const text = choice.message?.content ?? '';
      const promptTokens = response.usage?.prompt_tokens ?? 0;
      const completionTokens = response.usage?.completion_tokens ?? 0;

      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch (err) {
        throw new ExtractParseError(
          `JSON.parse failed: ${(err as Error).message}`,
          text,
        );
      }

      if (!isObject(parsed)) {
        throw new ExtractParseError('response is not an object', text);
      }
      const rawDiagrams = (parsed as { diagrams?: unknown }).diagrams;
      if (!Array.isArray(rawDiagrams)) {
        throw new ExtractParseError(
          'response.diagrams is not an array',
          text,
        );
      }

      // Walk each entry through fromWire. Invalid entries return null;
      // we drop them and bump droppedCount. This is the empirically-
      // important graceful-degradation path: a single malformed cell
      // shouldn't take out the entire emission.
      const diagrams: DiagramPayload[] = [];
      let droppedCount = 0;
      for (const entry of rawDiagrams) {
        const payload = fromWire(entry);
        if (payload === null) {
          droppedCount++;
        } else {
          diagrams.push(payload);
        }
      }

      const costUsd = actualCost({
        model: MODEL,
        promptTokens,
        completionTokens,
      });
      return {
        diagrams,
        droppedCount,
        promptTokens,
        completionTokens,
        costUsd,
        model: MODEL,
      };
    },
  });
}

// ───────────────────────────────────────────────────────────────────────────
// Internal
// ───────────────────────────────────────────────────────────────────────────

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}
