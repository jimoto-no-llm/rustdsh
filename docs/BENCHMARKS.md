# Benchmarks

The historical headline numbers below were measured on Linux x86_64.
For a current Mac run, see [2026-10-08 CLI verification](evidence/performance-20261008.md)
and [extended Rust measurements](evidence/performance-extended-20261008.md)
with raw samples, streaming/growing sessions, concurrent writers, real HTTP and
original DSH delegation. CLI startup/RSS measurements do not describe Desktop memory
or the performance of delegated model execution.

## Headline numbers

| Case | rdsh | Baseline | Factor |
| ---- | ---- | -------- | ------ |
| `--version` startup (median, n=5) | ~0.90ms | original `dsh` ~88ms | ~98x |
| `--version` peak RSS | ~2.9MB | original ~66MB | ~1/23 |
| Hook-equivalent peak RSS | ~2.7MB | equivalent Node script ~45MB | ~1/16 |
| search (300 files, ~600k lines) | ~17ms | before ~41ms | ~2.4x |
| tokens (9.6MB text) | ~12ms | before ~35ms | ~2.9x |
| sessions --tokens (20 sessions) | ~0.41s | before ~1.65s | ~4.0x |
| Distribution size | one ~806KB binary | ~508MB Node tree | -- |

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
The earlier `scripts/benchmark.py` run remains as evidence for ASCII/CJK and the
300-file search corpus; new native performance cases are Rust Cargo examples.

For the built-in startup comparison:

```sh
rdsh bench --n 5
/usr/bin/time -v rdsh --version
/usr/bin/time -v dsh --version
```

Before/after binaries were built from HEAD vs. the working tree in a scratch
worktree and their outputs were diffed for equality.

## Rules for benchmark PRs

1. State machine, OS, and `n`.
2. Paste raw output, not just the summary table.
3. Prove output equality (diff before/after outputs).
4. Update this file when a headline number moves by more than ~10 percent.
