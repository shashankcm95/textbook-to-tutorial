/**
 * src/components/TutorialCard.tsx — one tile of the home library grid.
 *
 * Server Component. Takes a `LibraryTutorialRow` and renders:
 *   - book title (or derived fallback from sourceS3Url)
 *   - author if known
 *   - status badge in the existing brand status-color palette
 *   - per-tutorial progress (X / N chapters complete)
 *   - relative "last viewed" or "added" timestamp
 *   - the whole tile is a <Link> to /tutorials/<id>
 *
 * No client-side JS; navigation is plain anchor traversal. The Next.js
 * router intercepts the click for client-side routing where possible
 * but the tile remains right-click/cmd-click-friendly because it IS a
 * real <a> element.
 *
 * Status color mapping reuses the tokens already in use in
 * TutorialOutline.tsx — see lines 168-171 there for the source of truth.
 * Keeping the same palette across surfaces is intentional.
 */

import React from 'react';
import Link from 'next/link';
import {
  Clock,
  AlertTriangle,
  CheckCircle2,
  Loader2,
  BookOpen,
  type LucideIcon,
} from 'lucide-react';

import type { LibraryTutorialRow, AggregateStatus } from '@/lib/library';
import { computeAggregateStatus, deriveFallbackTitle } from '@/lib/library';

interface TutorialCardProps {
  row: LibraryTutorialRow;
}

interface StatusBadgeSpec {
  label: string;
  className: string;
  icon: LucideIcon;
}

const STATUS_BADGE: Record<AggregateStatus, StatusBadgeSpec> = {
  ingesting: {
    label: 'Ingesting',
    className: 'border-info/40 bg-info-fade text-info',
    icon: Loader2,
  },
  generating: {
    label: 'Generating',
    className: 'border-info/40 bg-info-fade text-info',
    icon: Loader2,
  },
  partial: {
    label: 'Partial',
    className: 'border-warn/40 bg-warn-fade text-warn',
    icon: BookOpen,
  },
  ready: {
    label: 'Ready',
    className: 'border-success/40 bg-success-fade text-success',
    icon: CheckCircle2,
  },
  error: {
    label: 'Error',
    className: 'border-danger/40 bg-danger-fade text-danger',
    icon: AlertTriangle,
  },
};

export function TutorialCard({ row }: TutorialCardProps) {
  const aggregateStatus = computeAggregateStatus(row);
  const badge = STATUS_BADGE[aggregateStatus];
  const StatusIcon = badge.icon;
  const title = row.bookTitle ?? deriveFallbackTitle(row.sourceS3Url);
  const showFallbackHint =
    !row.bookTitle || row.metadataSource === 'filename' || row.metadataSource === 'none';

  // Progress: N of M chapters complete. Hidden when totalChapters is null
  // (pre-parse) or 0 (degenerate).
  const showProgress =
    row.totalChapters != null && row.totalChapters > 0;

  const timestampLabel = row.lastViewedAtMs
    ? `Last opened ${formatRelative(row.lastViewedAtMs)}`
    : `Added ${formatRelative(row.createdAtMs)}`;

  return (
    <Link
      href={`/tutorials/${row.id}`}
      aria-label={`Open ${title}`}
      className="group block h-full rounded-lg border border-paper-edge bg-paper-deep p-5 shadow-paper-sm transition-all duration-snap hover:border-brand/40 hover:shadow-paper focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="truncate font-display text-h4 text-ink group-hover:text-brand">
            {title}
          </h2>
          {row.bookAuthor ? (
            <p className="mt-1 truncate font-sans text-ui text-ink-muted">
              {row.bookAuthor}
            </p>
          ) : showFallbackHint ? (
            <p className="mt-1 font-sans text-caption text-ink-faint">
              Title from filename
            </p>
          ) : null}
        </div>
        <span
          className={`inline-flex shrink-0 items-center gap-1 rounded-sm border px-1.5 py-0.5 font-sans text-micro font-medium uppercase tracking-wide ${badge.className}`}
        >
          <StatusIcon
            className={`h-3 w-3 ${aggregateStatus === 'generating' || aggregateStatus === 'ingesting' ? 'animate-spin' : ''}`}
            aria-hidden={true}
          />
          {badge.label}
        </span>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 font-sans text-caption text-ink-muted">
        {showProgress ? (
          <span className="inline-flex items-center gap-1">
            <BookOpen className="h-3.5 w-3.5" aria-hidden={true} />
            <span>
              <span className="tabular-nums text-ink">
                {row.completeChapters}
              </span>
              <span aria-hidden="true"> / </span>
              <span className="tabular-nums">{row.totalChapters}</span>
              <span className="sr-only"> of </span> chapters
            </span>
          </span>
        ) : null}
        <span className="inline-flex items-center gap-1">
          <Clock className="h-3.5 w-3.5" aria-hidden={true} />
          {timestampLabel}
        </span>
      </div>

      {aggregateStatus === 'error' && row.errorMessage ? (
        <p className="mt-3 rounded-sm border border-danger/30 bg-danger-fade px-2 py-1.5 font-sans text-caption text-danger">
          {row.errorMessage.slice(0, 200)}
        </p>
      ) : null}
    </Link>
  );
}

/**
 * Tiny relative-time formatter — no Intl.RelativeTimeFormat dep on the
 * critical path, no fancy library. Steps: <1m / <1h / <1d / <7d / date.
 *
 * Robust against bad input (NaN, negative, non-finite, future) — returns
 * 'unknown' rather than 'NaN-NaN-NaN'. The library loader already coerces
 * timestamps to clean numbers via `coerceTimestampToMs`, but the card
 * is a leaf component and shouldn't trust its input shape.
 */
function formatRelative(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return 'unknown';
  const deltaSec = (Date.now() - ms) / 1000;
  if (deltaSec < 0) return 'just now'; // clock skew or future-dated row
  if (deltaSec < 60) return 'just now';
  if (deltaSec < 60 * 60) return `${Math.round(deltaSec / 60)}m ago`;
  if (deltaSec < 60 * 60 * 24) return `${Math.round(deltaSec / 3600)}h ago`;
  if (deltaSec < 60 * 60 * 24 * 7) return `${Math.round(deltaSec / 86_400)}d ago`;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return 'unknown';
  // Locale-neutral compact format: YYYY-MM-DD
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
