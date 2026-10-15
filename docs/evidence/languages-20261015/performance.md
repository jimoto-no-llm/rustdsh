# Performance observations

The candidate is the frozen merged macOS binary `7ec1e90782490ba61873b5a85e2238ba40ba617de1195c1c31ab7d52bd7a206c`. The baseline is an isolated source build of upstream `2db470bd15d2efbe58c9ff1a43e6679e5cea4d4a`, binary `22eae38f4a7a567b33d2d309eb1c36c5172084afae5338356f85c56d059b0962`. Neither replaces an installed binary.

Each case uses three warmups and 15 observations. CLI timings are parent wall-clock time including child process launch; filesystem caches stay warm. Extended sequential comparisons alternate order per sample; concurrent/growing/HTTP cases run in separate blocks. The HTTP series uses a persistent Rust server, not browser or server startup. Child peak RSS is a separate observation; concurrent aggregate RSS is not measured. Model/provider latency, external networks and Electron startup are excluded.

Both an initial run overlapping other local work and a repeat after ordinary Node tests completed are retained. The machine was still loaded during the repeat: observed load averages changed from approximately 21.36/15.50/12.76 to 19.37/15.34/12.75. This is not an idle-host experiment. Contention is an observed condition; its exact contribution to any sample is not established.

## Thirteen comparable CLI cases, repeat

Ratios divide candidate by baseline; smaller is faster. Every row retains identical stdout and every raw observation in the linked JSON files.

| Case | Baseline median ms | Candidate median ms | Median ratio | Baseline p95 ms | Candidate p95 ms | p95 ratio |
| --- | --- | --- | --- | --- | --- | --- |
| version | 7.937 | 7.826 | 0.986 | 8.892 | 8.845 | 0.995 |
| tokens_ascii | 10.243 | 10.117 | 0.988 | 11.934 | 16.203 | 1.358 |
| tokens_cjk | 11.670 | 11.454 | 0.981 | 23.242 | 33.135 | 1.426 |
| search | 13.493 | 12.183 | 0.903 | 21.620 | 23.540 | 1.089 |
| prune | 11.102 | 10.567 | 0.952 | 14.809 | 12.717 | 0.859 |
| sessions_tokens | 14.453 | 14.421 | 0.998 | 19.359 | 16.840 | 0.870 |
| sessions_known_frame_first_cache_miss | 18.026 | 16.957 | 0.941 | 22.108 | 19.283 | 0.872 |
| sessions_cache_disabled | 14.812 | 14.602 | 0.986 | 17.819 | 19.602 | 1.100 |
| sessions_cache_warm | 14.416 | 13.910 | 0.965 | 43.971 | 39.269 | 0.893 |
| sessions_streaming_zstd_no_content_size | 82.517 | 82.081 | 0.995 | 127.819 | 289.808 | 2.267 |
| search_under_32 | 6.388 | 6.243 | 0.977 | 7.823 | 9.033 | 1.155 |
| search_at_least_32 | 7.108 | 6.934 | 0.976 | 10.001 | 9.213 | 0.921 |
| compact_jsonl_1mib | 6.330 | 6.316 | 0.998 | 8.735 | 8.353 | 0.956 |

The observed median range is 0.903–0.998. The streaming zstd case has a worse p95: 289.808 ms versus 127.819 ms, ratio 2.267. Other tails also rise, including CJK token counting (1.426), ASCII token counting (1.358) and the small search fixture (1.155). The basic repeat's per-child peak RSS values are higher for the candidate. These observations support no universal speed or memory improvement claim.

## Additional extended observations

The four-writer repeat has a median of 29.877 ms versus 32.010 ms (ratio 0.933), but p95 is 40.389 ms versus 36.209 ms (1.115). The growing-stream repeat has a median of 25.741 ms versus 24.682 ms (1.043); its baseline has a large tail. Persistent HTTP medians are close: version ratio 1.022, tokens ratio 1.005, prune ratio 0.998. These separate-block samples do not isolate source causality.

The initial run has mixed median directions, including cases above 1.0; it is not discarded in favor of the repeat. Neither series is promoted to a controlled regression determination. A future isolated investigation should reproduce the streaming-zstd tail before assigning a source cause or changing a product budget. No deadline, concurrency limit, test assertion or performance threshold was relaxed.

## Raw records

- Initial: [basic](performance-initial.json), [extended](performance-extended-initial.json), [load/exit records](performance-initial-load.json).
- Repeat: [basic](performance-repeat.json), [extended](performance-extended-repeat.json), [load/exit records](performance-repeat-load.json).
- [Summary with binary SHA-256 and all thirteen comparisons](performance-summary.json).

Local absolute command paths and machine-identifying metadata are omitted from public copies; numerical samples, load observations, exit statuses and binary identifiers are retained. The extended runner's FNV identifiers are not substituted for the SHA-256 binary identities above. The optional original-DSH series is null and supplies no delegation-performance claim.

## Later fixed cc019 comparison

The later merged native candidate (`390cc393bf10a96f2093a5f466bfd9f63d0b9e1042381daee1e157272c1b16f0`) is compared with an isolated exact upstream cc019 build (`6062372c5b32016e852f921e26d7d869c6579346c3be74644c19ac5b1a37b161`). Both retain all 13 comparable stdout values. With three warmups and 15 samples, median ratios range from 0.921 to 1.034; the largest p95 ratio is 1.160 for cached session tokens. The streaming-zstd median/p95 ratios are 0.970/0.759 in this run. The earlier 2.267 tail remains recorded above; this observation does not identify its source cause.

Owned local builds and ordinary tests had completed before these measurements. Host load changed from 6.25/7.27/9.66 to 6.28/7.22/9.60, so this is still a shared-host observation. Optional plugin-only compatibility follow-ups do not change these native binaries. [Basic raw observations](performance-cc019-basic.json), [extended raw observations](performance-cc019-extended.json), [source/binary/exit/load receipt](performance-cc019-execution.json), [all 13 comparisons](performance-cc019-summary.json). No model/provider request, external user data or installed binary replacement is involved.

## Historical main29 comparison

The final product at `ca65dfb2664a5041c7600f28bb9b88ea1f4e4084` (binary SHA-256 `512255164703b66f41aa6e2a6390a0e57be297ee0aeeb8b1f5ec782b3692c932`) is compared with an isolated exact upstream `29e9a5c161ea81a6f3500215c1c2168743302c8c` build (`20c780bfb6b02ab4846646e2d78cfae0c2a0c1b16f996e7fc7ee616c8ce7b954`). All 13 CLI stdout values match. Three warmups and 15 observations give median ratios 0.955–1.068. The largest p95 ratio is 1.375 for the basic search corpus; the raw outlier remains recorded. Owned Mac builds and tests had finished before the observations, but the host remains shared.

The maintained `benchmark_regression` runner also passed its unchanged default 10% median regression gate against that exact upstream binary. This is separate from the raw tail observations and does not claim every workload is faster. [Basic](performance-main29-basic.json), [extended](performance-main29-extended.json), [execution/load](performance-main29-execution.json), [13-case summary](performance-main29-summary.json), [maintained regression gate](performance-main29-regression.json).

## Final a2c0827 integration comparison

The final normal release product (binary SHA-256 `098a955a6fe8c6f2513bb90e9a63d06bb628b816f130e31dd15c591b3e841f31`) is compared against an isolated exact upstream `a2c0827c50d7d2ab3cdfe70c94a39e6e6e6a8919` build (`d009fc92d2cb758b5f9dc513066667c2bc85dee7d025bb09be1893b4ceab5343`). It was rebuilt with `cargo build --release --locked` after every Cargo test; no Cargo command replaces it afterwards. All thirteen comparable stdout values match. Three warmups and fifteen observations per case give median ratios 0.921–1.015. The largest p95 ratio is 2.133 for search_under_32; every raw sample remains recorded. Owned Mac builds and tests had finished; ordinary shared-host load was still present.

The maintained regression runner passes its unchanged default 10% median threshold against the same upstream binary. This gate does not guarantee every tail is faster or establish a source cause for timing variation. [Basic raw observations](performance-a2-basic.json), [extended observations](performance-a2-extended.json), [execution/load receipt](performance-a2-execution.json), [all thirteen comparisons](performance-a2-summary.json), [maintained regression gate](performance-a2-regression.json).

An earlier a2 observation used the distinct Cargo test-stage executable `5e3cc1e4b4c01aa35de0c55b0d4711c89a689b2a974ae5fc5f5449a7e991c4e2`. Its thirteen equal stdout values, median range 0.837–1.006 and largest p95 ratio 4.691 remain historical measurements, not final normal-release qualification. [Basic](performance-a2-test-stage-basic.json), [extended](performance-a2-test-stage-extended.json), [execution](performance-a2-test-stage-execution.json), [summary](performance-a2-test-stage-summary.json), [regression](performance-a2-test-stage-regression.json).

## Subsequent 096 integration checkpoint comparison

The normal 096 integration executable (`6c32974fa817b324375afdbd9dc086339ca9a4c3cc042f29003188ec0706870e`) is compared with the preserved a2 localized normal executable (`098a955a6fe8c6f2513bb90e9a63d06bb628b816f130e31dd15c591b3e841f31`). This checks the subsequent integration against the earlier localized checkpoint, not a freshly built 096 upstream baseline. All thirteen stdout values match; three warmups and fifteen samples give median ratios 0.950–1.052 and maximum p95 ratio 2.181. The unchanged maintained 10% median gate passes. Owned builds/tests had completed; shared-host load remains recorded. No model request is made. [Raw basic](performance-096-basic.json), [raw extended](performance-096-extended.json), [execution and load](performance-096-execution.json), [summary](performance-096-summary.json), [regression gate](performance-096-regression.json).

## Final 9bfdaa1 upstream comparison

The final normal candidate (`f22d06f5b7d3687c56e7865acd7d0b94423251c1bbd6cf5a5f08b930afc5c128`) is compared with a freshly rebuilt exact upstream `9bfdaa166e2800ef393a365d8d45fc1117e8d884` normal executable (`c33ad187f71a97af5df4696f71df342b87f8167b63713284ba383b13af20f942`). The unmodified source comes from Git archive; a cloned dependency cache does not share writes with the preserved earlier checkpoint. All thirteen stdout values match. Three warmups and fifteen samples give median ratios 0.894–1.142, maximum p95 ratio 1.367, and a passing unchanged 10% median gate. These shared-host observations establish this measured gate, not a general speedup or a causal explanation for variation. [Basic](performance-main9-basic.json), [extended](performance-main9-extended.json), [execution/load](performance-main9-execution.json), [summary](performance-main9-summary.json), [regression gate](performance-main9-regression.json), [baseline build](performance-main9-baseline.json).

The first extended run stopped on one non-200 loopback HTTP response. Its failure log remains private and is hashed in integration-main9-validation.json. Independent exact-upstream/candidate probes then passed all 108 requests. The benchmark now reports binary, method, route and HTTP status when it fails; no assertion, timeout, sample count or threshold changes. The unchanged workload rerun passes; the exact cause of the first response is not asserted.

The maintained hard gate covers four headline cases (version startup, 1 MiB and 10 MiB token counting, and the 200-file search); it does not impose a 10% limit on all thirteen comparisons. The initial `sessions_tokens` median was 14.2% slower, with all samples retained. A targeted confirmation with the same workload/helpers and alternating order, three warmups and 31 observations gives median ratio 1.026 and p95 ratio 1.014. [Both the confirmation and its exact binary hashes](performance-main9-sessions-confirmation.json) are preserved. No timing cause or zero-overhead guarantee is asserted.

## Final778 upstream comparison

[Raw basic](performance-main778-basic.json), [raw extended](performance-main778-extended.json), [execution](performance-main778-execution.json) and [ratios](performance-main778-summary.json) identify the ordinary candidate`1a7d683e` and exact unmodified upstream778 baseline`92eeac9d`. Every one of13 workloads has identical stdout, three warmups and15 observations. Median ratios are0.944–1.036. The worst p95ratio is1.860 for compacting1MiB JSONL; warm session-cache p95 is1.225. RSS also rises in individual cases. All observations remain, including old9bf/a2 outliers; no blanket speedup or zero-overhead claim is made.

The [maintained regression gate](performance-main778-regression.json) passes its unchanged default10% median limit on version startup,1MiB/10MiB token counting and200-file search. That limit applies to these four headline cases. Timing measures parent wall clock including process launch on a shared18CPU macOS host with warm OS caches; it does not qualify physical storage, Electron startup or remote model latency.
