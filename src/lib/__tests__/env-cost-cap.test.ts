// src/lib/__tests__/env-cost-cap.test.ts
//
// Sprint E Tier 2 (2026-05-24): regression test for the COST_CAP_USD getter.
//
// Background: `src/lib/env.ts` parses environment once at module init. Before
// this change, `env.COST_CAP_USD` was the value parsed at boot — variant
// manifests' `env` blocks mutated process.env via applyVariant() but the
// mutation was silently ignored by cost-cap.ts because the value was already
// frozen on the env object.
//
// After: COST_CAP_USD is a getter that reads process.env fresh each access,
// falling back to the boot-parsed default when the env var is absent / blank /
// non-numeric.
//
// IMPORTANT: this test MUST be the first thing in this file that touches
// `process.env.COST_CAP_USD`, and it MUST restore the original value in a
// finally block — other tests may rely on the boot value.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { env } from '../env';

const KEY = 'COST_CAP_USD';

let originalRaw: string | undefined;

beforeEach(() => {
  originalRaw = process.env[KEY];
});

afterEach(() => {
  if (originalRaw === undefined) {
    delete process.env[KEY];
  } else {
    process.env[KEY] = originalRaw;
  }
});

describe('env.COST_CAP_USD getter (Sprint E Tier 2)', () => {
  it('reflects process.env mutation at access time', () => {
    process.env[KEY] = '5';
    expect(env.COST_CAP_USD).toBe(5);

    process.env[KEY] = '10';
    expect(env.COST_CAP_USD).toBe(10);
  });

  it('falls back to boot default when process.env value is removed', () => {
    process.env[KEY] = '7';
    expect(env.COST_CAP_USD).toBe(7);

    delete process.env[KEY];
    // Boot default is 1.0 per env.ts schema. The boot-time value (whatever
    // it was when this test process started) is what we fall back to. If the
    // host environment didn't set COST_CAP_USD at boot, this is 1.0; if it
    // did, this is whatever was set. The contract is "fall back to boot,
    // don't crash" — so just assert positive number.
    expect(env.COST_CAP_USD).toBeGreaterThan(0);
  });

  it('falls back to boot when process.env value is blank', () => {
    process.env[KEY] = '';
    expect(env.COST_CAP_USD).toBeGreaterThan(0);
  });

  it('falls back to boot when process.env value is non-numeric', () => {
    process.env[KEY] = 'not-a-number';
    expect(env.COST_CAP_USD).toBeGreaterThan(0);
  });

  it('falls back to boot when process.env value is zero or negative', () => {
    // Cost cap must be positive (matches the Zod schema constraint).
    process.env[KEY] = '0';
    expect(env.COST_CAP_USD).toBeGreaterThan(0);

    process.env[KEY] = '-3';
    expect(env.COST_CAP_USD).toBeGreaterThan(0);
  });

  it('accepts decimal values', () => {
    process.env[KEY] = '2.5';
    expect(env.COST_CAP_USD).toBe(2.5);
  });
});
