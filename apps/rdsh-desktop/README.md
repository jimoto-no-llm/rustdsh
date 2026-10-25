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
- New conversation (session/create), Enter to send, composer focus handling,
  and Japanese IME composition in the composer

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

## Development checks

This crate is a separate workspace; run its checks from this directory:

~~~sh
cargo fmt --check
cargo clippy --release --locked --all-targets -- -D warnings
cargo test --release --locked
~~~

The root workspace's checks do not cover the native desktop crate.

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

## Platforms

The crate builds on Linux, macOS and Windows. The GPUI dependency is
target-specific: Linux uses the Wayland feature set and needs the xkbcommon
development libraries, while macOS and Windows use the default backend. The
link-time helper in build.rs only runs on Linux, and the vendored xattr shim has
a branch per platform.

- Linux: install libxkbcommon-devel (Fedora) or libxkbcommon-dev (Debian) and a
  Vulkan driver.
- macOS: packaging/macos/Info.plist and bundle.sh create rdsh-desktop.app; copy
  packaging/icon.icns into the bundle resources.
- Windows: build the exe and point a Start-menu shortcut at it with
  packaging/icon.ico; see packaging/windows/README.md.

The CI workflow desktop.yml builds and tests the crate on all three platforms.

## Keyboard and themes

| Key | Action |
| --- | --- |
| Enter / Ctrl+Enter | Send the message |
| Shift+Enter | Newline |
| Esc | Clear the composer, or close the search filter |
| Esc Esc (while running) | Stop the run |
| Ctrl+K | Focus the composer |
| Ctrl+N | New conversation |

Printable text (including repeated letters and IME commits) enters the composer
through GPUI's input handler. The key-down listener handles editing commands and
shortcuts; it does not insert a second copy of printable keys.
Idle Enter and Shift+Enter remain composer commands on Wayland; Enter during
an active IME preedit remains owned by the input method.
On Linux, `python3 tests/composer-wayland.py --binary /path/to/rdsh-desktop
--output /path/to/evidence --verify-send` checks twelve editing flows through real OS events
and reads the editor text back through the Wayland clipboard. It also checks
that Enter stores the exact prompt in its isolated DSH session. See the script's
help for the compositor and isolated-profile setup.
Actual Linux before/after PNGs, the editing-flow GIF and clipboard observations
are in [the composer evidence](../../docs/evidence/composer-input/README.md).

The sidebar has a search filter (title and project path) and each project row
folds, archives and restores. The timeline loads older history on demand and
keeps at most 400 messages in memory.

Theme: `RDSH_DESKTOP_THEME=light|dark|system` or `--theme`; system follows the
desktop appearance setting when it can be read. The window never shrinks below
900x600.

## Sidebar projects

The sidebar groups conversations by project. Each project header folds the
group away when clicked (the caret shows the state), and the × button on the
header archives the project out of the list. Archived projects stay hidden
until the footer toggle (アーカイブ) shows them again, dimmed, with a 戻す
button. Both states persist in `~/.config/rdsh-desktop/ui.json`.

The window uses the project orca icon: packaging/rdsh-desktop.desktop points at
`~/.local/share/rdsh-desktop/icon.png` (copied from assets/icon-256.png), and
the window sets app_id rdsh-desktop so the taskbar matches that entry.

## Web UI

The same experience is reachable from a browser, with no Node and no build step:

~~~sh
rdsh-desktop --serve-web --port 8790
~~~

It binds 127.0.0.1 only, prints a URL carrying a random token, and rejects
requests without that token. The page shows project groups, the conversation,
streaming text, tool and reasoning rows, the model chip and pending approvals or
questions. Live updates arrive over Server-Sent Events, and the page raises
browser notifications when an approval or question arrives, and when a run
finishes while the tab is hidden. The harness cookie never leaves the process.

Endpoints: /api/state, /api/events (SSE), /api/select, /api/send, /api/cancel,
/api/model, /api/approve, /api/answer.

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

## Composer IME input

The composer takes platform IME input (Japanese composition included) through
GPUI's `EntityInputHandler`: `ElementInputHandler` is installed over the text
area during paint, and every range on that wire is UTF-16, mapped to the
editor's byte offsets.

- A replacement replaces the active preedit first: the range the platform sends
  wins, otherwise the marked (composing) range is replaced, otherwise the editor
  selection. A `k` -> `ka` update therefore rewrites the preedit instead of
  appending to it, and the commit replaces it instead of leaving `kか` behind.
- The IME's selected range inside the preedit is rebased onto the inserted text
  and becomes the editor selection, so `selected_text_range` reports the
  composing segment.
- Platform paths: Linux Wayland (`set_marked_text` / `insert_text`), Windows
  (IMM composition, `GCS_COMPSTR` with `GCS_CURSORPOS`), macOS
  (`NSTextInputClient` `setMarkedText:selectedRange:` /
  `insertText:replacementRange:`). Wayland never sends a preedit selection
  range, so that part only runs on Windows and macOS.
- Known limitations: `bounds_for_range` returns the whole composer rect, so the
  candidate window is anchored to the composer rather than the caret, and
  `character_index_for_point` returns the caret, so clicking inside composing
  text does not place the cursor. Only the pure range mapping is unit tested
  (`cargo test` in this directory); no real IME runs in CI, so the platform
  wiring still needs a manual pass.

To try it by hand: `cargo run --release`, focus the composer, compose with a
Japanese IME, and check that the preedit is rewritten in place and that the
committed text lands exactly once. Enter sends; while composing it commits the
composition instead.

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

### Run the Web UI as a user service (optional, off by default)

The service is **not** enabled by default. Switch it on from the setup page
(rdsh setup --web) or from the CLI with rdsh desktop web-ui on, and turn it off
again with rdsh desktop web-ui off. The steps below describe what that toggle
does, for reference:

To keep the Web UI available without a terminal, install it as a systemd user
service. The page token is pinned so the URL survives restarts:

~~~sh
mkdir -p ~/.config/rdsh-desktop
umask 077 && printf "RDSH_DESKTOP_WEB_TOKEN=%s\n" "$(head -c16 /dev/urandom | od -An -tx1 | tr -d " \n")" \
  > ~/.config/rdsh-desktop/webui.env
mkdir -p ~/.config/systemd/user
cp packaging/rdsh-webui.service ~/.config/systemd/user/rdsh-webui.service
systemctl --user daemon-reload
systemctl --user enable --now rdsh-webui.service
cat ~/.cache/rdsh-desktop/webui.url
~~~

Manage it with systemctl --user status|restart|stop rdsh-webui.service.
RDSH_DESKTOP_UPDATE_CHECK=0 in webui.env disables the background update check.

## Notes

- The window needs a GPU-backed Wayland session; every headless mode above runs
  without a display.
- xattr is vendored: gpui_http_client pins xattr 0.2.3, which no longer compiles
  on current Linux toolchains. vendor/xattr implements the 0.2 API the
  dependency uses (see NOTICE.md).
- proc-macro-error2 2.0.1 is vendored with a public `proc_macro` declaration to
  fix Rust's future-incompatibility warning in GPUI's stacksafe-macro dependency.
  See vendor/proc-macro-error2/NOTICE.md for provenance and the exact change.
