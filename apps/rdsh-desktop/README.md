# rdsh-desktop (native GPUI shell)

A native desktop window for DeepSeek Harness, ported from the upstream Electron
app (apps/desktop + apps/web at the pinned revision) to GPUI. It renders the same
design system and drives the same HTTP/WebSocket API, so the web UI is no longer
needed for day-to-day conversation work.

The process that paints the window is the process that talks to the harness; no
Electron, no bundled Chromium, no local web server.

## What works

- Project-grouped sidebar with the real conversation titles (filled from session
  projections, 80 conversations per launch)
- Header status: project, context usage, token totals, pending questions
- Model picker from the host catalog; the selection is stored by the host
  (session/selectModel) and survives restarts
- Live assistant streaming (session/follow + assistant-stream deltas) with a stop
  button (session/cancel)
- Approval prompts and user questions ($events waterfall, answered through
  $events/result and userQuestions/answer)
- Tool call rows and reasoning blocks in the timeline
- New conversation (session/create), Enter to send, composer focus handling

## Run

~~~sh
cd apps/rdsh-desktop
cargo run --release            # window (recommended: the dev build is slower)
cargo run -- --dump-ui         # sidebar/header state as JSON (headless)
cargo run -- --dump-titles     # resolve conversation titles (headless)
cargo run -- --dump-live       # both live sockets, 8s (headless)
cargo run -- --new-session     # create a conversation and print its id
cargo run -- --dump-session    # raw opening snapshot of one conversation
cargo run -- --probe           # session list, model catalog, history
cargo run -- --stop-host       # stop the detached harness host
~~~

RDSH_DESKTOP_DSH points at the harness launcher (defaults to dsh on PATH).

## Prerequisites

Linux uses the Wayland GPUI backend: a Vulkan driver, fontconfig and xkbcommon.
gpui links xkbcommon-x11 as well; install the development package when the
distribution ships only the runtime library:

- Fedora: sudo dnf install libxkbcommon-x11-devel
- Debian/Ubuntu: sudo apt install libxkbcommon-x11-dev

build.rs falls back to the runtime library when the development symlink is
missing and prints a warning. Windows and macOS use the default GPUI features.

## Design values

Tokens come from the upstream theme (packages/client/ui-theme/src/styles at the
pinned revision):

- page: white
- sidebar: hsl-like near-white (f9fafb)
- composer: white
- user bubble: pale blue (edf3fe)
- label: near-black (0f1115)
- secondary and tertiary text: (61666b, 81858c)
- accent: (4176e6)
- hairline borders at 4%, 10% and 12% black
- radii 4/8/12/16/20/28, body 14px with a 24px line box

## Interaction

- Sidebar shows every project group; the previous 60-row cap hid whole groups.
- Scrolling: both the sidebar and the timeline scroll with the wheel or trackpad.
- Model: the picker lists every provider (138 models here) with provider headers,
  keeps the current provider first and marks the active model.
- Model changes go through session/selectModel, so the host keeps them for the
  conversation and the chip and header update immediately.

## Following upstream dsh updates

The app does not pin a harness version. It resolves the launcher at startup,
preferring RDSH_DESKTOP_DSH, then every dsh on PATH, the local install paths and
the npm global bin, and keeps the newest one that answers --version. Upgrading
dsh (for example npm install -g @deepseek-ai/dsh@latest) is therefore enough to
move the app onto the new build.

- --check-host prints the launcher, its version, whether a host answered and the
  session count; add --online to compare against npm, which sets
  updateAvailable when upstream has something newer (prereleases included).
- scripts/verify-harness.sh /path/to/dsh checks the session list, model catalog
  and live events against one build without disturbing a running service.
- The startup status line names the harness version in use.

## Harness compatibility

The app speaks the harness client protocol (unary HTTP plus one WebSocket) and
follows the installed host instead of pinning a version. Verified against:

- 0.2.0-rc.2 (the dsh installed on this machine)
- 0.2.1-alpha.2 (the revision the upstream prototype pins)
- 0.2.1-rc.2

Each check covered the session list, the model catalog, the $events and
conversation streams, prompt streaming (reasoning-delta and text-delta) and the
cookie attach path. To exercise one harness build on its own, set
RDSH_DESKTOP_DSH to that dsh and RDSH_DESKTOP_NO_ATTACH=1, which forces a fresh
host instead of attaching to a running one.

The attach path mints the v1 authority cookie; 0.2.1 still accepts it next to
its v2 peer cookie, so attaching stays available on both.

## Startup and weight

The app paints its shell first and loads data in the background. It attaches to a
host that is already listening, and only starts one when nothing answers:

- attach (normal): about 0.6s, and no extra Node process. The app mints the
  signed browser cookie from the credentials secret, so an already running
  service (or a previous launch) is used directly.
- first launch without a host: about 9s once. The app starts a detached host and
  caches its ready URL, so the next launch attaches in under a second.
- --stop-host stops the detached host; RDSH_DESKTOP_ORIGIN forces one origin.

Use --release: the debug binary is about 500MB and renders slowly, while the
release build is 19MB. The dev profile keeps the app crate at opt-level 1 but
builds dependencies at opt-level 3, which keeps dev runs responsive.

Measured with --dump-ui: attach 606ms (release) / 949ms (dev), cold 9.4s,
app RSS about 52MB.

## Notes

- The window needs a GPU-backed Wayland session; every headless mode above runs
  without a display.
- xattr is vendored: gpui_http_client pins xattr 0.2.3, which no longer compiles
  on current Linux toolchains. vendor/xattr implements the 0.2 API the
  dependency uses (see NOTICE.md).
