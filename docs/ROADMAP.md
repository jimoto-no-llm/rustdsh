# Roadmap

Direction, not promises. Items move when someone sends a PR.
Managed under [PROJECTS.md](PROJECTS.md): this file states direction only,
issues and milestones are the source of truth for status.

Backlog index: [issue #74](https://github.com/jimoto-no-llm/rustdsh/issues/74)
(all 72 proposals mapped to feature issues, `P0`-`P3`).
Update this file at each minor release; status churn stays in issues.

## Now (`P0`-`P1`, milestone `v0.3.3`) — shipped

- Delegation stays byte-identical while upstream `dsh` evolves
  (`--passthrough` is the reference; see `docs/ARCHITECTURE.md`).
- Installers verified on Linux / macOS / WSL / Windows
  (`installer` label; `install.sh` / `install.ps1`; Unix archives also
  pinned in `release-digests.tsv`).
- Dashboard auth boundary, event subscriptions, QR flow
  (`dashboard` + `security` labels).
- Credentials use the upstream DSH lock protocol (#375).
- Context engine ships behind `features.context_engine` (default OFF).
- Release gate waits for the tag-push CI before building
  (see `docs/RELEASING.md`).

## Next (`P1`-`P2`, milestone `v0.4.0`)

- One-click translation of non-Japanese answers with history replacement
  (#448): spike, then the assistant-actions button, then replace via
  `surfaceOp`. Never auto-translate; Web UI only.
- Land the pending security reviews: Linux task sandbox (#254),
  sync digest pinning (#428), external source provenance chain (#236).
- Windows dashboard flake: intermittent routing probe / tray timeouts (#209).
- Start routing experiments (#87): cheapest-route selection, one provider
  at a time (see `docs/proposals/`).
- More `doctor` checks for broken wrappers and shadowed binaries.
- Windows side of the digest registry (`install.ps1`, follows #359).

## Later (`P2`-`P3`, no milestone yet)

- Windows-native dashboard parity with the WSL flow.
- Startup and memory regression tracking in CI (fail on >10 percent slip).
- Full i18n: keep README.ja.md in sync with README.md (`ja` + `docs` labels);
  UI strings follow after #448.

## Non-goals

- Reimplementing the agent loop or profile boot in Rust.
- Forking the Harness UI or its protocol.
- Supporting all providers at once in routing (one at a time).
