# Auto-update

A published rustdsh release only reaches an installation when something runs
[sync-dsh.sh](../sync-dsh.sh): it checks the release channel, verifies the
archive against the digests pinned in
[`release-digests.tsv`](../release-digests.tsv), installs the binary, verifies
it and rolls back on any failure. The repository ships
[`systemd/rdsh-sync.service`](../systemd/rdsh-sync.service) and
[`systemd/rdsh-sync.timer`](../systemd/rdsh-sync.timer) so that check also
happens on its own, once a day — but they are templates: the service names the
machine its `ExecStart` was written on, and nothing installed or enabled them.

The pinned digests are the gate: a release that is not pinned on `main` cannot be
installed or auto-updated however long it has been published, and the daily run
keeps reporting the previous release as latest. The `pin-release-digests`
workflow opens that pull request as soon as a stable release is published, so
merge it — or run `python3 scripts/pin-release-digests.py vX.Y.Z` — before
announcing the release. `install.ps1` reads the Windows ledger
(`release-digests-windows.tsv`) the same way. See [RELEASING.md](RELEASING.md)
and [PROJECT-SETUP.md](PROJECT-SETUP.md).

`rdsh update auto` writes those units for *this* machine and hands them to the
user's systemd instance.

```sh
rdsh update auto status          # where the units are, which script they run
rdsh update auto on              # write the units, daemon-reload, enable --now
rdsh update auto off             # disable --now, then remove the units
```

`--json` prints the same result for scripts, and `--dry-run` (with `on` or
`off`) shows the plan without writing files or calling systemd.

## Where the pieces come from

| Value | Source |
| --- | --- |
| Updater script | `RDSH_SYNC_SCRIPT`, else `RDSH_SOURCE_DIR/sync-dsh.sh`, else the directory above the running `rdsh` |
| Unit directory | `RDSH_SYSTEMD_DIR`, else `$XDG_CONFIG_HOME/systemd/user`, else `~/.config/systemd/user` |
| Timer | `rdsh-sync.timer`, daily with up to 30 minutes of jitter, `Persistent=true` |

`rdsh update auto on` refuses to write anything when it cannot find the updater
script: a timer that fails every day without anyone reading the log is worse
than no timer. Point it at the checkout that holds `sync-dsh.sh`:

```sh
RDSH_SYNC_SCRIPT=~/src/rustdsh/sync-dsh.sh rdsh update auto on
```

## Finding the DSH tree

The run updates two trees: the `rdsh` binary from the pinned release, and the
`@deepseek-ai/dsh` package that `dsh` boots. That package is not necessarily
under the npm first on `PATH`: `rdsh` is a passthrough launcher, so the live
tree is often `$HOME/.local/opt/<dir>/lib/node_modules/@deepseek-ai/dsh` while
`npm root -g` names another prefix. The script tries, in order:

1. `DSH_PKG_ROOT`, the complete `.../@deepseek-ai/dsh` directory
2. `NPM_BIN`'s `root -g`, else the npm it resolved itself
3. the newest `$HOME/.local/opt/*/lib/node_modules/@deepseek-ai/dsh`
4. `$HOME/.npm-global/lib/node_modules/@deepseek-ai/dsh`
5. `$HOME/.local/lib/node_modules/@deepseek-ai/dsh`

The first candidate with a readable `package.json` wins. When none matches,
the run logs `dsh tree not found; DSH skipped` and continues, so the release
update is still performed and the exit status stays 0: a moved layout must not
fail the daily run (and its update banner) forever. A tree found outside npm's
global root is reported the same way and left alone, because
`npm install -g` cannot update it. npm-managed trees keep the full contract:
pinned digests, no automatic downgrade, verification and rollback on failure.

## Containers and other init systems

Set `RDSH_SYSTEMD_NO_RELOAD=1` to write the units without calling `systemctl`.
The command then reports `"systemctl": "skipped"` and the operator schedules
the script however that host wants. The same switch keeps the tests away from
the test runner's own systemd instance.

## What it does not do

- It does not update anything itself: the daily run is `sync-dsh.sh`, with the
  digest pinning, downgrade refusal, verification and rollback described in
  [RELEASING.md](RELEASING.md).
- It does not touch the installed binary, the DSH tree or the profile: those
  remain the sync script's job, and it still runs safely (nice 19, idle IO)
  under load.
- It does not enable the timer for other users or system-wide.
