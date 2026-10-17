# Changelog

All notable changes to this project are documented here.
Format follows Keep a Changelog, versioning follows Semantic Versioning.

## [Unreleased]

## [0.7.0] - 2026-10-17

### Added

- Release native Linux packages, `rdsh_<version>_amd64.deb` and
  `rdsh-<version>-1.x86_64.rpm`, built from `packaging/nfpm.yaml` with a
  pinned nfpm (v2.48.0) in a new `packages` CD job. `sudo apt install
  ./rdsh_*.deb` and `sudo dnf install ./rdsh-*.rpm` install `/usr/bin/rdsh`
  without a Rust toolchain or `install.sh`; README.md, README.ja.md and
  docs/FEDORA.md document both commands, and release verification refuses a
  missing, duplicated, mislabelled or tampered package.

- `packaging/` carries install manifests for the published macOS and Windows
  archives: `packaging/homebrew/rdsh.rb` (Homebrew, Apple Silicon and Intel),
  `packaging/scoop/rdsh.json` (Scoop) and the three `packaging/winget/`
  manifests (winget). Each one pins the exact v0.6.0 URL and SHA-256, with
  install commands and the update step in `packaging/README.md` and
  `docs/PACKAGE-MANAGERS.md`. `scripts/update-packaging-manifests.py`
  regenerates every pinned value from `release-digests.tsv` and
  `release-digests-windows.tsv` and verifies them with `--check`, so the
  manifests never drop out of sync with what the installers trust
  (#728).

## [0.6.0] - 2026-10-17

### Security

- `rdsh guard` normalizes a command string before deny matching: quoting
  (`r"m" -rf`), same-line variable assembly (`A=rm; $A -rf`), command
  basenames (`/bin/rm -rf /`), nested quoted commands (`sh -c "rm -rf /"`) and
  path traversal or symlink targets are folded into bounded candidate texts, so
  the structural patterns can no longer be displaced by obfuscation (the
  #29/#32/#33 semantics are unchanged, and block still exits 2 with the same
  stderr) (#708).

### Added

- `scripts/benchmark-node-vs-rust.py` and its
  `scripts/benchmark-node-reference.mjs` reference measure the PreToolUse hook
  (`rdsh guard`), `rdsh tokens` and `rdsh search` against equivalent Node.js
  work on one generated dataset, with output-equality oracles, a JSON report and
  every raw sample. README.md, README.ja.md and docs/BENCHMARKS.md name the exact
  command each number measures, so the ~0.90 ms headline is stated as
  `--version` process launch only and the hook is reported at ~2.0 ms per call
  including process launch (#706).

- `rdsh doctor` finds the original `dsh` through the nvm, volta, fnm, pnpm and
  `npm -g` directories when a non-interactive shell or a service unit never ran
  their initialization, while PATH and the local backups keep their resolution
  order, and Node discovery accepts the nvm layout
  (`~/.nvm/versions/node/vX.Y.Z`). It prints a Node/npm/pnpm environment block
  (en/ja/zh, and under `doctor --json` as `environment`) and reports the pnpm
  build-script policy with the approval command that matches the installed pnpm
  release. Warnings never change the exit status, which still depends on the
  original `dsh` alone (#707).

- `plugins/install.sh` now separates **essential** plugins (installed on every
  run and printed first) from **recommended** ones, and accepts
  `--recommended=all|none|list|id,...` (or the `RECOMMENDED` environment
  variable) so non-interactive runs select a set without a prompt. With a TTY it
  lists the recommended plugins and asks before adding them; without one the
  historical per-profile defaults are unchanged. `plugins/recommended.md`,
  README.md, README.ja.md and docs/DESKTOP-INTEGRATION.md document the tiers
  (#713).

- `install.sh` reports a host readiness check before it downloads or builds
  anything: the tools the chosen path needs (`curl`, `tar`, `gzip`, coreutils),
  the Node.js 22+ / original `dsh` state and whether `PREFIX` is writable, each
  with the host's own install command (`sudo dnf install -y ...` on rpm hosts,
  and the Debian, Alpine, Arch and openSUSE equivalents). Fedora, RHEL, CentOS,
  Rocky, AlmaLinux and Oracle Linux also get the optional `zstd`/`bubblewrap`
  packages, a `PATH` hint and a note on which glibc or static musl archive was
  chosen, so no musl package is implied. `tests/install-isolated.sh` covers the
  rpm branch with a faked `ID=fedora` on a Debian base (#714).

- `rdsh subagents defaults [--json]` prints the limits `rdsh subagents plan`
  applies to a request that omits `limits`, together with the `source`
  (`settings` or `builtin`). The planner's built-in numbers are now overridable
  once through the new `subagents` section of `rdsh.json`
  (`max_parallel`, `max_items_per_agent`, `max_weight_per_agent`,
  `budget_units`); a request key still wins, and a missing or unreadable
  settings document falls back to the built-in defaults so an unrelated corrupt
  file cannot block a plan. The exploration subagent plugin also exposes its
  effective admission policy as `createOptimizer(...).limits` (#715).

- `plugins/rdsh-translation` は、完了した英語・中国語回答のアクション行に
  「日本語訳で置き換える」を追加しました（#448 Step 2, #718）。表示専用の「日本語訳を表示」は
  そのままに、明示操作のときだけ`/ja-replace`が独立した翻訳を1回送り、
  `surfaceOp: { op: 'replace', startSeq, endSeq }`と`source.kind: 'rdsh-translation'`で
  対象回答のsurfaceノードを訳文に置き換えます。新しいターンも追指示のuserメッセージも追加せず、
  元の回答は追記専用ログと人間向けtranscriptに残ります。busy・対象なし・保護トークン欠落・
  session拒否・置換済みは追記せずエラーを表示します。DSHが置換をモデル可視surfaceだけに
  適用するため画面上の回答表示は差し替わりません（訳文はダイアログで確認できます）。

- `plugins/rdsh-ui-comfort` makes Enter deliberate in the DSH Web chat and
  adds a `rdsh 入力` settings section. A plain Enter in the composer inserts a
  line break and a second Enter inside 1.5 s sends; the goal editor no longer
  commits on Enter, including the Enter that confirms an IME conversion, so
  Ctrl/Cmd+Enter (or the check button) commits and Escape still cancels. Both
  behaviours default to on and every modified Enter, completion-menu Enter,
  key auto-repeat and IME composition stay with the shell. A profile gets the
  plugin with `dsh plugin --profile web add <repo>/plugins/rdsh-ui-comfort`
  (#716).

### Changed

- `rdsh serve` states its role in the header as the Audit & Performance Monitor
  for DeepSeek Harness in English, Chinese and Japanese, renders the build
  version and a role overview before the token is entered, and fills the doctor
  diagnostics, sessions and skills cards in parallel once connected, so the first
  paint no longer reads as an empty chat page (#705).

- Former-owner `sahenjp/rustdsh` issue and pull-request links in
  `dashboard/README.md`, `docs/evidence/*.md` and the workflow-board READMEs
  point at the canonical `jimoto-no-llm/rustdsh` repository, because the old
  `issues/N` paths answer 404 instead of redirecting. The docs link-check remap
  stays so a pull request opened before the unification still resolves (#704).

- `release-digests.tsv` and `release-digests-windows.tsv` pin the published
  v0.5.2 archives and move the `latest` row to v0.5.2, so `install.sh
  --from-release` and the automatic updater install the release GitHub marks
  Latest (#702).

- The bounded-exploration subagent plugin admits 3 concurrent runs by default
  instead of 2, matching the planner's own default wave width (`max_parallel: 3`
  in `src/subagent_plan.rs`), so one default `rdsh subagents plan` wave runs
  without queueing. Its queue wait default rises from 10 s to 120 s and the
  accepted ceiling from 60 s to 600 s: a 10 s deadline expired before a single
  scout run could finish, which made the documented 8-deep queue unreachable and
  turned queued work into `RDSH_SUBAGENT_WAIT_TIMEOUT`. The bundled
  `cordis.patch.yml` pins the same values and a test now fails if the two
  drift (#715).

### Fixed

- The Windows tray helper waits for readiness by observed startup progress
  instead of an absolute clock: `dashboard/windows-tray.mjs` re-arms a
  `TRAY_READY_STALL_MS` quiet window at spawn and at each startup phase, so a
  cold start that is still alive is no longer killed by a fixed deadline, and
  the diagnostics report `last_event` and `quiet_ms` (#717).

## [0.5.2] - 2026-10-16

### Fixed

- The dashboard artifact preview truncates text on a UTF-8 character boundary
  instead of splitting a multi-byte sequence, refuses a non-regular file with
  415 instead of opening it, redacts credentials in a URL without the previous
  regular expression, and discards a preview that a newer request replaced. A
  dashboard test and the browser E2E check cover the bounds (#698).

### Changed

- `sync-dsh.sh` replaces its own installed copy with the current script from
  `main` before it does any work, so a fix to the daily run (the model-catalog
  step, for instance) reaches every machine instead of waiting for a manual
  update. `RDSH_SYNC_SELF_UPDATE=0` turns the step off, a copy inside a git
  checkout is never touched, and an origin that is unreachable or returns
  something other than a shell script keeps the current copy; see
  [docs/AUTO-UPDATE.md](docs/AUTO-UPDATE.md) (#697).

- `release-digests.tsv` and `release-digests-windows.tsv` pin the published
  v0.5.1 archives and move the `latest` row to v0.5.1, so `install.sh
  --from-release` and the automatic updater install the release GitHub marks
  Latest (#695).

## [0.5.1] - 2026-10-16

### Added

- The daily auto-update run refreshes the provider model catalogs: `sync-dsh.sh`
  ends with `rdsh models sync --auto`, which appends the models a provider
  advertises that the profiles lack and reports a catalog it could not reach
  without failing the run. `rdsh features off models_sync` (the default is on)
  or `RDSH_MODELS_SYNC=0` for one run turns the step off; see
  [docs/AUTO-UPDATE.md](docs/AUTO-UPDATE.md) (#692).

### Fixed

- The translation plugin classifies a malformed `rdsh.json` as
  `settings.malformed` ("format is invalid") instead of the unreadable-settings
  message, and `ci.yml` runs the `translation-core` and
  `translation-client-crlf` suites so a regression fails CI (#691).

- The links job parses `.lychee.toml` again: lychee 0.24.2 rejects the unknown
  `headers` key, so the crates.io crate pages are excluded by pattern instead
  (#689).

### Changed

- Dependency updates: `sha2` 0.11.1, `@modelcontextprotocol/client` 2.3.1 in
  `plugins/rdsh-mcp-oauth`, `dependabot/fetch-metadata` 3 and
  `pnpm/action-setup` 6 (#685, #686, #687, #688).

- `release-digests.tsv` and `release-digests-windows.tsv` pin the published
  v0.5.0 archives and move the `latest` row to v0.5.0, so `install.sh
  --from-release` and the automatic updater install the release GitHub marks
  Latest (#690).

## [0.5.0] - 2026-10-16

### Security

- The unresolved Dependabot and Code scanning alerts are cleared in one change:
  the headless runtime and the MCP plugins pin `@modelcontextprotocol/client`
  to 2.3.1 and `fflate` to 0.8.3, and every npm manifest is registered with
  Dependabot (#564, #647, #663).

- The audited-runtime guard reports `RDSH_SECURITY[UNSUPPORTED_RUNTIME]`,
  `[RUNTIME_CHANGED]` and `[RUNTIME_RESOLUTION_MISMATCH]` again: the preload
  compares each adapter digest, honours `RDSH_TOOL_ADAPTER`, detects a
  resolution mismatch in its `resolve` hook and refuses to run the nested body
  when the runtime is not the audited one (#676).

### Added

- 完了した英語・中国語回答に「日本語訳を表示」ボタンを追加。現在のモデルへ
  独立した翻訳リクエストを送り、コード・パスと原文・会話履歴を保持して訳文を表示します。
  Web／Desktop向けの導入と、失敗時の再試行に対応します。画面とコマンドの文言は
  DSHのlocaleカタログ（en/zh/ja）経由です（#448 Step 1）。
- `rdsh` publishes to crates.io from the release tag. The `cd` workflow gained a
  `publish-crate` job that runs after the GitHub release, and the `exclude` list
  in `Cargo.toml` drops the media, docs, dashboard and test trees so the crate
  fits the 10 MB registry limit (about 1.6 MB instead of 173 MiB). `ci.yml`
  guards both with the `crate-package` check, so `cargo install rdsh` and the
  prebuilt archives ship the same program.

- `rdsh models` prints the provider model catalog and `rdsh models sync`
  refreshes it from each provider's own published catalog, so a new model
  becomes selectable without editing `rdsh.json` by hand. The command landed
  after v0.4.0 (#641) and therefore ships in the next release; see
  [docs/MODEL-ROUTING.md](docs/MODEL-ROUTING.md).

- `plugins/rdsh-answer-guard` recovers a turn whose reply was emitted only into
  the reasoning channel: DSH closes such a turn as `completed` (its
  `EMPTY_RESPONSE` check only sees a fully empty message) and the Web UI folds
  the reasoning away, so the reader sees no answer and the agent looks stuck.
  The guard watches the committed events and, at `agent/turn-stopping`, steers
  one notice asking the model to restate the answer as text — once per turn,
  never on an aborted turn, and never when a tool result is still owed. It is
  installed by `./plugins/install.sh` and `rdsh features off answer_guard`
  disables it. See [README](plugins/rdsh-answer-guard/README.md).

- rdsh-owned output speaks English, Simplified Chinese and Japanese across the
  CLI, the Web UI, the bundled settings plugin and the standalone dashboard:
  help, diagnostics, interactive setup prompts and policy validation follow
  `--language`, `RDSH_LANG`, `general.language`, then the OS locale,
  defaulting to English. Delegated `dsh` arguments, model output, JSON fields,
  files and protocol identifiers are never translated (#617, #675, #678).

- The parallel dashboard feature work landed in one integration (#652):
  history survives a project move, per-device permissions, a versioned human
  decision log, versioned project profiles, provider quota and retry status,
  conservative run-stall diagnostics, a cross-project overview, a causal
  timeline, prioritized notifications, project-scoped deep links, reusable
  workflow recipes, artifact preview, secret-safe replay manifests, safe
  project state migrations and CPU, RAM and port reservations are all in
  `dashboard/`.

### Fixed

- 更新通知を dismiss したら、その更新については再表示しない（新しい更新のときだけ通知する）。

- Windows debug builds no longer overflow the main-thread stack while clap
  builds its parser: `build.rs` reserves the same 8 MiB as Unix
  (`/STACK:8388608` for MSVC, `-Wl,--stack,8388608` for GNU) (#655, #656).

- The settings plugin truncates strings by Unicode scalar value instead of
  UTF-16 code unit, so a GUI save can no longer write an isolated surrogate
  into `rdsh.json` and break every CLI command; its limits now match the Rust
  side (`default_profile` 200, `searxng_url` 2000) (#636, #637).

- `rdsh logs` shows its own "no logs" text again instead of the generic
  directory message the multilingual change introduced (#670), and
  `rdsh desktop install --plugins-dir` absolutizes a relative directory before
  building the plugin specs (#669).

- A failed update keeps its reason on stderr (#651), and the rpm family check
  matches quoted IDs and the real Oracle ID (#662).

### Changed

- Dependabot patch and minor pull requests enable auto-merge once the required
  approval and required checks pass (`dependabot-automerge.yml`); major updates
  stay manual. `.github/project-settings.json` lists the `crate-package`
  required check (ten names), enables secret-scanning validity checks, and
  records `require_last_push_approval: false`, matching the live branch
  protection and `docs/PROJECT-SETUP.md`.

- `AGENTS.md` and `docs/PROJECT-SETUP.md` record the working agreements that came
  out of the v0.4.0 cycle: the nine required checks and the branch-protection
  switches that are deliberately off, pinning the installer ledgers after every
  release, and keeping the security page at zero open alerts.

## [0.4.0] - 2026-10-15

### Security

- The optional `rdsh-mcp-exposure` plugin pins its development
  `@modelcontextprotocol/client` to the patched line (2.3.1, override) instead
  of the 2.0.0 that the upstream `dsh-mcp-client` peer pulls in, clearing the
  high-severity GHSA-6qxp-vccf-f47h alert. Runtime resolution is unchanged: the
  plugin uses the host DSH's MCP client.

- `install.ps1 -FromRelease` verifies the Windows archive against the digests
  pinned in `release-digests-windows.tsv` instead of the `.sha256` sidecar
  served next to it, so a release base that serves its own archive can no
  longer choose the checksum that admits it. The bypass needs `-NoChecksum`
  plus a typed `YES` at a terminal.

- The Windows pin lives in its own `release-digests-windows.tsv` ledger because
  the published v0.3.3 `install.sh` and every `sync-dsh.sh` copy refuse
  `release-digests.tsv` as a whole once one row names an asset outside the four
  Unix archives. `release-digests.tsv` therefore stays Unix-only, so
  `--from-release` and the automatic updater keep working for installs users
  already have, and `scripts/pin-release-digests.py` updates both ledgers.

### Added

- `plugins/rdsh-mobile-ui` is bundled and installed by `./plugins/install.sh`:
  below 767px the Web chat and composer use the full viewport width, the collapsed
  sidebar becomes a one-tap logo for the session list, and question cards fit the
  phone. The rules are adapted from Smart-DSH
  (<https://github.com/hikarioyama/Smart-DSH>, MIT) and ship only that responsive
  layout — not Smart-DSH's notifications, Esc handling or task hub. See
  [README](plugins/rdsh-mobile-ui/README.md).
- `rdsh provider add hai|sarashina|local-openai` writes an OpenAI-compatible route into a
  profile's `llm-pi-ai` providers (models from `--model`, opencode's
  `provider.<id>` or `GET /models`), keeping every other byte of
  `cordis.patch.yml`; `rdsh provider list` shows presets and per-profile
  route and key status. The `sarashina` preset writes the `compat` lines
  (`supportsStore`, `supportsUsageInStreaming`) and `maxTokens: 8000` that the
  API requires; its `tool_choice` default is a known open question for agent
  use. `HAI_API_KEY`, `SARASHINA_API_KEY` and `LOCAL_OPENAI_API_KEY` can be
  saved from the setup UI (`rdsh setup --yes` does not save them), but they count as a connection only when a profile's
  default model uses a route that reads them. Existing `llm-pi-ai` entries
  written with quotes, comments or any indent width are edited in place; a
  layout that cannot be read safely (including any other mention of
  `llm-pi-ai`, such as inside `- insert:`) is refused with the YAML to add by
  hand. See `docs/PROVIDERS.md`.
- `rdsh subagents plan` turns a declared use case into a deterministic
  dispatch plan for delegated subagents: role and model tier per item, bounded
  items and weight per agent, waves limited by `max_parallel`, and explicit
  warnings instead of guessed tiers. It starts no agent and writes nothing; the
  existing `workers prepare` still owns the checkout allocation
  (`docs/SUBAGENT-PLANNING.md`).
- `rdsh-dashboard agents list|submit|status|result|cancel` runs cursor-agent and
  devin as detached, cancellable jobs with untrusted-data results. The default
  `--permission read-only` selects each CLI's most restrictive mode
  (`--mode ask --sandbox enabled` for cursor-agent, `--permission-mode auto`
  for devin); it is a flag mapping, not an OS sandbox, and the known gaps are
  listed in `docs/AGENT-RUNNERS.md`. Every job end, and `cancel`, stops the
  agent's process group with TERM, a grace period and KILL, and records
  whether the stop was confirmed (`cleanup`); `cancel` also acts on jobs whose
  supervisor was lost or that finished with leftover processes, but only after
  proving the recorded group number still belongs to the job (a confirmed job
  is a no-op; where no process identity can be read, a group cannot be stopped
  after its supervisor is lost). On
  Windows descendants cannot be observed (no Job Object support): the leader
  tree is killed with `taskkill /T /F` while the leader is alive and cleanup is
  always reported `unconfirmed` (`windows_tree_unobservable`).
- `rdsh serial-proxy` replaces the standalone Node.js proxy with a native Rust
  command. It keeps the FIFO concurrency and rate limits, streams request and
  response bodies, and supports `--tool-choice-default <none|auto|required>`
  for Sarashina-compatible requests. See `docs/SERIAL-PROXY.md`.
- `rdsh update auto status|on|off` turns the daily automatic update on with one
  command: it writes a systemd user unit with the machine's own executable path
  and runs `daemon-reload` and `enable --now`. The update itself stays with
  `sync-dsh.sh` (digest pinning, downgrade refusal, verification, rollback) and
  the timer runs daily with up to 30 minutes of jitter. See
  `docs/AUTO-UPDATE.md`.
- `rdsh doctor` warns about broken wrappers and shadowed executables: dangling
  symlinks, a missing shebang, vanished `node`/`dsh` targets, duplicate `PATH`
  entries, a missing `dsh-orig` and an inconsistent `origin` ledger, collected
  in one bounded scan. It only warns; exit status and existing messages are
  unchanged.
- The `rdsh-update-banner` plugin is bundled again for the `web` profile, so
  update notifications return. Install it through the installer because pnpm
  prunes links it does not manage.

- `rdsh context inject` runs as a DSH `UserPromptSubmit` hook and attaches the
  turn context (goal, constraints, decisions, working set, git state, retrieved
  code, memory) through `hookSpecificOutput.additionalContext`. It is fail-open
  and always exits 0: an unreadable settings document or an unparseable payload
  inject nothing, while a damaged index or a deadline overrun drops only what
  depends on them and still injects goal, constraints, and memory.
- `rdsh context hook install|status|remove` merges that hook into a DSH
  `hooks.json` idempotently, keeps unrelated hooks untouched, and keeps a backup
  beside the first file it rewrites.
- The context memory store (`$DSH_HOME/rdsh-context-memory.json`, 0600, atomic
  write): `rdsh context remember|memory|distill|forget`. `distill` reads user
  turns from session logs (including `.jsonl.zstd` through the `zstd` CLI) and
  supersedes overlapping or retracted entries by deterministic rule, keeping the
  superseded record instead of overwriting it.
- `rdsh context build --sessions N` carries past sessions into one build, and
  `--require-stable` exits 3 unless the snapshot is provably stable: a git state
  or read file that changed during assembly counts, and so does a git state it
  cannot read.
- `rdsh deps build|query|impact`: a static dependency graph for Rust,
  JavaScript/TypeScript, Python and Go with a persistent incremental index
  (`$DSH_HOME/rdsh-index`, reused on unchanged size+mtime), symbol lookup, and
  direct/transitive dependents plus affected tests.
- `rdsh compact` now preserves high-value lines from the dropped middle
  (constraints, decisions, errors, diffs, commands) under a bounded reserve and
  reports a per-category digest, instead of keeping only the head and the newest
  turns.

### Fixed

- `sync-dsh.sh` discovers the `@deepseek-ai/dsh` tree by candidate instead of
  `npm root -g` alone (`DSH_PKG_ROOT`, npm's global root, the newest
  `~/.local/opt/*` tree, then the older per-user prefixes). A tree it cannot
  find, or one outside npm's global root, is reported and skipped while the
  rdsh release update still succeeds; npm-managed trees keep digest pinning,
  downgrade refusal, verification and rollback. See `docs/AUTO-UPDATE.md`.
- `rdsh update` stays native when rustdsh is invoked as `dsh`: it is back in
  the native command list and in `--help`, instead of being delegated to
  upstream `dsh`.
- The auto-update systemd unit quotes and escapes `ExecStart`, so an executable
  path containing spaces or `%` no longer breaks the timer.
- The update banner's close button no longer overlaps the timestamp.

- `release-digests.tsv` pins v0.3.3. Its follow-up PR was missing, so
  `install.sh --from-release` and the automatic updater stopped at v0.3.2 even
  though GitHub marks v0.3.3 Latest. `scripts/pin-release-digests.py` turns the
  follow-up into one reviewed command (refusing prerelease tags, missing
  archives and non-SHA-256 values), and `docs/RELEASING.md` uses it.

### Changed

- `rdsh-dashboard subagents plan` forwards to `rdsh subagents plan`: the planner
  is now the Rust implementation in `src/subagent_plan.rs`, the JavaScript
  planning module is removed so there is a single source of truth, and the
  request, plan and warning contract is unchanged
  (`docs/SUBAGENT-PLANNING.md`).
- Context retrieval expands its search hits with dependency-graph neighbours when
  the index exists, so an excerpt arrives with the files it depends on; without
  an index it degrades to the previous behaviour, and `features.dep_graph=false`
  keeps the index out of the context path entirely.
- Plain `rdsh context build` output starts with one `[snapshot: ...]` line (JSON
  already carried the object), so an assembled context is never mistaken for one
  that was verified later.
- `rdsh context status --json` also reports memory counts, the dependency-index
  summary, and the injection budget/deadline; `rdsh context build --json` adds a
  `snapshot` object describing whether the repository stayed stable.
- `rdsh compact` emits an identical line once. Repeats are counted in the
  dropped-line digest instead of being printed again, so a repeated command or
  error no longer consumes budget twice.

## [0.3.3] - 2026-10-13

### Security

- `install.sh --from-release` verifies every archive against the digests pinned
  in this repository's `release-digests.tsv` instead of trusting a checksum
  served next to the archive, so a tampered release base can no longer install
  its own payload. Unix only for now; `install.ps1` keeps using sidecars.
- The Windows dashboard launches its PowerShell tray helper, browser URL handler
  and installed CMD wrapper by absolute path. A `pwsh.exe` or `rundll32.exe`
  placed in the working directory is no longer selected. Re-run the installer
  to refresh an existing `rdsh-dashboard.cmd`.
- The installer validates the ICO header and payload ranges before rebuilding
  the Windows icon instead of trusting offsets in the image.

### Fixed

- Delegation skips `dsh` and Node candidates on `PATH` that the current
  effective user cannot execute, so an unrunnable first candidate no longer
  fails with `Permission denied`.
- `rdsh` shares the upstream DSH credential lock protocol, so saving and
  refreshing credentials after using rustdsh no longer times out.
- Dashboard lock cleanup no longer masks a committed write: the original error
  code is preserved and `lock_cleanup_unconfirmed` is attached.
- `rdsh_inspect` declares its parameters as a valid JSON Schema, so strict
  validators accept the tool definition.

### Added

- `rdsh guard --policy-file` classifies structured Read/Write/Edit operations
  and enforces the allow/deny policy against the resolved target; without the
  flag the previous text-matching behaviour is unchanged.
- The `rdsh-docs` skill ships with the plugins so the DSH web profile can
  check rustdsh behaviour against the verified source.
- The dashboard integrates worker changes in a fixed commit order and requires
  every check to pass before publishing.

### Changed

- Dependency updates: `sha2` 0.11 (digest output is encoded by an explicit
  lowercase hex encoder), `embed-resource` 3.0.12, `koffi` 3.3.3 and
  `@agentclientprotocol/sdk` 1.8.0.
- CI covers the Windows installer and delegation through Git Bash, runs the
  Discord presence suite, pins the upstream approval-integrity check, and the
  release job waits for the tag-push CI before building.

## [0.3.2] - 2026-10-12

### Fixed

- `rdsh compute` and the resident compute bridge contain a worker that closes
  its stdin mid-write: the resulting EPIPE no longer takes down the Node host,
  and the request falls back instead of exiting.
- `tokens`, `compute` and `serve` report `chars` as a Unicode scalar count
  instead of a UTF-8 byte count, so 日本語 is `3` chars rather than `9`.
- `context search` accepts two-character ASCII terms (`CI`, `UI`, `Go`)
  instead of silently returning no sessions; Japanese bigrams keep their weak
  score.
- `search-web` keeps valid results whose title, URL or snippet contains the
  correction word.
- Dashboard acceptance ignores unrelated forbidden files such as
  `.env.example` instead of stopping with `invalid_input_path`.
- Delegation skips `dsh` and Node candidates on `PATH` that cannot be
  executed, instead of failing with `Permission denied`.
- `rdsh headless "run the tests"` forwards the positional prompt the same way
  an explicit `--profile` does.
- `--dump-default-config` and `--dump-config-schema` reach upstream `dsh`
  as themselves instead of degrading to `--dump-config`.
- `rdsh compact` counts newlines in its token budget and no longer appends an
  extra trailing newline.
- Credential rotation replaces the `refs` entry instead of duplicating it, and
  already-duplicated files are healed back to a single entry.

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
