# External agent runners (cursor-agent, devin)

`rdsh-dashboard agents` runs one non-interactive task in an external agent CLI
(`cursor-agent` or `devin`), reports its state and collects the result. It is
separate from the DSH ACP adapter in [CLI-ADAPTERS.md](CLI-ADAPTERS.md): neither
CLI is driven over ACP, and there is no session control beyond `--resume`.
Related: issues #472 and #473.

Use it as the execution target for a plan from `rdsh-dashboard subagents plan`
or a checkout from `rdsh-dashboard workers prepare`
([WORKER-WORKSPACES.md](WORKER-WORKSPACES.md)): pass that checkout as
`--project`. The runner adds no scope enforcement of its own.

## Commands

Run these commands from the repository's dashboard directory:

```sh
node cli.mjs agents list [--probe]
node cli.mjs agents submit --agent cursor-agent|devin --project /path/to/repo \
  --prompt-file task.txt [--model <name>] [--permission read-only|edit|full] \
  [--resume <id>] [--trust-workspace] [--executable <path>] [--entrypoint <script>] [--wait]
node cli.mjs agents status <job_id>
node cli.mjs agents result <job_id>
node cli.mjs agents cancel <job_id>
```

All commands print one JSON document. `list` shows the catalog and recent jobs;
`--probe` also runs `<cli> --version` and the login check. `submit` returns
immediately with the job ID unless `--wait` is given. `--wait` prints the result
and exits with 1 unless the job succeeded.

The executable comes from `--executable` or a PATH lookup. Its real path and
`--version` output are recorded in the job. Processes are started from argv
arrays; no shell is involved. The parent environment is passed through because
the CLIs need `HOME` for their own login; the runner adds no secrets and never
reads credential files. The login check uses only the exit code and the text
`Logged in` (`cursor-agent status`, `devin auth status`) and stores a boolean.

`--entrypoint <script>` (an existing regular file; its real path is recorded in
the job) makes every launch run `<executable> <script> <args...>`: the version
probe and the agent run itself. On Windows a Node-based CLI is launched with
`--executable <node> --entrypoint <script>`, because shebang scripts and `.cmd`
shims are not run directly. Real Windows CLIs are untested. `list --probe`
takes no entrypoint, so a Windows CLI that needs one is reported as not found
or without a version there; `submit` is unaffected.

## Display language and UTF-8 input

Use `--language en|zh-CN|ja` before or after `agents` to select human-facing help and diagnostics. The dashboard language precedence also applies here. JSON keys, canonical job states and error codes, agent output, paths and caller text remain unchanged. Prompt files are UTF-8; Japanese filenames and instruction text are supported. Unknown external errors retain their original message. Locale tests run local fake agents and never submit paid provider requests. Real CLI authentication, provider behavior and billing require separate acceptance.

## Job states and error codes

States: `queued`, `running`, `succeeded`, `failed`, `cancelled`. A failed job
carries a `code`:

| Code | Meaning |
| ---- | ------- |
| `nonzero_exit`, `terminated_by_signal` | The CLI exited with an error or was killed |
| `agent_error` | cursor-agent reported `is_error: true` |
| `invalid_json`, `invalid_output` | cursor-agent output was not the expected JSON result |
| `output_too_large` | cursor-agent output exceeded 1 MiB |
| `workspace_untrusted` | devin refused an untrusted workspace |
| `spawn_failed`, `prompt_unreadable` | The supervisor could not start the CLI |
| `supervisor_init_failed` | The supervisor failed while setting up after the CLI started (for example a `job.json` write error); it stopped the CLI itself and `cleanup` says whether that was confirmed |
| `output_write_failed` | Writing the CLI's `stdout`/`stderr` to the job directory failed; the CLI was stopped |
| `supervisor_lost` | The supervisor died without writing a result (the agent may still be running; use `cancel`) |

`submit` rejects bad input before creating a job (`invalid_runner`,
`invalid_permission`, `invalid_model`, `invalid_resume`, `invalid_project`,
`prompt_too_large`, `invalid_prompt`, `executable_not_found`, `invalid_entrypoint`,
`version_probe_failed`, `trust_workspace_unsupported`).

## Permissions

`--permission` defaults to `read-only`, which selects the most restrictive mode
each CLI offers. The levels are mappings onto the CLI's own flags. The runner
does not enforce them at the OS level and cannot verify what the CLI actually
allows; "read-only" is the name of the level, not a guarantee.

| `--permission` | cursor-agent | devin |
| -------------- | ------------ | ----- |
| `read-only` | `--mode ask --sandbox enabled` | `--permission-mode auto` |
| `edit` | no mode flag | `--permission-mode accept-edits` |
| `full` | `--force` | `--permission-mode dangerous` |

With cursor-agent `edit`, tools that need approval fail because `-p` cannot
ask. `full` lets the agent run any command with your user's rights. `--force`
and `dangerous` are passed only for `full`.

Known gaps in `read-only`:

- cursor-agent: `--mode ask` alone has been reported not to be an enforced
  boundary in some versions (terminal commands still ran;
  <https://forum.cursor.com/t/ask-mode-terminal-commands/164600/16>). The runner
  therefore also passes `--sandbox enabled`, the CLI's own sandbox switch. The
  CLI version is recorded in the job, but no version is allowed or rejected,
  and the effect of the combination is not independently verified.
- devin: `--permission-mode auto` reads freely and asks before writes and shell
  commands, but allow rules in your own devin configuration still apply, and
  in `-p` mode an approval prompt is not something a person answers. devin's
  `--sandbox` (research preview) lets commands write inside the workspace, so
  it is not a read-only boundary and is not passed.
- Neither CLI is confined by the runner: both run with your user's rights in
  the project directory. For untrusted tasks use a throwaway checkout
  (`rdsh-dashboard workers prepare`) or a container or VM.

## cursor-agent

Command: `cursor-agent -p --output-format json --trust --workspace <project>
[--model <m>] [--resume <chatId>] <permission flags> <prompt>`.

cursor-agent accepts the prompt only as a positional argument, so the prompt is
visible in the process list while the job runs. The runner limits it to
100 KiB (`prompt_too_large`), never logs it and never stores it in `job.json`
(only `prompt.txt`). A prompt beginning with `-` gets one leading space so it
is not read as an option. Do not put secrets in prompts.

The result is the single JSON object the CLI prints. The runner returns the
`result` text, `session_id`, `duration_ms` and token usage.

## devin

Command: `devin -p --prompt-file <job>/prompt.txt --permission-mode <m>
--export <job>/export.json [--model <m>] [--resume <id>]`. The prompt is read
from the file, never from argv.

The result is the plain stdout text plus, from the ATIF export, `session_id`,
`model_name` and the number of steps. A missing or unparsable export does not
fail the job; it reports `export: "unavailable"`. The full export stays in the
job directory.

Devin refuses to run in a directory it does not trust and prints `Refusing to
run in an untrusted workspace`; the job fails with `workspace_untrusted`
(the raw stderr stays in the `stderr` file). Passing `--trust-workspace` to
`submit` adds `--respect-workspace-trust false` for that job. Use it only for a
project you chose and reviewed; it is rejected for cursor-agent.

## Job directory

Jobs live under `<state home>/agent-jobs/<job_id>/` (`RDSH_DASHBOARD_HOME`
selects the state home). The directory is mode 0700 and its files are 0600.

| File | Content |
| ---- | ------- |
| `job.json` | ID, runner, project real path, model, permission, resolved executable and version, PIDs, state. Never the prompt |
| `prompt.txt` | The task text |
| `stdout`, `stderr` | Raw output, each capped at 1 MiB |
| `export.json` | devin's ATIF export, if written |
| `result.json` | Written atomically when the job ends: state, code, exit code or signal, parsed result |

The state home is resolved to an absolute path at use, so a relative
`RDSH_DASHBOARD_HOME` does not change what the supervisor or devin
(`--prompt-file`, `--export`) opens.

A detached supervisor (`node agent-runners.mjs __supervise <dir>`) runs the CLI
in the project directory in its own process group and writes `result.json`.
`status` reports a vanished supervisor as `failed` with `supervisor_lost`; the
agent may still be running then, and `agent_pgid` stays in `job.json`.

## Stopping processes

One routine stops the agent's process group, both when a job ends (success or
failure) and on `cancel`: SIGTERM, a grace period, SIGKILL, then a check that
the group has no live member. `result.json` records the outcome as `cleanup`
(`status` and `result` show it, plus `agent_group_alive`): `confirmed` when the
group was verified gone, `unconfirmed` when it was not. An `unconfirmed` job
is not a clean end; the leftover processes can still be stopped with `cancel`.

On Linux a group counts as alive only if some member in `/proc/<pid>/stat` is
not a zombie, so zombies that a container without a reaping PID 1 keeps around
do not block a stop. Only `ENOENT`/`ESRCH` (the process vanished) counts as
gone while scanning; `EACCES`, other I/O errors and unparsable content make
the answer "unknown", and unknown is treated as possibly alive: the check
falls back to `kill(-pgid, 0)` and only `ESRCH` there proves absence. An
unreadable `/proc` therefore ends as `cleanup: unconfirmed`, never as a
confirmed stop. Elsewhere (macOS) the check is `kill(-pgid, 0)`; launchd
normally reaps orphans there.

On Windows the runner cannot confirm that descendants stopped: there are no
process groups and no Job Object support, so only the leader PID is
observable. While the leader is alive, the stop runs `taskkill /PID <leader>
/T /F` (awaited); once the leader has exited the remaining tree cannot be
observed. Cleanup is therefore always reported `unconfirmed`, with
`cleanup_code: windows_tree_unobservable` (or `windows_taskkill_failed` if
`taskkill` itself failed). `cancel` on such a job kills the leader tree only
while the leader is alive, never signals by number once the leader identity no
longer matches, and does not promote the result to `confirmed`.

### Cancel and ownership of the group number

A process group number is only a number: once the group is gone it can be
reused by an unrelated group (or after a reboot). The supervisor therefore
records `agent_identity` (the leader's `process-identity` record: start time
and boot/namespace scope on Linux, Windows and macOS; `null` where unavailable) in
`job.json`, and `cancel` follows these rules:

- A terminal job whose result has `cleanup: confirmed` is a pure no-op:
  no signal, and the number is not even probed (`agent_group_alive` is
  reported as `false`).
- A running job is cancelled through its supervisor. `cancel` writes the
  `cancel` file and the supervisor, which holds the child handle, stops the
  group and writes the result. This works on every platform, including macOS.
- Anything sent by number from outside the supervisor (`supervisor_lost`, or
  leftover processes of a finished job) first needs ownership:
  - leader identity matches: owned, the group is stopped (TERM, then KILL);
  - identity belongs to another incarnation (`pid_reused`): nothing is sent;
    the result becomes `cleanup: unconfirmed` with `cleanup_code: pgid_reused`
    and `cancel` returns that state;
  - anything else, including leader gone (even if members remain), no recorded
    identity or no identity support: nothing is sent; the result gets
    `cleanup: unconfirmed` with `cleanup_code: ownership_unknown` and `cancel`
    fails with `cancel_unconfirmed`.

After the leader exits, leftover descendants are reaped only by the live
supervisor, which stops the group (TERM, then KILL) immediately by its own
group number; it has watched the group without a gap, so the number cannot have
been recycled. If the supervisor is also gone, `cancel` never signals the
group, because surviving members do not prove it is still the job's group.
Stop them manually; the job's group number is recorded as `agent_pgid` in
`job.json`.

macOS: the process identity is read through `libproc` (see
`dashboard/darwin-process-identity.mjs`), so a lost supervisor's group can be
stopped by `cancel` like on Linux. Where no identity can be read, `status`
shows `supervisor_lost` with `cleanup_code: ownership_unknown` and the group
has to be stopped by hand.

When ownership holds and the group is gone, `cancel` returns only then,
otherwise it fails with `cancel_unconfirmed`. A running job ends as
`cancelled`; a `supervisor_lost` job (which never reported an outcome) also
becomes `cancelled`; a job that had already succeeded or failed keeps that
state and gets `cleanup: confirmed`. A descendant that left the group (for
example with `setsid`) is not reached.

## Security notes

- This is not a sandbox. The agent runs with your user's rights in the project
  directory; `full` removes the CLI's own approval prompts.
- `result` output is untrusted data (`provenance: "untrusted_data"`). ANSI
  sequences and control characters other than newline and tab are removed and
  the text is limited to 256 KiB. Do not execute it or treat it as instructions.
- Raw output files may contain anything the agent printed, including file
  contents. Keep the state directory private.
- Out of scope: Cursor cloud agents, Devin Cloud, MCP approval automation and
  estimating either vendor's quota or billing.
