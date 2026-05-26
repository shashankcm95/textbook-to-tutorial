'use client';

/**
 * src/components/CostChip.tsx — running-cost pill rendered in tutorial header.
 *
 * LOAD-BEARING ABSORB: riley CRITICAL-cost-placement (Phase 1 synthesis).
 *
 *   "CostChip in tutorial-page HEADER (always visible during stream), not in
 *    footer/sidebar."
 *
 * Visibility-during-stream is the key constraint: when generation is firing
 * tokens at the user, the cost is incrementing in real time and the user
 * needs to see the gauge climb without scrolling. Header placement satisfies
 * this (header is sticky in the page layout, alongside the chapter title).
 *
 * Data sources (two paths, complementary):
 *
 *   1. Polling — every POLL_INTERVAL_MS we GET /api/tutorials/${id}/cost.
 *      Catches background-worker progress that the SSE stream may not surface
 *      (e.g., the worker is mid-chapter but the SSE between chapters is idle).
 *      Also recovers from a torn-down SSE: the cost still climbs server-side
 *      until the worker completes the chapter; polling catches the final tick.
 *
 *   2. SSE 'cost-update' events — pushed by priya's stream handler whenever
 *      a chapter completes (after `parses_cost` row insert). Caller threads
 *      these into `propsCostNow` to avoid the polling-only lag. We use the
 *      SSE-pushed value when present (more recent than the poll baseline).
 *
 * Color coding (per spec):
 *   < 50% of cap → green   (safe headroom)
 *   50-80%       → amber   (paying attention)
 *   > 80%        → red     (likely to cap out before next chapter)
 *
 * The thresholds are chosen so the user sees ONE color transition while
 * generating an ordinary DDIA-sized tutorial (~13% of cap, per the snapshot's
 * expected-cost note) and the amber/red bands surface only when the cap is
 * close — at which point cost-cap-exceeded errors are imminent and the user
 * should be primed to act.
 *
 * a11y discipline: status semantics via `role="status"` + `aria-live="polite"`
 * so screen readers announce cost climbs without interrupting other reading.
 * Polite (not assertive) — cost is informational, not urgent. Each color
 * also carries a textual indicator ("safe" / "warn" / "cap-near") so users
 * with color-vision differences get the same signal.
 *
 * Anchors:
 *   - kb:web-dev/react-essentials §"Accessibility" — every UI element should
 *     communicate via something other than color alone (WCAG 1.4.1).
 *   - kb:web-dev/react-essentials §"State-management cascade" — local
 *     `useState` is sufficient here; no need to lift to context.
 */

import { useEffect, useState, useRef } from 'react';

// ───────────────────────────────────────────────────────────────────────────
// Constants
// ───────────────────────────────────────────────────────────────────────────

/** Poll cadence per spec (15s). Fast enough to feel live; slow enough that
 *  100 simultaneous tutorial views don't hammer the server. */
const POLL_INTERVAL_MS = 15_000;

// Persona-review 2026-05-26 (Riley/Priya): the old thresholds (50% warn,
// 80% danger) painted the chip red during normal reading sessions and
// communicated anxiety with no explanation. New thresholds keep it calm
// until the user is genuinely close to the cap, and the tooltip explains
// what hitting 100% actually means (gen pauses; existing content stays).
const COLOR_BAND_WARN = 0.85;
const COLOR_BAND_DANGER = 0.95;

// Tooltip copy attached to the chip so users understand the cap's effect.
// Surfaces in BOTH the native `title=` attribute and the aria-description
// for screen readers.
const COST_CAP_TOOLTIP =
  'When 100% of the cap is reached, new chapter generation pauses. Existing chapters stay readable.';

// ───────────────────────────────────────────────────────────────────────────
// Props + state types
// ───────────────────────────────────────────────────────────────────────────

export interface CostChipProps {
  /** Tutorial id — used to build the poll URL. */
  tutorialId: string;
  /**
   * Optional override — when the SSE stream pushes a fresh cost-update,
   * the parent re-renders us with `costUsdLive` set; we prefer that over
   * the polled value (it's newer). Reset to undefined on SSE disconnect.
   */
  costUsdLive?: number;
}

/**
 * Server response shape from /api/tutorials/${id}/cost.
 *
 * Persona-Sprint-A T1.4 fix: previous code expected `costUsd` / `costCapUsd`
 * but the server returns `spentUsd` / `capUsd` (see CostResponse in
 * src/app/api/tutorials/[id]/cost/route.ts:48-55). The mismatch silently
 * fell through to defaults of 0/0 → chip rendered "$0.00 / $0.00 (0%)"
 * across every revisit. Aligning the client-side keys to the server contract.
 *
 * (We keep the legacy aliases as optional fields so a transient deploy where
 * client + server are out-of-sync still degrades to the old behavior rather
 * than crashing the chip.)
 */
interface CostPollResponse {
  spentUsd: number;
  capUsd: number;
  /** Optional legacy keys — accepted for forward/backward compat. */
  costUsd?: number;
  costCapUsd?: number;
}

interface CostState {
  costUsd: number;
  costCapUsd: number;
  loading: boolean;
  error: string | null;
}

const INITIAL: CostState = {
  costUsd: 0,
  costCapUsd: 0,
  loading: true,
  error: null,
};

// ───────────────────────────────────────────────────────────────────────────
// Component
// ───────────────────────────────────────────────────────────────────────────

export function CostChip({ tutorialId, costUsdLive }: CostChipProps) {
  const [state, setState] = useState<CostState>(INITIAL);
  // Latch to skip the first interval-fired poll right after mount — we already
  // poll once on mount. Avoids double-fetch in the first 15s.
  const skipFirstIntervalRef = useRef(true);

  useEffect(() => {
    let disposed = false;
    const ac = new AbortController();

    /**
     * Single poll. Idempotent; safe to call from mount + interval.
     * Uses fetch with AbortSignal so the cleanup tears down inflight requests.
     */
    const poll = async (): Promise<void> => {
      try {
        const res = await fetch(
          `/api/tutorials/${encodeURIComponent(tutorialId)}/cost`,
          {
            signal: ac.signal,
            // Polling response should never be cached — staleness shows the
            // user a fake-low cost. Same rationale as the status endpoint
            // (src/app/api/tutorials/[id]/route.ts:81 Cache-Control: no-store).
            cache: 'no-store',
            credentials: 'include',
          },
        );
        if (!res.ok) {
          // 404 = tutorial doesn't exist / not owned; surface as a soft error
          // without crashing the chip. Could happen if the tutorial was
          // deleted while the user had the page open.
          throw new Error(`cost poll failed: ${res.status}`);
        }
        const data = (await res.json()) as Partial<CostPollResponse>;
        if (disposed) return;
        // Defensive parse — server SHOULD return the shape but defending
        // against partial deploys / proxy errors that munge the body.
        //
        // T1.4: accept both `spentUsd`/`capUsd` (current contract) and the
        // legacy `costUsd`/`costCapUsd` aliases. Spent first; legacy second.
        const spentRaw =
          typeof data.spentUsd === 'number' && Number.isFinite(data.spentUsd)
            ? data.spentUsd
            : typeof data.costUsd === 'number' && Number.isFinite(data.costUsd)
              ? data.costUsd
              : 0;
        const capRaw =
          typeof data.capUsd === 'number' && Number.isFinite(data.capUsd) && data.capUsd > 0
            ? data.capUsd
            : typeof data.costCapUsd === 'number' &&
                Number.isFinite(data.costCapUsd) &&
                data.costCapUsd > 0
              ? data.costCapUsd
              : 0;
        setState({ costUsd: spentRaw, costCapUsd: capRaw, loading: false, error: null });
      } catch (err: unknown) {
        if (disposed) return;
        // AbortError on cleanup is expected; don't surface.
        const isAbort =
          err instanceof Error && (err.name === 'AbortError' || ac.signal.aborted);
        if (isAbort) return;
        const message = err instanceof Error ? err.message : 'unknown';
        setState((prev) => ({ ...prev, loading: false, error: message }));
      }
    };

    // First poll — fire immediately.
    void poll();
    // Subsequent polls — interval.
    const id = setInterval(() => {
      if (skipFirstIntervalRef.current) {
        skipFirstIntervalRef.current = false;
        return;
      }
      void poll();
    }, POLL_INTERVAL_MS);

    return () => {
      disposed = true;
      clearInterval(id);
      // Abort any in-flight fetch so we don't update state on an unmounted
      // component (also helps if the user navigates away mid-poll).
      ac.abort();
    };
  }, [tutorialId]);

  // Prefer the SSE-pushed live value when present (fresher than poll cadence).
  const effectiveCost =
    typeof costUsdLive === 'number' && Number.isFinite(costUsdLive)
      ? costUsdLive
      : state.costUsd;

  // pct in [0, 1+]. We don't clamp at 1 in the data so the user can SEE that
  // they've exceeded the cap (cost overshoots happen if a single chapter's
  // actual cost beats the pre-call estimate by enough).
  const pct =
    state.costCapUsd > 0 ? effectiveCost / state.costCapUsd : 0;

  const band = pickBand(pct);
  const colorClasses = BAND_CLASSES[band];
  const bandLabel = BAND_LABEL[band];

  // Loading state — show neutral chip with placeholder text. Keeps the header
  // shape from jumping when the first poll lands.
  if (state.loading) {
    return (
      <span
        role="status"
        aria-live="polite"
        aria-label="Loading cost"
        className="inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium bg-muted text-muted-foreground"
      >
        <Spinner /> Cost…
      </span>
    );
  }

  if (state.error !== null) {
    return (
      <span
        role="status"
        aria-live="polite"
        title={state.error}
        className="inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium bg-destructive/10 text-destructive"
      >
        Cost: unavailable
      </span>
    );
  }

  // T1.4: if the cap is missing or zero (server contract drift or env
  // misconfiguration), show only the spent amount — no div-by-zero
  // "$0.00 / $0.00 (0%)". This is friendlier than asserting + crashing.
  if (state.costCapUsd <= 0) {
    return (
      <span
        role="status"
        aria-live="polite"
        aria-label={`Cost so far: ${formatUsd(effectiveCost)}`}
        className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium ${colorClasses}`}
      >
        <Dot bandClass={DOT_CLASSES[band]} />
        <span aria-hidden="true">{formatUsd(effectiveCost)} used</span>
      </span>
    );
  }

  return (
    <span
      role="status"
      aria-live="polite"
      aria-label={`Cost so far: ${formatUsd(effectiveCost)} of ${formatUsd(state.costCapUsd)} cap, ${Math.round(pct * 100)} percent, ${bandLabel}. ${COST_CAP_TOOLTIP}`}
      title={COST_CAP_TOOLTIP}
      className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium ${colorClasses}`}
    >
      <Dot bandClass={DOT_CLASSES[band]} />
      <span aria-hidden="true">
        {formatUsd(effectiveCost)} / {formatUsd(state.costCapUsd)}{' '}
        ({Math.round(pct * 100)}%)
      </span>
    </span>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Pure helpers (testable in isolation)
// ───────────────────────────────────────────────────────────────────────────

type ColorBand = 'safe' | 'warn' | 'danger';

export function pickBand(pct: number): ColorBand {
  if (pct < COLOR_BAND_WARN) return 'safe';
  if (pct < COLOR_BAND_DANGER) return 'warn';
  return 'danger';
}

/**
 * Format USD with two-decimal precision. Locale: en-US to keep the chip
 * width predictable across user locales. The narrative content is already
 * English (LLM generates in English); cost format consistency is preferable
 * to locale-driven re-layout.
 */
function formatUsd(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

// ───────────────────────────────────────────────────────────────────────────
// Color band → Tailwind class mappings (use Tailwind theme tokens from globals.css)
// ───────────────────────────────────────────────────────────────────────────

const BAND_CLASSES: Record<ColorBand, string> = {
  // Green band: emerald-50 / emerald-700 in light; emerald-950/40 / emerald-300 in dark.
  safe: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300',
  // Amber band.
  warn: 'bg-amber-100 text-amber-900 dark:bg-amber-950/40 dark:text-amber-300',
  // Red band — uses theme destructive for cohesion with other error UI.
  danger:
    'bg-destructive/10 text-destructive dark:bg-destructive/20 dark:text-destructive-foreground',
};

const DOT_CLASSES: Record<ColorBand, string> = {
  safe: 'bg-emerald-500',
  warn: 'bg-amber-500',
  danger: 'bg-destructive',
};

const BAND_LABEL: Record<ColorBand, string> = {
  safe: 'within budget',
  warn: 'approaching cap',
  danger: 'near or over cap',
};

// ───────────────────────────────────────────────────────────────────────────
// Tiny presentational atoms (avoid importing UI lib for one dot + spinner)
// ───────────────────────────────────────────────────────────────────────────

function Dot({ bandClass }: { bandClass: string }) {
  return (
    <span
      aria-hidden="true"
      className={`inline-block h-2 w-2 rounded-full ${bandClass}`}
    />
  );
}

function Spinner() {
  return (
    <svg
      aria-hidden="true"
      className="h-3 w-3 animate-spin"
      viewBox="0 0 24 24"
      fill="none"
    >
      <circle
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeOpacity="0.25"
        strokeWidth="3"
      />
      <path
        d="M22 12a10 10 0 0 1-10 10"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}
