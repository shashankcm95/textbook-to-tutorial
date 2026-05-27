// src/components/diagrams/DiagramFlow.tsx — Sprint F.2 primitive.
//
// Renders a 2-7 node directed pipeline as an inline SVG. Two directions:
// LR (single row, default) and TB (single column). Node shapes vary by
// `kind`: start/end render as pills, process as rounded rectangles,
// decision as diamonds. Edges are straight lines with a brand-indigo
// arrowhead marker (`cb-arrow-flow`, scoped per primitive so it can't
// leak across other diagram kinds — `kb:architecture/crosscut/information-hiding`).
//
// Server-component safe: no `'use client'`, no hooks, no DOM access. The
// viewBox is computed from node count × per-node pitch + padding so the
// SVG scales fluidly to the containing column width via
// `width="100%" height="auto"` + `preserveAspectRatio` defaults.
//
// Defensive edge-drop: edges referencing a `from` or `to` that isn't in
// `nodes[]` are silently filtered. The Zod schema doesn't enforce
// referential integrity between edges and nodes, and a missing-node edge
// would project to (0,0) and look like a glitch.
// Per `kb:architecture/discipline/error-handling-discipline §"Pattern 7"`:
// degrade gracefully, don't throw inside a render pass.
//
// Brand tokens via inline `hsl(var(--token))` (mirrors src/components/
// ProgressRing.tsx convention since SVG fill/stroke can't pick up Tailwind
// utility classes the same way HTML elements do).

import React from 'react';
import type { DiagramFlowPayload } from '@/lib/diagrams/schema';
import { markerId } from '@/lib/diagrams/instance-id';

// ── Geometry constants — design-pixel units; the viewBox carries them. ──
const NODE_W = 128;
const NODE_H = 56;
const PAD = 32;
const PITCH_X = 160; // LR direction
const PITCH_Y = 96; // TB direction

// Estimate text width by character count at ~7px per glyph at the 12px
// font. Good enough for the centering math — labels are capped at 32
// chars by the schema's `ShortLabel`.
// Persona-review 2026-05-26 (Riley): functional summary, not structural
// verbatim. Tells the screen-reader WHY to navigate this diagram, not
// what data structure it is.
function buildAriaLabel(payload: DiagramFlowPayload): string {
  const stepCount = payload.nodes.length;
  const labels = payload.nodes.map((n) => n.label);
  const heading = payload.title
    ? `Process diagram for "${payload.title}"`
    : 'Process diagram';
  return `${heading}: ${stepCount} step${stepCount === 1 ? '' : 's'} from start to end — ${labels.join(' → ')}.`;
}

export default function DiagramFlow({
  payload,
  instanceId,
}: {
  payload: DiagramFlowPayload;
  /**
   * Optional Sprint G (2026-05-27) — per-instance suffix on SVG marker IDs.
   * When DiagramBlock supplies this, the `<marker id="...">` definition is
   * scoped per-payload so two DiagramFlow renders on one page no longer
   * share `cb-arrow-flow` as their marker id. Omitted callers (e.g. the
   * diagram-gallery dev route with canned fixtures) render unchanged.
   */
  instanceId?: string;
}) {
  const { title, direction = 'LR', nodes, edges } = payload;
  const isLR = direction === 'LR';
  const arrowMarkerId = markerId('cb-arrow-flow', instanceId);
  const pitch = isLR ? PITCH_X : PITCH_Y;

  // 1. Place nodes on the active axis (declaration order = layout order).
  const positions = new Map<string, { x: number; y: number }>();
  nodes.forEach((node, i) => {
    if (isLR) positions.set(node.id, { x: PAD + i * pitch, y: PAD });
    else positions.set(node.id, { x: PAD, y: PAD + i * pitch });
  });

  // 2. Compute viewBox. The last node's box must fit fully inside.
  const lastIdx = nodes.length - 1;
  const W = isLR ? PAD * 2 + lastIdx * pitch + NODE_W : PAD * 2 + NODE_W;
  const H = isLR ? PAD * 2 + NODE_H : PAD * 2 + lastIdx * pitch + NODE_H;

  // 3. Drop edges whose endpoints aren't in the nodes list.
  const validEdges = edges.filter((e) => positions.has(e.from) && positions.has(e.to));

  const ariaLabel = buildAriaLabel(payload);

  return (
    <figure className="my-stanza" role="img" aria-label={ariaLabel}>
      {title ? (
        <figcaption className="mb-2 font-display text-caption text-ink-muted">
          {title}
        </figcaption>
      ) : null}
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        height="auto"
        role="presentation"
        xmlns="http://www.w3.org/2000/svg"
      >
        <defs>
          {/*
            Marker ID is scoped per-primitive (`cb-arrow-flow`) so it can
            never clash with StateTransitionDiagram's `cb-arrow-state` or
            SequenceDiagram's `cb-arrow-seq-call`. SVG markers live in a
            single global ID namespace per document, so per-primitive
            scoping is the only way to prevent cross-primitive bleed when
            multiple diagrams render on one page.
          */}
          <marker
            id={arrowMarkerId}
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="8"
            markerHeight="8"
            orient="auto"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill="hsl(var(--brand))" />
          </marker>
        </defs>

        {/* Edges first so node shapes paint on top of edge tails. */}
        {validEdges.map((edge, i) => {
          const from = positions.get(edge.from)!;
          const to = positions.get(edge.to)!;
          // LR: line exits source's right-edge midpoint, enters target's
          // left-edge midpoint. TB analogously: bottom-mid → top-mid.
          const x1 = isLR ? from.x + NODE_W : from.x + NODE_W / 2;
          const y1 = isLR ? from.y + NODE_H / 2 : from.y + NODE_H;
          const x2 = isLR ? to.x : to.x + NODE_W / 2;
          const y2 = isLR ? to.y + NODE_H / 2 : to.y;
          return (
            <line
              key={`edge-${i}`}
              x1={x1}
              y1={y1}
              x2={x2}
              y2={y2}
              stroke="hsl(var(--ink-muted))"
              strokeWidth={1.5}
              markerEnd={`url(#${arrowMarkerId})`}
            />
          );
        })}

        {/* Nodes — shape selected by kind. */}
        {nodes.map((node) => {
          const pos = positions.get(node.id)!;
          const cx = pos.x + NODE_W / 2;
          const cy = pos.y + NODE_H / 2;
          const kind = node.kind ?? 'process';

          let shape: React.ReactNode;
          if (kind === 'start' || kind === 'end') {
            shape = (
              <rect
                x={pos.x}
                y={pos.y}
                width={NODE_W}
                height={NODE_H}
                rx={NODE_H / 2}
                ry={NODE_H / 2}
                fill="hsl(var(--brand-fade))"
                stroke="hsl(var(--brand))"
                strokeWidth={1.5}
              />
            );
          } else if (kind === 'decision') {
            // Diamond: trace the four corners of the bounding box.
            const points = [
              `${cx},${pos.y}`,
              `${pos.x + NODE_W},${cy}`,
              `${cx},${pos.y + NODE_H}`,
              `${pos.x},${cy}`,
            ].join(' ');
            shape = (
              <polygon
                points={points}
                fill="hsl(var(--citation-fade))"
                stroke="hsl(var(--citation))"
                strokeWidth={1.5}
              />
            );
          } else {
            // process (default)
            shape = (
              <rect
                x={pos.x}
                y={pos.y}
                width={NODE_W}
                height={NODE_H}
                rx={8}
                ry={8}
                fill="hsl(var(--paper-deep))"
                stroke="hsl(var(--paper-edge))"
                strokeWidth={1.5}
              />
            );
          }

          return (
            <g key={node.id}>
              {shape}
              <text
                x={cx}
                y={cy}
                textAnchor="middle"
                dominantBaseline="central"
                fill="hsl(var(--ink))"
                fontFamily="var(--font-display), Georgia, serif"
                fontSize={13}
              >
                {node.label}
              </text>
            </g>
          );
        })}

        {/* Edge labels last so they paint above the lines. */}
        {(() => {
          // Sprint F.2 Wave-2 fix-up A-HIGH-3: detect bidirectional edge
          // pairs (A→B AND B→A both present) so we can perpendicular-offset
          // the second label of each pair. Without the offset both labels
          // land on the same midpoint and overlap into invisibility.
          const edgeSet = new Set(validEdges.map((e) => `${e.from}::${e.to}`));
          const isBidir = (e: { from: string; to: string }) =>
            edgeSet.has(`${e.to}::${e.from}`);

          return validEdges
            .filter((e) => e.label)
            .map((edge, i) => {
              const from = positions.get(edge.from)!;
              const to = positions.get(edge.to)!;
              const x1 = isLR ? from.x + NODE_W : from.x + NODE_W / 2;
              const y1 = isLR ? from.y + NODE_H / 2 : from.y + NODE_H;
              const x2 = isLR ? to.x : to.x + NODE_W / 2;
              const y2 = isLR ? to.y + NODE_H / 2 : to.y;
              const mx = (x1 + x2) / 2;
              const my = (y1 + y2) / 2;
              const label = edge.label!;
              // Sprint F.2 Wave-2 fix-up A-HIGH-3: bidir-pair perpendicular
              // offset for label position. Sign-by-direction (from < to → +,
              // else −) gives the two directions deterministic sides.
              const BIDIR_LABEL_OFFSET = 12;
              const bidir = isBidir(edge);
              const sign = bidir ? (edge.from < edge.to ? 1 : -1) : 0;
              // In LR mode lines are horizontal — perpendicular offset is in y.
              // In TB mode lines are vertical — perpendicular offset is in x.
              const lx = isLR ? mx : mx + sign * BIDIR_LABEL_OFFSET;
              const ly = isLR ? my + sign * BIDIR_LABEL_OFFSET : my;
              // Estimate label rect width from char count (11px font ≈ 6.5
              // px/char; using 7 as a conservative overestimate). Sprint F.2
              // Wave-2 fix-up A-HIGH-1: clamp the rect width to the visible
              // segment length so it cannot paint over the flanking node
              // shapes at the 24-char schema cap.
              const segmentLen = Math.hypot(x2 - x1, y2 - y1);
              const naturalW = Math.max(20, label.length * 7 + 8);
              const rectW = Math.min(naturalW, Math.max(20, segmentLen - 8));
              const rectH = 16;
              return (
                <g key={`edge-label-${i}`}>
                  <rect
                    x={lx - rectW / 2}
                    y={ly - rectH / 2}
                    width={rectW}
                    height={rectH}
                    fill="hsl(var(--paper-canvas))"
                  />
                  <text
                    x={lx}
                    y={ly}
                    textAnchor="middle"
                    dominantBaseline="central"
                    fill="hsl(var(--ink-muted))"
                    fontFamily="var(--font-sans), -apple-system, sans-serif"
                    fontSize={11}
                  >
                    {label}
                  </text>
                </g>
              );
            });
        })()}
      </svg>
    </figure>
  );
}
