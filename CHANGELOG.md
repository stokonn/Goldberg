# Changelog

## Goldberg 0.6.0 — A New Era

- Rebrand Opus to Goldberg, version code 3; retain application ID, database name, stable identifiers and signing setup.
- Add a flat harpsichord adaptive/themed icon and native Android 12+ splash resources.
- Add multi-piece sessions, live switching/selection/removal, per-piece timing and notes, free practice, pause/resume checkpoints and expandable summaries.
- Replace Home with Profile: editable identity/gallery avatar, period statistics/charts, current streak, most-practiced compositions and lazy visible history.
- Add persistent, ordered, user-selected showcase of up to five unlocked badges; keep the complete Badges destination.
- Unify search across personal repertoire, cached/online composers and works.
- Add validated version-1 JSON export/import using Android document pickers and explicit atomic replacement confirmation.
- Add Light/Dark/System appearance and matching system-bar contrast; retain scalable text and reduced-motion behavior.
- Add lightweight repertoire/addition changes, saved-session feedback and badge-unlock notices.
- Add schema 3 → 4 migration, preserving old session rows and backfilling per-piece history, plus targeted query indexes.
- Remove duplicate startup achievement evaluation, stop idle timer polling, reduce active refreshes from five per second to one, isolate timer collection to relevant destinations and bound portrait decoding.
- Add timer/attribution/showcase tests, seeded migration and backup persistence instrumentation, host schema checks and a local APK naming script.

## Opus 0.5 — The Classical Experience

Previous committed baseline: `346bc04`. Historical behavior and verification are preserved in `docs/OPUS-0.5.md`.
