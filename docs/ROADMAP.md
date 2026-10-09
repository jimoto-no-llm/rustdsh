# Roadmap

Direction, not promises. Items move when someone sends a PR.
Managed under [PROJECTS.md](PROJECTS.md): this file states direction only,
issues and milestones are the source of truth for status.

Backlog index: [issue #74](https://github.com/jimoto-no-llm/rustdsh/issues/74)
(all 72 proposals mapped to feature issues, `P0`-`P3`).
Update this file at each minor release; status churn stays in issues.

## Now (`P0`-`P1`, milestone `v0.3.0`)

- Keep delegation byte-identical while upstream `dsh` evolves
  (`--passthrough` is the reference; see `docs/ARCHITECTURE.md`).
- Keep installers working on Linux / macOS / WSL / Windows
  (`installer` label; `install.sh` / `install.ps1`).
- Dashboard hardening: auth boundary, event subscriptions, QR flow
  (`dashboard` + `security` labels).
- Land the current `feat/context-engine-practical` work behind
  `beta.context_engine` (default OFF).

## Next (`P1`-`P2`, milestone `v0.4.0`)

- Routing experiments (see `docs/proposals/`): cheapest-route selection
  across subscription providers, starting with a 2-provider manual table.
- More `doctor` checks for broken wrappers and shadowed binaries.
- Release automation: checksums, SBOM, musl builds for sync
  (see `docs/RELEASING.md`).

## Later (`P2`-`P3`, no milestone yet)

- Windows-native dashboard parity with the WSL flow.
- Startup and memory regression tracking in CI (fail on >10 percent slip).
- i18n: keep README.ja.md in sync with README.md (`ja` + `docs` labels).

## Non-goals

- Reimplementing the agent loop or profile boot in Rust.
- Forking the Harness UI or its protocol.
- Supporting all providers at once in routing (one at a time).
