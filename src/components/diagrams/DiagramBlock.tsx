// src/components/diagrams/DiagramBlock.tsx — Sprint F.1 router.
//
// What this component does:
//   1. Takes the raw JSON body of a ```diagram fenced block.
//   2. Parses + validates via parseDiagramBlock (returns Result-shaped output).
//   3. Routes valid payloads to the appropriate primitive component.
//   4. Falls back to a brand-themed source-text block on parse failure.
//
// Server-component safe (no DOM access, no hooks). All decisions happen
// synchronously in the render function.
//
// Fallback shape:
// ---------------
// Mirrors MermaidDiagram.tsx:144-155: a <figure> wrapping a
// `<pre>` containing the original source + a warn-styled footer
// describing the parse error. This degrades gracefully — the reader sees
// the LLM's intended content as text rather than a hole in the page, and
// the warn footer surfaces the failure so operators can investigate.
// Matches `kb:architecture/discipline/stability-patterns §Fail Fast` +
// `kb:architecture/discipline/error-handling-discipline §"Pattern 7"`.

import React from 'react';
import { parseDiagramBlock } from '@/lib/diagrams/parse';
import { computeInstanceId } from '@/lib/diagrams/instance-id';
import { ComparisonTable } from './ComparisonTable';
import { DefinitionList } from './DefinitionList';
import DiagramFlow from './DiagramFlow';
import StateTransitionDiagram from './StateTransitionDiagram';
import SequenceDiagram from './SequenceDiagram';
import DecisionTree from './DecisionTree';

export function DiagramBlock({ rawJSON }: { rawJSON: string }) {
  const result = parseDiagramBlock(rawJSON);

  if (!result.ok) {
    return <DiagramFallback rawJSON={rawJSON} errorMessage={result.error.message} />;
  }

  const { payload } = result;
  // Sprint G (2026-05-27): compute a deterministic per-payload instance ID
  // so SVG primitives can scope their `<marker id="...">` definitions and
  // avoid duplicate-ID collisions when two diagrams of the SAME kind render
  // on one page. Pure primitives (ComparisonTable, DefinitionList) don't
  // need it — they have no SVG marker defs.
  const instanceId = computeInstanceId(payload);
  switch (payload.kind) {
    case 'ComparisonTable':
      return <ComparisonTable payload={payload} />;
    case 'DefinitionList':
      return <DefinitionList payload={payload} />;
    case 'DiagramFlow':
      return <DiagramFlow payload={payload} instanceId={instanceId} />;
    case 'StateTransitionDiagram':
      return <StateTransitionDiagram payload={payload} instanceId={instanceId} />;
    case 'SequenceDiagram':
      return <SequenceDiagram payload={payload} instanceId={instanceId} />;
    case 'DecisionTree':
      return <DecisionTree payload={payload} />;
    default: {
      // Exhaustiveness — TypeScript narrows `payload` to `never` here. If
      // a new primitive is added to the schema without a case above,
      // this branch fires the typecheck error at compile-time.
      const _exhaustive: never = payload;
      return <DiagramFallback rawJSON={rawJSON} errorMessage="unknown diagram kind" />;
    }
  }
}

// ---------------------------------------------------------------------------
// Fallback views — parse error + Sprint-F.2-pending
// ---------------------------------------------------------------------------

function DiagramFallback({
  rawJSON,
  errorMessage,
}: {
  rawJSON: string;
  errorMessage: string;
}) {
  return (
    <figure
      className="my-stanza border-l-4 border-warn bg-paper-deep px-4 py-3"
      role="img"
      aria-label={`Diagram source (could not parse: ${errorMessage})`}
    >
      <pre className="overflow-x-auto font-mono text-caption text-ink">{rawJSON}</pre>
      <figcaption className="mt-2 font-display text-caption text-warn">
        Diagram source — could not parse: {errorMessage}
      </figcaption>
    </figure>
  );
}

// DiagramPending stays for future schema variants; current 6 primitives all
// route to real renderers. When Sprint G adds a 7th `kind`, the router's
// default-exhaustiveness check will fire a compile error, and this component
// is the natural soft-landing while the new primitive's SVG layout is built.
// Kept exported so a future PR can route to it from the switch without a
// name re-introduction.
export function DiagramPending({
  kind,
  rawJSON,
}: {
  kind: string;
  rawJSON: string;
}) {
  return (
    <figure
      className="my-stanza border border-dashed border-paper-edge bg-paper-deep px-4 py-3"
      role="img"
      aria-label={`Diagram of kind ${kind} (renderer pending — see source)`}
    >
      <pre className="overflow-x-auto font-mono text-caption text-ink-muted">{rawJSON}</pre>
      <figcaption className="mt-2 font-display text-caption text-ink-muted">
        {kind} renderer ships in Sprint F.2 — JSON shown for now
      </figcaption>
    </figure>
  );
}
