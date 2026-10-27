# Goldberg 0.11 — Catalogue sources, fields and licences (OWNER REVIEW DRAFT)

Date: 2026-10-27. Based on Stage 6 source commit `3254326809f6661b3043ec81661731d31f687f05`.
**NOT APPROVED, NOT AN INGEST AUTHORIZATION, NOT LEGAL CLEARANCE, NOT A PUBLIC-LAUNCH APPROVAL.**
The deployed read-only catalogue projection was empty at preparation. No import, endpoint, route or database change is permitted by this document.

## Purpose and conservative default

Separate the licence of **music metadata** from code, encyclopaedia prose, photos, scores, audio and recordings. A public API response must expose only individually reviewed metadata with preserved evidence and provenance; the presence of an item in a public API is not proof that all its content is free for republication. Respect rate limits and provider terms separately from copyright.

**Candidate initial whitelist for metadata import after owner review:**
1. Open Opus: its own project documentation identifies its **data** as public domain; the **API implementation** is GPL-3.0, a distinct thing. Review each prospective field and source and keep provider URLs/IDs.
2. Wikidata structured statements: CC0, distinct from Wikidata text in non-structured namespaces and from images linked from items.
3. MusicBrainz **core** database fields: CC0. MusicBrainz **supplementary** annotations, tags, ratings and other supplementary data use CC BY-NC-SA 3.0; exclude by default unless separately licensed/reviewed.
4. Manually researched elementary factual metadata may be considered only with documented sources and a field-by-field rights check; do not assume that large-scale copying from an unreviewed proprietary database is permissible.

References: https://www.openopus.org/ ; https://github.com/openopus-org/openopus_api ; https://www.wikidata.org/wiki/Wikidata:Licensing ; https://musicbrainz.org/doc/About/Data_License ; https://musicbrainz.org/doc/MusicBrainz_Database

## Default EXCLUSIONS from the public publication projection

- Wikipedia/Wikimedia article prose, descriptions, extracts and summaries; unless a separate compatible licence compliance plan is approved. General Wikipedia text is subject to CC BY-SA/GFDL terms, not CC0 merely because the related Wikidata item is CC0.
- Wikimedia Commons portraits and media; each **file** has its own licence and author/attribution/change requirements. A Wikidata image URL or Commons file title does not authorize copying, hosting or republishing the file. Permit a separately vetted future media presentation path with file-level metadata/attribution.
- Music scores, sheet music, notation, recordings, performance audio, cover art, streaming thumbnails or videos (including links that pretend to grant a reproduction licence). The copyright status of a *composition* does not automatically clear the rights in a modern score/edition, recording or photo.
- MusicBrainz supplementary material as above; contributor free-form text, user annotations, ratings and potentially sensitive personal biographical details.
- Project Gutenberg book text/quotes as catalogue metadata. Many items are public domain **in the United States**; Czech/EU status may differ. Provider trademark/site rules and distribution rights require item-specific checking. Its use in optional quotations is a separate feature and needs a separate review.
- Community contribution drafts, personal profile or practice journal records, IP addresses, support email messages, account credentials and raw HTTP headers. A user submission is not publication permission.

References: https://commons.wikimedia.org/wiki/Commons:Reusing_content_outside_Wikimedia/licenses ; https://foundation.wikimedia.org/wiki/Terms_of_Use ; https://www.gutenberg.org/policy/permission ; https://www.gutenberg.org/policy/terms_of_use

## Proposed publication field allowlist (conceptual; map to existing typed API only after schema review)

Per reviewed composer/work record: internal typed UUID, entity kind, normalized name/title, optionally factual dates/period/catalogue number/opus number/composer relationship, display-order/canonicalized aliases, source-specific external identity, source item URL, licence identifier, provenance/retrieval/review timestamp, approved attribution text if applicable, and revision/publication state.

Rules:
- Each published field must have a resolvable source and licence. A composite record may carry multiple source attributions with field-level provenance.
- Preserve exact external IDs and provider entity types. Do not auto-merge similarly named composers, unrelated works, arrangements or edition variants; unresolved identities remain separate/review-required.
- No HTML, arbitrary rich text, image/audio payloads, hidden location or personal details, practice-session data or contributor content. Bound lengths and reject unknown fields at ingest/publication boundaries.
- Historical data/revision/audit changes follow existing Stage 6 moderation/publication contract; no bypass of RLS and no new write path from an Android client.
- Do not imply artist identity or claim a recording/edition is in the public domain because its composer is deceased.

## Provider access and operational rules

- MusicBrainz Web Service usage is **not identical** to permission to reuse its CC0 core dataset. Current API guidance limits applications to one request per second and requires a meaningful User-Agent; commercial API use has separate terms. If usage changes, review before a bulk import. https://musicbrainz.org/doc/MusicBrainz_API
- Open Opus publishes public-domain data but its remote API remains somebody else's service; respect endpoint usage/operational limits and do not make unbounded bulk requests. Prefer a documented, permitted dataset acquisition method.
- Wikidata API/Query Service and Wikimedia Commons have separate service usage policies even where the underlying structured data is CC0.
- Source attribution in the app should be accessible without flooding primary UI. Keep links to source, licence and relevant authors for independently licensed media.
- Network/source failures should not delete offline repertoire or locally saved practice history.

## Ingest acceptance checks (do not execute before approval)

1. Produce a proposed precise data-field list and mapping against the current Stage 2/4/6 schema, with a licence/source matrix and prohibited-field tests.
2. Obtain explicit owner approval for exact providers, fields, attribution presentation and ingest scope. Any content requiring legal opinion stays excluded.
3. On synthetic/fake records **only**, test duplicate/unresolved identity handling, licence rejection, attribution preservation, revision/rollback/quarantine, export API safety and no accidental journal/profile leak.
4. Verify Free usage/cost limits, rate limiting, source access terms and necessary endpoint version stability. Zero-cost is a goal, not an assumed guarantee.
5. Record provenance and an auditable import/removal plan for later real records. Real metadata import remains a separate high-impact step needing explicit owner authorization.
6. Before public route activation, separately clear data-controller/privacy provider and operational gates; a licence review does not clear them.

## Items for owner/legal approval — OPEN

- [ ] Exact initial metadata source allowlist and approved fields, with source-to-field licence evidence.
- [ ] Licence/attribution display and evidence preservation (especially any eventual Commons media or encyclopaedia excerpts).
- [ ] Distinguish dataset reuse permission from remote API terms for actual scale/usage.
- [ ] Identity and rights review for living composers or sensitive biographical details, if in scope.
- [ ] Explicit publication/ingest authorization after dry-run and verification.
- [ ] All remaining Stage 6 launch gates and **separate** final public-route authorization.

This draft makes **no** claim that the real public catalogue already contains data or that a licence decision is already adopted.
