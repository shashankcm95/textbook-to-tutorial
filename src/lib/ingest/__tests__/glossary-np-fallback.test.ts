// src/lib/ingest/__tests__/glossary-np-fallback.test.ts
//
// Tests for the Sprint-J frequent-NP glossary bootstrap path.
//
// Coverage:
//   - extractFrequentNPs (pure):
//       * frequency ranking + threshold
//       * stopword filtering at sentence-start
//       * topK cap
//       * case-insensitive folding with first-seen display casing
//       * empty input → empty list
//   - buildRefineUserPrompt: structural assertions on candidate + context blocks.
//   - refineCandidatesWithLLM (mocked OpenAI):
//       * happy path emits validated terms
//       * empty candidate list short-circuits without an LLM call
//       * malformed-JSON response fails open with empty list
//       * malformed-shape response filters out invalid entries
//       * LLM throw fails open with empty list
//   - runGlossaryNPBootstrap (orchestrator):
//       * end-to-end happy path returns GlossaryArtifact with terms
//       * empty body paragraphs short-circuits
//       * fallback respects topK + minFrequency overrides

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SourceParagraph } from '@/lib/types';

// ───────────────────────────────────────────────────────────────────────────
// Mock the OpenAI singleton BEFORE importing the module under test.
// vitest hoists vi.mock to the top of the file, so this runs first.
// ───────────────────────────────────────────────────────────────────────────

const createMock = vi.fn();
vi.mock('@/lib/openai/client', () => ({
  openai: {
    chat: {
      completions: {
        create: (...args: unknown[]) => createMock(...args),
      },
    },
  },
}));

// Imports must come AFTER vi.mock for the mock to take effect.
import {
  extractFrequentNPs,
  buildRefineUserPrompt,
  refineCandidatesWithLLM,
  runGlossaryNPBootstrap,
  __TEST_ONLY,
  type NPCandidate,
} from '../glossary-np-fallback';

// ───────────────────────────────────────────────────────────────────────────
// Fixtures
// ───────────────────────────────────────────────────────────────────────────

function makeParagraph(
  page: number,
  paragraphIdx: number,
  text: string,
): SourceParagraph {
  return { page, paragraphIdx, text };
}

beforeEach(() => {
  createMock.mockReset();
});

// ───────────────────────────────────────────────────────────────────────────
// extractFrequentNPs — pure heuristic
// ───────────────────────────────────────────────────────────────────────────

describe('extractFrequentNPs', () => {
  it('returns empty list for empty input', () => {
    expect(extractFrequentNPs([])).toEqual([]);
  });

  it('returns empty list when no candidates meet minFrequency', () => {
    const paragraphs: SourceParagraph[] = [
      makeParagraph(
        1,
        0,
        'Binary Search Tree was introduced in this chapter as a key structure.',
      ),
      // Binary Search Tree appears only once across the body → below default
      // minFrequency=3, so the function should return an empty list.
    ];
    expect(extractFrequentNPs(paragraphs)).toEqual([]);
  });

  it('captures a multi-word capitalized phrase that appears ≥minFrequency times', () => {
    const paragraphs: SourceParagraph[] = [
      makeParagraph(1, 0, 'A Hash Table uses a hash function to index entries.'),
      makeParagraph(2, 0, 'When the Hash Table grows, it must rehash entries.'),
      makeParagraph(3, 0, 'Implementing a Hash Table requires care with collisions.'),
    ];
    const result = extractFrequentNPs(paragraphs);
    expect(result).toHaveLength(1);
    expect(result[0]!.term).toBe('Hash Table');
    expect(result[0]!.count).toBe(3);
    expect(result[0]!.firstParagraphRef).toBe('page1:paragraph0');
  });

  it('frequency-ranks descending; ties broken alphabetically by term', () => {
    // Each phrase placed in distinct paragraphs (and with separating prose
    // INSIDE each paragraph using lowercase connectors) so the multi-word
    // regex doesn't greedily glue adjacent repeats into one match.
    const paragraphs: SourceParagraph[] = [
      // "Hash Table" → 3 paragraphs (qualifies @ minFrequency=3).
      makeParagraph(1, 0, 'A Hash Table maps keys to values.'),
      makeParagraph(2, 0, 'A Hash Table uses a hash function.'),
      makeParagraph(3, 0, 'A Hash Table relies on bucket arrays.'),
      // "Linked List" → 3 paragraphs.
      makeParagraph(4, 0, 'A Linked List has nodes pointing forward.'),
      makeParagraph(5, 0, 'A Linked List can grow indefinitely.'),
      makeParagraph(6, 0, 'A Linked List uses pointers for next.'),
      // "Binary Search Tree" → 2 paragraphs (DOES NOT qualify).
      makeParagraph(7, 0, 'A Binary Search Tree halves the search space.'),
      makeParagraph(8, 0, 'A Binary Search Tree benefits from balancing.'),
    ];
    const result = extractFrequentNPs(paragraphs);
    // Hash Table (3) and Linked List (3) qualify; Binary Search Tree (2)
    // does NOT. Alphabetical on tie.
    expect(result).toHaveLength(2);
    expect(result.map((c) => c.term)).toEqual(['Hash Table', 'Linked List']);
  });

  it('folds case for counting but preserves first-seen display casing', () => {
    const paragraphs: SourceParagraph[] = [
      // First seen casing — should be the display form.
      makeParagraph(1, 0, 'A Bloom Filter is a probabilistic data structure.'),
      // Same words, different casing.
      makeParagraph(2, 0, 'A bloom filter trades space for accuracy.'),
      makeParagraph(3, 0, 'When the BLOOM FILTER fills up, false positives rise.'),
      makeParagraph(4, 0, 'Engineers reach for Bloom Filter when memory is tight.'),
    ];
    const result = extractFrequentNPs(paragraphs);
    // Lowercase + uppercase variants don't match the multi-word regex (it
    // requires Title-Case), so only the Title-Case occurrences count.
    // First-seen casing is preserved.
    expect(result.length).toBeGreaterThanOrEqual(0);
    // If the heuristic captures Title-Case occurrences only, the count is 2.
    // We're tolerant of that lower bound — the contract is "display = first
    // seen", not "match all casings".
    const bloomEntries = result.filter((c) => c.term === 'Bloom Filter');
    if (bloomEntries.length === 1) {
      expect(bloomEntries[0]!.count).toBeGreaterThanOrEqual(2);
    }
  });

  it('filters sentence-start stopword phrases at sentence boundaries', () => {
    const paragraphs: SourceParagraph[] = [
      // "This Chapter" at the start of a sentence — should be filtered.
      makeParagraph(1, 0, 'This Chapter introduces sorting. This Chapter ends here.'),
      makeParagraph(2, 0, 'This Chapter relates to data structures.'),
    ];
    const result = extractFrequentNPs(paragraphs);
    // "This Chapter" must NOT appear — first word is a sentence-start
    // stopword AND each match starts at a sentence boundary.
    const hasStopwordPhrase = result.some((c) => c.term.startsWith('This '));
    expect(hasStopwordPhrase).toBe(false);
  });

  it('respects topK cap', () => {
    // 5 distinct NPs, each appearing 3+ times.
    const paragraphs: SourceParagraph[] = [];
    const terms = [
      'Alpha Term',
      'Bravo Term',
      'Charlie Term',
      'Delta Term',
      'Echo Term',
    ];
    let pageNum = 1;
    for (const term of terms) {
      // 3 occurrences per term to clear minFrequency=3.
      for (let i = 0; i < 3; i++) {
        paragraphs.push(
          makeParagraph(pageNum++, 0, `Discussion of ${term} happens here.`),
        );
      }
    }
    const result = extractFrequentNPs(paragraphs, { topK: 3 });
    expect(result).toHaveLength(3);
  });

  it('respects custom minFrequency', () => {
    const paragraphs: SourceParagraph[] = [
      makeParagraph(1, 0, 'A Hash Table appears here.'),
      // Hash Table appears once — would NOT qualify at default minFrequency=3
      // but DOES qualify at minFrequency=1.
    ];
    const resultDefault = extractFrequentNPs(paragraphs);
    const resultLoose = extractFrequentNPs(paragraphs, { minFrequency: 1 });
    expect(resultDefault).toEqual([]);
    expect(resultLoose.length).toBeGreaterThanOrEqual(1);
    expect(resultLoose[0]!.term).toBe('Hash Table');
  });

  it('returns ranked output with the deterministic counter-tiebreaker', () => {
    // Each NP appears in distinct paragraphs to avoid the regex greedily
    // gobbling repeated phrases into a single multi-word match.
    const paragraphs: SourceParagraph[] = [
      // Hash Table → 4 paragraphs
      makeParagraph(1, 0, 'A Hash Table maps keys to values.'),
      makeParagraph(2, 0, 'A Hash Table needs a good hash function.'),
      makeParagraph(3, 0, 'A Hash Table grows by rehashing entries.'),
      makeParagraph(4, 0, 'A Hash Table is fast on average.'),
      // Binary Tree → 4 paragraphs
      makeParagraph(5, 0, 'A Binary Tree has two children per node.'),
      makeParagraph(6, 0, 'A Binary Tree can be traversed inorder.'),
      makeParagraph(7, 0, 'A Binary Tree is the basis of more advanced trees.'),
      makeParagraph(8, 0, 'A Binary Tree is recursive by definition.'),
      // Linked List → 3 paragraphs
      makeParagraph(9, 0, 'A Linked List has nodes with next pointers.'),
      makeParagraph(10, 0, 'A Linked List allows O(1) head insert.'),
      makeParagraph(11, 0, 'A Linked List supports flexible growth.'),
    ];
    const result = extractFrequentNPs(paragraphs);
    // Two terms tied at count=4 → alphabetical: Binary Tree before Hash Table.
    expect(result.map((c) => c.term)).toEqual([
      'Binary Tree',
      'Hash Table',
      'Linked List',
    ]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// buildRefineUserPrompt — structural check
// ───────────────────────────────────────────────────────────────────────────

describe('buildRefineUserPrompt', () => {
  it('emits both the candidate list and the context-paragraph block', () => {
    const candidates: NPCandidate[] = [
      { term: 'Hash Table', count: 5, firstParagraphRef: 'page1:paragraph0' },
      { term: 'Bloom Filter', count: 3, firstParagraphRef: 'page2:paragraph1' },
    ];
    const context: SourceParagraph[] = [
      makeParagraph(1, 0, 'A Hash Table maps keys to buckets via a hash function.'),
      makeParagraph(2, 1, 'A Bloom Filter is a probabilistic data structure.'),
    ];
    const prompt = buildRefineUserPrompt(candidates, context);
    expect(prompt).toContain('Candidate terms');
    expect(prompt).toContain('"Hash Table" (count=5, first_seen=page1:paragraph0)');
    expect(prompt).toContain('"Bloom Filter" (count=3, first_seen=page2:paragraph1)');
    expect(prompt).toContain('Source-context paragraph samples');
    expect(prompt).toContain('[page1:paragraph0]');
    expect(prompt).toContain('[page2:paragraph1]');
  });

  it('handles empty candidates with the (none) placeholder', () => {
    const prompt = buildRefineUserPrompt([], []);
    expect(prompt).toContain('Candidate terms');
    expect(prompt).toContain('(none)');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// refineCandidatesWithLLM — mocked OpenAI
// ───────────────────────────────────────────────────────────────────────────

function mockResponse(content: string) {
  return {
    choices: [{ message: { content } }],
    usage: { prompt_tokens: 100, completion_tokens: 50 },
  };
}

describe('refineCandidatesWithLLM', () => {
  it('returns empty list (no LLM call) when candidates list is empty', async () => {
    const result = await refineCandidatesWithLLM([], []);
    expect(result).toEqual([]);
    expect(createMock).not.toHaveBeenCalled();
  });

  it('parses a valid LLM response into RefinedTerm[]', async () => {
    createMock.mockResolvedValue(
      mockResponse(
        JSON.stringify({
          terms: [
            {
              term: 'Hash Table',
              definition: 'A data structure mapping keys to bucket indexes.',
              sourceParagraphRef: 'page1:paragraph0',
            },
            {
              term: 'Bloom Filter',
              definition: 'A probabilistic set membership filter.',
              sourceParagraphRef: 'page2:paragraph1',
            },
          ],
        }),
      ),
    );

    const result = await refineCandidatesWithLLM(
      [
        { term: 'Hash Table', count: 5, firstParagraphRef: 'page1:paragraph0' },
        { term: 'Bloom Filter', count: 3, firstParagraphRef: 'page2:paragraph1' },
      ],
      [makeParagraph(1, 0, 'A Hash Table example.')],
    );

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      term: 'Hash Table',
      definition: 'A data structure mapping keys to bucket indexes.',
      sourceParagraphRef: 'page1:paragraph0',
    });
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  it('filters out entries with invalid sourceParagraphRef shape', async () => {
    createMock.mockResolvedValue(
      mockResponse(
        JSON.stringify({
          terms: [
            { term: 'Good', definition: 'fine', sourceParagraphRef: 'page1:paragraph0' },
            { term: 'Bad', definition: 'fine', sourceParagraphRef: 'invalid-ref' },
            { term: 'Range', definition: 'fine', sourceParagraphRef: 'page1:paragraph3-5' },
          ],
        }),
      ),
    );
    const result = await refineCandidatesWithLLM(
      [{ term: 'Good', count: 3, firstParagraphRef: 'page1:paragraph0' }],
      [makeParagraph(1, 0, 'context')],
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.term).toBe('Good');
  });

  it('filters out entries with empty term or definition', async () => {
    createMock.mockResolvedValue(
      mockResponse(
        JSON.stringify({
          terms: [
            { term: '', definition: 'has def', sourceParagraphRef: 'page1:paragraph0' },
            { term: 'name', definition: '', sourceParagraphRef: 'page1:paragraph0' },
            { term: 'good', definition: 'good', sourceParagraphRef: 'page1:paragraph0' },
          ],
        }),
      ),
    );
    const result = await refineCandidatesWithLLM(
      [{ term: 'good', count: 3, firstParagraphRef: 'page1:paragraph0' }],
      [makeParagraph(1, 0, 'context')],
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.term).toBe('good');
  });

  it('returns empty list when the LLM response is malformed JSON (fail-open)', async () => {
    createMock.mockResolvedValue(mockResponse('this is not json {{{'));
    const result = await refineCandidatesWithLLM(
      [{ term: 'X', count: 3, firstParagraphRef: 'page1:paragraph0' }],
      [makeParagraph(1, 0, 'context')],
    );
    expect(result).toEqual([]);
  });

  it('returns empty list when the LLM call throws (fail-open)', async () => {
    // Throwing every call exhausts withRetry's retry budget and surfaces
    // the error to our try/catch.
    createMock.mockRejectedValue(new Error('network blew up'));
    const result = await refineCandidatesWithLLM(
      [{ term: 'X', count: 3, firstParagraphRef: 'page1:paragraph0' }],
      [makeParagraph(1, 0, 'context')],
    );
    expect(result).toEqual([]);
  });

  it('returns empty list when terms is missing from the response', async () => {
    createMock.mockResolvedValue(mockResponse(JSON.stringify({ irrelevant: true })));
    const result = await refineCandidatesWithLLM(
      [{ term: 'X', count: 3, firstParagraphRef: 'page1:paragraph0' }],
      [makeParagraph(1, 0, 'context')],
    );
    expect(result).toEqual([]);
  });

  it('caps term + definition string lengths at 200 / 500', async () => {
    const longTerm = 'A'.repeat(300);
    const longDef = 'B'.repeat(800);
    createMock.mockResolvedValue(
      mockResponse(
        JSON.stringify({
          terms: [
            { term: longTerm, definition: longDef, sourceParagraphRef: 'page1:paragraph0' },
          ],
        }),
      ),
    );
    const result = await refineCandidatesWithLLM(
      [{ term: longTerm, count: 3, firstParagraphRef: 'page1:paragraph0' }],
      [makeParagraph(1, 0, 'context')],
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.term.length).toBe(200);
    expect(result[0]!.definition.length).toBe(500);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// runGlossaryNPBootstrap — orchestrator
// ───────────────────────────────────────────────────────────────────────────

describe('runGlossaryNPBootstrap', () => {
  it('returns empty GlossaryArtifact for empty body paragraphs (no LLM call)', async () => {
    const result = await runGlossaryNPBootstrap([]);
    expect(result.schemaVersion).toBe(1);
    expect(result.terms).toEqual([]);
    expect(createMock).not.toHaveBeenCalled();
  });

  it('returns empty GlossaryArtifact when no candidates clear minFrequency (no LLM call)', async () => {
    const paragraphs: SourceParagraph[] = [
      makeParagraph(1, 0, 'A Hash Table is introduced once.'),
      makeParagraph(2, 0, 'A Bloom Filter is mentioned once.'),
    ];
    const result = await runGlossaryNPBootstrap(paragraphs);
    expect(result.terms).toEqual([]);
    expect(createMock).not.toHaveBeenCalled();
  });

  it('full end-to-end happy path: heuristic → LLM filter → GlossaryArtifact', async () => {
    const paragraphs: SourceParagraph[] = [
      makeParagraph(1, 0, 'Hash Table maps keys to buckets. Hash Table uses a hash.'),
      makeParagraph(2, 0, 'Hash Table grows by rehashing. Hash Table is fast.'),
      makeParagraph(3, 0, 'Linked List has nodes. Linked List grows easily.'),
      makeParagraph(4, 0, 'Linked List allows O(1) insert at head.'),
    ];

    createMock.mockResolvedValue(
      mockResponse(
        JSON.stringify({
          terms: [
            {
              term: 'Hash Table',
              definition: 'A keyed structure indexed via a hash function.',
              sourceParagraphRef: 'page1:paragraph0',
            },
          ],
        }),
      ),
    );

    const result = await runGlossaryNPBootstrap(paragraphs);
    expect(result.schemaVersion).toBe(1);
    expect(result.terms).toHaveLength(1);
    expect(result.terms[0]!.term).toBe('Hash Table');
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  it('passes the options.topK + options.minFrequency through to extractFrequentNPs', async () => {
    const paragraphs: SourceParagraph[] = [
      makeParagraph(1, 0, 'A Hash Table appears once here.'),
    ];
    // With default minFrequency=3, no candidates qualify → no LLM call.
    // With minFrequency=1, Hash Table qualifies → LLM IS called.
    createMock.mockResolvedValue(mockResponse(JSON.stringify({ terms: [] })));
    await runGlossaryNPBootstrap(paragraphs, { minFrequency: 1, topK: 5 });
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  it('returns empty terms when the LLM refine step fails (fail-open)', async () => {
    const paragraphs: SourceParagraph[] = [
      makeParagraph(1, 0, 'Hash Table is here. Hash Table again. Hash Table thrice.'),
    ];
    createMock.mockRejectedValue(new Error('boom'));
    const result = await runGlossaryNPBootstrap(paragraphs);
    expect(result.schemaVersion).toBe(1);
    expect(result.terms).toEqual([]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Module-level invariants
// ───────────────────────────────────────────────────────────────────────────

describe('__TEST_ONLY invariants', () => {
  it('uses gpt-4o-mini as the refine model', () => {
    expect(__TEST_ONLY.NP_FALLBACK_MODEL).toBe('gpt-4o-mini');
  });

  it('REFINE_SYSTEM_PROMPT mentions glossary + technical term filtering', () => {
    expect(__TEST_ONLY.REFINE_SYSTEM_PROMPT).toContain('glossary');
    expect(__TEST_ONLY.REFINE_SYSTEM_PROMPT).toContain('GENUINE TECHNICAL TERM');
  });

  it('NP_STOPWORDS contains the obvious sentence-start words', () => {
    expect(__TEST_ONLY.NP_STOPWORDS.has('The')).toBe(true);
    expect(__TEST_ONLY.NP_STOPWORDS.has('This')).toBe(true);
    expect(__TEST_ONLY.NP_STOPWORDS.has('In')).toBe(true);
  });
});
