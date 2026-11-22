# Roadmap

Direction, not promises. Items move when someone sends a PR.
Managed under [PROJECTS.md](PROJECTS.md): this file states direction only,
issues and milestones are the source of truth for status.

Backlog index: [issue #74](https://github.com/jimoto-no-llm/rustdsh/issues/74)
(all 72 proposals mapped to feature issues, `P0`-`P3`; closed once all 62
child issues were closed).
Update this file at each minor release; status churn stays in issues.

## Now (`P0`-`P1`, released through `v0.7.0`) — shipped

This "Now" section is the roadmap snapshot at `v0.7.0`; releases have
continued through `v0.16.0`. For the current version see `Cargo.toml`,
`CHANGELOG.md` and `docs/releases/`.

- `v0.7.0` ships native Linux packages (`.deb` / `.rpm`) and pinned
  Homebrew, Scoop and winget manifests that
  `scripts/update-packaging-manifests.py --check` keeps in step with the
  pinned digests (#728, `docs/PACKAGE-MANAGERS.md`).

- Delegation stays byte-identical while upstream `dsh` evolves
  (`--passthrough` is the reference; see `docs/ARCHITECTURE.md`).
- Installers verified on Linux / macOS / WSL / Windows
  (`installer` label; `install.sh` / `install.ps1`; Unix archives pinned in
  `release-digests.tsv`, Windows archives in `release-digests-windows.tsv`).
  `install.sh` checks host readiness before downloading and prints the install
  command and `PATH` hint for the detected rpm family too (#714).
- Dashboard auth boundary, event subscriptions, QR flow
  (`dashboard` + `security` labels); the parallel dashboard work landed in one
  integration (#652) and artifact previews are bounded and drop stale results
  (#698).
- Credentials use the upstream DSH lock protocol (#375), and only the selected
  CLIs and providers are shared (#102).
- Context engine ships behind `features.context_engine` (default OFF).
- Release gate waits for the tag-push CI before building, and requires `main`
  ancestry plus the exact-SHA run before tagging (`rdsh` also publishes to
  crates.io from the release tag, #684; see `docs/RELEASING.md`).
- Security reviews landed: the Linux task sandbox (#254) and the external
  source provenance chain (#236), plus the token, authorization and install
  diagnostics (#627); the review-evidence live delivery no longer crashes
  (#661).
- `rdsh doctor` warns about broken wrappers and shadowed executables (#510),
  `rdsh update auto` installs the daily update timer (#507), and the original
  `dsh` is found through nvm / volta / fnm / pnpm / `npm -g` with a
  Node/npm/pnpm environment block and the pnpm build-script policy (#707,
  #709, #712).
- Windows: the fault-simulator output collision, the proxy wait deadlines and
  the Windows IPv6 CI failure are fixed (#526, #533, #540); the debug
  main-thread stack reserves the same 8 MiB as Unix (#656), the native e2e
  legacy-cache test is fail-closed (#654), fallback discovery and `guard` path
  normalization pass (#711), and the tray ready deadline follows observed
  startup progress instead of an absolute clock (#717).
- Model catalog: `rdsh models` reports the models a profile lacks and
  `rdsh models sync` refreshes them from each provider's published catalog
  without dropping existing entries (#641). The daily auto-update runs
  `rdsh models sync --auto` (#692) and `sync-dsh.sh` replaces its own
  installed copy with the current one first (#697).
- `rdsh` speaks `en` / `zh-CN` / `ja` across the CLI, Web UI, settings
  plugin and standalone dashboard, including README.zh-CN.md (#617, #675,
  #678), and Step 1 of one-click Japanese translation landed as a display-only
  button that leaves the history untouched (#664).
- The settings plugin truncates strings by Unicode scalar value and matches
  the Rust limits, so a GUI save can no longer break `rdsh.json` (#636,
  #637).
- `rdsh guard` parses the command as shell syntax before deny matching, so
  quoting, same-line variable assembly, command basenames, nested quoted
  commands and path traversal no longer displace the structural patterns
  (#708).
- The PreToolUse hook benchmark measures `rdsh guard`, `rdsh tokens` and
  `rdsh search` against equivalent Node.js work, and README / BENCHMARKS name
  what each number measures: the ~0.90 ms headline is `--version` process
  launch only and the hook is ~2.0 ms per call including process launch
  (#706).
- `rdsh serve` states its Audit & Performance Monitor role and fills its cards
  before the first paint (#705), the plugin installer separates essential from
  recommended plugins (#713), and the UI sends on the second Enter and guards
  goal editing against Enter (#716).

## Next (`P1`-`P2`, `v0.7.x` and later)

Open issues and milestones stay the source of truth. The closed issues named
below finished their rustdsh-side scope; only the residual stated here is
still open.

- macOS dashboard process-management boundary (#485, the last open item of
  the `v0.5.0` milestone).
- Cargo workspace split into `rdsh-cli` / `rdsh-guard` / `rdsh-core` /
  `rdsh-web` (#703).
- Routing experiments: #87 closed with a provisional opt-in plan
  (proposed `features.route_plan`, default off) with five measurement steps
  and five falsification conditions in
  `docs/proposals/provider-quota-routing.md` (#513, #742). The command name,
  placement, `route_plan` section and pricing schema still wait for the 87-1
  decision, and nothing is implemented yet. The child issues Command Code as
  a provider (#450) and the ZDR-only mode (#484) are open.
- Translated answers on screen: Step 1 (#664) only shows a translation and
  leaves the conversation and the next model input unchanged; Step 2 (#718)
  replaces the model-visible surface (#448, closed). Replacing what the
  screen shows needs a DSH-side API (assistant-node display or a per-message
  display slot).
- Codex headless exit: the opt-in pinned runtime exits 157-281 ms after
  `turn_end` (#505; #488, closed). Fixing the stock install needs upstream
  APIs (an awaitable cleanup, an unref'd idle timer and a DSH disposal
  bridge).

## Later (`P2`-`P3`, no milestone yet)

- Gradual JS-to-Rust migration (`rust` label): eight slices landed (#509,
  #520, #521, #524, #535, #538, #546, #547); the rest of the execution logic
  moves after the workspace split (#703; #516, closed).
- Windows `routing probe` exec deadline (win32 60000 ms): the tray wait
  follows observed startup progress (#717; #209, closed), but the probe has
  no progress to observe and keeps its fixed deadline. #209's root cause is
  not established (`docs/evidence/windows-startup/README.md`), so a probe
  timeout still needs investigation rather than being attributed to runner
  load.
- Windows worker Git `dirtyPaths` is 1.35x the JS baseline; settle the
  benchmark fallback rule (#586).
- `rdsh-docs` skill acceptance: measure skill selection and body loading at
  model run time (`plugins/skills/rdsh-docs`, #741; #84, closed).
- Windows-native dashboard parity with the WSL flow.
- Startup and memory regression tracking in CI (fail on >10 percent slip).
- Full i18n: `en` / `zh-CN` / `ja` UI strings shipped (#617), so what
  remains is keeping README.ja.md and README.zh-CN.md in sync with README.md
  (`ja` + `docs` labels).

## Non-goals

- Reimplementing the agent loop or profile boot in Rust.
- Forking the Harness UI or its protocol.
- Supporting all providers at once in routing (one at a time).
