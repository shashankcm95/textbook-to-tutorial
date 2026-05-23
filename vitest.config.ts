import { defineConfig } from 'vitest/config';
import path from 'node:path';

/**
 * Vitest config for unit + integration tests.
 *
 * Mirrors the `@/*` → `./src/*` alias declared in `tsconfig.json` so that
 * test files can import via the same paths as source files.
 *
 * `environment: 'node'` because nearly all current tests exercise Node-only
 * modules (pdfjs-dist, better-sqlite3, openai sdk, zod). React component
 * tests (Phase 3+) opt into jsdom per-file via the `// @vitest-environment
 * jsdom` pragma at the top of those test files — not as a global default.
 *
 * Test fixtures that hit the network or AWS gate behind env vars
 * (PDF_FIXTURE_URL, OPENAI_API_KEY) and skip() when absent, so fresh-clone
 * + CI runs stay green without secrets.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    environment: 'node',
    globals: false,
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['node_modules', '.next', 'out', 'build', 'dist', 'data', '.tutorials-cache'],
    testTimeout: 10_000,
    dangerouslyIgnoreUnhandledErrors: false,
    reporters: ['default'],
  },
});
