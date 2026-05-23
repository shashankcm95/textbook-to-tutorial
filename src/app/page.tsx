import { HomeIngestForm } from './HomeIngestForm';

/**
 * Home page — paste-an-s3-URL ingest form.
 *
 * DRIFT-test3-014 (Phase 5): added during UAT setup. Original Phase 2-3
 * scaffolding shipped tutorial detail pages but no entry point — Phase 5
 * UAT surfaced the gap on first browser visit.
 *
 * Server component renders shell + bootstraps a client form (CSRF token
 * is set by the middleware on first request; the form reads __csrf cookie
 * and mirrors it via X-CSRF-Token header per double-submit contract).
 */
export default function HomePage() {
  // Test fixture pre-filled for fast UAT smoke. User can swap to any s3://
  // URL they have IAM read access for. The s3:// schema (NOT https://) is
  // required — server-side SDK fetch handles auth via AWS_* env vars.
  const PREFILL_S3_URL =
    's3://textbooks-561764227438-us-east-1-an/Designing Data Intensive Applications - Martin Kleppmann.pdf';

  return (
    <main className="mx-auto max-w-2xl px-4 py-12">
      <h1 className="mb-2 text-3xl font-semibold tracking-tight">
        Textbook → Tutorial
      </h1>
      <p className="mb-8 text-sm text-muted-foreground">
        Paste an <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
          s3://
        </code>{' '}
        URL to a PDF. Backend fetches via IAM-scoped creds, parses chapters,
        streams chapter narrative + quiz + flashcards.
      </p>
      <HomeIngestForm prefillUrl={PREFILL_S3_URL} />
      <section className="mt-12 space-y-2 text-xs text-muted-foreground">
        <p>
          <strong>Cost cap</strong>: $1.00 per tutorial (gpt-4o-mini ≈
          $0.03 for DDIA). See README §Cost cap behavior.
        </p>
        <p>
          <strong>Privacy</strong>: cookie-signed anonymous session; no
          login. Your s3:// URL + generated tutorial are tied to this
          browser session for 30 days.
        </p>
      </section>
    </main>
  );
}
