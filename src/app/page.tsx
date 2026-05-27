/**
 * src/app/page.tsx — home as a tutorial library.
 *
 * Server Component. Three states:
 *
 *   1. No valid session → empty state with the same "Add tutorial" CTA.
 *      (The middleware mints a session cookie on the response of this
 *       request, so the user's NEXT navigation will see their tutorials.
 *       First-visit users see the empty state once.)
 *
 *   2. Session valid, zero tutorials → centered "Add your first tutorial"
 *      CTA over a quiet tagline. The "+ Add" button at top-right is the
 *      same control; the CTA is just a more obvious entry point for
 *      first-time empties.
 *
 *   3. Session valid, ≥1 tutorials → 2-column grid (mobile: 1-column) of
 *      <TutorialCard> tiles, sorted most-recently-viewed-first by SQL.
 *
 * The "+ Add tutorial" button is a Client island (uses <dialog>); the
 * list itself is fully server-rendered. Keeping the rest of the page
 * SC means no client-side DB code ships to the browser.
 *
 * Force-dynamic + Node runtime: this page is per-user, must not be SSG/ISR'd
 * (one user's library would leak to another). The /tutorials/[id] route
 * already follows this pattern; the library page does the same.
 */

import { cookies } from 'next/headers';
import { LibraryBig } from 'lucide-react';

import { db, schema } from '@/db/client';
import { eq } from 'drizzle-orm';
import { verifySession, SESSION_COOKIE_NAME } from '@/lib/session';
import { loadLibrary } from '@/lib/library';
import { TutorialCard } from '@/components/TutorialCard';
import { AddTutorialSheet } from '@/components/library/AddTutorialSheet';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Sample URL surfaced to the AddTutorialSheet's "Try the DDIA sample"
// affordance. Single source of truth — if the test bucket changes, this
// is the one place to update.
const SAMPLE_URL =
  's3://textbooks-561764227438-us-east-1-an/Designing Data Intensive Applications - Martin Kleppmann.pdf';

export default async function HomePage() {
  const secret = process.env.SESSION_SECRET ?? '';
  const cookieStore = cookies();
  const sessionCookieValue = cookieStore.get(SESSION_COOKIE_NAME)?.value ?? '';
  const payload = secret
    ? await verifySession(sessionCookieValue, secret)
    : null;

  // Defense-in-depth: ensure the FK target exists before reading. The
  // session cookie alone isn't enough; the user row gets inserted only
  // when a state-changing route (POST /api/ingest) is hit. For a brand-new
  // session that has never ingested, we skip the loadLibrary query and
  // render the empty state.
  const rows =
    payload && (await userRowExists(payload.userId))
      ? await loadLibrary(payload.userId)
      : [];

  return (
    <main className="min-h-screen bg-paper">
      <header className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-gutter pt-10 pb-6">
        <div>
          <h1 className="font-display text-h2 text-ink">
            Your library<span className="text-brand">.</span>
          </h1>
          <p className="mt-1 font-sans text-ui text-ink-muted">
            {rows.length === 0
              ? 'Paste an S3 URL to get started.'
              : `${rows.length} ${rows.length === 1 ? 'tutorial' : 'tutorials'}.`}
          </p>
        </div>
        <AddTutorialSheet sampleUrl={SAMPLE_URL} />
      </header>

      <section
        aria-label="Tutorials"
        className="mx-auto max-w-6xl px-gutter pb-page"
      >
        {rows.length === 0 ? (
          <EmptyState />
        ) : (
          <ul className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {rows.map((r) => (
              <li key={r.id}>
                <TutorialCard row={r} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <footer className="mx-auto max-w-6xl px-gutter pb-page pt-12">
        <div className="border-t border-paper-edge pt-6 font-sans text-caption text-ink-faint">
          <p>
            <span className="font-medium text-ink-muted">Cost cap</span> $1.00
            per tutorial · ~$0.03 for DDIA at current rates
            <span aria-hidden="true"> · </span>
            <span className="font-medium text-ink-muted">Privacy</span>{' '}
            cookie-signed anonymous session
            <span aria-hidden="true"> · </span>
            <span className="font-medium text-ink-muted">Session</span> 30 days,
            no login required.
          </p>
        </div>
      </footer>
    </main>
  );
}

function EmptyState() {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-4 py-20 text-center">
      <span
        aria-hidden="true"
        className="flex h-14 w-14 items-center justify-center rounded-full bg-brand-fade"
      >
        <LibraryBig className="h-7 w-7 text-brand" aria-hidden={true} />
      </span>
      <h2 className="font-display text-h3 text-ink">
        No tutorials yet
      </h2>
      <p className="font-sans text-ui text-ink-muted">
        Use the <span className="font-medium text-ink">Add tutorial</span> button
        above to paste an S3 URL to a PDF. Each tutorial appears here after
        ingest.
      </p>
    </div>
  );
}

/**
 * Cheap presence check before calling loadLibrary. Avoids the JOIN when
 * the user row hasn't been created yet (brand-new session, never
 * ingested). loadLibrary handles this case correctly too (returns []),
 * but skipping the query keeps the empty-state first-paint fast.
 */
async function userRowExists(userId: string): Promise<boolean> {
  const rows = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);
  return rows.length > 0;
}
