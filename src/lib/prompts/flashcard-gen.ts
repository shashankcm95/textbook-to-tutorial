/**
 * src/lib/prompts/flashcard-gen.ts — INTENTIONALLY EMPTY in MVP.
 *
 * Rationale: chapter-gen.ts produces narrative + questions + flashcards in
 * a single OpenAI call. Splitting flashcard generation into its own prompt
 * is deferred until eval shows quality demands a focused prompt + the cost
 * of an extra call is justified.
 *
 * See src/lib/prompts/quiz-gen.ts for the parallel rationale.
 *
 * Future split: implement buildFlashcardGenSystemPrompt +
 * buildFlashcardGenUserPrompt + FLASHCARD_GEN_RESPONSE_FORMAT mirroring
 * chapter-gen.ts.
 */

export {};
