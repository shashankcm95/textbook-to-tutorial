/**
 * src/app/tutorials/[id]/loading.tsx — Suspense fallback skeleton.
 *
 * Next.js App Router convention: a `loading.tsx` adjacent to a `page.tsx`
 * automatically wraps the page in a Suspense boundary. The body of this
 * file renders while the server component above is awaiting its async work
 * (DB queries, session verification).
 *
 * Why a skeleton (not a spinner):
 *   - Layout-shift insurance: the skeleton occupies the same vertical space
 *     the real content will, so the page doesn't jump when the data lands.
 *     Per kb:web-dev/react-essentials §"Core Web Vitals", CLS (Cumulative
 *     Layout Shift) below 0.1 is the budget; same-height placeholders are
 *     the cheapest way to stay there.
 *   - Perceived performance: a structural skeleton communicates "I'm working
 *     on YOUR tutorial" more concretely than a generic spinner. The first
 *     impression of progress is the actual progress for sub-second loads.
 *   - No JS required: this is rendered server-side; no client bundle hit.
 *
 * Accessibility:
 *   - role="status" + aria-live="polite" announces loading to screen readers
 *     without interrupting other reading.
 *   - aria-busy="true" tells assistive tech the content is in-flight.
 *   - sr-only text gives non-visual users a meaningful label ("Loading
 *     tutorial…"); the visual skeleton bars are decorative (aria-hidden).
 *
 * KB: kb:web-dev/react-essentials §"Suspense + streaming";
 *     §"Accessibility — semantic HTML first".
 */

export default function TutorialLoading() {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy="true"
      className="space-y-6"
    >
      <span className="sr-only">Loading tutorial…</span>

      {/* Header skeleton — mirrors StreamingClient's sticky header layout */}
      <header
        aria-hidden="true"
        className="sticky top-0 z-10 -mx-4 flex items-center justify-between gap-4 border-b border-border bg-background/95 px-4 py-3"
      >
        <div className="h-5 w-32 animate-pulse rounded bg-muted" />
        <div className="flex items-center gap-3">
          <div className="h-6 w-24 animate-pulse rounded-full bg-muted" />
          <div className="h-5 w-16 animate-pulse rounded-full bg-muted" />
        </div>
      </header>

      {/* Body skeleton — chapter title + 5 narrative rows + sidebar */}
      <div
        aria-hidden="true"
        className="grid gap-6 lg:grid-cols-[1fr_18rem]"
      >
        <article className="space-y-4 min-w-0">
          <div className="h-6 w-2/3 animate-pulse rounded bg-muted" />
          <div className="space-y-2">
            <div className="h-4 w-full animate-pulse rounded bg-muted" />
            <div className="h-4 w-11/12 animate-pulse rounded bg-muted" />
            <div className="h-4 w-10/12 animate-pulse rounded bg-muted" />
            <div className="h-4 w-9/12 animate-pulse rounded bg-muted" />
            <div className="h-4 w-11/12 animate-pulse rounded bg-muted" />
          </div>
        </article>

        <aside className="space-y-3">
          <div className="h-5 w-24 animate-pulse rounded bg-muted" />
          <div className="h-2 w-full animate-pulse rounded-full bg-muted" />
          <div className="space-y-2">
            <div className="h-8 w-full animate-pulse rounded bg-muted" />
            <div className="h-8 w-full animate-pulse rounded bg-muted" />
            <div className="h-8 w-full animate-pulse rounded bg-muted" />
          </div>
        </aside>
      </div>
    </div>
  );
}
