# Mac CLI performance verification, 2026-10-08

Measured locally on macOS, Apple M5 Max, 18 logical CPUs. Each case uses 3 warmups
and 15 measured invocations. Candidate and base order alternate between samples.
The host was in normal use; these are warm CLI measurements, not an idle-host or
cold Desktop startup experiment. Timing includes process launch from Python.

Base source: `f2a7dc6b2850a6f0c0e1ea1b53494b12cd2e1221`. Candidate is the
settings-recovery maintenance change based on that commit. Both binary hashes and
every timing sample are in [raw JSON](performance-20261008.json).

| Synthetic workload | Candidate median / p95 ms | Base median / p95 ms | Same stdout |
| --- | --- | --- | --- |
| `version` | 4.156 / 5.939 | 4.206 / 4.707 | yes |
| `tokens_ascii` | 5.786 / 8.292 | 5.820 / 9.153 | yes |
| `tokens_cjk` | 5.753 / 10.072 | 5.838 / 7.042 | yes |
| `search` | 12.224 / 14.771 | 12.376 / 15.789 | yes |
| `prune` | 7.193 / 10.423 | 6.735 / 14.531 | yes |
| `sessions_tokens` | 9.473 / 11.938 | 9.404 / 10.433 | yes |

Candidate `--version` peak RSS: 2.41 MiB.
Original installed DSH `--version`: median 91.167 ms, p95
101.037 ms, peak RSS 89.27 MiB.
Peak RSS is a separate `/usr/bin/time -l` observation for each case.
Original DSH and rdsh version strings identify different binaries; stdout equality
is checked between base and candidate rdsh, not between different products.

## Workloads and limits

- ASCII token estimation: 10 MiB. CJK token estimation and prune: 50,000 repeated
  multilingual lines, 1450000 UTF-8 bytes.
- Search: 300 files, 600,000 lines, 100 returned hits.
- Sessions: 20 synthetic sessions, each a 1 MiB zstd frame with known content size.
  Warm cache and frame metadata avoid expansion; this is not the streaming zstd
  fallback or growing-session benchmark. Every returned token estimate is checked.
- No credentials, real transcripts, model calls, Desktop startup, or remote machines
  are used. HOME, DSH_HOME, and XDG directories are temporary fixtures.

Most medians remain close to base; prune was approximately 7 percent slower in
this run. Small timing changes
on an active host do not establish an optimization gain. p95 variation remains
visible in the raw data. Model latency, Electron RSS, cold filesystem caches,
Windows/Linux performance, and concurrent session-cache writers remain unmeasured.

## Reproduce

Build base and candidate release binaries in separate worktrees, then run:

```sh
python3 scripts/benchmark.py --bin ./target/release/rdsh \
  --baseline /path/to/base/target/release/rdsh --n 15 \
  --output /tmp/rdsh-performance.json
```

Add `--dsh /path/to/original/dsh` only to compare its `--version` startup. The
script fails on command errors, unstable output, differing base/candidate stdout,
or incorrect synthetic-session estimates. It reports missing zstd explicitly.
