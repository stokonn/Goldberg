# C6-PG — Stage 6 contract behavior vs real PostgreSQL: findings (Goldberg 0.11)

**Spike branch:** `spike/goldberg-0.11-stage-6-contract-pg` (from
`spike/goldberg-0.11-stage-6-contract` @ `d2a95d4`). **Never merged. Never deployed.**
Owner task of 2026-10-22: verify the existing C6 contract tests against a real,
isolated, LOCAL PostgreSQL instance. Synthetic data only; no Supabase project was
created; no cloud resource was touched; no production code was implemented.

## What was run (executed — actual results)

| Venue | Engine | Tests | Pass | Fail | Skipped | Evidence |
|---|---|---|---|---|---|---|
| SQLite post-port regression | `node:sqlite` (Node 22.23.1) | 86 | 79 | 0 | 7 (v10 is PG-only) | `results/pg/raw/tap-sqlite-postport.txt` |
| PostgreSQL | **PostgreSQL 17.11** (podman `c6-pg`, `127.0.0.1:54329`, default isolation **`read committed`**, trust auth on loopback) | 86 | **86** | **0** | 0 | `results/pg/raw/tap-postgres.txt` |

- Static isolation scan: **PASS** (20 files, no external-network surface; the only
  socket use is the `pg` driver → loopback instance).
- Baseline: the original C6 SQLite venue at `d2a95d4` was 79/79. The async port did
  **not regress** it (79/79 + 7 honest skips).
- Command: `C6_PG_URL=postgres://c6spike@127.0.0.1:54329/c6spike node tools/execute-pg.mjs`
  → `results/pg/summary-data.json`, `results/pg/environment.json`.
- v9 multi-process race, 10 trials per engine:
  - SQLite: **10/10 → `[201, 409]`** (T10 invariant holds; BEGIN IMMEDIATE write lock).
  - PostgreSQL (READ COMMITTED): **10/10 → `[201, 500]` / `[500, 201]`** — the T10
    invariant (`[201, 409]`) **never held**; the loser received a 500.

## Finding F1 — transaction isolation & concurrent moderation (T10) — THE key finding

The faithful C6 decision transaction does **not** survive PostgreSQL's default
READ COMMITTED (the same default Supabase's PostgREST pool uses):

1. **v9 (probabilistic, multi-process):** 10/10 PG trials ended `[201, 500]` — the
   loser's `INSERT INTO published_entities` collided with the winner's committed row
   (SQLSTATE **23505**), which the server maps to `500 internal`. The contract
   requires the loser to see **409 conflict**. Never `[201,409]`.
2. **v10 ISO-1 (deterministic, exact statement interleaving):** when the target entity
   already exists (the *amendment* case — no PK collision path), the stale read lets
   **BOTH** approves commit: 2 `published_revisions`, 2 `review_events`, 2 approval
   audit rows — a **double-approve / lost update**, exactly what T10 forbids.
3. **Root cause:** SQLite `BEGIN IMMEDIATE` acquires the database write lock *at
   BEGIN*, so the status guard is serialized. PostgreSQL `BEGIN` locks nothing at
   `SELECT status …`; the guard reads stale state and nothing in the statement
   sequence re-checks it. **`BEGIN IMMEDIATE` has no PostgreSQL equivalent** — this
   is the single most important SQLite test assumption that does not translate.
4. **Fixes demonstrated (probes only — NOT implemented anywhere):**
   - **ISO-2:** `SELECT … FOR UPDATE` on the submission row restores the invariant
     under READ COMMITTED (loser blocks, then observes `published` → guard → 409;
     exactly one decision commits). **PASS**
   - **ISO-3:** `ISOLATION LEVEL SERIALIZABLE` aborts the loser with SQLSTATE
     **40001** `serialization_failure` and a single decision commits. **PASS** — but
     the current server maps unknown errors to `500`, so a serializable production
     design must explicitly map **40001 → 409** (and decide on retry policy).

**Consequence (docs-only, task 6.1 design input):** the production decision path must
adopt one of the two demonstrated patterns (row lock, or serializable + 40001→409
mapping) and document it. Not implemented here — production implementation stays
gated on 6.0f (UNCHECKED).

## Finding F2 — database constraints & rollback

- **Rollback atomicity holds identically on PostgreSQL** — v6.1/v6.2 fault injection
  mid-approval returned 500 with **full rollback** (zero residual publication/feed/
  audit rows) and a subsequent retry succeeded exactly once. 77/77 of the shared
  suites passed on both engines.
- **Schema gap (both engines): the C6 DDL defines NO foreign keys.** v10 CONS-2 shows
  an orphan `published_revisions` row (nonexistent entity + submission) is accepted
  silently by PostgreSQL (and SQLite). Recorded for task **6.1 production DDL**: add
  FK constraints + decide on delete/quarantine semantics. Probed so it cannot regress
  silently.

## Finding F3 — idempotency

- Full contract behavior (replay, mismatch 422, per-principal scoping, ≥24 h expiry,
  failed-request non-consumption) passed **identically on both engines** (v5 7/7).
- **Concurrent duplicate `(principal_id, key)` insert → SQLSTATE 23505** unique
  violation (v10 CONS-1). The faithful `storeIdempotency` INSERT would surface as a
  **500** under a concurrent same-key race; production must catch **23505** and serve
  the stored replay response instead. (SQLite's write lock hides this race entirely.)

## Finding F4 — audit integrity

- Append-only verification + tamper/deletion detection passed **identically on both
  engines** (v8 6/6; chain coherent after every v9 PG trial).
- **Audit seq generation races:** the C6 pattern "read last seq *inside* the
  transaction, insert `last+1`" collides on the seq PK under concurrency (v10
  CHAIN-1 → **23505**). PostgreSQL `BIGSERIAL`/sequences or a row lock must serialize
  seq assignment in production DDL (task 6.1). SQLite's global write lock masks this.

## Finding F5 — SQLite → PostgreSQL differences actually encountered

| # | Difference | Symptom observed | Handling in this spike |
|---|---|---|---|
| 1 | `BEGIN IMMEDIATE` | no PG equivalent | adapter translates to `BEGIN`; **semantics differ (F1)** |
| 2 | `ON CONFLICT DO UPDATE SET x = x + 1` unqualified | PG error **42702** ambiguous column | qualified `table.x` (valid on both engines) — real portability fix |
| 3 | `rowid` | no such operator | `BIGSERIAL id` column + adapter translation |
| 4 | `?` placeholders | PG uses `$1..$n` | adapter translation |
| 5 | **int8/BIGINT default parser** | raw driver returns **strings** (`created_at`, `COUNT(*)`) → JSON would emit strings, breaking envelope types | adapter installs Number parsers; v10 TYPE-1 asserts both the driver default (string) and the adapter behavior (number) — production must configure parsers too |
| 6 | parallel test-file processes | cross-file schema name collision (23505 on `pg_namespace`) | per-process schema prefixes (harness detail) |

## What passed identically (shared contract)

v1 validation, v2 authz, v3 existence, v4 moderation, v5 idempotency, v6 failures,
v7 SSRF, v8 chain — **77/77 on PostgreSQL and 77/77 on SQLite from the same source**;
the async port itself is regression-free (79/79 SQLite).

## Honest non-claims

- A **local** PostgreSQL 17.11 is **not** the Supabase Free service (PostgREST pool,
  Supabase-managed config, Supabase backups/RLS). The **Supabase-hosted proof remains
  BLOCKED** (D5b/Q1 unresolved + C4 open + ORD-A steps 4–6; NOT AUTHORIZED).
- No production server exists; F1's fixes are probe demonstrations only; nothing here
  closes tasks 6.1–6.18; **6.0f stays UNCHECKED**; Q1/D5b unchanged (Q1-D recorded as
  owner preference only); C4 OPEN; C2 §12 OPEN; ORD-A sequencing-only; 0 CZK/month;
  Stage 7 untouched.
- The `pg` npm dependency exists **only on this spike branch** (SQLite venue stays
  zero-dep); it is not introduced anywhere in the application.
- Podman container `c6-pg` is stopped and removed after evidence capture (CR-7-style
  cleanup); recreation commands are in the spike README.

## Next required action

1. Owner reviews these findings (checkpoint synced to `docs/planning/…/stage-6/` +
   Issue #31).
2. At task **6.1 (production DDL/API design — gated on 6.0f)**: choose and document
   the F1 concurrency pattern (`SELECT … FOR UPDATE`, or SERIALIZABLE + 40001→409),
   add FK constraints (F2), serialize audit seq (F4), catch 23505 for idempotent
   replay (F3), and configure int8 parsers (F5.5) — each with its own test.
3. D5b/Q1 professional review remains the blocker for any provisioning (including the
   eventual Supabase-hosted re-verification of F1/F3/F4 under PostgREST).

created by stokonn with love <3
