'use client';

/**
 * src/components/CitationModal.tsx — proof-citation popover for inline refs.
 *
 * Renders when the user clicks a `[ref:pageN:paragraphM]` button inside
 * ChapterRenderer. Shows the raw source paragraph text from the PDF index
 * (`chapter.source_paragraphs_json`) so the user can verify the LLM's claim
 * traces back to a real sentence in the source.
 *
 * Per the "Proof-Backed Portfolio" pattern (from project memory): every AI
 * claim traces to code evidence. Here, the claim is the question/flashcard;
 * the evidence is the source paragraph; the modal is the bridge.
 *
 * Why a dialog (`<dialog>`) and not a portal-rendered div:
 *   - Native `<dialog>` element gets accessibility tree treatment for free:
 *     focus trap, Escape closes, role=dialog. Browser support is solid in
 *     Chrome/Edge/Firefox/Safari 15.4+ (covers the Next.js 14 target).
 *   - The `showModal()` API auto-handles backdrop, scroll lock, and the
 *     :modal pseudo-class for styling.
 *   - Avoids the React-Portal + focus-management code that you'd otherwise
 *     have to author from scratch (or pull in @radix-ui/react-dialog for —
 *     ~30KB gz unnecessary for a single modal in this app).
 *
 * a11y discipline (kb:web-dev/react-essentials §"Accessibility"):
 *   - `<dialog>` with `aria-labelledby` pointing to the heading.
 *   - Close button has visible focus state + descriptive label.
 *   - Escape key closes (browser default for <dialog>).
 */

import { useEffect, useRef } from 'react';
import type { SourceParagraph } from '@/lib/types';

export interface CitationModalProps {
  /** Whether the modal is open. Parent controls. */
  open: boolean;
  /** The page (1-based) the citation points at. Used for the header label. */
  page: number;
  /** The paragraph index (0-based) within that page. */
  paragraphIdx: number;
  /**
   * The resolved source paragraph, or null if not yet loaded / not found.
   * Parent is responsible for looking up the SourceParagraph from
   * `chapter.source_paragraphs_json`. We render-only here (SRP).
   */
  paragraph: SourceParagraph | null;
  /** Called when the user dismisses (Escape, backdrop click, X button). */
  onClose: () => void;
}

export function CitationModal(props: CitationModalProps) {
  const { open, page, paragraphIdx, paragraph, onClose } = props;
  const dialogRef = useRef<HTMLDialogElement | null>(null);

  // Sync the React `open` prop with the imperative `<dialog>` API.
  // `showModal()` opens with backdrop; `close()` dismisses.
  useEffect(() => {
    const dlg = dialogRef.current;
    if (!dlg) return;
    if (open && !dlg.open) {
      dlg.showModal();
    } else if (!open && dlg.open) {
      dlg.close();
    }
  }, [open]);

  // Wire the `close` event (fires on Escape or .close() call) back to React state.
  useEffect(() => {
    const dlg = dialogRef.current;
    if (!dlg) return;
    const handler = (): void => onClose();
    dlg.addEventListener('close', handler);
    return () => dlg.removeEventListener('close', handler);
  }, [onClose]);

  // Backdrop click — if the user clicks outside the dialog content (i.e. on
  // the ::backdrop), close. We attach to the dialog itself and check if the
  // click target is the dialog (backdrop = clicks register on the dialog
  // element directly; content clicks bubble through their children).
  const handleDialogClick: React.MouseEventHandler<HTMLDialogElement> = (e) => {
    if (e.target === dialogRef.current) {
      onClose();
    }
  };

  // Page is human-readable (1-based); paragraph is 0-based internally but we
  // surface it as 1-based to match how a user counts ("paragraph 3 on page 42"
  // ≠ "the fourth paragraph"). Keep the heading natural.
  const userParagraphNum = paragraphIdx + 1;

  return (
    <dialog
      ref={dialogRef}
      onClick={handleDialogClick}
      aria-labelledby="citation-modal-title"
      className="rounded-lg border border-border bg-card text-card-foreground p-0 max-w-prose w-[min(90vw,42rem)] backdrop:bg-black/40"
    >
      <div className="flex items-center justify-between border-b border-border px-5 py-3">
        <h2 id="citation-modal-title" className="text-sm font-semibold">
          Source: page {page}, paragraph {userParagraphNum}
        </h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close citation"
          className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
        >
          {/* Lightweight inline X — avoids importing lucide-react for one icon */}
          <svg
            width="16"
            height="16"
            viewBox="0 0 16 16"
            fill="none"
            aria-hidden="true"
          >
            <path
              d="M3 3l10 10M13 3L3 13"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </div>
      <div className="px-5 py-4 max-h-[60vh] overflow-y-auto">
        {paragraph === null ? (
          <p className="text-sm italic text-muted-foreground">
            Source paragraph not found in this chapter&apos;s index. The
            reference may be from a related chapter — check the chapter list.
          </p>
        ) : (
          <blockquote className="text-sm leading-relaxed whitespace-pre-wrap">
            {paragraph.text}
          </blockquote>
        )}
      </div>
    </dialog>
  );
}
