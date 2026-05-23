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

import { useMemo, useState, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import type { Components } from 'react-markdown';
import type { SourceParagraph } from '@/lib/types';
import { CitationModal } from './CitationModal';

// ───────────────────────────────────────────────────────────────────────────
// Citation regex + tokenizer
// ───────────────────────────────────────────────────────────────────────────

/**
 * `[ref:pageN:paragraphM]` — captures page and paragraph indices.
 * Groups: 1 = page, 2 = paragraph.
 * Global flag for .matchAll; case-insensitive for robustness against LLM
 * casing drift (`Ref` vs `ref`).
 */
const CITATION_RE = /\[ref:page(\d+):paragraph(\d+)\]/gi;

interface CitationToken {
  kind: 'citation';
  page: number;
  paragraphIdx: number;
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
    // match[1] / match[2] are page and paragraph capture groups; for a
    // successful global-flag match they MUST be defined. Defensive parse
    // anyway — Number('') is 0, /\d+/ rules out '', so this is paranoia.
    const pageStr = match[1] ?? '';
    const paraStr = match[2] ?? '';
    const page = Number.parseInt(pageStr, 10);
    const paragraphIdx = Number.parseInt(paraStr, 10);
    tokens.push({
      kind: 'citation',
      page,
      paragraphIdx,
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
    (page: number, paragraphIdx: number): void => {
      setActive({ page, paragraphIdx });
    },
    [],
  );

  const handleClose = useCallback((): void => {
    setActive(null);
  }, []);

  /**
   * react-markdown components map. We override the renderers that produce
   * text children — `p`, `li`, `h1-h6`, `em`, `strong`, etc — to walk their
   * children and tokenize any string children.
   *
   * Rather than override every text-producing element individually, we use
   * the `components.text` slot which fires for every plain text node. This
   * keeps the override surface small and behaviorally correct.
   *
   * Note: react-markdown v9 calls this with a node object whose `.value`
   * carries the text. Older versions passed `children` directly. We support
   * the v9 shape (per package.json `react-markdown: 9.0.1`).
   */
  const components: Components = useMemo(
    () => ({
      // The text node renderer. In react-markdown v9 plain text nodes pass
      // through this slot. We intercept and tokenize.
      // The type `Components['text']` doesn't expose a clean way to pull
      // string content, so we cast via the `node.value` field documented
      // in the hast spec (which react-markdown's mdast→hast layer surfaces).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      text: (props: any) => {
        // props.children is the text content for v9; node.value is the hast value.
        const raw =
          typeof props.children === 'string'
            ? props.children
            : typeof props?.node?.value === 'string'
              ? props.node.value
              : '';
        if (raw === '') return null;
        const tokens = tokenizeCitations(raw);
        if (tokens.length === 1 && tokens[0]?.kind === 'text') {
          // Common case — no citations in this text node. Return as-is to
          // avoid the wrapping <>...</> fragment which would be wasted work.
          return raw;
        }
        return (
          <>
            {tokens.map((tok, i) =>
              tok.kind === 'text' ? (
                // Position-stable key — react-markdown re-renders the same
                // text node on streaming updates; position within the split
                // is stable for a given input string.
                <span key={`t-${i}`}>{tok.text}</span>
              ) : (
                <CitationButton
                  key={`c-${i}-${tok.raw}`}
                  page={tok.page}
                  paragraphIdx={tok.paragraphIdx}
                  onClick={handleCitationClick}
                />
              ),
            )}
          </>
        );
      },
    }),
    [handleCitationClick],
  );

  const activeParagraph =
    active === null
      ? null
      : sourceIndex.get(`${active.page}:${active.paragraphIdx}`) ?? null;

  return (
    <div className="prose prose-sm dark:prose-invert max-w-none">
      <ReactMarkdown components={components}>{narrative}</ReactMarkdown>
      <CitationModal
        open={active !== null}
        page={active?.page ?? 0}
        paragraphIdx={active?.paragraphIdx ?? 0}
        paragraph={activeParagraph}
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
  onClick: (page: number, paragraphIdx: number) => void;
}

function CitationButton({ page, paragraphIdx, onClick }: CitationButtonProps) {
  const handleClick = useCallback((): void => {
    onClick(page, paragraphIdx);
  }, [onClick, page, paragraphIdx]);

  // Display: `[p.151 ¶3]` — compact, scannable, conveys "page 151, paragraph 3"
  // without consuming inline-flow real estate. The user-facing paragraph num
  // is 1-based (+1) to match CitationModal's heading convention.
  const userParaNum = paragraphIdx + 1;
  return (
    <button
      type="button"
      onClick={handleClick}
      aria-label={`View source: page ${page}, paragraph ${userParaNum}`}
      className="inline align-baseline mx-0.5 px-1 py-0 text-xs rounded bg-secondary text-secondary-foreground hover:bg-accent hover:text-accent-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
    >
      [p.{page} ¶{userParaNum}]
    </button>
  );
}
