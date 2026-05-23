import { NextResponse, type NextRequest } from 'next/server';
import {
  signSession,
  verifySession,
  newAnonymousUserId,
  generateCsrfToken,
  SESSION_COOKIE_NAME,
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  SESSION_TTL_SECONDS,
} from '@/lib/session';

/**
 * Edge-runtime middleware. Two responsibilities:
 *
 *   1. Issue / refresh the anonymous session cookie on every request.
 *      First visit: mint a UUID, sign it, set cookie. Subsequent visits:
 *      verify; if valid, leave alone; if invalid/expired, mint a new one.
 *
 *   2. Enforce CSRF on state-changing methods (POST/PUT/PATCH/DELETE).
 *      Double-submit pattern: `__csrf` cookie value MUST match the
 *      `X-CSRF-Token` request header. Mismatch / absence → 403.
 *
 * Why both `session` and `__csrf` cookies use SameSite=Strict:
 *   - We have zero cross-origin flows in MVP (no third-party embeds, no OAuth
 *     redirects). Strict gives us the strongest baseline against CSRF
 *     transmission.
 *   - If/when we add OAuth or social-share embeds, the `session` cookie may
 *     need to relax to Lax; `__csrf` should stay Strict (token-bearing).
 *
 * Excluded paths:
 *   - /api/health (liveness probe; no state-change, no session needed)
 *   - Next.js internals (/_next, favicon, static assets) — matcher below
 *
 * Per ari MEDIUM-3 (CSRF token surface): server actions get framework-level
 * CSRF protection by Next.js itself; bare API routes do NOT. Both routes
 * eventually exist in this app (form-action for ingest start, fetch-API for
 * streaming chapter delivery), so the middleware enforces the floor.
 *
 * Per kb:backend-dev/node-runtime-basics on async correctness: every async
 * boundary in this handler is a potential reordering point. We await
 * verifySession serially before constructing the response so the cookie set
 * happens deterministically; no parallel races on the response object.
 */

const CSRF_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const CSRF_EXCLUDED_PATHS = new Set(['/api/health']);

export async function middleware(req: NextRequest): Promise<NextResponse> {
  const { pathname } = req.nextUrl;
  const secret = process.env.SESSION_SECRET ?? '';
  const isProd = process.env.NODE_ENV === 'production';

  // SESSION_SECRET absence is an environment-config bug, not a runtime
  // recovery situation. Fail loudly so jules's env validator catches it at
  // startup; here we just refuse to issue tokens we can't sign.
  if (!secret) {
    return new NextResponse('Server misconfigured: SESSION_SECRET missing', {
      status: 500,
    });
  }

  /* ---------- 1. Session cookie handling ---------- */

  const sessionCookie = req.cookies.get(SESSION_COOKIE_NAME)?.value;
  let userId: string | null = null;

  if (sessionCookie) {
    const payload = await verifySession(sessionCookie, secret);
    if (payload) userId = payload.userId;
  }

  const isFreshSession = userId === null;
  if (isFreshSession) userId = newAnonymousUserId();

  /* ---------- 2. CSRF enforcement ---------- */

  const needsCsrfCheck =
    CSRF_METHODS.has(req.method) && !CSRF_EXCLUDED_PATHS.has(pathname);

  if (needsCsrfCheck) {
    const cookieToken = req.cookies.get(CSRF_COOKIE_NAME)?.value ?? '';
    const headerToken = req.headers.get(CSRF_HEADER_NAME) ?? '';
    const csrfOk =
      cookieToken.length > 0 &&
      headerToken.length > 0 &&
      cookieToken === headerToken;
    if (!csrfOk) {
      return new NextResponse('CSRF token missing or mismatched', {
        status: 403,
      });
    }
  }

  /* ---------- 3. Build response + set cookies ---------- */

  const res = NextResponse.next();

  // Always (re)issue the session cookie. For valid existing sessions this
  // is a no-op refresh of expiry; for fresh sessions it sets the new token.
  // We do NOT skip-on-valid because cookie expiry would slowly creep toward
  // zero with no refresh path otherwise.
  const sessionToken = await signSession(userId!, secret);
  res.cookies.set({
    name: SESSION_COOKIE_NAME,
    value: sessionToken,
    httpOnly: true,
    secure: isProd,
    sameSite: 'strict',
    path: '/',
    maxAge: SESSION_TTL_SECONDS,
  });

  // Issue a CSRF token on the FIRST request only (when no cookie present).
  // Subsequent rotation is on a per-session basis, not per-request, so the
  // client can cache it (e.g., in <meta name="csrf-token">). Rotating per
  // request would race with concurrent fetches mid-flight.
  if (!req.cookies.get(CSRF_COOKIE_NAME)) {
    const csrfToken = generateCsrfToken();
    res.cookies.set({
      name: CSRF_COOKIE_NAME,
      value: csrfToken,
      // NOT httpOnly — client JS must read this to populate the X-CSRF-Token
      // header. Double-submit relies on client readability; this is the
      // canonical shape (vs. an httpOnly token that's never readable).
      httpOnly: false,
      secure: isProd,
      sameSite: 'strict',
      path: '/',
      maxAge: SESSION_TTL_SECONDS,
    });
  }

  return res;
}

/**
 * Run middleware on all routes EXCEPT Next.js internals + static assets.
 * The matcher is regex-shaped (negative lookahead). `/api/health` is NOT
 * excluded here — we want the session cookie issued even on the probe path —
 * but the CSRF check above skips it explicitly.
 */
export const config = {
  matcher: [
    /*
     * Skip:
     *  - /_next/static  (build assets)
     *  - /_next/image   (image optimizer)
     *  - /favicon.ico, /robots.txt, /sitemap.xml
     *  - File requests with an extension (e.g. .png, .svg)
     */
    '/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml|.*\\..*).*)',
  ],
};
