// src/app/api/tutorials/[id]/chapters/[idx]/stream/route.ts
//
// New per-chapter SSE endpoint for the lazy-hybrid-chunking architecture.
// Generates ONE chapter at a time (4o narrative + 4o-mini quiz/flashcards),
// streams narrative tokens live, emits chapter-complete with parsed quiz +
// flashcards at the tail.
//
// Coexists with the legacy /api/tutorials/[id]/stream endpoint (which loops
// over all chapters in one connection — used by PR #1's StreamingClient).
// The lazy architecture (Commit 3) will switch StreamingClient to call THIS
// endpoint per-chapter with prefetch.
//
// SSE protocol (events emitted):
//   - chapter-start:    { chapterId, ordinal, title, sourceParagraphs[] }
//   - token:            { chapterId, kind: 'narrative', delta }
//   - chapter-complete: { chapterId, questions, flashcards, validationDropCount }
//   - cost-update:      { costUsd }
//   - done:             {}
//   - error:            { code, message? }
//
// Auth: session cookie (mirrors GET /api/tutorials/:id pattern).
// CSRF: none required — GET endpoint, no state change at the protocol layer.
// (Per-chapter state IS mutated, but the generation is an idempotent claim:
// only one runner can grab pending → generating at a time.)

import { type NextRequest } from 'next/server';
import { eq, and } from 'drizzle-orm';
import { db } from '@/db/client';
import { tutorials, chapters } from '@/db/schema';
import { verifySession, SESSION_COOKIE_NAME } from '@/lib/session';
import { generateChapter, ChapterGenerationError } from '@/lib/generation/per-chapter';
import { resolveChunksBucket, readChunk } from '@/lib/s3-chunks';
import type { SourceParagraph } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string; idx: string } },
) {
  // ── 1. Auth ─────────────────────────────────────────────────────────
  const secret = process.env.SESSION_SECRET ?? '';
  if (!secret) {
    return new Response(
      JSON.stringify({ error: 'server misconfigured: SESSION_SECRET missing' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }
  const sessionCookie = req.cookies.get(SESSION_COOKIE_NAME)?.value ?? '';
  const payload = await verifySession(sessionCookie, secret);
  if (!payload) {
    return new Response(JSON.stringify({ error: 'session required' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  const userId = payload.userId;

  // ── 2. Validate params ──────────────────────────────────────────────
  const { id: tutorialId, idx: idxStr } = params;
  if (!/^[0-9a-f-]{36}$/i.test(tutorialId)) {
    return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
  }
  const chapterIdx = Number.parseInt(idxStr, 10);
  if (!Number.isFinite(chapterIdx) || chapterIdx < 0) {
    return new Response(JSON.stringify({ error: 'invalid idx' }), { status: 400 });
  }

  // ── 3. Ownership + readiness check ──────────────────────────────────
  const tutRows = await db
    .select()
    .from(tutorials)
    .where(and(eq(tutorials.id, tutorialId), eq(tutorials.userId, userId)))
    .limit(1);
  const tutorial = tutRows[0];
  if (!tutorial) {
    return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
  }
  if (tutorial.status !== 'ready-to-generate' && tutorial.status !== 'generating') {
    return new Response(
      JSON.stringify({ error: 'tutorial not ready for generation', status: tutorial.status }),
      { status: 409, headers: { 'Content-Type': 'application/json' } },
    );
  }

  const chRows = await db
    .select()
    .from(chapters)
    .where(and(eq(chapters.tutorialId, tutorialId), eq(chapters.ordinal, chapterIdx)))
    .limit(1);
  const chapter = chRows[0];
  if (!chapter) {
    return new Response(JSON.stringify({ error: 'chapter not found' }), { status: 404 });
  }

  // Resolve source paragraphs for the chapter-start frame (so client can
  // populate the citation index immediately, before tokens arrive).
  const sourceParagraphs = await loadSourceParagraphs(chapter, tutorial);

  // ── 4. Open SSE stream ──────────────────────────────────────────────
  const encoder = new TextEncoder();
  const abort = new AbortController();
  req.signal?.addEventListener('abort', () => abort.abort(), { once: true });

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      function emit(event: string, data: unknown): void {
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          // controller closed; nothing to do
        }
      }

      // chapter-start (so client knows what we're working on)
      emit('chapter-start', {
        chapterId: chapter.id,
        ordinal: chapter.ordinal,
        title: chapter.title,
        sourceParagraphs,
      });

      try {
        const result = await generateChapter({
          tutorialId,
          chapterIdx,
          abortSignal: abort.signal,
          onNarrativeToken: (delta) =>
            emit('token', { chapterId: chapter.id, kind: 'narrative', delta }),
          onNarrativeComplete: (_narrative) => {
            // No-op for now; could emit a "phase-shift" event later.
          },
        });

        // chapter-complete with structured Q + F payload — client uses this
        // to populate quiz + flashcard surfaces.
        emit('chapter-complete', {
          chapterId: chapter.id,
          questionsCount: result.questionsCount,
          flashcardsCount: result.flashcardsCount,
          validationDropCount: result.validationDropCount,
          status: result.status,
        });
        emit('cost-update', { costUsd: result.totalCostUsd });
        emit('done', {});
      } catch (err) {
        if (err instanceof ChapterGenerationError && err.code === 'already-running') {
          emit('error', { code: 'already-running', message: 'chapter already being generated' });
        } else {
          const msg = err instanceof Error ? err.message : String(err);
          // eslint-disable-next-line no-console
          console.error(
            `[generate/chapter ${tutorialId}/${chapterIdx}] failed:`,
            msg,
          );
          emit('error', { code: 'chapter-parse-failed', message: msg.slice(0, 300) });
        }
      } finally {
        controller.close();
      }
    },
    cancel() {
      abort.abort();
    },
  });

  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}

// ───────────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────────

async function loadSourceParagraphs(
  chapter: { sourceParagraphsJson: string; chunkS3Key: string | null },
  tutorial: { sourceS3Url: string; sourcePdfSha256: string | null },
): Promise<SourceParagraph[]> {
  if (chapter.sourceParagraphsJson && chapter.sourceParagraphsJson !== '[]') {
    try {
      const parsed = JSON.parse(chapter.sourceParagraphsJson) as unknown;
      if (Array.isArray(parsed) && parsed.length > 0) return parsed as SourceParagraph[];
    } catch {
      // fall through
    }
  }
  if (!chapter.chunkS3Key || !tutorial.sourcePdfSha256) return [];
  const match = /chapters\/(\d+)\.json$/.exec(chapter.chunkS3Key);
  if (!match) return [];
  const idx = Number(match[1]);
  if (!Number.isFinite(idx)) return [];
  try {
    const bucket = resolveChunksBucket(tutorial.sourceS3Url);
    const artifact = await readChunk(bucket, tutorial.sourcePdfSha256, idx);
    return artifact.paragraphs;
  } catch {
    return [];
  }
}
