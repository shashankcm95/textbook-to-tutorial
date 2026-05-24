// src/lib/openai/__tests__/narrative-only.test.ts
//
// Tests for the gpt-4o streaming narrative generator (Feature B', Wave 2,
// Component 3 — plumbing voiceProfile + anchorWhitelist through to the
// prompt builder).
//
// Coverage:
//   - When neither voiceProfile nor anchorWhitelist is supplied, the system
//     message equals the no-args buildNarrativeOnlySystemPrompt() output
//     (byte-for-byte) — i.e., the pre-Wave-2 path is undisturbed.
//   - When a voiceProfile is supplied, the system message contains the
//     profile's tone_summary AND the AUTHOR VOICE PROFILE section header.
//   - When an anchorWhitelist is supplied, the system message contains the
//     NAMED ANCHORS header + each anchor's term.
//
// The OpenAI client is mocked at module level (vitest hoists vi.mock). The
// mock returns a minimal async-iterable stream so the caller's for-await
// loop completes deterministically without hitting the network.
//
// See src/lib/openai/narrative-only.ts for the contract.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SourceParagraph } from '@/lib/types';
import type { VoiceProfile } from '@/lib/ingest/voice-extract';
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
import { generateNarrativeOnly } from '../narrative-only';
import { buildNarrativeOnlySystemPrompt } from '@/lib/prompts/narrative-only';

// ───────────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────────

/**
 * Build a minimal async-iterable that yields a single chunk whose delta is
 * the strict-JSON narrative envelope, followed by a usage-only chunk. The
 * caller's for-await loop then parses the accumulated string as JSON.
 */
function makeStreamYielding(narrative: string, promptTokens = 100, completionTokens = 50) {
  const fullJson = JSON.stringify({ narrative });
  const chunks = [
    { choices: [{ delta: { content: fullJson } }] },
    { choices: [{ delta: {} }], usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens } },
  ];
  return {
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) yield c;
    },
  };
}

function makeSourceParagraph(page: number, idx: number, text: string): SourceParagraph {
  return { page, paragraphIdx: idx, text };
}

function makeVoiceProfile(): VoiceProfile {
  return {
    schema_version: 1,
    extracted_at: '2026-05-24T00:00:00.000Z',
    model: 'gpt-4o-mini',
    extraction_cost_usd: 0.0003,
    sample_size: 10,
    sampler_version: 'uniform-body-v1',
    tone_summary: 'UNIQUE-TONE-MARKER-XYZ123 dry pragmatic register.',
    signature_moves: [
      { name: 'Question opener', description: 'Opens with a question.' },
    ],
    example_phrases: [
      { phrase: 'as it turns out', ref: 'page1:paragraph0' },
    ],
    humor_patterns: ['Dry asides.'],
    preferred_analogies: ['Postal analogies.'],
  };
}

function makeAnchor(term: string): AnchorWhitelistEntry {
  return {
    term,
    category: 'search-term',
    frequency_in_source: 1,
    first_seen_at: '2026-05-24T00:00:00.000Z',
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Tests
// ───────────────────────────────────────────────────────────────────────────

describe('generateNarrativeOnly — system-prompt plumbing for voiceProfile + anchorWhitelist', () => {
  beforeEach(() => {
    createMock.mockReset();
  });

  it('passes the no-op system prompt when neither voiceProfile nor anchorWhitelist is provided', async () => {
    createMock.mockResolvedValueOnce(makeStreamYielding('# Lesson 1: Test\nbody.'));

    await generateNarrativeOnly({
      chapterTitle: 'Chapter 1',
      sourceParagraphs: [makeSourceParagraph(1, 0, 'paragraph text')],
      onToken: () => {},
    });

    expect(createMock).toHaveBeenCalledTimes(1);
    const callArgs = createMock.mock.calls[0]![0] as {
      messages: Array<{ role: string; content: string }>;
    };
    const systemMsg = callArgs.messages[0];
    expect(systemMsg?.role).toBe('system');
    // Byte-for-byte equality with the pre-Wave-2 prompt.
    expect(systemMsg?.content).toBe(buildNarrativeOnlySystemPrompt());
    // Negative: no injection headers leaked in.
    expect(systemMsg?.content).not.toContain('AUTHOR VOICE PROFILE');
    expect(systemMsg?.content).not.toContain('NAMED ANCHORS');
  });

  it('forwards a voiceProfile argument into the system prompt (tone_summary visible)', async () => {
    createMock.mockResolvedValueOnce(makeStreamYielding('# Lesson 1: Test\nbody.'));

    const voiceProfile = makeVoiceProfile();
    await generateNarrativeOnly({
      chapterTitle: 'Chapter 1',
      sourceParagraphs: [makeSourceParagraph(1, 0, 'paragraph text')],
      onToken: () => {},
      voiceProfile,
    });

    const callArgs = createMock.mock.calls[0]![0] as {
      messages: Array<{ role: string; content: string }>;
    };
    const systemMsg = callArgs.messages[0]?.content ?? '';
    expect(systemMsg).toContain('AUTHOR VOICE PROFILE');
    // The unique tone-summary marker must appear in the system prompt —
    // proves the arg flowed through the builder, not just a default.
    expect(systemMsg).toContain(voiceProfile.tone_summary);
    expect(systemMsg).toContain('UNIQUE-TONE-MARKER-XYZ123');
    // Anchor section absent when no whitelist supplied.
    expect(systemMsg).not.toContain('NAMED ANCHORS');
  });

  it('forwards an anchorWhitelist argument into the system prompt (each term visible)', async () => {
    createMock.mockResolvedValueOnce(makeStreamYielding('# Lesson 1: Test\nbody.'));

    const anchorWhitelist = [
      makeAnchor('Chaos Monkey'),
      makeAnchor('coordinated omission'),
    ];
    await generateNarrativeOnly({
      chapterTitle: 'Chapter 1',
      sourceParagraphs: [makeSourceParagraph(1, 0, 'paragraph text')],
      onToken: () => {},
      anchorWhitelist,
    });

    const callArgs = createMock.mock.calls[0]![0] as {
      messages: Array<{ role: string; content: string }>;
    };
    const systemMsg = callArgs.messages[0]?.content ?? '';
    expect(systemMsg).toContain('NAMED ANCHORS');
    for (const a of anchorWhitelist) {
      expect(systemMsg).toContain(`"${a.term}"`);
    }
    expect(systemMsg).not.toContain('AUTHOR VOICE PROFILE');
  });

  it('forwards both voiceProfile + anchorWhitelist in canonical order (voice before anchors before FIDELITY RULES)', async () => {
    createMock.mockResolvedValueOnce(makeStreamYielding('# Lesson 1: Test\nbody.'));

    await generateNarrativeOnly({
      chapterTitle: 'Chapter 1',
      sourceParagraphs: [makeSourceParagraph(1, 0, 'paragraph text')],
      onToken: () => {},
      voiceProfile: makeVoiceProfile(),
      anchorWhitelist: [makeAnchor('t-digest')],
    });

    const callArgs = createMock.mock.calls[0]![0] as {
      messages: Array<{ role: string; content: string }>;
    };
    const systemMsg = callArgs.messages[0]?.content ?? '';
    const voiceIdx = systemMsg.indexOf('AUTHOR VOICE PROFILE');
    const anchorsIdx = systemMsg.indexOf('NAMED ANCHORS');
    const fidelityIdx = systemMsg.indexOf('FIDELITY RULES');
    expect(voiceIdx).toBeGreaterThanOrEqual(0);
    expect(anchorsIdx).toBeGreaterThanOrEqual(0);
    expect(fidelityIdx).toBeGreaterThanOrEqual(0);
    expect(voiceIdx).toBeLessThan(anchorsIdx);
    expect(anchorsIdx).toBeLessThan(fidelityIdx);
  });
});
