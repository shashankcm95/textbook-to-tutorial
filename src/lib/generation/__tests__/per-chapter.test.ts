/**
 * src/lib/generation/__tests__/per-chapter.test.ts
 *
 * Smoke test for Feature B' Wave 3 — per-chapter.ts integration:
 *
 *   1. When S3 returns null for BOTH voice + anchor artifacts (legacy
 *      tutorial path), the integration falls back cleanly: generateNarrativeOnly
 *      is called WITHOUT voice/anchor args; no chapter_anchor_violations
 *      row is inserted.
 *
 *   2. When both artifacts ARE available AND the narrative DROPS some
 *      whitelist anchors, a chapter_anchor_violations row is inserted with
 *      the expected fields (missing terms, score, policy=log-and-continue,
 *      regen_triggered=0).
 *
 *   3. When both artifacts ARE available AND the narrative preserves ALL
 *      anchors, NO violations row is inserted (absence-of-row = success).
 *
 * Scope: this is integration-wiring verification. Pre-existing 4o/4o-mini
 * call orchestration is exercised by sibling unit tests (narrative-only,
 * quiz-from-narrative, fidelity-check, anchor-validator). What's NEW in
 * Wave 3 — the S3 loader, the validateAnchors call site, and the
 * violations INSERT — is what we verify here.
 *
 * Strategy: full vi.mock of every transitive dependency (OpenAI client,
 * S3 helpers, drizzle DB calls). We never touch the network or filesystem.
 * The test inspects the mock-arg history to assert the correct wiring.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SourceParagraph } from '@/lib/types';
import type { VoiceProfile } from '@/lib/ingest/voice-extract';
import type { AnchorWhitelistEntry } from '@/lib/openai/anchor-validator';

// ───────────────────────────────────────────────────────────────────────────
// Module-level mocks — hoisted by vitest BEFORE the SUT import.
// ───────────────────────────────────────────────────────────────────────────

// Capture the in-memory state the SUT touches. Reset in beforeEach.
type MockChapterRow = {
  id: string;
  tutorialId: string;
  ordinal: number;
  title: string;
  status: string;
  classification: 'body' | 'appendix';
  sourceParagraphsJson: string;
  chunkS3Key: string | null;
  narrative: string | null;
};

type MockTutorialRow = {
  id: string;
  sourceS3Url: string;
  sourcePdfSha256: string | null;
};

let chapterRow: MockChapterRow;
let tutorialRow: MockTutorialRow;
const anchorViolationInserts: Array<Record<string, unknown>> = [];
const fidelityInserts: Array<Record<string, unknown>> = [];
// Sprint H Wave 1 (Builder D) — capture every tx.insert call so tests can
// assert how many parses_cost rows landed and what their model/values were.
// Each entry is { tableMarker, row }; we discriminate by which schema
// import the SUT passed to tx.insert (better-sqlite3 doesn't expose a
// stable name; we inspect the row shape instead).
const txInserts: Array<{ table: 'parses_cost' | 'questions' | 'flashcards' | 'unknown'; row: Record<string, unknown> }> = [];
// Sprint H Wave 1: capture the chapters.narrative value persisted in the
// final transaction so tests can assert "the WOVEN narrative reaches DB".
const chapterUpdates: Array<Record<string, unknown>> = [];
const claimRunMock = vi.fn(() => ({ changes: 1 }));

// Minimal Drizzle stubs. Each builder method returns `this` so the SUT's
// `.from(...).where(...).limit(1)` chain compiles + executes. The terminal
// `.then` or call-as-promise resolves to the rows we want.
function makeSelectChain(rows: unknown[]) {
  const chain = {
    from: vi.fn(() => chain),
    where: vi.fn(() => chain),
    limit: vi.fn(() => Promise.resolve(rows)),
  };
  return chain;
}

const updateChain = {
  set: vi.fn(() => updateChain),
  where: vi.fn(() => updateChain),
  run: vi.fn(),
};

const insertChain = {
  values: vi.fn(() => insertChain),
  run: vi.fn(),
};

// Counter for db.select() — first call returns chapter, second returns tutorial.
// Reset in beforeEach.
let dbSelectCallIdx = 0;

vi.mock('@/db/client', () => {
  const db = {
    select: vi.fn(() => {
      const idx = dbSelectCallIdx++;
      if (idx === 0) return makeSelectChain([chapterRow]);
      return makeSelectChain([tutorialRow]);
    }),
    update: vi.fn(() => updateChain),
    insert: vi.fn((table: { _name?: string }) => {
      // Distinguish chapter_anchor_violations inserts from fidelity inserts
      // by inspecting the values passed.
      const captureChain = {
        values: vi.fn((row: Record<string, unknown>) => {
          // chapter_anchor_violations rows have `policyApplied`; fidelity has
          // `overallScore`. Discriminate on these.
          if ('policyApplied' in row) {
            anchorViolationInserts.push(row);
          } else if ('overallScore' in row) {
            fidelityInserts.push(row);
          }
          return captureChain;
        }),
        run: vi.fn(),
      };
      return captureChain;
    }),
    transaction: vi.fn((fn: (tx: unknown) => void) => {
      // Sprint H Wave 1 (Builder D): capture writes inside the transaction
      // so tests can assert that the WOVEN narrative reached chapters.narrative
      // AND that a third parses_cost row landed for the extract call.
      // Discrimination by row-shape: parses_cost rows always have
      // `costUsd`+`promptTokens`; questions have `prompt`+`optionsJson`;
      // flashcards have `front`+`back`.
      const txUpdateChain = {
        set: vi.fn((row: Record<string, unknown>) => {
          chapterUpdates.push(row);
          return txUpdateChain;
        }),
        where: vi.fn(() => txUpdateChain),
        run: vi.fn(),
      };
      function txInsertChain(table: 'parses_cost' | 'questions' | 'flashcards' | 'unknown') {
        const chain = {
          values: vi.fn((row: Record<string, unknown>) => {
            txInserts.push({ table, row });
            return chain;
          }),
          run: vi.fn(),
        };
        return chain;
      }
      const tx = {
        update: vi.fn(() => txUpdateChain),
        insert: vi.fn((maybeTable: unknown) => {
          // Cheap discriminator — we don't know the table object identity,
          // so we let values() do the row-shape discrimination instead.
          // Pre-allocate a chain; the first values() call decides the table.
          let tableForChain: 'parses_cost' | 'questions' | 'flashcards' | 'unknown' = 'unknown';
          const chain = {
            values: vi.fn((row: Record<string, unknown>) => {
              if ('promptTokens' in row && 'costUsd' in row && 'validationDropCount' in row) {
                tableForChain = 'parses_cost';
                txInserts.push({ table: tableForChain, row });
              } else if ('prompt' in row && 'optionsJson' in row) {
                tableForChain = 'questions';
                txInserts.push({ table: tableForChain, row });
              } else if ('front' in row && 'back' in row) {
                tableForChain = 'flashcards';
                txInserts.push({ table: tableForChain, row });
              } else if ('overallScore' in row) {
                // chapter_fidelity_scores — track in the pre-existing
                // fidelityInserts bucket so legacy assertions keep working.
                fidelityInserts.push(row);
              } else {
                txInserts.push({ table: 'unknown', row });
              }
              return chain;
            }),
            run: vi.fn(),
          };
          // Silence unused-var warning while keeping the maybeTable arg for parity with Drizzle.
          void maybeTable;
          void txInsertChain;
          return chain;
        }),
      };
      fn(tx);
    }),
  };
  const rawDb = {
    prepare: vi.fn(() => ({
      run: claimRunMock,
    })),
  };
  return { db, rawDb, schema: {} };
});

// Source paragraph helper.
function makeSourceParagraph(page: number, idx: number, text: string): SourceParagraph {
  return { page, paragraphIdx: idx, text };
}

// Capture generateNarrativeOnly args so we can assert voice/anchor wiring.
const generateNarrativeOnlyMock = vi.fn();
vi.mock('@/lib/openai/narrative-only', () => ({
  generateNarrativeOnly: (args: unknown) => generateNarrativeOnlyMock(args),
}));

const generateQuizFromNarrativeMock = vi.fn();
vi.mock('@/lib/openai/quiz-from-narrative', () => ({
  generateQuizFromNarrative: (args: unknown) => generateQuizFromNarrativeMock(args),
}));

const scoreFidelityMock = vi.fn();
vi.mock('@/lib/openai/fidelity-check', () => ({
  scoreFidelity: (args: unknown) => scoreFidelityMock(args),
}));

// S3 helpers — Wave 3A provides readVoiceProfile / readAnchorWhitelist.
// Sprint J adds readGlossary. Default mock REJECTS to mirror the
// production cache-miss path (readGlossary throws on S3 404); the
// per-chapter loader's Promise.allSettled boundary fail-opens to null,
// keeping pre-Sprint-J tests behaviorally unchanged. Tests that want to
// drive the glossary-injected path mockResolvedValue with a
// GlossaryArtifact.
const readVoiceProfileMock = vi.fn();
const readAnchorWhitelistMock = vi.fn();
const readGlossaryMock = vi.fn((..._args: unknown[]) =>
  Promise.reject(new Error('cache miss')),
);
vi.mock('@/lib/s3-chunks', () => ({
  readChunk: vi.fn(),
  resolveChunksBucket: vi.fn(() => 'test-bucket'),
  readVoiceProfile: (args: unknown) => readVoiceProfileMock(args),
  readAnchorWhitelist: (args: unknown) => readAnchorWhitelistMock(args),
  readGlossary: (...args: unknown[]) => readGlossaryMock(...args),
}));

// Sprint H Wave 1 (Builder D) — mock the diagram extractor + weaver so the
// SUT's transitive imports don't pull in `@/lib/openai/client` (which would
// trigger env validation at module load).
const extractDiagramsMock = vi.fn();
vi.mock('@/lib/openai/extract-diagrams', () => ({
  extractDiagrams: (args: unknown) => extractDiagramsMock(args),
}));

const weaveDiagramsMock = vi.fn();
vi.mock('@/lib/diagrams/weave', () => ({
  weaveDiagrams: (narrative: string, diagrams: unknown[]) =>
    weaveDiagramsMock(narrative, diagrams),
}));

// Mock cost-cap so we can drive the "cost-cap rejects extract" test path
// AND avoid the SUM-query default behavior. Default implementation: no-op
// (pass the budget); per-test mockRejectedValue for the rejection path.
const assertCostBudgetMock = vi.fn();
vi.mock('@/lib/openai/cost-cap', () => ({
  assertCostBudget: (...args: unknown[]) => assertCostBudgetMock(...args),
  CostCapExceeded: class CostCapExceeded extends Error {
    readonly name = 'CostCapExceeded';
  },
}));

// Mock estimateCost so we don't have to construct a real tokenizer / pricing
// path in the test. Returns a tiny stub; per-chapter only uses
// `estimatedCostUsd` to pass into assertCostBudget (which is itself mocked).
vi.mock('@/lib/openai/cost', () => ({
  estimateCost: vi.fn(() => ({
    model: 'gpt-4o-mini',
    estimatedPromptTokens: 100,
    estimatedCompletionTokens: 2048,
    estimatedCostUsd: 0.001,
  })),
}));

// Mock the extract prompt so the cost-estimate call in per-chapter.ts
// doesn't transitively bring in any heavier prompt-builder modules.
vi.mock('@/lib/prompts/extract-diagrams', () => ({
  EXTRACT_SYSTEM_PROMPT: 'mocked system prompt',
}));

// Imports AFTER mocks.
import { generateChapter } from '../per-chapter';

// ───────────────────────────────────────────────────────────────────────────
// Fixtures
// ───────────────────────────────────────────────────────────────────────────

const SOURCE_PARAGRAPHS: SourceParagraph[] = [
  makeSourceParagraph(
    1,
    0,
    'Chaos Monkey kills nodes at random; the leap-second bug crashed many systems in 2012.',
  ),
  makeSourceParagraph(2, 0, 'RAID arrays protect against single-disk failures.'),
];

const WHITELIST: AnchorWhitelistEntry[] = [
  {
    term: 'Chaos Monkey',
    category: 'named-system',
    frequency_in_source: 3,
    first_seen_at: '2026-05-24T00:00:00.000Z',
  },
  {
    term: 'leap-second bug',
    category: 'named-incident',
    frequency_in_source: 2,
    first_seen_at: '2026-05-24T00:00:00.000Z',
  },
  {
    term: 'RAID',
    category: 'search-term',
    frequency_in_source: 1,
    first_seen_at: '2026-05-24T00:00:00.000Z',
  },
];

const VOICE_PROFILE: VoiceProfile = {
  schema_version: 1,
  extracted_at: '2026-05-24T00:00:00.000Z',
  model: 'gpt-4o-mini',
  extraction_cost_usd: 0.0003,
  sample_size: 10,
  sampler_version: 'weighted-rhetorical-v1',
  tone_summary: 'dry pragmatic register',
  signature_moves: [],
  example_phrases: [],
  humor_patterns: [],
  preferred_analogies: [],
};

// ───────────────────────────────────────────────────────────────────────────
// beforeEach — reset everything to a clean baseline.
// ───────────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  anchorViolationInserts.length = 0;
  fidelityInserts.length = 0;
  txInserts.length = 0;
  chapterUpdates.length = 0;
  dbSelectCallIdx = 0;

  // Default Sprint H Wave 1 mocks: extract returns zero diagrams, weave is
  // an identity (no diagrams = no fences = pass-through). Cost-cap passes.
  extractDiagramsMock.mockResolvedValue({
    diagrams: [],
    droppedCount: 0,
    promptTokens: 50,
    completionTokens: 0,
    costUsd: 0.0001,
    model: 'gpt-4o-mini',
  });
  weaveDiagramsMock.mockImplementation((narrative: string) => narrative);
  assertCostBudgetMock.mockResolvedValue(undefined);

  chapterRow = {
    id: 'chapter-1',
    tutorialId: 'tutorial-1',
    ordinal: 0,
    title: 'Introduction',
    status: 'pending',
    classification: 'body',
    sourceParagraphsJson: JSON.stringify(SOURCE_PARAGRAPHS),
    chunkS3Key: 'parsed/abc/chapters/00.json',
    narrative: null,
  };
  tutorialRow = {
    id: 'tutorial-1',
    sourceS3Url: 's3://test-bucket/source.pdf',
    sourcePdfSha256: 'a'.repeat(64),
  };
  claimRunMock.mockReturnValue({ changes: 1 });

  generateNarrativeOnlyMock.mockResolvedValue({
    narrative: 'Some narrative output.',
    promptTokens: 100,
    completionTokens: 200,
    costUsd: 0.001,
    model: 'gpt-4o',
  });
  generateQuizFromNarrativeMock.mockResolvedValue({
    questions: [],
    flashcards: [],
    validationDropCount: 0,
    promptTokens: 50,
    completionTokens: 100,
    costUsd: 0.0005,
    model: 'gpt-4o-mini',
  });
  scoreFidelityMock.mockResolvedValue({
    specificNumbersPreserved: 0,
    namedExamplesPreserved: 0,
    terminologicalContrastsPreserved: 0,
    specificNumbersMissing: 0,
    namedExamplesMissing: 0,
    terminologicalContrastsMissing: 0,
    overallScore: 100,
    notes: [],
    promptTokens: 10,
    completionTokens: 20,
    costUsd: 0.0001,
    model: 'gpt-4o-mini',
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Tests
// ───────────────────────────────────────────────────────────────────────────

describe('per-chapter — Feature B Wave 3 integration', () => {
  it('legacy tutorial (no S3 artifacts) → generator called WITHOUT voice/anchor; no violations row', async () => {
    readVoiceProfileMock.mockResolvedValue(null);
    readAnchorWhitelistMock.mockResolvedValue(null);

    await generateChapter({ tutorialId: 'tutorial-1', chapterIdx: 0 });

    expect(generateNarrativeOnlyMock).toHaveBeenCalledTimes(1);
    const narrativeArgs = generateNarrativeOnlyMock.mock.calls[0][0];
    expect(narrativeArgs.voiceProfile).toBeUndefined();
    expect(narrativeArgs.anchorWhitelist).toBeUndefined();

    expect(anchorViolationInserts).toHaveLength(0);
  });

  it('artifacts present + dropped anchors → violations row inserted with missing terms + score', async () => {
    readVoiceProfileMock.mockResolvedValue(VOICE_PROFILE);
    readAnchorWhitelistMock.mockResolvedValue(WHITELIST);
    // Narrative omits "leap-second bug" and "RAID" — only "Chaos Monkey" preserved.
    generateNarrativeOnlyMock.mockResolvedValue({
      narrative: 'We deploy Chaos Monkey to kill random instances.',
      promptTokens: 100,
      completionTokens: 200,
      costUsd: 0.001,
      model: 'gpt-4o',
    });

    await generateChapter({ tutorialId: 'tutorial-1', chapterIdx: 0 });

    // Generator received both artifacts.
    const narrativeArgs = generateNarrativeOnlyMock.mock.calls[0][0];
    expect(narrativeArgs.voiceProfile).toBe(VOICE_PROFILE);
    expect(narrativeArgs.anchorWhitelist).toBe(WHITELIST);

    // Exactly one violation row, with the right shape.
    expect(anchorViolationInserts).toHaveLength(1);
    const row = anchorViolationInserts[0];
    expect(row.chapterId).toBe('chapter-1');
    expect(row.expectedCount).toBe(3);
    expect(row.foundCount).toBe(1);
    expect(row.policyApplied).toBe('log-and-continue');
    expect(row.regenTriggered).toBe(0);
    expect(typeof row.score).toBe('number');
    expect(row.score).toBeCloseTo(1 / 3, 5);
    const missing = JSON.parse(row.missingAnchorsJson as string);
    expect(missing).toEqual(expect.arrayContaining(['leap-second bug', 'RAID']));
    expect(missing).not.toContain('Chaos Monkey');
  });

  it('artifacts present + all anchors preserved → NO violations row', async () => {
    readVoiceProfileMock.mockResolvedValue(VOICE_PROFILE);
    readAnchorWhitelistMock.mockResolvedValue(WHITELIST);
    // Narrative mentions all three whitelist anchors verbatim.
    generateNarrativeOnlyMock.mockResolvedValue({
      narrative:
        'Chaos Monkey trips processes; the leap-second bug shows time is hard; RAID arrays mitigate disk loss.',
      promptTokens: 100,
      completionTokens: 200,
      costUsd: 0.001,
      model: 'gpt-4o',
    });

    await generateChapter({ tutorialId: 'tutorial-1', chapterIdx: 0 });

    expect(anchorViolationInserts).toHaveLength(0);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Sprint H Wave 1 (Builder D) — extract + weave integration tests.
//
// What we verify:
//   1. Happy path — extractDiagrams returns valid + dropped, weave runs, the
//      WOVEN narrative reaches chapters.narrative, a third parses_cost row
//      lands with the extract call's tokens/cost, the onDiagramsExtracted
//      callback fires with {count, droppedCount, costUsd}.
//   2. Empty-diagrams path — extract returns zero diagrams, weave is NOT
//      called (no-op), the original narrative is persisted, the callback
//      still fires with count=0, droppedCount=0, costUsd>0.
//   3. Fail-open — extractDiagrams throws, chapter still completes, the
//      ORIGINAL narrative is persisted, the callback is NOT invoked, no
//      exception bubbles, NO third parses_cost row appears.
//   4. Cost-cap rejection — assertCostBudget throws, extractDiagrams is
//      NEVER called, chapter completes with original narrative, callback
//      NOT invoked, NO third parses_cost row.
//   5. parses_cost row presence on happy path — second 4o-mini row landed
//      with the extract call's exact token/cost values.
//
// Strategy: extend the existing mock layer with extractDiagramsMock + the
// per-call weave / cost-cap implementations declared above. Tests inspect
// the captured `txInserts` + `chapterUpdates` to assert persistence shape.
// ───────────────────────────────────────────────────────────────────────────

describe('per-chapter — Sprint H Wave 1 (extract + weave integration)', () => {
  beforeEach(() => {
    // Pre-Sprint-H tests don't depend on S3 artifacts; null both so the
    // anchor validator path is a no-op and we focus on extract behavior.
    readVoiceProfileMock.mockResolvedValue(null);
    readAnchorWhitelistMock.mockResolvedValue(null);
  });

  it('happy path: 2 diagrams + 1 dropped → woven narrative persisted, third parses_cost row, callback fires', async () => {
    // Extractor returns 2 valid diagrams + 1 dropped.
    const fakeDiagrams = [
      { kind: 'ComparisonTable', title: 'A vs B', columns: ['A', 'B'], rows: [] } as unknown,
      { kind: 'DefinitionList', items: [] } as unknown,
    ];
    extractDiagramsMock.mockResolvedValue({
      diagrams: fakeDiagrams,
      droppedCount: 1,
      promptTokens: 250,
      completionTokens: 180,
      costUsd: 0.00075,
      model: 'gpt-4o-mini',
    });
    // Weave emits ```diagram fences appended to the input narrative.
    const wovenSentinel =
      'Some narrative output.\n\n```diagram\n{"kind":"ComparisonTable"}\n```\n\n```diagram\n{"kind":"DefinitionList"}\n```\n';
    weaveDiagramsMock.mockReturnValue(wovenSentinel);

    const onDiagramsExtracted = vi.fn();
    const result = await generateChapter({
      tutorialId: 'tutorial-1',
      chapterIdx: 0,
      onDiagramsExtracted,
    });

    // Cost-cap gate ran BEFORE the extract call.
    expect(assertCostBudgetMock).toHaveBeenCalledTimes(1);
    const [capTutorialId, capProjectedCost] = assertCostBudgetMock.mock.calls[0];
    expect(capTutorialId).toBe('tutorial-1');
    expect(typeof capProjectedCost).toBe('number');

    // Extractor was called with the narrative (not the woven version).
    expect(extractDiagramsMock).toHaveBeenCalledTimes(1);
    const extractArgs = extractDiagramsMock.mock.calls[0][0];
    expect(extractArgs.narrative).toBe('Some narrative output.');

    // Weave was called with original narrative + the 2 diagrams (wrapped).
    expect(weaveDiagramsMock).toHaveBeenCalledTimes(1);
    const [weaveNarrative, weaveDiagrams_] = weaveDiagramsMock.mock.calls[0];
    expect(weaveNarrative).toBe('Some narrative output.');
    expect(weaveDiagrams_).toHaveLength(2);
    expect(weaveDiagrams_[0].payload).toBe(fakeDiagrams[0]);
    expect(weaveDiagrams_[1].payload).toBe(fakeDiagrams[1]);

    // Persistence — the WOVEN narrative reached chapters.narrative.
    expect(chapterUpdates).toHaveLength(1);
    expect(chapterUpdates[0]?.narrative).toBe(wovenSentinel);

    // SSE callback fired with the contract payload.
    expect(onDiagramsExtracted).toHaveBeenCalledTimes(1);
    expect(onDiagramsExtracted).toHaveBeenCalledWith({
      count: 2,
      droppedCount: 1,
      costUsd: 0.00075,
    });

    // Third parses_cost row landed for extract (narrative + quiz + extract = 3).
    const parsesCostRows = txInserts.filter((e) => e.table === 'parses_cost');
    expect(parsesCostRows).toHaveLength(3);
    // Find the extract row by its exact cost-usd fingerprint.
    const extractRow = parsesCostRows.find((e) => e.row.costUsd === 0.00075);
    expect(extractRow).toBeTruthy();
    expect(extractRow?.row.model).toBe('gpt-4o-mini');
    expect(extractRow?.row.promptTokens).toBe(250);
    expect(extractRow?.row.completionTokens).toBe(180);
    expect(extractRow?.row.validationDropCount).toBe(0);

    // Result.narrative returns the woven string (callers reading it in-
    // memory see what's persisted).
    expect(result.narrative).toBe(wovenSentinel);
    // totalCostUsd includes the extract spend.
    expect(result.totalCostUsd).toBeGreaterThan(0.001 + 0.0005);
  });

  it('empty diagrams: weave NOT called, original narrative persisted, callback fires with count=0', async () => {
    extractDiagramsMock.mockResolvedValue({
      diagrams: [],
      droppedCount: 0,
      promptTokens: 200,
      completionTokens: 5,
      costUsd: 0.00005,
      model: 'gpt-4o-mini',
    });

    const onDiagramsExtracted = vi.fn();
    await generateChapter({
      tutorialId: 'tutorial-1',
      chapterIdx: 0,
      onDiagramsExtracted,
    });

    // Extract ran but weave was NOT called (no diagrams to splice).
    expect(extractDiagramsMock).toHaveBeenCalledTimes(1);
    expect(weaveDiagramsMock).not.toHaveBeenCalled();

    // Original narrative reached chapters.narrative untouched.
    expect(chapterUpdates).toHaveLength(1);
    expect(chapterUpdates[0]?.narrative).toBe('Some narrative output.');

    // Callback still fires (extract succeeded, just emitted zero diagrams).
    expect(onDiagramsExtracted).toHaveBeenCalledTimes(1);
    expect(onDiagramsExtracted).toHaveBeenCalledWith({
      count: 0,
      droppedCount: 0,
      costUsd: 0.00005,
    });

    // Three parses_cost rows still: narrative + quiz + extract.
    const parsesCostRows = txInserts.filter((e) => e.table === 'parses_cost');
    expect(parsesCostRows).toHaveLength(3);
  });

  it('fail-open: extractDiagrams throws → chapter still completes, original narrative persisted, callback NOT invoked', async () => {
    extractDiagramsMock.mockRejectedValue(
      new Error('extract-diagrams: model refused (safety)'),
    );

    const onDiagramsExtracted = vi.fn();
    const result = await generateChapter({
      tutorialId: 'tutorial-1',
      chapterIdx: 0,
      onDiagramsExtracted,
    });

    // No exception bubbled.
    expect(result.status).toBe('complete');

    // Weave never ran (extract failed before it could).
    expect(weaveDiagramsMock).not.toHaveBeenCalled();

    // Original narrative reached chapters.narrative (fail-open contract).
    expect(chapterUpdates).toHaveLength(1);
    expect(chapterUpdates[0]?.narrative).toBe('Some narrative output.');

    // No callback fired (fail-open path skips the SSE signal).
    expect(onDiagramsExtracted).not.toHaveBeenCalled();

    // Only TWO parses_cost rows — extract failed before it could bill.
    const parsesCostRows = txInserts.filter((e) => e.table === 'parses_cost');
    expect(parsesCostRows).toHaveLength(2);
  });

  it('cost-cap rejection: assertCostBudget throws → extract NEVER called, chapter completes with original narrative', async () => {
    assertCostBudgetMock.mockRejectedValue(
      Object.assign(new Error('Cost cap exceeded for tutorial=tutorial-1'), {
        name: 'CostCapExceeded',
      }),
    );

    const onDiagramsExtracted = vi.fn();
    const result = await generateChapter({
      tutorialId: 'tutorial-1',
      chapterIdx: 0,
      onDiagramsExtracted,
    });

    // Cost-cap was checked.
    expect(assertCostBudgetMock).toHaveBeenCalledTimes(1);
    // Extract NEVER called (gate rejected upstream).
    expect(extractDiagramsMock).not.toHaveBeenCalled();
    // Weave NEVER called.
    expect(weaveDiagramsMock).not.toHaveBeenCalled();
    // Chapter still completed.
    expect(result.status).toBe('complete');
    // Original narrative persisted.
    expect(chapterUpdates).toHaveLength(1);
    expect(chapterUpdates[0]?.narrative).toBe('Some narrative output.');
    // No callback fired.
    expect(onDiagramsExtracted).not.toHaveBeenCalled();
    // Only TWO parses_cost rows.
    const parsesCostRows = txInserts.filter((e) => e.table === 'parses_cost');
    expect(parsesCostRows).toHaveLength(2);
  });

  // Sprint H Wave 3 fix (Rev D HIGH-1) — gate-blocking regression:
  // before this fix, persistNarrativeOnly (called on the quiz-failure path)
  // wrote `narrativeResult.narrative` (raw prose) instead of the wovenNarrative
  // that the extractor + weave had already produced. The user would refresh
  // the chapter, see status='partial', and the diagrams would be silently
  // gone — even though the extract LLM call had succeeded and billed.
  it('quiz-failure path: extract succeeded → woven narrative still persisted + extract cost recorded', async () => {
    const fakeDiagrams = [
      { kind: 'ComparisonTable', title: 'A vs B', columns: ['A', 'B'], rows: [] } as unknown,
    ];
    extractDiagramsMock.mockResolvedValue({
      diagrams: fakeDiagrams,
      droppedCount: 0,
      promptTokens: 200,
      completionTokens: 100,
      costUsd: 0.0006,
      model: 'gpt-4o-mini',
    });
    const wovenSentinel =
      'Some narrative output.\n\n```diagram\n{"kind":"ComparisonTable"}\n```\n';
    weaveDiagramsMock.mockReturnValue(wovenSentinel);

    // Quiz call throws — narrative succeeded but the quiz LLM 500s/refuses.
    generateQuizFromNarrativeMock.mockRejectedValue(
      new Error('quiz-from-narrative: model timeout'),
    );

    const onDiagramsExtracted = vi.fn();
    await expect(
      generateChapter({
        tutorialId: 'tutorial-1',
        chapterIdx: 0,
        onDiagramsExtracted,
      }),
    ).rejects.toThrow(/quiz-from-narrative/);

    // The partial-state update wrote the WOVEN narrative — not the raw.
    expect(chapterUpdates).toHaveLength(1);
    expect(chapterUpdates[0]?.status).toBe('partial');
    expect(chapterUpdates[0]?.narrative).toBe(wovenSentinel);

    // parses_cost rows: narrative + extract (2 total — no quiz row since it
    // never completed). Both must be present so we don't underreport spend.
    const parsesCostRows = txInserts.filter((e) => e.table === 'parses_cost');
    expect(parsesCostRows).toHaveLength(2);
    // The extract row is identifiable by its cost-usd fingerprint.
    const extractRow = parsesCostRows.find((e) => e.row.costUsd === 0.0006);
    expect(extractRow).toBeTruthy();
    expect(extractRow?.row.stage).toBe('extract-diagrams');
    // Narrative row also has the stage set.
    const narrativeRow = parsesCostRows.find((e) => e.row.model === 'gpt-4o');
    expect(narrativeRow?.row.stage).toBe('narrative');
  });

  it('no onDiagramsExtracted callback provided → no throw, extract+weave still wired', async () => {
    // Defensive: optional callback must be safe to omit (SSE-less callers
    // like the prefetch path do not pass it).
    extractDiagramsMock.mockResolvedValue({
      diagrams: [{ kind: 'DefinitionList', items: [] } as unknown],
      droppedCount: 0,
      promptTokens: 150,
      completionTokens: 50,
      costUsd: 0.0002,
      model: 'gpt-4o-mini',
    });
    weaveDiagramsMock.mockReturnValue('Some narrative output.\n\n```diagram\n{}\n```\n');

    // No onDiagramsExtracted passed.
    const result = await generateChapter({ tutorialId: 'tutorial-1', chapterIdx: 0 });

    expect(result.status).toBe('complete');
    expect(extractDiagramsMock).toHaveBeenCalledTimes(1);
    expect(weaveDiagramsMock).toHaveBeenCalledTimes(1);
    expect(chapterUpdates[0]?.narrative).toContain('```diagram');
  });
});
