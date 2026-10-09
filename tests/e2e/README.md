# Browser integration tests

Native CLI and HTTP correctness tests are Rust integration tests in
`tests/native_e2e.rs`, run by `cargo test`. This directory tests the existing
JavaScript UI with Playwright against real Rust servers and the project CLI/MCP.
It does not replace native testing or reimplement the DSH agent loop.

## Reproduce

```sh
cargo build --release
npm ci --prefix dashboard
npm ci --prefix tests/e2e
(cd tests/e2e && npx playwright install chromium)
RDSH_E2E_BIN=./target/release/rdsh npm test --prefix tests/e2e
```

`RDSH_E2E_BIN` resolves relative to the repository root. Results and desktop/mobile
PNGs go to `target/e2e`; override with `RDSH_E2E_OUTPUT`.
The runner creates isolated HOME/DSH_HOME/XDG directories, starts loopback servers,
and removes its own processes and fixtures. It never connects a provider or enables
Tailscale. It checks persisted settings, tokens/prune, session display, actual MCP
questions and browser answers, draft retention across SSE, process restart, and
revocation of the previous browser key. Linux CI installs Chromium and retains PNGs
and JSON even when the job fails.

The default command also runs `update-banner.mjs` with the real React component
and two independent authenticated plugin hosts. Dummy HOME and loopback ports
cover live update push, cross-tab/port close events, two-hour boundaries, reload
notification, project remounts, legacy records and unavailable browser storage.
Mocked updater responses also cover successful close, failed retry, and a newer
update arriving during a request; the actual updater never runs in this fixture.
The browser clock advances the cadence without waiting two hours. It saves real
PNGs and a verification report; it never restarts production DSH or executes the
updater. Run just this flow with `npm run test:updates`. Set
`RDSH_UPDATE_BASELINE_CLIENT` to the previous client file for before/after captures.

The default command also runs `task-outcomes.mjs` against the actual project
server and isolated acceptance checks. It covers reported done versus verified,
partial/full checks, fixed milestones after task splits, stale code and an old
response arriving after an SSE update. `RDSH_OUTCOMES_OUTPUT` selects its evidence
directory; `RDSH_OUTCOMES_BASELINE` optionally points to a previous `server.mjs`.
Full-panel PNGs use extra viewport height to keep the fixed action bar clear;
separate phone PNGs and overflow checks use the actual 390 x 844 viewport.

## Optional installed DSH integration

```sh
RDSH_HARNESS_BIN=/path/to/original/dsh npm run test:harness --prefix tests/e2e
```

This installs the local rdsh settings plugin into a temporary DSH Web profile and
tests save/readback/reload/corruption/retry in its actual UI. It uses no credentials
or model calls, and does not start the Electron Desktop GUI. DSH must already be
installed; the optional test is not part of CI. The report separates
`functional_result` from `mobile_accepted` and `mobile_readability`; command success
means the settings flow passed, not that mobile UX was accepted.

For an existing browser installation, set `RDSH_CHROME_PATH`; an environment with
bundled Playwright can set `RDSH_PLAYWRIGHT_MODULE` to its module path.

See [the verification matrix](../../docs/evidence/e2e-20261008.md) for observed
coverage and remaining environment-specific checks.

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
