# C2 spike — CPU/Auth feasibility results (Goldberg 0.11 Stage 6, task 6.0f)

**Verdict: CONDITIONAL PASS** (see §9 for the exact conditions).
This is an isolated local experiment per `docs/planning/goldberg-0.11/stage-6/C2-SPIKE-PLAN.md`.
It is **not** production Stage 6 implementation and **not** definitive proof of
production Cloudflare performance (remaining §12 verification in §9/§10).

- Run: `2026-10-21T13:30:08.736Z` (run 3; runs 1–2 failed — preserved in `FAILURE-LOG.md`)
- Branch: `spike/goldberg-0.11-c2-bff` (isolated; planning baseline `2de3096`)
- Code-under-test commit: `SPIKE_COMMIT_SHA` (uncommitted at execution time — committed immediately after; `raw/run.json` records the parent planning SHA `2de30960fa8d99986b7aa621102ff5a21575ffe3`)

## 1. Runtime / tool versions

| Component | Version |
|---|---|
| Node.js | v22.23.1 (LTS) |
| npm | 10.9.8 |
| wrangler | 4.151.3 (pinned, lockfile) |
| workerd | 1.20261019.1 (bundled with wrangler) |
| TypeScript | 5.9.3 (pinned; `tsc --noEmit` clean) |
| @cloudflare/workers-types | 5.20261021.1 |
| ws / @types/ws | 8.18.3 / 8.18.1 (CDP cross-check only) |
| Workers Free CPU ceiling | **10 ms per invocation** — re-verified 2026-10-21 from the official pricing page (developers.cloudflare.com/workers/platform/pricing, last updated Oct 2, 2026) |

All test execution was loopback-only (127.0.0.1). No external API calls, no real
credentials, no Cloudflare/Supabase accounts, nothing deployed. Synthetic
identities and per-run generated RSA keys only; private keys are gitignored and
never committed.

## 2. Tests executed

| Class | Executed | Passed | Failed | Skipped | Inconclusive |
|---|---|---|---|---|---|
| Security S1–S19 | 19 | 19 | 0 | 0 | 0 |
| Performance P1–P7 | 7 | 7 (executed; interpretation caveats §10) | 0 | 0 | 0 |
| CPU-metric validity + probe + log scan | 3 | 3 | 0 | 0 | 0 |

Nothing was marked passed without execution. ~17 600 requests were issued in
total across the matrix (including 10 000-request stability run).

## 3. CPU measurement — investigation & validity (plan §7, critical)

Local workerd exposes **no per-request CPU metric**. Investigated:

| Candidate | Finding |
|---|---|
| `wrangler dev` request logs | Wall duration only; `--log-format json` does not exist in wrangler 4.151.3 |
| Local observability span store (`/cdn-cgi/local/explorer/api/local/observability/query`) | Per-invocation root spans with `duration_ms` (**wall**) only; no CPU attribute |
| In-worker `performance.now()` (`x-spike-cpu-ms`) | **Quantized to 1 ms** AND includes awaited I/O (4 ms → 407 ms under 100 ms injected stub latency). Not CPU; production's clock excludes I/O waits — local value is a **conservative per-invocation upper bound** |
| CDP V8 profiler via workerd inspector (`tools/cdp-probe.mjs`) | Supported; measures frames-on-stack ≈ wall-under-JS (6.65 ms/req on the queue path) — also an upper bound, not CPU-pure |
| **OS accounting of the workerd process** (`/proc/<pid>/stat` utime+stime) | **Adopted as PRIMARY.** Kernel does not count awaited I/O/sleep ⇒ true CPU. 10 ms tick granularity; batches sized for ≤0.5 % quantization error. Idle baseline: 0 ticks / 3 s |

**Validity check (kernel metric, run 3):** per-request CPU 2.1 ms at 0 ms
injected stub latency vs 2.5 ms at 100 ms injected latency — **flat** (the
injected sleep adds zero CPU). Handler clock tracked latency (4 → 407 ms),
confirming why it is not used as CPU. Verdict: kernel accounting **VALID** as
the primary CPU metric; handler clock recorded only as an upper bound.

## 4. CPU results (trustworthy: kernel accounting)

| Scenario | Kernel CPU / invocation (avg) |
|---|---|
| P1 warm happy path, sequential (1 000 req) | **2.03 ms** (103+ ticks, ≤0.5 % quantization) |
| P1 warm happy path, concurrency 8 (1 000 req) | **2.07 ms** |
| P4 latency sweep @ 0/5/25/100 ms | 1.9 / 1.8 / 1.8 / 2.1 ms — **flat** |
| P5 error path (5xx burst, 100 req) | 1.9 ms |
| P6 concurrency 1 / 5 / 20 (500 req each) | 2.04 / 2.14 / 1.88 ms — **flat** |
| P7 stability (10 000 req @ conc 10) | **2.054 ms** (2 054 ticks total, 0 errors, handler-clock drift −4.8 %) |

Per-invocation **percentiles** are not directly measurable locally (kernel
accounting is aggregate-only). Conservative per-invocation **upper bounds**
(handler clock at conc 1, includes awaited loopback I/O + 1 ms quantization,
n = 3 000): **p50 = 3 ms, p95 = 4 ms, p99 = 6 ms, max = 17 ms**. CDP cross-check
average: 6.65 ms/req (upper bound). One handler-clock outlier (17 ms) exceeded
the 10 ms ceiling as *wall-in-handler*, not CPU; with a kernel mean of 2.03 ms
and a tight distribution this is scheduling/GC, but a per-invocation CPU
ceiling is **inferred, not measured** (§10).

## 5. Wall-clock results

| Scenario | Wall |
|---|---|
| P1 warm (loopback) | p50 9.2 ms, p95 11.1 ms, p99 20.0 ms, max 33.0 ms (n = 3 000) |
| P2 cold start (wrangler dev spawn → healthy) | p50 1 970 ms, p95 1 988 ms (n = 20 fresh processes; dev-tooling artifact incl. bundling, not production isolate cold start) |
| P2 first requests on fresh process | sign-in handler clock p50 6 ms; queue p50 4 ms; per-request cold CPU below the 10 ms tick resolution (0–1 ticks/process — reported honestly, not fabricated) |
| P5 error paths (wall) | 5xx 22.9 ms, quota 25.0 ms, blackhole 2 017 ms (= stub timeout, truthful 503) |
| P6 concurrency 1/5/20 (wall p50) | 9.2 / 29.8 / 97.0 ms (local workerd contention semantics) |
| P7 10 000 requests | 60.2 s total, 0 errors |
| Validity sweep wall | 9.6 ms @ 0 ms latency vs 413.7 ms @ 100 ms latency (injection ×4 stub calls) |

## 6. Security results — S1–S19 (all executed, run 3)

| # | Scenario | Result | Evidence (abridged) |
|---|---|---|---|
| S1 | Valid admin session | PASS | queue 200, decide 201, decisions 0→1, CSP present |
| S2 | Non-admin → admin endpoint | PASS | 403 forbidden, state unchanged |
| S3 | Missing/malformed credentials | PASS | no-cookie 401, garbage-cookie 401 |
| S4 | Expired JWT + expired session row | PASS | 401 / 401 |
| S5 | Invalid signature (wrong key, wrong cookie secret) | PASS | 401 / 401 |
| S6 | Wrong issuer / audience | PASS | 401 / 401 |
| S7 | Unknown kid | PASS | 401, fail-closed after one bounded re-fetch |
| S8 | JWKS rotation + cache-window expiry | PASS | initial 200, within-window 200, old-key-after-window **401**, new-key 200 |
| S9 | alg=none + algorithm confusion | PASS | 401 / 401 (allowlist) |
| S10 | Revoked admin role | PASS | 200 → 403 at next request while JWT still cryptographically valid (no expiry wait) |
| S11 | Suspended account (handover + mid-session) | PASS | 403 / active 200 / mid-session 403 |
| S12 | CSRF missing/mismatch | PASS | 403 / 403, state unchanged |
| S13 | Cross-origin + foreign CORS preflight | PASS | 403; no ACAO echo |
| S14 | Backend blackhole (timeout) | PASS | truthful 503 service_unavailable, requestId present, static route stays 200 |
| S15 | Backend 5xx | PASS | 503, static 200, no internals leaked |
| S16 | Quota exhaustion + kill switch | PASS | quota 503; kill-write 503 (after cache TTL); read-while-killed 200; no escalation path exists in code |
| S17 | Replay of logged-out/revoked sessions | PASS | logout 200, cookie replay 401, revoked-row reuse 401 |
| S18 | Logout then access | PASS | 200 → 401 immediately |
| S19 | No privileged material in responses | PASS | 22-response corpus: no private keys, no session secret, no service-role strings, no token echo, no stack traces; sid cookie HttpOnly+Secure+SameSite=Strict; CSP on every response |

Log scan (20 757 captured wrangler/stub lines): no private-key material, no
session secret (`SESSION_SECRET` loaded from gitignored `.dev.vars`, displayed
as `(hidden)`, zero value occurrences). A failed attempt where wrangler's
`[vars]` display echoed the secret is preserved in `FAILURE-LOG.md`.

## 7. Performance results — P1–P7 (all executed)

| # | Scenario | Result |
|---|---|---|
| P1 | Warm happy path, 3×1 000 + kernel batches | kernel 2.03/2.07 ms; upper bounds p50 3 / p95 4 / p99 6 ms; CDP cross-check 6.65 ms avg |
| P2 | Cold start ×20 fresh processes | all 200; ready-to-serve p50 1 970 ms (dev artifact); cold requests CPU ≈ warm (2–3 ticks/process) |
| P3 | JWKS cold vs warm | handler clock cold p50 6 ms vs warm p50 3 ms (cold = first fetch + RSA import) |
| P4 | Latency sweep (CPU validity) | kernel flat 1.9–2.1 ms across 0/5/25/100 ms injected latency |
| P5 | Error paths | all 503 as designed; kernel 1.9 ms (early short-circuit) |
| P6 | Concurrency 1/5/20 | kernel flat 2.04/2.14/1.88 ms; wall grows with local contention |
| P7 | Stability 10 000 req | 0 errors; kernel 2.054 ms; handler drift −4.8 %; RSS 1 037 MB → 1 422 MB (see §10) |

## 8. CPU target evaluation (provisional targets: P50 ≤ 3, P95 ≤ 5, P99 ≤ 8 ms; ceiling 10 ms)

| Target | Evaluation |
|---|---|
| Avg CPU ≤ P50 target (3 ms) | **MET with margin** — kernel-measured 2.03 ms (2.2× headroom) |
| P50 ≤ 3 ms | MET via conservative upper bound (handler p50 = 3 ≥ true CPU) |
| P95 ≤ 5 ms | MET via upper bound (handler p95 = 4) |
| P99 ≤ 8 ms | MET via upper bound (handler p99 = 6) |
| 10 ms/invocation ceiling | Strongly supported (kernel mean 2.03 ms, tight distribution, 0 errors over 17 k+ requests); per-invocation ceiling **inferred, not directly measured** (handler max 17 ms was wall, not CPU) |

## 9. Verdict — C2: **CONDITIONAL PASS**

The approved BFF request pipeline (AUTH.md §2–3/§5–6) ran correctly and
securely on the real Cloudflare workerd runtime locally: **19/19 security
scenarios pass**, fail-closed behavior holds for every tested failure mode, and
average CPU per invocation is **2.03 ms kernel-accounted** — ~4.9× under the
10 ms Workers Free ceiling and below the provisional P50 target.

Conditions (all must be discharged before C2/6.0f can be closed):

1. **§12 production-runtime verification** (owner-gated, separate): per-request
   CPU percentiles on a real Cloudflare Workers deployment, production-like
   Supabase eu-central-1 latency, real cold starts, real cache isolation. The
   percentile claims here rest on conservative local upper bounds, not direct
   per-invocation CPU measurement.
2. Production adds business logic beyond this minimal pipeline — CPU must be
   re-measured in §12/6.8, not assumed to carry over.
3. Local workerd semantics differ from production (loopback overhead included in
   local wall/handler clocks; production excludes I/O waits from CPU time).
   Local CPU (kernel) excludes I/O already, so the 2.03 ms average is expected
   to be ≤ production, but this must be confirmed, not assumed.

C3/C4 remain separate open conditions. Task 6.0f is **not closed** by this
spike alone.

## 10. Known limitations

1. Local workerd ≠ production edge runtime (single node, loopback stub, dev
   tooling). Local results are not definitive production evidence.
2. Per-invocation CPU **percentiles** are not directly measurable locally:
   kernel accounting is aggregate; the in-worker clock is 1 ms-quantized and
   includes awaited I/O; the CDP profiler measures frames-on-stack. Upper-bound
   argument used instead; a single 17 ms handler-clock outlier was wall, not
   CPU, and the per-invocation ceiling is inferred.
3. P2 "cold start" includes wrangler bundling/spawn (~2 s) — a dev-tooling
   artifact; production isolate cold start is unmeasured here.
4. P7 RSS grew 1 037 →  1 422 MB over 10 000 requests in local dev (V8 arena
   retention vs. leak is undetermined; production GC/eviction semantics
   differ). Flagged for §12.
5. No request-controllable clock seam exists in the code under test (deliberate
   — a controllable clock would be a backdoor). Time-based scenarios were driven
   by fixture timestamps and short real cache windows instead.
6. P3 warm sign-in handler clock showed occasional GC outliers (p99 16 ms,
   max 85 ms) — wall/GC, not CPU (kernel P1/P7 remained 2.0 ms).
7. The stub models PostgREST/GoTrue/JWKS *shapes* only; it is not a Supabase
   emulator and validates nothing about real Supabase behavior.

## 11. Reproduction

```bash
cd spikes/bff-c2
npm ci                     # pinned deps + lockfile (official npm registry)
node tools/execute.mjs     # ~8 min: fixtures → stub → wrangler dev → probe
                           # → S1–S19 → P1–P7 → results/
```

Linux required (kernel CPU accounting uses `/proc/<pid>/stat`). All traffic is
loopback-only; nothing is deployed; fixtures (RSA keys + per-run session
secret) are regenerated into gitignored `fixtures/generated/` + `.dev.vars`.
Results land in `results/summary-data.json` and `results/raw/run.json`.
`wrangler dev` is spawned by the runner — do not run one concurrently on 8787.

## 12. Exact commit

- Branch: `spike/goldberg-0.11-c2-bff`
- Spike code + evidence commit: `SPIKE_COMMIT_SHA`
- Docs sync commit: `DOCS_COMMIT_SHA`
- Execution-time recorded parent: `2de30960fa8d99986b7aa621102ff5a21575ffe3`

created by stokonn with love <3
