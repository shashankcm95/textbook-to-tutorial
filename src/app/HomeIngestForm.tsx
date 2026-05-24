'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Client island: paste-an-s3-URL form. POSTs to /api/ingest with the
 * CSRF token mirrored from the `__csrf` cookie set by middleware.
 *
 * Submit flow:
 *   1. Read __csrf cookie value via document.cookie
 *   2. POST {s3Url} to /api/ingest with X-CSRF-Token header
 *   3. On 202: redirect to /tutorials/[id]
 *   4. On error: surface message + keep form intact for retry
 */
export function HomeIngestForm({ prefillUrl }: { prefillUrl: string }) {
  const router = useRouter();
  // Sprint-Bv2 redesign: start empty (was pre-filled with a dev-account
  // S3 URL which leaked into the brand surface). The `prefillUrl` is
  // kept as the prop so the parent can pass the sample fixture; users
  // opt in via the "Try the DDIA sample" affordance.
  const [s3Url, setS3Url] = useState('s3://');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function getCsrfToken(): string | null {
    const m = document.cookie.match(/__csrf=([^;]+)/);
    return m && m[1] ? decodeURIComponent(m[1]) : null;
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);

    const csrf = getCsrfToken();
    if (!csrf) {
      setError(
        'CSRF cookie missing. Reload the page (middleware sets it on first GET).',
      );
      setSubmitting(false);
      return;
    }

    try {
      const res = await fetch('/api/ingest', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrf,
        },
        credentials: 'same-origin',
        body: JSON.stringify({ s3Url }),
      });

      if (res.status === 202) {
        // POST /api/ingest returns { id, status } — see route.ts:171.
        const data = (await res.json()) as { id?: string };
        if (data.id) {
          router.push(`/tutorials/${data.id}`);
          return;
        }
        setError('Ingest accepted but no id returned.');
      } else {
        const body = await res.text().catch(() => '<unreadable>');
        setError(`HTTP ${res.status}: ${body.slice(0, 200)}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'network error');
    } finally {
      setSubmitting(false);
    }
  }

  /**
   * Sprint-Bv2: redesigned input. The previous implementation pre-filled
   * the test-bucket URL, which leaked a hard-coded AWS account number into
   * the brand surface. New flow: empty input by default + a "Try the DDIA
   * sample" link that one-shot prefills it. Cleaner first impression.
   */
  function tryDdiaSample(): void {
    setS3Url(prefillUrl);
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <label className="block">
        <span className="mb-2 block font-sans text-ui font-medium text-ink-muted">
          S3 URL
        </span>
        <div className="group flex overflow-hidden rounded-md border border-paper-edge bg-paper-deep shadow-paper-sm transition-colors duration-snap focus-within:border-brand focus-within:ring-2 focus-within:ring-brand/30">
          <span
            aria-hidden="true"
            className="flex shrink-0 items-center bg-brand-fade px-3 font-mono text-ui text-brand"
          >
            s3://
          </span>
          <input
            type="text"
            value={s3Url.replace(/^s3:\/\//, '')}
            onChange={(e) => {
              const v = e.target.value;
              setS3Url(v.startsWith('s3://') ? v : `s3://${v}`);
            }}
            placeholder="bucket-name/path/to/file.pdf"
            className="w-full bg-transparent px-3 py-2.5 font-mono text-ui text-ink placeholder:text-ink-faint focus:outline-none"
            required
            disabled={submitting}
            aria-describedby="s3-url-hint"
          />
        </div>
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={submitting || !s3Url.trim() || s3Url.trim() === 's3://'}
          className="inline-flex items-center gap-1.5 rounded-md bg-brand px-5 py-2.5 font-sans text-ui font-semibold text-white shadow-paper-sm transition-all duration-snap ease-decelerate hover:bg-brand-hover hover:shadow-paper active:translate-y-px focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-brand"
        >
          {submitting ? 'Generating…' : 'Generate tutorial'}
          {!submitting ? <span aria-hidden="true">→</span> : null}
        </button>
        <button
          type="button"
          onClick={tryDdiaSample}
          disabled={submitting}
          className="font-sans text-ui text-brand underline underline-offset-2 decoration-citation/40 hover:text-brand-hover hover:decoration-citation focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand focus-visible:rounded"
        >
          Try the DDIA sample →
        </button>
      </div>
      {error && (
        <p
          role="alert"
          className="rounded-md border border-danger/30 bg-danger-fade px-3 py-2 font-sans text-ui text-danger"
        >
          {error}
        </p>
      )}
    </form>
  );
}
