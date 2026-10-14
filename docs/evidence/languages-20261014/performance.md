# Final performance comparison, 2026-10-14

Current upstream base: `f3b836e34b871452a4b03723159d9a2821b3062b`. Candidate and baseline release binary SHA-256 values are in [the identity record](performance-identity.json). These measurements include the upstream search/compute fixes on both sides; they do not attribute upstream optimizations to localization.

macOS 26.6.2 arm64, Apple M5 Max, 18 logical CPUs; three warmups and fifteen measured samples, alternating baseline/candidate for sequential cases. Other owned compiles/browser/full-test jobs had ended before this final measurement. The host remained in normal use. Raw samples and separate peak-RSS observations remain in [basic JSON](performance-final.json) and [extended JSON](performance-extended-final.json).

## Basic CLI cases

| Operation | Candidate median / p95 ms | Upstream median / p95 ms | Median ratio | Peak RSS candidate / upstream MiB | Same output |
| --- | --- | --- | --- | --- | --- |
| version | 6.990 / 25.575 | 7.628 / 20.733 | 0.916 | 2.59 / 2.48 | True |
| tokens_ascii | 9.047 / 9.853 | 9.224 / 11.678 | 0.981 | 13.00 / 12.77 | True |
| tokens_cjk | 9.585 / 21.381 | 9.963 / 11.942 | 0.962 | 4.36 / 4.14 | True |
| search | 10.281 / 15.292 | 10.521 / 17.334 | 0.977 | 4.50 / 3.98 | True |
| prune | 9.581 / 15.839 | 9.397 / 14.747 | 1.020 | 4.53 / 4.28 | True |
| sessions_tokens | 11.200 / 18.180 | 11.342 / 14.305 | 0.987 | 3.36 / 3.08 | True |

## Extended CLI cases

| Operation | Candidate median / p95 ms | Upstream median / p95 ms | Median ratio | Same output |
| --- | --- | --- | --- | --- |
| compact_jsonl_1mib | 5.275 / 6.875 | 5.391 / 6.199 | 0.979 | True |
| search_at_least_32 | 5.979 / 9.342 | 6.009 / 10.274 | 0.995 | True |
| search_under_32 | 5.375 / 6.462 | 5.744 / 13.439 | 0.936 | True |
| sessions_cache_disabled | 13.185 / 22.363 | 13.446 / 16.680 | 0.981 | True |
| sessions_cache_warm | 13.207 / 17.338 | 14.672 / 19.636 | 0.900 | True |
| sessions_known_frame_first_cache_miss | 14.865 / 18.120 | 15.015 / 17.999 | 0.990 | True |
| sessions_streaming_zstd_no_content_size | 67.319 / 84.819 | 65.676 / 102.189 | 1.025 | True |

## Concurrent, growing and HTTP observations

- concurrent_4_writers: candidate 28.383 / 38.703 ms; upstream 26.976 / 50.081 ms.
- growing_stream: candidate 21.031 / 27.602 ms; upstream 22.808 / 26.922 ms.

Concurrent wall time covers the whole four-process group. Both growing-stream correctness checks pass; changing input sizes have no fixed throughput ratio.

| Native HTTP endpoint | Candidate median / p95 ms | Upstream median / p95 ms |
| --- | --- | --- |
| prune_40kib | 5.958 / 6.336 | 6.264 / 6.388 |
| tokens_40kib | 6.296 / 6.536 | 6.282 / 6.535 |
| version | 6.246 / 6.381 | 6.257 / 6.307 |

The basic median ratios range from 0.916 to 1.020 (candidate / upstream). These short measurements establish output compatibility and disclose observed overhead; they do not establish a universal speedup or production latency guarantee. p95 is the maximum of fifteen observations, so a single host stall remains visible. The extended HTTP series measures TCP connect plus the authenticated response against an already running Rust server, excluding browser rendering.

No provider, model, remote network or Electron startup was measured. Peak RSS is a separate process observation, not aggregate concurrent memory. Earlier loaded runs and a repeat are retained in the parent evidence directory; they show host contention and are not selected as favorable final figures. All thirteen sequential output comparisons pass. Existing budgets, security checks, retry semantics and parallelism limits remain unchanged.
