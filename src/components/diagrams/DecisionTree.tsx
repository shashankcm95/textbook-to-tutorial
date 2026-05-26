// src/components/diagrams/DecisionTree.tsx — Sprint F.2 primitive.
//
// Renders a recursive decision tree as an inline SVG, top-down (root at
// top, leaves at bottom). Internal nodes are rounded rectangles showing
// a question; leaves are pill-shaped outcomes. Edges are plain straight
// lines (no arrowheads — the top-to-bottom flow direction is implied by
// position) annotated with "Yes" (success-tinted) on the left branch and
// "No" (danger-tinted) on the right branch. Pedagogical convention: yes
// on the left, no on the right (enforced by the layout pass).
//
// Server-component safe: no `'use client'`, no hooks, no DOM access. The
// viewBox is computed from the subtree-width pack so the SVG scales
// fluidly to the containing column width via `width="100%" height="auto"`.
//
// Why a simplified Reingold-Tilford pack:
// ---------------------------------------
// Schema caps depth at 8 (enforced by parse.ts; we trust the boundary
// per `kb:architecture/discipline/error-handling-discipline §"Pattern 3"`
// — interior never re-validates) and each internal node has exactly 2
// branches. At those bounds, the simplified two-pass pack (post-order
// subtree-width compute, then pre-order x-coord placement) is empirically
// tight enough. Textbook-pure tidy-tree (nephew spacing, contour merge)
// would buy nothing visible at depth ≤ 8 with binary branching.
//
// Why no arrowhead markers:
// -------------------------
// Top-down reading order makes direction obvious; arrowheads on every
// internal-node-to-child line would visually clutter a tree that already
// carries two label glyphs per edge ("Yes" / "No"). DiagramFlow uses
// arrowheads because its LR/TB direction is less spatially overdetermined.
//
// Brand tokens via inline `hsl(var(--token))` — mirrors DiagramFlow.tsx
// since SVG fill/stroke can't pick up Tailwind utility classes the same
// way HTML elements do. All tokens live in src/app/globals.css under
// @layer utilities; we invent no new ones.

import React from 'react';
import type {
  DecisionTreeNode,
  DecisionTreePayload,
} from '@/lib/diagrams/schema';

// ── Geometry constants — design-pixel units carried by the viewBox. ──
const LEAF_MIN_W = 80;
const LEAF_MAX_W = 200;
const INTERNAL_MIN_W = 120;
// Sprint F.2 Wave-2 reviewer fix-up: cap internal box width so unbounded
// long questions don't blow out the tree. Beyond this cap, wrapLabel
// engages to fit text via 2-line wrap + ellipsis. Without this cap, an
// 80-char no-space question grows the box to ~580px wide, the layout
// becomes unreadable, AND wrapLabel never fires (silent overflow).
const INTERNAL_MAX_W = 240;
const GAP_X = 24;
const LEVEL_PITCH_Y = 80;
const PAD = 24;
const NODE_H = 44; // box height for both internal rect + leaf pill
const CHAR_PX = 7; // rough char width at 12-13px display font
const TEXT_MIN_PX = 40;

// Type narrowing helpers — pure, single-purpose.
function isLeaf(
  node: DecisionTreeNode,
): node is Extract<DecisionTreeNode, { leaf: string }> {
  return 'leaf' in node;
}

function nodeText(node: DecisionTreeNode): string {
  return isLeaf(node) ? node.leaf : node.question;
}

function estimateTextWidth(s: string): number {
  return Math.max(s.length * CHAR_PX, TEXT_MIN_PX);
}

// Greedy 2-line word wrap for internal-node questions. The schema caps
// `question` at 120 chars but our boxes are only ~120-200px wide; we wrap
// at word boundaries and ellipsize if a 3rd line would be needed.
function wrapLabel(
  text: string,
  maxWidth: number,
  maxLines = 2,
): string[] {
  const widthInChars = Math.max(6, Math.floor(maxWidth / CHAR_PX));
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = '';

  // Helper: truncate a single word that exceeds widthInChars to fit with
  // an ellipsis. Without this, a space-free 120-char schema-max question
  // (e.g., a CamelCase identifier) would silently overflow the SVG <rect>.
  // Sprint F.2 Wave-2 reviewer fix.
  const truncateWord = (w: string): string =>
    w.length > widthInChars ? `${w.slice(0, Math.max(0, widthInChars - 1))}…` : w;

  for (let i = 0; i < words.length; i++) {
    const word = words[i]!;
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= widthInChars) {
      current = candidate;
      continue;
    }
    if (lines.length < maxLines - 1) {
      // commit current, start new line with this word (truncated if needed)
      if (current) lines.push(current);
      current = truncateWord(word);
    } else {
      // we're on the final line — pack what fits, ellipsize the rest.
      // Use the positional index `i` (NOT words.indexOf(word)) so a repeated
      // word doesn't corrupt the tail slice. Sprint F.2 Wave-2 reviewer fix.
      const remaining = words.slice(i);
      const tail = remaining.join(' ');
      const room = Math.max(1, widthInChars - current.length - 1);
      if (current && tail.length > room) {
        // truncate within the existing final line
        const truncated = `${current} ${tail.slice(0, Math.max(0, room - 1))}`;
        current = `${truncated}…`;
      } else if (!current) {
        current = `${tail.slice(0, Math.max(0, widthInChars - 1))}…`;
      } else {
        current = `${current} ${tail}`;
      }
      break;
    }
  }
  if (current) lines.push(current);
  // Safety net for empty input — return a single empty string so the
  // <text> element still renders (preserves the bounding box).
  return lines.length > 0 ? lines : [''];
}

// Pass 1: post-order subtree-width. Each node's footprint = max(its own
// label width, sum of its children's footprints + gap).
// Sprint F.2 Wave-2 reviewer fix-up: own-width is now clamped to
// [INTERNAL_MIN_W..INTERNAL_MAX_W] (matching the render-time clamp) so
// the post-order budget agrees with the rect that actually paints.
function computeWidth(node: DecisionTreeNode): number {
  if (isLeaf(node)) {
    return Math.min(LEAF_MAX_W, Math.max(LEAF_MIN_W, estimateTextWidth(node.leaf)));
  }
  const yesW = computeWidth(node.yes);
  const noW = computeWidth(node.no);
  const ownW = Math.min(
    INTERNAL_MAX_W,
    Math.max(INTERNAL_MIN_W, estimateTextWidth(node.question)),
  );
  return Math.max(ownW, yesW + GAP_X + noW);
}

// Pass 2: pre-order placement. yes-child shifts left of parent center;
// no-child shifts right. The offset uses the *opposite* sibling's
// subtree width (matches the RFC's pseudocode exactly).
interface PlacedNode {
  node: DecisionTreeNode;
  x: number;
  y: number;
  depth: number;
  // For edge wiring: each placed node carries its parent's coords +
  // which branch it is, so the renderer can emit lines + labels without
  // a second traversal.
  parentX?: number;
  parentY?: number;
  branch?: 'yes' | 'no';
}

function place(
  node: DecisionTreeNode,
  centerX: number,
  depth: number,
  out: PlacedNode[],
  parentX?: number,
  parentY?: number,
  branch?: 'yes' | 'no',
): void {
  const y = PAD + depth * LEVEL_PITCH_Y;
  out.push({ node, x: centerX, y, depth, parentX, parentY, branch });
  if (isLeaf(node)) return;
  const yesW = computeWidth(node.yes);
  const noW = computeWidth(node.no);
  // Yes-branch: parent's center shifted LEFT by half(no's footprint + gap).
  // No-branch:  parent's center shifted RIGHT by half(yes's footprint + gap).
  // This packs each child against its sibling's outer edge.
  place(
    node.yes,
    centerX - (noW + GAP_X) / 2,
    depth + 1,
    out,
    centerX,
    y,
    'yes',
  );
  place(
    node.no,
    centerX + (yesW + GAP_X) / 2,
    depth + 1,
    out,
    centerX,
    y,
    'no',
  );
}

function getMaxDepth(node: DecisionTreeNode, depth = 0): number {
  if (isLeaf(node)) return depth;
  return Math.max(
    getMaxDepth(node.yes, depth + 1),
    getMaxDepth(node.no, depth + 1),
  );
}

// Persona-review 2026-05-26 (Riley): functional summary — count of
// outcomes + opening question, not "rooted at" implementation language.
function countOutcomes(node: DecisionTreeNode): number {
  if (isLeaf(node)) return 1;
  return countOutcomes(node.yes) + countOutcomes(node.no);
}

function buildAriaLabel(payload: DecisionTreePayload): string {
  const outcomeCount = countOutcomes(payload.root);
  const rootText = nodeText(payload.root);
  const heading = payload.title
    ? `Decision tree for "${payload.title}"`
    : 'Decision tree';
  return `${heading}: ${outcomeCount} possible outcome${outcomeCount === 1 ? '' : 's'}, starting with the question "${rootText}".`;
}

export default function DecisionTree({
  payload,
}: {
  payload: DecisionTreePayload;
}) {
  const { title, root } = payload;

  // Two-pass layout — pure functions, no state.
  const placed: PlacedNode[] = [];
  const rootWidth = computeWidth(root);
  place(root, PAD + rootWidth / 2, 0, placed);

  // ViewBox: total tree footprint + symmetric padding.
  const W = rootWidth + 2 * PAD;
  const H = (getMaxDepth(root) + 1) * LEVEL_PITCH_Y + 2 * PAD;

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
        {/* Edges first so node shapes paint on top of edge endpoints. */}
        {placed
          .filter((p) => p.parentX !== undefined && p.parentY !== undefined)
          .map((p, i) => {
            // parent center-bottom → child center-top
            const x1 = p.parentX!;
            const y1 = p.parentY! + NODE_H / 2;
            const x2 = p.x;
            const y2 = p.y - NODE_H / 2;
            return (
              <line
                key={`edge-${i}`}
                x1={x1}
                y1={y1}
                x2={x2}
                y2={y2}
                stroke="hsl(var(--ink-muted))"
                strokeWidth={1.5}
              />
            );
          })}

        {/* Node shapes + labels. */}
        {placed.map((p, i) => {
          const cx = p.x;
          const cy = p.y;
          if (isLeaf(p.node)) {
            const w = Math.max(LEAF_MIN_W, estimateTextWidth(p.node.leaf) + 16);
            return (
              <g key={`leaf-${i}`}>
                <rect
                  x={cx - w / 2}
                  y={cy - NODE_H / 2}
                  width={w}
                  height={NODE_H}
                  rx={NODE_H / 2}
                  ry={NODE_H / 2}
                  fill="hsl(var(--brand-fade))"
                  stroke="hsl(var(--brand))"
                  strokeWidth={1.5}
                />
                <text
                  x={cx}
                  y={cy}
                  textAnchor="middle"
                  dominantBaseline="central"
                  fill="hsl(var(--ink))"
                  fontFamily="var(--font-display), Georgia, serif"
                  fontSize={13}
                >
                  {p.node.leaf}
                </text>
              </g>
            );
          }
          // Internal node — rounded rect with 1- or 2-line wrapped question.
          // Width = clamp(question-width + padding, [INTERNAL_MIN_W, INTERNAL_MAX_W]).
          // The MAX cap forces wrapLabel to engage for long questions instead
          // of growing the box indefinitely (Sprint F.2 Wave-2 reviewer fix).
          const w = Math.min(
            INTERNAL_MAX_W,
            Math.max(INTERNAL_MIN_W, estimateTextWidth(p.node.question) + 16),
          );
          const lines = wrapLabel(p.node.question, w - 16, 2);
          // Stack the lines around the box vertical center. SVG <tspan>
          // x-coords reset per line; dy advances vertically.
          const lineHeight = 14;
          const startY = cy - ((lines.length - 1) * lineHeight) / 2;
          return (
            <g key={`internal-${i}`}>
              <rect
                x={cx - w / 2}
                y={cy - NODE_H / 2}
                width={w}
                height={NODE_H}
                rx={8}
                ry={8}
                fill="hsl(var(--paper-deep))"
                stroke="hsl(var(--paper-edge))"
                strokeWidth={1.5}
              />
              <text
                x={cx}
                y={startY}
                textAnchor="middle"
                dominantBaseline="central"
                fill="hsl(var(--ink))"
                fontFamily="var(--font-display), Georgia, serif"
                fontSize={13}
              >
                {lines.map((line, li) => (
                  <tspan key={li} x={cx} dy={li === 0 ? 0 : lineHeight}>
                    {line}
                  </tspan>
                ))}
              </text>
            </g>
          );
        })}

        {/* Yes / No branch labels last so they paint above the edge lines. */}
        {placed
          .filter((p) => p.branch !== undefined)
          .map((p, i) => {
            const x1 = p.parentX!;
            const y1 = p.parentY! + NODE_H / 2;
            const x2 = p.x;
            const y2 = p.y - NODE_H / 2;
            const mx = (x1 + x2) / 2;
            const my = (y1 + y2) / 2;
            const label = p.branch === 'yes' ? 'Yes' : 'No';
            const rectW = label.length * 7 + 10;
            const rectH = 16;
            const color =
              p.branch === 'yes' ? 'hsl(var(--success))' : 'hsl(var(--danger))';
            return (
              <g key={`branch-label-${i}`}>
                <rect
                  x={mx - rectW / 2}
                  y={my - rectH / 2}
                  width={rectW}
                  height={rectH}
                  fill="hsl(var(--paper-canvas))"
                />
                <text
                  x={mx}
                  y={my}
                  textAnchor="middle"
                  dominantBaseline="central"
                  fill={color}
                  fontFamily="var(--font-sans), -apple-system, sans-serif"
                  fontSize={11}
                  fontWeight={600}
                >
                  {label}
                </text>
              </g>
            );
          })}
      </svg>
    </figure>
  );
}
