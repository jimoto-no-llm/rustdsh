import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { ProjectStore, identity } from "../state.mjs";
import { ExecutionPlans, graphProblems } from "../execution-plan.mjs";
import { AcceptanceStore } from "../acceptance.mjs";
import { nativePlanBoundary } from "../plan-runtime.mjs";
import { startDashboard } from "../server.mjs";
import net from "node:net";

const exec = promisify(execFile),
  fail = (code) => (e) => e.code === code;
export async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rdsh-plan-test-")),
    cwd = path.join(root, "project");
  await fs.mkdir(cwd);
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k]) =>
      /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|TEMP|TMP|COMSPEC|LANG|LC_ALL)$/i.test(
        k,
      ),
    ),
  );
  Object.assign(env, {
    HOME: root,
    USERPROFILE: root,
    DSH_HOME: path.join(root, "dsh"),
    RDSH_DASHBOARD_HOME: path.join(root, "dashboard"),
    GIT_CEILING_DIRECTORIES: root,
  });
  await fs.writeFile(
    path.join(cwd, "module.mjs"),
    "export const answer = 1;\n",
  );
  await fs.writeFile(
    path.join(cwd, "check.mjs"),
    "import {answer} from './module.mjs'; if(answer!==1) process.exit(1);\n",
  );
  await exec("git", ["-C", cwd, "init", "-b", "plan-qa"], { env });
  await exec("git", ["-C", cwd, "add", "--", "module.mjs", "check.mjs"], {
    env,
  });
  await exec(
    "git",
    [
      "-C",
      cwd,
      "-c",
      "user.name=Plan Fixture",
      "-c",
      "user.email=plan@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      "Fixture",
    ],
    { env },
  );
  const project = await identity(cwd);
  project.directory = path.join(root, "dashboard", "projects", project.id);
  const state = await ProjectStore.open(project);
  for (const id of ["a", "b", "c", "nested"])
    await state.mutate("task", { id, title: "Task " + id, status: "todo" });
  const plans = ExecutionPlans.open(project),
    acceptance = await AcceptanceStore.open(project);
  const definition = {
    plan_id: "plan-qa",
    run_id: "run-qa",
    nodes: [
      { task_id: "a", depends_on: [], parent_task_id: null },
      { task_id: "b", depends_on: ["a"], parent_task_id: null },
      { task_id: "c", depends_on: [], parent_task_id: null },
      { task_id: "nested", depends_on: [], parent_task_id: "a" },
    ],
    limits: {
      max_concurrent: 2,
      max_depth: 2,
      max_starts: 4,
      stop_at: new Date(Date.now() + 3600000).toISOString(),
      stop_on_failure: true,
    },
  };
  const record = {
    binding: "confirmed",
    run_id: "run-qa",
    cli: "dsh",
    cli_version: "0.2.0-rc.2",
    cli_session_id: "native-root",
    cwd,
  };
  const bind = async (changes = {}) => {
    await plans.define({ ...definition, ...changes });
    return plans.enforce(definition.plan_id, record);
  };
  const complete = async (id = "a", scope = "full") => {
    await state.mutate("task", { id, title: "Task " + id, status: "done" });
    await acceptance.define(id, [
      {
        id: "result",
        description: "Module returns required result",
        inputs: ["module.mjs", "check.mjs"],
      },
    ]);
    return acceptance.perform({
      task_id: id,
      criterion_id: "result",
      argv: [process.execPath, "check.mjs"],
      scope,
      timeout_ms: 5000,
    });
  };
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("rdsh-plan-test-"));
    await fs.rm(root, { recursive: true });
  });
  return {
    root,
    cwd,
    env,
    project,
    state,
    plans,
    acceptance,
    definition,
    record,
    bind,
    complete,
  };
}
test("draft graph exposes unknown dependencies, cycles and branch depth; enforce refuses before start", async (t) => {
  const f = await setup(t);
  const def = {
    ...f.definition,
    nodes: [
      { task_id: "a", depends_on: ["b", "missing"], parent_task_id: null },
      { task_id: "b", depends_on: ["a"], parent_task_id: "a" },
      { task_id: "c", depends_on: [], parent_task_id: "b" },
    ],
  };
  await f.plans.define(def);
  const view = await f.plans.inspect("plan-qa");
  assert.ok(
    view.plans[0].preflight.some(
      (p) => p.code === "unknown_dependency" && p.related_task_id === "missing",
    ),
  );
  assert.ok(view.plans[0].preflight.some((p) => p.code === "dependency_cycle"));
  assert.ok(
    view.plans[0].preflight.some((p) => p.code === "branch_depth_limit"),
  );
  await assert.rejects(
    f.plans.enforce("plan-qa", f.record),
    fail("plan_graph_invalid"),
  );
  assert.equal((await f.plans.read()).claims.length, 0);
  assert.ok(
    graphProblems(
      {
        ...def,
        nodes: [{ task_id: "a", depends_on: [], parent_task_id: "a" }],
      },
      new Set(["a"]),
    ).some((p) => p.code === "branch_cycle"),
  );
});
test("reported done, reported pass, partial checks and stale code cannot open dependencies", async (t) => {
  const f = await setup(t),
    binding = await f.bind();
  const admit = () =>
    f.plans.admit("plan-qa", binding.context_hash, {
      task_id: "b",
      parent_session_id: "native-root",
      native_depth: 1,
    });
  await f.state.mutate("task", { id: "a", title: "Task a", status: "done" });
  await assert.rejects(admit(), fail("prerequisite_unverified"));
  await f.acceptance.define("a", [
    {
      id: "result",
      description: "Reported only",
      inputs: ["module.mjs", "check.mjs"],
    },
  ]);
  await f.acceptance.perform({
    task_id: "a",
    criterion_id: "result",
    reported: { status: "pass", reason: "Fixture report" },
  });
  await assert.rejects(admit(), fail("prerequisite_unverified"));
  await f.complete("a", "partial");
  await assert.rejects(admit(), fail("prerequisite_unverified"));
  await f.complete();
  await fs.writeFile(
    path.join(f.cwd, "module.mjs"),
    "export const answer = 2;\n",
  );
  await assert.rejects(admit(), fail("prerequisite_unverified"));
  await fs.writeFile(
    path.join(f.cwd, "module.mjs"),
    "export const answer = 1;\n",
  );
  const c = await admit();
  assert.equal(c.prerequisites[0].task_id, "a");
  assert.equal(c.prerequisites[0].evidence_ids.length, 1);
});
test("verified checks do not unlock a prerequisite whose native claim is still held", async (t) => {
  const f = await setup(t),
    binding = await f.bind(),
    a = await f.plans.admit("plan-qa", binding.context_hash, {
      task_id: "a",
      parent_session_id: "native-root",
      native_depth: 1,
    });
  await f.plans.update(a.claim_id, "started", "native-a");
  await f.complete();
  const next = () =>
    f.plans.admit("plan-qa", binding.context_hash, {
      task_id: "b",
      parent_session_id: "native-root",
      native_depth: 1,
    });
  await assert.rejects(next(), fail("prerequisite_unverified"));
  await f.plans.update(a.claim_id, "outcome", "completed");
  await f.plans.update(a.claim_id, "disposed");
  assert.equal((await next()).task_id, "b");
});
test("duplicate starts are rejected across processes before either native factory can run", async (t) => {
  const f = await setup(t),
    binding = await f.bind();
  const payload = {
      project: f.project,
      id: "plan-qa",
      hash: binding.context_hash,
      request: {
        task_id: "a",
        parent_session_id: "native-root",
        native_depth: 1,
      },
    },
    file = path.join(f.root, "claim.json");
  await fs.writeFile(file, JSON.stringify(payload));
  const child = fileURLToPath(
    new URL("./fixtures/plan-claim.mjs", import.meta.url),
  );
  const results = await Promise.all(
    [0, 1].map(() =>
      exec(process.execPath, [child, file], {
        env: f.env,
        windowsHide: true,
      }).then((r) => JSON.parse(r.stdout)),
    ),
  );
  assert.equal(results.filter((r) => r.allowed).length, 1);
  assert.ok(results.some((r) => r.reason === "task_already_claimed"));
  assert.equal((await f.plans.read()).claims.length, 1);
});
test("concurrency, explicit parent, native depth, total starts and operator stop gate native admissions", async (t) => {
  const f = await setup(t),
    binding = await f.bind(),
    req = (task_id, extra = {}) => ({
      task_id,
      parent_session_id: "native-root",
      native_depth: 1,
      ...extra,
    }),
    admit = (r) => f.plans.admit("plan-qa", binding.context_hash, r);
  await assert.rejects(admit(req("nested")), fail("branch_parent_mismatch"));
  await assert.rejects(
    admit(req("a", { native_depth: 3 })),
    fail("native_depth_limit"),
  );
  const a = await admit(req("a")),
    c = await admit(req("c"));
  await f.plans.update(a.claim_id, "started", "native-a");
  await assert.rejects(
    admit(req("nested", { parent_session_id: "native-a", native_depth: 2 })),
    fail("concurrency_limit"),
  );
  await f.plans.update(c.claim_id, "started", "native-c");
  await f.plans.update(c.claim_id, "outcome", "completed");
  await f.plans.update(c.claim_id, "disposed");
  const nested = await admit(
    req("nested", { parent_session_id: "native-a", native_depth: 2 }),
  );
  assert.equal(nested.native_depth, 2);
  await f.plans.stop("plan-qa");
  await assert.rejects(
    f.plans.beforeDispatch(nested),
    fail("operator_stopped"),
  );
  await assert.rejects(admit(req("b")), fail("operator_stopped"));
});
test("total-start cap and expiry apply even when no child is active", async (t) => {
  const f = await setup(t),
    binding = await f.bind({
      limits: { ...f.definition.limits, max_starts: 1 },
    });
  const a = await f.plans.admit("plan-qa", binding.context_hash, {
    task_id: "a",
    parent_session_id: "native-root",
    native_depth: 1,
  });
  await f.plans.update(a.claim_id, "started", "native-a");
  await f.plans.update(a.claim_id, "outcome", "completed");
  await f.plans.update(a.claim_id, "disposed");
  await assert.rejects(
    f.plans.admit("plan-qa", binding.context_hash, {
      task_id: "c",
      parent_session_id: "native-root",
      native_depth: 1,
    }),
    fail("total_start_limit"),
  );
  const v = await f.plans.read();
  assert.equal(v.claims[0].phase, "finished");
  // Deadline is immutable in normal use; a separately defined expired draft cannot enable.
  await f.plans.define({
    ...f.definition,
    plan_id: "expired",
    limits: {
      ...f.definition.limits,
      stop_at: new Date(Date.now() - 1000).toISOString(),
    },
  });
  await assert.rejects(
    f.plans.enforce("expired", { ...f.record, run_id: "run-qa" }),
    fail("plan_expired"),
  );
});
test("native failure holds capacity and blocks replay; completed output alone is not acceptance", async (t) => {
  const f = await setup(t),
    binding = await f.bind(),
    guard = nativePlanBoundary(f.plans, binding),
    parent = { session: { id: "native-root" } },
    signal = new AbortController().signal,
    provider = guard.register({});
  let dispatches = 0;
  await assert.rejects(
    guard.subagent({ parent, signal }, 1, () => {
      dispatches++;
    }),
    fail("explicit_workflow_task_required"),
  );
  await assert.rejects(
    guard.child("a", parent, () =>
      guard.subagent(
        { parent, signal },
        1,
        () => {
          dispatches++;
          throw new Error("startup unknown");
        },
        provider,
      ),
    ),
    /startup unknown/,
  );
  assert.equal(dispatches, 1);
  const book = await f.plans.read();
  assert.equal(book.claims[0].phase, "unknown");
  await assert.rejects(
    guard.child("c", parent, () =>
      guard.subagent(
        { parent, signal },
        1,
        () => {
          dispatches++;
        },
        provider,
      ),
    ),
    fail("child_failed_or_unconfirmed"),
  );
  assert.equal(dispatches, 1);
});
test("read-only HTTP is human scoped, stop persists, and agent cannot mutate the plan", async (t) => {
  const f = await setup(t);
  await f.bind();
  const portProbe = net.createServer();
  await new Promise((resolve) => portProbe.listen(0, "127.0.0.1", resolve));
  const port = portProbe.address().port;
  await new Promise((resolve) => portProbe.close(resolve));
  const server = await startDashboard({
    project: f.project,
    tailscale: false,
    port,
  });
  t.after(() => server.close());
  const info = JSON.parse(
      await fs.readFile(path.join(f.project.directory, "runtime.json"), "utf8"),
    ),
    url = `http://127.0.0.1:${port}`;
  const admin = { authorization: "Bearer " + info.token };
  assert.equal((await fetch(url + "/api/plans")).status, 401);
  assert.equal(
    (
      await fetch(url + "/api/plans", {
        headers: { authorization: "Bearer " + info.mcp_token },
      })
    ).status,
    401,
  );
  const get = await fetch(url + "/api/plans", { headers: admin });
  assert.equal(get.status, 200);
  const stop = await fetch(url + "/api/plans/stop", {
    method: "POST",
    headers: { ...admin, origin: url, "content-type": "application/json" },
    body: JSON.stringify({ plan_id: "plan-qa" }),
  });
  assert.equal(stop.status, 200);
  assert.equal((await stop.json()).plans[0].stop_reason, "operator_stopped");
});
test("unknown schema and stale writer locks preserve state and never dispatch", async (t) => {
  const f = await setup(t);
  await f.bind();
  const original = await fs.readFile(f.plans.index);
  await fs.writeFile(f.plans.index, JSON.stringify({ schema: 99 }));
  await assert.rejects(f.plans.read(), fail("plan_state_invalid"));
  assert.equal(JSON.parse(await fs.readFile(f.plans.index)).schema, 99);
  await fs.writeFile(f.plans.index, original);
  await fs.writeFile(
    path.join(f.plans.directory, "writer.lock"),
    "other-owner",
  );
  await assert.rejects(f.plans.stop("plan-qa"), fail("plan_busy"));
  assert.equal(
    await fs.readFile(path.join(f.plans.directory, "writer.lock"), "utf8"),
    "other-owner",
  );
});
test("CLI defines and inspects drafts without starting a CLI or accepting misplaced options", async (t) => {
  const f = await setup(t),
    cli = fileURLToPath(new URL("../cli.mjs", import.meta.url)),
    file = path.join(f.root, "plan.json");
  await fs.writeFile(file, JSON.stringify(f.definition));
  const run = (args) =>
    exec(process.execPath, [cli, "plan", ...args, "--project", f.cwd], {
      env: f.env,
      windowsHide: true,
    });
  assert.equal(
    JSON.parse((await run(["define", "--input-file", file])).stdout).definition
      .plan_id,
    "plan-qa",
  );
  assert.equal(
    JSON.parse((await run(["inspect", "--plan-id", "plan-qa"])).stdout).plans[0]
      .stop_reason,
    "plan_not_enabled",
  );
  await assert.rejects(
    run(["enforce", "--plan-id", "plan-qa", "--run-id", "missing-run"]),
  );
  await assert.rejects(run(["inspect", "--executable", process.execPath]));
  await assert.rejects(
    exec(
      process.execPath,
      [cli, "diagnostics", "--project", f.cwd, "--plan-id", "plan-qa"],
      { env: f.env, windowsHide: true },
    ),
  );
  assert.equal((await f.plans.read()).claims.length, 0);
});
test("stop during prerequisite I/O and a changed native parent block the final dispatch", async (t) => {
  const f = await setup(t),
    binding = await f.bind(),
    request = {
      task_id: "a",
      parent_session_id: "native-root",
      native_depth: 1,
    },
    a = await f.plans.admit("plan-qa", binding.context_hash, request);
  f.plans.prerequisites = async () => {
    await f.plans.stop("plan-qa");
    return { blockers: [], receipts: [] };
  };
  await assert.rejects(f.plans.beforeDispatch(a), fail("operator_stopped"));
  const g = await setup(t),
    otherBinding = await g.bind(),
    guard = nativePlanBoundary(g.plans, otherBinding),
    parent = { session: { id: "native-root" } },
    provider = guard.register({});
  let starts = 0;
  const original = g.plans.beforeDispatch.bind(g.plans);
  g.plans.beforeDispatch = async (claim) => {
    await original(claim);
    parent.session.id = "another-parent";
  };
  await assert.rejects(
    guard.child("a", parent, () =>
      guard.subagent(
        { parent },
        1,
        () => {
          starts++;
        },
        provider,
      ),
    ),
    fail("native_context_changed_before_start"),
  );
  assert.equal(starts, 0);
  assert.equal((await g.plans.read()).claims[0].phase, "finished");
});
