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
