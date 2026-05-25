'use client';

/**
 * src/components/CitationPopover.tsx — Radix Popover anchored to inline citation chips.
 *
 * Sprint C Phase 2: the UX Designer's "top one-line UX moment" — the highest-
 * leverage single UI change from the round-2 review.
 *
 * Pre-Phase-2, clicking a `[ref:pageN:paragraphM]` chip opened the full-screen
 * `<dialog>`-backed CitationModal. That broke reading flow: the modal stole
 * focus, dimmed the page, and required an explicit dismiss for what is usually
 * a glance-check ("which page was that?"). The UX-hybrid audit and the round-2
 * UX-designer persona converged on the same recommendation: a Stripe-Press-
 * style marginalia popover, anchored to the chip, dismissable by clicking
 * away.
 *
 * Why a popover, not a tooltip:
 *   - Tooltips are visual-only; popovers can carry semantic content (paragraph
 *     text, an "open in source" link). The reader's question is usually
 *     "what does this cite?", which means the paragraph text itself is the
 *     payload — a tooltip would force everything into the title attribute and
 *     be invisible to keyboard users.
 *   - Radix Popover handles focus management, outside-click dismiss, Escape,
 *     and ARIA wiring automatically. Authoring those manually for a tooltip
 *     would be more code than the popover itself.
 *
 * Escape hatch: when the citation spans more than 2 paragraphs, the popover
 * would be too cramped to render the source text usefully. ChapterRenderer
 * routes those to the existing CitationModal instead (kept unchanged). The
 * popover's "View in source →" footer link is the second escape hatch: even
 * for short citations, the reader can opt up to the full modal for the
 * fullwidth view (the modal has copy-friendly text and the original
 * paragraph indices in its header).
 *
 * a11y discipline:
 *   - Radix supplies `role="dialog"` + focus trap on the content; we add
 *     `aria-label="Citation source"` for screen-reader context.
 *   - `Popover.Arrow` gives a visual anchor so sighted users understand the
 *     popover relates to the chip they just clicked.
 *   - The trigger is the existing <CitationButton> (a real <button>) — Radix
 *     wraps it via Popover.Trigger asChild, preserving its semantics.
 */

import * as React from 'react';
import * as Popover from '@radix-ui/react-popover';
import type { SourceParagraph } from '@/lib/types';

export interface CitationPopoverProps {
  /**
   * The resolved source paragraph(s) for this citation. For a single citation
   * this has 1 entry; for a 2-paragraph range it has 2. If empty (paragraph
   * unresolvable), the popover renders a graceful fallback with just the
   * page/paragraph header.
   */
  paragraphs: SourceParagraph[];
  /** Page number (1-based) for the citation header. */
  page: number;
  /** Start paragraph index (0-based; +1 for user display). */
  paragraphIdx: number;
  /** End paragraph index (0-based, inclusive) for ranges; undefined for single. */
  paragraphEnd?: number;
  /**
   * Called when the user clicks the "View in source →" footer link. Parent
   * (ChapterRenderer) sets its `active` state to open the existing
   * <CitationModal> at the full text. The popover closes automatically via
   * Radix's outside-click handler once the modal mounts.
   */
  onOpenInFull: () => void;
  /** The trigger element — the existing inline <CitationButton>. */
  children: React.ReactNode;
}

export function CitationPopover({
  paragraphs,
  page,
  paragraphIdx,
  paragraphEnd,
  onOpenInFull,
  children,
}: CitationPopoverProps) {
  // User-facing paragraph numbers are 1-based (+1) to match CitationModal's
  // and CitationButton's convention.
  const userStart = paragraphIdx + 1;
  const userEnd =
    typeof paragraphEnd === 'number' ? paragraphEnd + 1 : undefined;
  const headerLabel =
    typeof userEnd === 'number' && userEnd !== userStart
      ? `Page ${page} · ¶${userStart}–¶${userEnd}`
      : `Page ${page} · ¶${userStart}`;

  return (
    <Popover.Root>
      <Popover.Trigger asChild>{children}</Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="top"
          sideOffset={6}
          collisionPadding={8}
          aria-label="Citation source"
          className="citation-popover-content z-50 max-w-sm rounded-md border border-paper-edge bg-paper-deep p-4 shadow-paper"
        >
          <div className="mb-2 font-mono text-micro uppercase tracking-wider text-citation">
            {headerLabel}
          </div>
          {paragraphs.length > 0 ? (
            <div className="space-y-2 font-serif text-sm leading-relaxed text-ink">
              {paragraphs.map((p, i) => (
                <p
                  key={`${p.page}-${p.paragraphIdx}-${i}`}
                  className="line-clamp-6"
                >
                  {p.text}
                </p>
              ))}
            </div>
          ) : (
            <p className="font-serif text-sm italic text-ink-muted">
              Source paragraph unavailable — open the full source view for
              context.
            </p>
          )}
          <div className="mt-3 flex justify-end border-t border-paper-edge pt-2">
            <button
              type="button"
              onClick={onOpenInFull}
              className="font-mono text-xs text-brand hover:text-brand-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
            >
              View in source →
            </button>
          </div>
          <Popover.Arrow
            width={10}
            height={5}
            style={{ fill: 'hsl(var(--paper-edge))' }}
          />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
