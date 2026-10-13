import test from "node:test";
import assert from "node:assert/strict";
import { renderBlock, renderEnvelope, renderSurface } from "../ui/blocks.mjs";

function makeNode() {
  const el = function (tag, text, className) {
    const attrs = {};
    const children = [];
    const handlers = {};
    const node = {
      tag,
      textContent: text === undefined ? "" : text,
      className: className === undefined ? "" : className,
      attrs,
      children,
      handlers,
      dataset: {},
      setAttribute(k, v) { if (k === "id") node.id = String(v); else attrs[k] = String(v); },
      getAttribute(k) { return attrs[k]; },
      addEventListener(type, fn) { (handlers[type] = handlers[type] || []).push(fn); },
      dispatch(type, event) { for (const fn of handlers[type] || []) fn(event || { target: node }); },
      append(...nodes) { children.push(...nodes); return node; },
      appendChild(child) { children.push(child); return child; },
    };
    return node;
  };
  return el;
}
function makeContainer() {
  const children = [];
  return {
    children,
    append(...nodes) { children.push(...nodes); },
    replaceChildren(...nodes) { children.length = 0; children.push(...nodes); },
    dump() { return JSON.stringify(children); },
  };
}
function findAll(root, pred, out) {
  const acc = out || [];
  for (const child of root.children || []) {
    if (child && typeof child === "object") {
      if (pred(child)) acc.push(child);
      findAll(child, pred, acc);
    }
  }
  return acc;
}
const block = (kind, data, extra) =>
  Object.assign({ id: "b-" + kind, kind, data }, extra || {});
const SAMPLES = {
  text: { text: "短い回答" },
  heading: { text: "見出し" },
  caption: { text: "補足" },
  code: { code: "cargo test" },
  callout: { text: "注意", tone: "warn" },
  "status-badge": { label: "検証済み", tone: "ok" },
  "key-value": { items: [{ label: "OS", value: "Linux" }, { label: "GPU", value: null }] },
  "simple-table": { columns: ["項目", "値"], rows: [["A", "1"], ["B", null]] },
  card: { blocks: [{ id: "inner", kind: "text", data: { text: "中身" } }] },
  row: { blocks: [{ id: "inner", kind: "text", data: { text: "中身" } }] },
  column: { blocks: [{ id: "inner", kind: "text", data: { text: "中身" } }] },
  choice: { prompt: "どれにしますか", choices: [{ id: "a", label: "A" }, { id: "b", label: "B" }] },
  button: { label: "実行", action: { id: "run", kind: "request_tool", label: "実行" } },
  form: { fields: [{ id: "name", label: "名前" }] },
  "dev.diff-split": { before: "old()", after: "new()", path: "a.mjs" },
  "dev.test-results": { cases: [{ name: "t1", status: "pass" }, { name: "t2", status: "fail" }, { name: "t3", status: "hold" }] },
  "chart.line": { points: [[0, 1], [1, 3]], x_unit: "回", y_unit: "USD" },
  "chart.bar": { bars: [{ label: "成功", value: 3 }, { label: "失敗", value: 1 }, { label: "保留", value: null }], unit: "件" },
  "agent.approval": { operation: "再起動", target: "run-1" },
};

test("all 19 kinds render without falling back", () => {
  const node = makeNode();
  for (const kind of Object.keys(SAMPLES)) {
    const container = makeContainer();
    const result = renderBlock(container, block(kind, SAMPLES[kind]), node);
    assert.equal(result.fallback, false, kind);
    assert.ok(container.children.length > 0, kind);
  }
});

test("observation labels are always visible", () => {
  const node = makeNode();
  const cases = [
    [{ kind: "measured", source: "ACP" }, /実測/],
    [{ kind: "agent_reported" }, /エージェント報告/],
    [{ kind: "estimated" }, /推定/],
    [{ kind: "unavailable" }, /未取得/],
    [undefined, /未取得/],
  ];
  for (const item of cases) {
    const container = makeContainer();
    const extra = item[0] === undefined ? {} : { observation: item[0] };
    renderBlock(container, block("text", { text: "x" }, extra), node);
    assert.match(container.dump(), item[1]);
  }
});

test("unknown values stay 未取得 and are never drawn as zero", () => {
  const node = makeNode();
  const table = makeContainer();
  renderBlock(table, block("simple-table", SAMPLES["simple-table"]), node);
  assert.match(table.dump(), /未取得/);
  assert.doesNotMatch(table.dump(), /"textContent":"0"/);
  const bar = makeContainer();
  renderBlock(bar, block("chart.bar", SAMPLES["chart.bar"]), node);
  assert.match(bar.dump(), /未取得/);
  assert.match(bar.dump(), /0としては描画しません/);
  const kv = makeContainer();
  renderBlock(kv, block("key-value", SAMPLES["key-value"]), node);
  assert.match(kv.dump(), /未取得/);
});

test("choice returns the selected id through emit", () => {
  const node = makeNode();
  const container = makeContainer();
  const seen = [];
  renderBlock(container, block("choice", SAMPLES.choice), node, (action, blk, value) => seen.push([action.kind, action.id, value]));
  const radios = findAll(container, (n) => n.tag === "input");
  assert.equal(radios.length, 2);
  radios[1].dispatch("change");
  const submit = findAll(container, (n) => n.tag === "button")[0];
  assert.equal(submit.disabled, undefined);
  submit.dispatch("click");
  assert.deepEqual(seen, [["submit_choice", "b-choice:submit", { choice_id: "b" }]]);
});

test("form returns typed values and refuses an empty submit", () => {
  const node = makeNode();
  const container = makeContainer();
  const seen = [];
  renderBlock(container, block("form", SAMPLES.form), node, (action, blk, value) => seen.push([action.kind, value]));
  const input = findAll(container, (n) => n.tag === "input")[0];
  input.dispatch("input", { target: { value: "sahen" } });
  const submit = findAll(container, (n) => n.tag === "button")[0];
  submit.dispatch("click");
  assert.deepEqual(seen, [["submit_form", { name: "sahen" }]]);
});

test("without emit the browser-only kinds stay disabled", () => {
  const node = makeNode();
  const container = makeContainer();
  renderEnvelope(container, { protocol: "rdsh-ui/1", blocks: [
    block("form", SAMPLES.form), block("agent.approval", SAMPLES["agent.approval"]),
  ] }, node);
  const buttons = findAll(container, (n) => n.tag === "button");
  assert.ok(buttons.length >= 3);
  for (const pressed of buttons) assert.equal(pressed.disabled, true);
});

test("approval buttons send a request but never grant authority", () => {
  const node = makeNode();
  const container = makeContainer();
  const seen = [];
  renderBlock(container, block("agent.approval", SAMPLES["agent.approval"]), node,
    (action) => seen.push(action.kind));
  const buttons = findAll(container, (n) => n.tag === "button");
  assert.equal(buttons.length, 2);
  assert.equal(buttons[0].attrs["data-action-kind"], "approve");
  buttons[0].dispatch("click");
  buttons[1].dispatch("click");
  assert.deepEqual(seen, ["approve", "reject"]);
  assert.match(container.dump(), /実行権限は発行されません/);
});

test("request-type actions are marked as recorded, not executed", () => {
  const node = makeNode();
  const container = makeContainer();
  renderBlock(container, block("button", SAMPLES.button), node, () => {});
  assert.match(container.dump(), /要求として記録され/);
  assert.match(container.dump(), /実行権限は発行されません/);
});

test("unknown kind degrades to text and never executes", () => {
  const node = makeNode();
  const container = makeContainer();
  const result = renderBlock(container, { id: "x", kind: "diagram.sankey", data: {} }, node);
  assert.equal(result.fallback, true);
  assert.equal(result.kind, "text");
  assert.match(container.dump(), /文字表示/);
  assert.match(container.dump(), /diagram.sankey/);
});

test("test results and nested containers render their contents", () => {
  const node = makeNode();
  const results = makeContainer();
  renderBlock(results, block("dev.test-results", SAMPLES["dev.test-results"]), node);
  assert.match(results.dump(), /成功 1/);
  assert.match(results.dump(), /失敗 1/);
  assert.match(results.dump(), /保留 1/);
  const nested = makeContainer();
  renderBlock(nested, block("card", SAMPLES.card), node);
  assert.match(nested.dump(), /中身/);
  const empty = makeContainer();
  const surfaceResult = renderSurface(empty, null, node);
  assert.deepEqual(surfaceResult, []);
  assert.match(empty.dump(), /提示されたUIはありません/);
});
