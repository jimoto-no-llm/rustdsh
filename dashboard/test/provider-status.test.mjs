import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {
  normalizeProviderStatus,
  providerStatusView,
} from "../provider-status.mjs";
import { renderProviderStatuses } from "../provider-status-ui.mjs";
import { identity, ProjectStore, publicState } from "../state.mjs";
import { startDashboard } from "../server.mjs";
import { executeTool, tools } from "../mcp.mjs";

const report = (overrides = {}) => ({
  provider_id: "codex",
  scope_id: "team:primary",
  status: "rate_limited",
  kind: "measured",
  event_id: "event-1",
  sequence: 1,
  quota: { remaining: 0, limit: 1000, unit: "tokens" },
  retry_after: new Date(Date.now() + 30 * 60_000).toISOString(),
  observed_at: new Date(Date.now() - 1000).toISOString(),
  source: "provider.response",
  reference: "request-123",
  max_age_seconds: 60,
  ...overrides,
});

function fakeNode(tag, text, className) {
  return {
    tag,
    textContent: text ?? "",
    className: className ?? "",
    children: [],
    append(...children) { this.children.push(...children); },
  };
}

function allText(element) {
  return [element.textContent, ...element.children.flatMap((child) => allText(child))]
    .filter(Boolean)
    .join(" ");
}

test("provider statuses preserve only bounded source data and expire from observation time", () => {
  const now = Date.now();
  const value = normalizeProviderStatus(report({
    observed_at: new Date(now - 1000).toISOString(),
    retry_after: new Date(now + 30 * 60_000).toISOString(),
  }), { now });
  assert.equal(value.provider_id, "codex");
  assert.equal(value.reference, "request-123");
  assert.equal(value.recorded_at, new Date(now).toISOString());

  const current = providerStatusView(value, now);
  assert.equal(current.freshness, "fresh");
  assert.match(current.retryMessage, /providerが示した再試行時刻/);
  assert.match(current.nextAction, /自動再試行は行いません/);

  const stale = providerStatusView(value, Date.parse(value.observed_at) + 60_000);
  assert.equal(stale.freshness, "stale");
  assert.equal(stale.retryMessage, "期限切れの再試行情報は表示しません。");
  assert.match(stale.nextAction, /現在の状態は未確認/);
});

test("provider status requires explicit retry evidence and keeps quota/auth guidance separate", () => {
  const now = Date.now();
  const pastRetry = normalizeProviderStatus(report({
    status: "quota_exhausted",
    quota: { remaining: 0, limit: 100, unit: "requests" },
    retry_after: new Date(now - 500).toISOString(),
    observed_at: new Date(now - 1000).toISOString(),
  }), { now });
  assert.match(providerStatusView(pastRetry, now).retryMessage, /利用可能とは確認されていません/);
  assert.match(providerStatusView(pastRetry, now).nextAction, /再ログインは必要と判断できません/);

  const auth = normalizeProviderStatus(report({
    status: "authentication_failed",
    quota: undefined,
    retry_after: undefined,
  }), { now });
  assert.match(providerStatusView(auth, now).nextAction, /手動で確認/);
  assert.match(providerStatusView(auth, now).nextAction, /自動再ログインは行いません/);
  assert.equal(auth.retry_after, null);

  assert.throws(() => normalizeProviderStatus(report({
    status: "authentication_failed",
    retry_after: new Date(now + 1000).toISOString(),
  }), { now }), /Only rate limits/);
  assert.throws(() => normalizeProviderStatus(report({
    status: "quota_exhausted",
    quota: { remaining: 10, limit: 100, unit: "requests" },
  }), { now }), /cannot report remaining/);
  assert.throws(() => normalizeProviderStatus(report({
    quota: { remaining: 12, limit: 10, unit: "requests" },
  }), { now }), /exceeds its limit/);
});

test("all provider status fixtures have distinct guidance and never invent retry times", () => {
  const now = Date.now();
  const fixtures = [
    ["rate_limited", "利用制限", /自動再試行は行いません/],
    ["quota_exhausted", "利用枠不足", /再ログインは必要と判断できません/],
    ["authentication_failed", "認証失敗", /認証状態を手動で確認/],
    ["unknown", "理由不明", /新しいprovider観測を待ちます/],
  ];
  for (const [status, label, nextAction] of fixtures) {
    const value = normalizeProviderStatus(report({
      status,
      quota: null,
      retry_after: null,
      observed_at: new Date(now - 1000).toISOString(),
    }), { now });
    const view = providerStatusView(value, now);
    assert.equal(view.label, label);
    assert.match(view.nextAction, nextAction);
    assert.equal(view.retryMessage, "再試行時刻は提供されていません。");
  }
});

test("provider status rejects inferred times, unsafe source labels, unknown fields and future observations", () => {
  const now = Date.now();
  assert.throws(() => normalizeProviderStatus(report({
    source: "Bearer secret-value",
  }), { now }), /source/);
  assert.throws(() => normalizeProviderStatus(report({
    observed_at: new Date(now + 60_000).toISOString(),
  }), { now }), /future/);
  assert.throws(() => normalizeProviderStatus({
    ...report(),
    error_message: "raw provider response",
  }), /Unknown provider status field/);
  assert.throws(() => normalizeProviderStatus(report({
    retry_after: new Date(now - 10_000).toISOString(),
  }), { now }), /must follow the observation/);
  assert.throws(() => normalizeProviderStatus(report({
    max_age_seconds: 0,
  }), { now }), /max_age_seconds/);
});

test("provider status records are scope-isolated, ordered and durable", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rdsh-provider-status-"));
  const projectRoot = path.join(root, "project");
  await fs.mkdir(projectRoot);
  const project = await identity(projectRoot);
  project.directory = path.join(root, "state", "projects", project.id);
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("rdsh-provider-status-"));
    await fs.rm(root, { recursive: true });
  });

  const store = await ProjectStore.open(project);
  const firstTime = Date.now() - 3000;
  await store.mutate("provider_status", report({
    observed_at: new Date(firstTime).toISOString(),
  }));
  await store.mutate("provider_status", report({
    scope_id: "team:secondary",
    observed_at: new Date(firstTime).toISOString(),
  }));
  await store.mutate("provider_status", report({
    status: "quota_exhausted",
    event_id: "event-2",
    sequence: 2,
    quota: { remaining: 0, limit: 1000, unit: "tokens" },
    observed_at: new Date(firstTime + 1000).toISOString(),
  }));
  assert.equal(store.value.provider_statuses.length, 2);
  assert.equal(store.value.provider_statuses[0].sequence, 2);
  assert.equal(store.value.provider_statuses[1].scope_id, "team:secondary");

  await assert.rejects(
    store.mutate("provider_status", report({ sequence: 2, event_id: "event-3" })),
    /sequence must increase/,
  );
  await assert.rejects(
    store.mutate("provider_status", report({
      sequence: 3,
      event_id: "event-3",
      observed_at: new Date(firstTime).toISOString(),
    })),
    /cannot move backwards/,
  );
  const reopened = await ProjectStore.open(project);
  assert.deepEqual(publicState(reopened.value).provider_statuses, store.value.provider_statuses);
});

test("older project state exposes an empty provider status list", () => {
  assert.deepEqual(publicState({ metrics: {}, tasks: [], questions: [], events: [], feedback: [] }).provider_statuses, []);
});

test("MCP reporting stores a status without calling login, refresh or retry APIs", async () => {
  const calls = [];
  const api = {
    async mutate(...args) {
      calls.push(args);
      return { project: { id: "project-a" }, revision: 4 };
    },
    async getState() { return {}; },
  };
  const tool = tools.find((item) => item.name === "dashboard_report_provider_status");
  assert.ok(tool);
  assert.equal(tool.inputSchema.additionalProperties, false);
  const payload = report();
  const result = await executeTool(api, tool.name, payload);
  assert.deepEqual(calls, [["provider_status", payload]]);
  assert.deepEqual(result, { project: "project-a", revision: 4 });
});

test("provider status UI renders report values as text and exposes no action controls", () => {
  const container = {
    children: [],
    replaceChildren(...children) { this.children = children; },
  };
  const value = normalizeProviderStatus(report());
  renderProviderStatuses(container, [value], fakeNode, Date.now());
  assert.equal(container.children.length, 1);
  const text = allText(container.children[0]);
  assert.match(text, /codex · team:primary/);
  assert.match(text, /provider.response/);
  assert.match(text, /自動再試行は行いません/);
  assert.equal(container.children[0].children.some((child) => child.tag === "button"), false);
  assert.equal(Object.hasOwn(container.children[0], "innerHTML"), false);

  renderProviderStatuses(container, [], fakeNode);
  assert.match(allText(container.children[0]), /まだ報告されていません/);
});

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test("provider status HTTP report is MCP-authenticated, project-local and read-only for browsers", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rdsh-provider-http-"));
  const projectRoot = path.join(root, "project");
  await fs.mkdir(projectRoot);
  const project = await identity(projectRoot);
  project.directory = path.join(root, "state", "projects", project.id);
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("rdsh-provider-http-"));
    await fs.rm(root, { recursive: true });
  });
  const dashboard = await startDashboard({ project, port: await freePort(), tailscale: false });
  t.after(() => dashboard.close());
  const runtime = JSON.parse(await fs.readFile(path.join(project.directory, "runtime.json"), "utf8"));
  const body = JSON.stringify(report());
  const mcpHeaders = {
    authorization: `Bearer ${runtime.mcp_token}`,
    "content-type": "application/json",
  };
  const saved = await fetch(dashboard.localUrl + "api/update/provider_status", {
    method: "POST",
    headers: mcpHeaders,
    body,
  });
  assert.equal(saved.status, 200, await saved.text());
  const state = await fetch(dashboard.localUrl + "api/state", { headers: mcpHeaders });
  assert.equal(state.status, 200);
  assert.equal((await state.json()).provider_statuses[0].status, "rate_limited");

  const browserToken = new URL(runtime.browser_url).hash.slice("#key=".length);
  const browserWrite = await fetch(dashboard.localUrl + "api/update/provider_status", {
    method: "POST",
    headers: { "x-rdsh-browser-token": browserToken, "content-type": "application/json" },
    body: JSON.stringify(report({ event_id: "event-2", sequence: 2 })),
  });
  assert.equal(browserWrite.status, 403);
  const moduleAsset = await fetch(dashboard.localUrl + "provider-status-ui.mjs");
  assert.equal(moduleAsset.status, 200);
  assert.match(moduleAsset.headers.get("content-type"), /javascript/);
});
