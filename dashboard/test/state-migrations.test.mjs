import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { identity, ProjectStore, writeJson } from "../state.mjs";
import {
  applyStateMigration,
  clearStaleStateMigrationLock,
  dryRunStateMigration,
  inspectStateMigrations,
  rollbackStateMigration,
} from "../state-migrations.mjs";
const exec = promisify(execFile);
const cli = fileURLToPath(new URL("../cli.mjs", import.meta.url));

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rdsh-state-migration-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const projectRoot = path.join(root, "project");
  const home = path.join(root, "dashboard-home");
  await fs.mkdir(projectRoot);
  const projectIdentity = await identity(projectRoot);
  const project = {
    ...projectIdentity,
    directory: path.join(home, "projects", projectIdentity.id),
  };
  await fs.mkdir(project.directory, { recursive: true });
  const state = structuredClone((await ProjectStore.open(project)).value);
  delete state.changes;
  const stateFile = path.join(project.directory, "state.json");
  await writeJson(stateFile, state);
  return { home, project, root, stateFile };
}

test("dry-run reports a schema migration without changing or snapshotting the source", async (t) => {
  const { project, stateFile } = await fixture(t);
  const before = await fs.readFile(stateFile);
  const report = await dryRunStateMigration(project);
  assert.equal(report.status, "ready");
  assert.equal(report.source_schema, 1);
  assert.equal(report.target_schema, 2);
  assert.deepEqual(report.changes, [
    "schema: 1 -> 2",
    "initialize required changes array",
  ]);
  assert.deepEqual(await fs.readFile(stateFile), before);
  await assert.rejects(fs.access(path.join(project.directory, "state-migrations")));
});

test("state-migrate dry-run is available through the dashboard CLI", async (t) => {
  const { home, project, root } = await fixture(t);
  const result = await exec(
    process.execPath,
    [cli, "state-migrate", "dry-run", "--project", project.root],
    {
      cwd: root,
      windowsHide: true,
      env: { ...process.env, RDSH_DASHBOARD_HOME: home },
    },
  );
  assert.equal(JSON.parse(result.stdout).status, "ready");
});

test("apply snapshots exact source bytes and rollback restores a schema-1-readable file", async (t) => {
  const { project, stateFile } = await fixture(t);
  const sourceBytes = await fs.readFile(stateFile);
  const applied = await applyStateMigration(project);
  assert.equal(applied.status, "applied");
  const migrated = JSON.parse(await fs.readFile(stateFile, "utf8"));
  assert.equal(migrated.schema, 2);
  assert.deepEqual(migrated.changes, []);
  assert.equal((await ProjectStore.open(project)).value.schema, 2);
  assert.deepEqual(
    await fs.readFile(path.join(project.directory, applied.snapshot)),
    sourceBytes,
  );

  const manifestFile = path.join(
    project.directory,
    "state-migrations",
    applied.migration_id + ".json",
  );
  const manifest = JSON.parse(await fs.readFile(manifestFile, "utf8"));
  manifest.stage = "prepared";
  await writeJson(manifestFile, manifest);
  const recovered = await inspectStateMigrations(project);
  assert.equal(recovered.migrations[0].effective_stage, "applied");
  assert.equal(recovered.migrations[0].recovered_after_restart, true);

  const beforeRepeat = await fs.readFile(stateFile);
  const secondApply = await applyStateMigration(project);
  assert.equal(secondApply.status, "current");
  assert.equal(
    secondApply.recovery_status,
    "schema_2_already_present_no_conversion_repeated",
  );
  assert.deepEqual(await fs.readFile(stateFile), beforeRepeat);
  assert.equal(
    (await inspectStateMigrations(project)).migrations[0].effective_stage,
    "applied",
  );

  const rolledBack = await rollbackStateMigration(
    project,
    applied.migration_id,
  );
  assert.equal(rolledBack.status, "rolled_back");
  assert.deepEqual(await fs.readFile(stateFile), sourceBytes);
  assert.equal((await ProjectStore.open(project)).value.schema, 1);
});

test("rollback refuses changed state and leaves post-migration data intact", async (t) => {
  const { project, stateFile } = await fixture(t);
  const applied = await applyStateMigration(project);
  const store = await ProjectStore.open(project);
  await store.mutate("event", { title: "New data after migration" });
  const changedBytes = await fs.readFile(stateFile);
  await assert.rejects(
    rollbackStateMigration(project, applied.migration_id),
    (error) => error.code === "state_changed_after_migration",
  );
  assert.deepEqual(await fs.readFile(stateFile), changedBytes);
  assert.equal((await ProjectStore.open(project)).value.events[0].title, "New data after migration");
});

test("unknown or corrupt schema data is preserved and a live dashboard blocks apply", async (t) => {
  const { project, stateFile } = await fixture(t);
  const original = await fs.readFile(stateFile);
  const unknown = JSON.parse(original.toString("utf8"));
  unknown.schema = 99;
  await writeJson(stateFile, unknown);
  const unknownBytes = await fs.readFile(stateFile);
  await assert.rejects(dryRunStateMigration(project));
  await assert.rejects(applyStateMigration(project));
  assert.deepEqual(await fs.readFile(stateFile), unknownBytes);

  await fs.writeFile(stateFile, "{truncated", "utf8");
  const corruptBytes = await fs.readFile(stateFile);
  await assert.rejects(dryRunStateMigration(project));
  assert.deepEqual(await fs.readFile(stateFile), corruptBytes);
  assert.equal((await inspectStateMigrations(project)).state_status, "invalid_or_foreign");

  await fs.writeFile(path.join(project.directory, "server.lock"), "1234", "utf8");
  await assert.rejects(
    applyStateMigration(project),
    (error) => error.code === "dashboard_must_be_stopped",
  );
  assert.deepEqual(await fs.readFile(stateFile), corruptBytes);
});

test("state readers and writers refuse to race a migration lock", async (t) => {
  const { project, stateFile } = await fixture(t);
  const store = await ProjectStore.open(project);
  const before = await fs.readFile(stateFile);
  await fs.writeFile(
    path.join(project.directory, "state-migration.lock"),
    JSON.stringify({ pid: process.pid, owner_id: "fixture" }),
    "utf8",
  );
  await assert.rejects(ProjectStore.open(project), /migration is in progress/);
  await assert.rejects(
    store.mutate("event", { title: "Must not write during migration" }),
    /migration is in progress/,
  );
  assert.deepEqual(await fs.readFile(stateFile), before);
});

test("stale migration locks are inspected and removed only with explicit confirmation", async (t) => {
  const { project } = await fixture(t);
  const lockFile = path.join(project.directory, "state-migration.lock");
  await fs.writeFile(
    lockFile,
    JSON.stringify({ pid: process.pid, owner_id: "00000000-0000-4000-8000-000000000001" }),
    "utf8",
  );
  const live = await inspectStateMigrations(project);
  assert.equal(live.state_lock.owner_process, "alive");
  await assert.rejects(
    clearStaleStateMigrationLock(project, { confirmed: true }),
    (error) => error.code === "migration_lock_owner_not_confirmed_gone",
  );

  const child = spawn(process.execPath, ["-e", "process.exit(0)"], {
    stdio: "ignore",
  });
  await once(child, "exit");
  await fs.writeFile(
    lockFile,
    JSON.stringify({
      pid: child.pid,
      owner_id: "00000000-0000-4000-8000-000000000002",
    }),
    "utf8",
  );
  const stale = await inspectStateMigrations(project);
  assert.equal(stale.state_lock.owner_process, "gone");
  await assert.rejects(
    clearStaleStateMigrationLock(project),
    (error) => error.code === "explicit_confirmation_required",
  );
  assert.equal(
    (await clearStaleStateMigrationLock(project, { confirmed: true })).status,
    "stale_lock_removed",
  );
  assert.equal((await inspectStateMigrations(project)).state_lock.status, "absent");
});
