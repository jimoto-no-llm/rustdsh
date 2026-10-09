import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { identity, ProjectStore } from "../dashboard/state.mjs";
import {
  SessionLedger,
  attachRecordedSession,
} from "../dashboard/session-ledger.mjs";
import { ExecutionPlans } from "../dashboard/execution-plan.mjs";
import { preparePlanAttachment } from "../dashboard/plan-runtime.mjs";
import {
  guardedPlanSource,
  planRuntimeHashes,
} from "../dashboard/plan-runtime-source.mjs";

if (!process.env.RDSH_TEST_PLAN_PACKAGE)
  throw new Error(
    "Set RDSH_TEST_PLAN_PACKAGE to isolated native dependencies package.json",
  );
const require = createRequire(path.resolve(process.env.RDSH_TEST_PLAN_PACKAGE)),
  exec = promisify(execFile),
  fixture = fileURLToPath(
    new URL("./fixtures/plan-native.mjs", import.meta.url),
  );
const sources = new Map();
for (const pkg of Object.keys(planRuntimeHashes)) {
  const file = require.resolve("@deepseek-ai/" + pkg),
    source = await fs.readFile(file, "utf8");
  sources.set(file, source);
  assert.equal(
    createHash("sha256").update(source).digest("hex"),
    planRuntimeHashes[pkg],
  );
}
async function setup(t, limits = {}, entrypoint = fixture) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rdsh-plan-native-")),
    cwd = path.join(root, "project");
  await fs.mkdir(cwd);
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k]) =>
      /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|TEMP|TMP|COMSPEC|LANG|LC_ALL|RDSH_TEST_PLAN_PACKAGE)$/i.test(
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
  await exec("git", ["-C", cwd, "init", "-b", "native-plan-qa"], { env });
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
      "--allow-empty",
      "-m",
      "Fixture",
    ],
    { env },
  );
  const project = await identity(cwd);
  project.directory = path.join(root, "dashboard", "projects", project.id);
  const ledger = await SessionLedger.open(project),
    draft = await ledger.record({
      command: [process.execPath, entrypoint],
      cwd,
      env,
    }),
    record = await ledger.confirm(draft.run_id, "native-root", "0.2.0-rc.2"),
    plans = ExecutionPlans.open(project),
    state = await ProjectStore.open(project);
  for (const id of ["a", "b", "c", "d"])
    await state.mutate("task", {
      id,
      title: "Native task " + id,
      status: "todo",
    });
  await plans.define({
    plan_id: "native-plan",
    run_id: record.run_id,
    nodes: ["a", "b", "c", "d"].map((id) => ({
      task_id: id,
      parent_task_id: null,
      depends_on: id === "b" ? ["a"] : [],
    })),
    limits: {
      max_concurrent: 2,
      max_depth: 2,
      max_starts: 4,
      stop_at: new Date(Date.now() + 3600000).toISOString(),
      stop_on_failure: true,
      ...limits,
    },
  });
  await plans.enforce("native-plan", record);
  const attachment = await preparePlanAttachment(project, record, env);
  t.after(async () => {
    await attachment.close();
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("rdsh-plan-native-"));
    await fs.rm(root, { recursive: true });
    for (const [file, source] of sources)
      assert.equal(await fs.readFile(file, "utf8"), source);
  });
  const invoke = async (
    scenario = "match",
    script = undefined,
    guarded = true,
  ) => {
    const task = exec(process.execPath, [fixture], {
      cwd,
      windowsHide: true,
      timeout: 15000,
      maxBuffer: 1024 * 1024,
      env: {
        ...(guarded ? attachment.env : env),
        RDSH_TEST_PLAN_SCENARIO: scenario,
        ...(script === undefined ? {} : { RDSH_TEST_PLAN_SCRIPT: script }),
      },
    });
    const pid = task.child.pid,
      { stdout, stderr } = await task;
    assert.equal(stderr, "");
    if (guarded) await attachment.ready({ child: { pid }, stopped: false });
    return JSON.parse(stdout);
  };
  return {
    invoke,
    plans,
    state,
    project,
    record,
    root,
    attachment,
    ledger,
    cwd,
    env,
  };
}
test("audited source rejects changed bytes and leaves original packages intact", async (t) => {
  for (const pkg of Object.keys(planRuntimeHashes)) {
    const source = await fs.readFile(
      require.resolve("@deepseek-ai/" + pkg),
      "utf8",
    );
    assert.throws(
      () => guardedPlanSource(pkg, source + "\n"),
      /unsupported source/,
    );
  }
  const f = await setup(t),
    before = await f.invoke(
      "match",
      'return await agent("fixture", {});',
      false,
    ),
    after = await f.invoke();
  assert.equal(before.outcome.stopReason, "completed");
  assert.equal(before.dispatches.length, 1);
  assert.equal(after.outcome.stopReason, "completed");
  assert.equal(after.dispatches.length, 1);
  const v = await f.plans.read();
  assert.equal(v.claims[0].phase, "finished");
  assert.equal(v.claims[0].child_session_id, after.dispatches[0].id);
  assert.equal(v.claims[0].outcome, "completed");
});
test("native Workflow result and task done alone do not start a dependent child", async (t) => {
  const f = await setup(t);
  await f.invoke();
  await f.state.mutate("task", {
    id: "a",
    title: "Native task a",
    status: "done",
  });
  const result = await f.invoke(
    "match",
    'return await agent("fixture", {rdshTaskId:"b"});',
  );
  assert.equal(result.dispatches.length, 0);
  assert.equal(result.outcome.stopReason, "error");
  assert.match(result.outcome.error, /prerequisite_unverified/);
});
test("native parallel children cannot exceed durable concurrency", async (t) => {
  const f = await setup(t),
    result = await f.invoke(
      "concurrent-held",
      'return await parallel([() => agent("one", {rdshTaskId:"a"}), () => agent("two", {rdshTaskId:"c"}), () => agent("three", {rdshTaskId:"d"})]);',
    );
  assert.equal(result.dispatches.length, 2);
  assert.equal(result.maximum_active, 2);
  assert.equal(result.outcome.stopReason, "error");
  assert.match(result.outcome.error, /concurrency_limit/);
  assert.equal(result.disposals.length, result.dispatches.length);
});
test("native duplicate and undeclared task starts are refused before provider", async (t) => {
  const f = await setup(t),
    result = await f.invoke(
      "concurrent",
      'return await parallel([() => agent("same", {rdshTaskId:"a"}), () => agent("same", {rdshTaskId:"a"})]);',
    );
  assert.equal(result.dispatches.length, 1);
  assert.match(result.outcome.error, /task_already_claimed/);
  const unknown = await f.invoke(
    "match",
    'return await agent("different", {rdshTaskId:"undeclared"});',
  );
  assert.equal(unknown.dispatches.length, 0);
  assert.match(unknown.outcome.error, /undeclared_task/);
});
test("missing metadata, direct subagent and continuable entry points fail closed", async (t) => {
  const f = await setup(t);
  for (const scenario of ["direct", "continuable"]) {
    const r = await f.invoke(scenario);
    assert.equal(r.dispatches.length, 0);
    assert.equal(r.error.code, "explicit_workflow_task_required");
  }
  for (const script of [
    'return await agent("fixture");',
    'return await agent("fixture", {});',
  ]) {
    const r = await f.invoke("match", script);
    assert.equal(r.dispatches.length, 0);
    assert.match(r.outcome.error, /explicit rdshTaskId/);
  }
});
test("providers outside the audited in-process spawn seam are rejected before factory", async (t) => {
  const f = await setup(t),
    result = await f.invoke("external");
  assert.equal(result.dispatches.length, 0);
  assert.match(result.outcome.error, /in_process_provider_required/);
});
test("persisted native delegation depth and parent identity are checked before start", async (t) => {
  const f = await setup(t),
    depth = await f.invoke("depth"),
    parent = await f.invoke("wrong-parent");
  assert.equal(depth.dispatches.length, 0);
  assert.match(depth.outcome.error, /native_depth_limit/);
  assert.equal(parent.dispatches.length, 0);
  assert.match(parent.outcome.error, /workflow_parent_unconfirmed/);
});
test("native failure stops further starts and failed disposal keeps a held claim", async (t) => {
  const f = await setup(t),
    result = await f.invoke(
      "child-error",
      'await agent("one", {rdshTaskId:"a"}); return await agent("two", {rdshTaskId:"c"});',
    );
  assert.equal(result.dispatches.length, 1);
  assert.match(result.outcome.error, /child_failed_or_unconfirmed/);
  const g = await setup(t),
    disposal = await g.invoke("dispose-error");
  assert.equal(disposal.dispatches.length, 1);
  assert.equal((await g.plans.read()).claims[0].phase, "unknown");
});
test("deadline is checked after guest body begins and before native provider dispatch", async (t) => {
  const f = await setup(t, {
      stop_at: new Date(Date.now() + 1600).toISOString(),
    }),
    result = await f.invoke(
      "match",
      'const until = Date.now() + 1700; while (Date.now() < until) {} return await agent("fixture", {rdshTaskId:"a"});',
    );
  assert.equal(result.dispatches.length, 0);
  assert.match(result.outcome.error, /plan_expired/);
});
test("native cancellation preserves the Workflow disposal lifecycle", async (t) => {
  const f = await setup(t),
    result = await f.invoke("hold");
  assert.equal(result.dispatches.length, 1);
  assert.equal(result.disposals.length, 1);
  assert.equal(result.outcome.stopReason, "cancelled");
  assert.equal((await f.plans.read()).claims[0].phase, "finished");
});
test("tracked ACP resume attaches the guard before send and leaves default process behavior unchanged", async (t) => {
  const acp = fileURLToPath(
      new URL("./fixtures/plan-native-acp.mjs", import.meta.url),
    ),
    f = await setup(t, {}, acp);
  const trace = path.join(f.root, "dispatches.json"),
    attached = await attachRecordedSession({
      ledger: f.ledger,
      run_id: f.record.run_id,
      command: [process.execPath, acp],
      env: { ...f.env, RDSH_TEST_PLAN_TRACE: trace },
      requestTimeout: 5000,
      stopTimeout: 1000,
    });
  try {
    assert.equal(
      attached.adapter.capabilities().plan_enforcement.status,
      "native_workflow_admission_loaded",
    );
    await attached.adapter.send(
      attached.record.cli_session_id,
      "fixture prompt",
    );
    assert.equal(JSON.parse(await fs.readFile(trace, "utf8")).length, 1);
    await assert.rejects(
      attached.adapter.send(
        attached.record.cli_session_id,
        "duplicate fixture prompt",
      ),
    );
    assert.equal(JSON.parse(await fs.readFile(trace, "utf8")).length, 1);
  } finally {
    await attached.adapter.stop();
  }
});
test("losing the bound index blocks attachment rather than resuming without enforcement", async (t) => {
  const f = await setup(t);
  await fs.unlink(f.plans.index);
  await assert.rejects(
    preparePlanAttachment(f.project, f.record, f.env),
    (e) => e.code === "plan_required_state_unconfirmed",
  );
});
