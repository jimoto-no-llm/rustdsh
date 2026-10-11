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

`rdsh` is a fast, safe launcher for [DeepSeek Harness (`dsh`)](https://github.com/deepseek-ai/deepseek-harness).
It ports frequently used CLI operations (token calculation, code search, session management) to native Rust, while delegating conversation workflows and model execution transparently to upstream `dsh`. All existing arguments and options continue to work as-is.

## Why rdsh?

- ⚡ **Sub-millisecond startup & low memory**: `--version` launches in ~0.90 ms with ~2.9 MB peak memory, compared to ~88 ms and ~66 MB for Node.js-based `dsh`.
- 🔄 **100% Drop-in Compatible**: Subcommands that are not rdsh-native are passed straight to upstream `dsh`. Existing scripts and workflows keep running unchanged.
- 🛠 **Fast Native Utilities**: Estimate tokens, search code, list sessions, and run health diagnostics (`rdsh doctor`) instantly without starting Node.js.
- 🛡 **Safe by Default**: Read-only commands never mutate files, credentials are never automatically synced or exported, and agent tools can be confined to explicitly shared files on Linux.

## Table of Contents

- [Quick Start](#quick-start)
- [Requirements](#requirements)
- [Installation](#installation)
- [Usage](#usage)
  - [Running with `dsh` Compatibility](#running-with-dsh-compatibility)
  - [Fast Native Commands](#fast-native-commands)
  - [Credential Management](#credential-management-rdsh-auth)
  - [Agent Tool Isolation](#agent-tool-isolation)
  - [Hook Guard](#hook-guard-rdsh-guard)
- [Web UI & Dashboard](#web-ui--dashboard)
- [Using with Smart-DSH](#using-with-smart-dsh)
- [Benchmarks](#benchmarks)
- [Safety Design](#safety-design)
- [FAQ](#faq)
- [Documentation](#documentation)
- [Community](#community)
- [Credits](#credits)
- [License](#license)

## Quick Start

### 1. Install (Prebuilt Binary)

**Linux / macOS / WSL**:

```sh
curl -fsSL https://github.com/jimoto-no-llm/rustdsh/releases/latest/download/install.sh | bash -s -- --from-release
```

**Windows (PowerShell)**:

```powershell
$f = Join-Path $env:TEMP 'rdsh-install.ps1'
Invoke-WebRequest -Uri https://github.com/jimoto-no-llm/rustdsh/releases/latest/download/install.ps1 -OutFile $f -UseBasicParsing
& $f -FromRelease
```

### 2. Verify & Setup

```sh
rdsh --version && rdsh doctor   # verify install and original dsh
rdsh setup                      # interactive setup (or rdsh setup --web for browser UI)
```

*Note: If you have an existing login from Codex CLI (ChatGPT OAuth) or opencode, import it with `rdsh auth --import --provider openai-codex`.*

### 3. Start a Conversation

```sh
rdsh tui                        # start with TUI profile
# or
rdsh --profile web              # start with Web profile
```

## Requirements

| Item | Detail |
| --- | --- |
| OS | Linux, macOS, WSL, Windows (native) |
| DSH runtime | Required for conversations and agent runs (native tools and diagnostics run standalone) |
| Rust | 1.85+ (only needed when building from source; prebuilt binaries require no Rust) |
| Optional | Node.js 22+ for the [Node.js dashboard](dashboard/README.md); SearXNG for `search-web` |

## Installation

### Building from Source & Advanced Options

**Linux / macOS / WSL**:

```sh
git clone https://github.com/jimoto-no-llm/rustdsh.git
cd rustdsh
./install.sh                 # build + install to ~/.local/bin/rdsh
./install.sh --as-dsh        # also replace `dsh` command (original backed up as dsh-orig)
./install.sh --restore       # undo the replacement
./install.sh --prefix=DIR    # custom install directory (default: ~/.local/bin)
```

**Windows (PowerShell)**:

```powershell
git clone https://github.com/jimoto-no-llm/rustdsh.git
cd rustdsh
.\install.ps1              # build + install to %LOCALAPPDATA%\rdsh\bin
.\install.ps1 -AsDsh       # also replace `dsh` command
.\install.ps1 -Restore     # undo the replacement
.\install.ps1 -Wsl         # also install inside WSL via install.sh
```

| OS | Script | Notes |
| --- | --- | --- |
| Linux / macOS | `./install.sh` | Needs `cargo` or `curl` (guided via rustup if missing). |
| WSL | `./install.sh` inside distro | Auto-detects WSL. `install.ps1 -Wsl` installs in both environments. |
| Windows (native) | `.\install.ps1` | Needs Rust and MSVC build tools (`winget install Rustlang.Rustup`). |

## Usage

### Running with `dsh` Compatibility

Run any standard `dsh` command unchanged:

```sh
rdsh tui                          # equivalent to: dsh --profile tui
rdsh --profile web --patch x.yml  # launch with configuration overlay
rdsh --dry-run tui -- --resume id # print what would be executed
```

When installed with `./install.sh --as-dsh`, typing `dsh` automatically uses the fast `rdsh` launcher.

### Fast Native Commands

Native tools execute in Rust without starting Node.js:

```sh
rdsh tokens ./README.md             # estimate token count (~4 chars = 1 tok, CJK = 1 tok each)
echo "..." | rdsh prune --max-tokens 4000 # prune context within a token budget
rdsh search TODO --dir . --max 100  # fast parallel text search
rdsh sessions --limit 20 --tokens   # list sessions and unpacked token estimates
rdsh compact ./s.jsonl              # compact session JSONL (source remains untouched)
rdsh doctor                         # check health of dsh, environment, and paths
rdsh profiles / rdsh skills         # list available profiles and skills
rdsh bench --n 5                    # benchmark startup speed between rdsh and dsh
```

### Credential Management (`rdsh auth`)

Safely import credentials from other tools into `$DSH_HOME/.credentials.yaml`:

```sh
rdsh auth                                  # inspect recognized login status
rdsh auth --import --provider openai-codex # import credentials from Codex CLI or opencode
rdsh setup                                 # interactive setup wizard
rdsh setup --web                           # browser-based setup interface
```

*Note: rdsh never exports or syncs external credentials without explicit user command.*

### Agent Tool Isolation

Delegated agent tools keep normal file access by default: the model reads and
writes the project like any other tool. On Linux (with bubblewrap and prlimit)
you can instead confine them to files you explicitly share:

```sh
rdsh --share-file README.md --share-file src/main.rs --profile tui
```

Only the shared files are mounted read-only, host files stay out of reach and
the sandbox has no network. Turn the same boundary on for every run with
`rdsh features on agent_tool_sandbox` (off again with
`rdsh features off agent_tool_sandbox`, or force it with `RDSH_SECURITY=1`).

### Hook Guard (`rdsh guard`)

Integrates with DSH `hooks.json` to inspect and block dangerous commands before execution:

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

Native execution overhead is ~1 ms per invocation.

## Web UI & Dashboard

### Lightweight Local Web UI (`rdsh serve`)

A lightweight status and token estimation page running on localhost (default `:38080`, does not conflict with DSH `:3080`):

```sh
rdsh settings set extras.enable serve  # enable the server feature
rdsh serve                             # launch (bound to localhost, protected with a one-time token)
```

### Extended Dashboard (`rdsh-dashboard`)

Optional Node.js dashboard for project metrics, human-in-the-loop Q&A, and mobile access (requires Node.js 22+):

```sh
rdsh-dashboard project --project <directory>
```

*On native Windows, the dashboard runs in the system tray and can be opened or stopped from the taskbar (`--no-tray` keeps it in the terminal). See [dashboard/README.md](dashboard/README.md).*

## Using with Smart-DSH

[Smart-DSH](https://github.com/hikarioyama/Smart-DSH) (a web-profile plugin bundle) works smoothly alongside rdsh:

```sh
rdsh doctor                                    # check dsh version and Smart-DSH bundles
rdsh plugin --profile web add /path/to/bundle  # add plugins
rdsh --profile web                             # boot web with plugins enabled
```

Ports never collide (DSH Web: `3080`, rdsh serve: `38080`).

## Benchmarks

Measurements conducted on Linux x86_64:

| Benchmark | rdsh | Upstream dsh / Baseline | Improvement |
| --- | --- | --- | --- |
| `--version` startup | **~0.90 ms** | ~88 ms | **~98x faster** |
| `--version` peak RSS | **~2.9 MB** | ~66 MB | **~1/23 memory** |
| Hook-equivalent memory | **~2.7 MB** | ~45 MB (Node equivalent) | **~1/16 memory** |
| Code search (`search`) | **~17 ms** | ~41 ms | **~2.4x faster** |
| Token estimate (`tokens`) | **~12 ms** | ~35 ms | **~2.9x faster** |
| Session list (`sessions --tokens`) | **~0.41 s** | ~1.65 s | **~4.0x faster** |
| Binary size | **~1.97 MB** (single binary) | ~508 MB (Node tree) | **Ultra compact** |

*Reproduce with `rdsh bench --n 5`. See [docs/BENCHMARKS.md](docs/BENCHMARKS.md) for detailed test setups and measurements.*

## Safety Design

1. **Upstream Fidelity**: Never reimplements conversation loops or agent logic; delegates directly to upstream `dsh`.
2. **Non-Destructive**: Read operations (tokens, search, session listing, compacting) never modify source files.
3. **Explicit Auth**: Credentials are never sent externally or synced automatically; only user-approved items are imported.
4. **Tool Sandboxing** (opt-in): On Linux, `--share-file` mounts only the files you share, read-only and without network, so the model never touches the rest of the host.

## FAQ

- **Q. Do I need the original `dsh` installed?**  
  Yes, for conversations and agent execution. Standalone commands like token calculation, file search, and health checks (`rdsh doctor`) work without it.

- **Q. Can I replace my existing `dsh` command?**  
  Yes. Install with `./install.sh --as-dsh` (or `.\install.ps1 -AsDsh` on Windows) to shadow `dsh` transparently. Revert anytime with `--restore`.

- **Q. What if there is a port collision?**  
  Upstream DSH Web uses `:3080` while `rdsh serve` defaults to `:38080`. To pick an arbitrary free port, specify `--port 0`.

- **Q. Will my existing scripts break?**  
  No. Any argument not belonging to an rdsh-specific command is forwarded verbatim to upstream `dsh`.

## Documentation

| Document | Description |
| --- | --- |
| [docs/USER-FLOW.md](docs/USER-FLOW.md) | End-to-end installation, usage, and recovery flow |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Architecture design and delegation model |
| [docs/BENCHMARKS.md](docs/BENCHMARKS.md) | Benchmark methodology and reproduction steps |
| [docs/RDSH-SETTINGS.md](docs/RDSH-SETTINGS.md) | Settings UI and CLI options |
| [docs/ROADMAP.md](docs/ROADMAP.md) | Project roadmap and planned capabilities |
| [docs/RELEASING.md](docs/RELEASING.md) | Release procedures |
| [CHANGELOG.md](CHANGELOG.md) | Changes per version |

## Community

- Contributions: See [CONTRIBUTING.md](CONTRIBUTING.md).
- Issues & Ideas: [Issue tracker](https://github.com/jimoto-no-llm/rustdsh/issues/new/choose) (Japanese or English).
- Security: Please report vulnerabilities privately according to [SECURITY.md](SECURITY.md).
- Support: [SUPPORT.md](SUPPORT.md) / Code of Conduct: [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## Credits

DeepSeek Harness provides the upstream runtime; without it, rustdsh would not exist.
Thanks to the upstream developers and everyone contributing code, reviews, tests, and ideas:

- Icon by [PENTACoXIAN](https://x.com/PENTACoXIAN)
- Security reports & review: [GrEarl](https://github.com/GrEarl), [PENTACoXIAN](https://x.com/PENTACoXIAN)
- Contributions & validation: [StudioYebisu](https://github.com/yebisu0529-ship-it), [RNA4219](https://github.com/RNA4219), [eightman999](https://github.com/eightman999)
- Ideas & feedback: [@remydre8](https://x.com/remydre8)

## License

MIT — see [LICENSE](LICENSE). Upstream DeepSeek Harness and its dependencies retain their respective licenses.
