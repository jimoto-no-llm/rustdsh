# Final performance comparison, 2026-10-14

Current upstream base: `f3b836e34b871452a4b03723159d9a2821b3062b`. Candidate and baseline release binary SHA-256 values are in [the identity record](performance-identity.json). These measurements include the upstream search/compute fixes on both sides; they do not attribute upstream optimizations to localization.

macOS 26.6.2 arm64, Apple M5 Max, 18 logical CPUs; three warmups and fifteen measured samples, alternating baseline/candidate for sequential cases. Other owned compiles/browser/full-test jobs had ended before this final measurement. The host remained in normal use. Raw samples and separate peak-RSS observations remain in [basic JSON](performance-final.json) and [extended JSON](performance-extended-final.json).

## Basic CLI cases

| Operation | Candidate median / p95 ms | Upstream median / p95 ms | Median ratio | Peak RSS candidate / upstream MiB | Same output |
| --- | --- | --- | --- | --- | --- |
| version | 5.211 / 10.287 | 5.439 / 18.321 | 0.958 | 2.59 / 2.47 | True |
| tokens_ascii | 7.996 / 8.506 | 7.701 / 11.576 | 1.038 | 13.09 / 12.78 | True |
| tokens_cjk | 9.305 / 21.762 | 9.886 / 14.731 | 0.941 | 4.47 / 4.14 | True |
| search | 10.582 / 13.217 | 10.484 / 37.726 | 1.009 | 4.45 / 4.16 | True |
| prune | 8.999 / 12.366 | 8.739 / 12.187 | 1.030 | 4.50 / 4.19 | True |
| sessions_tokens | 10.946 / 15.496 | 10.963 / 15.137 | 0.998 | 3.42 / 3.09 | True |

## Extended CLI cases

| Operation | Candidate median / p95 ms | Upstream median / p95 ms | Median ratio | Same output |
| --- | --- | --- | --- | --- |
| compact_jsonl_1mib | 4.939 / 6.332 | 5.175 / 9.074 | 0.954 | True |
| search_at_least_32 | 4.941 / 5.353 | 5.051 / 6.961 | 0.978 | True |
| search_under_32 | 4.714 / 5.586 | 5.071 / 12.751 | 0.930 | True |
| sessions_cache_disabled | 10.540 / 15.349 | 10.207 / 15.600 | 1.033 | True |
| sessions_cache_warm | 9.565 / 13.608 | 9.653 / 15.103 | 0.991 | True |
| sessions_known_frame_first_cache_miss | 14.582 / 22.006 | 15.094 / 20.891 | 0.966 | True |
| sessions_streaming_zstd_no_content_size | 63.457 / 108.113 | 68.882 / 110.216 | 0.921 | True |

## Concurrent, growing and HTTP observations

- concurrent_4_writers: candidate 23.777 / 28.928 ms; upstream 26.185 / 33.962 ms. Group wall time includes four processes for concurrent writers. Growing-stream correctness passes for both binaries; its changing byte count has no fixed throughput ratio.
- growing_stream: candidate 20.786 / 27.868 ms; upstream 20.860 / 28.740 ms. Correctness passes for both binaries; its changing byte count has no fixed throughput ratio.

| Native HTTP endpoint | Candidate median / p95 ms | Upstream median / p95 ms |
| --- | --- | --- |
| prune_40kib | 6.819 / 7.850 | 6.892 / 7.832 |
| tokens_40kib | 7.534 / 7.754 | 7.539 / 7.685 |
| version | 7.523 / 7.636 | 7.476 / 7.568 |

The basic medians range from roughly 6% faster to 4% slower. These short measurements establish output compatibility and disclose observed overhead; they do not establish a universal speedup or production latency guarantee. p95 is the maximum of fifteen observations, so a single host stall remains visible. The extended HTTP series measures TCP connect plus the authenticated response against an already running Rust server, excluding browser rendering.

No provider, model, remote network or Electron startup was measured. Peak RSS is a separate process observation, not aggregate concurrent memory. Earlier loaded runs and a repeat are retained in the parent evidence directory; they show host contention and are not selected as favorable final figures. All thirteen sequential output comparisons pass. Existing budgets, security checks, retry semantics and parallelism limits remain unchanged.
