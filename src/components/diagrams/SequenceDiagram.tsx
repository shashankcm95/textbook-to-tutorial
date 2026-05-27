// src/components/diagrams/SequenceDiagram.tsx — Sprint F.2 primitive.
//
// Renders a 2-6 actor sequence diagram as inline SVG. Each actor becomes
// a top-anchored labeled box and a vertical dashed lifeline descending
// the message area. Messages render in declaration order top-to-bottom
// as horizontal arrows between lifelines; self-messages render as a
// small right-loop on a single lifeline. Three message kinds carry
// distinct glyphs:
//
//   - `call`   — solid line + filled-triangle arrowhead (`cb-arrow-seq-call`),
//                stroke `ink`. The default when `kind` is omitted.
//   - `return` — dashed line + same filled-triangle arrowhead, stroke
//                `ink-muted`. Returns are visually less loaded than calls.
//   - `async`  — solid line + open-triangle arrowhead (`cb-arrow-seq-async`),
//                stroke `ink`. Standard UML async convention.
//
// Marker IDs are scoped per primitive (`cb-arrow-seq-call`,
// `cb-arrow-seq-async`) so they cannot clash with DiagramFlow's
// `cb-arrow-flow` or StateTransitionDiagram's `cb-arrow-state` when
// multiple diagrams render on one page. SVG marker IDs share a single
// global namespace per document — per-primitive scoping is the only
// safe pattern (`kb:architecture/crosscut/information-hiding`).
//
// Defensive missing-actor drop: a message whose `from` or `to` does not
// match any entry in `actors[]` is silently dropped. The Zod schema does
// not enforce referential integrity between message endpoints and the
// actor list (both are ShortLabel strings, not foreign keys), and a
// projected-to-(0,0) message would look like a glitch. Mirrors
// DiagramFlow's edge-drop convention; `kb:architecture/discipline/
// error-handling-discipline §"Pattern 7"` — degrade gracefully, don't
// throw inside a render pass.
//
// Server-component safe: no `'use client'`, no hooks, no DOM access. The
// viewBox is computed from actor count × LANE_PITCH_X and message count ×
// MESSAGE_PITCH_Y, so the SVG scales fluidly to the containing column
// via `width="100%" height="auto"`.
//
// Brand tokens via inline `hsl(var(--token))` — SVG fill/stroke can't
// pick up Tailwind utility classes the way HTML elements do (mirrors
// DiagramFlow + ProgressRing conventions in this repo).

import React from 'react';
import type { SequenceDiagramPayload } from '@/lib/diagrams/schema';
import { markerId } from '@/lib/diagrams/instance-id';

// ── Geometry constants — design-pixel units; the viewBox carries them. ──
const LIFELINE_X_0 = 80;     // x-coord of the FIRST lifeline (also = left pad)
const LANE_PITCH_X = 160;    // center-to-center horizontal spacing
const ACTOR_W = 120;
const ACTOR_H = 40;
const PAD_TOP = 8;           // gap above actor boxes
const MESSAGE_AREA_TOP_PAD = 32; // gap between actor boxes and first message
const MESSAGE_PITCH_Y = 48;
const BOTTOM_PAD = 32;
const SELF_LOOP_DX = 40;     // how far the self-message loops to the right
const SELF_LOOP_DY = 16;     // vertical span of the self-loop

// Persona-review 2026-05-26 (Riley): functional summary.
function buildAriaLabel(payload: SequenceDiagramPayload): string {
  const actorCount = payload.actors.length;
  const messageCount = payload.messages.length;
  const heading = payload.title
    ? `Sequence diagram for "${payload.title}"`
    : 'Sequence diagram';
  return `${heading}: ${messageCount} message${messageCount === 1 ? '' : 's'} between ${actorCount} actor${actorCount === 1 ? '' : 's'} (${payload.actors.join(', ')}).`;
}

export default function SequenceDiagram({
  payload,
  instanceId,
}: {
  payload: SequenceDiagramPayload;
  /** Sprint G (2026-05-27) — see DiagramFlow.tsx for rationale. */
  instanceId?: string;
}) {
  const { title, actors, messages } = payload;
  const callMarkerId = markerId('cb-arrow-seq-call', instanceId);
  const asyncMarkerId = markerId('cb-arrow-seq-async', instanceId);

  // 1. Actor name → index → lifeline x-coord. Index lookup is O(actors.length);
  //    actors caps at 6 so a plain Map suffices.
  const actorIndex = new Map<string, number>();
  actors.forEach((name, i) => {
    // First occurrence wins if the LLM duplicates an actor name (rare; the
    // schema doesn't enforce uniqueness, so we defensively pick first-wins
    // rather than throw).
    if (!actorIndex.has(name)) actorIndex.set(name, i);
  });

  const lifelineX = (i: number) => LIFELINE_X_0 + i * LANE_PITCH_X;

  // 2. Defensive drop: a message whose endpoints aren't in actors[] is
  //    discarded. We keep the original ordering for surviving messages so
  //    declaration order continues to drive vertical layout.
  const validMessages = messages.filter(
    (m) => actorIndex.has(m.from) && actorIndex.has(m.to),
  );

  // 3. Compute viewBox. The last lifeline's actor box needs ACTOR_W/2 of
  //    space to the right; LIFELINE_X_0 already gives that on the left
  //    (since the first actor is centered on LIFELINE_X_0). Symmetric pad.
  const W = LIFELINE_X_0 * 2 + (actors.length - 1) * LANE_PITCH_X;
  const messageAreaTop = PAD_TOP + ACTOR_H + MESSAGE_AREA_TOP_PAD;
  const H = messageAreaTop + validMessages.length * MESSAGE_PITCH_Y + BOTTOM_PAD;

  // Lifelines descend from just below the actor box to just past the last
  // message row, so the dashed line frames every arrow.
  const lifelineTopY = PAD_TOP + ACTOR_H;
  const lifelineBottomY = H - BOTTOM_PAD / 2;

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
            Two markers — both per-primitive-scoped so they can't bleed
            into other diagram kinds rendered on the same page.

            `cb-arrow-seq-call` — solid filled triangle. Used for `call`
              (default) and `return` (only the stroke style differs, not
              the head — per RFC §"Primitive 3 — Message-kind glyphs":
              "return ... filled-triangle arrowhead (same as call)").
            `cb-arrow-seq-async` — open triangle (stroke-only, no fill).
              Standard UML async-message convention.
          */}
          <marker
            id={callMarkerId}
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="8"
            markerHeight="8"
            orient="auto"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill="hsl(var(--ink))" />
          </marker>
          <marker
            id={asyncMarkerId}
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="8"
            markerHeight="8"
            orient="auto"
          >
            <path
              d="M 0 0 L 10 5 L 0 10"
              fill="none"
              stroke="hsl(var(--ink))"
              strokeWidth={1.5}
            />
          </marker>
        </defs>

        {/* Lifelines (vertical dashed lines) — paint first so messages
            and actor boxes layer over them. */}
        {actors.map((name, i) => (
          <line
            key={`lifeline-${i}`}
            x1={lifelineX(i)}
            y1={lifelineTopY}
            x2={lifelineX(i)}
            y2={lifelineBottomY}
            stroke="hsl(var(--ink-faint))"
            strokeWidth={1}
            strokeDasharray="4 4"
          />
        ))}

        {/* Actor boxes — rectangles centered on each lifeline x-coord. */}
        {actors.map((name, i) => {
          const cx = lifelineX(i);
          const x = cx - ACTOR_W / 2;
          return (
            <g key={`actor-${i}`}>
              <rect
                x={x}
                y={PAD_TOP}
                width={ACTOR_W}
                height={ACTOR_H}
                rx={4}
                ry={4}
                fill="hsl(var(--paper-deep))"
                stroke="hsl(var(--paper-edge))"
                strokeWidth={1.5}
              />
              <text
                x={cx}
                y={PAD_TOP + ACTOR_H / 2}
                textAnchor="middle"
                dominantBaseline="central"
                fill="hsl(var(--ink))"
                fontFamily="var(--font-display), Georgia, serif"
                fontSize={13}
              >
                {name}
              </text>
            </g>
          );
        })}

        {/* Messages — drawn top-to-bottom in declaration order. Each
            message is either a horizontal arrow between two lifelines
            or a right-loop on a single lifeline (self-message). */}
        {validMessages.map((msg, j) => {
          const fromIdx = actorIndex.get(msg.from)!;
          const toIdx = actorIndex.get(msg.to)!;
          const y = messageAreaTop + j * MESSAGE_PITCH_Y;
          const kind = msg.kind ?? 'call';
          const isReturn = kind === 'return';
          const isAsync = kind === 'async';

          const stroke = isReturn ? 'hsl(var(--ink-muted))' : 'hsl(var(--ink))';
          const dashArray = isReturn ? '6 4' : undefined;
          const arrowMarkerId = isAsync ? asyncMarkerId : callMarkerId;

          if (fromIdx === toIdx) {
            // Self-message: right-loop. Cubic Bézier exits the lifeline,
            // curves down SELF_LOOP_DY, and re-enters below. The label
            // sits to the right of the loop apex.
            const x0 = lifelineX(fromIdx);
            const xMid = x0 + SELF_LOOP_DX;
            const yTop = y;
            const yBot = y + SELF_LOOP_DY;
            // Two-segment path: forward arc out, return arc in. Using a
            // cubic with two control points on the outer side gives a
            // clean lobe without computing per-message tangents.
            const d = `M ${x0} ${yTop} C ${xMid} ${yTop}, ${xMid} ${yBot}, ${x0} ${yBot}`;
            return (
              <g key={`msg-${j}`}>
                <path
                  d={d}
                  fill="none"
                  stroke={stroke}
                  strokeWidth={1.5}
                  strokeDasharray={dashArray}
                  markerEnd={`url(#${arrowMarkerId})`}
                />
                <text
                  x={xMid + 6}
                  y={(yTop + yBot) / 2}
                  textAnchor="start"
                  dominantBaseline="central"
                  fill="hsl(var(--ink-muted))"
                  fontFamily="var(--font-sans), -apple-system, sans-serif"
                  fontSize={11}
                >
                  {msg.label}
                </text>
              </g>
            );
          }

          // Cross-lifeline message: straight horizontal arrow with a
          // label centered above the line.
          const x1 = lifelineX(fromIdx);
          const x2 = lifelineX(toIdx);
          const mx = (x1 + x2) / 2;
          // Label rect sits 8px above the line; estimate width from char
          // count (≈7px per glyph at the 11px sans font).
          const labelY = y - 8;
          const rectW = Math.max(20, msg.label.length * 7 + 8);
          const rectH = 14;
          return (
            <g key={`msg-${j}`}>
              <line
                x1={x1}
                y1={y}
                x2={x2}
                y2={y}
                stroke={stroke}
                strokeWidth={1.5}
                strokeDasharray={dashArray}
                markerEnd={`url(#${arrowMarkerId})`}
              />
              {/* Background rect so the label doesn't strike through the
                  lifelines underneath. */}
              <rect
                x={mx - rectW / 2}
                y={labelY - rectH / 2}
                width={rectW}
                height={rectH}
                fill="hsl(var(--paper-canvas))"
              />
              <text
                x={mx}
                y={labelY}
                textAnchor="middle"
                dominantBaseline="central"
                fill="hsl(var(--ink-muted))"
                fontFamily="var(--font-sans), -apple-system, sans-serif"
                fontSize={11}
              >
                {msg.label}
              </text>
            </g>
          );
        })}
      </svg>
    </figure>
  );
}
