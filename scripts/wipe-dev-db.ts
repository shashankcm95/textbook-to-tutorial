#!/usr/bin/env tsx
/**
 * scripts/wipe-dev-db.ts — destructive: clear all per-user data, rerun migrations.
 *
 * Intended for the personal-use bug-hunt workflow:
 *
 *   1. Wipe the dev DB (tutorials, chapters, fidelity scores, cost telemetry,
 *      anchor violations, srs state, glossary terms, skipped sections,
 *      questions, flashcards, users).
 *   2. Re-run all migrations from a clean slate so the next ingest starts
 *      against the canonical schema (including 0008's unixepoch defaults).
 *   3. Leave S3 chunk artifacts alone — they're durable; re-ingesting the
 *      same PDF will cache-hit on pdf_sha256 and skip the heavy parse.
 *
 * Usage:
 *   pnpm wipe-dev-db          # interactive: prompts before nuking
 *   pnpm wipe-dev-db --yes    # non-interactive (for scripts/CI)
 *
 * SAFETY: refuses to run when DB_PATH points outside `./data/`. Personal-use
 * scale + paranoia: the dev DB has zero production-data overlap, but a stray
 * `--yes` in a misconfigured shell shouldn't wipe an arbitrary path.
 */

import { existsSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';

const DB_PATH = process.env.DB_PATH ?? './data/tutorials.db';
const FORCE = process.argv.includes('--yes') || process.argv.includes('-y');

function refuseUnsafePath(dbPath: string): void {
  const abs = path.resolve(dbPath);
  const dataDir = path.resolve('./data');
  if (!abs.startsWith(dataDir + path.sep) && abs !== path.join(dataDir, 'tutorials.db')) {
    console.error(
      `[wipe-dev-db] REFUSING to wipe '${abs}' — only paths under './data/' are allowed.`,
    );
    console.error('[wipe-dev-db] To override, set DB_PATH explicitly AND edit this script.');
    process.exit(2);
  }
}

async function confirm(): Promise<boolean> {
  if (FORCE) return true;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(
      `\n⚠ This will DELETE ${DB_PATH} and re-run migrations from scratch.\n` +
        `  S3 chunks survive (re-ingest will cache-hit on sha256).\n` +
        `\nProceed? Type 'WIPE' to confirm: `,
      (answer) => {
        rl.close();
        resolve(answer.trim() === 'WIPE');
      },
    );
  });
}

async function main(): Promise<void> {
  refuseUnsafePath(DB_PATH);

  console.log(`[wipe-dev-db] target: ${path.resolve(DB_PATH)}`);
  console.log(`[wipe-dev-db] exists: ${existsSync(DB_PATH)}`);

  const ok = await confirm();
  if (!ok) {
    console.log('[wipe-dev-db] aborted (no changes).');
    process.exit(1);
  }

  // Step 1: nuke the file. SQLite file-level delete is the cleanest reset
  // — also clears WAL/journal side files.
  for (const ext of ['', '-journal', '-wal', '-shm']) {
    const f = DB_PATH + ext;
    if (existsSync(f)) {
      unlinkSync(f);
      console.log(`[wipe-dev-db] removed ${f}`);
    }
  }

  // Step 2: re-run migrations. Reuses the existing migration runner so any
  // schema drift between hand-edits and migrations would surface here.
  console.log('[wipe-dev-db] running pnpm db:migrate ...');
  const result = spawnSync('pnpm', ['db:migrate'], {
    stdio: 'inherit',
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    console.error('[wipe-dev-db] db:migrate failed; the DB may be in a partial state.');
    process.exit(result.status ?? 1);
  }

  console.log(
    '\n[wipe-dev-db] ✓ done. Open http://localhost:3000 and add your first tutorial.',
  );
  console.log('[wipe-dev-db]   Structured events will land in ./logs/<today>.jsonl');
  console.log('[wipe-dev-db]   Tail with:  pnpm logs:tail');
}

main().catch((err) => {
  console.error('[wipe-dev-db] FATAL:', err);
  process.exit(1);
});
