# Benchmarks

The historical headline numbers below were measured on Linux x86_64.
For a current Mac run, see [2026-10-08 CLI verification](evidence/performance-20261008.md)
and [extended Rust measurements](evidence/performance-extended-20261008.md)
with raw samples, streaming/growing sessions, concurrent writers, real HTTP and
original DSH delegation. CLI startup/RSS measurements do not describe Desktop memory
or the performance of delegated model execution.

For real Codex/Claude tasks, see the [Rust model runner](MODEL_BENCHMARKS.md)
and [2026-10-08 model runtime results](evidence/model-runtime-20261008.md).

Only the `--version` rows compare against upstream `dsh`. The `search`,
`tokens` and `sessions` baselines are earlier rdsh builds, and the hook row is an
equivalent Node.js judge; upstream `dsh` exposes none of those subcommands. See
[Node.js comparison](#nodejs-comparison-benchmark-node-vs-rustpy) for the current
side-by-side harness and its raw JSON.

## Headline numbers

| Case | rdsh | Baseline | Factor |
| ---- | ---- | -------- | ------ |
| `--version` startup (median, n=5) | ~0.90ms | original `dsh` ~88ms | ~98x |
| `--version` peak RSS | ~2.9MB | original ~66MB | ~1/23 |
| PreToolUse hook peak RSS (`rdsh guard`, n=15) | ~6.0MB | equivalent Node.js judge ~49MB | ~1/8 |
| search (`--max 10`, 160 files, 960k matching lines) | ~4.61ms | v0.2.0 ~197.77ms | ~42.9x |
| tokens (9.6MB text) | ~12ms | before ~35ms | ~2.9x |
| sessions --tokens (20 sessions) | ~0.41s | before ~1.65s | ~4.0x |
| Distribution size | one ~1.8-2.3MB binary (v0.3.3, per platform) | ~508MB Node tree | -- |

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

For the 2026-10-08 native search change, see
[raw samples, output equality, CPU affinity, and reproduction](evidence/search-performance/README.md).
This measurement uses generated dummy files, two warmups, ten alternating
before/after samples, and an isolated HOME. Ordinary, nonmatching searches
improved by 1.32–1.66x on this machine; the dense case benefits especially
from stopping once each worker has enough results. These are fixture results,
not a claim about every command or filesystem.

## Regression harness (`benchmark_regression`)

`examples/benchmark_regression.rs` is the CI-oriented runner. It measures the
core CLI fast paths of the **real binary** by spawning it as a subprocess with an
isolated temporary `HOME`, `DSH_HOME` and `XDG_*` environment, so no user
sessions, settings or credentials are read. It records a trend by default and
only becomes a gate when a baseline is supplied.

```sh
cargo build --release
cargo run --release --example benchmark_regression -- \
  --bin ./target/release/rdsh --n 15 --output /tmp/rdsh-perf.json
```

### What it measures

| Case | Command | Notes |
| ---- | ------- | ----- |
| `version_startup` | `rdsh --version` | process spawn to exit, launch latency included |
| `version_startup.peak_rss_bytes` | `rdsh --version` | `ps` sampling, `/usr/bin/time` fallback; `null` when unavailable |
| `tokens_1mib` | `rdsh tokens <1 MiB file>` | generated synthetic text |
| `tokens_10mib` | `rdsh tokens <10 MiB file>` | generated synthetic text |
| `search_tree_200_files` | `rdsh search <needle> --dir <tree>` | 200 files in 10 subdirectories |

Every case gets 3 warmup runs followed by `n` samples (`--n`, default 15,
minimum 5). With a live `--baseline` binary, both builds run in alternating
order on the same fixtures. Their HOME, DSH_HOME, XDG directories and working
directories are separate. The report carries the raw `samples_ms` array plus `median_ms`,
`p95_ms`, `min_ms` and `max_ms`. Percentiles use nearest rank, so `n=15` maps
`p95` onto the largest sample; treat it as a spread indicator, not a precise
quantile. `cpu_median_ms` is the CPU time the child consumed, reported next to
the wall clock so a noisy shared runner is visible: a CPU figure well above the
wall figure means the command is parallel, and one well below it means the
process was waiting on the scheduler.

### JSON schema

`schema_version` is `2`; it is bumped on any incompatible layout change.
`--baseline-json` also requires matching OS, architecture, CPU count, warmup,
timing/scope settings and exact fixture sizes. Every headline case must have a
finite positive median and a successful correctness outcome. The sample count
may differ; it affects measurement precision, not the fixture being compared.

| Field | Meaning |
| ----- | ------- |
| `schema_version` | report layout version (currently `2`) |
| `tool` | always `benchmark_regression` |
| `generated_at_utc` | Unix epoch seconds |
| `platform` | `os`, `arch`, `family`, `cpu_count` |
| `toolchain` | `rustc` and `cargo` version strings when obtainable |
| `config` | `n`, `warmups`, `max_regression_percent`, `headline_cases`, fixture sizes, timing scope |
| `binaries` | per label: `path`, `size_bytes`, `sha256` |
| `cases` | per case: `samples_ms`, `median_ms`, `p95_ms`, `min_ms`, `max_ms`, `throughput_mib_s`, `input_bytes`, `cpu_median_ms`, `peak_rss_bytes`, `exit_code`, `argv`, `correct`, `evidence`, `headline`, `outcome`, `comparison` |
| `failures` | correctness failures or invalid comparison timing values |
| `regressions` | cases over the threshold on a headline case |
| `comparison` | `baseline_label`, `baseline_median_ms`, `ratio`, `delta_percent`, `stdout_equal`, `output_compatible`, `regressed`; `null` when no baseline was given |

`outcome` is `recorded` (no baseline), `ok`, `regressed`, or `failed`.
`evidence` records what the oracle actually verified, e.g. `version=0.3.3`,
`tokens=2621453` or `hits=200`.

### Correctness first

Each case is checked against its own oracle before timing: `tokens` must equal
the byte-derived token count for the generated ASCII fixture, `search` must
return exactly one row per generated needle with no duplicates, and `--version`
must produce a valid `rdsh` semantic version. The same stdout must appear in
every warmup and sample for that build, or the run aborts. With a live baseline,
candidate and baseline output must match byte for byte except for
`version_startup`, where each build's version is validated independently. A
mismatch marks the case `failed`, reports no speed ratio for it, and exits
non-zero — a candidate is never described as a regression on an invalid result.
For a JSON baseline, `stdout_equal` is `null` because the report contains no
stdout; `output_compatible` reflects the candidate's oracle result. For a live
baseline with different valid versions, `stdout_equal` is false while
`output_compatible` remains true.

### Setting a baseline

Compare against another binary (for example a build of the previous commit):

```sh
cargo run --release --example benchmark_regression -- \
  --bin ./target/release/rdsh --baseline /path/to/base/target/release/rdsh \
  --n 15 --output /tmp/rdsh-perf.json
```

Or against a previously recorded report from the same platform and fixture
configuration:

```sh
cargo run --release --example benchmark_regression -- \
  --bin ./target/release/rdsh --baseline-json /tmp/rdsh-perf-previous.json \
  --n 15 --output /tmp/rdsh-perf.json
```

`--baseline` and `--baseline-json` are mutually exclusive. Running with no
baseline at all is not an error; it simply records the trend.

### Regression threshold policy

`--max-regression-percent` defaults to **10** and applies to the headline cases
(`version_startup`, `tokens_1mib`, `tokens_10mib`, `search_tree_200_files`).
The process exits non-zero when a headline case is slower than its baseline by
more than that percentage, or when any case fails correctness. A faster result
and a result exactly on the budget both pass.

The threshold is deliberately generous because a shared CI runner is noisy;
`version_startup` is sub-5 ms, where a single scheduler stall dominates the
median. Compare the recorded `cpu_median_ms` and `samples_ms` before treating
any single flagged run as a real regression. The threshold is a tripwire for
large, sustained slowdowns, not a substitute for reading the samples.

### CI job

The `perf-regression` job in `.github/workflows/ci.yml` runs the example's unit
tests, builds the release binary, executes the harness with `--n 15`, and
uploads the JSON as the `perf-regression` artifact. It intentionally passes no
`--baseline`: a fresh runner has no previous binary, and comparing against a
stale artifact would fail spuriously. The job asserts that the report exists
and that every case is marked correct; it does not fail on timing.

## Node.js comparison (`benchmark-node-vs-rust.py`)

`rdsh`'s speed claims have mixed three different baselines. This harness makes the
Node.js side explicit and reproducible on one machine:

```sh
cargo build --release
python3 scripts/benchmark-node-vs-rust.py --bin ./target/release/rdsh \
  --mode all --n 15 --calls 200 --output /tmp/rdsh-node-vs-rust.json
```

* `--mode hook` measures the PreToolUse hook: `rdsh guard` against
  `scripts/benchmark-node-reference.mjs guard`, one process per call, including
  process launch. It reports per-case median/p95 and the accumulated cost over
  `--calls` simulated tool calls with `--deny-percent` of them blocked.
* `--mode native` measures `rdsh tokens` and `rdsh search` against the same
  algorithms in `scripts/benchmark-node-reference.mjs` on one generated dataset
  (10 MiB ASCII text, 50,000 CJK lines, 300 files x 2,000 lines).

The reference script is a benchmark stand-in, not upstream `dsh`: upstream
exposes no `tokens`/`search` subcommand, so passing `--dsh PATH` only records
that absence in the report and never yields an upstream product ratio. Every case
is checked for output equality first (`tokens` values, sorted `search` hit sets,
allow/block decisions and the matched deny pattern); a mismatch aborts the run.
Search results are compared as sets because rdsh walks directories in raw readdir
order while Node's scandir sorts names, so a hit cap below the total hit count
would make the two orders select different subsets.

The JSON report records the OS, CPU count, `n`, warmups, timing scope, binary and
reference-script SHA-256, every raw sample, and the cumulative hook totals.
Fixtures run under a temporary `HOME`, `DSH_HOME` and `XDG_*`; no user data,
sessions, credentials or model calls are read. The upstream `dsh` binary is never
required; `node` is required for the comparison.

## Rules for benchmark PRs

1. State machine, OS, and `n`.
2. Paste raw output, not just the summary table.
3. Prove output equality (diff before/after outputs).
4. Update this file when a headline number moves by more than ~10 percent.
