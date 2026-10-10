# Local resource admission

rdsh-dashboard resources run is an opt-in launch gate for build and test
commands. It shares reservations across project directories for the current OS
user, checks requested CPU and memory against the observed host/container
capacity, limits concurrent heavy builds, and probes a requested port before
starting the command.

~~~powershell
rdsh-dashboard resources inspect
rdsh-dashboard resources policy --max-heavy-builds 1
rdsh-dashboard resources run --request-file .\resource-request.json --argv-file .\build-command.json
~~~

## CLI output change

Before this change, `rdsh-dashboard resources inspect` returned
`[rdsh-dashboard] Unknown command; use --help`. It now returns JSON with
`policy`, `host.enforced_limits`, `host.recommendation`, `reservations`, and
`recommendation_remaining`; `resources run` reports its acquired reservation
before launching the argv command. The CLI regression test exercises that
before/after path with an isolated state directory.

The request file has this shape:

~~~json
{
  "kind": "heavy-build",
  "cpu_cores": 4,
  "memory_mib": 4096,
  "port": null,
  "wait_ms": 60000
}
~~~

kind is heavy-build, test-server, or other. cpu_cores and memory_mib are
required positive reservations. port is optional and must be in the
unprivileged range 1024–65535. When it is occupied or already reserved, the
launcher probes the next 100 ports and reports the selected alternative.
wait_ms is optional and controls how long to wait for CPU, memory, or
heavy-build capacity; its maximum is ten minutes.

The argv file uses an executable and separate arguments; no shell string is
evaluated:

~~~json
{
  "command": "node",
  "args": ["server.mjs", "--port", "{{RDSH_RESERVED_PORT}}"],
  "cwd": "C:\\Projects\\MyProject"
}
~~~

The {{RDSH_RESERVED_PORT}} argument placeholder is replaced with the selected
port. Child processes also receive RDSH_RESERVED_PORT and
RDSH_RESOURCE_LEASE_ID. A command without a port may omit port or use null.
resources run forwards stdout/stderr and exits with the managed command's exit
code.

resources inspect reports OS/container-enforced limits separately from the
admission recommendation. On Linux, finite cgroup v2 CPU and memory limits are
observed and included. The launcher does not change cpu.max, memory.max,
Windows Job limits, or any other OS/container policy. CPU and memory
reservations are cooperative admission accounting, not throttling; CPU
headroom counts other rdsh reservations, while memory headroom also reflects
the current OS/cgroup observation. The configured heavy-build ceiling is an
rdsh policy, not a kernel limit.

Port probes and rdsh reservations prevent duplicate cooperating launches and
identify ports already in use before start. An unrelated process can still
claim a port after the probe; the managed command must bind the supplied port
and handle a bind failure.

The global reservation ledger lives below stateHome()/resource-admission. It
stores resource amounts, port, process identities, and ownership-scope
metadata, not command arguments. Reservations are released only after the
owned process and supervisor are observed gone and the process scope is
confirmed empty. If process identity or scope proof is unavailable, the lease
remains visible as unknown and continues to count against capacity. This
feature currently requires the Linux or Windows process-identity backend.
