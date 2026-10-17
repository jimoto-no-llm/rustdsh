<img src="assets/icon.png" width="96" alt="rdsh icon">

# rdsh — a fast, safe Rust launcher for `dsh`

[![ci](https://github.com/jimoto-no-llm/rustdsh/actions/workflows/ci.yml/badge.svg)](https://github.com/jimoto-no-llm/rustdsh/actions/workflows/ci.yml)
[![dashboard](https://github.com/jimoto-no-llm/rustdsh/actions/workflows/dashboard.yml/badge.svg)](https://github.com/jimoto-no-llm/rustdsh/actions/workflows/dashboard.yml)
[![docs](https://github.com/jimoto-no-llm/rustdsh/actions/workflows/docs.yml/badge.svg)](https://github.com/jimoto-no-llm/rustdsh/actions/workflows/docs.yml)
[![codecov](https://codecov.io/gh/jimoto-no-llm/rustdsh/graph/badge.svg)](https://codecov.io/gh/jimoto-no-llm/rustdsh)
[![release](https://img.shields.io/github/v/release/jimoto-no-llm/rustdsh.svg)](https://github.com/jimoto-no-llm/rustdsh/releases)
[![crates.io](https://img.shields.io/crates/v/rdsh.svg)](https://crates.io/crates/rdsh)
[![license](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![rust](https://img.shields.io/badge/rust-1.85%2B-orange.svg)](https://www.rust-lang.org/)

[日本語](README.ja.md) · [简体中文](README.zh-CN.md)

An independent community project; not an official DeepSeek or DeepSeek Harness project.

`rdsh` is a fast, safe launcher for [DeepSeek Harness (`dsh`)](https://github.com/deepseek-ai/deepseek-harness).
It ports frequently used CLI operations (token calculation, code search, session management) to native Rust, while delegating conversation workflows and model execution transparently to upstream `dsh`. All existing arguments and options continue to work as-is.

## Why rdsh?

- ⚡ **Sub-millisecond process launch**: `rdsh --version` starts in ~0.90 ms with ~2.9 MB peak RSS, versus ~88 ms and ~66 MB for Node.js-based `dsh --version`. This is process launch only: a booted agent profile still runs upstream Node.js, so conversation startup and session memory match upstream. See [Benchmarks](#benchmarks).
- 🔄 **100% Drop-in Compatible**: Subcommands that are not rdsh-native are passed straight to upstream `dsh`. Existing scripts and workflows keep running unchanged.
- 🛠 **Fast Native Utilities**: Estimate tokens, search code, list sessions, and run health diagnostics (`rdsh doctor`) instantly without starting Node.js.
- 🛡 **Safe by Default**: Read-only commands never modify source files, credentials are never automatically synced or exported, and `rdsh_inspect` can be confined to explicitly shared files on Linux.
- 🛠 **Fast Native Utilities**: Estimate tokens, search code, list sessions, and inspect local prerequisites (`rdsh doctor --json`) without starting Node.js.
- 🛡 **Safe by Default**: Read-only commands never modify source files, credentials are never automatically synced or exported, and agent tools can be confined to explicitly shared files on Linux.

## Table of Contents

- [Quick Start](#quick-start)
- [Requirements](#requirements)
- [Installation](#installation)
- [Usage](#usage)
  - [Running with `dsh` Compatibility](#running-with-dsh-compatibility)
  - [Fast Native Commands](#fast-native-commands)
  - [Credential sharing with rdsh auth](#credential-sharing-with-rdsh-auth)
  - [Agent Tool Isolation](#agent-tool-isolation)
  - [Hook Guard](#hook-guard-rdsh-guard)
  - [Context Injection](#context-injection-rdsh-context)
  - [Dependency Graph and Change Impact](#dependency-graph-and-change-impact-rdsh-deps)
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

Already using **Claude Code, Codex, Cursor, VS Code Copilot, OpenCode or Gemini CLI**?
[Connect the project dashboard through MCP](docs/MCP-CLIENTS.md)
to share tasks, questions and structured UI while keeping your current coding agent.
This entry point requires Node.js 22+; DSH and Rust are optional.

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

Or install the crate from crates.io (needs Rust 1.85+):

```sh
cargo install rdsh
```

`cargo install` builds from source and installs the same binary as the release
archives. Debian/Ubuntu and Fedora/RHEL users can also install the release
[`.deb`/`.rpm`](#native-packages-deb--rpm) with `apt`/`dnf`.

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

### Native Packages (`.deb` / `.rpm`)

Linux x86_64 users on Debian/Ubuntu (and WSL) or Fedora/RHEL can install the
same release binary with the OS package manager. Download the `.deb` or `.rpm`
from the
[latest release](https://github.com/jimoto-no-llm/rustdsh/releases/latest) and
install that file directly; no extra repository is configured.

```sh
sudo apt install ./rdsh_<version>_amd64.deb      # Debian, Ubuntu, WSL
sudo dnf install ./rdsh-<version>-1.x86_64.rpm   # Fedora, RHEL, Rocky, AlmaLinux
```

`<version>` is the release tag without its leading `v` (`0.6.0` for `v0.6.0`).
The package installs `/usr/bin/rdsh` together with the licence and README, so
`rdsh --version` works right after installation: no Rust toolchain, no
`install.sh`. Like `rdsh-linux-x64.tar.gz`, both packages carry the glibc
build, so the musl archive and `install.sh` stay the fallback for older
distributions.

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

### Package Managers (Homebrew / Scoop / winget)

Advanced users on macOS and Windows can let a package manager own the installed
`rdsh` binary. The manifests in [packaging/](packaging/README.md) pin the exact
release archives and their SHA-256 values;
[docs/PACKAGE-MANAGERS.md](docs/PACKAGE-MANAGERS.md) lists the install commands
and the update procedure.

**macOS (Homebrew)** — installs the Apple Silicon or Intel archive:

```sh
brew install --formula ./packaging/homebrew/rdsh.rb
```

**Windows (Scoop)**:

```powershell
scoop install https://raw.githubusercontent.com/jimoto-no-llm/rustdsh/main/packaging/scoop/rdsh.json
```

**Windows (winget)** — winget 1.6 or newer reads the three manifests directly;
submitting them to `microsoft/winget-pkgs` stays a manual step:

```powershell
winget install --manifest .\packaging\winget
```

These channels track one release at a time, so a new tag is not served until
`python3 scripts/update-packaging-manifests.py --version vX.Y.Z` refreshes them.

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
rdsh doctor --json                  # read-only metadata for scripts; no DSH/Node launch
rdsh profiles / rdsh skills         # list available profiles and skills
rdsh desktop status                 # detect the DeepSeek Harness Desktop app and profile
rdsh bench --n 5                    # benchmark startup speed between rdsh and dsh
```

On Windows, compressed session histories are not opened until rdsh can reject
parent junctions safely; `sessions --tokens` may omit those histories and its
totals are inexact.

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

To connect an OpenAI-compatible endpoint that dsh does not ship (HAI, Sarashina, a home llama.cpp / vLLM / LM Studio / Ollama server), add it as a profile route:

```sh
rdsh provider add hai --model deepseek-v4-flash              # key from HAI_API_KEY or --key-stdin
rdsh provider add sarashina                                  # key from SARASHINA_API_KEY; mini and nano built in
rdsh provider add local-openai --base-url http://host:8080/v1 --discover --no-key
rdsh provider list                                           # presets, per-profile route and key status
```

Details: [docs/PROVIDERS.md](docs/PROVIDERS.md).

### Model Catalog (`rdsh models`)

DeepSeek Harness answers "which models can this provider serve?" from the
catalog bundled in its `@earendil-works/pi-ai` dependency, which is generated
when that package is published. Anything a provider changes afterwards is
absent from the picker until that dependency is upgraded — and a profile that
lists `models:` explicitly replaces the bundled catalog for the route anyway.
`rdsh models` reads the provider's own catalog (the local Codex CLI, or Kimi
Code's `/v1/models` endpoint with the profile's API key) and folds it into the
profile:

```sh
rdsh models                              # read-only: missing ids and stale names
rdsh models --provider kimi-coding       # one provider only
rdsh models sync                         # add missing entries, refresh stale names
rdsh models sync --profile web --dry-run # preview one profile
```

Nothing is deleted, an existing entry keeps every other byte (a name the
provider's current one already contains is left as written), and a profile the
command does not recognize is refused instead of rewritten. The harness picks
the changes up on the next config reload or restart.

### Agent Tool Isolation

Delegated agent tools keep normal file access by default: the model reads and
writes the project like any other tool. `--share-file` isolates **`rdsh_inspect`
only**. On Linux (with bubblewrap and prlimit) that tool sees just the files you
explicitly share:

```sh
rdsh --share-file README.md --share-file src/main.rs --profile tui
```

From `rdsh_inspect`, only the shared files are mounted read-only, host files stay
out of reach and the sandbox has no network. Turn the same boundary on for every
run with `rdsh features on agent_tool_sandbox` (off again with
`rdsh features off agent_tool_sandbox`, or force it with `RDSH_SECURITY=1`).

Other DSH tools (`bash`, `read`, `write`, `run_code`, ...) are **not** isolated and
follow upstream DSH permissions and approvals. Startup prints
`[rdsh security] rdsh_inspect is isolated; other DSH tools use upstream permissions`.

### Hook Guard (`rdsh guard`)

Integrates with DSH `hooks.json` to inspect and block dangerous commands before execution:

```sh
echo "$input" | rdsh guard --deny "rm -rf /*" --deny "*token*"
```

For an opt-in structured check of supported file tools, pass a policy file.
This example permits `Read` only under one existing project directory:

```json
{
  "schema": 1,
  "rules": [
    { "id": "project-read", "tool": "Read", "access": "read", "roots": ["/absolute/project/path"] }
  ]
}
```

```sh
echo "$hook_json" | rdsh guard --policy-file ./hook-policy.json --json
```

The structured classifier supports the `Read`, `Write`, and `Edit` file-path
schemas. It canonicalizes the working directory and target, checks the selected
tool and read/write scope against existing policy roots, and reports
`allow`, `deny`, or `unknown` with a non-sensitive reason. In JSON mode an
`allow` is classification only and omits `decision`; the host still owns
permission and approval. Unknown tools, shell commands, malformed input, and
unsupported tool arguments fail closed. Shell parsing and network destinations
are not implemented. Path checks are advisory and can race with later filesystem
changes; this hook is not an OS sandbox. Use the actual execution sandbox for
enforcement.

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Bash", "hooks": [{ "type": "command", "command": "rdsh guard --deny \"rm -rf /*\"" }] }
    ]
  }
}
```

### Context Injection (`rdsh context`)

`rdsh context inject` assembles this turn's context — goal, constraints,
decisions, working set, git state, retrieved code, and curated memory — and
emits it in the DSH `UserPromptSubmit` hook contract, so the model sees it
without any copy-paste:

```sh
rdsh features on context_engine        # the engine is opt-in
rdsh context hook install              # merges $DSH_HOME/hooks.json (idempotent)
rdsh context hook status --json
```

The hook is fail-open: it never blocks a prompt and always exits 0. Only an
unreadable settings document or an unparseable payload inject nothing at all; a
corrupt index or a missed deadline drops just what depends on them — the graph
or the code search — and still injects goal, constraints, and memory. Injection
has its own
budget (`context.inject_budget`, default 1200 tokens) and deadline
(`context.inject_deadline_ms`, default 1200 ms); once the deadline passes the
code search is skipped and only memory, goal, and constraints go out.

Memory holds curated items, not a transcript dump:

```sh
rdsh context remember "Keep the API compatible" --kind constraint
rdsh context distill --session ~/.dsh/sessions/<project>/<session>/session.v4.jsonl.zstd --apply
rdsh context memory --json      # active and superseded entries
rdsh context forget mem_ab12cd34ef56
```

`distill` reads user turns only (zstd session logs included) and extracts
decisions, constraints, and retractions with deterministic markers, superseding
an older overlapping entry instead of guessing. `rdsh context build
--require-stable` exits 3 unless the snapshot is provably stable: a file or git
state that changed during assembly counts, and so does a git state it cannot
read, so a stale or unknown snapshot is never reported as fresh.

### Dependency Graph and Change Impact (`rdsh deps`)

```sh
rdsh deps build                    # incremental index under $DSH_HOME/rdsh-index
rdsh deps query engine_score       # where a symbol is defined and referenced
rdsh deps impact src/context.rs    # direct/transitive dependents + affected tests
```

The extractor covers Rust, JavaScript/TypeScript, Python, and Go and records
imports, definitions, and static call sites per file. Unchanged files (same size
and mtime) are reused, so repeated runs stay fast. It is a static approximation:
dynamic dispatch, indirect calls, macros, and generated code remain explicitly
`unknown` and are reported as unresolved counts rather than guessed, and a
missing index means "no information", never "no dependencies".

When the index exists, `rdsh context build` and `rdsh context inject` also pull
in the graph neighbours of the files their search matched, so a retrieved
excerpt arrives with the files it actually depends on.
Native execution overhead is ~1 ms per invocation.

## Low-end hosts

Default profile: `RDSH_DEFAULT_PROFILE`, then `general.default_profile` in rdsh settings, then local `tui`, else a guided error. Set the saved default with `rdsh settings set general.default_profile web`; an explicit `--profile <name>` keeps its precedence.

rdsh aims to remain useful on modest machines: older x86-64 CPUs, older Linux
distributions, and hosts without Node.js installed.

- **Faster Node startup.** When rdsh launches dsh, it sets `NODE_COMPILE_CACHE`
  to `~/.cache/rdsh-node-compile-cache`, letting Node reuse compiled code across
  launches (Node 22.1 or newer; older versions ignore it). An existing
  `NODE_COMPILE_CACHE` value is preserved. Set `RDSH_NODE_COMPILE_CACHE=0`, or
  use `--passthrough` / `RDSH_PASSTHROUGH=1`, to opt out.
- **Broad CPU support.** Prebuilt x86-64 binaries do not require AVX or BMI;
  the static musl build also runs on systems with older glibc.
- **Session token estimates.** `sessions --tokens` reads a decompressed size
  from the zstd frame header when available. Most streaming frames need the
  `zstd -dc` fallback. Results are cached under
  `~/.cache/rdsh/sessions-tokens.json` (`$XDG_CACHE_HOME` takes precedence);
  set `RDSH_TOKENS_CACHE=0` to disable the cache. A `?` marks an estimate that
  could not be read, for example when the zstd CLI is unavailable.
- **Bounded parallel work.** Search and session scans use at most eight worker
  threads. The zstd CLI fallback uses 8 to 32 parallel processes.
- **Native commands without Node.** Commands such as `tokens`, `search`, and
  `sessions` keep working without Node. To delegate conversations, install
  `@deepseek-ai/dsh` or set `DSH_ORIG_BIN` (or `RDSH_ORIG_BIN`).
- **Low-priority updates.** `sync-dsh.sh` updates dsh and rdsh, verifies
  archive bytes against that registry, and rolls back a failed update candidate. By default it uses the
  stable release selected by the reviewed repository digest registry; set `RDSH_SYNC_FROM_SOURCE=1` to build from
  `main` under `nice -n 19` and `ionice -c3` when available. The systemd unit
  runs at low priority; adjust its `ExecStart` to your checkout.

## Web UI & Dashboard

### Lightweight Local Web UI (`rdsh serve`)

A lightweight status and token estimation page running on localhost (default `:38080`, does not conflict with DSH `:3080`):

```sh
rdsh settings set extras.enable serve  # enable the server feature
rdsh serve                             # launch (bound to localhost, protected with a one-time token)
```

### Product language

rdsh-owned CLI diagnostics and the native local page support English, Simplified
Chinese, and Japanese. Choose one run with `--language`, or persist it in
`rdsh.json`; the default `auto` reads the first nonblank locale environment variable,
falling back to English when it is absent or unsupported.

```sh
rdsh --language ja settings show
rdsh settings set general.language zh-CN
```

Precedence is `--language`, `RDSH_LANG`, `general.language`, then `LC_ALL`,
`LC_MESSAGES`, and `LANG`. An explicitly invalid `general.language` stops the
command without rewriting the settings file. Delegated `dsh` arguments, model
output, JSON fields, files, and protocol identifiers are not translated. Interactive setup prompts and settings/policy validation use the selected
language too. Authentication decisions and skipped-provider notes localize only
the CLI presentation; their existing JSON strings remain unchanged, including
malformed or oversized guard-input reasons. Native search continues to refuse
unsupported non-Unix platforms before accessing the requested directory.

`worker-scope validate` and `worker-scope policy` also localize their help and CLI diagnostics. These pure commands and their help ignore unrelated corrupt settings; ordinary commands and root help still report the settings error. Canonical JSON, policy codes and supplied paths stay unchanged.

### Protected delegated tools

The opt-in agent tool sandbox supports Linux x86_64 with bubblewrap, prlimit,
and unprivileged user namespaces. Its audited DSH/tool-runtime pairs are
`0.2.0-rc.2`, `0.2.1-alpha.1`, and `0.2.1-alpha.3`, with matching versions in
each pair. It verifies package metadata, runtime bytes and the loaded module,
then limits inspection to explicitly shared files. Unknown, mixed, modified or
unexpectedly resolved runtimes stop before delegation. macOS and Windows
refuse protected delegation; ordinary delegation keeps the original tools.
This matrix applies to the Rust launcher. Project-pinned dashboard releases
retain their separate [supported tuple](docs/STAGED-UPDATES.md#capture-trusted-runtime-code).

### Extended Dashboard (`rdsh-dashboard`)

Optional Node.js dashboard for project metrics, human-in-the-loop Q&A, and mobile access (requires Node.js 22+):

```sh
rdsh-dashboard project --project <directory>
```

*On native Windows, the dashboard runs in the system tray and can be opened or stopped from the taskbar (`--no-tray` keeps it in the terminal). See [dashboard/README.md](dashboard/README.md). External agent CLIs (cursor-agent, devin) can be run as supervised jobs: see [docs/AGENT-RUNNERS.md](docs/AGENT-RUNNERS.md).*

## Desktop App (Electron)

DeepSeek Harness Desktop is an Electron shell around the complete Web
application. It shares `$DSH_HOME` with the CLI but owns a **reserved profile**
(`$DSH_HOME/profiles/desktop`) and its own bundled command runtime, so the npm
`dsh` CLI cannot manage its plugins. `rdsh desktop` detects all of that and
forwards plugin attachment to the app's own command — rdsh never boots or
rewrites the profile:

```sh
rdsh desktop status                 # app, command runtime, profile, plugin state (read-only)
rdsh desktop install --plugins-dir .   # rdsh-settings + default third-party (sound, gitview)
rdsh desktop install --plugins-dir . --compute   # + the resident compute bridge
rdsh desktop install --plugins-dir . --no-sound --no-gitview  # skip third-party
rdsh desktop verify                 # exit nonzero when the profile has no rdsh plugin
```

The same is available through the profile installer and the installers:

```sh
PROFILE=desktop ./plugins/install.sh   # essential + default recommended, forwarded correctly
./install.sh --desktop                 # attach the rdsh plugins during installation
```

*Quit the app before attaching plugins, reopen it afterwards. The app's own
Plugins page installs the same packages without any command. The Electron
runtime itself is never replaced: in-app delegation stays limited to the
opt-in, fail-open compute bridge. See
[DESKTOP-INTEGRATION.md](docs/DESKTOP-INTEGRATION.md).*

Two optional plugins extend the existing Desktop/Web runtime:

- [File organization](plugins/rdsh-easy-work/README.md): select a folder, preview
  extension-based categories, copy after confirmation, and archive the copies
  to undo. Originals stay in place. Execution currently requires Linux;
  Windows and macOS support preview only. No AI connection is needed.
- [Bounded exploration subagents](plugins/rdsh-subagent-optimizer/README.md):
  fresh context, bounded concurrency and output, and active duplicate suppression
  through the native DSH `spawn` provider (0.2.0-rc.2).

Use the app's Plugins page to add the corresponding directory, or select them
with `./plugins/install.sh --recommended=easy-work,subagents` (`EASY_WORK=1` /
`SUBAGENTS=1` still work). These are opt-in features being prepared for 0.4.0.
See the [acceptance evidence](docs/reviews/2026-10-14-easy-work.md).

[Desktop SDK and upstream preparation](desktop/README.md) provide a pinned
official SDK, an isolated fork home, bundled Rust launcher, and a dedicated
rustdsh update channel. Source preparation and SDK transport are tested;
signed Desktop installers and update acceptance still require platform builds.

## Using with Smart-DSH

[Smart-DSH](https://github.com/hikarioyama/Smart-DSH) (a web-profile plugin bundle) works smoothly alongside rdsh:

```sh
rdsh doctor                                    # check dsh version and Smart-DSH bundles
rdsh plugin --profile web add /path/to/bundle  # add plugins
rdsh --profile web                             # boot web with plugins enabled
```

Ports never collide (DSH Web: `3080`, rdsh serve: `38080`).
Ports never collide (dsh web GUI :3080, `rdsh serve` :38080). With
`install.sh --as-dsh`, point Smart-DSH helper scripts at `dsh-orig` or
export `DSH_PACKAGE_DIR`.

## Web dashboard

For the read-only workflow member board in DSH's conversation GUI, use the [verified source-patch preparation tool](plugins/workflow-board/README.md) with an isolated compatible source checkout. It includes the 18-file board/UI projection patch, compatibility diagnostics and fixture tests; building and adopting the patched DSH are separate steps.

For bounded MCP resource artifacts and explicit resource-link reads, use the [verified source-patch preparation tool](plugins/mcp-resource-artifacts/README.md) with an isolated checkout at its pinned DSH revision. Resource links are never fetched automatically, binary payloads stay out of model text, and building or adopting the patched DSH are separate steps.

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
Add `--include-project <directory>` to a project launch to show read-only
active, waiting, and needs-attention counts for only the projects explicitly
listed at startup. Details stay in each project's dashboard; unreadable
projects show their last successful observation time and an unknown state.

The original Harness update banner appears right after an update is recorded,
every two hours from its update time, and on every full page reload.
Dismiss / X or a successful updater check closes the current occurrence; the
two-hour schedule continues. Unchanged release checks do not record a new update. Switching projects keeps it closed until the next slot, and close
events reach other GUI ports of the same OS user. Activating new code needs one
normal GUI restart/reload; see [browser verification](docs/evidence/update-notice-repeat/README.md).

rdsh bundles only Smart-DSH's phone-width layout, as
[`plugins/rdsh-mobile-ui`](plugins/rdsh-mobile-ui/README.md) (MIT, adapted from
Smart-DSH): at 767px and below the chat and composer use the full width and the
logo opens the session list in one tap. Smart-DSH's notifications, Esc-to-stop,
task hub and shared-HMR workaround stay upstream — install the upstream bundle
when you want those.

## Benchmarks

Process-level measurements on Linux x86_64. Every row names the exact command it
measures, and none of them describe an agent session: when rdsh boots a profile it
`exec`s the same upstream Node.js `dsh`, so conversation startup, interactive
latency and session memory are those of upstream.

Only the `--version` rows compare rdsh with upstream `dsh`. The hook, `tokens`
and `search` rows compare against an equivalent Node.js implementation of the
same work; upstream `dsh` exposes no `tokens`/`search` subcommand, so no
upstream ratio is claimed for them. They were measured on one Linux x86_64 host
by `scripts/benchmark-node-vs-rust.py`.

| What is measured | rdsh | Baseline | Factor |
| --- | --- | --- | --- |
| `rdsh --version` process launch | **~0.90 ms** | ~88 ms, upstream `dsh --version` | **~98x faster** |
| `rdsh --version` peak RSS | **~2.9 MB** | ~66 MB, upstream `dsh --version` | **~1/23 memory** |
| PreToolUse hook `rdsh guard`, per tool call (launch included) | **~2.0 ms** | ~80–100 ms, equivalent Node.js judge | **~40–50x faster** |
| PreToolUse hook over 200 tool calls (cumulative, 10% denied) | **~0.4–0.6 s** | ~16–24 s, equivalent Node.js judge | **~42x faster** |
| PreToolUse hook peak RSS | **~6.0 MB** | ~49 MB, equivalent Node.js judge | **~1/8 memory** |
| `rdsh tokens` (9.6 MB ASCII text) | **~8 ms** | ~175–195 ms, Node.js reference | **~22x faster** |
| `rdsh search` (300 files, 600k lines) | **~10–25 ms** | ~125–230 ms, Node.js reference | **~9–12x faster** |
| `sessions --tokens` (20 sessions) | **~0.41 s** | ~1.65 s, previous rdsh build (historical) | **~4.0x faster** |
| Distribution size | **one ~1.8–2.3 MB binary** (per platform) | ~508 MB Node tree | **ultra compact** |

The `--version`, `sessions` and size rows are the historical headline numbers
recorded in [docs/BENCHMARKS.md](docs/BENCHMARKS.md); their absolute values are
host-dependent. The hook, `tokens` and `search` numbers are one Linux x86_64
host at `n=15` with process launch included; regenerate them with:

```sh
cargo build --release
python3 scripts/benchmark-node-vs-rust.py --bin ./target/release/rdsh \
  --mode all --n 15 --calls 200 --output /tmp/rdsh-node-vs-rust.json
```

For startup, run `rdsh bench --n 5`. See
[docs/BENCHMARKS.md](docs/BENCHMARKS.md) for every test setup and raw sample.

## Safety Design

1. **Upstream Fidelity**: Never reimplements conversation loops or agent logic; delegates directly to upstream `dsh`.
2. **Non-Destructive**: Read operations (tokens, search, session listing, compacting) never modify source files.
3. **Explicit Auth**: Credentials are never sent externally or synced automatically; only user-approved items are imported.
4. **Tool Sandboxing** (opt-in): On Linux, `--share-file` mounts only the files you share, read-only and without network, for the `rdsh_inspect` tool. Other DSH tools follow upstream permissions and approvals.

## FAQ

- **Q. Do I need the original `dsh` installed?**  
  Yes, for conversations and agent execution. Standalone commands like token calculation, file search, and health checks (`rdsh doctor`) work without it.

- **Q. Can I replace my existing `dsh` command?**  
  Yes. Install with `./install.sh --as-dsh` (or `.\install.ps1 -AsDsh` on Windows) to shadow `dsh` transparently. Revert anytime with `--restore`.

- **Q. What if there is a port collision?**  
  Upstream DSH Web uses `:3080` while `rdsh serve` defaults to `:38080`. To pick an arbitrary free port, specify `--port 0`.

- **Q. Will my existing scripts break?**  
  No. Any argument not belonging to an rdsh-specific command is forwarded verbatim to upstream `dsh`.

- **Q. Does a profile-less `rdsh boot` fail?**
  Set `general.default_profile` or `RDSH_DEFAULT_PROFILE`, or pass `--profile <name>`.

## Documentation

| Document | Description |
| --- | --- |
| [docs/USER-FLOW.md](docs/USER-FLOW.md) | End-to-end installation, usage, and recovery flow |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Architecture design and delegation model |
| [docs/BENCHMARKS.md](docs/BENCHMARKS.md) | Benchmark methodology and reproduction steps |
| [docs/RDSH-SETTINGS.md](docs/RDSH-SETTINGS.md) | Settings UI and CLI options |
| [docs/PROVIDERS.md](docs/PROVIDERS.md) | `rdsh provider`: HAI, Sarashina and home LLM server routes |
| [docs/DESKTOP-INTEGRATION.md](docs/DESKTOP-INTEGRATION.md) | DeepSeek Harness Desktop (Electron) integration |
| [docs/FEDORA.md](docs/FEDORA.md) | Fedora / RHEL packages, optional tools, and the Linux desktop reality |
| [docs/PACKAGE-MANAGERS.md](docs/PACKAGE-MANAGERS.md) | Homebrew, Scoop and winget manifests, and how to update them |
| [docs/ROADMAP.md](docs/ROADMAP.md) | Project roadmap and planned capabilities |
| [docs/RELEASING.md](docs/RELEASING.md) | Release procedures |
| [docs/SERIAL-PROXY.md](docs/SERIAL-PROXY.md) | Concurrency-limiting proxy for single-slot providers |
| [CHANGELOG.md](CHANGELOG.md) | Changes per version |

## Community

- Contributions: See [CONTRIBUTING.md](CONTRIBUTING.md).
- Rust development setup: [Rust development guide](docs/RUST-DEVELOPMENT.md).
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
- Default Web UI plugins (used with upstream permission, MIT): [dsh-sound-notifications](https://github.com/cwd514/dsh-sound-notifications) by [cwd514](https://github.com/cwd514) ((c) 2026) — synthesized tones and desktop notifications; [dsh-gitview](https://github.com/yugapor/dsh-gitview) by [yugapor](https://github.com/yugapor) ((c) 2026) — Git panel with diffs, history, and CI status. Both are fetched from upstream GitHub at install time (see `plugins/recommended.md`).

Third-party DSH plugins that rdsh uses, adapts or recommends (MIT, by their
authors):

- [Smart-DSH](https://github.com/hikarioyama/Smart-DSH) by hikarioyama — the
  phone-width layout bundled as
  [`rdsh-mobile-ui`](plugins/rdsh-mobile-ui/README.md)
- [dsh-sound-notifications](https://github.com/cwd514/dsh-sound-notifications) by
  cwd514 — opt-in effect sounds and desktop notifications (`SOUND=1`)
- [dsh-gitview](https://github.com/yugapor/dsh-gitview) by yugapor — optional
  sidebar Git panel
- [dsh-intelligent-ui](https://github.com/cwd514/dsh-intelligent-ui) by cwd514
  (MIT, (c) 2026 cwd514) — opt-in visual answers in the DSH Web chat via the
  declarative `render_ui` tool (`--recommended=intelligent-ui` or
  `INTELLIGENT_UI=1`)

## License

MIT — see [LICENSE](LICENSE). Upstream DeepSeek Harness and its dependencies retain their respective licenses.

### External agent jobs

`node dashboard/cli.mjs --language ja agents list` selects the same display language as the dashboard. External-agent help and CLI diagnostics support `en`, `zh-CN`, and `ja`; job states, error codes, JSON keys and agent output remain canonical. Use `agents submit --prompt-file` for UTF-8 instructions, including Japanese filenames and text. See [agent runners](docs/AGENT-RUNNERS.md) for commands and permission limits. Submitting a real job can incur the external provider’s charges; the locale tests use local fake executables only.

`budget-admission apply|validate|public --input-file <request-json>` is also a settings-independent pure JSON command. Native and dashboard entrypoints localize owned help/errors in all three languages, preserve canonical budget codes and output, and never call a provider or write the budget book. See [budget control](docs/BUDGET-CONTROL.md).

`question-contracts apply|validate|public`, `answer-applications apply|validate|public|schema` and `instruction-queue validate|context|submit|resolve|control` accept `--input-file <request-json>` without reading unrelated settings. Native and dashboard help and owned diagnostics support all three languages; engine messages, status codes and canonical JSON retain upstream values. The optional [answer guard](plugins/rdsh-answer-guard/README.md) also localizes its notice summary and configuration error without changing the model-facing reminder.
