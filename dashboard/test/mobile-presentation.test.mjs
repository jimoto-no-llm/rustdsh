import test from "node:test";
import assert from "node:assert/strict";
import { loadDashboard, stateFor } from "./answer-dom.mjs";

function metric(ui, title) {
  return ui.element("cards").children.find((card) => card.children[0].textContent === title);
}

test("unavailable metrics, a zero denominator and measured zero remain distinct", async () => {
  const state = stateFor();
  const ui = await loadDashboard({ state });
  assert.equal(metric(ui, "従来の累計報告（API換算）").children[1].textContent, "未取得");
  assert.match(metric(ui, "従来の累計報告（API換算）").textContent, /上限 未取得/);
  assert.equal(metric(ui, "ツールのエラー率").children[1].textContent, "未取得");
  const observation = {
    kind: "measured", observed_at: new Date().toISOString(),
    max_age_seconds: 600, source: "mobile-presentation fixture", report_id: "zero-metrics",
  };
  state.metric_observations = Object.fromEntries(
    ["total_cost_usd", "input_tokens", "cached_input_tokens", "tool_calls", "tool_errors"]
      .map((key) => [key, observation]),
  );
  state.metrics = { total_cost_usd: 0, input_tokens: 0, cached_input_tokens: 0, tool_calls: 0, tool_errors: 0 };
  state.revision++;
  await ui.changed();
  assert.equal(metric(ui, "従来の累計報告（API換算）").children[1].textContent, "$0.00");
  assert.equal(metric(ui, "キャッシュ読み込み率").children[1].textContent, "対象なし");
  assert.equal(metric(ui, "ツールのエラー率").children[1].textContent, "対象なし");
  state.metrics.input_tokens = 100;
  state.metrics.tool_calls = 5;
  state.revision++;
  await ui.changed();
  assert.equal(metric(ui, "キャッシュ読み込み率").children[1].textContent, "0.0%");
  assert.equal(metric(ui, "ツールのエラー率").children[1].textContent, "0.0%");
});

test("a reference is not inferred to be an approval and stays expanded while a draft refreshes", async () => {
  const state = stateFor();
  state.questions[0].default_action = "返事が来るまで待つ";
  const ui = await loadDashboard({ state });
  const question = ui.element("question-Q1");
  assert.doesNotMatch(question.textContent, /承認依頼/);
  const reference = question.querySelector("details");
  assert.ok(reference, "the reference must remain available without a separate narrow column");
  assert.match(reference.textContent, /返事が来るまで待つ/);
  reference.open = true;
  await ui.input("日本語の回答");
  ui.textarea().focus();
  ui.textarea().setSelectionRange(3, 5);
  state.revision++;
  await ui.changed();
  assert.equal(ui.element("question-Q1").querySelector("details").open, true);
  assert.equal(ui.textarea().value, "日本語の回答");
  assert.equal(ui.document.activeElement, ui.textarea());
  assert.equal(ui.textarea().selectionStart, 3);
  assert.equal(ui.answers().length, 0);
});

test("answered questions retain their ID, question and answer and show a count", async () => {
  const state = stateFor("project-alpha", ["Q1", "Q2"]);
  for (const question of state.questions) question.question = "共通の質問本文";
  const ui = await loadDashboard({ state });
  await ui.input("同じ文面でも識別できる");
  await ui.submit();
  assert.match(ui.element("answers").textContent, /Q1/);
  assert.match(ui.element("answers").textContent, /共通の質問本文/);
  assert.match(ui.element("answers").textContent, /同じ文面でも識別できる/);
  assert.equal(ui.element("answered-summary").textContent, "回答済みの質問（1件）");
  assert.equal(ui.answers().length, 1);
});

test("SSE redraw preserves focus on the same question's reference summary", async () => {
  const state = stateFor();
  state.questions[0].default_action = "返事が来るまで待つ";
  const ui = await loadDashboard({ state });
  await ui.input("まだ送信しない回答");
  for (const open of [false, true]) {
    const reference = ui.element("question-Q1").querySelector("details");
    reference.open = open;
    reference.querySelector("summary").focus();
    state.revision++;
    await ui.changed();
    const refreshed = ui.element("question-Q1").querySelector("details");
    assert.ok(ui.document.activeElement === refreshed.querySelector("summary"),
      "focus must return to the current reference summary after SSE redraw");
    assert.equal(refreshed.open, open);
    assert.equal(ui.textarea().value, "まだ送信しない回答");
    assert.equal(ui.answers().length, 0);
  }
});

test("reference focus does not transfer to a changed question or another question", async () => {
  const state = stateFor("project-alpha", ["Q1", "Q2"]);
  for (const question of state.questions) question.default_action = "返事が来るまで待つ";
  const ui = await loadDashboard({ state });
  ui.element("question-Q1").querySelector("summary").focus();
  state.questions[0].question = "同じIDの新しい質問";
  state.revision++;
  await ui.changed();
  assert.notEqual(ui.document.activeElement, ui.element("question-Q1").querySelector("summary"));
  assert.notEqual(ui.document.activeElement, ui.element("question-Q2").querySelector("summary"));

  ui.element("question-Q1").querySelector("summary").focus();
  state.questions[0].default_action = "";
  state.revision++;
  await ui.changed();
  assert.equal(ui.element("question-Q1").querySelector("summary"), null);
  assert.notEqual(ui.document.activeElement, ui.element("question-Q2").querySelector("summary"));
  assert.equal(ui.answers().length, 0);
});
