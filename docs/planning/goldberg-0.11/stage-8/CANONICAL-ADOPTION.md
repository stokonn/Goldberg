## Published release candidate — October25,2026

Goldberg0.11-rc.1 is published as a prerelease,source/tag a73a7e21adf656dcbe7ed6da351a71e9a681a384.
Signed non-debuggable release/code12/trusted53efcertificate;SHA256c5662d8ead2b175fac0be09145776e84936c2b8f794c85b967f71aaab1938bb5.
302JVM PASS;API36native203/192pass/11existing fixture-probe skips/0failures;
seeded upgrade/offline/process-death integrity PASS. Essential CI SUCCESS.
Stage6engine f300b09:506bodies andactualKotlin/HTTP/PG1PASS;hosted Supabase20RLS
bootstrap verified. Production networking/real-user collection remainsdisabled;
no Worker/credential/session deployment. Finalcloud gates andStage6 acceptanceOPEN.
Actual release andremaining blockers: https://github.com/stokonn/Goldberg/releases/tag/v0.11-rc.1
Source/CI/artifact details: docs/planning/goldberg-0.11/stage-8/RELEASE-CANDIDATE-VERIFIED.md.
No main merge/physical phone/public cloud activation. Earlier checkpoints below historical.

---

# Canonical Stage 6 client adoption in isolated Stage 8 integration

Status:LOCALLY VERIFIED SERVICE INTEGRATION;UI adoption andwhole-stage acceptance
remain PARTIAL. Branch integrate/goldberg-0.11-canonical-client is based on42f6897.
The accepted Stage7A/7B anddirty Stage8 worktrees were preserved without edits.
Current owner instruction authorizes this isolated source combination;earlier
preparation-only restrictions remain historical.

Purpose/scope:adopt the exact Stage6 canonical codec/client/audit verifier plus an
application-scoped repository andthe existing Android transport seam. No personal
Room/schema/migration/journal/practice changes,dependencies,network activation or
UI changes. Contract loading/decoding is off main;tokens/uncertain intent remain
in memory;process recreation requires fresh authentication. Production uses the
existing DisabledAdminTransport regardless of a persisted endpoint.

- [x] Recover reviewed integration sequence andinventory legacy consumers.
- [x] Preserve accepted legacyUI,Keystore,marker/settings andexisting fixture corpus.
- [x] Add exact canonical shared schema/codec/session/review/audit implementation.
- [x] Bind canonical application repository via suspend lazy factory andAndroid
  transport abstraction;boundedUTF8/no redirects/no endpoint switching.
- [x] Synchronize generation/cache guards;clear sensitive state before logout I/O;
  live capabilities,dual revisions,explicit confirmation anduncertain exact replay.
- [x]302 JVM tests PASS/0failures/errors/skips,including20canonical and7repository
  tests. First4derived-fixture identity mismatches retained in first-attempt/;
  corrected by binding test capabilities to the same token principal/session.
- [x] Debug APK,testAPK compilation andlint0errors132warnings1hint PASS atreviewed
  source. Final source/raw/hash receipt in results/canonical-integration-2026-10-25.
- [x] Actual Kotlin service→loopbackHTTP→BFF→PostgreSQL integration executed1PASS
  at final reviewed source: Stage6 services/community-bff/results/local-f0323084bea14437995a58a3e368e715/result.json.
  This executes challenge/login/caps/queue/detail/Comparison/open/confirmed reject/
  stats/audit/bodyless logout,not only captured-fixture replay.
- [x] Execute all4new native canonical application tests PASS;full API36 suite203/192pass/11existing skips/0failures. Local host emulator failure retained;no physical-device use.
- [ ] Adapt accepted legacy UI/service models to canonical decimal/dual revisions,
  Comparison/serverstats/audit semantics. No lossyInt conversion orlegacy fallback.
- [ ] Final accepted UI/account/Keystore lifecycle/seeded-upgrade combined acceptance.
- [ ] Public version/OAuth/real policies andhosted integration;owner acceptance.

Normal host gate:
./gradlew testDebugUnitTest assembleDebug assembleDebugAndroidTest lintDebug --no-daemon --max-workers=1

Actual HTTP/PG integration compiles its separate source set only with
-PgoldbergCanonicalIntegration=true;the Stage6 disposable runner supplies
SCHEMA_PG_PORT andGOLDBERG_BFF_SOURCE. This test-only loopback transport is never
packaged/selected in the application. No skipped external test is counted as pass.

No screenshot inspection was required/performed:existing UI was not changed.
API26 image absent;API36 nativeCI is the supported fallback.Local emulator logs
retain disk-capacity failure andtwohostSIGSEGVs;no local native success inferred.
Current APK remains development0.10.1/code11/com.opus.piano;trusted certificate
53eface4978f03dd7f0d7f1eb97ab94eed97055fe04a2a0fab9a7f280141d59e verified.
No release,main merge,tag,public service orpractice data synchronization.

created by stokonn with love <3
