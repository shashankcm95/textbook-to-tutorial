/**
 * src/lib/log.ts — structured event logger for personal-use observability.
 *
 * What it does:
 *   - One line per event, JSON-encoded, appended to `./logs/<YYYY-MM-DD>.jsonl`.
 *   - Mirrors the same line to stdout (info) or stderr (warn/error), so
 *     existing console-grep workflows keep working.
 *   - Caller passes a stable `event` slug + an optional context object.
 *     Errors are unwrapped to `{ message, stack, code }` so they grep cleanly.
 *
 * What it does NOT do:
 *   - No deps (no pino, no winston). Personal-use scale; zero dep bloat.
 *   - No async write queue — `fs.appendFileSync`. Personal-use traffic is
 *     trivial; the simplicity is worth the rare event-loop tick.
 *   - No log levels finer than info/warn/error. Add `trace`/`debug` later
 *     if real signal demands it.
 *   - No rotation beyond per-day files. Cron `find ./logs -mtime +30 -delete`
 *     if disk pressure becomes an issue (it won't, for a single user).
 *
 * Why JSONL instead of plain text:
 *   - Greppable: `jq 'select(.level=="error" and .event=="glossary.read.failed")'`
 *   - Stable schema lets us pipe to any tool later (Vector, Loki, etc.)
 *
 * Usage:
 *   import { logger } from '@/lib/log';
 *   logger.warn('glossary.read.failed', {
 *     tutorialId,
 *     chapterId,
 *     err,             // accepts Error | string | unknown — unwrapped safely
 *     fail_open: true, // any other fields you want on the line
 *   });
 *
 * The line that lands in the file is one minified JSON object:
 *   {"ts":"2026-05-27T18:39:28.123Z","level":"warn","event":"glossary.read.failed","tutorialId":"...","chapterId":"...","err":{"message":"NoSuchKey","stack":"..."},"fail_open":true}
 *
 * NODE-ONLY: this module imports `node:fs` and `node:path`. It is safe in
 * Server Components, route handlers, the ingest worker, and the SSE
 * stream route, all of which run on the Node runtime. Do NOT import from
 * middleware or any Edge-runtime surface.
 */

import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

export type LogLevel = 'info' | 'warn' | 'error';

export interface LogContext {
  readonly [key: string]: unknown;
}

export interface LogLine extends LogContext {
  readonly ts: string;
  readonly level: LogLevel;
  readonly event: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Configuration (env-overridable for tests and ops)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Where the per-day JSONL files live. Override with `LOG_DIR` env var.
 * Default: `./logs/` relative to `process.cwd()`. The directory is created
 * on first write; safe to gitignore.
 */
const DEFAULT_LOG_DIR = path.resolve(process.cwd(), 'logs');

/**
 * Set `DISABLE_FILE_LOG=1` to suppress file writes (useful in tests + CI
 * to avoid littering the working tree). Console mirror still fires.
 */
function fileLoggingEnabled(): boolean {
  return process.env.DISABLE_FILE_LOG !== '1';
}

function logDir(): string {
  return process.env.LOG_DIR ?? DEFAULT_LOG_DIR;
}

// ─────────────────────────────────────────────────────────────────────────────
// Error normalization
// ─────────────────────────────────────────────────────────────────────────────

interface NormalizedError {
  readonly message: string;
  readonly stack?: string;
  readonly code?: string;
  readonly name?: string;
}

/**
 * Unwrap an `unknown` thrown value into a JSON-serializable shape.
 *
 *   - Error instance → `{ message, stack, code?, name }` (preserves
 *     subclass info like `S3ChunkReadError.code = 'forbidden'`)
 *   - string         → `{ message: <string> }`
 *   - anything else  → `{ message: String(value) }`
 *
 * Pure; exposed for tests.
 */
export function normalizeError(value: unknown): NormalizedError {
  if (value instanceof Error) {
    const out: NormalizedError = {
      message: value.message,
      stack: value.stack,
      name: value.name,
      // Many node + AWS SDK errors carry a string `code`. Preserve when present.
      code: (value as Error & { code?: string }).code,
    };
    // Strip undefineds so they don't serialize as `null`.
    return Object.fromEntries(
      Object.entries(out).filter(([, v]) => v !== undefined),
    ) as NormalizedError;
  }
  if (typeof value === 'string') return { message: value };
  return { message: String(value) };
}

// ─────────────────────────────────────────────────────────────────────────────
// File path helpers
// ─────────────────────────────────────────────────────────────────────────────

let cachedDirEnsured: string | null = null;

function ensureDir(dir: string): void {
  // Cache the "already ensured" check so we don't statSync on every line.
  if (cachedDirEnsured === dir) return;
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  cachedDirEnsured = dir;
}

/**
 * Path for today's log file. Exposed for tests + the `pnpm logs:tail` script.
 */
export function todaysLogFile(now: Date = new Date()): string {
  const dir = logDir();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(now.getUTCDate()).padStart(2, '0');
  return path.join(dir, `${yyyy}-${mm}-${dd}.jsonl`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

function emit(level: LogLevel, event: string, ctx: LogContext = {}): void {
  // Build the line up front so a serialization error throws cleanly rather
  // than half-writing.
  const { err, ...rest } = ctx;
  const line: LogLine = {
    ts: new Date().toISOString(),
    level,
    event,
    ...rest,
    ...(err !== undefined ? { err: normalizeError(err) } : {}),
  };

  let serialized: string;
  try {
    serialized = JSON.stringify(line);
  } catch (e) {
    // Fall back to a safe stub so the caller's hot path doesn't crash.
    serialized = JSON.stringify({
      ts: line.ts,
      level,
      event,
      err: { message: 'log serialization failed: ' + String(e) },
    });
  }

  // 1. File sink (sync append; per-day file).
  if (fileLoggingEnabled()) {
    try {
      const dir = logDir();
      ensureDir(dir);
      appendFileSync(todaysLogFile(), serialized + '\n', { encoding: 'utf8' });
    } catch (e) {
      // The file sink is best-effort. If the disk is full or the dir is
      // read-only, we don't want to crash the request path. Surface to
      // stderr once-per-process via the console mirror below; do NOT
      // recurse back into emit() (would infinite-loop on the same error).
      // eslint-disable-next-line no-console
      console.error(
        '[logger] file sink failed (continuing console-only):',
        (e as Error).message,
      );
    }
  }

  // 2. Console mirror — preserves the existing developer-grep workflow.
  //    Use the level-matched method so existing terminal filters keep working.
  // eslint-disable-next-line no-console
  if (level === 'error') console.error(serialized);
  // eslint-disable-next-line no-console
  else if (level === 'warn') console.warn(serialized);
  // eslint-disable-next-line no-console
  else console.log(serialized);
}

/**
 * The logger instance — three methods, one event slug + context per call.
 *
 * Event-name convention: dot-separated, past-tense / state-of-event:
 *   - `glossary.read.failed`
 *   - `glossary.read.cache_miss`
 *   - `chapter.fidelity.scored`
 *   - `chapter.anchor.coverage.violated`
 *   - `ingest.worker.started`
 *   - `ingest.worker.failed`
 *
 * Grep cleanly: `jq 'select(.event | startswith("glossary."))'`.
 */
export const logger = {
  info(event: string, ctx?: LogContext): void {
    emit('info', event, ctx);
  },
  warn(event: string, ctx?: LogContext): void {
    emit('warn', event, ctx);
  },
  error(event: string, ctx?: LogContext): void {
    emit('error', event, ctx);
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Test helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Reset internal state. ONLY for tests — production code should not touch.
 * Exported under `__test_only` to keep the surface intentionally narrow.
 */
export const __test_only = {
  resetDirCache(): void {
    cachedDirEnsured = null;
  },
};
