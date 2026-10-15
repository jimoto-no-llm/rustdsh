# Review follow-up

The review originally inspected head `c3d5d9fd0bb902edf020dbe107df954d3b922429`. The current local evidence covers integration with upstream `2db470bd15d2efbe58c9ff1a43e6679e5cea4d4a`, which is newer than the review's `92cb72f` main snapshot. The source manifests bind these local results; approval or CI for the historical head is not carried forward as current approval or CI.

| Finding | Resulting behavior | Current evidence |
| --- | --- | --- |
| R500-JS-2 | Presence-reflection comparison uses the server's resolved presence language; browser/UI language still controls UI copy. Auto mode with different browser/server languages no longer stays falsely pending. | [Targeted plugin receipt](plugins.json), including all four browser/server-locale comparisons. |
| R500-JS-3 | Known Muse-owned login, timeout and bridge diagnostics use the selected product language while machine codes and genuine external messages remain intact. | [Targeted plugin receipt](plugins.json) uses synthetic catalog/worker replies and preserves external error text. No live Muse CLI claim. |
| R500-JS-5 | Read-only Darwin process identity is distinct from Linux/Windows managed-scope ownership. Darwin identity positives run; unsupported-identity negatives skip on supported platforms. | Both ordinary full dashboard runs; exact skip lists in the platform receipt. |
| R500-MAIN-01 | Root/provider/list/add and all newly integrated native command/argument help are localized without removing provider registration or native dispatch. | Release CLI tests and generated-command/argument dictionary coverage. |
| R500-MAIN-02 | Explicit source-scoped credential consent, dry-run behavior, truthful authentication status, provider helpers and route-key/default-route decisions remain upstream-compatible. | Auth-sharing/provider/CLI/settings release targets on macOS and Windows. |
| R500-MAIN-03 | Extensionless Node entrypoint detection, file-URL preload, opt-out, dry-run/metadata and sandbox distinctions remain present alongside explicit locale arguments. | Passthrough/preload unit tests and native CLI regressions; raw delegation argv tests remain active. |
| R500-MAIN-04 | Project workspace column selection and per-project restore/navigation remain functional and localized. | Real three-language CLI/HTTP/MCP/browser flows at desktop/mobile widths. |
| New outcome surface | Owned status/verification copy is localized while Japanese fixture data and wire states remain unchanged; mobile content stays within the viewport. | Six language/viewport observations and the included before/after PNGs. |

Provider refusal and HTTP failure tests now exercise all three languages through the real binary, preserve endpoint/status/IDs, and require unchanged profile content and no credential persistence. YAML parsers receive explicit locale values only for their owned diagnostic presentation; generated YAML and protocol JSON remain unchanged. Canonical JSON notes and translated human notes are rendered separately.

The merged upstream release introduced ordered JSON objects and a new source-consent inventory. Obsolete fixture expectations were updated to that behavior: guard reason values remain canonical English, auth preview requires an explicit source selection, and invalid external provider IDs are redacted. Negative checks for original data, secret non-disclosure, no credential copy and corrupt-file preservation remain. A fixture now declares `type: oauth` to actually reach upstream's invalid-provider diagnostic.

The prior language-selection pre-pass initially broke the upstream pure-planner corrupt-settings test. The final code restores settings independence for actual Clap-recognized recovery/pure JSON commands; the unchanged upstream test passes. The complete final macOS suite passes 434 tests and the Windows native suite passes 399.

The included source and local receipts are review evidence. New-head GitHub CI, human approval, merging and release are separate acceptance steps.
