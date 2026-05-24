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
- **AI**: OpenAI hybrid — `gpt-4o` for narrative (streaming) + `gpt-4o-mini`
  for classifier, quiz/flashcards, and fidelity scoring
- **Object store**: S3-compatible (textbook PDFs fetched by `s3://` URL;
  ingest chunks cached by `pdf_sha256` for multi-user reuse)
- **Auth**: cookie-signed anonymous sessions (HMAC-SHA256; no login flow)
- **CSRF**: double-submit cookie (`__csrf` + `X-CSRF-Token` header) on POST/PUT/DELETE
- **Language scope (MVP)**: **English-source PDFs only.** Tokenization,
  fidelity scoring, prompt rules, and front/back-matter classification are
  all tuned for English. Non-English support is deferred — see "Out of
  scope" below.

See `.claude/plans/` and `swarm/run-state/test3-design/PHASE-1-SYNTHESIS.md`
for the full design ceremony output.

## Cost cap behavior (MVP — known overrun gaps)

`COST_CAP_USD` (default `1.00`) is a **per-tutorial** ceiling enforced
**pre-call** via tiktoken-based token estimation. It is an estimate-ceiling,
not a hard real-cost wall. One known overrun vector remains in MVP:

**Concurrent-stream overrun** — `assertCostBudget()` reads + writes are
not serialized. Two streams ingesting the same tutorial near-simultaneously
each see "spent = X" before either commits its cost — both pass the cap
check, both bill. Bounded to one chapter's actual cost in the worst case.

The cost-recorded value in `parses_cost.cost_usd` is always the **actual**
post-call billable, so reconciliation is exact even when the budget check
was optimistic. A 20-chapter tutorial with concurrent reconnects can bill
roughly 1 chapter's worth (~$0.02 on `gpt-4o`/`gpt-4o-mini` hybrid) above
the nominal cap. Documented + accepted as MVP debt.

Hardening paths considered (deferred to v1.0):
- **Mid-stream tripwire** — abort when cumulative actual exceeds cap;
  cleaner UX but requires per-chunk cost accounting.
- **Per-user cost cap** — protects against rapid serial-ingest exhaustion
  of a shared cap; needs a `user_cost_caps` table + admin override.
- **Cap-with-grace** — auto-extend cap by 15% on overrun + alert; degrades
  to a "soft cap" pattern.

For the MVP (test3): treat `COST_CAP_USD` as a budget guardrail, not a
hard fence. Operators should set it well above expected per-PDF spend.

## Out of scope (MVP)

- **Non-English source PDFs.** Front/back-matter classification, fidelity
  scoring (concrete-anchor detection), prompt rules (rhetorical-voice
  preservation, "BUT clause" pattern, implementation-specific search-term
  anchors), and tiktoken BPE accounting are all English-tuned. Multilingual
  support is deferred; the MVP rejects nothing at ingest, but quality and
  cost-cap accuracy are only guaranteed for English-source material.
- Hardening paths for the concurrent-stream overrun (mid-stream tripwire,
  per-user cap, cap-with-grace) — deferred to v1.0.

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
