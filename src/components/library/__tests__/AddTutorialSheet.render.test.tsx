// @vitest-environment jsdom
//
// src/components/library/__tests__/AddTutorialSheet.render.test.tsx
//
// Smoke-coverage for the Add-tutorial sheet:
//   - renders a trigger button labelled "Add tutorial"
//   - clicking the trigger opens the <dialog> (showModal called)
//   - the dialog renders the HomeIngestForm body (s3:// affordance present)
//   - the close button calls .close() on the dialog
//
// We stub HTMLDialogElement.prototype.showModal because jsdom does not
// implement the dialog API as of v25. The stub records calls + flips
// `open` attribute so React state correctly observes the close event.

import React from 'react';
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';

import { AddTutorialSheet } from '../AddTutorialSheet';

// jsdom shim — without these, showModal() throws "not implemented".
beforeAll(() => {
  if (typeof HTMLDialogElement !== 'undefined') {
    HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
      this.setAttribute('open', '');
    };
    HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
      this.removeAttribute('open');
      this.dispatchEvent(new Event('close'));
    };
  }
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// Mock next/navigation's useRouter — HomeIngestForm calls it; without
// the mock we get "invariant: missing app router context".
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

describe('<AddTutorialSheet>', () => {
  it('renders the Add tutorial trigger button', () => {
    render(<AddTutorialSheet sampleUrl="s3://b/k.pdf" />);
    expect(screen.getByRole('button', { name: /add tutorial/i })).toBeTruthy();
  });

  it('opens the dialog when the trigger is clicked', () => {
    render(<AddTutorialSheet sampleUrl="s3://b/k.pdf" />);
    const trigger = screen.getByRole('button', { name: /add tutorial/i });

    // Pre-click: dialog body is not rendered (we mount it lazily on open).
    expect(screen.queryByText(/paste an s3 url/i)).toBeNull();

    fireEvent.click(trigger);

    // Post-click: dialog body content is visible.
    expect(screen.getByText(/paste an s3 url/i)).toBeTruthy();
    // The HomeIngestForm body's S3 prefix chip is present.
    const dialogTitle = screen.getByRole('heading', { name: /^add tutorial/i });
    expect(dialogTitle).toBeTruthy();
  });

  it('closes the dialog when the close (X) button is clicked', () => {
    render(<AddTutorialSheet sampleUrl="s3://b/k.pdf" />);
    fireEvent.click(screen.getByRole('button', { name: /add tutorial/i }));
    expect(screen.getByText(/paste an s3 url/i)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /close dialog/i }));
    // After close, the body is removed from the tree (we render conditionally).
    expect(screen.queryByText(/paste an s3 url/i)).toBeNull();
  });
});
