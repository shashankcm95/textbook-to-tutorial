// src/lib/s3.ts — S3 client + s3:// URL parsing for TB_to_Tutorial_converter
//
// Scope:
//   - Parse s3://bucket/key/with/slashes.pdf URLs (NOT presigned https://)
//   - Fetch the object using AWS SDK v3 with real credentials
//   - Enforce a max-bytes cap (default 50 MB) to prevent runaway downloads
//   - Verify Content-Type is PDF-shaped before returning
//
// The test fixture is:
//   s3://textbooks-561764227438-us-east-1-an/Designing Data Intensive Applications - Martin Kleppmann.pdf
//                                            ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
//                                            note the SPACES in the key — URL-decoding matters
//
// Design anchors:
//   - kb:architecture/discipline/error-handling-discipline §"Pattern 1 + 5" —
//     let SDK errors propagate to the outer ingest-worker layer (which has
//     context to update tutorials.status='error' + tutorials.error_message);
//     do NOT silently retry or swallow.
//   - kb:infra-dev/observability-basics §"Alert on symptoms not causes" —
//     the max-bytes cap is a symptom-level alert (user-visible payload
//     limit), not a cause-level guard (memory pressure). Surface the cap
//     hit as a structured error the UI can render.

import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { Readable } from 'node:stream';
import { s3Env } from './env';

export type S3UrlParts = { bucket: string; key: string };

export class S3UrlParseError extends Error {
  constructor(message: string, public readonly url: string) {
    super(`s3 url parse failed: ${message} (input: ${truncateForLog(url)})`);
    this.name = 'S3UrlParseError';
  }
}

export class S3FetchError extends Error {
  constructor(
    message: string,
    public readonly bucket: string,
    public readonly key: string,
    public readonly cause?: unknown,
  ) {
    super(`s3 fetch failed: ${message} (bucket=${bucket}, key=${truncateForLog(key)})`);
    this.name = 'S3FetchError';
  }
}

export class S3PayloadTooLargeError extends Error {
  constructor(public readonly maxBytes: number, public readonly observedBytes: number) {
    super(
      `s3 payload exceeded max ${maxBytes} bytes (observed ${observedBytes}+ bytes before abort)`,
    );
    this.name = 'S3PayloadTooLargeError';
  }
}

export class S3ContentTypeError extends Error {
  constructor(public readonly contentType: string) {
    super(
      `s3 object content-type ${JSON.stringify(contentType)} is not pdf-shaped ` +
        `(expected application/pdf or application/octet-stream)`,
    );
    this.name = 'S3ContentTypeError';
  }
}

/**
 * Parse an s3:// URL into bucket + key.
 *
 * Accepts:   s3://bucket/key/with/slashes.pdf
 *            s3://bucket/path%20with%20spaces.pdf  (URL-encoded)
 *            s3://bucket/path with spaces.pdf      (literal spaces — tolerated)
 * Returns:   { bucket: 'bucket', key: 'key/with/slashes.pdf' }  (URL-DECODED)
 * Throws:    S3UrlParseError on non-s3:// schema or missing bucket/key.
 *
 * URL-decoding rationale: AWS SDK takes the literal key bytes; the SDK does
 * NOT decode percent-escapes on input. So if a user pastes an s3:// URL with
 * percent-encoded characters (which is the conventional form for keys with
 * special chars), we must decode here so the SDK sees the real key.
 */
export function parseS3Url(url: string): S3UrlParts {
  if (typeof url !== 'string' || url.length === 0) {
    throw new S3UrlParseError('url is empty or not a string', String(url));
  }
  const SCHEMA = 's3://';
  if (!url.startsWith(SCHEMA)) {
    throw new S3UrlParseError(`url does not start with ${SCHEMA}`, url);
  }
  const rest = url.slice(SCHEMA.length);
  const firstSlash = rest.indexOf('/');
  if (firstSlash === -1) {
    throw new S3UrlParseError('url is missing bucket/key separator', url);
  }
  const bucket = rest.slice(0, firstSlash);
  const rawKey = rest.slice(firstSlash + 1);
  if (bucket.length === 0) {
    throw new S3UrlParseError('bucket is empty', url);
  }
  if (rawKey.length === 0) {
    throw new S3UrlParseError('key is empty', url);
  }
  // decodeURIComponent throws on malformed percent-escapes; catch + re-wrap
  // so the caller gets a uniform error shape.
  let key: string;
  try {
    key = decodeURIComponent(rawKey);
  } catch (err) {
    throw new S3UrlParseError(
      `key has malformed percent-encoding: ${(err as Error).message}`,
      url,
    );
  }
  return { bucket, key };
}

/**
 * Fetch a PDF object from S3 using s3:// URL.
 *
 * @param s3Url   - s3://bucket/key URL (parsed via parseS3Url)
 * @param maxBytes - maximum payload size in bytes (default 50 MB). Excess
 *                   triggers stream abort + S3PayloadTooLargeError.
 * @returns       { buffer, contentType } on success
 * @throws        S3UrlParseError | S3FetchError | S3PayloadTooLargeError | S3ContentTypeError
 *
 * Error-handling discipline: this function does NOT retry. Retry policy
 * belongs to the outer ingest-worker (which has context: tutorial-id,
 * user-id, prior-attempt count). Per
 * kb:architecture/discipline/error-handling-discipline §Pattern 1.
 */
export async function fetchPdfFromS3(
  s3Url: string,
  maxBytes: number = 50 * 1024 * 1024,
): Promise<{ buffer: Buffer; contentType: string }> {
  const { bucket, key } = parseS3Url(s3Url);
  const cfg = s3Env(); // throws if AWS creds missing — outer layer decides
  const client = new S3Client({
    region: cfg.AWS_REGION,
    credentials: {
      accessKeyId: cfg.AWS_ACCESS_KEY_ID,
      secretAccessKey: cfg.AWS_SECRET_ACCESS_KEY,
    },
  });
  let resp;
  try {
    resp = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  } catch (err) {
    throw new S3FetchError(`sdk send failed: ${(err as Error).message}`, bucket, key, err);
  }
  if (!resp.Body) {
    throw new S3FetchError('response body is empty', bucket, key);
  }
  const contentType = resp.ContentType ?? 'application/octet-stream';
  if (!isPdfContentType(contentType)) {
    throw new S3ContentTypeError(contentType);
  }
  // Stream → buffer with hard cap. AWS SDK v3 returns Body as a Readable
  // stream (in node runtime); we accumulate chunks but abort if total
  // exceeds maxBytes. This protects us from a 5 GB upload triggered by a
  // malicious URL paste.
  const body = resp.Body as Readable;
  const buffer = await streamToBufferWithCap(body, maxBytes);
  return { buffer, contentType };
}

// ---------------------------------------------------------------------------
// Helpers (file-private)
// ---------------------------------------------------------------------------

function isPdfContentType(ct: string): boolean {
  const normalized = ct.toLowerCase().split(';')[0].trim();
  return normalized === 'application/pdf' || normalized === 'application/octet-stream';
}

async function streamToBufferWithCap(stream: Readable, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunkRaw of stream) {
    const chunk = Buffer.isBuffer(chunkRaw) ? chunkRaw : Buffer.from(chunkRaw);
    total += chunk.length;
    if (total > maxBytes) {
      // Abort: destroy the stream so the socket closes; throw to outer layer.
      stream.destroy();
      throw new S3PayloadTooLargeError(maxBytes, total);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}

function truncateForLog(s: string, maxLen = 200): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen) + '...';
}

// ---------------------------------------------------------------------------
// Future work (documented, not implemented):
//   - Presigned HTTPS URL fallback. When a user pastes a presigned URL like
//     https://bucket.s3.region.amazonaws.com/key?X-Amz-Signature=...,
//     we'd fetch directly via undici/fetch without AWS SDK creds. For MVP
//     we support s3:// only; presigned support deferred to post-MVP per
//     ari's design (single concurrent user; user controls their bucket).
// ---------------------------------------------------------------------------
