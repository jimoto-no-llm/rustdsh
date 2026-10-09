import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NotificationInbox } from "../notifications.mjs";
import { RunHistory } from "../run-history.mjs";

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "rdsh-notifications-"));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert(path.basename(directory).startsWith("rdsh-notifications-"));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const project = { id: "project-notification-fixture", directory };
  const changes = [];
  for (let index = 1; index <= 40; index++) {
    const name = index % 2 ? "dashboard.progress.updated" : "dashboard.metrics.updated";
    changes.push({
      eventId: `evt_noise_${index}`,
      name,
      timestamp: "2026-10-10T01:00:00.000Z",
      data: { entity_id: `noise-${index}`, summary: `Routine update ${index}` },
    });
  }
  changes.push(
    {
      eventId: "evt_question_1",
      name: "dashboard.question.created",
      timestamp: "2026-10-10T01:01:00.000Z",
      data: { entity_id: "q-critical", summary: "Need a decision" },
      notification: { kind: "question_waiting", urgency: "critical" },
    },
    {
      eventId: "evt_blocked_1",
      name: "dashboard.task.updated",
      timestamp: "2026-10-10T01:02:00.000Z",
      data: { entity_id: "task-blocked", summary: "Blocked task" },
      notification: { kind: "task_status", previous_status: "doing", status: "blocked" },
    },
    {
      eventId: "evt_blocked_repeat",
      name: "dashboard.task.updated",
      timestamp: "2026-10-10T01:03:00.000Z",
      data: { entity_id: "task-blocked", summary: "Blocked task updated" },
      notification: { kind: "task_status", previous_status: "blocked", status: "blocked" },
    },
    {
      eventId: "evt_done_1",
      name: "dashboard.task.updated",
      timestamp: "2026-10-10T01:04:00.000Z",
      data: { entity_id: "task-done", summary: "Finished" },
      notification: { kind: "task_status", previous_status: "doing", status: "done" },
    },
  );
  const state = {
    project: { id: project.id },
    revision: changes.length,
    changes,
    questions: [
      {
        id: "q-critical",
        urgency: "critical",
        question: "Need a decision",
        created_at: "2026-10-10T01:01:00.000Z",
        answer: null,
      },
    ],
    question_contracts: { cards: {} },
    tasks: [
      {
        id: "task-blocked",
        title: "Blocked task",
        status: "blocked",
        blocker: "Waiting for an input",
        updated_at: "2026-10-10T01:03:00.000Z",
      },
      {
        id: "task-done",
        title: "Finished",
        status: "done",
        blocker: "",
        updated_at: "2026-10-10T01:04:00.000Z",
      },
      {
        id: "task-doing",
        title: "Ordinary ongoing work",
        status: "doing",
        blocker: "",
        updated_at: "2026-10-10T01:05:00.000Z",
      },
    ],
  };
  return { project, state };
}

test("important questions lead; noisy progress and metrics are grouped and filtered by default", async (t) => {
  const { project, state } = await fixture(t);
  const inbox = await NotificationInbox.open(project);
  const view = inbox.snapshot(state, Date.parse("2026-10-10T01:10:00.000Z"));

  assert.equal(view.items[0].kind, "question");
  assert.equal(view.items[0].importance, "critical");
  assert.equal(view.items[0].unread, true);
  assert.equal(view.items.filter((item) => item.target.type === "task").length, 2);
  assert.equal(view.items.some((item) => item.target.id === "task-doing"), false);
  assert.equal(view.items.find((item) => item.target.id === "task-blocked").event_id, "evt_blocked_1");
  assert.equal(view.items.find((item) => item.target.id === "task-blocked").source_event_count, 2);
  assert.match(view.items.find((item) => item.target.id === "task-done").summary, /受入検証/);
  assert.equal(view.ready_unread_count, 3);
  assert.equal(view.filtered_count, 2);
  assert.equal(view.unread_count, 5);
  assert.equal(view.items.some((item) => item.kind === "progress" || item.kind === "metrics"), false);
});

test("quiet hours hold noncritical items, priority filters are explicit, and critical questions bypass quiet hours", async (t) => {
  const { project, state } = await fixture(t);
  const inbox = await NotificationInbox.open(project);
  await inbox.updatePreferences(
    {
      minimum_importance: "high",
      quiet_hours: { start: "22:00", end: "08:00", time_zone: "UTC" },
    },
    state,
  );
  const view = inbox.snapshot(state, Date.parse("2026-10-10T23:30:00.000Z"));
  const question = view.items.find((item) => item.kind === "question");
  const blocked = view.items.find((item) => item.target.id === "task-blocked");

  assert.equal(question.delivery_state, "ready");
  assert.equal(blocked.delivery_state, "held");
  assert.equal(view.held_unread_count, 1);
  assert.equal(view.ready_unread_count, 1);
  assert.equal(view.filtered_count, 3);
  assert.equal(view.filtered_unread_count, 3);
});

test("read state persists across inbox instances, same-cause reports stay aggregated, and newer transitions require a new read", async (t) => {
  const { project, state } = await fixture(t);
  let inbox = await NotificationInbox.open(project);
  const first = inbox.snapshot(state).items.find((item) => item.target.id === "task-blocked");
  await inbox.markRead({ id: first.id, event_id: first.event_id }, state);

  state.changes.push({
    eventId: "evt_blocked_repeat_2",
    name: "dashboard.task.updated",
    timestamp: "2026-10-10T01:06:00.000Z",
    data: { entity_id: "task-blocked", summary: "Same blocked cause" },
    notification: { kind: "task_status", previous_status: "blocked", status: "blocked" },
  });
  let view = inbox.snapshot(state);
  let blocked = view.items.find((item) => item.id === first.id);
  assert.equal(blocked.unread, false);
  assert.equal(blocked.event_id, first.event_id);
  assert.equal(blocked.source_event_count, 3);

  state.changes.push({
    eventId: "evt_blocked_new_cause",
    name: "dashboard.task.updated",
    timestamp: "2026-10-10T01:06:30.000Z",
    data: { entity_id: "task-blocked", summary: "Blocked task updated" },
    notification: {
      kind: "task_status",
      previous_status: "blocked",
      status: "blocked",
      previous_title: "Blocked task",
      title: "Blocked task",
      previous_blocker: "Waiting for an input",
      blocker: "Different missing dependency",
    },
  });
  blocked = inbox.snapshot(state).items.find((item) => item.id === first.id);
  assert.equal(blocked.unread, true);
  assert.notEqual(blocked.event_id, first.event_id);

  inbox = await NotificationInbox.open(project);
  view = inbox.snapshot(state);
  assert.equal(view.items.find((item) => item.id === first.id).unread, true);

  state.changes.push({
    eventId: "evt_blocked_new_episode",
    name: "dashboard.task.updated",
    timestamp: "2026-10-10T01:07:00.000Z",
    data: { entity_id: "task-blocked", summary: "Blocked again" },
    notification: { kind: "task_status", previous_status: "done", status: "blocked" },
  });
  await assert.rejects(
    inbox.markRead({ id: first.id, event_id: first.event_id }, state),
    (error) => error.code === "notification_changed",
  );
  blocked = inbox.snapshot(state).items.find((item) => item.id === first.id);
  assert.equal(blocked.unread, true);

  state.questions[0].answer = "Approved";
  assert.equal(inbox.snapshot(state).items.some((item) => item.kind === "question"), false);
});

test("only explicit terminal run results notify; process exits and unknown runs stay uncertain", async (t) => {
  const { project, state } = await fixture(t);
  const history = await RunHistory.open(project);
  const failedRun = "run_00000000-0000-0000-0000-000000000056";
  const completedRun = "run_00000000-0000-0000-0000-000000000057";
  const disconnectedRun = "run_00000000-0000-0000-0000-000000000058";
  await history.register(failedRun);
  await history.transition(failedRun, "failed", "failure_confirmed");
  await history.register(completedRun);
  await history.transition(completedRun, "starting", "request_recorded");
  await history.transition(completedRun, "running", "cli_session_attached");
  await history.transition(completedRun, "succeeded", "completion_verified");
  await history.register(disconnectedRun);
  await history.transition(disconnectedRun, "starting", "request_recorded");
  await history.transition(disconnectedRun, "disconnected", "owned_exit_confirmed");
  const events = (await history.read()).events;
  const inbox = await NotificationInbox.open(project);
  const view = inbox.snapshot(state, Date.parse("2026-10-10T01:10:00.000Z"), events);
  const runItems = view.items.filter((item) => item.kind === "run");
  const replay = inbox.snapshot(state, Date.parse("2026-10-10T01:10:00.000Z"), events);

  assert.equal(runItems.length, 2);
  assert.equal(replay.unread_count, view.unread_count);
  assert.equal(runItems.find((item) => item.target.id === failedRun).importance, "high");
  assert.equal(runItems.find((item) => item.target.id === completedRun).importance, "normal");
  assert.match(runItems.find((item) => item.target.id === completedRun).title, /完了/);
  assert.equal(runItems.some((item) => item.target.id === disconnectedRun), false);
  assert.equal(runItems.find((item) => item.target.id === failedRun).source_event_count, 2);
  const failedItem = runItems.find((item) => item.target.id === failedRun);
  assert.ok(failedItem.source_event_ids.includes(failedItem.event_id));
  await inbox.markRead(
    { id: failedItem.id, event_id: failedItem.event_id },
    state,
    events,
  );
  assert.equal(
    inbox.snapshot(state, Date.parse("2026-10-10T01:10:00.000Z"), events)
      .items.find((item) => item.id === failedItem.id).unread,
    false,
  );
  assert.equal(
    inbox.snapshot(state, Date.now(), events, "unavailable").source_status.run_history,
    "unavailable",
  );
});

test("failed persistence leaves read state and preferences unchanged", async (t) => {
  const { project, state } = await fixture(t);
  const inbox = await NotificationInbox.open(project);
  const blocked = inbox.snapshot(state).items.find((item) => item.kind === "task");
  inbox.persist = async () => {
    throw new Error("fixture_write_failed");
  };

  await assert.rejects(
    inbox.markRead({ id: blocked.id, event_id: blocked.event_id }, state),
    /fixture_write_failed/,
  );
  assert.equal(
    inbox.snapshot(state).items.find((item) => item.id === blocked.id).unread,
    true,
  );
  await assert.rejects(
    inbox.updatePreferences(
      { minimum_importance: "critical", quiet_hours: null },
      state,
    ),
    /fixture_write_failed/,
  );
  assert.equal(inbox.snapshot(state).preferences.minimum_importance, "normal");
});
