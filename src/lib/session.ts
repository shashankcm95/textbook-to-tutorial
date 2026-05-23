/**
 * Session + CSRF primitives — Edge-runtime compatible.
 *
 * Why Web Crypto (not Node's `crypto` module): `src/middleware.ts` runs on
 * the Edge runtime by default in Next.js 14. The Node `crypto` module is
 * NOT available there. Web Crypto's `crypto.subtle.sign` + `getRandomValues`
 * IS — so we use them everywhere here. The same code works in Node 22+
 * (Web Crypto is the global default since Node 19).
 *
 * What we sign:
 *   payload = `${userId}.${expiresAtMs}`
 *   token   = `${payload}.${b64url(HMAC-SHA256(secret, payload))}`
 *
 * Invariants:
 *   - secret MUST be >= 32 bytes (FIX-I7: openssl rand -base64 32 is the
 *     canonical generator; we validate at call-site here, not at startup,
 *     because env validation is jules's `src/lib/env.ts` job)
 *   - Tokens are NOT encrypted, only authenticated. Do NOT put PII in userId.
 *     For this MVP, userId is a UUID generated at first-visit; no PII.
 *   - Constant-time compare for the HMAC to defeat timing oracles.
 *
 * No DB import here — keeps the file edge-runtime safe (better-sqlite3 is
 * Node-only) and avoids cyclic imports with the API layer. The userId is
 * an opaque string; the API resolves it to a row on demand.
 */

const HMAC_ALGO = { name: 'HMAC', hash: 'SHA-256' } as const;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export interface SessionPayload {
  userId: string;
  expiresAt: number;
}

/* ---------- base64url helpers (no padding) ---------- */

function bytesToBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (const byte of bytes) bin += String.fromCharCode(byte);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlToBytes(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + pad;
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/* ---------- HMAC core ---------- */

async function importKey(secret: string): Promise<CryptoKey> {
  if (secret.length < 32) {
    throw new Error('session secret must be >= 32 chars');
  }
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    HMAC_ALGO,
    false,
    ['sign', 'verify'],
  );
}

async function hmacB64Url(key: CryptoKey, message: string): Promise<string> {
  const sig = await crypto.subtle.sign(HMAC_ALGO, key, new TextEncoder().encode(message));
  return bytesToBase64Url(new Uint8Array(sig));
}

/**
 * Constant-time comparison — defeats timing oracles in HMAC verification.
 * Returns false fast on length mismatch (length is not secret).
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/* ---------- public API ---------- */

/**
 * Sign a session payload. Returns `${userId}.${expiresAt}.${sigB64Url}`.
 * The full token goes into the `session` cookie (HttpOnly, Secure in prod).
 */
export async function signSession(userId: string, secret: string): Promise<string> {
  const expiresAt = Date.now() + SESSION_TTL_MS;
  const payload = `${userId}.${expiresAt}`;
  const key = await importKey(secret);
  const sig = await hmacB64Url(key, payload);
  return `${payload}.${sig}`;
}

/**
 * Verify a session token. Returns the payload on success, null on any failure
 * (bad shape, bad signature, expired). The caller treats null as "issue a new
 * anonymous session" — never as "log the user out" since there's no login.
 *
 * Per kb:architecture/discipline/error-handling-discipline: this function
 * does NOT throw on a malformed token — that would be an exception leaking
 * to middleware-level catch handlers for what is normal-flow (cookie tampered,
 * expired, first-visit). The null return models "absent or invalid" cleanly.
 */
export async function verifySession(
  token: string,
  secret: string,
): Promise<SessionPayload | null> {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [userId, expiresAtStr, sig] = parts as [string, string, string];
  const expiresAt = Number(expiresAtStr);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return null;

  const payload = `${userId}.${expiresAtStr}`;
  const key = await importKey(secret);
  const expectedSig = await hmacB64Url(key, payload);
  if (!timingSafeEqual(sig, expectedSig)) return null;
  return { userId, expiresAt };
}

/**
 * Generate a fresh anonymous userId (UUID v4 via Web Crypto).
 * No PII; safe to log alongside requestId for tracing.
 */
export function newAnonymousUserId(): string {
  return crypto.randomUUID();
}

/**
 * Generate a CSRF token — 32 random bytes, base64url-encoded.
 * The token goes into BOTH the `__csrf` cookie (SameSite=Strict) AND is
 * mirrored back by the client in the `X-CSRF-Token` header on POST/PUT/DELETE.
 * Middleware compares the two; mismatch → 403.
 *
 * This is the "double-submit cookie" CSRF pattern. It's the right fit for
 * the bare-API-route case ari MEDIUM-3 flagged: server-actions get framework
 * protection for free, but our API routes (used by client fetch + the
 * eventual streaming endpoint) must opt in.
 */
export function generateCsrfToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return bytesToBase64Url(bytes);
}

export const SESSION_COOKIE_NAME = 'session';
export const CSRF_COOKIE_NAME = '__csrf';
export const CSRF_HEADER_NAME = 'x-csrf-token';
export const SESSION_TTL_SECONDS = SESSION_TTL_MS / 1000;
