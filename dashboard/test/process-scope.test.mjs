import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { spawnOwnedProcess } from "../process-scope.mjs";
import { startHarness } from "../harness.mjs";
import { RunHistory } from "../run-history.mjs";
import { startDashboard } from "../server.mjs";
import net from "node:net";
const fixture = fileURLToPath(
  new URL("./fixtures/owned-tree.mjs", import.meta.url),
);
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(check, budget = 10000) {
  const end = Date.now() + budget;
  while (Date.now() < end) {
    if (await check()) return;
    await pause(25);
  }
  throw new Error("Fixture did not reach the expected state");
}
async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rdsh-scope-"));
  const owned = [];
  t.after(async () => {
    for (const p of owned)
      await p.stop({ gracefulTimeout: 100, killTimeout: 1000 });
    await fs.rm(root, { recursive: true, force: true });
  });
  const rows = async (trace) =>
    (await fs.readFile(trace, "utf8").catch(() => ""))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(JSON.parse);
  const tree = async (mode = "stubborn") => {
    const trace = path.join(root, "trace-" + owned.length + ".jsonl"),
      stages = [];
    const p = await spawnOwnedProcess({
      command: [process.execPath, fixture, "root", mode, trace],
      cwd: root,
      onStage: (e) => {
        stages.push(e);
      },
    });
    owned.push(p);
    p.child.stdout.resume();
    p.child.stderr.resume();
    await p.release();
    await waitFor(async () =>
      (await rows(trace)).some(
        (r) => r.role === "grandchild" && r.type === "started",
      ),
    );
    return { p, trace, stages };
  };
  return { root, rows, tree, own: (p) => owned.push(p) };
}
test("owned children and detached grandchildren stop in order after a bounded graceful deadline, with duplicate requests sharing one result", async (t) => {
  const { tree, rows } = await setup(t),
    { p, trace, stages } = await tree("detached");
  const live = await p.inspect();
  assert.equal(live.status, "running");
  assert(live.remaining_count >= 3);
  const start = Date.now();
  const first = p.stop({ gracefulTimeout: 200, killTimeout: 1000 }),
    second = p.stop({ gracefulTimeout: 200, killTimeout: 1000 });
  const [a, b] = await Promise.all([first, second]);
  assert.deepEqual(a, b);
  assert.equal(a.confirmed, true);
  assert.equal(a.remaining_count, 0);
  assert.equal(a.resources_released, true);
  assert(Date.now() - start >= 190);
  assert.deepEqual(
    stages.filter((e) => e.phase === "request").map((e) => e.stage),
    ["input_interrupt", "graceful", "termination", "kill"],
  );
  assert.equal(stages.at(-1).stage, "verification");
  assert.equal(stages.at(-1).status, "exit_confirmed");
  const stopped = (await rows(trace)).length;
  await pause(180);
  assert.equal((await rows(trace)).length, stopped);
});
test("cooperative EOF/TERM exits require no forced kill on Linux and retain truthful Windows graceful capability", async (t) => {
  const { tree } = await setup(t),
    { p, stages } = await tree("cooperative");
  const result = await p.stop({ gracefulTimeout: 400, killTimeout: 1000 });
  assert.equal(result.confirmed, true);
  if (process.platform === "linux")
    assert(!stages.some((s) => s.stage === "kill"));
  else
    assert(
      stages.some(
        (s) => s.stage === "termination" && s.status === "unsupported",
      ),
    );
});
test("root exit cannot confirm descendant exit and changing the exposed PID to an independent canary never redirects a kernel-handle stop", async (t) => {
  const { root, tree, rows } = await setup(t),
    { p, trace } = await tree("root_exit"),
    { p: other, trace: otherTrace } = await tree();
  const canaryTrace = path.join(root, "human-terminal.jsonl");
  const canary = spawn(
    process.execPath,
    [fixture, "canary", "stubborn", canaryTrace],
    { stdio: "ignore", windowsHide: true },
  );
  t.after(async () => {
    if (canary.exitCode !== null || canary.signalCode !== null) return;
    const exit = new Promise((r) => canary.once("exit", r));
    canary.kill("SIGKILL");
    await exit;
  });
  await waitFor(async () =>
    (await rows(canaryTrace)).some((r) => r.type === "heartbeat"),
  );
  p.child.stdin.end();
  await waitFor(async () => {
    const state = await p.inspect();
    return (
      !state.remaining_pids.includes(p.descriptor.root_pid) &&
      state.remaining_count >= 2
    );
  });
  assert.equal((await p.inspect()).confirmed, false);
  p.child.pid = canary.pid; // Deterministic reused-PID fault; authority stays in the live kernel group.
  assert.equal(
    (await p.stop({ gracefulTimeout: 150, killTimeout: 1000 })).confirmed,
    true,
  );
  assert.equal((await other.inspect()).status, "running");
  assert((await other.inspect()).remaining_count >= 3);
  assert((await rows(otherTrace)).every((r) => r.type !== "term"));
  assert((await rows(canaryTrace)).every((r) => r.type !== "term"));
  const n = (await rows(canaryTrace)).length;
  await pause(150);
  assert((await rows(canaryTrace)).length > n);
  assert((await rows(trace)).some((r) => r.type === "eof"));
});
test("monitor disconnect is unverifiable, sends no guessed PID kill, and never produces a confirmed stop", async (t) => {
  const { tree, rows } = await setup(t),
    { p, trace, stages } = await tree();
  p.disconnectMonitor();
  const result = await p.stop({ gracefulTimeout: 100, killTimeout: 1000 });
  assert.equal(result.status, "unverifiable");
  assert.equal(result.confirmed, false);
  assert.deepEqual(
    stages.map((e) => e.stage),
    ["verification"],
  );
  // The supervisor's EOF cleanup is still confined to its original group.
  await pause(1300);
  const n = (await rows(trace)).length;
  await pause(180);
  assert.equal((await rows(trace)).length, n);
});
test("managed Harness stores ownership before release and every stop stage including final empty-group proof; reloaded history cannot recreate signal authority", async (t) => {
  const { root, own } = await setup(t),
    trace = path.join(root, "harness.jsonl"),
    project = { id: "scope-history", directory: path.join(root, "state") };
  const h = await startHarness(3081, 38081, {
    project,
    cwd: root,
    command: [process.execPath, fixture, "root", "stubborn", trace],
    stopTimeout: 150,
  });
  own(h);
  const before = await h.inspect();
  assert(before.scope.remaining_count >= 3);
  assert.equal((await h.stop()).confirmed, true);
  const history = await RunHistory.open(project),
    result = await history.inspect(h.run_id),
    events = (await history.events(h.run_id)).events;
  assert(
    events.findIndex((e) => e.type === "scope_intent") <
      events.findIndex((e) => e.type === "scope_bound"),
  );
  assert(
    events.some(
      (e) =>
        e.type === "stop_stage" &&
        e.data.stage === "kill" &&
        e.data.phase === "request",
    ),
  );
  assert.equal(result.scope_observation.status, "exit_confirmed");
  assert.equal(result.scope_observation.stop_authority, false);
  assert.equal(result.scope.stages.at(-1).remaining_count, 0);
  assert.equal(result.commands.filter((c) => c.operation === "stop").length, 1);
});

test("authenticated Harness API separates stopping from verified empty descendants, duplicate human requests stop once, and MCP credentials cannot stop the owned run", async (t) => {
  const { root, own } = await setup(t),
    previous = process.env.RDSH_DASHBOARD_HOME;
  process.env.RDSH_DASHBOARD_HOME = path.join(root, "dashboard-home");
  t.after(() => {
    if (previous === undefined) delete process.env.RDSH_DASHBOARD_HOME;
    else process.env.RDSH_DASHBOARD_HOME = previous;
  });
  const probe = net.createServer();
  await new Promise((r) => probe.listen(0, "127.0.0.1", r));
  const port = probe.address().port;
  await new Promise((r) => probe.close(r));
  const d = await startDashboard({
    kind: "harness",
    port,
    tailscale: false,
    harnessOptions: {
      cwd: root,
      command: [
        process.execPath,
        fixture,
        "root",
        "stubborn",
        path.join(root, "api-tree.jsonl"),
      ],
      stopTimeout: 400,
    },
  });
  own({ stop: () => d.close() });
  const runtime = JSON.parse(
    await fs.readFile(path.join(d.directory, "runtime.json"), "utf8"),
  );
  const url = d.localUrl + "_rdsh/api/",
    admin = { authorization: "Bearer " + runtime.token };
  assert.equal(
    (await fetch(url + "managed-stop", { method: "POST" })).status,
    401,
  );
  assert.equal(
    (
      await fetch(url + "managed-stop", {
        method: "POST",
        headers: { authorization: "Bearer " + runtime.mcp_token },
      })
    ).status,
    401,
  );
  const entry = new URL(d.browserUrl);
  const bootstrap = await fetch(entry, { redirect: "manual" });
  const cookie = bootstrap.headers.get("set-cookie").split(";", 1)[0];
  const headers = { cookie };
  const responses = await Promise.all([
    fetch(url + "managed-stop", { method: "POST", headers }),
    fetch(url + "managed-stop", { method: "POST", headers }),
  ]);
  assert(responses.every((r) => r.status === 202));
  assert.equal(
    (await (await fetch(url + "managed-process", { headers })).json()).scope
      .status,
    "stopping",
  );
  let state;
  await waitFor(async () => {
    state = await (await fetch(url + "managed-process", { headers })).json();
    return state.scope.status === "exit_confirmed";
  });
  assert.equal(state.scope.remaining_count, 0);
  assert.equal(state.scope.confirmed, true);
  assert.equal(
    state.stages.filter((s) => s.stage === "kill" && s.phase === "request")
      .length,
    1,
  );
  const history = await RunHistory.open({
    id: "managed-harness",
    directory: d.directory,
  });
  assert.equal(
    (await history.inspect(state.run_id)).commands.filter(
      (c) => c.operation === "stop",
    ).length,
    1,
  );
  assert.equal(
    (await fetch(url + "stop", { method: "POST", headers })).status,
    401,
  );
  assert.equal(
    (await fetch(url + "stop", { method: "POST", headers: admin })).status,
    200,
  );
});

test("lost Harness monitor remains unverifiable in HTTP responses and administrator shutdown refuses to hide the uncertain result", async (t) => {
  const { root } = await setup(t),
    previous = process.env.RDSH_DASHBOARD_HOME;
  process.env.RDSH_DASHBOARD_HOME = path.join(root, "lost-home");
  t.after(() => {
    if (previous === undefined) delete process.env.RDSH_DASHBOARD_HOME;
    else process.env.RDSH_DASHBOARD_HOME = previous;
  });
  const probe = net.createServer();
  await new Promise((r) => probe.listen(0, "127.0.0.1", r));
  const port = probe.address().port;
  await new Promise((r) => probe.close(r));
  let h;
  const d = await startDashboard({
    kind: "harness",
    port,
    tailscale: false,
    observeHarness: (value) => {
      h = value;
    },
    harnessOptions: {
      cwd: root,
      command: [
        process.execPath,
        fixture,
        "root",
        "stubborn",
        path.join(root, "lost-tree.jsonl"),
      ],
      stopTimeout: 150,
    },
  });
  const runtime = JSON.parse(
      await fs.readFile(path.join(d.directory, "runtime.json"), "utf8"),
    ),
    headers = { authorization: "Bearer " + runtime.token },
    url = d.localUrl + "_rdsh/api/";
  h.disconnectMonitor();
  assert.equal(
    (await fetch(url + "managed-stop", { method: "POST", headers })).status,
    202,
  );
  await waitFor(
    async () =>
      (await (await fetch(url + "managed-process", { headers })).json()).scope
        .status === "unverifiable",
  );
  const response = await fetch(url + "stop", { method: "POST", headers });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).managed_stop.confirmed, false);
  assert.equal((await fetch(url + "managed-process", { headers })).status, 200);
  const history = await RunHistory.open({
    id: "managed-harness",
    directory: d.directory,
  });
  assert.equal(
    (await history.inspect(h.run_id)).scope_observation.status,
    "unverifiable",
  );
  assert((await fs.stat(path.join(d.directory, "server.lock"))).isFile());
  // Test teardown closes this exact HTTP server after the supervisor's owned cleanup;
  // it does not invoke a persisted PID or reconstruct a stop authority.
  await pause(1300);
  d.server.closeAllConnections();
  await new Promise((r) => d.server.close(r));
});
