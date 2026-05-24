'use client';

/**
 * src/components/LessonCanvas.tsx — the reading surface.
 *
 * Replaces the inline `<div className="prose prose-sm dark:prose-invert">`
 * wrapper inside ChapterRenderer. The product is reading; this is the
 * load-bearing typography surface.
 *
 * Design intent (per UI/UX-hybrid audit §3.3, "Reading is the product"):
 *   - Body face: Source Serif 4 at 19/1.75 with -0.003em tracking. The
 *     `text-body` utility carries those values.
 *   - Container: max-w-[36em] — about 65ch at body size. The accepted
 *     range for sustained reading.
 *   - Headings switch to Newsreader (`font-display`).
 *   - First paragraph after each h2 gets `text-lead` (23px) — the "lesson
 *     opening" feel.
 *   - Body paragraphs separated by `mt-lead`; subsections by `mt-stanza`.
 *   - Hung punctuation + auto-hyphenation + OpenType kerning/ligatures
 *     enabled globally via the `.lesson-canvas` class in globals.css.
 *   - True small-caps for `<abbr>` (SQL, TCP, RPC) — also in globals.css.
 *   - Optional drop-cap on the first letter of the first paragraph of
 *     the first lesson, in display Newsreader at `text-display` size
 *     with the brand color. Stripe-Press-adjacent.
 *
 * The drop-cap is opt-in via `isFirstLesson` because applying it to every
 * lesson would feel ornamental, not editorial. Lesson 1 of chapter 1 only.
 *
 * react-markdown's output goes inside <article>. The Tailwind arbitrary-
 * descendant selectors ([&_p], [&_h2+p]) handle the rhythm without
 * @tailwindcss/typography (which has competing prose styles we don't
 * want here — prose.css is for content management, not book typography).
 */

import type { ReactNode } from 'react';

interface LessonCanvasProps {
  children: ReactNode;
  /** Whether this is the first lesson of the first chapter (controls drop-cap). */
  isFirstLesson?: boolean;
}

export function LessonCanvas({ children, isFirstLesson = false }: LessonCanvasProps) {
  // Each named utility expands via globals.css. The arbitrary-descendant
  // selectors hit react-markdown's output without us having to override
  // its component map for every tag.
  return (
    <article
      className={[
        'lesson-canvas',
        // Container
        'mx-auto max-w-[36em] font-serif text-body text-ink',
        // Paragraph rhythm
        '[&_p]:mt-lead',
        '[&_p:first-of-type]:mt-0',
        '[&_h2+p]:mt-stanza',
        // Headings inside the lesson body
        '[&_h2]:font-display [&_h2]:text-h2 [&_h2]:text-ink [&_h2]:mt-section [&_h2]:mb-stanza [&_h2]:font-medium [&_h2]:tracking-tight',
        '[&_h3]:font-display [&_h3]:text-h3 [&_h3]:text-ink [&_h3]:mt-stanza [&_h3]:mb-lead [&_h3]:font-medium [&_h3]:tracking-tight',
        '[&_h4]:font-sans [&_h4]:text-ui-lg [&_h4]:text-ink [&_h4]:mt-stanza [&_h4]:mb-lead [&_h4]:font-semibold',
        // Inline emphasis
        '[&_strong]:text-ink [&_strong]:font-semibold',
        '[&_em]:italic',
        // Inline code + the inline citation chip share the mono face
        '[&_code]:font-mono [&_code]:text-[0.9em] [&_code]:bg-brand-fade [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded-sm [&_code]:text-ink',
        // Links — brand color, subtle underline
        '[&_a]:text-brand [&_a]:underline [&_a]:underline-offset-2 [&_a]:decoration-citation/40 [&_a:hover]:text-brand-hover [&_a:hover]:decoration-citation',
        // Blockquote — citation-gold left rule, italic ink
        '[&_blockquote]:border-l-2 [&_blockquote]:border-citation [&_blockquote]:pl-4 [&_blockquote]:py-1 [&_blockquote]:text-ink-muted [&_blockquote]:italic',
        // Lists
        '[&_ul]:mt-lead [&_ul]:list-disc [&_ul]:pl-6 [&_ul_li]:mt-1',
        '[&_ol]:mt-lead [&_ol]:list-decimal [&_ol]:pl-6 [&_ol_li]:mt-1',
        // Optional drop-cap on lesson 1 / chapter 1 (Stripe-Press-quiet)
        isFirstLesson
          ? '[&>p:first-of-type::first-letter]:font-display [&>p:first-of-type::first-letter]:text-display [&>p:first-of-type::first-letter]:float-left [&>p:first-of-type::first-letter]:mr-2 [&>p:first-of-type::first-letter]:mt-1 [&>p:first-of-type::first-letter]:leading-[0.85] [&>p:first-of-type::first-letter]:text-brand'
          : '',
      ].join(' ')}
    >
      {children}
    </article>
  );
}
