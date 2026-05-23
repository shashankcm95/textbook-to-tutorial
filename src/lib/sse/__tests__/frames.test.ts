/**
 * src/lib/sse/__tests__/frames.test.ts — vitest unit suite for SSE framing.
 *
 * Coverage targets (per spawn brief):
 *   - frame shape (event: NAME\ndata: JSON\n\n)
 *   - null / undefined data handling (null → emit; undefined → omit data:)
 *   - multi-line data via JSON.stringify escaping
 *   - heartbeat shape (comment-line for keep-alive)
 *   - event-name validation (empty / forbidden chars)
 *   - byte encoding (Uint8Array contents match utf-8)
 *
 * Test discipline: each test asserts a SINGLE observable property of the
 * wire format. We don't bundle "frame shape + encoding + null" into one
 * test because diagnosis of a failing assertion would be ambiguous.
 *
 * Inference-path anchor: this module is part of the LLM token-streaming
 * transport (FIX-I8 inference-path scope per kb:ml-dev/training-vs-inference).
 * No model-training concerns; the test asserts wire-format correctness for
 * the OpenAI streaming consumption path.
 */

import { describe, it, expect } from 'vitest';
import {
  formatFrame,
  formatHeartbeat,
  encodeFrame,
  toFrameBytes,
} from '../frames';

// ───────────────────────────────────────────────────────────────────────────
// formatFrame — shape contract
// ───────────────────────────────────────────────────────────────────────────

describe('formatFrame — shape', () => {
  it('emits event + data + double-newline terminator for object payload', () => {
    const frame = formatFrame('token', { chapterId: 'abc', token: 'hi' });
    expect(frame).toBe(
      'event: token\ndata: {"chapterId":"abc","token":"hi"}\n\n',
    );
  });

  it('emits event + data + double-newline for primitive payload', () => {
    const frame = formatFrame('count', 42);
    expect(frame).toBe('event: count\ndata: 42\n\n');
  });

  it('emits event + data + double-newline for string payload', () => {
    const frame = formatFrame('msg', 'hello world');
    // JSON.stringify wraps string in quotes; that's the on-wire shape we want
    // (client JSON.parses the data field back to a string).
    expect(frame).toBe('event: msg\ndata: "hello world"\n\n');
  });

  it('always terminates with a blank line (frame dispatch signal)', () => {
    const frame = formatFrame('any', { x: 1 });
    expect(frame.endsWith('\n\n')).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// formatFrame — null vs undefined handling
// ───────────────────────────────────────────────────────────────────────────

describe('formatFrame — null/undefined handling', () => {
  it('emits literal "data: null" when payload is explicitly null', () => {
    const frame = formatFrame('signal', null);
    expect(frame).toBe('event: signal\ndata: null\n\n');
  });

  it('OMITS the data: line entirely when payload is undefined', () => {
    // SSE allows event-only frames (e.g., a pure signal like 'reset').
    // The client receives the named event with empty data.
    const frame = formatFrame('reset');
    expect(frame).toBe('event: reset\n\n');
    expect(frame).not.toContain('data:');
  });

  it('OMITS the data: line when arg is the literal undefined value', () => {
    const frame = formatFrame('heartbeat-named', undefined);
    expect(frame).toBe('event: heartbeat-named\n\n');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// formatFrame — multi-line / special-char payload data
// ───────────────────────────────────────────────────────────────────────────

describe('formatFrame — multi-line + special chars', () => {
  it('escapes newlines inside string payloads via JSON.stringify', () => {
    // The whole risk SSE has: if a literal newline reaches the wire inside
    // `data:`, the client sees TWO frames. JSON.stringify protects us by
    // converting \n inside a string to the two-char escape \\n.
    const payload = { narrative: 'line one\nline two' };
    const frame = formatFrame('token', payload);
    // The serialized form contains a LITERAL backslash-n, NOT a newline.
    expect(frame).toBe(
      'event: token\ndata: {"narrative":"line one\\nline two"}\n\n',
    );
    // No bare \n inside the data: payload (only the two trailing ones).
    const dataLine = frame.split('\n')[1] ?? '';
    expect(dataLine.includes('\\n')).toBe(true); // escaped form present
    expect(dataLine.endsWith('"}')).toBe(true);  // line ended cleanly
  });

  it('escapes nested quotes / backslashes via JSON.stringify', () => {
    const frame = formatFrame('token', { text: 'a "quoted" value\\with\\backslash' });
    expect(frame).toBe(
      'event: token\ndata: {"text":"a \\"quoted\\" value\\\\with\\\\backslash"}\n\n',
    );
  });

  it('preserves omar HIGH-3 source-tag markup verbatim inside string payload', () => {
    // The narrative tokens may include `[ref:pageN:paragraphM]` markup that
    // the UI CitationModal parses. SSE framing MUST NOT strip or transform
    // these — JSON.stringify only escapes \, ", and control chars; the
    // brackets and colons pass through as-is.
    const payload = { token: 'See [ref:page42:paragraph3] for the proof.' };
    const frame = formatFrame('token', payload);
    expect(frame).toContain('[ref:page42:paragraph3]');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// formatFrame — validation (defensive)
// ───────────────────────────────────────────────────────────────────────────

describe('formatFrame — input validation', () => {
  it('throws on empty event name', () => {
    expect(() => formatFrame('', { x: 1 })).toThrow(/event name/i);
  });

  it('throws on event name containing colon (would break field parser)', () => {
    expect(() => formatFrame('bad:name', { x: 1 })).toThrow(/forbidden character/i);
  });

  it('throws on event name containing newline', () => {
    expect(() => formatFrame('bad\nname', { x: 1 })).toThrow(/forbidden character/i);
  });

  it('throws on event name containing carriage return', () => {
    expect(() => formatFrame('bad\rname', { x: 1 })).toThrow(/forbidden character/i);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// formatHeartbeat — comment-frame shape
// ───────────────────────────────────────────────────────────────────────────

describe('formatHeartbeat', () => {
  it('emits a comment line followed by the frame terminator', () => {
    expect(formatHeartbeat()).toBe(': heartbeat\n\n');
  });

  it('starts with a colon (SSE comment marker — ignored by EventSource)', () => {
    expect(formatHeartbeat().startsWith(':')).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// encodeFrame / toFrameBytes — UTF-8 byte fidelity
// ───────────────────────────────────────────────────────────────────────────

describe('encodeFrame', () => {
  it('produces a Uint8Array', () => {
    const bytes = encodeFrame('event: x\ndata: 1\n\n');
    expect(bytes).toBeInstanceOf(Uint8Array);
  });

  it('round-trips through TextDecoder', () => {
    const frame = formatFrame('round-trip', { v: 'πάντα ῥεῖ' });
    const bytes = encodeFrame(frame);
    const decoded = new TextDecoder('utf-8').decode(bytes);
    expect(decoded).toBe(frame);
  });

  it('uses UTF-8 multi-byte encoding for non-ASCII payload', () => {
    // "é" = U+00E9 = 0xC3 0xA9 in UTF-8 (2 bytes). Sanity check that we're
    // not silently latin-1 encoding (which would emit 0xE9 — 1 byte).
    const frame = formatFrame('e', 'é');
    const bytes = encodeFrame(frame);
    // Locate the 'é' bytes near the end of the data: line. The full pattern
    // `data: "é"` becomes `data: "` (7 bytes) + 0xC3 0xA9 + `"\n\n` (3 bytes).
    // Easier check: assert 0xC3 byte appears somewhere in the array.
    expect(Array.from(bytes)).toContain(0xc3);
    expect(Array.from(bytes)).toContain(0xa9);
  });
});

describe('toFrameBytes', () => {
  it('matches the byte output of encodeFrame(formatFrame(...))', () => {
    const event = 'cost-update';
    const data = { spentUsd: 0.0123, capUsd: 1.0, pct: 1 };
    const combined = toFrameBytes(event, data);
    const stepwise = encodeFrame(formatFrame(event, data));
    expect(Array.from(combined)).toEqual(Array.from(stepwise));
  });
});
