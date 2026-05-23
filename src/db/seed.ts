/**
 * src/db/seed.ts — dev-only seed data.
 *
 * Inserts ONE anonymous user with a fixed `session_cookie_hash = 'dev-seed-hash'`
 * for local-dev convenience. No tutorials/chapters seeded — real ones come
 * from the PDF ingest pipeline (evan's worker scope).
 *
 * Idempotent: INSERT ... ON CONFLICT DO NOTHING. Safe to re-run.
 *
 * Usage:
 *   pnpm db:seed                 # via package.json script (evan provides)
 *   pnpm tsx src/db/seed.ts      # one-shot direct
 *
 * SAFETY: runs migrations first to ensure schema exists. Refuses to run in
 * NODE_ENV=production (the fixed cookie hash is a known plaintext —
 * seeding it in prod would create a backdoor account).
 */

import { randomUUID } from 'node:crypto';
import { db, schema } from './client';
import { runMigrations } from './migrate';

const DEV_USER_COOKIE_HASH = 'dev-seed-hash';

export function seed(): void {
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      '[seed] Refusing to run in NODE_ENV=production. ' +
        'The dev seed contains a fixed cookie hash — running in prod creates a backdoor account.',
    );
  }

  console.log('[seed] Running migrations first (idempotent)...');
  runMigrations();

  console.log(`[seed] Inserting dev user (cookie_hash=${DEV_USER_COOKIE_HASH})`);
  const result = db
    .insert(schema.users)
    .values({
      id: randomUUID(),
      sessionCookieHash: DEV_USER_COOKIE_HASH,
    })
    .onConflictDoNothing({ target: schema.users.sessionCookieHash })
    .run();

  if (result.changes === 0) {
    console.log('[seed] Dev user already exists — no-op.');
  } else {
    console.log('[seed] Dev user inserted.');
  }

  console.log('[seed] Done.');
}

// CLI entrypoint
const isDirectInvocation =
  typeof require !== 'undefined' && require.main === module;
const isESMDirectInvocation =
  typeof import.meta !== 'undefined' &&
  import.meta.url === `file://${process.argv[1]}`;

if (isDirectInvocation || isESMDirectInvocation) {
  try {
    seed();
    process.exit(0);
  } catch (err) {
    console.error('[seed] FAILED:', err);
    process.exit(1);
  }
}
