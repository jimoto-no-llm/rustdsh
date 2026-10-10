# Benchmarks

## Current checkout: 2026-10-10 UX and performance review

Measured against `e81782a` on Linux/WSL x86_64 (Ryzen 7 5700X), with release
builds, alternating before/after samples and isolated generated data:

| Case | Before median | After median | Before / after |
| --- | --- | --- | --- |
| Native `--version`, n=21 | 1.065 ms | 0.908 ms | 1.17x |
| ASCII prune, 10 MiB / 4000-token budget, n=21 | 10.770 ms | 7.830 ms | 1.38x |
| Nonmatching search, 160 files / 960k lines, n=21 | 8.998 ms | 5.390 ms | 1.67x |
| Idle browser render + forced layout, n=21 | 30.50 ms | 0.40 ms | 76.3x |
| Metrics-only browser render + forced layout, n=21 | 28.90 ms | 3.30 ms | 8.8x |

The browser fixture has 100 tasks, 40 questions and 30 events. This is rendering
time, not network latency, model execution or INP. Native samples include process
startup and use four allowed CPUs. Outputs, visible data, drafts and caret positions
are checked. Some other cases are slightly slower; see the **complete tables**, raw
samples, environment, source/binary hashes, regression matrix, real PNGs and GIF in
[the dated evidence](evidence/ux-performance-20261010/README.md).
The measured candidate binary was 1,968,752 bytes (~1.97 MB). These optimizations
are included in v0.2.1; the recorded hashes describe the builds at measurement time.

The dated page includes commands for `scripts/benchmark.py`,
`scripts/benchmark-search.py`, the Rust extended runner and
`tests/e2e/benchmark-dashboard.mjs`, plus instructions for building the baseline.

## Oversized settings: release follow-up

A 32 MiB `general.default_profile` fixture compares `7e7e99b` with the bounded
Unicode-prefix implementation, n=5 with one warmup per variant and alternating order:

| Case | Before median | After median |
| --- | --- | --- |
| Peak RSS of settings probe | 472.9 MiB | 216.7 MiB |
| Process startup + settings GET + disposal | 879.08 ms | 490.90 ms |

Both retain exactly the first 200 characters. This is one oversized known-field
fixture, not ordinary settings-page latency or full DSH memory. File parsing and
plugin lifecycle reads remain included; JSON input itself is still read in full.
Node 24.16.0 on Linux/WSL x86_64 used `--max-old-space-size=256`; this flag limits
old-space, not total RSS. [Raw samples and source hashes](evidence/release-v0.2.1/settings-benchmark.json)
record the scope and environment. Reproduce on Linux:

```sh
node scripts/benchmark-settings.mjs --baseline-ref 7e7e99b --n 5 \
  --output /tmp/rdsh-settings-benchmark.json
```

## Historical measurements

The historical headline numbers below were measured on Linux x86_64.
For the earlier Mac run, see [2026-10-08 CLI verification](evidence/performance-20261008.md)
and [extended Rust measurements](evidence/performance-extended-20261008.md)
with raw samples, streaming/growing sessions, concurrent writers, real HTTP and
original DSH delegation. CLI startup/RSS measurements do not describe Desktop memory
or the performance of delegated model execution.

For real Codex/Claude tasks, see the [Rust model runner](MODEL_BENCHMARKS.md)
and [2026-10-08 model runtime results](evidence/model-runtime-20261008.md).

### Historical headline numbers

| Case | rdsh | Baseline | Factor |
| ---- | ---- | -------- | ------ |
| `--version` startup (median, n=5) | ~0.90ms | original `dsh` ~88ms | ~98x |
| `--version` peak RSS | ~2.9MB | original ~66MB | ~1/23 |
| Hook-equivalent peak RSS | ~2.7MB | equivalent Node script ~45MB | ~1/16 |
| search (`--max 10`, 160 files, 960k matching lines) | ~4.61ms | v0.2.0 ~197.77ms | ~42.9x |
| tokens (9.6MB text) | ~12ms | before ~35ms | ~2.9x |
| sessions --tokens (20 sessions) | ~0.41s | before ~1.65s | ~4.0x |
| Distribution size | one ~806KB binary | ~508MB Node tree | -- |

These rows describe earlier revisions/builds and are retained as historical
evidence. They are not the current binary size or the 2026-10-10 comparison.

## How to reproduce

For synthetic workloads and before/after output checks:

```sh
cargo build --release
cargo run --release --example benchmark_extended -- \
  --bin ./target/release/rdsh --baseline /path/to/base/target/release/rdsh --n 15 \
  --output /tmp/rdsh-performance.json
```

The runner uses temporary HOME, DSH_HOME, and XDG directories. It generates
known-size and streaming compressed sessions, growing logs, search trees and JSONL
input; zstd is required. The JSON includes all samples, median/p95, workload sizes,
binary fingerprints, peak RSS when supported, and stdout equality. A candidate
failure or incorrect/different sequential output stops the run. An incorrect growing
base is explicitly recorded as failed correctness, with no comparative speed ratio.
`scripts/benchmark.py` measures ASCII/CJK input, pruning and the 300-file search
corpus. The Rust example adds streaming, growing, concurrent and HTTP cases.

For the built-in startup comparison:

```sh
rdsh bench --n 5
/usr/bin/time -v rdsh --version
/usr/bin/time -v dsh --version
```

Before/after binaries were built from HEAD vs. the working tree in a scratch
worktree and their outputs were diffed for equality.

For the 2026-10-08 native search change, see
[raw samples, output equality, CPU affinity, and reproduction](evidence/search-performance/README.md).
This measurement uses generated dummy files, two warmups, ten alternating
before/after samples, and an isolated HOME. Ordinary, nonmatching searches
improved by 1.32–1.66x on this machine; the dense case benefits especially
from stopping once each worker has enough results. These are fixture results,
not a claim about every command or filesystem.

## Rules for benchmark PRs

1. State machine, OS, and `n`.
2. Paste raw output, not just the summary table.
3. Prove output equality (diff before/after outputs).
4. Update this file when a headline number moves by more than ~10 percent.
