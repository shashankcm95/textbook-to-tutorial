/**
 * src/lib/sse/frames.ts — typed SSE wire-format helpers.
 *
 * Centralizes the bytes-on-the-wire shape of Server-Sent Events so the
 * stream route (server) and the EventSource consumer (UI) can mirror the
 * exact same contract without each re-implementing the framing. Anything
 * about the wire format that needs to change (event name conventions,
 * payload-stringification, heartbeat shape) lives in ONE file.
 *
 * Inference-path discipline (FIX-I8): this module lives BESIDE the OpenAI
 * streaming consumer (src/lib/openai/streaming.ts) not under any model-
 * training abstraction. SSE is the transport for LLM token deltas; it
 * belongs to the inference-API consumption surface. See:
 *   - kb:ml-dev/training-vs-inference §"Deployment topologies"
 *     ("Streaming" row): event-driven, seconds-to-minutes latency, the
 *     correct topology for per-token visibility during chapter generation.
 *   - kb:architecture/ai-systems/inference-cost-management §"Lever 5:
 *     Output control": the per-chapter `cost-update` event (not per-token)
 *     is the cost-aware design choice — chatter-on-the-wire is its own
 *     cost (server CPU + client re-render) and must be budgeted.
 *
 * Why a separate helper module (not inline in the route):
 *   - The stream route was 738 lines pre-rate-limit absorb; pushing
 *     framing into a helper trims it.
 *   - Casey's `useStreamingChapter` hook needs to know the wire shape too;
 *     having an EXPORTED `formatFrame` lets a hypothetical test fixture
 *     (jsdom EventSource mock) emit byte-identical frames.
 *   - HTML5 SSE has subtle parsing rules (event:NAME\ndata:JSON\n\n is
 *     the minimal complete frame; mixing newlines inside `data:` is a
 *     spec foot-gun); centralizing the encoder kills the foot-gun by
 *     never letting raw JSON.stringify output near a multi-line string.
 *
 * Source-tag passthrough (omar HIGH-3 fold): when narrative tokens contain
 * `[ref:pageN:paragraphM]` markup from the OpenAI output, those markers
 * pass through untouched — they are normal characters inside the JSON
 * string payload. No stripping, no re-emission as separate frames. The
 * UI's CitationModal owns the parsing.
 *
 * Set-based dedup (omar CRITICAL-1 fold): the dedup of sourceParagraphRef
 * across questions+flashcards already happens INSIDE
 * `generateChapterStreaming` (src/lib/openai/streaming.ts:158-160 builds
 * the `validRefs` Set; :350-366 enforces it). This module does NOT
 * re-dedup; the upstream contract guarantees the result is already clean
 * by the time `chapter-complete` is emitted.
 */

// ───────────────────────────────────────────────────────────────────────────
// HTML5 SSE wire format — the only protocol detail in this file
// ───────────────────────────────────────────────────────────────────────────

/**
 * The byte sequence that terminates an SSE event and triggers client
 * dispatch. Per WHATWG HTML Living Standard §"Server-sent events":
 *   "When the user agent encounters a blank line, it dispatches the event."
 * A blank line = `\n\n` after the last data line.
 */
const SSE_FRAME_TERMINATOR = '\n\n';

/**
 * Per HTML5 SSE spec: any newline inside the data: payload MUST be split
 * into multiple `data:` lines (the EventSource API concatenates them with
 * `\n` on the client). Since we ALWAYS JSON.stringify the payload (which
 * escapes \n to literal backslash-n), this normally doesn't fire — but a
 * caller passing a raw string that happens to contain newlines would
 * trigger this. We defend by always JSON.stringify-ing, so the body is
 * always a single line.
 *
 * Documented behavior: if `data` is `undefined` we omit the data: line
 * entirely (some events are pure signals — `event: heartbeat` is fine
 * with no payload). `null` payloads emit `data: null` (explicit null).
 */

// ───────────────────────────────────────────────────────────────────────────
// Public API
// ───────────────────────────────────────────────────────────────────────────

/**
 * Build an SSE frame as the string that goes on the wire.
 *
 * Wire format:
 *   event: <event-name>\n
 *   data: <JSON.stringify(payload)>\n
 *   \n
 *
 * Generic `<T>` is documentation-only — the runtime serialization is
 * pure JSON.stringify, which has no type-awareness. The type param lets
 * the call site declare the intended payload shape (and TypeScript can
 * check the call site catches shape regressions). For example:
 *
 *   formatFrame<TokenPayload>('token', { chapterId, token, kind })
 *
 * will TS-error if `kind` is missing — even though the wire format only
 * checks JSON.stringify's success.
 *
 * @param event   — the SSE event name. Should be a stable string per
 *                  the wire contract. Empty string forbidden (no `event:`
 *                  line means the client dispatches as 'message').
 * @param data    — the payload to JSON.stringify. `undefined` omits the
 *                  data: line entirely. `null` emits `data: null`.
 * @returns the complete frame string (terminator included). Caller writes
 *          this directly to the ReadableStream (after TextEncoder.encode).
 *
 * @example
 *   const frame = formatFrame('token', { chapterId: 'abc', token: 'hi', kind: 'narrative' });
 *   // → 'event: token\ndata: {"chapterId":"abc","token":"hi","kind":"narrative"}\n\n'
 *   controller.enqueue(new TextEncoder().encode(frame));
 */
export function formatFrame<T>(event: string, data?: T): string {
  if (event.length === 0) {
    throw new Error(
      'formatFrame: event name must not be empty (client would fall back to "message" dispatch which is rarely intended).',
    );
  }
  // Validate the event name — per WHATWG it MUST be a single line (no \n
  // or \r) and contain no colons (colons would parse as field separators).
  // We bail rather than silently produce a malformed frame.
  if (/[\n\r:]/.test(event)) {
    throw new Error(
      `formatFrame: event name ${JSON.stringify(event)} contains forbidden characters (\\n, \\r, or :)`,
    );
  }

  const lines: string[] = [`event: ${event}`];
  if (data !== undefined) {
    // JSON.stringify produces a single line (it escapes \n → \\n inside
    // strings, and arrays/objects never contain raw newlines).
    // The one edge case: callers passing a circular structure would throw
    // TypeError — we let that bubble up rather than emit a half-baked
    // frame. The route handler's outer try/catch surfaces this as an
    // 'internal-error' SSE frame.
    lines.push(`data: ${JSON.stringify(data)}`);
  }
  return lines.join('\n') + SSE_FRAME_TERMINATOR;
}

/**
 * Build a comment-line "heartbeat" frame. Per SSE spec, lines starting
 * with `:` are comments — the EventSource client ignores them, but the
 * bytes on the wire keep TCP/HTTP intermediaries (proxies, load
 * balancers) from closing the connection during long quiet periods.
 *
 * Use case: long-running chapter generation where the first OpenAI token
 * may take 5-10s to arrive. Some intermediaries time out idle connections
 * at 30-60s. A 15s-interval heartbeat keeps the pipe alive.
 *
 * @returns ': heartbeat\n\n' — minimal comment frame.
 */
export function formatHeartbeat(): string {
  return `: heartbeat${SSE_FRAME_TERMINATOR}`;
}

/**
 * Convenience: encode a frame string into Uint8Array bytes, ready to
 * pass to `ReadableStreamDefaultController.enqueue`. Centralizes the
 * TextEncoder allocation (which is non-trivial — one per call site
 * would proliferate; one shared encoder is fine because the API is
 * stateless across calls).
 *
 * Note: TextEncoder is a Web platform global available in both Node 19+
 * and Edge runtimes. No import needed.
 */
const sharedEncoder = new TextEncoder();

export function encodeFrame(frame: string): Uint8Array {
  return sharedEncoder.encode(frame);
}

/**
 * Convenience composition: format + encode in one call. The typical
 * route-handler pattern is:
 *
 *   controller.enqueue(toFrameBytes('token', payload));
 *
 * which reads cleaner than the two-step. Generic type param flows through.
 */
export function toFrameBytes<T>(event: string, data?: T): Uint8Array {
  return encodeFrame(formatFrame<T>(event, data));
}
