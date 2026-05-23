#!/usr/bin/env bash
# scripts/dev-setup.sh — TB_to_Tutorial_converter post-clone bootstrap
#
# Idempotent setup script that prepares a fresh checkout for development.
# Safe to re-run; existing .env / generated secrets are preserved.
#
# Usage:
#   bash scripts/dev-setup.sh
#
# Order matters:
#   1. Install deps (pnpm) — must precede anything that runs scripts via tsx.
#   2. Copy .env.example → .env IF .env missing (preserves operator edits).
#   3. Generate SESSION_SECRET via openssl IF still a placeholder (FIX-I7 +
#      DRIFT-test3-001 shapes both trigger this).
#   4. Run Phase 0 gate to confirm OPENAI_API_KEY is real (user must edit).
#   5. Run DB migration (idempotent — Drizzle handles `if not exists`).
#
# Idempotency anchors (per kb:architecture/crosscut/idempotency):
#   - `pnpm install`              — pnpm's lockfile + content-addressable store
#   - `cp` guarded by `[ -f ]`    — only copies on first run
#   - `sed -i.bak` then `rm .bak` — atomic; rerun produces no diff if already set
#   - `db:migrate`                — Drizzle migrations track applied state

set -euo pipefail

APP_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

log() { printf '[setup] %s\n' "$*"; }
err() { printf '[setup] ERROR: %s\n' "$*" >&2; }

log "App root: $APP_ROOT"
cd "$APP_ROOT"

# -----------------------------------------------------------------------------
# 1. Install deps
# -----------------------------------------------------------------------------
log "Installing deps via pnpm..."
if ! command -v pnpm >/dev/null 2>&1; then
  err "pnpm not found on PATH. Install via: corepack enable && corepack prepare pnpm@9.0.0 --activate"
  exit 2
fi
pnpm install --frozen-lockfile 2>/dev/null || pnpm install

# -----------------------------------------------------------------------------
# 2. .env bootstrap (idempotent: only copy if missing)
# -----------------------------------------------------------------------------
if [ ! -f "$APP_ROOT/.env" ]; then
  log "Copying .env.example → .env (first-time setup)"
  cp "$APP_ROOT/.env.example" "$APP_ROOT/.env"
else
  log ".env already exists; skipping copy (operator-edited values preserved)"
fi

# -----------------------------------------------------------------------------
# 3. Generate SESSION_SECRET if still a placeholder
# -----------------------------------------------------------------------------
# We grep for both angle-bracketed AND command-substitution-literal shapes per
# DRIFT-test3-001. If either matches at start-of-value, regenerate.
SESSION_LINE="$(grep -E '^SESSION_SECRET=' "$APP_ROOT/.env" || true)"
if [ -z "$SESSION_LINE" ]; then
  err "SESSION_SECRET line missing from .env — re-copy .env.example to recover"
  exit 3
fi

# Match patterns the env validator will reject:
#   SESSION_SECRET=<...>
#   SESSION_SECRET='$(...)' or "$(...)" with literal $(  (unevaluated)
#   SESSION_SECRET=YOUR_*_HERE / TODO / CHANGEME / placeholder / ${...}
NEEDS_REGEN=0
if echo "$SESSION_LINE" | grep -qE "^SESSION_SECRET=['\"]?<.*>['\"]?$"; then NEEDS_REGEN=1; fi
if echo "$SESSION_LINE" | grep -qE "^SESSION_SECRET=['\"]?\\\$\([^)]+\)['\"]?$"; then NEEDS_REGEN=1; fi
if echo "$SESSION_LINE" | grep -qiE "^SESSION_SECRET=['\"]?(TODO|FIXME|CHANGEME|placeholder|YOUR_[A-Z_]*_HERE)['\"]?$"; then NEEDS_REGEN=1; fi

if [ "$NEEDS_REGEN" -eq 1 ]; then
  if ! command -v openssl >/dev/null 2>&1; then
    err "openssl not found; cannot regenerate SESSION_SECRET. Install openssl or set manually."
    exit 4
  fi
  SECRET=$(openssl rand -base64 32)
  # macOS sed needs -i.bak; Linux GNU sed accepts -i.bak too. Portable.
  # Use a delimiter (|) that won't appear in base64 output.
  sed -i.bak "s|^SESSION_SECRET=.*|SESSION_SECRET=\"$SECRET\"|" "$APP_ROOT/.env"
  rm -f "$APP_ROOT/.env.bak"
  log "Generated SESSION_SECRET (32-byte base64)"
else
  log "SESSION_SECRET already non-placeholder; preserving"
fi

# -----------------------------------------------------------------------------
# 4. Phase 0 gate (OPENAI_API_KEY still operator's job to fill)
# -----------------------------------------------------------------------------
log "Running Phase 0 gate (validates OPENAI_API_KEY + SESSION_SECRET)..."
if bash "$APP_ROOT/scripts/phase0-gate.sh"; then
  log "Phase 0 gate PASSED"
else
  err "Phase 0 gate FAILED — edit .env (OPENAI_API_KEY is likely still a placeholder), then re-run this script"
  exit 5
fi

# -----------------------------------------------------------------------------
# 5. DB migration (idempotent via Drizzle migration table)
# -----------------------------------------------------------------------------
log "Running DB migration..."
mkdir -p "$APP_ROOT/data"
pnpm --dir "$APP_ROOT" db:migrate

log "Setup complete. Next steps:"
log "  pnpm dev          # start Next.js"
log "  pnpm test         # run vitest"
log "  pnpm test:phase0  # rerun gate"
