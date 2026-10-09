<img src="assets/icon.png" width="96" alt="rdsh icon">

# rdsh — a fast, safe Rust launcher for `dsh`

[![ci](https://github.com/jimoto-no-llm/rustdsh/actions/workflows/ci.yml/badge.svg)](https://github.com/jimoto-no-llm/rustdsh/actions/workflows/ci.yml)
[![dashboard](https://github.com/jimoto-no-llm/rustdsh/actions/workflows/dashboard.yml/badge.svg)](https://github.com/jimoto-no-llm/rustdsh/actions/workflows/dashboard.yml)
[![docs](https://github.com/jimoto-no-llm/rustdsh/actions/workflows/docs.yml/badge.svg)](https://github.com/jimoto-no-llm/rustdsh/actions/workflows/docs.yml)
[![release](https://img.shields.io/github/v/release/jimoto-no-llm/rustdsh.svg)](https://github.com/jimoto-no-llm/rustdsh/releases)
[![license](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![rust](https://img.shields.io/badge/rust-1.85%2B-orange.svg)](https://www.rust-lang.org/)

[Japanese version](README.ja.md)

An independent community project; not an official DeepSeek or DeepSeek Harness project.

`rdsh` is a drop-in fast path for [dsh](https://github.com/deepseek-ai/deepseek-harness)
(the DeepSeek Harness CLI). Instead of rewriting everything, it ports only
the hot paths to Rust and delegates conversations and model runs to the
original `dsh` binary. Arguments you already use keep working as-is.

## Why rdsh?

- Fast startup, small footprint. `--version` replies in about 0.90 ms with about 2.9 MB peak RSS on Linux x86_64 (original `dsh`: about 88 ms and 66 MB). Short-CLI numbers only; they do not describe the resident Desktop app or model calls.
- Drop-in compatible. Anything that is not an rdsh-native subcommand is passed to the original binary unchanged, so existing scripts keep running.
- Useful native commands. Token estimates, search, compaction, session listing, and health checks run without starting Node.
- Safe by default. Read paths never write, server features stay off until enabled, and agent tools run under mandatory isolation on supported Linux.

## Getting started

```sh
rdsh --version && rdsh doctor   # verify install and original dsh
rdsh setup --web                # open the printed #key=... URL, connect a model
rdsh tui                        # start a conversation, confirm a model reply
```

See the [usage and recovery flow](docs/USER-FLOW.md),
[settings](docs/RDSH-SETTINGS.md), and [architecture](docs/ARCHITECTURE.md).
Delegated conversations need the original DSH runtime.

## Requirements

| Item | Detail |
| --- | --- |
| OS | Linux, macOS, WSL, Windows (native). Agent isolation needs Linux x86_64 + bubblewrap + prlimit. |
| DSH runtime | Original `dsh` for conversations. Audited versions: 0.2.0-rc.2, 0.2.1-alpha.1. |
| Rust | 1.85+ (source builds only). Prebuilt binaries need no Rust. |
| Optional | Node.js 22+ for the [Node.js dashboard](dashboard/README.md); SearXNG for `search-web`; `zstd` CLI for exact compressed token sizes. |

## Install

Fastest (prebuilt binary, no Rust needed):

```sh
# Linux / macOS / WSL
curl -fsSL https://github.com/jimoto-no-llm/rustdsh/releases/latest/download/install.sh | bash -s -- --from-release
```

```powershell
# Windows (PowerShell)
$f = Join-Path $env:TEMP 'rdsh-install.ps1'
Invoke-WebRequest -Uri https://github.com/jimoto-no-llm/rustdsh/releases/latest/download/install.ps1 -OutFile $f -UseBasicParsing
& $f -FromRelease
```

From source:

```sh
git clone https://github.com/jimoto-no-llm/rustdsh.git
cd rustdsh
./install.sh                 # build + install to ~/.local/bin/rdsh
./install.sh --as-dsh        # also shadow `dsh` (original kept as dsh-orig)
./install.sh --restore       # undo the shadowing
./install.sh --prefix=DIR    # custom install dir (default ~/.local/bin)
```

`install.sh` covers Linux, macOS, and WSL (auto-detects WSL, installs Rust
via rustup unless `--no-rustup`). Native Windows uses `install.ps1`:

```powershell
git clone https://github.com/jimoto-no-llm/rustdsh.git
cd rustdsh
.\install.ps1              # build + install to %LOCALAPPDATA%\rdsh\bin (+ user PATH)
.\install.ps1 -AsDsh       # also shadow `dsh` (original kept as dsh-orig)
.\install.ps1 -Restore     # undo the shadowing
.\install.ps1 -Wsl         # also install inside WSL via install.sh
```

| OS | Script | Notes |
| --- | --- | --- |
| Linux / macOS | `./install.sh` | Needs `cargo` or `curl` (rustup auto-install). |
| WSL | `./install.sh` inside the distro | Detected automatically; alongside native via `install.ps1 -Wsl`. |
| Windows (native) | `.\install.ps1` | Needs Rust (`winget install Rustlang.Rustup`); MSVC build tools required to compile. |

First boot with no model connected prints a setup pointer instead of leaving
you at the DeepSeek prompt: run `rdsh setup` (or `rdsh setup --login` to
start the Codex/opencode OAuth flow right away). Direct builds use
`cargo build --release` (produces `target/release/rdsh`).

## Usage

### dsh-compatible delegation

```sh
rdsh tui                          # same as: dsh --profile tui (with slim env)
rdsh --profile web --patch x.yml  # boot with an extra overlay
rdsh --passthrough tui            # no slim env; tool isolation remains
rdsh --dry-run tui -- --resume abc  # print what would be executed
```

Slim mode only adds environment variables; unknown keys are ignored
upstream. `--passthrough` toggles environment tuning and never disables
tool isolation. Details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

### Native fast commands (no Node startup)

```sh
rdsh tokens ./AGENTS.md                # estimate input tokens (~4 chars = 1, CJK = 1 each)
echo ... | rdsh prune --max-tokens 4000  # keep head+tail within a token budget
rdsh search TODO --dir . --max 100    # recursive grep (parallel, same order as sequential)
rdsh compact ./s.jsonl --max-tokens 8000  # compact a session transcript (source untouched)
rdsh sessions --limit 20 --tokens     # list sessions with token estimates
rdsh logs --tail 50 --grep ERROR      # inspect startup logs
rdsh profiles / rdsh skills           # list profiles and skills
rdsh doctor                           # check original dsh, DSH_HOME, slim setup
rdsh bench --n 5                      # compare rdsh vs dsh startup
```

### Credential sharing with rdsh auth

External credentials are inventoried without showing their values. Nothing is
copied until you select a source and credential. OAuth copies use DSH's existing
version-1 store at $DSH_HOME/.credentials.yaml; API keys use its named refs.
The selection policy contains only identifiers at $DSH_HOME/rdsh-auth-sharing.json.

```sh
rdsh auth                                      # sources, destinations, selection and undo steps
rdsh auth --json                               # secret-free machine-readable inventory
rdsh --dry-run auth --select codex:openai-codex --import  # preview; writes no files
rdsh auth --select codex:openai-codex --import    # share only Codex OAuth
rdsh auth --select opencode:openai-codex --import # OpenCode openai maps to openai-codex
rdsh auth --select codex:OPENAI_API_KEY --import  # separate opt-in for Codex's API key
rdsh auth --select env:DEEPSEEK_API_KEY --import  # explicitly persist this environment key
rdsh auth --unselect codex:openai-codex          # stop future copies; retain the existing copy
rdsh setup                                    # sync selected credentials, then guide setup
rdsh setup --web                              # inventory, selection commands and explicit key save
```

For a one-time import, use `rdsh auth --import --provider openai-codex --source codex` or `rdsh auth --import --ref OPENAI_API_KEY --source codex`. These filters do not save or extend future-copy consent; `--select`/`--unselect` are separate persistent policy changes.

Repeat --select/--unselect for individual credentials. Selecting enables future
imports from that CLI/provider, including boot, dump-config, plugin, raw dsh
delegation and setup. --import immediately applies the selection. Even a newer
grant in another, unselected CLI cannot be chosen. Newer DSH grants and existing
API-key refs/records remain in place. Other entries, comments and line endings
are preserved. Unix credential and policy files use mode 0600.

The inventory checks Codex's ~/.codex/auth.json and OpenCode's
$XDG_DATA_HOME/opencode/auth.json (or its platform default data directory), plus
the legacy ~/.config/opencode/auth.json fallback. Selectors for OpenCode use
DSH provider IDs; opencode:openai-codex is the selector for its openai login.
Environment-key persistence supports DEEPSEEK_API_KEY, OPENAI_API_KEY and
ANTHROPIC_API_KEY. These are format/presence checks, not live authentication tests.

An environment variable already supplied to rdsh is inherited by DSH and its
child processes without rdsh writing a file. The JSON inventory marks this route
persistent=false, lists its destination and explains how to stop/revoke it.
Using the reference does not opt in to storing it. setup --yes no longer saves
every environment key; choose each one with auth --select env:NAME --import.
Interactive setup and the web form still allow an explicit, individual key save.

**Scope and undo:** saved entries are available to every DSH profile using the
same DSH_HOME. Unselect stops future rdsh imports; it does not delete a saved copy
or invalidate a running process. Stop DSH and remove the named record/ref from
the credential store to stop using a saved copy. To invalidate the credential
itself, revoke the OAuth grant or rotate the API key at its provider. That may
also disconnect the source CLI. This controls rdsh copying, not DSH's own
refreshes, inherited environment access or an OS sandbox.

**Migration:** existing DSH credentials are retained. A missing policy selects
nothing, including for legacy auth --import. RDSH_AUTH_AUTOSYNC=1 does not restore
the old import-all behavior. Inventory and preview first, then choose the sources
you need. RDSH_AUTH_AUTOSYNC=0 disables automatic imports while keeping the
selection; an explicit auth --import still works. Invalid/unreadable policies
fail closed instead of falling back to legacy sync.

Consent changes and rdsh credential writes share a lock, so a completed unselect
cannot be bypassed by a queued rdsh import using an earlier policy. After a
crashed writer, check that no rdsh auth/setup writer is active before removing
$DSH_HOME/.rdsh-auth-sharing.lock; the launcher skips copying while it is locked.

setup --web issues a new local access key at startup in its #key=... URL.
The tab retains that key; status reads, key saves and closing require it.
Keep the startup URL private. The page shows copy destinations and separate
unselect, saved-copy removal and provider revocation steps before a key save.

### Optional extras (off by default)

Server-type features stay off until enabled, so a plain install remains
a fast dsh:

```sh
rdsh settings set extras.enable serve,search-web
rdsh settings get extras.enable
```

| Extra | Command | Notes |
| --- | --- | --- |
| `serve` | `rdsh serve` (default :38080) | Local status page, localhost only, per-launch key. |
| `search-web` | `rdsh search-web "query" --limit 5` | Needs SearXNG. |

### Mandatory agent tool isolation

On Linux x86_64 with bubblewrap, prlimit, and an audited DSH, model tools are
limited to `rdsh_inspect`. Only copies of files you explicitly share are
mounted read-only; network and writes to host/project are denied at the kernel
level, with no host credentials or environment passed through.

```sh
rdsh --share-file README.md --share-file src/main.rs --profile tui
```

Shared contents can reach the model, so never share secrets. Hidden files,
symlinks, and multiply linked files are refused. Unsupported platforms or DSH
versions fail closed instead of running unprotected. Plugins and profiles you
configured remain trusted code.

### Hook guard (`rdsh guard`)

`guard` scans stdin (hook JSON or raw text) for `--deny` patterns:
exit 2 blocks with a reason, exit 0 passes. `--json` prints
`{"decision":"block"}` or `{}`. A miss is not an approval; the host
must still enforce permissions. `*` matches any string. At about 1 ms
startup, per-tool-call cost is effectively zero.

```sh
echo "$input" | rdsh guard --deny "rm -rf /*" --deny "*token*"
```

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Bash", "hooks": [{ "type": "command", "command": "rdsh guard --deny \"rm -rf /*\"" }] }
    ]
  }
}
```

Context generation never pulls session history automatically; use the explicit
`rdsh context search`. On Unix, context and recursive search open files
relative to a directory handle and refuse symlink swaps, hard links, and
special files. On Windows, native search is refused until a safe implementation
lands. This follows the dsh hook protocol: exit 2 blocks with a message the
model sees, other failures only log.

## Replacement mode (run as `dsh`)

When invoked as `dsh`, anything that is not an rdsh-native subcommand
(`tokens`, `guard`, `serve`, `sessions`, and so on) is delegated
verbatim to the original binary, so `dsh --version`, `dsh --profile tui`,
and `dsh --help` stay byte-identical.

- One-shot escapes: `RDSH_PASSTHROUGH=1 dsh ...` (no slim env), `RDSH_DRY_RUN=1 dsh ...` (print only).
- Default profile: `RDSH_DEFAULT_PROFILE`, then local `tui`, else a guided error.
- A profile literally named `tokens` still boots via `dsh --profile tokens`.
- Scripts that run `node "$(... dsh ...)"` break while shadowed; run `dsh`/`rdsh` directly. `rdsh doctor` lists affected wrappers.

## Using with Smart-DSH

[Smart-DSH](https://github.com/hikarioyama/Smart-DSH) is a DSH web-profile
plugin bundle (mobile UI, Web Push notifications, Esc-to-stop), not a competing
binary. It coexists with rdsh:

```sh
rdsh doctor                                    # also shows dsh version + Smart-DSH bundles
rdsh --profile web --dump-config | grep notify-push   # verify composition (read-only)
rdsh plugin --profile web add /path/to/dsh-notify-push  # same as dsh plugin ...
rdsh --profile web                             # boot web with slim env (plugins unaffected)
```

Ports never collide (dsh web GUI :3080, `rdsh serve` :38080). With
`install.sh --as-dsh`, point Smart-DSH helper scripts at `dsh-orig` or
export `DSH_PACKAGE_DIR`.

## Web dashboard

For the read-only workflow member board in DSH's conversation GUI, use the [verified source-patch preparation tool](plugins/workflow-board/README.md) with an isolated compatible source checkout. It includes the 18-file board/UI projection patch, compatibility diagnostics and fixture tests; building and adopting the patched DSH are separate steps.

```sh
rdsh settings set extras.enable serve  # replaces the enabled-extra list
rdsh serve
# open the URL containing #key=... printed by rdsh (localhost only)
```

| API | Purpose |
| --- | --- |
| `GET /api/version` | version (requires key) |
| `GET /api/doctor` | health check |
| `POST /api/tokens` | token estimate for `{"text"}` |
| `POST /api/prune` | prune `{"text","max_tokens"}` to budget |
| `GET /api/bench?n=3` | startup measurement |
| `GET /api/sessions?limit=20` | recent sessions |
| `GET /api/skills`, `/api/profiles` | name lists |

All APIs require the per-launch key in the `X-RDSH-Token` header (the
browser UI reads it from its URL). No CDN is used; the page works offline.

`rdsh serve` is the quick local status page. For project metrics, human
Q&A, and phone access, use the optional [Node.js dashboard](dashboard/README.md)
(needs Node.js 22+): `rdsh-dashboard project --project <directory>` or
`rdsh-dashboard harness` for the original Harness Web UI. On native Windows
the launcher can live in the tray (right-click Open / Exit,
double-click opens; `--no-tray` stays in the terminal).

The original Harness update banner appears right after an update is recorded,
every two hours from its update time, and on every full page reload.
Dismiss / X or a successful updater check closes the current occurrence; the
two-hour schedule continues. Unchanged release checks do not record a new update. Switching projects keeps it closed until the next slot, and close
events reach other GUI ports of the same OS user. Activating new code needs one
normal GUI restart/reload; see [browser verification](docs/evidence/update-notice-repeat/README.md).

## Benchmarks

Measured on Linux x86_64, including before/after comparisons:

| Case | rdsh | Baseline | Factor |
| --- | --- | --- | --- |
| `--version` startup (median, n=5) | ~0.90 ms | original `dsh` ~88 ms | ~98x |
| `--version` peak RSS | ~2.9 MB | original ~66 MB | ~1/23 |
| Hook-equivalent peak RSS | ~2.7 MB | equivalent Node script ~45 MB | ~1/16 |
| search (300 files, ~600k lines) | ~17 ms | before ~41 ms | ~2.4x |
| tokens (9.6 MB text) | ~12 ms | before ~35 ms | ~2.9x |
| sessions --tokens (20 sessions) | ~0.41 s | before ~1.65 s | ~4.0x |
| Distribution size | one ~806 KB binary | ~508 MB Node tree | — |

Reproduce with `rdsh bench --n 5` and `/usr/bin/time -v`.
Details: [docs/BENCHMARKS.md](docs/BENCHMARKS.md). On a dense synthetic search
fixture the median went from 197.77 ms to 4.61 ms (Linux, fixture-specific);
see [measurement evidence](docs/evidence/performance-security-audit.md).
Source changes after v0.2.0 are not in that published release; check the
release notes before installing binaries.

## Safety design

1. The agent loop and profile boot are never reimplemented — delegation only.
2. Slim mode only adds environment variables; unknown keys are ignored upstream.
3. Launcher error cases from the original (`desktop` profile, mutually exclusive dumps, missing `--profile`) are reproduced in Rust.
4. Read paths never write: tokens/search/compact/dump/native APIs touch nothing.
5. `--passthrough` disables environment tuning. Restoring the original DSH with `./install.sh --restore` also removes rustdsh protection.

Verify the current checkout with `cargo test`, `tests/regress.sh`, and the
[required checks](CONTRIBUTING.md). Reproducible synthetic performance tests and
before/after output checks are in [BENCHMARKS.md](docs/BENCHMARKS.md).

## Documentation

| Doc | What it covers |
| --- | --- |
| [docs/USER-FLOW.md](docs/USER-FLOW.md) | Install to setup to use to recover. |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Delegation, settings ownership, crate layout. |
| [docs/BENCHMARKS.md](docs/BENCHMARKS.md) | Reproducible measurements. |
| [docs/RDSH-SETTINGS.md](docs/RDSH-SETTINGS.md) | Settings UI and CLI keys. |
| [docs/ROADMAP.md](docs/ROADMAP.md) | Direction and backlog. |
| [docs/RELEASING.md](docs/RELEASING.md) | Release process. |
| [CHANGELOG.md](CHANGELOG.md) | Notable changes per release. |

## Community

- Start with [CONTRIBUTING.md](CONTRIBUTING.md) (4-line PRs, screenshot rules).
- Bugs and ideas: [issue forms](https://github.com/jimoto-no-llm/rustdsh/issues/new/choose) (Japanese OK).
- Questions: [Issues](https://github.com/jimoto-no-llm/rustdsh/issues).
- Security: never file public issues — see [SECURITY.md](SECURITY.md).
- Support: [SUPPORT.md](SUPPORT.md). Be kind: [Code of Conduct](CODE_OF_CONDUCT.md).

## Contributing

```sh
cargo fmt --check      # must be clean
cargo clippy --all-targets -- -D warnings   # must be clean
cargo test             # unit and isolated CLI integration tests
BIN=./target/debug/rdsh sh tests/regress.sh # CLI checks (needs cargo build first)
```

No new dependencies without discussion: binary size and startup time are
features. Behavior changes must extend `tests/regress.sh`.

Release: `git tag vX.Y.Z && git push origin vX.Y.Z` builds per-OS binaries
(Linux/macOS/Windows) and attaches them to the GitHub Release via the `cd`
workflow.

## FAQ

- Port is busy? The dsh web GUI uses 3080; `rdsh serve` defaults to 38080. Use `--port 0` for a free port.
- A profile collides with a subcommand name? Boot it explicitly: `dsh --profile <name>`.
- Revert the replacement? `./install.sh --restore` brings the original back.
- What does `~123tok?` mean? Without the `zstd` CLI the estimate falls back to compressed-bytes/4; the `?` marks that.

## Credits

DeepSeek Harness provides the upstream runtime; without it, rustdsh would not exist.
Thanks to the upstream developers and everyone contributing code, reviews, tests, and ideas.

- Icon by [PENTACoXIAN](https://x.com/PENTACoXIAN)

- [GrEarl](https://github.com/GrEarl) and [PENTACoXIAN](https://x.com/PENTACoXIAN): security reports and review.
- [StudioYebisu](https://github.com/yebisu0529-ship-it), [RNA4219](https://github.com/RNA4219), and [eightman999](https://github.com/eightman999): contributions and improvement reports.
- [@remydre8](https://x.com/remydre8): ideas and product suggestions.

## License

MIT — see [LICENSE](LICENSE). Upstream DeepSeek Harness and its dependencies retain their own license terms.
