import test from "node:test";
import assert from "node:assert/strict";
import { createFaultTrace } from "../fault-simulator-trace.mjs";

test("cleanup timing and repeated ENOSPC writes do not shift the seeded replay, and every failed write remains observable", () => {
  for (const [seed, boundary] of [[0, "write"], [1, "sync"]]) {
    const run = (retries, interval) => {
      let elapsed = 100;
      const trace = createFaultTrace(seed, () => elapsed);
      trace.observe("native_session_attached");
      elapsed += interval;
      trace.journalFailure(boundary);
      trace.observe("control_result_observed", { native_effects: 0, ack: false });
      for (let i = 0; i < retries; i += 1) {
        elapsed += interval;
        trace.journalFailure(boundary);
      }
      trace.observe("owned_stop_observed", { confirmed: true,
        history_error: "history_unconfirmed_after_owned_stop" });
      return trace;
    };
    const fast = run(1, 2), slow = run(17, 500);
    assert.deepEqual(fast.events, slow.events);
    assert.deepEqual(slow.events.map((event) => event.event), [
      "native_session_attached", "injected_ENOSPC", "control_result_observed", "owned_stop_observed",
    ]);
    assert.deepEqual(slow.events.map((event) => event.logical_time_ms),
      [1, 2, 3, 4].map((tick) => tick * (1 + seed % 7)));
    const attempts = slow.runtime_observations.journal_failures;
    assert.equal(fast.runtime_observations.journal_failures.length, 2);
    assert.equal(attempts.length, 18);
    assert(attempts.every((attempt, i) => attempt.attempt === i + 1 &&
      attempt.boundary === boundary && attempt.elapsed_ms === 500 * (i + 1)));
    assert.equal(attempts[0].after_event, "native_session_attached");
    assert(attempts.slice(1).every((attempt) => attempt.after_event === "control_result_observed"));
  }
});

test("network retry deadlines and backoff advance the same seeded clock as fault events", async () => {
  const trace = createFaultTrace(1, () => 0);
  assert.equal(trace.clock.now(), 0);
  trace.observe("mock_send_dispatched");
  assert.equal(trace.clock.now(), 2);
  await trace.clock.wait(100);
  assert.equal(trace.clock.now(), 102);
  trace.observe("tcp_response_lost");
  assert.equal(trace.clock.now(), 104);
  assert.equal(trace.events[1].logical_time_ms, 104);
  assert.deepEqual(trace.runtime_observations.journal_failures, []);
});
