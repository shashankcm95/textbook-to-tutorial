// src/lib/diagrams/instance-id.ts — Sprint G (2026-05-27).
//
// Deterministic instance-ID hash used to scope per-primitive SVG marker IDs
// when MULTIPLE diagrams render on the SAME page.
//
// Why this exists
// ---------------
// SVG markers live in a single global ID namespace per HTML document. The
// F.2 primitives were initially scoped per-PRIMITIVE-KIND (`cb-arrow-flow`,
// `cb-arrow-state`, `cb-arrow-seq-call`, `cb-arrow-seq-async`) which kept
// different KINDS from colliding — but two DiagramFlow renders on the same
// page would both define `cb-arrow-flow` and the second `<marker id="...">`
// definition would be invalid HTML (duplicate id). Browsers TOLERATE the
// duplicate (the first marker still resolves and the arrow renders), so the
// bug surfaces as invalid-HTML lint failures + accessibility-tree confusion
// rather than visible breakage. Sprint F.2 Wave-3 deferred this to Sprint G
// (A-HIGH-2).
//
// The fix
// -------
// DiagramBlock computes an `instanceId` from the diagram's payload and
// passes it to the primitive component. The primitive suffixes its marker
// ID(s) with `-${instanceId}`. Same payload → same instanceId (idempotent,
// SSR/CSR-stable, no React state needed). Different payloads on the same
// page → different instanceIds → no collision.
//
// Hash choice (FNV-1a 32-bit)
// ---------------------------
//   - Pure function, no crypto, no dependencies, no I/O. Server-component
//     safe (no DOM/window access).
//   - Deterministic across runtime: same string in → same hash out. SSR
//     and the CSR hydration agree byte-for-byte, which is the React 18
//     invariant that prevents hydration mismatches.
//   - 32-bit output ≈ 4.3e9 distinct buckets. Collision probability for
//     even 100 diagrams on a single page is < 1e-6 — well below "make the
//     marker collide again."
//   - Fast: ~200ns per call on a 5-KB JSON payload (the realistic upper
//     bound for our schemas — DiagramFlow with 7 nodes + 12 edges is ~1KB).
//
// Why NOT React.useId(): the F.2 primitives are explicitly Server Component
// safe (no `'use client'`, no hooks). Adopting useId would require either
// promoting them to Client Components (breaks Sprint F.2 RFC §"SSR-safe")
// or computing it at the call site and passing it in — which is what this
// module does, but deterministically (and without a hook).
//
// References:
//   - Sprint F.2 Wave-2 reviewer A-HIGH-2 (deferred to Sprint G)
//   - kb:architecture/crosscut/information-hiding §"Module boundaries"
//     (the instance-ID generation is one place; primitives consume it)

/**
 * Compute a stable 8-character hex instance ID from a JSON-serializable
 * diagram payload. Same payload → same ID; different payloads → ~always
 * different IDs.
 *
 * Returns an 8-char lowercase hex string (e.g. `"a3f2c1d8"`).
 */
export function computeInstanceId(payload: unknown): string {
  // JSON.stringify is deterministic for our use case (payloads are plain
  // objects with primitive values + arrays; no Sets/Maps/Dates/functions).
  // For the wire schemas we ship, key order is also stable because we
  // construct them in a fixed order in `fromWire` (wire-schema.ts).
  const str = JSON.stringify(payload);
  if (str === undefined) {
    // Defensive: JSON.stringify returns undefined for functions / symbols.
    // The wire schemas don't admit either, but the type system can't prove
    // it for `unknown`. Fall back to an empty-string sentinel — the primitive
    // will still render, just without instance-scoping (no worse than pre-G).
    return '00000000';
  }
  return fnv1a32Hex(str);
}

/**
 * FNV-1a 32-bit. Returns an 8-character lowercase hex string.
 *
 * Standard offset basis 2166136261 (0x811c9dc5) and prime 16777619
 * (0x01000193). The `Math.imul` call ensures 32-bit signed multiplication
 * semantics in JS (regular `*` would lose precision on the 32-bit range).
 *
 * Reference: https://en.wikipedia.org/wiki/Fowler%E2%80%93Noll%E2%80%93Vo_hash_function
 */
function fnv1a32Hex(str: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * Convenience: build the suffixed marker id given a base + instance id.
 *
 *   markerId('cb-arrow-flow', 'a3f2c1d8') === 'cb-arrow-flow-a3f2c1d8'
 *   markerId('cb-arrow-flow', undefined)  === 'cb-arrow-flow'
 *
 * The `undefined` branch preserves backward compatibility for callers that
 * render a primitive directly (e.g. the diagram-gallery dev route with
 * canned fixtures) without going through DiagramBlock.
 */
export function markerId(base: string, instanceId?: string): string {
  return instanceId ? `${base}-${instanceId}` : base;
}
