# Automatic provider-model refresh

[`rdsh models sync`](MODEL-ROUTING.md) learns what a provider advertises and writes
the missing or stale entries into a profile. `rdsh models auto` is the schedule
around it: one refresh per interval, in the background, without a launcher
release and without the operator remembering the command.

```sh
rdsh models auto --json          # apply the schedule once and report it
rdsh models auto --force         # refresh now, even inside the interval
rdsh models auto --dry-run       # show what would change, write nothing
```

The launcher calls the same policy on every boot: it reads a small state file,
and when the interval has elapsed it starts a detached
`rdsh models auto --quiet` that does the network work after DSH has launched.
A boot therefore never waits for a provider, and a provider that is slow,
unreachable or logged out cannot stop the launch.

## Controls

| Control | Effect |
| --- | --- |
| `features.models_auto` in `rdsh.json` (default **on**) | `rdsh features off models_auto` stops both the background refresh and `rdsh models auto` |
| `RDSH_NO_MODELS_AUTO=1` | Same veto, without editing settings; useful for CI and for hosts that must never call a provider |
| `RDSH_MODELS_AUTO_INTERVAL_HOURS` | Interval in hours (default 24, clamped to at least 1) |
| `--dry-run` on a launch | No hook runs at all; the launch prints its command and stops |
| `rdsh models auto --force` | Ignores the interval once (a timer or a manual run) |

`rdsh features` reports the effective value, and
[the settings guide](RDSH-SETTINGS.md) lists the switch with the others.

## State

`$DSH_HOME/cache/rdsh-models-auto.json` records the last attempt:

```json
{
  "schema": 1,
  "last_attempt_unix": 1791926530,
  "last_success_unix": 1791926530,
  "changed": false,
  "outcome": "ok",
  "detail": "2 profile(s), 1 added"
}
```

- `outcome` is `ok` or `failed`; `detail` is the same one-line summary the
  command prints.
- A missing, unreadable, oversized or malformed file counts as "never ran", so
  a broken state file can only cause one extra refresh, never a wedged schedule.
- `--dry-run` never writes the state: a preview does not consume the interval.
- The sibling lock (`rdsh-models-auto.json.lock`) serializes concurrent
  launches: the second one waits, sees the fresh state and exits.

## Profile writes

The refresh goes through the same safe rewriter as `rdsh models sync`: the
profile is replaced atomically and keeps the permissions it already had (a new
file starts at 0600). The first rewrite also copies the profile aside as
`cordis.patch.yml.bak-rdsh-models`, the same rule the context hook uses for
`hooks.json`; later rewrites never overwrite that copy, so the pre-rdsh file
stays recoverable. A backup that cannot be taken stops the write instead of
leaving the profile rewritten without one.

## Exit status and output

`rdsh models auto` exits non-zero when a provider listing could not be read, a
profile changed its endpoint or credential while fetching, or a profile could
not be read or written. The failure is recorded in the state and the next
attempt waits for the interval again. A profile layout that the safe rewriter
does not support is reported as skipped. `--json` prints one report:

```json
{
  "enabled": true,
  "ran": true,
  "reason": "due",
  "changed": false,
  "detail": "no profile carries a provider block",
  "failed": false,
  "summary": {"profiles": 0, "listed": 0, "added": 0, "renamed": 0, "written": 0, "skipped": 0, "failed": 0},
  "command": "models sync --json",
  "state_path": "/home/you/.dsh/cache/rdsh-models-auto.json",
  "state_error": null
}
```

`reason` is one of `due`, `dry_run`, `not_due`, `no_profiles` or
`disabled`. The background hook reports `no_profiles` when no eligible profile
has a `cordis.patch.yml`, including an empty profiles directory or one that only
contains the Desktop-owned profile.

## Scheduling it outside the launcher

The boot hook is enough for interactive hosts. A machine that should refresh
even while nobody launches DSH can run the same command from a timer:

```ini
# ~/.config/systemd/user/rdsh-models-auto.service
[Unit]
Description=rdsh provider model refresh

[Service]
Type=oneshot
Nice=19
IOSchedulingClass=idle
ExecStart=%h/.local/bin/rdsh models auto --quiet
```

```ini
# ~/.config/systemd/user/rdsh-models-auto.timer
[Unit]
Description=Daily rdsh provider model refresh

[Timer]
OnCalendar=daily
RandomizedDelaySec=1800
Persistent=true

[Install]
WantedBy=timers.target
```

`systemctl --user enable --now rdsh-models-auto.timer` starts it; the interval
still applies, so a timer that fires more often than the interval does nothing.
On Windows, a Task Scheduler entry running `rdsh models auto --quiet` plays the
same role.

## What it does not do

- It never deletes a model entry and never rewrites a profile that the provider
  selection cannot parse: the sync reports a skip instead.
- It does not refresh the harness's bundled catalog, so a provider that the
  running DSH build cannot address still needs a DSH update.
- It does not apply to the Desktop (Electron) application's reserved profile,
  which rdsh never edits.
- An applied refresh reaches the model picker on the next config reload or DSH
  restart; the command says so when something changed.
