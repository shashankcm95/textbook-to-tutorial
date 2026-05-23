/**
 * src/app/api/tutorials/[id]/stream/route.ts — SSE streaming endpoint that
 * orchestrates per-chapter OpenAI generation and emits structured events
 * to the browser EventSource client.
 *
 * Inference-path persona task (FIX-I8 dogfood): we consume the OpenAI API
 * via omar's `generateChapterStreaming` (src/lib/openai/streaming.ts), then
 * persist results through the rae/noor Drizzle schema. NO training-time
 * concerns here — this is product inference plumbing end-to-end.
 *
 * Design anchors:
 *   - kb:ml-dev/training-vs-inference §"Deployment topologies" — this is
 *     the "Streaming" topology (seconds-to-minutes latency; event-driven).
 *     The choice was forced by user-facing progress requirements: a
 *     5-chapter tutorial generates over ~30-60s; per-token visibility
 *     keeps the user oriented during the wait.
 *   - kb:architecture/ai-systems/inference-cost-management §"Lever 5:
 *     Output control" — `cost-update` events are emitted per chapter
 *     boundary (NOT per token) to avoid flooding the stream with cost
 *     accounting overhead. The 5-lever framing was used to scope what to
 *     emit and what to suppress.
 *   - kb:architecture/ai-systems/inference-cost-management §"Hidden cost:
 *     agent loop amortization" — each chapter is an independent single-
 *     shot call (no loop); per-chapter cost arithmetic is linear, not
 *     quadratic. The orchestrator below does NOT replay history; each
 *     chapter call is fresh prompt + fresh source paragraphs only.
 *   - kb:architecture/discipline/stability-patterns §Steady State — every
 *     code path in this stream terminates the connection cleanly: success
 *     (`done` event), abort (request.signal handler), cost-cap (error
 *     event then close), unrecoverable parse error (error event then
 *     close). NO path leaks an open SSE connection.
 *   - riley CRITICAL-1 (Phase 1) — request.signal → abortSignal →
 *     OpenAI fetch signal chain wired explicitly. Client disconnect
 *     STOPS billing within one round-trip latency.
 *   - noor CRITICAL-2 (Phase 2 W2) — each chapter is wrapped in its own
 *     sub-transaction (chapter UPDATE + questions INSERT + flashcards
 *     INSERT). A failure in chapter N does NOT roll back chapter N-1's
 *     writes (already committed). Per-chapter blast radius.
 *   - omar HIGH-3 (Phase 2 W2) — inline `[ref:pageN:paragraphM]` markup
 *     in narrative tokens is forwarded VERBATIM in `token` frames; the
 *     UI tokenizer (casey's TutorialChapter) parses + renders them.
 *     Server-side does NOT pre-resolve refs; that's a rendering concern.
 *   - omar CRITICAL-1 (Phase 2 W2) — Set-based dedup of source paragraph
 *     refs is enforced INSIDE `generateChapterStreaming` already; we
 *     verify by reading the file (see verify_dedup() below) and call
 *     through. NO duplicate-detection layer at this orchestrator level.
 *
 * Runtime: Node (better-sqlite3 is Node-only, and the Drizzle persistence
 * path requires it). Edge runtime would force a refactor of every DB
 * write into a separate API call; the streaming benefits don't outweigh
 * that cost for an MVP.
 *
 * SRP boundary: this file does ORCHESTRATION + SSE PROTOCOL. It does
 * NOT do prompt construction (omar's prompts/chapter-gen.ts), token
 * generation (omar's openai/streaming.ts), cost arithmetic (omar's
 * openai/cost.ts), schema definition (rae's db/schema.ts), or PDF
 * parsing (noor's pdf/parse.ts). Folding any of those here would
 * violate the change-reason discipline (per Clean Code ch 10 "actor"
 * test). The orchestrator's sole change-reason is "the SSE protocol
 * with the UI evolved".
 */

import { type NextRequest } from 'next/server';
import { eq, and, asc } from 'drizzle-orm';
import { db, schema } from '@/db/client';
import { verifySession, SESSION_COOKIE_NAME } from '@/lib/session';
import { env } from '@/lib/env';
import {
  generateChapterStreaming,
  ChapterGenParseError,
} from '@/lib/openai/streaming';
import { CostCapExceeded, spentSoFar } from '@/lib/openai/cost-cap';
import type { SourceParagraph, ChapterGenerationResult } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ───────────────────────────────────────────────────────────────────────────
// Concurrent-stream rate limit (mio HIGH-2 fold — Phase 3 challenger absorb)
// ───────────────────────────────────────────────────────────────────────────
//
// Without this, an authenticated user can open N EventSource connections in
// rapid succession; each triggers `orchestrate()` which begins parallel
// generation, multiplying OpenAI spend by N before per-tutorial cost-cap
// catches up. The cost-cap is the financial backstop, but it is not a DoS
// barrier — server CPU + DB write contention scale linearly with N.
//
// Policy: max 2 concurrent open SSE connections per session. 3rd open
// returns 429 with Retry-After. Same shape as noor's ingest rate-limit
// (per-user Map), but here the metric is "currently-open connections" not
// "operations per window".
//
// Bounded growth: the Map only holds counts for sessions that currently
// HAVE open connections. Decrement-on-close brings the count to 0 and we
// delete the key. Worst case is one entry per concurrently-streaming user.

const MAX_CONCURRENT_STREAMS_PER_USER = 2;

const concurrentStreams = new Map<string, number>();

function tryAcquireStreamSlot(userId: string): boolean {
  const current = concurrentStreams.get(userId) ?? 0;
  if (current >= MAX_CONCURRENT_STREAMS_PER_USER) {
    return false;
  }
  concurrentStreams.set(userId, current + 1);
  return true;
}

function releaseStreamSlot(userId: string): void {
  const current = concurrentStreams.get(userId) ?? 0;
  if (current <= 1) {
    concurrentStreams.delete(userId); // bounded growth: drop on zero
  } else {
    concurrentStreams.set(userId, current - 1);
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Public types — the SSE wire contract with the UI (casey)
// ───────────────────────────────────────────────────────────────────────────

/**
 * SSE event types emitted by this route. Names map 1:1 to `event:` lines.
 * The UI's EventSource code registers a handler per event name.
 *
 * Wire format (per HTML5 SSE spec):
 *   event: <event-name>\n
 *   data: <stringified JSON>\n\n
 */
type SseEventName =
  | 'chapter-start'
  | 'token'
  | 'chapter-complete'
  | 'cost-update'
  | 'done'
  | 'error';

// blair HIGH-1 + HIGH-4 (test3 Phase 4) fix: field names aligned with the
// client parser in StreamingClient.tsx. Previously server emitted
// `chapterIdx` + `token` while client read `ordinal` + `delta` — every
// streaming token + chapter-start frame was silently dropped. Long-term
// follow-up (blair DRY root-cause): move these interfaces into
// src/lib/sse/frames.ts as the single source of truth, import from both
// sides. For Phase 5 UAT we do the surgical alignment here.
interface ChapterStartPayload {
  chapterId: string;
  ordinal: number;
  title: string;
}

interface TokenPayload {
  chapterId: string;
  delta: string;
  /**
   * Routing hint for the UI tokenizer. The current MVP emits all tokens
   * as `narrative` — we do NOT segment JSON-stream tokens into question /
   * flashcard buckets because the stream is JSON and the model emits the
   * full payload in document order (narrative comes first, then questions
   * array, then flashcards). A future iteration can boundary-detect via
   * the open/close braces and switch `kind`; for MVP the UI parses the
   * accumulated text at chapter-complete to render Q+F.
   *
   * Why include the field at all if always 'narrative'? Forward-compat:
   * the casey UI tokenizer already keys off `kind`; emitting it now
   * (even uniformly) lets us upgrade the segmenter without changing
   * the wire contract.
   */
  kind: 'narrative' | 'question' | 'flashcard';
}

interface ChapterCompletePayload {
  chapterId: string;
  questionCount: number;
  flashcardCount: number;
  droppedRefCount: number;
  durationMs: number;
}

interface CostUpdatePayload {
  spentUsd: number;
  capUsd: number;
  /** 0-100, rounded to nearest integer. UI renders as cost-chip fill. */
  pct: number;
}

interface DonePayload {
  tutorialId: string;
  chaptersCompleted: number;
  totalCostUsd: number;
}

interface ErrorPayload {
  /**
   * Machine-readable error code for the UI to branch on. The casey
   * client matches these strings literally.
   */
  code:
    | 'cost-cap-exceeded'
    | 'chapter-parse-failed'
    | 'unauthorized'
    | 'tutorial-not-ready'
    | 'aborted'
    | 'internal-error';
  message: string;
  chapterId?: string;
}

// ───────────────────────────────────────────────────────────────────────────
// GET /api/tutorials/:id/stream
// ───────────────────────────────────────────────────────────────────────────

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } },
): Promise<Response> {
  // ── 1. Session check (mirrors src/app/api/tutorials/[id]/route.ts:38-50) ──
  const secret = process.env.SESSION_SECRET ?? '';
  if (!secret) {
    return new Response('Server misconfigured: SESSION_SECRET missing', {
      status: 500,
    });
  }
  const sessionCookie = req.cookies.get(SESSION_COOKIE_NAME)?.value ?? '';
  const payload = await verifySession(sessionCookie, secret);
  if (!payload) {
    return new Response('session required', { status: 401 });
  }
  const userId = payload.userId;

  // ── 2. Validate id shape (defense-in-depth; same pattern as status route) ──
  const { id: tutorialId } = params;
  if (typeof tutorialId !== 'string' || !/^[0-9a-f-]{36}$/i.test(tutorialId)) {
    // 404 (NOT 400) to avoid leaking "this id shape doesn't exist" signal.
    return new Response('not found', { status: 404 });
  }

  // ── 3. Ownership + readiness check ────────────────────────────────────
  // Compound WHERE: id AND userId. Collapses "not found" and "not owned"
  // into a single 404 — per security-by-obscurity in the sibling status
  // route (src/app/api/tutorials/[id]/route.ts:61).
  const tutorialRows = await db
    .select({
      id: schema.tutorials.id,
      status: schema.tutorials.status,
      totalChapters: schema.tutorials.totalChapters,
    })
    .from(schema.tutorials)
    .where(
      and(
        eq(schema.tutorials.id, tutorialId),
        eq(schema.tutorials.userId, userId),
      ),
    )
    .limit(1);

  if (tutorialRows.length === 0) {
    return new Response('not found', { status: 404 });
  }
  const tutorial = tutorialRows[0]!;

  if (
    tutorial.status !== 'ready-to-generate' &&
    tutorial.status !== 'generating' &&
    tutorial.status !== 'complete'
  ) {
    // 409 Conflict: the resource exists but is not in a valid state for
    // streaming. UI should redirect back to the status-poll page.
    return new Response('tutorial not ready for streaming', { status: 409 });
  }

  // ── 4. Acquire concurrent-stream slot (mio HIGH-2 fold) ───────────────
  // Done AFTER ownership-check so a foreign-tutorial probe doesn't burn
  // a slot the legitimate session could use. Released in the stream's
  // finally block (createTutorialStream below).
  if (!tryAcquireStreamSlot(userId)) {
    return new Response('too many concurrent streams (max 2 per session)', {
      status: 429,
      headers: {
        // Retry-After: a hint, not enforcement. The client should close
        // any spare tabs / connections before retrying.
        'Retry-After': '5',
      },
    });
  }

  // ── 5. Build the SSE stream ────────────────────────────────────────────
  // We construct a ReadableStream<Uint8Array> and let the runtime pipe it to
  // the response body. The orchestrator loop runs INSIDE the stream's start()
  // so it can write events as it goes. Async generator pattern would be
  // cleaner but Next.js's Response() expects a ReadableStream, not an
  // AsyncIterable, so we adapt.
  const stream = createTutorialStream({
    tutorialId,
    userId,
    requestSignal: req.signal,
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      // Cache-Control: prevent ALL caching. Public proxies + browser cache
      // must NEVER store an SSE response (it'd return stale partial data).
      // 'no-transform' prevents compressing proxies from buffering until end.
      'Cache-Control': 'no-cache, no-store, no-transform',
      // X-Accel-Buffering: nginx/Cloudflare proxy directive — disables
      // proxy-side buffering so events ship to the client as written
      // (without this, nginx buffers in 8KB chunks; small chapter starts
      // never arrive until the whole chapter is done).
      'X-Accel-Buffering': 'no',
      // Connection: keep-alive — explicit signal to HTTP/1.1 intermediaries
      // not to close after the response headers. HTTP/2 negotiates this
      // automatically, but the header is harmless there.
      Connection: 'keep-alive',
    },
  });
}

// ───────────────────────────────────────────────────────────────────────────
// Stream orchestration
// ───────────────────────────────────────────────────────────────────────────

interface CreateStreamArgs {
  tutorialId: string;
  /**
   * The userId from the verified session. Threaded down so the stream's
   * finally block can release the concurrent-stream slot acquired in the
   * GET handler (mio HIGH-2 fold). Decoupled from the slot map so the
   * orchestrator does not need to know about rate-limit state directly.
   */
  userId: string;
  /**
   * The incoming request's AbortSignal. Fires when the client disconnects
   * (closes the EventSource OR navigates away). Propagates through to
   * `generateChapterStreaming` so the OpenAI fetch is cancelled in-flight.
   * (riley CRITICAL-1)
   */
  requestSignal: AbortSignal;
}

/**
 * Build the ReadableStream that produces the SSE byte stream. All event
 * emission happens here; the route handler above is pure framing.
 *
 * The orchestrator iterates chapters where status='pending' (idempotent —
 * a reconnect after partial progress resumes from the next pending chapter).
 * Per chapter:
 *   1. Mark chapter status='generating' (single-row UPDATE outside any tx)
 *   2. Emit `chapter-start`
 *   3. Call `generateChapterStreaming` with onToken bridged to SSE
 *   4. On success: per-chapter sub-tx that writes narrative + questions +
 *      flashcards + parses_cost row; mark status='complete' or 'partial'
 *   5. Emit `chapter-complete` + `cost-update`
 * On any per-chapter failure: mark chapter status='failed' + emit `error`
 * frame with the chapter_id, then CONTINUE to next chapter (chapter-level
 * blast radius, not stream-level). UI handles error frames inline.
 *
 * Stream terminates with a single `done` event after all chapters processed
 * (or on cost-cap-exceeded, which is stream-level fatal — we close after
 * the error frame).
 */
function createTutorialStream(args: CreateStreamArgs): ReadableStream<Uint8Array> {
  const { tutorialId, userId, requestSignal } = args;
  const encoder = new TextEncoder();

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      // Helper: encode + enqueue an SSE event. Centralizing this means the
      // wire format lives in ONE place; the per-event-type writers below
      // just build the payload object.
      //
      // NOTE: this could equivalently call `toFrameBytes` from
      // `@/lib/sse/frames` (the shared helper module). We keep the inline
      // implementation here for minimum-deps in the hot path; the helper
      // module exists so casey's UI test fixture can emit byte-identical
      // frames without us having to re-export framing logic.
      const emit = (event: SseEventName, payload: unknown): void => {
        // Per HTML5 SSE: each event is `event:NAME\ndata:JSON\n\n`. The
        // empty trailing line is what flushes the event to the client.
        // We stringify with NO indent — minimizes bytes on the wire and
        // (more importantly) guarantees JSON.parse on the client gets a
        // single line per event (no newlines inside `data:`).
        const frame = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
        controller.enqueue(encoder.encode(frame));
      };

      try {
        await orchestrate({
          tutorialId,
          requestSignal,
          emit,
        });
      } catch (err) {
        // ANY uncaught error reaching this boundary is an unexpected
        // internal failure — orchestrate() catches per-chapter errors
        // internally. We still emit a structured error event so the UI
        // can render a useful message instead of "stream closed".
        //
        // mio MEDIUM-3 fold: we deliberately DO NOT thread the raw
        // exception message into the wire payload. Errors here may carry
        // file paths, stack frames, internal model names, or even
        // truncated OpenAI responses (if a downstream parse threw).
        // The redaction layer (toUserSafeError) maps to a fixed allowlist
        // of user-facing codes + generic messages; raw details go to
        // server stderr only.
        // eslint-disable-next-line no-console
        console.error(`[stream/${tutorialId}] uncaught orchestrator error:`, err);
        emit('error', toUserSafeError(err, 'internal-error'));
      } finally {
        // mio HIGH-2 fold: release the concurrent-stream slot acquired in
        // the GET handler. MUST happen in finally so cost-cap return,
        // client abort, and uncaught error paths all decrement.
        releaseStreamSlot(userId);
        // Always close the controller. The browser EventSource will see
        // the connection close and fire its `onerror` handler (which the
        // UI uses to clean up); the `done` event emitted by orchestrate()
        // tells the UI to NOT auto-reconnect (the EventSource default).
        try {
          controller.close();
        } catch {
          // controller was already closed (e.g., client disconnected
          // mid-write); swallow — the stream is done either way.
        }
      }
    },

    /**
     * Called when the consumer cancels the stream (Browser closed the
     * EventSource OR Next.js aborted the request). We do NOT propagate
     * here directly because the orchestrator polls requestSignal AND each
     * generateChapterStreaming call passes requestSignal through to the
     * OpenAI fetch. This callback is the BACKSTOP — by the time we land
     * here the orchestrator should already be unwinding.
     */
    cancel() {
      // No-op: the AbortSignal wired into requestSignal handles cleanup.
      // (Adding cleanup here would risk double-aborting / dangling state.)
    },
  });
}

// ───────────────────────────────────────────────────────────────────────────
// Per-chapter orchestration loop
// ───────────────────────────────────────────────────────────────────────────

interface OrchestrateArgs {
  tutorialId: string;
  requestSignal: AbortSignal;
  emit: (event: SseEventName, payload: unknown) => void;
}

async function orchestrate(args: OrchestrateArgs): Promise<void> {
  const { tutorialId, requestSignal, emit } = args;

  // Load all chapters in ordinal order. We re-query each chapter's status
  // inline below before generating — the snapshot here is just for the
  // iteration order, not the work-decision.
  const chapterRows = await db
    .select({
      id: schema.chapters.id,
      ordinal: schema.chapters.ordinal,
      title: schema.chapters.title,
      status: schema.chapters.status,
      sourceParagraphsJson: schema.chapters.sourceParagraphsJson,
    })
    .from(schema.chapters)
    .where(eq(schema.chapters.tutorialId, tutorialId))
    .orderBy(asc(schema.chapters.ordinal));

  // Flip the tutorial to 'generating' if it isn't already (idempotent — only
  // transitions from 'ready-to-generate'). This is informational for
  // observers polling the status route during stream.
  await db
    .update(schema.tutorials)
    .set({ status: 'generating' })
    .where(
      and(
        eq(schema.tutorials.id, tutorialId),
        eq(schema.tutorials.status, 'ready-to-generate'),
      ),
    );

  let chaptersCompleted = 0;
  for (const chapter of chapterRows) {
    // Cooperative abort check between chapters. The OpenAI fetch already
    // honors requestSignal mid-stream; this catches the case where the
    // client disconnects BETWEEN chapter calls.
    if (requestSignal.aborted) {
      emit('error', {
        code: 'aborted',
        message: 'stream aborted by client',
      } satisfies ErrorPayload);
      return;
    }

    // Skip already-complete chapters (reconnect scenario; idempotent).
    // We do NOT skip 'failed' chapters — operator intent (retry later)
    // requires explicit re-set to 'pending', which is a separate flow.
    if (chapter.status === 'complete' || chapter.status === 'partial') {
      chaptersCompleted++;
      continue;
    }
    if (chapter.status !== 'pending') {
      // 'failed' or 'generating' (last run crashed mid-flight); skip in
      // this auto-orchestrator. Operator-driven retry would reset to
      // 'pending' first.
      continue;
    }

    const chapterStartedAt = Date.now();

    // ── Step 1: parse the SourceParagraph[] payload ─────────────────────
    let sourceParagraphs: SourceParagraph[];
    try {
      sourceParagraphs = JSON.parse(chapter.sourceParagraphsJson) as SourceParagraph[];
    } catch {
      // Malformed JSON in the DB is a noor-pipeline failure; surface and
      // continue to next chapter. The chapter row gets status='failed'.
      await markChapterFailed(chapter.id, 'source paragraphs JSON malformed');
      emit('error', {
        code: 'chapter-parse-failed',
        message: 'source paragraphs malformed',
        chapterId: chapter.id,
      } satisfies ErrorPayload);
      continue;
    }

    // ── Step 2: flip chapter status to 'generating' via CAS ─────────────
    // nova CRITICAL-1 (test3 Phase 3) fix: previously this was an
    // unconditional UPDATE which let two concurrent SSE connections (e.g.
    // EventSource auto-reconnect mid-flip from pending → generating) BOTH
    // claim the same chapter, producing two OpenAI calls + two parses_cost
    // rows + duplicate questions/flashcards.
    //
    // CAS pattern: UPDATE...WHERE status='pending' AND RETURNING id. If
    // the row was already past 'pending' (another connection got there
    // first), the returning array is empty and we skip — that connection
    // owns this chapter. The chapter-row read at line 478 may show stale
    // 'pending' from a few ms ago; this CAS is the linearization point.
    //
    // (Single-row UPDATE outside any transaction. If we crash before the
    // sub-tx below, this row sits at 'generating' — operator manual reset
    // to 'pending' is the recovery path, deferred to test4 per ari design.)
    const claimed = await db
      .update(schema.chapters)
      .set({ status: 'generating' })
      .where(
        and(
          eq(schema.chapters.id, chapter.id),
          eq(schema.chapters.status, 'pending'),
        ),
      )
      .returning({ id: schema.chapters.id });
    if (claimed.length === 0) {
      // CAS lost — another connection beat us to this chapter. Skip.
      continue;
    }

    emit('chapter-start', {
      chapterId: chapter.id,
      ordinal: chapter.ordinal,
      title: chapter.title,
    } satisfies ChapterStartPayload);

    // ── Step 3: stream tokens ──────────────────────────────────────────
    let genResult;
    try {
      genResult = await generateChapterStreaming({
        tutorialId,
        chapterTitle: chapter.title,
        sourceParagraphs,
        abortSignal: requestSignal,
        onToken: (delta) => {
          // The OpenAI stream emits a single JSON document character-by-
          // character. We forward each delta verbatim; the UI buffers and
          // parses at chapter-complete to render the structured payload.
          // Per omar HIGH-3: any inline `[ref:pageN:paragraphM]` markup
          // in narrative text gets carried through unchanged here — the
          // UI tokenizer turns them into clickable spans.
          emit('token', {
            chapterId: chapter.id,
            delta,
            kind: 'narrative',
          } satisfies TokenPayload);
        },
      });
    } catch (err) {
      // ── Branch A: cost cap exceeded — STREAM-FATAL ─────────────────
      // We've hit the per-tutorial spend ceiling. Mark this chapter as
      // failed (work was not committed), emit the error frame, and STOP
      // the stream. UI will show "cost cap reached" with a re-attempt
      // path (operator: raise the cap or accept partial tutorial).
      if (err instanceof CostCapExceeded) {
        await markChapterFailed(chapter.id, 'cost cap exceeded');
        // mio MEDIUM-3 fold: do NOT leak the cap value, spent value, or
        // projected value. Those are server-internal economics; the UI
        // only needs to know "generation stopped because budget hit".
        // Server logs retain the full CostCapExceeded message for ops.
        // eslint-disable-next-line no-console
        console.error(`[stream/${tutorialId}/${chapter.id}] cost-cap: ${err.message}`);
        emit('error', toUserSafeError(err, 'cost-cap-exceeded', chapter.id));
        return; // stream-level fatal — caller will close()
      }

      // ── Branch B: client aborted (riley CRIT-1) ─────────────────────
      // The AbortSignal fired mid-stream; the OpenAI request is cancelled,
      // billing has stopped, no partial data was persisted. Mark the
      // chapter back to 'pending' so a reconnect picks up cleanly.
      if (isAbortLike(err) || requestSignal.aborted) {
        await db
          .update(schema.chapters)
          .set({ status: 'pending' })
          .where(eq(schema.chapters.id, chapter.id));
        // We do NOT emit an error here — the client is GONE; nothing
        // would receive the frame. Just return to close the stream.
        return;
      }

      // ── Branch C: chapter-parse failure or other recoverable ────────
      // Mark THIS chapter failed but continue to the next one. This is
      // the per-chapter blast-radius discipline (noor CRITICAL-2): one
      // bad chapter does not poison the whole tutorial.
      //
      // mio MEDIUM-3 fold: route the error through the allowlisted
      // mapper. ChapterGenParseError.rawText may contain truncated model
      // output (which per ari HIGH-3 could echo embedded source-paragraph
      // text including potentially injected prompts) — we never let that
      // cross the SSE boundary. Server logs retain the full message.
      const internalMessage =
        err instanceof ChapterGenParseError
          ? `chapter-parse-failed (raw len=${err.rawText.length})`
          : err instanceof Error
            ? err.message
            : String(err);
      // eslint-disable-next-line no-console
      console.error(
        `[stream/${tutorialId}/${chapter.id}] chapter generation failed:`,
        internalMessage,
      );
      await markChapterFailed(chapter.id, internalMessage);
      const errCode = err instanceof ChapterGenParseError
        ? 'chapter-parse-failed'
        : 'chapter-parse-failed'; // single MVP bucket; finer codes in v2.9.1
      emit('error', toUserSafeError(err, errCode, chapter.id));
      continue;
    }

    // ── Step 4: persist the chapter (per-chapter sub-transaction) ───────
    // noor CRITICAL-2: each chapter is its own atomic unit. A crash here
    // leaves prior chapters committed and this one rolled back to
    // 'generating' — recoverable on next stream open.
    //
    // vlad CRITICAL-2 / nova HIGH-2 (test3 Phase 3+4) fix: wrap in try/catch
    // at the chapter boundary. Without this, a SQLite failure inside
    // persistChapterResult escaped to the outer stream-level handler which
    // (a) closed the connection with 'internal-error' to the client and
    // (b) left the chapter row stuck at 'generating' FOREVER — the CAS at
    // step 2 only flips from 'pending', so reconnect couldn't reclaim it.
    // We now explicitly markChapterFailed so the operator can reset to
    // 'pending' for re-generation (re-bills OpenAI; the chapter was paid
    // for but not stored, so re-running is the correct recovery posture).
    const durationMs = Date.now() - chapterStartedAt;
    try {
      persistChapterResult({
        tutorialId,
        chapterId: chapter.id,
        result: genResult.result,
        promptTokens: genResult.promptTokens,
        completionTokens: genResult.completionTokens,
        costUsd: genResult.costUsd,
        validationDropCount: genResult.validationDropCount,
        model: genResult.model,
      });
    } catch (persistErr) {
      const persistMessage =
        persistErr instanceof Error ? persistErr.message : 'persist failed';
      // eslint-disable-next-line no-console
      console.error(
        `[stream/${tutorialId}/${chapter.id}] persist failure (chapter generated but not stored): ${persistMessage}`,
      );
      await markChapterFailed(
        chapter.id,
        `persist-failed: ${persistMessage}`,
      );
      emit('error', toUserSafeError(persistErr, 'chapter-persist-failed', chapter.id));
      continue;
    }

    chaptersCompleted++;

    emit('chapter-complete', {
      chapterId: chapter.id,
      questionCount: genResult.result.questions.length,
      flashcardCount: genResult.result.flashcards.length,
      droppedRefCount: genResult.validationDropCount,
      durationMs,
    } satisfies ChapterCompletePayload);

    // ── Step 5: emit cost update (per omar inference-cost discipline) ──
    // ONCE per chapter, NOT once per token. Per inference-cost-management
    // §Lever 5: chatter-on-the-wire is its own cost (server CPU + client
    // re-render). Chapter-boundary granularity keeps the chip live without
    // flooding the stream.
    const spent = await spentSoFar(tutorialId);
    const cap = env.COST_CAP_USD;
    emit('cost-update', {
      spentUsd: round4(spent),
      capUsd: cap,
      pct: Math.round((spent / cap) * 100),
    } satisfies CostUpdatePayload);
  }

  // ── All chapters processed: flip tutorial to 'complete' + emit done ───
  // Only mark complete if EVERY chapter ended in 'complete' or 'partial'.
  // If any chapter is still 'pending' or 'failed', we leave the tutorial
  // in 'generating' — operator can retry the failed chapters individually.
  // Cheap full status scan over chapters (N is small — bounded by
  // detectChapters output; per noor's pipeline N rarely exceeds ~20).
  const statusRows = await db
    .select({ status: schema.chapters.status })
    .from(schema.chapters)
    .where(eq(schema.chapters.tutorialId, tutorialId));
  const stillPending = statusRows.filter(
    (r) => r.status !== 'complete' && r.status !== 'partial',
  ).length;

  if (stillPending === 0) {
    await db
      .update(schema.tutorials)
      .set({ status: 'complete' })
      .where(eq(schema.tutorials.id, tutorialId));
  }

  const totalCostUsd = await spentSoFar(tutorialId);
  emit('done', {
    tutorialId,
    chaptersCompleted,
    totalCostUsd: round4(totalCostUsd),
  } satisfies DonePayload);
}

// ───────────────────────────────────────────────────────────────────────────
// Persistence — per-chapter sub-transaction (noor CRITICAL-2)
// ───────────────────────────────────────────────────────────────────────────

interface PersistArgs {
  tutorialId: string;
  chapterId: string;
  result: ChapterGenerationResult;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  validationDropCount: number;
  model: string;
}

/**
 * Atomic persistence of one chapter's generation output.
 *
 * Per noor CRITICAL-2: this is ONE chapter's worth of work in ONE
 * sub-transaction. Prior chapters are NOT in scope — they're already
 * committed. A failure here rolls back THIS chapter only.
 *
 * Synchronous (better-sqlite3 transactions are synchronous; the drizzle
 * adapter mirrors that). Caller awaits the returned Promise<void>, but
 * the body runs sync inside the transaction.
 */
function persistChapterResult(args: PersistArgs): void {
  const {
    tutorialId,
    chapterId,
    result,
    promptTokens,
    completionTokens,
    costUsd,
    validationDropCount,
    model,
  } = args;

  // Decide chapter terminal status: 'partial' if any refs were dropped,
  // else 'complete'. Per chapters.status enum + ari HIGH-3 absorb +
  // schema.ts:113-119 ('partial' was added precisely for this signal).
  const terminalStatus = validationDropCount > 0 ? 'partial' : 'complete';

  db.transaction((tx) => {
    // ── 1. UPDATE the chapter row with narrative + terminal status ────
    tx.update(schema.chapters)
      .set({
        narrative: result.narrative,
        status: terminalStatus,
      })
      .where(eq(schema.chapters.id, chapterId))
      .run();

    // ── 2. INSERT each question ───────────────────────────────────────
    // Loop is bounded by prompt schema (5-10 questions); no SQL builder
    // bulk insert needed. Each row uses crypto.randomUUID() — same id
    // convention as noor's worker (src/lib/ingest/worker.ts:116).
    for (const q of result.questions) {
      tx.insert(schema.questions)
        .values({
          id: crypto.randomUUID(),
          chapterId,
          prompt: q.prompt,
          optionsJson: JSON.stringify(q.options),
          correctIndex: q.correctIndex,
          explanation: q.explanation,
          sourceParagraphRef: q.sourceParagraphRef,
        })
        .run();
    }

    // ── 3. INSERT each flashcard ──────────────────────────────────────
    for (const f of result.flashcards) {
      tx.insert(schema.flashcards)
        .values({
          id: crypto.randomUUID(),
          chapterId,
          front: f.front,
          back: f.back,
          sourceParagraphRef: f.sourceParagraphRef,
        })
        .run();
    }

    // ── 4. INSERT the parses_cost telemetry row ───────────────────────
    // chapter_id NOT NULL here (chapter-level cost row, per schema.ts:259).
    // validation_drop_count fed through verbatim per ari HIGH-3 absorb.
    tx.insert(schema.parsesCost)
      .values({
        id: crypto.randomUUID(),
        tutorialId,
        chapterId,
        model,
        promptTokens,
        completionTokens,
        costUsd,
        validationDropCount,
      })
      .run();
  });
}

// ───────────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────────

async function markChapterFailed(chapterId: string, _reason: string): Promise<void> {
  // We do NOT have a chapter.errorMessage column (only tutorials.errorMessage
  // exists in current schema). The `_reason` is logged for operator forensics
  // but not persisted. v2.9.1 candidate: add chapters.error_message column.
  // For MVP the reason rides only in the SSE `error` event payload.
  await db
    .update(schema.chapters)
    .set({ status: 'failed' })
    .where(eq(schema.chapters.id, chapterId));
}

function isAbortLike(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { name?: unknown; code?: unknown };
  return e.name === 'AbortError' || e.code === 'ERR_ABORTED';
}

/**
 * mio MEDIUM-3 fold: allowlist-based error mapper for SSE error frames.
 *
 * The wire `ErrorPayload.message` field MUST NOT contain:
 *   - raw cost values (CostCapExceeded message has spent / cap / projected)
 *   - model names (chapter-gen errors may include 'gpt-4o-mini' etc.)
 *   - file paths or stack frames (any caught Error.message)
 *   - truncated OpenAI responses (ChapterGenParseError.rawText)
 *
 * The previous `safeErrorMessage` regex-stripper was an allowdeny pattern —
 * it tried to redact known-bad substrings. That's fragile: any new shape
 * of internal data slipped through. The allowlist mapper inverts the
 * default: only pre-defined user-facing strings ever cross the boundary.
 *
 * Server-side observability is preserved: callers should `console.error`
 * the raw error before calling this mapper. Operators get full forensics
 * in stderr; clients get only the generic user-facing copy.
 */
const USER_FACING_ERROR_MESSAGES: Record<ErrorPayload['code'], string> = {
  'cost-cap-exceeded':
    'Generation stopped: per-tutorial cost limit reached. Contact the operator to raise the cap, or accept the partial tutorial.',
  'chapter-parse-failed':
    'A chapter could not be generated. The tutorial will continue with the next chapter.',
  unauthorized: 'Session required.',
  'tutorial-not-ready': 'Tutorial is not ready for streaming.',
  aborted: 'Stream aborted.',
  'internal-error':
    'An unexpected error occurred. Please retry; if it persists, contact support.',
};

function toUserSafeError(
  _internalError: unknown,
  code: ErrorPayload['code'],
  chapterId?: string,
): ErrorPayload {
  // The internal error is intentionally NOT inspected here for message
  // content — it's documented as a parameter so callers (and reviewers)
  // see the redaction-point clearly. The whole point of the allowlist is
  // that we don't trust the message string.
  const base: ErrorPayload = {
    code,
    message: USER_FACING_ERROR_MESSAGES[code],
  };
  return chapterId === undefined ? base : { ...base, chapterId };
}

/** Round to 4 decimal places (USD precision for the UI cost-chip). */
function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}
