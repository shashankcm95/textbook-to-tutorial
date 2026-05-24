'use client';

/**
 * src/components/ProgressRing.tsx — small circular progress indicator.
 *
 * Used in the TutorialHeader to surface tutorial-level completion (% of
 * chapters fully complete) alongside the book title + cost chip. Replaces
 * the text "X of Y chapters fully complete" hidden inside CompletionTracker
 * with a glance-able visual.
 *
 * Design notes (per UI/UX hybrid audit §3.2 / §3.8):
 *   - Two-arc SVG (stroke-based, not filled): a paper-edge track + a brand
 *     foreground that fills clockwise as `value` rises.
 *   - 28px default — about the tap-target floor for a sticky header.
 *   - The numeric percent renders centered when `showLabel` is true; for
 *     header use we typically hide it (the ring is glance-only).
 *   - `transition-[stroke-dashoffset]` animates the fill on value change
 *     with the `decelerate` easing token (180ms). reduced-motion users
 *     get instant snap via the global `@media (prefers-reduced-motion)`
 *     rule in globals.css.
 *   - aria-valuenow / aria-valuemin / aria-valuemax expose the same
 *     information to assistive tech.
 *
 * Pure presentational. No hooks, no fetch, no streaming awareness — the
 * caller owns the `value` (0..1).
 */

interface ProgressRingProps {
  /** Completion ratio in [0, 1]. Values outside the range are clamped. */
  value: number;
  /** Diameter in px. Defaults to 28 (sticky-header use). */
  size?: number;
  /** Show centered percent label. Defaults to false (glance mode). */
  showLabel?: boolean;
  /** Optional accessible label. Falls back to "Progress: N%". */
  ariaLabel?: string;
  /** Foreground stroke color (CSS color). Defaults to brand indigo. */
  trackColor?: string;
  fillColor?: string;
  /** Stroke width in px. Defaults to 2.5 for size=28; scales linearly. */
  strokeWidth?: number;
}

export function ProgressRing({
  value,
  size = 28,
  showLabel = false,
  ariaLabel,
  trackColor,
  fillColor,
  strokeWidth,
}: ProgressRingProps) {
  const clamped = Math.max(0, Math.min(1, value));
  const pct = Math.round(clamped * 100);
  const sw = strokeWidth ?? Math.max(2, size * 0.09);
  const r = (size - sw) / 2;
  const c = 2 * Math.PI * r;
  const dashOffset = c * (1 - clamped);

  const label = ariaLabel ?? `Progress: ${pct} percent`;

  return (
    <span
      role="progressbar"
      aria-valuenow={pct}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label}
      className="relative inline-flex shrink-0 items-center justify-center"
      style={{ width: size, height: size }}
    >
      <svg width={size} height={size} aria-hidden="true">
        {/* Track */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={trackColor ?? 'hsl(var(--paper-edge))'}
          strokeWidth={sw}
        />
        {/* Fill — rotates so 0° is at 12 o'clock */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={fillColor ?? 'hsl(var(--brand))'}
          strokeWidth={sw}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={dashOffset}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
          className="transition-[stroke-dashoffset] duration-base ease-decelerate"
        />
      </svg>
      {showLabel ? (
        <span
          className="absolute font-mono text-micro text-ink tabular-nums"
          style={{ fontSize: Math.max(8, size * 0.28) }}
        >
          {pct}
        </span>
      ) : null}
    </span>
  );
}
