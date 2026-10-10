# GPU lease evidence

Original measurement source: `82a38bd3f0bcd9fb3da7cc6c8b8487e830a9a68b`, with actual main
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

## Windows aliases and current main

Source `45dbbf3b4dff6ae4256115774b37a160f4ee0d80` integrates actual main
`93b3bcaa7759fb27461b02f1dd0b0012e946b329` and fixes a Windows CI failure that
the original local-path runs did not exercise. The two `e2f9a1e` Windows CI runs
each had 197 passes and 19 `gpu_directory_untrusted` failures. A real NTFS 8.3
alias reproduced the failure locally before the fix.

Windows directory checks now expand short names with `GetLongPathNameW`, reject
reparse attributes in every ancestor and compare with the actual filesystem
path. A real short/long-name pair must contend for the same kernel ledger lock;
a junction through that same alias must still be refused. Space/Unicode paths
and direct/ancestor redirects have independent regressions. Lock sharing,
no-unlink ownership and fail-closed validation are retained.

[Windows current raw results](windows-main93.json), [Linux current raw
results](linux-main93.json), and [current summary](before-after-main93.json)
record a new measurement series. Both platforms hash the same 17 selected
runtime/fixture files as
`333834197bf53aa40cd49a2524e8d5d265229b6df830f8037d366e12e161e012`.
The earlier `82a38bd` files and measurements above remain historical evidence.

- Windows: all 219 dashboard tests passed with zero failures, cancellations or
  skips, including the actual 8.3 alias test. The GPU/path target suite passed
  all 22 cases.
- Linux: 219 dashboard tests, 213 passed and six Windows-only cases skipped;
  no failures/cancellations. Rust release tests (103) and benchmark example
  tests (7), fence (2), CLI (53), security boundaries (11), icon asset checks,
  fmt and release Clippy with zero warnings passed.
- Both measurement runs verifiably released all three admitted reservations
  through `held_kernel_group_empty` and ended with zero active reservations.
  The low-capacity opt-in path still returned the wait before starting a native
  process. No physical GPU allocation, model/API call or power-loss test ran.

| Runtime               | Operation     | Disabled median, ms | Leased median, ms |
| --------------------- | ------------- | ------------------: | ----------------: |
| Windows, Node 22.23.3 | attach        |            1,192.55 |          1,180.28 |
| Windows, Node 22.23.3 | send          |               38.13 |             41.37 |
| Windows, Node 22.23.3 | verified stop |              165.87 |            457.70 |
| Linux, Node 24.21.0   | attach        |              276.69 |            318.69 |
| Linux, Node 24.21.0   | send          |               50.60 |             56.05 |
| Linux, Node 24.21.0   | verified stop |              137.21 |            149.20 |

Absent-request lookup median/p95 was 0.167/0.273 ms on Windows and
0.201/0.261 ms on Linux. Three alternating attachments per mode do not establish
a speed improvement; the raw samples and durable guard/stop overhead are
retained. The current hosted CI must be checked independently on the final PR
head; the failed earlier CI is not counted as a pass.

## Short-path receipt recovery after the hosted Windows failure

Measured source: `04f363f9ea5d5a5ea6d887c4264aac6c556c0414`, including merged main
`93b3bcaa7759fb27461b02f1dd0b0012e946b329`. The previous source-45/82 results above
remain historical evidence; they do not validate this receipt-reader change.

The hosted Windows run on `66d1514` passed 218 tests and failed one durable
kernel-empty receipt assertion: a real 8.3 temporary-directory alias was still
compared literally against its expanded project path in `recordedExit`.
A new real-filesystem project test reproduced `retained` before the fix and
`released / recorded_kernel_group_empty` afterward. The reader now uses the
same native alias expansion and ancestor reparse rejection as the writer,
without creating a missing project directory. Corrupt tails, missing directories,
junction/symlink receipts, mismatched descriptors and uncertain process facts
retain their reservations.

Current-source validation:

| Suite | Total | Pass | Fail/cancel | Skip |
| --- | ---: | ---: | ---: | ---: |
| Windows dashboard, Node 22 | 220 | 220 | 0 | 0 |
| Linux delegated cgroup dashboard, Node 24 | 220 | 213 | 0 | 7 Windows-only |
| Windows GPU tests with actual 8.3 TEMP/TMP | 23 | 23 | 0 | 0 |

Rust release tests: 103, benchmark examples: 7, fence: 2, CLI regressions: 53,
security boundaries: 11. fmt and release Clippy with zero warnings passed.
The 17 measured runtime/fixture files have the same fingerprint on both OSes:
`96b4ba739a0e4db97d6a38a92b34489bd0aeb31c483364be35719e0f7ff837b4`.
Both measured runs released their three fixture leases only with
`held_kernel_group_empty`; final active reservations were zero.

The machine results are in [Windows](windows-short-path-receipts.json),
[Linux](linux-short-path-receipts.json) and
[before/after](before-after-short-path-receipts.json). The same fixed inventory,
public CLI, native Job/delegated-cgroup fixtures and no-model scope apply.
No physical GPU memory or provider throughput was measured. These are local
checks; hosted CI is evaluated separately on the current PR head.

| OS | attach/send/stop medians in ms | GPU-marker miss, 200 samples |
| --- | --- | --- |
| windows | {"disabled": {"attach_ms": 1193.5612999999994, "send_ms": 41.41160000000036, "stop_ms": 165.20790000000034}, "leased": {"attach_ms": 1256.8760999999995, "send_ms": 43.123099999999795, "stop_ms": 479.7992999999997}} | {"median_ms": 0.24220000000002528, "p95_ms": 0.29700000000002547} |
| linux | {"disabled": {"attach_ms": 261.333176, "send_ms": 48.105139000000236, "stop_ms": 139.3467559999999}, "leased": {"attach_ms": 325.83575999999994, "send_ms": 54.892005000000154, "stop_ms": 138.62116500000002}} | {"median_ms": 0.20621999999997342, "p95_ms": 0.29064900000000193} |

## Windows tray integration after main d705ed7

Measured source: `0f4e8ced93ebeefb4799571b5ae56f75409ba844`, including merged main
`d705ed7f4c39c8776426cbd7b2b0f789b2008243`.
The earlier receipt-reader and short-path records above stay historical.

The [hosted Windows run on source 45fb49c](https://github.com/jimoto-no-llm/rustdsh/actions/runs/37870281544/job/113626541245)
passed 219 tests and failed the tray launcher ready check at its original
15-second deadline, with `System.Threading.Tasks.VoidTaskResult` in stderr.
The verified PR #203 startup change replaces per-launch C# reader compilation
with the CLR delegate, records bounded startup phases/version/stderr hashes
and observes only its own helper's exit. Tray/launcher/native-menu deadlines
remain 15/60/25 seconds. CLI integration preserves GPU resource-wait exit code
75. Issue #209's underlying hosted-runner cause is still unconfirmed.

| Suite | Total | Pass | Fail/cancel | Skip |
| --- | ---: | ---: | ---: | ---: |
| Windows launcher/tray/GPU targets, Node 22 | 39 | 39 | 0 | 0 |
| Linux delegated-cgroup dashboard, Node 24 | 223 | 215 | 0 | 8 Windows-only |

The 17 measured runtime/fixture files, including `cli.mjs`, have the same
fingerprint on both OSes:
`cce045a07930385fcda51c4acdeca043f316fe952d8264ced114eefb0c47dea2`.
Both runs released their three fixture leases through
`held_kernel_group_empty`, ended with zero active reservations, and refused
the low-capacity opt-in before starting a native process.

Machine results: [Windows](windows-tray-startup.json),
[Linux](linux-tray-startup.json) and
[before/after](before-after-tray-startup.json).
Full Windows and final-head hosted CI are checked separately; this table only
records the completed local suites. No physical GPU allocation, model/API call
or power-loss test ran. Three alternating attachments per mode do not prove a
speed improvement; raw samples and stop-verification overhead are retained.

| Runtime | Operation | Disabled median, ms | Leased median, ms |
| --- | --- | ---: | ---: |
| windows, v22.23.3 | attach_ms | 1119.94 | 1146.97 |
| windows, v22.23.3 | send_ms | 32.69 | 35.96 |
| windows, v22.23.3 | stop_ms | 150.70 | 462.56 |
| linux, v24.21.0 | attach_ms | 246.65 | 299.15 |
| linux, v24.21.0 | send_ms | 46.97 | 49.45 |
| linux, v24.21.0 | stop_ms | 122.55 | 134.85 |
