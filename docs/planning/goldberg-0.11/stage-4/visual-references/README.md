# Goldberg 0.11 — Original UI Visual References

These four images are **design references** for the approved editorial/classical-music direction, not screenshots of implemented functionality or pixel-perfect engineering specifications.

## Screens

1. `01-discover.png` — Discover / Explore + Search. Categories, recent items, locally available music, clean editorial cards.
2. `02-library.png` — Personal Library / "Your Collections". Works, artists, albums, lists, recently practiced items and offline-library entry point.
3. `03-artist-profile.png` — Composer/artist details. Editorial portrait, short biography and Read more, key works, recordings, attribution.
4. `04-work-profile.png` — Work details. Title/composer/catalogue ID, add to repertoire, structure/parts, arrangements, recordings, source credits.

## How to use these references

- Maintain a cohesive Ivory (light) / Nocturne (dark) design language with restrained typography, spacing and hierarchy.
- **Honor the project's latest approved navigation, labels, features and UX contracts over any incidental mockup details.** The images are inspiration, not new product decisions.
- Preserve source licensing, privacy, offline rules, accessibility and screen-size adaptability. No passive network fetch just from opening Discover or a personal item.
- Do not invent composer biographies, catalogue counts, timings, media rights, recording links or collection contents because they appear in the mockups; placeholder facts are illustrative only.
- Generated people/portraits/artwork in these images are illustrative, **not approved reusable production assets**. Any actual portraits or artwork need provenance and explicit per-file rights verification.
- Do not copy iPhone chrome/device frames into an Android app. Implement using existing Jetpack Compose design/navigation patterns.
- Stage 4 is a reliability-first catalogue stage. Any wider redesign or new feature not already authorized requires separate owner approval; do not modify unrelated Home, Practice or Profile work from these images.
- These images are documentation/reference files only: do not bundle them into the APK or change production code just to accommodate them.

Owner approval of implementation scope is separate from delivery of design references. Keep existing personal DB, backup, migration and recovery guarantees unchanged.

## Stage 7 linkage (2026-10-20)

These four references are the approved design baseline for the Goldberg 0.11 **Stage 7**
redesign of Discover, Library / Your Collections, Artist Profile and Work / Composition
Profile. The authoritative Stage 7 plan and acceptance matrix are
`docs/planning/goldberg-0.11/stage-7/README.md` and `stage-7/UI-ACCEPTANCE-MATRIX.md`;
owner-approved Home and User Profile redesigns are documented there from the owner's
Stage 7 instruction plus `docs/design/goldberg-0.10/screens/01_HOME_APPROVED.png`,
`02_PROFILE_APPROVED.png` and `docs/design/goldberg-0.10.1/APPROVAL_MATRIX.md` (no
dedicated 0.11 mockups exist for those two screens). Stage 7 is planning-approved but
**not implemented**; do not cite these images as evidence of completed Android screens.
