-- 0008_fix_timestamp_text_defaults.sql — repair legacy TEXT timestamp values.
--
-- Schema discovery 2026-05-27: four timestamp columns declared in
-- `src/db/schema.ts` as `integer mode='timestamp'` were using
-- `.default(sql\`CURRENT_TIMESTAMP\`)` at the ORM layer. Drizzle injects
-- that as a literal at INSERT time, yielding TEXT like
-- '2026-05-27 18:39:28' in a column typed as integer. The downstream
-- `mode='timestamp'` coercion then produced NaN when those rows were read
-- back as Date objects — surfaced visually as "Added NaN-NaN-NaN" in
-- the library page tiles (PR #50 added a defensive read-side helper).
--
-- The column-level DEFAULT in the original CREATE TABLE statements is
-- already `unixepoch()` (correct — integer seconds). So this migration:
--
--   1. Rewrites existing TEXT rows to integer seconds via SQLite's
--      `unixepoch(<text>)` parser. Idempotent: `typeof = 'text'` filter
--      skips rows already in integer form.
--   2. The schema.ts companion change flips `.default(sql\`CURRENT_TIMESTAMP\`)`
--      → `.default(sql\`(unixepoch())\`)` so future inserts also write
--      integer seconds. No table rebuild needed.
--
-- Columns touched:
--   - users.created_at
--   - users.last_seen_at
--   - tutorials.created_at
--   - parses_cost.created_at
--   - chapters.viewed_at (defensive — populated by app code, likely
--     already integer, but covered against any drift)
--
-- Safe to re-run: each UPDATE is guarded by `typeof = 'text'`. Rows
-- already in integer form are skipped.

UPDATE `users`
  SET `created_at` = unixepoch(`created_at`)
  WHERE typeof(`created_at`) = 'text';
--> statement-breakpoint

UPDATE `users`
  SET `last_seen_at` = unixepoch(`last_seen_at`)
  WHERE typeof(`last_seen_at`) = 'text';
--> statement-breakpoint

UPDATE `tutorials`
  SET `created_at` = unixepoch(`created_at`)
  WHERE typeof(`created_at`) = 'text';
--> statement-breakpoint

UPDATE `parses_cost`
  SET `created_at` = unixepoch(`created_at`)
  WHERE typeof(`created_at`) = 'text';
--> statement-breakpoint

UPDATE `chapters`
  SET `viewed_at` = unixepoch(`viewed_at`)
  WHERE typeof(`viewed_at`) = 'text';
