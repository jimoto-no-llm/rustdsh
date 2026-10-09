import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createProjectCrossOverview } from "../project-cross-overview.mjs";
import { identity, ProjectStore } from "../state.mjs";
import { startDashboard } from "../server.mjs";

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function saveState(project, state) {
  await fs.mkdir(project.directory, { recursive: true });
  await fs.writeFile(
    path.join(project.directory, "state.json"),
    JSON.stringify(state),
  );
}

function state(project, overrides = {}) {
  return {
    schema: 1,
    project: { id: project.id, name: project.name, root: project.root },
    tasks: [],
    questions: [],
    ...overrides,
  };
}

test("overview summarizes only explicit projects and hides counts after a read failure", async (t) => {
  const temporary = await fs.mkdtemp(
    path.join(os.tmpdir(), "rdsh-cross-overview-"),
  );
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const projectsRoot = path.join(temporary, "projects");
  await fs.mkdir(projectsRoot);
  const [alpha, beta, ignored] = await Promise.all(
    ["alpha", "beta", "ignored"].map(async (name) => {
      const root = path.join(projectsRoot, name);
      await fs.mkdir(root);
      return {
        id:
          name === "alpha"
            ? "1111111111111111"
            : name === "beta"
              ? "2222222222222222"
              : "3333333333333333",
        name,
        root,
        directory: path.join(temporary, "state", name),
      };
    }),
  );
  const primaryState = state(alpha, {
    tasks: [
      { id: "A1", status: "doing" },
      { id: "A2", status: "todo" },
      { id: "A3", status: "todo" },
      { id: "A4", status: "blocked" },
    ],
    questions: [
      { id: "Q1", answer: null },
      { id: "Q2", answer: "answered" },
    ],
    instructions: {
      requests: {
        I1: { status: "review_required" },
        I2: { status: "resolved" },
      },
    },
  });
  await saveState(alpha, primaryState);
  await saveState(
    beta,
    state(beta, {
      tasks: [{ id: "B1", status: "doing" }],
      questions: [],
    }),
  );
  await saveState(
    ignored,
    state(ignored, { tasks: [{ id: "C1", status: "blocked" }] }),
  );
  await fs.writeFile(
    path.join(alpha.directory, "runtime.json"),
    JSON.stringify({
      kind: "project",
      project_id: alpha.id,
      pid: 123,
      local_url: "http://127.0.0.1:38101/",
      browser_url: "http://127.0.0.1:38101/#key=" + "a".repeat(64),
    }),
  );
  await fs.writeFile(path.join(alpha.directory, "server.lock"), "123");
  const cacheFile = path.join(temporary, "overview-cache.json");
  let time = Date.parse("2026-10-10T00:00:00Z");
  const overview = createProjectCrossOverview([alpha, beta], cacheFile, {
    now: () => time,
    processApi: {
      kill(pid) {
        if (pid !== 123) throw Object.assign(new Error(), { code: "ESRCH" });
      },
    },
  });

  const first = await overview.snapshot();
  assert.deepEqual(
    first.projects.map((project) => project.name),
    ["alpha", "beta"],
  );
  assert.deepEqual(first.projects[0].counts, {
    active: 1,
    waiting: 2,
    needs_attention: 3,
  });
  assert.equal(first.projects[1].counts.active, 1);
  assert.equal(first.projects[0].status, "observed");
  assert.equal(new URL(first.projects[0].detail_url).hash, "");
  assert.equal(
    new URL(first.projects[0].detail_url).origin,
    "http://127.0.0.1:38101",
  );
  assert.equal(first.projects[1].detail_url, null);
  assert.doesNotMatch(JSON.stringify(first), /ignored|projectsRoot/);
  const savedCache = JSON.parse(await fs.readFile(cacheFile, "utf8"));
  assert.deepEqual(savedCache.entries[alpha.id], {
    last_observed_at: "2026-10-10T00:00:00.000Z",
  });
  assert.doesNotMatch(JSON.stringify(savedCache), /alpha|beta|doing|blocked/);

  time += 15000;
  await fs.rm(path.join(beta.directory, "state.json"));
  const second = await overview.snapshot();
  assert.equal(second.projects[1].status, "unknown");
  assert.equal(second.projects[1].counts, null);
  assert.equal(second.projects[1].detail_url, null);
  assert.equal(second.projects[1].last_observed_at, "2026-10-10T00:00:00.000Z");
  await saveState(beta, state(beta, { tasks: [null], questions: [] }));
  const third = await overview.snapshot();
  assert.equal(third.projects[1].status, "unknown");
  assert.equal(third.projects[1].counts, null);
  assert.equal(third.projects[1].last_observed_at, "2026-10-10T00:00:00.000Z");
});

test("cross-project allowlist rejects duplicate or excessive entries", () => {
  const cacheFile = path.join(os.tmpdir(), "rdsh-overview-test-cache.json");
  const project = {
    id: "1111111111111111",
    name: "one",
    root: "C:\\one",
    directory: "C:\\state\\one",
  };
  assert.throws(
    () => createProjectCrossOverview([project, project], cacheFile),
    /distinct projects/,
  );
  assert.throws(
    () =>
      createProjectCrossOverview(
        Array.from({ length: 33 }, (_, index) => ({
          ...project,
          id: String(index).padStart(16, "0"),
        })),
        cacheFile,
      ),
    /2–32/,
  );
});

test("CLI accepts repeated explicit project paths before validating other options", async (t) => {
  const temporary = await fs.mkdtemp(
    path.join(os.tmpdir(), "rdsh-cross-overview-cli-"),
  );
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const directories = await Promise.all(
    ["primary", "included-a", "included-b"].map(async (name) => {
      const directory = path.join(temporary, name);
      await fs.mkdir(directory);
      return directory;
    }),
  );
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL("../cli.mjs", import.meta.url)),
      "project",
      "--project",
      directories[0],
      "--include-project",
      directories[1],
      "--include-project",
      directories[2],
      "--port",
      "not-a-port",
      "--no-tailscale",
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Port must be an integer/);
  assert.doesNotMatch(result.stderr, /Cross-project overview directories/);
});

test("HTTP overview is limited to the explicit list and a human browser credential", async (t) => {
  const temporary = await fs.mkdtemp(
    path.join(os.tmpdir(), "rdsh-cross-overview-http-"),
  );
  const previousHome = process.env.RDSH_DASHBOARD_HOME;
  process.env.RDSH_DASHBOARD_HOME = path.join(temporary, "state-home");
  let primaryDashboard, includedDashboard;
  t.after(async () => {
    await primaryDashboard?.close();
    await includedDashboard?.close();
    if (previousHome) process.env.RDSH_DASHBOARD_HOME = previousHome;
    else delete process.env.RDSH_DASHBOARD_HOME;
    await fs.rm(temporary, { recursive: true, force: true });
  });

  const roots = path.join(temporary, "projects");
  await fs.mkdir(roots);
  const [primary, included, notIncluded] = await Promise.all(
    ["primary", "included", "not-included"].map(async (name) => {
      const root = path.join(roots, name);
      await fs.mkdir(root);
      return identity(root);
    }),
  );
  const includedStore = await ProjectStore.open(included);
  includedStore.value.tasks = [{ id: "T1", title: "Active", status: "doing" }];
  await saveState(included, includedStore.value);
  primaryDashboard = await startDashboard({
    project: primary,
    overviewProjects: [included],
    port: await freePort(),
    tailscale: false,
  });
  includedDashboard = await startDashboard({
    project: included,
    port: await freePort(),
    tailscale: false,
  });
  const runtime = JSON.parse(
    await fs.readFile(path.join(primary.directory, "runtime.json"), "utf8"),
  );
  const includedRuntime = JSON.parse(
    await fs.readFile(path.join(included.directory, "runtime.json"), "utf8"),
  );
  const token = new URL(runtime.browser_url).hash.slice("#key=".length);
  const includedToken = new URL(includedRuntime.browser_url).hash.slice(
    "#key=".length,
  );
  const route = primaryDashboard.localUrl + "api/projects/overview";

  assert.equal((await fetch(route)).status, 401);
  assert.equal(
    (
      await fetch(route, {
        headers: { authorization: `Bearer ${runtime.mcp_token}` },
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await fetch(route, {
        headers: { authorization: `Bearer ${runtime.token}` },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await fetch(route, {
        headers: { "x-rdsh-browser-token": includedToken },
      })
    ).status,
    401,
  );
  const response = await fetch(route, {
    headers: { "x-rdsh-browser-token": token },
  });
  assert.equal(response.status, 200);
  const value = await response.json();
  assert.deepEqual(
    value.projects.map((project) => project.name),
    ["primary", "included"],
  );
  assert.equal(value.projects[1].status, "observed");
  assert.equal(value.projects[1].counts.active, 1);
  assert.equal(new URL(value.projects[1].detail_url).hash, "");
  assert.doesNotMatch(JSON.stringify(value), new RegExp(includedToken));
  assert.doesNotMatch(JSON.stringify(value), /not-included|root|directory/);
  assert.equal(
    (
      await (
        await fetch(primaryDashboard.localUrl + "api/config", {
          headers: { "x-rdsh-browser-token": token },
        })
      ).json()
    ).project_overview_enabled,
    true,
  );
});
