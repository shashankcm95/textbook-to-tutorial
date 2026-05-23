# TB → Tutorial Converter

Convert textbook PDFs into chapter-by-chapter tutorials with multiple-choice
quizzes and SRS flashcards. Local-first MVP — your PDF, your machine, your data.

## Bootstrap

Requires Node 22+ (`nvm use 22`) and pnpm.

```bash
# 1. Install deps
pnpm install

# 2. Configure environment
cp .env.example .env
# edit .env: set OPENAI_API_KEY (real sk-...) and SESSION_SECRET (openssl rand -base64 32)

# 3. Pre-flight gate — verifies env is real, not placeholder
bash scripts/phase0-gate.sh
# Exit 0 → proceed. Exit 1 → fix .env and rerun.

# 4. Initialize the local SQLite database
pnpm db:migrate
pnpm db:seed

# 5. Run the dev server
pnpm dev
# → http://localhost:3000
```

## Verify the scaffold

```bash
curl http://localhost:3000/api/health
# {"status":"ok","version":"0.1.0","timestamp":"2026-..."}
```

The health endpoint requires no auth and is excluded from CSRF enforcement.

## Architecture

- **Stack**: Next.js 14 (App Router) + TypeScript + Tailwind + shadcn/ui base
- **Persistence**: SQLite via Drizzle ORM (`./data/tutorials.db`)
- **AI**: OpenAI (`gpt-4o-mini` default) for chapter generation, quiz, flashcards
- **Object store**: S3-compatible (textbook PDFs fetched by `s3://` URL)
- **Auth**: cookie-signed anonymous sessions (HMAC-SHA256; no login flow)
- **CSRF**: double-submit cookie (`__csrf` + `X-CSRF-Token` header) on POST/PUT/DELETE

See `.claude/plans/` and `swarm/run-state/test3-design/PHASE-1-SYNTHESIS.md`
for the full design ceremony output.

## Cost cap behavior (MVP — known overrun gaps)

`COST_CAP_USD` (default `1.00`) is a **per-tutorial** ceiling enforced
**pre-call** via tiktoken-based token estimation. It is an estimate-ceiling,
not a hard real-cost wall. Two independent overrun vectors compound:

1. **Non-English text under-count** — tiktoken's BPE for `gpt-4o-mini`
   under-counts non-Latin scripts (CJK, Arabic, Devanagari, Cyrillic) by
   roughly 30%. A tutorial that estimates at $0.50 may actually bill ~$0.65.

2. **Concurrent-stream overrun** — `assertCostBudget()` reads + writes are
   not serialized. Two streams ingesting the same tutorial near-simultaneously
   each see "spent = X" before either commits its cost — both pass the cap
   check, both bill. Bounded to one chapter's actual cost in the worst case.

These vectors are **additive**, not exclusive. A 20-chapter non-English
tutorial with concurrent reconnects can bill roughly 10% above the
nominal cap (~$1.10 against a $1.00 cap). Documented + accepted as MVP
debt; the cost-recorded value in `parses_cost.cost_usd` is always the
**actual** post-call billable, so reconciliation is exact even when the
budget check was optimistic.

Hardening paths considered (deferred to v1.0):
- **Mid-stream tripwire** — abort when cumulative actual exceeds cap;
  cleaner UX but requires per-chunk cost accounting.
- **Per-user cost cap** — protects against rapid serial-ingest exhaustion
  of a shared cap; needs a `user_cost_caps` table + admin override.
- **Cap-with-grace** — auto-extend cap by 15% on overrun + alert; degrades
  to a "soft cap" pattern.

For the MVP (test3): treat `COST_CAP_USD` as a budget guardrail, not a
hard fence. Operators should set it well above expected per-PDF spend.

## Scripts

| Script | Purpose |
|--------|---------|
| `pnpm dev` | Next.js dev server (port 3000) |
| `pnpm build` | Production build |
| `pnpm start` | Run production build |
| `pnpm lint` | ESLint (Next.js recommended preset) |
| `pnpm test` | Vitest unit tests |
| `pnpm test:phase0` | Re-run the pre-flight env gate |
| `pnpm db:generate` | Generate Drizzle migrations from schema |
| `pnpm db:migrate` | Apply migrations to local SQLite |
| `pnpm db:seed` | Seed reference rows (Leitner boxes, sample tutorial) |

## License

MIT (TBD).
