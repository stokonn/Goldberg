# C6-PG concurrency hardening — SELECT FOR UPDATE vs SERIALIZABLE (Goldberg 0.11)

**⚠ EXPERIMENTAL MITIGATION SPIKE — NOT PRODUCTION CODE, NEVER MERGED, NEVER DEPLOYED.**
Continuation of the C6-PG findings (`results/SUMMARY-PG.md`, F1/F3/F4) on the same
isolated spike branch `spike/goldberg-0.11-stage-6-contract-pg`. Synthetic data only;
a LOCAL podman PostgreSQL 17.11; no Supabase project; no cloud resource; no
production code. The faithful sources (`src/server.mjs`, `src/db-pg.mjs`,
`tools/execute-pg.mjs`, `tools/decide-child.mjs`) and the **original failing
evidence** (`results/pg/`) are byte-for-byte untouched, so the 10/10-deviation
reproduction stays available.

## Purpose

F1 (READ COMMITTED duplicate/lost decisions and loser-500 instead of 409), F3
(concurrent idempotency INSERT 23505 → 500 instead of stored replay) and F4
(audit seq read-last-inside-transaction race) were, until now, *probed*. This stage
implements both candidate mitigations **over the same decision step sequence**
(mirroring `runDecision` steps 1–7 exactly) and compares them empirically:

| Strategy | Concurrency control | Audit append (F4) | SQLSTATE handling |
|---|---|---|---|
| `for-update` | `BEGIN` + `SELECT … FOR UPDATE` on the submission row (READ COMMITTED re-evaluates after the lock wait → loser observes `published` → 409) | single-row `audit_head` table lock (mutex); read-last-seq is race-free once the head is held | none needed — the conflict never materializes (0 retries observed) |
| `serializable` | `BEGIN ISOLATION LEVEL SERIALIZABLE`, faithful statement sequence (no row locks) | faithful read-last-seq kept; a 23505 on the seq PK is promoted to a retryable conflict | explicit: bounded retry on **40001 / 40P01 / 23505**; exhaustion maps to a **409** envelope — never an unhandled 500 |

Both share the F3 store hardening: a 23505 on the idempotency INSERT re-reads the
winning row and **serves its stored replay** (same request hash) or the faithful
**422 idempotency_mismatch** (different body).

**Scope (documented):** the hardened server (`src/harden.mjs`) implements ONLY
`POST /v1/admin/submissions/:id/decisions` — auth gate, envelope + allowlist,
kill switch, idempotency layer, decision transaction. All other endpoints and
quotas remain the faithful server's responsibility (v1–v10, untouched).

## What was run (executed — actual results, 2026-10-22)

Command: `C6_ENGINE=postgres C6_PG_URL=postgres://c6spike@127.0.0.1:54329/c6spike node tools/execute-hardening.mjs`

| Venue | Tests | Pass | Fail | Skipped | Evidence |
|---|---|---|---|---|---|
| SQLite regression (faithful server only; v10+v11 are PG-only) | 93 | 79 | **0** | 14 | `raw/tap-sqlite-regression.txt` |
| PostgreSQL hardening (v1–v11, PostgreSQL 17.11, default `read committed`) | 123 | **123** | **0** | 0 | `raw/tap-postgres-hardening.txt` |

- Static isolation scan: **PASS** (23 files; the only socket use is the `pg` driver →
  loopback instance; `child_process` confined to the race tests + child tools).
- SQLite regression: 79/79 pass — **the faithful behavior is unchanged by this
  branch's additions** (v1–v9 all still green; v10/v11 honest PG-only skips).
- `results/pg/` (original 10/10-deviation evidence) untouched — verified by
  `git status`: only the new files below are added.

## v11 suite — results per test (PostgreSQL venue)

| Test | Strategy | Result | Telemetry |
|---|---|---|---|
| V11-1 in-process approve race (new + pre-existing entity) | for-update | 2× `[201,409]`, exactly-one-decision counts, chain coherent | **0 retries, 0 exhausted** |
| V11-2 in-process approve race (new + pre-existing entity) | serializable | 2× `[201,409]`, exactly-one-decision counts, chain coherent | 2× `40001` aborts (loser retried → 409), 0 exhausted |
| V11-3 **repeated multi-process barrier race, 20 trials** | for-update | **20/20 `[201,409]`** — never 2×201, never 500 | **0 retries, 0 exhausted** |
| V11-4 **repeated multi-process barrier race, 20 trials** | serializable | **20/20 `[201,409]`** | 21× `40001` (≈1 per trial), 0 exhausted |
| V11-5 contract + negative behavior (11 subtests × 2 strategies) | both | happy path, stored replay, 401/403/400/409/503, kill switch, concurrent same-key dup `[201,409]` + one stored row + one decision, fault injection → 500 with full rollback then clean retry — **all pass** | — |
| V11-6 F3 deterministic store race (2 connections, xact-lock blocked INSERT) | both | loser's 23505 serves the winner's stored replay (exactly 1 row); different body → 422 | — |
| V11-7 F4 audit integrity at scale, 20 concurrent decisions | for-update | 20×201, seqs strictly consecutive, distinct seq per decision, chain coherent | **0 retries** |
| V11-7 F4 audit integrity at scale, 20 concurrent decisions | serializable | 20×201, seqs strictly consecutive, distinct seq per decision, chain coherent | **218× `40001`** (maxAttempts=64), 0 exhausted |

Multi-process V11-3/V11-4 outcomes (both 20/20):
`[[409,201],[409,201],[201,409],…]` — the exact invariant the faithful server
violated 10/10 times in v9 (`[201,500]`).

## Comparison conclusion (engineering, from this evidence)

1. **Recommended: `SELECT … FOR UPDATE` (row lock) on the submission row + the
   `audit_head` append mutex.** Deterministic outcomes (20/20), **zero** SQLSTATE
   retries and zero exhausted retries in every test including the 20-way scale run,
   no SSI false-abort exposure, and the loser's 409 comes from the ordinary status
   guard — the contract path, not an error-mapping path.
2. **SERIALIZABLE + SQLSTATE handling also restores the invariant** (20/20, 0
   exhausted with bounded retry), proving F1/F4 can be solved without row locks —
   but the faithful read-last-seq audit pattern under SSI is retry-costly: at 20-way
   concurrency it burned **218 `40001` aborts** (maxAttempts had to be 64). A
   serializable production design must either keep a bounded-but-generous retry
   budget, or serialize audit seq assignment by other means (e.g. sequence/ID
   generator), and must map exhausted 40001/40P01/23505 to **409** — never 500.
3. **F3 mitigation verified deterministically:** concurrent duplicate idempotency
   inserts serve the stored replay (or 422 on hash mismatch). Sequential duplicates
   were already replayed faithfully (v5).
4. **Known design observation (documented, not a bug):** a *concurrent* same-key
   duplicate on the decision endpoint answers `[201,409]` (the decision is
   exactly-once; the loser hits the status guard before any replay can exist);
   *sequential* same-key duplicates get the stored replay. Task 6.1 must state
   this in the API contract.
5. **Nothing here changed production behavior.** The faithful `runDecision` still
   has F1/F3/F4 as found; production implementation stays gated on **6.0f
   (UNCHECKED)**. These mitigations exist only to de-risk and inform task 6.1's
   design choice with measured evidence.

## Honest non-claims

- A local PostgreSQL 17.11 in a rootless podman container is **not** the Supabase
  Free service (PostgREST pool, managed config, backups/RLS). The **Supabase-hosted
  proof remains BLOCKED** (6.0f UNCHECKED, D5b/Q1 unresolved, C4 OPEN, ORD-A
  sequencing-only).
- Test counts of 20 trials characterize this spike's runs; they are not a formal
  concurrency proof. The deterministic probes (V11-6 xact-lock race; in-process
  V11-1/2) complement the probabilistic ones.
- The V11-7 serializable retry count (218) is a measured single-run figure; it will
  vary by timing. The invariant asserted is all-201 + consecutive seqs + 0 exhausted.
- This spike branch is **never merged**; `pg` stays a spike-only dependency; the
  SQLite venue stays zero-dep. 6.0f/6.1–6.18 UNCHECKED; Q1/D5b/C4/C2-§12 unchanged;
  0 CZK/month; Stage 7 untouched.
- Podman container `c6-pg` is stopped and removed after evidence capture;
  recreation commands are in the spike README.

## Reproduce

```bash
podman run -d --name c6-pg -e POSTGRES_USER=c6spike -e POSTGRES_DB=c6spike \
  -e POSTGRES_HOST_AUTH_METHOD=trust -p 127.0.0.1:54329:5432 \
  docker.io/library/postgres:17-alpine
# wait for readiness, then:
cd spikes/contract-c6
C6_ENGINE=postgres C6_PG_URL=postgres://c6spike@127.0.0.1:54329/c6spike \
  node --test tests/v11-concurrency-hardening.test.mjs          # v11 alone
C6_PG_URL=postgres://c6spike@127.0.0.1:54329/c6spike \
  node tools/execute-hardening.mjs                              # full evidence run
```

`tools/execute-pg.mjs` remains the historical executor for the ORIGINAL evidence at
`e37ed00` (v1–v10; its scan-exception list predates v11 — use
`tools/execute-hardening.mjs` for the current full suite).

created by stokonn with love <3
