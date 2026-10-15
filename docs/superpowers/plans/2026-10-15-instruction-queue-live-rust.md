# Instruction Queue Live Rust Bridge Implementation Plan

> **For agentic workers:** Follow this plan inline, one task at a time. Each task has a test before implementation and a verification step.

**Goal:** Route live Dashboard instruction queue writes through one long-lived Rust process while preserving the existing state JSON, HTTP errors, and update ordering.

**Architecture:** `rdsh instruction-queue serve` accepts one JSON request per line and returns one JSON result per line. `ProjectStore` sends only instruction queue mutations to a per-Dashboard worker; its existing serialized update queue still owns commit ordering, and all other store operations retain their current handlers.

**Tech Stack:** Rust (`serde_json`, `std::io`), Node.js child process and readline, Dashboard `ProjectStore` tests.

---

### Task 1: Add the Rust JSONL worker protocol

**Files:**
- Modify: `src/instruction_queue.rs`
- Modify: `src/main.rs`
- Test: `tests/instruction_queue_cli.rs`

- [ ] Add `instruction_queue::cmd_instruction_queue_serve()` and a `serve` CLI action that does not require `--input-file`.
- [ ] Parse each input line as `{ operation, state, input, context }`; return a result line with the existing operation output, or `{ "error": message, "status": code }` for that request, then continue reading the next line.
- [ ] Keep file-based `validate|context|submit|resolve|control` behavior unchanged by extracting a shared `run_instruction_queue(action, document)` function.
- [ ] Add an integration test that sends a successful mutation, an invalid request, then another valid request through one child and verifies three ordered response lines and continued service after the error.
- [ ] Verify RED/GREEN with `CARGO_TARGET_DIR=/tmp/rdsh-instruction-queue-target cargo test --locked --test instruction_queue_cli instruction_queue_serve`.

### Task 2: Add a managed Node worker

**Files:**
- Create: `dashboard/instruction-queue-worker.mjs`
- Create: `dashboard/test/instruction-queue-worker.test.mjs`

- [ ] Resolve the absolute `rdsh` executable from `RDSH_BIN` or absolute `PATH` entries, spawn `rdsh instruction-queue serve`, and serialize requests through a promise queue.
- [ ] Pair each request with exactly one stdout JSON line; reject the waiting call on parse failure, process exit, or spawn error, and throw native errors with their returned `status`.
- [ ] Implement `close()` by ending stdin and waiting for process exit, with a bounded termination fallback.
- [ ] Use a temporary fake executable in tests to cover request order, native error status, premature exit, and clean close.
- [ ] Verify with `mise exec node@22.23.2 -- node --test dashboard/test/instruction-queue-worker.test.mjs`.

### Task 3: Route ProjectStore writes through the worker

**Files:**
- Modify: `dashboard/state.mjs`
- Modify: `dashboard/server.mjs`
- Modify: `dashboard/test/answer-applications.test.mjs`

- [ ] Let `ProjectStore.open(project, { instructionQueueWorker })` retain an optional worker. In `mutateReply`, map `instruction_submit|instruction_resolve|control` to `submit|resolve|control`, send the cloned state and context, validate the returned state, and commit only after a successful native response.
- [ ] Preserve the `history_backups` reference in the cloned state because instruction mutations cannot change it and `commit()` uses reference identity to detect restored-history changes.
- [ ] Construct one worker for the live project Dashboard when an installed `rdsh` is available, pass it to `ProjectStore`, and close it after the update queue drains during normal shutdown.
- [ ] Keep direct `ProjectStore` tests injectable so existing tests without a compiled binary continue to use the existing JavaScript handler.
- [ ] Add a store test proving native returned state/result are committed and native errors leave the stored state untouched; run `mise exec node@22.23.2 -- node --test --test-concurrency=1 dashboard/test/answer-applications.test.mjs dashboard/test/instruction-queue-worker.test.mjs`.

### Task 4: Verify the live boundary and performance

**Files:**
- Modify: `docs/` only if observed behavior changes the migration record.

- [ ] Build the release binary and run Dashboard store mutation tests with `RDSH_BIN` pointing at it.
- [ ] Compare JavaScript and Rust outputs for submit, retry, stale review, append, interrupt approval, cancel claim, and proof reconciliation.
- [ ] Measure the live ProjectStore mutation end-to-end before and after worker routing using the same state fixture; record median and p95, and retain the JavaScript fallback if the worker regresses the measured end-to-end path.
- [ ] Run `cargo test --locked --release`, `cargo clippy --locked --all-targets --release -- -D warnings`, `cargo +1.85.0 check --locked --all-targets`, `cargo fmt --all -- --check`, and the focused Node tests.
- [ ] Do not mark the full Dashboard runtime migrated; this worker only closes the instruction mutation path.
