import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { identity } from "../state.mjs";
import { startDashboard } from "../server.mjs";

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test("generated stdio configuration connects independent clients and survives credential rotation", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rdsh-mcp-clients-"));
  const previousHome = process.env.RDSH_DASHBOARD_HOME;
  process.env.RDSH_DASHBOARD_HOME = path.join(root, "custom state");
  const clients = [];
  let dashboard;
  t.after(async () => {
    for (const client of clients) await client.close();
    await dashboard?.close();
    if (previousHome === undefined) delete process.env.RDSH_DASHBOARD_HOME;
    else process.env.RDSH_DASHBOARD_HOME = previousHome;
    await fs.rm(root, { recursive: true, force: true });
  });
  const cwd = path.join(root, "日本語 project");
  await fs.mkdir(cwd);
  const project = await identity(cwd);
  const start = async () => startDashboard({ project, port: await freePort(), tailscale: false });
  dashboard = await start();
  const config = JSON.parse(await fs.readFile(path.join(project.directory, "mcp-config.json"), "utf8"));
  const serverConfig = Object.values(config.mcpServers)[0];
  const runtime = JSON.parse(await fs.readFile(path.join(project.directory, "runtime.json"), "utf8"));
  for (const secret of [runtime.token, runtime.mcp_token, runtime.browser_url])
    assert.ok(!JSON.stringify(config).includes(secret));
  const call = async (client, name, args) => {
    const result = await client.callTool({ name, arguments: args });
    assert.notEqual(result.isError, true, result.content[0]?.text);
    return JSON.parse(result.content[0].text);
  };
  // These are protocol clients, not provider-backed Claude Code/Codex runs.
  for (const name of ["claude-compatible-stdio", "codex-compatible-stdio"]) {
    const client = new Client({ name, version: "1.0.0" }, { capabilities: {} });
    clients.push(client);
    await client.connect(new StdioClientTransport({
      ...serverConfig,
      cwd: root,
      env: { HOME: root, USERPROFILE: root, ...serverConfig.env },
      stderr: "pipe",
    }));
    const tools = (await client.listTools()).tools.map((tool) => tool.name);
    assert.ok(tools.includes("dashboard_present_ui"));
    assert.equal((await call(client, "dashboard_get_state", {})).project.id, project.id);
  }
  await call(clients[0], "dashboard_upsert_task", { id: "claude-review", title: "Review", status: "doing" });
  assert.ok((await call(clients[1], "dashboard_get_state", {})).tasks.some((task) => task.id === "claude-review"));
  await dashboard.close();
  dashboard = await start();
  const restarted = JSON.parse(await fs.readFile(path.join(project.directory, "runtime.json"), "utf8"));
  assert.ok(runtime.mcp_token !== restarted.mcp_token);
  for (const client of clients)
    assert.ok((await call(client, "dashboard_get_state", {})).tasks.some((task) => task.id === "claude-review"));
});
