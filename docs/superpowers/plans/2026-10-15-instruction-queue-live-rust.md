# Instruction Queue Live Rust Bridge Implementation Plan

> **For agentic workers:** Follow this plan inline, one task at a time. Each task has a test before implementation and a verification step.

**Goal:** Route live Dashboard instruction queue writes through one long-lived Rust process while preserving the existing state JSON, HTTP errors, and update ordering.

**Architecture:** `rdsh instruction-queue serve` accepts one JSON request per line and returns one JSON result per line. `ProjectStore` sends only instruction queue mutations to a per-Dashboard worker; its existing serialized update queue still owns commit ordering, and all other store operations retain their current handlers.

**Tech Stack:** Rust (`serde_json`, `std::io`), Node.js child process and readline, Dashboard `ProjectStore` tests.

---

## Task 1: Add the Rust JSONL worker protocol

**Files:**

- Modify: `src/instruction_queue.rs`
- Modify: `src/main.rs`
- Test: `tests/instruction_queue_cli.rs`

- [x] Add `instruction_queue::cmd_instruction_queue_serve()` and a `serve` CLI action that does not require `--input-file`.
- [x] Parse each input line as `{ operation, state, input, context }`; return a result line with the existing operation output, or `{ "error": message, "status": code }` for that request, then continue reading the next line.
- [x] Keep file-based `validate|context|submit|resolve|control` behavior unchanged by extracting a shared `run_instruction_queue(action, document)` function.
- [x] Add an integration test that sends a successful mutation, an invalid request, then another valid request through one child and verifies three ordered response lines and continued service after the error.
- [x] Verify RED/GREEN with `CARGO_TARGET_DIR=/tmp/rdsh-instruction-queue-target cargo test --locked --test instruction_queue_cli instruction_queue_serve`.

## Task 2: Add a managed Node worker

**Files:**

- Create: `dashboard/instruction-queue-worker.mjs`
- Create: `dashboard/test/instruction-queue-worker.test.mjs`

- [x] Resolve the absolute `rdsh` executable from `RDSH_BIN` or absolute `PATH` entries, spawn `rdsh instruction-queue serve`, and serialize requests through a promise queue.
- [x] Pair each request with exactly one stdout JSON line; reject the waiting call on parse failure, process exit, or spawn error, and throw native errors with their returned `status`.
- [x] Implement `close()` by ending stdin and waiting for process exit, with a bounded termination fallback.
- [x] Use a temporary fake executable in tests to cover request order, native error status, premature exit, and clean close.
- [x] Verify with `mise exec node@22.23.2 -- node --test dashboard/test/instruction-queue-worker.test.mjs`.

## Task 3: Route ProjectStore writes through the worker

**Files:**

- Modify: `dashboard/state.mjs`
- Modify: `dashboard/server.mjs`
- Modify: `dashboard/test/answer-applications.test.mjs`

- [x] Let `ProjectStore.open(project, { instructionQueueWorker })` retain an optional worker. In `mutateReply`, map `instruction_submit|instruction_resolve|control` to `submit|resolve|control`, send the cloned state and context, and commit only after a successful native response. Rust validates the returned instruction state before acknowledging it.
- [x] Preserve the `history_backups` reference in the cloned state because instruction mutations cannot change it and `commit()` uses reference identity to detect restored-history changes.
- [x] Allow one worker for the live project Dashboard behind `RDSH_DASHBOARD_RUST_INSTRUCTION_QUEUE=1`, pass it to `ProjectStore`, and close it after the update queue drains during normal shutdown. Automatic use remains disabled until the live latency gate passes.
- [x] Keep direct `ProjectStore` tests injectable so existing tests without a compiled binary continue to use the existing JavaScript handler.
- [x] Add a store test proving native returned state/result are committed and native errors leave the stored state untouched; run focused store/worker tests.

## Task 4: Verify the live boundary and performance

**Files:**

- Modify: `docs/` only if observed behavior changes the migration record.

- [x] Build the release binary and run ProjectStore mutation benchmarks against that exact worker binary.
- [ ] Compare JavaScript and Rust outputs for submit, retry, stale review, append, interrupt approval, cancel claim, and proof reconciliation.
- [x] Measure the live ProjectStore mutation end-to-end before and after worker routing using the same state fixture; record median and p95, and retain the JavaScript fallback if the worker regresses the measured end-to-end path.
- [x] Run `cargo test --locked --release`, `cargo clippy --locked --all-targets --release -- -D warnings`, `cargo +1.85.0 check --locked --all-targets`, `cargo fmt --all -- --check`, and the focused Node tests.
- Full Dashboard runtime migration remains open; this worker covers only instruction mutations.

### 2026-10-15 performance gate

On macOS arm64 with Node 24.21.0 and the Release `rdsh` from this worktree, the same fixture started with 100 accepted instructions. Five pairs each measured 20 mutations after five warm-up operations. Median-of-pair-medians was 2.18 ms for JavaScript and 4.68 ms for the Rust worker; median-of-pair-p95 values were 3.05 ms and 5.94 ms. The JSONL worker remains opt-in through `RDSH_DASHBOARD_RUST_INSTRUCTION_QUEUE=1`; the default Dashboard path stays in-process JavaScript until a lower-overhead Rust state boundary removes this regression.

The focused Node 22 ProjectStore/worker tests pass. The complete answer-applications suite still has 22 failures at session setup with `Session ledger: cleanup_unconfirmed`, tracked separately as issue #548; the tests that reach the ProjectStore/worker cases pass.
