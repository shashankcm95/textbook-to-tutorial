// src/lib/prompts/quiz-from-narrative.ts — prompts for the quiz/flashcard
// derivation call (gpt-4o-mini, second half of the hybrid architecture).
//
// Input: the narrative just produced by gpt-4o + the chapter's source paragraphs
// (needed for ref validation — the model cites paragraphs that the narrative
// referenced, so we need them in scope).
//
// Output: 5-10 multiple-choice questions + 15-25 flashcards. Each item cites a
// source paragraph the narrative actually discussed.

import type { SourceParagraph } from '@/lib/types';

export function buildQuizFromNarrativeSystemPrompt(): string {
  return [
    'You generate quiz questions and flashcards from a tutorial narrative.',
    '',
    'INPUT:',
    '  1. A tutorial narrative (markdown with inline [ref:pageN:paragraphM] citations).',
    '  2. The SOURCE PARAGRAPHS the narrative was derived from.',
    '',
    'OUTPUT (strict JSON):',
    '  { "questions": [...5-10...], "flashcards": [...15-25...] }',
    '',
    'RULES:',
    '- Test ONLY concepts covered in the NARRATIVE. Do not invent topics the narrative did not discuss.',
    '- Every question and every flashcard MUST cite a sourceParagraphRef of the form "pageN:paragraphM"',
    '  using ONLY refs that appear in the narrative\'s inline `[ref:...]` markers OR the SOURCE PARAGRAPHS list.',
    '- Questions have exactly 4 options; correctIndex is 0..3 — index of the correct option.',
    '- Question explanation briefly explains WHY the correct answer is correct (1-2 sentences).',
    '- Flashcards: front is a short prompt (definition, "What is X?", quick recall); back is the concise answer.',
    '- Output strictly valid JSON. No prose outside the JSON.',
  ].join('\n');
}

export interface BuildQuizFromNarrativeUserPromptArgs {
  chapterTitle: string;
  narrative: string;
  sourceParagraphs: SourceParagraph[];
}

export function buildQuizFromNarrativeUserPrompt(
  args: BuildQuizFromNarrativeUserPromptArgs,
): string {
  const { chapterTitle, narrative, sourceParagraphs } = args;
  // Compact source refs — just the keys + first 120 chars of each para, so
  // the LLM can sanity-check ref attribution without re-reading full source.
  const sourceRefs = sourceParagraphs
    .map((p) => {
      const t = p.text.length > 120 ? p.text.slice(0, 120) + '…' : p.text;
      return `[page${p.page}:paragraph${p.paragraphIdx}] ${t}`;
    })
    .join('\n');
  return [
    `SECTION TITLE: ${chapterTitle}`,
    '',
    'NARRATIVE (use this as the primary source for question/card content):',
    narrative,
    '',
    'SOURCE PARAGRAPHS (the narrative was derived from these; cite these refs):',
    sourceRefs,
    '',
    'Generate the JSON quiz + flashcards now.',
  ].join('\n');
}

export const QUIZ_FROM_NARRATIVE_RESPONSE_FORMAT = {
  type: 'json_schema' as const,
  json_schema: {
    name: 'quiz_from_narrative_result',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['questions', 'flashcards'],
      properties: {
        questions: {
          type: 'array',
          minItems: 5,
          maxItems: 10,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['prompt', 'options', 'correctIndex', 'explanation', 'sourceParagraphRef'],
            properties: {
              prompt: { type: 'string' },
              options: {
                type: 'array',
                minItems: 4,
                maxItems: 4,
                items: { type: 'string' },
              },
              correctIndex: { type: 'integer', enum: [0, 1, 2, 3] },
              explanation: { type: 'string' },
              sourceParagraphRef: { type: 'string' },
            },
          },
        },
        flashcards: {
          type: 'array',
          minItems: 15,
          maxItems: 25,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['front', 'back', 'sourceParagraphRef'],
            properties: {
              front: { type: 'string' },
              back: { type: 'string' },
              sourceParagraphRef: { type: 'string' },
            },
          },
        },
      },
    },
  },
} as const;
