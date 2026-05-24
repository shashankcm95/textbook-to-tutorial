'use client';

/**
 * src/components/MermaidDiagram.tsx — render a Mermaid source block as SVG.
 *
 * Sprint-Bv2.5: lessons can now embed diagrams + workflows. The LLM
 * emits a fenced code block tagged with ` ```mermaid `, e.g.:
 *
 *   ```mermaid
 *   flowchart LR
 *     A[Client] --> B[Load balancer]
 *     B --> C[Replica 1]
 *     B --> D[Replica 2]
 *   ```
 *
 * ChapterRenderer detects the `language-mermaid` className on the
 * react-markdown `<code>` slot and renders this component instead of
 * a plain code block. We render the SVG client-side via the official
 * mermaid package, with the diagram's text as a fallback for
 * accessibility (and for SSR — mermaid is browser-only).
 *
 * Why client-only + lazy import:
 *   - `mermaid` is a large bundle (~1.2MB minified). Static-importing
 *     it would pull it into every page; dynamic-importing only on
 *     diagram presence keeps the lesson page fast for chapters that
 *     don't use diagrams (most chapters in DDIA; many in CLRS).
 *   - mermaid uses DOM APIs (document.createElementNS) and can't
 *     render server-side. Loading via dynamic import guarantees the
 *     code only runs after hydration.
 *
 * Theming: we feed mermaid our brand tokens via its `themeVariables`
 * config so diagrams sit on the paper canvas with brand-indigo nodes
 * and citation-gold accents. Light + dark are handled by reading the
 * CSS variables at render time.
 *
 * Failure mode (per kb:architecture/discipline/stability-patterns
 * §Fail Fast): if mermaid throws a parse error (LLM emitted malformed
 * syntax — happens), we show the original source as a code block with
 * a "diagram source" footer. The reader still gets the information,
 * just without the visual.
 */

import { useEffect, useId, useState } from 'react';

interface MermaidDiagramProps {
  /** Mermaid source — the raw text between the ```mermaid fences. */
  source: string;
}

export function MermaidDiagram({ source }: MermaidDiagramProps) {
  const id = useId().replace(/:/g, '_'); // mermaid hates `:` in IDs
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setSvg(null);
    setError(null);

    // Read brand tokens at render time so the diagram inherits dark/light
    // mode + brand color drift. document is guaranteed here (useEffect).
    const root = getComputedStyle(document.documentElement);
    const paper = `hsl(${root.getPropertyValue('--paper-canvas').trim()})`;
    const paperDeep = `hsl(${root.getPropertyValue('--paper-deep').trim()})`;
    const paperEdge = `hsl(${root.getPropertyValue('--paper-edge').trim()})`;
    const ink = `hsl(${root.getPropertyValue('--ink').trim()})`;
    const inkMuted = `hsl(${root.getPropertyValue('--ink-muted').trim()})`;
    const brand = `hsl(${root.getPropertyValue('--brand').trim()})`;
    const brandFade = `hsl(${root.getPropertyValue('--brand-fade').trim()})`;
    const citation = `hsl(${root.getPropertyValue('--citation').trim()})`;

    (async () => {
      try {
        // Dynamic import — keep mermaid out of the first-load bundle.
        const mermaidMod = await import('mermaid');
        const mermaid = mermaidMod.default;

        mermaid.initialize({
          startOnLoad: false,
          theme: 'base',
          securityLevel: 'strict',
          fontFamily: 'var(--font-sans), -apple-system, sans-serif',
          themeVariables: {
            background: paper,
            primaryColor: brandFade,
            primaryTextColor: ink,
            primaryBorderColor: brand,
            secondaryColor: paperDeep,
            tertiaryColor: paperEdge,
            lineColor: inkMuted,
            edgeLabelBackground: paper,
            textColor: ink,
            mainBkg: brandFade,
            nodeBorder: brand,
            clusterBkg: paperDeep,
            clusterBorder: paperEdge,
            // Highlight + special-state colors map to citation-gold so
            // emphasized nodes pop in the same accent as the inline
            // citation chips.
            secondaryBorderColor: citation,
          },
        });

        // Validate first — mermaid.parse throws on malformed input.
        // `parse` returns a promise in v10+; await to surface errors
        // here rather than inside `render`.
        await mermaid.parse(source);

        // Render into an offscreen container.
        const { svg: out } = await mermaid.render(`mermaid-${id}`, source);
        if (!cancelled) setSvg(out);
      } catch (err) {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : 'unknown mermaid error';
        // eslint-disable-next-line no-console
        console.warn('[MermaidDiagram] render failed:', message);
        setError(message);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [id, source]);

  // Loading / unrendered state — show the source as a quiet placeholder
  // so the layout doesn't jump after hydration.
  if (svg === null && error === null) {
    return (
      <pre className="my-stanza overflow-x-auto rounded-md border border-paper-edge bg-paper-deep px-4 py-3 font-mono text-caption text-ink-muted">
        <code>{source}</code>
      </pre>
    );
  }

  // Parse/render failed — graceful degrade to source + footer label.
  if (error !== null) {
    return (
      <figure className="my-stanza">
        <pre className="overflow-x-auto rounded-md border border-warn/40 bg-warn-fade/40 px-4 py-3 font-mono text-caption text-ink">
          <code>{source}</code>
        </pre>
        <figcaption className="mt-1 font-sans text-caption text-warn">
          Diagram source (auto-render failed: {error.slice(0, 80)})
        </figcaption>
      </figure>
    );
  }

  // Success — render the SVG inline. dangerouslySetInnerHTML is safe
  // here because mermaid is initialized with `securityLevel: 'strict'`
  // which sandboxes its output (no script tags, escaped HTML in nodes).
  return (
    <figure className="my-stanza overflow-x-auto rounded-md border border-paper-edge bg-paper-deep p-4">
      <div
        role="img"
        aria-label="Diagram (Mermaid)"
        // mermaid produces well-formed, sanitized SVG when securityLevel='strict'.
        // eslint-disable-next-line react/no-danger
        dangerouslySetInnerHTML={{ __html: svg ?? '' }}
      />
    </figure>
  );
}
