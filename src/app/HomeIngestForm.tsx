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
  const [s3Url, setS3Url] = useState(prefillUrl);
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
        const data = (await res.json()) as { tutorialId?: string };
        if (data.tutorialId) {
          router.push(`/tutorials/${data.tutorialId}`);
          return;
        }
        setError('Ingest accepted but no tutorialId returned.');
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

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <label className="block">
        <span className="mb-1 block text-sm font-medium">S3 URL</span>
        <input
          type="text"
          value={s3Url}
          onChange={(e) => setS3Url(e.target.value)}
          placeholder="s3://bucket-name/path/to/file.pdf"
          className="w-full rounded border border-input bg-background px-3 py-2 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          required
          disabled={submitting}
        />
      </label>
      <button
        type="submit"
        disabled={submitting || !s3Url.trim()}
        className="rounded bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {submitting ? 'Submitting…' : 'Generate tutorial'}
      </button>
      {error && (
        <p
          role="alert"
          className="rounded border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </p>
      )}
    </form>
  );
}
