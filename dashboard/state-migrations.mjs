import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { ProjectStore } from "./state.mjs";

const migrationSchema = 1;
const migrationDirectory = "state-migrations";
const migrationLock = "state-migration.lock";
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const exact = (value, keys) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));

export class StateMigrationError extends Error {
  constructor(code) {
    super("State migration: " + code);
    this.code = code;
  }
}

function check(condition, code) {
  if (!condition) throw new StateMigrationError(code);
}

function paths(project) {
  return {
    state: path.join(project.directory, "state.json"),
    lock: path.join(project.directory, migrationLock),
    serverLock: path.join(project.directory, "server.lock"),
    migrations: path.join(project.directory, migrationDirectory),
  };
}

async function readBytes(file) {
  try {
    return await fs.readFile(file);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new StateMigrationError("state_read_failed");
  }
}

function decodeState(bytes, project) {
  let state;
  try {
    state = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new StateMigrationError("state_corrupt");
  }
  check(
    state &&
      typeof state === "object" &&
      state.project?.id === project.id &&
      Number.isSafeInteger(state.schema),
    "state_identity_invalid",
  );
  return state;
}

function migrationOutput(state) {
  check(state.schema === 1, "schema_not_supported");
  check(
    state.changes === undefined || Array.isArray(state.changes),
    "legacy_changes_invalid",
  );
  return {
    ...structuredClone(state),
    schema: 2,
    changes: structuredClone(state.changes ?? []),
  };
}

async function writeAtomic(file, bytes) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = file + "." + randomUUID() + ".tmp";
  let handle;
  try {
    handle = await fs.open(temporary, "wx", 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temporary, file);
    if (process.platform !== "win32") {
      const parent = await fs.open(path.dirname(file), "r");
      try {
        await parent.sync();
      } finally {
        await parent.close();
      }
    }
  } catch {
    throw new StateMigrationError("atomic_write_unconfirmed");
  } finally {
    await handle?.close();
    await fs.unlink(temporary).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

async function writeJson(file, value) {
  await writeAtomic(file, Buffer.from(JSON.stringify(value, null, 2) + "\n"));
}

async function acquireLock(file) {
  let handle;
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    handle = await fs.open(file, "wx", 0o600);
    await handle.writeFile(
      JSON.stringify({ pid: process.pid, owner_id: randomUUID() }),
    );
    await handle.sync();
  } catch (error) {
    await handle?.close();
    if (error.code === "EEXIST")
      throw new StateMigrationError("migration_lock_present");
    throw new StateMigrationError("migration_lock_failed");
  }
  return async () => {
    await handle.close();
    await fs.unlink(file).catch(() => {
      throw new StateMigrationError("migration_lock_cleanup_unconfirmed");
    });
  };
}

async function lockSnapshot(file) {
  const bytes = await readBytes(file);
  if (bytes === null) return { bytes: null, status: "absent" };
  try {
    const value = JSON.parse(bytes.toString("utf8"));
    check(
      exact(value, ["pid", "owner_id"]) &&
        Number.isSafeInteger(value.pid) &&
        value.pid > 0 &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
          value.owner_id,
        ),
      "migration_lock_invalid",
    );
    let ownerProcess;
    try {
      process.kill(value.pid, 0);
      ownerProcess = "alive";
    } catch (error) {
      ownerProcess =
        error.code === "ESRCH"
          ? "gone"
          : error.code === "EPERM"
            ? "alive"
            : "unknown";
    }
    return {
      bytes,
      status: "present",
      pid: value.pid,
      owner_id: value.owner_id,
      owner_process: ownerProcess,
      automatic_removal: false,
    };
  } catch {
    return { bytes, status: "unreadable", automatic_removal: false };
  }
}

async function refuseLiveWriters(file) {
  try {
    await fs.access(file);
    throw new StateMigrationError("dashboard_must_be_stopped");
  } catch (error) {
    if (error instanceof StateMigrationError) throw error;
    if (error.code !== "ENOENT")
      throw new StateMigrationError("dashboard_lock_unreadable");
  }
}

function migrationId(sourceHash) {
  return "mig_" + sourceHash.slice(0, 24);
}

function migrationFiles(directory, id) {
  return {
    snapshot: path.join(directory, id + ".before.json"),
    manifest: path.join(directory, id + ".json"),
  };
}

async function writeSnapshot(file, sourceBytes, sourceHash) {
  try {
    const handle = await fs.open(file, "wx", 0o600);
    try {
      await handle.writeFile(sourceBytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (process.platform !== "win32") {
      const parent = await fs.open(path.dirname(file), "r");
      try {
        await parent.sync();
      } finally {
        await parent.close();
      }
    }
  } catch (error) {
    if (error.code !== "EEXIST")
      throw new StateMigrationError("snapshot_write_failed");
    const existing = await readBytes(file);
    check(existing && digest(existing) === sourceHash, "snapshot_conflict");
  }
}

function makePlan(project, sourceBytes, source) {
  const sourceHash = digest(sourceBytes);
  const id = migrationId(sourceHash);
  const output = migrationOutput(source);
  const targetBytes = Buffer.from(JSON.stringify(output, null, 2) + "\n");
  return {
    schema: migrationSchema,
    project_id: project.id,
    status: "ready",
    migration_id: id,
    source_schema: 1,
    target_schema: 2,
    source_sha256: sourceHash,
    target_sha256: digest(targetBytes),
    source_bytes: sourceBytes.length,
    target_bytes: targetBytes.length,
    changes: [
      "schema: 1 -> 2",
      ...(source.changes === undefined
        ? ["initialize required changes array"]
        : []),
    ],
    rollback: "restore snapshot only while current state matches target hash",
    targetBytes,
  };
}

export async function dryRunStateMigration(project) {
  const { state } = paths(project);
  const sourceBytes = await readBytes(state);
  if (sourceBytes === null)
    return {
      schema: migrationSchema,
      project_id: project.id,
      status: "no_state_file",
      changes: [],
    };
  const source = decodeState(sourceBytes, project);
  await ProjectStore.open(project);
  const validatedBytes = await readBytes(state);
  check(
    validatedBytes !== null && digest(validatedBytes) === digest(sourceBytes),
    "state_changed_during_dry_run",
  );
  if (source.schema === 2)
    return {
      schema: migrationSchema,
      project_id: project.id,
      status: "current",
      current_schema: 2,
      changes: [],
    };
  check(source.schema === 1, "schema_not_supported");
  return publicPlan(makePlan(project, sourceBytes, source));
}

function publicPlan(plan) {
  const { targetBytes: _targetBytes, ...visible } = plan;
  return visible;
}

function validateManifest(value, project, id) {
  return (
    exact(value, [
      "schema",
      "project_id",
      "migration_id",
      "source_schema",
      "target_schema",
      "source_sha256",
      "target_sha256",
      "snapshot",
      "stage",
      "created_at",
      "updated_at",
    ]) &&
    value.schema === migrationSchema &&
    value.project_id === project.id &&
    value.migration_id === id &&
    value.source_schema === 1 &&
    value.target_schema === 2 &&
    /^[0-9a-f]{64}$/.test(value.source_sha256) &&
    /^[0-9a-f]{64}$/.test(value.target_sha256) &&
    value.snapshot === id + ".before.json" &&
    ["prepared", "applied", "rolled_back"].includes(value.stage) &&
    Number.isFinite(Date.parse(value.created_at)) &&
    Number.isFinite(Date.parse(value.updated_at))
  );
}

async function readManifest(project, id) {
  check(/^mig_[0-9a-f]{24}$/.test(id), "migration_id_invalid");
  const { manifest } = migrationFiles(paths(project).migrations, id);
  let value;
  try {
    value = JSON.parse(await fs.readFile(manifest, "utf8"));
  } catch {
    throw new StateMigrationError("migration_record_unavailable");
  }
  check(validateManifest(value, project, id), "migration_record_invalid");
  return value;
}

export async function applyStateMigration(project) {
  const filePaths = paths(project);
  await refuseLiveWriters(filePaths.serverLock);
  const initialBytes = await readBytes(filePaths.state);
  check(initialBytes !== null, "state_file_missing");
  const initial = decodeState(initialBytes, project);
  await ProjectStore.open(project);
  if (initial.schema === 2)
    return {
      schema: migrationSchema,
      project_id: project.id,
      status: "current",
      current_schema: 2,
      recovery_status: "schema_2_already_present_no_conversion_repeated",
      changes: [],
    };
  const plan = makePlan(project, initialBytes, initial);
  const unlock = await acquireLock(filePaths.lock);
  try {
    await refuseLiveWriters(filePaths.serverLock);
    const sourceBytes = await readBytes(filePaths.state);
    check(
      sourceBytes !== null && digest(sourceBytes) === plan.source_sha256,
      "state_changed_after_plan",
    );
    const directory = filePaths.migrations;
    const { snapshot, manifest } = migrationFiles(
      directory,
      plan.migration_id,
    );
    await fs.mkdir(directory, { recursive: true });
    await writeSnapshot(snapshot, sourceBytes, plan.source_sha256);
    const now = new Date().toISOString();
    const record = {
      schema: migrationSchema,
      project_id: project.id,
      migration_id: plan.migration_id,
      source_schema: 1,
      target_schema: 2,
      source_sha256: plan.source_sha256,
      target_sha256: plan.target_sha256,
      snapshot: path.basename(snapshot),
      stage: "prepared",
      created_at: now,
      updated_at: now,
    };
    const existing = await readBytes(manifest);
    if (existing !== null) {
      const saved = JSON.parse(existing.toString("utf8"));
      check(
        validateManifest(saved, project, plan.migration_id) &&
          saved.source_sha256 === plan.source_sha256 &&
          saved.target_sha256 === plan.target_sha256,
        "migration_record_conflict",
      );
      record.created_at = saved.created_at;
      record.stage = "prepared";
    } else await writeJson(manifest, record);

    const currentBytes = await readBytes(filePaths.state);
    check(
      currentBytes !== null && digest(currentBytes) === plan.source_sha256,
      "state_changed_before_cutover",
    );
    await writeAtomic(filePaths.state, plan.targetBytes);
    record.stage = "applied";
    record.updated_at = new Date().toISOString();
    await writeJson(manifest, record);
    return {
      ...publicPlan(plan),
      status: "applied",
      snapshot: path.relative(project.directory, snapshot),
    };
  } finally {
    await unlock();
  }
}

export async function rollbackStateMigration(project, id) {
  const filePaths = paths(project);
  await refuseLiveWriters(filePaths.serverLock);
  const unlock = await acquireLock(filePaths.lock);
  try {
    await refuseLiveWriters(filePaths.serverLock);
    const record = await readManifest(project, id);
    check(record.stage !== "rolled_back", "migration_already_rolled_back");
    const currentBytes = await readBytes(filePaths.state);
    check(
      currentBytes !== null && digest(currentBytes) === record.target_sha256,
      "state_changed_after_migration",
    );
    const snapshot = path.join(filePaths.migrations, record.snapshot);
    const snapshotBytes = await readBytes(snapshot);
    check(
      snapshotBytes !== null && digest(snapshotBytes) === record.source_sha256,
      "snapshot_invalid",
    );
    await writeAtomic(filePaths.state, snapshotBytes);
    record.stage = "rolled_back";
    record.updated_at = new Date().toISOString();
    const { manifest } = migrationFiles(filePaths.migrations, id);
    await writeJson(manifest, record);
    return {
      schema: migrationSchema,
      project_id: project.id,
      migration_id: id,
      status: "rolled_back",
      restored_schema: 1,
      snapshot: path.relative(project.directory, snapshot),
    };
  } finally {
    await unlock();
  }
}

export async function clearStaleStateMigrationLock(
  project,
  { confirmed = false } = {},
) {
  check(confirmed, "explicit_confirmation_required");
  const filePaths = paths(project);
  await refuseLiveWriters(filePaths.serverLock);
  const lock = await lockSnapshot(filePaths.lock);
  if (lock.status === "absent")
    return { schema: migrationSchema, status: "already_absent" };
  check(
    lock.status === "present" && lock.owner_process === "gone",
    "migration_lock_owner_not_confirmed_gone",
  );
  const current = await readBytes(filePaths.lock);
  check(
    current !== null && digest(current) === digest(lock.bytes),
    "migration_lock_changed",
  );
  await fs.unlink(filePaths.lock);
  return {
    schema: migrationSchema,
    project_id: project.id,
    status: "stale_lock_removed",
    owner_process: "gone",
    automatic_removal: false,
  };
}

export async function inspectStateMigrations(project) {
  const filePaths = paths(project);
  const bytes = await readBytes(filePaths.state);
  let currentState = null;
  let stateStatus = bytes === null ? "missing" : "valid";
  if (bytes !== null) {
    try {
      currentState = decodeState(bytes, project);
    } catch {
      stateStatus = "invalid_or_foreign";
    }
  }
  const lock = await lockSnapshot(filePaths.lock);
  let files = [];
  try {
    files = await fs.readdir(filePaths.migrations);
  } catch (error) {
    if (error.code !== "ENOENT")
      throw new StateMigrationError("migration_directory_unreadable");
  }
  const migrations = [];
  for (const name of files.filter((file) => /^mig_[0-9a-f]{24}\.json$/.test(file))) {
    const id = name.slice(0, -5);
    try {
      const record = await readManifest(project, id);
      const cutoverConfirmed =
        record.stage === "prepared" &&
        bytes !== null &&
        digest(bytes) === record.target_sha256;
      migrations.push({
        ...record,
        effective_stage: cutoverConfirmed ? "applied" : record.stage,
        recovered_after_restart: cutoverConfirmed,
      });
    } catch {
      migrations.push({ migration_id: id, stage: "unavailable" });
    }
  }
  return {
    schema: migrationSchema,
    project_id: project.id,
    current_schema: currentState?.schema ?? null,
    state_status: stateStatus,
    current_sha256: bytes === null ? null : digest(bytes),
    state_lock: {
      status: lock.status,
      pid: lock.pid ?? null,
      owner_id: lock.owner_id ?? null,
      owner_process: lock.owner_process ?? null,
      automatic_removal: false,
    },
    dashboard_lock_present: await readBytes(filePaths.serverLock) !== null,
    migrations,
  };
}
