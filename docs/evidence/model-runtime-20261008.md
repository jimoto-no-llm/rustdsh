# Codex / Claude runtime verification, 2026-10-08

**Overall result: FAIL.** All 24 planned runs finished and were recorded; model
acceptance passed 23/24, while strict runtime acceptance passed 11/24. These
results do not establish complete model/runtime E2E acceptance.

## Environment and artifacts

- Main run: 2026-10-08 10:30 JST, macOS Darwin 25.6.0, aarch64, rustc 1.99.0.
- Installed official DSH: 0.2.0-rc.2. Rust executable: rdsh 0.1.5, release build.
- Main harness source: `c3d59d901ab2a43f90104bd19915f1103012a3e6`.
- Diagnostic follow-up source: `80664644100edffc4cf6fdc0e210e796189389f5`.
- Rust executable SHA-256: `809b9833e17d01d410e8306c7a7e328dba5845c9b11cd15bd32d476aa9de73ea`.
- [All 24 main runs](model-runtime-20261008.json), including token usage,
  routes, effort, tool counts, timeouts, exit codes and runtime bundle SHA-256.
- [Six diagnostic Rust repair runs](model-rust-triage-20261008.json).
- [Runner, isolation, acceptance and reproduction](../MODEL_BENCHMARKS.md).

Both models used high reasoning effort, verified in stored request headers.
Every main run verified its session request route, advertised tool catalog,
zero retry-attempt events and the request cap. The 24 runs recorded 42 provider
attempts; the configured cap allowed at most 48 agent request preparations.
Provider and launcher order alternated, runs were sequential, and the Node
compile cache started empty. Prompts had unique equal-length nonces and the
same arithmetic workload. No pricing or billing was measured.

## Main measurements

Times are process spawn to the committed `turn_end`, including launcher boot,
network and model work. p50/p95 use nearest rank on accepted model runs only;
failed attempts remain in the full JSON. This is not first-token latency.

| Model | Task | Launcher | Model pass | Runtime pass | p50 seconds | p95 seconds |
|---|---|---|---:|---:|---:|---:|
| GPT 6.1 Sol | Short response | Original DSH | 3/3 | 0/3 | 4.825 | 5.021 |
| GPT 6.1 Sol | Short response | rdsh | 3/3 | 0/3 | 3.645 | 4.475 |
| GPT 6.1 Sol | Read JSON fixture | rdsh | 3/3 | 0/3 | 4.742 | 6.623 |
| GPT 6.1 Sol | Repair Rust | rdsh | 3/3 | 0/3 | 8.699 | 9.131 |
| Claude Sonnet 5.5 | Short response | Original DSH | 3/3 | 3/3 | 1.831 | 2.080 |
| Claude Sonnet 5.5 | Short response | rdsh | 3/3 | 3/3 | 1.788 | 2.130 |
| Claude Sonnet 5.5 | Read JSON fixture | rdsh | 3/3 | 3/3 | 3.712 | 5.135 |
| Claude Sonnet 5.5 | Repair Rust | rdsh | 2/3 | 2/3 | 3.732 | 4.885 |

Every executed Rust oracle exercised inputs 0 through 1,000. The original buggy
fixture failed before model execution. The successful repairs passed the external
Cargo tests without giving the model access to test files or shell execution.

## Failures and diagnostic follow-up

### Codex shutdown

All 12 main Codex runs produced their expected answer, completed turn and official
final event, but remained alive after the two-second shutdown grace period. The
runner terminated its own process group and recorded `shutdown_timeout`. An
initial original-DSH pilot had already remained alive for 120 seconds after its
completed answer (first committed text: 6.841 seconds). This occurs with both the
original launcher and Rust delegation; the data does not identify a Rust regression.

The official headless runner flushes its session, writes `final`, then calls the
launcher's `appExit`. The initial investigation found natural event-loop drain and
global plugin disposal as potential sources of the stall. The live root cause
was not determined. A leaked transport handle is a hypothesis, not a verified cause.

### Claude Rust acceptance

Main sample 2 returned `FIXED` and exited normally, but failed the combined Rust
acceptance gate. That run did not distinguish source-shape rejection from Cargo
oracle failure, so it cannot be described as a confirmed incorrect implementation.

The runner was updated to record these stages independently, then only the Rust
repair exercise was repeated three times per model. The follow-up accepted 5/6
model results and 2/6 runtime results. Codex passed 3/3 Rust oracles and retained
its shutdown failure. Claude passed 2/3 Rust oracles; its other output was outside
the four reviewed implementation shapes (`generated_source_allowed=false`), so
Cargo was **not executed** (`cargo_oracle_passed=null`). Its answer and normal
exit succeeded. The semantics of that unexecuted implementation remain unverified.
The follow-up does not replace or remove the failed main sample.

### Pilot accounting

Two interrupted pilot series retained 14 completed sanitized run summaries plus
two interrupted runs without full results. They exposed shutdown behavior,
attachment-scoped `read_image` remaining advertised, and insufficiently explicit
answer-format instructions. Before the main run, attachment/image plugins were
disabled and prompts specified `NONCE:TOTAL` with no spaces or code fences.
Pilot conditions differ from the main run and are excluded from its timing table.
All raw pilot workspaces, sessions, profiles and caches were removed.

## Local checks and remaining acceptance

Rust's 80 existing unit/integration/native E2E tests, two extended benchmark tests,
five model-runner tests, 20 plugin/client/fence tests and 42 regression checks passed.
Formatting and Clippy with warnings denied also passed. The regression shell's
first run encountered an unrelated managed-Python download/attestation 503; using
the already installed Python interpreter made all 42 checks pass without disabling
artifact verification.

Only sanitized reports were retained after live runs; reasoning, raw tool payloads,
stderr, credential values, workspaces and sessions were not published. Existing
profiles were not edited. Normal official-provider OAuth refresh was permitted.

Still unverified: Codex normal shutdown, the unsupported Claude source semantics,
long-running tasks, first-token latency, stable tail latency, general coding quality,
and Electron Desktop GUI operation. With three samples, p95 is the maximum; model
time/network variability prevents attributing the response difference to Rust
launcher speed. Source changes after the two measured commits affect diagnostics,
offline catalog validation and documentation, not the measured Rust launcher.
