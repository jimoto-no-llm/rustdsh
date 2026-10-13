import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { renderBlock } from "../ui/blocks.mjs";

const stylesheet = await fs.readFile(
  fileURLToPath(new URL("../ui.html", import.meta.url)),
  "utf8",
);
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
      append(...nodes) { children.push(...nodes); return node; },
      appendChild(child) { children.push(child); return child; },
    };
    return node;
  };
  return el;
}
function makeContainer() {
  const children = [];
  return { children, append(...n) { children.push(...n); }, replaceChildren(...n) { children.length = 0; children.push(...n); } };
}
function classesOf(root, out) {
  const acc = out || [];
  if (root.className) acc.push(String(root.className));
  for (const child of root.children || [])
    if (child && typeof child === "object") classesOf(child, acc);
  return acc;
}
const block = (kind, data, extra) => Object.assign({ id: "b-" + kind.replace(/\./g, "-"), kind, data }, extra || {});
const SAMPLES = {
  text: { text: "短い回答" },
  heading: { text: "見出し" },
  caption: { text: "補足" },
  code: { code: "cargo test", language: "sh" },
  callout: { text: "注意", tone: "warn" },
  "status-badge": { label: "検証済み", tone: "ok" },
  "key-value": { items: [{ label: "OS", value: "Linux" }, { label: "GPU", value: null }] },
  "simple-table": { columns: ["項目", "値"], rows: [["A", "1"], ["B", null]] },
  card: { blocks: [{ id: "inner", kind: "text", data: { text: "中身" } }] },
  row: { blocks: [{ id: "inner-row", kind: "text", data: { text: "中身" } }] },
  column: { blocks: [{ id: "inner-col", kind: "text", data: { text: "中身" } }] },
  choice: { prompt: "どれにしますか", choices: [{ id: "a", label: "A" }] },
  button: { label: "実行", action: { id: "run", kind: "request_tool", label: "実行" } },
  form: { fields: [{ id: "name", label: "名前" }] },
  "dev.diff-split": { before: "old()", after: "new()", path: "a.mjs" },
  "dev.test-results": { cases: [{ name: "t1", status: "pass" }, { name: "t2", status: "fail" }, { name: "t3", status: "hold" }] },
  "chart.line": { points: [[0, 1]], x_unit: "回", y_unit: "USD" },
  "chart.bar": { bars: [{ label: "成功", value: 3 }, { label: "保留", value: null }], unit: "件" },
  "agent.approval": { operation: "再起動", target: "run-1" },
};

test("every class the renderer emits is styled by ui.html", () => {
  const node = makeNode();
  const emitted = new Set();
  for (const kind of Object.keys(SAMPLES)) {
    const container = makeContainer();
    renderBlock(container, block(kind, SAMPLES[kind]), node, () => {});
    for (const value of classesOf(container)) {
      for (const token of value.split(/\s+/).filter(Boolean)) emitted.add(token);
    }
  }
  const missing = [...emitted].filter((token) => !stylesheet.includes("." + token));
  assert.deepEqual(missing, [], "unstyled classes: " + missing.join(", "));
});

test("every tone and observation variant has a rule", () => {
  for (const selector of [
    ".badge.ok", ".badge.warn", ".badge.danger", ".badge.info",
    ".callout.warn", ".callout.danger",
    ".bar-ok", ".bar-warn", ".bar-danger", ".bar-info", ".bar-neutral",
    ".provenance-badge.measured", ".provenance-badge.agent_reported",
    ".provenance-badge.estimated", ".provenance-badge.unavailable",
    ".ui-block", ".ui-block-title", ".ui-observation", ".ui-actions",
    ".ui-choice", ".ui-form", ".ui-table", ".ui-diff-panes", ".ui-chart",
    ".ui-surface", ".ui-empty", ".ui-panel", ".ui-heading",
  ])
    assert.ok(stylesheet.includes(selector), selector);
});

test("interactive states and reduced motion are themed", () => {
  for (const rule of [
    ".ui-choice:has(input:checked)",
    ".ui-choice:has(input:focus-visible)",
    ".ui-actions button:focus-visible",
    ".ui-actions button[disabled]",
    ".ui-form input:focus-visible",
    "prefers-reduced-motion",
    "::selection",
    "scrollbar-color",
  ])
    assert.ok(stylesheet.includes(rule), rule);
});
