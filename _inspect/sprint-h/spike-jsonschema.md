# Spike: JSON-Schema strict-mode compatibility

**Sprint H Wave 0.5** — empirical resolution of the two known-friction
constructs in the F.1 Zod schema (`src/lib/diagrams/schema.ts`) before
Wave 1 locks the wire-schema design.

- **Model used**: `gpt-4o-mini`
- **OpenAI SDK**: `4.55.0`
- **Date**: 2026-05-26
- **Script**: `_inspect/sprint-h/spike-jsonschema.ts` (+ follow-up
  `spike-jsonschema-followup.ts`)
- **Logs**: `spike-jsonschema.log`, `spike-jsonschema-followup.log`
- **Total OpenAI cost**: **$0.000250** (4 calls; well under the $0.10 budget)

---

## Test matrix

| Case | Construct | Compile? | Output → Zod? | Latency | Cost |
|------|-----------|----------|---------------|---------|------|
| **case1** | ComparisonTable rows via `additionalProperties: { type: 'string' }` | **NO** | n/a | 1,204 ms (reject) | $0 |
| **case2** | ComparisonTable rows as flat-list fallback (`{column, value}[]` per row) | **YES** | **YES** | 2,582 ms | $0.000107 |
| **case3** | DecisionTree via `$ref` recursion | **NO** (timeout / never compiles) | n/a | 60,006 ms (60 s timeout) | $0 |
| **case4** | DecisionTree as adjacency-list fallback (`nodes[]` with `yesId`/`noId`) | **YES** | **YES** | 4,905 ms | $0.000142 |

Two follow-up isolation trials confirmed the verdicts:

| Trial | Test | Result |
|-------|------|--------|
| **Q1a** | Single object with one property whose value uses `additionalProperties: { type: 'string' }` | **Rejected at compile** in 227 ms with the same misleading "Extra required key" message |
| **Q1b** | Array of rows, each row is `additionalProperties: { type: 'string' }` | **Rejected at compile** in 105 ms (same error) |
| **Q2a** | Minimal `$ref` recursion (root → Node → yes/no → Node), 180 s timeout | **Hung; timed out at 180,003 ms.** Strict-mode compiler never returns. |

---

## Q1 verdict — **REJECT**

`additionalProperties: { type: 'string' }` is **not accepted** by OpenAI
strict-mode `response_format`. The error message is misleading and worth
preserving for grep:

```
Invalid schema for response_format 'trial_payload':
In context=(), 'required' is required to be supplied and to be an array
including every key in properties. Extra required key 'rows' supplied.
```

The error blames `required` for listing `rows`, but `rows` IS listed in
`properties`. The root cause is that strict mode silently strips/ignores
any property whose schema declares a typed `additionalProperties`; from
the validator's POV, the property then no longer exists in `properties`,
which is why `required: ['rows']` triggers an "extra required key"
complaint. We confirmed this with the two follow-up isolation trials
(Q1a single-object, Q1b array-of-objects) — both fail identically with
or without the array wrapper.

Strict mode requires every object to be closed (`additionalProperties:
false`). Typed `additionalProperties` is treated as a schema-shape that
strict mode cannot validate, so it rejects the schema at compile time.

**Implication**: `z.record(z.string())` for ComparisonTable.rows must
be expressed via the flat-list fallback at the wire-schema boundary.

### case2 (fallback) — accepted output sample (truncated)

```json
{
  "diagrams": [{
    "kind": "ComparisonTable",
    "title": "Database Engine Comparison",
    "columns": ["Engine", "Data Model", "Consistency"],
    "rows": [
      { "cells": [
        {"column": "Engine", "value": "PostgreSQL"},
        {"column": "Data Model", "value": "Relational"},
        {"column": "Consistency", "value": "Strong"}
      ]},
      { "cells": [
        {"column": "Engine", "value": "MongoDB"},
        {"column": "Data Model", "value": "Document"},
        {"column": "Consistency", "value": "Eventual"}
      ]},
      { "cells": [
        {"column": "Engine", "value": "Redis"},
        {"column": "Data Model", "value": "Key-Value"},
        {"column": "Consistency", "value": "Eventual"}
      ]}
    ]
  }]
}
```

The translator (`fromWire`) needs ~10 LoC to reduce each row's `cells[]`
into the `Record<string,string>` shape that `ComparisonTableSchema`
expects.

---

## Q2 verdict — **REJECT**

`$ref` recursion is **effectively rejected** by OpenAI strict-mode. The
behavior is *not* a clean 400 error at compile time — instead the API
hangs and never returns. Two independent observations:

1. **case3** (full DecisionTree schema with `$ref`): client-side 60-s
   timeout fired with no response.
2. **Q2a follow-up** (minimal `$ref` recursion in isolation): client-side
   **180-s timeout** fired with no response.

This is worse than case1's clean rejection — it costs latency and consumes
client-timeout budget. **Wave 1 must not ship `$ref` recursion** under any
strict-mode response_format.

For DecisionTree we use the adjacency-list fallback (case4): a flat
`nodes[]` with string `yesId` / `noId` pointers and a top-level `rootId`.
Empty-string sentinel for "no child" / "no question" / "no leaf" (strict
mode forces every property listed in `required` to be present, so we
can't simply omit them). The translator (`fromWire`) walks the
adjacency list from `rootId` and re-builds the recursive Zod shape; it
drops empty-string leaves into leaf-nodes and empty-string questions
into branch-nodes, so the Zod union discriminator (`leaf` vs `question +
yes + no`) resolves correctly.

### case4 (fallback) — accepted output sample (truncated)

```json
{
  "diagrams": [{
    "kind": "DecisionTree",
    "title": "Database Type Selector",
    "rootId": "1",
    "nodes": [
      { "id": "1", "question": "Do you require complex queries?",
        "leaf": "", "yesId": "2", "noId": "3" },
      { "id": "2", "question": "Is data structured?",
        "leaf": "", "yesId": "4", "noId": "5" },
      { "id": "3", "question": "Do you need scalability?",
        "leaf": "", "yesId": "6", "noId": "7" },
      { "id": "4", "question": "", "leaf": "SQL", "yesId": "", "noId": "" },
      { "id": "5", "question": "", "leaf": "Consider other SQL options",
        "yesId": "", "noId": "" },
      { "id": "6", "question": "", "leaf": "NoSQL Document Store",
        "yesId": "", "noId": "" },
      { "id": "7", "question": "", "leaf": "Key-Value Store",
        "yesId": "", "noId": "" }
    ]
  }]
}
```

Translator must handle:
- empty-string `question` → indicates a leaf node
- empty-string `leaf` → indicates an internal node
- empty-string `yesId` / `noId` on leaves (ignored)
- missing `id` → surface as ExtractParseError
- cycle in pointer graph → bounded recursion depth (≤8) in the translator;
  surface as ExtractParseError if exceeded

---

## Strict-mode "every-property-required" rule (cross-cutting)

A second non-obvious strict-mode rule surfaced repeatedly during this
spike: **every key in `properties` must appear in `required`** — strict
mode does not permit optional fields. This forces:

- TitleString (currently optional in Zod) must be present in the wire
  schema; the LLM emits `""` and the translator strips empty strings
  before Zod parse.
- DecisionNode.question / .leaf / .yes / .no must all be required in the
  wire schema (the translator decides leaf-vs-internal by inspecting
  which field is non-empty).
- Same will apply to every other primitive (`direction` on DiagramFlow,
  `initial` / `terminal` on StateTransitionDiagram, `trigger` on
  transitions, `label` on edges, `kind` on flow-nodes, `kind` on
  sequence-messages).

This is mechanical translator work but adds ~30-40 LoC across the wire
schema to handle the "absent" → "" sentinel pattern. The translator's
`fromWire` strips empty-string optional fields before handing to Zod;
the `toWire` direction fills in `""` for absent optional fields.

---

## Recommended wire-schema strategy for Wave 1

**Both Q1 and Q2 require fallbacks. Use both flat-list fallbacks.**

Per the RFC's `wire-schema.ts` LoC estimate: **~150 LoC total**.

Concrete shape decisions for Wave 1's `src/lib/diagrams/wire-schema.ts`:

1. **All objects close**: every object literal in the wire schema has
   `additionalProperties: false` and every property key listed in
   `required`. No `additionalProperties: { type: ... }` anywhere.
2. **Optional fields become empty-string sentinels**: TitleString,
   DiagramFlow.direction (default `"LR"`), DiagramFlow.nodes[].kind,
   DiagramFlow.edges[].label, StateTransition states[].initial/terminal,
   StateTransition transitions[].trigger, SequenceDiagram messages[].kind.
   The translator `fromWire` strips these before Zod parse.
3. **ComparisonTable rows**: wire-shape `Array<{ cells: Array<{column:
   string, value: string}> }>`. Translator `fromWire` reduces each row's
   `cells[]` into a `Record<string,string>` Zod input. **~10 LoC.**
4. **DecisionTree**: wire-shape `{ rootId: string, nodes: Array<{id,
   question, leaf, yesId, noId}> }` (all five strings required, empty
   means "absent"). Translator `fromWire` does depth-bounded
   adjacency-list traversal from `rootId`. **~40 LoC including cycle/
   depth guards.**
5. **discriminatedUnion → oneOf with const discriminator**: 6 branches;
   each branch object closed. Wave 1 builders A + B coordinate on the
   exact branch field-orderings.

**Total Wave-1 wire-schema.ts: ~150 LoC** (RFC's worst-case estimate;
both fallbacks needed).

---

## Total spike cost: $0.000250

(Plus zero billable cost for the two follow-up trials that timed out
or were rejected at compile.)

---

## Verified

The four primary fixtures + three follow-up trials captured under
`_inspect/sprint-h/`:

- `spike-jsonschema.log` — primary spike output, all 4 cases with
  acceptance/rejection + full LLM output JSON for cases 2 + 4
- `spike-jsonschema-followup.log` — Q1a/Q1b/Q2a isolation runs
- `spike-jsonschema.ts` + `spike-jsonschema-followup.ts` — the throwaway
  scripts themselves

Concretely:

- **case1**: rejected with 1,204 ms latency; error message recorded
  verbatim above; this and Q1a + Q1b isolation trials triangulate the
  root cause as "strict mode silently strips properties using typed
  additionalProperties; that property then appears as an 'extra required
  key' to the validator." Reproducible: same error every call.
- **case2**: accepted; gpt-4o-mini emitted a clean 3-engine /
  3-column / 3-row comparison; full JSON output round-trips through the
  translator-then-Zod chain (`ComparisonTableSchema.safeParse` returned
  `success: true` after translator collapsed `cells[]` into row records).
- **case3** + **Q2a**: timed out at 60 s and 180 s respectively with no
  API response. The strict-mode compilation step never completed. **No
  recursive `$ref` schema in Wave 1.**
- **case4**: accepted; gpt-4o-mini emitted a 7-node decision tree
  (3 internal nodes, 4 leaves) using empty-string sentinels for absent
  fields; translator rebuilt the recursive tree and `DecisionTreeSchema.
  safeParse` returned `success: true`.

Wave 1 unblocked. Builder B's `wire-schema.ts` target is ~150 LoC with
both flat-list fallbacks; no further schema-compat investigation needed.
