import test from "node:test";
import assert from "node:assert/strict";
import { createTimelinePanel } from "../causal-timeline-ui.mjs";

class FakeNode {
  constructor(tagName, textContent = "", className = "") {
    this.tagName = tagName;
    this.textContent = textContent;
    this.className = className;
    this.children = [];
    this.dataset = {};
    this.style = {};
    this.listeners = new Map();
    this.parent = null;
    this.hidden = false;
    this.open = false;
    this.disabled = false;
    this.type = "";
    this.connectedRoot = false;
  }

  get childElementCount() {
    return this.children.length;
  }

  get isConnected() {
    let current = this;
    while (current.parent) current = current.parent;
    return current.connectedRoot;
  }

  append(...nodes) {
    for (const child of nodes) {
      if (child.parent) {
        child.parent.children = child.parent.children.filter(
          (item) => item !== child,
        );
      }
      child.parent = this;
      this.children.push(child);
    }
  }

  replaceChildren(...nodes) {
    for (const child of this.children) child.parent = null;
    this.children = [];
    this.append(...nodes);
  }

  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }

  click() {
    this.listeners.get("click")?.({ target: this });
  }

  querySelectorAll(selector) {
    assert.equal(selector, "details[open]");
    const found = [];
    const visit = (item) => {
      for (const child of item.children) {
        if (child.tagName === "details" && child.open) found.push(child);
        visit(child);
      }
    };
    visit(this);
    return found;
  }
}

function descendants(root) {
  const result = [];
  const visit = (item) => {
    result.push(item);
    for (const child of item.children) visit(child);
  };
  visit(root);
  return result;
}

const renderText = (item) =>
  [item.textContent, ...item.children.map(renderText)].filter(Boolean).join(" ");
const makeNode = (tag, text = "", className = "") =>
  new FakeNode(tag, text, className);

function summaryTrace(traceId, issues = []) {
  return {
    trace_id: traceId,
    title: `Trace ${traceId}`,
    context: null,
    stages: [{ stage: "test", count: 1, unknown: 0 }],
    issues,
  };
}

function summaryReport(revision, firstIssues = []) {
  return {
    notice: `summary revision ${revision}`,
    state_revision: revision,
    history_revision: revision,
    after: 0,
    next: null,
    total: 2,
    traces: [summaryTrace("A", firstIssues), summaryTrace("B")],
  };
}

function detailReport(traceId, status, revision) {
  return {
    notice: `detail revision ${revision}`,
    state_revision: revision,
    traces: [
      {
        ...summaryTrace(traceId),
        links: [],
        nodes: [
          {
            id: `${traceId}-test`,
            stage: "test",
            status,
            source_id: `${traceId}-source`,
            raw: { status },
          },
        ],
      },
    ],
  };
}

test("refreshes every open trace detail and sequences requests per trace", async () => {
  const summaries = [summaryReport(1), summaryReport(2, [{ message: "A changed" }])];
  const detailCalls = { A: 0, B: 0 };
  let summaryCalls = 0,
    resolveSecondA,
    resolveThirdA;
  const api = (url) => {
    if (url.startsWith("timeline?after="))
      return Promise.resolve(summaries[summaryCalls++]);
    const traceId = new URLSearchParams(url.split("?")[1]).get("trace_id");
    detailCalls[traceId] += 1;
    if (traceId === "A" && detailCalls.A === 2)
      return new Promise((resolve) => (resolveSecondA = resolve));
    if (traceId === "A" && detailCalls.A === 3)
      return new Promise((resolve) => (resolveThirdA = resolve));
    const status = traceId === "A" && detailCalls.A >= 4 ? "invalidated" : "current_full_pass";
    return Promise.resolve(detailReport(traceId, status, detailCalls[traceId]));
  };
  const element = makeNode("div");
  element.connectedRoot = true;
  const panel = createTimelinePanel(element, { api, node: makeNode });
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  const traceView = (traceId) =>
    descendants(element).find((item) => item.dataset.timelineTrace === traceId);
  const detailsTarget = (view) => view.children.find((item) => item.tagName === "div");
  const openButton = (view) => view.children.find((item) => item.tagName === "button");

  await panel.refresh();
  openButton(traceView("A")).click();
  await settle();
  openButton(traceView("B")).click();
  await settle();
  assert.match(renderText(detailsTarget(traceView("A"))), /現行の全体試験成功/);
  assert.match(renderText(detailsTarget(traceView("B"))), /現行の全体試験成功/);

  await panel.refresh();
  await settle();
  assert.equal(detailCalls.A, 2, "A must be fetched again while its detail stays open");
  assert.equal(detailCalls.B, 2, "B must also be refreshed");

  resolveSecondA(detailReport("A", "recorded_revision", 2));
  await settle();
  assert.match(
    renderText(detailsTarget(traceView("A"))),
    /回答時の質問revision/,
    "B's response must not invalidate A's independent refresh",
  );

  openButton(traceView("A")).click();
  await settle();
  openButton(traceView("A")).click();
  await settle();
  assert.match(renderText(detailsTarget(traceView("A"))), /旧revision/);
  resolveThirdA(detailReport("A", "current_full_pass", 3));
  await settle();
  assert.match(
    renderText(detailsTarget(traceView("A"))),
    /旧revision/,
    "the stale response for A must not replace the newer A detail",
  );
  assert.match(renderText(detailsTarget(traceView("B"))), /現行の全体試験成功/);
});
