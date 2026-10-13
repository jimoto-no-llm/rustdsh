import test from "node:test";
import assert from "node:assert/strict";
import { renderEnvelope } from "../ui/blocks.mjs";
import { buildUiEnvelope } from "../ui/state-adapter.mjs";

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
const envelopeOf = (blocks) => ({
  protocol: "rdsh-ui/1", session_id: "dashboard",
  message_id: "m-1", revision: 1, blocks,
});

test("re-rendering the same envelope is idempotent", () => {
  const node = makeNode();
  const container = makeContainer();
  const envelope = envelopeOf([{
    id: "c", kind: "chart.line",
    data: { points: [[0, 1], [1, 2]], x_unit: "x", y_unit: "y" },
  }]);
  renderEnvelope(container, envelope, node);
  const first = container.dump();
  renderEnvelope(container, envelope, node);
  assert.equal(container.dump(), first);
  assert.equal(first.split(String.fromCharCode(34) + "tag" + String.fromCharCode(34) + ":" + String.fromCharCode(34) + "svg" + String.fromCharCode(34)).length - 1, 1);
});

test("a 201-block surface renders at most 200 blocks", () => {
  const node = makeNode();
  const container = makeContainer();
  const blocks = [];
  for (let i = 0; i < 201; i += 1) blocks.push({ id: "b-" + i, kind: "text", data: { text: "t" } });
  const results = renderEnvelope(container, envelopeOf(blocks), node);
  assert.equal(results.length, 200);
});

test("without a session bridge the interactive kinds stay disabled", () => {
  const node = makeNode();
  const container = makeContainer();
  renderEnvelope(container, envelopeOf([
    { id: "f", kind: "form", data: { fields: [{ id: "a", label: "A" }] } },
    { id: "a", kind: "agent.approval", data: { operation: "削除", target: "run-1" } },
  ]), node);
  const buttons = findAll(container, (n) => n.tag === "button");
  assert.ok(buttons.length >= 3);
  for (const pressed of buttons) assert.equal(pressed.disabled, true);
  assert.match(container.dump(), /実行権限は発行されません/);
});

test("labels, chart roles and input names stay present for assistive tech", () => {
  const node = makeNode();
  const container = makeContainer();
  renderEnvelope(container, envelopeOf([
    { id: "b", kind: "button", data: { label: "実行" } },
    { id: "c", kind: "chart.line", data: { points: [[0, 1]] } },
    { id: "f", kind: "form", data: { fields: [{ id: "q", label: "Q", type: "textarea" }] } },
  ]), node);
  for (const pressed of findAll(container, (n) => n.tag === "button")) assert.ok(pressed.textContent.length > 0);
  const svgs = findAll(container, (n) => n.tag === "svg");
  assert.equal(svgs.length, 1);
  assert.equal(svgs[0].attrs.role, "img");
  const areas = findAll(container, (n) => n.tag === "textarea");
  assert.equal(areas.length, 1);
  assert.equal(areas[0].attrs.name, "q");
});

test("the state bridge is read-only and survives missing data", () => {
  const node = makeNode();
  const before = JSON.stringify({ budget_admission: { policies: null }, questions: null, revision: 7 });
  const current = JSON.parse(before);
  const envelope = buildUiEnvelope(current);
  assert.equal(envelope.protocol, "rdsh-ui/1");
  assert.equal(envelope.revision, 7);
  const container = makeContainer();
  const results = renderEnvelope(container, envelope, node);
  assert.ok(results.every((entry) => entry.fallback === false));
  assert.equal(JSON.stringify(current), before);
  const partial = buildUiEnvelope({
    revision: 8,
    questions: [],
    budget_admission: {
      policies: [{ run_id: null, status: "unknown", currency: "USD", effective: null, hard_limit: "1", spent: null }],
      decisions: [],
    },
  });
  const partialContainer = makeContainer();
  renderEnvelope(partialContainer, partial, node);
  assert.match(partialContainer.dump(), /未取得/);
  assert.doesNotMatch(partialContainer.dump(), /"textContent":"0"/);
  assert.ok(buildUiEnvelope(null).blocks.length >= 2);
  const empty = buildUiEnvelope(null);
  assert.equal(empty.blocks.some((entry) => entry.kind === "chart.line"), false);
});

test("mixed currencies are never summed into one series", () => {
  const envelope = buildUiEnvelope({
    revision: 1,
    budget_admission: {
      policies: [],
      decisions: [
        { kind: "usage", currency: "USD", amount: "1.5" },
        { kind: "usage", currency: "JPY", amount: "200" },
        { kind: "usage", currency: "USD", amount: "2.5" },
        { kind: "usage", currency: "USD", amount: null },
      ],
    },
    questions: [],
  });
  const chart = envelope.blocks.find((entry) => entry.id === "ui-reported-cost-trend");
  assert.deepEqual(chart.data.points, [[0, 1.5], [1, 2.5]]);
  assert.equal(chart.data.y_unit, "USD");
});
