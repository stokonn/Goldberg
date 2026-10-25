# Goldberg 0.11 release candidate

Owner now authorizes release when critical gates pass,or a truthful release
candidate withreal-user cloud collection disabled when hosted gates remain open.
Branch release/goldberg-0.11-rc.1,based onverified canonical f5fc296.

- [x] Both engineering branches preserved,pushed andexact remote SHAs verified.
- [x] Select0.11-rc.1/code12,above published0.10.1/code11;identity/database unchanged.
- [x] Keep production networking andreal-user cloud collection disabled.
- [x] Build non-debug release APK,sign withthe existing trusted identity,verify ZIP/package/hash/signature.
- [x] Essential302JVM/lint and203native/seeded-upgradeCI PASS;11 existing native skips recorded.
- [x] Publish verified prerelease candidate;remote digest andre-downloaded APK bytes exact.
- [ ] Final0.11 release:hosted security/credentials/OAuth/privacy/backup/version/client adoption gates remain OPEN.

No main merge,hosted credential orWorker mutation is implied. Existing Stage6
Supabase20-table deployment is preserved;no repeated ACL/bootstrap action.
