# Desktop (Electron) integration

How rdsh attaches to **DeepSeek Harness Desktop** ("the app"), what is verified,
what cannot work, and the exact commands.

Upstream facts in this document come from `apps/desktop/README.md` in
[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)
(`master`, read 2026-10-12, sections "Terminal command", "Bundled command
runtime", "Installation ownership", "Runtime and plugin activation"). The
Desktop application itself was **not** executed while writing this guide: this
Linux host has no Desktop build (Linux is not a supported Desktop release
target) and the app is not installed. Detection and forwarding are covered by
unit tests and a stub-command integration test; see
[Verification status](#verification-status).

## What the app is

- An Electron shell around the complete dsh **Web** application, shipped
  natively for **macOS** and **Windows x64** only.
- It bundles its own Node/Electron runtime, its own pnpm
  (`resources/runtime/primary-runtime/dependencies/pnpm`) and its own CLI at
  `resources/runtime/cli/bin/dsh` (`dsh.cmd` on Windows).
- It **shares** `$DSH_HOME` with the CLI (sessions, settings, credentials,
  workspaces, storage) but keeps **executable packages, plugin activation and
  lockfiles separate** in the reserved profile `$DSH_HOME/profiles/desktop`.
- The npm `dsh` CLI refuses to boot or manage that profile; the
  Desktop-installed command may manage it while the app is closed, and the
  app's own **Plugins** page manages it while the app is running.

## Where rdsh fits

| Surface | How rdsh is used | Status |
| --- | --- | --- |
| CLI (`dsh`) | `./install.sh --as-dsh` / `.\install.ps1 -AsDsh`; native fast paths answer, everything else delegates byte-identically | supported |
| TUI profile | `rdsh tui` delegation plus `rdsh tokens/search/sessions/compact` | supported |
| Web profile | `rdsh web`, the bundled plugins (`rdsh-settings`), `rdsh serve` dashboard | supported |
| Desktop app | `rdsh desktop status` / `install` / `verify` attach the plugins to the reserved profile through the app's own command runtime | supported (this document) |
| Agent loop, profile boot, Electron shell | not reimplemented; rdsh never boots the `desktop` profile | out of scope |
| In-app token/search/session delegation | pure compute (token estimate/prune) is the only in-app bridge, opt-in and fail-open | partial by design |

`rdsh --profile desktop ...` keeps returning exit 2 with
"profile desktop is managed exclusively by the Electron application": rdsh does
not attempt to boot a profile the app owns.

## Attach the plugins

1. **Install and open the app once**, then quit it. The first launch creates
   `$DSH_HOME/profiles/desktop/package.json`; the Desktop command refuses an
   uninitialized profile instead of creating a CLI-style profile in its place.
2. **Attach** (from a rustdsh checkout, with `rdsh` on PATH):

   ```sh
   rdsh desktop status                     # read-only: app, command, profile, plugins
   rdsh desktop install --plugins-dir .    # rdsh-settings + default third-party (sound, gitview)
   rdsh desktop install --plugins-dir . --compute   # also rdsh-compute
   rdsh desktop install --plugins-dir . --no-sound --no-gitview  # skip third-party
   ```

   `rdsh desktop install` resolves the Desktop command — `DSH_DESKTOP_CLI`,
   a standard application directory, or a `dsh` on PATH that lives inside the
   app's runtime (`resources/runtime/cli/bin/`, which **Manage dsh Command...
   -> Install** creates) — then runs, once per package:

   ```sh
   <app>/resources/runtime/cli/bin/dsh plugin --profile desktop add <package>
   ```

   The package operation keeps the shared profile write lock, version
   compatibility checks and bundle activation with the app's plugin manager.
   rdsh never edits the profile manifest itself.
3. **Reopen the app** so the profile recomposes, then verify:

   ```sh
   rdsh desktop verify                        # rdsh-settings enabled?
   rdsh desktop verify --require rdsh-compute # require a specific plugin
   ```

### Without the command runtime

The app's **Plugins** page can install the same packages (registry names, git
URLs, or an absolute path into a rustdsh checkout) while the app is running;
this needs no `dsh` command and no `rdsh`. Use it when the app lives in a
non-standard location or when you prefer the UI.

### Testing on Linux (Fedora)

Upstream builds and launches the Desktop shell only for `mac-arm64`, `mac-x64`
and `win-x64`: `resolveDesktopBuildTarget` rejects every other target, so on
Fedora both `pnpm run dev:desktop` and the `package:*` scripts stop with
`desktop build paths: unsupported target linux-x64` (the AppImage block in the
electron-builder config is not reachable from those targets). The equivalent
surface on Fedora is the **Web profile** — `rdsh web` serves the same
application the Desktop shell wraps, with the same plugins.

`rdsh desktop` is still ready for a Linux tree obtained another way (a build from
a machine that has one, a locally extended target list, or an extracted
AppImage), and the app's own Plugins page manages the same profile:

```sh
# Extracted AppImage
./DeepSeek-Harness-<version>.AppImage --appimage-extract
DSH_DESKTOP_APP_DIR=$PWD/squashfs-root rdsh desktop status

# Any unpacked tree
DSH_DESKTOP_CLI=<app>/resources/runtime/cli/bin/dsh rdsh desktop status
```

Detection covers `$APPDIR` (exported by a running AppImage), `~/squashfs-root`,
`./squashfs-root`, `/opt/DeepSeek Harness` and
`~/.local/{share,opt}/DeepSeek Harness`. Everything after detection is identical
to macOS and Windows: the same reserved profile, the same lock, the same
**Plugins** page. Fedora needs no extra package; `zenity` or `kdialog` only
affects the app's native folder dialog.

### All profiles in one command

```sh
PROFILE=web      ./plugins/install.sh    # recommended plugins, web profile (+ default third-party)
PROFILE=tui      ./plugins/install.sh    # tui profile
PROFILE=desktop  ./plugins/install.sh    # forwarded through `rdsh desktop install`
PROFILE=desktop COMPUTE=1 ./plugins/install.sh   # plus the compute bridge
PROFILE=web SOUND=0 GITVIEW=0 ./plugins/install.sh  # skip the default third-party plugins
```

`PROFILE=desktop` never calls `dsh plugin` directly (the npm CLI refuses the
reserved profile); it forwards every package to `rdsh desktop install
--no-bundled --package <spec>`. With no `rdsh` on PATH it prints the manual
Plugins-page steps instead.

The installers can do this inline: `./install.sh --desktop` and
`.\install.ps1 -Desktop` attach `rdsh-settings`, `rdsh-compute`, and the default
third-party plugins (sound, gitview) after installing the launcher. Both are
no-ops when no initialized Desktop profile is detected, and neither fails the
installation.

`--plugins-dir` must name a directory whose `rdsh-settings/package.json` is
valid JSON with `"name": "rdsh-settings"`; anything else is skipped rather than
forwarded. On Unix a non-executable `DSH_DESKTOP_CLI` is run through `sh`.

## What the plugins give the app

| Plugin | Effect in the app | Gate |
| --- | --- | --- |
| `rdsh-settings` | rdsh settings section in the app's settings, Discord Rich Presence, context-engine switches, `rdsh.json` editing | none (default) |
| `rdsh-compute` | resident `rdsh compute` worker for token estimate/batch/prune through the Web plugin bridge | `rdsh features on compute` (off by default) |
| `github:cwd514/dsh-sound-notifications` (MIT, (c) 2026 cwd514) | effect sounds and desktop notifications for reply-done / approval / questions / errors | default on; `rdsh desktop install --no-sound`, `SOUND=0`, or `features.sound=false` to skip |
| `github:yugapor/dsh-gitview` (MIT, (c) 2026 yugapor) | Git panel: changes, diffs, history, branches, blame, CI status | default on; `rdsh desktop install --no-gitview`, `GITVIEW=0`, or `features.gitview=false` to skip |
| recommended upstream packages | `dsh-tool-present`, `dsh-tool-ask-user`, `dsh-skill-office`, `dsh-mcp-client`, and the rest of `plugins/recommended.md` | `PROFILE=desktop ./plugins/install.sh` (forwards the same command), or the Plugins page |

The compute bridge keeps its documented contract: pure string operations only,
1 MiB input cap, 5 s timeout, and a fallback to the JavaScript implementation on
any error, so the app behaves the same when rdsh is missing, older, or broken.
See [WEB-COMPUTE.md](WEB-COMPUTE.md).

## Environment overrides

| Variable | Used for |
| --- | --- |
| `DSH_DESKTOP_APP_DIR` | where the application directory lives (non-standard install) |
| `DSH_DESKTOP_CLI` | the Desktop-installed command to forward to; wins over detection |
| `APPDIR` | the mount point a running AppImage exports; used as an application directory on Linux |
| `DSH_DESKTOP_USER_DATA_DIR` | Electron userData override (development launches) |
| `RDSH_PLUGINS_DIR` | rustdsh checkout (or `plugins/`) for `rdsh desktop install` |
| `RDSH_BIN` | rdsh executable the plugins use for `--version` and the compute worker |

`rdsh desktop status` shows the application, command and profile it resolved
(and reports a `DSH_DESKTOP_CLI` that points at a missing file). A `dsh` or
`dsh.cmd` found on `PATH` inside `<app>/resources/runtime/cli/bin/` is also
accepted as the Desktop command, which covers a non-standard install directory
once the app's **Manage dsh Command... -> Install** has run.

## Safety and design rules

- **Read-only by default**: `status` and `verify` only read the profile
  manifest and probe well-known paths. `install` is the only mutating
  subcommand and it mutates nothing directly: it invokes the app's own command.
- **No runtime replacement**: the Electron shell, the bundled runtime and the
  signing/notarization chain are untouched. rdsh adds a plugin, not a boot path.
- **Quit the app first**: plugin changes take the profile lock while the Host is
  stopped. `rdsh desktop install` reports Electron's `SingletonLock` when it is
  present: on stderr in human output, as `running.hint` with `--json` (a hint,
  not a guarantee: the lock survives a crash).
- **Fail-open plugins**: a missing or failing bridge never blocks the app.
- **No credential traffic**: the bridge carries text and options only.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `Open DeepSeek Harness Desktop once ...` | the reserved profile does not exist yet | launch the app once, quit it, retry |
| `Desktop command runtime not found` | app never opened, unusual location, or command not installed | set `DSH_DESKTOP_CLI`, use **Manage dsh Command... -> Install** in the app, or install from the Plugins page |
| `plugin command failed` with a lock error | the app is still running | quit the app fully (tray on Windows, Cmd-Q on macOS) and retry |
| plugins listed as `absent` after installing | the app has not recomposed the profile | reopen the app, then `rdsh desktop verify` |
| `desktop status` reports `initialized` **and** `package.json is not valid JSON` | the reserved manifest is corrupt | let the app rewrite it (open it once) or remove the file, then retry |
| `rdsh --profile desktop` prints the Electron message | by design | use `rdsh desktop ...` instead |
| plugin has no effect in the app | feature gate off | `rdsh features on compute` for the bridge; check `rdsh features` |

## Verification status

There is no Desktop application to run on the development host, and the app
ships for macOS and Windows x64 only, so the feature is verified against the
documented command contract instead: a stub command that records its argv and
updates the profile the way the shared plugin manager does. The CI matrix
(`ubuntu-latest`, `macos-latest`, `windows-latest`) runs the same test file,
which means the Windows runner starts the stub as a `dsh.cmd` through
`cmd /C` from a directory whose name contains a space - the packaged layout.
The Windows runner additionally parses `install.ps1` with the PowerShell
language parser.

Verified on this repository's Linux host:

- `cargo test` unit tests for detection (app/command candidates per platform,
  profile parsing, plugin state, Electron lock hint, plugins-directory
  resolution, target selection, PATH-runtime scan, malformed/relative/broken
  inputs).
- `node --test tests/desktop.test.mjs`: status JSON, `--dry-run` (no command
  execution, no manifest change), forwarding argv, plugin activation through the
  stub command, `verify` pass/fail, uninitialized-profile refusal.
- `sh tests/regress.sh`: `rdsh --profile desktop` still exits 2;
  `desktop status|status --json|install|verify` behave as documented.
- `node --test tests/plugin-security.test.mjs tests/settings-client.test.mjs
  tests/update-banner.test.mjs tests/feature-switches.test.mjs
  tests/model_benchmark/fence.test.mjs` and the compute plugin's own `npm test`
  cover both copies of the `rdsh` binary resolver used inside the app.
- One manual end-to-end run with a stub Desktop command
  (`plugins/install.sh` with `PROFILE=desktop`): 8 packages forwarded as
  `plugin --profile desktop add <spec>`, `rdsh-settings` activated in the
  fixture profile, `rdsh desktop verify` passes.

Not verified here:

- No real Electron process was started anywhere, on this host or in CI: the
  Desktop command is a stub that implements the documented contract, so real
  pnpm installation, profile locking and bundle activation still need one run
  on a machine with the app.
- `.\install.ps1 -Desktop` is not executed end to end (that needs a release and
  a real app); CI parses it and the POSIX tail is exercised with a stub.
- A Windows install directory chosen by something other than the default
  (`%LOCALAPPDATA%\Programs\DeepSeek Harness`, recorded in the uninstall
  registry key) is not detected automatically; `DSH_DESKTOP_APP_DIR`,
  `DSH_DESKTOP_CLI`, or the app's **Manage dsh Command...** entry cover it.
- Whether the bundled Node honors `NODE_COMPILE_CACHE`, and Desktop cold/warm
  startup timings (see [DESKTOP-SPEEDUP.md](DESKTOP-SPEEDUP.md)).

## Related documents

- [DESKTOP-SPEEDUP.md](DESKTOP-SPEEDUP.md) - measured rdsh vs Node costs, what
  the app's startup can and cannot inherit.
- [WEB-COMPUTE.md](WEB-COMPUTE.md) - the `rdsh-compute/1` protocol and the
  `T_total` acceptance rule.
- [ARCHITECTURE.md](ARCHITECTURE.md) - delegation model and non-goals.
