import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ProjectStore, writeJson } from "../state.mjs";
import {
  applyProjectMove,
  identity,
  previewProjectMove,
  rollbackProjectMove,
} from "../project-identity.mjs";
import {
  applyStateMigration,
  dryRunStateMigration,
  rollbackStateMigration,
} from "../state-migrations.mjs";

async function fixture(t, { legacy = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rdsh-state-maintenance-"));
  const previousHome = process.env.RDSH_DASHBOARD_HOME;
  process.env.RDSH_DASHBOARD_HOME = path.join(root, "home");
  t.after(async () => {
    if (previousHome === undefined) delete process.env.RDSH_DASHBOARD_HOME;
    else process.env.RDSH_DASHBOARD_HOME = previousHome;
    await fs.rm(root, { recursive: true, force: true });
  });
  const source = path.join(root, "source");
  await fs.mkdir(source);
  const project = await identity(source);
  const store = await ProjectStore.open(project);
  await store.mutate("task", { id: "kept-task", title: "Preserve this task", status: "todo" });
  const stateFile = path.join(project.directory, "state.json");
  if (legacy) {
    const value = structuredClone(store.value);
    delete value.state_auth;
    await writeJson(stateFile, value);
    await fs.unlink(path.join(project.directory, "state-integrity.key"));
    await fs.unlink(path.join(project.directory, "state-integrity.enabled"));
  }
  return { root, source, project, stateFile };
}

async function snapshot(directory) {
  const result = {};
  for (const name of (await fs.readdir(directory)).sort())
    result[name] = await fs.readFile(path.join(directory, name));
  return result;
}

test("legacy dry-run is repeatable and neither seals state nor creates integrity files", async (t) => {
  const { project } = await fixture(t, { legacy: true });
  const before = await snapshot(project.directory);
  const first = await dryRunStateMigration(project);
  assert.equal(first.status, "ready");
  assert.equal(first.source_schema, 1);
  assert.equal(first.target_schema, 2);
  assert.deepEqual(await dryRunStateMigration(project), first);
  assert.deepEqual(await snapshot(project.directory), before);
});

test("legacy apply succeeds on its first attempt and rollback restores the exact source", async (t) => {
  const { project, stateFile } = await fixture(t, { legacy: true });
  const before = await fs.readFile(stateFile);
  const plan = await dryRunStateMigration(project);
  const result = await applyStateMigration(project);
  assert.equal(result.status, "applied");
  assert.equal(result.target_sha256, plan.target_sha256);
  assert.deepEqual(await fs.readFile(path.join(project.directory, result.snapshot)), before);
  assert.equal(JSON.parse(await fs.readFile(stateFile, "utf8")).schema, 2);
  assert.equal((await dryRunStateMigration(project)).status, "current");
  await assert.rejects(fs.access(path.join(project.directory, "state-integrity.key")), { code: "ENOENT" });
  await rollbackStateMigration(project, result.migration_id);
  assert.deepEqual(await fs.readFile(stateFile), before);
  const reopened = await ProjectStore.open(project);
  assert.equal(reopened.value.tasks[0].title, "Preserve this task");
  assert.ok(reopened.value.state_auth);
});

test("sealed dry-run verifies integrity without repairing or removing recovery files", async (t) => {
  const { project, stateFile } = await fixture(t);
  await fs.unlink(path.join(project.directory, "state-integrity.enabled"));
  const { state_auth: _seal, ...payload } = JSON.parse(await fs.readFile(stateFile, "utf8"));
  await writeJson(path.join(project.directory, "state-integrity.pending"), {
    schema: 1,
    project_id: project.id,
    state_sha256: createHash("sha256").update(JSON.stringify(payload)).digest("hex"),
  });
  const before = await snapshot(project.directory);
  assert.equal((await dryRunStateMigration(project)).status, "ready");
  assert.deepEqual(await snapshot(project.directory), before);
  const readOnly = await ProjectStore.open(project, { readOnly: true });
  await assert.rejects(readOnly.mutate("event", { title: "Must not write" }), /read-only/);
  assert.deepEqual(await snapshot(project.directory), before);

  const corrupt = JSON.parse(await fs.readFile(stateFile, "utf8"));
  corrupt.tasks[0].title = "Changed without a valid seal";
  await writeJson(stateFile, corrupt);
  const tampered = await snapshot(project.directory);
  await assert.rejects(dryRunStateMigration(project), /integrity check failed/);
  await assert.rejects(applyStateMigration(project), /integrity check failed/);
  assert.deepEqual(await snapshot(project.directory), tampered);
});

test("a schema-2 project can move and roll back without rewriting its history", async (t) => {
  const { root, source, project, stateFile } = await fixture(t);
  await applyStateMigration(project);
  const before = await fs.readFile(stateFile);
  const target = path.join(root, "renamed");
  await fs.rename(source, target);
  const preview = await previewProjectMove(target, project.id);
  assert.equal(preview.status, "ready");
  assert.equal(preview.task_count, 1);
  const moved = await applyProjectMove(target, project.id, preview.source_revision);
  const selected = await identity(target);
  assert.equal(selected.id, project.id);
  const reopened = await ProjectStore.open(selected);
  assert.equal(reopened.value.schema, 2);
  assert.equal(reopened.value.project.root, await fs.realpath(target));
  assert.equal(reopened.value.tasks[0].id, "kept-task");
  assert.equal((await previewProjectMove(target, project.id)).status, "already_moved");
  await rollbackProjectMove(moved.migration_id);
  assert.notEqual((await identity(target)).id, project.id);
  assert.deepEqual(await fs.readFile(stateFile), before);
});

test("pending legacy integrity recovery blocks schema migration without consuming its record", async (t) => {
  const { project, stateFile } = await fixture(t, { legacy: true });
  const value = JSON.parse(await fs.readFile(stateFile, "utf8"));
  await writeJson(path.join(project.directory, "state-integrity.pending"), {
    schema: 1,
    project_id: project.id,
    state_sha256: createHash("sha256").update(JSON.stringify(value)).digest("hex"),
  });
  const before = await snapshot(project.directory);
  await assert.rejects(dryRunStateMigration(project), /integrity migration is pending/);
  await assert.rejects(applyStateMigration(project), /integrity migration is pending/);
  assert.deepEqual(await snapshot(project.directory), before);
  await ProjectStore.open(project);
  assert.equal((await applyStateMigration(project)).status, "applied");
});

test("opening missing state read-only does not initialize keys or create a directory", async (t) => {
  const { root } = await fixture(t);
  const directory = path.join(root, "uninitialized");
  const project = { id: "123456789abcdef0", name: "project", root, directory };
  const store = await ProjectStore.open(project, { readOnly: true });
  assert.deepEqual(store.value.tasks, []);
  await assert.rejects(store.mutate("event", { title: "Must not initialize" }), /read-only/);
  await assert.rejects(fs.access(directory), { code: "ENOENT" });
});

test("schema-2 moves reject a missing change log without creating a mapping", async (t) => {
  const { root, project, stateFile } = await fixture(t);
  const target = path.join(root, "target");
  await fs.mkdir(target);
  const value = JSON.parse(await fs.readFile(stateFile, "utf8"));
  value.schema = 2;
  delete value.changes;
  await writeJson(stateFile, value);
  const before = await fs.readFile(stateFile);
  await assert.rejects(previewProjectMove(target, project.id), /history .* is invalid/);
  assert.notEqual((await identity(target)).id, project.id);
  assert.deepEqual(await fs.readFile(stateFile), before);
});
