# Local integration queue

Issue #22 adds an opt-in **local operator CLI** for integrating committed worker
changes in a fixed order. The dashboard browser, HTTP handlers and MCP tools
cannot register, apply or run this queue. Its private registry and dedicated Git
worktree live under `<project-state>/integration/`, outside the source repository.
Source checkouts, worker branches, dirty files and remote refs are retained.

## Define the complete checks

Create a trusted local JSON file containing the project's full validation suite.
Each check has an absolute executable, literal argument array, related tracked
inputs and a timeout between 500 and 600000 milliseconds. A queue's suite is
immutable; a partial test or an operator-reported pass cannot replace it.

```json
{
  "checks": [
    {
      "id": "full-tests",
      "description": "Complete project test suite",
      "inputs": ["package.json", "package-lock.json"],
      "argv": [
        "/absolute/path/to/node",
        "/absolute/path/to/npm-cli.js",
        "test"
      ],
      "timeout_ms": 600000
    }
  ]
}
```

Use the actual full source HEAD and current registry revision from `inspect`.
An uninitialized registry has revision zero. Windows paths are absolute JSON
strings such as `"C:/Tools/node.exe"`.

```sh
node dashboard/cli.mjs integration inspect --project /path/to/repo
node dashboard/cli.mjs integration init --project /path/to/repo \
  --input-file /private/full-checks.json --expected-revision 0 \
  --expected-head <full-source-sha>
```

`init` creates a dedicated `codex/integration-<uuid>` branch and worktree at that
commit. It records provisioning before Git starts, uses an empty checkout-hook
directory and registers acceptance definitions. It executes no checks and
publishes nothing. A failed or interrupted provisioning record retains any
branch/files already created and never claims a ready checkout.

## Register fixed committed sources

The enqueue input names a label and full immutable base/head commit IDs from the
same repository. The base must be an ancestor of both the source and integration
target. The head must contribute commits not already in the target. Duplicate
source heads are rejected. Moving a worker branch later does not change its
queued source. Uncommitted worker edits are not included.

```json
{
  "label": "worker-a",
  "source_base_sha": "<full-worker-base-sha>",
  "source_head_sha": "<full-committed-worker-sha>"
}
```

```sh
node dashboard/cli.mjs integration enqueue --project /path/to/repo \
  --input-file /private/worker-a.json --expected-revision <current-revision>
```

Registration appends a monotonically numbered entry. It changes only the private
registry: no integration, command dispatch or push occurs.

## Apply one entry, then validate the resulting commit

```sh
node dashboard/cli.mjs integration apply --project /path/to/repo \
  --expected-revision <current-revision> --expected-head <current-target-sha>
node dashboard/cli.mjs integration inspect --project /path/to/repo
node dashboard/cli.mjs integration validate --project /path/to/repo \
  --expected-revision <new-revision> --expected-head <integrated-target-sha>
```

`apply` always selects the earliest queued entry. Git computes a three-way merge
tree without editing worker/source checkouts. A successful integration records a
local merge commit whose parents are the previous integration target and exact
queued source. Only the dedicated integration branch advances. Before and after
commit IDs and sequence remain in the registry. Checkout hooks and signing are
disabled for these local operations. Dirty, missing or reassigned integration
checkouts block application and their files are retained.

After each successful integration, **every declared full check must pass for
that exact target before the next entry can apply**. `validate` explicitly runs
the trusted argv via the existing acceptance runner, in the integration worktree.
It keeps a fresh private home and stripped environment, records intent before
dispatch, and retains exit status, stdout/stderr hashes and code/environment
observations. A failed check stays failed even when the other checks pass.
Each retry runs the entire suite again; passes from separate attempts cannot
be combined. `inspect` never runs tests.

Inspection reports the target, next sequence, failure reason, retryability and
each check's evidence. `ready_for_review` requires every registered entry to be
integrated and the latest entire validation attempt to remain verified. It does
not mean human approval, production adoption or permission to publish.

## Conflicts, changed targets and interruption

Merge conflicts retain their paths and exact source/target IDs. No target commit
is changed, and later entries cannot skip the conflict. `apply` can retry that
same fixed source when inspection says `next_integration.retryable`. To withdraw
a queued/conflicted item, supply `{"reason":"Why this source is withdrawn"}`
with `integration reject --input-file ... --expected-revision ...`. Rejection is
recorded explicitly; a queue containing rejected entries never reports that all
sources were integrated.

A new target commit, dirty checkout, changed command/evidence or changed code
observation invalidates the old pass. An operator's committed correction must
first be acknowledged with `integration retarget --expected-revision ...
--expected-head ...`. It requires a clean descendant on the same integration
branch, publishes nothing, and requires a fresh complete validation run.

The registry has a private exclusive writer lock, revision checks, bounded strict
schema and flushed atomic replacement. Git/validation intent is persisted before
mutation or execution. A process interruption leaves unconfirmed evidence; it
never automatically repeats an integration or test whose outcome is unknown.
Old locks are not reclaimed by elapsed time. Corrupt or linked registries are
rejected without replacement. Retained partial work requires operator inspection;
there is no destructive cleanup/reset operation.

## Authority and scope

Use this CLI with locally trusted source code, Git configuration and validation
argv under the existing native execution policy. Checks and Git merge
drivers/filters can execute local code; the queue is not an OS sandbox. The suite
declares what is checked and cannot prove that the operator chose every required
test. Ignored build outputs are not acceptance inputs. Native DSH tool policies
and sandbox restrictions remain the authority for executing user code.

There is no queue action for merging into `main`, pushing, changing protection or
publishing a release. Those decisions and credentials remain separate. This
module reuses acceptance evidence; it does not add an agent loop, profile boot,
provider calls, worker launcher or browser execution endpoint.

`dashboard/test/integration.test.mjs` exercises actual disposable Git worktrees,
fixed source heads, ordered merges, conflict/rejection, complete-suite retries,
commit/dirt changes, deadlines/interruption, concurrent writers, corrupt/linked
storage, evidence tampering and the public CLI. No model or provider is used.
