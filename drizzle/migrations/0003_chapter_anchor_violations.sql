-- 0003_chapter_anchor_violations.sql — Feature B' anchor validator persistence.
--
-- After narrative generation, src/lib/openai/anchor-validator.ts checks whether
-- whitelist anchors present in a chunk's source paragraphs appear verbatim in
-- the generated narrative. Each chapter generation that produces violations
-- writes one row here. Side-table (not chapter column) for the same reasons
-- chapter_fidelity_scores is a side-table: allows multiple violation records
-- per chapter (regen history), doesn't bloat the chapters projection.
--
-- Driven by design doc: docs/design/feature-b-voice-and-anchor-profile.md
-- §Component 4 — Anchor Validator.
--
-- Wave-1 review HIGH-1 + HIGH-2 fixes (migrations + schema reviewer):
--   * Added non-negativity CHECKs on expected_count and found_count
--   * Added relationship CHECK: found_count <= expected_count
--     (without this, a buggy validator returning found > expected would
--      pass the score-range CHECK after division produces score > 1 only
--      via the cap; corrupt data could still land if score happened to
--      land in-range — the relationship check rejects the underlying
--      inconsistency, not just the symptom.)
-- The `score` column remains as a stored value (NOT computed) for query
-- convenience. App-enforced invariant: score must equal
-- found_count / expected_count, or 1.0 when expected_count = 0 (vacuous
-- perfect — no anchors in source means no fidelity test to fail). Caller
-- in src/lib/openai/anchor-validator.ts is the single producer; that
-- invariant is enforced there before INSERT.

CREATE TABLE `chapter_anchor_violations` (
  `id` text PRIMARY KEY NOT NULL,
  `chapter_id` text NOT NULL,
  `expected_count` integer NOT NULL,    -- whitelist anchors present in source paragraphs for this chunk
  `found_count` integer NOT NULL,       -- of those, how many appeared in the narrative
  `missing_anchors_json` text NOT NULL DEFAULT '[]',  -- JSON array of strings (the terms that were dropped)
  `score` real NOT NULL,                -- found_count / expected_count, in [0, 1] (or 1.0 when expected_count=0)
  `policy_applied` text NOT NULL DEFAULT 'log-and-continue',  -- 'log-and-continue' | 'forced-regen'
  `regen_triggered` integer NOT NULL DEFAULT 0,  -- 0 = no, 1 = yes (boolean as integer per SQLite convention)
  `created_at` integer DEFAULT (unixepoch()) NOT NULL,
  FOREIGN KEY (`chapter_id`) REFERENCES `chapters`(`id`) ON UPDATE no action ON DELETE cascade,
  CHECK (`expected_count` >= 0),
  CHECK (`found_count` >= 0),
  CHECK (`found_count` <= `expected_count`),
  CHECK (`score` BETWEEN 0 AND 1),
  CHECK (`policy_applied` IN ('log-and-continue', 'forced-regen')),
  CHECK (`regen_triggered` IN (0, 1))
);
--> statement-breakpoint
CREATE INDEX `idx_anchor_violations_chapter_recent` ON `chapter_anchor_violations` (`chapter_id`, `created_at`);
