// src/lib/openai/quiz-from-narrative.ts — 4o-mini quiz + flashcard derivation.
//
// Second half of the hybrid architecture: takes the narrative just produced by
// gpt-4o + the chapter's source paragraphs (for ref validation) and emits
// 5-10 quiz questions + 15-25 flashcards. Non-streaming — the output is
// structured + small enough that streaming adds nothing useful.
//
// Why 4o-mini (not 4o):
//   - The work is derivative: read the narrative, extract testable points.
//     Doesn't need deep reasoning — 4o-mini is enough.
//   - Cost: ~3K input + 2K output ≈ $0.002 per chapter, vs $0.02+ for 4o.
//
// Refs are validated against the source paragraphs; invalid refs cause that
// question/flashcard to be dropped (counted in validationDropCount, persisted
// in parses_cost for telemetry).

import { openai } from './client';
import { actualCost } from './cost';
import {
  buildQuizFromNarrativeSystemPrompt,
  buildQuizFromNarrativeUserPrompt,
  QUIZ_FROM_NARRATIVE_RESPONSE_FORMAT,
} from '@/lib/prompts/quiz-from-narrative';
import { validateRef } from '@/lib/pdf/paragraph-anchors';
import type { SourceParagraph, QuizQuestion, LLMFlashcard } from '@/lib/types';

const MODEL = 'gpt-4o-mini';
const MAX_COMPLETION_TOKENS = 4096;

export interface QuizFromNarrativeArgs {
  chapterTitle: string;
  narrative: string;
  sourceParagraphs: SourceParagraph[];
  abortSignal?: AbortSignal;
}

export interface QuizFromNarrativeResult {
  questions: QuizQuestion[];
  flashcards: LLMFlashcard[];
  validationDropCount: number;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  model: string;
}

export class QuizParseError extends Error {
  constructor(message: string, public readonly rawText: string) {
    super(message);
    this.name = 'QuizParseError';
  }
}

export async function generateQuizFromNarrative(
  args: QuizFromNarrativeArgs,
): Promise<QuizFromNarrativeResult> {
  const { chapterTitle, narrative, sourceParagraphs, abortSignal } = args;

  const systemPrompt = buildQuizFromNarrativeSystemPrompt();
  const userPrompt = buildQuizFromNarrativeUserPrompt({
    chapterTitle,
    narrative,
    sourceParagraphs,
  });

  const response = await openai.chat.completions.create(
    {
      model: MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      response_format: QUIZ_FROM_NARRATIVE_RESPONSE_FORMAT,
      max_tokens: MAX_COMPLETION_TOKENS,
      temperature: 0.2,
    },
    { signal: abortSignal },
  );

  const text = response.choices[0]?.message?.content ?? '';
  const promptTokens = response.usage?.prompt_tokens ?? 0;
  const completionTokens = response.usage?.completion_tokens ?? 0;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new QuizParseError(`JSON.parse failed: ${(err as Error).message}`, text);
  }

  if (!isObject(parsed)) throw new QuizParseError('response is not an object', text);
  const rawQ = Array.isArray(parsed.questions) ? (parsed.questions as QuizQuestion[]) : [];
  const rawF = Array.isArray(parsed.flashcards) ? (parsed.flashcards as LLMFlashcard[]) : [];

  // Validate refs; drop invalids; count drops.
  let droppedCount = 0;
  const questions: QuizQuestion[] = [];
  for (const q of rawQ) {
    if (typeof q.sourceParagraphRef === 'string' && validateRef(q.sourceParagraphRef, sourceParagraphs)) {
      questions.push(q);
    } else {
      droppedCount++;
    }
  }
  const flashcards: LLMFlashcard[] = [];
  for (const f of rawF) {
    if (typeof f.sourceParagraphRef === 'string' && validateRef(f.sourceParagraphRef, sourceParagraphs)) {
      flashcards.push(f);
    } else {
      droppedCount++;
    }
  }

  const costUsd = actualCost({ model: MODEL, promptTokens, completionTokens });
  return {
    questions,
    flashcards,
    validationDropCount: droppedCount,
    promptTokens,
    completionTokens,
    costUsd,
    model: MODEL,
  };
}

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}
