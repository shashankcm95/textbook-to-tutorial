/**
 * src/lib/book-metadata.ts — derive book title + author from an S3 URL.
 *
 * Sprint-Bv2.5 stop-gap. The proper fix is a `tutorials.book_title` +
 * `tutorials.author_name` schema column populated at ingest time
 * (probably via PDF metadata extraction, with fallback to filename
 * heuristics). That's a separate PR — schema migration + ingest worker
 * change + UI threading.
 *
 * For now, parse the filename. The DDIA + CLRS test fixtures live in
 * a single bucket and follow two conventions:
 *
 *   - `Designing Data Intensive Applications - Martin Kleppmann.pdf`
 *     → title="Designing Data Intensive Applications", author="Martin Kleppmann"
 *
 *   - `Cormen Introduction to Algorithms.pdf`
 *     → title="Introduction to Algorithms", author="Cormen"
 *
 * Heuristics applied in order:
 *
 *   1. If the filename contains ` - ` (space-hyphen-space, common
 *      "Title - Author" delimiter), split on it. Left = title,
 *      right = author. Handles DDIA.
 *
 *   2. If the filename begins with a single-word capitalized token
 *      that matches a common author-surname pattern (Cormen, Knuth,
 *      Sipser, Tanenbaum, etc.), treat the first word as the author
 *      and the rest as the title. Handles CLRS.
 *
 *   3. Otherwise: title = filename minus extension, author = unknown.
 *
 * Pure function. Easy to unit-test (and we should add a test in Sprint E).
 */

/**
 * Common technical-textbook author surnames that appear FIRST in filenames.
 * Conservative list — better to fall through to heuristic 3 than to
 * misattribute a title fragment as an author. Add entries as we
 * observe new ingest patterns.
 */
const KNOWN_AUTHOR_SURNAMES: ReadonlySet<string> = new Set([
  'Cormen',
  'Knuth',
  'Sipser',
  'Tanenbaum',
  'Kleppmann',
  'Hopcroft',
  'Russell',
  'Norvig',
  'Bishop',
  'Goodfellow',
  'Silberschatz',
  'Stallings',
  'Patterson',
  'Hennessy',
  'Sedgewick',
  'Skiena',
  'Bird',
  'Pierce',
  'Aho',
  'Ullman',
]);

export interface BookMetadata {
  /** Display title — empty string if not derivable. */
  bookTitle: string;
  /** Author display string — empty if not derivable. */
  author: string;
  /** True when both fields came from a high-confidence delimiter ('-'). */
  highConfidence: boolean;
}

/**
 * Extract book metadata from an `s3://bucket/Path/To/Filename.pdf` URL.
 * Returns empty strings for fields that can't be derived. Never throws.
 */
export function bookMetadataFromS3Url(s3Url: string): BookMetadata {
  if (typeof s3Url !== 'string' || s3Url.trim().length === 0) {
    return { bookTitle: '', author: '', highConfidence: false };
  }

  // Strip s3:// prefix + leading bucket — keep just the key tail (last segment).
  // s3://bucket/path/to/foo.pdf → "foo.pdf"
  const withoutScheme = s3Url.replace(/^s3:\/\//, '');
  const tail = withoutScheme.split('/').pop() ?? '';
  // Strip extension + URL-decode (S3 keys may have %20 etc.)
  const decoded = (() => {
    try {
      return decodeURIComponent(tail);
    } catch {
      return tail;
    }
  })();
  const stem = decoded.replace(/\.(pdf|epub|mobi)$/i, '').trim();
  if (stem.length === 0) {
    return { bookTitle: '', author: '', highConfidence: false };
  }

  // Heuristic 1: " - " delimiter.
  const splitOnHyphen = stem.split(/\s+-\s+/);
  if (splitOnHyphen.length >= 2) {
    const left = (splitOnHyphen[0] ?? '').trim();
    const right = splitOnHyphen.slice(1).join(' - ').trim();
    if (left.length > 0 && right.length > 0) {
      return {
        bookTitle: left,
        author: right,
        highConfidence: true,
      };
    }
  }

  // Heuristic 2: known surname prefix.
  const firstWord = stem.split(/\s+/)[0] ?? '';
  if (firstWord.length > 0 && KNOWN_AUTHOR_SURNAMES.has(firstWord)) {
    const rest = stem.slice(firstWord.length).trim();
    if (rest.length > 0) {
      return {
        bookTitle: rest,
        author: firstWord,
        highConfidence: false,
      };
    }
  }

  // Heuristic 3: fallback — the whole stem is the title.
  return {
    bookTitle: stem,
    author: '',
    highConfidence: false,
  };
}
