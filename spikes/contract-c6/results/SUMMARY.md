# C6 spike — contract-behavior verification results (Goldberg 0.11 Stage 6)

**Verdict: 79/79 tests PASS, static isolation scan PASS — LOCAL SIMULATOR SCOPE ONLY.**
Isolated local experiment per the owner-authorized Stage 6 verification-prototype
instruction (2026-10-22). **Not** production Stage 6 implementation, **not**
integration/production readiness, **not** 6.0f acceptance.

- Run: `2026-10-22T06:40:20.323Z` → `06:40:23.144Z` (executor run; suite exit 0)
- Branch: `spike/goldberg-0.11-stage-6-contract` (isolated; planning baseline `c22adb1`)
- Raw evidence: `results/raw/tap.txt`, `results/raw/run.json`,
  `results/summary-data.json`
- Tooling: Node.js v22.23.1, `node:test` + `node:sqlite` (built-in, experimental —
  ExperimentalWarning recorded in TAP), **zero npm dependencies, zero network calls**
- Static scan: 17 files, no `node:http`/`node:net`/`node:dns`/`fetch`/`undici`/
  `wrangler` surface (child_process permitted only for the in-repo race test)

## 1. Executed verification (all actually run, this run)

| # | Scenario group | Result |
|---|---|---|
| V1 (16) | Validation: allowlist, caps 16 KiB/20 fields/10 URLs/depth, mass-assignment, HTML/control chars, license, UUID, personal-data key rejection, quota≠validation | 16/16 PASS |
| V2 (14) | Authz: 401 missing/garbage/expired/revoked session, default-deny 403s, actor≠author, suspension live at next request, live role revocation, T22 no-self-grant + no audit-mutation endpoint + no DELETE /v1/me | 14/14 PASS |
| V3 (9) | Existence-hidden 404 (identical oracle-safe envelope), cross-user revision/withdraw 404 unchanged rows, moderator/owner reads, pending never public, own-rows only, deterministic cursor paging, no route smuggling | 9/9 PASS |
| V4 (10) | Approve atomicity (all canonical-order effects exactly once), reject terminal, request_changes → immutable revision → approve at revision 2, stale expectedRevision 409 with current state, sequential double-decision (one commits), withdrawal terminal both directions, decision-body 400s, nonexistent 404, queue/detail history, quarantine (reason required, capability-gated, feed keeps evidence, double-quarantine 409) | 10/10 PASS |
| V5 (7) | Idempotency: replay same result no second effect, mismatch → 422, decision replay single publication + mismatch, per-principal key scoping, ≥24 h expiry (replay before / fresh after), failed request doesn't consume key, quota doesn't consume key | 7/7 PASS |
| V6 (7) | Fault injection mid-approval → 500 + FULL rollback (no publish/status/review/feed rows, chain intact, no idempotency row) + retry-once success; fault before publish row same; kill switch 503 writes / reads continue / recovery; daily-cap 429 + pending-cap 429 on fresh day + withdrawal frees slot without deletion; error taxonomy distinct [400,401,403,404,429] no internals leaked; requestId on success | 7/7 PASS |
| V7 (8) | SSRF static guard: metadata/loopback/IPv6+v4-mapped (incl. WHATWG hex canonicalization `::ffff:7f00:1`), private/special ranges, dangerous schemes, credentials/ports/.local, invalid octets + non-4-part numeric hosts, contract-level 400 enforcement, public https accepted without fetching | 8/8 PASS |
| V8 (6) | Audit chain: verifies after full lifecycle (7 rows), tamper detected at exact seq, deletion detected, no mutating API route exists, admin-only export + independent hash recomputation, submission mutations cannot rewrite history | 6/6 PASS |
| V9 (2) | **Multi-process race (10 trials):** barrier-synced independent Node processes approving concurrently → every trial exactly `[201,409]`, one publication, one review event, one approval audit row, coherent chain; scratch-disposability check | 12/12 PASS |

Totals: **79 tests, 79 pass, 0 fail, 0 skipped** (exit 0).

### Failure log (first attempts — preserved for honesty)

Run 1: **69/79 pass, 10 fail.** Root causes (all fixed; none was a contract violation
masked by a weakened assertion):
1. `checkIdempotency` threw an uncaught `HttpError` → V5.2/V5.3 crashed instead of
   returning 422 — **server bug**, fixed with try/catch converting to a 422 response.
2. V4.4 used a revision flow the contract does not allow (revising a `submitted`
   submission) — **test bug**, restructured through `request_changes`.
3. V5.5/V6.4/V6.5 advanced the fake clock past the 1 h session TTL and then reused
   the session → 401 — **test bug**, re-authenticate after day jumps (V2.3 behavior).
4. V6.1 asserted `body.requestId` on an error envelope where requestId lives at
   `body.error.requestId` — **test bug**, fixed.
5. V7.1/V7.6: WHATWG URL canonicalizes `::ffff:127.0.0.1` → `::ffff:7f00:1` and
   shorthand `1.2.3` → `1.2.0.3` — **guard gap + test expectation**, guard now parses
   hex-form v4-mapped addresses and refuses any non-4-part numeric host; shorthand
   resolution documented as a finding (resolved address is what gets range-checked).
6. V8.5 expected a 64-hex `prevHash` on the first chain row — **test bug**, row 1
   anchors with `GENESIS`.

## 2. Reused from C2 (not re-executed here)

C2 spike (`spike/goldberg-0.11-c2-bff` @ `7bc6976`): 19/19 security scenarios over
real workerd HTTP (JWT forgery, JWKS rotation, CSRF/CORS, session revocation), kernel
CPU method (2.03 ms avg/invocation), CONDITIONAL PASS with §12 open. This spike trusts
those for the token/transport layer and verifies the business-logic contract above it.

## 3. NOT executed (precise blockers)

- C2 §12 production-runtime verification → needs a deployed Worker = provisioning
  (6.0d; blocked by D5b/Q1 unresolved, C4 open, ORD-A steps 4–6 not authorized).
- All [I]-venue rows: real Google OAuth/JWKS, real Supabase quota/pause/latency,
  browser CSRF/CORS against deployed Admin, real RPO drill → same provisioning gate.
- Real Postgres serializable-isolation proof → Supabase not provisioned; v9 proves
  contract-level single-commit under SQLite write locking only.
- HTTP transport, cookies, TLS, CORS/CSRF headers → C2 scope, not repeated.
- Production server implementation (tasks 6.1–6.18) → gated on 6.0f + authorization;
  nothing here is production source (isolation: `spikes/contract-c6/` only).
- CPU budget → C2 already measured; not repeated.
- Lint/emulator/Android checks → out of spike scope (no app code touched).

## 4. Limitations

In-process dispatch (no HTTP transport); SQLite ≠ Supabase Postgres (engine semantics
unverified); simulated auth (fake sessions — token crypto NOT re-tested, C2 covered);
T14 static portion only (no DNS/redirect/rebinding — no network exists here); race
outcome-invariant asserted, wall-clock interleaving order not asserted; `node:sqlite`
is experimental on Node 22; contract ambiguities (see README) interpreted conservatively
and flagged for implementation-time decisions.

## 5. Non-claims

No integration or production readiness is claimed from these simulated results. No
Stage 6 task (6.1–6.18) is closed by this spike. 6.0f remains UNCHECKED; Q1/D5b
unresolved; C4 open; ORD-A sequencing-only; 0 CZK/month, no billing/spending, no
cloud resources created, no merge, no tag, no release.
