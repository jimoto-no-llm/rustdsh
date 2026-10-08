import test from "node:test";
import assert from "node:assert/strict";
import { overviewModel } from "../project-overview.mjs";

const state = () => ({
  project: { name: "Project A" },
  updated_at: null,
  tasks: [
    { id: "T1", title: "Fix", status: "done" },
    { id: "T2", title: "Review", status: "doing" },
  ],
  questions: [],
  events: [],
});
test("follow-up review counts and a newer unknown instruction remain visible in the task overview", () => {
  const s = state();
  s.answer_applications = {
    consumers: { C1: { task_id: "T1" }, C2: { task_id: "T2" } },
    commands: {
      R1: {
        consumer_id: "C1",
        display_phase: "succeeded",
        question_id: "Q1",
        run_id: "run1",
        saved_at: "2026-10-06T00:00:00Z",
        completed_at: "2026-10-06T00:01:00Z",
        target_observation: { status: "available" },
      },
    },
  };
  s.instructions = {
    requests: {
      I1: { consumer_id: "C1", status: "review_required" },
      I2: { consumer_id: "C2", status: "review_required" },
    },
    commands: {
      I3: {
        source_kind: "instruction",
        command_id: "I3",
        consumer_id: "C1",
        display_phase: "unknown",
        run_id: "run1",
        saved_at: "2026-10-06T00:03:00Z",
        target_observation: { status: "unknown" },
      },
    },
  };
  const view = overviewModel(s, "T1");
  assert.equal(view.reviews.length, 1);
  assert.match(view.decision, /追指示の確認待ち 1/);
  assert.match(view.lastResult.title, /追指示入力の結果は不明/);
  assert.match(view.execution, /入力対象.*不明 1/);
  assert.equal(overviewModel(s).reviews.length, 2);
});
test("task completion reports and saved/delivered answers never become native success or live state", () => {
  const s = state();
  s.answer_applications = {
    consumers: { C1: { task_id: "T1" } },
    commands: {
      R1: {
        consumer_id: "C1",
        display_phase: "saved",
        saved_at: "2026-10-06T00:00:00Z",
        delivery: [{ status: "delivered" }],
      },
    },
  };
  const overview = overviewModel(s, "T1");
  assert.equal(overview.execution, "実行状態は未取得");
  assert.equal(overview.lastResult, null);
  assert.match(overview.taskReport, /完了の申告/);
  assert.match(overview.stop, /停止は非対応/);
});
test("task context excludes other tasks and retains unbound and expired decision truth", () => {
  const s = state();
  s.questions = ["Q1", "Q2", "Q3", "Q4", "Q5"].map((id) => ({
    id,
    question: id,
    answer: null,
  }));
  s.question_contracts = { cards: {} };
  for (const [id, task, status, expires] of [
    ["Q1", "T1", "open", null],
    ["Q2", "T2", "open", null],
    ["Q3", "T1", "cancelled", null],
    ["Q4", "T1", "open", "2026-10-01T00:00:00Z"],
  ])
    s.question_contracts.cards[id] = {
      status,
      snapshot: {
        decision: { target: { task_id: task }, expires_at: expires },
      },
    };
  assert.deepEqual(
    overviewModel(s, "T1", Date.parse("2026-10-06")).pending.map((q) => q.id),
    ["Q1"],
  );
  assert.equal(overviewModel(s, "T1").unassigned, 1);
  const missing = overviewModel(s, "Tmissing");
  assert.match(missing.context, /Tmissing/);
  assert.match(missing.taskReport, /一覧にありません/);
  assert.equal(missing.pending.length, 0);
});
test("the latest unknown or invalidated input result does not inherit an earlier success or another task", () => {
  const s = state();
  s.events = [
    { title: "Entire project report", created_at: "2026-10-06T00:05:00Z" },
  ];
  s.answer_applications = {
    consumers: { C1: { task_id: "T1" }, C2: { task_id: "T2" } },
    commands: {
      R1: {
        consumer_id: "C1",
        question_id: "Q1",
        run_id: "run1",
        display_phase: "succeeded",
        saved_at: "2026-10-06T00:00:00Z",
        completed_at: "2026-10-06T00:01:00Z",
        target_observation: {
          status: "available",
          observed_at: "2026-10-06T00:01:00Z",
        },
      },
      R2: {
        consumer_id: "C1",
        question_id: "Q1",
        run_id: "run1",
        display_phase: "unknown",
        saved_at: "2026-10-06T00:02:00Z",
        started_at: "2026-10-06T00:03:00Z",
        target_observation: {
          status: "unknown",
          observed_at: "2026-10-06T00:04:00Z",
        },
      },
      R3: {
        consumer_id: "C2",
        question_id: "Q2",
        run_id: "run2",
        display_phase: "succeeded",
        saved_at: "2026-10-06T00:04:00Z",
        completed_at: "2026-10-06T00:05:00Z",
        target_observation: {
          status: "available",
          observed_at: "2026-10-06T00:05:00Z",
        },
      },
    },
  };
  const before = structuredClone(s);
  const overview = overviewModel(s, "T1");
  assert.match(overview.lastResult.title, /結果は不明/);
  assert.match(overview.execution, /接続確認 0/);
  assert.match(overview.execution, /不明 1/);
  assert.deepEqual(s, before);
  s.answer_applications.commands.R2.display_phase = "invalidated";
  assert.match(overviewModel(s, "T1").lastResult.title, /旧版/);
  assert.equal(overviewModel(s, "Tmissing").lastResult, null);
});
