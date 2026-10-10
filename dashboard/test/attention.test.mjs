import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildInbox, buildAttentionHistory, normalizeAttention, validateAttentionState } from "../attention.mjs";
import { applyOperation, ProjectStore } from "../state.mjs";

function initial() {
  return { schema: 1, project: { id: "project-one", name: "Fixture", root: "/fixture" },
    revision: 0, updated_at: null, metrics: {}, tasks: [], questions: [], events: [], feedback: [] };
}
const issue = { cause_id: "build", kind: "failure", deadline: "2026-10-09T09:00:00+09:00", impact: "high", next_action: "Review build failure" };
const task = (id, extra = {}) => ({ id, title: `Task ${id}`, status: "doing", ...extra });

test("typed cancellation and expiry leave the inbox and retain the original report in history", () => {
  const state = initial();
  applyOperation(state, "question", { id: "cancelled", question: "Review the original target",
    decision: { kind: "consultation" }, attention: { next_action: "Review original conditions", impact: "high" } });
  applyOperation(state, "question", { id: "expired", question: "Time-limited consultation",
    decision: { kind: "consultation", expires_at: "2030-01-01T00:00:00Z" }, attention: { impact: "critical" } });
  applyOperation(state, "question", { id: "legacy", question: "Legacy remains available" });
  assert.equal(buildInbox(state, "priority", Date.UTC(2029, 0, 1)).itemCount, 3);
  applyOperation(state, "question", { id: "cancelled", action: "cancel", expected_revision: 1, cancel_reason: "Target retired" });
  const now = Date.UTC(2031, 0, 1);
  assert.deepEqual(buildInbox(state, "priority", now).groups.map((group) => group.items[0].id), ["legacy"]);
  const history = buildAttentionHistory(state, now);
  assert.equal(history.find((entry) => entry.id === "cancelled").action, "cancelled");
  assert.equal(history.find((entry) => entry.id === "cancelled").attention.next_action, "Review original conditions");
  assert.equal(history.find((entry) => entry.id === "expired").action, "expired");
  assert.equal(history.find((entry) => entry.id === "expired").recorded_at, "2030-01-01T00:00:00.000Z");
  assert.equal(state.feedback.length, 0);
  validateAttentionState(state);
});

test("typed revisions preserve omitted metadata and keep answered report history after a new question revision", () => {
  const state = initial();
  const first = { id: "typed", question: "Original consultation", decision: { kind: "consultation" },
    attention: { next_action: "Review original text", cause_id: "cause-v1" } };
  applyOperation(state, "question", first);
  applyOperation(state, "question", { id: "typed", action: "revise", expected_revision: 1,
    question: "Revised consultation", decision: { kind: "consultation" } });
  assert.deepEqual(state.questions[0].attention, first.attention);
  const card = state.question_contracts.cards.typed;
  applyOperation(state, "answer", { id: "typed", answer: "Original response", expected_revision: card.revision,
    contract_fingerprint: card.fingerprint });
  applyOperation(state, "question", { id: "typed", action: "revise", expected_revision: 2,
    question: "A new decision", decision: { kind: "consultation" }, attention: { next_action: "Review new target" } });
  assert.equal(buildInbox(state).itemCount, 1);
  const history = buildAttentionHistory(state);
  assert.equal(history.length, 1);
  assert.equal(history[0].title, "Revised consultation");
  assert.equal(history[0].attention.next_action, "Review original text");
  assert.equal(state.feedback[0].answer, "Original response");
  assert.equal(state.feedback[0].execution_authorized, false);
  assert.equal(state.questions[0].attention.next_action, "Review new target");
  assert.throws(() => applyOperation(state, "question", { ...first, id: "invalid", attention: { unexpected: "field" } }), /attention/);
  assert.ok(!state.questions.some((question) => question.id === "invalid"));
});

test("reported attention preserves omission and records explicit resolution and recurrence", () => {
  const state = initial();
  applyOperation(state, "task", task("T1", { attention: issue }));
  const first = structuredClone(state.tasks[0].attention_history[0]);
  applyOperation(state, "task", task("T1", { status: "blocked" }));
  assert.deepEqual(state.tasks[0].attention, issue);
  assert.equal(buildInbox(state).itemCount, 1);
  applyOperation(state, "task", task("T1", { attention: { ...issue } }));
  assert.equal(state.tasks[0].attention_history.length, 1);
  const changed = { ...issue, next_action: "Retry after reviewing logs" };
  applyOperation(state, "task", task("T1", { attention: changed }));
  const replaced = { cause_id: "upstream", kind: "dependency", impact: "critical" };
  applyOperation(state, "task", task("T1", { attention: replaced }));
  applyOperation(state, "task", task("T1", { attention: null }));
  assert.equal(state.tasks[0].attention, null);
  assert.equal(buildInbox(state).itemCount, 0);
  applyOperation(state, "task", task("T1", { attention: null }));
  applyOperation(state, "task", task("T1", { attention: issue }));
  const history = state.tasks[0].attention_history;
  assert.deepEqual(history.map((entry) => entry.action), ["reported", "updated", "replaced", "resolved", "reopened"]);
  assert.deepEqual(history.map((entry) => entry.sequence), [1, 2, 3, 4, 5]);
  assert.deepEqual(history[0], first);
  assert.deepEqual(history[2].previous_attention, changed);
  assert.deepEqual(history[3].attention, replaced);
  assert.equal(history[3].title, "Task T1");
  assert.ok(history.every((entry) => Number.isFinite(Date.parse(entry.recorded_at))));
  validateAttentionState(state);
});

test("inbox groups explicit shared causes and retains unresolved members and original answered questions", () => {
  const state = initial();
  applyOperation(state, "task", task("T1", { attention: issue }));
  applyOperation(state, "task", task("T2", { attention: { ...issue, kind: "dependency", impact: "critical", deadline: "2026-10-08T01:00:00Z", next_action: "Check upstream" } }));
  applyOperation(state, "question", { id: "Q1", question: "Retry this build?", attention: { cause_id: "build", next_action: "Answer this question" } });
  applyOperation(state, "question", { id: "Q2", question: "Independent question" });
  applyOperation(state, "question", { id: "Q3", question: "Independent question", attention: { impact: "low" } });
  let inbox = buildInbox(state);
  assert.equal(inbox.itemCount, 5);
  assert.equal(inbox.groups.length, 3);
  const grouped = inbox.groups.find((group) => group.cause_id === "build");
  assert.equal(grouped.items.length, 3);
  assert.equal(grouped.deadline, "2026-10-08T01:00:00Z");
  assert.equal(grouped.impact, "critical");
  assert.equal(grouped.next_action, "Answer this question");
  assert.deepEqual(grouped.items.map((item) => item.kind).sort(), ["dependency", "failure", "question"]);
  assert.equal(grouped.items.find((item) => item.id === "T1").next_action, issue.next_action);
  assert.ok(inbox.groups.filter((group) => group.cause_id === null).every((group) => group.items.length === 1));
  applyOperation(state, "task", task("T1", { attention: null }));
  applyOperation(state, "answer", { id: "Q1", answer: "Wait for the upstream task" });
  inbox = buildInbox(state);
  assert.equal(inbox.groups.find((group) => group.cause_id === "build").items.length, 1);
  assert.equal(state.questions.find((item) => item.id === "Q1").question, "Retry this build?");
  assert.equal(state.feedback[0].answer, "Wait for the upstream task");
  assert.equal(state.tasks[0].attention_history.at(-1).action, "resolved");
  const other = structuredClone(state);
  other.project.id = "project-two";
  assert.notEqual(buildInbox(other).groups[0].id, inbox.groups[0].id);
});

test("all three inbox sorts are deterministic, missing-last and pure", () => {
  const state = initial();
  for (const [id, attention] of [
    ["missing", { cause_id: "missing", kind: "dependency" }],
    ["late", { cause_id: "late", kind: "failure", deadline: "2026-11-01T01:00:00Z", impact: "low", next_action: "A action" }],
    ["early", { cause_id: "early", kind: "failure", deadline: "2026-10-01T01:00:00Z", impact: "critical", next_action: "Z action" }],
  ]) applyOperation(state, "task", task(id, { attention }));
  const before = structuredClone(state);
  const order = (sort) => buildInbox(state, sort).groups.map((group) => group.cause_id);
  assert.deepEqual(order("deadline"), ["early", "late", "missing"]);
  assert.deepEqual(order("impact"), ["early", "late", "missing"]);
  assert.deepEqual(order("next_action"), ["early", "late", "missing"]);
  assert.deepEqual(state, before);
  state.tasks.reverse();
  assert.deepEqual(order("next_action"), ["early", "late", "missing"]);
  assert.throws(() => buildInbox(state, "created"), /Invalid inbox sort/);
  const tied = initial();
  applyOperation(tied, "question", { id: "z", question: "Same" });
  applyOperation(tied, "question", { id: "a", question: "Same" });
  const expected = buildInbox(tied).groups.map((group) => group.id);
  tied.questions.reverse();
  assert.deepEqual(buildInbox(tied).groups.map((group) => group.id), expected);
  applyOperation(tied, "question", { id: "\ud800", question: "Legacy ID" });
  applyOperation(tied, "task", task("surrogate", { attention: { cause_id: "\ud800", kind: "failure" } }));
  assert.equal(buildInbox(tied).groups.length, 4);
  const sameInstant = initial();
  applyOperation(sameInstant, "task", task("a", { attention: issue }));
  applyOperation(sameInstant, "task", task("b", { attention: { ...issue, deadline: "2026-10-09T00:00:00Z" } }));
  const firstDeadline = buildInbox(sameInstant).groups[0].deadline;
  sameInstant.tasks.reverse();
  assert.equal(buildInbox(sameInstant).groups[0].deadline, firstDeadline);
});

test("ordinary logs and metrics cannot add attention or evict its original history", () => {
  const state = initial();
  applyOperation(state, "task", task("T1", { attention: issue }));
  applyOperation(state, "task", task("T1", { attention: null }));
  const history = structuredClone(state.tasks[0].attention_history);
  for (let i = 0; i < 1005; i++) applyOperation(state, "event", { title: "build failed (ordinary log)", detail: String(i) });
  applyOperation(state, "metrics", { tool_calls: 2, tool_errors: 2 });
  assert.equal(state.events.length, 1000);
  assert.equal(buildInbox(state).itemCount, 0);
  assert.deepEqual(state.tasks[0].attention_history, history);
});

test("state rejects invalid attention before changing a task or creating a question", () => {
  const state = initial();
  applyOperation(state, "task", task("T1", { attention: issue }));
  const before = structuredClone(state);
  const invalid = [false, [], "bad", {}, { ...issue, cause_id: " " }, { ...issue, cause_id: "x".repeat(161) },
    { ...issue, kind: "question" }, { ...issue, deadline: "2026-02-30T12:00:00Z" },
    { ...issue, deadline: "2026-10-08" }, { ...issue, deadline: "2026-10-08T24:00:00Z" },
    { ...issue, deadline: "2026-10-08T00:00:00+24:00" }, { ...issue, deadline: null },
    { ...issue, impact: "urgent" }, { ...issue, next_action: 1 }, { ...issue, next_action: "x".repeat(2001) },
    { ...issue, resolved_at: "2026-10-08T00:00:00Z" }];
  for (const attention of invalid) {
    assert.throws(() => applyOperation(state, "task", task("T1", { attention })), /Invalid attention/);
    assert.deepEqual(state, before);
  }
  assert.throws(() => applyOperation(state, "task", task("T1", { attention_history: [] })), /server-managed/);
  for (const attention of [null, { kind: "failure" }, { deadline: "2025-02-29T00:00:00Z" }, { unknown: true }])
    assert.throws(() => applyOperation(state, "question", { id: "Q", question: "Question", attention }), /Invalid attention/);
  assert.throws(() => applyOperation(state, "question", { id: "Q", question: "Question", attention_history: [] }), /server-managed/);
  assert.deepEqual(state, before);
  assert.deepEqual(normalizeAttention({ deadline: "2024-02-29T23:59:59.999Z" }, "question"), { deadline: "2024-02-29T23:59:59.999Z" });
});

test("attention and resolved history survive restart; a failed save leaves memory and disk unchanged", async (t) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "rdsh-attention-"));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const project = { id: "persist-attention", name: "Fixture", root: temporary, directory: path.join(temporary, "state") };
  const store = await ProjectStore.open(project);
  await store.mutate("task", task("T1", { attention: issue }));
  await store.mutate("question", { id: "Q1", question: "Confirm?", attention: { cause_id: "build" } });
  const saved = await fs.readFile(path.join(project.directory, "state.json"), "utf8");
  const before = structuredClone(store.value);
  const failure = t.mock.method(fs, "rename", async () => { throw new Error("fixture disk failure"); });
  await assert.rejects(store.mutate("task", task("T1", { attention: null })), /fixture disk failure/);
  assert.deepEqual(store.value, before);
  assert.equal(await fs.readFile(path.join(project.directory, "state.json"), "utf8"), saved);
  failure.mock.restore();
  const reopened = await ProjectStore.open(project);
  assert.deepEqual(reopened.value, before);
  await reopened.mutate("task", task("T1", { attention: null }));
  await reopened.mutate("answer", { id: "Q1", answer: "Confirmed" });
  const resolved = await ProjectStore.open(project);
  assert.equal(buildInbox(resolved.value).itemCount, 0);
  assert.deepEqual(resolved.value.tasks[0].attention_history.map((entry) => entry.action), ["reported", "resolved"]);
  assert.equal(resolved.value.questions[0].answer, "Confirmed");
  assert.deepEqual(resolved.value.questions[0].attention, { cause_id: "build" });
});

test("legacy states remain readable and corrupt new metadata is rejected without rewriting it", async (t) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "rdsh-attention-corrupt-"));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const project = { id: "legacy-attention", name: "Fixture", root: temporary, directory: temporary };
  const store = await ProjectStore.open(project);
  await store.mutate("task", task("T1"));
  await store.mutate("question", { id: "Q1", question: "Legacy?" });
  assert.equal(buildInbox((await ProjectStore.open(project)).value).itemCount, 1);
  await store.mutate("task", task("T1", { attention: issue }));
  for (const corrupt of [
    (value) => { value.tasks[0].attention.deadline = "yesterday"; },
    (value) => { value.tasks[0].attention_history[0].recorded_at = "2026-02-30T00:00:00Z"; },
    (value) => { value.tasks[0].attention_history[0].sequence = 9; },
    (value) => { value.tasks[0].attention_history[0].action = "unknown"; },
    (value) => { value.tasks[0].attention = null; },
    (value) => { value.questions[0].attention = { kind: "failure" }; },
  ]) {
    const broken = structuredClone(store.value);
    corrupt(broken);
    const serialized = JSON.stringify(broken);
    await fs.writeFile(path.join(temporary, "state.json"), serialized);
    await assert.rejects(ProjectStore.open(project), /[Aa]ttention/);
    assert.equal(await fs.readFile(path.join(temporary, "state.json"), "utf8"), serialized);
  }
});
