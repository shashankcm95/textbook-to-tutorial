// src/lib/eval/__tests__/variant.test.ts
//
// Tests for the variant manifest model + apply/revert plumbing. All file I/O
// is scoped to an os.tmpdir() sandbox so this never touches the real repo.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  VariantManifestSchema,
  readVariantManifest,
  applyVariant,
  revertVariant,
  requireTutorialIdForDbMode,
  type VariantManifest,
} from '../variant';

let sandbox: string;

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'ttt-eval-variant-'));
});

afterEach(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
});

describe('VariantManifestSchema', () => {
  it('parses a minimal manifest with default chapter_range', () => {
    const parsed = VariantManifestSchema.parse({
      name: 'v3',
      tutorial_id: 'abc',
    });
    expect(parsed.name).toBe('v3');
    expect(parsed.tutorial_id).toBe('abc');
    expect(parsed.chapter_range).toEqual([0, 5]);
  });

  it('rejects names with unsafe characters', () => {
    expect(() =>
      VariantManifestSchema.parse({ name: 'v3 with spaces', tutorial_id: 'a' }),
    ).toThrow();
  });

  it('rejects chapter_range with start > end', () => {
    expect(() =>
      VariantManifestSchema.parse({
        name: 'v3',
        tutorial_id: 'a',
        chapter_range: [5, 2],
      }),
    ).toThrow();
  });

  // Sprint E Tier 2 (2026-05-24): tutorial_id is now optional at the schema
  // level — required only at runtime in db mode (see requireTutorialIdForDbMode
  // tests below). Round-3 PoC dogfood found duplicating tutorial_id across
  // both variants purely to satisfy the schema was a footgun in fs mode.
  it('accepts a manifest WITHOUT tutorial_id (fs mode use case)', () => {
    const parsed = VariantManifestSchema.parse({
      name: 'fs-only-variant',
      chapter_range: [0, 3],
    });
    expect(parsed.name).toBe('fs-only-variant');
    expect(parsed.tutorial_id).toBeUndefined();
    expect(parsed.chapter_range).toEqual([0, 3]);
  });
});

describe('requireTutorialIdForDbMode', () => {
  it('returns the tutorial_id when present', () => {
    const variant: VariantManifest = {
      name: 'v',
      tutorial_id: 'tut-abc',
      chapter_range: [0, 0],
    };
    expect(requireTutorialIdForDbMode(variant)).toBe('tut-abc');
  });

  it('throws a clear error naming the variant when tutorial_id is absent', () => {
    const variant: VariantManifest = {
      name: 'fs-variant',
      chapter_range: [0, 0],
    };
    expect(() => requireTutorialIdForDbMode(variant)).toThrow(
      /fs-variant.*tutorial_id.*--narratives-from=db/s,
    );
  });
});

describe('readVariantManifest', () => {
  it('reads + validates from disk', () => {
    const file = path.join(sandbox, 'v3.json');
    fs.writeFileSync(
      file,
      JSON.stringify({
        name: 'v3',
        tutorial_id: 'abc',
        chapter_range: [0, 5],
      }),
    );
    const m = readVariantManifest(file);
    expect(m.name).toBe('v3');
  });
});

describe('applyVariant + revertVariant — prompt overrides', () => {
  it('round-trips a prompt override: applies, then revertVariant restores original contents', () => {
    // Set up a fake repo root with a source file and an override file.
    const repoRoot = sandbox;
    const srcRel = 'src/prompts/p.ts';
    const overrideRel = 'overrides/p.ts';
    const srcAbs = path.join(repoRoot, srcRel);
    const overrideAbs = path.join(repoRoot, overrideRel);
    fs.mkdirSync(path.dirname(srcAbs), { recursive: true });
    fs.mkdirSync(path.dirname(overrideAbs), { recursive: true });
    fs.writeFileSync(srcAbs, 'ORIGINAL CONTENT');
    fs.writeFileSync(overrideAbs, 'OVERRIDE CONTENT');

    const variant: VariantManifest = {
      name: 'override-test',
      tutorial_id: 't',
      chapter_range: [0, 0],
      prompt_overrides: { [srcRel]: overrideRel },
    };

    const applied = applyVariant(variant, repoRoot);
    expect(fs.readFileSync(srcAbs, 'utf8')).toBe('OVERRIDE CONTENT');

    revertVariant(applied);
    expect(fs.readFileSync(srcAbs, 'utf8')).toBe('ORIGINAL CONTENT');
  });

  it('throws when prompt_overrides source file is missing', () => {
    const variant: VariantManifest = {
      name: 'missing-src',
      tutorial_id: 't',
      chapter_range: [0, 0],
      prompt_overrides: { 'dest.ts': 'does-not-exist.ts' },
    };
    expect(() => applyVariant(variant, sandbox)).toThrow(/not found/);
  });

  it('removes files that did not exist before when reverting', () => {
    const repoRoot = sandbox;
    const overrideRel = 'overrides/new.ts';
    const overrideAbs = path.join(repoRoot, overrideRel);
    fs.mkdirSync(path.dirname(overrideAbs), { recursive: true });
    fs.writeFileSync(overrideAbs, 'NEW');

    const destRel = 'src/new.ts';
    const destAbs = path.join(repoRoot, destRel);
    // dest does NOT exist before apply.
    expect(fs.existsSync(destAbs)).toBe(false);

    const variant: VariantManifest = {
      name: 'create-new',
      tutorial_id: 't',
      chapter_range: [0, 0],
      prompt_overrides: { [destRel]: overrideRel },
    };
    const applied = applyVariant(variant, repoRoot);
    expect(fs.existsSync(destAbs)).toBe(true);

    revertVariant(applied);
    expect(fs.existsSync(destAbs)).toBe(false);
  });
});

describe('applyVariant + revertVariant — env mutations', () => {
  it('round-trips env mutations and restores absent keys', () => {
    const key = '__TTT_TEST_VAR_DO_NOT_USE__';
    expect(process.env[key]).toBeUndefined();

    const applied = applyVariant(
      {
        name: 'env-test',
        tutorial_id: 't',
        chapter_range: [0, 0],
        env: { [key]: 'value-during-run' },
      },
      sandbox,
    );
    expect(process.env[key]).toBe('value-during-run');

    revertVariant(applied);
    expect(process.env[key]).toBeUndefined();
  });

  it('restores prior values when key was already set', () => {
    const key = '__TTT_TEST_VAR2_DO_NOT_USE__';
    process.env[key] = 'original';
    try {
      const applied = applyVariant(
        {
          name: 'env-test2',
          tutorial_id: 't',
          chapter_range: [0, 0],
          env: { [key]: 'override' },
        },
        sandbox,
      );
      expect(process.env[key]).toBe('override');
      revertVariant(applied);
      expect(process.env[key]).toBe('original');
    } finally {
      delete process.env[key];
    }
  });
});

describe('applyVariant — git_ref not yet implemented', () => {
  it('throws a clear message when git_ref is set', () => {
    expect(() =>
      applyVariant(
        {
          name: 'gitref',
          tutorial_id: 't',
          chapter_range: [0, 0],
          git_ref: 'abcd1234',
        },
        sandbox,
      ),
    ).toThrow(/git_ref/);
  });
});
