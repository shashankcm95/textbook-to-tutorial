// src/lib/diagrams/__tests__/wire-schema.test.ts — Sprint H Wave 1 (Builder B).
//
// Coverage:
//   - Per-kind round-trip parity: build a Zod-valid DiagramPayload, run
//     toWire then fromWire, assert deep equality (after Zod's transforms
//     like .trim() are accounted for).
//   - Sentinel discipline: every Zod-optional field is present in the
//     wire shape; absent → empty string '' (strings) or false (booleans).
//   - Translator robustness: malformed entries → null (no throw); cycle
//     detection in DecisionTree adjacency list; mismatched ComparisonTable
//     cells; unknown discriminator.
//   - WIRE_SCHEMA structural invariants: root closes; every property in
//     every nested object is listed in `required` (strict-mode rule).

import { describe, it, expect } from 'vitest';
import {
  WIRE_SCHEMA,
  fromWire,
  toWire,
  type WireDecisionTree,
} from '../wire-schema';
import type { DiagramPayload } from '../schema';

// ---------------------------------------------------------------------------
// Fixtures — minimal Zod-valid payloads for each kind.
// ---------------------------------------------------------------------------

const comparisonTable: DiagramPayload = {
  kind: 'ComparisonTable',
  title: 'Replication topologies',
  columns: ['Topology', 'Writes'],
  rows: [
    { Topology: 'Single-leader', Writes: 'SPOF' },
    { Topology: 'Multi-leader', Writes: 'High' },
  ],
};

const definitionList: DiagramPayload = {
  kind: 'DefinitionList',
  title: 'Concurrency control',
  items: [
    { term: 'Lock', definition: 'Mutual exclusion mechanism.' },
    { term: 'MVCC', definition: 'Multi-version concurrency control.' },
  ],
};

const diagramFlow: DiagramPayload = {
  kind: 'DiagramFlow',
  title: 'Write path',
  direction: 'LR',
  nodes: [
    { id: 'a', label: 'Client', kind: 'start' },
    { id: 'b', label: 'Leader', kind: 'process' },
    { id: 'c', label: 'Replica', kind: 'end' },
  ],
  edges: [
    { from: 'a', to: 'b', label: 'write' },
    { from: 'b', to: 'c' }, // edge label omitted (optional)
  ],
};

const stateTransition: DiagramPayload = {
  kind: 'StateTransitionDiagram',
  title: 'TCP states',
  states: [
    { id: 'closed', label: 'CLOSED', initial: true },
    { id: 'open', label: 'OPEN' },
    { id: 'gone', label: 'CLOSED', terminal: true },
  ],
  transitions: [
    { from: 'closed', to: 'open', trigger: 'connect' },
    { from: 'open', to: 'gone' }, // trigger omitted
  ],
};

const sequenceDiagram: DiagramPayload = {
  kind: 'SequenceDiagram',
  title: 'Two-phase commit',
  actors: ['Coordinator', 'Replica'],
  messages: [
    { from: 'Coordinator', to: 'Replica', label: 'prepare', kind: 'call' },
    { from: 'Replica', to: 'Coordinator', label: 'vote-yes', kind: 'return' },
    { from: 'Coordinator', to: 'Replica', label: 'commit' }, // kind omitted
  ],
};

const decisionTree: DiagramPayload = {
  kind: 'DecisionTree',
  title: 'DB picker',
  root: {
    question: 'Need joins?',
    yes: {
      question: 'Need ACID?',
      yes: { leaf: 'Postgres' },
      no: { leaf: 'MySQL' },
    },
    no: { leaf: 'Redis' },
  },
};

const allFixtures: DiagramPayload[] = [
  comparisonTable,
  definitionList,
  diagramFlow,
  stateTransition,
  sequenceDiagram,
  decisionTree,
];

// ---------------------------------------------------------------------------
// Round-trip parity
// ---------------------------------------------------------------------------

describe('toWire / fromWire round-trip', () => {
  for (const payload of allFixtures) {
    it(`preserves a ${payload.kind} across toWire→fromWire`, () => {
      const wire = toWire(payload);
      const back = fromWire(wire);
      expect(back).not.toBeNull();
      expect(back).toEqual(payload);
    });
  }
});

// ---------------------------------------------------------------------------
// Sentinel discipline — wire shape always presents every optional field
// ---------------------------------------------------------------------------

describe('toWire sentinel discipline', () => {
  it('emits empty-string title sentinel when payload has no title', () => {
    const noTitle: DiagramPayload = {
      kind: 'DefinitionList',
      items: [
        { term: 'A', definition: 'a' },
        { term: 'B', definition: 'b' },
      ],
    };
    const wire = toWire(noTitle);
    expect(wire.title).toBe('');
  });

  it('emits empty-string sentinel for omitted DiagramFlow node.kind', () => {
    const minFlow: DiagramPayload = {
      kind: 'DiagramFlow',
      direction: 'LR',
      nodes: [
        { id: 'a', label: 'A' }, // no `kind`
        { id: 'b', label: 'B' },
      ],
      edges: [{ from: 'a', to: 'b' }],
    };
    const wire = toWire(minFlow);
    if (wire.kind !== 'DiagramFlow') throw new Error('kind mismatch');
    expect(wire.nodes[0]?.kind).toBe('');
    expect(wire.edges[0]?.label).toBe('');
  });

  it('emits boolean false sentinel for omitted state initial/terminal', () => {
    const minState: DiagramPayload = {
      kind: 'StateTransitionDiagram',
      states: [
        { id: 'a', label: 'A' },
        { id: 'b', label: 'B' },
      ],
      transitions: [{ from: 'a', to: 'b' }],
    };
    const wire = toWire(minState);
    if (wire.kind !== 'StateTransitionDiagram') throw new Error('kind mismatch');
    expect(wire.states[0]?.initial).toBe(false);
    expect(wire.states[0]?.terminal).toBe(false);
    expect(wire.transitions[0]?.trigger).toBe('');
  });

  it('strips the title sentinel during fromWire so Zod-optional passes', () => {
    const back = fromWire({
      kind: 'DefinitionList',
      title: '', // sentinel
      items: [
        { term: 'A', definition: 'a' },
        { term: 'B', definition: 'b' },
      ],
    });
    expect(back).not.toBeNull();
    expect(back?.title).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Translator robustness
// ---------------------------------------------------------------------------

describe('fromWire translator robustness', () => {
  it('returns null on non-object input', () => {
    expect(fromWire(null)).toBeNull();
    expect(fromWire(undefined)).toBeNull();
    expect(fromWire('string')).toBeNull();
    expect(fromWire(42)).toBeNull();
  });

  it('returns null when kind is missing or not a string', () => {
    expect(fromWire({ garbage: true })).toBeNull();
    expect(fromWire({ kind: 12 })).toBeNull();
  });

  it('returns null when kind is unknown', () => {
    expect(fromWire({ kind: 'Bogus' })).toBeNull();
  });

  it('returns null when ComparisonTable cell.column not in columns array', () => {
    const bad = {
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
    expect(fromWire(bad)).toBeNull();
  });

  it('returns null when Zod parse fails (e.g. only 1 column)', () => {
    const bad = {
      kind: 'ComparisonTable',
      title: '',
      columns: ['A'], // Zod requires ≥ 2
      rows: [{ cells: [{ column: 'A', value: '1' }] }],
    };
    expect(fromWire(bad)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// DecisionTree adjacency-list edge cases
// ---------------------------------------------------------------------------

describe('fromWire DecisionTree adjacency-list', () => {
  it('rebuilds a valid leaf-only tree', () => {
    // Smallest tree: root is internal with two leaves.
    const wire: WireDecisionTree = {
      kind: 'DecisionTree',
      title: 'tiny',
      rootId: 'r',
      nodes: [
        { id: 'r', question: 'q?', leaf: '', yesId: 'y', noId: 'n' },
        { id: 'y', question: '', leaf: 'YES', yesId: '', noId: '' },
        { id: 'n', question: '', leaf: 'NO', yesId: '', noId: '' },
      ],
    };
    const back = fromWire(wire);
    expect(back).not.toBeNull();
    if (back?.kind !== 'DecisionTree') throw new Error('kind mismatch');
    expect(back.root).toEqual({
      question: 'q?',
      yes: { leaf: 'YES' },
      no: { leaf: 'NO' },
    });
  });

  it('returns null when adjacency list has a cycle', () => {
    const cyclic: WireDecisionTree = {
      kind: 'DecisionTree',
      title: '',
      rootId: 'a',
      nodes: [
        { id: 'a', question: 'q1', leaf: '', yesId: 'b', noId: 'c' },
        { id: 'b', question: 'q2', leaf: '', yesId: 'a', noId: 'c' }, // cycle back to a
        { id: 'c', question: '', leaf: 'X', yesId: '', noId: '' },
      ],
    };
    expect(fromWire(cyclic)).toBeNull();
  });

  it('returns null when rootId points at a missing node', () => {
    const dangling: WireDecisionTree = {
      kind: 'DecisionTree',
      title: '',
      rootId: 'ghost',
      nodes: [{ id: 'a', question: '', leaf: 'X', yesId: '', noId: '' }],
    };
    expect(fromWire(dangling)).toBeNull();
  });

  it('returns null when internal node has empty yesId/noId', () => {
    const broken: WireDecisionTree = {
      kind: 'DecisionTree',
      title: '',
      rootId: 'a',
      nodes: [
        { id: 'a', question: 'q?', leaf: '', yesId: '', noId: '' },
      ],
    };
    expect(fromWire(broken)).toBeNull();
  });

  it('returns null when a node has BOTH question and leaf populated', () => {
    const both: WireDecisionTree = {
      kind: 'DecisionTree',
      title: '',
      rootId: 'a',
      nodes: [
        { id: 'a', question: 'q?', leaf: 'X', yesId: 'b', noId: 'b' },
        { id: 'b', question: '', leaf: 'Y', yesId: '', noId: '' },
      ],
    };
    expect(fromWire(both)).toBeNull();
  });

  it('returns null when a node has NEITHER question nor leaf', () => {
    const neither: WireDecisionTree = {
      kind: 'DecisionTree',
      title: '',
      rootId: 'a',
      nodes: [{ id: 'a', question: '', leaf: '', yesId: '', noId: '' }],
    };
    expect(fromWire(neither)).toBeNull();
  });

  it('returns null when duplicate node ids appear', () => {
    const dup: WireDecisionTree = {
      kind: 'DecisionTree',
      title: '',
      rootId: 'a',
      nodes: [
        { id: 'a', question: 'q1', leaf: '', yesId: 'a', noId: 'a' },
        { id: 'a', question: '', leaf: 'X', yesId: '', noId: '' },
      ],
    };
    expect(fromWire(dup)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// WIRE_SCHEMA structural invariants (strict-mode every-property-required)
// ---------------------------------------------------------------------------
//
// We don't pull in ajv as a dep — package.json has nothing of the sort. We
// walk WIRE_SCHEMA recursively and assert the load-bearing strict-mode
// invariant: at every object literal in the schema, every property listed
// in `properties` is ALSO listed in `required`, and `additionalProperties`
// is explicitly false.

describe('WIRE_SCHEMA strict-mode invariants', () => {
  it('root closes (additionalProperties: false) and requires `diagrams`', () => {
    expect(WIRE_SCHEMA.additionalProperties).toBe(false);
    expect(WIRE_SCHEMA.required).toContain('diagrams');
  });

  it('every nested object: properties ⊆ required, additionalProperties === false', () => {
    walkObjects(WIRE_SCHEMA, (obj, path) => {
      const props = obj.properties;
      if (!props) return;
      // Must close.
      expect(obj.additionalProperties, `${path}: additionalProperties`).toBe(false);
      // Must list every property in required.
      const required = (obj.required ?? []) as string[];
      for (const key of Object.keys(props)) {
        expect(
          required,
          `${path}: missing key '${key}' in required (strict-mode rule)`,
        ).toContain(key);
      }
    });
  });

  it('declares exactly 6 oneOf branches under diagrams.items', () => {
    const items = WIRE_SCHEMA.properties.diagrams.items;
    expect(items.oneOf).toHaveLength(6);
    const discriminators = items.oneOf.map((b) => (b.properties.kind as { const: string }).const);
    expect(new Set(discriminators).size).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// Helper — recursive walker for the schema-invariants test.
// ---------------------------------------------------------------------------

type SchemaNode = {
  type?: string;
  properties?: Record<string, SchemaNode>;
  required?: readonly string[];
  additionalProperties?: boolean | SchemaNode;
  items?: SchemaNode;
  oneOf?: readonly SchemaNode[];
  [k: string]: unknown;
};

function walkObjects(
  node: unknown,
  visit: (obj: SchemaNode, path: string) => void,
  path = '$',
): void {
  if (!node || typeof node !== 'object') return;
  const n = node as SchemaNode;
  if (n.type === 'object' || n.properties) {
    visit(n, path);
  }
  if (n.properties) {
    for (const [k, v] of Object.entries(n.properties)) {
      walkObjects(v, visit, `${path}.${k}`);
    }
  }
  if (n.items) walkObjects(n.items, visit, `${path}[]`);
  if (n.oneOf) n.oneOf.forEach((branch, i) => walkObjects(branch, visit, `${path}|${i}`));
}
