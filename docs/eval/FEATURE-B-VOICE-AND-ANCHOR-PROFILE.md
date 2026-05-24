# Feature B' — Voice + Anchor Fidelity Profile (Design Doc, v0)

**Status:** design only, no code yet. Awaiting review.
**Author:** drafted in conversation with the maintainer 2026-05-24.
**Owner:** TBD.
**Related:** Brainstorm 2 from the persona-stakeholder discussion;
DRIFT-test3-029 / -031 (failure modes this fix addresses); v3/v4/v5
prompt-iteration negative result; `docs/eval/HARNESS-DESIGN.md`.

---

## Motivation

The convergent finding from three prompt iterations and 12 persona reviews:

> *"Prompt engineering has hit its ceiling. The next gain comes from
> source-grounding — anchor-aware retrieval, vocabulary whitelist
> scoring — not from a v6 prompt."* — domain-expert review, v5

Concrete examples of what survived three iterations:
- Ch2 dropped **"head-of-line blocking"**, **"tail-latency amplification"**,
  **"t-digest"**, **"HdrHistogram"**, **"coordinated omission"** — DDIA names
  these explicitly; v3/v4/v5 narratives paraphrased them into generic
  descriptions ("queueing delays", "slow outliers", "histogram approximations").
- Ch3 dropped **"Out of the Tar Pit"** (Moseley & Marks citation) and
  **"big ball of mud"** (Foote & Yoder).
- Ch5 dropped **"impedance mismatch"** verbatim, substituting "object-relational
  mismatch" (a near-miss; loses the EE-engineering analogy that makes the term
  memorable).
- Across all 6 chapters, the AUTHOR's signature register (BUT-clauses, dry
  humor about distributed-systems failure modes, the celebrity-hybrid thought
  experiment, named war stories) was sanitized into generic-LLM-tutorial English.

Why prompts can't fix this: the rules in `narrative-only.ts` say "preserve
named anchors" — but the model only sees the source paragraphs for the
current chunk. If a paragraph uses the term once and the model has a
~30% probability of dropping any single term during paraphrase, then
across a 200-paragraph chunk the EXPECTED outcome is ~60% of the anchors
get dropped. Telling the model "preserve them harder" doesn't change the
distribution; the only mechanisms that change the distribution are:

1. **Authoritative whitelist** the model sees alongside the source —
   "these specific 20 terms are non-negotiable; if they appear in the
   source paragraphs, they MUST appear in the narrative verbatim."
2. **Post-generation validator** that detects violations and either logs
   them as drift signal or forces a regen with explicit feedback.

Feature B' implements both, plus the related "voice fingerprint" that
addresses the equally-convergent finding that the narrative tone doesn't
match the author. The two are bundled because they share the same
ingest-time extraction pipeline + the same prompt-injection plumbing.

---

## Architecture overview

```
INGEST (one-time per pdf_sha256; multi-user-shared via S3 cache)

  PDF parse ─► outline ─► classifier ─► tree-descent chunker ─► glossary-extract
                                                       │
                                                       ├─► VOICE EXTRACTOR ──┐    (NEW)
                                                       │                    │
                                                       └─► ANCHOR EXTRACTOR ─┤    (NEW)
                                                                            │
                                                                            ▼
                                                         S3 (alongside metadata.json):
                                                           voice_profile.json
                                                           anchor_whitelist.json

GENERATION (lazy, per-chapter — DRIFT-019 path)

  ┌─ Load chunk + voice_profile + anchor_whitelist ─┐
  │                                                  │
  ▼                                                  ▼
  4o narrative (system prompt now includes voice profile + relevant whitelist subset)
                          │
                          ▼
  ANCHOR VALIDATOR ── checks whitelist anchors present in chunk source paragraphs
                      DID appear verbatim in narrative
                          │
                          ├─► all present → continue
                          └─► some missing → log violation;
                                              optionally trigger ONE retry with feedback
                                              (per Open Decision D4 below)
                          ▼
  4o-mini quiz/flashcards (unchanged)
                          ▼
  4o-mini fidelity scorer (also receives anchor_whitelist; scorer becomes
                           anchor-aware rather than relying on the LLM to
                           re-discover anchors per call)
```

The harness (Phases 1-3) measures this. Feature B' ships first; harness
ships after to validate the gains rigorously.

---

## Component 1 — Voice Extractor

### Scope

A 4o-mini ingest-time call that produces a structured `voice_profile.json`
for the PDF. One-time cost per `pdf_sha256`; multi-user-shared via the
existing S3 cache pattern.

### Input

- The book's body paragraphs (skip front-matter + appendices via the
  existing classifier's labels).
- A bounded sample — see §"Sampling Strategy" — to keep the call cheap.

### Sampling strategy

Three legal sampling modes (decision deferred; see Open Decisions D1):

| Mode | Mechanism | Pro | Con |
|---|---|---|---|
| **Uniform body sample** | Take every Nth paragraph across all body chunks until ~10 paragraphs collected | Simple; representative of overall register | Misses density bursts (signature analogies often cluster) |
| **Density-weighted** | Sample more from chunks that the chunker rated high (per-chunk paragraph density) | Better captures author's most-thoughtful sections | More complex; needs chunker score that doesn't yet exist |
| **Mid-book bias** | 70% of samples from middle 50% of body chunks; 15% from first half; 15% from last | Avoids "warm-up" first-chapter style + "rushed conclusion" last-chapter style | Heuristic; might miss intro/closing voice moves |

**Recommendation:** start with **uniform body sample** (10 paragraphs).
Easiest to implement, deterministic per (sha256, sampler version),
sufficient as a baseline. Iterate to density-weighted only if the v1
voice profiles read flat across books.

### Prompt

```
SYSTEM:
You are a literary stylometric analyst. Given 10 sample paragraphs from a
non-fiction technical book, identify the author's distinct rhetorical voice.
Your output will be injected into a tutorial-generation prompt as a
preservation guide.

Identify:

  1. SIGNATURE MOVES (3-5): named rhetorical patterns the author uses
     consistently. Examples:
       - "Opens chapters with a question or a deliberate pushback"
       - "Sets up benefits then immediately qualifies with 'but...'"
       - "Uses Twitter/Slack-era 2010s anecdotes as anchors"
       - "Names canonical incidents (leap-second bug, Knight Capital) rather
         than describing abstract failure classes"
       - "Cites academic papers inline by surname + year"

  2. EXAMPLE PHRASES (5-8): verbatim short quotes from the samples that
     sound DISTINCTIVELY like this author — phrases that would lose their
     identity if paraphrased. ≤15 words each.

  3. HUMOR PATTERNS (1-3): how the author handles failure modes / mistakes
     / industry hype. Dry? Self-deprecating? Bombastic? Specific named
     jokes if present.

  4. PREFERRED ANALOGY TYPES (1-3): does the author reach for celestial
     bodies, sports, food, household-appliance metaphors? Identify the
     analogy register without inventing instances.

USER:
[10 sampled paragraphs, each with [page:paragraph] prefix]

Output strict JSON: {
  "signature_moves": [{ "name": str, "description": str (≤30 words) }, …],
  "example_phrases": [{ "phrase": str, "ref": "pageN:paragraphM" }, …],
  "humor_patterns": [str (≤25 words)],
  "preferred_analogies": [str (≤20 words)],
  "tone_summary": str (single sentence, ≤25 words)
}
```

### Output schema

```jsonc
// _s3_bucket/<pdf_sha256>/voice_profile.json
{
  "schema_version": 1,
  "extracted_at": "2026-05-24T...",
  "model": "gpt-4o-mini",
  "extraction_cost_usd": 0.002,
  "sample_size": 10,
  "sampler_version": "uniform-body-v1",
  "tone_summary": "Dry, precise, fond of qualifying claims; uses named incidents as evidence",
  "signature_moves": [
    {
      "name": "BUT-clause caveats",
      "description": "Sets up a benefit then immediately qualifies with 'but...' — every claim earns its caveat"
    },
    {
      "name": "Named-incident anchoring",
      "description": "Teaches via specific events (leap-second bug, Knight Capital, GitHub MySQL failover) rather than abstract failure classes"
    },
    {
      "name": "Forward-pointing closes",
      "description": "Ends chapters with 'In the next chapter we will examine X', never with a meta-summary"
    }
  ],
  "example_phrases": [
    { "phrase": "but reality is not that simple", "ref": "page1:paragraph3" },
    { "phrase": "swallowed by a black hole", "ref": "page8:paragraph5" }
  ],
  "humor_patterns": [
    "Black humor about distributed-systems failure modes — uses dramatic phrasing to dismiss simplistic claims"
  ],
  "preferred_analogies": [
    "Astronomical and cosmological (black holes, gravity, scale)",
    "Industrial / mechanical (factories, assembly lines)"
  ]
}
```

### Cost

- Input: 10 paragraphs × ~150 tokens = 1,500 tokens + ~300 token system prompt = ~1,800 input tokens
- Output: ~600 tokens
- 4o-mini: $0.15/1M input + $0.60/1M output → **~$0.001 per PDF**, one-time, multi-user-shared

---

## Component 2 — Anchor Extractor

### Scope

A 4o-mini ingest-time call that produces an `anchor_whitelist.json` — the
LIST of source-specific named terms that MUST survive into any narrative.
This is the load-bearing component for closing DRIFT-031.

### Detection heuristics (deterministic pre-filter)

Before calling the LLM, a deterministic pass extracts CANDIDATE anchors:

1. **Capitalized multi-word noun phrases** ("Head-of-Line Blocking", "Chaos Monkey", "Out of the Tar Pit")
2. **Words starting with capital occurring ≥3 times** in body (filtered to exclude common-English titles, chapter headings, place names)
3. **Glossary terms** from the existing glossary-extract pass (these are CANONICAL anchors per author intent)
4. **Hyphenated technical compounds** ("shared-nothing", "fault-tolerant", "tail-latency")
5. **Quoted strings ≥3 words** in the body (often paper titles or signature analogies)
6. **Cross-paragraph references** ("see §3.2", "as discussed in Chapter 7") — these signal the author treats a concept as load-bearing across chapters

Candidates feed into the 4o-mini call (saves cost by avoiding sending the
whole book corpus; the LLM scores ~80 candidates rather than discovering from scratch).

### LLM scoring prompt

```
SYSTEM:
You are filtering a candidate list of TECHNICAL ANCHOR TERMS extracted from
a book. The downstream tutorial-generation prompt will be instructed to
preserve every term on this whitelist VERBATIM when it appears in source
paragraphs. Your job: filter the candidates to keep ONLY terms that:

  - Are search-term-anchors: a curious reader can web-search them and
    find further literature (e.g., "head-of-line blocking", "t-digest")
  - Are named systems / papers / people / incidents (e.g., "Chaos Monkey",
    "Out of the Tar Pit", "Knight Capital outage")
  - Are signature analogies the author uses across multiple sections
    ("swallowed by a black hole", "big ball of mud")
  - Are precise terminology pairs the author distinguishes ("fault vs failure",
    "latency vs response time")

REJECT candidates that:
  - Are generic English nouns capitalized only because they start a sentence
  - Are chapter / section names (the outline already covers those)
  - Are person names mentioned once incidentally (e.g., "I once spoke with
    John Smith at QCon...")
  - Are place names without technical relevance

Output strict JSON: {
  "anchors": [
    {
      "term": str (verbatim, exactly as it appears in source),
      "category": "search-term" | "named-system" | "named-paper" | "named-incident" | "signature-analogy" | "contrast-pair",
      "frequency_in_source": int,
      "first_seen_at": "pageN:paragraphM"
    }, ...
  ]
}

USER:
[candidate list, one per line, with frequency + first-seen ref]
```

### Output schema

```jsonc
// _s3_bucket/<pdf_sha256>/anchor_whitelist.json
{
  "schema_version": 1,
  "extracted_at": "2026-05-24T...",
  "model": "gpt-4o-mini",
  "extraction_cost_usd": 0.003,
  "candidate_count": 87,
  "accepted_count": 24,
  "anchors": [
    {
      "term": "head-of-line blocking",
      "category": "search-term",
      "frequency_in_source": 4,
      "first_seen_at": "page36:paragraph2"
    },
    {
      "term": "Chaos Monkey",
      "category": "named-system",
      "frequency_in_source": 3,
      "first_seen_at": "page8:paragraph7"
    },
    {
      "term": "Out of the Tar Pit",
      "category": "named-paper",
      "frequency_in_source": 1,
      "first_seen_at": "page42:paragraph5"
    },
    {
      "term": "swallowed by a black hole",
      "category": "signature-analogy",
      "frequency_in_source": 1,
      "first_seen_at": "page8:paragraph5"
    },
    {
      "term": "latency vs response time",
      "category": "contrast-pair",
      "frequency_in_source": 2,
      "first_seen_at": "page14:paragraph0"
    }
    // ... ~20 more
  ]
}
```

### Size cap

The whitelist is capped at **30 entries** per book (top-30 by frequency,
ties broken by category priority: contrast-pair > named-paper > named-system >
named-incident > search-term > signature-analogy). Rationale: a longer
whitelist (a) bloats the narrative prompt by ~500 tokens per chapter ×
124 chapters = $0.30/book/regen-cycle of marginal cost, (b) dilutes the
preservation signal — if everything is load-bearing, nothing is.

### Cost

- Deterministic pre-filter: $0 (Node-side regex + frequency counting)
- LLM scoring: ~80 candidates × ~30 tokens = 2,400 + system prompt = ~2,800 input tokens
- Output: ~800 tokens
- 4o-mini: **~$0.003 per PDF**, one-time, multi-user-shared

**Total ingest cost delta:** ~$0.001 (voice) + ~$0.003 (anchor) = **~$0.004/PDF**.
Amortized across all users of that PDF. Negligible.

---

## Component 3 — Prompt Injection

### What changes in `narrative-only.ts`

Two new injected blocks in the system prompt, BEFORE the existing fidelity
rules:

```
AUTHOR VOICE PROFILE (preserve this register):
  Tone: <voice_profile.tone_summary>

  Signature moves this author uses (preserve where the source paragraphs
  show them):
    1. <signature_moves[0].name>: <signature_moves[0].description>
    2. ...

  Example phrases that sound DISTINCTIVELY like this author (KEEP THESE
  VERBATIM where they appear in your source paragraphs):
    - "<example_phrases[0].phrase>" [<example_phrases[0].ref>]
    - "<example_phrases[1].phrase>" [<example_phrases[1].ref>]
    - ...

  Humor / register: <humor_patterns[0]>
  Preferred analogy types: <preferred_analogies[0]>

NAMED ANCHORS (preserve verbatim where present in your source paragraphs):
  These terms have been identified by the source-grounding pass as
  load-bearing. If your assigned source paragraphs contain any of these
  terms, your narrative MUST contain them verbatim. Paraphrasing them
  into generic descriptions defeats the purpose of preserving authorial
  voice and pedagogical fidelity.

    - "head-of-line blocking" (search-term)
    - "Chaos Monkey" (named-system)
    - "Out of the Tar Pit" (named-paper)
    - ...
```

### What does NOT change

- The existing fidelity rules (1-6, A-C, D) — they stay. The voice profile
  + anchor whitelist are ADDITIVE, not replacements.
- The existing `## Lesson N:` structure (Feature A) — unchanged.
- The strict-mode JSON output schema (`narrative_only_result`) — unchanged.

### Token budget

- Voice profile injection: ~250 tokens
- Anchor whitelist injection: ~300 tokens (30 anchors × ~10 tokens each)
- Combined: ~550 extra input tokens per chapter call

Cost delta per chapter: +$0.0014 (gpt-4o input pricing). DDIA full read =
+$0.17. Acceptable.

### Per-chapter whitelist scoping (optional optimization, deferred)

The full whitelist may contain anchors that are irrelevant to the current
chunk (e.g., "Chaos Monkey" if the current chunk is about partitioning).
A future optimization filters the whitelist to anchors whose `first_seen_at`
is within (or near) the current chunk's source paragraphs. This cuts the
~300-token injection to ~80 tokens for non-Chaos-Monkey chunks. Defer to
v2 of this feature; the MVP injects the full whitelist.

---

## Component 4 — Anchor Validator

### Scope

A post-narrative deterministic check that fails-loud when whitelist anchors
present in the chunk's source paragraphs are missing from the generated
narrative.

### Algorithm

```
function validateAnchors(narrative, sourceParagraphs, anchorWhitelist):
  // 1. Find anchors PRESENT in source paragraphs for THIS chunk
  presentInSource = []
  for anchor in anchorWhitelist:
    if anchor.term appears in any paragraph of sourceParagraphs (case-insensitive contains):
      presentInSource.push(anchor)

  // 2. Check each is also PRESENT in narrative (verbatim, case-insensitive)
  missing = []
  for anchor in presentInSource:
    if anchor.term not in narrative (case-insensitive):
      missing.push(anchor)

  return {
    expectedCount: presentInSource.length,
    foundCount: presentInSource.length - missing.length,
    missing: missing.map(a => a.term),
    score: presentInSource.length > 0 ? foundCount / expectedCount : 1.0
  }
```

Pure function; no LLM call; runs in milliseconds.

### Policy on validation failure (Open Decision D4)

Three legal policies:

| Policy | Behavior on miss | Cost | Risk |
|---|---|---|---|
| **A. Log-and-continue** | Persist a `chapter_anchor_violations` row; chapter proceeds to complete | $0 marginal | Quality silently degrades when violations are common |
| **B. Single forced regen with feedback** | If `missing.length > 0`, regen the narrative ONCE with the prompt addendum: "You dropped these anchors: [missing]. Regenerate including them verbatim where the source uses them." | +1× narrative cost ($0.018) when fires | Doubles cost on the affected chapter; user waits ~70s instead of ~35s |
| **C. Threshold-based regen** | Regen only if `score < 0.7`; log otherwise | Avg +20% chapter cost (assuming 1 in 5 chapters fires) | Tunable; needs the threshold itself tuned empirically |

**Recommendation:** start with **A. Log-and-continue**, ship, run the harness
against it to measure violation rate empirically. If the rate is high (>30%
of chapters drop anchors), graduate to **B**. Don't ship **B** by default
before measuring — paying 2× cost when the policy isn't load-bearing is wasteful.

### Persistence (new table)

```sql
CREATE TABLE chapter_anchor_violations (
  id text PRIMARY KEY,
  chapter_id text NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
  expected_count integer NOT NULL,
  found_count integer NOT NULL,
  missing_anchors_json text NOT NULL DEFAULT '[]',
  score real NOT NULL CHECK (score BETWEEN 0 AND 1),
  policy_applied text NOT NULL DEFAULT 'log-and-continue',
  regen_triggered integer NOT NULL DEFAULT 0,
  created_at integer NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX idx_anchor_violations_chapter ON chapter_anchor_violations(chapter_id, created_at);
```

Side-table; mirrors the `chapter_fidelity_scores` pattern. The harness's
"Scorer vs humans" comparison can also surface "Validator vs humans" once
this is wired.

---

## Component 5 — Fidelity Scorer Update

The existing `src/lib/openai/fidelity-check.ts` is anchor-blind — it asks
the scorer LLM to re-discover anchors per call. With the whitelist available,
the scorer becomes anchor-aware:

- Scorer system prompt now receives the relevant whitelist slice
- Scorer's job becomes: "Did the narrative preserve THESE SPECIFIC anchors that
  appear in the source paragraphs?" — a far more constrained question
- Should reduce scorer variance and align scoring with the validator

Schema change: add `whitelist_anchors_preserved` + `whitelist_anchors_missing`
fields to `chapter_fidelity_scores`. Backward-compatible (existing rows
have `null` for the new columns).

This is a small change but worth bundling into the same PR so the scorer's
output is meaningful from day one.

---

## S3 storage layout (additive)

```
s3://<chunks-bucket>/<pdf_sha256>/
  metadata.json                  (existing)
  chapters/00.json               (existing)
  chapters/01.json
  ...
  glossary.json                  (existing)
  voice_profile.json             (NEW)
  anchor_whitelist.json          (NEW)
```

`tutorials.parsed_s3_prefix` column already exists; voice_profile and
anchor_whitelist live alongside the chunks under that prefix. No DB schema
change needed for the location.

---

## DB schema changes summary

| Change | New table or column | Migration |
|---|---|---|
| `chapter_anchor_violations` table | NEW | `drizzle/migrations/0003_chapter_anchor_violations.sql` |
| `chapter_fidelity_scores.whitelist_anchors_preserved` (integer, nullable) | NEW column | `drizzle/migrations/0004_anchor_aware_fidelity.sql` |
| `chapter_fidelity_scores.whitelist_anchors_missing` (integer, nullable) | NEW column | (same migration) |

Both migrations are additive; no breaking changes.

---

## File layout (proposed)

```
src/lib/ingest/
  voice-extract.ts                (NEW) — wraps 4o-mini with withRetry, S3 read/write
  anchor-extract.ts               (NEW) — deterministic pre-filter + LLM scoring + S3 write
  __tests__/voice-extract.test.ts (NEW)
  __tests__/anchor-extract.test.ts (NEW)

src/lib/openai/
  anchor-validator.ts             (NEW) — pure function: validateAnchors(narrative, sourceParagraphs, whitelist)
  __tests__/anchor-validator.test.ts (NEW)

src/lib/openai/narrative-only.ts  (MODIFY) — inject voice profile + whitelist
src/lib/prompts/narrative-only.ts (MODIFY) — accept VoiceProfile + AnchorWhitelist args
src/lib/openai/fidelity-check.ts  (MODIFY) — accept whitelist; emit new fields
src/lib/ingest/worker.ts          (MODIFY) — invoke voice + anchor extractors
src/lib/generation/per-chapter.ts (MODIFY) — load profile + whitelist; call validator
src/db/schema.ts                  (MODIFY) — add chapter_anchor_violations + new columns

drizzle/migrations/
  0003_chapter_anchor_violations.sql   (NEW)
  0004_anchor_aware_fidelity.sql       (NEW)
```

**Total estimated LoC:** ~700 (with tests).

---

## Sequencing (assuming this design approved)

| Step | Effort | Depends on |
|---|---|---|
| 1. Voice extractor (4o-mini + S3 write) | ~2h | nothing |
| 2. Anchor extractor — deterministic pre-filter | ~2h | nothing |
| 3. Anchor extractor — LLM scoring + S3 write | ~2h | (2) |
| 4. Migrations (chapter_anchor_violations + new fidelity columns) | ~30min | nothing |
| 5. Anchor validator (pure fn) + unit tests | ~1h | (4) |
| 6. Prompt injection in `narrative-only.ts` + builder API | ~1h | (1), (3) |
| 7. Worker integration (call both extractors at ingest; cache to S3) | ~1h | (1), (3) |
| 8. Per-chapter integration (load profile + whitelist; run validator post-gen) | ~1.5h | (5), (6) |
| 9. Fidelity scorer update (anchor-aware) | ~1h | (5) |
| 10. Smoke: re-ingest a fresh PDF; regen DDIA ch0-5; verify both artifacts cache; eyeball violations | ~1h | all |
| 11. Commit + PR | ~30min | (10) |

**Total: ~13 hours.** Shippable in a single PR; testable in isolation; no
behavior regression at the chapter generation surface (existing tutorials
without `voice_profile.json` / `anchor_whitelist.json` gracefully degrade
to v3-shipped behavior — see "Graceful degradation" below).

---

## Graceful degradation

What happens for a tutorial ingested BEFORE Feature B' shipped?

- S3 `voice_profile.json` / `anchor_whitelist.json` absent → S3 read returns
  null
- `generateChapter()` checks for null → falls back to the pre-Feature-B
  prompt (existing fidelity rules only)
- Anchor validator is skipped (no whitelist → nothing to validate)
- Fidelity scorer falls back to its current anchor-blind mode

This means **NO MIGRATION** of existing tutorials is required. The user
can opt into Feature B' by re-ingesting, OR by running a one-shot
`scripts/extract-voice-and-anchors.ts <tutorial-id>` that hits the same
extractors against an existing parsed PDF. Defer the one-shot script to a
follow-up; v1 ships with re-ingest as the only opt-in path.

---

## Open decisions for review

| # | Decision | Recommendation |
|---|---|---|
| **D1** | Sampling strategy for voice extractor (uniform / density-weighted / mid-book-bias) | **Uniform body sample**, 10 paragraphs. Simplest; revisit if profiles read flat. |
| **D2** | Voice profile size — how many signature moves / phrases / humor patterns to extract | **3-5 moves, 5-8 phrases, 1-3 humor, 1-3 analogies**. Bounded by output schema. |
| **D3** | Anchor whitelist size cap | **30 entries**, top-N by frequency, tied-break by category priority |
| **D4** | Anchor validator policy on miss | **A. Log-and-continue** for v1. Measure violation rate via harness. Graduate to B/C only if data shows it's needed. |
| **D5** | Voice profile UI surface ("How this book teaches" sidebar) | **Yes, surface it.** The persona-discussion grad student + senior eng both flagged this as a differentiation signal vs generic LLM tutorials. Small UI surface (~80 LoC). Defer to a separate PR after Feature B' ships if scope grows. |
| **D6** | Per-chapter whitelist scoping (filter whitelist by chunk-relevant anchors) | **DEFER to v2.** Inject full whitelist for v1; measure token overhead empirically. ~$0.17 / full-DDIA-read is below the noise floor. |
| **D7** | If voice extractor produces a result the maintainer thinks is bad, what's the override path? | **`docs/eval/personas/voice-profile-override-<sha256>.json`** — a committed override file the worker reads BEFORE checking S3. Lets us hand-curate voice profiles for high-value books (DDIA being the first). |
| **D8** | Anchor pre-filter — should it use the existing `glossary-extract.ts` output as a seed? | **Yes**, but as ONE source of candidates among others (capitalization, frequency, hyphenation). Glossary terms get a category-priority boost. |
| **D9** | Should the validator's regen feedback be applied to the SAME prompt that generated the failing version, or to a stricter variant? | **Same prompt + addendum** for v1 — "You dropped these anchors: [missing]. Regenerate the chapter preserving them verbatim where the source uses them." Avoids prompt-fork complexity. |

---

## Risks + mitigations

| # | Risk | Mitigation |
|---|---|---|
| R1 | Voice extractor produces a generic "academic, precise" profile for every book → no differentiation | The 10-paragraph sample includes example_phrases that are VERBATIM source quotes. Even if the moves are generic, the verbatim quotes inject author-specific phrasing into the prompt. Hard to be generic when you're literally quoting Kleppmann's "swallowed by a black hole". |
| R2 | Anchor extractor whitelists too many terms → narrative becomes mechanically anchor-stuffed | Cap at 30. Frequency-weighted; only terms appearing ≥2 times in body. Validator only flags missing anchors that ALSO appear in the chunk's source paragraphs — narrative-stuffing of irrelevant anchors is not rewarded. |
| R3 | Anchor extractor MISSES important anchors (false negatives) | The harness (Phase 1 author-persona review) will catch this — Kleppmann persona reads the chapters and reports missing anchors qualitatively. If a known anchor (HOL blocking) is repeatedly missed, audit the pre-filter. |
| R4 | Validator's case-insensitive substring match has false positives ("RAID" matches "afraid", "MySQL" matches "MyselfQL") | Use word-boundary regex: `/(^|[^A-Za-z0-9])TERM([^A-Za-z0-9]|$)/i`. Edge case for hyphenated terms ("head-of-line"): pre-escape and use the same boundary. Unit tests cover the false-positive shapes. |
| R5 | Voice extractor + anchor extractor add ~$0.004 to every fresh PDF ingest — multi-user economic argument weakens for unpopular books | Acceptable. The cost is paid once per `pdf_sha256`. If a book is so unpopular it's never re-read, the ingester is the only user and pays $0.004 for a meaningfully better tutorial. |
| R6 | The author-persona profile (Kleppmann) used by the harness might be biased toward MATCHING the auto-extracted voice profile, creating a circular validation | The harness's author persona is primed from PUBLIC corpus (DDIA, his blog, his lectures, Twitter), NOT from the auto-extracted profile. The two pipelines never share state. If both produce similar judgments, that's converging evidence; if they diverge, the harness's Kleppmann persona is the human-reference baseline. |
| R7 | Hand-curated override (D7) drifts from production extractor outputs over time, hiding regressions | Override files include `sha256_override_for` field + a check-in date. CI lint warns when an override is >180 days old without revalidation. |
| R8 | Anchor validator's "regen with feedback" path (Policy B/C, deferred) could loop on adversarial inputs | Hard-cap at 1 regen per chapter per validator failure. If still missing, log and surrender. Prevents infinite-spiral cost overruns. |

---

## Out of scope (deferred)

- **Per-author adapter / LoRA fine-tuning** — would maximize fidelity but
  requires training infra + per-author cost. Worth revisiting at scale
  (many books per author, or very-popular single books).
- **Cross-author transfer** — using Kleppmann's voice for a non-Kleppmann
  book. Not useful; defeats the purpose of voice preservation.
- **Real-time voice profile editing** — UI lets the user tune the profile
  themselves. Cute but not validated as a real user need; the persona
  discussion didn't surface it.
- **Translation-aware extraction** — non-English source PDFs. Already
  out of scope per the README's English-only MVP.
- **Cross-chapter anchor consistency check** — making sure that an anchor
  defined in Chapter 1 is referenced consistently in Chapter 5. Possible
  v2 feature; not load-bearing for v1.
- **Auto-tuning the whitelist cap** — finding the right N per book empirically
  rather than a fixed 30. Defer until we have data from 5+ books.

---

## Why this is the right shape

- **Addresses the SHARP convergent diagnosis** from v3/v4/v5 reviews:
  source-grounding, not prompt-engineering, is the next leverage point.
- **Architecturally separable**: extraction is at ingest, injection is at
  generation, validation is post-generation. Each phase is independently
  testable.
- **Multi-user-shared via S3**: the cost of extraction is paid once per PDF.
  Aligns with the existing chunk-cache economics.
- **Graceful degradation**: no migration of existing tutorials. Re-ingest
  is the opt-in path; old tutorials keep working with their old behavior.
- **Measurable via the harness**: Phase 1 of the eval harness can directly
  A/B "pre-B'" vs "post-B'" variants and emit per-persona ratings.
- **Modest cost delta**: ~$0.004/PDF ingest + ~$0.0014/chapter generation.
  Below the noise floor on a $2.17 full-DDIA read.

---

## Summary in one paragraph

Voice extractor + anchor extractor run at ingest, write structured JSON
alongside the existing S3 chunk cache. At generation, the narrative prompt
gets two injected blocks (author voice fingerprint + per-book anchor
whitelist) before the existing fidelity rules. A post-generation validator
flags chapters that dropped whitelist anchors present in their source
paragraphs. The fidelity scorer also receives the whitelist so its ratings
align with the validator. New tutorials get the full pipeline; existing
tutorials gracefully degrade to v3-shipped behavior. ~$0.004/PDF + ~$0.0014/chapter
cost delta; the source-grounding leverage point the three prompt iterations
identified as the next gain.

---

*End of design. Awaiting review.*
