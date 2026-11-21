# rdsh-update-banner

Update notice card for [rdsh](https://github.com/jimoto-no-llm/rustdsh) on the dsh
web GUI. One overlay card carries every notice; it never opens a second fixed
card per component.

## What it shows

| Row | Source |
| --- | --- |
| `rdsh` | an applied update recorded by `sync-dsh.sh` in `~/.local/share/rdsh/update-state.json` |
| `rustxng` | the rustxng sidecar record in the same file |
| `dsh` | a published `@deepseek-ai/dsh` release newer than the running host |

Every row is in one of these states:

- **available** — a newer release exists. Shows `current → latest`, the release
  channel (stable / prerelease / next), and `Checked <relative time>`.
- **applying** — the request is running; the row is `aria-busy` and the button is
  disabled.
- **applied** — a short confirmation (8 s). It is never a permanent alert, and it
  is not replayed by a poll, a remount or a reload.
- **restart-required** — `dsh` was installed but the running host still uses the
  old build. This survives a reload for 24 h until it is dismissed.
- **up-to-date** — shown for 5 s after a manual *Retry* finds nothing.
- **error** — the check or the update failed. The card becomes `role="alert"` and
  offers *Retry*; an error is never confused with "up to date".

Priority inside the card is error > available > applied.

## Dismissal

Dismissing stores a record for **(component, from, to)** in browser storage under
`rdsh-update-dismissals:v4` (legacy `rdsh-update-close:v3` and
`rdsh-update-close:dsh:v3` keys are migrated and removed). The registry check
time is *not* part of the identity, so the twelve-hour `npm view` re-check that
only rewrites `checkedAt` cannot bring a dismissed release back. A different
target release notifies again.

The server accepts `POST /api/rdsh-update/dismiss` with `{ kind, from?, to }`,
validates it against the live notice (the applied record for `rdsh`/`rustxng`,
the currently advertised `dsh` target for `dsh`) and writes
`~/.local/share/rdsh/update-notice-close.json` atomically (mode 0600, single
hard link, no symlinks). The close is then streamed on
`/api/rdsh-update/events`, so another tab or an independent GUI port running as
the same OS user closes the same notice. A `dsh` dismissal can never close an
`rdsh`/`rustxng` notice. Demo closes write no account state.

State file hardening: a record with `from === to`, a record older than 24 hours,
or a `rustxng` record while no `rdsh` binary is on `PATH` is suppressed and
reported as "no update" instead of rendering.

## dsh releases

`npm view @deepseek-ai/dsh dist-tags versions --json` is cached for twelve hours
in `~/.cache/rdsh-desktop/update-check.json` (atomic write). The target comes
from `dist-tags`, not from the maximum of every published version:

- **stable** users get `dist-tags.latest` (or the newest stable version).
- A user already running a prerelease may advance to `dist-tags.next` when it is
  newer, labelled **next (prerelease)**.
- Prerelease identifiers compare per SemVer, so `1.0.0-alpha.10` is newer than
  `1.0.0-alpha.2`.

Set `RDSH_DESKTOP_UPDATE_CHECK=0` to disable the registry query; the dsh row
then stays hidden.

### Installing a dsh update

The running package decides the install target. `activeDshInstall()` always
returns `{ version, prefix, managed, environmentVersion, packageDir }` (also when
`DSH_VERSION` is set, which used to return a bare string). The npm prefix is
derived from the package location for both layouts — `<prefix>/node_modules/@scope/pkg`
(installer) and `<prefix>/lib/node_modules/@scope/pkg` (npm global) — and for
scoped or unscoped packages.

`POST /api/rdsh-update/dsh/run` runs `npm install --prefix <prefix> @deepseek-ai/dsh@<version>`
(timeout five minutes, no shell, version string validated) and then reads
`<prefix>/node_modules/@deepseek-ai/dsh/package.json` back. Only a matching
version reports success, with `restartRequired: true`; the web service must be
restarted to run the new host. When the running install cannot be located, the
plugin refuses instead of falling back to `npm install -g`, which would update a
different installation than the one serving the GUI.

## Accessibility and layout

- `role="status"` + `aria-live="polite"` for availability; `role="alert"` +
  `aria-live="assertive"` only while an error is shown.
- Every row header and action is a real `<button>`; expandable rows expose
  `aria-expanded` and `aria-controls`. The card close button is 44×44 with a
  localized `aria-label`; every action and link keeps a 44 px touch target.
- Escape closes the card and focus returns to the element that was focused
  before it appeared. `:focus-visible` outlines come from the DSH tokens.
- The badge carries text, so state is never conveyed by color alone; SVG icons are
  `aria-hidden`. Entry animation respects `prefers-reduced-motion`, the panel
  background respects `prefers-reduced-transparency`, and
  `prefers-contrast: more` strengthens borders.
- Position uses `--dsh-frame-overlay-top` / `--dsh-frame-chrome-top` with a 64 px
  fallback and sits 12 px below the DSH chrome, clear of DSH toasts. The card has a
  `max-height` with internal scrolling. At or below 480 px it becomes a bottom
  sheet with `env(safe-area-inset-bottom)`.

Copy is English, Japanese and Chinese. The client registers its dictionaries with
the DSH locale service (`ctx.locale.register`, slot `locale`), so the card follows
the GUI language; without that service it uses `navigator.languages`.

## Config

```yaml
- insert:
    - id: rdsh-update-banner
      name: "rdsh-update-banner"
      config:
        demo: false
```

- `demo: true` shows a demo notice without touching any state file.
- `syncScript` optionally sets an absolute or plugin-relative updater path. The
  bundled checkout resolves `../../sync-dsh.sh`; a missing script reports how to
  configure or reinstall it. Before execution the plugin requires one regular file
  owned by the current OS user, executed without a shell.
- Without updates recorded, the card stays hidden.
- All five API routes require the DSH GUI session and its Host/Origin checks. DSH
  must provide `connection.requestRejection`. Without the `connection` service the
  plugin is not loaded; if the service lacks the authentication API, requests are
  refused with 503.

## Tests

- `node --test tests/update-banner.test.mjs` — client state machine in a VM,
  server contract (same-version suppression, 24 h TTL, orphaned rustxng record,
  dsh dismissal matching the live target, cross-tab stream, planted symlinks),
  SemVer/dist-tag selection, prefix detection, locale dictionaries, ARIA basics.
- `cd tests/e2e && node update-banner.mjs` — Playwright against the real component
  and the real routes: single card, dsh dismissal persistence across
  `checkedAt` refreshes, ja/zh/en copy, 320/375/1100 px viewports, Escape and
  focus, reduced motion, error and retry, restart-required. It uses a temporary
  `HOME`, pins `DSH_VERSION`, seeds the dsh cache and mocks every updater
  response; it never runs a real updater.

## npm package retirement (Issue #6)

`rdsh-update-banner@1.0.0` on npm is superseded by the in-repo bundled copy
(`plugins/rdsh-update-banner`, installed via `install-banner.sh`).
Do not publish new versions to npm.

1. `npm deprecate rdsh-update-banner "moved into jimoto-no-llm/rustdsh: plugins/rdsh-update-banner"`
2. Only if deprecation is not enough: `npm unpublish rdsh-update-banner@1.0.0`
   (needs a classic token + fresh OTP).

## License

MIT
