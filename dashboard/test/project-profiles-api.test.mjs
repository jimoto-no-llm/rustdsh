import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { identity, ProjectStore } from "../state.mjs";
import { startDashboard } from "../server.mjs";

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test("project profiles are browser-managed, previewed without execution, and durable across restart", async (t) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "rdsh-profiles-test-"));
  const oldHome = process.env.RDSH_DASHBOARD_HOME;
  const oldMaxParallel = process.env.RDSH_PROFILE_MAX_PARALLEL;
  process.env.RDSH_DASHBOARD_HOME = path.join(temporary, "state");
  process.env.RDSH_PROFILE_MAX_PARALLEL = "8";
  await fs.mkdir(path.join(temporary, "project"));
  const project = await identity(path.join(temporary, "project"));
  let dashboard;
  t.after(async () => {
    await dashboard?.close();
    if (oldHome === undefined) delete process.env.RDSH_DASHBOARD_HOME;
    else process.env.RDSH_DASHBOARD_HOME = oldHome;
    if (oldMaxParallel === undefined) delete process.env.RDSH_PROFILE_MAX_PARALLEL;
    else process.env.RDSH_PROFILE_MAX_PARALLEL = oldMaxParallel;
    await fs.rm(temporary, { recursive: true, force: true });
  });

  dashboard = await startDashboard({ project, port: await freePort(), tailscale: false });
  const runtime = JSON.parse(
    await fs.readFile(path.join(project.directory, "runtime.json"), "utf8"),
  );
  const browserToken = new URL(runtime.browser_url).hash.slice("#key=".length);
  const browser = { "x-rdsh-browser-token": browserToken };
  const mcp = { authorization: `Bearer ${runtime.mcp_token}` };
  assert.equal((await fetch(dashboard.localUrl + "api/profiles")).status, 401);
  assert.equal(
    (await fetch(dashboard.localUrl + "api/profiles", { headers: mcp })).status,
    401,
  );
  assert.match(await (await fetch(dashboard.localUrl)).text(), /プロジェクト運用プロファイル/);

  const post = (route, value, headers = browser) =>
    fetch(dashboard.localUrl + route, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(value),
    });
  const saved = await post("api/profiles/save", {
    id: "web-review",
    name: "Web review",
    values: {
      model_route: "openai/gpt-4.1",
      verification_commands: [["npm", "test"]],
      permissions: { read_paths: ["src"], write_paths: [], network_hosts: [] },
      max_parallel: 4,
      notifications: "all",
    },
    activate: true,
  });
  assert.equal(saved.status, 200);
  const catalog = await saved.json();
  const version = catalog.active.version;
  assert.match(version, /^sha256:[a-f0-9]{64}$/);

  const preview = await post("api/profiles/preview", {
    id: "web-review",
    version,
    user: { notifications: "actionable" },
    invocation: { max_parallel: 2 },
  });
  assert.equal(preview.status, 200);
  const resolved = await preview.json();
  assert.equal(resolved.effective_values.model_route, "openai/gpt-4.1");
  assert.equal(resolved.effective_values.max_parallel, 2);
  assert.equal(resolved.effective_values.notifications, "all");
  assert.equal(resolved.sources.max_parallel.selected, "invocation");
  assert.equal(resolved.sources.notifications.selected, "project");
  assert.equal(resolved.execution_effect, "none");

  assert.equal(
    (await post("api/profiles/save", {
      id: "leak",
      name: "Leak",
      values: { api_key: "secret" },
    }, mcp)).status,
    401,
  );
  await dashboard.close();
  dashboard = null;
  const persisted = await ProjectStore.open(project);
  assert.equal(
    persisted.value.profile_catalog.profiles["web-review"].versions[0].version,
    version,
  );
  assert.deepEqual(persisted.value.profile_catalog.active, {
    id: "web-review",
    version,
  });
});
