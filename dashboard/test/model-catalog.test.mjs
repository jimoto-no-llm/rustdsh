import test from "node:test";
import assert from "node:assert/strict";
import {
  createModelCatalogPanel,
  catalogActiveRatio,
  MODEL_CATALOG,
} from "../model-catalog-ui.mjs";

function makeNode() {
  const el = (tag, text, className) => {
    const attrs = {};
    const children = [];
    const node = {
      tag,
      text: text ?? "",
      className: className ?? "",
      attrs,
      children,
      dataset: {},
      setAttribute(k, v) {
        attrs[k] = String(v);
      },
      getAttribute(k) {
        return attrs[k];
      },
      append(...nodes) {
        children.push(...nodes);
        return node;
      },
      appendChild(n) {
        children.push(n);
        return n;
      },
      querySelectorAll() {
        return [];
      },
      textContent: "",
    };
    node.textContent = text ?? "";
    return node;
  };
  return el;
}

function makeContainer() {
  const children = [];
  return {
    children,
    replaceChildren(...nodes) {
      children.length = 0;
      if (nodes.length) children.push(...nodes);
    },
    append(...nodes) {
      children.push(...nodes);
    },
    dump() {
      return JSON.stringify(children);
    },
  };
}

test("createModelCatalogPanel が export されている", () => {
  assert.equal(typeof createModelCatalogPanel, "function");
  assert.equal(typeof catalogActiveRatio, "function");
  assert.ok(Array.isArray(MODEL_CATALOG) && MODEL_CATALOG.length >= 1);
});

test("空カタログはテキスト表示し 0 にしない", () => {
  const node = makeNode();
  const container = makeContainer();
  createModelCatalogPanel(container, node, []);
  const dump = container.dump();
  assert.match(dump, /未登録/);
  assert.doesNotMatch(dump, /\b0\b.*件|\"text\":\"0\"/);
});

test("有効/総の棒比率は 0.49 になる", () => {
  const ratio = catalogActiveRatio(MODEL_CATALOG[0]);
  assert.ok(Math.abs(ratio - 0.49) < 1e-9);
  // 異常値（null）は null を返し 0 にしない
  assert.equal(catalogActiveRatio({ total_value: null, active_value: 49 }), null);
  assert.equal(catalogActiveRatio({ total_value: 100, active_value: null }), null);
});
