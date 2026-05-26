// src/lib/diagrams/weave.ts — Sprint H Wave 1 (Builder C).
//
// What this module is:
// --------------------
// A pure, idempotent string transformer that inserts ```diagram fences
// into a chapter narrative at semantically-anchored positions. The
// extractor (Builder A) returns a list of `ExtractedDiagram` — a Zod-
// valid F.1 `DiagramPayload` plus optional positional hints — and the
// per-chapter integration (Builder D) calls `weaveDiagrams` to splice
// fences into the narrative before persistence.
//
// Why pure-function (no fs, no DB, no Date.now):
// ----------------------------------------------
// Per Sprint H RFC §"Wave 1 → Builder C" and the F.1 architecture: the
// renderer dispatches on fenced ```diagram blocks in the persisted
// narrative; weave is the single bridge between the extractor's
// structured output and the renderer's text input. Keeping it pure means
// the test surface is "string-in, string-out", regen replays are
// deterministic, and Builder D can call us inside a transaction without
// worrying about side effects. Citing
// `kb:architecture/discipline/pure-function-discipline`.
//
// Why idempotency is load-bearing:
// --------------------------------
// Lazy regeneration in TB calls per-chapter.ts on demand. If a user
// regens a chapter that already has woven diagrams, the extractor will
// re-emit the same diagrams (the prose hasn't changed), and weave runs
// again on the previously-woven narrative. We MUST NOT double-insert,
// or the density metric will mis-count and the rendered chapter will
// repeat each diagram. Dedup is by canonical-JSON of the payload — the
// same content-addressed identity the renderer would use to render the
// block. Citing `kb:architecture/crosscut/idempotency`.
//
// Why match diagram-density.ts regex byte-for-byte:
// -------------------------------------------------
// The fence we emit must be counted by the eval-harness density metric.
// `src/lib/eval/diagram-density.ts` uses the regex
//   /^```(diagram|mermaid)[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*(?=\r?\n|$)/gm
// which requires the opening fence on its own line, the body terminated
// by a newline before the closing fence, and the closing fence followed
// by either a newline or EOF. We emit `\n\n```diagram\n<json>\n```\n\n`
// which satisfies the regex regardless of surrounding context.

import type { DiagramPayload } from './schema';

// ─────────────────────────────────────────────────────────────────────────────
// Public shape
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One diagram coming out of the extractor (Builder A) and into the weaver.
 *
 * `payload` is the F.1 Zod-validated structured-figure shape. The optional
 * hints below are best-effort positional anchors emitted by the extractor;
 * the weaver treats all hints as advisory and falls back to a deterministic
 * 30% character-position fallback when no hint matches.
 */
export interface ExtractedDiagram {
  payload: DiagramPayload;
  /**
   * Heading text the diagram belongs under (e.g. "Lesson 2: Performance").
   * Matched as a case-insensitive substring of any line starting with `## `.
   */
  anchorHeading?: string;
  /**
   * A citation token from the narrative body (e.g. `[ref:page105:paragraph10]`).
   * Matched as a substring of any line in the narrative.
   */
  anchorCitation?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Canonical JSON for dedup. Recursively sorts object keys so that two payloads
 * with the same content but different key insertion order serialize identically.
 *
 * Arrays preserve order (semantic for diagrams — row order, edge order, etc.).
 * Primitives serialize as-is. `undefined` is omitted, matching `JSON.stringify`.
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const body = entries
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
    .join(',');
  return `{${body}}`;
}

/**
 * Build the fence string that gets spliced into the narrative.
 *
 * The leading + trailing `\n\n` guarantees the fence is its own block — the
 * opening fence will always land at column 0 on its own line regardless of
 * whether the insertion point ends with `\n`, `\n\n`, or no newline at all
 * (we normalize during splice).
 */
function buildFence(payload: DiagramPayload): string {
  // One-line JSON (no indent) — keeps the fence body a single line which
  // is the most defensive shape against any markdown post-processor that
  // might mishandle blank lines inside a code fence. The density-metric
  // regex `[\s\S]*?` accepts either, but one-line is simpler to grep.
  const body = JSON.stringify(payload);
  return `\n\n\`\`\`diagram\n${body}\n\`\`\`\n\n`;
}

/**
 * Extract every existing ```diagram fence body from `narrative`. Used by the
 * idempotency dedup pass: before inserting, we canonicalize each existing
 * body's parsed JSON and skip if a match is already present.
 *
 * Uses the same regex shape as `diagram-density.ts` (the contract regex) so
 * what we count here is exactly what the eval-harness will count later.
 */
function existingDiagramBodies(narrative: string): string[] {
  const re = /^```diagram[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*(?=\r?\n|$)/gm;
  const bodies: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(narrative)) !== null) {
    bodies.push(match[1] ?? '');
  }
  return bodies;
}

/**
 * Given a narrative and an existing-bodies list, return the set of canonical-
 * JSON keys for diagrams already present. Bodies that fail JSON.parse are
 * silently ignored — they're either malformed (the extractor wouldn't have
 * produced them) or someone else's responsibility (the parser is the bouncer).
 */
function alreadyPresentKeys(narrative: string): Set<string> {
  const keys = new Set<string>();
  for (const body of existingDiagramBodies(narrative)) {
    try {
      const parsed = JSON.parse(body) as unknown;
      keys.add(canonicalJson(parsed));
    } catch {
      // Malformed existing block — skip. We don't want a malformed block
      // to suppress a valid insertion.
    }
  }
  return keys;
}

// ─────────────────────────────────────────────────────────────────────────────
// Insertion strategies
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Strategy 1 — insertAfterHeading. Look for the first line that starts with
 * `## ` and contains the anchor heading as a case-insensitive substring.
 *
 * Returns the byte offset in `narrative` immediately after that heading line
 * (and the immediately-following blank line, if any), or `null` if no match.
 */
function findHeadingAnchor(narrative: string, anchorHeading: string): number | null {
  const needle = anchorHeading.toLowerCase();
  const lines = narrative.split('\n');
  let cursor = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const lineWithNl = i < lines.length - 1 ? line.length + 1 : line.length;
    if (line.startsWith('## ') && line.toLowerCase().includes(needle)) {
      // Insertion point: end of the heading line (after its trailing \n).
      let offset = cursor + line.length;
      if (i < lines.length - 1) offset += 1; // include the heading's \n
      // If the next line is blank, advance past it so we land between
      // the heading and the next content paragraph cleanly.
      if (i + 1 < lines.length && (lines[i + 1] ?? '').trim() === '') {
        offset += (lines[i + 1] ?? '').length;
        if (i + 1 < lines.length - 1) offset += 1; // include the blank line's \n
      }
      return offset;
    }
    cursor += lineWithNl;
  }
  return null;
}

/**
 * Strategy 2 — insertAfterCitation. Look for the first line that contains the
 * anchor citation as a substring. Returns the byte offset immediately after
 * that line's trailing `\n`, or `null` if no match.
 */
function findCitationAnchor(narrative: string, anchorCitation: string): number | null {
  const lines = narrative.split('\n');
  let cursor = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const lineWithNl = i < lines.length - 1 ? line.length + 1 : line.length;
    if (line.includes(anchorCitation)) {
      return cursor + lineWithNl;
    }
    cursor += lineWithNl;
  }
  return null;
}

/**
 * Strategy 3 — 30% fallback. Insert after the first blank line at or past
 * the 30%-character mark. If no blank line exists past 30%, fall back to the
 * 30% mark itself (end-of-string-safe).
 *
 * The 30% number is a heuristic — it places diagrams past the opening prose
 * (which is usually scene-setting) but before the chapter conclusion, so they
 * land in the body where the meat of the content lives.
 */
function findFallbackAnchor(narrative: string): number {
  const threshold = Math.floor(narrative.length * 0.3);
  // Look for the first "\n\n" (paragraph boundary) at or past the threshold.
  const idx = narrative.indexOf('\n\n', threshold);
  if (idx === -1) {
    // Sprint H Wave 3 fix (Rev C HIGH-1): no paragraph boundary past the
    // 30% mark — APPEND at end-of-string rather than splitting mid-word
    // at the threshold. The original code returned `min(threshold,
    // narrative.length)` whose comment claimed "clamp to end of string"
    // but actually clamped to the 30% threshold, splitting words in
    // pathologically-short narratives (no `\n\n` past 30%). End-of-string
    // is the only insertion point guaranteed not to corrupt prose.
    return narrative.length;
  }
  // Land just past the "\n\n" so we're between paragraphs, not after the
  // first \n of a still-active paragraph block.
  return idx + 2;
}

/**
 * Splice a fence into the narrative at `offset`. Normalizes surrounding
 * whitespace so we always end up with exactly one blank line on each side
 * of the fence — no triple-newlines, no missing separators.
 */
function spliceFence(narrative: string, offset: number, fence: string): string {
  const before = narrative.slice(0, offset);
  const after = narrative.slice(offset);
  // `fence` is "\n\n```diagram\n<json>\n```\n\n". Normalize trailing
  // whitespace on `before` and leading whitespace on `after` so we don't
  // stack more than 2 newlines.
  const beforeTrimmed = before.replace(/\n+$/, '');
  const afterTrimmed = after.replace(/^\n+/, '');
  // If `before` is empty we don't need a leading separator (would be
  // ambient at start-of-file).
  const leadSep = beforeTrimmed.length === 0 ? '' : '\n\n';
  const trailSep = afterTrimmed.length === 0 ? '\n' : '\n\n';
  const fenceBody = fence.replace(/^\n+|\n+$/g, '');
  return `${beforeTrimmed}${leadSep}${fenceBody}${trailSep}${afterTrimmed}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public: weaveDiagrams
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Insert structured ```diagram fences into `narrative` at heading > citation >
 * 30%-fallback anchor sites. Pure, deterministic, idempotent.
 *
 * @param narrative The markdown narrative emitted by the LLM (no `\`\`\`diagram`
 *   fences yet, or possibly with some inline — both work).
 * @param diagrams  Extracted diagrams (F.1 payloads + optional positional
 *   hints from the extractor).
 * @returns A new narrative string with one ```diagram fence per non-duplicate
 *   diagram. Input narrative is never mutated.
 */
export function weaveDiagrams(narrative: string, diagrams: ExtractedDiagram[]): string {
  if (diagrams.length === 0) return narrative;

  let working = narrative;
  const seen = alreadyPresentKeys(working);

  for (const diagram of diagrams) {
    const key = canonicalJson(diagram.payload);
    if (seen.has(key)) continue;

    // Strategy ladder: heading → citation → 30% fallback.
    let offset: number | null = null;
    if (diagram.anchorHeading) {
      offset = findHeadingAnchor(working, diagram.anchorHeading);
    }
    if (offset === null && diagram.anchorCitation) {
      offset = findCitationAnchor(working, diagram.anchorCitation);
    }
    if (offset === null) {
      offset = findFallbackAnchor(working);
    }

    working = spliceFence(working, offset, buildFence(diagram.payload));
    seen.add(key);
  }

  return working;
}
