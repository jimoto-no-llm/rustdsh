import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  PROTOCOL_VERSION_META_KEY,
  CLIENT_INFO_META_KEY,
  CLIENT_CAPABILITIES_META_KEY,
} from "@modelcontextprotocol/server";
import { identity } from "../state.mjs";
import { startDashboard } from "../server.mjs";

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

const taskAttention = {
  cause_id: "fixture-build-dependency",
  kind: "failure",
  deadline: "2030-05-01T12:00:00.000Z",
  impact: "high",
  next_action: "確認してから再実行する（この表示だけでは実行しない）",
};
const questionAttention = {
  cause_id: taskAttention.cause_id,
  deadline: taskAttention.deadline,
  impact: "critical",
  next_action: "質問の回答欄を開く",
};

function assertReportedFields(actual, expected) {
  assert.ok(actual, "attention metadata is present in public state");
  for (const [name, value] of Object.entries(expected))
    assert.equal(actual[name], value, `reported ${name} survives transport`);
}

test("attention metadata has the same durable contract on HTTP, legacy MCP, stdio, and MCP 2", async (t) => {
  const temporary = await fs.mkdtemp(
    path.join(os.tmpdir(), "rdsh-attention-api-"),
  );
  const previousHome = process.env.RDSH_DASHBOARD_HOME;
  process.env.RDSH_DASHBOARD_HOME = path.join(temporary, "state");
  let dashboard, legacy, stdio, runtime;
  t.after(async () => {
    await stdio?.close();
    await legacy?.close();
    await dashboard?.close();
    if (previousHome === undefined) delete process.env.RDSH_DASHBOARD_HOME;
    else process.env.RDSH_DASHBOARD_HOME = previousHome;
    await fs.rm(temporary, { recursive: true, force: true });
  });
  const projectRoot = path.join(temporary, "project");
  await fs.mkdir(projectRoot);
  const project = await identity(projectRoot);
  async function start() {
    dashboard = await startDashboard({
      project,
      port: await freePort(),
      tailscale: false,
    });
    runtime = JSON.parse(
      await fs.readFile(path.join(project.directory, "runtime.json"), "utf8"),
    );
  }
  await start();
  const adminHeaders = () => ({
    authorization: `Bearer ${runtime.token}`,
    "content-type": "application/json",
  });
  const browserHeaders = () => ({
    "x-rdsh-browser-token": new URL(runtime.browser_url).hash.slice(
      "#key=".length,
    ),
    "content-type": "application/json",
  });
  async function state() {
    const response = await fetch(dashboard.localUrl + "api/state", {
      headers: adminHeaders(),
    });
    assert.equal(response.status, 200);
    return response.json();
  }
  async function httpCall(name, args) {
    const route = {
      dashboard_upsert_task: "task",
      dashboard_ask_question: "question",
    }[name];
    assert.ok(route, "test only sends known reporting operations");
    const response = await fetch(dashboard.localUrl + "api/update/" + route, {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify(args),
    });
    const body = await response.json();
    return {
      isError: !response.ok,
      content: [{ type: "text", text: JSON.stringify(body) }],
    };
  }
  legacy = new Client(
    { name: "attention-legacy", version: "1.0.0" },
    { capabilities: {} },
  );
  await legacy.connect(
    new StreamableHTTPClientTransport(new URL(dashboard.localUrl + "mcp"), {
      requestInit: { headers: { authorization: `Bearer ${runtime.mcp_token}` } },
    }),
  );
  stdio = new Client(
    { name: "attention-stdio", version: "1.0.0" },
    { capabilities: {} },
  );
  await stdio.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [
        fileURLToPath(new URL("../cli.mjs", import.meta.url)),
        "mcp",
        "--project",
        project.root,
      ],
      env: { ...process.env },
      stderr: "pipe",
    }),
  );
  let requestId = 0;
  async function modernRequest(method, params = {}) {
    const response = await fetch(dashboard.localUrl + "mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${runtime.mcp_token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": method,
        ...(params.name ? { "mcp-name": params.name } : {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: ++requestId,
        method,
        params: {
          ...params,
          _meta: {
            [PROTOCOL_VERSION_META_KEY]: "2026-07-28",
            [CLIENT_INFO_META_KEY]: {
              name: "attention-modern",
              version: "1.0.0",
            },
            [CLIENT_CAPABILITIES_META_KEY]: {},
          },
        },
      }),
    });
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    assert.equal(result.error, undefined, JSON.stringify(result));
    return result.result;
  }
  const routes = [
    ["http", httpCall],
    ["legacy", (name, args) => legacy.callTool({ name, arguments: args })],
    ["stdio", (name, args) => stdio.callTool({ name, arguments: args })],
    [
      "modern",
      (name, args) => modernRequest("tools/call", { name, arguments: args }),
    ],
  ];

  await t.test("MCP catalogs expose the optional metadata without changing tool names", async () => {
    for (const catalog of [
      await legacy.listTools(),
      await stdio.listTools(),
      await modernRequest("tools/list"),
    ]) {
      assert.equal(catalog.tools.length, 6);
      for (const name of ["dashboard_upsert_task", "dashboard_ask_question"]) {
        const schema = catalog.tools.find(
          (tool) => tool.name === name,
        ).inputSchema;
        assert.ok(schema.properties.attention, `${name} advertises attention`);
        assert.ok(
          !schema.required?.includes("attention"),
          "old callers need not send metadata",
        );
      }
    }
  });

  for (const [route, call] of routes) {
    await t.test(`${route}: save, preserve, clear, and reject invalid metadata atomically`, async () => {
      async function report(name, args) {
        const result = await call(name, args);
        assert.notEqual(result.isError, true, result.content?.[0]?.text);
      }
      const task = {
        id: `${route}-failure`, title: "失敗の報告", status: "blocked",
      };
      const dependency = {
        id: `${route}-dependency`, title: "同じ原因の依存待ち", status: "blocked",
      };
      const question = {
        id: `${route}-question`, question: "原因の修正方法を選んでください",
      };
      await report("dashboard_upsert_task", { ...task, attention: taskAttention });
      await report("dashboard_upsert_task", {
        ...dependency, attention: { ...taskAttention, kind: "dependency" },
      });
      await report("dashboard_ask_question", {
        ...question, attention: questionAttention,
      });
      await report("dashboard_ask_question", {
        id: `${route}-question-no-cause`, question: "原因が未報告の質問", attention: { impact: "low" },
      });
      const initial = await state();
      const stored = initial.tasks.find((item) => item.id === task.id).attention;
      assertReportedFields(stored, taskAttention);
      assertReportedFields(
        initial.questions.find((item) => item.id === question.id).attention,
        questionAttention,
      );
      await report("dashboard_upsert_task", {
        ...task, title: "旧callerから本文だけ更新",
      });
      assert.deepEqual(
        (await state()).tasks.find((item) => item.id === task.id).attention,
        stored,
      );

      const invalidTasks = [
        { ...task, attention: { ...taskAttention, cause_id: "" } },
        { ...task, attention: { ...taskAttention, cause_id: "x".repeat(161) } },
        { ...task, attention: { kind: "blocked" } },
        { ...task, status: "done", attention: taskAttention },
        { ...task, attention: { ...taskAttention, kind: "done" } },
        { ...task, attention: { ...taskAttention, deadline: "tomorrow" } },
        { ...task, attention: { ...taskAttention, impact: "urgent" } },
        { ...task, attention: { ...taskAttention, next_action: "x".repeat(2001) } },
        { ...task, attention: { ...taskAttention, resolved_at: "2030-01-01T00:00:00Z" } },
        { ...task, attention: taskAttention, attention_history: [] },
      ];
      const invalidQuestions = [
        { id: `${route}-bad-kind`, question: "Invalid", attention: { kind: "failure" } },
        { id: `${route}-bad-date`, question: "Invalid", attention: { deadline: "yesterday" } },
        { id: `${route}-bad-impact`, question: "Invalid", attention: { impact: "urgent" } },
        { id: `${route}-bad-history`, question: "Invalid", attention: { history: [] } },
      ];
      for (const [name, inputs] of [
        ["dashboard_upsert_task", invalidTasks],
        ["dashboard_ask_question", invalidQuestions],
      ]) {
        for (const input of inputs) {
          const before = await state();
          const result = await call(name, input);
          assert.equal(
            result.isError, true, `${route} rejects ${JSON.stringify(input)}`,
          );
          assert.deepEqual(
            await state(), before,
            "a refused report changes neither revision nor durable content",
          );
        }
      }
      await report("dashboard_upsert_task", { ...task, attention: null });
      const cleared = await state();
      assert.equal(
        cleared.tasks.find((item) => item.id === task.id).attention == null, true,
      );
      assertReportedFields(
        cleared.tasks.find((item) => item.id === dependency.id).attention,
        { ...taskAttention, kind: "dependency" },
      );
      assert.equal(
        cleared.questions.find((item) => item.id === question.id).answer, null,
      );
      const legacyTask = { id: `${route}-legacy`, title: "既存の停止報告", status: "blocked", blocker: "前提の確認待ち" };
      await report("dashboard_upsert_task", legacyTask);
      await report("dashboard_upsert_task", { ...legacyTask, status: "doing", blocker: "" });
      assert.equal((await state()).tasks.find(item => item.id === legacyTask.id).attention_history.at(-1).attention.blocker, "前提の確認待ち");
      await report("dashboard_upsert_task", { ...legacyTask, attention: { kind: "failure" } });
      await report("dashboard_upsert_task", { ...legacyTask, status: "done", blocker: "" });
      const completed = (await state()).tasks.find(item => item.id === legacyTask.id);
      assert.equal(completed.attention, null);
      assert.equal(completed.attention_history.at(-1).action, "resolved");
    });
  }

  await t.test("attention does not grant reporting callers human answer authority", async () => {
    const endpoint = dashboard.localUrl + "api/update/answer";
    const body = JSON.stringify({ id: "http-question", answer: "調査を続ける" });
    for (const [headers, status] of [
      [{ "content-type": "application/json" }, 401],
      [{ "content-type": "application/json", authorization: `Bearer ${runtime.mcp_token}` }, 401],
      [adminHeaders(), 403],
    ]) {
      const before = await state();
      assert.equal((await fetch(endpoint, { method: "POST", headers, body })).status, status);
      assert.deepEqual(await state(), before);
    }
    const response = await fetch(endpoint, { method: "POST", headers: browserHeaders(), body });
    assert.equal(response.status, 200);
    const answered = await state();
    const original = answered.questions.find((question) => question.id === "http-question");
    assert.equal(original.answer, "調査を続ける");
    assertReportedFields(original.attention, questionAttention);
    assert.equal(answered.questions.find((question) => question.id === "legacy-question").answer, null);
    assert.equal(answered.feedback.filter((entry) => entry.question_id === "http-question").length, 1);
    for (const [route, call] of routes.slice(1)) {
      const reply = await call("dashboard_get_feedback", { after: 0 });
      assert.notEqual(reply.isError, true, route);
      const feedback = JSON.parse(reply.content.find(item => item.type === "text").text);
      assert.equal(feedback.messages.find(item => item.question_id === "http-question").answer, "調査を続ける", route);
      const next = await call("dashboard_get_feedback", { after: feedback.next_cursor });
      assert.deepEqual(JSON.parse(next.content.find(item => item.type === "text").text).messages, [], route);
    }
    assert.equal((await fetch(endpoint, { method: "POST", headers: browserHeaders(), body })).status, 400);
    assert.deepEqual(await state(), answered, "duplicate answer does not erase or duplicate history");
  });

  await t.test("reported metadata and cleared members survive an actual dashboard restart", async () => {
    const before = await state();
    await stdio.close();
    stdio = null;
    await legacy.close();
    legacy = null;
    await dashboard.close();
    dashboard = null;
    await start();
    assert.deepEqual(await state(), before);
  });
});
