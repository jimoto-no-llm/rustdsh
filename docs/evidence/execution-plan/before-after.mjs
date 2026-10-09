// Actual native outputs; original services, synthetic provider/PTC transport.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { identity, ProjectStore } from "../../../dashboard/state.mjs";
import { SessionLedger } from "../../../dashboard/session-ledger.mjs";
import { ExecutionPlans } from "../../../dashboard/execution-plan.mjs";
import { preparePlanAttachment } from "../../../dashboard/plan-runtime.mjs";

const exec = promisify(execFile);
const fixture = fileURLToPath(
  new URL("../../../tests/fixtures/plan-native.mjs", import.meta.url),
);
const sourceHead = process.env.RDSH_QA_SOURCE_HEAD || null;
const repeated =
  'return await parallel([() => agent("same", {rdshTaskId:"a"}), () => agent("same", {rdshTaskId:"a"})]);';
const dependent = 'return await agent("dependent", {rdshTaskId:"b"});';

async function capture(guarded, script, completeParent = false) {
  // rdshTaskId is the explicit opt-in extension; original guests use {}.
  const invokedScript = guarded
    ? script
    : script
        .replaceAll('{rdshTaskId:"a"}', "{}")
        .replaceAll('{rdshTaskId:"b"}', "{}");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rdsh-plan-output-"));
  const cwd = path.join(root, "project");
  await fs.mkdir(cwd);
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) =>
      /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|TEMP|TMP|COMSPEC|LANG|LC_ALL|RDSH_TEST_PLAN_PACKAGE)$/i.test(
        key,
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
  let attachment;
  try {
    await exec("git", ["-C", cwd, "init", "-b", "output-fixture"], { env });
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
    const ledger = await SessionLedger.open(project);
    const draft = await ledger.record({
      command: [process.execPath, fixture],
      cwd,
      env,
    });
    const record = await ledger.confirm(
      draft.run_id,
      "native-root",
      "0.2.0-rc.2",
    );
    const state = await ProjectStore.open(project),
      plans = ExecutionPlans.open(project);
    for (const id of ["a", "b"])
      await state.mutate("task", { id, title: id, status: "todo" });
    if (guarded) {
      await plans.define({
        plan_id: "output-plan",
        run_id: record.run_id,
        nodes: [
          { task_id: "a", depends_on: [], parent_task_id: null },
          { task_id: "b", depends_on: ["a"], parent_task_id: null },
        ],
        limits: {
          max_concurrent: 2,
          max_depth: 2,
          max_starts: 2,
          stop_at: new Date(Date.now() + 3600000).toISOString(),
          stop_on_failure: true,
        },
      });
      await plans.enforce("output-plan", record);
      attachment = await preparePlanAttachment(project, record, env);
    }
    const invoke = async (body, scenario = "match") => {
      const promise = exec(process.execPath, [fixture], {
        cwd,
        windowsHide: true,
        timeout: 15000,
        env: {
          ...(attachment?.env || env),
          RDSH_TEST_PLAN_SCRIPT: body,
          RDSH_TEST_PLAN_SCENARIO: scenario,
        },
      });
      const pid = promise.child.pid,
        { stdout, stderr } = await promise;
      assert.equal(stderr, "");
      if (attachment)
        await attachment.ready({ child: { pid }, stopped: false });
      return JSON.parse(stdout);
    };
    let parentResult = null;
    if (completeParent) {
      parentResult = await invoke(
        'return await agent("parent", {rdshTaskId:"a"});',
      );
      assert.equal(parentResult.outcome.stopReason, "completed");
      await state.mutate("task", { id: "a", title: "a", status: "done" });
    }
    const result = await invoke(
      invokedScript,
      script === repeated ? "concurrent" : "match",
    );
    // These are original child outputs; no outcome is inferred from ledger state.
    return {
      workflow_script: invokedScript,
      parent_result: parentResult,
      native_output: result,
      claims: (await plans.read()).claims.map(
        ({ task_id, phase, outcome, native_depth }) => ({
          task_id,
          phase,
          outcome,
          native_depth,
        }),
      ),
    };
  } finally {
    await attachment?.close();
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("rdsh-plan-output-"));
    await fs.rm(root, { recursive: true });
  }
}

const beforeDuplicate = await capture(false, repeated);
const afterDuplicate = await capture(true, repeated);
const beforeDependency = await capture(false, dependent);
const afterDependency = await capture(true, dependent, true);
assert.equal(beforeDuplicate.native_output.dispatches.length, 2);
assert.equal(afterDuplicate.native_output.dispatches.length, 1);
assert.match(
  afterDuplicate.native_output.outcome.error,
  /task_already_claimed/,
);
assert.equal(beforeDependency.native_output.dispatches.length, 1);
assert.equal(afterDependency.native_output.dispatches.length, 0);
assert.match(
  afterDependency.native_output.outcome.error,
  /prerequisite_unverified/,
);
console.log(
  JSON.stringify(
    {
      schema: 1,
      result: "PASS",
      source_head: sourceHead,
      scope:
        "same original native Workflow/SubagentRuntime services, guard absent versus explicitly bound; synthetic provider and PTC transport, no actual models",
      duplicate: { before: beforeDuplicate, after: afterDuplicate },
      dependency: { before: beforeDependency, after: afterDependency },
    },
    null,
    2,
  ),
);
