# Acceptance checks and evidence freshness

`rdsh-dashboard acceptance` keeps task reports separate from observed acceptance
checks. A task reported `done` remains unverified while any declared condition
has no current, intact, successful full check. The task schema and six project
MCP tools retain their existing contracts; this feature is an explicit local CLI.

## Declare and check conditions

Use an existing task ID and an exact Git project root. Store the input JSON files
outside the project so editing command arguments does not change the code target.
Each criterion has a unique ID, description and explicit project-relative inputs:

```json
[
  {
    "id": "required-result",
    "description": "The module returns the required result",
    "inputs": ["module.mjs", "check.mjs"]
  }
]
```

Define the conditions, then inspect missing checks:

```sh
node dashboard/cli.mjs acceptance define --project /absolute/project \
  --task-id task-qa --criteria-file /outside/criteria.json
node dashboard/cli.mjs acceptance inspect --project /absolute/project \
  --task-id task-qa
```

An argv file contains an explicit executable and arguments. The executable must
be absolute; the command uses the project as cwd, without a shell. For example,
`["/absolute/node", "check.mjs"]`. Commands are never read from task descriptions,
criterion text, images, or reported results.

```sh
node dashboard/cli.mjs acceptance run --project /absolute/project \
  --task-id task-qa --criterion-id required-result \
  --argv-file /outside/argv.json --scope full --timeout-ms 60000
```

The operator authorizes this one command by invoking `run`. Select an appropriate
test: successful execution does not prove its coverage or semantic sufficiency.
The runner passes only an OS/locale/path allowlist, an empty private home, isolated
DSH/dashboard home paths and `CI=true`. Provider credentials are not copied. This
environment filtering is not an OS sandbox; the selected program still has the
operator's filesystem and network access. Existing permission boundaries remain
in force. Native agents, model prompts and automatic retries are not involved.

`run` records `pass` for exit 0, `fail` for an observed nonzero exit code, and
`blocked` for unavailable code observations, a changed execution target, timeout,
or unconfirmed transport. The default deadline is 60 seconds, configurable from
500 milliseconds to 10 minutes. Timeout termination targets the owned root
process; descendant termination is not established. Inspect never reruns a test.

## Reports, partial results and images

For an external or agent report, supply a JSON object containing `status` and a
nonempty `reason`. Valid statuses are `pass`, `fail`, `blocked` and `not-run`:

```sh
node dashboard/cli.mjs acceptance report --project /absolute/project \
  --task-id task-qa --criterion-id required-result \
  --result-file /outside/result.json --scope partial
```

Reported results retain source `operator_reported`. A reported pass cannot set
`verified_full_check`. Full and partial histories have separate latest results;
a successful partial run cannot overwrite a failed or unexecuted full run.
Inspection lists every criterion, its missing/failed check, freshness reason,
original target, command metadata, exit code, timestamps and artifact integrity.

Optional repeated `--image relative/path.png` arguments copy up to four explicitly
selected PNG/JPEG payloads into the private evidence package. Files must stay
within the project and are limited to 8 MiB each. Signature checking identifies
the container only; it does not decode, render or visually review the image.
An imported image retains its code observation and import timestamp, while
`captured_at` is null and `capture_target_unverified` is explicit. Importing an
old image cannot certify when or against which version it was captured. Actual
screen capture and human visual acceptance require their own evidence.

## Current, stale and unknown

Before and after execution, the observer records Git HEAD/branch, hashes of the
declared inputs and nonignored worktree files, and OS/architecture/Node versions.
The acceptance storage itself is excluded. Observations require an exact Git
root with a committed HEAD. Inputs cannot escape the project, contain `.git` or
`.env` components, or be missing/ignored. Observation limits are 5,000 files,
64 MiB per file, 256 MiB total and bounded Git subprocesses.

| Observation after a check                                             | Current validity                       |
| --------------------------------------------------------------------- | -------------------------------------- |
| Same criterion, code target, environment and intact logs              | `current`                              |
| Changed criterion, HEAD/branch, related input or environment          | `stale`                                |
| Deleted or ignored required input                                     | `stale`; a new run is blocked          |
| Changed worktree outside declared inputs                              | `unknown`, `impact_scope_unknown`      |
| Unavailable Git/files, unstable execution target or incomplete record | `unknown`                              |
| Missing/modified command or evidence artifact                         | Ineligible pass, with integrity reason |

Revalidation records a new evidence ID and preserves old results. These hashes
are local before/after observations, not continuous filesystem attestation.
Ignored dependencies, external tools/services, hidden configuration and changes
that are reverted between observations are not proven unchanged. Include known
code/configuration dependencies in the declared inputs; inspect uncertainty
requires an explicit new check rather than borrowing an old pass.

## Persistence and truthful verification

Private project state contains `acceptance/index.json` and
`acceptance/evidence/evi_<uuid>/`. Intent is flushed before execution. Each package
has checksummed metadata, exact argv in private `command.json`, and copied stdout,
stderr and selected images. Public inspection returns metadata and private file
locations, without opening logs or returning command argument bodies.

Checksums detect accidental changes; they are not authentication against an
operator who can rewrite the private store. Logs and exact argv may contain
sensitive data: keep the evidence directory private and do not commit/export it.
Exclusive index locks serialize definitions and evidence references. Surviving
locks are not stolen, and incomplete records block verification without dispatch.
Corrupt metadata is preserved and rejected. Limits are 200 tasks, 50 conditions
per task and 2,000 evidence records per project.

`all_declared_full_checks_pass` requires the latest full record for every
criterion to be an observed local exit-0 execution against the current target,
with intact exact argv, stdout/stderr and any copied artifacts. `reported_done_with_verified_checks`
also requires the existing task report to be `done`. Human review and Production
adoption remain explicitly `not_assessed`; no task status is rewritten.

See [local before/after evidence](evidence/acceptance-evidence.md) and
[issue #39](https://github.com/sahenjp/rustdsh/issues/39).
