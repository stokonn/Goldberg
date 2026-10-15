# Opus

A native, offline-first piano practice companion for acoustic pianists. Kotlin, Jetpack Compose, Material 3, Room, and MVVM. Android 8.0 (API 26) or newer.

## Phase 1

- **Home:** today's practice minutes, repertoire totals and performance readiness, completed session count, and recent activity. All values come from the local database; no sample statistics.
- **Repertoire:** add, edit, delete, search, filter by learning status, and sort by title or composer. Each piece includes title, composer, difficulty, status, and optional notes. Deletion requires confirmation.
- **Practice:** optional piece selection or free practice, start/pause/resume, discard confirmation, and finish/save. Completed sessions persist locally and update Home.
- **Quests / Wrapped:** explicit placeholders for future goals, XP, achievements, and monthly/yearly reflections.
- Charcoal surfaces, warm ivory text, restrained gold accents, serif headings, and fading screen transitions.

No microphone access, audio recording, accounts, or analytics. The optional classical catalogue uses internet access to Open Opus and Wikimedia services; repertoire entries, practice sessions, and personal notes are never uploaded. App data stays in a Room database on the device. Android cloud backup is disabled. Uninstalling the app clears the data.

## Open and build

Open this directory in a recent Android Studio supporting AGP 9.1. Allow Gradle sync to finish. `local.properties` specifies this machine's SDK path:

```properties
sdk.dir=/home/stokonn/Android/Sdk
```

On another machine, set that property to its SDK path. Install Android SDK Platform 36 and Build Tools 36.0.0, or let Gradle install them after accepting Android SDK licenses.

```bash
./gradlew assembleDebug
./gradlew lintDebug
# With a running emulator or connected device:
./gradlew connectedDebugAndroidTest
```

APK: `app/build/outputs/apk/debug/app-debug.apk`.

The wrapper pins Gradle 9.3.1, which supports running on the installed Java 25. Android Studio's bundled JBR on this machine is also Java 25, so no JBR fallback is needed. Java/Kotlin bytecode targets Java 17. For a different setup, use a compatible JDK via `JAVA_HOME` or Android Studio's Gradle JDK setting. Initial builds need internet for dependencies; practice, personal repertoire, and previously loaded catalogue information work offline. Discovering new catalogue information needs an internet connection.

Dependencies are pinned: AGP 9.1.0 (built-in Kotlin 2.2.10), Compose compiler 2.2.10, Compose BOM 2025.08.01, KSP 2.3.12, Room 2.7.2, Lifecycle 2.9.2, Navigation 2.9.3, and Activity 1.10.1. KSP 2.3 supports AGP's built-in Kotlin source handling.

## Architecture

- `data/OpusDatabase.kt`: Room entities, enum converters, DAO, database, and repository. Repertoire and session lists are observable flows. Room handles asynchronous writes; the UI never queries the database directly. Version 1 and 2 schemas are exported to `app/schemas`. Migration 1 → 2 adds catalogue storage and a nullable unique source ID without recreating repertoire or history tables. No destructive migration fallback.
- `OpusApplication.kt`: application-scoped repository and database, created lazily without a dependency injection framework.
- `ui/OpusViewModel.kt`: shared screen state, repository mutations, error messages, and manual timer. Flows are collected with lifecycle awareness. SavedStateHandle retains the timer's last checkpoint and selected piece if Android recreates the process.
- `ui/OpusApp.kt`: stateless screen data rendering, forms, local presentation state, and Navigation Compose routes. A single activity-scoped ViewModel keeps practice active while navigating.
- `ui/Theme.kt`: Material 3 palette and typography.

The timer uses `SystemClock.elapsedRealtime()` so wall-clock changes do not alter practice duration. It continues while paused in the background **if the app process remains alive**, and survives activity rotation. Pausing excludes break time. After process recreation it restores the last recorded checkpoint as **paused**; it does not infer practice while the app process was absent. This is intentionally a manual Phase 1 timer, without a foreground service or notification. Finish saves only sessions of at least one second; a failed write retains the timer for retry. Focus selection is locked once the timer starts.

Sessions contain a piece ID and title snapshot. They deliberately survive deleting the repertoire entry, and retain the title used when practice began. Learning status is user-maintained, not inferred from duration. Dashboard dates use the device's local time zone, and today's minutes are the sum of sessions completed today (rounded down after summing).

## Verification

The instrumentation test `DatabaseTest.repertoireCrudAndHistorySurviveReopening` checks add/update/delete, reopening a disk-backed Room database, persisted notes and session durations, and preserving session history after deleting a piece.

Manual acceptance flow:

1. Add a title and composer; choose difficulty/status and notes. Save and restart the app to check persistence.
2. Search, filter, and sort; edit the piece; cancel a delete confirmation, then confirm deletion.
3. Select a piece in Practice, start, pause, resume, rotate, and navigate away/back. Finish/save and check Home activity.
4. Restart and verify the session remains. Delete its piece and verify history remains readable.
5. Visit Quests and Wrapped to verify the placeholder screens.

Verified on 2026-10-15 with system OpenJDK 25:

- `./gradlew assembleDebug lintDebug`: **BUILD SUCCESSFUL**, final run completed in 7 seconds. Debug APK generated. Lint has zero errors; remaining warnings concern newer dependency versions and the SDK 36 target.
- `./gradlew connectedDebugAndroidTest`: **not executed on device**. Test APK compiled, but the task failed with `No online devices found`. The installed API 37 emulator crashed during startup (exit 139); retrying with Vulkan and cameras disabled did not produce an online device. No runtime/UI verification is claimed.
- `git diff --check`: passed.

Lint report: `app/build/reports/lint-results-debug.html`. These generated reports and APKs are excluded from Git; rebuild to regenerate them.


## Classical catalogue

Open **Repertoire → Browse catalogue** to search composers and works, open a composer profile, inspect a work, or add it directly. Existing manual add/edit/delete and the timer are preserved. Linked repertoire entries offer **View catalogue detail**; edits preserve the original source ID. Imported difficulty is **Not assessed**, not an inferred difficulty rating.

### Data flow and offline behaviour

- `data/CatalogRepository.kt`: Open Opus HTTPS client, repository, atomic catalogue cache writes, and idempotent repertoire imports. Uses Android/Java networking and JSON support; no new dependencies.
- `data/CatalogModels.kt`: Room composer/work entities, response cache timestamps, metadata models, shared Unicode normalization, and DAO. Catalogue data lives in `opus.db` beside existing user data.
- `data/WikimediaProfile.kt`: verifies a unique Wikidata identity using normalized full name/alias, birth year, and human classification. A verified English Wikipedia sitelink supplies an unchanged introductory excerpt. Ambiguous or unavailable matches produce an explicit missing-biography state, never generated prose. Exact life dates are shown only at the precision supplied by Wikidata; Open Opus placeholder dates are displayed as years.
- `ui/CatalogViewModel.kt`: lifecycle state, cancellable 350 ms search debounce, pagination, independent work/profile loading, errors, retries, and add state. Search matching runs off the UI thread and ignores diacritics. Raw text input is saved across activity recreation.
- `ui/CatalogScreens.kt`: inline live suggestions, composer portrait and works, work detail, attribution links, and loading/empty/error states in the existing Opus design system.

Open Opus endpoints: `/composer/list/pop.json`, `/omnisearch/{normalized-query}/{offset}.json`, `/work/list/composer/{id}/genre/all.json`, and `/work/detail/{id}.json`. The public bulk dump is deliberately not used: it lacks the IDs needed to distinguish catalogue works reliably. Search results are paginated using the server's `next` offset; cached results are also searched locally. Queries shorter than two normalized characters use saved suggestions only. Search is accent-insensitive, not a translator of work titles or catalogue abbreviations.

Open Opus responses are reused for 7 days; verified profiles for 30 days. Refresh controls bypass the TTL. Failed refreshes retain saved data. Cached composers and works, including those imported into repertoire, have no automatic eviction. Portrait files are stored in app-private persistent storage with hashed filenames, bounded downloads, and atomic replacement. No network connection is required to add a previously loaded work or to use personal repertoire. Offline discovery covers **previously loaded records**, not the entire Open Opus database. A newly discovered work can have partial metadata until its full detail has been opened; unavailable fields are marked explicitly. A key parsed from an explicit phrase in the source title is labeled as such.

Duplicates are blocked by a unique nullable Open Opus work ID and a serialized database transaction. An exact normalized title/composer match also prevents importing a duplicate of a manually entered piece. Different IDs or composers are not merged merely because titles resemble one another. Personal edits/notes are never overwritten by catalogue refreshes. The `pieces` table gains only a nullable `catalogWorkId` column and its unique index; `sessions` is unchanged. Migration has no destructive fallback and preserves all old rows and IDs. Schema version 1 is kept for migration verification.

### Sources, images and licensing

- [Open Opus documentation](https://github.com/openopus-org/openopus_api/blob/master/USAGE.md) and [data licence](https://openopus.org/): public-domain metadata, no API key required. The GPL server code is not bundled in this app.
- [Wikidata data access](https://www.wikidata.org/wiki/Help:Data_access): CC0 identity and life dates. Requests use the public `wbsearchentities` / `wbgetentities` Action API.
- Wikipedia excerpts include the article link, contributor/history link, and the licence name/URL returned by `siteinfo/rightsinfo` (currently CC BY-SA 4.0 on English Wikipedia). No biography is fabricated or translated.
- Portraits are obtained from verified Wikidata P18 → Wikimedia Commons `imageinfo/extmetadata`, not from an arbitrary image search. Only images with public-domain/CC0/CC BY/CC BY-SA metadata, an author, a source page, and no stated restrictions are displayed. The UI includes author, credit, source, licence and crop notice. Missing/unverified images use a neutral icon. Open Opus portrait URLs are not used without individual image licensing information.
- HTTPS requests have an explicit identifying User-Agent, timeouts, bounded response sizes, host allowlisting, and serialized access. HTTP/API errors (including rate limits) become retryable UI states; there is no automatic retry loop. Before broad distribution, add the maintainer's actual contact URL/email to the User-Agent per [Wikimedia access guidance](https://www.mediawiki.org/wiki/Wikimedia_APIs/Access_policy).

### Catalogue verification (2026-10-15)

- `./gradlew assembleDebug testDebugUnitTest assembleDebugAndroidTest lintDebug`: passed. Three JVM tests cover accented/decomposed Unicode, catalogue-number normalization, and explicit versus missing musical keys.
- A host SQLite migration check executed the actual migration SQL against the exported v1 schema, preserved legacy repertoire/session rows, and matched the exported v2 columns and indices. This complements, but does not replace, Room validation on Android.
- `CatalogDatabaseTest` compiles and tests v1 → v2 migration with the real exported schema, preserved notes/history, concurrent duplicate imports, same-title/different-composer works, and delete/re-add. **Not executed on Android**: ADB reports no connected devices.
- Actual API responses were checked for Open Opus work detail/search/empty results, Wikidata identity data, Wikipedia excerpt/licensing, and Commons portrait attribution. These are endpoint contract checks, not an Android UI/runtime test.
- Final APK: `app/build/outputs/apk/debug/app-debug.apk`. Lint report: `app/build/reports/lint-results-debug.html`.
