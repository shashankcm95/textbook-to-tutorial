// src/lib/diagrams/wire-schema.ts — Sprint H Wave 1 (Builder B).
//
// What this module is:
// --------------------
// The wire-format mirror of the F.1 Zod schema (./schema.ts) plus translators
// in both directions. The wire-format is the JSON-Schema-2020 representation
// used by OpenAI's `response_format: { type: 'json_schema', strict: true }`
// in the Sprint H Shape A 2-pass extractor (`src/lib/openai/extract-diagrams.ts`,
// Builder A). Two wire shapes differ from the in-memory Zod shape due to
// strict-mode constraints discovered in the Wave 0.5 spike
// (`_inspect/sprint-h/spike-jsonschema.md`):
//
//   1. ComparisonTable.rows: in-memory `Record<string,string>` becomes wire
//      `Array<{cells: Array<{column, value}>}>`. Strict mode rejects
//      `additionalProperties: { type: 'string' }`; flat-list fallback proven
//      by spike case2.
//
//   2. DecisionTree: in-memory recursive `{root: DecisionNode}` becomes wire
//      `{rootId: string, nodes: Array<{id, question, leaf, yesId, noId}>}`.
//      Strict mode hangs indefinitely on `$ref` recursion (spike case3/Q2a);
//      adjacency-list fallback proven by spike case4.
//
// Plus a cross-cutting strict-mode rule:
//
//   3. Every property listed in `properties` MUST be in `required` (strict
//      mode does not permit truly optional fields). Zod-optional fields are
//      represented in the wire as required-with-empty-string-sentinel; the
//      translator strips the sentinels before handing to Zod so the
//      optional() validator passes.
//
// Why a separate module (not embedded in extract-diagrams.ts):
// -----------------------------------------------------------
// Pure data-shape translation. No openai, no fs, no DB. Round-trippable in
// isolation. Lets the extractor be a thin call-site (~180 LoC budget per
// RFC) and lets the schema design be tested + reviewed independently.
//
// Imports rule:
// -------------
// ONLY `./schema`. Builder B's module is a leaf in the dependency graph.

import {
  DiagramPayloadSchema,
  type DiagramPayload,
  type DecisionTreeNode,
} from './schema';

// ---------------------------------------------------------------------------
// Public wire types
// ---------------------------------------------------------------------------
//
// Every Zod-optional in the F.1 schema becomes a required string here
// (empty-string sentinel). Enums that are optional become required strings
// (empty-string sentinel) since strict-mode + enum + required doesn't allow
// the absent state.

export type WireComparisonTable = {
  kind: 'ComparisonTable';
  title: string; // empty-string sentinel = "no title"
  columns: string[];
  rows: Array<{ cells: Array<{ column: string; value: string }> }>;
};

export type WireDefinitionList = {
  kind: 'DefinitionList';
  title: string;
  items: Array<{ term: string; definition: string }>;
};

export type WireDiagramFlow = {
  kind: 'DiagramFlow';
  title: string;
  // direction default 'LR' in Zod; wire requires the field, sentinel '' →
  // translator substitutes 'LR' (matches Zod's .default).
  direction: 'LR' | 'TB' | '';
  nodes: Array<{
    id: string;
    label: string;
    // kind is z.enum(['start','process','decision','end']).optional()
    // wire requires the field, empty string = absent.
    kind: 'start' | 'process' | 'decision' | 'end' | '';
  }>;
  edges: Array<{ from: string; to: string; label: string }>;
};

export type WireStateTransitionDiagram = {
  kind: 'StateTransitionDiagram';
  title: string;
  states: Array<{
    id: string;
    label: string;
    initial: boolean; // false = absent (Zod boolean().optional() defaults absent)
    terminal: boolean;
  }>;
  transitions: Array<{ from: string; to: string; trigger: string }>;
};

export type WireSequenceDiagram = {
  kind: 'SequenceDiagram';
  title: string;
  actors: string[];
  messages: Array<{
    from: string;
    to: string;
    label: string;
    kind: 'call' | 'return' | 'async' | '';
  }>;
};

export type WireDecisionTree = {
  kind: 'DecisionTree';
  title: string;
  rootId: string;
  nodes: Array<{
    id: string;
    question: string; // '' = leaf node
    leaf: string;     // '' = internal node
    yesId: string;    // '' = no child (leaf)
    noId: string;     // '' = no child (leaf)
  }>;
};

export type WireDiagram =
  | WireComparisonTable
  | WireDefinitionList
  | WireDiagramFlow
  | WireStateTransitionDiagram
  | WireSequenceDiagram
  | WireDecisionTree;

// ---------------------------------------------------------------------------
// WIRE_SCHEMA — JSON-Schema 2020 literal for OpenAI strict-mode response_format
// ---------------------------------------------------------------------------
//
// Root shape: `{ diagrams: Array<WireDiagram> }`. Each branch in the anyOf
// closes (additionalProperties: false) and every property is in required.
// Discriminator is `kind` via per-branch `const`.
//
// String length limits intentionally mirror Zod (.max(...)). Defense-in-
// depth: strict-mode validates length at compile, Zod re-validates after
// translator. Numeric range limits (minItems / maxItems) likewise mirror.

const titleField = {
  type: 'string',
  maxLength: 120,
  description: 'Optional. Empty string "" means no title.',
} as const;

const shortLabelField = {
  type: 'string',
  minLength: 1,
  maxLength: 32,
} as const;

const nodeIdField = {
  type: 'string',
  minLength: 1,
  maxLength: 64,
  pattern: '^[A-Za-z0-9_-]+$',
} as const;

const comparisonTableBranch = {
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: { type: 'string', const: 'ComparisonTable' },
    title: titleField,
    columns: {
      type: 'array',
      items: shortLabelField,
      minItems: 2,
      maxItems: 6,
    },
    rows: {
      type: 'array',
      minItems: 1,
      maxItems: 20,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          cells: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                column: { type: 'string', minLength: 1, maxLength: 32 },
                value: { type: 'string', maxLength: 400 },
              },
              required: ['column', 'value'],
            },
          },
        },
        required: ['cells'],
      },
    },
  },
  required: ['kind', 'title', 'columns', 'rows'],
} as const;

const definitionListBranch = {
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: { type: 'string', const: 'DefinitionList' },
    title: titleField,
    items: {
      type: 'array',
      minItems: 2,
      maxItems: 15,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          term: { type: 'string', minLength: 1, maxLength: 80 },
          definition: { type: 'string', minLength: 1, maxLength: 400 },
        },
        required: ['term', 'definition'],
      },
    },
  },
  required: ['kind', 'title', 'items'],
} as const;

const diagramFlowBranch = {
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: { type: 'string', const: 'DiagramFlow' },
    title: titleField,
    // direction: enum with empty-string sentinel for "absent → use default"
    direction: { type: 'string', enum: ['LR', 'TB', ''] },
    nodes: {
      type: 'array',
      minItems: 2,
      maxItems: 7,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: nodeIdField,
          label: shortLabelField,
          kind: { type: 'string', enum: ['start', 'process', 'decision', 'end', ''] },
        },
        required: ['id', 'label', 'kind'],
      },
    },
    edges: {
      type: 'array',
      minItems: 1,
      maxItems: 12,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          from: nodeIdField,
          to: nodeIdField,
          label: { type: 'string', maxLength: 24 },
        },
        required: ['from', 'to', 'label'],
      },
    },
  },
  required: ['kind', 'title', 'direction', 'nodes', 'edges'],
} as const;

const stateTransitionBranch = {
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: { type: 'string', const: 'StateTransitionDiagram' },
    title: titleField,
    states: {
      type: 'array',
      minItems: 2,
      maxItems: 8,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: nodeIdField,
          label: shortLabelField,
          initial: { type: 'boolean' },
          terminal: { type: 'boolean' },
        },
        required: ['id', 'label', 'initial', 'terminal'],
      },
    },
    transitions: {
      type: 'array',
      minItems: 1,
      maxItems: 16,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          from: nodeIdField,
          to: nodeIdField,
          trigger: { type: 'string', maxLength: 32 },
        },
        required: ['from', 'to', 'trigger'],
      },
    },
  },
  required: ['kind', 'title', 'states', 'transitions'],
} as const;

const sequenceDiagramBranch = {
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: { type: 'string', const: 'SequenceDiagram' },
    title: titleField,
    actors: {
      type: 'array',
      items: shortLabelField,
      minItems: 2,
      maxItems: 6,
    },
    messages: {
      type: 'array',
      minItems: 1,
      maxItems: 20,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          from: shortLabelField,
          to: shortLabelField,
          label: { type: 'string', minLength: 1, maxLength: 40 },
          kind: { type: 'string', enum: ['call', 'return', 'async', ''] },
        },
        required: ['from', 'to', 'label', 'kind'],
      },
    },
  },
  required: ['kind', 'title', 'actors', 'messages'],
} as const;

const decisionTreeBranch = {
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: { type: 'string', const: 'DecisionTree' },
    title: titleField,
    rootId: { type: 'string', minLength: 1, maxLength: 64 },
    nodes: {
      type: 'array',
      minItems: 1,
      maxItems: 32,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', minLength: 1, maxLength: 64 },
          question: { type: 'string', maxLength: 120 },
          leaf: { type: 'string', maxLength: 80 },
          yesId: { type: 'string', maxLength: 64 },
          noId: { type: 'string', maxLength: 64 },
        },
        required: ['id', 'question', 'leaf', 'yesId', 'noId'],
      },
    },
  },
  required: ['kind', 'title', 'rootId', 'nodes'],
} as const;

export const WIRE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    diagrams: {
      type: 'array',
      // Sprint H Wave 4 fix (DRIFT-test3-024): OpenAI strict-mode response_format
      // does NOT permit `oneOf` at any depth ("Invalid schema for response_format
      // 'extracted_diagrams': In context=('properties','diagrams','items'),
      // 'oneOf' is not permitted"). `anyOf` IS permitted and is semantically
      // equivalent here because the 6 branches are mutually exclusive by `kind`.
      // The Wave 0.5 spike validated individual kind shapes but did NOT exercise
      // the top-level discriminated-union shape across multiple kinds — that
      // gap let the 0/5 Wave-4 result surface. Lesson recorded for the next
      // schema-compat spike.
      items: {
        anyOf: [
          comparisonTableBranch,
          definitionListBranch,
          diagramFlowBranch,
          stateTransitionBranch,
          sequenceDiagramBranch,
          decisionTreeBranch,
        ],
      },
    },
  },
  required: ['diagrams'],
} as const;

// ---------------------------------------------------------------------------
// Constants — depth + cycle bounds for DecisionTree adjacency-list traversal
// ---------------------------------------------------------------------------

const MAX_DECISION_TREE_DEPTH = 8;

// ---------------------------------------------------------------------------
// fromWire — wire-shape → DiagramPayload (Zod-validated)
// ---------------------------------------------------------------------------
//
// Returns null when:
//   - the input isn't a recognized wire shape (missing/unknown `kind`)
//   - DecisionTree adjacency list has a cycle, exceeds max depth, or has
//     a dangling reference (id pointed to but not in `nodes`)
//   - Zod parse fails on the translated payload (caller drops + counts)
//
// Empty-string sentinels for optional Zod fields are stripped (the key is
// omitted from the output object entirely) so Zod's .optional() validator
// passes. Empty arrays for optional-array fields aren't an issue here
// because Zod-side those arrays have minItems ≥ 1, so an empty array is
// always invalid anyway.

export function fromWire(rawDiagram: unknown): DiagramPayload | null {
  if (!rawDiagram || typeof rawDiagram !== 'object') return null;
  const wire = rawDiagram as { kind?: unknown };
  if (typeof wire.kind !== 'string') return null;

  let translated: unknown;
  try {
    switch (wire.kind) {
      case 'ComparisonTable':
        translated = translateComparisonTable(rawDiagram as WireComparisonTable);
        break;
      case 'DefinitionList':
        translated = translateDefinitionList(rawDiagram as WireDefinitionList);
        break;
      case 'DiagramFlow':
        translated = translateDiagramFlow(rawDiagram as WireDiagramFlow);
        break;
      case 'StateTransitionDiagram':
        translated = translateStateTransition(rawDiagram as WireStateTransitionDiagram);
        break;
      case 'SequenceDiagram':
        translated = translateSequenceDiagram(rawDiagram as WireSequenceDiagram);
        break;
      case 'DecisionTree':
        translated = translateDecisionTree(rawDiagram as WireDecisionTree);
        break;
      default:
        return null;
    }
  } catch {
    // Internal translation invariant violated (cycle, dangling ref,
    // ComparisonTable cells column not in columns array, etc.).
    return null;
  }

  if (translated === null) return null;
  const parsed = DiagramPayloadSchema.safeParse(translated);
  return parsed.success ? parsed.data : null;
}

function stripTitle(title: string): { title?: string } {
  // Empty-string sentinel ⇒ omit the key so Zod's .optional() succeeds.
  // Trim deferred to Zod's transform.
  return title === '' ? {} : { title };
}

function translateComparisonTable(w: WireComparisonTable): unknown {
  // Validate cell columns are a subset of declared columns; rebuild record.
  const columnSet = new Set(w.columns);
  const rows = w.rows.map((row) => {
    const obj: Record<string, string> = {};
    for (const cell of row.cells) {
      if (!columnSet.has(cell.column)) {
        throw new Error('cell column not in declared columns');
      }
      obj[cell.column] = cell.value;
    }
    return obj;
  });
  return {
    kind: 'ComparisonTable',
    ...stripTitle(w.title),
    columns: w.columns,
    rows,
  };
}

function translateDefinitionList(w: WireDefinitionList): unknown {
  return {
    kind: 'DefinitionList',
    ...stripTitle(w.title),
    items: w.items,
  };
}

function translateDiagramFlow(w: WireDiagramFlow): unknown {
  const direction = w.direction === '' ? 'LR' : w.direction;
  const nodes = w.nodes.map((n) => {
    // Strip the empty-string sentinel on kind; keep the field when populated.
    const base: { id: string; label: string; kind?: string } = {
      id: n.id,
      label: n.label,
    };
    if (n.kind !== '') base.kind = n.kind;
    return base;
  });
  const edges = w.edges.map((e) => {
    const base: { from: string; to: string; label?: string } = {
      from: e.from,
      to: e.to,
    };
    if (e.label !== '') base.label = e.label;
    return base;
  });
  return {
    kind: 'DiagramFlow',
    ...stripTitle(w.title),
    direction,
    nodes,
    edges,
  };
}

function translateStateTransition(w: WireStateTransitionDiagram): unknown {
  const states = w.states.map((s) => {
    const base: { id: string; label: string; initial?: boolean; terminal?: boolean } = {
      id: s.id,
      label: s.label,
    };
    // boolean-false is a *meaningful* absent sentinel here; only carry
    // the field through when true (so Zod-optional remains optional).
    if (s.initial) base.initial = true;
    if (s.terminal) base.terminal = true;
    return base;
  });
  const transitions = w.transitions.map((t) => {
    const base: { from: string; to: string; trigger?: string } = {
      from: t.from,
      to: t.to,
    };
    if (t.trigger !== '') base.trigger = t.trigger;
    return base;
  });
  return {
    kind: 'StateTransitionDiagram',
    ...stripTitle(w.title),
    states,
    transitions,
  };
}

function translateSequenceDiagram(w: WireSequenceDiagram): unknown {
  const messages = w.messages.map((m) => {
    const base: { from: string; to: string; label: string; kind?: string } = {
      from: m.from,
      to: m.to,
      label: m.label,
    };
    if (m.kind !== '') base.kind = m.kind;
    return base;
  });
  return {
    kind: 'SequenceDiagram',
    ...stripTitle(w.title),
    actors: w.actors,
    messages,
  };
}

function translateDecisionTree(w: WireDecisionTree): unknown {
  // Build node map; check rootId exists.
  const byId = new Map<string, WireDecisionTree['nodes'][number]>();
  for (const n of w.nodes) {
    if (byId.has(n.id)) throw new Error('duplicate node id');
    byId.set(n.id, n);
  }
  if (!byId.has(w.rootId)) throw new Error('rootId not found in nodes');

  function build(id: string, depth: number, visiting: Set<string>): DecisionTreeNode {
    if (depth > MAX_DECISION_TREE_DEPTH) throw new Error('max depth exceeded');
    if (visiting.has(id)) throw new Error('cycle detected');
    const n = byId.get(id);
    if (!n) throw new Error('dangling node reference');
    const hasLeaf = n.leaf !== '';
    const hasQuestion = n.question !== '';
    if (hasLeaf === hasQuestion) {
      // Strict: a node must be one or the other, exclusively.
      throw new Error('node must be either leaf or internal, not both/neither');
    }
    if (hasLeaf) {
      return { leaf: n.leaf };
    }
    if (n.yesId === '' || n.noId === '') {
      throw new Error('internal node missing yesId/noId');
    }
    const next = new Set(visiting);
    next.add(id);
    return {
      question: n.question,
      yes: build(n.yesId, depth + 1, next),
      no: build(n.noId, depth + 1, next),
    };
  }

  const root = build(w.rootId, 0, new Set());
  return {
    kind: 'DecisionTree',
    ...stripTitle(w.title),
    root,
  };
}

// ---------------------------------------------------------------------------
// toWire — DiagramPayload → WireDiagram (inverse direction)
// ---------------------------------------------------------------------------
//
// Used in:
//   - tests (round-trip parity)
//   - future regen-fixture generation (capture a known-good DiagramPayload,
//     emit its wire shape, replay against the extractor for prompt-tuning)
//
// Discipline: fills empty-string sentinels for absent optional fields. No
// information loss across toWire(fromWire(x)) provided x was Zod-valid to
// begin with.

export function toWire(payload: DiagramPayload): WireDiagram {
  switch (payload.kind) {
    case 'ComparisonTable':
      return {
        kind: 'ComparisonTable',
        title: payload.title ?? '',
        columns: payload.columns,
        rows: payload.rows.map((row) => ({
          cells: payload.columns
            .filter((col) => Object.prototype.hasOwnProperty.call(row, col))
            .map((col) => ({ column: col, value: row[col] ?? '' })),
        })),
      };
    case 'DefinitionList':
      return {
        kind: 'DefinitionList',
        title: payload.title ?? '',
        items: payload.items.map((it) => ({ term: it.term, definition: it.definition })),
      };
    case 'DiagramFlow':
      return {
        kind: 'DiagramFlow',
        title: payload.title ?? '',
        direction: payload.direction,
        nodes: payload.nodes.map((n) => ({
          id: n.id,
          label: n.label,
          kind: n.kind ?? '',
        })),
        edges: payload.edges.map((e) => ({
          from: e.from,
          to: e.to,
          label: e.label ?? '',
        })),
      };
    case 'StateTransitionDiagram':
      return {
        kind: 'StateTransitionDiagram',
        title: payload.title ?? '',
        states: payload.states.map((s) => ({
          id: s.id,
          label: s.label,
          initial: s.initial ?? false,
          terminal: s.terminal ?? false,
        })),
        transitions: payload.transitions.map((t) => ({
          from: t.from,
          to: t.to,
          trigger: t.trigger ?? '',
        })),
      };
    case 'SequenceDiagram':
      return {
        kind: 'SequenceDiagram',
        title: payload.title ?? '',
        actors: payload.actors,
        messages: payload.messages.map((m) => ({
          from: m.from,
          to: m.to,
          label: m.label,
          kind: m.kind ?? '',
        })),
      };
    case 'DecisionTree':
      return decisionTreeToWire(payload);
  }
}

function decisionTreeToWire(payload: Extract<DiagramPayload, { kind: 'DecisionTree' }>): WireDecisionTree {
  // BFS over the recursive structure, assigning stable string ids n0..nK.
  const nodes: WireDecisionTree['nodes'] = [];
  let counter = 0;
  function nextId(): string {
    return `n${counter++}`;
  }
  function walk(node: DecisionTreeNode): string {
    const id = nextId();
    if ('leaf' in node) {
      nodes.push({ id, question: '', leaf: node.leaf, yesId: '', noId: '' });
      return id;
    }
    // Reserve slot first so child ids come after this node's id.
    const placeholderIdx = nodes.length;
    const placeholder = { id, question: node.question, leaf: '', yesId: '', noId: '' };
    nodes.push(placeholder);
    const yesId = walk(node.yes);
    const noId = walk(node.no);
    nodes[placeholderIdx] = { ...placeholder, yesId, noId };
    return id;
  }
  const rootId = walk(payload.root);
  return {
    kind: 'DecisionTree',
    title: payload.title ?? '',
    rootId,
    nodes,
  };
}
