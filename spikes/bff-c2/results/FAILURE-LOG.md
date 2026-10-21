# C2 spike — preserved failure evidence (all attempts, nothing hidden)

Every execution attempt of `tools/execute.mjs` on 2026-10-21 is recorded here.
Final matrix: **run 3 — 19/19 security PASS, full P1–P7 executed**.

## Run 1 — 2026-10-21T13:05:27Z — 9 security FAIL + runner crash (P3)

Console excerpt (verbatim, trimmed):

```
[FAIL] S2 Authenticated non-administrator hits admin endpoint — status=201 code=undefined state unchanged=false
[FAIL] S4 Expired session token and expired session row — expired-JWT=401 expired-row=200
[FAIL] S8 JWKS rotation and cache-window expiry — initial=200 cached-within-window=200 old-key-after-window=200 new-key=200
[FAIL] S10 Revoked administrator role effective at next request — before=200 after=200 JWT still valid=true
[FAIL] S11 Suspended account (at handover and mid-session) — handover=200 active=200 mid-session-suspend=200
[FAIL] S14 Simulated backend timeout (blackhole) → truthful503 — api=401 (unauthenticated) static-route=200 wall=5ms
[FAIL] S15 Simulated backend unavailability (5xx burst) — api=401
[FAIL] S16 Simulated quota exhaustion + kill switch denies intake — quota=401 kill-write=201
[FAIL] S17 Replay of logged-out and revoked sessions — logout=200 cookie-replay=200 revoked-row-reuse=200
[FAIL] S18 Logout then subsequent access rejected — before-logout=200 after-logout=200
EXECUTION FAILED: TypeError: Cannot read properties of undefined (reading 'p50')  (tools/execute.mjs:775)
```

Root causes found and fixed:

1. **Stub filter bug (harness)** — `Object.entries(urlSearchParams)` returns `[]`
   (`URLSearchParams` stores entries in internal slots), so every `?col=eq.value`
   lookup silently returned **all rows** (first-row-wins). This single bug
   explained S2 (wrong principal), S4b/S17b (wrong session row), S10 (other
   principals' grants), S11 (suspended principal shadowed by first row).
   Fixed: iterate `query.entries()`.
2. **Stub `reset` early-return (harness)** — `POST /__control {reset, jwks_max_age}`
   returned on `reset` and dropped sibling params. Fixed: fall through.
3. **Sign-in-after-fault ordering (harness)** — S14/S15/S16 injected the fault
   *before* signing in; the handover itself needs the backend, so no cookie was
   ever issued (`401`, not the expected backend-failure path). Fixed: sign in
   first, then inject.
4. **Kill-switch cache TTL (harness)** — the worker caches the kill flag for
   5 s (`KILL_CACHE_MS`); the S16 write landed inside a stale `killed:false`
   window. Fixed: wait out the TTL after `kill:true`.
5. **Worker bug (response-only, not authorization)** — sign-in's grants lookup
   omitted the `eq.` prefix (`?principal_id=p-admin`), which after fix (1) would
   have returned every principal's grants in the sign-in response body.
   Fixed: `?principal_id=eq.…`.
6. **Runner regression** — P3 referenced `perf.P2.coldSigninCpu` after it was
   renamed to `coldSigninHandlerClock` → crash before results were written.
   Fixed + the runner now persists partial results even on mid-run failure.

## Run 2 — 2026-10-21T13:20:11Z — 18/19 security PASS

```
[FAIL] S8 JWKS rotation and cache-window expiry — old-key-after-window=200
P4 kernel cpu/req @0/@100ms: 3.2 2.1 flat: false
log scan — secret in logs: true
```

Root causes found and fixed:

1. **S8** — the worker honors the *last* `Cache-Control` it saw; the cache was
   still inside a 300 s window adopted before the test, so the stub's new 1 s
   window was never adopted and rotation was never observed. Fixed: the test
   forces one bounded re-fetch (unknown-kid path) so the cache adopts the 1 s
   window before rotation. (Worker behavior itself was correct per AUTH.md §2.)
2. **P4 kernel flatness false** — the lat=0 batch ran immediately after P3's
   200 RSA-verify signins; GC work was attributed to the batch (3.2 ms vs
   2.1 ms). Fixed: discarded GC-settling warm-up batch before the sweep.
   Final: 1.9 / 1.8 / 1.8 / 2.1 ms — flat.
3. **Secret in local logs** — wrangler dev's startup bindings table echoes
   `[vars]` **values**, including `SESSION_SECRET`. Fixed: the per-run secret
   moved to `.dev.vars` (gitignored, regenerated per run, loaded by wrangler as
   a secret → displayed as `"(hidden)"`, verified zero occurrences in logs).

## Run 3 — 2026-10-21T13:30:08Z — **19/19 PASS, full matrix clean**

```
== done == {"PASS":19}
log scan — private key in logs: false | secret in logs: false
P1 kernel cpu/req seq/conc8: 2.03 / 2.07 ms
P7 errors: 0 | kernel cpu/req: 2.054 ms
```

Evidence: `results/summary-data.json`, `results/raw/run.json`.
Raw run-1/run-2 console output is preserved in this log; the run-3 full
machine-readable record is the committed JSON.

created by stokonn with love <3
