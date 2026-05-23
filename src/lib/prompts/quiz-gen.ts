/**
 * src/lib/prompts/quiz-gen.ts — INTENTIONALLY EMPTY in MVP.
 *
 * Rationale: chapter-gen.ts produces narrative + questions + flashcards in
 * a single OpenAI call (see kb:architecture/ai-systems/inference-cost-
 * management §"Lever 2: Context management" — sharing source-text context
 * across all three artifacts avoids 3× input-cost replay).
 *
 * Split into a per-type prompt only when:
 *   1. Eval shows question quality is materially worse than what a focused
 *      prompt + chain-of-thought would produce.
 *   2. The cost of running TWO calls (narrative-only + quiz-only) is
 *      justified by the quality delta (per cost-vs-quality eval discipline
 *      in kb:architecture/ai-systems/inference-cost-management §"Tensions").
 *
 * Until then, this file is a placeholder so the import-graph slot exists.
 * Future split: implement buildQuizGenSystemPrompt + buildQuizGenUserPrompt
 * + QUIZ_GEN_RESPONSE_FORMAT mirroring chapter-gen.ts.
 */

export {};
