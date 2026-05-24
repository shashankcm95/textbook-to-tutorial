'use client';

/**
 * src/components/BookSpinePreview.tsx — home-page right-column hero card.
 *
 * The home page used to be just a form on a white page. Per UI/UX-hybrid
 * audit §3.1, the right column now shows a stylized book spine that
 * tells the user "we know what you're about to upload — this becomes a
 * book in our system."
 *
 * Two modes:
 *   1. Detected — the URL field matched a known book; show actual title +
 *      author + a stylized spine. The spine is a CSS construct (not an
 *      external image), so we don't need to ship cover assets or hit a
 *      third-party API.
 *   2. Default — no detection yet; show a "?" spine + a quiet
 *      "we'll detect the book when you paste an S3 URL" caption.
 *
 * Why CSS-only spine (no real cover):
 *   - Avoids a Google-Books / OpenLibrary fetch on every keystroke
 *     (privacy + latency hit).
 *   - Designs cleanly to the brand palette (paper + ink + brand-indigo)
 *     without needing a library of jacket designs.
 *   - The user *will* see the actual cover later (when the book's
 *     metadata loads post-ingest — Sprint Bv2.5 schema work).
 *
 * The spine reads vertically (book-on-shelf orientation). The
 * `[writing-mode:vertical-rl]` CSS rotates the text glyphs themselves,
 * not the bounding box — so the title flows top-to-bottom while staying
 * legible.
 */

import { BookOpen } from 'lucide-react';

interface BookSpinePreviewProps {
  detectedTitle?: string;
  author?: string;
}

export function BookSpinePreview({ detectedTitle, author }: BookSpinePreviewProps) {
  const hasDetection =
    typeof detectedTitle === 'string' && detectedTitle.trim().length > 0;
  return (
    <aside
      aria-label={hasDetection ? 'Detected book preview' : 'Book preview placeholder'}
      className="relative isolate hidden h-[420px] items-center justify-center lg:flex"
    >
      {/* Soft "library shelf" backdrop — a quiet horizontal band */}
      <div
        aria-hidden="true"
        className="absolute inset-x-0 bottom-[18%] h-px bg-paper-edge"
      />
      <div
        aria-hidden="true"
        className="absolute inset-x-0 bottom-[18%] h-2 -translate-y-px bg-gradient-to-t from-paper-edge/40 to-transparent"
      />

      {/* The spine itself */}
      <div className="relative flex h-[320px] w-[88px] -rotate-[1.5deg] flex-col justify-between rounded-sm border border-paper-edge bg-brand-fade px-2 py-4 shadow-paper-lg transition-transform duration-slow ease-decelerate hover:-rotate-0 hover:scale-[1.02]">
        {/* Top deco band */}
        <div className="h-1 rounded-[1px] bg-brand/30" aria-hidden="true" />

        {/* Vertical title */}
        <div className="flex flex-1 items-center justify-center">
          {hasDetection ? (
            <p
              className="font-display text-ui-lg font-medium text-ink"
              style={{
                writingMode: 'vertical-rl',
                transform: 'rotate(180deg)',
                letterSpacing: '0.01em',
              }}
            >
              {detectedTitle}
            </p>
          ) : (
            <span
              className="font-display text-display text-ink-faint"
              aria-hidden="true"
            >
              ?
            </span>
          )}
        </div>

        {/* Author at the foot */}
        {hasDetection && author ? (
          <p
            className="self-center font-sans text-micro uppercase tracking-wider text-ink-muted"
            style={{
              writingMode: 'vertical-rl',
              transform: 'rotate(180deg)',
            }}
          >
            {author}
          </p>
        ) : (
          <div className="h-1 rounded-[1px] bg-brand/30" aria-hidden="true" />
        )}
      </div>

      {/* Caption */}
      <p className="absolute bottom-2 left-0 right-0 text-center font-sans text-caption text-ink-faint">
        {hasDetection ? (
          <>
            <BookOpen aria-hidden="true" className="mr-1.5 inline h-3.5 w-3.5" />
            Detected from your URL
          </>
        ) : (
          'Paste an S3 URL to detect the book'
        )}
      </p>
    </aside>
  );
}
