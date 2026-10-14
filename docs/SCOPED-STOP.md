# Scoped staged stop

Managed ACP and Web profile launches own a kernel process group per run. DSH
retains its original argv, shipped profile, tools and agent loop. Input
cancellation, graceful exit, deadline termination and descendant verification
are distinct stages. A root exit alone cannot confirm a stopped run.

## Supported ownership

Windows reuses `@deepseek-ai/dsh-win32-process` 0.2.0-rc.2: create suspended,
assign an unnamed kill-on-close Job, then resume. Termination uses the retained
Job handle. Breakaway limits are not enabled. Normal CreateProcess descendants,
including detached fixtures, remain owned. Processes created through an external
broker or deliberately migrated by privileged code are outside this lifecycle
contract; these controls are not an OS security sandbox.

Linux requires cgroup v2, a writable group below the caller's current group,
`cgroup.kill` and libc pidfd support. A fixed launcher joins the new random cgroup
before exec, then waits until ownership is recorded. The group's directory,
kill and events descriptors remain open. TERM uses pidfds and verifies current
membership, with no numeric PID fallback. Force writes to the held cgroup.kill
descriptor, covering concurrent forks and nested cgroups. Only populated 0
confirms descendant exit. PID enumeration is observational and can be incomplete.

No mount, controller enablement or process-name search is performed. Missing
native support blocks profile launch as ownership_unavailable; macOS has no
backend here. History readers cannot recreate kernel handles. Root absence or
PID reuse cannot permit resumed/checkpoint runs while descendants are unverified.

### Explicit macOS Docker Linux worker

macOS native execution remains unsupported. An operator may instead select the
separate Linux worker for a command that is valid in the pinned Node image:

```sh
node dashboard/cli.mjs session-ledger start --project /absolute/project \
  --cwd /absolute/project --executable /usr/local/bin/node \
  --entrypoint /absolute/project/worker-entry.mjs \
  --docker-linux-worker --docker-worker-mount-root /absolute/project
```

`--docker-linux-worker` is an explicit platform change, never a Darwin fallback.
Each `--docker-worker-mount-root` is an operator-selected absolute root; the
worker rejects a cwd or entrypoint outside it and never infers or mounts `HOME`.
The worker accepts only `/usr/local/bin/node` from its pinned
`node@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392`
image. A host Mach-O executable is therefore rejected rather than translated.

The Dashboard creates one unprivileged, network-disabled container with an
exact retained ID. It mounts the selected workspace and its fixed supervisor
only, never a Docker socket or the host PID namespace. Workload argv and env
travel through the attached framed stdin after container creation, so no
workload environment is placed in Docker create arguments or metadata. The
Docker client uses its own host environment; workload `DOCKER_*` values cannot
redirect it.

The history descriptor records `kind=docker_linux_container`,
`execution_platform=linux`, `transport=colima_docker`, and the exact container
ID. Its `root_pid` and `root_identity` are null: a macOS Docker-client PID is
not a Linux workload identity. The stop result is confirmed only after Docker
reports that this exact started container is stopped; it is then removed by its
exact ID. Daemon/monitor ambiguity stays unverifiable. Native macOS results and
selected Linux-worker results must be reported separately.

Provision a delegated service for non-root Linux operation. CI runs tests in a
unique transient service with Delegate=yes and DelegateSubgroup=supervisor under
the existing runner account. It does not run test payloads as root or change other
service groups. The subgroup property requires systemd 254 or later.

Windows-to-WSL Web mode uses the Linux supervisor and a separate framed control
channel. Native stdin/stdout/stderr bytes remain data. RDSH_WSL_NODE selects the
original Node path (default /root/.local/opt/rdsh-node/bin/node). The existing
RDSH_WSL_DISTRO and RDSH_WSL_HARNESS_BIN still select the distribution and wrapper.

The Windows installer detects an existing selected WSL distribution's x64/arm64
architecture and co-installs the pinned Linux native prebuilt. It does not create
a distribution or execute the DSH wrapper during setup. If running Windows npm ci
directly, co-install the matching WSL prebuilt separately; for Windows/WSL x64:

```powershell
cd dashboard
npm install --no-save --package-lock=false --ignore-scripts --force @koromix/koffi-linux-x64@3.1.1
```

This installs the version-pinned Linux dependency in this checkout. Native Linux
npm ci selects its own prebuilt automatically. Other architecture combinations
are not exercised by the checked-in evidence.

## Stop stages and persistence

The adapter retains its six operations. Its stop_stages capability describes
cancellation, graceful close/EOF, OS termination, force and verification. ACP
cancel is a notification; only a cancelled prompt result acknowledges interruption.
Web has no input cancellation capability. Windows TERM is explicitly unsupported;
protocol/EOF and deadline Job termination are available.

Ownership intent is fsynced before profile launch. Private run history binds owner
ID, run ID, root birth/scope observation and kernel-group descriptor. Requests are
recorded before effects, followed by results and configured deadlines. A journal
failure still permits cleanup through an existing live owned handle but cannot
produce durable verified completion. Graceful and force waits have separate
budgets; a timed-out protocol callback does not become an acknowledgement.

Repeated/concurrent requests share one stop promise. Monitor loss, an unreadable
group, remaining descendants after the final deadline or unconfirmed history
leaves an unverifiable result. No saved PID guesses a target. Supervisor EOF
cleanup remains confined to its group and does not create client-side proof after
monitor loss. Management resource release is separate from process exit proof.

## Human UI and API

The Harness entry page shows running, stopping, confirmed empty descendants and
unverifiable states, with run ID, remaining owned PIDs/count and stage history.
Its stop button disables immediately. The page remains available for inspection.

GET /\_rdsh/api/managed-process returns that scoped result. Authenticated humans or
the administrator may POST /\_rdsh/api/managed-stop. The 202 response confirms the
request, not termination. Unauthenticated and MCP credentials cannot operate it;
existing host/origin checks and browser cookie bootstrap still apply.

POST /\_rdsh/api/stop remains administrator-only. It confirms the managed Harness
exit before closing the dashboard. An unverifiable stop returns 409 and preserves
the dashboard and instance lock. Independent DSH instances and human terminals
have no ownership handle in this run and receive no signals.

## Verification

See [scoped-stop evidence](evidence/scoped-stop.md) for actual captures,
before/after fixture output, native Web startup and Windows-to-WSL byte preservation.
Kernel contracts: [Microsoft Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects),
[Linux cgroups](https://docs.kernel.org/admin-guide/cgroup-v2.html),
[pidfd signals](https://man7.org/linux/man-pages/man2/pidfd_send_signal.2.html),
[systemd delegation](https://systemd.io/CGROUP_DELEGATION/).
