'use client';

/**
 * src/components/library/AddTutorialSheet.tsx — "Add tutorial from S3 URL"
 * button + native <dialog> modal that wraps the existing HomeIngestForm.
 *
 * Why <dialog> over Radix Dialog / DIY focus-trap:
 *   - Native browser support since 2022 (Chrome/Edge/Safari/Firefox).
 *   - showModal() handles focus trap, inert background, ESC dismiss,
 *     and aria-modal semantics out of the box.
 *   - Adds zero deps. The project deliberately ships only
 *     @radix-ui/react-popover (not Dialog) — promoting to Radix Dialog
 *     is reserved for when a second modal lands.
 *
 * Composition contract with HomeIngestForm:
 *   - We pass `onSuccess={() => closeDialog()}` so the modal disappears
 *     during the navigation to /tutorials/<id>. The form still owns the
 *     CSRF read + POST + router.push. We do NOT duplicate that logic.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Plus, X } from 'lucide-react';

import { HomeIngestForm } from '@/app/HomeIngestForm';

interface AddTutorialSheetProps {
  /** Sample S3 URL passed through to HomeIngestForm's "Try the DDIA sample" affordance. */
  sampleUrl: string;
}

export function AddTutorialSheet({ sampleUrl }: AddTutorialSheetProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);

  const closeDialog = useCallback(() => {
    dialogRef.current?.close();
    setOpen(false);
  }, []);

  const openDialog = useCallback(() => {
    const el = dialogRef.current;
    if (!el) return;
    // showModal() is the load-bearing API — it's what gives us the
    // focus trap, the ::backdrop, and the inert-rest-of-page behavior.
    // Calling .show() (no Modal) would NOT do that.
    if (typeof el.showModal === 'function') {
      el.showModal();
    } else {
      // Fallback for very old browsers: open as non-modal. Acceptable
      // degradation for a personal-use app.
      el.setAttribute('open', '');
    }
    setOpen(true);
  }, []);

  // Mirror native ESC/backdrop-click close events into our React state
  // so subsequent open() works correctly. <dialog> emits 'close' when
  // ESC is pressed or .close() is called.
  useEffect(() => {
    const el = dialogRef.current;
    if (!el) return;
    const onClose = () => setOpen(false);
    el.addEventListener('close', onClose);
    return () => el.removeEventListener('close', onClose);
  }, []);

  // Backdrop click → close. Native <dialog> closes on ESC for free but
  // not on backdrop click; we attach a click handler that compares the
  // event.target to the dialog itself (clicks on the form inside the
  // dialog bubble up with a different target).
  function onDialogClick(e: React.MouseEvent<HTMLDialogElement>) {
    if (e.target === dialogRef.current) {
      closeDialog();
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={openDialog}
        className="inline-flex items-center gap-1.5 rounded-md bg-brand px-4 py-2 font-sans text-ui font-semibold text-white shadow-paper-sm transition-all duration-snap ease-decelerate hover:bg-brand-hover hover:shadow-paper active:translate-y-px focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
      >
        <Plus className="h-4 w-4" aria-hidden={true} />
        Add tutorial
      </button>

      <dialog
        ref={dialogRef}
        onClick={onDialogClick}
        aria-labelledby="add-tutorial-title"
        // Style targets the dialog element itself + ::backdrop pseudo
        // via globals.css if we add one later. For now, rely on browser
        // defaults plus a content wrapper that matches the paper surface.
        className="w-full max-w-lg rounded-lg border border-paper-edge bg-paper p-0 shadow-paper backdrop:bg-ink/40 backdrop:backdrop-blur-sm"
      >
        {open ? (
          <div className="p-6">
            <div className="mb-4 flex items-start justify-between gap-4">
              <div>
                <h2
                  id="add-tutorial-title"
                  className="font-display text-h3 text-ink"
                >
                  Add tutorial<span className="text-brand">.</span>
                </h2>
                <p className="mt-1 font-sans text-ui text-ink-muted">
                  Paste an S3 URL to a PDF. Ingest starts immediately.
                </p>
              </div>
              <button
                type="button"
                onClick={closeDialog}
                aria-label="Close dialog"
                className="rounded-md p-1 text-ink-muted transition-colors hover:bg-paper-edge hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
              >
                <X className="h-5 w-5" aria-hidden={true} />
              </button>
            </div>
            <HomeIngestForm
              prefillUrl={sampleUrl}
              onSuccess={closeDialog}
            />
          </div>
        ) : null}
      </dialog>
    </>
  );
}
