# Worker scopes and worktree leases

`rdsh-dashboard workers` allocates a Git checkout and branch for each worker,
records its read/write scope and reports conflicts before and after editing.
Use the existing DSH worker/runtime with the resulting checkout. This command
does not start a model or change a DSH profile. It adds no browser or MCP tools.

## Declare and allocate

The project must be a Git repository root with a committed HEAD. Save a local
operator-owned declaration as `worker.json`:

```json
{
  "worker_id": "dashboard-editor",
  "role": "edit",
  "read_paths": ["."],
  "write_paths": ["dashboard", "tests"],
  "modules": ["dashboard"],
  "forbidden_paths": ["dashboard/package-lock.json", "tests/e2e/package-lock.json"],
  "lease_seconds": 3600
}
```

Scopes are repository-relative path prefixes. They accept files and directories,
with `.` meaning the repository root. Absolute paths, traversal, backslashes and
globs are rejected. A forbidden prefix takes precedence over write permission.
Writing Git metadata is excluded. Each write prefix must also be readable.
Worker IDs use lowercase letters, digits and hyphens, starting with a letter.

```sh
node dashboard/cli.mjs workers plan --project /path/to/repo --input-file worker.json
node dashboard/cli.mjs workers prepare --project /path/to/repo --input-file worker.json \
  --expected-revision 0 --expected-head <source.head_sha-from-plan>
node dashboard/cli.mjs workers inspect --project /path/to/repo
```

Use the actual `revision` and `source.head_sha` returned by `plan`. Changed
registry revisions and changed source commits require a fresh plan. Editing
scopes are compared against allocated workers and source checkout changes.
Common configuration and lockfiles receive a separate conflict reason. A
conflict blocks allocation; the plan lists the worker/path that needs attention.

All source changes are reported in `source.dirty_paths`, including untracked
files. Changes outside the new worker's write scope can remain in the original
checkout. The worker starts from the specified committed HEAD; uncommitted
source changes are retained in place. The record keeps the source observation
from before allocation and returns an observation after it.

Each worker receives a new `codex/worker-...` branch and a separate checkout
under the project's dashboard state directory. Configure `RDSH_DASHBOARD_HOME`
to choose that state location; it must be outside the source repository and
its Git metadata. Existing worker IDs and checkout paths are retained and cannot
be overwritten. Use a new worker ID for a new allocation.

For review workers, set `"role": "review"` and omit `write_paths` or set it to
`[]`. Supplying a write scope is rejected. A scan reports any observed review
edits as scope violations. The declaration and Git scan cover assignment and
diagnostics; DSH's native tool policy and the execution sandbox provide runtime
enforcement. Select a matching read-only native policy when launching a reviewer.

## Scan changes and retain work

`inspect` is read-only. It reports source checkout changes, each worker's actual
HEAD/branch, uncommitted paths, committed paths since its allocated base, scope
violations and overlapping changes across workers or the source checkout. Rename
and delete paths remain visible. Shared lock/config changes are detected even
when two workers declared different source modules and then wrote outside them.
Unavailable or reassigned checkouts have `tree.status: "unavailable"` and
`tree.dirty: null`; they do not supply a clean-tree result.

Lease state and checkout state are independent. An expired lease can retain
uncommitted files, committed changes or an unavailable checkout. Expiry keeps
the worker's scope allocated and performs no cleanup. After inspection, renew
or explicitly release the lease using the current registry revision:

```sh
node dashboard/cli.mjs workers renew --project /path/to/repo \
  --worker-id dashboard-editor --lease-seconds 3600 --expected-revision 2
node dashboard/cli.mjs workers release --project /path/to/repo \
  --worker-id dashboard-editor --expected-revision 3
```

Release records the operator's decision to end the allocation. The checkout,
branch and all changes are retained, and its dirty/changed paths remain in
inspection. A later plan warns about overlapping scopes of released workers;
review retained changes before allocating overlapping work again. Release
does not stop a running DSH process or establish integration success.

The registry uses a private writer lock, revision checks and a flushed atomic
replacement. It records provisioning before Git starts. An interrupted or failed
checkout operation retains a `provision_failed` or `provisioning` record and any
files/branch Git created; inspect it before further work. An existing writer lock
blocks mutations and is never reclaimed based on elapsed time. Corrupt or linked
registry files are rejected without replacement. Assignment uses an empty
checkout-hook directory.

## Integration and verification

This CLI grants no merge/push authority and has no cleanup operation. Run the
existing DSH worker in the allocated `worktree`, with its native policy matching
the declared role. Scans expose work to integrate and validate separately;
integration order and validation belong to the integration queue in issue #22.

The current upstream subagent service owns provider capabilities, child sessions,
working-directory inheritance and tool filters. It remains the execution owner:
[upstream subagent contract](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/docs/subsystems/subagent.md).
The old proposal's fork document is currently unavailable; no runtime feature
is inferred from that missing source.

`dashboard/test/workers.test.mjs` uses actual disposable Git repositories,
branches and worktrees. It covers assignment, source changes, overlap warnings,
shared lockfile changes before/after editing, committed changes, review scope,
expiry/renew/release retention, stale source/revision, conflicting allocators,
missing checkout, corrupt/locked storage and the existing Node CLI. No provider,
model or external repository is used by these tests.
