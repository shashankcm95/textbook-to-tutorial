// src/components/diagrams/StateTransitionDiagram.tsx — Sprint F.2 primitive.
//
// Renders a finite-state machine as a circular SVG diagram: states are
// circles arranged on a unit-circle layout (state 0 at 12 o'clock), with
// transitions as straight lines / Bézier self-loops / parallel pairs for
// bidirectional transitions. Pure SVG; server-component safe (no hooks,
// no DOM access, no `'use client'`).
//
// Why circular layout (per Sprint F.2 RFC §"Primitive 2"):
// --------------------------------------------------------
// Schema caps states at 8, which fits naturally on a circle (≥45° apart).
// Circular layout sidesteps the "two-states-with-bidirectional-arrows"
// problem a row layout would handle awkwardly (parallel arrows overlap or
// need routing). Radius scales with state count so labels don't collide.
//
// Why circles (not rectangles) for states:
// ----------------------------------------
// Standard FSM convention from CLRS / Sipser. The schema's
// `StateTransitionDiagram.states[i]` carries no `shape` field — that's a
// render-internal decision per `kb:architecture/crosscut/information-hiding`,
// not a contract surface.
//
// Visual markers:
// ---------------
// - `initial: true` → small filled brand-colored circle just outside the
//   state's perimeter at the radially-outward direction, with a short arrow
//   pointing to the state edge. Automata-textbook convention.
// - `terminal: true` → double-ring (inner circle inset 4px from the
//   perimeter). Standard accept-state convention.
//
// Transition routing (three cases):
// ---------------------------------
// 1. Self-loop (from === to): cubic Bézier curving outward from the
//    state's perimeter; arrow lands back on the same state; trigger sits
//    beyond the loop's apex.
// 2. Single (A→B with no B→A): straight line from A-perimeter to
//    B-perimeter (computed via center-distance + radius clipping). Trigger
//    at midpoint over a `bg-paper` rect so the line doesn't strike through.
// 3. Bidirectional pair (A→B AND B→A both exist): two parallel lines
//    offset ±8px perpendicular to the A-B axis; each gets its own arrow +
//    its own trigger label offset ±12px from the midline.
//
// Same-pair same-direction transitions (two A→B with different triggers):
// concatenated with " | " and drawn as ONE line — pedagogically clearer
// than routing-soup, and rare in textbook state machines.
//
// Defensive missing-state filter:
// -------------------------------
// If `transition.from` or `transition.to` references a state not in
// `states[]`, the transition is silently dropped. Per
// `kb:architecture/discipline/error-handling-discipline §"Pattern 7"` —
// degrade gracefully in the render pass; never throw on schema-valid but
// referentially-broken data.

import React from 'react';
import type { StateTransitionDiagramPayload } from '@/lib/diagrams/schema';

// ---------------------------------------------------------------------------
// Geometry constants — design pixels, scaled by SVG viewBox.
// ---------------------------------------------------------------------------

const NODE_W = 96;
const NODE_H = 48;
const NODE_R = NODE_H / 2; // 24 — state circle radius
const PAD = 64; // outer padding so labels + initial-markers don't clip
const INITIAL_OFFSET = 18; // distance from state perimeter to initial dot
const INITIAL_DOT_R = 6;
const TERMINAL_INSET = 4; // inner circle radius offset for double-ring
const BIDIR_OFFSET = 8; // perpendicular offset per parallel arrow
const BIDIR_LABEL_OFFSET = 12; // perpendicular offset for bidir label vs midline

// ---------------------------------------------------------------------------
// Helper: build the (deduped) transition list.
// ---------------------------------------------------------------------------
//
// Returns an array where every entry is a unique (from, to) pair. If the
// payload had multiple same-direction transitions for the same pair, their
// triggers are concatenated with " | " into a single entry — one drawn line.
//
// We preserve first-occurrence order so the visual rendering is stable
// across re-emissions where the LLM swaps trigger-permutations.

interface RoutedTransition {
  from: string;
  to: string;
  trigger?: string; // concatenated " | "-joined string, undefined if all blank
}

function dedupeTransitions(
  transitions: StateTransitionDiagramPayload['transitions'],
  validIds: Set<string>,
): RoutedTransition[] {
  const byPair = new Map<string, RoutedTransition>();
  for (const t of transitions) {
    if (!validIds.has(t.from) || !validIds.has(t.to)) continue; // defensive drop
    const key = `${t.from}::${t.to}`;
    const existing = byPair.get(key);
    if (!existing) {
      byPair.set(key, { from: t.from, to: t.to, trigger: t.trigger });
      continue;
    }
    // Merge triggers (concat with " | "). Drop empty triggers from the join.
    const merged = [existing.trigger, t.trigger]
      .filter((s): s is string => Boolean(s && s.length > 0))
      .join(' | ');
    existing.trigger = merged.length > 0 ? merged : undefined;
  }
  return Array.from(byPair.values());
}

// ---------------------------------------------------------------------------
// aria-label builder.
// ---------------------------------------------------------------------------

// Persona-review 2026-05-26 (Riley): functional summary, not structural.
// Conveys count + purpose first; state list second.
function describe(payload: StateTransitionDiagramPayload): string {
  const stateCount = payload.states.length;
  const transitionCount = payload.transitions.length;
  const labels = payload.states.map((s) => s.label).join(', ');
  const heading = payload.title
    ? `State machine for "${payload.title}"`
    : 'State machine';
  return `${heading}: ${stateCount} state${stateCount === 1 ? '' : 's'} (${labels}) connected by ${transitionCount} transition${transitionCount === 1 ? '' : 's'}.`;
}

// ---------------------------------------------------------------------------
// Component.
// ---------------------------------------------------------------------------

export default function StateTransitionDiagram({
  payload,
}: {
  payload: StateTransitionDiagramPayload;
}) {
  const { title, states, transitions } = payload;

  // Circle radius — at least 120; grows with state count so circles + labels
  // don't collide. The 24px slack on top of NODE_W/2 + NODE_W/2 accounts for
  // initial-marker arrows + trigger labels.
  const R = Math.max(120, (states.length * (NODE_W + 24)) / (2 * Math.PI));

  // ViewBox: room for the layout circle + node radii + initial-markers + pad.
  const halfSide = R + NODE_R + INITIAL_OFFSET + INITIAL_DOT_R + PAD;
  const W = halfSide * 2;
  const H = halfSide * 2;
  const cx = W / 2;
  const cy = H / 2;

  // Place each state.
  const positions = new Map<
    string,
    { x: number; y: number; angle: number; state: (typeof states)[number] }
  >();
  states.forEach((state, i) => {
    const angle = -Math.PI / 2 + i * ((2 * Math.PI) / states.length);
    const x = cx + R * Math.cos(angle);
    const y = cy + R * Math.sin(angle);
    positions.set(state.id, { x, y, angle, state });
  });

  // Dedup + defensive filter the transition list.
  const validIds = new Set(states.map((s) => s.id));
  const routed = dedupeTransitions(transitions, validIds);

  // Build a set of "reverse-exists" pairs so we can identify bidirectional pairs.
  const pairKey = (a: string, b: string) => `${a}::${b}`;
  const routedSet = new Set(routed.map((t) => pairKey(t.from, t.to)));

  return (
    <figure className="my-stanza" role="img" aria-label={describe(payload)}>
      {title ? (
        <figcaption className="mb-2 font-display text-caption text-ink-muted">
          {title}
        </figcaption>
      ) : null}
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        height="auto"
        className="text-ink"
        role="presentation"
      >
        <defs>
          {/* Arrowhead — solid filled triangle in current text color. */}
          <marker
            id="cb-arrow-state"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="7"
            markerHeight="7"
            orient="auto"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill="hsl(var(--brand))" />
          </marker>
        </defs>

        {/* 1. Transitions painted first so state circles paint on top of edge ends. */}
        {routed.map((t) => {
          if (t.from === t.to) {
            return <SelfLoop key={`${t.from}->${t.to}`} from={positions.get(t.from)!} trigger={t.trigger} />;
          }
          const isBidir = routedSet.has(pairKey(t.to, t.from));
          return (
            <PairTransition
              key={`${t.from}->${t.to}`}
              from={positions.get(t.from)!}
              to={positions.get(t.to)!}
              trigger={t.trigger}
              bidirectional={isBidir}
            />
          );
        })}

        {/* 2. State nodes (circles, terminal double-ring, initial-marker). */}
        {Array.from(positions.values()).map(({ x, y, angle, state }) => (
          <StateNode key={state.id} x={x} y={y} angle={angle} label={state.label} initial={state.initial} terminal={state.terminal} />
        ))}
      </svg>
    </figure>
  );
}

// ---------------------------------------------------------------------------
// StateNode — single state with optional initial-marker + terminal double-ring.
// ---------------------------------------------------------------------------

function StateNode({
  x,
  y,
  angle,
  label,
  initial,
  terminal,
}: {
  x: number;
  y: number;
  angle: number; // layout angle from center (radians)
  label: string;
  initial?: boolean;
  terminal?: boolean;
}) {
  // Initial-marker: small dot outside the perimeter on the radially-outward
  // direction (same angle as the state-to-center vector, away from center).
  const initialDx = Math.cos(angle) * (NODE_R + INITIAL_OFFSET);
  const initialDy = Math.sin(angle) * (NODE_R + INITIAL_OFFSET);
  const initialX = x + initialDx;
  const initialY = y + initialDy;

  // Initial-arrow end is the state perimeter at the same angle.
  const perimX = x + Math.cos(angle) * NODE_R;
  const perimY = y + Math.sin(angle) * NODE_R;

  return (
    <g>
      {initial ? (
        <>
          <line
            x1={initialX}
            y1={initialY}
            x2={perimX}
            y2={perimY}
            stroke="currentColor"
            strokeWidth={1.5}
            markerEnd="url(#cb-arrow-state)"
          />
          <circle cx={initialX} cy={initialY} r={INITIAL_DOT_R} fill="hsl(var(--brand))" />
        </>
      ) : null}
      <circle
        cx={x}
        cy={y}
        r={NODE_R}
        className="text-ink"
        fill="hsl(var(--paper-canvas))"
        stroke="currentColor"
        strokeWidth={1.5}
      />
      {terminal ? (
        <circle
          cx={x}
          cy={y}
          r={NODE_R - TERMINAL_INSET}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
        />
      ) : null}
      <text
        x={x}
        y={y}
        dominantBaseline="central"
        textAnchor="middle"
        fontSize={12}
        className="font-display text-ink"
        fill="currentColor"
      >
        {label}
      </text>
    </g>
  );
}

// ---------------------------------------------------------------------------
// SelfLoop — cubic Bézier curving outward from a state's perimeter.
// ---------------------------------------------------------------------------

function SelfLoop({
  from,
  trigger,
}: {
  from: { x: number; y: number; angle: number };
  trigger?: string;
}) {
  // We anchor the loop on the radially-outward side of the state circle.
  // The two perimeter anchor points sit ±15° from the radial-outward axis;
  // the two Bézier control points sit further out along ±35° from the
  // radial-outward axis at distance NODE_R * 2.5.
  const anchorSpread = (15 * Math.PI) / 180;
  const controlSpread = (35 * Math.PI) / 180;
  const controlDist = NODE_R * 2.5;

  const a = from.angle; // direction from layout center to this state (radially outward)
  const ax1 = from.x + NODE_R * Math.cos(a - anchorSpread);
  const ay1 = from.y + NODE_R * Math.sin(a - anchorSpread);
  const ax2 = from.x + NODE_R * Math.cos(a + anchorSpread);
  const ay2 = from.y + NODE_R * Math.sin(a + anchorSpread);

  const cx1 = from.x + controlDist * Math.cos(a - controlSpread);
  const cy1 = from.y + controlDist * Math.sin(a - controlSpread);
  const cx2 = from.x + controlDist * Math.cos(a + controlSpread);
  const cy2 = from.y + controlDist * Math.sin(a + controlSpread);

  // Loop apex (label position) — radially outward beyond the control points.
  const labelDist = NODE_R + 56;
  const lx = from.x + labelDist * Math.cos(a);
  const ly = from.y + labelDist * Math.sin(a);

  const d = `M ${ax1} ${ay1} C ${cx1} ${cy1} ${cx2} ${cy2} ${ax2} ${ay2}`;

  return (
    <g>
      <path
        d={d}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        markerEnd="url(#cb-arrow-state)"
      />
      {trigger ? <EdgeLabel x={lx} y={ly} text={trigger} /> : null}
    </g>
  );
}

// ---------------------------------------------------------------------------
// PairTransition — straight line (with optional ±8px perpendicular offset
// for bidirectional pairs) between two states' perimeters.
// ---------------------------------------------------------------------------

function PairTransition({
  from,
  to,
  trigger,
  bidirectional,
}: {
  from: { x: number; y: number };
  to: { x: number; y: number };
  trigger?: string;
  bidirectional: boolean;
}) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  // Avoid divide-by-zero if two states ended up coincident (shouldn't happen
  // with our circular layout + ≥2 states cap, but defensive).
  if (dist === 0) return null;

  // Unit direction from→to.
  const ux = dx / dist;
  const uy = dy / dist;

  // Unit perpendicular (rotated +90° from the direction): used for bidir offset.
  const px = -uy;
  const py = ux;

  // Perpendicular offset (positive magnitude for bidir pair; 0 for single).
  // The two directions of a bidir pair AUTOMATICALLY land on opposite sides
  // even though `offsetSign` is `+1` in both calls: the perpendicular vector
  // (px, py) is computed from the per-call direction (ux, uy), which itself
  // flips sign when from↔to swap, so `offX = px * +BIDIR_OFFSET` for A→B
  // ends up exactly negated vs the equivalent expression for B→A. Verified
  // by tracing through both calls; the parallel-lines invariant holds without
  // any explicit lexicographic flip. (Sprint F.2 Wave-2 reviewer cross-check.)
  const offsetSign = bidirectional ? 1 : 0;
  const offX = px * BIDIR_OFFSET * offsetSign;
  const offY = py * BIDIR_OFFSET * offsetSign;

  // Anchor on each state's perimeter along the from→to direction.
  const sx = from.x + ux * NODE_R + offX;
  const sy = from.y + uy * NODE_R + offY;
  const ex = to.x - ux * NODE_R + offX;
  const ey = to.y - uy * NODE_R + offY;

  // Label position: midpoint, offset perpendicularly for bidir pairs so the
  // two labels don't collide.
  const midX = (sx + ex) / 2;
  const midY = (sy + ey) / 2;
  const labelOffX = bidirectional ? px * BIDIR_LABEL_OFFSET : 0;
  const labelOffY = bidirectional ? py * BIDIR_LABEL_OFFSET : 0;
  const lx = midX + labelOffX;
  const ly = midY + labelOffY;

  return (
    <g>
      <line
        x1={sx}
        y1={sy}
        x2={ex}
        y2={ey}
        stroke="currentColor"
        strokeWidth={1.5}
        markerEnd="url(#cb-arrow-state)"
      />
      {trigger ? <EdgeLabel x={lx} y={ly} text={trigger} /> : null}
    </g>
  );
}

// ---------------------------------------------------------------------------
// EdgeLabel — text with a paper-colored rect underneath so the line behind
// doesn't strike through. Estimated text width via the 32-char schema cap.
// ---------------------------------------------------------------------------

function EdgeLabel({ x, y, text }: { x: number; y: number; text: string }) {
  // Rough text width estimate at 11px font: ~6.6px per glyph average.
  const estW = Math.max(16, text.length * 6.6);
  const padX = 4;
  const padY = 2;
  const rectW = estW + padX * 2;
  const rectH = 14 + padY * 2;

  return (
    <g>
      <rect
        x={x - rectW / 2}
        y={y - rectH / 2}
        width={rectW}
        height={rectH}
        fill="hsl(var(--paper-canvas))"
        rx={2}
      />
      <text
        x={x}
        y={y}
        dominantBaseline="central"
        textAnchor="middle"
        fontSize={11}
        className="text-ink-muted font-sans"
        fill="currentColor"
      >
        {text}
      </text>
    </g>
  );
}
