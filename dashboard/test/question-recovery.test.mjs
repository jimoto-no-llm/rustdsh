import test from "node:test";
import assert from "node:assert/strict";
import { renderQuestionCards } from "../question-cards-ui.mjs";
import { createQuestionRecovery, draftReviewState } from "../answer-recovery.mjs";
import { applyOperation } from "../state.mjs";

test("maximum escaped legacy question keys restore all saved drafts", () => {
  const value = { revision: 1, questions: [], feedback: [], events: [] };
  // Both inputs are accepted by the real state API. JSON escaping expands
  // the storage identity beyond the raw question/default-action lengths.
  applyOperation(value, "question", { id: "long", question: "\u0001".repeat(8000), default_action: "\u0002".repeat(2000) });
  applyOperation(value, "question", { id: "short", question: "短い質問" });
  const saved = storage();
  let warnings = 0;
  const options = { ...saved, onStorageError: () => warnings++ };
  const first = createQuestionRecovery("escaped-questions", options);
  for (const q of value.questions) first.change(first.draftFor(q), { text: "下書き:" + q.id });
  const reloaded = createQuestionRecovery("escaped-questions", options);
  assert.equal(warnings, 0);
  for (const q of value.questions) assert.equal(reloaded.draftFor(q).text, "下書き:" + q.id);
});

class Element {
  constructor(tag, document, text = "", className = "") {
    Object.assign(this, { tagName: tag.toUpperCase(), ownerDocument: document,
      children: [], dataset: {}, attributes: {}, listeners: {}, className,
      value: "", disabled: false, checked: false, _text: text ?? "" });
  }
  append(...children) { for (const child of children) child.parentElement = this; this.children.push(...children); }
  replaceChildren(...children) { this.children = []; this._text = ""; this.append(...children); }
  set textContent(value) { this.replaceChildren(); this._text = value; }
  get textContent() { return this._text + this.children.map((child) => child.textContent).join(""); }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(name, listener) { (this.listeners[name] ||= []).push(listener); }
  dispatch(name) { return Promise.all((this.listeners[name] || []).map((listener) => listener({ target: this, preventDefault() {} }))); }
  querySelectorAll(selector) {
    const matches = (element) => selector === "[data-question]" ? Boolean(element.dataset.question) :
      selector === '[role="alert"]' ? element.attributes.role === "alert" :
      selector === 'input[type="radio"]:checked' ? element.tagName === "INPUT" && element.type === "radio" && element.checked :
      selector.startsWith(".") ? element.className.split(" ").includes(selector.slice(1)) :
      element.tagName === selector.toUpperCase();
    return this.children.flatMap((child) => [...(matches(child) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  focus() { this.ownerDocument.activeElement = this; }
  setSelectionRange(start, end, direction = "none") { Object.assign(this, { selectionStart: start, selectionEnd: end, selectionDirection: direction }); }
  click() { return this.disabled ? Promise.resolve() : this.dispatch("click"); }
}
function dom() {
  const document = { activeElement: null, getElementById: () => null };
  globalThis.document = document;
  const node = (tag, text, className) => new Element(tag, document, text, className);
  return { document, node, container: node("div") };
}
function question() {
  return { id: "Q1", question: "確認する内容", urgency: "normal", default_action: "参考情報",
    created_at: "2026-10-08T00:00:00.000Z", answer: null };
}
function contract(revision = 1, fingerprint = "fingerprint-" + revision) {
  return { revision, fingerprint, status: "open", answer: null, history: [], changed_fields: [],
    snapshot: { decision: { kind: "consultation", target: null, choices: [
      { id: "proceed", label: "進める" }, { id: "hold", label: "保留する" },
    ], expires_at: null } } };
}
function state(card = contract(), revision = 1) {
  return { revision, questions: [question()], question_contracts: card ? { cards: { Q1: card } } : undefined };
}
function storage() {
  const values = new Map();
  return { values, read: (key) => values.get(key), write: (key, value) => values.set(key, value) };
}
function open(value = state(), saved = storage()) {
  const recovery = createQuestionRecovery("test-project", saved);
  recovery.reconcile(value, recovery.beginRead());
  return { recovery, saved, entry: recovery.draftFor(value.questions[0], value.question_contracts?.cards.Q1) };
}

test("a held answer stays locked across an SSE redraw", async () => {
  const ui = dom(), q = question();
  let requests = 0;
  const context = { node: ui.node, api: () => { requests++; return new Promise(() => {}); }, refreshState: async () => {} };
  renderQuestionCards(ui.container, [q], null, context);
  const area = ui.container.querySelector("textarea");
  area.value = "送信中の回答";
  await area.dispatch("input");
  void ui.container.querySelector("form").dispatch("submit");
  assert.equal(requests, 1);
  renderQuestionCards(ui.container, [q], null, context);
  assert.equal(ui.container.querySelector('button').disabled, true);
  void ui.container.querySelector("form").dispatch("submit");
  assert.equal(requests, 1);
});

test("reload preserves text, choice and revision review without selecting or sending automatically", () => {
  const value = state();
  const first = open(value);
  first.recovery.change(first.entry, { text: "元の版からの下書き", choice: "proceed" });
  const second = open(value, first.saved);
  assert.equal(second.entry.text, "元の版からの下書き");
  assert.equal(second.entry.choice, "proceed");
  value.revision++;
  value.question_contracts.cards.Q1 = contract(2);
  value.questions[0].question = "変更後の対象への質問";
  second.recovery.reconcile(value, second.recovery.beginRead());
  assert.equal(second.entry.choice, null);
  assert.equal(second.entry.text, "元の版からの下書き");
  assert.equal(draftReviewState(second.entry, value.question_contracts.cards.Q1).reviewRequired, true);
  assert.equal(second.recovery.beginSend(value.questions[0], value.question_contracts.cards.Q1), null);
  second.recovery.change(second.entry, { reviewed: "fingerprint-2", reviewedRevision: 2, choice: "hold" });
  const third = open(value, first.saved);
  assert.equal(third.entry.choice, "hold");
  assert.equal(draftReviewState(third.entry, value.question_contracts.cards.Q1).reviewRequired, false);
  const operation = third.recovery.beginSend(value.questions[0], value.question_contracts.cards.Q1);
  assert.deepEqual(operation.payload, { id: "Q1", answer: "元の版からの下書き",
    expected_revision: 2, contract_fingerprint: "fingerprint-2", choice_id: "hold" });
});

test("returning to an earlier fingerprint at a new revision still requires a fresh review", () => {
  const value = state(), { recovery, entry } = open(value);
  recovery.change(entry, { text: "確認中", choice: "proceed" });
  value.revision++;
  value.question_contracts.cards.Q1 = contract(2);
  recovery.reconcile(value, recovery.beginRead());
  recovery.change(entry, { reviewed: "fingerprint-2", reviewedRevision: 2, choice: "hold" });
  value.revision++;
  value.question_contracts.cards.Q1 = contract(3, "fingerprint-1");
  recovery.reconcile(value, recovery.beginRead());
  assert.equal(entry.choice, null);
  assert.equal(entry.reviewed, null);
  assert.equal(draftReviewState(entry, value.question_contracts.cards.Q1).reviewRequired, true);
  assert.equal(recovery.beginSend(value.questions[0], value.question_contracts.cards.Q1), null);
});

test("an uncertain POST is only released by a read started after its failure", () => {
  const value = state(), { recovery, entry, saved } = open(value);
  recovery.change(entry, { text: "  空白を含む回答\n", choice: "hold" });
  const operation = recovery.beginSend(value.questions[0], value.question_contracts.cards.Q1);
  const earlierRead = recovery.beginRead();
  assert.equal(recovery.checkResult(operation), true);
  recovery.reconcile(value, earlierRead);
  assert.equal(entry.phase, "checking");
  assert.equal(recovery.beginSend(value.questions[0], value.question_contracts.cards.Q1), null);
  recovery.reconcile(value, recovery.beginRead());
  assert.equal(entry.phase, "retry");
  const reloaded = open(value, saved);
  assert.equal(reloaded.entry.text, "  空白を含む回答\n");
  const retry = reloaded.recovery.beginSend(value.questions[0], value.question_contracts.cards.Q1);
  assert.deepEqual(retry.payload, operation.payload);
});

test("a saved typed choice with a lost response is reconciled after reload", () => {
  const value = state(), { recovery, entry, saved } = open(value);
  recovery.change(entry, { choice: "hold" });
  const operation = recovery.beginSend(value.questions[0], value.question_contracts.cards.Q1);
  assert.equal(operation.payload.answer, "保留する");
  value.revision++;
  value.questions[0].answer = "保留する";
  Object.assign(value.question_contracts.cards.Q1, { status: "answered", answer: { text: "保留する", choice_id: "hold" } });
  const reloaded = open(value, saved);
  assert.equal(reloaded.recovery.hasDrafts(), false);
  assert.deepEqual(JSON.parse([...saved.values.values()][0]), []);
});

test("identical text with a different contract choice retains the unsent copy", () => {
  const value = state(), { recovery, entry } = open(value);
  recovery.change(entry, { text: "同じ本文", choice: "hold" });
  recovery.beginSend(value.questions[0], value.question_contracts.cards.Q1);
  value.revision++;
  value.questions[0].answer = "同じ本文";
  Object.assign(value.question_contracts.cards.Q1, { status: "answered", answer: { text: "同じ本文", choice_id: "proceed" } });
  recovery.reconcile(value, recovery.beginRead());
  assert.equal(recovery.retained()[0].text, "同じ本文");
});

for (const status of ["cancelled", "expired"]) {
  test(`${status} questions retain drafts and cannot be submitted or revived on reload`, () => {
    const value = state(), { recovery, entry, saved } = open(value);
    recovery.change(entry, { text: "失わない回答", choice: "hold" });
    value.revision++;
    if (status === "expired") value.question_contracts.cards.Q1.snapshot.decision.expires_at = "2000-01-01T00:00:00Z";
    else value.question_contracts.cards.Q1.status = status;
    recovery.reconcile(value, recovery.beginRead());
    assert.equal(recovery.beginSend(value.questions[0], value.question_contracts.cards.Q1), null);
    assert.equal(recovery.retained()[0].text, "失わない回答");
    const reloaded = open(value, saved);
    assert.equal(reloaded.recovery.beginSend(value.questions[0], value.question_contracts.cards.Q1), null);
    assert.equal(reloaded.recovery.retained()[0].text, "失わない回答");
  });
}

test("an older GET cannot clear a current draft or release its request lock", () => {
  const value = state(), earlier = structuredClone(value), { recovery, entry } = open(value);
  recovery.change(entry, { text: "旧GETから守る" });
  const operation = recovery.beginSend(value.questions[0], value.question_contracts.cards.Q1);
  recovery.checkResult(operation);
  value.revision = 3;
  recovery.reconcile(value);
  earlier.questions[0].answer = "旧GETから守る";
  assert.equal(recovery.reconcile(earlier, recovery.beginRead()), false);
  assert.equal(entry.phase, "checking");
  assert.equal(recovery.hasDrafts(), true);
});

test("unreadable saved drafts are preserved while new drafts remain usable in memory", () => {
  const saved = storage();
  saved.values.set("rdsh_project_drafts_v1:test-project", "{incomplete");
  let warnings = 0;
  const value = state(), recovery = createQuestionRecovery("test-project", { ...saved, onStorageError: () => warnings++ });
  recovery.reconcile(value);
  const entry = recovery.draftFor(value.questions[0], value.question_contracts.cards.Q1);
  recovery.change(entry, { text: "メモリー上の本文" });
  assert.equal(warnings, 1);
  assert.equal(entry.text, "メモリー上の本文");
  assert.equal(saved.values.get("rdsh_project_drafts_v1:test-project"), "{incomplete");
});

test("legacy draft records restore under the same tab storage key", () => {
  const value = state(null), q = value.questions[0], saved = storage();
  saved.write("rdsh_project_drafts_v1:test-project", JSON.stringify([{ key: JSON.stringify([q.id, q.created_at, q.question, q.default_action]),
    id: q.id, question: q.question, draft: "旧版の下書き", uncertain: true }]));
  const { recovery, entry } = open(value, saved);
  assert.equal(entry.text, "旧版の下書き");
  assert.equal(entry.phase, "retry");
  assert.deepEqual(recovery.beginSend(q).payload, { id: "Q1", answer: "旧版の下書き" });
});

test("contract review, choice, reference expansion and text selection survive actual card redraws", async () => {
  const ui = dom(), value = state(), { recovery } = open(value);
  const requests = [];
  const context = { node: ui.node, recovery, api: (route, body) => { requests.push({ route, body }); return new Promise(() => {}); },
    refreshState: async () => {}, rerender: () => renderQuestionCards(ui.container, value.questions, value.question_contracts, context) };
  context.rerender();
  let area = ui.container.querySelector("textarea");
  area.value = "版を確認して送る";
  await area.dispatch("input");
  area.focus();
  area.setSelectionRange(1, 4, "backward");
  ui.container.querySelector("details").open = true;
  context.rerender();
  area = ui.container.querySelector("textarea");
  assert.equal(ui.document.activeElement, area);
  assert.deepEqual([area.selectionStart, area.selectionEnd, area.selectionDirection], [1, 4, "backward"]);
  assert.equal(ui.container.querySelector("details").open, true);
  value.revision++;
  value.question_contracts.cards.Q1 = contract(2);
  recovery.reconcile(value, recovery.beginRead());
  context.rerender();
  assert.equal(ui.container.querySelector("button").disabled, true);
  const review = ui.container.querySelectorAll("input").find((item) => item.type === "checkbox");
  review.checked = true;
  await review.dispatch("change");
  const radio = ui.container.querySelectorAll("input").find((item) => item.value === "hold");
  assert.equal(radio.disabled, false);
  radio.checked = true;
  await radio.dispatch("change");
  void ui.container.querySelector("form").dispatch("submit");
  assert.deepEqual(requests, [{ route: "update/answer", body: { id: "Q1", answer: "版を確認して送る",
    expected_revision: 2, contract_fingerprint: "fingerprint-2", choice_id: "hold" } }]);
  assert.equal(ui.container.querySelector("textarea").readOnly, true);
  assert.equal(ui.container.querySelectorAll("button").find((item) => item.textContent === "この質問を取消す").disabled, true);
});
