# Browser integration tests

Native CLI and HTTP correctness tests are Rust integration tests in
`tests/native_e2e.rs`, run by `cargo test`. This directory tests the existing
JavaScript UI with Playwright against real Rust servers and the project CLI/MCP.
It does not replace native testing or reimplement the DSH agent loop.

## Reproduce

```sh
cargo build --release
(cd dashboard && npm ci)
(cd tests/e2e && npm ci)
(cd tests/e2e && npx playwright install chromium)
RDSH_E2E_BIN=./target/release/rdsh npm test --prefix tests/e2e
```

`RDSH_E2E_BIN` resolves relative to the repository root. Results and desktop/mobile
PNGs go to `target/e2e`; override with `RDSH_E2E_OUTPUT`.
The runner creates isolated HOME/DSH_HOME/XDG directories, starts loopback servers,
and removes its own processes and fixtures. It never connects a provider or enables
Tailscale. It checks persisted settings, tokens/prune, session display, actual MCP
questions and browser answers, draft retention across SSE, process restart, and
revocation of the previous browser key. The separate project-overview browser
flow checks the explicit project allowlist, summary-only state, per-project detail
authentication, and mobile layout. Linux CI installs Chromium and retains PNGs
and JSON even when the job fails. It also emits SHA-bound `qa-matrix.json` and a
filterable `qa-matrix.html`; missing, stale, or mismatched-mode evidence stays
`not-run`. The loopback browser job leaves real-phone, WSL, and Tailscale paths
unverified.

The default browser suite also runs `run-health.mjs` against a local managed-child
fixture. It verifies the dashboard-owned Harness service process card's
process/output evidence, unavailable upstream signals, and that an authenticated
dashboard polling gap does not change the reported process state.
This uses no provider, model, credentials, or external network. The screenshot is
an actual browser capture of the local dashboard, not a mockup; it does not prove
that DSH exposes the unavailable task/API/GPU telemetry.

`node tests/e2e/artifact-preview.mjs` exercises actual report buttons and the
authenticated project server with deferred text decoding. It checks close/reopen
with text and image previews, close without reopening, state freshness during
decoding, and object URL cleanup. PNGs, browser video, and observations go to
`target/e2e/artifact-preview` (`RDSH_PREVIEW_OUTPUT` overrides this).
Set `RDSH_PREVIEW_BASELINE_APP` to a previous `app.mjs` for real before captures
over the same isolated backend; the regression assertions still fail on defects.
This flow is also included in the default suite and uses no provider or Tailscale.

The default command repeats native setup, native Web and project-dashboard flows
in `en`, `zh-CN`, and `ja`, including original Japanese task/question text that
must not be translated. Each display language also checks Japanese, Chinese and
English palette queries, one-key Escape/focus recovery, and a browser-generated
cancellation reason persisted through the authenticated HTTP API. Individual `browser.mjs` runs use
`RDSH_E2E_LANGUAGE` (default `ja`). It also runs `update-banner.mjs` with the real React component
and two independent authenticated plugin hosts. Dummy HOME and loopback ports
cover live update push, cross-tab/port close events, dismiss finality across
polls, remount, reload and later hours, notification of a newer target or update
time, project remounts, legacy records and unavailable browser storage.
Mocked updater responses also cover successful close, failed retry, and a newer
update arriving during a request; the actual updater never runs in this fixture.
The browser clock advances hours without waiting, proving a dismissed update
stays hidden. It saves real PNGs and a verification report; it never restarts
production DSH or executes the updater. Run just this flow with
`npm run test:updates`. Set `RDSH_UPDATE_BASELINE_CLIENT` to the previous client
file for before/after captures.

The default command also runs `task-outcomes.mjs` against the actual project
server and isolated acceptance checks. It covers reported done versus verified,
partial/full checks, fixed milestones after task splits, stale code and an old
response arriving after an SSE update. `RDSH_OUTCOMES_OUTPUT` selects its evidence
directory; `RDSH_OUTCOMES_BASELINE` optionally points to a previous `server.mjs`.
Full-panel PNGs use extra viewport height to keep the fixed action bar clear;
separate phone PNGs and overflow checks use the actual 390 x 844 viewport.

The default command also runs `causal-timeline.mjs` against an actual isolated
project dashboard. It covers summary-only reads, problem details, stable IDs,
unknown native intent, exact question/answer/native correlations, an actual local
acceptance command, staleness after editing its input, refresh retention, escaped
producer text, and 390-pixel layout. Stored native receipts are explicit fixtures;
this test never sends a provider prompt or validates production native execution.
Run only this flow with `npm run test:timeline --prefix tests/e2e`. Results go to
`target/e2e/causal-timeline`; override with `RDSH_TIMELINE_E2E_OUTPUT`.
Set `RDSH_TIMELINE_BASELINE_HTML` and `RDSH_TIMELINE_BASELINE_APP` to unchanged
previous frontend files for real before/after screenshots over the same isolated
backend. That comparison measures the frontend only. `runtime-observations.json`
includes actual stage/ID observations and separates the native fixtures from
local acceptance and browser proof. See [the contract](../../docs/CAUSAL-TIMELINE.md).

## Optional installed DSH integration

```sh
RDSH_HARNESS_BIN=/path/to/original/dsh npm run test:harness --prefix tests/e2e
```

This installs the local rdsh settings plugin into a temporary DSH Web profile and
tests save/readback/reload/corruption/retry and live en/zh-CN/ja language
switching in its actual UI. It uses no credentials
or model calls, and does not start the Electron Desktop GUI. DSH must already be
installed; the optional test is not part of CI. The report separates
`functional_result` from `mobile_accepted` and `mobile_readability`; command success
means the settings flow passed, not that mobile UX was accepted.

For an existing browser installation, set `RDSH_CHROME_PATH`; an environment with
bundled Playwright can set `RDSH_PLAYWRIGHT_MODULE` to its module path.

`npm run test:language` uses the same `RDSH_HARNESS_BIN` with a DSH version that
supports `locale.addLanguage`. It checks the actual Language menu, Japanese
General settings, English fallback, Chinese/English switching, reload, and a
process restart in a fresh English browser. It isolates all profiles and disables
Discord presence. Set `RDSH_LANGUAGE_BASELINE_CLIENT` to the previous
`rdsh-settings/client.js` for real before/after PNGs. Results go to
`target/harness-language-e2e` (or `RDSH_E2E_OUTPUT`).

See [the route-matrix contract](../../docs/evidence/qa-route-matrix.md) for
coverage rules and [historical E2E evidence](../../docs/evidence/e2e-20261008.md)
for earlier runs and environment-specific checks.

## Answer guard (installed DSH, no provider)

```sh
RDSH_NATIVE_MODULES=/path/to/original/dsh/node_modules npm run test:answer-guard --prefix tests/e2e
```

This composes the real `AgentLoop`, `LlmRuntime`, session store and projections
in-process and registers a stub `LlmAdapter`, so no provider, network or model
API is involved. The stub answers the first call with the recorded failure shape
— one `reasoning` block, no `text`, no tool call — and the second with ordinary
text. The harness then requires that `plugins/rdsh-answer-guard` caused a second
model call inside the same turn, that the notice reached that request, and that
a `text` block landed in the session log. It also runs two contrasting
scenarios (plugin not applied, `features.answer_guard=false`) that must stop
after one call, so a passing run shows the guard, not the loop, recovered the
turn. Like `discord-native.mjs` it needs an installed DSH tree and is not part
of CI; its exit code is the verdict.

## Translation preview (isolated installed DSH, no provider)

```sh
RDSH_NATIVE_MODULES=/path/to/isolated/dsh/node_modules npm run test:translation --prefix tests/e2e
```

This optional acceptance test uses the real DSH AgentLoop, LlmRuntime,
CommandRuntime and session, with a local stub adapter. It requires the preview
command to make one independent call using the current request-header route,
return the translation, and retain the original messages, turns, surface and
next-request input. Only the normal command run/done records may be added.
It isolates HOME, DSH_HOME, XDG and cwd, and never uses a provider credential or
model API. It verifies the native contracts; actual Web profile/slot loading and
translation quality require separate acceptance. It is not part of the default
browser suite and does not install DSH itself.

## Discord integration

`harness-settings.mjs` also saves/reloads the Discord controls in the original DSH
Web UI, with presence disabled so it never publishes to a user's Discord. It checks
preview, partial save with another section's draft retained, ID reset, icon loading,
and the rdsh section's navigation/content layout at 390px.
The default regression suite includes a real local IPC fixture:

```sh
node --test tests/discord-presence.test.mjs tests/settings-client.test.mjs tests/plugin-security.test.mjs
```

Optional installed DSH check exercises the actual AgentLoop and Cordis lifecycle
(idle → two running agents → idle). It rejects fixture work before any model call
and sends activities to an in-memory receiver:

```sh
RDSH_NATIVE_MODULES=/path/to/original/dsh/node_modules node tests/e2e/discord-native.mjs
```

On WSL with Windows PowerShell available, this separate test uses a randomly named
Windows pipe to verify the real bridge, Unicode payloads, Windows PID, ACK and clear.
It never uses the actual Discord pipe or a Discord account:

```sh
node tests/e2e/discord-wsl.mjs
```

常駐サービス相当の環境でも確認できます。WSL環境変数とWindows PATHがなくても、
製品側の判定と名前付きパイプへの接続が動くことを確認します。

```sh
env -u WSL_DISTRO_NAME PATH=/home/sahen/.local/bin:/usr/local/bin:/usr/bin:/bin node tests/e2e/discord-wsl.mjs
```

The bundled dsh Application ID is used by default. To explicitly publish a live
integration test to the logged-in Discord desktop client:

```sh
RDSH_NATIVE_MODULES=/path/to/original/dsh/node_modules node tests/e2e/discord-live.mjs --hold-seconds 60
```

This runs the real AgentLoop with work held before model dispatch, publishes
idle → two running agents → idle, and clears the activity when disabled. It
records sanitized Discord acknowledgement fields in
`target/discord-live/with-application-id.json`; it does not log account details.
It changes the user's visible activity temporarily, so it is never part of CI
or ordinary regression tests. RPC acknowledgement and actual profile UI rendering
are separate results; the script only verifies the former.

Add `--extras` to publish a temporary project link alongside the bundled icon.
The live report includes acknowledged assets, buttons, status display type and
timestamps. Button acknowledgement does not mean it will appear on your own profile;
Discord displays Rich Presence buttons to other users.

## CLI terminal prompts

On POSIX systems, `RDSH_E2E_BIN=./target/release/rdsh python3 tests/e2e/cli-tty.py`
opens real private pseudo-terminals for English, Chinese and Japanese setup. It
observes both the pasted-key prompt and environment-key confirmation, skips or
refuses both, and verifies no credential is written. Only a synthetic placeholder
is placed in the child environment; no secret is entered and no provider is called.
The existing native CI matrix runs this test on Linux and macOS.

The outcome language flow runs actual synthetic acceptance checks through the local server in English, Simplified Chinese and Japanese. It checks initial unverified state, verified criteria, original Japanese task values, and desktop/mobile layout without provider calls.

On native Windows, `powershell -NoProfile -File tests/e2e/cli-tty-windows.ps1` checks all six interactive setup cases through ConPTY using isolated homes and no provider requests. `RDSH_E2E_BIN` selects a built `.exe`. POSIX hosts use `python3 tests/e2e/cli-tty.py`. These tests do not exercise a physical keyboard or the Windows OS IME.

Set `RDSH_OUTCOME_RECORD_FLOW=1` when running `node tests/e2e/outcome-languages.mjs`
to capture real Chromium video and initial/unmet/verified PNG checkpoints for each
language. `RDSH_OUTCOME_LANGUAGES_OUTPUT` selects the private output directory.
The recording includes actual local criterion execution and browser clicks; it
contains no model or account call. Convert the resulting WebM to a GIF with an
existing video tool if a review attachment needs that format. Setup browser flows
also render a deliberately corrupt private sharing policy, verify the localized
warning and unchanged canonical API reason, then repair the private file.
