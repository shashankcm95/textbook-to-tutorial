// src/lib/s3-chunks.ts — read/write chunk artifacts in S3.
//
// The lazy-hybrid-chunking architecture stores per-chapter chunk JSON in S3
// keyed by the source PDF's sha256. Layout under the source bucket:
//
//   parsed/<pdf_sha256>/
//     ├── metadata.json
//     ├── chapters/
//     │   ├── 00.json
//     │   ├── 01.json
//     │   └── …
//     └── glossary.json
//
// Why under the SOURCE PDF's bucket (not a separate bucket):
//   - Same IAM scope already grants read; only write permission to add.
//   - Same region (no cross-region latency for the eventual generation reads).
//   - Same lifecycle policies; operator manages one bucket.
//   - Multi-user cache key is sha256 — identical PDFs hit the same chunks
//     regardless of who uploaded.
//
// Override path: if CHUNKS_S3_BUCKET env is set, write to that bucket instead.
// Reserved for cases where source-PDF bucket is read-only.
//
// Design anchors:
//   - kb:architecture/discipline/error-handling-discipline §"Pattern 1" — let
//     SDK errors propagate to the outer ingest-worker layer (which has context
//     to update tutorials.status='error'). No retry here.
//   - kb:architecture/crosscut/single-responsibility — this module ONLY does
//     S3 I/O for chunk artifacts. Chunker logic lives in chunker.ts; classifier
//     logic in classifier.ts.

import { S3Client, GetObjectCommand, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
import { s3Env } from './env';
import { parseS3Url } from './s3';
import type { SourceParagraph } from './types';
import type { OutlineClassification } from './ingest/classifier';
import type { VoiceProfile } from './ingest/voice-extract';
import type { AnchorWhitelistEntry } from './openai/anchor-validator';

// ───────────────────────────────────────────────────────────────────────────
// On-disk types — what we put in S3
// ───────────────────────────────────────────────────────────────────────────

/**
 * One chunk file (chapters/NN.json). Self-contained: holds the title +
 * paragraphs + provenance the generator needs without any DB round-trip.
 */
export interface ChunkArtifact {
  /** Schema version of this artifact shape; bump on breaking layout change. */
  schemaVersion: 1;
  /** 0-based chunk index, matches chapters.ordinal. */
  idx: number;
  /** Display title (from the outline entry that became this chunk). */
  title: string;
  /** Classification (body/appendix; glossary/skipped don't get a chunk artifact). */
  classification: Extract<OutlineClassification, 'body' | 'appendix'>;
  pageStart: number;
  pageEnd: number;
  /** Outline depth at which this chunk was emitted. */
  depth: number;
  /** Parent chunk idx in the outline tree, or null for top-level chunks. */
  parentIdx: number | null;
  /** The paragraph payload for the generator. */
  paragraphs: SourceParagraph[];
}

/**
 * Top-level metadata.json for the whole parsed PDF. Holds the chunk index
 * (for navigation), the skipped sections (for audit), the glossary count,
 * and provenance fields used for cache invalidation.
 */
export interface MetadataArtifact {
  schemaVersion: 1;
  pdfSha256: string;
  parsedAt: string;
  pageCount: number;
  outlinePresent: boolean;
  chunkerVersion: number;
  classificationVersion: number;
  chunks: Array<{
    idx: number;
    title: string;
    classification: 'body' | 'appendix';
    pageStart: number;
    pageEnd: number;
    paragraphCount: number;
    depth: number;
    parentIdx: number | null;
    s3Key: string;
  }>;
  skipped: Array<{
    title: string;
    classification: 'front-matter' | 'bibliography' | 'glossary' | 'index';
    pageStart: number;
    pageEnd: number;
  }>;
  glossaryAvailable: boolean;
}

/**
 * glossary.json shape. One entry per term extracted from glossary-classified
 * outline entries. v1 ships empty array when no glossary section detected.
 */
export interface GlossaryArtifact {
  schemaVersion: 1;
  terms: Array<{
    term: string;
    definition: string;
    sourceParagraphRef: string;
  }>;
}

/**
 * voice_profile.json — author-voice stylometric fingerprint.
 *
 * Written once per pdf_sha256 by the ingest worker after the voice extractor
 * succeeds. Read once per chapter by the per-chapter generator (Wave 3B) so
 * the prompt can inject a "preservation guide" for the author's distinct
 * rhetorical voice. Absence is fail-open: the generator falls back to the
 * v3 prompt behavior when this artifact doesn't exist.
 *
 * The on-disk shape IS the in-memory VoiceProfile produced by the extractor —
 * no envelope wrapping. The extractor already includes the schema_version,
 * extracted_at, model, cost, sample_size, and sampler_version fields, so the
 * artifact is self-describing without further nesting.
 */
export type VoiceProfileArtifact = VoiceProfile;

/**
 * anchor_whitelist.json — load-bearing technical-anchor whitelist.
 *
 * Written once per pdf_sha256 by the ingest worker after the anchor pre-
 * filter + LLM scorer succeed. Read once per chapter by the per-chapter
 * generator (Wave 3B) for the anchor validator. Absence is fail-open.
 *
 * Envelope wraps the AnchorWhitelistEntry[] with provenance fields
 * (schema_version, extracted_at, model, cost, candidate_count, accepted_count)
 * to match the design doc's example schema and keep the shape forward-
 * compatible. See docs/design/feature-b-voice-and-anchor-profile.md §"Output
 * schema" for the anchor profile.
 */
export interface AnchorWhitelistArtifact {
  schema_version: 1;
  extracted_at: string; // ISO timestamp
  model: string; // e.g. "gpt-4o-mini"
  extraction_cost_usd: number;
  candidate_count: number;
  accepted_count: number;
  anchors: AnchorWhitelistEntry[];
}

// ───────────────────────────────────────────────────────────────────────────
// Path helpers
// ───────────────────────────────────────────────────────────────────────────

/**
 * Build the canonical S3 prefix for a parsed PDF.
 * Returns just the prefix (without trailing slash):  `parsed/<sha256>`
 */
export function chunksPrefix(pdfSha256: string): string {
  if (!/^[0-9a-f]{64}$/i.test(pdfSha256)) {
    throw new Error(`chunksPrefix: invalid sha256 ${JSON.stringify(pdfSha256)}`);
  }
  return `parsed/${pdfSha256.toLowerCase()}`;
}

export function metadataKey(pdfSha256: string): string {
  return `${chunksPrefix(pdfSha256)}/metadata.json`;
}

export function chapterKey(pdfSha256: string, idx: number): string {
  if (!Number.isInteger(idx) || idx < 0) {
    throw new Error(`chapterKey: idx must be non-negative integer, got ${idx}`);
  }
  return `${chunksPrefix(pdfSha256)}/chapters/${String(idx).padStart(2, '0')}.json`;
}

export function glossaryKey(pdfSha256: string): string {
  return `${chunksPrefix(pdfSha256)}/glossary.json`;
}

export function voiceProfileKey(pdfSha256: string): string {
  return `${chunksPrefix(pdfSha256)}/voice_profile.json`;
}

export function anchorWhitelistKey(pdfSha256: string): string {
  return `${chunksPrefix(pdfSha256)}/anchor_whitelist.json`;
}

// ───────────────────────────────────────────────────────────────────────────
// Client construction (mirrors src/lib/s3.ts pattern)
// ───────────────────────────────────────────────────────────────────────────

function buildClient() {
  const cfg = s3Env();
  return new S3Client({
    region: cfg.AWS_REGION,
    credentials: {
      accessKeyId: cfg.AWS_ACCESS_KEY_ID,
      secretAccessKey: cfg.AWS_SECRET_ACCESS_KEY,
    },
  });
}

/**
 * Resolve the bucket name to write chunks into. Defaults to extracting the
 * bucket from the source PDF's s3:// URL (so chunks live next to the source).
 * Override via env CHUNKS_S3_BUCKET when source bucket is read-only.
 */
export function resolveChunksBucket(sourcePdfS3Url: string): string {
  const override = process.env.CHUNKS_S3_BUCKET;
  if (typeof override === 'string' && override.trim().length > 0) {
    return override.trim();
  }
  return parseS3Url(sourcePdfS3Url).bucket;
}

// ───────────────────────────────────────────────────────────────────────────
// Write helpers
// ───────────────────────────────────────────────────────────────────────────

export class S3ChunkWriteError extends Error {
  constructor(
    message: string,
    public readonly bucket: string,
    public readonly key: string,
    public override readonly cause?: unknown,
  ) {
    super(`s3 chunk write failed: ${message} (bucket=${bucket}, key=${key})`);
    this.name = 'S3ChunkWriteError';
  }
}

async function putJson(bucket: string, key: string, body: unknown): Promise<void> {
  const client = buildClient();
  try {
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: JSON.stringify(body),
        ContentType: 'application/json',
        // ServerSideEncryption omitted — relies on bucket default if any.
      }),
    );
  } catch (err) {
    throw new S3ChunkWriteError(`sdk send failed: ${(err as Error).message}`, bucket, key, err);
  }
}

export async function writeChunk(
  bucket: string,
  pdfSha256: string,
  chunk: ChunkArtifact,
): Promise<{ s3Key: string }> {
  const key = chapterKey(pdfSha256, chunk.idx);
  await putJson(bucket, key, chunk);
  return { s3Key: key };
}

export async function writeMetadata(
  bucket: string,
  pdfSha256: string,
  metadata: MetadataArtifact,
): Promise<{ s3Key: string }> {
  const key = metadataKey(pdfSha256);
  await putJson(bucket, key, metadata);
  return { s3Key: key };
}

export async function writeGlossary(
  bucket: string,
  pdfSha256: string,
  glossary: GlossaryArtifact,
): Promise<{ s3Key: string }> {
  const key = glossaryKey(pdfSha256);
  await putJson(bucket, key, glossary);
  return { s3Key: key };
}

/**
 * Write the author-voice profile to S3 as voice_profile.json.
 *
 * Returns the resolved S3 key + sha256 hash of the serialized JSON body
 * (useful for tracing / cache audit; not load-bearing on the read path).
 *
 * Throws S3ChunkWriteError on PUT failure — caller decides fail-open. Per
 * the worker.ts contract, voice extraction is fail-open: a write failure
 * here is logged + swallowed so tutorial ingest can still complete.
 */
export async function writeVoiceProfile(args: {
  bucket: string;
  pdfSha256: string;
  profile: VoiceProfileArtifact;
}): Promise<{ s3Key: string; contentHash: string }> {
  const { bucket, pdfSha256, profile } = args;
  const key = voiceProfileKey(pdfSha256);
  const body = JSON.stringify(profile);
  const contentHash = createHash('sha256').update(body).digest('hex');
  await putJson(bucket, key, profile);
  return { s3Key: key, contentHash };
}

/**
 * Write the anchor whitelist to S3 as anchor_whitelist.json.
 *
 * Wraps the AnchorWhitelistEntry[] in an envelope with provenance fields
 * (schema_version, extracted_at, model, costs, counts). See
 * AnchorWhitelistArtifact for the on-disk shape.
 *
 * Returns the resolved S3 key + sha256 hash of the serialized JSON body.
 * Throws S3ChunkWriteError on PUT failure — fail-open at the worker layer.
 */
export async function writeAnchorWhitelist(args: {
  bucket: string;
  pdfSha256: string;
  whitelist: AnchorWhitelistArtifact;
}): Promise<{ s3Key: string; contentHash: string }> {
  const { bucket, pdfSha256, whitelist } = args;
  const key = anchorWhitelistKey(pdfSha256);
  const body = JSON.stringify(whitelist);
  const contentHash = createHash('sha256').update(body).digest('hex');
  await putJson(bucket, key, whitelist);
  return { s3Key: key, contentHash };
}

// ───────────────────────────────────────────────────────────────────────────
// Read helpers — multi-user cache hit path
// ───────────────────────────────────────────────────────────────────────────

export class S3ChunkReadError extends Error {
  constructor(
    message: string,
    public readonly bucket: string,
    public readonly key: string,
    public override readonly cause?: unknown,
  ) {
    super(`s3 chunk read failed: ${message} (bucket=${bucket}, key=${key})`);
    this.name = 'S3ChunkReadError';
  }
}

/**
 * Returns true if the object exists. Used to skip re-parsing on cache hits.
 *
 * AWS quirk: a HEAD on a missing object returns 404 ("NotFound") when the
 * caller has `s3:ListBucket` permission; without it, S3 returns **403**
 * (Forbidden) to obscure object existence. We can't distinguish "missing
 * object, no ListBucket" from "object exists, no GetObject" — both look
 * like a 403 with no specific error code.
 *
 * Resolution policy:
 *   - 404 / NotFound / NoSuchKey → cache miss (object doesn't exist)
 *   - 403 (without specific code) → ALSO treat as cache miss. Safe because:
 *       (a) if the object actually exists, the subsequent PUT will overwrite
 *           it (idempotent — chunks are content-addressed by sha256)
 *       (b) if the object doesn't exist, we correctly proceed to write
 *       (c) if PUT is also denied, the user gets a clear PutObject 403
 *   - any other error → re-raise (real failure: throttle, network, etc.)
 *
 * The full IAM grant that avoids the 403-ambiguity is documented in
 * .env.example (s3:ListBucket on the bucket + GetObject/PutObject on /parsed/*).
 */
export async function chunksExist(bucket: string, pdfSha256: string): Promise<boolean> {
  const client = buildClient();
  const key = metadataKey(pdfSha256);
  try {
    await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch (err) {
    const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
    const code = e.name;
    if (code === 'NotFound' || code === 'NoSuchKey') return false;
    const status = e.$metadata?.httpStatusCode;
    if (status === 403 || status === 404) {
      // Ambiguous 403 (or rare 404 without specific name). Per the policy
      // above: treat as cache miss + log so operators can spot the
      // permission gap when latency or write-overhead matters.
      // eslint-disable-next-line no-console
      console.warn(
        `[s3-chunks] HEAD ${key} returned ${status}; treating as cache miss. ` +
          `Grant s3:ListBucket to enable cleaner cache-hit semantics.`,
      );
      return false;
    }
    // Other errors (network, throttle, real auth failure): re-raise.
    throw new S3ChunkReadError(`HEAD failed: ${(err as Error).message}`, bucket, key, err);
  }
}

async function getJson<T>(bucket: string, key: string): Promise<T> {
  const client = buildClient();
  let resp;
  try {
    resp = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  } catch (err) {
    throw new S3ChunkReadError(`sdk send failed: ${(err as Error).message}`, bucket, key, err);
  }
  if (!resp.Body) throw new S3ChunkReadError('response body empty', bucket, key);
  const text = await streamToString(resp.Body as Readable);
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    throw new S3ChunkReadError(
      `json parse failed: ${(err as Error).message}`,
      bucket,
      key,
      err,
    );
  }
}

export async function readMetadata(
  bucket: string,
  pdfSha256: string,
): Promise<MetadataArtifact> {
  return getJson<MetadataArtifact>(bucket, metadataKey(pdfSha256));
}

export async function readChunk(
  bucket: string,
  pdfSha256: string,
  idx: number,
): Promise<ChunkArtifact> {
  return getJson<ChunkArtifact>(bucket, chapterKey(pdfSha256, idx));
}

export async function readGlossary(
  bucket: string,
  pdfSha256: string,
): Promise<GlossaryArtifact> {
  return getJson<GlossaryArtifact>(bucket, glossaryKey(pdfSha256));
}

/**
 * Read the author-voice profile from S3. Returns `null` on cache miss
 * (404 / NoSuchKey / ambiguous 403 — same policy as `chunksExist`).
 *
 * Callers (Wave 3B's per-chapter.ts) are required to gracefully degrade
 * when the profile is absent — the v3 prompt path continues to work.
 *
 * Other errors (network, throttle, real auth failure on a bucket the
 * caller can otherwise list) propagate as S3ChunkReadError so the caller
 * sees a real problem rather than a silent miss.
 */
export async function readVoiceProfile(args: {
  bucket: string;
  pdfSha256: string;
}): Promise<VoiceProfileArtifact | null> {
  const { bucket, pdfSha256 } = args;
  return getJsonOrNull<VoiceProfileArtifact>(bucket, voiceProfileKey(pdfSha256));
}

/**
 * Read the anchor whitelist from S3. Returns the `anchors` array on a hit
 * (unwrapping the on-disk envelope) or `null` on cache miss (same policy
 * as `readVoiceProfile`).
 *
 * Why we unwrap here rather than returning the full envelope: the
 * downstream consumer (Wave 3B per-chapter.ts) feeds the result directly
 * into `validateAnchors`, which takes an `AnchorWhitelistEntry[]`. The
 * envelope's provenance fields (model, cost, counts) are write-time
 * metadata — they don't change the read-time API surface. If a future
 * consumer needs the envelope, expose a `readAnchorWhitelistArtifact`
 * sibling that returns the full `AnchorWhitelistArtifact`.
 *
 * Backward-compat note: if a pre-Wave-3 artifact happens to be a bare
 * array on disk (no envelope), we still accept it — the unwrap is
 * defensive.
 */
export async function readAnchorWhitelist(args: {
  bucket: string;
  pdfSha256: string;
}): Promise<AnchorWhitelistEntry[] | null> {
  const { bucket, pdfSha256 } = args;
  const raw = await getJsonOrNull<AnchorWhitelistArtifact | AnchorWhitelistEntry[]>(
    bucket,
    anchorWhitelistKey(pdfSha256),
  );
  if (raw === null) return null;
  if (Array.isArray(raw)) return raw;
  return raw.anchors ?? [];
}

/**
 * Wrapper around getJson that converts a "not present" S3 response into
 * `null` instead of throwing. Mirrors the cache-miss policy of
 * `chunksExist`: 404 / NoSuchKey AND ambiguous 403 (no s3:ListBucket
 * grant) both surface as null + a one-line warning.
 *
 * Real failures (network, throttle, malformed JSON in an existing object)
 * still throw S3ChunkReadError so the caller can distinguish "miss" from
 * "broken cache entry" — only the latter merits a retry / re-extraction.
 */
async function getJsonOrNull<T>(bucket: string, key: string): Promise<T | null> {
  const client = buildClient();
  let resp;
  try {
    resp = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  } catch (err) {
    const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
    const code = e.name;
    if (code === 'NotFound' || code === 'NoSuchKey') return null;
    const status = e.$metadata?.httpStatusCode;
    if (status === 404) return null;
    if (status === 403) {
      // Ambiguous 403 — mirrors the chunksExist policy. Treat as cache
      // miss + log so operators can spot a permission gap.
      // eslint-disable-next-line no-console
      console.warn(
        `[s3-chunks] GET ${key} returned 403; treating as cache miss. ` +
          `Grant s3:ListBucket + GetObject on /parsed/* to enable cleaner cache-hit semantics.`,
      );
      return null;
    }
    throw new S3ChunkReadError(`sdk send failed: ${(err as Error).message}`, bucket, key, err);
  }
  if (!resp.Body) throw new S3ChunkReadError('response body empty', bucket, key);
  const text = await streamToString(resp.Body as Readable);
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    throw new S3ChunkReadError(
      `json parse failed: ${(err as Error).message}`,
      bucket,
      key,
      err,
    );
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Helpers (file-private)
// ───────────────────────────────────────────────────────────────────────────

async function streamToString(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunkRaw of stream) {
    const chunk = Buffer.isBuffer(chunkRaw) ? chunkRaw : Buffer.from(chunkRaw);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}
