# Three-language review follow-up, 2026-10-15

This record covers the PR #500 integration of upstream `2db470bd15d2efbe58c9ff1a43e6679e5cea4d4a` with English, Simplified Chinese and Japanese product copy. The original integration receipts cover local macOS and physical Windows; the additional Linux receipt below covers one native kernel lifecycle case. Source commit `8ee5d7f94f221db6135a9b3a3116707cc0fd4511` subsequently passed all 26 GitHub checks, including an unchanged-source retry of the failed Windows tray-start job ([run](https://github.com/jimoto-no-llm/rustdsh/actions/runs/38675592833/attempts/2)). Later evidence-only commits require their own CI; human approval, merge and release remain separate. The tested source was an uncommitted merge integration; [350 relative source-file hashes](source-files.json) identify it without assigning a future commit SHA. At source `8ee5d7f`, all 350 files matched the transferred Windows source and that checkout; all 46 Rust receipt files matched across both platforms. Later source repairs are recorded separately below. [Source verification](source-verification.json).

The [2026-10-14 record](../languages-20261014/README.md) remains historical. Its older source bases, test counts, Darwin identity limitation, Windows terminal gap and earlier benchmark numbers do not describe this integration. Historical passing CI on `c3d5d9f` does not establish passing CI for the new integration.

## Execution results

| Surface | Current result | Evidence |
| --- | --- | --- |
| macOS Rust release suite | 434 pass, 0 fail, 0 ignored; 12 targets | [Receipt](macos-native.json) |
| Windows native Rust release suite | 399 pass, 0 fail, 0 ignored; 12 targets | [Receipt](windows-native.json) |
| macOS ordinary full dashboard suite | 347 total: 256 pass, 91 platform skips, 0 fail | [Every skipped case](dashboard-platforms.json) |
| Windows ordinary full dashboard suite | 347 total: 335 pass, 12 platform skips, 0 fail | [Every skipped case](dashboard-platforms.json) |
| Linux native kernel ownership | One case passes: three generations, pidfd TERM, forced cgroup stop once, canary survives, complete cleanup | [Receipt and prerequisites](linux-cgroup-native.json) |
| macOS POSIX terminal | 6 actual PTY cases, all pass | [Receipt](posix-tty.json) |
| Windows native terminal | 6 actual ConPTY cases, all pass | [Receipt](windows-conpty.json) |
| Setup, native dashboard, project HTTP/MCP/browser | All three languages pass at desktop/mobile widths | [English](browser-en.json), [Chinese](browser-zh-CN.json), [Japanese](browser-ja.json) |
| Targeted settings/Muse/Discord fixtures | 56/56 pass; final shared UI focused run 35/35 pass | [Plugin receipt](plugins.json), [overlapping-run ledger](targeted-runs.json) |
| Existing update banner | 13 flows pass; real authenticated local routes, mocked updater | [Receipt](update-banner.json) |
| Outcome language UI | 3 languages × 2 viewports; real local criterion checks, no page errors | [Receipt](outcome-languages.json) |

Format, debug and release clippy with warnings denied, both release benchmark example test suites, model fence, 69 shell regressions and the changed settings-guide lint also pass. [Executed checks](macos-native.json). The platform counts differ because of OS-specific tests; skipped cases are not passes. Darwin now supports read-only native process identity, while kernel-owned managed child-process scopes remain unsupported. [Platform details](platform-ledger.md).

The PTY and ConPTY tests use programmatic input in real native terminals. They observe each localized prompt, skip key entry or refuse persistence, and verify successful exit without a credential file. They make no model/provider request, contain no real key and leave no test-owned Windows binary process running. These results do not claim physical keyboard or OS IME operation.

## Actual captures

The before images show an earlier task-card capture before local criterion checks. The after images show the localized card with actual synthetic checks observed; the state and scroll position can differ. Japanese task text, IDs and persisted wire values remain original data. Images are real Chromium captures, not reconstructed UI.

| Viewport | Before | English | Simplified Chinese | Japanese |
| --- | --- | --- | --- | --- |
| Desktop | [PNG](before-desktop.png) | [PNG](en-desktop.png) | [PNG](zh-CN-desktop.png) | [PNG](ja-desktop.png) |
| Mobile | [PNG](before-mobile.png) | [PNG](en-mobile.png) | [PNG](zh-CN-mobile.png) | [PNG](ja-mobile.png) |

The new outcome language flow preserves original Japanese values and verifies two real local criterion checks in each language. The mobile layout no longer expands past the viewport. Existing three-language setup/native/project flows, workspace-column persistence and pane navigation also pass with the final macOS binary.

## Review corrections and limits

[The review record](review-follow-up.md) identifies the fixed auto-presence comparison, Muse-owned diagnostics, Darwin identity capability distinction and upstream Rust/UI integration. Fixed English progress/diagnostic text added upstream is localized, including provider YAML refusal/read-back, HTTP/curl context, auth-sharing consent, update and proxy output. Raw OS/library diagnostics, upstream response text, identifiers, generated configuration and JSON protocol values retain their bytes.

Recovery and pure JSON operations retain upstream settings independence: `settings init --force`, `task-outcomes` and `subagents plan` can parse without opening unrelated corrupt settings. Their language comes from the explicit flag, environment override and OS locale environment; other commands still refuse corrupt settings without replacing it.

No real provider login, model invocation, external Discord presence publication, installed binary replacement or release was performed. Live Muse CLI/catalog operation remains unverified: [read-only feasibility checks](muse-feasibility.json) across six physical hosts and four running WSL surfaces found no existing CLI in PATH or checked standard installation locations. No arbitrary external paths or other accounts were searched. The full [remaining/intentional-exception ledger](known-exceptions.json) distinguishes runtime prerequisites, unsupported features, preserved raw data and current-head CI acceptance.

## Measurements

[Performance details](performance.md) retain both the initial loaded run and the repeat. In the repeat, the 13 comparable CLI cases have candidate/baseline median ratios of 0.903–0.998 with identical stdout. The streaming zstd case has a worse p95: 289.808 ms versus 127.819 ms, ratio 2.267. Several other tails and child RSS values also increase. These observations do not establish a general speedup or a controlled source-level performance regression.

Both binaries are identified by SHA-256, with the same current-upstream source as the baseline. Each case has three warmups and 15 observations; OS caches remain warm. No timing threshold, timeout, supported-platform assertion or product concurrency limit was relaxed.

## Latest review repairs and operation recording

The [new focused receipt](review-repair-validation.json) covers the local `e0d4a16` tree merged forward with upstream `99a42fd`, plus the reviewed repairs. Its file hashes identify the uncommitted source without inventing a future commit. The earlier 8ee Windows/macOS full-suite and CI results above remain historical results, not full-suite qualification of these repairs.

`R500-INTEGRATION-05` now dispatches the settings-independent `subagents plan` and `task-outcomes apply|validate|schema` bridges using only the explicit language flag and environment. Corrupt saved settings still reject ordinary commands. Native argv, request data, output and exit status remain intact. `R500-MAIN-02` now translates only known setup policy failures at the UI boundary and uses the existing locale dictionary for the inline `providers: {}` refusal. Canonical API JSON, unknown external messages, rejected YAML bytes and credential non-persistence remain unchanged. The receipt links each pre-fix failing control and passing consumer check.

The ordinary Linux dashboard run exposed a separate `freePort()` race: the fixture closed its listener before the product acquired the same port. The backup fixture now requests an OS-assigned port directly. `startDashboard({port: 0})` keeps that socket bound and publishes its actual address consistently in returned URLs, runtime metadata, MCP URLs and origin checks. The regression holds the default port occupied while checking two independent listeners and real authenticated HTTP. Existing explicit/default ports and cleanup checks remain. The focused port/history/lock/close run passes 12 cases with one existing Darwin ownership skip; it does not replace a new full Linux run.

The [Japanese outcome GIF](outcome-verification-flow-ja.gif) records the current outcome operation: initial report → unmet checks → actual local criterion execution → refresh with both checks verified. It comes from the [real Chromium video](outcome-verification-flow-ja.webm), played at half speed and resampled to 8 fps; it is not the historical palette GIF. The [initial](outcome-flow-ja-initial.png), [unmet](outcome-flow-ja-unmet.png) and [verified](outcome-flow-ja-verified.png) PNGs are actual checkpoints. All three languages pass the same local operation at desktop/mobile widths in the [new outcome receipt](review-repair-outcome-languages.json). No provider or model is called.

The real setup flow additionally corrupts and repairs a private sharing policy in [English](en-setup-policy-error-mobile.png), [Chinese](zh-CN-setup-policy-error-mobile.png) and [Japanese](ja-setup-policy-error-mobile.png), verifying the localized warning and canonical English API reason. The preexisting before-image source-commit gap remains: this recording and these current checkpoints do not retrospectively identify the source of those older images. New-head CI, full native/Linux qualification, human approval, merge and release remain separate.
