# Project-scoped pinned updates (#47)

The local dashboard CLI captures a compatible runtime once, verifies it in one
canary project, and explicitly selects it for further projects. A project's
default applies to new runs. Each managed run separately keeps its original
Node/CLI/adapter/DSH artifact and native session binding through updates and
rollback. No global install, release workflow or update notification is changed.

## Capture trusted runtime code

Use an existing original DSH installation and its Node executable, not the Rust
launcher or a shell shim. A stage input is a small local JSON file:

```json
{
  "executable": "/absolute/node/bin/node",
  "dsh_root": "/absolute/node/lib/node_modules/@deepseek-ai/dsh",
  "entrypoint": "lib/bin.js",
  "adapter_root": "/absolute/rustdsh",
  "changes": "Describe the concrete CLI/adapter/plugin changes being tested",
  "rollback": "Requalify the previous project release ID and select it again",
  "provenance": "Operator-selected code installation; describe its source"
}
```

```sh
node dashboard/cli.mjs release stage --input-file candidate.json
node dashboard/cli.mjs release inspect --project /projects/alpha
```

`executable`, `dsh_root` and `adapter_root` must be absolute. The roots are an
explicit trust decision: staging executes the specified Node `--version`, and
qualification executes the captured DSH and adapter. Staging is not an automatic
download, signature verification, updater or untrusted-code sandbox.

The slot contains its Node binary, original packaged DSH and dependencies, the
dashboard runtime modules/dependencies, and the two managed plugins. Source
tests, evidence, `.git`, `.bin` links, project code, native homes, credential files,
runtime keys and event state are excluded. Symlinks and nonregular code files
are refused; use a materialized package installation. Only the packaged runtime
is captured. Existing user profile/configuration and external plugins remain
external configuration; their contents are not claimed to be pinned or qualified.

Each release has a SHA-256 identity over its full manifest: file paths, lengths,
read-only/executable permissions, checksums, tuple and change/recovery notes.
The same version string can identify different code builds; inspect their release
IDs and change notes. Provenance text is operator-declared, not independently
verified publisher identity. Current supported tuple:

| Component            | Contract                                     |
| -------------------- | -------------------------------------------- |
| Local dashboard CLI  | `0.1.0`, captured source/dependencies        |
| ACP adapter          | `acp-stdio-v1`, captured source/dependencies |
| Original DSH         | `0.2.0-rc.2` only                            |
| Qualification plugin | `rdsh-release-probe`, contract 1             |
| Node                 | Exact captured binary/version, Node 22+      |
| Platform             | Exact OS and architecture                    |

A slot is limited to 1 GiB and 50,000 files (a 16 MiB manifest); the registry holds at most 100
releases, 5,000 project selections and 10,000 run pins. Slots are kept in
`RDSH_DASHBOARD_HOME/managed-releases/slots/rel_<sha256>` (or the existing default
state home). Files are read-only, copied rather than linked to mutable installs.
The configured state root is resolved canonically, including Windows case and
short-name aliases; links inside its slot hierarchy remain refused.
Managed launch/selection verifies every recorded byte and refuses extra files,
missing files, links and incompatible tuples. These checks establish bytes at
attachment/selection time; they are not protection against a privileged operator
altering a running process. Slots have no automatic deletion or global update.

## Verify one project, then widen explicitly

```sh
node dashboard/cli.mjs release canary --project /projects/alpha \
  --release-id rel_<sha256> --selection-revision 0
node dashboard/cli.mjs release inspect --project /projects/alpha
node dashboard/cli.mjs release promote --project /projects/beta \
  --release-id rel_<sha256> --selection-revision 0
```

Read the current **project selection revision**, not the global registry revision,
before changing its default. A first selection starts at 0. Only one project can
be a candidate's canary. No project default changes before qualification passes.
Additional projects require an explicit `promote` after that success. Failed or
unfinished qualification cannot be used to start new runs or promote elsewhere.
Their recorded observations remain available in `release inspect`.

Qualification re-execs the captured Node and CLI and imports the captured adapter.
It uses the original `--profile acp --patch <owned-file>` boot and original ACP
operations: start a session, observe the probe's native `llm` injection, confirm
the owned process exits, then resume exactly the same native ID in a second
process, observe injection again and confirm its exit. The probe only posts its
contract/Node/platform identity to an ephemeral, scoped loopback callback. It has
no agent loop, stream interception or model request.

Its temporary home inherits no provider credentials. Results distinguish startup,
both plugin loads, same-ID resume, owned stops and cleanup. Provider auth, model
output/billing and Production adoption remain explicitly unverified. This base
profile check does not qualify every user's external profile/plugin configuration.
If cleanup is unconfirmed, its home is retained and no success is recorded.

## New runs and existing sessions

```sh
node dashboard/cli.mjs session-ledger start --project /projects/alpha
node dashboard/cli.mjs session-ledger resume --project /projects/alpha \
  --run-id run_<uuid>
node dashboard/cli.mjs reply-consumer once --project /projects/alpha \
  --run-id run_<uuid>
```

Managed commands omit `--executable` and `--entrypoint`; overrides are refused.
The CLI re-execs the slot's Node and CLI, with the selected/pinned artifact and
revision checked again inside that process. Budget enforcement remains an
explicit `--budget-guard --worker-id` choice and uses the captured budget plugin.
The existing reply consumer also dispatches through the captured CLI/adapter.
Managed dispatch refuses `NODE_OPTIONS`/`NODE_PATH` injection; resolve those
external code overrides explicitly before launching the pinned runtime. Staging
probes its Node version without inheriting these overrides.

A new run's pin is durably saved before budget/native session dispatch. The
original SessionLedger keeps its exact executable/entrypoint, home/config paths,
working tree, branch and native ID; none are rewritten to migrate a session.
An update selects a different default for subsequent runs while existing pins
still use their old slot. Resume never consults the new default as a fallback.
Unknown or legacy unpinned records retain the existing launch contract and receive
no automatic version guarantee. `release inspect` shows defaults and run pins;
managed attachment output distinguishes `new_run_project_default` from
`existing_run_pin` and reports the tuple/release ID.

Registry updates reload under an exclusive private lock and reject stale project
revisions. A selection change between plan and dispatch blocks new native work.
That rejected attempt can leave an unknown ledger record; it is not a started
session and is never silently retried. Missing/tampered slots and incompatible
runtimes require restoring the exact pinned bytes or waiting for a compatible
runtime. They never complete another run, kill an unrelated owner or redirect
resume. A crashed qualification remains `checking`; a lock records its owner PID.
Inspect ownership and unfinished work before manual recovery; no automatic stale
lock deletion or fabricated qualification is provided.

## Roll back with verification

```sh
node dashboard/cli.mjs release rollback --project /projects/alpha \
  --release-id rel_<previous-sha256> --selection-revision 2
node dashboard/cli.mjs release inspect --project /projects/alpha
```

The target must be a previous default for this project and its artifact must
remain available. Rollback repeats startup, both plugin loads, same-ID continuation
and owned-exit verification before changing the new-run default. Failure retains
the current default and records the failed result. Success appends a
`rollback_requalified` selection history entry and a `rollback` qualification.
Runs created under either release keep their own pins after rollback.

The Rust passthrough launcher, `sync-dsh.sh`, the global DSH install and ordinary
external CLI starts are outside this managed project/run contract. The existing
global update banner/release workflow is not duplicated. See the actual fixture
and native lifecycle evidence in [evidence/staged-updates](evidence/staged-updates/README.md).
