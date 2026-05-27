/**
 * src/lib/eval/variant.ts — variant manifest schema + apply/revert plumbing.
 *
 * A "variant" describes WHAT IS BEING COMPARED in a single A/B run.
 * Per docs/eval/HARNESS-DESIGN.md §"Variant model", three legal sources of
 * variation can be combined in one manifest:
 *
 *   1. Git ref         — harness uses `git worktree add` to spin a clean
 *                        working copy at the ref. (NOT IMPLEMENTED in this
 *                        first cut — see "Out of scope" below.)
 *   2. Prompt overrides — harness writes the override file(s) into the
 *                         active checkout, regens, restores. Implemented.
 *   3. Env / feature flags — passed through to the regen call as
 *                            process.env mutations (scoped + restored).
 *                            Implemented.
 *
 * The manifest is the harness's ONLY canonical input for "what to compare."
 * No magic flags, no implicit defaults beyond the ones declared here.
 *
 * ─── Out of scope for this first cut ─────────────────────────────────────
 *
 * Per the hard constraint "do not touch production paths," and per the
 * design's own §Sequencing ("Phase 1 is the foundation"), this module
 * implements the prompt-override + env-flag axes only. The git-ref axis
 * (which requires shelling out to `git worktree add`, spinning a second
 * Next.js dev-server per worktree, and routing regen calls into it) is
 * stubbed with a clear error message — when the user passes `git_ref`,
 * we explain that this axis lands in a follow-up PR. The manifest schema
 * already accepts the field so manifests written today stay valid.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';

// ─────────────────────────────────────────────────────────────────────────────
// Schema
// ─────────────────────────────────────────────────────────────────────────────

export const VariantManifestSchema = z.object({
  /** Display name for the variant (used in report tables and file paths). */
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-zA-Z0-9_.-]+$/, 'variant name must be alphanumeric + . _ -'),

  /**
   * Optional git ref to compare against. NOT IMPLEMENTED in this cut.
   * Recorded for forward-compat; harness errors out if non-empty.
   */
  git_ref: z.string().optional(),

  /**
   * Optional map of `<source-file-path> → <override-file-path>`. When
   * applying the variant, the harness backs up the original source file
   * and copies the override on top. On revert, the backup is restored.
   *
   * Paths are interpreted relative to the repo root.
   */
  prompt_overrides: z.record(z.string(), z.string()).optional(),

  /**
   * Optional env vars to set during the variant's regen pass. The harness
   * snapshots `process.env` before applying, mutates, and restores after.
   */
  env: z.record(z.string(), z.string()).optional(),

  /**
   * The tutorial whose chapters this variant regenerates / reads.
   *
   * Sprint E Tier 2 (2026-05-24): made optional at the schema level. When the
   * harness runs `--narratives-from=fs`, the DB is never queried and this
   * field is silently unused — round-3 PoC dogfood had to duplicate the same
   * id across both variants purely to satisfy schema validation.
   *
   * Runtime enforcement: `requireTutorialIdForDbMode()` (called by runner /
   * narrative-source factory) throws a clear error if a variant lacks
   * `tutorial_id` when the run is `--narratives-from=db`.
   */
  tutorial_id: z.string().min(1).optional(),

  /**
   * [startInclusive, endInclusive] chapter ordinals to evaluate. Default
   * [0, 5] per design §"Risks + open questions" R6.
   */
  chapter_range: z
    .tuple([z.number().int().min(0), z.number().int().min(0)])
    .default([0, 5])
    .refine(([s, e]) => s <= e, 'chapter_range[0] must be ≤ chapter_range[1]'),
});

export type VariantManifest = z.infer<typeof VariantManifestSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// I/O
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Read + validate a manifest from disk. Throws on schema failure with the
 * Zod error formatted for readability. JSON parsing happens first; if the
 * file isn't valid JSON, the JSON error propagates as-is.
 */
export function readVariantManifest(filePath: string): VariantManifest {
  const raw = fs.readFileSync(filePath, 'utf8');
  const parsed = JSON.parse(raw) as unknown;
  return VariantManifestSchema.parse(parsed);
}

/**
 * Sprint E Tier 2 (2026-05-24): assert that the variant carries a
 * `tutorial_id` when the harness will query the DB. Schema makes the field
 * optional (fs mode doesn't need it); this is the runtime gate for db mode.
 *
 * Throws with a single clear message naming the offending variant + the
 * mode that requires the field. Returns the narrowed string for ergonomic
 * use at the call site.
 */
export function requireTutorialIdForDbMode(
  variant: VariantManifest,
): string {
  if (!variant.tutorial_id) {
    throw new Error(
      `variant "${variant.name}": tutorial_id is required when ` +
        `--narratives-from=db. Add "tutorial_id" to the manifest, or run ` +
        `with --narratives-from=fs --narratives-dir <dir> to read from disk.`,
    );
  }
  return variant.tutorial_id;
}

// ─────────────────────────────────────────────────────────────────────────────
// Apply / revert
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Records what was changed when applying a variant so that revert() can
 * undo it. Returned by apply(); passed to revert().
 *
 * - `fileBackups`: map of `<destination-file> → <original-contents>`. Files
 *   that did not exist before are represented with `null` (revert removes them).
 * - `envSnapshot`: the `process.env` keys that were modified, with their
 *   original values. Keys absent from the original env map to `undefined`.
 */
export interface AppliedVariant {
  variant: VariantManifest;
  fileBackups: Map<string, string | null>;
  envSnapshot: Map<string, string | undefined>;
  /** Absolute path to the repo root, captured at apply time for revert. */
  repoRoot: string;
}

export function applyVariant(
  variant: VariantManifest,
  repoRoot: string,
): AppliedVariant {
  if (variant.git_ref) {
    throw new Error(
      `variant ${variant.name}: git_ref is declared but not yet implemented. ` +
        `The git-worktree axis lands in a follow-up PR (Phase 2 plumbing). ` +
        `For now, point variants at the active checkout and use prompt_overrides / env only.`,
    );
  }

  const fileBackups = new Map<string, string | null>();
  const envSnapshot = new Map<string, string | undefined>();

  // 1) Apply prompt overrides — back up existing, then copy override onto
  //    the destination. This MUST be atomic per-file (write + rename) so
  //    a crash mid-loop doesn't leave the tree in a half-applied state.
  if (variant.prompt_overrides) {
    for (const [dest, src] of Object.entries(variant.prompt_overrides)) {
      const absDest = path.resolve(repoRoot, dest);
      const absSrc = path.resolve(repoRoot, src);

      if (!fs.existsSync(absSrc)) {
        throw new Error(
          `variant ${variant.name}: prompt_overrides source "${src}" not found at ${absSrc}`,
        );
      }

      const prior = fs.existsSync(absDest) ? fs.readFileSync(absDest, 'utf8') : null;
      fileBackups.set(absDest, prior);

      const overrideContent = fs.readFileSync(absSrc, 'utf8');
      // 2026-05-27 — variant.test "removes files that did not exist before"
      // exposed: when `dest` points at a path whose PARENT directory doesn't
      // yet exist (e.g. overriding `src/new-prompt.ts` in a sandbox tree),
      // the write-rename below fails with ENOENT on the .eval-tmp write.
      // mkdirSync(...{recursive:true}) is a no-op when the directory exists.
      fs.mkdirSync(path.dirname(absDest), { recursive: true });
      // Write-rename for atomicity; matches the pattern in src/lib/db/migrate.ts.
      const tmp = `${absDest}.eval-tmp`;
      fs.writeFileSync(tmp, overrideContent, 'utf8');
      fs.renameSync(tmp, absDest);
    }
  }

  // 2) Apply env mutations — snapshot pre-existing values for revert.
  if (variant.env) {
    for (const [key, value] of Object.entries(variant.env)) {
      envSnapshot.set(key, process.env[key]);
      process.env[key] = value;
    }
  }

  return { variant, fileBackups, envSnapshot, repoRoot };
}

/**
 * Undo what applyVariant did. Best-effort: failures are logged but not
 * thrown — a revert error MUST NOT prevent the harness from continuing
 * to the next variant or printing the partial report.
 */
export function revertVariant(applied: AppliedVariant): void {
  const errors: string[] = [];

  // Restore env first (cheap, can't fail in interesting ways).
  for (const [key, original] of applied.envSnapshot.entries()) {
    if (original === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = original;
    }
  }

  // Restore file backups.
  for (const [absDest, prior] of applied.fileBackups.entries()) {
    try {
      if (prior === null) {
        // File didn't exist before — remove it.
        if (fs.existsSync(absDest)) fs.unlinkSync(absDest);
      } else {
        fs.writeFileSync(absDest, prior, 'utf8');
      }
    } catch (err) {
      errors.push(`failed to restore ${absDest}: ${(err as Error).message}`);
    }
  }

  if (errors.length > 0) {
    // eslint-disable-next-line no-console
    console.error(
      `[revertVariant] partial revert (${errors.length} errors):\n  ` +
        errors.join('\n  '),
    );
  }
}
