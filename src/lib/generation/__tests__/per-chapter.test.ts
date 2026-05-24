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
      // Pass a transaction shim with the same methods we use inside the txn.
      const tx = {
        update: vi.fn(() => updateChain),
        insert: vi.fn(() => insertChain),
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
const readVoiceProfileMock = vi.fn();
const readAnchorWhitelistMock = vi.fn();
vi.mock('@/lib/s3-chunks', () => ({
  readChunk: vi.fn(),
  resolveChunksBucket: vi.fn(() => 'test-bucket'),
  readVoiceProfile: (args: unknown) => readVoiceProfileMock(args),
  readAnchorWhitelist: (args: unknown) => readAnchorWhitelistMock(args),
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
  sampler_version: 'uniform-body-v1',
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
  dbSelectCallIdx = 0;

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
