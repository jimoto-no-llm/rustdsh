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
  [--resume <id>] [--trust-workspace] [--executable <path>] [--wait]
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
| `supervisor_lost` | The supervisor died without writing a result |

`submit` rejects bad input before creating a job (`invalid_runner`,
`invalid_permission`, `invalid_model`, `invalid_resume`, `invalid_project`,
`prompt_too_large`, `invalid_prompt`, `executable_not_found`,
`version_probe_failed`, `trust_workspace_unsupported`).

## Permissions

`--permission` defaults to `read-only`. This is the flag mapping of each CLI,
not an OS sandbox.

| `--permission` | cursor-agent | devin |
| -------------- | ------------ | ----- |
| `read-only` | `--mode ask` | `--permission-mode auto` |
| `edit` | no mode flag | `--permission-mode accept-edits` |
| `full` | `--force` | `--permission-mode dangerous` |

With cursor-agent `edit`, tools that need approval fail because `-p` cannot
ask. `full` lets the agent run any command with your user's rights. `--force`
and `dangerous` are passed only for `full`.

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

A detached supervisor (`node agent-runners.mjs __supervise <dir>`) runs the CLI
in the project directory in its own process group and writes `result.json`.
`status` reports a vanished supervisor as `failed` with `supervisor_lost`.
`cancel` sends SIGTERM to the agent's process group, SIGKILL after 5 seconds,
and returns only after the group is gone, with the state `cancelled`. A
descendant that left the group (for example with `setsid`) is not reached. On
Windows the tree is stopped with `taskkill /T`.

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
