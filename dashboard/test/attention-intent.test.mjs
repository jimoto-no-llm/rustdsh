import test from "node:test";
import assert from "node:assert/strict";
import { buildInbox, validateAttentionState } from "../attention.mjs";
import { applyOperation } from "../state.mjs";

const initial = () => ({ project: { id: "intent" }, tasks: [], questions: [], events: [], metrics: {}, feedback: [] });
const task = (status, extra = {}) => ({ id: "T1", title: "依存の確認", status, ...extra });

test("existing question urgency drives default priority without inventing impact", () => {
  const state = initial();
  applyOperation(state, "question", { id: "A1", question: "通常の相談" });
  applyOperation(state, "question", { id: "Z1", question: "緊急の判断", urgency: "critical", default_action: "回答まで待機" });
  const inbox = buildInbox(state);
  assert.equal(inbox.groups[0].items[0].id, "Z1");
  assert.equal(inbox.groups[0].impact, null);
  assert.equal(inbox.groups[0].items[0].next_action, "質問に回答");
  assert.equal(buildInbox(state, "deadline").groups[0].items[0].id, "Z1");
});

test("legacy blocked reports are visible without guessing failure or a shared cause, and retain resolution history", () => {
  const state = initial();
  state.tasks.push({ ...task("blocked", { blocker: "上流の作業結果を確認中" }), updated_at: "2026-10-08T00:00:00Z" });
  let item = buildInbox(state).groups[0]?.items[0];
  assert.equal(item?.kind, "blocked");
  assert.equal(item.blocker, "上流の作業結果を確認中");
  assert.equal(item.next_action, "停止理由を確認");
  applyOperation(state, "task", task("doing"));
  assert.equal(buildInbox(state).itemCount, 0);
  assert.equal(state.tasks[0].attention_history.at(-1).action, "resolved");
  assert.equal(state.tasks[0].attention_history.at(-1).attention.blocker, "上流の作業結果を確認中");
  validateAttentionState(state);
  applyOperation(state, "task", task("blocked", { blocker: "別の前提を確認中" }));
  applyOperation(state, "task", task("blocked", { attention: null }));
  assert.equal(buildInbox(state).itemCount, 0);
  validateAttentionState(state);
});

test("reported failures without known causes stay separate and completing a task clears its report", () => {
  const state = initial();
  applyOperation(state, "task", task("doing", { attention: { kind: "failure", next_action: "ログを確認" } }));
  applyOperation(state, "task", { id: "T2", title: "別の失敗", status: "doing", attention: { kind: "failure" } });
  assert.equal(buildInbox(state).groups.length, 2);
  applyOperation(state, "task", task("done"));
  assert.equal(buildInbox(state).itemCount, 1);
  assert.equal(state.tasks[0].attention_history.at(-1).action, "resolved");
  assert.equal(state.tasks[0].attention_history.at(-1).attention.next_action, "ログを確認");
  validateAttentionState(state);
  assert.throws(() => applyOperation(state, "task", task("done", { attention: { kind: "failure" } })), /done/);
});

test("next action sorts by available operation instead of arbitrary action wording", () => {
  const state = initial();
  applyOperation(state, "task", task("doing", { attention: { cause_id: "failure", kind: "failure", next_action: "AAAログを確認" } }));
  applyOperation(state, "question", { id: "Q", question: "どうしますか？", attention: { next_action: "ZZZ回答を選ぶ" } });
  const inbox = buildInbox(state, "next_action");
  assert.equal(inbox.groups[0].items[0].id, "Q");
  applyOperation(state, "answer", { id: "Q", answer: "再確認" });
  assert.equal(buildInbox(state).itemCount, 1);
  assert.equal(state.feedback[0].answer, "再確認");
});

test("both resolution paths preserve the original blocker for classified failures", () => {
  for (const resolution of [task("done"), task("doing", { attention: null })]) {
    const state = initial();
    applyOperation(state, "task", task("blocked", { blocker: "dependency fetch returned 503", attention: { kind: "failure" } }));
    applyOperation(state, "task", resolution);
    assert.equal(buildInbox(state).itemCount, 0);
    assert.equal(state.tasks[0].attention_history.at(-1).blocker, "dependency fetch returned 503");
    validateAttentionState(state);
  }
});

test("a new legacy blocked episode reopens after a classified failure was completed", () => {
  const state = initial();
  applyOperation(state, "task", task("blocked", { attention: { kind: "failure" } }));
  applyOperation(state, "task", task("done"));
  applyOperation(state, "task", task("blocked", { blocker: "新しい停止理由" }));
  assert.equal(buildInbox(state).itemCount, 1);
  assert.equal(state.tasks[0].attention_history.at(-1).action, "reopened");
  assert.equal(buildInbox(state).groups[0].items[0].blocker, "新しい停止理由");
  validateAttentionState(state);
});
