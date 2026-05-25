-- 0005_pdf_metadata.sql — Sprint D Phase 1: per-PDF metadata extraction.
--
-- Replaces the filename-heuristic-only attribution path. At ingest time the
-- worker now extracts Title + Author from the PDF /Info dictionary (or the
-- XMP stream as fallback) and persists them here, alongside a source field
-- describing where the values came from:
--
--   'pdf-info' / 'pdf-xmp' → high-confidence; suppresses the "Auto-detected"
--                            warning badge that PR #22 introduced as stop-gap
--   'filename'             → derived from the S3 key by the existing heuristic;
--                            keeps the warning badge on
--   'none'                 → no source yielded a value (extraction failed AND
--                            filename was also empty)
--
-- All three columns are nullable. Pre-migration rows have NULL across the
-- board — the application code falls through to the URL heuristic for those
-- so the user-visible behavior is unchanged until the next ingest of the
-- same tutorial (or a new tutorial entirely).
--
-- Schema-additive (per the project's migration discipline; see schema.ts
-- file-level comment). SQLite ALTER TABLE ADD COLUMN is a no-rewrite
-- metadata-only op on modern SQLite (≥3.35), so the cost is constant
-- regardless of `tutorials` row count.

ALTER TABLE `tutorials`
  ADD COLUMN `book_title` text;
--> statement-breakpoint
ALTER TABLE `tutorials`
  ADD COLUMN `book_author` text;
--> statement-breakpoint
ALTER TABLE `tutorials`
  ADD COLUMN `metadata_source` text;
