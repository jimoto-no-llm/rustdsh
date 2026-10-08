# Changelog

All notable changes to this project are documented here.
Format follows Keep a Changelog, versioning follows Semantic Versioning.

## [Unreleased]

## [0.2.0] - 2026-10-08

### Security

- Agent tools launched through rustdsh now require Linux x86_64, bubblewrap,
  prlimit, and the audited DSH 0.2.0-rc.2 runtime. They can inspect only files
  explicitly shared with `--share-file`, without host credentials or network.
  Unsupported agent environments fail closed; native commands remain available
  subject to the platform limits documented in README.
- External CLI credentials are no longer imported automatically. Imports require
  an explicit provider or record. Hook misses no longer grant approval.
- File reads reject symlink races, hard links and FIFOs; settings and credentials
  use private atomic writes. Plugin routes require authenticated sessions.
- Release updates require valid SHA256 sidecars before extraction. Release
  publishing waits for every platform asset and verifies all checksums.

### Added

- Dashboard CLI adapters, session ledger, run recovery, scoped stops, checkpoints,
  retries, model routing, task preflight and acceptance evidence.
- Reviewed question/reply workflows, follow-up ordering, mobile overview,
  connection diagnostics, cost and budget controls, credential-free history
  backups, and staged release qualification.

### Fixed

- Preserve unmodeled settings and explicit working-file clears when saving forms.
- Do not cache unknown session token sizes when the zstd CLI is unavailable;
  recheck legacy unknown sizes once zstd becomes available.
- Dismissed update banners remain hidden across polls and reloads for two hours,
  unless a new update is recorded.

## [0.1.5] - 2026-10-06

### Changed

- `sessions --tokens` reuses decompressed sizes from a content-keyed cache
  (`~/.cache/rdsh/sessions-tokens.json`, `RDSH_TOKENS_CACHE=0` disables it);
  repeat views drop from ~0.7s to ~5ms with byte-identical values.
- Deferred `.zstd` files stream through one `zstd` call per session and skip
  the wasted full-file header walk via a first-frame sniff.

## [0.1.4] - 2026-10-06

### Added

- `rdsh sessions --json`: machine-readable session list for sidecar use
  (Desktop/Electron); default table output is unchanged.
- GitHub community health: Code of Conduct, Security/Support policy,
  issue forms, PR template, Dependabot, docs set.
- Docs: ARCHITECTURE / BENCHMARKS / ROADMAP / RELEASING guides.
- rdsh settings UI bundled by default (`./plugins/install.sh`) and
  matched to the Harness theme; see `docs/RDSH-SETTINGS.md`.

### Fixed

- `rdsh doctor` no longer reads huge binaries in full (4.6s -> 0.1s);
  entries are size-gated before reading, warnings unchanged.

### Changed

- Context engine は既定OFFになりました（実験的）。使うときだけ
  `rdsh settings set beta.context_engine true` でONにします。
- Context engine v2: 複合語の点数検索、優先度パッキング
  （goal優先・retrievedから削減）、git snapshot強化、設定は
  `rdsh.json` に一本化（旧ファイルは補完のみ）。
- `rdsh settings get/set/unset/keys` を追加し、context以外も
  CLIから編集できます（例: `search.max`、`guard.deny`、`serve.port`）。

## [0.1.3] - 2026-10-05

### Added

- Context engine prototype: `rdsh context build/search/status/explain`
  rebuilds per-turn context from local files (no vector DB).
- Unified settings: `rdsh settings show/path/init` backed by
  `$DSH_HOME/rdsh.json`; every native default (budgets, limits, ports,
  guard patterns, default profile, beta flags) follows settings unless
  the CLI flag is passed explicitly.
- DSH settings UI: `plugins/rdsh-settings` adds an `rdsh` section to
  the settings sidebar (same design, order 20).
- Beta gate: `rdsh context` requires `beta.context_engine=true`.

## [0.1.2] - 2026-10-04

### Added

- Private project dashboards, QR access, and MCP Events.
- Single installer uploader; pinned line endings for installers.

### Fixed

- CI fixes around OAuth auto-recognition, first-run setup, release installers.

## [0.1.0] - 2026-09

### Added

- Initial Rust launcher: hot-path port with verbatim exec delegation to dsh.
- Native fast commands: tokens / compact / inspect / serve / guard / search.
- Floating setup UI, dsh-default detection, SearXNG search.
- Installers: install.sh (Linux/macOS/WSL), install.ps1 (Windows).

[Unreleased]: #unreleased
[0.2.0]: docs/releases/v0.2.0.md
[0.1.5]: https://github.com/sahenjp/rustdsh/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/sahenjp/rustdsh/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/sahenjp/rustdsh/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/sahenjp/rustdsh/releases/tag/v0.1.2
[0.1.0]: https://github.com/sahenjp/rustdsh/tree/806c583
