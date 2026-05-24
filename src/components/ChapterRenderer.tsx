'use client';

/**
 * src/components/ChapterRenderer.tsx — markdown + inline-citation tokenizer.
 *
 * LOAD-BEARING ABSORB: omar HIGH-3 (Phase 2 Wave 2 synthesis).
 *
 *   "LLM-emitted `[ref:pageN:paragraphM]` inline tokens must be tokenized into
 *    clickable `<button>` spans by ChapterRenderer (regex split + map to React)."
 *
 * The LLM may embed citation markers inline within the narrative markdown,
 * e.g.,
 *   "Replication is the process of keeping a copy of the same data on
 *    multiple nodes [ref:page151:paragraph2]. There are three main approaches:
 *    single-leader, multi-leader, and leaderless [ref:page151:paragraph3]."
 *
 * react-markdown handles the markdown → HTML transformation but treats
 * `[ref:...]` as plain text. We hook into the text-rendering layer to split
 * each text node on the citation pattern and replace matches with `<button>`s
 * that open the CitationModal.
 *
 * Why a custom `components.text` (instead of preprocessing the markdown):
 *   - Preserves markdown semantics: headings, lists, links, emphasis all work
 *     normally. The citation tokenizer only fires on plain text leaves.
 *   - Streaming-friendly: react-markdown re-renders incrementally as new
 *     tokens arrive. Each render's text leaves go through our splitter; no
 *     full-document AST walk needed.
 *   - Idempotent: if the LLM emits the same ref twice in the same paragraph,
 *     each instance becomes its own button (React keys are based on position
 *     within the split — stable across re-renders of the same node).
 *
 * Why NOT dangerouslySetInnerHTML or a custom parser:
 *   - react-markdown is already sanitizing (per its rehype defaults). Pulling
 *     in raw HTML defeats the safety guarantee.
 *   - The kb:web-dev/react-essentials §"Anti-patterns" explicitly flags
 *     `dangerouslySetInnerHTML` without sanitization as an XSS vector. We
 *     keep the chain clean: LLM → markdown → react-markdown → our tokenizer
 *     → React elements. No raw HTML.
 *
 * Citation regex shape (matches `[ref:pageN:paragraphM]`):
 *   - `page` then 1+ digits, then `:paragraph` then 1+ digits.
 *   - Allows N=1 minimum (PDF page numbers are 1-based; first valid is page 1).
 *   - paragraphM is 0-based per the SourceParagraphRef contract (src/lib/types.ts:70).
 *   - Greedy on digits — won't match `[ref:page12foo:paragraph3]` (foo breaks
 *     the pattern). Designed to be conservative: false positives in source
 *     prose would corrupt the UI; false negatives just leave the ref as text.
 */

import React, { useMemo, useState, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import type { Components } from 'react-markdown';
import type { SourceParagraph } from '@/lib/types';
import { CitationModal } from './CitationModal';

// ───────────────────────────────────────────────────────────────────────────
// Citation regex + tokenizer
// ───────────────────────────────────────────────────────────────────────────

/**
 * `[ref:pageN:paragraphM]` (single) OR `[ref:pageN:paragraphM-K]` (range) —
 * captures page and paragraph indices.
 *
 * Groups: 1 = page, 2 = paragraphStart, 3 = paragraphEnd (optional).
 *
 * Why two shapes:
 *   - The LLM emits BOTH single-paragraph (`paragraph2`) and range
 *     (`paragraph0-5`) citations depending on how much of the source it
 *     paraphrased into one inline reference. Empirically: DDIA chapter
 *     summaries cite multi-paragraph ranges; specific-claim citations
 *     cite single paragraphs. The Sprint-A walkthrough capture showed
 *     range citations as plain text leaking into the UI — the original
 *     single-only regex never matched them.
 *
 * Behavior:
 *   - If the range form fires, `paragraphIdx` = start; `paragraphEnd` = end.
 *     CitationButton renders `[p.26 ¶1-6]`; CitationModal shows all
 *     paragraphs in the range when resolvable.
 *   - If the single form fires, `paragraphEnd` = undefined.
 *
 * Global flag for .matchAll; case-insensitive for robustness against LLM
 * casing drift (`Ref` vs `ref`).
 */
const CITATION_RE = /\[ref:page(\d+):paragraph(\d+)(?:-(\d+))?\]/gi;

interface CitationToken {
  kind: 'citation';
  page: number;
  paragraphIdx: number;
  /** End of the paragraph range (inclusive) when the marker is a range. */
  paragraphEnd?: number;
  /** Original raw text matched, for key stability. */
  raw: string;
}

interface TextToken {
  kind: 'text';
  text: string;
}

type Token = CitationToken | TextToken;

/**
 * Split a string into an alternating sequence of text and citation tokens.
 * Pure function — easy to unit-test (Phase 4 test scope).
 *
 * Invariants:
 *   - Concatenating all token texts (text.text || citation.raw) recovers
 *     the original input exactly.
 *   - No two adjacent TextTokens (we coalesce empty splits).
 */
export function tokenizeCitations(input: string): Token[] {
  const tokens: Token[] = [];
  let lastIndex = 0;
  // Reset regex state — .matchAll creates a fresh iterator but if the regex
  // were used with .exec elsewhere, lastIndex could be non-zero. Defensive.
  CITATION_RE.lastIndex = 0;
  for (const match of input.matchAll(CITATION_RE)) {
    const matchStart = match.index;
    // matchAll returns matches with `.index` always defined for global regex;
    // TypeScript types it as optional. Guard for safety with no-uncheckedAccess.
    if (typeof matchStart !== 'number') continue;
    if (matchStart > lastIndex) {
      tokens.push({ kind: 'text', text: input.slice(lastIndex, matchStart) });
    }
    // match[1] / match[2] are page and paragraph-start; match[3] is the
    // optional range-end. For a successful global-flag match groups 1+2
    // MUST be defined; group 3 is undefined for single-paragraph form.
    const pageStr = match[1] ?? '';
    const paraStr = match[2] ?? '';
    const paraEndStr = match[3];
    const page = Number.parseInt(pageStr, 10);
    const paragraphIdx = Number.parseInt(paraStr, 10);
    const paragraphEnd =
      typeof paraEndStr === 'string' ? Number.parseInt(paraEndStr, 10) : undefined;
    tokens.push({
      kind: 'citation',
      page,
      paragraphIdx,
      ...(typeof paragraphEnd === 'number' && !Number.isNaN(paragraphEnd)
        ? { paragraphEnd }
        : {}),
      raw: match[0],
    });
    lastIndex = matchStart + match[0].length;
  }
  if (lastIndex < input.length) {
    tokens.push({ kind: 'text', text: input.slice(lastIndex) });
  }
  return tokens;
}

// ───────────────────────────────────────────────────────────────────────────
// Component
// ───────────────────────────────────────────────────────────────────────────

export interface ChapterRendererProps {
  /** The chapter narrative in markdown (may contain inline `[ref:...]`). */
  narrative: string;
  /**
   * The source paragraph index for this chapter (from
   * `chapter.source_paragraphs_json`). Used to resolve citation clicks into
   * actual paragraph text shown in CitationModal.
   */
  sourceParagraphs: SourceParagraph[];
}

interface ActiveCitation {
  page: number;
  paragraphIdx: number;
  /** Inclusive end-paragraph for range citations; undefined for single. */
  paragraphEnd?: number;
}

export function ChapterRenderer({ narrative, sourceParagraphs }: ChapterRendererProps) {
  const [active, setActive] = useState<ActiveCitation | null>(null);

  /**
   * Resolve a citation to its SourceParagraph. O(1) lookup via a Map keyed
   * by `${page}:${paragraphIdx}`. Memoized over sourceParagraphs identity so
   * the index isn't rebuilt every render.
   */
  const sourceIndex = useMemo(() => {
    const m = new Map<string, SourceParagraph>();
    for (const p of sourceParagraphs) {
      m.set(`${p.page}:${p.paragraphIdx}`, p);
    }
    return m;
  }, [sourceParagraphs]);

  const handleCitationClick = useCallback(
    (page: number, paragraphIdx: number, paragraphEnd?: number): void => {
      setActive(
        typeof paragraphEnd === 'number'
          ? { page, paragraphIdx, paragraphEnd }
          : { page, paragraphIdx },
      );
    },
    [],
  );

  const handleClose = useCallback((): void => {
    setActive(null);
  }, []);

  /**
   * react-markdown v9 components map.
   *
   * IMPORTANT: react-markdown v9 removed the `text` slot that earlier versions
   * exposed (see https://github.com/remarkjs/react-markdown/issues/783). Plain
   * text nodes inside paragraphs/headings/list items don't pass through any
   * customizable hook anymore — they render directly as strings. The previous
   * code attempted to override `text` and silently no-op'd; combined with the
   * regex that didn't accept range syntax (`paragraph0-5`), citation buttons
   * never appeared on any narrative in production.
   *
   * The right approach in v9: override the block elements that carry text
   * (p / li / heading levels) and recursively walk their children, tokenizing
   * any string leaves into our CitationButton spans. Inline elements (em,
   * strong, code, a) get the same treatment so citations inside emphasis or
   * links still resolve.
   *
   * Why not preprocess the markdown string before handing to react-markdown:
   *   keeps the regex out of the markdown grammar layer — links / code spans
   *   / fenced blocks that happen to contain a `[ref:...]` token (e.g., a
   *   code example) would otherwise be incorrectly tokenized. Walking the
   *   rendered tree is safer: code blocks bypass our walker.
   */
  const tokenizeChildren = useCallback(
    (children: React.ReactNode): React.ReactNode => {
      const arr = React.Children.toArray(children);
      return arr.map((child, i) => {
        if (typeof child === 'string') {
          const tokens = tokenizeCitations(child);
          if (tokens.length === 1 && tokens[0]?.kind === 'text') {
            return child;
          }
          return (
            <React.Fragment key={`tk-${i}`}>
              {tokens.map((tok, j) =>
                tok.kind === 'text' ? (
                  <React.Fragment key={`t-${i}-${j}`}>{tok.text}</React.Fragment>
                ) : (
                  <CitationButton
                    key={`c-${i}-${j}-${tok.raw}`}
                    page={tok.page}
                    paragraphIdx={tok.paragraphIdx}
                    paragraphEnd={tok.paragraphEnd}
                    onClick={handleCitationClick}
                  />
                ),
              )}
            </React.Fragment>
          );
        }
        return child;
      });
    },
    [handleCitationClick],
  );

  const components: Components = useMemo(
    () => ({
      p: ({ children, ...rest }) => <p {...rest}>{tokenizeChildren(children)}</p>,
      li: ({ children, ...rest }) => <li {...rest}>{tokenizeChildren(children)}</li>,
      h1: ({ children, ...rest }) => <h1 {...rest}>{tokenizeChildren(children)}</h1>,
      h2: ({ children, ...rest }) => <h2 {...rest}>{tokenizeChildren(children)}</h2>,
      h3: ({ children, ...rest }) => <h3 {...rest}>{tokenizeChildren(children)}</h3>,
      h4: ({ children, ...rest }) => <h4 {...rest}>{tokenizeChildren(children)}</h4>,
      h5: ({ children, ...rest }) => <h5 {...rest}>{tokenizeChildren(children)}</h5>,
      h6: ({ children, ...rest }) => <h6 {...rest}>{tokenizeChildren(children)}</h6>,
      em: ({ children, ...rest }) => <em {...rest}>{tokenizeChildren(children)}</em>,
      strong: ({ children, ...rest }) => <strong {...rest}>{tokenizeChildren(children)}</strong>,
    }),
    [tokenizeChildren],
  );

  // Resolve the active citation to one paragraph (single) or many
  // (range). Range is inclusive on both ends. Missing paragraphs are
  // dropped silently — the modal renders only what's resolvable.
  const activeParagraphs: SourceParagraph[] = useMemo(() => {
    if (active === null) return [];
    const end = active.paragraphEnd ?? active.paragraphIdx;
    const result: SourceParagraph[] = [];
    for (let i = active.paragraphIdx; i <= end; i++) {
      const p = sourceIndex.get(`${active.page}:${i}`);
      if (p) result.push(p);
    }
    return result;
  }, [active, sourceIndex]);

  return (
    <div className="prose prose-sm dark:prose-invert max-w-none">
      <ReactMarkdown components={components}>{narrative}</ReactMarkdown>
      <CitationModal
        open={active !== null}
        page={active?.page ?? 0}
        paragraphIdx={active?.paragraphIdx ?? 0}
        paragraphEnd={active?.paragraphEnd}
        paragraph={activeParagraphs[0] ?? null}
        paragraphs={activeParagraphs}
        onClose={handleClose}
      />
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// CitationButton — semantic <button> per kb:web-dev/react-essentials a11y rule
// ───────────────────────────────────────────────────────────────────────────

interface CitationButtonProps {
  page: number;
  paragraphIdx: number;
  paragraphEnd?: number;
  onClick: (page: number, paragraphIdx: number, paragraphEnd?: number) => void;
}

function CitationButton({ page, paragraphIdx, paragraphEnd, onClick }: CitationButtonProps) {
  const handleClick = useCallback((): void => {
    onClick(page, paragraphIdx, paragraphEnd);
  }, [onClick, page, paragraphIdx, paragraphEnd]);

  // Display:
  //   single: `[p.151 ¶3]`
  //   range:  `[p.26 ¶1-6]`
  // Compact, scannable, conveys page + paragraph(s) without consuming much
  // inline-flow real estate. User-facing paragraph nums are 1-based (+1) to
  // match CitationModal's heading convention.
  const userStart = paragraphIdx + 1;
  const userEnd =
    typeof paragraphEnd === 'number' ? paragraphEnd + 1 : undefined;
  const label =
    typeof userEnd === 'number' && userEnd !== userStart
      ? `View source: page ${page}, paragraphs ${userStart}–${userEnd}`
      : `View source: page ${page}, paragraph ${userStart}`;
  const text =
    typeof userEnd === 'number' && userEnd !== userStart
      ? `[p.${page} ¶${userStart}-${userEnd}]`
      : `[p.${page} ¶${userStart}]`;
  return (
    <button
      type="button"
      onClick={handleClick}
      aria-label={label}
      className="inline align-baseline mx-0.5 px-1 py-0 text-xs rounded bg-secondary text-secondary-foreground hover:bg-accent hover:text-accent-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
    >
      {text}
    </button>
  );
}
