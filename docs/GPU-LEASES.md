# Optional GPU admission for original ACP attachments

The opt-in GPU lease records a stable NVIDIA GPU UUID, requested VRAM in MiB,
exclusive/shared mode, project/run/controller owner, heartbeat, and original
owned-process scope before starting an ACP session. It wraps the existing DSH
start/resume/send/stop transport; it does not implement an agent loop.

```powershell
node dashboard/cli.mjs gpu inspect
node dashboard/cli.mjs session-ledger start --project C:\work\project --executable C:\path\node.exe --entrypoint C:\path\original-dsh\bin.js --gpu-request '{"device_id":"GPU-00000000-0000-0000-0000-000000000001","requested_vram_mib":4096,"mode":"exclusive"}'
```

The UUID above is a fixture: select a real UUID from `gpu inspect`. Ordinal
indices and MIG IDs are not accepted. Inventory uses bounded, read-only
`nvidia-smi` UUID/total/used/free queries, without a shell, resets, compute-mode
changes or driver configuration. NVIDIA's [query documentation](https://docs.nvidia.com/deploy/nvidia-smi/index.html)
explains the stable UUID selector and unavailable values. Windows uses
`%SystemRoot%\System32\nvidia-smi.exe`; Linux uses `/usr/bin/nvidia-smi`.
Unsupported/missing inventory and `N/A` stay unknown and block GPU admission.

## Start, wait and explicitly retry

- `session-ledger start/resume` and `reply-consumer once/serve` accept
  `--gpu-request`. The run's checksummed request survives client restart; later
  resume/consumer attachments automatically reacquire it even without the flag.
  Changing a recorded request requires a new run, rather than a silent rebind.
- `session-ledger start/resume` still verifies attachment then stops its owned
  process without sending a prompt. A reply consumer holds the reservation for
  its live original ACP process and checks the durable lease before every send.
- A capacity/exclusive wait returns JSON with `status: waiting-resource`, a
  reason, target UUID, requested memory, observed driver data and reserved
  memory. Exit code **75** means temporary admission wait. No ACP/version probe,
  reply claim or native session creation occurs in this path.
- For an initial wait, explicitly run `session-ledger retry-start --project ...
  --run-id <reported-run-id> --executable ... --entrypoint ...` after capacity
  changes. Only the same never-dispatched GPU run with no native ID, process,
  scope or commands can use this action. It performs one admission attempt and
  one original `start`, without an automatic launch loop. Existing native
  sessions use `resume`, preserving their exact native ID.
- Existing CUDA/container masks must explicitly include the selected UUID
  (or NVIDIA `all`); disabled/ordinal masks fail as `gpu_visibility_unverified`.
  The child receives `CUDA_VISIBLE_DEVICES=<UUID>`, restricting its selector.
  A captured managed release without this GPU protocol rejects an explicit or
  restored GPU requirement before attaching; qualify an updated release first.

## Reservation and release authority

All cooperative clients/projects using the **same dashboard state home** share
`gpu-resources/leases.json`. A persistent kernel-locked `leases.lock` serializes
fresh driver observation, admission and fsynced atomic ledger replacement:
Windows [exclusive CreateFile sharing](https://learn.microsoft.com/en-us/windows/win32/fileio/creating-and-opening-files)
or Linux [flock](https://man7.org/linux/man-pages/man2/flock.2.html). Writer exit
releases the OS handle. No stale lock-file unlink race, TTL override or PID-name
kill is used. Invalid checksums, partial files, links and write failures cannot
grant a reservation. Recent waits/releases are bounded at 128, as are live leases.

Admission uses `max(0, driver_free_mib - reserved_mib)`. It conservatively counts
managed allocations already reflected in driver use twice; it does not guess
per-process VRAM when WDDM reports `N/A`. A shared request must fit this remainder.
An exclusive request conflicts with **every** held lease on that UUID; a shared
request conflicts with an exclusive lease. Different state homes, unmanaged
applications and other OS users do not participate. This is a cooperative start
gate and environment selector, not a driver quota or a guarantee that VRAM stays
free after admission. The existing GPU preflight remains a check without a lease.

The live controller heartbeats every 10 seconds; expiry is 30 seconds and never
frees memory by itself. Root exit also cannot free a reservation while descendants
live. Release requires the original held Job/cgroup to report an empty group and
an actual root identity/absence observation. No kernel handle is reconstructed
from a saved path/PID. `gpu reconcile` checks at most eight expired leases per
invocation using PID **and birth/host identity**. It can release a never-launched
reservation after confirmed controller absence, or a bound reservation after a
matching checksummed run-history kernel-empty receipt plus actual root absence.
An unbound launch intent, remaining descendants, unknown PID/host observations,
missing/mismatched receipts or lost monitor keep the reservation. Re-run reconcile
for remaining expired entries; inspect reports retained reasons. There is no
force-release command that treats a heartbeat or missing driver PID as proof.

`gpu inspect` is read-only and separately exposes `driver_used_mib`,
`driver_free_mib`, `reserved_mib`, and `admission_available_mib`, with the driver's
timestamp and each lease's heartbeat/expiry/owner. Waits are recorded admission
observations, not a background task scheduler. Existing browser task metadata
does not gain execution authority or an implicit GPU lease.

## Verification

Run the dashboard suite from its directory (`npm test --prefix dashboard`). GPU
tests use fixed inventory with the original ACP peer fixture and actual Windows
Job/Linux cgroup ownership; no real GPU workload, model or provider is invoked.
They cover cross-process/project exclusive contention, abnormal writer/root exit,
detached descendants, unknown/mismatched receipts, PID reuse, N/A, corruption,
visibility, wait/retry/resume and loss of the durable lease before a prompt.
Linux requires the same delegated cgroup as the existing dashboard suite.

`node dashboard/test/gpu-evidence.mjs` records before/after admission and the
original transport's measured disabled/leased attach/send/stop timings. Optional
`--hardware-metadata` only queries inventory and hashes physical UUIDs. See
[saved evidence](evidence/gpu-leases/README.md). Physical allocation, unmanaged
competition after admission, multiple OS users, AMD/MIG, power-loss durability
and model quality are unverified; fixture results do not establish those claims.
