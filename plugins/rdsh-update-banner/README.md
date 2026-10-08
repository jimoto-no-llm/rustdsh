# rdsh-update-banner

Update notification banner for [rdsh](https://github.com/sahenjp/rustdsh) on the dsh web GUI.

When `sync-dsh.sh` (shipped with rdsh) records an update in
`~/.local/share/rdsh/update-state.json`, a notification card appears at the
top of the web GUI. From the card you can run the update check, see details,
minimize it, or dismiss it (dismissed versions stay dismissed).

## Install

```sh
dsh plugin --profile web add rdsh-update-banner
```

Then add one block to your web profile `cordis.patch.yml` (or run
`install-banner.sh` from the rdsh repo, which does both steps):

```yaml
- insert:
    - id: rdsh-update-banner
      name: "rdsh-update-banner"
      config:
        demo: false
```

Reload the web GUI to pick it up.

## Config

- `demo: true` shows a demo notification without touching any state file.
- Without updates recorded, the banner stays hidden.
- Both API routes require the DSH GUI session and its Host/Origin checks.
  DSH must provide `connection.requestRejection` (verified with 0.2.0-rc.2).
  Without the `connection` service, the plugin is not loaded. If the service
  lacks the authentication API, requests are refused with 503.

## Live GUI verification (Issue #5)

The banner is wired into the live web profile (insert block + node_modules
link) and serves real state via `/api/rdsh-update`, but the live `:3080`
process predates the wiring, so it has never rendered there (verified only
on the `:38080` demo instance).

After the next GUI restart, confirm on `:3080`:

1. The banner appears when `~/.local/share/rdsh/update-state.json` records an update.
2. Dismiss, minimize, and update-all actions work.
3. No boot errors appear in the GUI logs.

Then stop creating demo instances for this check.

## npm package retirement (Issue #6)

`rdsh-update-banner@1.0.0` on npm is superseded by the in-repo bundled copy
(`plugins/rdsh-update-banner`, installed via `install-banner.sh`).
Do not publish new versions to npm.

Retirement steps (docs only; no code deleted here):

1. `npm deprecate rdsh-update-banner "moved into sahenjp/rustdsh: plugins/rdsh-update-banner"`
   (preferred; keeps installs resolving with a pointer).
2. Only if deprecation is not enough: `npm unpublish rdsh-update-banner@1.0.0`
   (needs a classic token + fresh OTP; granular 2FA-bypass tokens are
   rejected for deletes).

Acceptance: the registry entry is gone, or deprecated with a pointer to
the repo copy.

## License

MIT
