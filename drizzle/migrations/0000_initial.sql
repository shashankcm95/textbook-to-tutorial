-- 0000_initial.sql — TB_to_Tutorial_converter initial schema (7 tables).
--
-- Hand-written (NOT drizzle-kit generated) per Phase 2 Wave 1 constraint
-- (no pnpm available at codegen time; ari design + riley deltas locked).
-- See src/db/schema.ts for the Drizzle TS source-of-truth.
--
-- Conventions:
--   - All TIMESTAMP columns are SQLite INTEGER (unix seconds) per Drizzle
--     `mode: 'timestamp'` convention.
--   - CHECK constraints enforce enum-shaped status fields + index range.
--   - All FK relationships ON DELETE CASCADE — when a tutorial is deleted,
--     its chapters → questions/flashcards → srs_reviews cascade.
--     CAUTION: cascade blast-radius is broad; see report finding HIGH-1.
--   - Indices follow ari Phase 1 design exactly; no speculative add'ns.
--
-- Applied programmatically by `src/db/migrate.ts`; never run by hand.

-- ─────────────────────────────────────────────────────────────────────────────
-- users
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE `users` (
  `id` text PRIMARY KEY NOT NULL,
  `session_cookie_hash` text NOT NULL,
  `created_at` integer DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
  `last_seen_at` integer DEFAULT (CURRENT_TIMESTAMP) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_session_cookie_hash_unique` ON `users` (`session_cookie_hash`);
--> statement-breakpoint
CREATE INDEX `idx_users_cookie` ON `users` (`session_cookie_hash`);
--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- tutorials
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE `tutorials` (
  `id` text PRIMARY KEY NOT NULL,
  `user_id` text NOT NULL,
  `source_s3_url` text NOT NULL,
  `source_pdf_sha256` text,
  `status` text NOT NULL,
  `error_message` text,
  `total_pages` integer,
  `total_chapters` integer,
  `created_at` integer DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
  CHECK (`status` IN ('ingesting','parsing','ready-to-generate','generating','complete','error'))
);
--> statement-breakpoint
CREATE INDEX `idx_tutorials_user` ON `tutorials` (`user_id`);
--> statement-breakpoint
CREATE INDEX `idx_tutorials_status` ON `tutorials` (`status`);
--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- chapters (incl. riley HIGH-2 observational fields)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE `chapters` (
  `id` text PRIMARY KEY NOT NULL,
  `tutorial_id` text NOT NULL,
  `ordinal` integer NOT NULL,
  `title` text NOT NULL,
  `narrative` text,
  `source_page_start` integer NOT NULL,
  `source_page_end` integer NOT NULL,
  `source_paragraphs_json` text NOT NULL,
  `status` text NOT NULL,
  `is_read` integer DEFAULT 0 NOT NULL,
  -- riley HIGH-2 absorb (observational completion model) --
  `viewed_at` integer,
  `scroll_depth_pct` real,
  `time_spent_seconds` integer DEFAULT 0 NOT NULL,
  `last_quiz_attempt_at` integer,
  `last_quiz_score` real,
  FOREIGN KEY (`tutorial_id`) REFERENCES `tutorials`(`id`) ON UPDATE no action ON DELETE cascade,
  CHECK (`status` IN ('pending','generating','complete','failed','partial')),
  CHECK (`is_read` IN (0,1)),
  CHECK (`scroll_depth_pct` IS NULL OR (`scroll_depth_pct` BETWEEN 0.0 AND 1.0)),
  CHECK (`last_quiz_score` IS NULL OR (`last_quiz_score` BETWEEN 0.0 AND 1.0))
);
--> statement-breakpoint
CREATE INDEX `idx_chapters_tutorial_ordinal` ON `chapters` (`tutorial_id`, `ordinal`);
--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- questions
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE `questions` (
  `id` text PRIMARY KEY NOT NULL,
  `chapter_id` text NOT NULL,
  `prompt` text NOT NULL,
  `options_json` text NOT NULL,
  `correct_index` integer NOT NULL,
  `explanation` text NOT NULL,
  `source_paragraph_ref` text NOT NULL,
  FOREIGN KEY (`chapter_id`) REFERENCES `chapters`(`id`) ON UPDATE no action ON DELETE cascade,
  CHECK (`correct_index` BETWEEN 0 AND 3)
);
--> statement-breakpoint
CREATE INDEX `idx_questions_chapter` ON `questions` (`chapter_id`);
--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- flashcards
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE `flashcards` (
  `id` text PRIMARY KEY NOT NULL,
  `chapter_id` text NOT NULL,
  `front` text NOT NULL,
  `back` text NOT NULL,
  `source_paragraph_ref` text NOT NULL,
  FOREIGN KEY (`chapter_id`) REFERENCES `chapters`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_flashcards_chapter` ON `flashcards` (`chapter_id`);
--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- srs_reviews (incl. riley HIGH-1 PARTIAL SM-2 future-proof columns)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE `srs_reviews` (
  `flashcard_id` text NOT NULL,
  `user_id` text NOT NULL,
  `box` integer DEFAULT 1 NOT NULL,
  `last_reviewed_at` integer,
  `due_at` integer NOT NULL,
  `consecutive_correct` integer DEFAULT 0 NOT NULL,
  -- riley HIGH-1 PARTIAL absorb (SM-2 / FSRS future-proofing); null until enabled --
  `ease_factor` real,
  `interval_days` real,
  PRIMARY KEY (`flashcard_id`, `user_id`),
  FOREIGN KEY (`flashcard_id`) REFERENCES `flashcards`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
  CHECK (`box` BETWEEN 1 AND 5),
  CHECK (`consecutive_correct` >= 0)
);
--> statement-breakpoint
CREATE INDEX `idx_srs_due` ON `srs_reviews` (`user_id`, `due_at`);
--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- parses_cost (incl. ari HIGH-3 validation_drop_count)
-- chapter_id NULLABLE — parse-level (whole PDF) vs chapter-level (per LLM call).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE `parses_cost` (
  `id` text PRIMARY KEY NOT NULL,
  `tutorial_id` text NOT NULL,
  `chapter_id` text,
  `model` text NOT NULL,
  `prompt_tokens` integer NOT NULL,
  `completion_tokens` integer NOT NULL,
  `cost_usd` real NOT NULL,
  `validation_drop_count` integer DEFAULT 0 NOT NULL,
  `created_at` integer DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
  FOREIGN KEY (`tutorial_id`) REFERENCES `tutorials`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`chapter_id`) REFERENCES `chapters`(`id`) ON UPDATE no action ON DELETE cascade,
  CHECK (`prompt_tokens` >= 0),
  CHECK (`completion_tokens` >= 0),
  CHECK (`cost_usd` >= 0.0),
  CHECK (`validation_drop_count` >= 0)
);
--> statement-breakpoint
CREATE INDEX `idx_cost_tutorial` ON `parses_cost` (`tutorial_id`);
