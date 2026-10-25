# Diagnostic credential exposure — October 25, 2026

Status: forward redaction and local safeguards verified; public history exposure remains OPEN. Normal Stage 8 publication was interrupted on the owner's urgent instruction. This is an incident record within existing Stage 8, not another implementation stage.

GitHub [Secret Scanning alert #1](https://github.com/stokonn/Goldberg/security/secret-scanning/1) reports a publicly leaked Google API key, validity UNKNOWN. One distinct value (SHA-256 fingerprint `43cec959c0b2ffb5`) appeared eight times in three diagnostic files introduced by commit `42f6897bc5bc228cf4d3f8b2e1f95bee28e22566`: `host-commands.jsonl` (four occurrences), `ime-before-back.txt` and `ime-after-back.txt` (two each), all under `results/independent-android-2026-10-25/`.

The source field is Gboard's `expressive_stickers_api_key`. That identifies the diagnostic origin; it does not establish credential ownership, restrictions, validity or authority to revoke it. No request using this credential was made. The credential itself is deliberately omitted from this report and all public receipts.

## Response checklist

- [x] Stop ordinary publication; preserve the interrupted work, private PMP, APKs, test failures and historical evidence.
- [x] Inspect alert/location metadata privately and confirm the three files and introducing commit without printing the value.
- [x] Preserve restricted, ignored forensic originals and original hashes before redaction. No historical evidence was deleted or rewritten.
- [x] Replace all eight values in the current tracked files with fingerprint markers. Sanitize the additional unpublished command-log copy; preserve its original privately.
- [x] Verify the current files equal the redaction-only transform of the originals; command JSON/exit codes and observed IME states are unchanged.
- [x] Harden the independent collector's command/instrumentation streams and directly written IME/storage diagnostics; preserve future originals privately before sanitizing.
- [x] Add a reusable credential-pattern publication scanner and eight passing host regressions. Scan the working publication tree, APK/ZIP contents of new artifacts, and complete staged tree before publishing.
- [x] Prepare the ordinary forward remediation and complete working-tree/new-artifact scans. Full staged/outgoing scans are mandatory before push; exact remote receipt belongs in the appended Issue #31 checkpoint. No force push or history rewrite.
- [ ] Identify the credential/project owner and agree containment with that owner. Revocation/rotation requires verified ownership and explicit owner approval.
- [ ] Decide separately whether public-history removal is necessary and authorized. Forward redaction cannot remove the original commit from GitHub, clones or caches.
- [ ] Resolve the alert only after its disposition is justified; it remains OPEN.

## Verification and limits

`python3 scripts/test_diagnostic_redaction.py`: eight PASS, zero failures. Tests cover repeated Gboard fields, JSON structure, unchanged nonsecret UTF-8, recognized credential shapes, complete/truncated private-key bodies, private-original permissions, index-versus-working-tree differences, intermediate-commit exposure ZIP member detection ZIP member detection and fail-closed missing artifacts. Test values are generated synthetic patterns.

`python3 -m py_compile scripts/check_publication_secrets.py scripts/stage8/independent/{redact_diagnostics,run_probes,platform_ui}.py`: PASS. The saved actual originals also reproduce the sanitized working files exactly, with nonsecret observations retained. This change touches verification tooling and evidence only; application behavior, signing, version metadata, databases and Stage 6 files are unchanged. Android tests are not rerun for diagnostic redaction.

The initial staged scan correctly FAILED with eight findings in the three old indexed blobs. Scans report paths, line numbers, types and fingerprints only. The scanner recognizes selected Google/GitHub/AWS/Slack token shapes and PEM private keys; it is not universal secret detection. Binary archive scanning has explicit fail-closed size limits. Ignored forensic originals intentionally retain the value under restricted permissions and must never be uploaded or committed.

`results/independent-android-2026-10-25/security-redaction-receipt.json` binds original and sanitized hashes and occurrence counts. The evidence `SHA256.json` is refreshed for sanitized files and final receipts; the original manifest is preserved privately. Runtime results remain bound to their original tested source/APKs, not to a later security/documentation commit.

## Required publication preflight

Run from the repository root before any new evidence publication:

```sh
python3 scripts/test_diagnostic_redaction.py
python3 scripts/check_publication_secrets.py --archives
python3 scripts/check_publication_secrets.py --paths .gradle/stage8-independent-artifacts --archives
python3 scripts/check_publication_secrets.py --staged
python3 scripts/check_publication_secrets.py --commits origin/feature/goldberg-0.11-stage-8..HEAD
```

Explicitly scan any additional upload path, including ignored artifacts, before uploading it. Investigate failures privately; do not print raw matches or raw diffs of affected logs. Do not install shared Git hooks that could interfere with the externally owned Stage 6 worktree. GitHub Secret Scanning remains an additional server-side signal. Local scans are not evidence that the already public historical commit has been cleansed.

## Resume checkpoint

Independent Android verification remains executed: 12 targeted native passes, six deliberate process terminations, one corrected fixture failure retained, trusted in-place migration/data preservation, backup/recovery/reboot and bounded UI/platform observations. Source `42f6897` has successful automatic quality CI [40191732099](https://github.com/stokonn/Goldberg/actions/runs/40191732099). The pending final documentation receipt is preserved. Resume its source-bound reporting after the security preflight; full Stage 8 integration and release acceptance remain incomplete. Stage 6 accepted-consumer/live dependencies remain open, and its worktree is untouched.

created by stokonn with love <3
