import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ProjectStore, writeJson } from "../state.mjs";
import { startDashboard } from "../server.mjs";
import {
  acquireProjectIdentityLock,
  applyProjectMove,
  identity,
  previewProjectMove,
  rollbackProjectMove,
} from "../project-identity.mjs";

const cli = fileURLToPath(new URL("../cli.mjs", import.meta.url));

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rdsh-project-move-"));
  const previousHome = process.env.RDSH_DASHBOARD_HOME;
  process.env.RDSH_DASHBOARD_HOME = path.join(root, "dashboard-state");
  t.after(async () => {
    if (previousHome === undefined) delete process.env.RDSH_DASHBOARD_HOME;
    else process.env.RDSH_DASHBOARD_HOME = previousHome;
    await fs.rm(root, { recursive: true, force: true });
  });
  return root;
}

async function seedHistory(project) {
  const store = await ProjectStore.open(project);
  store.value.tasks.push({ id: "task-kept", title: "Keep this task" });
  store.value.questions.push({
    id: "question-kept",
    question: "Keep this answer?",
    answer: "Yes",
  });
  store.value.events.push({
    id: "evidence-kept",
    task_id: "task-kept",
    reference: "evidence://kept",
  });
  await writeJson(path.join(project.directory, "state.json"), store.value);
  return JSON.parse(
    await fs.readFile(path.join(project.directory, "state.json"), "utf8"),
  );
}

function runCli(args, home) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    env: { ...process.env, RDSH_DASHBOARD_HOME: home },
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

test("explicit move and rename preserve the same task, answer and evidence state", async (t) => {
  const root = await setup(t);
  const sourceRoot = path.join(root, "wsl-home", "old-name");
  const targetRoot = path.join(root, "windows-workspace", "new-name");
  await fs.mkdir(sourceRoot, { recursive: true });
  await fs.mkdir(path.dirname(targetRoot), { recursive: true });
  const source = await identity(sourceRoot);
  const before = await seedHistory(source);
  await fs.rename(sourceRoot, targetRoot);

  const preview = await previewProjectMove(targetRoot, source.id);
  assert.equal(preview.status, "ready");
  assert.equal(preview.source_revision, before.revision);
  assert.equal(preview.task_count, 1);
  assert.equal(preview.answered_question_count, 1);
  assert.notEqual(preview.target_default_id, source.id);
  const result = await applyProjectMove(
    targetRoot,
    source.id,
    preview.source_revision,
  );
  assert.equal(result.status, "applied");

  const moved = await identity(targetRoot);
  assert.equal(moved.id, source.id);
  const movedState = (await ProjectStore.open(moved)).value;
  assert.equal(
    await fs.realpath(movedState.project.root),
    await fs.realpath(targetRoot),
  );
  assert.deepEqual(movedState.tasks, before.tasks);
  assert.deepEqual(movedState.questions, before.questions);
  assert.deepEqual(movedState.events, before.events);
  const dashboard = await startDashboard({
    project: moved,
    port: await freePort(),
    tailscale: false,
  });
  try {
    assert.equal(dashboard.store.value.project.id, source.id);
    assert.equal(dashboard.store.value.tasks[0].id, "task-kept");
    assert.equal(dashboard.store.value.questions[0].answer, "Yes");
  } finally {
    await dashboard.close();
  }
  const unrelatedRoot = path.join(root, "other-project");
  await fs.mkdir(unrelatedRoot);
  const unrelated = await identity(unrelatedRoot);
  assert.notEqual(unrelated.id, moved.id);

  const repeated = await applyProjectMove(
    targetRoot,
    source.id,
    preview.source_revision,
  );
  assert.equal(repeated.status, "already_moved");
  assert.equal(repeated.migration_id, result.migration_id);
  const registry = JSON.parse(
    await fs.readFile(
      path.join(process.env.RDSH_DASHBOARD_HOME, "project-identities.json"),
      "utf8",
    ),
  );
  assert.equal(registry.migrations.length, 1);
  assert.deepEqual(
    JSON.parse(
      await fs.readFile(path.join(source.directory, "state.json"), "utf8"),
    ),
    before,
  );
});

test("move refuses an occupied destination and leaves its state byte-for-byte intact", async (t) => {
  const root = await setup(t);
  const sourceRoot = path.join(root, "old-project");
  const targetRoot = path.join(root, "new-project");
  await fs.mkdir(sourceRoot);
  await fs.mkdir(targetRoot);
  const source = await identity(sourceRoot);
  await seedHistory(source);
  const target = await identity(targetRoot);
  await seedHistory(target);
  const targetState = path.join(target.directory, "state.json");
  const before = await fs.readFile(targetState);

  await assert.rejects(
    previewProjectMove(targetRoot, source.id),
    /will not be overwritten or merged/,
  );
  assert.deepEqual(await fs.readFile(targetState), before);
  assert.equal((await identity(targetRoot)).id, target.id);
});

test("apply refuses a source revision that changed after preview", async (t) => {
  const root = await setup(t);
  const sourceRoot = path.join(root, "source");
  const targetRoot = path.join(root, "target");
  await fs.mkdir(sourceRoot);
  await fs.mkdir(targetRoot);
  const source = await identity(sourceRoot);
  await seedHistory(source);
  const preview = await previewProjectMove(targetRoot, source.id);
  const changed = await ProjectStore.open(source);
  changed.value.revision++;
  await writeJson(path.join(source.directory, "state.json"), changed.value);

  await assert.rejects(
    applyProjectMove(targetRoot, source.id, preview.source_revision),
    /history changed after preview/,
  );
  assert.notEqual((await identity(targetRoot)).id, source.id);
});

test("an interrupted cross-runtime identity lock can be reclaimed after its lease", async (t) => {
  await setup(t);
  await fs.mkdir(process.env.RDSH_DASHBOARD_HOME, { recursive: true });
  const lock = path.join(
    process.env.RDSH_DASHBOARD_HOME,
    "project-identity.lock",
  );
  await fs.writeFile(
    lock,
    JSON.stringify({
      pid: 123456789,
      platform: process.platform === "win32" ? "linux" : "win32",
      token: "12345678-1234-1234-1234-123456789abc",
      created_at_ms: Date.now() - 31_000,
    }),
  );
  const release = await acquireProjectIdentityLock();
  await release();
  await assert.rejects(fs.stat(lock), { code: "ENOENT" });
});

test("move preview detects live servers, and rollback removes only its mapping", async (t) => {
  const root = await setup(t);
  const sourceRoot = path.join(root, "source");
  const targetRoot = path.join(root, "renamed");
  await fs.mkdir(sourceRoot);
  await fs.mkdir(targetRoot);
  const source = await identity(sourceRoot);
  const before = await seedHistory(source);
  const lockFile = path.join(source.directory, "server.lock");
  await fs.writeFile(
    lockFile,
    JSON.stringify({ pid: process.pid, platform: process.platform, token: "test" }),
  );
  await assert.rejects(
    previewProjectMove(targetRoot, source.id),
    /Stop this project's dashboard/,
  );
  await fs.unlink(lockFile);
  await fs.writeFile(
    lockFile,
    JSON.stringify({
      pid: process.pid + 100000000,
      platform: process.platform === "win32" ? "linux" : "win32",
      token: "other-runtime",
    }),
  );
  await assert.rejects(
    previewProjectMove(targetRoot, source.id),
    /Stop this project's dashboard/,
  );
  await fs.unlink(lockFile);

  const preview = await previewProjectMove(targetRoot, source.id);
  const result = await applyProjectMove(
    targetRoot,
    source.id,
    preview.source_revision,
  );
  const rolledBack = await rollbackProjectMove(result.migration_id);
  assert.equal(rolledBack.status, "rolled_back");
  assert.notEqual((await identity(targetRoot)).id, source.id);
  assert.equal(
    (await rollbackProjectMove(result.migration_id)).status,
    "already_rolled_back",
  );
  assert.deepEqual(
    JSON.parse(
      await fs.readFile(path.join(source.directory, "state.json"), "utf8"),
    ),
    before,
  );
});

test("project-id and project-move CLI support preview, apply, and rollback", async (t) => {
  const root = await setup(t);
  const home = process.env.RDSH_DASHBOARD_HOME;
  const sourceRoot = path.join(root, "before");
  const targetRoot = path.join(root, "after");
  await fs.mkdir(sourceRoot);
  const source = await identity(sourceRoot);
  const before = await seedHistory(source);
  const id = runCli(["project-id", "--project", sourceRoot], home);
  assert.equal(id.project_id, source.id);
  await fs.rename(sourceRoot, targetRoot);

  const preview = runCli(
    ["project-move", "preview", "--project", targetRoot, "--from-id", source.id],
    home,
  );
  assert.equal(preview.status, "ready");
  const applied = runCli(
    [
      "project-move",
      "apply",
      "--project",
      targetRoot,
      "--from-id",
      source.id,
      "--expected-revision",
      String(preview.source_revision),
    ],
    home,
  );
  assert.equal(applied.status, "applied");
  assert.equal(
    runCli(["project-id", "--project", targetRoot], home).project_id,
    source.id,
  );
  const rolledBack = runCli(
    ["project-move", "rollback", "--migration-id", applied.migration_id],
    home,
  );
  assert.equal(rolledBack.status, "rolled_back");
  assert.equal(
    JSON.stringify(
      JSON.parse(
        await fs.readFile(path.join(source.directory, "state.json"), "utf8"),
      ),
    ),
    JSON.stringify(before),
  );
});
