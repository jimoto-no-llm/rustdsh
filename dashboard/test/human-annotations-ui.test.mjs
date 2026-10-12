import test from "node:test";
import assert from "node:assert/strict";
import { createHumanAnnotationPanel } from "../human-annotations-ui.mjs";

class FakeElement {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.attributes = new Map();
    this.dataset = {};
    this.hidden = false;
    this.disabled = false;
    this.required = false;
    this.value = "";
    this.textContent = "";
    this.className = "";
    this.id = "";
    this.listeners = new Map();
  }
  setAttribute(key, value) {
    this.attributes.set(key, String(value));
  }
  getAttribute(key) {
    return this.attributes.get(key) ?? null;
  }
  append(...items) {
    for (const item of items) this.children.push(item);
    return this;
  }
  replaceChildren(...items) {
    this.children = [...items];
    return this;
  }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }
  emit(type) {
    for (const listener of this.listeners.get(type) ?? [])
      listener({ preventDefault() {}, target: this });
  }
  querySelectorAll(selector) {
    const wanted = new Set(
      selector
        .split(",")
        .map((part) => part.trim().toLowerCase())
        .filter(Boolean),
    );
    const found = [];
    const walk = (element) => {
      if (wanted.has(element.tagName.toLowerCase())) found.push(element);
      for (const child of element.children)
        if (child instanceof FakeElement) walk(child);
    };
    for (const child of this.children)
      if (child instanceof FakeElement) walk(child);
    return found;
  }
}

function harness() {
  const created = [];
  const node = (tag, text, className) => {
    const element = new FakeElement(tag);
    if (text !== undefined) element.textContent = text;
    if (className) element.className = className;
    created.push(element);
    return element;
  };
  const container = new FakeElement("div");
  const api = async () => ({ annotations: [], git_head: null });
  createHumanAnnotationPanel(container, { api, node, navigateTo: () => {} });
  const form = created.find((item) => item.tagName === "FORM");
  const selects = created.filter((item) => item.tagName === "SELECT");
  // Creation order in human-annotations-ui.mjs: task, kind, event, decision.
  const kindSelect = selects[1];
  const sections = new Map(
    created
      .filter((item) => item.dataset.kind)
      .map((section) => [section.dataset.kind, section]),
  );
  assert.equal(sections.size, 3);
  return { form, kindSelect, sections };
}

function disabledByKind(sections, kind) {
  return sections
    .get(kind)
    .querySelectorAll("input, select, textarea")
    .map((control) => control.disabled);
}

test("hidden annotation target fields stay out of constraint validation", () => {
  const { kindSelect, sections } = harness();
  for (const kind of ["event", "decision", "diff"]) {
    kindSelect.value = kind;
    kindSelect.emit("change");
    const active = sections.get(kind);
    assert.equal(active.hidden, false, kind + " section should be visible");
    for (const control of active.querySelectorAll("input, select, textarea"))
      assert.equal(control.disabled, false, kind + " visible control enabled");
    for (const other of ["event", "decision", "diff"]) {
      if (other === kind) continue;
      const hidden = sections.get(other);
      assert.equal(hidden.hidden, true, other + " section should be hidden");
      const controls = hidden.querySelectorAll("input, select, textarea");
      assert.ok(controls.length > 0, other + " has form controls");
      for (const control of controls)
        assert.equal(
          control.disabled,
          true,
          other + " hidden control must be disabled",
        );
    }
  }
  // Required markers stay for the visible kind; disabled keeps hidden ones out.
  const eventControls = sections.get("event").querySelectorAll("input, select, textarea");
  const decisionControls = sections.get("decision").querySelectorAll("input, select, textarea");
  const diffControls = sections.get("diff").querySelectorAll("input, select, textarea");
  assert.ok(eventControls.some((control) => control.required));
  assert.ok(decisionControls.some((control) => control.required));
  assert.ok(diffControls.some((control) => control.required));
  kindSelect.value = "event";
  kindSelect.emit("change");
  assert.deepEqual(disabledByKind(sections, "event"), [false, false]);
});
