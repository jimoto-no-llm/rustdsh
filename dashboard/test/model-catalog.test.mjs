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
  assert.match(dump, /No models are registered/);
  assert.doesNotMatch(dump, /\b0\b.*件|\"text\":\"0\"/);
});

test("有効/総の棒比率は 0.49 になる", () => {
  const ratio = catalogActiveRatio(MODEL_CATALOG[0]);
  assert.ok(Math.abs(ratio - 0.49) < 1e-9);
  // 異常値（null）は null を返し 0 にしない
  assert.equal(
    catalogActiveRatio({ total_value: null, active_value: 49 }),
    null,
  );
  assert.equal(
    catalogActiveRatio({ total_value: 100, active_value: null }),
    null,
  );
});

import { execFileSync } from "node:child_process";

function detailNode(tag, value = "", className = "") {
  let ownText = value;
  const el = {
    tag,
    tagName: tag.toUpperCase(),
    className,
    dataset: {},
    attrs: {},
    children: [],
    events: {},
    value: "",
    append(...items) {
      this.children.push(...items);
    },
    replaceChildren(...items) {
      this.children = items;
      ownText = "";
    },
    setAttribute(key, value) {
      this.attrs[key] = value;
    },
    addEventListener(name, fn) {
      this.events[name] = fn;
    },
    focus() {},
    setSelectionRange() {},
    querySelectorAll(selector) {
      const matches = (item) =>
        selector === "[data-question]"
          ? Boolean(item.dataset.question)
          : selector === '[role="alert"]'
            ? item.attrs.role === "alert"
            : selector === 'input[type="radio"]:checked'
              ? item.tag === "input" && item.type === "radio" && item.checked
              : item.tag === selector;
      return this.children.flatMap((item) => [
        ...(matches(item) ? [item] : []),
        ...item.querySelectorAll(selector),
      ]);
    },
    querySelector(selector) {
      return this.querySelectorAll(selector)[0] || null;
    },
    get textContent() {
      return ownText + this.children.map((item) => item.textContent).join(" ");
    },
    set textContent(value) {
      ownText = value;
      this.children = [];
    },
  };
  return el;
}

for (const language of ["en", "zh-CN", "ja"])
  test(`model catalog renders ${language} while preserving received values`, () => {
    const source = `
    import assert from "node:assert/strict";
    globalThis.document = { documentElement: { dataset: { rdshLocale: ${JSON.stringify(language)} } }, getElementById() { return null; }, activeElement: null };
    ${detailNode.toString()}
    const node = detailNode;
    const { text, formatDateTime, catalog } = await import(${JSON.stringify(new URL("../locale.mjs", import.meta.url).href)});

    const { createModelCatalogPanel, MODEL_CATALOG } = await import(${JSON.stringify(new URL("../model-catalog-ui.mjs", import.meta.url).href)});
    const root = node("div");
    const render = createModelCatalogPanel(root, node);
    for (const key of ["model.heading", "model.intro", "model.preview", "model.weightsPlan", "model.trillion", "model.billion", "model.reported", "model.sourceBuiltin"]) assert.ok(root.textContent.includes(text(key)), key);
    assert.equal(root.querySelector("svg").attrs["aria-label"], text("model.ratio", { value: "0.49" }));
    assert.equal(MODEL_CATALOG[0].id, "mistral-large-preview");
    const raw = "原文 日本語 / 中文 · English {id}";
    const entry = { name: raw, architecture: raw, status: raw, weights: raw, total_value: 100, active_value: 49, total_label: raw, active_label: raw, certainty: raw, source_ref: raw };
    render([entry]);
    assert.equal(root.querySelector("h3").textContent, raw);
    assert.ok(root.textContent.includes(raw));
    assert.equal(entry.total_label, raw);
    render([{}]);
    for (const key of ["model.noName", "model.noArchitecture", "model.noStatus", "model.unavailable", "model.missingRatio"]) assert.ok(root.textContent.includes(text(key)), key);
    render([]);
    assert.ok(root.textContent.includes(text("model.empty")));
    const { detailsEntries } = await import(${JSON.stringify(new URL("../locale-details.mjs", import.meta.url).href)});
    assert.equal(new Set(detailsEntries.map(row => row[0])).size, detailsEntries.length);
    for (const [key, ja, en, zh] of detailsEntries) {
      assert.equal(typeof catalog[${JSON.stringify(language)}][key], "string", key);
      const placeholders = value => [...value.matchAll(/[{]([a-zA-Z0-9_]+)[}]/g)].map(match => match[1]).sort();
      assert.deepEqual(placeholders(ja), placeholders(en), key);
      assert.deepEqual(placeholders(ja), placeholders(zh), key);
    }

  `;
    execFileSync(process.execPath, ["--input-type=module", "-e", source], {
      encoding: "utf8",
    });
  });
