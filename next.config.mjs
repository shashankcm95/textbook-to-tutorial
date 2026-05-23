/** @type {import('next').NextConfig} */

/**
 * Next.js 14 App Router config.
 *
 * DRIFT-test3-013 (Phase 5): converted from next.config.ts → next.config.mjs
 * because Next 14.2.5 does NOT support TypeScript config files (added in
 * Next 15). evan shipped the .ts variant in Phase 2 Wave 1; failure surfaced
 * at first `pnpm dev` invocation in Phase 5 UAT.
 *
 * Notes:
 *  - No `output: 'standalone'` — we run via `pnpm dev` / `pnpm start` only
 *    (localhost-only MVP per ari Phase 1 design). When Cloudflare Pages
 *    becomes a target (post-MVP), switch to `output: 'export'` or stay on
 *    Workers + container as fits.
 *  - `serverActions.bodySizeLimit = '50mb'` — PDFs (the primary ingest)
 *    exceed the Next.js default of 1mb. The hard cap is enforced upstream
 *    via env (MAX_PDF_BYTES) before the action handler runs; this setting
 *    just keeps Next from rejecting at framework level.
 *  - `images.remotePatterns: []` — no remote images in MVP. If/when avatar
 *    or thumbnail support lands, add the bucket origin here explicitly.
 *  - `reactStrictMode: true` is a deliberate prod hygiene win — surfaces
 *    effect double-mount issues during dev.
 */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    serverActions: {
      bodySizeLimit: '50mb',
    },
  },
  images: {
    remotePatterns: [],
  },
};

export default nextConfig;
