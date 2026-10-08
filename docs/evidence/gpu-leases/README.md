# GPU lease evidence

Source commit: `82a38bd3f0bcd9fb3da7cc6c8b8487e830a9a68b`, with actual main
`39c5dd1325f91de05870166c7da75e6424948ab7` integrated. Both measured runs hash
the same 17 runtime/fixture files as
`5572992d552c69f084c761017209ba69cf3d0110b400a5a2099e73c1393e86a7`.
This evidence-only commit leaves those source bytes unchanged.

[Windows raw results](windows.json), [Linux raw results](linux.json), and
[before/after and validation summary](before-after.json) retain sample arrays,
runtime versions, observed outputs and the measured scope. The fixed NVIDIA
inventory and original ACP peer fixtures use actual Windows Job/Linux cgroup
ownership. Physical GPU allocations, real models/providers and power-loss
durability were not exercised.

## Admission behavior

With 1,024 MiB free and a request for 4,096 MiB, the disabled path starts and
verifiably stops the original native peer. The opt-in path instead returns:

```json
{
  "status": "waiting-resource",
  "reason": "gpu_capacity_insufficient",
  "device_id": "GPU-00000000-0000-0000-0000-000000000001",
  "requested_vram_mib": 4096,
  "driver_free_mib": 1024,
  "reserved_mib": 0,
  "native_process_started": false
}
```

The public CLI returns exit code 75 for this wait. A caller must explicitly
retry the same never-dispatched run; the wait cannot create a native session or
claim a reply. All three admitted reservations per platform ended with an
observed `held_kernel_group_empty` release and zero active reservations.

## Measured transport cost

The driver alternates disabled/leased original ACP attachments, with three
attach/stop samples and 24 sends per mode. These are local fixture measurements,
not a provider throughput benchmark. Values below are milliseconds; the driver
uses the upper middle sorted sample for an even sample count.

| Runtime               | Operation     | Disabled median | Leased median | Difference |
| --------------------- | ------------- | --------------: | ------------: | ---------: |
| Windows, Node 22.23.3 | attach        |        1,156.11 |      1,222.54 |     +66.42 |
| Windows, Node 22.23.3 | send          |           35.55 |         41.36 |      +5.80 |
| Windows, Node 22.23.3 | verified stop |          152.78 |        462.86 |    +310.08 |
| Linux, Node 24.21.0   | attach        |          313.98 |        331.46 |     +17.48 |
| Linux, Node 24.21.0   | send          |           52.46 |         56.44 |      +3.99 |
| Linux, Node 24.21.0   | verified stop |          144.59 |        154.75 |     +10.16 |

Two hundred absent GPU-request lookups had median/p95 costs of
0.139/0.228 ms on Windows and 0.250/0.321 ms on Linux. The leased path adds durable
admission/guard checks and verified release, including extra Windows process
identity observations; its measured overhead is retained rather than hidden.
Different OS/runtime versions and small sample counts limit cross-platform
comparisons.

## Validation and reproduction

- Windows: all 216 dashboard tests passed, with zero failures, cancellations or
  skips. The targeted process-scope/checkpoint/GPU suite also passed all 40 cases.
- Linux: 216 dashboard tests, 211 passed and five Windows-only UI/wrapper cases
  skipped; zero failures/cancellations. Rust release tests (110), benchmark
  examples (7), fence tests (2), CLI checks (53), security-boundary tests (11),
  fmt and release Clippy with zero warnings passed.
- The earlier `fecbdc0` Windows run had 214 passes and one checkpoint setup
  failure. Independent Job membership/accounting queries could disagree while
  a process exited, returning `exit_confirmed` with an older nonempty PID list.
  The journal correctly refused that proof. The final backend requires both
  observations to be empty; deterministic exit/spawn interleavings and real
  owned-process regressions now pass. Contradictory observations retain the
  reservation and are polled again.

From the repository's dashboard directory, Windows PowerShell expands the
test paths explicitly:

```powershell
npm ci --no-audit --no-fund
$taskTests = (Get-ChildItem test -Filter '*.test.mjs' -File).FullName
node --test --test-concurrency=1 @taskTests
node test/gpu-evidence.mjs
```

On Linux, run the same commands in a delegated cgroup; the captured review used
`systemd-run --wait --pipe --collect --property=Delegate=yes
--property=DelegateSubgroup=supervisor` for the test suite and evidence driver.
Run `node --test --test-concurrency=1 test/*.test.mjs` and then
`node test/gpu-evidence.mjs` from that environment. Optional
`--hardware-metadata` only queries inventory and hashes physical UUIDs.

The reservation is a cooperative admission gate for one OS/state home.
Unmanaged competition after admission, Windows/WSL or network-filesystem sharing,
AMD/MIG, actual VRAM enforcement and model quality remain outside this proof.
