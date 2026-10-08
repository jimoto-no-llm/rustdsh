# Persistent CLI session ledger

The ledger links project, logical run, task and native CLI session identities.
Display labels are descriptive data and never select a resume target. Native
sessions and conversations remain in the CLI's own storage; rdsh does not copy
them or implement another agent loop.

## Identity and persistence

Each project has `sessions.json` beside its dashboard state. This is separate
from metric `session_id`, dashboard task reports and DSH's session database.

| Field                    | Meaning                                                                     |
| ------------------------ | --------------------------------------------------------------------------- |
| `project_id`             | Existing canonical-project identity from `state.mjs`                        |
| `run_id`                 | Allocated UUID, retained when that logical run is reattached                |
| `task_id`                | Explicit task link, or `null`; never inferred from a title                  |
| `cli` / `cli_session_id` | CLI name and its native session ID, or `null`                               |
| `cwd` / `branch`         | Canonical working directory and observed Git branch                         |
| `git`                    | Repository root, observed commit and context status                         |
| `provider`               | Optional operator-reported provider name; no authentication proof           |
| `launch`                 | Protocol, executable path, optional Node entrypoint and ACP profile         |
| `scope`                  | CLI home/config-directory paths; no credential contents or environment dump |
| `binding`                | `unknown`, operator `reported`, or native ACP `confirmed` identity          |
| `cli_version`            | Version observed during a confirmed attachment                              |

Missing IDs display as `不明` and remain JSON `null`. Missing provider, branch
and launch facts are also listed in `unknown_fields`. A confirmation concerns
the session identity, without claiming a live process, task completion or
valid provider authentication.

Writes reload the durable revision under an exclusive file lock and replace
the JSON atomically. Invalid schema, project mismatch or malformed JSON is
rejected without overwriting it. The ledger retains up to 5000 runs within an
8 MiB limit; it never silently drops older identities. A competing writer
gets `ledger_busy`. A lock left by an interrupted writer is preserved: inspect
its PID and remove that specific stale lock only after confirming the owner
has exited. Read-only resolution does not require the writer lock. This lock
protects ledger writes, without claiming ownership of native running sessions.

## Public CLI

```sh
node dashboard/cli.mjs session-ledger list --project /workspace/project
node dashboard/cli.mjs session-ledger record --project /workspace/project \
  --task-id task-42 --label 'same screen name'
node dashboard/cli.mjs session-ledger resolve --project /workspace/project \
  --run-id run_00000000-0000-4000-8000-000000000001
```

`record` allocates a new run ID. An optional `--session-id` is an operator
report, which stays `reported` until a native attachment confirms it. Two
records with the same task ID and label retain different run IDs and native
session links. `resolve` requires an exact run ID, never a label or task title.
An unknown native ID cannot be resumed.

DSH ACP lifecycle checks can create or reattach a native session, persist its
identity and then stop their own CLI process. They send no prompt:

```sh
node dashboard/cli.mjs session-ledger start --project /workspace/project \
  --executable /absolute/path/to/original-dsh --task-id task-42
node dashboard/cli.mjs session-ledger resume --project /workspace/project \
  --executable /absolute/path/to/original-dsh --run-id <recorded-run-id>
```

For a Node entrypoint, use `--executable /absolute/path/to/node` and
`--entrypoint /absolute/path/to/bin.js`. These are executable file paths;
arbitrary flags and shell command strings are not persisted. Each resume
requires explicit operator argv matching the record, the same CLI home/config
scope, compatible CLI version and unchanged working-directory/repository
context. It never checks out a branch or substitutes another session.
Detached HEAD resumes additionally require the recorded commit. A normal
branch can advance without changing its identity.
An unreadable Git repository is distinguished from a non-Git directory and
blocks attachment until its context can be observed.

A pending record is written before native session creation. If a start fails
or exits before confirmation is saved, its native ID remains unknown. A
failed resume keeps the previous reported/confirmed ID without claiming a new
successful attachment. CLI lifecycle output explicitly reports that the owned
ACP process has stopped.

## Adapter callers and verification

`attachRecordedSession({ ledger, command, env, task_id })` returns the recorded
identity and the live [version-checked adapter](CLI-ADAPTERS.md).
Passing `run_id` resolves that persisted native session and working directory.
The caller owns the returned adapter and must call `adapter.stop()` when
finished. Prompts, CLI output and credential values are not stored in the ledger.
Other CLI names can be recorded, but their launch and resume implementations
remain explicitly unsupported.

Fixture tests cover identical labels, unknown IDs, separate client processes,
changed launch/home/branch/version, concurrent writers, corrupt files,
immutable bindings and failed native operations. The
[command comparison and isolated real DSH restart](evidence/session-ledger.md)
record what was exercised, including the limits of provider authentication.
