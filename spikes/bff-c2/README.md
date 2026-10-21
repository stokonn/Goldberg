# spikes/bff-c2 — C2 CPU/auth feasibility spike (Goldberg 0.11 Stage 6)

**Isolated synthetic test harness. Local execution only. Never deployed.**
`wrangler deploy` is forbidden for this directory. See
`docs/planning/goldberg-0.11/stage-6/C2-SPIKE-PLAN.md` for scope and gates.

Implements the approved BFF request pipeline (AUTH.md §2–3/§5–6) against a
local fake Supabase stub (PostgREST/GoTrue/JWKS shapes), then runs the full
C2 matrix: CPU-metric validity, security scenarios S1–S19, performance
scenarios P1–P7.

## Layout

```
src/worker.ts        BFF worker under test (auth pipeline + x-spike-* instrumentation)
stub/server.mjs      fake Supabase (127.0.0.1 only; /__control fault injection, /__state dump)
tools/gen-fixtures.mjs  per-run RSA keys + JWKS + principals + session secret (gitignored)
tools/lib.mjs        JWT minting (synthetic), HTTP with wall timing, stats
tools/execute.mjs    one-command orchestrator: full matrix → results/
tools/cdp-probe.mjs  CDP V8 profiler cross-check (workerd inspector)
fixtures/public/     inert public JWKS only (committed)
results/SUMMARY.md   final report + verdict
results/FAILURE-LOG.md  preserved evidence of failed attempts
```

## Run it

```bash
npm ci
node tools/execute.mjs     # ~8 min, loopback only, nothing deployed
```

Linux required (kernel CPU accounting via `/proc/<pid>/stat`). Don't run a
manual `wrangler dev` on 8787 at the same time. Private keys and the session
secret live in gitignored `fixtures/generated/` and `.dev.vars` — never commit
them.

## Headline result (2026-10-21)

- S1–S19: **19/19 PASS**; P1–P7 fully executed.
- True CPU (kernel-accounted): **2.03 ms/invocation** average, flat across
  latency injection, concurrency and 10 000-request stability — vs the 10 ms
  Workers Free ceiling. Per-invocation upper bounds p50 3 / p95 4 / p99 6 ms.
- Verdict: **CONDITIONAL PASS** — details, limitations and the remaining §12
  production-runtime verification in `results/SUMMARY.md`.

created by stokonn with love <3
