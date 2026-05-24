// src/lib/openai/__tests__/fidelity-check.test.ts
//
// Tests for the narrative-vs-source fidelity scorer (Wave 3C extension —
// anchor-aware variant; Feature B' Component 5).
//
// The scorer has two modes:
//   1. Pre-Wave-3 (anchorWhitelist absent / empty / no chunk-relevant
//      hits) — system prompt + response schema must be byte-for-byte
//      identical to the legacy path. The new result fields are null.
//   2. Anchor-aware (anchorWhitelist passes with at least one anchor that
//      actually appears in the chunk's source) — the system prompt gains
//      a WHITELIST ANCHORS instruction block, the user prompt lists the
//      chunk-relevant anchors, the response schema requires two new
//      integer fields, and the result populates whitelistAnchorsPreserved
//      + whitelistAnchorsMissing from the LLM response.
//
// The OpenAI client is mocked at module level so no network call ever
// happens; we assert on the args the scorer would have sent.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SourceParagraph } from '@/lib/types';
import type { AnchorWhitelistEntry } from '../anchor-validator';

// ───────────────────────────────────────────────────────────────────────────
// Mock the OpenAI client BEFORE importing the module under test.
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

// Imports AFTER vi.mock.
import { scoreFidelity, FidelityCheckError } from '../fidelity-check';

// ───────────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────────

function mkParagraph(text: string, page = 1, idx = 0): SourceParagraph {
  return { page, paragraphIdx: idx, text };
}

function mkAnchor(
  term: string,
  category: AnchorWhitelistEntry['category'] = 'search-term',
): AnchorWhitelistEntry {
  return {
    term,
    category,
    frequency_in_source: 1,
    first_seen_at: '2026-05-24T00:00:00.000Z',
  };
}

/**
 * Standard base shape that the LLM-side scorer is required to return,
 * regardless of anchor-aware mode. Tests can spread + override specific
 * fields as needed.
 */
function baseLlmJson(
  overrides: Partial<{
    specific_numbers_preserved: number;
    named_examples_preserved: number;
    terminological_contrasts_preserved: number;
    specific_numbers_missing: number;
    named_examples_missing: number;
    terminological_contrasts_missing: number;
    overall_score: number;
    notes: string[];
    whitelist_anchors_preserved: number;
    whitelist_anchors_missing: number;
  }> = {},
): string {
  return JSON.stringify({
    specific_numbers_preserved: 3,
    named_examples_preserved: 2,
    terminological_contrasts_preserved: 1,
    specific_numbers_missing: 0,
    named_examples_missing: 1,
    terminological_contrasts_missing: 0,
    overall_score: 87,
    notes: ['kept most anchors', 'dropped one example'],
    ...overrides,
  });
}

/**
 * Build the minimal OpenAI completion response shape that the scorer's
 * code path consumes. Just the `content` and `usage` fields matter.
 */
function mockCompletion(
  contentJson: string,
  promptTokens = 1000,
  completionTokens = 100,
) {
  return {
    choices: [{ message: { content: contentJson } }],
    usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens },
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Pre-Wave-3 path (no anchorWhitelist) — prompt + schema unchanged
// ───────────────────────────────────────────────────────────────────────────

describe('scoreFidelity — pre-Wave-3 path (no anchorWhitelist supplied)', () => {
  beforeEach(() => {
    createMock.mockReset();
  });

  it('produces existing result shape with whitelist fields null when called without anchorWhitelist', async () => {
    createMock.mockResolvedValueOnce(mockCompletion(baseLlmJson()));

    const result = await scoreFidelity({
      chapterTitle: 'Chapter 1',
      narrative: '# Lesson 1: Faults\nThe Knight Capital outage shows...',
      sourceParagraphs: [mkParagraph('Knight Capital outage in 2012.')],
    });

    // Existing fields populate normally.
    expect(result.specificNumbersPreserved).toBe(3);
    expect(result.namedExamplesPreserved).toBe(2);
    expect(result.terminologicalContrastsPreserved).toBe(1);
    expect(result.specificNumbersMissing).toBe(0);
    expect(result.namedExamplesMissing).toBe(1);
    expect(result.terminologicalContrastsMissing).toBe(0);
    expect(result.overallScore).toBe(87);
    expect(result.notes).toEqual(['kept most anchors', 'dropped one example']);
    expect(result.model).toBe('gpt-4o-mini');
    expect(result.promptTokens).toBe(1000);
    expect(result.completionTokens).toBe(100);
    expect(result.costUsd).toBeGreaterThan(0);

    // New Wave-3 fields are explicitly null in legacy mode.
    expect(result.whitelistAnchorsPreserved).toBeNull();
    expect(result.whitelistAnchorsMissing).toBeNull();
  });

  it('sends a system prompt that does NOT contain the WHITELIST ANCHORS section', async () => {
    createMock.mockResolvedValueOnce(mockCompletion(baseLlmJson()));

    await scoreFidelity({
      chapterTitle: 'Chapter 1',
      narrative: 'n',
      sourceParagraphs: [mkParagraph('source text')],
    });

    expect(createMock).toHaveBeenCalledTimes(1);
    const callArgs = createMock.mock.calls[0]![0] as {
      messages: Array<{ role: string; content: string }>;
      response_format: { json_schema: { name: string; schema: { required: string[] } } };
    };
    const systemMsg = callArgs.messages[0]?.content ?? '';
    const userMsg = callArgs.messages[1]?.content ?? '';

    // Pre-Wave-3 prompt: no WHITELIST ANCHORS injection in either message.
    expect(systemMsg).not.toContain('WHITELIST ANCHORS');
    expect(userMsg).not.toContain('WHITELIST ANCHORS');

    // Schema name is the legacy one and does NOT require the new fields.
    expect(callArgs.response_format.json_schema.name).toBe('fidelity_score');
    expect(callArgs.response_format.json_schema.schema.required).not.toContain(
      'whitelist_anchors_preserved',
    );
    expect(callArgs.response_format.json_schema.schema.required).not.toContain(
      'whitelist_anchors_missing',
    );
  });

  it('treats anchorWhitelist=[] as the no-whitelist case (null new fields, no prompt injection)', async () => {
    createMock.mockResolvedValueOnce(mockCompletion(baseLlmJson()));

    const result = await scoreFidelity({
      chapterTitle: 'Chapter 1',
      narrative: 'n',
      sourceParagraphs: [mkParagraph('source text')],
      anchorWhitelist: [],
    });

    expect(result.whitelistAnchorsPreserved).toBeNull();
    expect(result.whitelistAnchorsMissing).toBeNull();

    const callArgs = createMock.mock.calls[0]![0] as {
      messages: Array<{ role: string; content: string }>;
      response_format: { json_schema: { name: string } };
    };
    expect(callArgs.messages[0]?.content).not.toContain('WHITELIST ANCHORS');
    expect(callArgs.response_format.json_schema.name).toBe('fidelity_score');
  });

  it('treats a whitelist with no chunk-relevant anchors as the no-whitelist case', async () => {
    createMock.mockResolvedValueOnce(mockCompletion(baseLlmJson()));

    // Five anchors but NONE appear in this chunk's source.
    const whitelist = [
      mkAnchor('Chaos Monkey'),
      mkAnchor('coordinated omission'),
      mkAnchor('t-digest'),
      mkAnchor('Brewer'),
      mkAnchor('Postgres'),
    ];
    const result = await scoreFidelity({
      chapterTitle: 'Chapter 1',
      narrative: 'A short narrative about disks.',
      sourceParagraphs: [mkParagraph('Disks fail at 1% per year.')],
      anchorWhitelist: whitelist,
    });

    expect(result.whitelistAnchorsPreserved).toBeNull();
    expect(result.whitelistAnchorsMissing).toBeNull();

    const callArgs = createMock.mock.calls[0]![0] as {
      messages: Array<{ role: string; content: string }>;
      response_format: { json_schema: { name: string } };
    };
    // The source contains none of the anchors → collapse to pre-Wave-3 path.
    expect(callArgs.messages[1]?.content).not.toContain('WHITELIST ANCHORS');
    expect(callArgs.response_format.json_schema.name).toBe('fidelity_score');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Anchor-aware path — prompt injection, schema swap, result population
// ───────────────────────────────────────────────────────────────────────────

describe('scoreFidelity — anchor-aware path (anchorWhitelist with chunk-relevant hits)', () => {
  beforeEach(() => {
    createMock.mockReset();
  });

  it('injects the WHITELIST ANCHORS section into both system + user messages', async () => {
    createMock.mockResolvedValueOnce(
      mockCompletion(
        baseLlmJson({ whitelist_anchors_preserved: 2, whitelist_anchors_missing: 1 }),
      ),
    );

    const whitelist = [
      mkAnchor('Chaos Monkey', 'named-system'),
      mkAnchor('coordinated omission', 'search-term'),
      mkAnchor('t-digest', 'search-term'),
    ];
    await scoreFidelity({
      chapterTitle: 'Chapter 1',
      narrative: 'The narrative discusses Chaos Monkey and coordinated omission.',
      sourceParagraphs: [
        mkParagraph(
          'Netflix uses Chaos Monkey to randomly kill nodes. Their team also worried about coordinated omission and used t-digest for percentile reporting.',
        ),
      ],
      anchorWhitelist: whitelist,
    });

    expect(createMock).toHaveBeenCalledTimes(1);
    const callArgs = createMock.mock.calls[0]![0] as {
      messages: Array<{ role: string; content: string }>;
    };
    const systemMsg = callArgs.messages[0]?.content ?? '';
    const userMsg = callArgs.messages[1]?.content ?? '';

    // System prompt: WHITELIST ANCHORS instruction block must be appended.
    expect(systemMsg).toContain('WHITELIST ANCHORS');
    expect(systemMsg).toContain('whitelist_anchors_preserved');
    expect(systemMsg).toContain('whitelist_anchors_missing');

    // User prompt: chunk-relevant anchor list must be present with each term.
    expect(userMsg).toContain("WHITELIST ANCHORS PRESENT IN THIS CHUNK'S SOURCE");
    for (const a of whitelist) {
      expect(userMsg).toContain(`"${a.term}"`);
      expect(userMsg).toContain(`(${a.category})`);
    }
  });

  it('swaps the response schema to the anchor-aware variant that REQUIRES the two new fields', async () => {
    createMock.mockResolvedValueOnce(
      mockCompletion(
        baseLlmJson({ whitelist_anchors_preserved: 1, whitelist_anchors_missing: 0 }),
      ),
    );

    await scoreFidelity({
      chapterTitle: 'Chapter 1',
      narrative: 'Discusses t-digest.',
      sourceParagraphs: [mkParagraph('t-digest is used for percentiles.')],
      anchorWhitelist: [mkAnchor('t-digest')],
    });

    const callArgs = createMock.mock.calls[0]![0] as {
      response_format: {
        json_schema: {
          name: string;
          strict: boolean;
          schema: {
            required: string[];
            properties: Record<string, unknown>;
          };
        };
      };
    };
    const rf = callArgs.response_format.json_schema;
    expect(rf.name).toBe('fidelity_score_with_anchors');
    expect(rf.strict).toBe(true);
    expect(rf.schema.required).toContain('whitelist_anchors_preserved');
    expect(rf.schema.required).toContain('whitelist_anchors_missing');
    expect(rf.schema.properties).toHaveProperty('whitelist_anchors_preserved');
    expect(rf.schema.properties).toHaveProperty('whitelist_anchors_missing');
  });

  it('populates whitelistAnchorsPreserved + whitelistAnchorsMissing from the LLM response', async () => {
    createMock.mockResolvedValueOnce(
      mockCompletion(
        baseLlmJson({ whitelist_anchors_preserved: 4, whitelist_anchors_missing: 2 }),
      ),
    );

    const whitelist = [
      mkAnchor('Chaos Monkey'),
      mkAnchor('coordinated omission'),
    ];
    const result = await scoreFidelity({
      chapterTitle: 'Chapter 1',
      narrative: 'Mentions Chaos Monkey and coordinated omission.',
      sourceParagraphs: [
        mkParagraph('Chaos Monkey and coordinated omission both apply here.'),
      ],
      anchorWhitelist: whitelist,
    });

    expect(result.whitelistAnchorsPreserved).toBe(4);
    expect(result.whitelistAnchorsMissing).toBe(2);
    // Existing fields still populated.
    expect(result.overallScore).toBe(87);
    expect(result.specificNumbersPreserved).toBe(3);
  });

  it('only includes chunk-relevant anchors in the user-prompt list (filters out absent terms)', async () => {
    createMock.mockResolvedValueOnce(
      mockCompletion(
        baseLlmJson({ whitelist_anchors_preserved: 1, whitelist_anchors_missing: 0 }),
      ),
    );

    // Whitelist has 3 terms; only "t-digest" actually appears in source.
    const whitelist = [
      mkAnchor('t-digest'),
      mkAnchor('Chaos Monkey'),
      mkAnchor('Brewer'),
    ];
    await scoreFidelity({
      chapterTitle: 'Chapter 1',
      narrative: 'Uses t-digest for percentiles.',
      sourceParagraphs: [mkParagraph('t-digest is great for percentile reporting.')],
      anchorWhitelist: whitelist,
    });

    const callArgs = createMock.mock.calls[0]![0] as {
      messages: Array<{ role: string; content: string }>;
    };
    const userMsg = callArgs.messages[1]?.content ?? '';
    expect(userMsg).toContain('"t-digest"');
    // Absent anchors must NOT leak into the anchor list section.
    expect(userMsg).not.toContain('"Chaos Monkey"');
    expect(userMsg).not.toContain('"Brewer"');
  });

  it('throws FidelityCheckError when the LLM response is missing the required whitelist fields in anchor-aware mode', async () => {
    // Mock returns a response WITHOUT the two new fields. Because the
    // shape check requires them in anchor-aware mode, this must throw.
    // The shared retry wrapper will retry on parse errors, so mock the
    // SAME bad payload for the maximum retry attempts.
    const badJson = JSON.stringify({
      specific_numbers_preserved: 1,
      named_examples_preserved: 1,
      terminological_contrasts_preserved: 1,
      specific_numbers_missing: 0,
      named_examples_missing: 0,
      terminological_contrasts_missing: 0,
      overall_score: 80,
      notes: ['no whitelist fields'],
      // whitelist_anchors_preserved / missing deliberately omitted.
    });
    // Saturate retries with the same bad payload so withRetry surfaces it.
    for (let i = 0; i < 10; i++) {
      createMock.mockResolvedValueOnce(mockCompletion(badJson));
    }

    await expect(
      scoreFidelity({
        chapterTitle: 'Chapter 1',
        narrative: 'n',
        sourceParagraphs: [mkParagraph('t-digest is great.')],
        anchorWhitelist: [mkAnchor('t-digest')],
      }),
    ).rejects.toBeInstanceOf(FidelityCheckError);
  });
});
