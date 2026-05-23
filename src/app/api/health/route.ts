import { NextResponse } from 'next/server';

/**
 * GET /api/health — liveness probe.
 *
 * Returns a stable JSON shape that's safe for k8s/Cloudflare/etc. health
 * checks. Intentionally NO database call here: a liveness probe should
 * answer "is the process running?", not "is every dependency healthy?"
 * (that's a /readiness probe, future work). Conflating the two leads to
 * cascading restarts when transient DB blips knock liveness offline and
 * the orchestrator kills the pod that was about to recover.
 *
 * No CSRF / no session required. The middleware excludes this path from
 * the CSRF check (see `src/middleware.ts:CSRF_EXCLUDED_PATHS`).
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(): Promise<NextResponse> {
  return NextResponse.json({
    status: 'ok',
    version: process.env.npm_package_version ?? '0.1.0',
    timestamp: new Date().toISOString(),
  });
}
