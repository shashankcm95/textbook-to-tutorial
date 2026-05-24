import { HomeIngestForm } from './HomeIngestForm';
import { BookSpinePreview } from '@/components/BookSpinePreview';
import { LibraryBig, ListChecks, Layers } from 'lucide-react';

/**
 * Home page — Sprint Bv2 redesign.
 *
 * Two-column hero (lg+), single column on mobile:
 *   Left: display headline, one-line value prop, ingest form, sample link.
 *   Right: stylized book spine preview (detected on URL paste).
 *
 * Below: 3-icon feature strip + cost cap / privacy footnote.
 *
 * Background is paper-canvas (warm off-white) — first signal that this
 * isn't an admin tool, it's a reading product. Brand color, display
 * type, and the book spine sell that intent within the first viewport.
 *
 * The pre-fill URL is kept (so UAT smoke still works), but it's now
 * surfaced via a quiet "Try the DDIA sample" link rather than dumped
 * into the input — first impression matters; an empty placeholder reads
 * cleaner than a dev-account-numbered S3 URL.
 *
 * DRIFT-test3-014 (Phase 5) lineage preserved: this remains the SC entry
 * point; the form remains a client island for CSRF + paste detection.
 */
export default function HomePage() {
  // Sample URL — used by the form for the "Try the DDIA sample" affordance.
  // Kept here as the authoritative fixture; if the test bucket changes,
  // this is the one place to update.
  const SAMPLE_URL =
    's3://textbooks-561764227438-us-east-1-an/Designing Data Intensive Applications - Martin Kleppmann.pdf';

  return (
    <main className="min-h-screen bg-paper">
      {/* Hero */}
      <section className="mx-auto grid max-w-6xl gap-12 px-gutter py-page lg:grid-cols-[1.2fr_1fr] lg:items-center">
        <div>
          <h1 className="font-display text-hero text-ink">
            Textbook<span className="text-brand">.</span>
            <br />
            Tutorial<span className="text-brand">.</span>
          </h1>
          <p className="mt-6 max-w-lg font-sans text-ui-lg text-ink-muted">
            Turn any technical book into a chapter-by-chapter tutorial with
            quizzes, flashcards, and a source link for every claim.
          </p>
          <div className="mt-10 max-w-xl">
            <HomeIngestForm prefillUrl={SAMPLE_URL} />
          </div>
        </div>
        <BookSpinePreview
          detectedTitle="Designing Data-Intensive Applications"
          author="Martin Kleppmann"
        />
      </section>

      {/* Feature strip */}
      <section
        aria-label="What you get"
        className="mx-auto max-w-6xl border-t border-paper-edge px-gutter py-12"
      >
        <ul className="grid grid-cols-1 gap-8 sm:grid-cols-3">
          <Feature
            icon={LibraryBig}
            title="Chapter-by-chapter"
            body="Released as you complete each one — never the whole book at once."
          />
          <Feature
            icon={ListChecks}
            title="Source-cited"
            body="Every claim links to the page and paragraph it came from."
          />
          <Feature
            icon={Layers}
            title="Spaced repetition"
            body="Twenty flashcards a day from the chapters you've read."
          />
        </ul>
      </section>

      {/* Colophon-style footer */}
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

interface FeatureProps {
  icon: React.ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;
  title: string;
  body: string;
}

function Feature({ icon: Icon, title, body }: FeatureProps) {
  return (
    <li className="flex gap-3">
      <span
        aria-hidden="true"
        className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-brand-fade"
      >
        <Icon className="h-5 w-5 text-brand" aria-hidden={true} />
      </span>
      <div>
        <p className="font-sans text-ui-lg font-medium text-ink">{title}</p>
        <p className="mt-1 font-sans text-ui text-ink-muted">{body}</p>
      </div>
    </li>
  );
}
