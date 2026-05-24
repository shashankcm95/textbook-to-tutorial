// src/lib/ingest/anchor-prefilter.ts — deterministic anchor candidate pre-filter.
//
// Pure-deterministic Wave-1 pre-filter for Feature B' (voice + anchor profile).
// Scans body paragraphs and produces a list of `AnchorCandidate`s via 5
// regex/frequency heuristics. NO LLM CALLS — this module is fully synchronous
// and side-effect-free.
//
// The output of this pre-filter feeds the Wave-2 LLM scorer (separate module)
// which categorizes each candidate, picks the top-30, and writes the final
// anchor profile. By splitting the work this way:
//   - The deterministic surface (here) is unit-testable, fast, and free.
//   - The LLM scorer only sees ~50–200 pre-filtered candidates, not the
//     full text — bounding cost.
//
// Design anchor: docs/design/feature-b-voice-and-anchor-profile.md
//
// Heuristics (applied in order, results merged + deduped):
//   1. Capitalized multi-word noun phrases   → `'capitalized-multiword'`
//   2. Single capitalized words occurring ≥3 → `'capitalized-frequency'`
//   3. Glossary terms (if provided)          → `'glossary'` (+ priority flag)
//   4. Hyphenated technical compounds        → `'hyphenated-compound'`
//   5. Quoted phrases ≥3 words               → `'quoted-phrase'`

import type { SourceParagraph } from '@/lib/types';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type AnchorCategory =
  | 'search-term'
  | 'named-system'
  | 'named-paper'
  | 'named-incident'
  | 'signature-analogy'
  | 'contrast-pair'
  | 'unknown';

export interface AnchorCandidate {
  /** Verbatim term, as it appears in source (first-seen casing). */
  term: string;
  /** Always `'unknown'` from the pre-filter; Wave-2 LLM scorer assigns the real category. */
  category: AnchorCategory;
  /** Total occurrences across all body paragraphs (case-insensitive, word-bounded). */
  frequency: number;
  /** Location of first occurrence, formatted as `page{N}:paragraph{M}`. */
  first_seen_at: string;
  /** Which heuristic surfaced this candidate. */
  source:
    | 'capitalized-multiword'
    | 'capitalized-frequency'
    | 'glossary'
    | 'hyphenated-compound'
    | 'quoted-phrase';
  /** Present iff `source === 'glossary'`. Used by Wave-2 scorer to boost canonical author intent. */
  glossary_priority?: boolean;
}

export interface ExtractAnchorCandidatesArgs {
  bodyParagraphs: SourceParagraph[];
  glossaryTerms?: string[];
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/**
 * A raw match from a single heuristic, before merging/deduping/frequency.
 * `term` is the verbatim text; `paragraph` is where it first appeared.
 */
interface RawHit {
  term: string;
  source: AnchorCandidate['source'];
  paragraph: SourceParagraph;
  /** char-offset within the paragraph text — used to detect sentence-start runs. */
  offset: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Stoplist of common English words that capitalize at sentence-start. Filters
 * heuristic 2 (single-cap-frequency) — without this, "The"/"This"/"And" would
 * dominate every doc.
 */
const COMMON_SENTENCE_START_STOPLIST = new Set<string>([
  'The', 'A', 'An', 'I', 'We', 'You', 'It', 'He', 'She', 'They',
  'This', 'That', 'These', 'Those',
  'What', 'When', 'Where', 'Why', 'How', 'Who', 'Which',
  'But', 'And', 'Or', 'So', 'Yet',
  // Wave-1 review HIGH L-2: expanded to include common-English titles
  // that frequently appear at sentence-start positions in technical prose.
  'In', 'At', 'With', 'For', 'If', 'As', 'By', 'From', 'On', 'To', 'Of',
]);

/**
 * Stoplist for all-caps short words (heuristic 2 extension for acronyms).
 * Filters trivial all-caps non-terms — without it, common standalone
 * conjunctions / articles / boolean keywords would surface as "acronyms".
 */
const ALL_CAPS_STOPLIST = new Set<string>([
  'IN', 'AND', 'OR', 'NOT', 'THE', 'NO', 'YES', 'ON', 'OFF',
  'TO', 'BY', 'AT', 'IF', 'AS', 'IS', 'OF', 'AN', 'A', 'I',
  'WE', 'IT', 'BE', 'DO', 'GO', 'SO', 'UP', 'US',
  'OK', 'OS', 'AKA', 'TLDR',
]);

/**
 * Capitalized-multiword: 2 to 5 capitalized words joined by space or hyphen.
 *
 * Extension over the spec base form (`\b[A-Z][a-z]+(?:[\s-][A-Z][a-z]+){1,4}\b`):
 * we additionally allow lowercase connector words (`of`, `the`, `and`, `for`,
 * `in`, `on`, `to`) joined by hyphens between capitalized segments — this
 * catches titles like "Head-of-Line Blocking" and "Out-of-the-Box" where the
 * internal small words remain lowercase per English title-case convention.
 * Without this, the spec's own example ("Head-of-Line Blocking") would not
 * match.
 */
const CAPITALIZED_MULTIWORD_RE =
  /\b[A-Z][a-z]+(?:[\s-](?:[A-Z][a-z]+|of|the|and|for|in|on|to)){0,4}[\s-][A-Z][a-z]+\b/g;

/**
 * Single capitalized word (used for the frequency-≥3 sweep in heuristic 2).
 *
 * Wave-1 review HIGH H1 fix: extended to also match all-caps acronyms
 * (≥2 chars). Before this, technical acronyms like "RAFT", "ACID", "TCP",
 * "Kafka" appearing 3+ times in body text were invisible to this heuristic
 * — a load-bearing miss because most CS textbook anchors ARE all-caps
 * (RAID, CAP, MVCC, ACID, CRDT, ...).
 *
 * The alternation `(?:[A-Z][a-z]+|[A-Z]{2,})` captures both Title-Case
 * (`Kafka`) and ALL-CAPS (`RAFT`) forms. Filtered downstream by
 * COMMON_SENTENCE_START_STOPLIST (Title-Case) and ALL_CAPS_STOPLIST (acronyms).
 */
const SINGLE_CAPITALIZED_RE = /\b(?:[A-Z][a-z]+|[A-Z]{2,})\b/g;

/** Lowercase hyphenated compound: 2 to 4 lowercase words joined by hyphen. */
const HYPHENATED_COMPOUND_RE = /\b[a-z]+(?:-[a-z]+){1,3}\b/g;

/**
 * Quoted phrases — straight and curly quotes. Content must be 8–200 chars to
 * skip trivial quoted single-word emphasis, and we further filter by
 * word-count ≥3 downstream.
 *
 * Two separate patterns (one straight, one curly) because mixing the quote
 * characters in a single character-class regex confuses some JS engines on
 * the curly forms.
 */
const QUOTED_STRAIGHT_RE = /"([^"]{8,200})"/g;
// Wave-1 review HIGH H4 fix: include U+2018 ('‘') and U+2019 ('’') —
// single-curly quotes — which are the dominant quoting style in
// LaTeX-typeset technical PDFs. Without these, named paper titles +
// signature analogies quoted in single curlies were silently dropped.
const QUOTED_CURLY_RE = /[“”‟‘’′″]([^“”‟‘’′″]{8,200})[“”‟‘’′″]/g;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatRef(p: SourceParagraph): string {
  return `page${p.page}:paragraph${p.paragraphIdx}`;
}

/**
 * Escape a string for use as a RegExp literal — needed because candidate
 * terms can contain regex-special chars (hyphens at edges, dots in
 * abbreviations, etc.).
 */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Count word-bounded occurrences of `term` in `text`, case-insensitively.
 *
 * Uses `\b...\b` so "RAID" doesn't match "afraid" and "MySQL" doesn't match
 * "MyselfQL". The `\b` zero-width assertion is `[A-Za-z0-9_]`-aware, which
 * is what we want for ASCII-dominant technical text.
 *
 * For multi-word terms (e.g., "Head-of-Line Blocking"), `\b` still works
 * because hyphens and spaces are non-word chars, so the assertion holds at
 * each end of the full literal.
 */
function countWordBounded(text: string, term: string): number {
  if (term.length === 0) return 0;
  const pattern = new RegExp(`\\b${escapeRegex(term)}\\b`, 'gi');
  const matches = text.match(pattern);
  return matches ? matches.length : 0;
}

/**
 * Detect whether a capitalized-multiword match is just two sentence-starts in
 * a row (e.g., the end of one sentence's "...the bus. Stops" splices).
 *
 * Heuristic: if the offset is immediately preceded by `.` `?` `!` (skipping
 * whitespace), AND the match contains exactly one space-separator, it's
 * suspect. We then check whether the second word also starts a sentence-like
 * span (followed by punctuation+space or end-of-text). This is a coarse
 * filter — false negatives are fine; false positives (filtering a real
 * proper noun) would be costly, so we err conservatively and only filter
 * when both signals fire.
 */
function isLikelySentenceStartArtifact(
  match: string,
  offset: number,
  fullText: string,
): boolean {
  if (match.includes('-')) return false; // hyphenated compounds aren't splices
  const parts = match.split(/\s+/);

  // Check the char immediately before the match (skipping whitespace) — if
  // it's sentence-ending punctuation, the first word is a sentence-starter.
  let i = offset - 1;
  while (i >= 0 && /\s/.test(fullText[i] ?? '')) i--;
  const prevChar = i >= 0 ? fullText[i] : '';
  const firstIsSentenceStart = prevChar === '.' || prevChar === '?' || prevChar === '!' || offset === 0;
  if (!firstIsSentenceStart) return false;

  // Wave-1 review HIGH H2 fix: extended to N-word phrases (was previously
  // restricted to 2-word). If the FIRST word is a known sentence-start
  // stopword AND the match is at a sentence boundary, the whole phrase is
  // almost certainly a splice artifact ("The First Principle ..." at
  // start of paragraph), regardless of length. Conservative: only fires
  // when both signals (stopword + boundary) hold, so real proper nouns
  // that happen to start with "The" (rare for technical books) aren't
  // filtered when they appear mid-paragraph.
  if (parts.length >= 2 && parts[0] && COMMON_SENTENCE_START_STOPLIST.has(parts[0])) {
    return true;
  }

  // The legacy 2-word period-after heuristic (preserved): only applies to
  // exact 2-word matches that are followed immediately by sentence-ending
  // punctuation. Catches edge cases the stopword check misses.
  if (parts.length !== 2) return false;

  // Check whether a period appears between the two words — i.e., the regex
  // ate a "...word1. Word2..." boundary. Since the regex requires `\s` or
  // `-` between the caps, a period between them would actually break the
  // match — so we instead look at the SECOND word's continuation: if it's
  // immediately followed by sentence-internal text (lowercase letter), it's
  // a real proper noun mid-sentence. If it's followed by punctuation, it's
  // suspicious.
  const endOffset = offset + match.length;
  const after = fullText.slice(endOffset, endOffset + 3);
  // Real proper nouns at sentence-start usually continue ("Chaos Monkey is...")
  // — the next non-space char will be lowercase or a comma. If we see a
  // period directly after, it's likely "...end. Title.\n\nNext sentence."
  if (/^\.[\s\n]/.test(after) || /^[\s\n]*$/.test(after)) {
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Heuristics — each returns RawHit[]
// ---------------------------------------------------------------------------

function extractCapitalizedMultiword(paragraphs: SourceParagraph[]): RawHit[] {
  const out: RawHit[] = [];
  for (const p of paragraphs) {
    CAPITALIZED_MULTIWORD_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = CAPITALIZED_MULTIWORD_RE.exec(p.text)) !== null) {
      const term = m[0];
      const offset = m.index;
      if (isLikelySentenceStartArtifact(term, offset, p.text)) continue;
      out.push({ term, source: 'capitalized-multiword', paragraph: p, offset });
    }
  }
  return out;
}

function extractCapitalizedFrequency(paragraphs: SourceParagraph[]): RawHit[] {
  // First pass: count case-sensitive occurrences of each single-cap word so we
  // can apply the ≥3 threshold before allocating hits.
  const counts = new Map<string, { count: number; first: SourceParagraph; offset: number }>();
  for (const p of paragraphs) {
    SINGLE_CAPITALIZED_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = SINGLE_CAPITALIZED_RE.exec(p.text)) !== null) {
      const word = m[0];
      // Wave-1 review HIGH H1 fix: dual stoplist — Title-Case stopwords
      // for `Word` matches; all-caps stopwords for `WORD` matches (the
      // extended regex now surfaces both).
      if (COMMON_SENTENCE_START_STOPLIST.has(word)) continue;
      if (ALL_CAPS_STOPLIST.has(word)) continue;
      const existing = counts.get(word);
      if (existing) {
        existing.count += 1;
      } else {
        counts.set(word, { count: 1, first: p, offset: m.index });
      }
    }
  }
  const out: RawHit[] = [];
  for (const [term, { count, first, offset }] of counts) {
    if (count >= 3) {
      out.push({ term, source: 'capitalized-frequency', paragraph: first, offset });
    }
  }
  return out;
}

function extractGlossary(
  paragraphs: SourceParagraph[],
  glossaryTerms: string[] | undefined,
): RawHit[] {
  if (!glossaryTerms || glossaryTerms.length === 0) return [];
  const out: RawHit[] = [];
  for (const term of glossaryTerms) {
    if (!term || term.trim().length === 0) continue;
    // Find first paragraph the term appears in (case-insensitive). If never
    // appears in body, we still emit it (glossary is canonical author intent)
    // anchored to the first body paragraph as a fallback, with offset 0.
    let firstPara: SourceParagraph | null = null;
    let firstOffset = 0;
    const pattern = new RegExp(`\\b${escapeRegex(term)}\\b`, 'i');
    for (const p of paragraphs) {
      const idx = p.text.search(pattern);
      if (idx >= 0) {
        firstPara = p;
        firstOffset = idx;
        break;
      }
    }
    if (!firstPara) {
      // Glossary term never appears in the supplied body. Still emit it,
      // but anchor to the first body paragraph (callers can decide what to
      // do with this). If there are no body paragraphs at all, skip.
      if (paragraphs.length === 0) continue;
      firstPara = paragraphs[0]!;
      firstOffset = 0;
    }
    out.push({ term: term.trim(), source: 'glossary', paragraph: firstPara, offset: firstOffset });
  }
  return out;
}

/** Returns true if the lowercase hyphenated compound passes the syllable/length filter. */
function isQualifyingHyphenated(term: string): boolean {
  const parts = term.split('-');
  if (parts.length < 2) return false;
  // At least one word must be ≥4 chars (filters "all-in", "to-do").
  if (!parts.some((w) => w.length >= 4)) return false;
  // Syllable proxy: total vowel-groups across all words must be ≥2. Counting
  // vowel groups (not single vowels) approximates syllable count well for
  // English technical terms without dragging in a real syllabifier.
  let syllables = 0;
  for (const w of parts) {
    const groups = w.match(/[aeiouy]+/gi);
    syllables += groups ? groups.length : 0;
  }
  return syllables >= 2;
}

function extractHyphenatedCompound(paragraphs: SourceParagraph[]): RawHit[] {
  const out: RawHit[] = [];
  for (const p of paragraphs) {
    HYPHENATED_COMPOUND_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = HYPHENATED_COMPOUND_RE.exec(p.text)) !== null) {
      const term = m[0];
      if (!isQualifyingHyphenated(term)) continue;
      out.push({ term, source: 'hyphenated-compound', paragraph: p, offset: m.index });
    }
  }
  return out;
}

function extractQuotedPhrases(paragraphs: SourceParagraph[]): RawHit[] {
  const out: RawHit[] = [];
  for (const p of paragraphs) {
    for (const re of [QUOTED_STRAIGHT_RE, QUOTED_CURLY_RE]) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(p.text)) !== null) {
        const inner = m[1]?.trim() ?? '';
        if (inner.length === 0) continue;
        const wordCount = inner.split(/\s+/).filter((w) => w.length > 0).length;
        if (wordCount < 3) continue;
        // offset of the inner content, not the opening quote
        const offset = m.index + 1;
        out.push({ term: inner, source: 'quoted-phrase', paragraph: p, offset });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Merge / dedupe / finalize
// ---------------------------------------------------------------------------

/**
 * Source priority for dedup: when the same lowercase term surfaces from
 * multiple heuristics, we keep the highest-priority source (lower number).
 * Glossary wins so the `glossary_priority` flag survives the merge.
 */
const SOURCE_PRIORITY: Record<AnchorCandidate['source'], number> = {
  glossary: 0,
  // Quoted phrases beat capitalized-multiword because an author explicitly
  // demarcating a phrase with quotes is a stronger signal than a phrase
  // that merely happens to be title-cased (which can be incidental).
  'quoted-phrase': 1,
  'capitalized-multiword': 2,
  'hyphenated-compound': 3,
  'capitalized-frequency': 4,
};

/**
 * Compare two RawHits for "which appeared first in document order". Lower
 * page → earlier; same page → lower paragraphIdx → earlier; same paragraph
 * → lower offset → earlier.
 */
function hitDocOrderLessThan(a: RawHit, b: RawHit): boolean {
  if (a.paragraph.page !== b.paragraph.page) return a.paragraph.page < b.paragraph.page;
  if (a.paragraph.paragraphIdx !== b.paragraph.paragraphIdx) {
    return a.paragraph.paragraphIdx < b.paragraph.paragraphIdx;
  }
  return a.offset < b.offset;
}

/**
 * Main entry point.
 *
 * @param args.bodyParagraphs Body-only paragraphs (caller filters front/back matter).
 * @param args.glossaryTerms  Optional list of canonical glossary terms.
 * @returns Deduped, sorted (frequency desc, then alpha) list of candidates.
 */
export function extractAnchorCandidates(args: ExtractAnchorCandidatesArgs): AnchorCandidate[] {
  const { bodyParagraphs, glossaryTerms } = args;
  if (!bodyParagraphs || bodyParagraphs.length === 0) return [];

  // Run all 5 heuristics.
  const allHits: RawHit[] = [
    ...extractCapitalizedMultiword(bodyParagraphs),
    ...extractCapitalizedFrequency(bodyParagraphs),
    ...extractGlossary(bodyParagraphs, glossaryTerms),
    ...extractHyphenatedCompound(bodyParagraphs),
    ...extractQuotedPhrases(bodyParagraphs),
  ];

  // Dedupe by lowercase term. Keep highest-priority source. Track the
  // earliest-occurring hit (document order) as the first_seen anchor and
  // pick the verbatim casing from that earliest hit (unless glossary, which
  // overrides — author-canonical casing).
  interface MergedEntry {
    term: string;            // verbatim, from chosen hit
    source: AnchorCandidate['source'];
    firstHit: RawHit;        // earliest hit overall (for first_seen_at)
    isGlossary: boolean;
  }
  const merged = new Map<string, MergedEntry>();

  for (const hit of allHits) {
    const key = hit.term.toLowerCase();
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, {
        term: hit.term,
        source: hit.source,
        firstHit: hit,
        isGlossary: hit.source === 'glossary',
      });
      continue;
    }

    // Pick higher-priority source (lower number wins).
    const newSourceRank = SOURCE_PRIORITY[hit.source];
    const oldSourceRank = SOURCE_PRIORITY[existing.source];
    if (newSourceRank < oldSourceRank) {
      existing.source = hit.source;
      // Glossary wins → also adopt the glossary casing as the verbatim term.
      if (hit.source === 'glossary') {
        existing.term = hit.term;
        existing.isGlossary = true;
      }
    }

    // Track earliest-occurring hit for first_seen_at.
    if (hitDocOrderLessThan(hit, existing.firstHit)) {
      existing.firstHit = hit;
      // If we're updating earliest AND the chosen source isn't glossary, also
      // adopt the verbatim casing from the new earliest hit (so first-seen
      // casing is consistent). Glossary casing stays sticky.
      if (existing.source !== 'glossary') {
        existing.term = hit.term;
      }
    }
  }

  // Compute frequencies (case-insensitive word-bounded) across all body
  // paragraphs, once per unique lowercase term.
  const candidates: AnchorCandidate[] = [];
  for (const entry of merged.values()) {
    let total = 0;
    for (const p of bodyParagraphs) {
      total += countWordBounded(p.text, entry.term);
    }
    // Glossary terms anchored to a paragraph that doesn't contain them count
    // as 0 from the word-bounded sweep; that's correct behavior — the LLM
    // scorer can decide whether a zero-frequency glossary term still ranks.
    const c: AnchorCandidate = {
      term: entry.term,
      category: 'unknown',
      frequency: total,
      first_seen_at: formatRef(entry.firstHit.paragraph),
      source: entry.source,
    };
    if (entry.isGlossary) c.glossary_priority = true;
    candidates.push(c);
  }

  // Sort: frequency descending, then alphabetically (case-insensitive) for
  // stable, deterministic output.
  candidates.sort((a, b) => {
    if (a.frequency !== b.frequency) return b.frequency - a.frequency;
    return a.term.toLowerCase().localeCompare(b.term.toLowerCase());
  });

  return candidates;
}
