#!/usr/bin/env tsx
/**
 * scripts/ab-compare.ts — Phase 1 entrypoint per HARNESS-DESIGN.md §"Sample
 * run command" (line 200).
 *
 * Usage:
 *
 *   pnpm tsx scripts/ab-compare.ts \
 *     --run-id <run-id> \
 *     --variants <manifest1.json>[,<manifest2.json>,...] \
 *     --personas <slug1>[,<slug2>,...] \
 *     [--tutorial <tutorialId>] \
 *     [--chapters <start>-<end>] \
 *     [--rate-runs <n>] \
 *     [--narratives-from <fs|db>] \
 *     [--narratives-dir <dir>]
 *
 * The variant manifest is the canonical source of `tutorial_id` and
 * `chapter_range`. The CLI `--tutorial` / `--chapters` flags exist for
 * convenience overrides but the manifest wins when set.
 *
 * Source modes:
 *   --narratives-from=db  (default): read from SQLite, requires DB_PATH
 *   --narratives-from=fs   : read from `<narrative-dir>/<variant>/ch{n}.md`
 *
 * Real LLM calls happen only when `OPENAI_API_KEY` is set. To do a dry
 * run that exercises the I/O layer without burning tokens, set
 * `EVAL_DRY_RUN=1` and a deterministic mock will be used.
 *
 * This script is a thin wrapper around src/lib/eval/runner.ts — the
 * orchestration lives there.
 */

import * as path from 'node:path';
import * as fs from 'node:fs';

// ─── Auto-load .env from CWD BEFORE any module that reads process.env ─────────
//
// Sprint E Tier 2 — round-3 PoC dogfood (2026-05-24) found `pnpm eval:run`
// required users to manually `set -a; source .env; set +a` first; this
// auto-load eliminates the footgun. Pure-Node implementation (no dotenv dep)
// is idempotent: it never overwrites an already-set process.env key, so any
// vars passed in on the CLI ("FOO=bar pnpm eval:run") still win.
//
// IMPORTANT: this runs BEFORE the imports below so that `src/lib/env.ts` —
// which `parseBootEnv()`s at module load — sees the .env values.
function loadDotEnvIfPresent(): void {
  const envPath = path.resolve(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) return;
  const content = fs.readFileSync(envPath, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    // Strip a single layer of surrounding double or single quotes.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}
loadDotEnvIfPresent();

import { runEvalHarness } from '../src/lib/eval/runner';
import type { NarrativeSource } from '../src/lib/eval/narratives';
import type { RatingChatClient } from '../src/lib/eval/persona';
import {
  requireTutorialIdForDbMode,
  type VariantManifest,
} from '../src/lib/eval/variant';

interface CliArgs {
  runId: string;
  variants: string[];
  personas: string[];
  rateRuns: number;
  narrativesFrom: 'db' | 'fs';
  narrativesDir?: string;
  tutorial?: string;
  chapters?: readonly [number, number];
}

function parseArgs(argv: string[]): CliArgs {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        args[key] = next;
        i++;
      } else {
        args[key] = 'true';
      }
    }
  }

  if (!args['run-id']) throw new Error('--run-id is required');
  if (!args['variants']) throw new Error('--variants is required');
  if (!args['personas']) throw new Error('--personas is required');

  let chapters: readonly [number, number] | undefined;
  if (args['chapters']) {
    const m = args['chapters'].match(/^(\d+)-(\d+)$/);
    if (!m) throw new Error('--chapters must be of form N-M (e.g. 0-5)');
    chapters = [parseInt(m[1], 10), parseInt(m[2], 10)];
  }

  return {
    runId: args['run-id'],
    variants: args['variants'].split(',').map((s) => s.trim()).filter(Boolean),
    personas: args['personas'].split(',').map((s) => s.trim()).filter(Boolean),
    rateRuns: args['rate-runs'] ? parseInt(args['rate-runs'], 10) : 1,
    narrativesFrom: (args['narratives-from'] as 'db' | 'fs') ?? 'db',
    narrativesDir: args['narratives-dir'],
    tutorial: args['tutorial'],
    chapters,
  };
}

async function main(): Promise<void> {
  const cli = parseArgs(process.argv.slice(2));
  const repoRoot = path.resolve(__dirname, '..');

  // Narrative source factory: filesystem reads from `<dir>/<variant>/ch{n}.md`,
  // database reads via a lazy-loaded Drizzle handle (only on db mode).
  const narrativeSourceForVariant = await buildNarrativeSourceFactory(
    cli,
    repoRoot,
  );

  // Chat client — real OpenAI by default, dry-run mock when EVAL_DRY_RUN=1.
  const chatClient: RatingChatClient = process.env.EVAL_DRY_RUN === '1'
    ? buildDryRunChatClient()
    : await buildRealOpenAiClient();

  const result = await runEvalHarness({
    runId: cli.runId,
    repoRoot,
    variantPaths: cli.variants,
    personaSlugs: cli.personas,
    rateRuns: cli.rateRuns,
    narrativeSourceForVariant,
    chatClient,
  });

  console.log(`[ab-compare] done. report: ${result.reportPath}`);
  console.log(`[ab-compare] ratings: ${result.ratings.length}`);
}

async function buildNarrativeSourceFactory(
  cli: CliArgs,
  repoRoot: string,
): Promise<(variant: VariantManifest) => NarrativeSource> {
  if (cli.narrativesFrom === 'fs') {
    if (!cli.narrativesDir) {
      throw new Error('--narratives-dir is required when --narratives-from=fs');
    }
    const baseDir = path.resolve(repoRoot, cli.narrativesDir);
    if (!fs.existsSync(baseDir)) {
      throw new Error(`narratives directory does not exist: ${baseDir}`);
    }
    return (variant) => ({
      type: 'filesystem',
      dir: path.resolve(baseDir, variant.name),
    });
  }

  // DB mode — lazy-load the drizzle handle + schema so the script can run
  // in --narratives-from=fs mode without requiring better-sqlite3 to load
  // (matters in CI environments where the native module may not be built).
  const { db } = await import('../src/db/client');
  const { chapters, chapterFidelityScores } = await import('../src/db/schema');
  const { and, eq, desc } = await import('drizzle-orm');

  return (variant) => ({
    type: 'database',
    // Sprint E Tier 2 — runtime gate: schema now makes tutorial_id optional
    // (fs mode doesn't need it); this throws if db mode is missing the field.
    tutorialId: requireTutorialIdForDbMode(variant),
    db: {
      selectChapter: (tutorialId, ordinal) => {
        const rows = db
          .select({ title: chapters.title, narrative: chapters.narrative })
          .from(chapters)
          .where(and(eq(chapters.tutorialId, tutorialId), eq(chapters.ordinal, ordinal)))
          .all();
        return rows[0] ?? null;
      },
      selectLatestFidelityScore: ({ tutorialId, ordinal }) => {
        const rows = db
          .select({
            overallScore: chapterFidelityScores.overallScore,
          })
          .from(chapterFidelityScores)
          .innerJoin(chapters, eq(chapters.id, chapterFidelityScores.chapterId))
          .where(and(eq(chapters.tutorialId, tutorialId), eq(chapters.ordinal, ordinal)))
          .orderBy(desc(chapterFidelityScores.createdAt))
          .limit(1)
          .all();
        return rows[0] ?? null;
      },
    },
  });
}

async function buildRealOpenAiClient(): Promise<RatingChatClient> {
  const { openai } = await import('../src/lib/openai/client');
  return openai as unknown as RatingChatClient;
}

/**
 * Deterministic mock used when EVAL_DRY_RUN=1. Emits a valid rubric
 * response so the I/O layer can be exercised end-to-end without burning
 * tokens. Ratings are derived from the narrative length so the report
 * has SOME signal to render (not all-identical).
 */
function buildDryRunChatClient(): RatingChatClient {
  return {
    chat: {
      completions: {
        create: async (args) => {
          const userMsg = args.messages.find((m) => m.role === 'user')?.content ?? '';
          const len = userMsg.length;
          // Map length to a rating in [4, 8]. Deterministic.
          const r = 4 + (len % 5);
          const body = {
            ratings: {
              content_fidelity: r,
              ux_clarity: null,
              navigation_friction: null,
              voice_match: Math.max(1, r - 1),
              learning_value: r,
              would_recommend: Math.min(10, r + 1),
            },
            evidence: {
              phrase_that_landed: '(dry-run) first 60 chars: ' + userMsg.slice(0, 60),
              phrase_that_failed: '',
              named_anchors_present: ['(dry-run)'],
              named_anchors_missing: ['(dry-run-missing)'],
            },
            free_form_notes: '(dry-run) generated without LLM. Length=' + len,
          };
          return {
            choices: [{ message: { content: JSON.stringify(body) } }],
          };
        },
      },
    },
  };
}

main().catch((err) => {
  console.error('[ab-compare] FATAL:', err);
  process.exit(1);
});
