// Optional original Workflow admission benchmark, synthetic provider, no models.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { identity, ProjectStore } from "../../dashboard/state.mjs";
import { SessionLedger } from "../../dashboard/session-ledger.mjs";
import { ExecutionPlans } from "../../dashboard/execution-plan.mjs";
import { preparePlanAttachment } from "../../dashboard/plan-runtime.mjs";
import assert from "node:assert/strict";
const exec = promisify(execFile),
  count = 20,
  root = await fs.mkdtemp(path.join(os.tmpdir(), "rdsh-plan-benchmark-")),
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
const fixture = fileURLToPath(
  new URL("../../tests/fixtures/plan-native.mjs", import.meta.url),
);
let attachment;
try {
  await exec("git", ["-C", cwd, "init", "-b", "plan-benchmark"], { env });
  await exec(
    "git",
    [
      "-C",
      cwd,
      "-c",
      "user.name=Plan Benchmark",
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
      command: [process.execPath, fixture],
      cwd,
      env,
    }),
    record = await ledger.confirm(draft.run_id, "native-root", "0.2.0-rc.2"),
    store = await ProjectStore.open(project),
    plans = ExecutionPlans.open(project),
    ids = Array.from({ length: count }, (_, i) => "bench-" + i);
  for (const id of ids)
    await store.mutate("task", { id, title: id, status: "todo" });
  await plans.define({
    plan_id: "benchmark",
    run_id: record.run_id,
    nodes: ids.map((id) => ({
      task_id: id,
      depends_on: [],
      parent_task_id: null,
    })),
    limits: {
      max_concurrent: 2,
      max_depth: 2,
      max_starts: count,
      stop_at: new Date(Date.now() + 3600000).toISOString(),
      stop_on_failure: true,
    },
  });
  await plans.enforce("benchmark", record);
  attachment = await preparePlanAttachment(project, record, env);
  const run = async (guarded) =>
    JSON.parse(
      (
        await exec(process.execPath, [fixture], {
          cwd,
          windowsHide: true,
          timeout: 60000,
          maxBuffer: 1024 * 1024,
          env: {
            ...(guarded ? attachment.env : env),
            RDSH_TEST_PLAN_ITERATIONS: String(count),
            RDSH_TEST_PLAN_SCRIPT: guarded
              ? 'return await agent("fixture", {rdshTaskId:args.taskId});'
              : 'return await agent("fixture", {});',
          },
        })
      ).stdout,
    );
  const summarize = (value) => {
    assert.equal(value.outcome.stopReason, "completed");
    assert.equal(value.dispatches.length, count);
    assert.equal(value.disposals.length, count);
    const timings = [...value.timings_ms].sort((a, b) => a - b);
    return {
      count,
      median_ms: timings[Math.floor(count / 2)],
      p95_ms: timings[Math.ceil(count * 0.95) - 1],
      total_ms: timings.reduce((a, b) => a + b, 0),
    };
  };
  const before = summarize(await run(false)),
    after = summarize(await run(true));
  console.log(
    JSON.stringify(
      {
        schema: 1,
        platform: process.platform,
        node: process.version,
        scope:
          "20 original Workflow start/result/disposal operations; synthetic provider with 5ms delay; no dependencies/acceptance criteria; Node boot excluded, guest parsing and durable local audit included; no network/inference claim",
        before,
        after,
        added_median_ms: after.median_ms - before.median_ms,
        source_head: process.env.RDSH_QA_SOURCE_HEAD || null,
      },
      null,
      2,
    ),
  );
} finally {
  await attachment?.close();
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(root).startsWith("rdsh-plan-benchmark-"));
  await fs.rm(root, { recursive: true });
}
