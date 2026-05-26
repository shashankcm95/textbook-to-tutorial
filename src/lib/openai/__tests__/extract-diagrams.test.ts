// src/lib/openai/__tests__/extract-diagrams.test.ts — Sprint H Wave 1 (A).
//
// Pure unit tests for extractDiagrams(). The OpenAI client is mocked at
// module load (vi.mock is hoisted). The mock returns a non-streamed
// completion object whose `choices[0].message.content` is the JSON string
// the model "would have produced" — extractDiagrams parses, runs every entry
// through Builder B's fromWire(), and counts drops vs valid payloads.
//
// Coverage:
//   - Success: one valid wire entry → 1 diagram, 0 drops, costUsd > 0.
//   - Mixed: 1 valid + 2 shape-invalid → 1 diagram, 2 drops.
//   - Empty: { diagrams: [] } → 0 diagrams, 0 drops, no throw.
//   - Parse-error: non-JSON content → throws ExtractParseError after one
//     parse-retry attempt (withRetry retries parse errors once).
//   - Refusal: choices[0].message.refusal set → throws (non-retryable;
//     called exactly once).
//   - No-choices: response.choices = [] → throws ExtractParseError.
//   - Bad shape: parsed has no `diagrams` array → throws ExtractParseError.

import { describe, it, expect, vi, beforeEach } from 'vitest';

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
import { extractDiagrams, ExtractParseError } from '../extract-diagrams';
import { EXTRACT_SYSTEM_PROMPT } from '@/lib/prompts/extract-diagrams';
import { WIRE_SCHEMA } from '@/lib/diagrams/wire-schema';

// ───────────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────────

/**
 * Build a fake non-streamed chat-completion response whose `content` is the
 * given JSON string and whose usage block reports plausible token counts.
 */
function makeResponse(
  contentJson: string,
  opts: {
    promptTokens?: number;
    completionTokens?: number;
    refusal?: string;
    noChoices?: boolean;
  } = {},
) {
  const promptTokens = opts.promptTokens ?? 800;
  const completionTokens = opts.completionTokens ?? 150;
  if (opts.noChoices) {
    return {
      choices: [],
      usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens },
    };
  }
  const message: { content: string; refusal?: string } = { content: contentJson };
  if (opts.refusal !== undefined) message.refusal = opts.refusal;
  return {
    choices: [{ message }],
    usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens },
  };
}

/** Minimal, Zod-valid ComparisonTable in wire shape. */
function validComparisonTableWire() {
  return {
    kind: 'ComparisonTable',
    title: 'Replication topologies',
    columns: ['Topology', 'Writes'],
    rows: [
      {
        cells: [
          { column: 'Topology', value: 'Single-leader' },
          { column: 'Writes', value: 'SPOF' },
        ],
      },
      {
        cells: [
          { column: 'Topology', value: 'Multi-leader' },
          { column: 'Writes', value: 'High' },
        ],
      },
    ],
  };
}

/** A wire entry with an unknown kind — fromWire returns null. */
function bogusKindWire() {
  return { kind: 'NotARealKind', title: '' };
}

/** A wire entry where a cell column is not in the columns array — fromWire
 *  returns null (Builder B's translator catches this). */
function badCellsWire() {
  return {
    kind: 'ComparisonTable',
    title: '',
    columns: ['A', 'B'],
    rows: [
      {
        cells: [
          { column: 'A', value: '1' },
          { column: 'NOT_IN_COLUMNS', value: '2' },
        ],
      },
    ],
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Tests
// ───────────────────────────────────────────────────────────────────────────

describe('extractDiagrams — success path', () => {
  beforeEach(() => {
    createMock.mockReset();
  });

  it('returns one DiagramPayload when the model emits one valid wire entry', async () => {
    createMock.mockResolvedValueOnce(
      makeResponse(JSON.stringify({ diagrams: [validComparisonTableWire()] })),
    );

    const result = await extractDiagrams({ narrative: '## Lesson 1\nbody.' });

    expect(result.diagrams).toHaveLength(1);
    expect(result.diagrams[0]?.kind).toBe('ComparisonTable');
    expect(result.droppedCount).toBe(0);
    expect(result.costUsd).toBeGreaterThan(0);
    // 4o-mini at 800 prompt + 150 completion tokens ≈ $0.0002 — well under
    // the "anything > $0.01 is wrong" sanity ceiling.
    expect(result.costUsd).toBeLessThan(0.001);
    expect(result.model).toBe('gpt-4o-mini');
    expect(result.promptTokens).toBe(800);
    expect(result.completionTokens).toBe(150);
  });

  it('calls openai.chat.completions.create with strict-mode response_format', async () => {
    createMock.mockResolvedValueOnce(
      makeResponse(JSON.stringify({ diagrams: [] })),
    );

    await extractDiagrams({ narrative: 'narrative body' });

    expect(createMock).toHaveBeenCalledTimes(1);
    const callArgs = createMock.mock.calls[0]![0] as {
      model: string;
      stream?: boolean;
      messages: Array<{ role: string; content: string }>;
      response_format: {
        type: string;
        json_schema: { name: string; strict: boolean; schema: unknown };
      };
    };
    expect(callArgs.model).toBe('gpt-4o-mini');
    expect(callArgs.stream).toBe(false);
    expect(callArgs.messages[0]?.role).toBe('system');
    expect(callArgs.messages[0]?.content).toBe(EXTRACT_SYSTEM_PROMPT);
    expect(callArgs.messages[1]?.role).toBe('user');
    expect(callArgs.messages[1]?.content).toBe('narrative body');
    expect(callArgs.response_format.type).toBe('json_schema');
    expect(callArgs.response_format.json_schema.name).toBe('extracted_diagrams');
    expect(callArgs.response_format.json_schema.strict).toBe(true);
    expect(callArgs.response_format.json_schema.schema).toBe(WIRE_SCHEMA);
  });
});

describe('extractDiagrams — mixed-validity path', () => {
  beforeEach(() => {
    createMock.mockReset();
  });

  it('drops shape-invalid entries and counts them', async () => {
    createMock.mockResolvedValueOnce(
      makeResponse(
        JSON.stringify({
          diagrams: [
            validComparisonTableWire(),
            bogusKindWire(),
            badCellsWire(),
          ],
        }),
      ),
    );

    const result = await extractDiagrams({ narrative: 'body' });

    expect(result.diagrams).toHaveLength(1);
    expect(result.diagrams[0]?.kind).toBe('ComparisonTable');
    expect(result.droppedCount).toBe(2);
  });
});

describe('extractDiagrams — empty path', () => {
  beforeEach(() => {
    createMock.mockReset();
  });

  it('returns no diagrams and no drops when the model emits an empty array', async () => {
    createMock.mockResolvedValueOnce(
      makeResponse(JSON.stringify({ diagrams: [] })),
    );

    const result = await extractDiagrams({ narrative: 'prose only.' });

    expect(result.diagrams).toEqual([]);
    expect(result.droppedCount).toBe(0);
    expect(result.costUsd).toBeGreaterThan(0);
  });

  it('handles empty narrative without throwing', async () => {
    createMock.mockResolvedValueOnce(
      makeResponse(JSON.stringify({ diagrams: [] })),
    );

    const result = await extractDiagrams({ narrative: '' });

    expect(result.diagrams).toEqual([]);
    expect(result.droppedCount).toBe(0);
  });
});

describe('extractDiagrams — parse-error path', () => {
  beforeEach(() => {
    createMock.mockReset();
  });

  it('throws ExtractParseError when the content is not JSON (after exhausting parse-retries)', async () => {
    // withRetry's parse-error slot is 0ms with Math.min(attempt, 0) — it
    // matches on every attempt, so parse-failures keep retrying until the
    // overall maxAttempts() ceiling (1 initial + 3+2+1 budget = 7 total).
    // Mock every call to bad JSON so it exhausts and bubbles.
    createMock.mockResolvedValue(makeResponse('definitely not json {{{'));

    await expect(extractDiagrams({ narrative: 'body' })).rejects.toBeInstanceOf(
      ExtractParseError,
    );
    // Sanity check on the retry budget — should be the shared maxAttempts().
    expect(createMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(createMock.mock.calls.length).toBeLessThanOrEqual(7);
  });

  it('throws ExtractParseError when parsed object lacks a diagrams array', async () => {
    createMock.mockResolvedValue(
      makeResponse(JSON.stringify({ wrong_root: [] })),
    );

    await expect(extractDiagrams({ narrative: 'body' })).rejects.toBeInstanceOf(
      ExtractParseError,
    );
  });

  it('throws ExtractParseError when response has no choices', async () => {
    createMock.mockResolvedValue(makeResponse('', { noChoices: true }));

    await expect(extractDiagrams({ narrative: 'body' })).rejects.toBeInstanceOf(
      ExtractParseError,
    );
  });

  it('retries parse-error once then succeeds on attempt 2', async () => {
    createMock
      .mockResolvedValueOnce(makeResponse('garbage'))
      .mockResolvedValueOnce(
        makeResponse(JSON.stringify({ diagrams: [validComparisonTableWire()] })),
      );

    const result = await extractDiagrams({ narrative: 'body' });

    expect(result.diagrams).toHaveLength(1);
    expect(createMock).toHaveBeenCalledTimes(2);
  });
});

describe('extractDiagrams — refusal path', () => {
  beforeEach(() => {
    createMock.mockReset();
  });

  it('throws (non-retryable) when the model returns a refusal string', async () => {
    // The mock returns a refusal on EVERY call; if extractDiagrams treated
    // refusal as retryable, createMock would fire multiple times. Asserting
    // call count == 1 proves non-retryability.
    createMock.mockResolvedValue(
      makeResponse('', { refusal: 'I cannot help with that.' }),
    );

    await expect(extractDiagrams({ narrative: 'body' })).rejects.toThrow(
      /model refused/,
    );
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  it('does NOT throw refusal when refusal field is empty string', async () => {
    // Defensive: an empty `refusal: ''` should be treated as "no refusal";
    // we still need the content to parse though, so provide valid content.
    createMock.mockResolvedValueOnce(
      makeResponse(JSON.stringify({ diagrams: [] }), { refusal: '' }),
    );

    const result = await extractDiagrams({ narrative: 'body' });
    expect(result.diagrams).toEqual([]);
  });
});
