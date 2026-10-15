# Opus

A native, offline-first piano practice companion for acoustic pianists. Kotlin, Jetpack Compose, Material 3, Room, and MVVM. Android 8.0 (API 26) or newer.

## Phase 1

- **Home:** today's practice minutes, repertoire totals and performance readiness, completed session count, and recent activity. All values come from the local database; no sample statistics.
- **Repertoire:** add, edit, delete, search, filter by learning status, and sort by title or composer. Each piece includes title, composer, difficulty, status, and optional notes. Deletion requires confirmation.
- **Practice:** optional piece selection or free practice, start/pause/resume, discard confirmation, and finish/save. Completed sessions persist locally and update Home.
- **Quests / Wrapped:** explicit placeholders for future goals, XP, achievements, and monthly/yearly reflections.
- Dark olive-black surfaces, warm ivory text, restrained gold accents, serif headings, and fading screen transitions.

No microphone access, audio recording, network permission, accounts, analytics, or remote services. App data stays in a Room database on the device. Android cloud backup is disabled. Uninstalling the app clears the data.

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

The wrapper pins Gradle 9.3.1, which supports running on the installed Java 25. Android Studio's bundled JBR on this machine is also Java 25, so no JBR fallback is needed. Java/Kotlin bytecode targets Java 17. For a different setup, use a compatible JDK via `JAVA_HOME` or Android Studio's Gradle JDK setting. Initial builds need internet for dependencies; the installed app works entirely offline.

Dependencies are pinned: AGP 9.1.0 (built-in Kotlin 2.2.10), Compose compiler 2.2.10, Compose BOM 2025.08.01, KSP 2.3.12, Room 2.7.2, Lifecycle 2.9.2, Navigation 2.9.3, and Activity 1.10.1. KSP 2.3 supports AGP's built-in Kotlin source handling.

## Architecture

- `data/OpusDatabase.kt`: Room entities, enum converters, DAO, database, and repository. Repertoire and session lists are observable flows. Room handles asynchronous writes; the UI never queries the database directly. Version 1 schemas are exported to `app/schemas` for future migrations. No destructive migration fallback.
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
