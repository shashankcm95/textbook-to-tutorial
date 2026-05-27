// src/lib/prompts/__tests__/narrative-only.test.ts
//
// Tests for the narrative-only system-prompt builder (Feature B', Wave 2,
// Component 3 — Prompt Injection).
//
// The builder is load-bearing for the fidelity-injection path: a regression
// that drops a section, reorders sections, or breaks the no-op-when-absent
// guarantee silently changes the system prompt for every chapter. Both
// directions land here as test failures.
//
// Coverage:
//   - No-args call returns the pre-Wave-2 prompt unchanged (byte-for-byte).
//   - Voice profile only (no anchors) — voice section injected; anchor absent.
//   - Anchors only (no voice) — anchor section injected; voice absent.
//   - Both present — voice FIRST, anchors SECOND, both BEFORE "FIDELITY RULES".
//   - Empty signature_moves array → voice section still renders gracefully.
//   - Empty anchorWhitelist array → no NAMED ANCHORS section emitted.
//   - Existing fidelity + negative rules unchanged in every case (substring
//     assertion: each existing rule text still appears).
//
// See src/lib/prompts/narrative-only.ts for the contract.

import { describe, it, expect } from 'vitest';
import {
  buildNarrativeOnlySystemPrompt,
  buildNarrativeOnlyUserPrompt,
  type BuildNarrativeOnlySystemPromptArgs,
  type GlossaryTermEntry,
} from '../narrative-only';
import type { VoiceProfile } from '@/lib/ingest/voice-extract';
import type { AnchorWhitelistEntry } from '@/lib/openai/anchor-validator';
import type { SourceParagraph } from '@/lib/types';

// ───────────────────────────────────────────────────────────────────────────
// Fixtures
// ───────────────────────────────────────────────────────────────────────────

function makeVoiceProfile(overrides: Partial<VoiceProfile> = {}): VoiceProfile {
  return {
    schema_version: 1,
    extracted_at: '2026-05-24T00:00:00.000Z',
    model: 'gpt-4o-mini',
    extraction_cost_usd: 0.0003,
    sample_size: 10,
    sampler_version: 'weighted-rhetorical-v1',
    tone_summary:
      'Dry, pragmatic, allergic to hype; explains via concrete incidents.',
    signature_moves: [
      { name: 'Question opener', description: 'Opens chapters with a question or pushback.' },
      { name: 'Benefit-then-qualify', description: 'Sets up benefits then qualifies them.' },
      { name: 'Named incidents', description: 'Names canonical incidents (leap-second).' },
    ],
    example_phrases: [
      { phrase: 'as it turns out, this is harder than it looks', ref: 'page1:paragraph0' },
      { phrase: 'the literature glosses over this', ref: 'page2:paragraph1' },
    ],
    humor_patterns: [
      'Dry asides about industry hype.',
      'Self-deprecating callbacks.',
    ],
    preferred_analogies: [
      'Postal/messaging analogies.',
      'Clock + calendar metaphors.',
    ],
    ...overrides,
  };
}

function makeAnchor(
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

// Subset of fidelity rules that MUST survive every call (regression canaries).
// Sprint C Phase 1: extended with Rules D + E (Professor round-2 HIGH #2 —
// silent-delete risk on the negative-rules block shipped in PR #22).
// Sprint E Tier 1: extended with Rules 7 + 8 (CTCI ingest audit predicted ~0%
// code-preservation; image-handling audit measured 100% figure drop across
// 588 chapter rows — both gaps land here as silent-delete canaries).
const EXISTING_RULE_FRAGMENTS = [
  'FIDELITY RULES',
  '1. PRESERVE CONCRETE ANCHORS.',
  '2. PRESERVE TERMINOLOGICAL PRECISION.',
  '3. MATCH THE AUTHOR\'S RHETORICAL VOICE.',
  '4. PRESERVE NAMED IDIOMS, HUMOR, AND SIGNATURE PHRASES.',
  // PR #42 (Tier 1 persona-rewalk fix) strengthened this rule to call out
  // practical-deployment caveats. Match the new prefix without the trailing
  // period so the test survives further refinements of the rule body.
  '5. PRESERVE THE "BUT CLAUSE" PATTERN',
  '6. PRESERVE IMPLEMENTATION-SPECIFIC SEARCH-TERM ANCHORS.',
  '7. PRESERVE CODE LISTINGS,',
  '8. PRESERVE FIGURE REFERENCES.',
  'NEGATIVE RULES (do NOT do these):',
  'A. NO LLM BOILERPLATE OPENERS OR CLOSERS.',
  'B. NO GENERIC ABSTRACTION-FIRST INTROS.',
  'C. NO PARAPHRASING NAMED TECHNIQUES INTO GENERIC DESCRIPTIONS.',
  'D. FORBIDDEN-PHRASE LINT',
  'E. ORPHAN DISCOURSE MARKER LINT',
];

function expectExistingRulesPresent(prompt: string): void {
  for (const fragment of EXISTING_RULE_FRAGMENTS) {
    expect(prompt, `existing fragment missing: ${fragment}`).toContain(fragment);
  }
}

// ───────────────────────────────────────────────────────────────────────────
// No-op / backward compatibility
// ───────────────────────────────────────────────────────────────────────────

describe('buildNarrativeOnlySystemPrompt — no-args / no-op path', () => {
  it('returns the pre-Wave-2 prompt unchanged when called with no args', () => {
    const noArgs = buildNarrativeOnlySystemPrompt();
    // Sanity: it's a non-empty string.
    expect(typeof noArgs).toBe('string');
    expect(noArgs.length).toBeGreaterThan(0);
    // Must NOT contain either injection section header.
    expect(noArgs).not.toContain('AUTHOR VOICE PROFILE');
    expect(noArgs).not.toContain('NAMED ANCHORS');
    // Existing rules still present.
    expectExistingRulesPresent(noArgs);
  });

  it('returns byte-for-byte identical output for no-args vs undefined-args vs empty-object', () => {
    const noArgs = buildNarrativeOnlySystemPrompt();
    const undefArgs = buildNarrativeOnlySystemPrompt(undefined);
    const emptyArgs = buildNarrativeOnlySystemPrompt({});
    expect(undefArgs).toBe(noArgs);
    expect(emptyArgs).toBe(noArgs);
  });

  it('treats empty anchorWhitelist + absent voiceProfile as no-op', () => {
    const noArgs = buildNarrativeOnlySystemPrompt();
    const emptyAnchors = buildNarrativeOnlySystemPrompt({ anchorWhitelist: [] });
    expect(emptyAnchors).toBe(noArgs);
  });

  it('treats empty glossary + absent voice + absent anchors as no-op (Sprint J)', () => {
    const noArgs = buildNarrativeOnlySystemPrompt();
    const emptyGlossary = buildNarrativeOnlySystemPrompt({ glossary: [] });
    expect(emptyGlossary).toBe(noArgs);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Voice profile only
// ───────────────────────────────────────────────────────────────────────────

describe('buildNarrativeOnlySystemPrompt — voice profile only', () => {
  it('injects the AUTHOR VOICE PROFILE section with tone, moves, phrases, humor, analogies', () => {
    const voiceProfile = makeVoiceProfile();
    const prompt = buildNarrativeOnlySystemPrompt({ voiceProfile });

    expect(prompt).toContain('AUTHOR VOICE PROFILE');
    expect(prompt).toContain(`Tone: ${voiceProfile.tone_summary}`);

    // All signature moves rendered as numbered list.
    voiceProfile.signature_moves.forEach((move, i) => {
      expect(prompt).toContain(`${i + 1}. ${move.name}: ${move.description}`);
    });

    // All example phrases rendered verbatim with their refs.
    voiceProfile.example_phrases.forEach((p) => {
      expect(prompt).toContain(`"${p.phrase}" [${p.ref}]`);
    });

    // Humor + analogy patterns rendered.
    voiceProfile.humor_patterns.forEach((h) => expect(prompt).toContain(h));
    voiceProfile.preferred_analogies.forEach((a) => expect(prompt).toContain(a));

    // No anchor section when whitelist absent.
    expect(prompt).not.toContain('NAMED ANCHORS');

    // Existing rules preserved.
    expectExistingRulesPresent(prompt);
  });

  it('orders the voice section BEFORE the FIDELITY RULES block', () => {
    const prompt = buildNarrativeOnlySystemPrompt({ voiceProfile: makeVoiceProfile() });
    const voiceIdx = prompt.indexOf('AUTHOR VOICE PROFILE');
    const fidelityIdx = prompt.indexOf('FIDELITY RULES');
    expect(voiceIdx).toBeGreaterThanOrEqual(0);
    expect(fidelityIdx).toBeGreaterThanOrEqual(0);
    expect(voiceIdx).toBeLessThan(fidelityIdx);
  });

  it('renders gracefully when signature_moves is empty (no numbered bullets, header still emitted)', () => {
    const profile = makeVoiceProfile({ signature_moves: [] });
    const prompt = buildNarrativeOnlySystemPrompt({ voiceProfile: profile });
    expect(prompt).toContain('AUTHOR VOICE PROFILE');
    expect(prompt).toContain(`Tone: ${profile.tone_summary}`);
    // No "1. " numbered move line should appear inside the voice block.
    // (Defensive: this would catch a regression that hallucinated a bullet
    // for an empty array.)
    const voiceBlock = prompt.slice(
      prompt.indexOf('AUTHOR VOICE PROFILE'),
      prompt.indexOf('Example phrases'),
    );
    expect(voiceBlock).not.toMatch(/^\s*1\./m);
    expectExistingRulesPresent(prompt);
  });

  it('renders gracefully when humor_patterns is empty (no Humor label emitted)', () => {
    const profile = makeVoiceProfile({ humor_patterns: [] });
    const prompt = buildNarrativeOnlySystemPrompt({ voiceProfile: profile });
    expect(prompt).not.toContain('Humor / register:');
    // Analogies still rendered.
    expect(prompt).toContain('Preferred analogy types:');
  });

  it('renders gracefully when preferred_analogies is empty (no analogy label emitted)', () => {
    const profile = makeVoiceProfile({ preferred_analogies: [] });
    const prompt = buildNarrativeOnlySystemPrompt({ voiceProfile: profile });
    expect(prompt).not.toContain('Preferred analogy types:');
    // Humor still rendered.
    expect(prompt).toContain('Humor / register:');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Anchor whitelist only
// ───────────────────────────────────────────────────────────────────────────

describe('buildNarrativeOnlySystemPrompt — anchor whitelist only', () => {
  it('injects the NAMED ANCHORS section with each anchor rendered as term + category', () => {
    const anchors: AnchorWhitelistEntry[] = [
      makeAnchor('Chaos Monkey', 'named-system'),
      makeAnchor('t-digest', 'search-term'),
      makeAnchor('leap-second bug', 'named-incident'),
    ];
    const prompt = buildNarrativeOnlySystemPrompt({ anchorWhitelist: anchors });

    expect(prompt).toContain('NAMED ANCHORS');
    expect(prompt).toContain('preserve verbatim');
    for (const a of anchors) {
      expect(prompt).toContain(`"${a.term}" (${a.category})`);
    }

    // No voice section when profile absent.
    expect(prompt).not.toContain('AUTHOR VOICE PROFILE');

    expectExistingRulesPresent(prompt);
  });

  it('orders the anchors section BEFORE the FIDELITY RULES block', () => {
    const anchors = [makeAnchor('HdrHistogram')];
    const prompt = buildNarrativeOnlySystemPrompt({ anchorWhitelist: anchors });
    const anchorsIdx = prompt.indexOf('NAMED ANCHORS');
    const fidelityIdx = prompt.indexOf('FIDELITY RULES');
    expect(anchorsIdx).toBeGreaterThanOrEqual(0);
    expect(fidelityIdx).toBeGreaterThanOrEqual(0);
    expect(anchorsIdx).toBeLessThan(fidelityIdx);
  });

  it('emits no NAMED ANCHORS section when the whitelist is empty', () => {
    const prompt = buildNarrativeOnlySystemPrompt({ anchorWhitelist: [] });
    expect(prompt).not.toContain('NAMED ANCHORS');
    // Should equal the no-args (no-op) prompt byte-for-byte.
    expect(prompt).toBe(buildNarrativeOnlySystemPrompt());
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Both sections present — ordering contract
// ───────────────────────────────────────────────────────────────────────────

describe('buildNarrativeOnlySystemPrompt — voice + anchors together', () => {
  it('emits voice FIRST, anchors SECOND, both BEFORE FIDELITY RULES', () => {
    const voiceProfile = makeVoiceProfile();
    const anchors = [
      makeAnchor('Chaos Monkey', 'named-system'),
      makeAnchor('coordinated omission', 'search-term'),
    ];
    const prompt = buildNarrativeOnlySystemPrompt({ voiceProfile, anchorWhitelist: anchors });

    const voiceIdx = prompt.indexOf('AUTHOR VOICE PROFILE');
    const anchorsIdx = prompt.indexOf('NAMED ANCHORS');
    const fidelityIdx = prompt.indexOf('FIDELITY RULES');

    expect(voiceIdx).toBeGreaterThanOrEqual(0);
    expect(anchorsIdx).toBeGreaterThanOrEqual(0);
    expect(fidelityIdx).toBeGreaterThanOrEqual(0);
    expect(voiceIdx).toBeLessThan(anchorsIdx);
    expect(anchorsIdx).toBeLessThan(fidelityIdx);

    expectExistingRulesPresent(prompt);
  });

  it('preserves the role line ("You are a tutorial-writer...") AFTER the prepended sections', () => {
    const voiceProfile = makeVoiceProfile();
    const anchors = [makeAnchor('t-digest')];
    const prompt = buildNarrativeOnlySystemPrompt({ voiceProfile, anchorWhitelist: anchors });

    const roleIdx = prompt.indexOf('You are a tutorial-writer');
    const voiceIdx = prompt.indexOf('AUTHOR VOICE PROFILE');
    const anchorsIdx = prompt.indexOf('NAMED ANCHORS');

    expect(roleIdx).toBeGreaterThan(voiceIdx);
    expect(roleIdx).toBeGreaterThan(anchorsIdx);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Type-level smoke: the args interface stays optional
// ───────────────────────────────────────────────────────────────────────────

describe('BuildNarrativeOnlySystemPromptArgs — type smoke', () => {
  it('accepts a profile-only args object', () => {
    const args: BuildNarrativeOnlySystemPromptArgs = { voiceProfile: makeVoiceProfile() };
    expect(() => buildNarrativeOnlySystemPrompt(args)).not.toThrow();
  });
  it('accepts an anchors-only args object', () => {
    const args: BuildNarrativeOnlySystemPromptArgs = {
      anchorWhitelist: [makeAnchor('RAID')],
    };
    expect(() => buildNarrativeOnlySystemPrompt(args)).not.toThrow();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Wave-2 review fix-up regression guards
// ───────────────────────────────────────────────────────────────────────────

describe('renderVoiceProfileSection — Wave-2 review HIGH 2B-H1 (empty example_phrases)', () => {
  it('omits the example-phrases header when example_phrases is empty', () => {
    const voiceProfile = makeVoiceProfile();
    voiceProfile.example_phrases = [];
    const prompt = buildNarrativeOnlySystemPrompt({ voiceProfile });

    // The header MUST NOT appear when there are no phrases to list under it.
    expect(prompt).not.toContain('Example phrases that sound DISTINCTIVELY');

    // But the rest of the voice section MUST still render.
    expect(prompt).toContain('AUTHOR VOICE PROFILE');
    expect(prompt).toContain(`Tone: ${voiceProfile.tone_summary}`);
    expect(prompt).toContain('Signature moves');
  });
});

describe('renderers — Wave-2 review HIGH 2B-H2 (defensive size caps)', () => {
  it('caps signature_moves at 10 entries (defends against extractor cardinality drift)', () => {
    const voiceProfile = makeVoiceProfile();
    voiceProfile.signature_moves = Array.from({ length: 50 }, (_, i) => ({
      name: `Move ${i + 1}`,
      description: `description ${i + 1}`,
    }));
    const prompt = buildNarrativeOnlySystemPrompt({ voiceProfile });

    // First 10 must appear.
    expect(prompt).toContain('1. Move 1: description 1');
    expect(prompt).toContain('10. Move 10: description 10');
    // Move 11 onward must NOT appear.
    expect(prompt).not.toContain('11. Move 11');
    expect(prompt).not.toContain('Move 25');
  });

  it('caps example_phrases at 10 entries', () => {
    const voiceProfile = makeVoiceProfile();
    voiceProfile.example_phrases = Array.from({ length: 30 }, (_, i) => ({
      phrase: `unique-phrase-${i + 1}`,
      ref: `page1:paragraph${i}`,
    }));
    const prompt = buildNarrativeOnlySystemPrompt({ voiceProfile });

    expect(prompt).toContain('unique-phrase-1');
    expect(prompt).toContain('unique-phrase-10');
    expect(prompt).not.toContain('unique-phrase-11');
    expect(prompt).not.toContain('unique-phrase-25');
  });

  it('caps anchorWhitelist at 30 entries (defends against scorer drift)', () => {
    const anchorWhitelist = Array.from({ length: 60 }, (_, i) =>
      makeAnchor(`anchor-term-${i + 1}`),
    );
    const prompt = buildNarrativeOnlySystemPrompt({ anchorWhitelist });

    expect(prompt).toContain('anchor-term-1');
    expect(prompt).toContain('anchor-term-30');
    expect(prompt).not.toContain('anchor-term-31');
    expect(prompt).not.toContain('anchor-term-45');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Sprint J — glossary injection
// ───────────────────────────────────────────────────────────────────────────

function makeGlossaryEntry(
  term: string,
  definition: string,
  sourceParagraphRef: string = 'page1:paragraph0',
): GlossaryTermEntry {
  return { term, definition, sourceParagraphRef };
}

describe('buildNarrativeOnlySystemPrompt — glossary injection (Sprint J)', () => {
  it('injects the GLOSSARY section with each term + definition rendered as a bullet', () => {
    const glossary: GlossaryTermEntry[] = [
      makeGlossaryEntry('Hash Table', 'A keyed data structure indexed via a hash function.'),
      makeGlossaryEntry('Bloom Filter', 'A probabilistic set-membership data structure.'),
    ];
    const prompt = buildNarrativeOnlySystemPrompt({ glossary });

    expect(prompt).toContain('GLOSSARY');
    expect(prompt).toContain('canonical definitions');
    for (const g of glossary) {
      expect(prompt).toContain(`"${g.term}": ${g.definition}`);
    }

    // No voice / anchor section absent.
    expect(prompt).not.toContain('AUTHOR VOICE PROFILE');
    expect(prompt).not.toContain('NAMED ANCHORS');

    expectExistingRulesPresent(prompt);
  });

  it('orders the glossary section BEFORE the FIDELITY RULES block', () => {
    const prompt = buildNarrativeOnlySystemPrompt({
      glossary: [makeGlossaryEntry('CAP theorem', 'A distributed-systems consistency tradeoff.')],
    });
    const glossaryIdx = prompt.indexOf('GLOSSARY');
    const fidelityIdx = prompt.indexOf('FIDELITY RULES');
    expect(glossaryIdx).toBeGreaterThanOrEqual(0);
    expect(fidelityIdx).toBeGreaterThanOrEqual(0);
    expect(glossaryIdx).toBeLessThan(fidelityIdx);
  });

  it('emits no GLOSSARY section when the list is empty', () => {
    const prompt = buildNarrativeOnlySystemPrompt({ glossary: [] });
    expect(prompt).not.toContain('GLOSSARY');
    // Equals the no-args (no-op) prompt byte-for-byte.
    expect(prompt).toBe(buildNarrativeOnlySystemPrompt());
  });

  it('caps glossary entries at MAX_GLOSSARY_ENTRIES (defends against pipeline drift)', () => {
    const glossary: GlossaryTermEntry[] = Array.from({ length: 120 }, (_, i) =>
      makeGlossaryEntry(`unique-gloss-term-${i + 1}`, `definition ${i + 1}`),
    );
    const prompt = buildNarrativeOnlySystemPrompt({ glossary });
    // First 80 must appear.
    expect(prompt).toContain('unique-gloss-term-1');
    expect(prompt).toContain('unique-gloss-term-80');
    // 81 onward must NOT appear.
    expect(prompt).not.toContain('unique-gloss-term-81');
    expect(prompt).not.toContain('unique-gloss-term-100');
  });
});

describe('buildNarrativeOnlySystemPrompt — voice + anchors + glossary (full Sprint J ordering)', () => {
  it('emits voice FIRST, anchors SECOND, glossary THIRD, base prompt LAST', () => {
    const voiceProfile = makeVoiceProfile();
    const anchors = [makeAnchor('Chaos Monkey', 'named-system')];
    const glossary = [
      makeGlossaryEntry('Replication', 'The act of keeping a copy of data on multiple nodes.'),
    ];
    const prompt = buildNarrativeOnlySystemPrompt({
      voiceProfile,
      anchorWhitelist: anchors,
      glossary,
    });

    const voiceIdx = prompt.indexOf('AUTHOR VOICE PROFILE');
    const anchorsIdx = prompt.indexOf('NAMED ANCHORS');
    const glossaryIdx = prompt.indexOf('GLOSSARY');
    const fidelityIdx = prompt.indexOf('FIDELITY RULES');

    expect(voiceIdx).toBeGreaterThanOrEqual(0);
    expect(anchorsIdx).toBeGreaterThanOrEqual(0);
    expect(glossaryIdx).toBeGreaterThanOrEqual(0);
    expect(fidelityIdx).toBeGreaterThanOrEqual(0);
    expect(voiceIdx).toBeLessThan(anchorsIdx);
    expect(anchorsIdx).toBeLessThan(glossaryIdx);
    expect(glossaryIdx).toBeLessThan(fidelityIdx);

    expectExistingRulesPresent(prompt);
  });

  it('preserves the role line ("You are a tutorial-writer...") AFTER the prepended sections', () => {
    const prompt = buildNarrativeOnlySystemPrompt({
      voiceProfile: makeVoiceProfile(),
      anchorWhitelist: [makeAnchor('RAID')],
      glossary: [makeGlossaryEntry('RAID', 'A redundant array of inexpensive disks.')],
    });
    const roleIdx = prompt.indexOf('You are a tutorial-writer');
    const glossaryIdx = prompt.indexOf('GLOSSARY');
    expect(roleIdx).toBeGreaterThan(glossaryIdx);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// buildNarrativeOnlyUserPrompt — PR-B [CODE] marker
// ───────────────────────────────────────────────────────────────────────────
//
// The user prompt is where each paragraph's text reaches the LLM. PR-B adds
// a `[CODE]` marker prefix to paragraphs whose typography the parser
// classified as monospace (kind === 'code'). Prose paragraphs are unchanged.
// FIDELITY rule 7 in the SYSTEM prompt references the marker.

function makeParagraph(overrides: Partial<SourceParagraph> = {}): SourceParagraph {
  return {
    page: 1,
    paragraphIdx: 0,
    text: 'sample paragraph text',
    ...overrides,
  };
}

describe('buildNarrativeOnlyUserPrompt — PR-B [CODE] marker', () => {
  // Helper: slice the prompt to JUST the dumped paragraphs (skip the SOURCE
  // PARAGRAPHS header which itself mentions `[CODE]` as documentation). The
  // header ends at the first `[pageN:paragraphM]` token; everything from
  // that token to "Generate the JSON narrative" is the paragraph dump.
  function paragraphsBlock(prompt: string): string {
    const firstParaIdx = prompt.search(/\[page\d+:paragraph\d+]/);
    const generateIdx = prompt.indexOf('Generate the JSON narrative');
    if (firstParaIdx < 0 || generateIdx < 0) return prompt;
    return prompt.slice(firstParaIdx, generateIdx);
  }

  it('emits [CODE] prefix for kind="code" paragraphs', () => {
    const sourceParagraphs: SourceParagraph[] = [
      makeParagraph({ page: 1, paragraphIdx: 0, text: 'class Node { int v; }', kind: 'code' }),
    ];
    const prompt = buildNarrativeOnlyUserPrompt({
      chapterTitle: 'Trees and Graphs',
      sourceParagraphs,
    });
    expect(paragraphsBlock(prompt)).toContain('[page1:paragraph0] [CODE] class Node { int v; }');
  });

  it("does NOT emit [CODE] prefix for kind='prose' paragraphs", () => {
    const sourceParagraphs: SourceParagraph[] = [
      makeParagraph({ page: 1, paragraphIdx: 0, text: 'This chapter introduces trees.', kind: 'prose' }),
    ];
    const prompt = buildNarrativeOnlyUserPrompt({
      chapterTitle: 'Trees',
      sourceParagraphs,
    });
    const block = paragraphsBlock(prompt);
    expect(block).toContain('[page1:paragraph0] This chapter introduces trees.');
    expect(block).not.toContain('[CODE]');
  });

  it('does NOT emit [CODE] prefix when kind is absent (pre-PR-B back-compat)', () => {
    // Pre-PR-B source_paragraphs_json rows lack the kind field entirely.
    // Existing cached tutorials must keep their old prompt shape so cache
    // hits don't reshape narratives unexpectedly.
    const sourceParagraphs: SourceParagraph[] = [
      makeParagraph({ page: 2, paragraphIdx: 3, text: 'Legacy paragraph text.' }),
    ];
    const prompt = buildNarrativeOnlyUserPrompt({
      chapterTitle: 'Legacy',
      sourceParagraphs,
    });
    const block = paragraphsBlock(prompt);
    expect(block).toContain('[page2:paragraph3] Legacy paragraph text.');
    expect(block).not.toContain('[CODE]');
  });

  it('mixes [CODE] and prose paragraphs correctly in document order', () => {
    const sourceParagraphs: SourceParagraph[] = [
      makeParagraph({ page: 1, paragraphIdx: 0, text: 'Intro prose.', kind: 'prose' }),
      makeParagraph({ page: 1, paragraphIdx: 1, text: 'function f() {}', kind: 'code' }),
      makeParagraph({ page: 1, paragraphIdx: 2, text: 'Closing prose.', kind: 'prose' }),
    ];
    const prompt = buildNarrativeOnlyUserPrompt({
      chapterTitle: 'Mixed',
      sourceParagraphs,
    });
    const block = paragraphsBlock(prompt);
    expect(block).toContain('[page1:paragraph0] Intro prose.');
    expect(block).toContain('[page1:paragraph1] [CODE] function f() {}');
    expect(block).toContain('[page1:paragraph2] Closing prose.');
    // Order preservation in the paragraphs block only
    const introIdx = block.indexOf('Intro prose');
    const codeIdx = block.indexOf('[CODE]');
    const closingIdx = block.indexOf('Closing prose');
    expect(introIdx).toBeGreaterThan(0);
    expect(codeIdx).toBeGreaterThan(introIdx);
    expect(closingIdx).toBeGreaterThan(codeIdx);
  });

  it('includes the [CODE]-marker explainer in the SOURCE PARAGRAPHS header', () => {
    const prompt = buildNarrativeOnlyUserPrompt({
      chapterTitle: 'Whatever',
      sourceParagraphs: [makeParagraph()],
    });
    // The header must reference the marker so the LLM knows to act on it.
    expect(prompt).toMatch(/paragraphs tagged `\[CODE\]`/);
  });
});
