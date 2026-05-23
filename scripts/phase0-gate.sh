#!/usr/bin/env bash
# phase0-gate.sh — TB_to_Tutorial_converter Phase 0 pre-flight
#
# Validates required env vars are real (not placeholders) before allowing
# Phase 1 (HETS design ceremony) to proceed. Per FIX-I4 + FIX-I7.
#
# Usage:
#   bash scripts/phase0-gate.sh
#
# Exit codes:
#   0 — all required vars are real values; Phase 1 cleared to start
#   1 — one or more required vars missing / placeholder; Phase 1 blocked
#
# Sources `.env` from the app root if present (mimics what the Next.js app
# does at startup via dotenv). Then invokes `agent-team doctor` with the
# required-vars list + --strict.

set -euo pipefail

APP_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TOOLKIT_DOCTOR="${HOME}/Documents/claude-toolkit/scripts/agent-team/doctor.js"

# Required env vars for Phase 1+
REQUIRED_VARS="OPENAI_API_KEY,SESSION_SECRET"

# Load .env if present (mirror Next.js dotenv behavior).
if [ -f "${APP_ROOT}/.env" ]; then
  echo "[phase0] Loading ${APP_ROOT}/.env"
  set -a
  # shellcheck disable=SC1090
  source "${APP_ROOT}/.env"
  set +a
else
  echo "[phase0] No .env file present at ${APP_ROOT}/.env"
  echo "[phase0] If env vars are set in your shell rc, that's fine; otherwise:"
  echo "[phase0]   cp .env.example .env"
  echo "[phase0]   # edit .env with real values"
fi

if [ ! -f "${TOOLKIT_DOCTOR}" ]; then
  echo "[phase0] ERROR: agent-team doctor not found at ${TOOLKIT_DOCTOR}" >&2
  echo "[phase0]   Ensure claude-toolkit is installed at ~/Documents/claude-toolkit" >&2
  exit 2
fi

echo "[phase0] Running agent-team doctor --probe env-inheritance --strict"
echo "[phase0]   Required vars: ${REQUIRED_VARS}"
echo ""

# `set -e` would abort here on non-zero exit; use an if-block to capture
# the exit code so we can print a friendly final summary.
if node "${TOOLKIT_DOCTOR}" --probe env-inheritance --vars "${REQUIRED_VARS}" --strict --json; then
  DOCTOR_EXIT=0
else
  DOCTOR_EXIT=$?
fi

echo ""
if [ "${DOCTOR_EXIT}" -eq 0 ]; then
  echo "[phase0] ✓ GATE PASS — Phase 1 (HETS design) cleared to start"
else
  echo "[phase0] ✗ GATE FAIL — Phase 1 blocked until env vars are filled with real values"
  echo "[phase0]   Action: cp .env.example .env  &&  edit .env  &&  rerun this script"
  exit 1
fi
