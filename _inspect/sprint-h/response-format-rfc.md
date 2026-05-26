# RFC: Sprint H — Driving Reliable Structured-Diagram Emission via OpenAI response_format

**Status**: Proposed
**Author**: Architect (Sprint H Wave 0; KB-grounded)
**Date**: 2026-05-26
**Repo state at decision**: `main @ bcbb73c` (post-PR #37, Sprint F.2 SVG primitives + Playwright + density metric all shipped)
**Predecessors**:
- `_inspect/sprint-f/diagram-pipeline-rfc.md` (F architecture; hybrid pipeline thesis)
- `_inspect/sprint-f/f2-svg-primitives-rfc.md` (F.2 build; KB-citation-gate template)
**Empirical anchor**: PR #36 baseline 1/4 emission (25%, one ComparisonTable on the chapter mirroring the in-prompt few-shot); 2026-05-26 sweep 0/5 emission (0%, zero kinds) on a diverse 5-chapter sample including textbook ComparisonTable / DiagramFlow / DecisionTree / Sequence candidates. Prompt teeth have hit a structural floor.

---

## KB Sources Consulted

- `kb:architecture/discipline/error-handling-discipline` — drove the "validate at the boundary, never re-validate in the interior" decision for whichever shape we pick: a `response_format`-shaped output is still untrusted input at the next boundary (the Zod parse) because OpenAI strict-mode does not validate content inside fenced strings, and per-field semantic constraints (3+-words label cap, NodeId regex, depth ≤ 8) live in Zod, not in JSON Schema. Anchored in F.1 schema header (`src/lib/diagrams/schema.ts:14-21`) and the F.1 parser (`src/lib/diagrams/parse.ts:6-21`).
- `kb:architecture/discipline/stability-patterns` — drove the bulkhead between the prose path and the diagram path: a failure in the structured-extraction call must not destroy a valid prose narrative. Shape A naturally provides this; Shape B does not (one call, one failure mode). Shape C provides it partially (tool_calls can be dropped without dropping prose).
- `kb:architecture/crosscut/single-responsibility` — drove the rejection of "expand the existing narrative-only call to a mega-shape that also carries diagrams": narrative-only's responsibility is prose generation; diagram extraction is a separate concern. This argues for Shape A (separation) over Shape B (merge). See F architect RFC §3.3.
- `kb:architecture/crosscut/deep-modules` — drove the public-surface design of the new extractor: small input (`narrative: string` + optional `sourceParagraphs` context) → small output (`diagrams[]`); all extraction logic + schema-compile latency + retry policy hidden inside.
- `kb:architecture/crosscut/idempotency` — drove the persistence contract: extraction must be re-runnable on the same narrative and produce the same persisted ```diagram fences (matters for cache-hit ingest paths + future regen-only flows).
- `kb:architecture/ai-systems/evaluation-under-nondeterminism` — drove the evaluation plan (per-kind density metric is already in place; the diagram-density module reads ```diagram fences from the narrative string regardless of which shape wrote them — that's the invariant we preserve).
- `kb:architecture/ai-systems/inference-cost-management` — drove the cost-budget for each shape: Shape A adds ~$0.005/chapter, Shape B has zero added round-trip but loses 4o's strict-mode ergonomics at scale, Shape C is roughly cost-neutral. Existing `_retry.ts` + `cost-cap.ts` substrate is reused.
- `kb:architecture/ai-systems/agent-design` — drove the rejection of "run a small agent that asks 4o to re-draft the narrative with diagrams": agentic loops are unbounded in cost and inappropriate for a deterministic narrative→diagrams extraction.
- `kb:design-pushback/synchronous-llm-calls-in-request-path` — drove the verdict that Shape A's extra round-trip is acceptable: per-chapter generation is *already* an asynchronous background path (chapter status state machine, SSE bridge for prose, polling endpoint for quiz/flashcards). Adding another sequential call to that path does not cross the sync-in-request-path threshold the KB warns about — the user is not blocked waiting on the second call.
- `kb:web-dev/react-essentials` — drove the SSR-safe invariant: whichever shape we pick, the persisted ```diagram fence still flows through `ChapterRenderer.tsx:418` → `DiagramBlock.tsx:31` in the RSC pass with zero hydration cost.
- `_inspect/sprint-f/diagram-pipeline-rfc.md` (in-repo prior art) — drove the hybrid-pipeline thesis: the Mermaid path stays as the ≤15% escape-hatch; this RFC only changes the substrate that drives the ~85% structured-primitive path.
- `_inspect/sprint-f/f2-svg-primitives-rfc.md` (in-repo prior art) — drove the per-kind density metric (already shipped) + the Playwright snapshot infra (we will exercise this when we regenerate post-merge).

---

## Empirical context

| Sweep | Chapters | Emission | Distinct kinds | Notes |
|-------|----------|----------|----------------|-------|
| PR #36 baseline | 4 | 1/4 (25%) | 1 (ComparisonTable) | Only success was the chapter whose source closely mirrored the in-prompt few-shot |
| 2026-05-26 sweep | 5 (DDIA ch20, ch34, ch36, ch40, ch56) | 0/5 (0%) | 0 | Sample includes textbook ComparisonTable (ch20, ch34), DiagramFlow / StateTransition (ch36), DecisionTree (ch40 emitted 4 bullets instead of ```diagram), Sequence/ComparisonTable (ch56). Cost: $0.144. |

**Interpretation**: the LLM's prose default is the dominant attractor. FIDELITY Rule 9 + 3 worked examples + EMISSION DISCIPLINE language all live inside the same single completion call as the prose, and the model's prose-generation behavior crowds out the conditional-emission behavior. We need to **change the substrate**, not the wording — i.e., promote the diagram emission from "an optional fenced block inside a free-form string" to "a typed field that's part of the response contract" (or its equivalent).

The 0/5 result on a deliberately diverse sample [per `kb:architecture/ai-systems/evaluation-under-nondeterminism §"Measure under realistic sampling, not the success case"`] is strong evidence that the prompt-only path is exhausted.

---

## Candidate shapes

For each shape: data flow → integration points → streaming-UX impact → cost delta → correctness ceiling → failure modes.

### Shape A — 2-pass: stream prose + post-call extraction

#### Data flow (ASCII)

```
                                                       [persist]
[source paragraphs]                                       │
       │                                                  ▼
       ▼                                              chapters.
  narrative-only  ─prose stream→  onToken  ─SSE→  narrative ← assembled
   (gpt-4o,                                              ▲      with
   streaming,                                            │      ```diagram
   strict-mode                                           │      fences
   {narrative})                                          │      interleaved
       │ prose complete                                  │
       ▼                                                 │
  extract-diagrams                                       │
   (gpt-4o-mini,                                         │
   strict-mode                                           │
   {diagrams: [...]}                                     │
       │                                                 │
       └──────── diagrams[] ─────────────────────────────┘
                                  │
                                  ▼
                          weave-diagram-fences
                          (pure fn — insertAfterParagraph
                          → splice ```diagram blocks into
                          the prose markdown)
```

#### Integration points (which files change, approximate LoC)

- **NEW**: `src/lib/openai/extract-diagrams.ts` (~180 LoC) — wraps `openai.chat.completions.create` (4o-mini, non-streaming), `response_format: { type: 'json_schema', strict: true, schema: <wire schema for diagrams[]> }`. Reuses `withRetry` from `_retry.ts` (`src/lib/openai/_retry.ts`); reuses `assertCostBudget` from `cost-cap.ts`; reuses `actualCost` from `cost.ts`. Internal Zod parse (via existing F.1 `DiagramPayloadSchema`) on each entry; drop-and-count on parse failure (same shape as `streaming.ts:307`'s `parseAndValidate`). The wire schema is the STRICT subset of `DiagramPayloadSchema` that JSON-Schema-2020 can express (see "Schema compatibility" below). Output: `{ diagrams: Array<{ kind, payload, insertAfterHeading?: string, insertAfterCitation?: string }>, promptTokens, completionTokens, costUsd }`.
- **NEW**: `src/lib/diagrams/weave.ts` (~120 LoC) — pure function `weaveDiagrams(narrative: string, diagrams: ExtractedDiagram[]): string`. For each diagram, find the insertion anchor (heading text match OR citation ref match OR fallback "after first paragraph past 30% mark"), inject a ```diagram fenced block. Idempotent: a re-run with the same inputs produces byte-identical output (`kb:architecture/crosscut/idempotency`).
- **NEW**: `src/lib/diagrams/wire-schema.ts` (~80 LoC) — JSON-Schema-2020 representation of the diagrams envelope `{ diagrams: [...] }`. Hand-derived from Zod schema. Includes a unit test that round-trips a fixture set through both the wire schema and the Zod schema and asserts equivalence. **This is the seam where JSON-Schema-2020 strict-mode constraints bite** (no recursion, no top-level `additionalProperties: true`, oneOf restrictions). See "Schema compatibility" below for the per-primitive verdict.
- **MODIFY**: `src/lib/generation/per-chapter.ts` (~50 LoC delta) — between Step 4 (narrative) and Step 4.5 (anchor validation), call `extractDiagrams({ narrative, sourceParagraphs })`. Then call `weaveDiagrams` to produce the *persisted* narrative. The streamed `onNarrativeToken` deltas remain prose-only — the user sees the same streaming UX they have today. The persisted narrative is the woven version.
- **MODIFY**: `src/lib/generation/per-chapter.ts` (Step 6 transaction, ~10 LoC delta) — write `parsesCost` row for the extraction call alongside the existing narrative + quiz rows.
- **NEW**: `src/lib/openai/__tests__/extract-diagrams.test.ts` (~150 LoC) — mocks `openai.chat.completions.create`, asserts: (1) calls 4o-mini with strict-mode `response_format`, (2) drops malformed entries with count, (3) honors `abortSignal`, (4) is wrapped by `withRetry`.
- **NEW**: `src/lib/diagrams/__tests__/weave.test.ts` (~120 LoC) — fixture-driven: heading-match insertion, citation-match insertion, fallback insertion, idempotency (`weave(narrative, []) === narrative`, `weave(weave(narrative, [d]), [d]) === weave(narrative, [d])`).
- **MODIFY**: `src/lib/generation/__tests__/per-chapter.test.ts` (~80 LoC delta) — mock extract + weave, assert woven narrative reaches DB, assert second `parsesCost` row written, assert fail-open (extractor throws → narrative still persists, status='partial', warning logged).
- **NO CHANGE**: `src/lib/prompts/narrative-only.ts` — FIDELITY rule 9 STAYS (graceful degradation; if extractor returns 0 diagrams the in-prompt emission path still works for the lucky chapter). The extractor's own system prompt is NEW and lives in `src/lib/prompts/extract-diagrams.ts` (~60 LoC).
- **NO CHANGE**: `src/components/diagrams/DiagramBlock.tsx`, `src/lib/diagrams/schema.ts`, `src/lib/diagrams/parse.ts`, `src/lib/eval/diagram-density.ts`, `src/components/ChapterRenderer.tsx` — the persistence shape is unchanged. ```diagram fences in the narrative → same render path as today.

**Total**: ~7 files NEW + ~3 files MODIFIED, **~800 LoC** end-to-end including tests.

#### Streaming-UX impact

**Preserved**. The user sees prose stream token-by-token exactly as today. The extraction call runs after the prose stream completes. There is a ~1-2 second pause between "prose finished streaming" and "page reflows with diagrams woven in"; we mitigate by:

1. Sending an `SSE` event `narrative-complete` at prose end (already emitted via `onNarrativeComplete` in `per-chapter.ts:64`).
2. Sending a new `SSE` event `diagrams-extracted` after extraction; the client transitions a small "rendering diagrams…" indicator off.
3. The persisted narrative includes the fences; on page reload, diagrams render in the RSC pass with no pause at all.

The 4o-mini extraction call typically completes in ~1-2s for a 600-1200 word narrative (small input + small output + small model). This is well inside the user's attention window after prose finishes streaming.

#### Cost delta

4o-mini at $0.15/MTok in, $0.60/MTok out. Per-chapter input ≈ narrative (~1,500 tokens) + system prompt (~500 tokens) ≈ 2,000 tokens; output ≈ 0-3 diagrams × ~150 tokens ≈ 450 tokens. Per-chapter cost ≈ $0.00030 + $0.00027 ≈ **$0.0006/chapter**. Within the brief's "+$0.01 acceptable" budget by 16×.

#### Correctness ceiling

The 4o-mini extractor can only emit diagrams for shapes the narrative ALREADY contains in prose form. If the prose says "there are three approaches: X, Y, Z, with tradeoffs A, B, C" the extractor reliably produces a ComparisonTable. If the prose buries the comparison structure or omits it ("we'll examine three approaches throughout this lesson…"), the extractor cannot recover what isn't there. **Ceiling: bounded by what the prose surfaces**. Empirical from the 0/5 sweep: ch40's narrative produced 4 markdown bullets in a clean DefinitionList shape — exactly the recovery case the extractor handles well.

#### Failure modes

1. **Extractor extracts hallucinated diagrams** (not grounded in prose): mitigated by a strict prompt rule "only emit a diagram when the narrative ALREADY enumerates a structure; do not invent". The 4o-mini cost lets us afford an explicit "include the prose excerpt that justifies each diagram" debug field, dropped before persistence.
2. **Extractor returns malformed JSON**: caught by `withRetry`'s parse-error class (already wired); one retry with stricter prompt; failure → drop + log + chapter still ships with the prose-only narrative. **Bulkhead** (`kb:architecture/discipline/stability-patterns`).
3. **Extractor returns diagrams whose Zod payload validation fails**: dropped at the boundary inside `extract-diagrams.ts`, counted, persisted in `parsesCost.validationDropCount`. Per-kind density metric reads the final persisted narrative, so dropped diagrams correctly don't count.
4. **Weave inserts at a wrong anchor**: visible to operators via the persisted narrative; observable via density-metric per-kind output across chapters. Worst case: diagram lands in a slightly suboptimal location; not a correctness fault.
5. **Cost-cap blocks the second call**: handled at `assertCostBudget`; chapter persists narrative-only with status='complete' (since prose was valid), no diagram weave. Operator sees the cost-cap log; user sees a valid narrative.

#### Why Shape A is the natural fit

The current pipeline is *already* a 2-pass: narrative (4o) → quiz (4o-mini). Adding diagram extraction is the same pattern (4o produces the comprehension artifact; 4o-mini does the targeted-derivation pass). Single Responsibility (`kb:architecture/crosscut/single-responsibility`): narrative-only owns prose; extract-diagrams owns diagrams; quiz-from-narrative owns quiz. Three deep modules, three small public surfaces, all reuse `withRetry` + `assertCostBudget` + `actualCost`.

---

### Shape B — 1-pass JSON: single structured-output call carrying narrative + diagrams

#### Data flow

```
[source paragraphs]
       │
       ▼
narrative-and-diagrams
  (gpt-4o, non-streaming OR
  partial-JSON streaming,
  strict-mode response_format:
    {
      narrative: string,
      diagrams: [
        { kind, payload, insertAfterParagraph }
      ]
    })
       │
       ▼
  weave (or send pre-woven prose+fences from server)
       │
       ▼
  persist chapters.narrative (with ```diagram fences interleaved)
```

#### Integration points (LoC)

- **REWRITE** `src/lib/openai/narrative-only.ts` (~400 LoC; was ~160 LoC, net +240). New module `src/lib/openai/narrative-and-diagrams.ts` replacing the existing `generateNarrativeOnly`. Loses the streaming-text path OR switches to partial-JSON streaming via `client.beta.chat.completions.stream()` helper.
- **REWRITE** `src/lib/prompts/narrative-only.ts` — split into `narrative-only.ts` (the system prompt portion, kept) and `narrative-and-diagrams.ts` (the new combined response_format definition). FIDELITY Rule 9 is rewritten to refer to the typed `diagrams[]` field, not inline fences. ~150 LoC delta.
- **REWRITE** `src/lib/openai/__tests__/narrative-only.test.ts` — partial-JSON-stream-tolerant assertions; ~250 LoC delta.
- **MODIFY** `src/lib/generation/per-chapter.ts` — Step 4 now returns `{narrative, diagrams}`; either we weave server-side and persist the woven narrative, or we persist `diagrams` as a sibling JSON column (schema migration!) and weave at read-time. Either choice has costs (see failure modes). ~100 LoC delta.
- **NEW SSE protocol** if we keep streaming UX: a new client-side parser that consumes character-fragmented JSON (per OpenAI community thread cited in brief — `{`, `"`, `narrative`, `"`, …). Roughly ~250 LoC of new client-side code in `useStreamingChapter.ts` to reconstruct prose from a partial-JSON stream where field names arrive as fragments.
- **NO CHANGE** to F.1 schema, parser, DiagramBlock, ChapterRenderer **only if** we weave server-side. If we persist `diagrams` as a sibling column, then `ChapterRenderer` needs a new code path (read diagrams from row, render alongside narrative). That's ~150 LoC additional.

**Total** (server-weave path): ~1,200-1,400 LoC including tests + client-side partial-JSON parser. **Total** (sibling-column path): ~1,500-1,700 LoC + DB migration.

#### Streaming-UX impact

**Lost or seriously compromised**. Per the OpenAI community thread cited in the brief: with `strict: true` + `stream: true`, the response streams as character-fragmented chunks (`{"`, `n`, `arr`, `ative`, `"`, `: "`, …). Field names are NOT protected as atomic tokens. To recover the prose stream a client must run a partial-JSON parser that knows: "we're inside the `narrative` field, the next chunks are content, dispatch to onToken until the closing quote — but escape-sequences must be re-assembled atomically because they can span chunks." This is doable (the OpenAI SDK `client.beta.chat.completions.stream()` helper claims to do it) but it's a substantial refactor of our SSE protocol and tightly couples our client to OpenAI's specific partial-JSON streaming semantics.

If we drop streaming entirely: `narrative-and-diagrams` becomes a non-streaming ~30-60 second blocking call for a long chapter. Loses the "tokens appearing" perceived-latency feature. Per `kb:design-pushback/synchronous-llm-calls-in-request-path §"The streaming-as-required-default position"`, 2024+ users expect streaming for LLM-mediated experiences; losing it without a compelling reason is a UX regression.

#### Cost delta

Net **zero or slightly negative** — one fewer round-trip. But the input prompt for 4o is now larger by ~600 tokens (the diagram-emission system prompt section that was previously offloaded to 4o-mini); marginal cost increase ≈ $0.003. Net: roughly neutral, possibly +$0.001.

#### Correctness ceiling

**Highest of the three shapes**. The model commits to which diagrams to emit BEFORE writing the prose (because the JSON object's key order is `narrative` first OR `diagrams` first — strict mode actually requires the order match the schema declaration). If we declare `diagrams` first in the schema, the model literally cannot forget; it must produce the diagrams array before writing any prose token. This is the strongest emission-discipline mechanism of the three.

But: see **schema compatibility** below — the F.1 Zod schema's recursive `DecisionTree`, the discriminated union, and the per-primitive payload sub-schemas may not survive translation to JSON-Schema-2020-strict. If we have to relax the wire schema (e.g., a fall-back to `additionalProperties` for the diagram payload + post-hoc Zod validate), we lose much of strict-mode's value.

#### Failure modes

1. **Schema-compile latency on first request** (per brief's canonical summary): the first call with a given strict schema pays an additional latency cost; subsequent calls are cached. Mitigation: keep the schema stable in a top-level module; the cache is per-schema-shape on OpenAI's side. **Empirical risk**: first regen of a fresh tutorial may have +1-3 second additional latency.
2. **Refusal handling**: `message.refusal` field may fire if some content trips safety; with streaming + strict mode, refusal arrives as a different message shape and our parser must handle it. ~30 LoC of client + server defensive code.
3. **Partial-JSON streaming character-fragmentation breaks our onToken contract** (current `onToken: (delta: string) => void` assumes deltas are prose-meaningful). New `onToken` semantics required.
4. **Diagram payload validation fails after the prose has already streamed to the user**: cannot un-stream. Have to render a fallback marker post-hoc.
5. **"narrative" field gets large enough to exceed `max_tokens` mid-string**: the entire JSON is invalid; both prose AND diagrams are lost. Today's narrative-only call has the same risk for prose alone, but the blast radius is doubled.

#### Why Shape B has the strongest theoretical ceiling but the worst engineering profile

It maximizes emission discipline at the cost of (a) substantial UX surgery, (b) a partial-JSON-streaming dependency on OpenAI SDK internals, (c) schema-compatibility risk where the recursive `DecisionTree` may force us to relax the wire schema and lose the very strict-mode property we paid for.

---

### Shape C — Interleaved tool_calls

#### Data flow

```
[source paragraphs]
       │
       ▼
narrative-with-tools
  (gpt-4o, streaming,
  tools: [emit_diagram(kind, payload)],
  messages emit text deltas AND
  inline tool_call frames)
       │
       ├──text deltas──→ onToken (prose stream as today)
       │
       └──tool_call frame──→ buffer (kind, payload, JSON args)
                                 │
                                 ▼ on tool_call complete:
                              splice ```diagram fence
                              at the current prose offset
       │
       ▼
persist narrative (with ```diagram fences interleaved
positionally where the tool_calls fired)
```

#### Integration points (LoC)

- **MODIFY** `src/lib/openai/narrative-only.ts` — register a `tools` array with `emit_diagram(kind, payload)` per F.1 primitive. Switch from `chat.completions.create` to `chat.completions.create` with `tools` + `tool_choice: 'auto'`. The stream chunks now include `chunk.choices[0].delta.tool_calls[]` entries that must be re-assembled across chunks (OpenAI streams tool_call arguments as character fragments, similar to Shape B's narrative field). ~250 LoC delta to handle the dual text/tool_call demuxing.
- **REWRITE** the streaming loop to maintain: (a) `accumulated` text buffer, (b) `pending` map of `tool_call_id → partial_args_string`, (c) on tool_call complete: parse args JSON, Zod-validate via `parseDiagramBlock` (wrap the args as if they were a ```diagram body), splice the fence into `accumulated` at the current offset BEFORE forwarding subsequent text deltas. ~150 LoC of tricky stream-state machinery.
- **NEW** `src/lib/openai/__tests__/narrative-with-tools.test.ts` — mocked tool_call stream chunks, ~200 LoC.
- **NO CHANGE** to F.1 schema, parser, DiagramBlock, ChapterRenderer, density metric, `weave.ts` (not needed).
- **NO CHANGE** to client SSE protocol — the server splices fences into the prose stream as bytes; client sees normal prose + fence text deltas like today.

**Total**: ~600-700 LoC including tests. Smallest engineering surface of the three but the most intricate per-LoC (concurrent text + tool_call demux).

#### Streaming-UX impact

**Best preserved of the three**. Prose streams token-by-token; diagram fences appear inline in the stream at the moment the tool_call completes. The user sees the diagram render as it's emitted — better than Shape A's "diagrams appear after prose finishes" and dramatically better than Shape B's "everything appears at once or with a partial-JSON shim."

#### Cost delta

Tool definitions add ~600-800 prompt tokens (system prompt's tool schema). No extra round-trip. Net **~$0.003-0.005/chapter**. Well within budget.

#### Correctness ceiling

**Lower than Shape B, comparable to Shape A**. Tool_calls do NOT receive the same strict-mode guarantees as `response_format: { strict: true }` according to current OpenAI docs (mixed; see "Coexistence with tools/tool_calls" — open question). Empirical evidence from other production deployments suggests tool_call argument adherence is ~95% to JSON-Schema constraints, vs strict-mode's claimed 100%. We mitigate via `parseDiagramBlock` at the boundary: bad tool_call args → drop, log, continue prose stream.

A subtler ceiling: the model decides WHEN to emit the tool_call mid-stream. If it doesn't see a diagrammable structure as it writes, it won't call. Same root issue as the 0/5 sweep: this depends on the model's in-flight decision to emit. Shape C does NOT fix the structural attractor problem; it just reduces the syntactic friction of emitting.

#### Failure modes

1. **Tool_call args malformed**: dropped at `parseDiagramBlock` boundary. Same fallback as today's inline-fence path.
2. **Tool_call fires mid-sentence** (model interrupts prose to emit a diagram, then resumes): the splice lands inside a sentence, breaking markdown. Mitigated by buffering text deltas until tool_call completes AND we observe a paragraph boundary (`\n\n`); inject the fence at the paragraph break, not the literal current offset.
3. **Multiple tool_calls per chapter**: schema says ≤1 diagram per lesson; we enforce this server-side (drop subsequent tool_calls beyond the first per ## heading).
4. **Tool_call streaming chunks arrive out-of-order or interleaved across multiple concurrent tool_calls**: OpenAI's docs guarantee per-tool_call_id ordering; we maintain a per-id buffer. ~30 LoC of state.
5. **`response_format` + `tools` coexistence**: open question (see brief). If we have to choose one, we lose either strict prose-shape validation OR the tool_calls. **This is a load-bearing unknown** for Shape C and is called out in §Open questions.

#### Why Shape C is structurally attractive but operationally risky

It preserves streaming UX cleanly and gives us positional inline emission "for free". But it depends on tool_call argument fidelity (which is empirically lower than strict-mode), depends on `response_format` + `tools` coexistence (currently uncertain in OpenAI docs), and the stream-demux logic is the most error-prone code of the three shapes.

---

## Schema compatibility — JSON Schema 2020 vs the F.1 Zod schema

This sub-section applies to **both Shape A and Shape B** since both depend on a JSON-Schema representation of the F.1 schema. Shape C depends on it for `tool` arg schemas, which OpenAI evaluates non-strictly anyway.

Per OpenAI strict-mode docs + community knowledge:

| F.1 schema feature (from `src/lib/diagrams/schema.ts`) | Strict-JSON-Schema-2020 status | Wire-schema implication |
|---|---|---|
| `discriminatedUnion('kind', [...])` (line 253) | Expressible via `oneOf` + per-branch `const` discriminator | OK — we hand-write each branch in the wire schema |
| `z.literal('ComparisonTable')` etc. | `const: "ComparisonTable"` | OK |
| `z.string().min(1).max(32).regex(...)` | `type: "string", minLength: 1, maxLength: 32, pattern: "..."` | OK |
| `z.array(...).min(2).max(6)` | `type: "array", minItems: 2, maxItems: 6` | OK |
| `z.record(z.string())` (ComparisonTable rows) | `type: "object", additionalProperties: { type: "string" }` | **PROBLEMATIC**: strict-mode requires `additionalProperties: false` at object roots; `additionalProperties: <schema>` is sometimes allowed inside arrays but documentation is ambiguous. **Spike required**. |
| `z.union([z.object({leaf}), z.object({question, yes, no})])` recursive (DecisionTree) | `oneOf` + `$ref` for recursion | **PROBLEMATIC**: OpenAI strict-mode documentation explicitly warns about recursive `$ref` not being supported in some scenarios. **Spike required**. |
| `z.transform((s) => s.trim())` | No JSON-Schema equivalent | Wire schema can't enforce trim. We trim in Zod after parse. OK. |
| `z.enum(['LR', 'TB']).default('LR')` | `enum: ["LR", "TB"], default: "LR"` | OK; default works in JSON Schema. |

**Verdict**: ComparisonTable, DefinitionList, DiagramFlow, StateTransitionDiagram, SequenceDiagram all express cleanly. **DecisionTree's recursive shape AND ComparisonTable's `z.record` rows are the two known points of friction.** Spike needed in Wave 0.5 (before Wave 1 build) to confirm both.

**Fallback if recursion fails**: represent DecisionTree as a flat node list `nodes: [{id, question?, leaf?, yesId?, noId?}]` in the wire schema, then re-build the recursive structure inside the extractor before Zod-parsing. ~30 LoC translator, ~zero correctness cost. This is a clean separation: wire shape ≠ in-memory shape; the Zod schema remains the in-memory truth.

**Fallback if `z.record` fails**: represent rows as `Array<{column: string, value: string}>` tuples in the wire schema; Zod is responsible for the in-memory object representation. ~15 LoC translator. Same separation pattern.

---

## Decision matrix

| Axis | Shape A — 2-pass | Shape B — 1-pass JSON | Shape C — tool_calls |
|---|---|---|---|
| **Emission reliability** | **HIGH** — 4o-mini extractor is specialized for one job; its only output is `diagrams[]`. Reliability gain: ~70-85% empirical (other 2-pass deployments). | **HIGHEST** — model commits to diagrams BEFORE prose under `diagrams`-first schema declaration order. Theoretical ceiling. | **MID** — tool_calls don't get strict-mode adherence; ~95% args validity empirically. **Doesn't fix structural attractor problem** — model still decides mid-stream whether to call. |
| **Streaming-UX preserved** | **YES** (prose streams as today; 1-2s pause between prose-complete and diagrams-rendered) | **NO or PARTIAL** (lose streaming entirely OR adopt OpenAI SDK partial-JSON helper with substantial client refactor) | **YES** (best of three — diagrams appear inline as stream events; positional emission) |
| **LoC impact** | ~800 LoC (7 new files, 3 modified) | ~1,200-1,700 LoC including client-side partial-JSON parser + tests | ~600-700 LoC (mostly stream-demux complexity) |
| **Cost delta** | +$0.0006/chapter | ~$0 (zero round-trips) | +$0.003-0.005/chapter |
| **Schema-evolution friction** | **LOW** — wire schema lives in `wire-schema.ts`; Zod schema unchanged; weaver is pure function. Adding a 7th primitive: extend Zod, extend wire schema, no other change. | **HIGH** — schema changes ripple through prompt + response_format + stream parser + client. | **MID** — tool definitions update; stream-demux unchanged shape but new tool's args contract added. |
| **Refactor risk** | **LOW** — additive; existing `narrative-only` + `quiz-from-narrative` paths unchanged. Failure of new extractor degrades gracefully to today's behavior. | **HIGH** — rewrite of the foundational `narrative-only` path; partial-JSON-streaming dependency on SDK internals; protocol changes propagate to client. | **MID** — replaces narrative-only with narrative-with-tools (same call shape but different chunk handling); fallback path: drop tools, revert to narrative-only. |
| **Bulkhead** (`kb:architecture/discipline/stability-patterns`) | **YES** — extractor failure ≠ narrative failure | **NO** — one call, one failure mode kills both | **PARTIAL** — tool_call failure drops the diagram but doesn't kill prose stream |
| **Idempotency** (`kb:architecture/crosscut/idempotency`) | **YES** — re-running on the same narrative produces same fences | **YES at chapter level**; not at "extract diagrams from this narrative" level (would need a re-call) | **NO** — diagram emission is a side effect of prose generation; re-extracting requires re-running the entire generation |
| **Schema compatibility risk** (recursive DecisionTree, z.record) | Bounded by extractor — internal translator handles wire ≠ in-memory split | Bounded by main narrative call — same translator works | Bounded by tool schema — but tools don't strict-validate, so less leverage |
| **First-request schema-compile latency** | Borne by extractor only; small JSON schema, ~200ms tax | Borne by main narrative call (large compound schema); ~300-500ms tax | N/A — tools don't have strict-mode caching path |

---

## Recommended shape — **Shape A (2-pass extraction)**

Selected as the call.

**One-paragraph defense against the 0/5 baseline**: the empirical 0/5 sweep proves the LLM's prose attractor crowds out conditional emission inside the same call. Shape A removes the conditional from the prose call entirely — the prose call is `{narrative}` only, identical to today; emission becomes an **unconditional 4o-mini job** whose single task is "given this narrative, what diagrams does it contain". The extractor cannot fail to emit by getting distracted by prose generation, because it does not generate prose. This is the structural change the empirical signal demands. Shape A also preserves the existing streaming UX (unchanged), reuses 100% of the existing `_retry.ts`/`cost-cap.ts`/`actualCost` substrate, keeps F.1's contract byte-for-byte, and adds a clean idempotent weave step that downstream consumers (density metric, ChapterRenderer, fidelity scoring) never need to know about. The +$0.0006/chapter cost is 16× under budget. The correctness ceiling — "extractor can only emit diagrams the prose already enumerates" — is in practice the binding constraint we want: a chapter where the prose buries the structure should not get a synthetic diagram pasted on; it should get either (a) prompt revision upstream or (b) prose-only output, both correct behaviors.

**Why not Shape B**: highest theoretical ceiling but the engineering profile is wrong — partial-JSON streaming infrastructure is a load-bearing dependency on OpenAI SDK internals; the bulkhead between prose and diagrams disappears; schema-compile latency on the main call hits every regen; and the LoC blast radius (~1,400 LoC including client-side partial-JSON parser) is 75% bigger than Shape A's. Defer to "Sprint H+1 if Shape A's emission rate plateaus below ~70%."

**Why not Shape C**: streaming UX wins but tool_calls don't get strict-mode adherence + the open question on `response_format` + `tools` coexistence is unresolved + the stream-demux logic is the most error-prone code of the three. Defer to "Sprint I if Shape A succeeds but users empirically prefer inline-streamed diagrams over the 1-2s post-prose pause."

---

## Wave plan

### Wave 0.5 (PRE-build spike, 1 builder, ~3 hours wall-clock)

**Goal**: resolve the two schema-compatibility unknowns before locking the wire-schema design.

**Builder S** — JSON-Schema-2020 strict-mode compatibility spike. Writes a throwaway Node script (lives at `_inspect/sprint-h/spike-jsonschema.ts`, NOT shipped) that:

1. Defines a candidate wire schema for ComparisonTable using `additionalProperties: { type: 'string' }` for rows. Calls OpenAI 4o-mini with this schema as `response_format`. Reports: accepted / rejected, latency tax, first-call vs cached.
2. Defines a candidate wire schema for DecisionTree using `$ref` recursion. Same protocol.
3. If either rejected: confirms the flat-list fallback works (rows as `Array<{column, value}>`; DecisionTree as `nodes[]` with `yesId`/`noId`).
4. Reports findings to a 1-page memo in the same directory.

Output: a confirmed wire-schema strategy (either "use F.1 shape directly" or "use flat-list fallback") that Wave 1 builds against without further investigation.

**Cost**: ~$0.05 in OpenAI calls + ~30 min builder time.

### Wave 1 (parallel build, 5 builders)

All builders branch off `main` (Sprint F.2 already merged at `bcbb73c`), targeting a single integration branch `feat/sprint-h-extract-diagrams`. Pre-flight enforced: every builder's first command is `pwd && git branch --show-current` (per recurring branch-confusion bug; see `2026-05-25` memory entry).

**Builder A — Extractor module + tests**
- **Target files**:
  - `src/lib/openai/extract-diagrams.ts` (new, ~180 LoC)
  - `src/lib/prompts/extract-diagrams.ts` (new, ~60 LoC)
  - `src/lib/openai/__tests__/extract-diagrams.test.ts` (new, ~150 LoC)
- **LoC budget**: 390 total.
- **Imports**: `openai` from `./client`, `withRetry` from `./_retry`, `assertCostBudget` from `./cost-cap`, `actualCost` from `./cost`, `DiagramPayloadSchema` from `@/lib/diagrams/schema`, wire schema from `@/lib/diagrams/wire-schema` (Builder B).
- **Contract**: `extractDiagrams({ narrative, sourceParagraphs?, abortSignal? }) → { diagrams: ExtractedDiagram[], promptTokens, completionTokens, costUsd, model }`. Calls 4o-mini with `response_format: { type: 'json_schema', strict: true, json_schema: { name: 'extracted_diagrams', strict: true, schema: WIRE_SCHEMA }}`. Drops entries that fail Zod parse, counts. Wrapped in `withRetry` with class `ExtractParseError` registered as parse-retryable.

**Builder B — Wire schema + translator + tests**
- **Target files**:
  - `src/lib/diagrams/wire-schema.ts` (new, ~80 LoC unless Wave-0.5 found flat-list fallback needed, then ~150 LoC)
  - `src/lib/diagrams/__tests__/wire-schema.test.ts` (new, ~100 LoC — round-trip fixture set through wire schema and Zod, assert equivalence)
- **LoC budget**: 250 total.
- **Imports**: `DiagramPayloadSchema` from `./schema` only (no other deps; pure module).
- **Contract**: exports `WIRE_SCHEMA` (the JSON-Schema-2020 object literal) and `toWire(payload)` / `fromWire(rawEntry)` translators. `fromWire` produces inputs ready for Zod parse. `toWire` is for tests + future regen-fixture generation.
- **Sequencing**: must merge BEFORE Builder A's PR can pass typecheck, since A imports `WIRE_SCHEMA`. Builder B has no upstream deps; starts first; ~1-2h wall-clock to a first push.

**Builder C — Weave function + tests**
- **Target files**:
  - `src/lib/diagrams/weave.ts` (new, ~120 LoC)
  - `src/lib/diagrams/__tests__/weave.test.ts` (new, ~120 LoC)
- **LoC budget**: 240 total.
- **Imports**: none (pure string-manipulation module; reads its inputs as values).
- **Contract**: `weaveDiagrams(narrative: string, diagrams: ExtractedDiagram[]): string`. Insertion strategy: try `insertAfterHeading` first (match `## Lesson N: <Title>` exactly), then `insertAfterCitation` (match `[ref:pageN:paragraphM]`), then fallback "after first paragraph past 30% of narrative length." Idempotent: `weave(narrative, []) === narrative`; `weave(weave(n, [d]), [d])` MUST equal `weave(n, [d])` (test enforced).
- **Sequencing**: no upstream deps; starts in parallel with Builders A + B + D.

**Builder D — per-chapter.ts integration + tests**
- **Target files**:
  - `src/lib/generation/per-chapter.ts` (modify; ~50 LoC delta to wire extract + weave between Step 4 and Step 4.5; ~10 LoC delta in transaction for second parsesCost row)
  - `src/lib/generation/__tests__/per-chapter.test.ts` (modify; ~80 LoC delta — mock extract + weave, assert woven narrative reaches DB, assert fail-open semantics)
- **LoC budget**: 140 delta.
- **Imports**: `extractDiagrams` from `@/lib/openai/extract-diagrams` (Builder A), `weaveDiagrams` from `@/lib/diagrams/weave` (Builder C).
- **Contract**: between current Steps 4 and 4.5: call `extractDiagrams({ narrative: narrativeResult.narrative })`. On success: `wovenNarrative = weaveDiagrams(narrative, extractResult.diagrams)`. Persist `wovenNarrative` to `chapters.narrative`. Insert second `parsesCost` row (for extract). On extract failure: log + continue with original narrative (fail-open per `kb:architecture/discipline/stability-patterns`). Anchor validation (existing Step 4.5) reads `wovenNarrative` (extractor cannot have added anchors, so behavior is unchanged for the anchor validator).
- **Sequencing**: depends on A + C having pushed initial commits. Merges LAST in Wave 1.

**Builder E — SSE event + client integration + density-metric verification**
- **Target files**:
  - `src/app/api/chapters/.../route.ts` (modify SSE handler to emit a new `diagrams-extracted` event after extract completes; ~25 LoC delta — exact route path TBD by reading the existing SSE bridge)
  - `src/hooks/useStreamingChapter.ts` (modify; consume `diagrams-extracted` event; transition a small UI indicator off; ~30 LoC delta)
  - `src/lib/eval/__tests__/diagram-density.test.ts` (verify-only; assert that the same per-kind counts are produced whether fences came from inline LLM emission OR Shape A weave; ~25 LoC delta as new it() block)
- **LoC budget**: 80 delta.
- **Sequencing**: starts in parallel with A/B/C; SSE wiring blocks on D's final per-chapter integration only for the integration test. Can merge in parallel with D as long as the contract is agreed up front.

### Wave 2 (reviewers + honesty auditor)

Per the F.2 pattern that empirically delivered ~10× wall-clock compression (see 2026-05-24 TB memory entry):

- **5 code-reviewers** (one per builder, in parallel) using the `power-loom:code-reviewer` agent variant. Each reviewer reads their builder's PR + the original RFC + the builder's kickoff prompt; reports `CRITICAL / HIGH / MEDIUM / LOW`.
- **1 honesty auditor** using the `power-loom:honesty-auditor` agent. Reads ALL five PRs + this RFC + the empirical 0/5 baseline doc. Specifically tasked with: (a) did the build close the 0/5 baseline? (b) are any reviewer false-positives suppressing legitimate concerns? (c) does the persisted narrative actually contain ```diagram fences in a regen-test?
- **Mandatory empirical gate**: post-merge, regenerate the same 5 DDIA chapters from the 2026-05-26 sweep (ch20, ch34, ch36, ch40, ch56). Measure: per-kind emission rate. Acceptance: ≥3/5 emit at least one structured diagram (60% emission lift from 0%) AND ≥2 distinct kinds observed. **If acceptance fails**: pause Wave 3, escalate (Shape B or prompt-revision investigation).

### Wave 3 (fix-ups)

Root-direct serial fix-ups for HIGH findings (per F.2 cadence, ~12 HIGHs across 6 builders found and resolved in ~2h of root-direct work). Honesty-auditor MEDIUMs promoted to HIGH if they touch the empirical-success-gate measurement. Re-run Playwright snapshot suite (already shipped in F.2) to confirm no visual regressions in the actual primitives.

### Wave 4 (measure + ship)

1. Regen the 5-chapter sweep; record per-kind density.
2. If gate passes: merge to `main`, tag `v0.X.Y`.
3. If gate passes by a large margin (≥4/5 emission): regen ch1-5 of DDIA as an A/B vs the pre-Sprint-H baseline; persist eval-harness output for the per-tutorial-overview Sprint G discussion (latent in user-priority queue).
4. If gate fails: capture per-kind failure mode in `_inspect/sprint-h/post-mortem.md`; open Shape-B RFC.

---

## Open questions

Resolve before locking the Wave 1 builder kickoff prompts. In priority order:

1. **Does `response_format: { strict: true }` coexist with `tools[]` in the same OpenAI chat completion?** Brief flagged this as ambiguous in current OpenAI docs. The Wave 0.5 spike (Builder S) can include a probe (define a minimal schema + a minimal tool, see if the API rejects). **Material to Shape C** if we ever revisit; **not blocking** for the recommended Shape A.

2. **Does `additionalProperties: { type: 'string' }` survive `strict: true` in JSON-Schema-2020 mode on OpenAI?** Specifically for ComparisonTable's `rows` (currently `z.record(z.string())`). If rejected: Builder B implements the flat-list fallback (rows as `Array<{column, value}>` with wire-schema-side translation; +30 LoC; no correctness cost). **Wave 0.5 must answer this before Wave 1 starts.**

3. **Does recursive `$ref` survive `strict: true`?** Specifically for DecisionTree.root. If rejected: Builder B implements the flat-list fallback (`nodes: [{id, question?, leaf?, yesId?, noId?}]` with translator; +50 LoC). **Wave 0.5 must answer this before Wave 1 starts.**

4. **What's the empirical schema-compile latency tax on first request?** Brief documented "additional latency on first call with a given schema; subsequent calls cached." If the tax is <500ms it's negligible against the existing ~3-4s per-chapter total; if it's >2s it changes the UX story for cold-cache regens. Wave 0.5 spike can measure.

5. **Is there a route file naming inconsistency that affects Builder E?** The brief mentions `src/lib/eval/fidelity-from-narrative.ts` and `src/lib/openai/streaming-with-retry.ts`, but those files don't exist in the repo — the actual modules are `src/lib/openai/_retry.ts` + `src/lib/openai/narrative-only.ts` + `src/lib/openai/streaming.ts` (the last is the legacy chapter-gen path, not used by lazy-hybrid), and fidelity scoring lives in `src/lib/openai/fidelity-check.ts` (an LLM scorer, not a grep-based pure function). Confirm with the orchestrator whether the brief's file paths were aspirational/outdated, or whether new modules are expected. **Recommendation**: the RFC's plan uses the actual current names; flag the discrepancy upstream so Sprint H's PR description matches the code reality.

6. **Should the extractor optionally see `sourceParagraphs` in addition to the narrative?** Pro: lets the extractor catch diagrammable structure the prose buried. Con: doubles the input token count (~1,500 → ~3,500 tokens), pushes cost from $0.0006 → $0.0011/chapter (still way under budget). Con: encourages hallucination of diagrams not in the narrative (defeats Shape A's "bounded by what prose surfaces" ceiling — which is actually a feature for correctness). **Recommendation**: ship Shape A V1 with narrative-only input; revisit if the empirical emission rate plateaus below 70%.

7. **Should we add a FIDELITY rule update telling 4o it MAY emit ```diagram fences inline AND can rely on the extractor as a safety net?** Current FIDELITY Rule 9 tells 4o "PREFER STRUCTURED FIGURE REPRESENTATIONS" — keep, soften, or replace? **Recommendation**: keep verbatim. If 4o emits inline, weave is a no-op for that block (idempotent); if 4o doesn't, the extractor handles it. Two-pass with rule retention = belt + suspenders.

---

## ADR — Sprint H Wave 0 Response-Format Substrate Choice

**Status**: Proposed
**Context**: PR #36 baseline showed 25% diagram emission on a 4-chapter sample; 2026-05-26 sweep showed 0% on a diverse 5-chapter sample. F.1's FIDELITY Rule 9 + F.2's complete renderer suite (4 SVG primitives + 2 pure-HTML primitives + density metric + Playwright) are all in production at `main @ bcbb73c`, but the LLM's prose attractor crowds out structured emission inside the single-call narrative path. We need a substrate change, not more prompt teeth.
**Decision**: Adopt **Shape A — 2-pass extraction**. Keep `narrative-only.ts` byte-for-byte; add a new 4o-mini extraction call between Step 4 (narrative complete) and Step 4.5 (anchor validation) in `per-chapter.ts`. The extractor uses `response_format: { type: 'json_schema', strict: true }` with a wire schema derived from the F.1 Zod `DiagramPayloadSchema`. A pure-function weaver inserts ```diagram fences into the narrative at heading or citation anchors. Persistence shape unchanged. Density metric, ChapterRenderer, DiagramBlock, schema, parser all unchanged.
**Consequences**: ~800 LoC across 7 new files + 3 modified, in 5 parallel builders + 1 Wave-0.5 spike. Cost +$0.0006/chapter (16× under budget). Streaming UX preserved verbatim. Bulkhead between prose and diagrams established (extract failure does not lose prose). F.1 contract untouched; no migration risk. Schema-compatibility friction bounded to two known points (`z.record` for ComparisonTable rows, recursive `$ref` for DecisionTree); Wave 0.5 spike resolves both before Wave 1 starts. Acceptance gate is empirical: ≥3/5 emission on the same 2026-05-26 sweep chapters post-merge, ≥2 distinct kinds. Failure mode: regression to today's behavior (extractor degrades gracefully).
**Alternatives Considered**:
- **Shape B (1-pass JSON)** — rejected: requires either dropping streaming UX (`kb:design-pushback/synchronous-llm-calls-in-request-path` argues against) or adopting OpenAI SDK partial-JSON-streaming helper (load-bearing dependency on SDK internals + ~1,400 LoC blast radius including client refactor); eliminates the bulkhead between prose and diagrams; schema-compile latency hits every regen. Highest theoretical ceiling but worst engineering profile. Deferred to Sprint H+1 if Shape A's empirical emission plateaus.
- **Shape C (interleaved tool_calls)** — rejected: tool_calls don't get strict-mode adherence (empirical ~95% args validity vs strict-mode's claimed 100%); `response_format` + `tools` coexistence is currently uncertain in OpenAI docs; stream-demux logic is the most error-prone code of the three. Doesn't fix the structural attractor problem (model still decides mid-stream whether to call). Deferred to Sprint I if users empirically dislike Shape A's 1-2s post-prose pause.
**Principle Audit**:
- **SOLID — Single Responsibility**: narrative-only owns prose; extract-diagrams owns diagrams; weave owns insertion; quiz-from-narrative owns quiz. Four deep modules, four small public surfaces.
- **DRY**: 100% reuse of `_retry.ts`, `cost-cap.ts`, `actualCost`, `DiagramPayloadSchema`, `parseDiagramBlock`. No duplicated retry policy, cost arithmetic, or schema validation.
- **KISS**: pure-function weaver; idempotent contract; persistence shape unchanged; no client protocol changes.
- **YAGNI**: do NOT pre-build a partial-JSON-streaming client parser (Shape B) or stream-demux infrastructure (Shape C) until empirical signal demands them.
- **Modularity**: 7 new files, each with a small public surface; F.1 contract unchanged; F.2 renderers unchanged; density metric unchanged. Sprint H is strictly additive.
- **Maintainability**: wire schema lives in `wire-schema.ts` with a round-trip test; adding a 7th primitive in Sprint I extends Zod + wire schema, no other changes.
- **Performance**: +1 round-trip is 1-2s post-prose; user-perceived latency unchanged because streaming is preserved; cost +$0.0006 well under budget.
- **Scalability**: extraction is per-chapter, stateless, idempotent; can scale horizontally with the existing per-chapter worker model.
- **Security**: no new attack surface; LLM output validated at the same Zod boundary as today.
**Sources**:
- `kb:architecture/discipline/error-handling-discipline` — informed the "validate at the boundary, never re-validate inside" pattern preserved at the new extractor.
- `kb:architecture/discipline/stability-patterns` — informed the bulkhead between prose and diagram paths (Shape A naturally provides; Shape B does not).
- `kb:architecture/crosscut/single-responsibility` — informed the four-module decomposition (narrative / extract / weave / quiz).
- `kb:architecture/crosscut/deep-modules` — informed the extractor's small public surface (`narrative: string` → `diagrams[]`).
- `kb:architecture/crosscut/idempotency` — informed the weaver's pure-function contract (`weave(weave(n, [d]), [d]) === weave(n, [d])`).
- `kb:architecture/ai-systems/evaluation-under-nondeterminism` — informed the empirical acceptance gate (≥3/5 emission on the same diverse 5-chapter sample that produced the 0% baseline).
- `kb:architecture/ai-systems/inference-cost-management` — informed the cost-budget envelope (+$0.0006/chapter, 16× under +$0.01 budget).
- `kb:design-pushback/synchronous-llm-calls-in-request-path` — informed the verdict that Shape A's extra round-trip is acceptable (per-chapter is already an async background path; user is not blocked).
- `_inspect/sprint-f/diagram-pipeline-rfc.md` (in-repo prior art) — informed the hybrid-pipeline preservation: structured primitives ~85% / Mermaid escape-hatch ~15%, Sprint H changes the substrate driving the 85% path, not the architecture.
- `_inspect/sprint-f/f2-svg-primitives-rfc.md` (in-repo prior art) — informed the per-kind density metric (already shipped + reused without modification) and the HETS Wave structure (5 parallel builders + 5 reviewers + 1 honesty auditor; empirical acceptance gate).
