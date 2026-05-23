/**
 * drizzle.config.ts — Drizzle Kit configuration for SQLite (better-sqlite3).
 *
 * Used by `drizzle-kit generate` (schema → SQL diff) and `drizzle-kit studio`.
 * Production migration runner is `src/db/migrate.ts` (programmatic).
 *
 * Schema source: `./src/db/schema.ts` (7 tables — users, tutorials, chapters,
 *   questions, flashcards, srs_reviews, parses_cost; see ari Phase 1 design
 *   + riley HIGH-1/HIGH-2 absorbs in PHASE-1-SYNTHESIS.md).
 *
 * DB credentials: `DATABASE_URL` env var (libsql/file:// URL form).
 * Defaults to `file:./data/tutorials.db` if env var missing — local-dev
 * convenience per the test3 MVP scope (localhost-only, single user).
 *
 * NOTE: better-sqlite3 driver in the app itself opens DB at `process.env.DB_PATH`
 *   (see `src/db/client.ts`); the `DATABASE_URL` here is only for drizzle-kit
 *   CLI tooling. Keep them in sync via `.env`.
 */

import type { Config } from 'drizzle-kit';

const dbUrl = process.env.DATABASE_URL ?? 'file:./data/tutorials.db';

export default {
  schema: './src/db/schema.ts',
  out: './drizzle/migrations',
  dialect: 'sqlite',
  dbCredentials: {
    url: dbUrl,
  },
  // Verbose output during migrations — surfaces silent schema drift early
  // (per data-engineer mindset: data quality before model quality).
  verbose: true,
  strict: true,
} satisfies Config;
