# Extended Rust performance verification, 2026-10-08

macOS 26.6.2 arm64, Apple M5 Max, 18 logical CPUs; Rust 1.99.0; zstd 1.5.7.
The host was in normal use. Three warmups precede 15 measured samples per case;
p95 uses nearest rank and therefore equals the largest of 15 samples. Sequential
base/candidate order alternates per sample. Concurrent, growing, HTTP and delegation
cases use separate blocks; small differences cannot establish an optimization gain.

Base source: `f2a7dc6b2850a6f0c0e1ea1b53494b12cd2e1221`.
Candidate binary source: `b8ac3bc045b04683f384e7a64cf72654b8f8261d`, PR #177
maintenance changes including the session exactness fixes. Later commits add
documentation and Windows log-path handling; they do not change these measured
session/search/compact/HTTP/delegation paths. The binary hashes below identify the
measured snapshot, not a later rebuilt binary.
Measured release binary SHA-256:

- Candidate: `3b9b4164e61f8de77d9d01dfe3a23c9562135922609c7fa0e618c1e5fa06dece`
- Base: `f18f25d6fc6d90f3cd6760d09a75cdcc2093300c84fc751946ccd060fd4290f7`

[Raw JSON with every sample](performance-extended-20261008.json) includes output
fingerprints, peak RSS and correctness results. Its FNV fingerprints identify
outputs/binaries for comparison; SHA-256 above provides stronger binary identity.

## Sequential CLI cases

| Case | Candidate median / p95 ms | Base median / p95 ms | Output equality |
| --- | --- | --- | --- |
| Known-size sessions, token-cache miss | 8.086 / 23.832 | 8.166 / 10.580 | yes |
| Known-size sessions, cache disabled | 8.881 / 16.135 | 8.838 / 12.866 | yes |
| Known-size sessions, warm token cache | 7.709 / 12.307 | 7.768 / 8.556 | yes |
| Unknown-size zstd streaming, cache miss | 38.651 / 71.789 | 37.751 / 80.339 | yes |
| Search, 16 files / 294 bytes | 3.598 / 4.783 | 3.683 / 4.551 | yes |
| Search, 40 files / 750 bytes | 3.773 / 4.056 | 3.848 / 5.001 | yes |
| JSONL compact, 1,048,626 bytes | 4.197 / 6.092 | 4.150 / 6.163 | yes |

Session fixtures have 20 sessions of 1 MiB uncompressed data each; one known-size
session concatenates two frames. The streaming fixture explicitly omits content
sizes and expands using real `zstd`. Every session count/value/exactness flag is
checked. Cache misses clear the application token cache before each invocation,
including the separate RSS observation. The OS filesystem cache remains warm.
Search covers either side of the parallel-worker threshold with independent hit
counts; these tiny trees measure branching/startup, not large-corpus throughput.

Median differences in these seven cases range approximately from 2.3 percent faster
to 2.4 percent slower. The candidate has larger p95 values in several known-size
session cases; raw variation remains visible and no universal speedup is claimed.
An earlier exploratory streaming run was about 22 percent slower on the candidate
while test servers were running; it did not establish a persistent regression.

## Concurrent writers and growing logs

Four separate CLI processes write a cold token cache simultaneously for each of
15 measured waves. All outputs and the final cache are checked. Candidate group
median/p95: **12.463 / 19.064 ms**; base: **12.711 / 20.153 ms**. This is wall
time for the entire group, not one process; aggregate RSS is not measured.

The growing fixture appends 256 KiB to one unknown-size zstd session before each
invocation. With `stale_secs=0`, the base **fails correctness** on the first growth:
it returns 262144 tokens as exact instead of 327680. The candidate passes all
growth checks, median/p95 **12.481 / 18.660 ms**. No performance ratio is reported
against an incorrect base. Input size changes on every invocation, so fixed-size
throughput is null.

## Persistent Rust HTTP server

| Endpoint | Candidate median / p95 ms | Base median / p95 ms |
| --- | --- | --- |
| version | 0.337 / 0.365 | 0.507 / 0.916 |
| tokens, 40 KiB ASCII | 0.367 / 0.393 | 0.518 / 0.729 |
| prune, 40 KiB ASCII | 0.403 / 0.605 | 0.438 / 0.589 |

These samples measure TCP connect plus complete loopback HTTP response against
actual authenticated Rust servers; correctness checks require HTTP 200 and
expected response fields. They exclude process startup, browser rendering, provider
latency and remote network latency. Servers use temporary settings and random ports.

## Actual DSH delegation

Installed original DSH 0.2.0-rc.2 `--version`: median/p95 **88.084 / 93.544 ms**;
separate peak RSS **89.22 MiB**. An unchanged rdsh binary copied to a temporary
`dsh` shim delegates to that same installed CLI:

| Compile-cache condition | Median / p95 ms | Same stdout as original |
| --- | --- | --- |
| Disabled | 96.366 / 100.724 | yes |
| Warm | 94.802 / 97.038 | yes |
| Empty before each invocation | 104.798 / 128.874 | yes |

The cache directory is absent when disabled and observed when enabled. A shim
adds launch overhead and a cold compile cache is slower here. This verifies
version delegation only; it does not measure DSH agent boot or Electron Desktop
RSS/startup. It uses no real credentials or model calls.

## Reproduce and limits

```sh
cargo build --release
cargo run --release --example benchmark_extended -- \
  --bin ./target/release/rdsh --baseline /path/to/base/target/release/rdsh \
  --dsh /path/to/original/dsh --n 15 --output /tmp/rdsh-extended.json
```

Omit `--dsh` if the original CLI is unavailable. zstd is required; absence fails
explicitly. Native measurements use Rust and existing dependencies, with isolated
HOME/DSH_HOME/XDG paths. Parent wall time includes launch for CLI cases. Throughput
uses logical fixture bytes, not physical disk IO; known-frame metadata does not
read 20 MiB of expanded content. Peak RSS is a separate OS time-tool observation,
not total Desktop or child-process-group memory. Remaining gaps include cold OS
cache, Windows/Linux timing, prolonged load, model execution, Desktop memory and
real mobile/network latency.
