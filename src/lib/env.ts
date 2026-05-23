// src/lib/env.ts — zod-validated env loader for TB_to_Tutorial_converter
//
// Design anchors:
//   - kb:architecture/discipline/error-handling-discipline §"Patterns 3+7" —
//     validate at the outermost meaningful layer (process boot); crash with
//     a structured error when config is corrupt (Pattern 7); design errors
//     OUT by clamping types via zod schemas (Pattern 3).
//   - FIX-I7 lineage (claude-toolkit/_lib/env-placeholder.js) — placeholder
//     shapes are treated as "value absent" so naive `[ -n "$X" ]` truthy
//     guards cannot let `<your-key-here>` silently degrade Phase 5 UAT.
//   - DRIFT-test3-001 quinn CRIT-1 — adds the `$(...)` command-substitution
//     literal shape to the placeholder regex set, AHEAD of the toolkit fix.
//     This closes a real foot-gun: operators who paste
//       SESSION_SECRET="\$(openssl rand -base64 32)"
//     into a single-quoted shell or who escape the substitution would
//     otherwise pass the truthy guard but ship a useless literal.
//
// Lazy-S3 design: AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY are NOT required
// at boot. Only when `s3Env()` is invoked (first s3:// ingest attempt) do
// we validate them. Rationale: Phase 2-4 dev/test/unit work must run without
// AWS creds; only Phase 5 UAT (real s3:// fetch) needs them. This matches
// the "validate at the outermost meaningful layer FOR THE OPERATION" reading
// of the end-to-end principle: AWS creds are meaningful only at the s3-fetch
// boundary, not at process boot.

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Placeholder detection — mirrors toolkit's _lib/env-placeholder.js (FIX-I7)
// PLUS the `$(...)` shape per DRIFT-test3-001.
//
// Replicated inline (not imported from claude-toolkit) because TB_to_Tutorial
// is a separate project with its own runtime. Keeping this list in sync is a
// known coordination cost; the placeholder set is short and stable enough
// that drift is detectable via the gate failures themselves.
// ---------------------------------------------------------------------------

/**
 * Return true if `value` looks like a placeholder/template (treat as absent).
 *
 * Recognized shapes (mirrors FIX-I7 + DRIFT-test3-001):
 *   1. empty / whitespace-only         → ""
 *   2. <angle-bracketed>                → <your-key-here>
 *   3. XXX (3+ X case-insensitive)      → xxx, XXXXX
 *   4. TODO / FIXME / CHANGEME          → TODO
 *   5. YOUR_*_HERE                      → YOUR_API_KEY_HERE
 *   6. ${VAR}    (curly shell-var)      → ${ANTHROPIC_KEY}
 *   7. ...       (literal ellipsis)     → ...
 *   8. "placeholder" literal            → placeholder
 *   9. $(...)    (command substitution) → $(openssl rand -base64 32)   ← NEW
 *
 * All patterns are anchored ^...$ for whole-string match so "TODO: real key"
 * does NOT false-positive.
 */
export function isPlaceholderEnvValue(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (trimmed === '') return true;
  return (
    /^<.*>$/.test(trimmed) ||
    /^x{3,}$/i.test(trimmed) ||
    /^(?:TODO|FIXME|CHANGEME)$/i.test(trimmed) ||
    /^YOUR_[A-Z_]*_HERE$/i.test(trimmed) ||
    /^\$\{[A-Z_][A-Z0-9_]*\}$/i.test(trimmed) ||
    /^\.\.\.$/.test(trimmed) ||
    /^placeholder$/i.test(trimmed) ||
    /^\$\([^)]+\)$/.test(trimmed) // DRIFT-test3-001: closes quinn CRIT-1
  );
}

// Zod refinement: reject a value if it matches any placeholder shape.
// Error message is short + actionable (operator-facing).
const notPlaceholder = (label: string) =>
  z.string().refine((v) => !isPlaceholderEnvValue(v), {
    message: `${label} is a placeholder; replace with a real value (see .env.example for shape requirements)`,
  });

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

// Required at boot (Phase 0 gate enforces; this schema mirrors the gate).
const requiredAlways = z.object({
  OPENAI_API_KEY: notPlaceholder('OPENAI_API_KEY').pipe(z.string().min(20)),
  // min(32) intentionally matches src/lib/session.ts:55 (mio CRITICAL-2,
  // test3 Phase 3): a 16-31 char secret previously passed boot but threw
  // on every request via session.ts threshold — silent dev-mode crash.
  // Single-source-of-truth at 32. openssl rand -base64 32 = 44 chars (b64
  // overhead), well above; no user-facing change required.
  SESSION_SECRET: notPlaceholder('SESSION_SECRET').pipe(z.string().min(32)),
});

// Required only when the first s3:// ingest is attempted (lazy).
const requiredForS3 = z.object({
  AWS_ACCESS_KEY_ID: notPlaceholder('AWS_ACCESS_KEY_ID').pipe(z.string().min(8)),
  AWS_SECRET_ACCESS_KEY: notPlaceholder('AWS_SECRET_ACCESS_KEY').pipe(z.string().min(8)),
  AWS_REGION: z.string().default('us-east-1'),
});

// Optional with defaults (always parsed at boot, never throws — pure defaults
// path is the "define errors out of existence" pattern per error-handling KB).
const optional = z.object({
  OPENAI_MODEL: z.string().default('gpt-4o-mini'),
  DB_PATH: z.string().default('./data/tutorials.db'),
  DATABASE_URL: z.string().default('file:./data/tutorials.db'),
  COST_CAP_USD: z.coerce.number().positive().default(1.0),
});

// ---------------------------------------------------------------------------
// Parsing — explicit field whitelist (NEVER spread process.env into errors)
// ---------------------------------------------------------------------------
//
// CRITICAL: do NOT pass `process.env` directly to zod's parse() if the schema
// would echo unknown keys in the error path. We construct a narrowed input
// object so zod errors cannot accidentally leak other env vars (e.g.,
// AWS_SESSION_TOKEN, GITHUB_TOKEN, etc.) into stderr or logs.
//
// Reference: kb:architecture/discipline/error-handling-discipline §"Forgetting
// to log" + the inverse — logging too MUCH at the outer-layer catch can leak
// secrets. Whitelist explicitly.

function pickEnv<T extends readonly string[]>(keys: T): Record<T[number], string | undefined> {
  const out = {} as Record<T[number], string | undefined>;
  for (const k of keys) {
    out[k as T[number]] = process.env[k];
  }
  return out;
}

const BOOT_KEYS = [
  'OPENAI_API_KEY',
  'SESSION_SECRET',
  'OPENAI_MODEL',
  'DB_PATH',
  'DATABASE_URL',
  'COST_CAP_USD',
] as const;

const S3_KEYS = ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_REGION'] as const;

// Parse + merge. zod throws ZodError on failure; we re-throw with a
// sanitized message that does NOT include the failing value (only the field
// name). The outer layer (Next.js boot, scripts/dev-setup.sh) catches.
function parseBootEnv() {
  const input = pickEnv(BOOT_KEYS);
  const merged = requiredAlways.merge(optional);
  const result = merged.safeParse(input);
  if (!result.success) {
    const fieldErrors = result.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    // Note: we deliberately do NOT include the offending value in the error
    // string. The field-name + message is enough for the operator to act on,
    // and avoiding the value prevents secret-leak via stderr / log scrapers.
    throw new Error(`Environment validation failed:\n${fieldErrors}`);
  }
  return result.data;
}

export const env = parseBootEnv();

/**
 * Lazy S3 env loader — only call from the s3-fetch boundary.
 *
 * Throws if AWS creds are missing / placeholders. Caller (the s3:// fetch
 * orchestrator) is the outermost meaningful layer for AWS-cred errors and
 * decides whether to surface "credentials not configured" to the user or
 * fall back to a presigned-URL flow.
 */
export function s3Env() {
  const input = pickEnv(S3_KEYS);
  const result = requiredForS3.safeParse(input);
  if (!result.success) {
    const fieldErrors = result.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`S3 environment validation failed:\n${fieldErrors}`);
  }
  return result.data;
}

// Type exports (for downstream consumers — db, s3, openai client, etc.)
export type BootEnv = z.infer<typeof requiredAlways> & z.infer<typeof optional>;
export type S3Env = z.infer<typeof requiredForS3>;
