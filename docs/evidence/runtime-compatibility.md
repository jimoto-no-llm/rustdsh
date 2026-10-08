# DSH interpreter and update compatibility

Baseline: main `96dbcbbd6e1295b2e92ba31e9cf9037770107b24`.
Production source tested and measured: `81e38f32d3442de9c89e95fa2d7a034c54771621`.
These are the two issues retained as separate main fixes in the review of PR #86.

## Interpreter selection

A DSH JavaScript entry inside a matching `node-vX.Y.Z-OS-ARCH` tree now uses
that tree's interpreter before PATH. Launcher aliases are resolved first.
Foreign trees, missing interpreters and directories fall back to the existing
PATH/latest-tree lookup. Windows archives with root-level `node.exe` are supported.
The change adds no Node version subprocess and preserves DSH's arguments and
mandatory tool isolation.

The real metadata fixture printed these interpreter paths before and after:

```text
before: .../system-bin/node
after:  .../node-v24.21.0-linux-x64/bin/node
arguments: ["--version"]
both exit codes: 0
```

Both fixture interpreters are copies of the same real Node binary. This proves
the selection change; it does not claim to reproduce a particular native ABI
failure or execute a model. The release-binary test exercises six Linux paths,
including the symlink alias and each fallback, and is included in the Linux,
macOS and Windows CI matrix. Windows also exercises a directory junction and
the root-level archive layout.

## Version selection

The updater parses npm's actual JSON version list and compares
[SemVer 2.0.0 precedence](https://semver.org/spec/v2.0.0.html).
Stable releases follow their prereleases; numeric identifiers compare
numerically; build metadata does not change precedence. A lower or equivalent
candidate never triggers a DSH installation. Invalid installed versions or a
registry with no valid candidate, malformed JSON and unknown channels stop
before modifying binaries.

Actual `sync-dsh.sh --check-only --channel=any` output differences:

| Installed and registry fixture | Before | After |
| --- | --- | --- |
| `0.2.0`, registry `0.2.0-rc.99` and `0.2.0` | Update available: `0.2.0-rc.99` | Up to date: `0.2.0` |
| `0.2.0-rc.2`, compact JSON with rc.2 and rc.10 | Invalid joined candidate: `0.2.0-rc.20.2.0-rc.10` | Update available: `0.2.0-rc.10` |
| `9.0.0`, registry `8.0.0` and `8.1.0-rc.1` | Update available: `8.1.0-rc.1` | No downgrade |
| `1.0.0`, registry `1.0.0+another-build` | Update available | Equivalent precedence; no installation |

The compatibility suite runs 12 valid version/channel scenarios, rejects invalid
installed or registry versions and four malformed/empty JSON forms, and rejects
an unknown channel. The npm fixture refuses every mutation and makes no network
requests. The existing release checksum success/failure scenarios still pass.

## Startup measurement

Linux x86_64 under WSL2 `6.6.87.2-microsoft-standard-WSL2`, Ryzen 9 7950X3D,
Node `v24.21.0`; release builds with the same locked dependencies and compiler.
Five warmups per binary, then 30 alternating samples per binary, reversing the
order every other pair. The complete wrapper-to-Node metadata invocation is timed.

| Invocation | Before median / p95 | After median / p95 |
| --- | --- | --- |
| Shadowed `dsh --version` metadata fixture | 25.180 / 27.658ms | 25.249 / 26.535ms |

The median difference is 0.069ms (+0.28%) in this local fixture. No speedup or
model-execution performance claim is made. The intended output difference is
the interpreter path; arguments and successful exit status stay equal.

[Raw samples, binary hashes and complete before/after output](runtime-compatibility-benchmark.json)
and the [measurement program](runtime-compatibility-benchmark.mjs) are included.
To reproduce, build release binaries from the two source commits in separate
scratch archives, then pass the binaries and source directories to:

```sh
node docs/evidence/runtime-compatibility-benchmark.mjs \
  /scratch/before/target/release/rdsh /scratch/after/target/release/rdsh \
  /scratch/before /scratch/after /scratch/measurement.json
```

## Validation

The isolated source above passed release fmt and Clippy with warnings denied,
103 Rust tests, seven example tests, 49 Node security/settings/banner tests,
the two compatibility matrix tests, 53 CLI checks, 20 settings checks,
21 context checks and six Python release-artifact tests. Synthetic homes,
credentials and controlled executables were used throughout.

CI also checks transferred repository URLs at the canonical owner without
excluding destination issue, file or release links. A separate test-only fix
clears inherited nonblocking state on accepted HTTP-fixture sockets on BSD;
production search and delegation code are unchanged by that fixture correction.
