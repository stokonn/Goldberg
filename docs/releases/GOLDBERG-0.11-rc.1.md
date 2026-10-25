# Goldberg 0.11-rc.1

A release candidate for the Music Database Update, with the integrated catalogue, encyclopedia, offline bundles, Smart Cache and accepted Android administration UI work.

The APK is a **non-debuggable release build**, version **0.11-rc.1**, versionCode **12**, signed with the existing compatible Goldberg certificate. Application identity and local user data are preserved.

**Production community networking, cloud sign-in and real-user contribution collection remain disabled. No deployed Cloudflare backend is claimed.** Personal practice data stays local.

Verified on the exact candidate source:

- 302 JVM tests passed.
- API 36 native suite: 203 cases, 192 passed, 11 existing fixture/probe-dependent skips, no failures. All four new canonical application tests passed on the integration source.
- Seeded 0.10.1 upgrade preserved original rows, preferences and 37 sessions; schema 8 to 10, offline startup, process-death integrity and foreign-key checks passed. CI uses debug rebuilds; the release APK's trusted certificate was independently checked against the published APK.
- Local BFF/PostgreSQL: 506 test bodies passed; actual canonical Kotlin service to HTTP to PostgreSQL integration passed. This is local evidence, not a live public service.

[Candidate CI and upgrade evidence](https://github.com/stokonn/Goldberg/actions/runs/40212684482).

Final public-cloud release gates remain open: confidential credentials and private Worker/TLS/OAuth acceptance; production backup custody; privacy/source/license and public API/client adoption decisions. This prerelease does not mark Stage 6 accepted.

APK SHA-256: `c5662d8ead2b175fac0be09145776e84936c2b8f794c85b967f71aaab1938bb5`

created by stokonn with love <3
