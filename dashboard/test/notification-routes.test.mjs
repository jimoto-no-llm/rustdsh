import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { identity, ProjectStore } from "../state.mjs";
import { RunHistory } from "../run-history.mjs";
import { startDashboard } from "../server.mjs";

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test("browser notification read state and settings persist while MCP cannot read or change them", async (t) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "rdsh-notification-route-test-"));
  const previousHome = process.env.RDSH_DASHBOARD_HOME;
  process.env.RDSH_DASHBOARD_HOME = path.join(temporary, "state");
  let dashboard;
  t.after(async () => {
    await dashboard?.close();
    if (previousHome === undefined) delete process.env.RDSH_DASHBOARD_HOME;
    else process.env.RDSH_DASHBOARD_HOME = previousHome;
    assert.equal(path.dirname(path.resolve(temporary)), path.resolve(os.tmpdir()));
    assert(path.basename(temporary).startsWith("rdsh-notification-route-test-"));
    await fs.rm(temporary, { recursive: true, force: true });
  });

  const root = path.join(temporary, "project");
  await fs.mkdir(root);
  const project = await identity(root);
  const store = await ProjectStore.open(project);
  for (let index = 0; index < 25; index++)
    await store.mutate("event", { type: "progress", title: `Routine update ${index}` });
  await store.mutate("task", {
    id: "task-blocked",
    title: "Waiting on review",
    status: "blocked",
    blocker: "Needs a decision",
  });
  const history = await RunHistory.open(project);
  const failedRun = "run_00000000-0000-0000-0000-000000000074";
  await history.register(failedRun);
  await history.transition(failedRun, "failed", "failure_confirmed");
  await store.mutate("question", {
    id: "question-1",
    question: "Which option should we use?",
    urgency: "critical",
  });
  await store.mutate("task", {
    id: "task-1",
    title: "Waiting on review",
    status: "blocked",
    blocker: "Needs a decision",
  });

  const start = async () =>
    await startDashboard({ project, port: await freePort(), tailscale: false });
  dashboard = await start();
  const runtimeFile = path.join(project.directory, "runtime.json");
  let runtime = JSON.parse(await fs.readFile(runtimeFile, "utf8"));
  const browserHeaders = {
    "x-rdsh-browser-token": new URL(runtime.browser_url).hash.slice("#key=".length),
  };
  const mcpHeaders = { authorization: `Bearer ${runtime.mcp_token}` };
  assert.equal((await fetch(dashboard.localUrl + "notifications-ui.mjs")).status, 200);
  const browserState = async () =>
    await (await fetch(dashboard.localUrl + "api/state", { headers: browserHeaders })).json();
  let state = await browserState();
  assert.equal(state.notifications.items[0].kind, "question");
  assert.equal(state.notifications.filtered_count, 1);
  assert.equal(state.notifications.items.some((item) => item.target.id === failedRun), true);
  const laterFailedRun = "run_00000000-0000-0000-0000-000000000075";
  await history.register(laterFailedRun);
  await history.transition(laterFailedRun, "failed", "failure_confirmed");
  state = await browserState();
  assert.equal(state.notifications.items.some((item) => item.target.id === laterFailedRun), true);
  const blocked = state.notifications.items.find((item) => item.target.id === "task-blocked");
  const readBlocked = await fetch(dashboard.localUrl + "api/notifications/read", {
    method: "POST",
    headers: { ...browserHeaders, "content-type": "application/json" },
    body: JSON.stringify({ id: blocked.id, event_id: blocked.event_id }),
  });
  assert.equal(readBlocked.status, 200);
  const changedCause = await fetch(dashboard.localUrl + "api/update/task", {
    method: "POST",
    headers: { ...mcpHeaders, "content-type": "application/json" },
    body: JSON.stringify({
      id: "task-blocked",
      title: "Waiting on review",
      status: "blocked",
      blocker: "Different dependency",
    }),
  });
  assert.equal(changedCause.status, 200);
  state = await browserState();
  const updatedBlocked = state.notifications.items.find((item) => item.id === blocked.id);
  assert.equal(updatedBlocked.unread, true);
  assert.notEqual(updatedBlocked.event_id, blocked.event_id);
  assert.equal("notifications" in (await (await fetch(dashboard.localUrl + "api/state", { headers: mcpHeaders })).json()), false);

  const question = state.notifications.items.find((item) => item.kind === "question");
  const read = await fetch(dashboard.localUrl + "api/notifications/read", {
    method: "POST",
    headers: { ...browserHeaders, "content-type": "application/json" },
    body: JSON.stringify({ id: question.id, event_id: question.event_id }),
  });
  assert.equal(read.status, 200);
  state = await browserState();
  assert.equal(state.notifications.items.find((item) => item.kind === "question").unread, false);
  assert.equal(state.notifications.items.some((item) => item.target.id === failedRun), true);

  const denied = await fetch(dashboard.localUrl + "api/notifications/preferences", {
    method: "POST",
    headers: { ...mcpHeaders, "content-type": "application/json" },
    body: JSON.stringify({ minimum_importance: "critical", quiet_hours: null }),
  });
  assert.equal(denied.status, 401);
  const adminDenied = await fetch(dashboard.localUrl + "api/notifications/preferences", {
    method: "POST",
    headers: {
      authorization: `Bearer ${runtime.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ minimum_importance: "critical", quiet_hours: null }),
  });
  assert.equal(adminDenied.status, 403);
  const saved = await fetch(dashboard.localUrl + "api/notifications/preferences", {
    method: "POST",
    headers: { ...browserHeaders, "content-type": "application/json" },
    body: JSON.stringify({ minimum_importance: "high", quiet_hours: null }),
  });
  assert.equal(saved.status, 200);

  await dashboard.close();
  dashboard = null;
  dashboard = await start();
  runtime = JSON.parse(await fs.readFile(runtimeFile, "utf8"));
  browserHeaders["x-rdsh-browser-token"] = new URL(runtime.browser_url).hash.slice("#key=".length);
  state = await browserState();
  assert.equal(state.notifications.preferences.minimum_importance, "high");
  assert.equal(state.notifications.items.find((item) => item.kind === "question").unread, false);
  assert.equal(state.notifications.filtered_count, 1);
});
