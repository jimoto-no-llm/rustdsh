import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ProjectStore, publicChangeRecords } from "../state.mjs";
import { updateSummary } from "../update-summary.mjs";

const baseline = {
  schema: 1,
  revision: 4,
  timestamp: "2026-10-10T10:00:00.000Z",
  eventSequence: 12,
  taskStates: {
    T1: { status: "doing", hasBlocker: false, updatedAt: "2026-10-09T10:00:00.000Z" },
    T2: { status: "blocked", hasBlocker: true, updatedAt: "2026-10-09T10:00:00.000Z" },
  },
};

test("first view and unchanged revisions do not invent a change", () => {
  const state = { revision: 4, tasks: [], questions: [], events: [] };
  assert.equal(updateSummary(state, null).mode, "initial");
  assert.equal(updateSummary(state, baseline).mode, "unchanged");
  assert.deepEqual(updateSummary(state, baseline).items, []);
});

test("changed tasks, decisions, answers, reports and metrics keep current evidence distinctions", () => {
  const state = {
    revision: 10,
    updated_at: "2026-10-10T10:05:00.000Z",
    tasks: [
      {
        id: "T1",
        title: "Release candidate",
        status: "done",
        blocker: "",
        updated_at: "2026-10-10T10:01:00.000Z",
        observation: { kind: "agent_reported" },
      },
      {
        id: "T2",
        title: "Waiting on review",
        status: "doing",
        blocker: "",
        updated_at: "2026-10-10T10:02:00.000Z",
        observation: { kind: "measured" },
      },
    ],
    questions: [
      {
        id: "Q1",
        question: "May we continue?",
        answer: null,
        created_at: "2026-10-10T10:03:00.000Z",
      },
      {
        id: "Q2",
        question: "Which target?",
        answer: "Production",
        created_at: "2026-10-09T09:00:00.000Z",
        answered_at: "2026-10-10T10:03:30.000Z",
      },
    ],
    question_contracts: {
      cards: {
        Q1: { status: "open", revision: 1, updated_at: "2026-10-10T10:03:00.000Z" },
      },
    },
    events: [
      {
        sequence: 13,
        type: "artifact",
        title: "QA report attached",
        detail: "Browser suite passed",
        created_at: "2026-10-10T10:04:00.000Z",
        observation: { kind: "agent_reported" },
      },
    ],
    metric_observations: {
      tool_calls: { recorded_at: "2026-10-10T10:04:30.000Z" },
    },
    change_records: [
      { event_id: "evt_project_5", name: "dashboard.task.updated", revision: 5, entity_id: "T1" },
      { event_id: "evt_project_6", name: "dashboard.task.updated", revision: 6, entity_id: "T2" },
      { event_id: "evt_project_7", name: "dashboard.question.created", revision: 7, entity_id: "Q1" },
      { event_id: "evt_project_8", name: "dashboard.answer.created", revision: 8, entity_id: "Q2" },
      { event_id: "evt_project_9", name: "dashboard.metrics.updated", revision: 9, entity_id: "" },
    ],
  };
  const result = updateSummary(state, baseline);
  assert.equal(result.mode, "changed");
  const completedReport = result.items.find((item) => item.id === "task-T1");
  assert.ok(completedReport.detail.includes("完了報告"));
  assert.ok(completedReport.detail.includes("agent報告"));
  const resolvedBlocker = result.items.find((item) => item.id === "task-T2");
  assert.ok(resolvedBlocker.detail.includes("状態: 保留 → 進行中"));
  assert.ok(resolvedBlocker.detail.includes("保留要因: あり → なし"));
  assert.ok(result.items.some((item) => item.title.includes("判断待ち")));
  assert.ok(result.items.some((item) => item.title.includes("回答が保存")));
  assert.ok(result.items.some((item) => item.title.includes("QA report attached")));
  assert.ok(result.items.some((item) => item.title.includes("数値レポート")));
  const taskSource = result.items.find((item) => item.id === "task-T1");
  assert.equal(taskSource.target, "change-evt_project_5");
  assert.ok(taskSource.detail.includes("evt_project_5"));
  assert.equal(
    result.items.find((item) => item.id === "question-Q2-answered").target,
    "change-evt_project_8",
  );
  assert.equal(result.items.find((item) => item.id === "metrics").target, "change-evt_project_9");
  assert.ok(result.items.every((item) => !item.title.includes("検証済み")));
});

test("an updated revision without a comparable record stays unknown", () => {
  const result = updateSummary(
    { revision: 5, updated_at: "2026-10-10T10:01:00.000Z", tasks: [], questions: [], events: [] },
    baseline,
  );
  assert.equal(result.mode, "untracked");
  assert.deepEqual(result.items, []);
});

test("unsupported checkpoints do not become a false first-view baseline", () => {
  const result = updateSummary(
    { revision: 5, tasks: [], questions: [], events: [] },
    { ...baseline, schema: 2 },
  );
  assert.equal(result.mode, "unavailable");
});

test("cursor change records are ordered and bounded without exposing free text", () => {
  const view = publicChangeRecords({
    revision: 2,
    changes: [{
      eventId: "evt_project_2",
      name: "dashboard.task.updated",
      timestamp: "t".repeat(100),
      data: { revision: 2, entity_id: "T2" },
    }, {
      eventId: "evt_project_1",
      name: "dashboard.task.updated",
      timestamp: "2026-10-10T10:01:00.000Z",
      data: {
        project_id: "project",
        revision: 1,
        entity_id: "T1",
        summary: "private free-text summary",
      },
    }],
  }, 0);
  assert.deepEqual(view.records.map((record) => record.event_id), [
    "evt_project_1",
    "evt_project_2",
  ]);
  assert.equal(view.records[1].timestamp.length, 64);
  assert.equal(JSON.stringify(view).includes("private free-text summary"), false);
});

test("state marks when the 10000-event change cursor has discarded older entries", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "rdsh-summary-change-cap-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const project = {
    id: "summary-cap-project",
    name: "summary-cap-project",
    root: directory,
    directory: path.join(directory, "state"),
  };
  await fs.mkdir(project.directory, { recursive: true });
  const store = new ProjectStore(project, {
    schema: 1,
    project,
    revision: 10000,
    updated_at: "2026-10-10T10:00:00.000Z",
    metrics: {},
    tasks: [],
    questions: [],
    events: [],
    feedback: [],
    changes: Array.from({ length: 10000 }, (_, index) => ({
      eventId: `evt_test_${index + 1}`,
      name: "dashboard.task.updated",
      timestamp: "2026-10-10T10:00:00.000Z",
      data: { revision: index + 1, entity_id: `T${index + 1}` },
      cursor: null,
    })),
  });
  await store.mutate("event", { id: "E1", type: "note", title: "latest record" });
  assert.equal(store.value.changes.length, 10000);
  assert.equal(store.value.change_history_truncated, true);
  assert.equal(store.value.changes.at(-1).data.revision, 10001);
  const delta = publicChangeRecords(store.value, 1);
  assert.equal(delta.history_gap, true);
  assert.equal(delta.records.length, 10000);
  assert.equal(delta.records[0].revision, 2);
});

test("event retention gaps are explicit and restored older revisions require a new baseline", () => {
  const events = Array.from({ length: 1000 }, (_, index) => ({
    sequence: index + 501,
    type: "note",
    title: `note ${index + 501}`,
    created_at: "2026-10-10T10:01:00.000Z",
  }));
  const gap = updateSummary(
    { revision: 2000, events, tasks: [], questions: [] },
    { ...baseline, eventSequence: 100 },
  );
  assert.equal(gap.historyGap, true);
  assert.equal(gap.mode, "changed");

  const changeRecords = Array.from({ length: 10000 }, (_, index) => ({
    event_id: `evt_${index + 501}`,
    name: "dashboard.task.updated",
    revision: index + 501,
    entity_id: `T${index}`,
  }));
  const changeGap = updateSummary(
    {
      revision: 11000,
      change_records: changeRecords,
      change_history_gap: true,
      tasks: [],
      questions: [],
      events: [],
    },
    { ...baseline, revision: 100 },
  );
  assert.equal(changeGap.historyGap, true);
  const fullyRetained = updateSummary(
    {
      revision: 11000,
      change_records: changeRecords,
      change_history_gap: false,
      tasks: [],
      questions: [],
      events: [],
    },
    { ...baseline, revision: 100 },
  );
  assert.equal(fullyRetained.historyGap, false);

  const reset = updateSummary({ revision: 3, events: [], tasks: [], questions: [] }, baseline);
  assert.equal(reset.mode, "reset");
});
