# Query encoding allocation benchmark

The production change replaces a temporary `format!` string for each escaped
byte with `write!` into the output string. Output equality was checked for ASCII,
Japanese, CRLF, emoji and NUL/tab inputs.

Baseline: `96dbcbbd6e1295b2e92ba31e9cf9037770107b24`.
Candidate: `19c4a6d0d42b37ac7079d7cf0ac92ca52bb99b24`.
Both functions are extracted verbatim from Git and compiled with `rustc -O`.
The timer uses no allocator instrumentation. A separate binary counts allocations
and reallocations. No network request or model is used.

Environment: WSL2 Linux on AMD Ryzen 9 7950X3D. Five warmup pairs precede
30 alternating samples, each with 10,000 calls using `日本語 Rust&CLI? 100%`.

| Observation | Baseline | Candidate |
| --- | ---: | ---: |
| Median elapsed time per 10,000 calls | 4.408597 ms | 1.9888165 ms |
| Allocations/reallocations per call | 26 | 2 |

This measures only query encoding, not end-to-end websearch latency. Allocation
counts depend on the input. Raw samples and environment are in
[query-encoding-benchmark.json](query-encoding-benchmark.json).

From a checkout with both commits available, Node and Rust on PATH:

```sh
node docs/evidence/query-encoding-benchmark.mjs /tmp/query-encoding-benchmark.json
```
