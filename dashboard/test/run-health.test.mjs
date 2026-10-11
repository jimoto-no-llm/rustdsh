import test from "node:test";
import assert from "node:assert/strict";
import { diagnoseManagedRun } from "../run-health.mjs";

const now = "2026-10-11T03:00:00.000Z";
const find = (report, key) => report.observations.find((item) => item.key === key);

test("long silence remains a quiet running process, not a failed or killed task", () => {
  const report = diagnoseManagedRun({
    run_id: "run_123",
    scope: { status: "running" },
    last_output_at: "2026-10-11T02:50:00.000Z",
    observed_at: now,
  });

  assert.equal(report.state, "quiet_process");
  assert.equal(report.outcome, "not_assessed");
  assert.equal(report.stop_action, "manual_only");
  assert.match(report.summary, /停止とは判定しません/);
  assert.match(report.guidance.join(" "), /Harness画面/);
});

test("process exit stays distinct from verified task completion and surviving children", () => {
  const report = diagnoseManagedRun({
    run_id: "run_456",
    scope: { status: "running" },
    process_exit: {
      code: 2,
      signal: null,
      observed_at: "2026-10-11T02:59:55.000Z",
    },
    observed_at: now,
  });

  assert.equal(report.state, "root_exited_descendants_running");
  assert.equal(find(report, "managed_root_exit").status, "observed");
  assert.equal(find(report, "managed_process_scope").status, "running");
  assert.equal(report.outcome, "not_assessed");
});

test("an empty owned process scope does not claim the work succeeded", () => {
  const report = diagnoseManagedRun({
    run_id: "run_789",
    scope: { status: "exit_confirmed" },
    observed_at: now,
  });

  assert.equal(report.state, "process_scope_exited");
  assert.equal(report.outcome, "not_assessed");
  assert.match(report.summary, /作業結果は未確認/);
});

test("a dashboard reconnect gap is separate from process health", () => {
  const report = diagnoseManagedRun({
    run_id: "run_gap",
    scope: { status: "running" },
    browser_poll_gap_ms: 12_000,
    last_output_at: "2026-10-11T02:59:59.000Z",
    observed_at: now,
  });

  assert.equal(report.state, "process_running");
  assert.equal(find(report, "dashboard_browser_poll").status, "reconnected_after_gap");
  assert.match(report.guidance.join(" "), /実行状態を示すものではありません/);
  assert.equal(find(report, "managed_process_scope").status, "running");
});

test("missing heartbeat, API wait and CPU/GPU activity are unavailable, never zero", () => {
  const report = diagnoseManagedRun({
    run_id: "run_missing",
    scope: { status: "running" },
    observed_at: now,
  });

  for (const key of [
    "task_heartbeat",
    "api_wait",
    "cpu_activity",
    "gpu_activity",
  ]) {
    const signal = find(report, key);
    assert.equal(signal.status, "unavailable");
    assert.equal(signal.value, null);
    assert.equal(signal.observed_at, now);
  }
});
