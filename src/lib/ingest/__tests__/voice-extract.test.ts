// src/lib/ingest/__tests__/voice-extract.test.ts
//
// Unit tests for the voice-profile extractor (Feature B').
//
// T3.5 — sampler v1 → v2 (weighted-rhetorical-v1) refresh:
//   - weighParagraph (pure, deterministic) gets explicit per-rule tests.
//   - weightedSample (Algorithm A-Res; statistical) gets a high-weight-bias
//     distribution test over many trials, and a Math.random-mocked
//     deterministic-ordering test.
//   - sampleParagraphs no longer makes claims about specific indices
//     (sampling is randomized); we assert structural invariants instead
//     (size, source-order, no duplicates, deterministic under mocked rng).
//   - sampler_version literal updated to 'weighted-rhetorical-v1' (canary).
//
// Coverage:
//   - sampleParagraphs: exact-10, <10, >10 (weighted), 0-empty, source-order
//   - weighParagraph: each rule in isolation + combined
//   - weightedSample: empty/<=k passthrough, weight-biased distribution
//   - buildVoiceUserPrompt: ref shape + count marker
//   - extractVoiceProfile: happy path with mocked OpenAI (cost computed,
//     all fields populated, schema_version + sampler_version stamped)
//   - VoiceProfileParseError: malformed JSON triggers it; withRetry-driven
//     retry semantics observed
//   - Model + prompt invariants asserted via __TEST_ONLY (no string drift)

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
  extractVoiceProfile,
  sampleParagraphs,
  buildVoiceUserPrompt,
  weighParagraph,
  weightedSample,
  VoiceProfileParseError,
  __TEST_ONLY,
  type VoiceProfile,
} from '../voice-extract';

// ───────────────────────────────────────────────────────────────────────────
// Test fixtures
// ───────────────────────────────────────────────────────────────────────────

function makeParagraph(page: number, paragraphIdx: number, text: string): SourceParagraph {
  return { page, paragraphIdx, text };
}

/** Build N paragraphs with deterministic page/paragraphIdx for sample-tracking. */
function makeNParagraphs(n: number): SourceParagraph[] {
  return Array.from({ length: n }, (_, i) =>
    makeParagraph(Math.floor(i / 3) + 1, i % 3, `para-${i}-content`),
  );
}

/** A valid LLM-response JSON string matching the strict schema. */
const VALID_LLM_RESPONSE = JSON.stringify({
  tone_summary: 'Dry, pragmatic, allergic to hype; explains via concrete incidents.',
  signature_moves: [
    { name: 'Question opener', description: 'Opens chapters with a question or pushback.' },
    { name: 'Benefit-then-qualify', description: 'Sets up benefits then immediately qualifies.' },
    { name: 'Named incidents', description: 'Names canonical incidents (leap-second, Knight Capital).' },
  ],
  example_phrases: [
    { phrase: 'as it turns out, this is harder than it looks', ref: 'page1:paragraph0' },
    { phrase: 'the literature glosses over this', ref: 'page2:paragraph1' },
    { phrase: 'in practice, almost no one does this', ref: 'page3:paragraph2' },
    { phrase: 'a beautifully clean theorem with no operational legs', ref: 'page4:paragraph0' },
    { phrase: 'consider the case where the clock goes backwards', ref: 'page5:paragraph1' },
  ],
  humor_patterns: [
    'Dry asides about industry hype, usually one clause long.',
    'Self-deprecating callbacks to earlier oversimplifications.',
  ],
  preferred_analogies: [
    'Reaches for postal/messaging analogies (envelopes, post offices, letters).',
    'Occasional clock + calendar metaphors.',
  ],
});

function buildOpenAIResponseFromContent(content: string, promptTokens = 1200, completionTokens = 400): {
  choices: Array<{ message: { content: string } }>;
  usage: { prompt_tokens: number; completion_tokens: number };
} {
  return {
    choices: [{ message: { content } }],
    usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens },
  };
}

// ───────────────────────────────────────────────────────────────────────────
// sampleParagraphs — weighted reservoir sampling (T3.5)
//
// Specific-index assertions are intentionally absent: v2 is randomized. We
// pin the structural invariants (count, source-order, no duplicates, dedup
// passthrough on small inputs) and rely on the dedicated weighParagraph +
// weightedSample tests below for the algorithm-level guarantees.
// ───────────────────────────────────────────────────────────────────────────

describe('sampleParagraphs', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns empty array when no paragraphs', () => {
    expect(sampleParagraphs([])).toEqual([]);
  });

  it('returns all paragraphs when fewer than SAMPLE_SIZE (10)', () => {
    const five = makeNParagraphs(5);
    const out = sampleParagraphs(five);
    expect(out).toEqual(five);
    expect(out.length).toBe(5);
  });

  it('returns exactly 10 when input is exactly 10 (passthrough branch)', () => {
    const ten = makeNParagraphs(10);
    const out = sampleParagraphs(ten);
    expect(out).toEqual(ten);
    expect(out.length).toBe(10);
  });

  it('returns exactly SAMPLE_SIZE (10) when input is much larger', () => {
    const hundred = makeNParagraphs(100);
    const out = sampleParagraphs(hundred);
    expect(out.length).toBe(10);
  });

  it('returns paragraphs in source order (page, then paragraphIdx)', () => {
    const fifty = makeNParagraphs(50);
    const out = sampleParagraphs(fifty);
    for (let i = 1; i < out.length; i++) {
      const prev = out[i - 1]!;
      const cur = out[i]!;
      const prevKey = prev.page * 1000 + prev.paragraphIdx;
      const curKey = cur.page * 1000 + cur.paragraphIdx;
      expect(curKey).toBeGreaterThan(prevKey);
    }
  });

  it('does not duplicate any input paragraph in the sample', () => {
    const fifty = makeNParagraphs(50);
    const out = sampleParagraphs(fifty);
    const seen = new Set(out.map((p) => `${p.page}:${p.paragraphIdx}`));
    expect(seen.size).toBe(out.length);
  });

  it('preserves page + paragraphIdx for ref reconstruction', () => {
    const twenty = makeNParagraphs(20);
    const out = sampleParagraphs(twenty);
    for (const p of out) {
      expect(typeof p.page).toBe('number');
      expect(typeof p.paragraphIdx).toBe('number');
    }
  });

  it('is deterministic when Math.random is mocked (regression canary for rng surface)', () => {
    // Pin Math.random to a constant so two consecutive runs produce the
    // same draw. This protects against future refactors that swap in a
    // private rng without honoring Math.random.
    const fifty = makeNParagraphs(50);
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const a = sampleParagraphs(fifty);
    const b = sampleParagraphs(fifty);
    expect(a.map((p) => `${p.page}:${p.paragraphIdx}`)).toEqual(
      b.map((p) => `${p.page}:${p.paragraphIdx}`),
    );
  });
});

// ───────────────────────────────────────────────────────────────────────────
// weighParagraph — pure, deterministic weight function (T3.5)
// ───────────────────────────────────────────────────────────────────────────

describe('weighParagraph', () => {
  it('returns 1.0 (baseline) for a plain mid-page paragraph with no markers', () => {
    // paragraphIdx >= 3 escapes the chapter-opening boost; long with period
    // escapes epigraph; no rhetorical markers in the text.
    const p = makeParagraph(5, 4, 'This sentence is plain and contains zero special markers.');
    expect(weighParagraph(p)).toBe(1.0);
  });

  it('applies the chapter-opening boost (3×) for paragraphIdx <= 2', () => {
    for (const idx of [0, 1, 2]) {
      const p = makeParagraph(
        2,
        idx,
        // Plain text, no markers — long enough to escape epigraph rule.
        'A reasonably long sentence that ends with a period so the epigraph rule does not fire here at all today.',
      );
      // paragraphIdx === 0 also fires epigraph? No — text ends with period.
      expect(weighParagraph(p)).toBe(__TEST_ONLY.WEIGHT_CHAPTER_OPENING);
    }
  });

  it('applies the rhetorical-marker boost (2×) for "but" / "however" / em-dash / forward-pointer', () => {
    const cases: Array<[string, string]> = [
      ['but', 'It seemed simple, but it never is.'],
      ['however', 'There is a caveat, however, worth naming.'],
      ['yet', 'We have not solved it yet in any deployment.'],
      ['em-dash', 'It works fine — until the leap second arrives unannounced.'],
      ['en-dash', 'Range 1990–2020 was the easy era for clock drift.'],
      ['forward-pointer (we will)', 'We will return to this in section four.'],
      ['forward-pointer (next chapter)', 'In the next chapter we wire up the consensus protocol.'],
    ];
    for (const [, text] of cases) {
      const p = makeParagraph(5, 5, text); // mid-page → no chapter-opening
      expect(weighParagraph(p)).toBe(__TEST_ONLY.WEIGHT_RHETORICAL_MARKER);
    }
  });

  it('applies the epigraph boost (1.5×) for short, top-of-page, no-terminal-period paragraphs', () => {
    // <40 words, paragraphIdx 0, no terminal period. Avoid em-dash / en-dash
    // and any rhetorical-marker word so we isolate the epigraph boost (and
    // the unavoidable chapter-opening boost at idx 0).
    const epigraph = makeParagraph(3, 0, '"Time is what keeps everything from happening at once"');
    // paragraphIdx 0 also fires chapter-opening (idx <= 2) so weight is
    // chapter-opening × epigraph.
    const expected = __TEST_ONLY.WEIGHT_CHAPTER_OPENING * __TEST_ONLY.WEIGHT_EPIGRAPH;
    expect(weighParagraph(epigraph)).toBe(expected);
  });

  it('combines all three rules multiplicatively (max 3 × 2 × 1.5 = 9)', () => {
    const allThree = makeParagraph(
      4,
      0,
      // idx 0 (chapter-opening + epigraph candidate), contains em-dash
      // (rhetorical), short, no terminal period.
      'It is — at best — partial',
    );
    const expected =
      __TEST_ONLY.WEIGHT_CHAPTER_OPENING *
      __TEST_ONLY.WEIGHT_RHETORICAL_MARKER *
      __TEST_ONLY.WEIGHT_EPIGRAPH;
    expect(weighParagraph(allThree)).toBe(expected);
  });

  it('does not fire epigraph for a long paragraph at paragraphIdx 0', () => {
    const longOpener = makeParagraph(
      1,
      0,
      Array.from({ length: 60 }, (_, i) => `word${i}`).join(' '),
    );
    // chapter-opening fires; epigraph does NOT (>= 40 words).
    expect(weighParagraph(longOpener)).toBe(__TEST_ONLY.WEIGHT_CHAPTER_OPENING);
  });

  // ─────────────────────────────────────────────────────────────────────
  // Sprint D Phase 3 — chapter-firsts plumbing (preference + fallback)
  //
  // T3.5 (PR #24) used `paragraphIdx <= 2` (page-top) as a proxy for
  // chapter-firsts because no chapter-boundary metadata existed on
  // SourceParagraph. Sprint D Phase 3 adds `chapterParagraphIdx` (0-based
  // ordinal within the chapter, populated by the ingest worker) and updates
  // weighParagraph to PREFER that field when present and FALL BACK to the
  // page-top proxy when absent.
  //
  // These tests pin the preference + fallback semantics so a future
  // refactor of weighParagraph can't silently regress to either:
  //   (a) the page-top-only behavior (loses the architectural fix), or
  //   (b) the chapter-only behavior (breaks backward compat with
  //       already-ingested tutorials whose source_paragraphs_json lacks
  //       the new field).
  // ─────────────────────────────────────────────────────────────────────

  it('Sprint D Phase 3: prefers chapterParagraphIdx <= 2 (true chapter-first) for the boost', () => {
    // chapterParagraphIdx 0 → boost fires regardless of page-local
    // paragraphIdx. Use paragraphIdx 10 (NOT page-top) to prove the new
    // field is the actual signal driving the boost.
    const trueChapterFirst: SourceParagraph = {
      page: 7,
      paragraphIdx: 10, // not page-top — the page-top proxy WOULD NOT fire here
      text: 'A plain sentence that ends with a period and contains no markers at all today.',
      chapterParagraphIdx: 0, // true chapter-first
    };
    expect(weighParagraph(trueChapterFirst)).toBe(__TEST_ONLY.WEIGHT_CHAPTER_OPENING);
  });

  it('Sprint D Phase 3: does NOT boost when chapterParagraphIdx > 2 even at page-top', () => {
    // chapterParagraphIdx 3 → NOT a chapter-first. paragraphIdx 0 (page-top)
    // is the kind of paragraph the OLD proxy would have boosted; the new
    // preference rule correctly skips it because the TRUE signal says
    // "mid-chapter, just happens to land at page-top".
    const midChapterAtPageTop: SourceParagraph = {
      page: 7,
      paragraphIdx: 0, // page-top — the OLD page-top proxy WOULD HAVE fired here
      text: 'A plain sentence that ends with a period and contains no markers at all today.',
      chapterParagraphIdx: 3, // truly mid-chapter
    };
    // No boost: weight is exactly the 1.0× baseline. Confirms the new
    // field WINS over the page-top heuristic when both are present.
    expect(weighParagraph(midChapterAtPageTop)).toBe(1.0);
  });

  it('Sprint D Phase 3 fallback: page-top proxy still fires when chapterParagraphIdx is absent', () => {
    // Pre-Phase-3 paragraph: no `chapterParagraphIdx` (undefined).
    // paragraphIdx 1 → page-top fallback fires (≤ 2). This is the backward
    // compatibility path: an already-ingested tutorial whose
    // source_paragraphs_json was written before the new field existed
    // continues to get the chapter-opening boost via the proxy.
    const legacyPageTop: SourceParagraph = {
      page: 4,
      paragraphIdx: 1, // page-top → proxy fires
      text: 'A plain sentence that ends with a period and contains no markers at all today.',
      // chapterParagraphIdx: intentionally undefined (legacy shape)
    };
    expect(weighParagraph(legacyPageTop)).toBe(__TEST_ONLY.WEIGHT_CHAPTER_OPENING);
  });

  it('Sprint D Phase 3 fallback: no boost when chapterParagraphIdx is absent AND not page-top', () => {
    // Pre-Phase-3 paragraph, mid-page. Neither the new field nor the
    // proxy fires → baseline 1.0 weight. Distinguishes the fallback from
    // an unconditional boost.
    const legacyMidPage: SourceParagraph = {
      page: 4,
      paragraphIdx: 10, // not page-top, not chapter-first via proxy
      text: 'A plain sentence that ends with a period and contains no markers at all today.',
      // chapterParagraphIdx: intentionally undefined (legacy shape)
    };
    expect(weighParagraph(legacyMidPage)).toBe(1.0);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// weightedSample — Algorithm A-Res (T3.5)
// ───────────────────────────────────────────────────────────────────────────

describe('weightedSample', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns [] for empty input', () => {
    expect(weightedSample([], 5)).toEqual([]);
  });

  it('returns [] when k <= 0', () => {
    expect(weightedSample([{ item: 'a', weight: 1 }], 0)).toEqual([]);
  });

  it('returns all items unchanged when items.length <= k', () => {
    const items = [
      { item: 'a', weight: 1 },
      { item: 'b', weight: 5 },
      { item: 'c', weight: 0.1 },
    ];
    expect(weightedSample(items, 10)).toEqual(['a', 'b', 'c']);
  });

  it('biases selection toward higher-weight items across many trials', () => {
    // Items: one high-weight target ("hot") at 100×; rest baseline 1×.
    // Pick k=1 per trial. Over 1000 trials, "hot" should win the lion's
    // share. With weight 100 vs ten 1's (total 110), expected ~91% hits.
    const trials = 1000;
    const items = [
      { item: 'hot', weight: 100 },
      ...Array.from({ length: 10 }, (_, i) => ({ item: `cold-${i}`, weight: 1 })),
    ];
    let hotHits = 0;
    for (let i = 0; i < trials; i++) {
      const drawn = weightedSample(items, 1);
      if (drawn[0] === 'hot') hotHits++;
    }
    // Generous lower bound: well above the baseline ~9% (1/11) a uniform
    // sampler would produce, leaving room for natural variance.
    expect(hotHits).toBeGreaterThan(700);
  });

  it('is deterministic when Math.random is mocked to a fixed value', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const items = [
      { item: 'a', weight: 1 },
      { item: 'b', weight: 4 },
      { item: 'c', weight: 9 },
      { item: 'd', weight: 16 },
    ];
    const a = weightedSample(items, 2);
    const b = weightedSample(items, 2);
    expect(a).toEqual(b);
    // With identical U=0.5 across all items, ordering is purely by weight:
    // larger weight → smaller exponent (1/w) → larger 0.5^(1/w) → ranked first.
    // Expect top 2 by weight: 'd' then 'c'.
    expect(new Set(a)).toEqual(new Set(['c', 'd']));
  });

  it('does not duplicate items in the sample', () => {
    const items = Array.from({ length: 20 }, (_, i) => ({
      item: `i-${i}`,
      weight: 1 + i,
    }));
    const drawn = weightedSample(items, 5);
    expect(new Set(drawn).size).toBe(drawn.length);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// SAMPLER_VERSION regression canary (T3.5)
// ───────────────────────────────────────────────────────────────────────────

describe('SAMPLER_VERSION', () => {
  it('is "weighted-rhetorical-v1" (T3.5 bump from uniform-body-v1)', () => {
    // Load-bearing for downstream S3 cache invalidation; any drift here
    // means the cache will silently keep returning v1-sampled profiles.
    expect(__TEST_ONLY.SAMPLER_VERSION).toBe('weighted-rhetorical-v1');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// buildVoiceUserPrompt — prompt formatting
// ───────────────────────────────────────────────────────────────────────────

describe('buildVoiceUserPrompt', () => {
  it('renders each paragraph as [pageN:paragraphM] <text>', () => {
    const samples: SourceParagraph[] = [
      makeParagraph(1, 0, 'first text'),
      makeParagraph(8, 5, 'second text'),
    ];
    const prompt = buildVoiceUserPrompt(samples);
    expect(prompt).toContain('[page1:paragraph0] first text');
    expect(prompt).toContain('[page8:paragraph5] second text');
  });

  it('uses the actual sample count in the "(N total)" marker', () => {
    const seven = makeNParagraphs(7);
    const prompt = buildVoiceUserPrompt(seven);
    expect(prompt).toContain('(7 total)');
  });

  it('ends with the "Output strict JSON now." instruction', () => {
    const samples = makeNParagraphs(3);
    const prompt = buildVoiceUserPrompt(samples);
    expect(prompt.trim().endsWith('Output strict JSON now.')).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// extractVoiceProfile — integration with mocked OpenAI
// ───────────────────────────────────────────────────────────────────────────

describe('extractVoiceProfile', () => {
  beforeEach(() => {
    createMock.mockReset();
  });

  it('returns a fully-populated VoiceProfile on a happy-path call', async () => {
    createMock.mockResolvedValueOnce(buildOpenAIResponseFromContent(VALID_LLM_RESPONSE));

    const paragraphs = makeNParagraphs(50);
    const profile: VoiceProfile = await extractVoiceProfile({
      pdfSha256: 'sha-abc-123',
      bodyParagraphs: paragraphs,
    });

    // Stamped fields
    expect(profile.schema_version).toBe(1);
    expect(profile.model).toBe('gpt-4o-mini');
    expect(profile.sampler_version).toBe('weighted-rhetorical-v1');
    expect(profile.sample_size).toBe(10); // 50 > SAMPLE_SIZE → 10 sampled
    expect(typeof profile.extracted_at).toBe('string');
    // ISO timestamp shape
    expect(profile.extracted_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // Cost computed from the (mocked) usage block. gpt-4o-mini pricing:
    // 1200 prompt × 0.15/1M + 400 completion × 0.60/1M
    //   = 0.00018 + 0.00024 = 0.00042
    expect(profile.extraction_cost_usd).toBeCloseTo(0.00042, 6);

    // LLM-sourced fields
    expect(profile.tone_summary).toContain('pragmatic');
    expect(profile.signature_moves.length).toBe(3);
    expect(profile.signature_moves[0]?.name).toBe('Question opener');
    expect(profile.example_phrases.length).toBe(5);
    expect(profile.example_phrases[0]?.ref).toBe('page1:paragraph0');
    expect(profile.humor_patterns.length).toBe(2);
    expect(profile.preferred_analogies.length).toBe(2);
  });

  it('passes the verbatim system prompt + correct model + temperature=0', async () => {
    createMock.mockResolvedValueOnce(buildOpenAIResponseFromContent(VALID_LLM_RESPONSE));

    await extractVoiceProfile({
      pdfSha256: 'sha-xyz',
      bodyParagraphs: makeNParagraphs(20),
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
    expect(callArgs.messages[1]?.content).toContain('SAMPLE PARAGRAPHS:');
    expect(callArgs.messages[1]?.content).toContain('Output strict JSON now.');
    // Strict-mode JSON schema is wired up.
    expect(callArgs.response_format.type).toBe('json_schema');
  });

  it('reflects sample_size when input has fewer than 10 paragraphs', async () => {
    createMock.mockResolvedValueOnce(buildOpenAIResponseFromContent(VALID_LLM_RESPONSE));

    const profile = await extractVoiceProfile({
      pdfSha256: 'sha-small',
      bodyParagraphs: makeNParagraphs(4),
    });
    expect(profile.sample_size).toBe(4);
  });

  it('throws VoiceProfileParseError after exhausting the retry budget on malformed JSON', async () => {
    // withRetry's parseError schedule is `[0]` (one slot). Per `_retry.ts`
    // `computeRetryDelay`, `Math.min(attempt, parseError.length - 1) === 0`
    // for every attempt, so parse errors are eligible for retry up to
    // `maxAttempts() = 1 + 3 + 2 + 1 = 7` total attempts (1 initial + 3
    // rateLimit slots + 2 serverError slots + 1 parseError slot, all
    // budget arms walkable via the shared `attempt` counter).
    //
    // Wave-1 review HIGH H-1 fix: pin the assertion to the actual upper
    // bound (7), not `> 1`. Pinning catches regressions in either
    // direction (e.g., a future tightening to a real 1-parse-retry policy
    // would silently pass `> 1` but fail this exact `=== 7` assertion).
    createMock.mockResolvedValue(buildOpenAIResponseFromContent('this is not JSON {'));

    await expect(
      extractVoiceProfile({
        pdfSha256: 'sha-bad-json',
        bodyParagraphs: makeNParagraphs(15),
      }),
    ).rejects.toBeInstanceOf(VoiceProfileParseError);

    // maxAttempts() = 7 per _retry.ts; every attempt re-enters parseError
    // budget [0] via the shared-attempt-counter semantic.
    expect(createMock.mock.calls.length).toBe(7);
  });

  it('throws on empty bodyParagraphs (Wave-1 review HIGH H-2)', async () => {
    // Empty bodyParagraphs previously slipped through and called the LLM
    // with zero context, producing a hallucinated profile. Now surfaces
    // loudly as a caller error.
    await expect(
      extractVoiceProfile({
        pdfSha256: 'sha-empty-body',
        bodyParagraphs: [],
      }),
    ).rejects.toThrow(/bodyParagraphs is empty/);

    // The LLM must NOT have been called at all for this path.
    expect(createMock).not.toHaveBeenCalled();
  });

  it('throws VoiceProfileParseError when JSON is valid but the shape is wrong', async () => {
    const wrongShape = JSON.stringify({ unrelated: 'object' });
    createMock.mockResolvedValue(buildOpenAIResponseFromContent(wrongShape));

    await expect(
      extractVoiceProfile({
        pdfSha256: 'sha-wrong-shape',
        bodyParagraphs: makeNParagraphs(15),
      }),
    ).rejects.toBeInstanceOf(VoiceProfileParseError);
  });

  it('recovers on parse-retry when first attempt returns malformed JSON and second succeeds', async () => {
    // First attempt: bad JSON → triggers VoiceProfileParseError → withRetry
    //   schedules a parse-retry (0ms delay).
    // Second attempt: good JSON → success.
    createMock.mockResolvedValueOnce(buildOpenAIResponseFromContent('not JSON'));
    createMock.mockResolvedValueOnce(buildOpenAIResponseFromContent(VALID_LLM_RESPONSE));

    const profile = await extractVoiceProfile({
      pdfSha256: 'sha-retry',
      bodyParagraphs: makeNParagraphs(15),
    });

    expect(createMock).toHaveBeenCalledTimes(2);
    expect(profile.tone_summary).toContain('pragmatic');
  });
});
