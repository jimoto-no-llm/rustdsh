# Final performance comparison, 2026-10-14

Current upstream base: `f3b836e34b871452a4b03723159d9a2821b3062b`. Candidate and baseline release binary SHA-256 values are in [the identity record](performance-identity.json). These measurements include the upstream search/compute fixes on both sides; they do not attribute upstream optimizations to localization.

macOS 26.6.2 arm64, Apple M5 Max, 18 logical CPUs; three warmups and fifteen measured samples, alternating baseline/candidate for sequential cases. Other owned compiles/browser/full-test jobs had ended before this final measurement. The host remained in normal use. Raw samples and separate peak-RSS observations remain in [basic JSON](performance-final.json) and [extended JSON](performance-extended-final.json).

## Basic CLI cases

| Operation | Candidate median / p95 ms | Upstream median / p95 ms | Median ratio | Peak RSS candidate / upstream MiB | Same output |
| --- | --- | --- | --- | --- | --- |
| version | 7.561 / 11.641 | 7.927 / 12.553 | 0.954 | 2.61 / 2.47 | True |
| tokens_ascii | 9.827 / 10.635 | 10.162 / 12.956 | 0.967 | 13.12 / 12.77 | True |
| tokens_cjk | 10.639 / 12.425 | 11.025 / 11.814 | 0.965 | 4.48 / 4.14 | True |
| search | 11.988 / 13.383 | 12.408 / 14.172 | 0.966 | 4.39 / 4.17 | True |
| prune | 9.630 / 32.578 | 10.398 / 13.886 | 0.926 | 4.53 / 4.20 | True |
| sessions_tokens | 12.060 / 13.918 | 12.331 / 15.918 | 0.978 | 3.41 / 3.09 | True |

## Extended CLI cases

| Operation | Candidate median / p95 ms | Upstream median / p95 ms | Median ratio | Same output |
| --- | --- | --- | --- | --- |
| compact_jsonl_1mib | 6.441 / 8.478 | 6.415 / 9.437 | 1.004 | True |
| search_at_least_32 | 5.594 / 6.821 | 5.673 / 6.041 | 0.986 | True |
| search_under_32 | 5.895 / 9.410 | 6.744 / 8.707 | 0.874 | True |
| sessions_cache_disabled | 11.929 / 31.977 | 10.782 / 27.636 | 1.106 | True |
| sessions_cache_warm | 9.929 / 14.195 | 10.032 / 11.846 | 0.990 | True |
| sessions_known_frame_first_cache_miss | 14.776 / 38.431 | 14.931 / 25.852 | 0.990 | True |
| sessions_streaming_zstd_no_content_size | 58.008 / 140.694 | 62.025 / 91.785 | 0.935 | True |

## Concurrent, growing and HTTP observations

- concurrent_4_writers: candidate 28.662 / 116.781 ms; upstream 28.024 / 72.386 ms.
- growing_stream: candidate 20.069 / 24.950 ms; upstream 20.695 / 39.993 ms.

Concurrent wall time covers the whole four-process group. Both growing-stream correctness checks pass; changing input sizes have no fixed throughput ratio.

| Native HTTP endpoint | Candidate median / p95 ms | Upstream median / p95 ms |
| --- | --- | --- |
| prune_40kib | 6.314 / 9.387 | 6.327 / 6.454 |
| tokens_40kib | 6.297 / 7.305 | 6.289 / 6.505 |
| version | 6.303 / 6.955 | 6.195 / 6.337 |

The basic median ratios range from 0.926 to 0.978 (candidate / upstream). These short measurements establish output compatibility and disclose observed overhead; they do not establish a universal speedup or production latency guarantee. p95 is the maximum of fifteen observations, so a single host stall remains visible. The extended HTTP series measures TCP connect plus the authenticated response against an already running Rust server, excluding browser rendering.

No provider, model, remote network or Electron startup was measured. Peak RSS is a separate process observation, not aggregate concurrent memory. Earlier loaded runs and a repeat are retained in the parent evidence directory; they show host contention and are not selected as favorable final figures. All thirteen sequential output comparisons pass. Existing budgets, security checks, retry semantics and parallelism limits remain unchanged.
