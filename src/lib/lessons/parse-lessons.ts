// src/lib/lessons/parse-lessons.ts — split a chapter narrative into lessons.
//
// Feature A — multipage chapters. The narrative-only prompt requires output of
// the form:
//
//   ## Lesson 1: Motivating the Problem
//   ...body for lesson 1...
//
//   ## Lesson 2: Measuring Performance
//   ...body for lesson 2...
//
//   ## Lesson 3: Tradeoffs and Synthesis
//   ...body for lesson 3...
//
// This module turns that raw markdown string into an array of {title, body}
// records keyed by lesson index, so the UI can render one lesson per page.
//
// FALLBACK CONTRACT (load-bearing): if the input has fewer than 2 lesson
// markers (e.g., a chapter generated under the v3-shipped prompt before
// Feature A landed, or an LLM run that didn't emit markers), the parser
// returns a single-lesson array containing the whole narrative. This means
// EVERY chapter, old or new, can be rendered through the multipage UI; the
// graceful-degradation path is "one chapter = one lesson". No migration of
// existing chapter rows is required.
//
// Why a separate module:
//   - SRP: parsing markdown structure is a different change-reason from
//     citation parsing or content rendering. Tested in isolation.
//   - The fallback contract is the load-bearing invariant; localizing it
//     keeps the rest of the codebase from re-implementing edge cases.

export interface Lesson {
  /** 1-indexed lesson ordinal as authored in the markdown. */
  ordinal: number;
  /** Title from the `## Lesson N: <title>` header (without the prefix). */
  title: string;
  /** Markdown body of the lesson, NOT including its own `## Lesson` header.
   *  May still contain ### subheadings, lists, citations, etc. */
  body: string;
}

/**
 * Regex matching a lesson header at the start of a line.
 * Captures: (1) ordinal number, (2) title text.
 *
 * Anchored to `^` with the `m` flag so it matches at start of any line, not
 * only at start of string. The title runs to end-of-line (greedy non-newline).
 */
const LESSON_HEADER_RE = /^## Lesson (\d+):\s*(.+?)\s*$/gm;

/**
 * Split a chapter narrative into ordered lessons.
 *
 * Behavior:
 *   - Headers matched against `^## Lesson <N>: <title>` (case-sensitive — the
 *     prompt is explicit about exact form).
 *   - Content between header K and header K+1 (or end of string) is lesson K's
 *     body. Leading + trailing whitespace trimmed.
 *   - Any prose BEFORE the first lesson header is discarded (the prompt
 *     forbids preamble; if the LLM emits some anyway, we treat it as noise
 *     rather than a lesson-zero).
 *
 * Fallback:
 *   - If fewer than 2 lesson headers are found, returns a single lesson
 *     containing the entire input. This handles:
 *       a) Pre-Feature-A narratives (v3-shipped prompt, no markers)
 *       b) Future LLM runs that mis-format the structure
 *       c) Defensive: a "## Lesson 1:" alone (only 1 marker) — also single
 *          lesson, since 1 marker offers no pagination benefit; we use the
 *          whole input rather than splitting on a single boundary
 *
 * The fallback is deliberately conservative — if the structure is even
 * slightly off, render the whole chapter on one page rather than risk
 * showing a truncated or mis-ordered slice.
 */
export function parseLessons(narrative: string): Lesson[] {
  if (!narrative) {
    return [{ ordinal: 1, title: 'Chapter', body: '' }];
  }

  // Collect all header matches with their positions; we need positions to
  // slice the body between consecutive headers.
  const headers: Array<{ ordinal: number; title: string; start: number; end: number }> = [];
  const re = new RegExp(LESSON_HEADER_RE.source, LESSON_HEADER_RE.flags);
  let m: RegExpExecArray | null;
  while ((m = re.exec(narrative)) !== null) {
    const ordinalStr = m[1];
    const titleStr = m[2];
    if (!ordinalStr || !titleStr) continue;
    const ordinal = Number.parseInt(ordinalStr, 10);
    if (!Number.isFinite(ordinal) || ordinal < 1) continue;
    headers.push({
      ordinal,
      title: titleStr.trim(),
      start: m.index,
      end: m.index + m[0].length,
    });
  }

  // Fallback: <2 headers means we can't reliably paginate. Treat as one
  // lesson holding the whole narrative.
  if (headers.length < 2) {
    return [{ ordinal: 1, title: 'Chapter', body: narrative.trim() }];
  }

  // Slice bodies between headers.
  const lessons: Lesson[] = [];
  for (let i = 0; i < headers.length; i++) {
    const h = headers[i];
    if (!h) continue;
    const next = headers[i + 1];
    const bodyStart = h.end;
    const bodyEnd = next ? next.start : narrative.length;
    const body = narrative.slice(bodyStart, bodyEnd).trim();
    lessons.push({ ordinal: h.ordinal, title: h.title, body });
  }

  // Defensive: if the LLM authored e.g. `Lesson 1, Lesson 3` (skipping 2),
  // we still preserve the order they were authored in but flag the gap by
  // returning ordinals as-given. The UI uses ARRAY INDEX for navigation, not
  // ordinal — so a skip is visually invisible. We don't renumber because
  // renumbering would invalidate the "Lesson 3" label the LLM intended.
  return lessons;
}

/**
 * Count the lessons in a narrative without allocating Lesson objects.
 * Useful for the SSR pass when only the count is needed (e.g., to render a
 * progress bar before the lesson body is rendered).
 */
export function countLessons(narrative: string): number {
  if (!narrative) return 1;
  const re = new RegExp(LESSON_HEADER_RE.source, LESSON_HEADER_RE.flags);
  let count = 0;
  while (re.exec(narrative) !== null) count++;
  return count < 2 ? 1 : count;
}
