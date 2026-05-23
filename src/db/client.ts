/**
 * src/db/client.ts — better-sqlite3 + drizzle singleton.
 *
 * Opens the DB at `process.env.DB_PATH` (defaults to `./data/tutorials.db`).
 * Configures PRAGMAs for FK enforcement, WAL journaling, and pragmatic durability.
 *
 * Per ari design Phase 1 §2 (Drizzle schema), `PRAGMA foreign_keys = ON` is
 * NOT default in SQLite (per-connection setting). Must be set on every open;
 * any code path that opens its own better-sqlite3 connection must mirror this.
 *
 * WAL mode trade-off (acknowledged in this persona's report finding MEDIUM-1):
 *   + Concurrent reads-during-writes (no writer-blocks-reader stall)
 *   + Better crash recovery vs DELETE journal
 *   - Three on-disk files (.db, .db-wal, .db-shm) instead of one
 *   - WAL mode is per-DB-file persistent (set once, sticks across processes)
 *   - Multi-process writers compete for the lock; single Next.js process is fine
 *
 * synchronous=NORMAL trade-off (WAL-mode safe):
 *   + Faster commits (~10x vs FULL on spinning disk; less on SSD)
 *   - On power loss, last few committed transactions may be lost (WAL only,
 *     not corruption). Acceptable for local-dev tutorial cache; NOT for
 *     financial data. Per data-engineer mindset: documented deviation.
 *
 * Idempotency note: `ensureDataDir()` is mkdir -p semantics; safe to call
 * concurrently / repeatedly. Singleton ensures one connection per process.
 */

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import * as schema from './schema';

const DEFAULT_DB_PATH = './data/tutorials.db';

/**
 * Ensure the parent directory of the SQLite file exists.
 * better-sqlite3 throws SQLITE_CANTOPEN if the directory is missing; we'd
 * rather create it than crash. Pure function — no side effects beyond mkdir.
 */
function ensureDataDir(dbPath: string): void {
  const dir = dirname(resolve(dbPath));
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

/**
 * Open the SQLite DB with project-standard PRAGMAs.
 * Exported for migration tooling (`src/db/migrate.ts`) and tests that need
 * a fresh in-memory instance — production code should use the `db` singleton.
 */
export function openDatabase(dbPath: string = DEFAULT_DB_PATH): Database.Database {
  ensureDataDir(dbPath);

  let sqlite: Database.Database;
  try {
    sqlite = new Database(dbPath);
  } catch (err) {
    // Disk-not-found fallback: retry once after mkdir (race-condition safety
    // in case ensureDataDir lost a race with another process). If THIS retry
    // also fails, the error is a real I/O / permissions / disk-full issue.
    if (err instanceof Error && /SQLITE_CANTOPEN/.test(err.message)) {
      ensureDataDir(dbPath);
      sqlite = new Database(dbPath);
    } else {
      throw err;
    }
  }

  // PRAGMAs — order matters: foreign_keys is per-connection; journal_mode + synchronous
  // are per-DB-file (persistent on disk). Setting all on open is idempotent.
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('synchronous = NORMAL');

  // busy_timeout: if another connection has the write lock (unlikely with
  // single Next.js process, but matters for migration scripts running alongside),
  // wait up to 5s for it instead of throwing SQLITE_BUSY immediately.
  sqlite.pragma('busy_timeout = 5000');

  return sqlite;
}

// Singleton — one connection per Node process. Next.js dev mode hot-reloads
// modules; the `globalThis` cache prevents leaking connections across HMR.
const globalForDb = globalThis as unknown as {
  __ttt_sqlite__?: Database.Database;
  __ttt_drizzle__?: ReturnType<typeof drizzle<typeof schema>>;
};

const dbPath = process.env.DB_PATH ?? DEFAULT_DB_PATH;

const sqlite = globalForDb.__ttt_sqlite__ ?? openDatabase(dbPath);
if (process.env.NODE_ENV !== 'production') {
  globalForDb.__ttt_sqlite__ = sqlite;
}

export const db = globalForDb.__ttt_drizzle__ ?? drizzle(sqlite, { schema });
if (process.env.NODE_ENV !== 'production') {
  globalForDb.__ttt_drizzle__ = db;
}

// Re-export the schema namespace so consumers do `import { db, schema } from '@/db/client'`
// instead of two imports. Cuts boilerplate.
export { schema };

// Raw connection escape hatch — for migration scripts, PRAGMA introspection,
// or anything that needs the better-sqlite3 API directly. Use sparingly.
export const rawDb = sqlite;
