// src/lib/eval/__tests__/diagram-density.test.ts
//
// Unit tests for computeDiagramDensity. Pure-function in/out; no I/O.
// Block-extraction edge cases (EOF without trailing newline, non-diagram
// fences) are exercised explicitly.

import { describe, it, expect } from 'vitest';

import { computeDiagramDensity } from '../diagram-density';
import { weaveDiagrams, type ExtractedDiagram } from '@/lib/diagrams/weave';
import type { DiagramPayload } from '@/lib/diagrams/schema';

// ─────────────────────────────────────────────────────────────────────────────
// Fixture builders
// ─────────────────────────────────────────────────────────────────────────────

const VALID_COMPARISON_TABLE = JSON.stringify({
  kind: 'ComparisonTable',
  columns: ['Approach', 'Latency', 'Cost'],
  rows: [
    { Approach: 'Single-leader', Latency: 'low', Cost: 'low' },
    { Approach: 'Multi-leader', Latency: 'medium', Cost: 'medium' },
  ],
});

const VALID_DEFINITION_LIST = JSON.stringify({
  kind: 'DefinitionList',
  items: [
    { term: 'Leader', definition: 'A node that accepts writes.' },
    { term: 'Follower', definition: 'A node that replicates from the leader.' },
  ],
});

const VALID_DIAGRAM_FLOW = JSON.stringify({
  kind: 'DiagramFlow',
  nodes: [
    { id: 'a', label: 'Start' },
    { id: 'b', label: 'End' },
  ],
  edges: [{ from: 'a', to: 'b' }],
});

const MALFORMED_DIAGRAM = '{ this is not valid json';

function diagramBlock(body: string): string {
  return '```diagram\n' + body + '\n```';
}

function mermaidBlock(body: string): string {
  return '```mermaid\n' + body + '\n```';
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('computeDiagramDensity', () => {
  it('returns all zeros for an empty narrative', () => {
    const d = computeDiagramDensity('');
    expect(d.totalValid).toBe(0);
    expect(d.parseFailures).toBe(0);
    expect(d.mermaidBlocks).toBe(0);
    expect(d.byKind).toEqual({
      ComparisonTable: 0,
      DefinitionList: 0,
      DiagramFlow: 0,
      StateTransitionDiagram: 0,
      SequenceDiagram: 0,
      DecisionTree: 0,
    });
  });

  it('counts a valid ComparisonTable block under byKind.ComparisonTable', () => {
    const md = `Some prose.\n\n${diagramBlock(VALID_COMPARISON_TABLE)}\n\nMore prose.`;
    const d = computeDiagramDensity(md);
    expect(d.byKind.ComparisonTable).toBe(1);
    expect(d.totalValid).toBe(1);
    expect(d.parseFailures).toBe(0);
    expect(d.mermaidBlocks).toBe(0);
  });

  it('counts a malformed ```diagram block as a parseFailure, not as byKind', () => {
    const md = `Intro.\n\n${diagramBlock(MALFORMED_DIAGRAM)}\n`;
    const d = computeDiagramDensity(md);
    expect(d.parseFailures).toBe(1);
    expect(d.totalValid).toBe(0);
    expect(d.byKind.ComparisonTable).toBe(0);
  });

  it('counts a ```mermaid block under mermaidBlocks (not byKind)', () => {
    const md = `Intro.\n\n${mermaidBlock('graph TD\n  A --> B')}\n`;
    const d = computeDiagramDensity(md);
    expect(d.mermaidBlocks).toBe(1);
    expect(d.totalValid).toBe(0);
    expect(d.parseFailures).toBe(0);
  });

  it('counts multiple blocks of mixed kinds correctly', () => {
    const md = [
      'Opening.',
      '',
      diagramBlock(VALID_COMPARISON_TABLE),
      '',
      'Middle.',
      '',
      diagramBlock(VALID_DEFINITION_LIST),
      '',
      diagramBlock(VALID_DIAGRAM_FLOW),
      '',
      mermaidBlock('graph TD\n  A --> B'),
      '',
      diagramBlock(MALFORMED_DIAGRAM),
      '',
      'Closing.',
    ].join('\n');
    const d = computeDiagramDensity(md);
    expect(d.byKind.ComparisonTable).toBe(1);
    expect(d.byKind.DefinitionList).toBe(1);
    expect(d.byKind.DiagramFlow).toBe(1);
    expect(d.totalValid).toBe(3);
    expect(d.mermaidBlocks).toBe(1);
    expect(d.parseFailures).toBe(1);
  });

  it('handles a ```diagram block at end-of-string without trailing newline', () => {
    // No trailing newline after the closing fence; matches when LLM emission
    // is the last token in the narrative.
    const md = `Final paragraph.\n\n${diagramBlock(VALID_COMPARISON_TABLE)}`;
    const d = computeDiagramDensity(md);
    expect(d.byKind.ComparisonTable).toBe(1);
    expect(d.totalValid).toBe(1);
  });

  it('ignores non-diagram non-mermaid fenced code blocks (e.g., ```js)', () => {
    const md = [
      'See this snippet:',
      '',
      '```js',
      'const x = 1;',
      '```',
      '',
      'And a real diagram:',
      '',
      diagramBlock(VALID_COMPARISON_TABLE),
    ].join('\n');
    const d = computeDiagramDensity(md);
    expect(d.byKind.ComparisonTable).toBe(1);
    expect(d.totalValid).toBe(1);
    expect(d.parseFailures).toBe(0);
    expect(d.mermaidBlocks).toBe(0);
  });

  // ───────────────────────────────────────────────────────────────────────
  // Sprint H Wave 1 (Builder E) — source-blindness regression.
  //
  // Why this test exists:
  // ---------------------
  // Sprint H's Shape A architecture means ```diagram fences land in the
  // persisted narrative via TWO paths:
  //   (1) The 4o narrative model emits them inline mid-stream (current
  //       Sprint F.2 path — the empirical 0/5 baseline this sprint is
  //       lifting).
  //   (2) The 4o-mini extractor emits them post-stream, and weaveDiagrams
  //       splices them into the narrative before persistence (Builder C
  //       wired this; Builder D will call it from per-chapter.ts).
  //
  // The density metric MUST be source-blind: a Shape-A woven fence and a
  // Sprint-F.2 inline fence with the SAME payload MUST count identically.
  // If they don't, Wave 4's empirical-success gate (≥3/5 emission, ≥2
  // kinds) becomes meaningless — we'd be measuring path-of-emission, not
  // emission rate.
  //
  // The test exercises the actual `weaveDiagrams` function (no mock) so
  // any future change to weave's fence-emission shape that drifts away
  // from the BLOCK_RE regex contract is caught here, not in production.
  // ───────────────────────────────────────────────────────────────────────
  it('source-blindness: woven fences produce identical byKind counts vs inline fences', () => {
    // (a) Narrative with fences emitted INLINE (the F.2 path the LLM
    //     currently uses on the rare occasion it reaches for one). These
    //     fences are hand-written into the narrative string — no weave
    //     involvement.
    const narrativeInline = [
      '## Lesson 1: Replication',
      '',
      'In a replicated system, writes propagate from a leader to followers.',
      '',
      diagramBlock(VALID_COMPARISON_TABLE),
      '',
      'The two main approaches differ in failure modes.',
      '',
      diagramBlock(VALID_DIAGRAM_FLOW),
      '',
      'Each has its place.',
    ].join('\n');

    // (b) Narrative where the SAME payloads arrive via weaveDiagrams —
    //     prose-only narrative + ExtractedDiagram inputs. The weave runs
    //     for real (no mock) so we're testing the actual production path
    //     Builder D will exercise.
    const narrativeProseOnly = [
      '## Lesson 1: Replication',
      '',
      'In a replicated system, writes propagate from a leader to followers.',
      '',
      'The two main approaches differ in failure modes.',
      '',
      'Each has its place.',
    ].join('\n');

    const diagrams: ExtractedDiagram[] = [
      {
        // The fixture payloads above are JSON strings; round-trip through
        // JSON.parse to get the structured shape weave expects. The cast
        // is safe: each fixture is built to satisfy DiagramPayloadSchema.
        payload: JSON.parse(VALID_COMPARISON_TABLE) as DiagramPayload,
        anchorHeading: 'Replication',
      },
      {
        payload: JSON.parse(VALID_DIAGRAM_FLOW) as DiagramPayload,
      },
    ];
    const narrativeWoven = weaveDiagrams(narrativeProseOnly, diagrams);

    const dInline = computeDiagramDensity(narrativeInline);
    const dWoven = computeDiagramDensity(narrativeWoven);

    // The contract: byKind counts MUST be identical regardless of how
    // the fences arrived. totalValid follows; parseFailures + mermaidBlocks
    // must both be zero on both sides (sanity — the woven fences round-trip
    // through parseDiagramBlock cleanly).
    expect(dWoven.byKind).toEqual(dInline.byKind);
    expect(dWoven.byKind.ComparisonTable).toBe(1);
    expect(dWoven.byKind.DiagramFlow).toBe(1);
    expect(dWoven.totalValid).toBe(dInline.totalValid);
    expect(dWoven.totalValid).toBe(2);
    expect(dWoven.parseFailures).toBe(0);
    expect(dInline.parseFailures).toBe(0);
    expect(dWoven.mermaidBlocks).toBe(0);
    expect(dInline.mermaidBlocks).toBe(0);
  });

  it('source-blindness: weave fallback path (no anchors) still counts in byKind', () => {
    // Extra defense: when the extractor returns no positional hints, weave
    // falls through to the 30% fallback. The fence shape must still match
    // BLOCK_RE — otherwise hint-less extractions would be invisible to the
    // density metric, biasing measurements.
    const proseOnly =
      'A'.repeat(200) +
      '\n\n' +
      'B'.repeat(200) +
      '\n\n' +
      'C'.repeat(200);
    const diagrams: ExtractedDiagram[] = [
      {
        payload: JSON.parse(VALID_DEFINITION_LIST) as DiagramPayload,
      },
    ];
    const woven = weaveDiagrams(proseOnly, diagrams);
    const d = computeDiagramDensity(woven);
    expect(d.byKind.DefinitionList).toBe(1);
    expect(d.totalValid).toBe(1);
    expect(d.parseFailures).toBe(0);
  });

  it('returns totalValid = sum of byKind counts', () => {
    const md = [
      diagramBlock(VALID_COMPARISON_TABLE),
      '',
      diagramBlock(VALID_DEFINITION_LIST),
      '',
      diagramBlock(VALID_DIAGRAM_FLOW),
    ].join('\n');
    const d = computeDiagramDensity(md);
    const sum =
      d.byKind.ComparisonTable +
      d.byKind.DefinitionList +
      d.byKind.DiagramFlow +
      d.byKind.StateTransitionDiagram +
      d.byKind.SequenceDiagram +
      d.byKind.DecisionTree;
    expect(d.totalValid).toBe(sum);
    expect(d.totalValid).toBe(3);
  });
});
