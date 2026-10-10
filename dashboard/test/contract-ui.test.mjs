import test from "node:test";
import assert from "node:assert/strict";
import { renderTaskContract, renderOperations } from "../contract-view.mjs";

test("contracts and approval scopes render as literal text; human choices bind request version", async () => {
  class Element {
    constructor(tag) {
      this.tag = tag;
      this.children = [];
      this.dataset = {};
      this.style = {};
      this.textContent = "";
    }
    set innerHTML(_value) { throw new Error("Contract content must use textContent"); }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    setAttribute() {}
    addEventListener(event, listener) { (this.listeners ||= {})[event] = listener; }
    querySelectorAll() { return []; }
  }
  const elements = new Map();
  const document = {
    addEventListener() {},
    createElement: (tag) => new Element(tag),
    getElementById: (id) => {
      if (!elements.has(id)) elements.set(id, new Element("div"));
      return elements.get(id);
    },
  };
  const unsafe = '<img src=x onerror="forged approval">';
  const version = {
    version: 1, changed_at: "2026-10-05T00:00:00Z", purpose: unsafe,
    repository: "/fixture", allowed_scope: "Source only", write_roots: ["/fixture/src"],
    forbidden_actions: ["No publication"], completion_conditions: ["Tests pass"],
    change_reason: "Initial contract",
  };
  const state = {
    metrics: {}, tasks: [{ id: "T1", title: "Test", status: "todo", blocker: "" }, { id: "T2", title: "Legacy task", status: "todo", blocker: "" }],
    questions: [], events: [], updated_at: null,
    contracts: [{ task_id: "T1", versions: [version, { ...version, version: 2, write_roots: [], change_reason: "Read only" }] }],
    approval_requests: [{ id: "R1", versions: [{
      version: 3, status: "pending", task_id: "T1", contract_version: 2,
      run_id: "run-ui", command_id: "command-ui", attributes: { tool: "file.write", path: "/fixture/src/new.txt" },
      operation_digest: "fixture-digest", limits: { max_cost_usd: 2, max_attempts: 1 },
      expires_at: "2026-10-06T00:00:00.000Z", source_ref: unsafe, uses: [], reserved_cost_microusd: 0,
    }] }],
  };
  const previousApproval = structuredClone(state.approval_requests[0].versions[0]);
  previousApproval.version = 2;
  previousApproval.status = "revoked";
  previousApproval.decisions = [{ decision: "revoke", approver: "dashboard_owner", authenticated_by: "human_browser_credential", decided_at: "fixture-time" }];
  previousApproval.uses = [{ attempt: 1, reserved_cost_microusd: 500000, execution: "not_started", claimed_at: "fixture-time" }];
  previousApproval.reserved_cost_microusd = 500000;
  state.approval_requests[0].versions.unshift(previousApproval);
  const decisions = [];
  const node = (tag, text, className) => {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    if (className) element.className = className;
    return element;
  };
  const render = () => {
    elements.get("tasks").replaceChildren(...state.tasks.map((task) => renderTaskContract(task, state, node)));
    renderOperations(state, document.getElementById("policy-checks"), document.getElementById("approvals"), {
      node,
      api: async (route, decision) => {
        assert.equal(route, "approvals/decide");
        decisions.push(decision);
        state.approval_requests[0].versions.at(-1).status = decision.decision === "grant" ? "granted" : "revoked";
      },
      refreshState: async () => render(),
    });
  };
  document.getElementById("tasks");
  render();
  const descendants = (element) => [element, ...element.children.flatMap(descendants)];
  const nodes = descendants(elements.get("tasks"));
  const labels = nodes.map((node) => node.textContent);
  assert.ok(labels.includes("タスク契約 v2"));
  assert.ok(labels.includes("タスク契約 未設定"));
  assert.ok(labels.some((label) => label.startsWith("v1 ・")));
  assert.ok(labels.some((label) => label.startsWith("v2 ・")));
  assert.ok(labels.includes("目的: " + unsafe));
  assert.ok(labels.includes("書込先: 書込不可"));
  assert.ok(labels.includes("終了条件: Tests pass"));
  assert.ok(labels.includes("変更理由: Read only"));
  assert.ok(nodes.every((node) => node.tag !== "img" && node.tag !== "script"));
  let approvals = descendants(elements.get("approvals"));
  assert.ok(approvals.some((node) => node.textContent === "元要求: " + unsafe));
  assert.ok(approvals.some((node) => node.textContent === "run / command: run-ui / command-ui"));
  assert.ok(approvals.every((node) => node.tag !== "img" && node.tag !== "script"));
  assert.ok(approvals.some((node) => node.textContent === "過去の要求（1版）"));
  assert.ok(approvals.some((node) => node.textContent === "v2: revoked（現在の操作には適用不可）"));
  assert.ok(approvals.some((node) => node.textContent.includes("判断: revoke / dashboard_owner / human_browser_credential / fixture-time")));
  assert.ok(approvals.some((node) => node.textContent.includes("実行: attempt 1 / $0.5 / not_started")));
  assert.equal(approvals.filter((node) => node.tag === "button").length, 2);
  await approvals.find((node) => node.tag === "button" && node.textContent === "この操作範囲を承認").listeners.click();
  assert.deepEqual(decisions, [{ id: "R1", request_version: 3, decision: "grant" }]);
  approvals = descendants(elements.get("approvals"));
  await approvals.find((node) => node.tag === "button" && node.textContent === "承認を取り消す").listeners.click();
  assert.deepEqual(decisions[1], { id: "R1", request_version: 3, decision: "revoke" });
});
