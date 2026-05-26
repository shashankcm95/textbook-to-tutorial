// src/components/__tests__/CostChip.bands.test.ts
//
// Persona-review 2026-05-26 (Riley/Priya): the cost chip used to turn amber
// at 50% and red at 80%, painting normal reading sessions in anxiety colors.
// New thresholds keep it calm until the user is genuinely close to the cap.
//
// Pure-function tests on `pickBand`. The full chip's render path (with
// tooltip + aria-label) is integration-tested through the live app.

import { describe, it, expect } from 'vitest';
import { pickBand } from '../CostChip';

describe('CostChip pickBand — new thresholds (persona-review 2026-05-26)', () => {
  it('stays in safe band through 84% of the cap', () => {
    expect(pickBand(0)).toBe('safe');
    expect(pickBand(0.5)).toBe('safe');
    expect(pickBand(0.84)).toBe('safe');
  });

  it('crosses to warn band at 85% of the cap', () => {
    expect(pickBand(0.85)).toBe('warn');
    expect(pickBand(0.94)).toBe('warn');
  });

  it('crosses to danger band only at 95% of the cap', () => {
    expect(pickBand(0.95)).toBe('danger');
    expect(pickBand(1.0)).toBe('danger');
    expect(pickBand(1.5)).toBe('danger'); // overshoot is visible, still danger.
  });

  it('does not paint normal reading sessions in danger colors', () => {
    // The whole point of the threshold bump: 70% spend should look CALM,
    // not anxiety-coded. Was 'warn' (amber) pre-fix; should be 'safe' now.
    expect(pickBand(0.7)).toBe('safe');
  });
});
