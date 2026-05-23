# test3 Phase 5 — Resume Notes (post-fork)

**Created**: 2026-05-23 by the wedged session before kill.
**Fork UUID**: `1c047218-d9c4-4c0e-a4e5-14e6402c4dce`
**Parent UUID** (wedged, do not resume): `75cc079e-acd4-43be-b5a0-099f7bb016f1`
**Fork point**: end of the "done?" assistant turn (Phase 5 setup just completed).

## What the fork has

- Phases 0–4 complete; all challenger absorbs landed (mio CRIT-1+2, vlad CRIT-1+2, nova CRIT-1+2, blair HIGH-1+4).
- Dev server brought up successfully. /api/health → 200. Home page + paste-URL form created.
- TaskUpdate state: `#90 in_progress` (Phase 5 — live UAT with real S3 PDF).
- DEVIATION ratio 0.50 / 0.75 depending on how you count Phase 4 reviewers.

## What the fork is MISSING (discovered AFTER fork-point in the wedged tail)

Five real bugs surfaced during curl-driven UAT iteration that need fixing before Phase 5 can complete end-to-end:

| # | File:line | Bug | Fix sketch |
|---|---|---|---|
| **FINDING-UI-1** | `src/app/HomeIngestForm.tsx:62` | Form reads `data.tutorialId` but `POST /api/ingest` returns `{id, status}` | Change to `data.id` OR rename API response to `tutorialId` (prefer renaming API for clarity) |
| **FINDING-API-1** | `src/app/api/tutorials/[id]/route.ts:92` | GET returns 500 (downstream of API-2 below) | Same root-cause as API-2 |
| **FINDING-API-2** | `src/app/api/tutorials/[id]/route.ts:92` | `RangeError: Invalid time value` — `row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt` throws because `row.createdAt` is `new Date(NaN)` from Drizzle parsing TEXT as integer-mode-timestamp | Fix downstream of SCHEMA-1; also guard: `Number.isFinite(d.getTime()) ? d.toISOString() : null` |
| **FINDING-PDF-1** | `src/lib/pdf/parse.ts:37` | `Setting up fake worker failed: Cannot find module '.../pdf.worker.mjs'` — pdfjs-dist 4.x worker file not bundled by Next.js webpack | Either (a) disable worker for Node-side parse: `import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs'; pdfjsLib.GlobalWorkerOptions.workerSrc = ''; getDocument({data, disableWorker: true})`, OR (b) pin to pdfjs-dist@3.x with simpler worker-less import |
| **FINDING-SCHEMA-1** | `src/db/schema.ts:50,53,93,147,150,237,238,278` (8 timestamp columns) vs `drizzle/migrations/0000_initial.sql` | Drizzle schema declares `integer('created_at', { mode: 'timestamp' })` (Unix seconds INT) but hand-written migration uses `integer DEFAULT (CURRENT_TIMESTAMP)` which writes ISO TEXT to an INTEGER column → Drizzle reads back as `Date(NaN)` | Change migration's defaults to `(unixepoch())` instead of `(CURRENT_TIMESTAMP)`. Drop + recreate DB (data/tutorials.db) since prior rows have bad TEXT values. |

## Cleanup state after fork

- `data/tutorials.db` has 1 tutorial row with `status='error'` (the failed DDIA ingest from the wedged session). Safe to delete + re-migrate.
- `.env` SESSION_SECRET was regenerated to 43 chars (was 26). Backup at `.env.bak-<ts>`.
- `next.config.ts` was converted to `next.config.mjs` (Next 14.2.5 doesn't support TS config).
- New files created: `src/app/page.tsx`, `src/app/HomeIngestForm.tsx`, `vitest.config.ts`.

## Substrate signals logged (for v2.9.1 substrate work, not Phase 5)

- DRIFT-test3-013: Next.js < 15 doesn't support `next.config.ts`
- DRIFT-test3-014: Phase 2-3 scaffolding shipped tutorial detail pages but no `src/app/page.tsx`
- DRIFT-test3-PREVIEW-1: Claude Preview MCP cwd-sandboxed; can't preview app in sibling directory
- DRIFT-test3-PREVIEW-2: dueling Claude CLI processes resuming same session id = API-retry storm + JSONL corruption → desktop app crash

## Recommended Phase 5 entry move

1. `cd ~/Documents/TB_to_Tutorial_converter`
2. Read this file (you're already doing that)
3. Fix SCHEMA-1 first (root cause for API-1+2): edit migration defaults, drop+re-migrate db, re-run curl ingest
4. Fix PDF-1: pdfjs worker config
5. Re-run UAT via curl (NOT chrome — same Preview cwd-sandbox limitation):
   ```bash
   COOKIE_JAR=/tmp/tb-uat-cookies.txt; rm -f $COOKIE_JAR
   curl -fsS -c $COOKIE_JAR -b $COOKIE_JAR -o /dev/null http://localhost:3000/
   CSRF=$(awk '/__csrf/ {print $7}' $COOKIE_JAR | tail -1)
   curl -sS -c $COOKIE_JAR -b $COOKIE_JAR -H "Content-Type: application/json" -H "X-CSRF-Token: $CSRF" \
     -X POST -d '{"s3Url":"s3://textbooks-561764227438-us-east-1-an/Designing Data Intensive Applications - Martin Kleppmann.pdf"}' \
     http://localhost:3000/api/ingest
   # then poll /api/tutorials/<id> every 5s until status='ready-to-generate'
   # then curl --no-buffer /api/tutorials/<id>/stream to consume SSE
   ```
6. After UAT passes, fix UI-1 (cosmetic, low priority)
