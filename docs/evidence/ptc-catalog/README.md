# PTC catalog verification

This evidence covers P1 [#80](https://github.com/jimoto-no-llm/rustdsh/issues/80).
The optional [bundle](../../../plugins/rdsh-ptc-catalog/README.md) preserves the
original DSH execution path and replaces only the model-facing SDK section.
It does not activate PTC in rdsh's guarded Native launcher.

## Recorded Windows result

[Machine report](windows-benchmark.json) and [actual output comparison](before-after.txt)
were generated from the same local source using Node 22.23.3,
`@deepseek-ai/dsh-tools@0.2.0-rc.2` and `js-tiktoken@1.0.21` / `cl100k_base`.
The report includes SHA-256 identities for the runtime, benchmark fixture and
lockfile. Hashes cover the listed files, not the entire repository/dependency tree.

| Measurement | Original full SDK | Scoped catalog |
| --- | ---: | ---: |
| Visible capability tools | 1,000 | 1,000 |
| Fixed query/execution fixtures | 80 | 80 |
| Encoded SDK input tokens | 78,400 | 909 |
| SDK UTF-8 bytes | 289,814 | 4,339 |
| Input payload tokens per fixture | 78,434 | 3,074.5 |
| Lookup successes | 80/80 | 80/80 |
| Incorrect body calls | 0 | 0 |
| Actual correct body calls | 80 | 80 |
| Outer PTC submissions per fixture | 1 | 2 |
| Nested dispatches | 80 | 240 |
| SDK stable after unrelated addition | No | Yes |
| Full assembly median, 5 samples | 45.090 ms | 91.568 ms |

The declaration reduction is 98.84%; the scripted input-payload reduction is
96.08%. Input payload totals count the complete prompt per outer PTC submission
and the discovery result, excluding provider request envelopes and earlier
conversation. These are encoded fixture strings, not provider-billed usage,
DeepSeek tokenizer counts or model quality. The full-declaration baseline has
an exact-name oracle; the catalog ranks the fixed query. Search and describe
share the first submission, with invocation in the second submission.

The public hook runs after original full-SDK assembly, so it does not reduce
that CPU/allocation work. The measured assembly overhead is reported rather
than hidden behind the token reduction.

## Local validation scope

Windows Node 22 and Linux Node 24: 12 tests passed, failed/cancelled/skipped 0
on each OS. This includes actual Cordis injection, default configuration and
disposal, added in source `838f38b`. The original Node
PTC provider returned this actual fixed-program result:

```json
{"fixture":"original-node-provider","result":{"value":{"value":"ORIGINAL_NODE_BINDING"},"name":"fixture/read.value","completeTypes":true,"hidden":"not_found","credentialAbsent":true},"actualBodyCalls":1,"guardDenied":true,"nestedEvents":5}
```

The other tests exercise the actual DSH registry, scoped inheritance and
restrictions, shadowing, exact namespace boundaries, pagination, normalization
collisions, complete schemas, both original language renderers, explicit budget
failure, stable SDK bytes, late restriction, original guards/typed-return
failures, parallel dispatch, complete prompt authority and effect disposal.

The matching runtime source `ca09567` also passed `cargo fmt --check`, release
Clippy with zero warnings, Rust 103 tests, 7 example tests and 53 regress checks.
Its Linux dashboard suite passed all 182 tests, skipped 0. The explicit
release-binary security invocation passed all 15 checks; the kernel-isolated
dispatcher probe rejected catalog activation while still allowing approved
inspection. A first local security invocation omitted `BIN` and could not
start its CLI fixtures; it is not counted as successful verification.

This execution fixture uses a fresh home/workspace and no inherited provider
credentials. Its fixed program uses full access; it is not a sandbox security
claim. The [matching Linux machine report](linux-benchmark.json) records the
same token/lookup/dispatch results with Node 24.21.0; its assembly medians were
46.438 ms before and 76.823 ms after. Token/payload numbers agree across OSes;
timings are environment-specific.

The initial [three-OS CI run](https://github.com/jimoto-no-llm/rustdsh/actions/runs/37828833871)
on runtime source `ca09567` passed the then-current 11 tests plus the benchmark
on Linux, macOS and Windows. The additional lifecycle test and evidence-only
changes are tracked separately by the latest PR checks; earlier CI is not
presented as a check on a later head.

Reproduce with the bundle's documented `npm ci`, tests and benchmark. The
workflow uploads a separate benchmark report for each OS. No live model,
paid API, GPU, actual MCP server or existing user profile was used or changed.
