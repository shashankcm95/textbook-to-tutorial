import type { Metadata } from 'next';
import { Inter, Newsreader, Source_Serif_4, JetBrains_Mono } from 'next/font/google';
import './globals.css';

/**
 * Brand typography stack — Sprint Bv2.
 *
 * Each face loads via next/font/google → zero runtime requests, automatic
 * subsetting, font-display: swap. CSS variables are surfaced on <html>
 * via className so the globals.css utility classes can reference them
 * (font-display / font-serif / font-sans / font-mono).
 *
 *  - Newsreader (display)     — book titles, chapter h1, hero. Open-source
 *                                serif with literary character + ink-trap
 *                                detail. "Looks expensive without being precious."
 *  - Source Serif 4 (body)    — lesson canvas at 19/1.75. Built-in optical
 *                                sizing; OpenType c2sc/smcp for true small-caps
 *                                on technical abbreviations (SQL/TCP/RPC).
 *  - Inter (UI chrome)        — buttons, labels, sidebar, sticky header.
 *                                tabular-nums for cost chips + counters.
 *  - JetBrains Mono (code)    — code blocks, citation `[p.26 ¶1-6]` chips,
 *                                `s3://` token in the home form.
 *
 * Weights kept minimal (3-4 each) to keep the first-load payload small.
 * Total: ~200KB with all four subsetted; the lesson canvas is the
 * cache-warmest surface so this amortizes fast.
 */
const newsreader = Newsreader({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  style: ['normal', 'italic'],
  variable: '--font-display',
  display: 'swap',
});

const sourceSerif = Source_Serif_4({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  style: ['normal', 'italic'],
  variable: '--font-serif',
  display: 'swap',
});

const inter = Inter({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-sans',
  display: 'swap',
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  weight: ['400', '500'],
  variable: '--font-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'TB → Tutorial Converter',
  description:
    'Turn any technical book into a chapter-by-chapter tutorial with quizzes, flashcards, and a source link for every claim.',
};

interface RootLayoutProps {
  children: React.ReactNode;
}

export default function RootLayout({ children }: RootLayoutProps) {
  const fontClasses = [
    newsreader.variable,
    sourceSerif.variable,
    inter.variable,
    jetbrainsMono.variable,
  ].join(' ');
  return (
    <html lang="en" className={fontClasses}>
      {/*
        Body uses the new `font-sans` (Inter) + `bg-paper` brand surface.
        The previous `bg-background` + `container mx-auto px-4 py-6`
        wrapper has been removed from here — individual pages now own
        their own layout (the home page is full-bleed two-column; the
        tutorial page has its own sticky header + canvas centering).
        Keeping a global `<main>` wrapper here would fight every page's
        bespoke layout.
      */}
      <body className="min-h-screen bg-paper font-sans text-ink antialiased">
        {children}
      </body>
    </html>
  );
}
