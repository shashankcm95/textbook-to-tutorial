// src/lib/generation/diagrams-extracted-event.ts — Sprint H Wave 1 (Builder E).
//
// Contract module: the shape + callback signature for the "diagrams-
// extracted" signal that crosses the per-chapter / SSE-route boundary.
//
// Why a dedicated module:
// -----------------------
// Builder E (this file's author) wires the SSE route + streaming hook;
// Builder D wires the actual extract call inside per-chapter.ts. We
// agreed up-front (RFC §Wave 1) that the integration seam is an optional
// callback on `generateChapter`. Putting the shape + callback type in
// one home means both builders import the same surface — no drift, no
// "what fields does the route expect?" archaeology in code review.
//
// Why the callback is fire-and-forget (no Promise):
// -------------------------------------------------
// The SSE route's only job on this signal is to encode a frame and call
// `controller.enqueue` (synchronous + cheap). Making the callback async
// would invite "did we await it?" bugs in per-chapter.ts's transaction
// boundary. Keep it synchronous so the contract is "by the time
// generateChapter resolves, all callbacks have already returned".
//
// Bulkhead note (kb:architecture/discipline/stability-patterns):
// --------------------------------------------------------------
// Builder D's wiring will fail-open on extract errors — the callback
// only fires on extract SUCCESS. The SSE route therefore treats the
// absence of a diagrams-extracted frame BEFORE chapter-complete as
// "extraction was skipped or fail-opened" — same UX as today: just
// no count surfaced to the user. No new error frame is added; existing
// `error` frame catches everything else (cost-cap, chapter-parse, etc.).

/**
 * Payload shape sent on the diagrams-extracted SSE frame AND passed to
 * the `onDiagramsExtracted` callback Builder D wires into
 * `generateChapter`. Field semantics match
 * `ExtractDiagramsResult` from `@/lib/openai/extract-diagrams`:
 *
 *   - `count`        = `diagrams.length` (validated F.1 payloads only)
 *   - `droppedCount` = wire entries that failed fromWire / Zod parse
 *   - `costUsd`      = the extract call's actualCost result
 *
 * The interface mirrors the SSE wire data; the SSE route serializes
 * exactly this object (no envelope, no extra fields).
 */
export interface DiagramsExtractedEvent {
  count: number;
  droppedCount: number;
  costUsd: number;
}

/**
 * The callback Builder D's `generateChapter` will invoke (synchronously,
 * once per chapter, only on extract success — fail-open path skips it).
 *
 * Builder D will add an optional `onDiagramsExtracted?: OnDiagramsExtracted`
 * field to `GenerateChapterArgs`; the SSE route already passes it today
 * via an intersection cast (see `chapters/[idx]/stream/route.ts`). When
 * Builder D's field lands, the cast becomes a no-op; the contract
 * remains stable.
 */
export type OnDiagramsExtracted = (event: DiagramsExtractedEvent) => void;

/**
 * The SSE event name. Centralized here so both producer (route) and
 * consumer (`useStreamingChapter`) reference the same string literal —
 * a typo on one side becomes a compile error, not a silent frame drop.
 */
export const DIAGRAMS_EXTRACTED_EVENT = 'diagrams-extracted' as const;

/**
 * The SSE event name emitted by the route the moment narrative-token
 * streaming finishes (between `onNarrativeComplete` firing and the
 * extraction call starting in Builder D's per-chapter wiring). The
 * streaming hook flips `isExtracting` true on this frame and false on
 * `diagrams-extracted`. Pre-Builder-D, this frame still fires and
 * `isExtracting` simply stays true through `chapter-complete` (cosmetic;
 * the bulkhead is intact).
 */
export const NARRATIVE_STREAM_COMPLETE_EVENT = 'narrative-stream-complete' as const;
