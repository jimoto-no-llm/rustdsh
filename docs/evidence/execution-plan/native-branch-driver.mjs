import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { identity, ProjectStore } from "../../../dashboard/state.mjs";
import { SessionLedger } from "../../../dashboard/session-ledger.mjs";
import { ExecutionPlans } from "../../../dashboard/execution-plan.mjs";
import { preparePlanAttachment } from "../../../dashboard/plan-runtime.mjs";
const exec = promisify(execFile),
  root = await fs.mkdtemp(path.join(os.tmpdir(), "rdsh-plan-branch-")),
  cwd = path.join(root, "project");
await fs.mkdir(cwd);
let attachment;
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
try {
  await exec("git", ["-C", cwd, "init", "-b", "branch-probe"], { env });
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
  const file = fileURLToPath(
    new URL("./native-branch-runner.mjs", import.meta.url),
  );
  const ledger = await SessionLedger.open(project),
    draft = await ledger.record({
      command: [process.execPath, file],
      cwd,
      env,
    }),
    record = await ledger.confirm(draft.run_id, "native-root", "0.2.0-rc.2"),
    state = await ProjectStore.open(project),
    plans = ExecutionPlans.open(project);
  for (const id of ["parent", "nested"])
    await state.mutate("task", { id, title: id, status: "todo" });
  await plans.define({
    plan_id: "nested-plan",
    run_id: record.run_id,
    nodes: [
      { task_id: "parent", parent_task_id: null, depends_on: [] },
      { task_id: "nested", parent_task_id: "parent", depends_on: [] },
    ],
    limits: {
      max_concurrent: 2,
      max_depth: 2,
      max_starts: 2,
      stop_at: new Date(Date.now() + 3600000).toISOString(),
      stop_on_failure: true,
    },
  });
  await plans.enforce("nested-plan", record);
  attachment = await preparePlanAttachment(project, record, env);
  const result = JSON.parse(
      (
        await exec(process.execPath, [file], {
          cwd,
          env: attachment.env,
          windowsHide: true,
          timeout: 15000,
        })
      ).stdout,
    ),
    book = await plans.read();
  assert.equal(result.outcome.stopReason, "completed");
  assert.equal(result.nestedOutcome.stopReason, "completed");
  assert.equal(result.dispatches.length, 2);
  assert.equal(result.disposals.length, 2);
  assert.deepEqual(
    book.claims.map((c) => c.native_depth),
    [1, 2],
  );
  assert.ok(book.claims.every((c) => c.phase === "finished"));
  console.log(
    JSON.stringify(
      {
        result: "PASS",
        scope:
          "original nested Workflow and SubagentRuntime; synthetic spawn factory/transport; no actual models or profile boot",
        native_depths: book.claims.map((c) => c.native_depth),
        phases: book.claims.map((c) => c.phase),
        parent_correlations_match:
          book.claims[1].parent_session_id === book.claims[0].child_session_id,
        native_result: result,
        source_head: process.env.RDSH_QA_SOURCE_HEAD || null,
      },
      null,
      2,
    ),
  );
} finally {
  await attachment?.close();
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(root).startsWith("rdsh-plan-branch-"));
  await fs.rm(root, { recursive: true });
}
