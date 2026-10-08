# Checkpoints and native recovery choices

A checkpoint binds a ledger run and native CLI session to its current canonical
cwd, Git root/branch/HEAD, native-home scope, selected executable/entrypoint,
last durable event, last acknowledged event and save time. It records unfinished
control operations and optionally references exact retry-operation IDs. It does
not copy a conversation, infer missing context or replay native operations.

## Record and inspect

```sh
node dashboard/cli.mjs checkpoint record --project /workspace/project \
  --run-id run_00000000-0000-0000-0000-000000000000 \
  --executable /absolute/path/to/original-dsh
node dashboard/cli.mjs checkpoint list --project /workspace/project
node dashboard/cli.mjs checkpoint inspect --project /workspace/project \
  --checkpoint-id cp_00000000-0000-0000-0000-000000000000 \
  --executable /absolute/path/to/original-dsh --verify-native
```

Use IDs returned by the session ledger and checkpoint command. Node entrypoints
also require `--entrypoint /absolute/path/to/bin.js` with the Node executable.
Repeated `--retry-operation-id op_<uuid>` flags on `record` bind explicit external
operations from this project's retry history. These references are selected by
the operator; unreferenced external work is not silently inferred or reconciled.

Default inspection reads local records and never launches a profile or repeats
a control command. `--verify-native` explicitly starts a temporary owned ACP
client, negotiates the pinned DSH version and queries the advertised
`session/list` API. It creates no session, sends no prompt, then stops that owned
root. Session titles, peer error text and conversation content are not retained.
Pagination is limited to twenty pages, 5,000 IDs and one request-time budget.
Malformed frames, duplicate IDs and cursor loops fail closed.

The current context, journal prefix, original process ownership and referenced
external outcomes must be observable before native verification is attempted.
A live or unobservable old root, unfinished dispatched control request, stale
writer, journal repair requirement, missing checkpoint event, changed home,
branch/HEAD or moved/unavailable cwd blocks recovery with a specific reason.
Independent Git work or a moved project is not silently rebound to the old
session. Project-state migration remains a separate operation.

## The three choices

| Candidate           | Meaning                                                                                                       |
| ------------------- | ------------------------------------------------------------------------------------------------------------- |
| `formal_resume`     | The current native list contains the exact ID/cwd and advertises resume; the actual resume still must succeed |
| `summary_start_new` | A deliberate new conversation with an operator-supplied summary and explicit context-loss choice              |
| `unavailable`       | A blocking context, ownership, history or outcome uncertainty must be resolved first                          |

A missing item in a complete session list is reported as `not_listed`.
ACP does not establish whether it was deleted, expired or omitted by the agent.
Unavailable listing and unsupported resume are distinct observations. Listing
does not acknowledge resume; `native.resume_verified` stays false until the
actual native request succeeds. Protocol support or a session ID alone does not
establish a running model, valid credentials or intact external dependencies.

The [official ACP lifecycle](https://agentclientprotocol.com/protocol/v1/session-setup)
requires a negotiated resume capability. `session/resume` restores the requested
session without replaying its conversation; no guessed file format or second
agent loop is used here. Checkpoint recovery invokes only the selected original
DSH. The six public adapter operations and MCP tool inventory are unchanged.

This checkpoint marks durable control evidence; it does not force the native
CLI to snapshot or roll back its conversation at that timestamp. Formal resume
uses the context the original CLI actually persisted. Control events added
since the checkpoint are counted separately; unsaved native messages and the
extent of any lost conversation remain unknown.

## Resume the same session

```sh
node dashboard/cli.mjs checkpoint resume --project /workspace/project \
  --checkpoint-id cp_00000000-0000-0000-0000-000000000000 \
  --executable /absolute/path/to/original-dsh
```

The command rechecks native availability and context, flushes recovery intent,
calls the ledger's native resume, confirms the original session ID, records the
native acknowledgement and stops its owned root. It sends no prompt. Success
means attachment and owned-root exit were observed, not task completion.

## Deliberately begin a new conversation

```sh
node dashboard/cli.mjs checkpoint start-new --project /workspace/project \
  --checkpoint-id cp_00000000-0000-0000-0000-000000000000 \
  --executable /absolute/path/to/original-dsh \
  --summary-file /absolute/path/to/operator-summary.txt --accept-context-loss
```

Both flags are required. The existing session may still be available: the
operator can choose a new conversation deliberately. The summary must be a
nonempty UTF-8 regular file of at most 65,536 bytes. It is an explicit operator
prompt, not a system policy or generated recovery instruction. The checkpoint
cannot fill in lost messages, tool state, external dependencies or unrecorded
side effects. Review those gaps before choosing this mode.

The command creates a distinct ledger run/native session, persists its reference
to the source checkpoint, then sends that exact summary once through the native
ACP adapter. It checks the original repository context and control history again
before sending. The action stores the summary's digest and byte count, never its
body. A native prompt response is `response_observed`; it does not prove semantic
acceptance of the summary. The root is stopped after the observed response.
This command can invoke the configured native model; it is not a credential-free
diagnostic. No model request is needed for record, list or formal resume.

The operator's explicit request authorizes this one native prompt. Recovery
does not add permission to old operations or native tools. Original DSH remains
responsible for its model/tool behavior; ACP client filesystem, terminal and
permission requests remain denied. This component does not supply an OS sandbox
or attest arbitrary native side effects.

## Uncertain effects and durable storage

Unacknowledged dispatched control commands block both recovery modes. Referenced
external writes with unknown certainty also block them. A trusted reconciliation
that confirms an operation applied permits recovery without resending it.
An original prompt acknowledgement is a control fact, not proof of every tool's
external outcome. Missing external dependencies and unreferenced operations
remain explicit limits of the checkpoint, never evidence of completion.

Checkpoint snapshots are immutable private files with a project ID, schema and
checksum. The referenced event ID/hash must remain in the validated run journal.
The checksum detects corruption; it is not an authorization credential.
Each recovery has a separate private action record and exclusive per-checkpoint
lock. Intent is flushed before creating/resuming a session. The new run/native
ID is flushed before summary delivery. Actions and snapshots are each bounded
to 128 KiB; lists return at most one hundred snapshots with a truncation flag.
The full journal determines unfinished-command counts even when the checkpoint
only retains the latest one hundred unfinished references.

One checkpoint admits one recovery action. Repeating a completed request returns
historical IDs and status without a new native query or prompt. It is not a fresh
availability observation. Use a fresh checkpoint for another deliberate recovery.
A crash, missing acknowledgement, failed persistence or failed cleanup leaves
the action unconfirmed and prevents automatic retry. A lost summary response can
already have produced an external effect; it is never resent automatically.
Surviving locks are visible and never stolen. Corrupt or unknown-schema data is
preserved and rejected. Reads restore evidence without restarting anything.
File flushing and process fixtures do not establish power-loss durability.
