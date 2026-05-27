// @vitest-environment jsdom
//
// src/components/__tests__/TutorialCard.render.test.tsx
//
// Render + status-badge coverage for the home library tile.
//
// We assert by accessible role + visible text, not by Tailwind class
// names — the test survives class-churn but catches the load-bearing
// surface (status label, progress count, title fallback, error message).
//
// Server-Component note: TutorialCard imports next/link, which works
// under jsdom because RTL doesn't run a Next.js router; the Link
// renders as a plain anchor.

import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

afterEach(() => {
  cleanup();
});

import { TutorialCard } from '../TutorialCard';
import type { LibraryTutorialRow } from '@/lib/library';

function makeRow(overrides: Partial<LibraryTutorialRow> = {}): LibraryTutorialRow {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    bookTitle: 'Designing Data-Intensive Applications',
    bookAuthor: 'Martin Kleppmann',
    metadataSource: 'pdf-info',
    sourceS3Url: 's3://b/k.pdf',
    status: 'complete',
    errorMessage: null,
    totalChapters: 60,
    completeChapters: 60,
    maxUnlockedChapterIdx: 5,
    lastViewedAtMs: Date.now() - 60_000, // 1 minute ago → "1m ago"
    createdAtMs: Date.now() - 86_400_000, // 1 day ago
    ...overrides,
  };
}

describe('<TutorialCard>', () => {
  it('renders the book title and author when both are known', () => {
    render(<TutorialCard row={makeRow()} />);
    expect(
      screen.getByText('Designing Data-Intensive Applications'),
    ).toBeTruthy();
    expect(screen.getByText('Martin Kleppmann')).toBeTruthy();
  });

  it('links to /tutorials/<id>', () => {
    render(<TutorialCard row={makeRow({ id: 'abc-123' })} />);
    const anchor = screen.getByRole('link') as HTMLAnchorElement;
    expect(anchor.getAttribute('href')).toBe('/tutorials/abc-123');
  });

  it('falls back to a derived title when bookTitle is null', () => {
    render(
      <TutorialCard
        row={makeRow({
          bookTitle: null,
          metadataSource: 'filename',
          sourceS3Url: 's3://b/Some+Book+Title.pdf',
          bookAuthor: null,
        })}
      />,
    );
    expect(screen.getByText('Some Book Title')).toBeTruthy();
    expect(screen.getByText(/title from filename/i)).toBeTruthy();
  });

  it('shows a Ready badge for a complete tutorial', () => {
    render(<TutorialCard row={makeRow()} />);
    expect(screen.getByText('Ready')).toBeTruthy();
  });

  it('shows a Partial badge for a complete tutorial with chapters still left', () => {
    render(
      <TutorialCard
        row={makeRow({
          status: 'complete',
          totalChapters: 60,
          completeChapters: 12,
        })}
      />,
    );
    expect(screen.getByText('Partial')).toBeTruthy();
  });

  it('shows a Generating badge while generation is in flight', () => {
    render(
      <TutorialCard
        row={makeRow({
          status: 'generating',
          totalChapters: 60,
          completeChapters: 5,
        })}
      />,
    );
    expect(screen.getByText('Generating')).toBeTruthy();
  });

  it('shows an Ingesting badge during the parse phase', () => {
    render(
      <TutorialCard
        row={makeRow({
          status: 'ingesting',
          totalChapters: null,
          completeChapters: 0,
        })}
      />,
    );
    expect(screen.getByText('Ingesting')).toBeTruthy();
  });

  it('shows an Error badge AND surfaces the error message', () => {
    render(
      <TutorialCard
        row={makeRow({
          status: 'error',
          errorMessage: 'ingest failed: S3 object not found',
        })}
      />,
    );
    expect(screen.getByText('Error')).toBeTruthy();
    expect(
      screen.getByText(/ingest failed: S3 object not found/i),
    ).toBeTruthy();
  });

  it('renders progress counts only when totalChapters is set', () => {
    const { container, rerender } = render(
      <TutorialCard
        row={makeRow({ totalChapters: 60, completeChapters: 12 })}
      />,
    );
    // Match the whole "12 / 60 chapters" microcopy via container.textContent —
    // getByText('60') is ambiguous (also matches the SR-text "of 60 chapters").
    expect(container.textContent ?? '').toMatch(/12\s*\/\s*60/);
    expect(container.textContent ?? '').toMatch(/chapters/i);

    rerender(
      <TutorialCard
        row={makeRow({ totalChapters: null, completeChapters: 0 })}
      />,
    );
    expect(container.textContent ?? '').not.toMatch(/\/\s*60/);
  });

  it('shows "Added …" rather than "Last opened …" when never viewed', () => {
    render(
      <TutorialCard
        row={makeRow({
          lastViewedAtMs: null,
          createdAtMs: Date.now() - 60_000,
        })}
      />,
    );
    expect(screen.getByText(/^Added /)).toBeTruthy();
  });
});
