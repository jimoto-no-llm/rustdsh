import test from "node:test";
import assert from "node:assert/strict";
import {
  PROTOCOL, BLOCK_KINDS, MAX_DEPTH, MAX_BLOCKS, ACTION_HANDLING,
  observationLabel, isClientAction, isSessionAction, isWiredActionKind,
  validateAction, validateBlock, validateEnvelope, normalizeBlock,
  defaultActions, collectActions, countBlocks, fallbackBlock,
} from "../ui/registry.mjs";

const SAMPLES = {
  text: { text: "短い回答" },
  heading: { text: "見出し" },
  caption: { text: "補足" },
  code: { code: "cargo test", language: "sh" },
  callout: { text: "注意", tone: "warn" },
  "status-badge": { label: "検証済み", tone: "ok" },
  "key-value": { items: [{ label: "OS", value: "Linux" }, { label: "GPU", value: null }] },
  "simple-table": { columns: ["項目", "値"], rows: [["A", "1"], ["B", null]] },
  card: { blocks: [{ id: "c-inner", kind: "text", data: { text: "中身" } }] },
  row: { blocks: [{ id: "r-inner", kind: "text", data: { text: "中身" } }] },
  column: { blocks: [{ id: "col-inner", kind: "text", data: { text: "中身" } }] },
  choice: { prompt: "どれにしますか", choices: [{ id: "a", label: "A" }, { id: "b", label: "B" }] },
  button: { label: "実行", action: { id: "run", kind: "request_tool", label: "実行" } },
  form: { fields: [{ id: "name", label: "名前" }] },
  "dev.diff-split": { before: "old()", after: "new()", path: "a.mjs" },
  "dev.test-results": { cases: [{ name: "t1", status: "pass" }, { name: "t2", status: "fail" }] },
  "chart.line": { points: [[0, 1], [1, 2]], x_unit: "回", y_unit: "USD" },
  "chart.bar": { bars: [{ label: "成功", value: 2 }, { label: "失敗", value: null }], unit: "件" },
  "agent.approval": { operation: "再起動", target: "run-1" },
};

test("protocol is rdsh-ui/1 and every documented kind has a sample", () => {
  assert.equal(PROTOCOL, "rdsh-ui/1");
  assert.equal(BLOCK_KINDS.length, 19);
  assert.deepEqual(Object.keys(SAMPLES).sort(), [...BLOCK_KINDS].sort());
});

test("every kind validates its own sample and rejects a type mismatch", () => {
  for (const kind of BLOCK_KINDS) {
    const block = { id: "b-" + kind, kind, data: SAMPLES[kind] };
    const ok = validateBlock(block);
    assert.equal(ok.ok, true, kind + ": " + ok.errors.join(","));
    const broken = validateBlock({ id: "b", kind, data: { nothing: true } });
    assert.equal(broken.ok, false, kind);
  }
});

test("unknown kind, bad id and bad data fall back instead of throwing", () => {
  assert.equal(validateBlock({ id: "x", kind: "chart.realtime", data: {} }).fallback, true);
  assert.equal(validateBlock({ id: "", kind: "text", data: { text: "x" } }).ok, false);
  assert.equal(validateBlock({ id: "x", kind: "text", data: { text: 42 } }).ok, false);
  assert.equal(validateBlock(null).fallback, true);
  const out = fallbackBlock({ id: "x", kind: "chart.realtime", data: { a: 1 } }, "unknown");
  assert.equal(out.kind, "text");
  assert.match(out.data.text, /文字表示/);
});

test("nested containers stop at MAX_DEPTH and count toward MAX_BLOCKS", () => {
  let block = { id: "leaf", kind: "text", data: { text: "x" } };
  for (let i = 0; i < MAX_DEPTH - 1; i += 1)
    block = { id: "c" + i, kind: "card", data: { blocks: [block] } };
  assert.equal(validateBlock(block).ok, true);
  const tooDeep = { id: "top", kind: "card", data: { blocks: [block] } };
  const checked = validateBlock(tooDeep);
  assert.equal(checked.ok, false);
  assert.match(checked.errors.join(","), /入れ子/);
  assert.equal(countBlocks([block]), MAX_DEPTH);
  const many = [];
  for (let i = 0; i < MAX_BLOCKS + 1; i += 1)
    many.push({ id: "m" + i, kind: "text", data: { text: "x" } });
  assert.equal(validateEnvelope({ protocol: PROTOCOL, blocks: many }).ok, false);
});

test("default actions are issued for choice, form and approval", () => {
  const choice = normalizeBlock({ id: "q1", kind: "choice", data: SAMPLES.choice }, 1);
  assert.equal(choice.actions.length, 1);
  assert.equal(choice.actions[0].kind, "submit_choice");
  assert.equal(choice.actions[0].id, "q1:submit");
  const form = normalizeBlock({ id: "f1", kind: "form", data: SAMPLES.form }, 1);
  assert.equal(form.actions[0].kind, "submit_form");
  const approval = normalizeBlock({ id: "a1", kind: "agent.approval", data: SAMPLES["agent.approval"] }, 1);
  assert.deepEqual(approval.actions.map((a) => a.kind), ["approve", "reject"]);
  assert.equal(defaultActions({ id: "t", kind: "text", data: {} }), null);
  const button = normalizeBlock({ id: "b1", kind: "button", data: SAMPLES.button }, 1);
  assert.equal(button.actions[0].kind, "request_tool");
});

test("collectActions reports handling and refuses duplicates", () => {
  const blocks = [
    normalizeBlock({ id: "q1", kind: "choice", data: SAMPLES.choice }, 1),
    normalizeBlock({ id: "a1", kind: "agent.approval", data: SAMPLES["agent.approval"] }, 1),
  ];
  const collected = collectActions(blocks);
  assert.equal(collected.duplicates, false);
  assert.deepEqual(collected.actions.map((a) => a.handling), ["session", "session", "session"]);
  const clashing = [
    { id: "one", kind: "text", data: { text: "x" }, actions: [{ id: "dup", kind: "copy", label: "複写" }] },
    { id: "two", kind: "text", data: { text: "y" }, actions: [{ id: "dup", kind: "copy", label: "複写" }] },
  ];
  assert.equal(collectActions(clashing).duplicates, true);
});

test("action handling separates client, session and request authority", () => {
  assert.equal(isClientAction({ kind: "copy" }), true);
  assert.equal(isClientAction({ kind: "delete" }), false);
  assert.equal(isSessionAction({ kind: "submit_choice" }), true);
  assert.equal(isWiredActionKind("request_tool"), true);
  assert.equal(isWiredActionKind("teleport"), false);
  assert.equal(ACTION_HANDLING.delete, "request");
  assert.equal(validateAction({ id: "a", kind: "teleport", label: "x" }).ok, false);
});

test("inherited object keys never become action kinds or observation labels", () => {
  for (const kind of ["toString", "constructor", "__proto__"]) {
    assert.equal(isWiredActionKind(kind), false, kind);
    assert.equal(validateAction({ id: "a", kind, label: "x" }).ok, false, kind);
    assert.equal(observationLabel({ kind }), "未取得", kind);
  }
});

test("observation labels stay explicit and default to 未取得", () => {
  assert.equal(observationLabel({ kind: "measured" }), "実測");
  assert.equal(observationLabel({ kind: "agent_reported" }), "エージェント報告");
  assert.equal(observationLabel({ kind: "estimated" }), "推定");
  assert.equal(observationLabel({ kind: "unavailable" }), "未取得");
  assert.equal(observationLabel(undefined), "未取得");
  assert.equal(observationLabel({ kind: "made_up" }), "未取得");
  assert.equal(validateBlock({ id: "x", kind: "text", data: { text: "a" }, observation: { kind: "made_up" } }).ok, false);
});
