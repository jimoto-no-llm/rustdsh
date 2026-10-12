# Changelog

All notable changes to this project are documented here.
Format follows Keep a Changelog, versioning follows Semantic Versioning.

## [0.3.1] - 2026-10-12

### Fixed

- Dashboard: the model catalog module is authorized and served again, so project
  pages render instead of failing with 401/404 and a blank screen.
- `rdsh serve` no longer panics when its stderr is closed (for example
  `rdsh serve 2>&1 | head -1`): log writes now ignore write errors.
- `install.sh --from-release` removes every download directory at exit, so no
  archive, sidecar or extracted binary is left behind in TMPDIR.
- The setup web UI writes the canonical `features.<id>` switches and reports
  their effective state, so its toggles match `rdsh features`.
- Desktop: bundled plugin specs stay slash-separated on Windows.
- Docs: the desktop integration table no longer trips the markdown linter.

### Added

- The DSH web UI's rdsh section shows the running `rdsh` and `dsh` versions.
- `rdsh desktop status|install|verify` detects the DeepSeek Harness Desktop
  (Electron) application, its reserved `$DSH_HOME/profiles/desktop` profile and
  its bundled command runtime, then attaches the rdsh plugins through that
  command (`plugin --profile desktop add`). `--package` forwards extra specs,
  `--dry-run` prints the exact argv, `--compute` adds the resident compute
  bridge. Detection is read-only; the Electron runtime, the bundled Node and
  profile boot stay untouched.
- `PROFILE=desktop ./plugins/install.sh` plus the `--desktop` / `-Desktop`
  installer flags attach the recommended plugins to the Desktop profile, and
  `rdsh doctor` reports the Desktop app, profile and enabled plugins.
- GUI-hosted plugin hardening: the compute bridge and the settings plugin
  resolve `rdsh` from `RDSH_BIN`, then `PATH`, then the well-known install
  locations, and `rdsh-compute` declares its DSH bundle so a profile can enable
  it.

### Documentation

- `docs/DESKTOP-INTEGRATION.md`: what the Desktop application is, how to attach
  the plugins, environment overrides, safety rules, troubleshooting and the
  current verification status.

## [0.3.0] - 2026-10-12

### Security

- Release tagging is fail-closed: the tag must be annotated, its commit must be
  on `main`, and every required CI check on that exact commit must have
  succeeded before any platform build starts. Candidates keep using exact-tag
  installer URLs and never replace the stable `latest` channel.
- The installer verifies the pinned rustup bootstrap checksum before running it,
  and release metadata is read and written as UTF-8 on every host.
- Credentials and settings use atomic writes that keep unmodeled fields, reject
  integer narrowing, escape values as JSON, refuse overflowing JWT expiry, and
  keep local dashboard tokens out of logs.
- Browser-context POSTs to the dashboard require an `Origin` header, and
  proxied backup and budget requests are refused. Webhook subscriptions and
  reply consumer ownership are validated before use.
- Web search advances its UTF-8 attribute scan safely, and context rebuilding
  enforces its UTF-8 byte cap.

### Added

- Agent tools keep **normal file access by default**: the model can read and
  write the project like any other tool. The strict bubblewrap boundary is now
  opt-in through `--share-file`, `features.agent_tool_sandbox=true`, or
  `RDSH_SECURITY=1`.
- Feature switches: `rdsh features` lists all optional capabilities with their
  effective state, and `rdsh features on|off <id>` (or
  `rdsh settings set features.<id> true|false`) turns one off. Bundled plugins
  honor the same switches, so Discord Rich Presence, update checks and
  notifications, the sound-notification offer, the compute bridge, the budget
  guard and the release probe can be disabled from one place. Existing keys
  (`discord.enabled`, `extras.enable`, `beta.context_engine`) keep working,
  and `features.<id>` wins when both are set.
- `rdsh compute`: opt-in resident pure-compute worker (`rdsh-compute/1`) that
  answers token and batch estimates without filesystem, credential or session
  access; its Web proof of concept stays opt-in.
- The plugin installer offers opt-in DSH sound notifications.
- Dashboard: report sources and observation freshness, human bookmarks and
  annotations, saved project workspace layouts, and read-only observation of
  external CLI processes.
- Reproducible offline control-plane fault simulator, and retained worker
  worktrees with declared scopes.
- Windows: scoped dashboard tray, unified rushDSH artwork across web and
  Windows, and DSH 0.2.1-alpha.1 support alongside 0.2.0-rc.2.

### Fixed

- **Installer:** a Linux x86_64 install now selects the static musl build on
  musl hosts and on glibc older than 2.39, runs the downloaded binary before
  installing it, and retries with the musl build when the glibc build cannot
  start. Ubuntu 22.04, Debian 12 and RHEL 9 clones install cleanly instead of
  failing with `GLIBC_2.39 not found`.
- Update checks close completed runs without generating false updates, keep
  dismissals across projects and GUI instances, and preserve the two-hour
  reminder cadence.
- `rdsh logs` streams only the requested tail and keeps cwd-relative paths
  inside the confined root.
- Windows tray startup and cleanup are validated, budgeted before the launcher
  timeout, and timed-out helpers are confirmed to exit.
- WSL keeps a co-installed native package on the active Koffi version, and
  interpreter and update selection stay compatible.

### Changed

- Performance: `rdsh serve` cuts idle accept latency and answers estimates in
  batches, dashboard budget totals replay incrementally, native search work is
  bounded, and compressed session logs are no longer re-read in full.
- Release process: notes follow the v0.2.0 format, all five platform builds are
  staged and verified before publication, and project metadata, installers and
  documentation point at the canonical `jimoto-no-llm/rustdsh` repository.
- Adds `tests/install-isolated.sh`: the built or published artifacts are
  installed inside clean containers with no network, covering the distro matrix,
  the musl fallback and the fail-closed paths. It runs in CI and gates releases.

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

[0.3.1]: docs/releases/v0.3.1.md
[0.3.0]: docs/releases/v0.3.0.md
[0.2.0]: docs/releases/v0.2.0.md
[0.1.5]: https://github.com/jimoto-no-llm/rustdsh/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/jimoto-no-llm/rustdsh/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/jimoto-no-llm/rustdsh/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/jimoto-no-llm/rustdsh/releases/tag/v0.1.2
[0.1.0]: https://github.com/jimoto-no-llm/rustdsh/tree/806c583
