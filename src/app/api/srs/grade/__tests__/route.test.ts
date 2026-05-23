/**
 * POST /api/srs/grade — ownership-chain enforcement tests.
 *
 * LOAD-BEARING ABSORB: mio CRITICAL-1 (Phase 3 security audit).
 *
 *   "Verify that a request with a flashcardId belonging to a DIFFERENT user's
 *    tutorial returns 404 and does NOT create or modify any srs_reviews row."
 *
 * This is the contract test for the IDOR boundary. The test:
 *
 *   1. Creates two users (A and B) and the full join chain for each:
 *      User A → Tutorial A → Chapter A → Flashcard A
 *      User B → Tutorial B → Chapter B → Flashcard B
 *
 *   2. Calls POST /api/srs/grade as User A with Flashcard B's id.
 *
 *   3. Asserts the response is 404 (NOT 403 — never leak existence of
 *      foreign IDs).
 *
 *   4. Asserts NO srs_reviews row was written for either flashcard. The
 *      ownership-chain JOIN rejection must short-circuit BEFORE the
 *      onConflictDoUpdate; if it didn't, an attacker could harvest the
 *      foreign flashcardId by triggering the write and observing the
 *      composite-PK collision behavior.
 *
 *   5. Sanity: calls POST again as User A with FLASHCARD A's id and asserts
 *      200 + a srs_reviews row IS written. This proves the test setup is
 *      live (not silently broken in a way that would let the negative case
 *      pass trivially).
 *
 * The test uses an in-memory SQLite DB (created via openDatabase) and drives
 * the route handler directly (importing POST + calling it with a hand-built
 * NextRequest). No HTTP server bound; vitest runs in pure Node mode.
 *
 * KB anchors:
 *   - kb:security-dev/auth-patterns §"IDOR (Insecure Direct Object Reference)
 *     — the threat model this test validates.
 *   - kb:engineering:testing-strategy §"Contract tests at the auth boundary" —
 *     these are the load-bearing tests; they pay for themselves the first
 *     time a refactor silently weakens the join.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ─────────────────────────────────────────────────────────────────────────────
// Test setup: temp DB path + module mocking.
//
// The route imports `db` from `@/db/client`, which is a process-singleton
// keyed off DB_PATH. We:
//   1. Set DB_PATH to a fresh temp file BEFORE importing the route.
//   2. Stub @/lib/session to bypass HMAC verification (deterministic userId).
//
// The temp-DB approach gives us a real SQLite instance with real foreign-key
// behavior — the JOIN actually runs against a real engine, so the test
// validates the production query path end-to-end.
// ─────────────────────────────────────────────────────────────────────────────

let tempDbDir: string;
let tempDbPath: string;

const SESSION_USER_A = '11111111-1111-1111-1111-111111111111';
const SESSION_USER_B = '22222222-2222-2222-2222-222222222222';

// Mutable holder so each test can switch which "user" is making the request.
const currentSession = { userId: SESSION_USER_A };

vi.mock('@/lib/session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/session')>();
  return {
    ...actual,
    // Stub: verifySession always returns currentSession.userId, ignoring the
    // cookie value entirely. This lets us drive the test without needing to
    // actually sign valid HMAC tokens.
    verifySession: vi.fn(async () => ({
      userId: currentSession.userId,
      expiresAt: Date.now() + 60_000,
    })),
  };
});

// Required env vars — set BEFORE any module that reads them is imported.
beforeEach(() => {
  tempDbDir = mkdtempSync(join(tmpdir(), 'ttt-srs-test-'));
  tempDbPath = join(tempDbDir, 'test.db');
  process.env.DB_PATH = tempDbPath;
  // env.ts requires SESSION_SECRET >= 32 chars and OPENAI_API_KEY >= 20 chars.
  // These are test-only placeholders — never used because we mock verifySession
  // and never call OpenAI.
  process.env.SESSION_SECRET = 'x'.repeat(48);
  process.env.OPENAI_API_KEY = 'sk-test-' + 'a'.repeat(40);
  currentSession.userId = SESSION_USER_A;
  // Reset module cache so the db singleton picks up the new DB_PATH.
  vi.resetModules();
});

afterEach(() => {
  try {
    rmSync(tempDbDir, { recursive: true, force: true });
  } catch {
    // ignore cleanup errors — temp dir cleanup is best-effort
  }
  delete process.env.DB_PATH;
});

/**
 * Build the schema in the temp DB (we don't run drizzle-kit migrations here;
 * the migration SQL is the source of truth in prod but for tests we run a
 * minimal CREATE TABLE pass that mirrors the schema's runtime contract).
 *
 * Per kb:engineering:testing-strategy — using a real DB beats mocking because
 * the JOIN behavior IS the test target. A mocked-DB version would never
 * catch a regression where the JOIN was silently removed.
 */
async function setupSchema(): Promise<void> {
  const { rawDb } = await import('@/db/client');
  // Minimal schema — only the tables the SRS-grade JOIN touches.
  rawDb.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      session_cookie_hash TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
      last_seen_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
    );
    CREATE TABLE tutorials (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      source_s3_url TEXT NOT NULL,
      source_pdf_sha256 TEXT,
      status TEXT NOT NULL,
      error_message TEXT,
      total_pages INTEGER,
      total_chapters INTEGER,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
    );
    CREATE TABLE chapters (
      id TEXT PRIMARY KEY,
      tutorial_id TEXT NOT NULL REFERENCES tutorials(id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL,
      title TEXT NOT NULL,
      narrative TEXT,
      source_page_start INTEGER NOT NULL,
      source_page_end INTEGER NOT NULL,
      source_paragraphs_json TEXT NOT NULL,
      status TEXT NOT NULL,
      is_read INTEGER NOT NULL DEFAULT 0,
      viewed_at INTEGER,
      scroll_depth_pct REAL,
      time_spent_seconds INTEGER NOT NULL DEFAULT 0,
      last_quiz_attempt_at INTEGER,
      last_quiz_score REAL
    );
    CREATE TABLE flashcards (
      id TEXT PRIMARY KEY,
      chapter_id TEXT NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
      front TEXT NOT NULL,
      back TEXT NOT NULL,
      source_paragraph_ref TEXT NOT NULL
    );
    CREATE TABLE srs_reviews (
      flashcard_id TEXT NOT NULL REFERENCES flashcards(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      box INTEGER NOT NULL DEFAULT 1,
      last_reviewed_at INTEGER,
      due_at INTEGER NOT NULL,
      consecutive_correct INTEGER NOT NULL DEFAULT 0,
      ease_factor REAL,
      interval_days REAL,
      PRIMARY KEY (flashcard_id, user_id)
    );
  `);
}

/**
 * Seed the cross-tenant fixture: two complete tutorial chains.
 *
 *   User A (SESSION_USER_A) owns:
 *     Tutorial A (ta-uuid)
 *       Chapter A (ca-uuid)
 *         Flashcard A (fa-uuid)
 *
 *   User B (SESSION_USER_B) owns:
 *     Tutorial B (tb-uuid)
 *       Chapter B (cb-uuid)
 *         Flashcard B (fb-uuid)
 */
const FIXTURE = {
  tutorialA: 'aaaaaaaa-1111-1111-1111-111111111111',
  chapterA: 'aaaaaaaa-2222-2222-2222-222222222222',
  flashcardA: 'aaaaaaaa-3333-3333-3333-333333333333',
  tutorialB: 'bbbbbbbb-1111-1111-1111-111111111111',
  chapterB: 'bbbbbbbb-2222-2222-2222-222222222222',
  flashcardB: 'bbbbbbbb-3333-3333-3333-333333333333',
};

async function seedFixture(): Promise<void> {
  const { rawDb } = await import('@/db/client');
  rawDb.exec(`
    INSERT INTO users (id, session_cookie_hash) VALUES
      ('${SESSION_USER_A}', 'hash-a'),
      ('${SESSION_USER_B}', 'hash-b');

    INSERT INTO tutorials (id, user_id, source_s3_url, status) VALUES
      ('${FIXTURE.tutorialA}', '${SESSION_USER_A}', 's3://test/a.pdf', 'complete'),
      ('${FIXTURE.tutorialB}', '${SESSION_USER_B}', 's3://test/b.pdf', 'complete');

    INSERT INTO chapters
      (id, tutorial_id, ordinal, title, source_page_start, source_page_end, source_paragraphs_json, status)
    VALUES
      ('${FIXTURE.chapterA}', '${FIXTURE.tutorialA}', 0, 'Chapter A', 1, 10, '[]', 'complete'),
      ('${FIXTURE.chapterB}', '${FIXTURE.tutorialB}', 0, 'Chapter B', 1, 10, '[]', 'complete');

    INSERT INTO flashcards (id, chapter_id, front, back, source_paragraph_ref) VALUES
      ('${FIXTURE.flashcardA}', '${FIXTURE.chapterA}', 'Q?', 'A.', 'page1:paragraph0'),
      ('${FIXTURE.flashcardB}', '${FIXTURE.chapterB}', 'Q?', 'B.', 'page1:paragraph0');
  `);
}

/** Build a minimal NextRequest for the POST handler under test. */
function buildRequest(body: unknown): import('next/server').NextRequest {
  // The route reads `req.cookies.get(SESSION_COOKIE_NAME)?.value` — the
  // mocked verifySession ignores the value but we need .get() to not throw.
  // We hand-construct a Request and cast to NextRequest (which extends Request);
  // the .cookies surface is added by Next.js but the route only calls .get().
  const headers = new Headers({
    'content-type': 'application/json',
    cookie: 'session=fake; __csrf=fake',
  });
  const req = new Request('http://localhost/api/srs/grade', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  // Augment with a minimal .cookies surface that the route expects.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (req as any).cookies = {
    get: (name: string) => ({
      value: name === 'session' ? 'fake-session-token' : 'fake-csrf-token',
    }),
  };
  return req as unknown as import('next/server').NextRequest;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/srs/grade — ownership-chain (mio CRITICAL-1)', () => {
  it('returns 404 when User A grades a Flashcard owned by User B', async () => {
    await setupSchema();
    await seedFixture();
    const { POST } = await import('../route');

    // Acting as User A, but pass User B's flashcard ID.
    currentSession.userId = SESSION_USER_A;
    const req = buildRequest({
      flashcardId: FIXTURE.flashcardB,
      recall: 'correct',
    });
    const res = await POST(req);

    // LOAD-BEARING ASSERTION: 404 (NOT 403). mio CRITICAL-1 explicitly says
    // never leak the existence of a foreign ID. 404 conflates "doesn't exist"
    // with "exists but not yours" — the only safe shape.
    expect(res.status).toBe(404);

    // NO srs_reviews row should have been created — the JOIN must
    // short-circuit BEFORE the onConflictDoUpdate.
    const { rawDb } = await import('@/db/client');
    const rows = rawDb
      .prepare('SELECT * FROM srs_reviews WHERE flashcard_id = ?')
      .all(FIXTURE.flashcardB);
    expect(rows).toHaveLength(0);
  });

  it('returns 404 when User A grades a non-existent flashcard ID', async () => {
    await setupSchema();
    await seedFixture();
    const { POST } = await import('../route');

    currentSession.userId = SESSION_USER_A;
    const req = buildRequest({
      flashcardId: '99999999-9999-9999-9999-999999999999',
      recall: 'correct',
    });
    const res = await POST(req);

    // Same 404 — "doesn't exist" and "exists but foreign" must be
    // indistinguishable to the client.
    expect(res.status).toBe(404);
  });

  it('positive control: User A grading their OWN flashcard succeeds (200 + write)', async () => {
    await setupSchema();
    await seedFixture();
    const { POST } = await import('../route');

    currentSession.userId = SESSION_USER_A;
    const req = buildRequest({
      flashcardId: FIXTURE.flashcardA,
      recall: 'correct',
    });
    const res = await POST(req);

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      newBox: number;
      nextDueAt: string;
      idempotentReplay: boolean;
    };
    // First grade of a fresh card: box goes 1 → 2 (got-it promotes).
    expect(body.newBox).toBe(2);
    expect(body.idempotentReplay).toBe(false);

    // srs_reviews row SHOULD exist now.
    const { rawDb } = await import('@/db/client');
    const rows = rawDb
      .prepare(
        'SELECT * FROM srs_reviews WHERE flashcard_id = ? AND user_id = ?',
      )
      .all(FIXTURE.flashcardA, SESSION_USER_A);
    expect(rows).toHaveLength(1);
  });

  it('returns 400 on invalid body (no flashcardId)', async () => {
    await setupSchema();
    await seedFixture();
    const { POST } = await import('../route');

    currentSession.userId = SESSION_USER_A;
    const req = buildRequest({ recall: 'correct' });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });
});

describe('POST /api/srs/grade — mio HIGH-1 idempotency window', () => {
  it('within 60s of a prior grade, returns idempotentReplay=true and does NOT advance box', async () => {
    await setupSchema();
    await seedFixture();
    const { POST } = await import('../route');

    currentSession.userId = SESSION_USER_A;
    // First grade — should advance box 1 → 2.
    const req1 = buildRequest({
      flashcardId: FIXTURE.flashcardA,
      recall: 'correct',
    });
    const res1 = await POST(req1);
    expect(res1.status).toBe(200);
    const body1 = (await res1.json()) as { newBox: number };
    expect(body1.newBox).toBe(2);

    // Second grade IMMEDIATELY — should be idempotent (within 60s window).
    const req2 = buildRequest({
      flashcardId: FIXTURE.flashcardA,
      recall: 'correct',
    });
    const res2 = await POST(req2);
    expect(res2.status).toBe(200);
    const body2 = (await res2.json()) as {
      newBox: number;
      idempotentReplay: boolean;
    };
    expect(body2.idempotentReplay).toBe(true);
    // Box must NOT have advanced — still box 2, not box 3.
    expect(body2.newBox).toBe(2);
  });
});
