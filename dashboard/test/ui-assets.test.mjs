import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { identity, ProjectStore } from "../state.mjs";
import { startDashboard } from "../server.mjs";

async function freePort() {
  const socket = net.createServer();
  await new Promise((resolve) => socket.listen(0, "127.0.0.1", resolve));
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  return port;
}

// A single module that the browser cannot fetch stops the whole page from
// booting, so the import graph is walked without a browser token and every
// file must be public and served as JavaScript.
test("every browser module in the dashboard import graph is public", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rdsh-ui-assets-"));
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

  const page = await fetch(dashboard.localUrl);
  assert.equal(page.status, 200);
  const html = await page.text();
  for (const id of ["agent-ui", "agent-ui-status"])
    assert.match(html, new RegExp('id="' + id + '"'), id);

  const entry = new URL("app.mjs", dashboard.localUrl);
  const seen = new Set();
  const queue = [entry];
  const modules = [];
  while (queue.length > 0) {
    const url = queue.shift();
    const key = url.pathname;
    if (seen.has(key)) continue;
    seen.add(key);
    const response = await fetch(url);
    assert.equal(response.status, 200, key + " must be served without a browser token");
    assert.match(response.headers.get("content-type") || "", /javascript/, key);
    const source = await response.text();
    modules.push(key);
    const pattern = /(?:from|import)\s*\(?\s*"\.\/([^"]+)"/g;
    let match = pattern.exec(source);
    while (match) {
      queue.push(new URL(match[1], url));
      match = pattern.exec(source);
    }
  }
  assert.ok(modules.length >= 5, modules.join(","));
  assert.ok(modules.includes("/app.mjs"));
  assert.ok(modules.some((name) => name.startsWith("/ui/")));
});
