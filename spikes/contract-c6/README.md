# spikes/contract-c6 — Stage 6 contract-behavior verification spike (Goldberg 0.11)

**Isolated synthetic simulator. Local execution only. Never deployed. Never merged.**
`wrangler deploy`, cloud provisioning, and any real-credential use are forbidden for
this directory. Scope authority: the owner-authorized Stage 6 local-only verification
prototype instruction (2026-10-22), mirroring the C2 spike precedent. See
`docs/planning/goldberg-0.11/stage-6/` for the normative contract.

Branch: `spike/goldberg-0.11-stage-6-contract` (created from planning HEAD `c22adb1`).
Planning branch stays untouched; planning-doc sync happens separately, without merging
this spike's code (C2 pattern: spike docs commit, then planning-branch docs commit).

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

## How to run

```bash
node tools/execute.mjs     # static isolation scan + full suite + results/ (~5 s)
# or manually:
node --test tests/*.test.mjs
```

Zero npm dependencies — no `npm install` is needed or permitted. Requires Node ≥ 22.5
(`node:sqlite`, experimental; the ExperimentalWarning is recorded in the raw TAP).

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
- **Real Postgres serializable-isolation proof** — Supabase Free not provisioned;
  v9 verifies contract-level conditional commit under SQLite's write lock only.
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
verify HTTP transport/CSRF/CORS (C2 scope), does not exercise a real database engine's
isolation level, does not use real accounts/credentials/user data, and does not close
any Stage 6 task (6.1–6.18 remain unchecked). Results are simulator-contract evidence
only. Layout: `src/` simulator, `tests/` suites, `tools/` executor + race child,
`results/` recorded evidence.
