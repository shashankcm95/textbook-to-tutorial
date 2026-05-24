// src/lib/ingest/__tests__/anchor-scorer.test.ts
//
// Unit tests for the LLM anchor scorer (Feature B', Wave 2).
//
// Coverage:
//   - Happy path: 50 candidates → LLM scores → top-30 returned, categorized
//   - Empty candidates → empty whitelist, no LLM call
//   - LLM hallucination guard: term not in input → dropped
//   - LLM invalid-category guard: category not in enum → dropped
//   - Glossary priority: glossary candidate survives top-30 cut even when
//     non-glossary candidates would otherwise displace it
//   - Cap enforcement: 100 candidates returning 100 → top-30 only
//   - Category-priority tie-break: contrast-pair beats search-term at same freq
//   - Parse-retry recovery: first call malformed → second call succeeds
//   - Cost arithmetic correctness
//   - Prompt + model invariants asserted via __TEST_ONLY

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AnchorCandidate } from '../anchor-prefilter';

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
  scoreAnchorCandidates,
  AnchorScorerParseError,
  buildScorerUserPrompt,
  compareForTopN,
  selectTopNWithGlossaryBoost,
  __TEST_ONLY,
} from '../anchor-scorer';
import type { AnchorWhitelistEntry } from '@/lib/openai/anchor-validator';

// ───────────────────────────────────────────────────────────────────────────
// Test fixtures
// ───────────────────────────────────────────────────────────────────────────

interface MakeCandidateOpts {
  term: string;
  frequency: number;
  source?: AnchorCandidate['source'];
  firstSeen?: string;
  glossary?: boolean;
}

function makeCandidate(opts: MakeCandidateOpts): AnchorCandidate {
  const c: AnchorCandidate = {
    term: opts.term,
    category: 'unknown',
    frequency: opts.frequency,
    first_seen_at: opts.firstSeen ?? 'page1:paragraph0',
    source: opts.source ?? 'capitalized-multiword',
  };
  if (opts.glossary) c.glossary_priority = true;
  return c;
}

/**
 * Build N candidates with descending frequencies starting at maxFreq.
 * Default source is `capitalized-multiword`. Term names are `term-N`.
 */
function makeNCandidates(n: number, maxFreq = 100): AnchorCandidate[] {
  return Array.from({ length: n }, (_, i) =>
    makeCandidate({
      term: `term-${i}`,
      frequency: Math.max(1, maxFreq - i),
      firstSeen: `page${i + 1}:paragraph0`,
    }),
  );
}

function buildLLMContentFromCandidates(
  candidates: AnchorCandidate[],
  category: AnchorWhitelistEntry['category'] = 'search-term',
): string {
  return JSON.stringify({
    anchors: candidates.map((c) => ({
      term: c.term,
      category,
      keep: true,
    })),
  });
}

function buildOpenAIResponse(
  content: string,
  promptTokens = 1500,
  completionTokens = 600,
): {
  choices: Array<{ message: { content: string } }>;
  usage: { prompt_tokens: number; completion_tokens: number };
} {
  return {
    choices: [{ message: { content } }],
    usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens },
  };
}

// ───────────────────────────────────────────────────────────────────────────
// buildScorerUserPrompt — prompt formatting
// ───────────────────────────────────────────────────────────────────────────

describe('buildScorerUserPrompt', () => {
  it('renders each candidate on its own [N] line with all fields', () => {
    const cs = [
      makeCandidate({
        term: 'head-of-line blocking',
        frequency: 4,
        source: 'capitalized-multiword',
        firstSeen: 'page36:paragraph2',
      }),
      makeCandidate({
        term: 'ACID',
        frequency: 12,
        source: 'glossary',
        firstSeen: 'page2:paragraph1',
        glossary: true,
      }),
    ];
    const prompt = buildScorerUserPrompt(cs);
    expect(prompt).toContain(
      '[1] term: "head-of-line blocking", source: capitalized-multiword, frequency: 4, first_seen: page36:paragraph2, glossary: false',
    );
    expect(prompt).toContain(
      '[2] term: "ACID", source: glossary, frequency: 12, first_seen: page2:paragraph1, glossary: true',
    );
    expect(prompt.trim().endsWith('Output the filtered whitelist as strict JSON now.')).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// compareForTopN + selectTopNWithGlossaryBoost — pure selection helpers
// ───────────────────────────────────────────────────────────────────────────

describe('compareForTopN', () => {
  it('sorts higher frequency first', () => {
    const a: AnchorWhitelistEntry = {
      term: 'a',
      category: 'search-term',
      frequency_in_source: 10,
      first_seen_at: 'page1:paragraph0',
    };
    const b: AnchorWhitelistEntry = {
      term: 'b',
      category: 'search-term',
      frequency_in_source: 5,
      first_seen_at: 'page1:paragraph0',
    };
    expect(compareForTopN(a, b)).toBeLessThan(0);
    expect(compareForTopN(b, a)).toBeGreaterThan(0);
  });

  it('breaks ties by category priority (contrast-pair beats search-term)', () => {
    const contrast: AnchorWhitelistEntry = {
      term: 'fault vs failure',
      category: 'contrast-pair',
      frequency_in_source: 5,
      first_seen_at: 'page1:paragraph0',
    };
    const search: AnchorWhitelistEntry = {
      term: 'eventual consistency',
      category: 'search-term',
      frequency_in_source: 5,
      first_seen_at: 'page1:paragraph0',
    };
    expect(compareForTopN(contrast, search)).toBeLessThan(0);
  });

  it('breaks further ties by lowercase term alpha order', () => {
    const a: AnchorWhitelistEntry = {
      term: 'Banana',
      category: 'search-term',
      frequency_in_source: 5,
      first_seen_at: 'page1:paragraph0',
    };
    const b: AnchorWhitelistEntry = {
      term: 'apple',
      category: 'search-term',
      frequency_in_source: 5,
      first_seen_at: 'page1:paragraph0',
    };
    // apple < banana (case-insensitive)
    expect(compareForTopN(b, a)).toBeLessThan(0);
  });
});

describe('selectTopNWithGlossaryBoost', () => {
  it('returns all entries unchanged when count <= 30', () => {
    const entries = Array.from({ length: 20 }, (_, i) => ({
      term: `t${i}`,
      category: 'search-term' as const,
      frequency_in_source: 100 - i,
      first_seen_at: 'page1:paragraph0',
      isGlossary: false,
    }));
    const out = selectTopNWithGlossaryBoost(entries);
    expect(out.length).toBe(20);
  });

  it('caps to exactly 30 entries when more are provided', () => {
    const entries = Array.from({ length: 100 }, (_, i) => ({
      term: `t${i}`,
      category: 'search-term' as const,
      frequency_in_source: 1000 - i,
      first_seen_at: 'page1:paragraph0',
      isGlossary: false,
    }));
    const out = selectTopNWithGlossaryBoost(entries);
    expect(out.length).toBe(30);
    // First by frequency desc → t0 wins (freq 1000)
    expect(out[0]?.term).toBe('t0');
  });

  it('boosts a glossary entry that would otherwise be displaced', () => {
    // 30 non-glossary entries with frequencies 30..1, plus one glossary
    // entry with frequency 0 (below the cut). The glossary entry should
    // displace the lowest-freq non-glossary entry (freq 1).
    const entries: Array<
      AnchorWhitelistEntry & { isGlossary: boolean }
    > = Array.from({ length: 30 }, (_, i) => ({
      term: `t${i}`,
      category: 'search-term' as const,
      frequency_in_source: 30 - i,
      first_seen_at: 'page1:paragraph0',
      isGlossary: false,
    }));
    entries.push({
      term: 'GLOSSARY-TERM',
      category: 'search-term',
      frequency_in_source: 0,
      first_seen_at: 'page1:paragraph0',
      isGlossary: true,
    });
    const out = selectTopNWithGlossaryBoost(entries);
    expect(out.length).toBe(30);
    // Glossary entry should be present.
    expect(out.find((e) => e.term === 'GLOSSARY-TERM')).toBeDefined();
    // The lowest-freq non-glossary (t29, freq 1) should have been displaced.
    expect(out.find((e) => e.term === 't29')).toBeUndefined();
  });

  it('strips the isGlossary internal flag from returned entries', () => {
    const entries = [
      {
        term: 'a',
        category: 'search-term' as const,
        frequency_in_source: 5,
        first_seen_at: 'page1:paragraph0',
        isGlossary: true,
      },
    ];
    const out = selectTopNWithGlossaryBoost(entries);
    expect(out[0]).toEqual({
      term: 'a',
      category: 'search-term',
      frequency_in_source: 5,
      first_seen_at: 'page1:paragraph0',
    });
    // No leaked isGlossary field.
    expect('isGlossary' in (out[0] as object)).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// scoreAnchorCandidates — integration with mocked OpenAI
// ───────────────────────────────────────────────────────────────────────────

describe('scoreAnchorCandidates', () => {
  beforeEach(() => {
    createMock.mockReset();
  });

  it('returns an empty result without calling the LLM when candidates is empty', async () => {
    const result = await scoreAnchorCandidates({
      pdfSha256: 'sha-empty',
      candidates: [],
    });
    expect(result.whitelist).toEqual([]);
    expect(result.candidateCount).toBe(0);
    expect(result.acceptedCount).toBe(0);
    expect(result.extractionCostUsd).toBe(0);
    expect(result.promptTokens).toBe(0);
    expect(result.completionTokens).toBe(0);
    expect(result.model).toBe('gpt-4o-mini');
    expect(createMock).not.toHaveBeenCalled();
  });

  it('happy path: 50 candidates → top-30 returned, categorized', async () => {
    const candidates = makeNCandidates(50, 100);
    // LLM keeps all 50 with default search-term category.
    createMock.mockResolvedValueOnce(
      buildOpenAIResponse(buildLLMContentFromCandidates(candidates)),
    );

    const result = await scoreAnchorCandidates({
      pdfSha256: 'sha-happy',
      candidates,
    });

    expect(result.candidateCount).toBe(50);
    expect(result.whitelist.length).toBe(30);
    expect(result.acceptedCount).toBe(30);
    expect(result.model).toBe('gpt-4o-mini');
    // Top-30 by frequency desc → first should be term-0 (freq 100).
    expect(result.whitelist[0]?.term).toBe('term-0');
    expect(result.whitelist[0]?.frequency_in_source).toBe(100);
    // All entries have a valid category.
    for (const e of result.whitelist) {
      expect(e.category).toBe('search-term');
    }
  });

  it('drops LLM-hallucinated terms not in input candidates', async () => {
    const candidates = [
      makeCandidate({ term: 'real-term', frequency: 5 }),
    ];
    const hallucinatedContent = JSON.stringify({
      anchors: [
        { term: 'real-term', category: 'search-term', keep: true },
        { term: 'made-up-term', category: 'search-term', keep: true },
      ],
    });
    createMock.mockResolvedValueOnce(buildOpenAIResponse(hallucinatedContent));

    const result = await scoreAnchorCandidates({
      pdfSha256: 'sha-hallucinated',
      candidates,
    });

    expect(result.whitelist.length).toBe(1);
    expect(result.whitelist[0]?.term).toBe('real-term');
    expect(result.whitelist.find((e) => e.term === 'made-up-term')).toBeUndefined();
  });

  it('drops LLM entries with an invalid category', async () => {
    const candidates = [
      makeCandidate({ term: 'good-term', frequency: 5 }),
      makeCandidate({ term: 'bad-cat-term', frequency: 4 }),
    ];
    const invalidCategoryContent = JSON.stringify({
      anchors: [
        { term: 'good-term', category: 'search-term', keep: true },
        { term: 'bad-cat-term', category: 'invalid', keep: true },
      ],
    });
    createMock.mockResolvedValueOnce(buildOpenAIResponse(invalidCategoryContent));

    const result = await scoreAnchorCandidates({
      pdfSha256: 'sha-bad-cat',
      candidates,
    });

    expect(result.whitelist.length).toBe(1);
    expect(result.whitelist[0]?.term).toBe('good-term');
  });

  it('honors glossary priority: glossary candidate survives top-30 cut', async () => {
    // 30 non-glossary candidates (freq 100..71) + 1 glossary (freq 1).
    // The LLM rejects the glossary candidate but keeps the 30 non-glossary
    // ones. After glossary-priority boost, the glossary candidate is
    // promoted into the top-30, displacing term-29 (freq 71).
    const nonGlossary = Array.from({ length: 30 }, (_, i) =>
      makeCandidate({
        term: `ng-${i}`,
        frequency: 100 - i,
        firstSeen: `page${i + 1}:paragraph0`,
      }),
    );
    const glossary = makeCandidate({
      term: 'CRDT',
      frequency: 1,
      source: 'glossary',
      firstSeen: 'page2:paragraph1',
      glossary: true,
    });
    const candidates = [...nonGlossary, glossary];

    // LLM keeps only the 30 non-glossary (rejects glossary CRDT).
    createMock.mockResolvedValueOnce(
      buildOpenAIResponse(buildLLMContentFromCandidates(nonGlossary)),
    );

    const result = await scoreAnchorCandidates({
      pdfSha256: 'sha-glossary',
      candidates,
    });

    expect(result.whitelist.length).toBe(30);
    // CRDT should be present (auto-survives via glossary boost).
    expect(result.whitelist.find((e) => e.term === 'CRDT')).toBeDefined();
    // ng-29 (lowest freq) should have been displaced.
    expect(result.whitelist.find((e) => e.term === 'ng-29')).toBeUndefined();
  });

  it('enforces 30-entry cap when LLM returns 100 candidates', async () => {
    const candidates = makeNCandidates(100, 200);
    createMock.mockResolvedValueOnce(
      buildOpenAIResponse(buildLLMContentFromCandidates(candidates)),
    );

    const result = await scoreAnchorCandidates({
      pdfSha256: 'sha-cap',
      candidates,
    });

    expect(result.candidateCount).toBe(100);
    expect(result.whitelist.length).toBe(30);
  });

  it('breaks frequency ties by category priority (contrast-pair > search-term)', async () => {
    // Two candidates at the same frequency. LLM assigns different categories.
    const candidates = [
      makeCandidate({ term: 'fault vs failure', frequency: 5 }),
      makeCandidate({ term: 'eventual consistency', frequency: 5 }),
    ];
    const content = JSON.stringify({
      anchors: [
        { term: 'fault vs failure', category: 'contrast-pair', keep: true },
        { term: 'eventual consistency', category: 'search-term', keep: true },
      ],
    });
    createMock.mockResolvedValueOnce(buildOpenAIResponse(content));

    const result = await scoreAnchorCandidates({
      pdfSha256: 'sha-tiebreak',
      candidates,
    });

    expect(result.whitelist.length).toBe(2);
    // contrast-pair wins the priority tie-break.
    expect(result.whitelist[0]?.term).toBe('fault vs failure');
    expect(result.whitelist[0]?.category).toBe('contrast-pair');
    expect(result.whitelist[1]?.category).toBe('search-term');
  });

  it('recovers on parse-retry when first call returns malformed JSON and second succeeds', async () => {
    const candidates = [makeCandidate({ term: 'good-term', frequency: 5 })];
    const validContent = buildLLMContentFromCandidates(candidates);

    createMock.mockResolvedValueOnce(buildOpenAIResponse('not JSON {'));
    createMock.mockResolvedValueOnce(buildOpenAIResponse(validContent));

    const result = await scoreAnchorCandidates({
      pdfSha256: 'sha-retry',
      candidates,
    });

    expect(createMock).toHaveBeenCalledTimes(2);
    expect(result.whitelist.length).toBe(1);
    expect(result.whitelist[0]?.term).toBe('good-term');
  });

  it('throws AnchorScorerParseError when JSON is valid but shape is wrong', async () => {
    const candidates = [makeCandidate({ term: 'x', frequency: 1 })];
    createMock.mockResolvedValue(
      buildOpenAIResponse(JSON.stringify({ unrelated: 'object' })),
    );

    await expect(
      scoreAnchorCandidates({
        pdfSha256: 'sha-wrong-shape',
        candidates,
      }),
    ).rejects.toBeInstanceOf(AnchorScorerParseError);
  });

  it('computes cost correctly from usage tokens', async () => {
    const candidates = [makeCandidate({ term: 'x', frequency: 1 })];
    createMock.mockResolvedValueOnce(
      buildOpenAIResponse(buildLLMContentFromCandidates(candidates), 1500, 600),
    );

    const result = await scoreAnchorCandidates({
      pdfSha256: 'sha-cost',
      candidates,
    });

    // gpt-4o-mini pricing: input 0.15/1M, output 0.60/1M
    //   1500 prompt × 0.15/1M + 600 completion × 0.60/1M
    //     = 0.000225 + 0.00036 = 0.000585
    expect(result.extractionCostUsd).toBeCloseTo(0.000585, 6);
    expect(result.promptTokens).toBe(1500);
    expect(result.completionTokens).toBe(600);
  });

  it('passes the verbatim system prompt + correct model + temperature=0', async () => {
    const candidates = [makeCandidate({ term: 'x', frequency: 1 })];
    createMock.mockResolvedValueOnce(
      buildOpenAIResponse(buildLLMContentFromCandidates(candidates)),
    );

    await scoreAnchorCandidates({
      pdfSha256: 'sha-prompt-check',
      candidates,
    });

    expect(createMock).toHaveBeenCalledTimes(1);
    const firstCall = createMock.mock.calls[0];
    expect(firstCall).toBeDefined();
    const callArgs = firstCall![0] as {
      model: string;
      temperature: number;
      max_tokens: number;
      messages: Array<{ role: string; content: string }>;
      response_format: { type: string };
    };
    expect(callArgs.model).toBe('gpt-4o-mini');
    expect(callArgs.temperature).toBe(0);
    expect(callArgs.max_tokens).toBe(__TEST_ONLY.MAX_COMPLETION_TOKENS);
    expect(callArgs.messages[0]?.role).toBe('system');
    // Verbatim match — drift in the constant is a test failure.
    expect(callArgs.messages[0]?.content).toBe(__TEST_ONLY.SYSTEM_PROMPT);
    expect(callArgs.messages[1]?.role).toBe('user');
    expect(callArgs.messages[1]?.content).toContain('Candidates (filter to keep load-bearing technical anchors only):');
    expect(callArgs.messages[1]?.content.trim().endsWith('Output the filtered whitelist as strict JSON now.')).toBe(true);
    // Strict-mode JSON schema is wired up.
    expect(callArgs.response_format.type).toBe('json_schema');
  });

  it('preserves verbatim candidate casing even if LLM echoes lowercase', async () => {
    const candidates = [
      makeCandidate({ term: 'Chaos Monkey', frequency: 5 }),
    ];
    // LLM echoes back lowercase — we should still use the candidate's casing.
    const content = JSON.stringify({
      anchors: [{ term: 'chaos monkey', category: 'named-system', keep: true }],
    });
    createMock.mockResolvedValueOnce(buildOpenAIResponse(content));

    const result = await scoreAnchorCandidates({
      pdfSha256: 'sha-casing',
      candidates,
    });

    expect(result.whitelist.length).toBe(1);
    // Authoritative casing from candidate, not LLM echo.
    expect(result.whitelist[0]?.term).toBe('Chaos Monkey');
  });

  it('de-duplicates if LLM returns the same term twice', async () => {
    const candidates = [makeCandidate({ term: 'unique', frequency: 5 })];
    const content = JSON.stringify({
      anchors: [
        { term: 'unique', category: 'search-term', keep: true },
        { term: 'unique', category: 'named-system', keep: true },
      ],
    });
    createMock.mockResolvedValueOnce(buildOpenAIResponse(content));

    const result = await scoreAnchorCandidates({
      pdfSha256: 'sha-dup',
      candidates,
    });

    expect(result.whitelist.length).toBe(1);
    // First-wins de-dup → search-term.
    expect(result.whitelist[0]?.category).toBe('search-term');
  });
});
