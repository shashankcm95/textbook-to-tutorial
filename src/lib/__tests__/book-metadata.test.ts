// src/lib/__tests__/book-metadata.test.ts
//
// Covers:
//   - bookMetadataFromS3Url (legacy filename heuristic) — narrow regression tests
//     for the cases the original Sprint Bv2.5 design comment called out.
//   - resolveBookMetadata (Sprint D Phase 1 DB-first resolver) — exhaustive
//     branch table: pdf-info / pdf-xmp / filename / none / NULL pre-migration.

import { describe, it, expect } from 'vitest';
import {
  bookMetadataFromS3Url,
  resolveBookMetadata,
  type TutorialMetadataSource,
} from '@/lib/book-metadata';

// Helper: build a minimal TutorialMetadataSource for resolver tests.
function tut(overrides: Partial<TutorialMetadataSource>): TutorialMetadataSource {
  return {
    bookTitle: null,
    bookAuthor: null,
    metadataSource: null,
    sourceS3Url: 's3://bucket/test.pdf',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// bookMetadataFromS3Url — legacy filename heuristic
// ---------------------------------------------------------------------------

describe('bookMetadataFromS3Url', () => {
  it('extracts title + author from " - " delimiter (high-confidence)', () => {
    const result = bookMetadataFromS3Url(
      's3://b/Designing Data Intensive Applications - Martin Kleppmann.pdf',
    );
    expect(result).toEqual({
      bookTitle: 'Designing Data Intensive Applications',
      author: 'Martin Kleppmann',
      highConfidence: true,
    });
  });

  it('extracts known author surname prefix (low-confidence)', () => {
    const result = bookMetadataFromS3Url('s3://b/Cormen Introduction to Algorithms.pdf');
    expect(result).toEqual({
      bookTitle: 'Introduction to Algorithms',
      author: 'Cormen',
      highConfidence: false,
    });
  });

  it('falls back to whole-stem as title for unrecognized filenames', () => {
    const result = bookMetadataFromS3Url('s3://b/some random book.pdf');
    expect(result).toEqual({
      bookTitle: 'some random book',
      author: '',
      highConfidence: false,
    });
  });

  it('handles empty / invalid input without throwing', () => {
    expect(bookMetadataFromS3Url('')).toEqual({
      bookTitle: '',
      author: '',
      highConfidence: false,
    });
  });
});

// ---------------------------------------------------------------------------
// resolveBookMetadata — Sprint D Phase 1 DB-first resolver
// ---------------------------------------------------------------------------

describe('resolveBookMetadata — pdf-info source', () => {
  it('returns high-confidence values from DB', () => {
    const result = resolveBookMetadata(
      tut({
        bookTitle: 'DDIA',
        bookAuthor: 'Kleppmann',
        metadataSource: 'pdf-info',
      }),
    );
    expect(result).toEqual({
      bookTitle: 'DDIA',
      author: 'Kleppmann',
      highConfidence: true,
    });
  });

  it('high-confidence flag holds even when only one field is populated', () => {
    const result = resolveBookMetadata(
      tut({
        bookTitle: 'Only Title',
        bookAuthor: null,
        metadataSource: 'pdf-info',
      }),
    );
    expect(result).toEqual({
      bookTitle: 'Only Title',
      author: '',
      highConfidence: true,
    });
  });
});

describe('resolveBookMetadata — pdf-xmp source', () => {
  it('returns high-confidence values from DB', () => {
    const result = resolveBookMetadata(
      tut({
        bookTitle: 'XMP Title',
        bookAuthor: 'XMP Author',
        metadataSource: 'pdf-xmp',
      }),
    );
    expect(result).toEqual({
      bookTitle: 'XMP Title',
      author: 'XMP Author',
      highConfidence: true,
    });
  });
});

describe('resolveBookMetadata — filename source', () => {
  it('returns DB values but with highConfidence=false (badge stays on)', () => {
    const result = resolveBookMetadata(
      tut({
        bookTitle: 'Filename Title',
        bookAuthor: 'Filename Author',
        metadataSource: 'filename',
      }),
    );
    expect(result).toEqual({
      bookTitle: 'Filename Title',
      author: 'Filename Author',
      highConfidence: false,
    });
  });

  it('does NOT re-run the URL heuristic — DB is the source of truth', () => {
    // Even if URL would parse to something else, we trust the DB value.
    const result = resolveBookMetadata({
      bookTitle: 'Persisted Title',
      bookAuthor: 'Persisted Author',
      metadataSource: 'filename',
      sourceS3Url: 's3://b/Totally Different Filename - Other Person.pdf',
    });
    expect(result.bookTitle).toBe('Persisted Title');
    expect(result.author).toBe('Persisted Author');
  });
});

describe('resolveBookMetadata — none source', () => {
  it('returns empty strings with low-confidence flag', () => {
    const result = resolveBookMetadata(
      tut({
        bookTitle: null,
        bookAuthor: null,
        metadataSource: 'none',
      }),
    );
    expect(result).toEqual({
      bookTitle: '',
      author: '',
      highConfidence: false,
    });
  });
});

describe('resolveBookMetadata — pre-migration (NULL metadataSource)', () => {
  it('falls through to bookMetadataFromS3Url for rows without the new columns', () => {
    const result = resolveBookMetadata({
      bookTitle: null,
      bookAuthor: null,
      metadataSource: null,
      sourceS3Url: 's3://b/Designing Data Intensive Applications - Martin Kleppmann.pdf',
    });
    expect(result).toEqual({
      bookTitle: 'Designing Data Intensive Applications',
      author: 'Martin Kleppmann',
      highConfidence: true,
    });
  });

  it('falls through to URL heuristic for surname-prefix filenames', () => {
    const result = resolveBookMetadata({
      bookTitle: null,
      bookAuthor: null,
      metadataSource: null,
      sourceS3Url: 's3://b/Cormen Introduction to Algorithms.pdf',
    });
    expect(result.author).toBe('Cormen');
    expect(result.highConfidence).toBe(false);
  });
});
