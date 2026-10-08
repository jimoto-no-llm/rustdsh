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
