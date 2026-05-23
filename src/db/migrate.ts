/**
 * src/db/migrate.ts — programmatic migration runner.
 *
 * Invoked via `pnpm db:migrate` (see evan's package.json). Applies any
 * pending `drizzle/migrations/*.sql` files in lexicographic order.
 *
 * Idempotent: drizzle migrator maintains a `__drizzle_migrations` table
 * internally; already-applied files are skipped. Safe to re-run after
 * partial failures (data-engineer mindset: idempotency is non-negotiable).
 *
 * Failure semantics:
 *   - SQL syntax error in a migration → migrator throws; partial DDL may have
 *     been applied (SQLite per-statement; no DDL transaction wrapping).
 *     Recovery: fix the migration SQL, then re-run — already-applied
 *     statements will fail-fast with "table exists" and the run aborts
 *     before mutating. (data-loss preventive: fail-fast > silent skip.)
 *   - FK violation during seed-after-migrate → seed.ts handles via
 *     INSERT OR IGNORE; migrate.ts only runs DDL.
 *
 * Usage (programmatic, from `src/db/seed.ts` or one-shot CLI):
 *   import { runMigrations } from './migrate';
 *   await runMigrations();
 *
 * Usage (CLI via tsx):
 *   pnpm tsx src/db/migrate.ts
 */

import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { resolve } from 'node:path';
import { db, rawDb } from './client';

const MIGRATIONS_FOLDER = resolve(process.cwd(), 'drizzle', 'migrations');

export function runMigrations(folder: string = MIGRATIONS_FOLDER): void {
  console.log(`[migrate] Applying migrations from: ${folder}`);
  console.log(`[migrate] DB path: ${rawDb.name}`);

  const startedAt = Date.now();
  try {
    migrate(db, { migrationsFolder: folder });
  } catch (err) {
    console.error('[migrate] FAILED');
    console.error(err);
    throw err;
  }

  const elapsedMs = Date.now() - startedAt;
  console.log(`[migrate] OK (${elapsedMs}ms)`);
}

// CLI entrypoint — `pnpm tsx src/db/migrate.ts` or `node --import tsx src/db/migrate.ts`
// `require.main === module` check is CommonJS; tsx in ESM mode uses import.meta.url.
const isDirectInvocation =
  typeof require !== 'undefined' && require.main === module;
const isESMDirectInvocation =
  typeof import.meta !== 'undefined' &&
  import.meta.url === `file://${process.argv[1]}`;

if (isDirectInvocation || isESMDirectInvocation) {
  try {
    runMigrations();
    process.exit(0);
  } catch {
    process.exit(1);
  }
}
