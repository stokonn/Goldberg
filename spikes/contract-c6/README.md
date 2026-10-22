# spikes/contract-c6 — Stage 6 contract-behavior verification spike (Goldberg 0.11)

**Isolated synthetic simulator. Local execution only. Never deployed. Never merged.**
`wrangler deploy`, cloud provisioning, and any real-credential use are forbidden for
this directory. Scope authority: the owner-authorized Stage 6 local-only verification
prototype instruction (2026-10-22), mirroring the C2 spike precedent. See
`docs/planning/goldberg-0.11/stage-6/` for the normative contract.

Branch: `spike/goldberg-0.11-stage-6-contract-pg` (the C6-PG port branch, created from
`spike/goldberg-0.11-stage-6-contract` @ `d2a95d4`). Planning branch stays untouched;
planning-doc sync happens separately, without merging this spike's code (C2 pattern:
spike docs commit, then planning-branch docs commit). **Never merged.**

## C6-PG port (2026-10-22): the same contract tests against real PostgreSQL

Owner task: verify the existing C6 contract tests against a real, isolated, LOCAL
PostgreSQL instance (transaction isolation and concurrent moderation, constraints and
rollback, idempotency and audit integrity, SQLite-vs-PostgreSQL differences).

Approach — **same server source, same suites, two engines**:

- The DB layer became a small async adapter interface (`get/all/run/exec/close`) with
  two implementations selected per run via `C6_ENGINE` (`sqlite` default | `postgres`):
  `src/db.mjs` (SQLite, still zero-dep) and `src/db-pg.mjs` (PostgreSQL, the single new
  dependency `pg` — a deliberate, isolated deviation from C6's zero-npm invariant,
  needed to speak the wire protocol; SQLite venue stays zero-dep).
- `src/server.mjs` / `src/auth.mjs` / all suites were ported to `await` the adapter —
  business logic, validation, state machine and hash chain are unchanged, so engine
  differences surface as test results instead of code forks.
- Adapter translations (each a recorded SQLite→PostgreSQL difference):
  `?` → `$1..$n`; `BEGIN IMMEDIATE` → `BEGIN` (PostgreSQL has no write-lock-at-BEGIN);
  `rowid` → `id` (a real `BIGSERIAL id` column is added to `published_entities`);
  int8/BIGINT results → JS numbers via an installed type parser.
- New suite `tests/v10-pg-isolation.test.mjs` (PostgreSQL-only, deterministic
  interleavings of the exact runDecision statement sequence): ISO-1/2/3 isolation
  probes, CONS-1 idempotency PK race, CHAIN-1 audit-seq race, TYPE-1 int8 mapping,
  CONS-2 FK-absence probe.
- Evidence: `results/pg/` (both venues' TAP, summary, environment). SQLite post-port
  regression run is captured next to the PostgreSQL run.

Verification instance (synthetic data only, rootless podman, loopback only):

```bash
podman run -d --name c6-pg -e POSTGRES_USER=c6spike -e POSTGRES_DB=c6spike \
  -e POSTGRES_HOST_AUTH_METHOD=trust -p 127.0.0.1:54329:5432 \
  docker.io/library/postgres:17-alpine
C6_PG_URL=postgres://c6spike@127.0.0.1:54329/c6spike node tools/execute-pg.mjs
```

`127.0.0.1:54329` binds host-loopback only; trust auth is loopback-only; every test
uses a fresh throwaway schema; nothing is shared with any Supabase project (none
exists — provisioning stays gated).

## Concurrency hardening (2026-10-22): FOR UPDATE vs SERIALIZABLE — EXPERIMENTAL

Follow-up to the C6-PG findings F1/F3/F4 (`results/SUMMARY-PG.md`). **Experimental
mitigation spike: not production code, never merged, never deployed.** The faithful
sources and the original failing evidence (`results/pg/`) stay byte-untouched.

- `src/harden.mjs` — an experimental hardened decision endpoint implementing BOTH
  candidate mitigations over the same `runDecision` step sequence:
  `for-update` (row lock + `audit_head` append mutex; 0 retries observed everywhere)
  and `serializable` (SSI + bounded retry + explicit 40001/40P01/23505 handling;
  exhaustion maps to 409, never 500). Both share the F3 store hardening (23505 →
  serve the stored replay, or 422 on mismatch).
- `tests/v11-concurrency-hardening.test.mjs` (PG-only) — in-process races through
  the real hardened server, the repeated 20-trial multi-process barrier race per
  strategy (the mitigation counterpart of v9's 10/10 deviations), contract +
  negative behavior, a deterministic F3 store race, and a 20-decision F4 scale run.
- `tools/decide-hardened-child.mjs` + `tools/execute-hardening.mjs` — race child
  and evidence executor writing to `results/pg-hardening/` only.
- Result (see `results/pg-hardening/SUMMARY-HARDENING.md`): both strategies restore
  `[201,409]` in 20/20 multi-process trials; **row locking is the recommended
  pattern** (deterministic, zero retries); serializable works but cost 218× 40001
  aborts at 20-way concurrency.

## What it does

Implements a minimal, disposable, **in-process** simulator of the Stage 6 `/v1`
contract (API-CONTRACTS.md, DATA-MODEL.md §2–§6) over an isolated per-run SQLite
database (`node:sqlite`, `:memory:` for suites, scratch file for the race test) with
synthetic identities, fake sessions and a fake clock, then verifies with deterministic
`node:test` suites:

| Suite | Contract behavior | THREAT-MODEL rows |
|---|---|---|
| `v1-validation` | payload allowlist, caps, plain-text rules, envelope | T6, T13 |
| `v2-authz` | sessions, roles, default-deny, live revocation/suspension, no self-grant | T5, T22 |
| `v3-existence` | existence-hidden 404, ownership, public read separation, paging | T7, T8 |
| `v4-moderation` | decisions, state machine, conflicts, quarantine | T10 |
| `v5-idempotency` | replay, mismatch 422, per-principal scoping, ≥24 h expiry | T11, T12 |
| `v6-failures` | fault-injection rollback, kill switch, quotas, error envelope | T16, T17, T20 |
| `v7-ssrf` | evidence-URL guard (static portion) | T14 (static only) |
| `v8-chain` | append-only audit, tamper evidence | T18 (local chain) |
| `v9-race` | multi-process concurrent approve → exactly one commits | T10 (true concurrency) |
| `v10-pg-isolation` (PG-only) | READ COMMITTED vs FOR UPDATE vs SERIALIZABLE, idempotency/audit seq races, int8 mapping, FK absence | T10, T11, T18 |
| `v11-concurrency-hardening` (PG-only, experimental) | hardened decision endpoint: repeated race per strategy, SQLSTATE mapping, F3 replay-on-conflict, F4 scale | T10, T11, T18 (mitigation comparison) |

## How to run

```bash
node tools/execute.mjs     # SQLite venue: scan + full suite + results/ (~5 s)
# PostgreSQL venue (needs the loopback instance above):
C6_PG_URL=postgres://c6spike@127.0.0.1:54329/c6spike node tools/execute-pg.mjs
# hardening evidence run (current full suite incl. v11):
C6_PG_URL=postgres://c6spike@127.0.0.1:54329/c6spike node tools/execute-hardening.mjs
# or manually, either engine:
C6_ENGINE=postgres C6_PG_URL=... node --test tests/*.test.mjs
```

SQLite venue: zero npm dependencies. PostgreSQL venue: `npm install` once to get the
`pg` wire client. Requires Node ≥ 22.5 (`node:sqlite`, experimental; the
ExperimentalWarning is recorded in the raw TAP).

## Permissible vs blocked experiments (pre-6.0f determination)

**Performed (permissible):** THREAT-MODEL §2 [L]-venue rows T5, T6, T7, T8, T10,
T11, T12, T13, T14 (static portion), T16, T17, T18 (local chain), T22 — an isolated
disposable local prototype, exactly the C2 precedent: spike branch, `spikes/` only,
synthetic data, never merged, never deployed. 6.0f gates *production implementation*,
which this explicitly is not.

**Blocked, skipped, not bypassed (precise blockers):**
- **C2 §12 production-runtime verification** — requires deploying a Worker on a real
  Cloudflare account = provisioning (6.0d), gated by D5b/Q1 unresolved + C4 open +
  ORD-A steps 4–6 (NOT AUTHORIZED).
- **All [I] venue rows** — real Google OAuth/JWKS rotation, real Supabase quota/
  pause, browser CSRF/CORS against a deployed Admin, real RPO drill — require the
  provisioned project (same gate as above).
- **Real Postgres serializable-isolation proof** — partially addressed by the C6-PG
  port: verified against a LOCAL PostgreSQL 17.11 (v9 + v10, both isolation probes,
  see `results/SUMMARY-PG.md`). **Still blocked: the same proof against the actual
  Supabase Free service** (PostgREST pool, Supabase-managed config) — Supabase Free
  not provisioned (D5b/Q1 + C4 gates; NOT AUTHORIZED).
- **Production server implementation (6.1–6.18)** — gated on 6.0f acceptance +
  separate implementation authorization. Nothing here implements production code.
- **CPU budget re-measurement** — already measured by C2 (2.03 ms avg); not repeated.
- **Token/JWKS/HTTP-layer security** — already verified by C2 (S1–S19, 19/19 PASS);
  this spike uses fake sessions and deliberately does NOT re-test token crypto.

## Contract ambiguities found (interpretations recorded in results/SUMMARY.md)

1. `DELETE /v1/session` idempotency — implemented as literal always-200 no-op
   (contract says "idempotent"); alternative reading (401 on already-revoked token)
   matches C2 S17/S18 expectations. Flagged for implementation-time decision.
2. Author revision timing — API-CONTRACTS §4 allows revisions in
   `{draft, changes_requested, returned}`; `draft` never exists in DATA-MODEL §3
   lifecycle (creation = `submitted`). Implemented per contract text: authors revise
   only after `request_changes`.
3. Depth-check vs allowlist overlap in payload rejection — both fire for deeply
   nested bodies; observed behavior is a single 400 (mechanism not distinguished).
4. Self-suspension forbidden (stricter than contract; conservative T22 interpretation).
5. WHATWG URL normalization resolves IPv4 shorthand (`127.1` → `127.0.0.1`) *before*
   the SSRF guard — range checks therefore apply to the resolved address (safe;
   documented in v7-ssrf).

## Non-claims

This spike does **not** demonstrate integration or production readiness, does not
verify HTTP transport/CSRF/CORS (C2 scope), does not use real accounts/credentials/
user data, does not exercise the Supabase-managed service itself, and does not close
any Stage 6 task (6.1–6.18 remain unchecked). With the C6-PG port it now DOES exercise
a real database engine's isolation behavior — a local PostgreSQL 17.11 with its default
READ COMMITTED plus explicit SERIALIZABLE probes (evidence in `results/pg/`,
findings in `results/SUMMARY-PG.md`) — but a local instance is not Supabase and this
is still simulator-contract evidence only. Layout: `src/` simulator (two DB engines),
`tests/` suites, `tools/` executors + race child, `results/` recorded evidence.
