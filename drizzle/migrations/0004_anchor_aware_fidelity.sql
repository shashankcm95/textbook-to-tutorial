-- 0004_anchor_aware_fidelity.sql — Feature B' makes the fidelity scorer
-- whitelist-aware. Adds two nullable columns so existing rows (scored before
-- Feature B' shipped) remain valid; new scores populate them.
--
-- Driven by design doc: docs/design/feature-b-voice-and-anchor-profile.md
-- §Component 5 — Fidelity Scorer Update.
--
-- Note: SQLite ALTER TABLE ADD COLUMN does NOT support CHECK constraints in
-- older versions. The application layer enforces non-negativity for the
-- counts written here.

ALTER TABLE `chapter_fidelity_scores`
  ADD COLUMN `whitelist_anchors_preserved` integer;
--> statement-breakpoint
ALTER TABLE `chapter_fidelity_scores`
  ADD COLUMN `whitelist_anchors_missing` integer;
