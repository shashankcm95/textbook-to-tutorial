// src/lib/__tests__/log.test.ts
//
// Tests for the structured event logger.
//
// Two test surfaces:
//   1. Pure: `normalizeError` and `todaysLogFile` (no I/O).
//   2. I/O: the file-sink path, exercised against a tempdir via the
//      `LOG_DIR` env var. Each test points LOG_DIR somewhere unique and
//      cleans up after itself.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  logger,
  normalizeError,
  todaysLogFile,
  __test_only,
} from '../log';

// ─────────────────────────────────────────────────────────────────────────────
// normalizeError (pure)
// ─────────────────────────────────────────────────────────────────────────────

describe('normalizeError', () => {
  it('unwraps a plain Error into { message, stack, name }', () => {
    const e = new Error('boom');
    const out = normalizeError(e);
    expect(out.message).toBe('boom');
    expect(out.name).toBe('Error');
    expect(typeof out.stack).toBe('string');
  });

  it('preserves a `code` field on subclassed errors (e.g. SDK errors)', () => {
    class CodedError extends Error {
      code = 'NoSuchKey';
    }
    const out = normalizeError(new CodedError('object missing'));
    expect(out.code).toBe('NoSuchKey');
    expect(out.message).toBe('object missing');
  });

  it('wraps a string as { message: <string> }', () => {
    expect(normalizeError('plain string error')).toEqual({
      message: 'plain string error',
    });
  });

  it('stringifies unknown shapes (objects, numbers)', () => {
    expect(normalizeError({ weird: true })).toEqual({
      message: '[object Object]',
    });
    expect(normalizeError(42)).toEqual({ message: '42' });
  });

  it('does not include undefined fields in the output', () => {
    // Bare Error subclass without `code` — the field should be omitted,
    // not serialized as null.
    const e = new Error('plain');
    const out = normalizeError(e);
    expect('code' in out).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// todaysLogFile (pure)
// ─────────────────────────────────────────────────────────────────────────────

describe('todaysLogFile', () => {
  it('builds a YYYY-MM-DD.jsonl path under LOG_DIR (or default ./logs)', () => {
    const originalLogDir = process.env.LOG_DIR;
    process.env.LOG_DIR = '/tmp/test-logs';
    try {
      const f = todaysLogFile(new Date('2026-05-27T18:39:28Z'));
      expect(f).toBe('/tmp/test-logs/2026-05-27.jsonl');
    } finally {
      if (originalLogDir === undefined) delete process.env.LOG_DIR;
      else process.env.LOG_DIR = originalLogDir;
    }
  });

  it('uses UTC date components (not local) for cross-tz stability', () => {
    process.env.LOG_DIR = '/tmp/test-logs';
    // 2026-01-01T00:30:00Z = 2025-12-31 in some local zones, but UTC says 01-01.
    const f = todaysLogFile(new Date('2026-01-01T00:30:00Z'));
    expect(f).toContain('2026-01-01.jsonl');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// File sink + console mirror (I/O)
// ─────────────────────────────────────────────────────────────────────────────

describe('logger file sink', () => {
  let tmpDir: string;
  let origLogDir: string | undefined;
  let origDisable: string | undefined;
  // Spy on console methods so we can assert mirror behavior + suppress noise.
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'log-test-'));
    origLogDir = process.env.LOG_DIR;
    origDisable = process.env.DISABLE_FILE_LOG;
    process.env.LOG_DIR = tmpDir;
    delete process.env.DISABLE_FILE_LOG;
    __test_only.resetDirCache();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    if (origLogDir === undefined) delete process.env.LOG_DIR;
    else process.env.LOG_DIR = origLogDir;
    if (origDisable === undefined) delete process.env.DISABLE_FILE_LOG;
    else process.env.DISABLE_FILE_LOG = origDisable;
    logSpy.mockRestore();
    warnSpy.mockRestore();
    errSpy.mockRestore();
  });

  function readTodayLog(): string[] {
    const files = readdirSync(tmpDir).filter((f) => f.endsWith('.jsonl'));
    if (files.length === 0) return [];
    const raw = readFileSync(path.join(tmpDir, files[0]!), 'utf8');
    return raw.trim().split('\n').filter((l) => l.length > 0);
  }

  it('writes one JSONL line per call', () => {
    logger.info('test.event', { foo: 'bar' });
    const lines = readTodayLog();
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(parsed.event).toBe('test.event');
    expect(parsed.level).toBe('info');
    expect(parsed.foo).toBe('bar');
    expect(typeof parsed.ts).toBe('string');
  });

  it('appends successive calls to the same file', () => {
    logger.info('first');
    logger.warn('second', { ctx: 1 });
    logger.error('third', { ctx: 2 });
    const lines = readTodayLog();
    expect(lines).toHaveLength(3);
    const events = lines.map((l) => (JSON.parse(l) as { event: string }).event);
    expect(events).toEqual(['first', 'second', 'third']);
  });

  it('routes warn to console.warn and error to console.error (mirror)', () => {
    logger.warn('warn.test');
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(errSpy).not.toHaveBeenCalled();

    logger.error('error.test');
    expect(errSpy).toHaveBeenCalledTimes(1);
  });

  it('unwraps an Error in the `err` field', () => {
    logger.warn('failure.observed', {
      tutorialId: 'tut-123',
      err: new Error('thing broke'),
    });
    const lines = readTodayLog();
    const parsed = JSON.parse(lines[0]!) as { err: { message: string; stack: string } };
    expect(parsed.err.message).toBe('thing broke');
    expect(typeof parsed.err.stack).toBe('string');
  });

  it('creates the log directory on first write if missing', () => {
    const nested = path.join(tmpDir, 'nested', 'deep');
    process.env.LOG_DIR = nested;
    __test_only.resetDirCache();
    expect(existsSync(nested)).toBe(false);
    logger.info('first.line');
    expect(existsSync(nested)).toBe(true);
  });

  it('suppresses file writes when DISABLE_FILE_LOG=1 (mirror still fires)', () => {
    process.env.DISABLE_FILE_LOG = '1';
    logger.info('disabled.test');
    expect(readTodayLog()).toHaveLength(0);
    expect(logSpy).toHaveBeenCalledTimes(1);
  });
});
