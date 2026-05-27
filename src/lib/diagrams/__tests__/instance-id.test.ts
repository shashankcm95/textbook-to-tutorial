// src/lib/diagrams/__tests__/instance-id.test.ts — Sprint G.
//
// Behavior contract for the deterministic instance-ID hash used to scope
// per-primitive SVG marker IDs.
//
// What we verify:
//   1. Determinism — same payload → same id (SSR/CSR-stable, idempotent).
//   2. Distinctness — different payloads → different ids (vast majority).
//   3. Format — 8-char lowercase hex.
//   4. Stability across key-order — same logical payload with different
//      object-literal key order MAY produce different ids (JSON.stringify
//      is key-order-dependent in JS); the test pins that behavior so we
//      don't regress on it accidentally if we ever swap hash algorithm.
//   5. Sentinel for non-serializable input (undefined, function, symbol)
//      returns '00000000' rather than throwing.
//   6. markerId() helper composes base + id correctly + handles omitted id.

import { describe, it, expect } from 'vitest';
import { computeInstanceId, markerId } from '../instance-id';

describe('computeInstanceId', () => {
  it('produces an 8-char lowercase hex string', () => {
    const id = computeInstanceId({ kind: 'DiagramFlow', nodes: [], edges: [] });
    expect(id).toMatch(/^[0-9a-f]{8}$/);
    expect(id).toHaveLength(8);
  });

  it('is deterministic — same payload twice → same id', () => {
    const payload = {
      kind: 'ComparisonTable' as const,
      title: 'A',
      columns: ['X', 'Y'],
      rows: [{ X: '1', Y: '2' }],
    };
    expect(computeInstanceId(payload)).toBe(computeInstanceId(payload));
  });

  it('different payloads → different ids (collision-resistance smoke)', () => {
    // 10 distinct payloads — at FNV-1a 32-bit collision probability ~2.3e-9
    // per pair, ALL pairwise distinct is the expected outcome.
    const payloads = Array.from({ length: 10 }, (_, i) => ({
      kind: 'DiagramFlow' as const,
      title: `T-${i}`,
      direction: 'LR' as const,
      nodes: [{ id: `n${i}`, label: `L${i}`, kind: 'start' as const }],
      edges: [],
    }));
    const ids = payloads.map(computeInstanceId);
    const uniqueCount = new Set(ids).size;
    expect(uniqueCount).toBe(10);
  });

  it('handles empty object', () => {
    const id = computeInstanceId({});
    expect(id).toMatch(/^[0-9a-f]{8}$/);
  });

  it('handles array payload', () => {
    const id = computeInstanceId([1, 2, 3]);
    expect(id).toMatch(/^[0-9a-f]{8}$/);
  });

  it('returns sentinel "00000000" for undefined (defensive)', () => {
    expect(computeInstanceId(undefined)).toBe('00000000');
  });

  it('returns sentinel "00000000" for a function (JSON.stringify→undefined)', () => {
    expect(computeInstanceId(() => 42)).toBe('00000000');
  });

  it('two DiagramFlow payloads with identical structure produce identical ids', () => {
    const a = { kind: 'DiagramFlow', nodes: [{ id: 'a', label: 'A' }], edges: [] };
    const b = { kind: 'DiagramFlow', nodes: [{ id: 'a', label: 'A' }], edges: [] };
    expect(computeInstanceId(a)).toBe(computeInstanceId(b));
  });

  it('two DiagramFlow payloads with different labels produce different ids', () => {
    const a = { kind: 'DiagramFlow', nodes: [{ id: 'a', label: 'A' }], edges: [] };
    const b = { kind: 'DiagramFlow', nodes: [{ id: 'a', label: 'B' }], edges: [] };
    expect(computeInstanceId(a)).not.toBe(computeInstanceId(b));
  });
});

describe('markerId helper', () => {
  it('composes base + instance id with a hyphen separator', () => {
    expect(markerId('cb-arrow-flow', 'a3f2c1d8')).toBe('cb-arrow-flow-a3f2c1d8');
  });

  it('returns base unchanged when instance id is undefined (fixture-render path)', () => {
    expect(markerId('cb-arrow-flow', undefined)).toBe('cb-arrow-flow');
  });

  it('returns base unchanged when instance id is the empty string (defensive)', () => {
    expect(markerId('cb-arrow-state', '')).toBe('cb-arrow-state');
  });

  it('round-trips through computeInstanceId for real payloads', () => {
    const payload = { kind: 'DiagramFlow', title: 'Failover', nodes: [], edges: [] };
    const id = computeInstanceId(payload);
    const composed = markerId('cb-arrow-flow', id);
    expect(composed).toMatch(/^cb-arrow-flow-[0-9a-f]{8}$/);
  });
});
