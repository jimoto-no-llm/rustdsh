<img src="assets/icon.svg" width="96" alt="rdsh icon">

# rdsh — a fast, safe Rust launcher for `dsh`

[![ci](https://github.com/sahenjp/rustdsh/actions/workflows/ci.yml/badge.svg)](https://github.com/sahenjp/rustdsh/actions/workflows/ci.yml)
[![dashboard](https://github.com/sahenjp/rustdsh/actions/workflows/dashboard.yml/badge.svg)](https://github.com/sahenjp/rustdsh/actions/workflows/dashboard.yml)
[![docs](https://github.com/sahenjp/rustdsh/actions/workflows/docs.yml/badge.svg)](https://github.com/sahenjp/rustdsh/actions/workflows/docs.yml)
[![release](https://img.shields.io/github/v/release/sahenjp/rustdsh.svg)](https://github.com/sahenjp/rustdsh/releases)
[![license](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![rust](https://img.shields.io/badge/rust-1.73%2B-orange.svg)](https://www.rust-lang.org/)

[日本語版](README.ja.md)

`rdsh` is a drop-in fast path for [dsh](https://github.com/deepseek-ai/deepseek-harness)
(the DeepSeek Harness CLI). Instead of a full rewrite, it **ports only the hot paths
to Rust and delegates everything else to the original `dsh` binary** — so you get
~98x faster startup and ~1/23rd the memory with zero behavior change.

- Startup median **~0.90ms** (original `dsh`: ~88ms)
- Resident memory **~2.9MB** (original: ~66MB), single ~806KB binary, no runtime tree
- Safe by construction: agent loop and profile boot are never reimplemented,
  delegation is a verbatim `exec`, and every optimization is output-identical

## Contents

- [Benchmarks](#benchmarks)
- [Install](#install)
- [Usage](#usage)
- [Replacement mode (run as `dsh`)](#replacement-mode-run-as-dsh)
- [Low-end hosts](#low-end-hosts)
- [Using with Smart-DSH](#using-with-smart-dsh)
- [Web dashboard](#web-dashboard)
- [Safety design](#safety-design)
- [Community](#community)
- [FAQ](#faq)
- [Credits](#credits)
- [License](#license)

## Benchmarks

Measured on Linux x86_64, including before/after comparisons for the optimizations.

| Case | rdsh | Baseline | Factor |
| --- | --- | --- | --- |
| `--version` startup (median, n=5) | ~0.90ms | original `dsh` ~88ms | ~98x |
| `--version` peak RSS | ~2.9MB | original ~66MB | ~1/23 |
| Hook-equivalent peak RSS | ~2.7MB | equivalent Node script ~45MB | ~1/16 |
| search (300 files, ~600k lines) | ~17ms | before ~41ms | ~2.4x |
| tokens (9.6MB text) | ~12ms | before ~35ms | ~2.9x |
| sessions --tokens (20 sessions) | ~0.41s | before ~1.65s | ~4.0x |
| Distribution size | one ~806KB binary | ~508MB Node tree | — |

Reproduce with `rdsh bench --n 5` and `/usr/bin/time -v`.
Details: [docs/BENCHMARKS.md](docs/BENCHMARKS.md).

## Install

Fastest (prebuilt binary, no Rust needed):

```sh
# Linux / macOS / WSL
curl -fsSL https://github.com/sahenjp/rustdsh/releases/latest/download/install.sh | bash -s -- --from-release
```

On Linux/x86_64 the installer picks the glibc build (`rdsh-linux-x64.tar.gz`,
needs glibc >= 2.34), or the fully static `rdsh-linux-x64-musl.tar.gz` when it
detects an older glibc. Force the static build with `--musl` (or `RDSH_MUSL=1`);
on musl-only systems such as Alpine, where glibc cannot be detected, pass
`--musl` yourself. Each download is checked against its `.sha256` file.

```powershell
# Windows (PowerShell)
$f = Join-Path $env:TEMP 'rdsh-install.ps1'
Invoke-WebRequest -Uri https://github.com/sahenjp/rustdsh/releases/latest/download/install.ps1 -OutFile $f -UseBasicParsing
& $f -FromRelease
```

From source:

```sh
git clone https://github.com/sahenjp/rustdsh.git
cd rustdsh
./install.sh                 # build + install to ~/.local/bin/rdsh
./install.sh --as-dsh        # also shadow `dsh` (original kept as dsh-orig)
./install.sh --restore       # undo the shadowing
./install.sh --prefix=DIR    # custom install dir (default ~/.local/bin)
```

install.sh covers Linux, macOS, and WSL (auto-detects WSL, auto-installs
Rust via rustup unless `--no-rustup`). Native Windows uses install.ps1:

```powershell
git clone https://github.com/sahenjp/rustdsh.git
cd rustdsh
.\install.ps1              # build + install to %LOCALAPPDATA%\rdsh\bin (+ user PATH)
.\install.ps1 -AsDsh       # also shadow `dsh` (original kept as dsh-orig)
.\install.ps1 -Restore     # undo the shadowing
.\install.ps1 -Wsl         # also install inside WSL via install.sh
```

| OS | script | notes |
| --- | --- | --- |
| Linux / macOS | `./install.sh` | needs `cargo` or `curl` (rustup auto-install) |
| WSL | `./install.sh` inside the distro | detected automatically; alongside native via `install.ps1 -Wsl` |
| Windows (native) | `.\install.ps1` | needs Rust (`winget install Rustlang.Rustup`); MSVC build tools required to compile |

First boot with no model connected prints a pointer instead of leaving
you at the DeepSeek prompt: run `rdsh setup` (or `rdsh setup --login` to
start the Codex/opencode OAuth flow right away).

Or build directly: `cargo build --release` produces `target/release/rdsh`.
Requires Rust 1.73+.

## Usage

### dsh-compatible delegation

```sh
rdsh web                          # same as: dsh --profile web (with slim env)
rdsh --profile web --patch x.yml  # boot with an extra overlay
rdsh --passthrough web           # byte-identical delegation, no slim env
rdsh --dry-run web -- --resume abc  # print what would be executed
```

Any profile name is passed to dsh verbatim. dsh >= 0.2.0 no longer ships a
`tui` profile (it creates `web`, `headless`, `acp`, `sdk` and `sdk-minimal`),
so `rdsh tui` only works if you have a local `$DSH_HOME/profiles/tui`.

Without a profile, `rdsh boot` and `rdsh dump-config` use
`RDSH_DEFAULT_PROFILE`, then `general.default_profile` from the rdsh settings
(`rdsh settings set general.default_profile web`), then a local `tui` profile
if there is one. If none applies, rdsh exits with an error that tells you to
pass `--profile <name>` or set `RDSH_DEFAULT_PROFILE`.

### Native fast commands (no Node startup)

```sh
rdsh tokens ./AGENTS.md               # estimate input tokens (~4 chars = 1, CJK = 1 each)
echo ... | rdsh prune --max-tokens 4000  # keep head+tail within a token budget
rdsh search TODO --dir . --max 100   # recursive grep (parallel, same order as sequential)
rdsh search-web "rust async" --limit 5  # web search via SearXNG (default http://127.0.0.1:8888, $SEARXNG_URL wins)
rdsh compact ./s.jsonl --max-tokens 8000 # compact a session transcript (source untouched)
rdsh sessions --limit 20 --tokens    # list sessions with token estimates (read from zstd headers, no decompression)
rdsh logs --tail 50 --grep ERROR     # inspect startup logs
rdsh profiles / rdsh skills          # list profiles and skills
rdsh doctor                          # check original dsh, DSH_HOME, slim setup
rdsh bench --n 5                     # compare rdsh vs dsh startup
rdsh serve                           # local web dashboard (:38080)
```

### `rdsh auth`: OAuth auto-recognition (drop it in and it works)

Logins you already did elsewhere are mirrored into
`$DSH_HOME/.credentials.yaml`, the credential store dsh itself reads:

- Codex CLI (`~/.codex/auth.json`, ChatGPT OAuth)
- opencode (`$XDG_DATA_HOME/opencode/auth.json`, e.g. `openai` OAuth
  becomes the `openai-codex` route)

```sh
rdsh auth            # status: what was found, what dsh already recognizes
rdsh auth --import   # write missing/older grants (0600, other entries untouched)
rdsh auth --json     # machine-readable status
rdsh setup           # first-run wizard: import, DeepSeek-key paste, --login/--open
rdsh setup --web     # floating glass setup UI on localhost (browser auto-opens)
```

`setup --web` issues a fresh key on every launch and prints a URL
containing `#key=...`. Open it in your browser; the key stays in that tab
and is required to save keys or finish setup. Do not share the URL.

### Optional extras (off by default)

Server-type features stay off until you enable them, so a plain install
remains a fast dsh. Enable them from the setup UI (`rdsh setup --web`,
Extras section) or the CLI:

```sh
rdsh settings set extras.enable serve,search-web
rdsh settings get extras.enable
```

| Extra | Command |
| --- | --- |
| `serve` | `rdsh serve` local dashboard |
| `search-web` | `rdsh search-web` web search |

Booting (`rdsh web`, `dump-config`, `plugin`) auto-syncs first, so logging
in with Codex/opencode is enough. `RDSH_AUTH_AUTOSYNC=0` disables it.
A dsh-side token that is newer is never overwritten, and non-grant
records (API keys) are left alone.

### `rdsh guard`: a fast hook command for hooks.json

`guard` scans stdin (hook JSON or raw text) for deny patterns and blocks on
match: exit code 2 with the reason on stderr, exit 0 otherwise. With `--json`
it prints `{"decision":"block"}` / `{"decision":"approve"}` instead. `*` in a
pattern matches any string. At ~1ms startup and ~3MB RSS, per-tool-call hook
cost is effectively zero.

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

This follows the dsh hook protocol: exit 2 blocks with a message the model sees,
any other failure is non-blocking and only logged.

## Replacement mode (run as `dsh`)

When the binary is invoked under the name `dsh`, anything that is not an
rdsh-native subcommand is delegated verbatim to the original binary, so
`dsh --version`, `dsh --profile tui`, and `dsh --help` stay byte-identical.
Full discovery order and naming rules: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

- One-shot escapes: `RDSH_PASSTHROUGH=1 dsh ...` (no slim env),
  `RDSH_DRY_RUN=1 dsh ...` (print only)
- Default profile: `RDSH_DEFAULT_PROFILE`, then local `tui`, else a guided error
- Name shadowing: a bare `dsh tokens` runs the rdsh subcommand; a profile
  literally named `tokens` still boots via `dsh --profile tokens`
- Scripts that run `node "$(... dsh ...)"` break while `dsh` is
  shadowed. Run `dsh`/`rdsh` directly instead of via `node`;
  `rdsh doctor` lists the affected wrappers.

## Low-end hosts

rdsh is meant to stay useful on weak machines (2-core Celeron/Pentium class,
no AVX, older distros, no Node at all).

- **Faster Node boot.** When rdsh boots dsh it sets `NODE_COMPILE_CACHE` to
  `~/.cache/rdsh-node-compile-cache`, so Node reuses compiled code between
  launches (Node >= 22.1; older Node ignores it). A `NODE_COMPILE_CACHE` you
  already export is left untouched. `RDSH_NODE_COMPILE_CACHE=0`, `--passthrough`
  and `RDSH_PASSTHROUGH=1` turn it off. The other slim variables (`RDSH_*`)
  are hints that upstream dsh itself does not read.
- **Prebuilt binaries** are plain x86-64 (no AVX/BMI), so they run on
  Celeron/Pentium parts; the static musl build covers old glibc.
- **`sessions --tokens`** reads each session's decompressed size from the zstd
  frame header (no decompression, no `zstd` CLI needed). Only a frame that
  records no size falls back to the `zstd` CLI; `?` marks sessions where
  neither worked.
- **Threads.** `search` and the `sessions` scan use as many threads as the
  host has cores (at most 8).
- **No Node on the host?** The native commands (`tokens`, `search`,
  `sessions`, ...) keep working. `rdsh doctor` reports the missing original
  dsh and exits with 1; set `DSH_ORIG_BIN` (or `RDSH_ORIG_BIN`) or install
  `@deepseek-ai/dsh` to boot dsh.
- **Gentle auto-update.** `sync-dsh.sh` updates the original dsh (with
  verification and rollback) and rdsh itself. By default rdsh comes from the
  latest GitHub release as a prebuilt binary, so there is no cargo build and
  commits on `main` reach you only once they are tagged; the new binary
  replaces the old one only after it runs and passes `tests/regress.sh` in a
  throwaway `HOME`. To follow `main` with a source build instead, set
  `RDSH_SYNC_FROM_SOURCE=1` (it runs under `nice -n 19`, and `ionice -c3` when
  available). `systemd/rdsh-sync.service` runs it at idle priority; point its
  `ExecStart` at your checkout.

## Using with Smart-DSH

[Smart-DSH](https://github.com/hikarioyama/Smart-DSH) is a DSH web-profile
plugin bundle (mobile UI, Web Push notifications, Esc-to-stop), not a competing
binary — it coexists with rdsh. rdsh passes its setup commands through:

```sh
rdsh doctor                                    # also shows dsh version + Smart-DSH bundles
rdsh --profile web --dump-config | grep notify-push   # verify composition (read-only)
rdsh plugin --profile web add /path/to/dsh-notify-push  # same as dsh plugin ...
rdsh --profile web                             # boot web with slim env (plugins unaffected)
```

Co-use notes:

- Ports never collide: dsh web GUI uses 3080, `rdsh serve` defaults to 38080
  (`--port 0` picks a free port).
- With `install.sh --as-dsh`, point Smart-DSH helper scripts at the original
  (`dsh-orig ...`) or export `DSH_PACKAGE_DIR`.
- `rdsh doctor` shows your dsh version so mismatches are visible first.

## Web dashboard

```sh
rdsh serve
# open the URL containing #key=... printed by rdsh (localhost only)
# default :38080 keeps clear of the dsh web GUI (:3080); --port 0 auto-picks
```

| API | Purpose |
| --- | --- |
| `GET /api/version` | version |
| `GET /api/doctor` | health check |
| `POST /api/tokens` | token estimate for `{"text"}` |
| `POST /api/prune` | prune `{"text","max_tokens"}` to budget |
| `GET /api/bench?n=3` | startup measurement |
| `GET /api/sessions?limit=20` | recent sessions |
| `GET /api/skills`, `/api/profiles` | name lists |

APIs other than `/api/version` require the per-launch key in the
`X-RDSH-Token` header (the browser UI uses the key from its URL).
No CDN is used; the page works offline.

Which one? `rdsh serve` is the quick local status page (no setup beyond
the binary). For project metrics, human Q&A, and phone access, use the
optional [Node.js dashboard](dashboard/README.md) (needs Node.js 22+).

The Node.js dashboard adds project metrics, tasks, human Q&A, and Tailscale
QR access: `rdsh-dashboard project --project <directory>` for a project,
`rdsh-dashboard harness` for the original Harness Web UI.

## Safety design

1. The agent loop and profile boot are never reimplemented — delegation only.
2. Slim mode only *adds* environment variables (`RDSH_*` hints plus
   `NODE_COMPILE_CACHE`); unknown keys are ignored upstream and your own
   `NODE_COMPILE_CACHE` is never overridden.
3. Launcher error cases from the original (`desktop` profile, mutually exclusive
dumps, missing `--profile`) are reproduced in Rust.
4. Read paths never write: tokens/search/compact/dump/native APIs touch nothing.
5. Instant retreats: `--passthrough`, `RDSH_PASSTHROUGH=1`, `./install.sh --restore`.

Verified with `cargo test` (26 unit tests) and `tests/regress.sh`
(35 CLI checks), plus byte-for-byte output equality on optimizations.

## Community

- Start with [CONTRIBUTING.md](CONTRIBUTING.md) (4-line PRs, screenshot rules).
- Bugs and ideas: [issue forms](https://github.com/sahenjp/rustdsh/issues/new/choose) (Japanese OK).
- Questions: [Issues](https://github.com/sahenjp/rustdsh/issues).
- Security: never file public issues — see [SECURITY.md](SECURITY.md).
- Design docs: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) ·
  [docs/BENCHMARKS.md](docs/BENCHMARKS.md) · [docs/ROADMAP.md](docs/ROADMAP.md) ·
  [docs/RELEASING.md](docs/RELEASING.md) · [CHANGELOG.md](CHANGELOG.md).
- Be kind: [Code of Conduct](CODE_OF_CONDUCT.md).

## FAQ

- **Port is busy?** The dsh web GUI uses 3080; `rdsh serve` defaults to 38080. Use `--port 0` for a free port.
- **`rdsh tui`, or a bare `rdsh boot`, fails?** dsh 0.2.0 no longer ships
  `tui`. Use `rdsh web` / `rdsh --profile headless`, or set
  `RDSH_DEFAULT_PROFILE=web` for the profile-less `rdsh boot`.
- **A profile collides with a subcommand name?** Boot it explicitly:
  `dsh --profile <name>`.
- **Revert the replacement?** `./install.sh --restore` brings the original back.
- **What does `~123tok?` mean?** The decompressed size could not be read from
  the zstd frame header or via the `zstd` CLI, so the number is a rough
  stored-bytes/4 estimate.
- **No NODE_COMPILE_CACHE wanted?** `RDSH_NODE_COMPILE_CACHE=0` (or `--passthrough`).
  An exported `NODE_COMPILE_CACHE` of your own is always respected.

## Credits

Ideas: [@studio_yebisu](https://x.com/studio_yebisu), [@remydre8](https://x.com/remydre8).

## License

MIT — see [LICENSE](LICENSE).
