import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ProjectStore, applyOperation } from "../state.mjs";
import { inspectTaskOutcomes } from "../task-outcomes-view.mjs";
import { startDashboard } from "../server.mjs";
import { tools } from "../mcp.mjs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createOutcomeProject } from "./fixtures/task-outcomes-project.mjs";

async function setup(t) {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "rdsh-outcomes-test-"),
  );
  t.after(async () => {
    assert.equal(
      path.dirname(path.resolve(directory)),
      path.resolve(os.tmpdir()),
    );
    assert.ok(path.basename(directory).startsWith("rdsh-outcomes-test-"));
    await fs.rm(directory, { recursive: true });
  });
  return createOutcomeProject(directory);
}
const taskView = (f) =>
  inspectTaskOutcomes(f.project, f.state.value, { task_id: "goal" });
const milestoneView = (f) =>
  inspectTaskOutcomes(f.project, f.state.value, { milestone_id: "M1" });

test("existing HTTP MCP task publication accepts outcome metadata without adding tools", async (t) => {
  const f = await setup(t);
  const dashboard = await startDashboard({
    project: f.project,
    port: 0,
    tailscale: false,
  });
  t.after(() => dashboard.close());
  const runtime = JSON.parse(
    await fs.readFile(path.join(f.project.directory, "runtime.json"), "utf8"),
  );
  const client = new Client(
    { name: "outcome-fixture", version: "1.0.0" },
    { capabilities: {} },
  );
  t.after(() => client.close());
  await client.connect(
    new StreamableHTTPClientTransport(new URL(dashboard.localUrl + "mcp"), {
      requestInit: {
        headers: { authorization: `Bearer ${runtime.mcp_token}` },
      },
    }),
  );
  const advertised = (await client.listTools()).tools;
  assert.equal(advertised.length, 6);
  assert.ok(
    advertised.find((tool) => tool.name === "dashboard_upsert_task").inputSchema
      .properties.outcome,
  );
  const result = await client.callTool({
    name: "dashboard_upsert_task",
    arguments: {
      id: "mcp-child",
      title: "Published through MCP",
      status: "done",
      milestone: "M1",
      outcome: {
        purpose: "親の成果を分担する",
        owner: "MCP担当",
        latest_outcome: "提出した差分",
        next_step: "親の受入条件を確認",
        acceptance_task_id: "goal",
      },
      milestone_contract: f.contract,
    },
  });
  assert.notEqual(result.isError, true, result.content[0]?.text);
  const report = dashboard.store.value.task_outcomes.tasks.find(
    (item) => item.task_id === "mcp-child",
  );
  assert.equal(report.owner, "MCP担当");
  assert.equal(report.acceptance_task_id, "goal");
  assert.equal(dashboard.store.value.schema, 1);
});

test("legacy task shape retains observation metadata and omitted outcome fields retain earlier reports", async (t) => {
  const f = await setup(t);
  assert.deepEqual(Object.keys(f.state.value.tasks[0]).sort(), [
    "blocker",
    "id",
    "milestone",
    "observation",
    "status",
    "title",
    "updated_at",
  ]);
  assert.equal(f.state.value.tasks[0].observation.kind, "agent_reported");
  assert.equal(f.state.value.tasks[0].observation.reference, "goal");
  await f.state.mutate("task", {
    id: "goal",
    title: "Updated title",
    status: "doing",
    outcome: { next_step: "修正を続ける", owner: null },
  });
  await f.state.mutate("task", {
    id: "goal",
    title: "Legacy caller",
    status: "done",
  });
  const reopened = await ProjectStore.open(f.project);
  assert.equal(reopened.value.schema, 1);
  assert.equal(
    reopened.value.task_outcomes.tasks[0].latest_outcome,
    "修正を提出しました",
  );
  assert.equal(reopened.value.task_outcomes.tasks[0].next_step, "修正を続ける");
  assert.equal(reopened.value.task_outcomes.tasks[0].owner, null);
  const legacy = { tasks: [] };
  applyOperation(legacy, "task", {
    id: "old",
    title: "Legacy only",
    status: "done",
  });
  assert.equal(Object.hasOwn(legacy, "task_outcomes"), false);
  assert.equal(tools.length, 6);
});
test("reported done and partial or operator-reported passes never imply a verified full check", async (t) => {
  const f = await setup(t);
  assert.equal((await taskView(f)).reported_done_with_verified_checks, false);
  await f.run("value", "partial");
  await f.acceptance.perform({
    task_id: "goal",
    criterion_id: "shape",
    scope: "full",
    reported: { status: "pass", reason: "Declared by an operator" },
  });
  const view = await taskView(f);
  assert.equal(view.reported_status, "done");
  assert.equal(view.status, "unverified");
  assert.ok(view.conditions.every((item) => !item.verified));
  assert.equal((await milestoneView(f)).verified_count, 0);
});
test("fixed criterion references preserve achieved progress when tasks are split or added", async (t) => {
  const f = await setup(t);
  await f.run("value");
  const before = await milestoneView(f);
  assert.equal(before.verified_count, 1);
  assert.equal(before.condition_count, 2);
  for (const id of ["split-a", "split-b", "unrelated"])
    await f.state.mutate("task", {
      id,
      title: id,
      status: "done",
      milestone: "M1",
      outcome: { acceptance_task_id: "goal" },
    });
  const after = await milestoneView(f);
  assert.deepEqual(after.conditions, before.conditions);
  assert.equal(after.verified_count, 1);
  assert.equal(after.condition_count, 2);
  const child = await inspectTaskOutcomes(f.project, f.state.value, {
    task_id: "split-a",
  });
  assert.equal(child.acceptance_task_id, "goal");
  assert.equal(child.reported_done_with_verified_checks, false);
  await f.run("shape");
  assert.equal((await milestoneView(f)).all_declared_full_checks_pass, true);
  assert.equal((await taskView(f)).reported_done_with_verified_checks, true);
});
test("changed code, missing evidence and changed criterion meaning remain unmet", async (t) => {
  const f = await setup(t);
  await f.run("value");
  const result = await f.run("shape");
  await fs.writeFile(
    path.join(f.root, "module.mjs"),
    "export const answer = 2;\n",
  );
  const stale = await milestoneView(f);
  assert.equal(stale.verified_count, 0);
  assert.ok(stale.conditions.every((item) => item.freshness === "stale"));
  await fs.writeFile(
    path.join(f.root, "module.mjs"),
    "export const answer = 1;\n",
  );
  await fs.unlink(path.join(result.private_record_directory, "stdout.log"));
  assert.equal((await milestoneView(f)).verified_count, 1);
  await f.acceptance.define(
    "goal",
    f.definition.map((item) =>
      item.id === "value"
        ? { ...item, description: "A different requirement" }
        : item,
    ),
  );
  const changed = await milestoneView(f);
  assert.equal(changed.conditions[0].status, "definition_changed");
  assert.equal(changed.verified_count, 0);
});
test("milestone criteria cannot be silently redefined and forged verification is rejected atomically", async (t) => {
  const f = await setup(t);
  const input = { id: "goal", title: "Goal", status: "done", milestone: "M1" };
  const before = JSON.stringify(f.state.value);
  for (const extra of [
    { outcome: { verified: true } },
    {
      milestone_contract: {
        ...f.contract,
        criteria: f.contract.criteria.slice(0, 1),
      },
    },
    {
      milestone_contract: {
        ...f.contract,
        criteria: [f.contract.criteria[0], f.contract.criteria[0]],
      },
    },
    { outcome: { owner: "x".repeat(1001) } },
  ]) {
    await assert.rejects(f.state.mutate("task", { ...input, ...extra }));
    assert.equal(JSON.stringify(f.state.value), before);
  }
  await f.state.mutate("task", { ...input, milestone_contract: f.contract });
  assert.equal(f.state.value.task_outcomes.milestones.length, 1);
});
test("outcome inspection requires the project credential, exposes safe fields, and runs no checks", async (t) => {
  const f = await setup(t);
  await f.run("value");
  const before = await fs.readFile(
    path.join(f.project.directory, "acceptance/index.json"),
    "utf8",
  );
  const dashboard = await startDashboard({
    project: f.project,
    port: 0,
    tailscale: false,
  });
  t.after(() => dashboard.close());
  const runtime = JSON.parse(
    await fs.readFile(path.join(f.project.directory, "runtime.json"), "utf8"),
  );
  const url = dashboard.localUrl + "api/task-outcomes?task_id=goal";
  assert.equal((await fetch(url)).status, 401);
  assert.equal(
    (await fetch(url, { headers: { authorization: "Bearer invalid" } })).status,
    401,
  );
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${runtime.mcp_token}` },
  });
  assert.equal(response.status, 200);
  const view = await response.json();
  assert.equal(view.checks_executed, 0);
  assert.equal(view.state_revision, f.state.value.revision);
  assert.doesNotMatch(
    JSON.stringify(view),
    /fixture-private-output|private_record_directory|command|arguments_digest/,
  );
  assert.equal(
    await fs.readFile(
      path.join(f.project.directory, "acceptance/index.json"),
      "utf8",
    ),
    before,
  );
  const browserToken = new URL(runtime.browser_url).hash.slice("#key=".length);
  assert.equal(
    (await fetch(url, { headers: { "x-rdsh-browser-token": browserToken } }))
      .status,
    200,
  );
  assert.equal(
    (
      await fetch(url + "&task_id=other", {
        headers: { authorization: `Bearer ${runtime.mcp_token}` },
      })
    ).status,
    400,
  );
});
