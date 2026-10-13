import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { identity, ProjectStore } from "../state.mjs";
import { startDashboard } from "../server.mjs";

async function freePort() {
  const socket = net.createServer();
  await new Promise((resolve) => socket.listen(0, "127.0.0.1", resolve));
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  return port;
}

test("an agent presents UI and the human action returns to the same session", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rdsh-ui-roundtrip-"));
  const previousHome = process.env.RDSH_DASHBOARD_HOME;
  process.env.RDSH_DASHBOARD_HOME = path.join(root, "state");
  t.after(async () => {
    if (previousHome) process.env.RDSH_DASHBOARD_HOME = previousHome;
    else delete process.env.RDSH_DASHBOARD_HOME;
    await fs.rm(root, { recursive: true, force: true });
  });
  const cwd = path.join(root, "project");
  await fs.mkdir(cwd);
  const project = await identity(cwd);
  project.directory = path.join(root, "dashboard", "projects", project.id);
  await ProjectStore.open(project);
  const dashboard = await startDashboard({ project, port: await freePort(), tailscale: false });
  t.after(() => dashboard.close());
  const runtime = JSON.parse(await fs.readFile(path.join(project.directory, "runtime.json"), "utf8"));
  const browserToken = new URL(runtime.browser_url).hash.replace(/^#key=/, "");
  const browserHeaders = { "x-rdsh-browser-token": browserToken, "content-type": "application/json" };
  const client = new Client({ name: "ui-roundtrip", version: "1.0.0" }, { capabilities: {} });
  await client.connect(new StreamableHTTPClientTransport(new URL(dashboard.localUrl + "mcp"), {
    requestInit: { headers: { authorization: "Bearer " + runtime.mcp_token } },
  }));
  t.after(() => client.close());
  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    assert.notEqual(result.isError, true, result.content[0] && result.content[0].text);
    return JSON.parse(result.content[0].text);
  };
  const names = (await client.listTools()).tools.map((tool) => tool.name);
  assert.ok(names.includes("dashboard_present_ui"), names.join(","));

  const presented = await call("dashboard_present_ui", {
    message_id: "turn-7",
    blocks: [
      { id: "results", kind: "dev.test-results", data: { suite: "cargo test", cases: [
        { name: "a", status: "pass" }, { name: "b", status: "fail" }, { name: "c", status: "hold" },
      ] } },
      { id: "chart", kind: "chart.bar", data: { bars: [
        { label: "成功", value: 12 }, { label: "失敗", value: 8 }, { label: "保留", value: null },
      ], unit: "件" } },
      { id: "next", kind: "choice", data: { prompt: "次に行う操作", choices: [
        { id: "fix", label: "失敗した8件を分析して修正する" },
        { id: "log", label: "失敗ログを詳しく表示する" },
        { id: "stop", label: "修正せず結果をまとめる" },
      ] } },
    ],
  });
  assert.match(presented.surface_id, /^srf_/);
  assert.equal(presented.revision, 1);
  assert.equal(presented.fallback.length, 0);
  const action = presented.actions.find((item) => item.kind === "submit_choice");
  assert.ok(action, JSON.stringify(presented.actions));

  const seen = await (await fetch(dashboard.localUrl + "api/state", { headers: browserHeaders })).json();
  assert.equal(seen.ui_surfaces.current.surface_id, presented.surface_id);
  assert.equal(seen.ui_surfaces.current.blocks.length, 3);

  const anonymous = await fetch(dashboard.localUrl + "api/ui/actions", {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}",
  });
  assert.ok([401, 403].includes(anonymous.status), String(anonymous.status));

  const body = {
    surface_id: presented.surface_id, surface_revision: presented.revision,
    block_id: action.block_id, action_id: action.action_id,
    value: { choice_id: "fix" }, action_request_id: "act-1",
  };
  const accepted = await (await fetch(dashboard.localUrl + "api/ui/actions", {
    method: "POST", headers: browserHeaders, body: JSON.stringify(body),
  })).json();
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.delivered_to_session, true);
  assert.equal(accepted.execution_authorized, false);
  assert.equal(accepted.handling, "session");

  const feedback = await call("dashboard_get_feedback", { after: 0 });
  const message = feedback.messages.find((item) => item.type === "ui_action");
  assert.ok(message, JSON.stringify(feedback.messages));
  assert.equal(message.value.choice_id, "fix");
  assert.equal(message.surface_id, presented.surface_id);
  assert.equal(message.execution_authorized, false);

  const second = await fetch(dashboard.localUrl + "api/ui/actions", {
    method: "POST", headers: browserHeaders,
    body: JSON.stringify(Object.assign({}, body, { action_request_id: "act-2" })),
  });
  assert.equal(second.status, 409);
  const replay = await (await fetch(dashboard.localUrl + "api/ui/actions", {
    method: "POST", headers: browserHeaders, body: JSON.stringify(body),
  })).json();
  assert.equal(replay.replayed, true);
  const stale = await fetch(dashboard.localUrl + "api/ui/actions", {
    method: "POST", headers: browserHeaders,
    body: JSON.stringify(Object.assign({}, body, { surface_revision: presented.revision + 5, action_request_id: "act-3" })),
  });
  assert.equal(stale.status, 409);

  const updated = await call("dashboard_present_ui", {
    message_id: "turn-8", surface_id: presented.surface_id,
    blocks: [{ id: "note", kind: "callout", data: { text: "選択を受け取りました", tone: "info" } }],
  });
  assert.equal(updated.surface_id, presented.surface_id);
  assert.equal(updated.revision, 2);
  const after = await call("dashboard_get_state", {});
  assert.equal(after.ui_surfaces.current.blocks.length, 1);
});
