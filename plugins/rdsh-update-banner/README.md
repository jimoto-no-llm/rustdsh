# rdsh-update-banner

Update notification banner for [rdsh](https://github.com/jimoto-no-llm/rustdsh) on the dsh web GUI.

When `sync-dsh.sh` records an actual update in
`~/.local/share/rdsh/update-state.json`, the open web GUI receives a notification
through the authenticated `/api/rdsh-update/events` stream. File changes trigger
push delivery; a one-second server check covers missed filesystem events. If the
stream is unavailable, the client checks every five seconds and reconnects.

The card appears immediately, on every full page reload, and every **two hours**
from the recorded update time. **Dismiss** and **×** close the current occurrence.
Closing, polling, reloading, or switching projects does not reset the two-hour
schedule. A project remount keeps the current occurrence closed; the next reminder
or an actual new update appears again. Minimizing keeps the notification.

A successful **update** / **update again** check closes the occurrence that started
the request, like Dismiss, without resetting the schedule. Failed checks remain
visible and retryable. A newer update arriving during the request remains visible.
The release updater compares verified binary bytes with the installed binary:
an unchanged payload neither reinstalls nor rewrites the notification time. A
changed payload still updates even if its version label is the same. See
[loop regression evidence](../../docs/evidence/update-notice-noop/README.md).

Same-origin tabs share close events through browser storage. Independent GUI
ports running as the same OS user also share live close events through the private,
atomically replaced `~/.local/share/rdsh/update-notice-close.json` file. The
notification identifies the component, target, update time and two-hour period, so
an old close cannot hide a newer update or reminder. Existing close records are
not replayed on page load. Separate OS accounts keep separate records.

Legacy permanent dismissal records are ignored and retained on disk. Closing
works in memory when browser storage is disabled, including project remounts;
full reload intentionally shows the notification again. Demo closes never write
account state. Activate the new server/client code through the normal GUI
restart/reload once; running user sessions are not restarted automatically.

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
- All four API routes require the DSH GUI session and its Host/Origin checks.
  DSH must provide `connection.requestRejection` (verified with 0.2.0-rc.2).
  Without the `connection` service, the plugin is not loaded. If the service
  lacks the authentication API, requests are refused with 503.

## Live GUI verification (Issue #5)

The banner is wired into the live web profile (insert block + node_modules
link) and serves real state via `/api/rdsh-update`, but the live `:3080`
process predates the wiring, so it has never rendered there (verified only
on the `:38080` demo instance).

After the next GUI restart, confirm on `:3080`:

1. An actual update appears in an open page without reloading.
2. Dismiss/× close it; full reload and the next two-hour boundary show it again.
3. Minimize and updater actions still work; no boot errors appear in GUI logs.

[Reproducible browser evidence](../../docs/evidence/update-notice-repeat/README.md)
uses isolated authenticated hosts and dummy state without restarting the live GUI.

Then stop creating demo instances for this check.

## npm package retirement (Issue #6)

`rdsh-update-banner@1.0.0` on npm is superseded by the in-repo bundled copy
(`plugins/rdsh-update-banner`, installed via `install-banner.sh`).
Do not publish new versions to npm.

Retirement steps (docs only; no code deleted here):

1. `npm deprecate rdsh-update-banner "moved into jimoto-no-llm/rustdsh: plugins/rdsh-update-banner"`
   (preferred; keeps installs resolving with a pointer).
2. Only if deprecation is not enough: `npm unpublish rdsh-update-banner@1.0.0`
   (needs a classic token + fresh OTP; granular 2FA-bypass tokens are
   rejected for deletes).

Acceptance: the registry entry is gone, or deprecated with a pointer to
the repo copy.

## License

MIT
