# Desktop (Electron) speedup notes

App identity: the v0.2 Desktop app is an Electron shell with a bundled
`dsh` runtime and a bundled Node runtime (upstream `apps/desktop`,
`dsh-v0.2.0-rc.2` notes). It is native-distributed, not native-executed.
Startup cost (~10s to ready URL, measured on Linux web profile) comes from
Chromium + Node + plugin loading, so no external shim can make the app
itself boot like a 1MB native binary.

See [DESKTOP-INTEGRATION.md](DESKTOP-INTEGRATION.md) for the supported attach
path (`rdsh desktop install` into the reserved profile) and its verification
status.

## Where rdsh helps (measured, release build)

| Call site | rdsh | Baseline |
| --- | --- | --- |
| `--version` startup | 2ms | Node `dsh` 97ms (~48x) |
| Peak RSS | 3.1MB | 66MB (~1/21) |
| `sessions --limit 20` table/JSON | ms-class, no JSON penalty | n/a |
| `sessions --limit 20 --tokens` | ~0.65s (zstd-bound) | n/a |
| `search` / `dump-config --native` | ms-class | n/a |
| `doctor` | 0.11s (was 4.6s before size-gate fix) | n/a |
| Node with `NODE_COMPILE_CACHE` warm | n/a | ~19% off Node boot |

## Integration points

1. Terminal `dsh` slot: install with `install.ps1 -FromRelease -AsDsh`
   (or `install.sh --as-dsh`). Original is kept as `dsh-orig`; delegation
   stays byte-identical, native fast paths answer directly.
2. In-app heavy reads: call `rdsh sessions --json [--tokens]`, `rdsh search`,
   `rdsh tokens` from plugins/helpers instead of Node. Stdout is pure JSON
   (notes go to stderr). This needs an upstream or plugin-side change;
   rdsh alone cannot reroute the bundled runtime.
3. Bundled Node boot: if the app inherits user env, a persistent
   `NODE_COMPILE_CACHE` dir trims ~19% off its Node-side startups.
   Not set by the installers today (opt-in candidate).
4. Keep resident: quitting pays the ~10s boot again; background tasks
   already survive window close upstream.

## What rdsh cannot do

- Replace the Electron main process or the bundled runtime (breaks
  signing and compat; never reimplement the agent loop or profile boot).
- Reach code paths that never shell out to `dsh`.

## Still to measure (needs the Windows/mac machine)

- Desktop cold/warm startup time (stopwatch to first paint).
- Before/after for terminal `dsh` calls once `-AsDsh` is active.
- Whether the bundled Node honors `NODE_COMPILE_CACHE`.
