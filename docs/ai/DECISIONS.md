# Goldberg 0.11 — DECISIONS (Stage 5 view)

Pointer register — this file does not replace the canonical decision table in
`docs/planning/goldberg-0.11/stage-2/READINESS.md` or `docs/planning/goldberg-0.11/STAGES.md`.

## Owner-approved decisions governing Stage 5

| ID | Decision | Where it lands | Source |
|---|---|---|---|
| D5.1 | File-based manifests (not DB rows) with mandatory per-file rights | `OfflineBundle.kt`, `BundleManifestCodec.kt` (task 5.1) | Owner-approved; STAGE-CHECKLIST Stage 5 header |
| D5.3 | WorkManager for background scheduling (owner-mandated) | `BundleScheduler.kt`, `BundleDownloadWorker.kt` (task 5.8) | Owner instruction; STAGE-CHECKLIST Stage 5 header |
| D5.6 | Test-only org.json dependency (no production org.json) | androidTest/test Gradle additions | STAGE-CHECKLIST Stage 5 header |
| D7 | Measured storage caps + free-space reserve + per-job metered consent; no automatic mobile background downloads; prompt thresholds provisional (256 MiB limit / 8 MiB large-job / dynamic reserve, tunable in Stage 5) | `BundlePolicy.kt`, `BundleNetwork.kt` (task 5.3) | `stage-2/READINESS.md` D7 row; STAGE-CHECKLIST |

D4/D5/D8 (backend/Admin/cloud gates) remain unresolved later-stage dependencies and are out of
scope for Stage 5.

## Session-local test decisions (2026-10-20, test-only — no production change)

1. `Harness.published`/`stateOf` made `suspend`; consent-test `refresh` + shared `BundleJobStore`
   hoisted above the harness lambda; `harness()` accepts optional `jobs`. Rationale: suspend
   store reads were being called outside a coroutine context (compile errors).
2. Interruption fixtures use `chunkSize = 8` so `failAfterReads` fires mid-stream (the fake only
   drops when `reads > failAfterReads`; EOF reads are not counted).
3. Low-storage fixture reserves `usableSpace − 512 KiB` with a 1 MiB payload, so the manifest
   write fits but content does not (`reserve == usableSpace` would refuse even the manifest).
   Assertions unchanged.

## Owner decisions on F1/F2 (2026-10-20, resume session — both APPROVED as recommended)

- **F1 — retarget the test to the reachable contract (test-only, no production change).**
  Implemented: `invalidRightsQuarantineInsteadOfRetrying` replaced by
  `invalidRightsOnDiskQuarantineManifestAndDeactivatesJob`: a valid manifest is encoded, its
  `license` field blanked, and the JSON written straight to `manifests/` (simulating on-disk
  rights corruption, since D5.1 makes invalid rights unreachable through `save()`/`encode()`).
  Asserts: outcome `Permanent(MANIFEST_MISSING)`, job deactivated with that `lastError`, no
  published manifest, no active state, tampered bytes preserved in quarantine. No production
  change; codec validation stays as designed.
- **F2 — apply the minimal `BundleStore.installBlob` fix (production change, owner-approved).**
  Implemented: the dedup branch now verifies an existing target's length + sha256 against the
  staged copy before deduplicating. Valid target → dedup as before; invalid target → bytes
  moved to quarantine (`DEDUP_CORRUPT_REASON = "dedup_corrupt"`, never silently deleted —
  inline because `quarantineBlob` would deadlock on the already-held non-reentrant mutex), then
  the verified staged copy is installed so the **same attempt** repairs the corruption. If the
  quarantine rename fails → return `false` (fail-safe; caller turns that into a durable
  Retryable). Scope: ~12 lines in `BundleStore.kt`, no DB/backup/schema/signing impact.
  Verification: existing `corruptStoredBlobIsQuarantinedAndRepairedOnRetry` test + emulator run.

See `docs/ai/STATE.md` for the full investigation record of both findings.

## Owner-approved Stage 7 UI/UX direction (2026-10-20, planning-only — no code changed)

Pointer: full plan `docs/planning/goldberg-0.11/stage-7/README.md`; acceptance matrix
`docs/planning/goldberg-0.11/stage-7/UI-ACCEPTANCE-MATRIX.md`. All six screens are
Goldberg 0.11 Stage 7 scope; none is deferred to 0.12.

| ID | Decision | Where it lands | Source |
|---|---|---|---|
| S7.1 | Discover stays a separate tab; local-first search preserved; online search explicit; approved editorial layout (header, search, truthful privacy notice, categories, Recently Viewed, Available offline) | `DiscoverScreen.kt` (task 7.1) | Owner Stage 7 instruction; `01-discover.png` |
| S7.2 | Library screen headed "Your Collections"; filters All/Works/Artists/Albums/Lists ("Lists" = compact label); offline entry point → Stage 5 management; bottom tab label Library/Knihovna restored (0.10.1 approval); repertoire data/prefs untouched | `RepertoireScreen.kt` (task 7.2) | Owner instruction; `02-library.png`; 0.10.1 APPROVAL_MATRIX |
| S7.3 | Artist Profile = editorial portrait/header + essential works + real sources; Read More bio; never fabricate bio/dates/counts/relationships; unresolved identities stay visible | `ComposerScreen.kt` (task 7.3) | Owner instruction; `03-artist-profile.png` |
| S7.4 | Work Profile = title/composer/catalogue ID + prominent Add to Repertoire + compact sections (Overview/Structure/Arrangements/Recordings/Sources) with progressive disclosure; UUID-safe, duplicate-proof; no invented data; external Listen only with verified destination | `CompositionScreen.kt` (task 7.4) | Owner instruction; `04-work-profile.png` |
| S7.5 | Home = compact activity dashboard: greeting top-left, quote block top-right, Today Practiced + Streak, seven-day graph, 1–2 Recently Practiced; no gear/favorites/Start Practice/duplicates | `BalancedHome.kt` (task 7.5) | Owner Stage 7 instruction (supersedes 0.10 mockup gear) |
| S7.6 | Profile = musical identity: larger avatar/name, integrated About Me, Favorite Artist/Piece/Era, prominent Badge Showcase max 5 with direct selection; no Practice History/"Your Musical Journey"/generic Customize; pencil overlay + Settings gear kept; data unchanged | `ProfileScreen.kt` (task 7.6) | Owner Stage 7 instruction; 0.10.1 APPROVAL_MATRIX |
| S7.7 | Mockup conflicts resolved by preserving functional truth: no "our servers" copy (providers are third-party), no mockup biographies/counts/lists/covers as data, no mockup assets in APK, "See all"/Listen only with real destinations (conflicts C1–C6 listed in stage-7/README.md §9) | all six screens | Owner privacy/licensing policy; visual-references README |

Owner-approved Discover privacy notice wording (2026-10-20, subject to implementation
accuracy): EN "Local search works offline. When you explicitly start an online search,
your query is sent to external music-data providers." · CZ "Místní vyhledávání funguje
offline. Když výslovně spustíte online vyhledávání, dotaz se odešle externím
poskytovatelům hudebních dat." (resolves conflict C1).

Owner integration decisions (2026-10-20): the four visual-reference PNGs + READMEs are
tracked in Git on this branch (design references, never APK assets); GitHub tracking goes
to the existing Issue #31 only (no duplicate issues; Stage 7 stays pending, Stage 5 stays
In Progress); this documentation branch is **not** merged into the active Stage 5 branch —
reconcile/integrate only after Stage 5 reaches a safe verified checkpoint, with owner
approval.
