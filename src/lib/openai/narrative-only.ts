// src/lib/openai/narrative-only.ts — 4o streaming narrative generator.
//
// First half of the hybrid-model architecture: gpt-4o reads source paragraphs
// and produces a markdown narrative with inline `[ref:pageN:paragraphM]`
// citations. Streams token-by-token via onToken callback (caller bridges to
// SSE). Returns the parsed narrative + actual usage + cost.
//
// Quiz + flashcards are NOT generated here — they're a separate 4o-mini call
// in quiz-from-narrative.ts that consumes the narrative as input.
//
// Design anchors:
//   - kb:architecture/ai-systems/inference-cost-management §"Lever 1: Model
//     selection" — gpt-4o for the comprehension step (better quality at small
//     input sizes thanks to lazy chunking).
//   - kb:architecture/ai-systems/inference-cost-management §"Lever 5: Output
//     control" — structured output (narrative-only schema) caps drift.
//   - kb:architecture/discipline/stability-patterns §Fail-Fast — JSON parse
//     errors throw immediately; caller decides retry vs mark failed.

import { openai } from './client';
import { actualCost, isSupportedModel, UnknownModelError } from './cost';
import { withRetry } from './_retry';
import {
  buildNarrativeOnlySystemPrompt,
  buildNarrativeOnlyUserPrompt,
  NARRATIVE_ONLY_RESPONSE_FORMAT,
} from '@/lib/prompts/narrative-only';
import type { SourceParagraph } from '@/lib/types';
import type { VoiceProfile } from '@/lib/ingest/voice-extract';
import type { AnchorWhitelistEntry } from './anchor-validator';

const MODEL = 'gpt-4o';
const MAX_COMPLETION_TOKENS = 3500;

export interface NarrativeOnlyArgs {
  chapterTitle: string;
  sourceParagraphs: SourceParagraph[];
  abortSignal?: AbortSignal;
  /** Fires per streaming token delta; caller bridges to SSE 'token' event. */
  onToken: (delta: string) => void;
  /**
   * Feature B' Wave 2 — optional author voice profile to prepend to the
   * system prompt. No-op when absent (graceful degradation for tutorials
   * generated before the voice-extract pipeline existed).
   */
  voiceProfile?: VoiceProfile;
  /**
   * Feature B' Wave 2 — optional named-anchor whitelist to prepend to the
   * system prompt. No-op when absent or empty (the source-grounding pass
   * found no load-bearing anchors for this chunk).
   */
  anchorWhitelist?: AnchorWhitelistEntry[];
  /**
   * Sprint J — optional canonical glossary to prepend to the system
   * prompt. No-op when absent or empty (the labeled-section extractor
   * AND the NP-fallback both produced zero terms, or the tutorial pre-
   * dates Sprint J entirely). The prompt-builder caps the rendered list
   * at MAX_GLOSSARY_ENTRIES (currently 80) as defense against pipeline
   * cardinality drift.
   */
  glossary?: import('@/lib/prompts/narrative-only').GlossaryTermEntry[];
}

export interface NarrativeOnlyResult {
  narrative: string;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  model: string;
}

export class NarrativeParseError extends Error {
  constructor(message: string, public readonly rawText: string) {
    super(message);
    this.name = 'NarrativeParseError';
  }
}

export async function generateNarrativeOnly(
  args: NarrativeOnlyArgs,
): Promise<NarrativeOnlyResult> {
  const {
    chapterTitle,
    sourceParagraphs,
    abortSignal,
    onToken,
    voiceProfile,
    anchorWhitelist,
    glossary,
  } = args;
  if (!isSupportedModel(MODEL)) throw new UnknownModelError(MODEL);

  const systemPrompt = buildNarrativeOnlySystemPrompt({
    voiceProfile,
    anchorWhitelist,
    glossary,
  });
  const userPrompt = buildNarrativeOnlyUserPrompt({ chapterTitle, sourceParagraphs });

  // DRIFT-test3-032: wrap in shared retry policy. Without this, a single 429
  // from OpenAI marked the chapter `failed`, threw away the prompt tokens,
  // and surfaced a dead chapter to the user. The retry policy honors abort
  // cooperatively; NarrativeParseError is recognized as parse-retryable so a
  // transient bad-JSON streams gets ONE retry (attempt index >0) with no
  // backoff. Caller (per-chapter.ts) is unchanged otherwise.
  return withRetry({
    operationName: 'narrative-only',
    abortSignal,
    isParseError: (err) => err instanceof NarrativeParseError,
    fn: async () => {
      const stream = await openai.chat.completions.create(
        {
          model: MODEL,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          response_format: NARRATIVE_ONLY_RESPONSE_FORMAT,
          stream: true,
          stream_options: { include_usage: true },
          max_tokens: MAX_COMPLETION_TOKENS,
          temperature: 0.3,
        },
        { signal: abortSignal },
      );

      let accumulated = '';
      let promptTokens = 0;
      let completionTokens = 0;
      for await (const chunk of stream) {
        if (abortSignal?.aborted) throw new Error('aborted');
        const delta = chunk.choices[0]?.delta?.content;
        if (typeof delta === 'string' && delta.length > 0) {
          accumulated += delta;
          onToken(delta);
        }
        if (chunk.usage) {
          promptTokens = chunk.usage.prompt_tokens;
          completionTokens = chunk.usage.completion_tokens;
        }
      }

      // Parse the strict-mode JSON output and extract narrative field.
      let parsed: unknown;
      try {
        parsed = JSON.parse(accumulated);
      } catch (err) {
        throw new NarrativeParseError(
          `JSON.parse failed: ${(err as Error).message}`,
          accumulated,
        );
      }
      if (!isObjectWithNarrative(parsed)) {
        throw new NarrativeParseError('response missing narrative field', accumulated);
      }

      const costUsd = actualCost({ model: MODEL, promptTokens, completionTokens });
      return {
        narrative: parsed.narrative,
        promptTokens,
        completionTokens,
        costUsd,
        model: MODEL,
      };
    },
  });
}

function isObjectWithNarrative(x: unknown): x is { narrative: string } {
  return (
    typeof x === 'object' &&
    x !== null &&
    'narrative' in x &&
    typeof (x as { narrative: unknown }).narrative === 'string'
  );
}
