#!/usr/bin/env tsx
/**
 * scripts/regenerate-chapters.ts — one-shot regeneration driver.
 *
 * Calls the per-chapter generator directly (no HTTP) for a given tutorial id
 * and chapter ordinal range. Useful for:
 *   - Smoke-testing prompt changes against existing tutorials
 *   - Bypassing client-disconnect-during-long-stream issues
 *   - Re-running fidelity scoring on already-generated chapters
 *
 * Usage: pnpm tsx scripts/regenerate-chapters.ts <tutorialId> <startIdx> <endIdx>
 *
 * Example: pnpm tsx scripts/regenerate-chapters.ts a4163650-... 0 5
 */

import { generateChapter, ChapterGenerationError } from '../src/lib/generation/per-chapter';

async function main() {
  const [tutorialId, startIdxStr, endIdxStr] = process.argv.slice(2);
  if (!tutorialId || !startIdxStr || !endIdxStr) {
    console.error('Usage: tsx regenerate-chapters.ts <tutorialId> <startIdx> <endIdx>');
    process.exit(1);
  }
  const startIdx = Number.parseInt(startIdxStr, 10);
  const endIdx = Number.parseInt(endIdxStr, 10);

  for (let idx = startIdx; idx <= endIdx; idx++) {
    const t0 = Date.now();
    let tokenCount = 0;
    try {
      const result = await generateChapter({
        tutorialId,
        chapterIdx: idx,
        onNarrativeToken: () => {
          tokenCount++;
        },
      });
      const elapsedSec = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(
        `ch${idx}: ${result.status} (${result.questionsCount}Q + ${result.flashcardsCount}F, drops=${result.validationDropCount}) ` +
          `cost=$${result.totalCostUsd.toFixed(5)} tokens=${tokenCount} elapsed=${elapsedSec}s`,
      );
    } catch (err) {
      if (err instanceof ChapterGenerationError) {
        console.log(`ch${idx}: SKIP (${err.code}: ${err.message})`);
      } else {
        console.error(`ch${idx}: ERROR ${(err as Error).message}`);
      }
    }
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
