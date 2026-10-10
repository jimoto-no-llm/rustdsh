import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { createProjectCrossSearch } from "../project-cross-search.mjs";
import { identity, ProjectStore } from "../state.mjs";
import { startDashboard } from "../server.mjs";

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function saveState(project, value) {
  await fs.mkdir(project.directory, { recursive: true });
  await fs.writeFile(
    path.join(project.directory, "state.json"),
    JSON.stringify(value),
  );
}

async function runtimeFiles(project, port, key) {
  await fs.mkdir(project.directory, { recursive: true });
  await fs.writeFile(
    path.join(project.directory, "runtime.json"),
    JSON.stringify({
      kind: "project",
      project_id: project.id,
      pid: 123,
      local_url: `http://127.0.0.1:${port}/`,
      browser_url: `http://127.0.0.1:${port}/#key=${key}`,
    }),
  );
  await fs.writeFile(path.join(project.directory, "server.lock"), "123");
}

function fixtureState(project, overrides = {}) {
  return {
    schema: 1,
    project: { id: project.id, name: project.name, root: project.root },
    tasks: [],
    questions: [],
    events: [],
    ...overrides,
  };
}

test("project search returns source-linked records from only its explicit allowlist", async (t) => {
  const temporary = await fs.mkdtemp(
    path.join(os.tmpdir(), "rdsh-cross-search-"),
  );
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const roots = path.join(temporary, "projects");
  await fs.mkdir(roots);
  const projects = await Promise.all(
    ["alpha", "beta", "excluded"].map(async (name, index) => {
      const root = path.join(roots, name);
      await fs.mkdir(root);
      return {
        id: `${index + 1}`.repeat(16),
        name,
        root,
        directory: path.join(temporary, "state", name),
      };
    }),
  );
  const [alpha, beta, excluded] = projects;
  const artifactDirectory = path.join(beta.root, "reports");
  await fs.mkdir(artifactDirectory);
  await fs.writeFile(
    path.join(artifactDirectory, "release.md"),
    "private-body-not-indexed",
  );
  const states = new Map([
    [
      alpha.id,
      fixtureState(alpha, {
        tasks: [
          {
            id: "T-1",
            title: "Starlight planning task",
            status: "doing",
            milestone: "October",
            blocker: "",
            updated_at: "2026-10-01T12:00:00Z",
          },
        ],
        questions: [
          {
            id: "Q-1",
            question: "Starlight planning decision",
            answer: "Use the staged path",
            created_at: "2026-10-02T10:00:00Z",
            answered_at: "2026-10-02T11:00:00Z",
          },
        ],
      }),
    ],
    [
      beta.id,
      fixtureState(beta, {
        events: [
          {
            sequence: 7,
            type: "progress",
            title: "Starlight planning log",
            detail: "passed integration checks",
            created_at: "2026-10-02T12:00:00Z",
          },
          {
            sequence: 8,
            type: "artifact",
            title: "Starlight planning artifact",
            detail: "private-body-not-indexed",
            artifact: "reports/release.md",
            created_at: "2026-10-03T12:00:00Z",
          },
          {
            sequence: 9,
            type: "artifact",
            title: "Starlight planning stale reference",
            artifact: "reports/moved.md",
            created_at: "2026-10-04T12:00:00Z",
          },
          {
            sequence: 10,
            type: "artifact",
            title: "Starlight planning external reference",
            artifact: "https://example.test/file?api_key=hidden#token",
            created_at: "2026-10-05T12:00:00Z",
          },
          {
            sequence: 11,
            type: "artifact",
            title: "Starlight planning outside reference",
            artifact: "../excluded/private.txt",
            created_at: "2026-10-06T12:00:00Z",
          },
        ],
      }),
    ],
    [excluded.id, fixtureState(excluded, {
      tasks: [{ id: "secret", title: "Starlight private hidden content" }],
    })],
  ]);
  await Promise.all(projects.map((project) => saveState(project, states.get(project.id))));
  const keys = new Map();
  await Promise.all(
    [alpha, beta].map(async (project, index) => {
      const key = String(index + 1).repeat(64);
      keys.set(project.id, key);
      await runtimeFiles(project, 38100 + index, key);
    }),
  );
  const search = createProjectCrossSearch([alpha, beta], {
    processApi: { kill() {} },
  });

  const all = await search.search({ query: "starlight planning" });
  assert.deepEqual(
    new Set(all.results.map((item) => item.kind)),
    new Set(["task", "decision", "log", "artifact"]),
  );
  assert.deepEqual(
    new Set(all.results.map((item) => item.project_name)),
    new Set(["alpha", "beta"]),
  );
  assert.equal(all.results.some((item) => item.project_name === "excluded"), false);
  assert.equal(all.results.some((item) => item.title.includes("private hidden")), false);
  assert.equal(all.results.find((item) => item.kind === "artifact").search_scope, "reference_only");
  assert.equal(all.results.find((item) => item.record_id === "8").reference_status, "available");
  assert.equal(all.results.find((item) => item.record_id === "9").reference_status, "stale");
  assert.equal(all.results.find((item) => item.record_id === "10").reference_status, "external");
  assert.equal(all.results.find((item) => item.record_id === "11").reference_status, "unknown");
  assert.equal(all.results.find((item) => item.record_id === "8").source, "artifact:8");
  assert.match(all.results.find((item) => item.record_id === "8").source_url, /#event-8$/);
  for (const item of all.results) {
    const source = new URL(item.source_url);
    assert.equal(source.search, "");
    assert.doesNotMatch(source.href, /key=|hidden/);
    assert.doesNotMatch(JSON.stringify(item), new RegExp(keys.get(item.project_id)));
  }
  assert.doesNotMatch(JSON.stringify(all), /private-body-not-indexed|api_key|excluded|private\.txt/);

  const decisionsOnDay = await search.search({
    query: "starlight planning",
    kind: "decision",
    since: "2026-10-02",
    until: "2026-10-02",
  });
  assert.equal(decisionsOnDay.matched_count, 1);
  assert.equal(decisionsOnDay.results[0].record_id, "Q-1");

  const logsInBeta = await search.search({
    query: "starlight planning",
    kind: "log",
    project_ids: [beta.id, excluded.id],
  });
  assert.equal(logsInBeta.matched_count, 1);
  assert.equal(logsInBeta.results[0].project_id, beta.id);

  const limited = await search.search({ query: "starlight planning", limit: 2 });
  assert.equal(limited.results.length, 2);
  assert.equal(limited.truncated, true);

  const artifactBody = await search.search({ query: "private-body-not-indexed" });
  assert.equal(artifactBody.matched_count, 0);

  const sanitizedUrl = await search.search({ query: "api_key" });
  assert.equal(sanitizedUrl.matched_count, 0);
  await assert.rejects(search.search({ query: "" }), /Enter a search term/);
  await assert.rejects(search.search({ query: "x ".repeat(11) }), /up to 10 terms/);
  await assert.rejects(
    search.search({ query: "starlight", since: "2026-02-30" }),
    /valid YYYY-MM-DD/,
  );
});

test("unavailable allowlisted project data becomes unknown without a count or snippet", async () => {
  const projects = ["1", "2"].map((id, index) => ({
    id: id.repeat(16),
    name: `project-${index}`,
    root: path.join(os.tmpdir(), `rdsh-search-project-${index}`),
    directory: path.join(os.tmpdir(), `rdsh-search-state-${index}`),
  }));
  const search = createProjectCrossSearch(projects, {
    readState: async (project) => {
      if (project.id === projects[1].id) throw new Error("unavailable");
      return fixtureState(project, {
        tasks: [{ id: "T", title: "Starlight planning task" }],
      });
    },
  });
  const value = await search.search({ query: "starlight planning" });
  assert.equal(value.matched_count, 1);
  assert.deepEqual(value.unavailable_projects, [
    { project_id: projects[1].id, name: projects[1].name },
  ]);
  assert.equal(value.results.some((item) => item.project_id === projects[1].id), false);
});

test("HTTP cross-project search requires the primary human browser credential", async (t) => {
  const temporary = await fs.mkdtemp(
    path.join(os.tmpdir(), "rdsh-cross-search-http-"),
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
  const projects = await Promise.all(
    ["primary", "included", "not-included"].map(async (name) => {
      const root = path.join(roots, name);
      await fs.mkdir(root);
      return identity(root);
    }),
  );
  const [primary, included, notIncluded] = projects;
  const primaryStore = await ProjectStore.open(primary);
  primaryStore.value.tasks = [
    {
      id: "P-1",
      title: "Starlight primary task",
      status: "todo",
      updated_at: "2026-10-07T12:00:00Z",
    },
  ];
  await saveState(primary, primaryStore.value);
  const includedStore = await ProjectStore.open(included);
  includedStore.value.tasks = [
    {
      id: "I-1",
      title: "Starlight included task",
      status: "doing",
      updated_at: "2026-10-07T12:00:00Z",
    },
  ];
  await saveState(included, includedStore.value);
  const hiddenStore = await ProjectStore.open(notIncluded);
  hiddenStore.value.tasks = [
    {
      id: "H-1",
      title: "Starlight unlisted confidential title",
      status: "blocked",
      updated_at: "2026-10-07T12:00:00Z",
    },
  ];
  await saveState(notIncluded, hiddenStore.value);

  includedDashboard = await startDashboard({
    project: included,
    port: await freePort(),
    tailscale: false,
  });
  primaryDashboard = await startDashboard({
    project: primary,
    overviewProjects: [included],
    port: await freePort(),
    tailscale: false,
  });
  const primaryRuntime = JSON.parse(
    await fs.readFile(path.join(primary.directory, "runtime.json"), "utf8"),
  );
  const includedRuntime = JSON.parse(
    await fs.readFile(path.join(included.directory, "runtime.json"), "utf8"),
  );
  const token = new URL(primaryRuntime.browser_url).hash.slice("#key=".length);
  const includedToken = new URL(includedRuntime.browser_url).hash.slice("#key=".length);
  const route = primaryDashboard.localUrl + "api/projects/search";
  const request = (headers, body = { query: "starlight" }) =>
    fetch(route, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });

  assert.equal((await request({})).status, 401);
  assert.equal(
    (await request({ authorization: `Bearer ${primaryRuntime.mcp_token}` })).status,
    401,
  );
  assert.equal(
    (await request({ authorization: `Bearer ${primaryRuntime.token}` })).status,
    403,
  );
  assert.equal((await request({ "x-rdsh-browser-token": includedToken })).status, 401);

  const response = await request({ "x-rdsh-browser-token": token });
  assert.equal(response.status, 200);
  const value = await response.json();
  assert.deepEqual(
    new Set(value.results.map((item) => item.project_name)),
    new Set(["primary", "included"]),
  );
  assert.doesNotMatch(JSON.stringify(value), /not-included|confidential|root|directory/);
  assert.doesNotMatch(JSON.stringify(value), new RegExp(token));
  assert.doesNotMatch(JSON.stringify(value), new RegExp(includedToken));
  assert.match(value.results.find((item) => item.project_id === included.id).source_url, /#task-I-1$/);
  const configResponse = await fetch(primaryDashboard.localUrl + "api/config", {
    headers: { "x-rdsh-browser-token": token },
  });
  assert.equal((await configResponse.json()).project_search_enabled, true);

  const invalid = await request(
    { "x-rdsh-browser-token": token },
    { query: "starlight", project_ids: [notIncluded.id] },
  );
  assert.equal(invalid.status, 200);
  assert.equal((await invalid.json()).matched_count, 0);

  const badFilters = await request(
    { "x-rdsh-browser-token": token },
    { query: "starlight", kind: "session" },
  );
  assert.equal(badFilters.status, 400);
});
