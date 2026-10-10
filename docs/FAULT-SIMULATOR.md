# Offline control-plane fault simulator

The simulator exercises the shipped ACP adapter, session ledger, durable run
history and bounded retry controller with fixed local peers. It uses no provider
credentials, paid API, model process or GPU driver. The GPU-loss case models a
device error reported by the mock CLI; physical GPU behavior remains unverified.

Run from a source checkout after `npm ci` in `dashboard/`, with Node 22 or newer.
Windows uses the existing Job Object backend. Linux requires the same delegated
cgroup v2 environment as the dashboard tests; it refuses unsupported ownership
rather than falling back to PID-only stopping.

```sh
node dashboard/fault-simulator.mjs run --seed 1 --output /tmp/rdsh-fault-run
node dashboard/fault-simulator.mjs replay \
  --manifest /tmp/rdsh-fault-run/input.json --output /tmp/rdsh-fault-replay
node dashboard/fault-simulator.mjs run --scenario disk_full --seed 0 \
  --output /tmp/rdsh-fault-write-full
```

On Windows, pass a new directory such as `C:\Temp\rdsh-fault-run`. The parent
directory must already exist. Output directories are never reused, removed or
overwritten. Replay creates a separate run from the exact saved manifest.
The exit code is zero only when every selected scenario satisfies its checks.

| Scenario | Injected failure | Required observed result |
| --- | --- | --- |
| `duplicate_events` | Duplicate native usage event and resend of the same durable command ID | One mock effect and one native command ack; the duplicate command is rejected before dispatch |
| `out_of_order` | Acknowledgement before a recorded command has been dispatched | The production journal rejects the phase change without changing committed bytes; a valid subsequent prompt executes once |
| `network_disconnect` | A loopback TCP connection closes after the mock operation commits, before its response arrives | One dispatch; the exact operation/scope receipt reconciles the result; rereading the operation never dispatches it again |
| `restart` | The control worker is killed after a mock effect, before its native ack is recorded | A fresh process reads the durable journal without replay; the command remains unknown with no ack, and unavailable scope proof is not reconstructed |
| `disk_full` | `ENOSPC` at the real journal write (even seed) or fsync (odd seed) | No native prompt is dispatched and no success/ack is returned; stopping the owned group still succeeds while history persistence stays unconfirmed |
| `gpu_loss` | The mock CLI reports that `fixture-gpu-0` disappeared | The command/run remains unknown, no mock effect or success ack occurs, and process membership remains present until verified owned stopping |

GPU disappearance is not an empty-process-group observation. The simulator
checks remaining owned processes before stopping and the actual empty-group
proof afterward. It adds no GPU lease manager and makes no driver-usage claim.
Likewise, a root process observed absent after restart cannot recreate the lost
kernel handle or confirm all descendants; recovery retains that uncertainty.

The peer and worker have isolated homes and a strict environment allowlist.
Provider credentials, proxy settings and `NODE_OPTIONS` are not inherited.
TCP is limited to literal loopback addresses, and TLS/UDP creation is denied in
the disposable worker/peer. No real CLI executable or endpoint is configurable.
Only the captured scenario worker is killed at the explicit restart checkpoint;
normal stopping uses the existing owned-kernel-group backend.

Each scenario has a bounded worker lifetime. The seeded logical clock labels
the fixture event order. Native RPC deadlines, OS process observations and kernel
stopping remain real; a logical timestamp is not an OS liveness observation.
An ENOSPC boundary becomes one seeded fault event. Further write/fsync attempts
while that device remains full are recorded individually in
`runtime_observations.journal_failures`, with attempt numbers, elapsed wall-clock
milliseconds and the preceding logical event. Cleanup polling can produce a
different number of those attempts on each replay without shifting the seeded
event order; no observed failed write is discarded.
The seed also selects the ENOSPC boundary. Run both seeds 0 and 1 to cover write
and fsync failure. Hard-process termination is not a power-loss/storage-device test.

## Results and reproduction

- `input.json` contains the versioned scenario selection, seed, logical-clock
  settings and fault points. Unknown fields and arbitrary executable/endpoint
  additions are rejected before creating a new output directory.
- `reproducibility.json` records the Node runtime, fixture CLI version, locked
  and installed dependency versions, input digest, fixture digest, target commit,
  and a tracked-worktree hash. The worktree hash covers `HEAD` and tracked file
  changes; untracked and ignored files are excluded. Missing installed versions
  and version mismatches are listed separately.
- Environment variable names and values are never copied into the manifest.
  It records only aggregate omission counts, and the accepted input schema
  rejects arbitrary config or prompt fields. The manifest keeps a reference and
  digest for `input.json` rather than embedding another copy of its contents.
- `report.json` and each scenario's `result.json` contain individual checks,
  observed effect counts, ack/persistence/resource results, logical events,
  runtime I/O observations and failure phase/code. A failed worker is recorded
  as failed, never as skipped.
- The mock CLI trace and isolated state remain beside each result. Bounded worker
  diagnostics are retained when present. Simulator state is disposable, but the
  command never deletes it. Do not use these mock sessions to resume a real run.
- `source_fingerprint`, `reproducibility.json`, and Node/platform metadata
  distinguish source/runtime changes from the saved input. The result claims a
  bounded offline fixture replay, not complete reproducibility: host process and
  filesystem behavior remain external, and provider/model/GPU behavior is not
  exercised. Wall-clock times, generated native IDs and process identities can
  differ across replays; the input and semantic outcome checks are reproducible.

The dashboard workflow runs all six cases and replay on Windows/Linux, adds the
write-failure seed, and uploads the reports even when a run fails. The regular
dashboard tests also check state/ack/effect invariants, exact manifest replay,
invalid-plan/output preservation, and network rejection. This evidence covers
mock control-plane recovery. Real provider, physical phone, Tunnel/Dot, GPU and
storage hardware tests retain their own verification requirements.
