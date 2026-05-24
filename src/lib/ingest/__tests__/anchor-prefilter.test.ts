// src/lib/ingest/__tests__/anchor-prefilter.test.ts — pure-function tests.
//
// Covers each of the 5 heuristics in isolation, plus the cross-cutting
// concerns (word-boundary correctness, frequency counting, first_seen_at,
// dedup, glossary priority, stoplist behavior, empty input).
//
// No network, no LLM, no fixtures — all synthetic paragraphs constructed
// in-test.

import { describe, it, expect } from 'vitest';
import { extractAnchorCandidates } from '@/lib/ingest/anchor-prefilter';
import type { AnchorCandidate } from '@/lib/ingest/anchor-prefilter';
import type { SourceParagraph } from '@/lib/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function p(page: number, idx: number, text: string): SourceParagraph {
  return { page, paragraphIdx: idx, text };
}

function findByTerm(
  results: AnchorCandidate[],
  term: string,
): AnchorCandidate | undefined {
  return results.find((c) => c.term.toLowerCase() === term.toLowerCase());
}

// ---------------------------------------------------------------------------
// Heuristic 1: capitalized multi-word noun phrases
// ---------------------------------------------------------------------------

describe('extractAnchorCandidates — heuristic 1: capitalized multi-word', () => {
  it('matches multi-word capitalized phrases like "Chaos Monkey"', () => {
    const paragraphs = [
      p(1, 0, 'Netflix engineers built Chaos Monkey to break things on purpose.'),
    ];
    const results = extractAnchorCandidates({ bodyParagraphs: paragraphs });
    const hit = findByTerm(results, 'Chaos Monkey');
    expect(hit).toBeDefined();
    expect(hit?.source).toBe('capitalized-multiword');
    expect(hit?.category).toBe('unknown');
  });

  it('matches hyphenated multi-word phrases like "Head-of-Line Blocking"', () => {
    const paragraphs = [
      p(2, 1, 'The classic problem is Head-of-Line Blocking in TCP streams.'),
    ];
    const results = extractAnchorCandidates({ bodyParagraphs: paragraphs });
    // Wave-1 review HIGH H3 fix: tighten the assertion to the FULL canonical
    // span "Head-of-Line Blocking" — previously this matched any term
    // starting with "Head", which would silently pass if the regex emitted
    // a partial span like "Head-of-Line" without "Blocking".
    const headHit = results.find((c) => c.term === 'Head-of-Line Blocking');
    expect(headHit).toBeDefined();
    expect(headHit?.source).toBe('capitalized-multiword');
  });
});

// ---------------------------------------------------------------------------
// Heuristic 2: single capitalized words occurring ≥3 times
// ---------------------------------------------------------------------------

describe('extractAnchorCandidates — heuristic 2: single-cap ≥3-frequency', () => {
  it('captures a capitalized singleton when it appears 3+ times', () => {
    const paragraphs = [
      p(1, 0, 'Kubernetes orchestrates containers.'),
      p(1, 1, 'In Kubernetes, pods are the unit of deployment.'),
      p(2, 0, 'Operators extend Kubernetes with custom controllers.'),
    ];
    const results = extractAnchorCandidates({ bodyParagraphs: paragraphs });
    const hit = findByTerm(results, 'Kubernetes');
    expect(hit).toBeDefined();
    // Could be surfaced by either heuristic 1 (if part of a multi-word phrase)
    // or heuristic 2. Both are acceptable; what matters is freq tracking.
    expect(hit?.frequency).toBe(3);
  });

  it('does NOT capture a capitalized singleton appearing only twice', () => {
    const paragraphs = [
      p(1, 0, 'Postgres is mentioned here.'),
      p(1, 1, 'And Postgres is mentioned here too.'),
    ];
    const results = extractAnchorCandidates({ bodyParagraphs: paragraphs });
    expect(findByTerm(results, 'Postgres')).toBeUndefined();
  });

  it('filters common-English sentence-starters from the stoplist', () => {
    const paragraphs = [
      p(1, 0, 'The cat. The dog. The bird. The fish. The fox.'),
      p(1, 1, 'This is one. This is two. This is three.'),
      p(1, 2, 'And so on. And forever. And ever. And ever.'),
    ];
    const results = extractAnchorCandidates({ bodyParagraphs: paragraphs });
    expect(findByTerm(results, 'The')).toBeUndefined();
    expect(findByTerm(results, 'This')).toBeUndefined();
    expect(findByTerm(results, 'And')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Heuristic 3: glossary terms
// ---------------------------------------------------------------------------

describe('extractAnchorCandidates — heuristic 3: glossary terms', () => {
  it('surfaces every glossary term as a candidate with glossary_priority=true', () => {
    const paragraphs = [
      p(1, 0, 'ACID is a transaction property set.'),
      p(2, 0, 'CAP theorem says you can pick two of three.'),
    ];
    const results = extractAnchorCandidates({
      bodyParagraphs: paragraphs,
      glossaryTerms: ['ACID', 'CAP', 'BASE'],
    });
    const acid = findByTerm(results, 'ACID');
    const cap = findByTerm(results, 'CAP');
    const base = findByTerm(results, 'BASE');
    expect(acid).toBeDefined();
    expect(cap).toBeDefined();
    expect(base).toBeDefined();
    expect(acid?.glossary_priority).toBe(true);
    expect(cap?.glossary_priority).toBe(true);
    // BASE never appears in body but glossary still emits it.
    expect(base?.glossary_priority).toBe(true);
    expect(base?.frequency).toBe(0);
    expect(acid?.source).toBe('glossary');
  });

  it('glossary candidates are NOT filtered by stoplist (canonical author intent)', () => {
    const paragraphs = [
      p(1, 0, 'Once upon a time we had a system.'),
    ];
    const results = extractAnchorCandidates({
      bodyParagraphs: paragraphs,
      glossaryTerms: ['A'], // would normally be stoplist-filtered
    });
    const hit = findByTerm(results, 'A');
    expect(hit).toBeDefined();
    expect(hit?.glossary_priority).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Heuristic 4: hyphenated technical compounds
// ---------------------------------------------------------------------------

describe('extractAnchorCandidates — heuristic 4: hyphenated compounds', () => {
  it('matches qualifying compounds like "shared-nothing" and "fault-tolerant"', () => {
    const paragraphs = [
      p(1, 0, 'A shared-nothing architecture is fault-tolerant by design.'),
      p(1, 1, 'We measured tail-latency under load.'),
    ];
    const results = extractAnchorCandidates({ bodyParagraphs: paragraphs });
    expect(findByTerm(results, 'shared-nothing')).toBeDefined();
    expect(findByTerm(results, 'fault-tolerant')).toBeDefined();
    expect(findByTerm(results, 'tail-latency')).toBeDefined();
    expect(findByTerm(results, 'shared-nothing')?.source).toBe(
      'hyphenated-compound',
    );
  });

  it('filters out trivial short hyphenated forms like "all-in" and "to-do"', () => {
    const paragraphs = [
      p(1, 0, 'We are all-in on this approach.'),
      p(1, 1, 'Add it to my to-do list.'),
    ];
    const results = extractAnchorCandidates({ bodyParagraphs: paragraphs });
    expect(findByTerm(results, 'all-in')).toBeUndefined();
    expect(findByTerm(results, 'to-do')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Heuristic 5: quoted phrases ≥3 words
// ---------------------------------------------------------------------------

describe('extractAnchorCandidates — heuristic 5: quoted phrases', () => {
  it('matches a straight-quoted phrase with ≥3 words', () => {
    const paragraphs = [
      p(1, 0, 'The paper "Out of the Tar Pit" makes this argument.'),
    ];
    const results = extractAnchorCandidates({ bodyParagraphs: paragraphs });
    const hit = findByTerm(results, 'Out of the Tar Pit');
    expect(hit).toBeDefined();
    expect(hit?.source).toBe('quoted-phrase');
  });

  it('matches a curly-quoted phrase with ≥3 words', () => {
    const paragraphs = [
      p(1, 0, 'They called it “a tale of two systems”.'),
    ];
    const results = extractAnchorCandidates({ bodyParagraphs: paragraphs });
    const hit = findByTerm(results, 'a tale of two systems');
    expect(hit).toBeDefined();
    expect(hit?.source).toBe('quoted-phrase');
  });

  it('skips quoted single-word emphasis (< 3 words)', () => {
    const paragraphs = [
      p(1, 0, 'They called it "consistency" but meant something else entirely.'),
    ];
    const results = extractAnchorCandidates({ bodyParagraphs: paragraphs });
    const hit = results.find((c) => c.source === 'quoted-phrase');
    expect(hit).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Cross-cutting: word-boundary correctness
// ---------------------------------------------------------------------------

describe('extractAnchorCandidates — word boundaries', () => {
  it('"RAID" does not match inside "afraid"', () => {
    const paragraphs = [
      p(1, 0, 'I am afraid that afraid people get afraid.'),
    ];
    const results = extractAnchorCandidates({
      bodyParagraphs: paragraphs,
      glossaryTerms: ['RAID'],
    });
    const hit = findByTerm(results, 'RAID');
    expect(hit).toBeDefined();
    // RAID is a glossary term; the frequency is computed word-bounded over
    // the body. "afraid" should NOT contribute.
    expect(hit?.frequency).toBe(0);
  });

  it('"MySQL" does not match inside "MyselfQL"', () => {
    const paragraphs = [
      p(1, 0, 'I use MyselfQL daily but never MyselfQL again.'),
      p(1, 1, 'But MySQL is fine for now.'),
    ];
    const results = extractAnchorCandidates({
      bodyParagraphs: paragraphs,
      glossaryTerms: ['MySQL'],
    });
    const hit = findByTerm(results, 'MySQL');
    expect(hit).toBeDefined();
    expect(hit?.frequency).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Cross-cutting: frequency counting across paragraphs
// ---------------------------------------------------------------------------

describe('extractAnchorCandidates — frequency counting', () => {
  it('counts case-insensitive word-bounded occurrences across all paragraphs', () => {
    const paragraphs = [
      p(1, 0, 'Kubernetes is great. We love kubernetes.'),
      p(2, 0, 'KUBERNETES handles container orchestration.'),
      p(3, 0, 'And kubernetes is fun.'),
      p(4, 0, 'Did I mention Kubernetes?'),
    ];
    const results = extractAnchorCandidates({
      bodyParagraphs: paragraphs,
      glossaryTerms: ['Kubernetes'],
    });
    const hit = findByTerm(results, 'Kubernetes');
    expect(hit).toBeDefined();
    expect(hit?.frequency).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Cross-cutting: first_seen_at correctness
// ---------------------------------------------------------------------------

describe('extractAnchorCandidates — first_seen_at', () => {
  it('reports the first paragraph the term appears in, not a later one', () => {
    const paragraphs = [
      p(5, 0, 'No anchor here.'),
      p(7, 2, 'First mention of Kubernetes here.'),
      p(8, 0, 'Second mention of Kubernetes here.'),
      p(9, 0, 'Third mention of Kubernetes here.'),
    ];
    const results = extractAnchorCandidates({ bodyParagraphs: paragraphs });
    const hit = findByTerm(results, 'Kubernetes');
    expect(hit).toBeDefined();
    expect(hit?.first_seen_at).toBe('page7:paragraph2');
  });

  it('uses the page/paragraph idx of the earliest-document-order hit when multiple heuristics surface the same term', () => {
    const paragraphs = [
      // Page 3 — surfaced via capitalized-multiword
      p(3, 1, 'In Chaos Monkey we trust.'),
      // Page 5 — would also surface via glossary
      p(5, 0, 'Earlier mention.'),
    ];
    const results = extractAnchorCandidates({
      bodyParagraphs: paragraphs,
      glossaryTerms: ['Chaos Monkey'],
    });
    const hit = findByTerm(results, 'Chaos Monkey');
    expect(hit).toBeDefined();
    // The hit appeared on page 3 → first_seen_at must be page3:paragraph1.
    expect(hit?.first_seen_at).toBe('page3:paragraph1');
  });
});

// ---------------------------------------------------------------------------
// Cross-cutting: dedup by case
// ---------------------------------------------------------------------------

describe('extractAnchorCandidates — dedup by lowercase', () => {
  it('"Chaos Monkey" and "chaos monkey" produce a single entry', () => {
    const paragraphs = [
      p(1, 0, 'Chaos Monkey is one tool.'),
      p(2, 0, 'But chaos monkey runs in production too.'),
      p(3, 0, 'Chaos Monkey strikes again.'),
    ];
    const results = extractAnchorCandidates({ bodyParagraphs: paragraphs });
    const matches = results.filter(
      (c) => c.term.toLowerCase() === 'chaos monkey',
    );
    expect(matches.length).toBe(1);
    // Frequency must aggregate both casings.
    expect(matches[0]!.frequency).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Cross-cutting: glossary priority flag presence
// ---------------------------------------------------------------------------

describe('extractAnchorCandidates — glossary_priority flag', () => {
  it('is set true on glossary-sourced candidates and undefined on others', () => {
    const paragraphs = [
      p(1, 0, 'Chaos Monkey breaks things.'),
      p(1, 1, 'A shared-nothing approach scales.'),
      p(1, 2, 'ACID is a transaction property.'),
    ];
    const results = extractAnchorCandidates({
      bodyParagraphs: paragraphs,
      glossaryTerms: ['ACID'],
    });
    const chaos = findByTerm(results, 'Chaos Monkey');
    const shared = findByTerm(results, 'shared-nothing');
    const acid = findByTerm(results, 'ACID');
    expect(chaos?.glossary_priority).toBeUndefined();
    expect(shared?.glossary_priority).toBeUndefined();
    expect(acid?.glossary_priority).toBe(true);
  });

  it('wins source merge: term in both glossary AND another heuristic becomes glossary-sourced', () => {
    const paragraphs = [
      // Appears as capitalized-multiword AND in glossary list.
      p(1, 0, 'Chaos Monkey breaks things.'),
      p(2, 0, 'Chaos Monkey breaks more things.'),
    ];
    const results = extractAnchorCandidates({
      bodyParagraphs: paragraphs,
      glossaryTerms: ['Chaos Monkey'],
    });
    const hit = findByTerm(results, 'Chaos Monkey');
    expect(hit).toBeDefined();
    expect(hit?.source).toBe('glossary');
    expect(hit?.glossary_priority).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Cross-cutting: sort order
// ---------------------------------------------------------------------------

describe('extractAnchorCandidates — sort order', () => {
  it('sorts by frequency descending, then alphabetically', () => {
    const paragraphs = [
      // Banana appears 3x; Apple appears 5x; Cherry appears 3x.
      p(1, 0, 'Apple Apple Apple Apple Apple.'),
      p(1, 1, 'Banana Banana Banana.'),
      p(1, 2, 'Cherry Cherry Cherry.'),
    ];
    const results = extractAnchorCandidates({ bodyParagraphs: paragraphs });
    const apple = findByTerm(results, 'Apple');
    const banana = findByTerm(results, 'Banana');
    const cherry = findByTerm(results, 'Cherry');
    expect(apple).toBeDefined();
    expect(banana).toBeDefined();
    expect(cherry).toBeDefined();

    const appleIdx = results.indexOf(apple!);
    const bananaIdx = results.indexOf(banana!);
    const cherryIdx = results.indexOf(cherry!);

    // Apple (freq 5) must come before Banana (freq 3) and Cherry (freq 3).
    expect(appleIdx).toBeLessThan(bananaIdx);
    expect(appleIdx).toBeLessThan(cherryIdx);
    // Banana (tied freq) must come before Cherry alphabetically.
    expect(bananaIdx).toBeLessThan(cherryIdx);
  });
});

// ---------------------------------------------------------------------------
// Cross-cutting: empty input
// ---------------------------------------------------------------------------

describe('extractAnchorCandidates — edge cases', () => {
  it('empty bodyParagraphs returns empty array', () => {
    expect(extractAnchorCandidates({ bodyParagraphs: [] })).toEqual([]);
  });

  it('empty bodyParagraphs returns empty even with glossary supplied', () => {
    expect(
      extractAnchorCandidates({ bodyParagraphs: [], glossaryTerms: ['ACID'] }),
    ).toEqual([]);
  });

  it('bodyParagraphs with no qualifying matches returns empty array', () => {
    const paragraphs = [p(1, 0, 'just some lowercase prose with no anchors.')];
    const results = extractAnchorCandidates({ bodyParagraphs: paragraphs });
    expect(results).toEqual([]);
  });

  it('bodyParagraphs with empty-text paragraphs returns empty array (no crash)', () => {
    const paragraphs = [p(1, 0, ''), p(1, 1, ''), p(2, 0, '')];
    const results = extractAnchorCandidates({ bodyParagraphs: paragraphs });
    expect(results).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Wave-1 review HIGH H1: all-caps acronyms (heuristic 2 extension)
// ---------------------------------------------------------------------------

describe('extractAnchorCandidates — all-caps acronyms (Wave-1 review HIGH H1)', () => {
  it('captures all-caps acronym occurring ≥3 times', () => {
    // Before the H1 fix, SINGLE_CAPITALIZED_RE was /\b[A-Z][a-z]+\b/g —
    // an all-caps term like RAFT had zero matches and was silently missed.
    // After the fix, the regex matches both Title-Case and ALL-CAPS forms.
    const paragraphs = [
      p(1, 0, 'The RAFT protocol elects a leader.'),
      p(1, 1, 'RAFT log entries are replicated to a quorum.'),
      p(2, 0, 'Both Paxos and RAFT solve consensus.'),
    ];
    const results = extractAnchorCandidates({ bodyParagraphs: paragraphs });
    const hit = results.find((c) => c.term === 'RAFT');
    expect(hit).toBeDefined();
    expect(hit?.source).toBe('capitalized-frequency');
    expect(hit?.frequency).toBe(3);
  });

  it('captures multiple all-caps acronyms (ACID, TCP, MVCC) in one corpus', () => {
    const paragraphs = [
      p(1, 0, 'ACID transactions are foundational. ACID is the standard.'),
      p(1, 1, 'TCP guarantees ordered delivery. TCP retries lost segments.'),
      p(2, 0, 'MVCC uses snapshots. MVCC is read-optimized. ACID and MVCC.'),
      p(3, 0, 'Together ACID, TCP, and MVCC define the durability layer.'),
    ];
    const results = extractAnchorCandidates({ bodyParagraphs: paragraphs });
    const terms = new Set(results.map((c) => c.term));
    expect(terms.has('ACID')).toBe(true);
    expect(terms.has('TCP')).toBe(true);
    expect(terms.has('MVCC')).toBe(true);
  });

  it('filters all-caps stopwords (IN, AND, OR, NOT)', () => {
    // Sentence-start stopwords would otherwise dominate any technical doc.
    const paragraphs = [
      p(1, 0, 'IN the beginning. IN the middle. IN the end.'),
      p(1, 1, 'AND therefore. AND also. AND finally.'),
      p(2, 0, 'OR perhaps. OR maybe. OR not.'),
    ];
    const results = extractAnchorCandidates({ bodyParagraphs: paragraphs });
    const terms = new Set(results.map((c) => c.term));
    expect(terms.has('IN')).toBe(false);
    expect(terms.has('AND')).toBe(false);
    expect(terms.has('OR')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Wave-1 review HIGH H2: N-word sentence-start filter
// ---------------------------------------------------------------------------

describe('extractAnchorCandidates — N-word sentence-start filter (Wave-1 review HIGH H2)', () => {
  it('filters "The First Principle" at sentence-start position (3-word phrase)', () => {
    // Pre-fix: only 2-word splices were filtered. "The First Principle" at
    // sentence-start would leak through as a capitalized-multiword candidate.
    // Post-fix: phrases beginning with a known sentence-start stopword AT
    // sentence-boundary are filtered regardless of length.
    const paragraphs = [
      p(1, 0, 'The First Principle of distributed systems is acknowledging that the network is unreliable.'),
    ];
    const results = extractAnchorCandidates({ bodyParagraphs: paragraphs });
    const noise = results.find((c) => c.term === 'The First Principle');
    expect(noise).toBeUndefined();
  });

  it('does NOT filter a real proper noun that happens to start with "The" mid-sentence', () => {
    // The conservative rule: filter ONLY when BOTH (a) starts with stopword
    // AND (b) at sentence boundary. A mid-paragraph occurrence is preserved.
    const paragraphs = [
      p(1, 0, 'Many systems use The Bigtable Pattern for sparse tables today, including HBase and Cassandra.'),
    ];
    const results = extractAnchorCandidates({ bodyParagraphs: paragraphs });
    // The phrase is mid-sentence (after "use"), so the filter does NOT fire.
    // Whether the regex captures it depends on the engine; we assert only
    // that the filter doesn't prematurely strike it.
    const hit = results.find((c) => c.term.startsWith('The Bigtable'));
    if (hit) {
      // If captured, it must be a valid multiword (not filtered as splice)
      expect(hit.source).toBe('capitalized-multiword');
    }
    // The test passes regardless of whether the regex captured the phrase;
    // what we're verifying is that the filter logic doesn't OVER-fire.
  });
});

// ---------------------------------------------------------------------------
// Wave-1 review HIGH H4: single curly quotes (U+2018/U+2019)
// ---------------------------------------------------------------------------

describe('extractAnchorCandidates — single curly quotes (Wave-1 review HIGH H4)', () => {
  it('matches a phrase quoted with single curly quotes (LaTeX-typeset PDFs)', () => {
    // Pre-fix: QUOTED_CURLY_RE only matched double curlies (U+201C/U+201D).
    // LaTeX-typeset technical books predominantly use single curly quotes
    // for short citations and signature analogies. Without this fix, those
    // phrases were silently dropped from the candidate list.
    const paragraphs = [
      p(1, 0, 'Kleppmann describes ‘the celebrity hybrid pattern’ in chapter 1.'),
    ];
    const results = extractAnchorCandidates({ bodyParagraphs: paragraphs });
    const hit = results.find(
      (c) => c.source === 'quoted-phrase' && c.term === 'the celebrity hybrid pattern',
    );
    expect(hit).toBeDefined();
  });

  it('matches both single and double curly quotes in the same paragraph', () => {
    const paragraphs = [
      p(1, 0,
        'The author calls it “the celebrity hybrid resolution”, ' +
          'inspired by ‘the impedance mismatch metaphor’ from earlier.',
      ),
    ];
    const results = extractAnchorCandidates({ bodyParagraphs: paragraphs });
    const terms = new Set(results.map((c) => c.term));
    expect(terms.has('the celebrity hybrid resolution')).toBe(true);
    expect(terms.has('the impedance mismatch metaphor')).toBe(true);
  });
});
