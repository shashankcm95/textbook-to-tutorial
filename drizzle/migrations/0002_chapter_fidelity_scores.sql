-- 0002_chapter_fidelity_scores.sql — fidelity-check scoring (DRIFT-test3-022)
--
-- Adds a side-table for narrative-vs-source fidelity scores. After narrative
-- generation, a 4o-mini call counts how many of the source's load-bearing
-- elements survived into the narrative: specific numbers, named examples,
-- terminological contrasts. The composite score (0-100) is persisted here
-- and surfaced as a per-chapter quality signal.
--
-- Why a separate table (not columns on chapters):
--   - Allows multiple fidelity scores over time (regeneration history).
--   - Doesn't bloat the chapters projection used by SSR.
--   - Cleanly cascade-deletes on chapter removal.
--
-- Driven by the post-merge critique audit that found chapter 1 ("Reliability")
-- silently dropped the 10,000-disks number, the leap-second bug, the
-- configuration-error 10-25% statistic, and the fault/failure contrast —
-- all named in DDIA as load-bearing.

CREATE TABLE `chapter_fidelity_scores` (
  `id` text PRIMARY KEY NOT NULL,
  `chapter_id` text NOT NULL,
  -- Counts of preserved elements (>= 0)
  `specific_numbers_preserved` integer NOT NULL DEFAULT 0,
  `named_examples_preserved` integer NOT NULL DEFAULT 0,
  `terminological_contrasts_preserved` integer NOT NULL DEFAULT 0,
  -- Counts of MISSING elements that the scorer flagged
  `specific_numbers_missing` integer NOT NULL DEFAULT 0,
  `named_examples_missing` integer NOT NULL DEFAULT 0,
  `terminological_contrasts_missing` integer NOT NULL DEFAULT 0,
  -- Composite 0-100 score (higher = more faithful)
  `overall_score` integer NOT NULL,
  -- LLM-generated notes about what was dropped (JSON array of strings)
  `notes_json` text NOT NULL DEFAULT '[]',
  -- Cost tracking (scoring itself is a 4o-mini call)
  `model` text NOT NULL,
  `prompt_tokens` integer NOT NULL,
  `completion_tokens` integer NOT NULL,
  `cost_usd` real NOT NULL,
  `created_at` integer DEFAULT (unixepoch()) NOT NULL,
  FOREIGN KEY (`chapter_id`) REFERENCES `chapters`(`id`) ON UPDATE no action ON DELETE cascade,
  CHECK (`overall_score` BETWEEN 0 AND 100)
);
--> statement-breakpoint
-- Query path: "latest fidelity score for chapter X" → ORDER BY created_at DESC LIMIT 1
CREATE INDEX `idx_fidelity_chapter_recent` ON `chapter_fidelity_scores` (`chapter_id`, `created_at`);
