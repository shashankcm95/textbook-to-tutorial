/**
 * src/lib/openai/client.ts — singleton OpenAI client.
 *
 * Lazy-init: the OpenAI constructor is called on first access of `openai`,
 * NOT at module load. Rationale:
 *   - Test paths that stub the SDK can install the stub before any code
 *     touches the real client.
 *   - Build-time module evaluation (Next.js production build) must not
 *     trip env validation for OPENAI_API_KEY — but env.ts already
 *     parses at boot, so this is belt-and-suspenders.
 *   - Hot reload during `next dev` re-runs module init; the
 *     `globalThis` cache prevents leaking client instances across HMR
 *     (same pattern as src/db/client.ts).
 *
 * Design anchor:
 *   - kb:architecture/ai-systems/inference-cost-management §"Lever 1: Model
 *     selection" — the model is read from env (OPENAI_MODEL) so the routing
 *     decision is config, not code. Default = gpt-4o-mini per ari Phase 1.
 *   - kb:hets/stack-skill-map "LLM-integrated web app" — claude-api skill
 *     conventions transfer (HTTP API contract is similar across SDKs); this
 *     is the inference-path entry point.
 *
 * This is the INFERENCE-PATH OpenAI client (not training-path). See
 * kb:ml-dev/training-vs-inference for the dichotomy: per-request,
 * per-token billed, latency-bound, structured output via response_format.
 */

import OpenAI from 'openai';
import { env } from '@/lib/env';

// HMR-safe singleton cache. Next.js dev mode tears down + re-runs modules;
// without this, every save would leak a new client (each holding its own
// undici Agent + keep-alive pool).
const globalForOpenai = globalThis as unknown as {
  __ttt_openai__?: OpenAI;
};

function buildClient(): OpenAI {
  return new OpenAI({
    apiKey: env.OPENAI_API_KEY,
    // Default maxRetries=2 in the SDK is REPLACED by our own retry policy
    // in streaming.ts (we need granular 429-vs-5xx-vs-json-parse handling
    // with explicit backoff curves). Disable SDK-level retries so we don't
    // double-retry and triple our cost on a single 429.
    maxRetries: 0,
    // 120s timeout — dense chapter narratives (4o on full DDIA chapters with
    // ~200-paragraph contexts) routinely run 20-40s wall-clock, and the v3
    // fidelity-rules expansion pushed input prompts longer. Bumped from 30s
    // (DRIFT-test3-027) after v3 regen saw 4/6 timeouts on retry.
    // Per-request streaming still has its own AbortSignal for callers that
    // need tighter ceilings.
    timeout: 120_000,
  });
}

/**
 * Lazy-init proxy: `openai.chat.completions.create(...)` works as if it
 * were a normal client, but the constructor only runs once on first method
 * access. The Proxy keeps the API ergonomic while preserving lazy semantics.
 */
function getOrCreate(): OpenAI {
  const cached = globalForOpenai.__ttt_openai__;
  if (cached) return cached;
  const fresh = buildClient();
  globalForOpenai.__ttt_openai__ = fresh;
  return fresh;
}

// Export-as-proxy: any `openai.X` access lazily resolves the client. Keeps
// `import { openai } from '@/lib/openai/client'` ergonomic at call sites
// without breaking lazy init.
export const openai = new Proxy({} as OpenAI, {
  get(_target, prop, receiver) {
    const client = getOrCreate();
    const value = Reflect.get(client, prop, receiver);
    // Bind methods so `this` resolves correctly when the SDK uses internal
    // `this.<x>` chains (e.g., `client.chat.completions` is a getter that
    // returns an object holding a reference back to the client).
    return typeof value === 'function' ? value.bind(client) : value;
  },
}) as OpenAI;

/**
 * Returns the active model identifier from env. Centralized accessor so
 * cost.ts, streaming.ts, and prompts can all stay in sync without each
 * re-reading env.OPENAI_MODEL.
 *
 * Phase 1 design notes deferred the fallback-to-gpt-4o cascade (per ari
 * design §3) to test4; this returns ONE model for now. When the cascade
 * lands, this function will return the *active* tier (callers may also
 * call `getFallbackModel()` once that exists).
 */
export function getModel(): string {
  return env.OPENAI_MODEL;
}
