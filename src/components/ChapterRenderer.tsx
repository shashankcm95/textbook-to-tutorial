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
import { CitationPopover } from './CitationPopover';
import { LessonCanvas } from './LessonCanvas';
import { MermaidDiagram } from './MermaidDiagram';

/**
 * Sprint C Phase 2 — popover vs modal threshold. Citations covering 1-2 source
 * paragraphs open in the inline Radix Popover (Stripe-Press marginalia
 * convention); citations covering 3+ paragraphs fall through to the full
 * <CitationModal> because a popover would be too cramped to render the
 * volume of source text usefully. The UX-designer round-2 review identified
 * the popover as the "top one-line UX moment" — this constant is the seam.
 */
const POPOVER_MAX_PARAGRAPHS = 2;

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
  /**
   * When true, LessonCanvas renders the Stripe-Press-adjacent drop-cap on
   * the very first paragraph. Reserved for the FIRST lesson of the FIRST
   * chapter only — applying it everywhere would feel ornamental, not
   * editorial. Caller (ChapterLessons) computes this as
   * `isFirstChapter && lessonIdx === 0`.
   */
  isFirstLesson?: boolean;
}

interface ActiveCitation {
  page: number;
  paragraphIdx: number;
  /** Inclusive end-paragraph for range citations; undefined for single. */
  paragraphEnd?: number;
}

export function ChapterRenderer({ narrative, sourceParagraphs, isFirstLesson = false }: ChapterRendererProps) {
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
  /**
   * Resolve a citation token to its source paragraphs (inclusive range). Used
   * by the popover path to render the actual source text inline. Returns the
   * SAME list shape the modal uses, so the modal's escape-hatch and the
   * popover render against an identical resolution.
   */
  const resolveCitationParagraphs = useCallback(
    (page: number, paragraphIdx: number, paragraphEnd?: number): SourceParagraph[] => {
      const end = paragraphEnd ?? paragraphIdx;
      const out: SourceParagraph[] = [];
      for (let i = paragraphIdx; i <= end; i++) {
        const p = sourceIndex.get(`${page}:${i}`);
        if (p) out.push(p);
      }
      return out;
    },
    [sourceIndex],
  );

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
              {tokens.map((tok, j) => {
                if (tok.kind === 'text') {
                  return (
                    <React.Fragment key={`t-${i}-${j}`}>{tok.text}</React.Fragment>
                  );
                }
                // Sprint C Phase 2: short citations (≤2 paragraphs) get the
                // inline Radix Popover; longer ranges fall through to the
                // full CitationModal because a popover would be too cramped.
                // Computing the range size here lets us route deterministically
                // at render-time without juggling state.
                const rangeSize =
                  typeof tok.paragraphEnd === 'number'
                    ? tok.paragraphEnd - tok.paragraphIdx + 1
                    : 1;
                const button = (
                  <CitationButton
                    page={tok.page}
                    paragraphIdx={tok.paragraphIdx}
                    paragraphEnd={tok.paragraphEnd}
                    onClick={handleCitationClick}
                  />
                );
                if (rangeSize > POPOVER_MAX_PARAGRAPHS) {
                  // Long-range citation — click goes straight to the modal,
                  // same as pre-Phase-2 behavior.
                  return (
                    <React.Fragment key={`c-${i}-${j}-${tok.raw}`}>
                      {button}
                    </React.Fragment>
                  );
                }
                // Short citation — wrap the button in CitationPopover. The
                // popover's "View in source →" footer calls
                // handleCitationClick, which opens the existing modal as the
                // escape-hatch (deeper view of the same content).
                const resolved = resolveCitationParagraphs(
                  tok.page,
                  tok.paragraphIdx,
                  tok.paragraphEnd,
                );
                return (
                  <CitationPopover
                    key={`c-${i}-${j}-${tok.raw}`}
                    page={tok.page}
                    paragraphIdx={tok.paragraphIdx}
                    paragraphEnd={tok.paragraphEnd}
                    paragraphs={resolved}
                    onOpenInFull={() =>
                      handleCitationClick(
                        tok.page,
                        tok.paragraphIdx,
                        tok.paragraphEnd,
                      )
                    }
                  >
                    {button}
                  </CitationPopover>
                );
              })}
            </React.Fragment>
          );
        }
        return child;
      });
    },
    [handleCitationClick, resolveCitationParagraphs],
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
      // Sprint-Bv2.5: detect ```mermaid fenced blocks and render them as
      // an actual SVG diagram via the MermaidDiagram component. react-
      // markdown passes the code block's language as a className like
      // `language-mermaid`; falling back to the default render for any
      // other language preserves syntax-highlighting / plain code blocks.
      //
      // The `inline` flag (true for inline `<code>` like `foo`) is
      // explicitly passed-through unchanged — inline code never becomes
      // a diagram, only fenced blocks.
      // Sprint E Tier 1: <figure> wrapper + brand-themed img override.
      //
      // Render-prep for future figure-extraction work — today no markdown image
      // syntax (`![alt](src)`) is emitted into narratives, so this override
      // stays dormant. The image-handling audit (588 chapter rows scanned)
      // measured 100% figure drop empirically; FIDELITY rule 8 (added in this
      // same PR) instructs the LLM to reference figures by label, which is
      // step 1. Step 2 will be a future ingest pass that materializes Figure
      // X-Y into `![Figure X-Y caption](s3://.../figure-x-y.png)` markdown.
      // When that lands, no ChapterRenderer change will be needed — this slot
      // is already brand-themed (paper-edge border + ink-muted caption) and
      // wraps each image in a semantic <figure>/<figcaption> pair.
      //
      // Why eslint-disable next/no-img-element: the markdown source URL is
      // unknown at build time (resolved from S3 at runtime) so next/image
      // would require a dynamic loader; <img> with explicit max-width is the
      // simpler safe choice for the dormant render-prep slot. Revisit if
      // figure-extraction lands a known origin we can configure with
      // next.config images.remotePatterns.
      img: ({ src, alt, title }: { src?: string; alt?: string; title?: string }) => (
        <figure className="my-stanza">
          {src ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={src}
              alt={alt ?? ''}
              title={title}
              className="mx-auto max-w-full rounded-md border border-paper-edge shadow-paper-sm"
            />
          ) : null}
          {alt ? (
            <figcaption className="mt-2 text-center font-sans text-caption italic text-ink-muted">
              {alt}
            </figcaption>
          ) : null}
        </figure>
      ),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      code: ({ inline, className, children, ...rest }: any) => {
        const isMermaid =
          !inline &&
          typeof className === 'string' &&
          /\blanguage-mermaid\b/.test(className);
        if (isMermaid) {
          // Mermaid source is the raw text content of the code block.
          // react-markdown gives us children as an array of strings (or a
          // single string); join + trim for safety against fence-trailing
          // whitespace.
          const source = (Array.isArray(children) ? children.join('') : String(children ?? '')).trim();
          if (source.length === 0) return null;
          return <MermaidDiagram source={source} />;
        }
        // Default: emit normal <code>. Inline code already gets the
        // LessonCanvas mono+brand-fade style via the `[&_code]:…`
        // selectors; we don't tokenize citations inside code (would
        // mangle a literal `[ref:...]` example).
        return (
          <code className={className} {...rest}>
            {children}
          </code>
        );
      },
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

  // Sprint-Bv2: swap the inline `prose prose-sm` wrapper for the brand
  // `<LessonCanvas>` (Source Serif 4 at 19/1.75, Newsreader headings,
  // hung punctuation, OpenType ligatures). The CitationModal stays
  // outside the canvas — modals belong at the document root, not
  // nested inside the lesson typography.
  //
  // Round-2 quick win: drop-cap opt-in via `isFirstLesson` is now threaded
  // from ChapterLessons (chapter ordinal 0 + lesson idx 0 only). Student
  // Round-2 found the dead-wire: prior to this, the prop existed in
  // LessonCanvas but no caller ever set it true, so the "editorial moment"
  // never fired.
  return (
    <>
      <LessonCanvas isFirstLesson={isFirstLesson}>
        <ReactMarkdown components={components}>{narrative}</ReactMarkdown>
      </LessonCanvas>
      <CitationModal
        open={active !== null}
        page={active?.page ?? 0}
        paragraphIdx={active?.paragraphIdx ?? 0}
        paragraphEnd={active?.paragraphEnd}
        paragraph={activeParagraphs[0] ?? null}
        paragraphs={activeParagraphs}
        onClose={handleClose}
      />
    </>
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

  // Sprint-Bv2 — superscript "footnote chip" style.
  //
  // Pre-Sprint-Bv2 the marker rendered as `[p.26 ¶1-6]` — readable but
  // inline-code-shaped, which clobbered the reading rhythm. The UX-hybrid
  // audit (§3.3) calls for a real footnote convention: a small,
  // superscripted, citation-colored chip that gets out of the way until
  // the reader wants it.
  //
  // We retain the page-and-paragraph numbers in the aria-label for
  // assistive tech (the visible chip just shows `[p.26]` to stay tiny),
  // and the click handler still opens the source paragraph(s) in the
  // citation modal. Once Sprint C lands Radix Popover, this becomes
  // hover-and-click; for now it stays click-to-open.
  return (
    <sup className="inline-block align-super">
      <button
        type="button"
        onClick={handleClick}
        aria-label={label}
        className="mx-0.5 inline-flex items-center rounded-sm bg-citation-fade px-1 py-px font-mono text-[0.6875rem] font-medium leading-none text-citation transition-colors duration-snap ease-decelerate hover:bg-citation hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-citation"
      >
        p.{page}
      </button>
    </sup>
  );
}
