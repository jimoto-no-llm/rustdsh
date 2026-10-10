import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const projectIdPattern = /^[0-9a-f]{16}$/;
const migrationIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const identityLockLeaseMs = 30_000;

export function stateHome() {
  return (
    process.env.RDSH_DASHBOARD_HOME ||
    path.join(
      process.env.LOCALAPPDATA || path.join(os.homedir(), ".local", "state"),
      "rdsh",
      "dashboard",
    )
  );
}

function registryPath(home = stateHome()) {
  return path.join(home, "project-identities.json");
}

function lockPath(home = stateHome()) {
  return path.join(home, "project-identity.lock");
}

function normalizedRoot(root) {
  return process.platform === "win32" ? root.toLowerCase() : root;
}

function pathId(root) {
  return createHash("sha256")
    .update(normalizedRoot(root))
    .digest("hex")
    .slice(0, 16);
}

async function canonicalRoot(project) {
  if (typeof project !== "string" || !project)
    throw new Error("Project path is required");
  const root = await fs.realpath(path.resolve(project));
  if (!(await fs.stat(root)).isDirectory())
    throw new Error("Project must be a directory");
  return root;
}

function emptyRegistry() {
  return { schema: 1, revision: 0, paths: {}, migrations: [] };
}

function validateRegistry(value) {
  if (
    !value ||
    value.schema !== 1 ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0 ||
    !value.paths ||
    typeof value.paths !== "object" ||
    Array.isArray(value.paths) ||
    !Array.isArray(value.migrations)
  )
    throw new Error("Project identity registry is corrupt or unsupported");
  const entries = Object.entries(value.paths);
  for (const [root, entry] of entries)
    if (
      !root ||
      !entry ||
      !projectIdPattern.test(entry.project_id) ||
      !migrationIdPattern.test(entry.migration_id)
    )
      throw new Error("Project identity registry contains an invalid path");
  const seen = new Map();
  for (const migration of value.migrations)
    if (
      !migration ||
      !migrationIdPattern.test(migration.id) ||
      seen.has(migration.id) ||
      !projectIdPattern.test(migration.project_id) ||
      !projectIdPattern.test(migration.target_default_id) ||
      typeof migration.target_root !== "string" ||
      typeof migration.target_key !== "string" ||
      !["applied", "rolled_back"].includes(migration.status) ||
      !Number.isSafeInteger(migration.source_revision) ||
      !Number.isSafeInteger(migration.snapshot?.registry_revision)
    )
      throw new Error("Project identity registry contains an invalid migration");
    else seen.set(migration.id, migration);
  for (const [root, entry] of entries) {
    const migration = seen.get(entry.migration_id);
    if (
      !migration ||
      migration.status !== "applied" ||
      migration.project_id !== entry.project_id ||
      migration.target_key !== root
    )
      throw new Error("Project identity registry contains an inconsistent mapping");
  }
  for (const migration of seen.values())
    if (
      migration.status === "applied" &&
      value.paths[migration.target_key]?.migration_id !== migration.id
    )
      throw new Error("Project identity registry is missing an applied mapping");
  return value;
}

async function readRegistry(home = stateHome()) {
  try {
    return validateRegistry(
      JSON.parse(await fs.readFile(registryPath(home), "utf8")),
    );
  } catch (error) {
    if (error.code === "ENOENT") return emptyRegistry();
    throw error;
  }
}

async function writeRegistry(value, home = stateHome()) {
  const file = registryPath(home);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify(value, null, 2) + "\n", {
      mode: 0o600,
    });
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

async function lockOwner(file) {
  try {
    const value = JSON.parse(await fs.readFile(file, "utf8"));
    if (
      !value ||
      !Number.isSafeInteger(value.pid) ||
      value.pid <= 0 ||
      typeof value.platform !== "string" ||
      !Number.isSafeInteger(value.created_at_ms) ||
      !migrationIdPattern.test(value.token)
    )
      throw new Error("Project identity lock is unreadable; inspect it before removing it");
    return value;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    if (error.code === "EPERM") return true;
    throw error;
  }
}

export async function acquireProjectIdentityLock(home = stateHome()) {
  const file = lockPath(home);
  await fs.mkdir(home, { recursive: true });
  for (let attempt = 0; attempt < 1600; attempt++) {
    const token = randomUUID();
    let handle;
    let created = false;
    try {
      handle = await fs.open(file, "wx", 0o600);
      created = true;
      await handle.writeFile(
        JSON.stringify({
          pid: process.pid,
          platform: process.platform,
          token,
          created_at_ms: Date.now(),
        }),
      );
      return async () => {
        await handle.close();
        const owner = await lockOwner(file);
        if (owner?.token === token) await fs.unlink(file);
      };
    } catch (error) {
      await handle?.close();
      if (created) await fs.unlink(file).catch(() => {});
      if (error.code !== "EEXIST") throw error;
      const stale = await lockOwner(file);
      if (!stale)
        continue;
      const samePlatform = stale.platform === process.platform;
      const alive = samePlatform ? await processIsAlive(stale.pid) : true;
      const foreignLeaseExpired =
        !samePlatform && Date.now() - stale.created_at_ms >= identityLockLeaseMs;
      if ((samePlatform && alive) || (!samePlatform && !foreignLeaseExpired)) {
        if (attempt === 1599)
          throw new Error(
            "Project identity is in use by another runtime; retry after it finishes",
          );
        await new Promise((resolve) => setTimeout(resolve, 25));
        continue;
      }
      const current = await lockOwner(file);
      if (current?.token === stale.token) await fs.unlink(file);
    }
  }
  throw new Error("Could not acquire the project identity lock; retry the operation");
}

export async function identity(project, home = stateHome()) {
  const root = await canonicalRoot(project);
  const registry = await readRegistry(home);
  const entry = registry.paths[normalizedRoot(root)];
  const id = entry?.project_id || pathId(root);
  return {
    id,
    root,
    name: path.basename(root),
    directory: path.join(home, "projects", id),
  };
}

async function projectState(projectId, home = stateHome()) {
  const directory = path.join(home, "projects", projectId);
  let value;
  try {
    value = JSON.parse(
      await fs.readFile(path.join(directory, "state.json"), "utf8"),
    );
  } catch (error) {
    if (error.code === "ENOENT")
      throw new Error(`Project ${projectId} has no saved dashboard history`);
    throw error;
  }
  if (
    value.schema !== 1 ||
    value.project?.id !== projectId ||
    !Number.isSafeInteger(value.revision) ||
    !Array.isArray(value.tasks) ||
    !Array.isArray(value.questions)
  )
    throw new Error(`Saved dashboard history for ${projectId} is invalid`);
  return { directory, value };
}

async function serverLockStatus(directory, { clearStale = false } = {}) {
  const file = path.join(directory, "server.lock");
  let text;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return "stopped";
    throw error;
  }
  let owner;
  try {
    owner = JSON.parse(text);
  } catch {
    throw new Error(
      "Dashboard lock predates cross-runtime ownership; stop or inspect it before moving the project",
    );
  }
  if (
    !owner ||
    !Number.isSafeInteger(owner.pid) ||
    owner.pid <= 0 ||
    typeof owner.platform !== "string" ||
    typeof owner.token !== "string"
  )
    throw new Error("Dashboard lock is unreadable; inspect it before moving the project");
  if (owner.platform !== process.platform || (await processIsAlive(owner.pid)))
    throw new Error("Stop this project's dashboard before moving its identity");
  if (clearStale) {
    const currentText = await fs.readFile(file, "utf8").catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (currentText === text) await fs.unlink(file);
  }
  return "stale_lock";
}

async function planProjectMove(project, fromId, home = stateHome()) {
  if (!projectIdPattern.test(fromId || ""))
    throw new Error("--from-id must be a 16-character project ID from project-id");
  const root = await canonicalRoot(project);
  const rootKey = normalizedRoot(root);
  const targetId = pathId(root);
  const registry = await readRegistry(home);
  const existing = registry.paths[rootKey];
  if (existing) {
    if (existing.project_id !== fromId)
      throw new Error("Move target already belongs to another project; no state was changed");
    const migration = registry.migrations.find(
      (item) => item.id === existing.migration_id,
    );
    if (!migration || migration.status !== "applied")
      throw new Error("Move target has an inconsistent identity mapping");
    const source = await projectState(fromId, home);
    return {
      status: "already_moved",
      project_id: fromId,
      target_root: root,
      target_default_id: targetId,
      source_revision: source.value.revision,
      migration_id: migration.id,
      registry_revision: registry.revision,
    };
  }
  if (fromId === targetId) {
    const source = await projectState(fromId, home);
    return {
      status: "same_identity",
      project_id: fromId,
      target_root: root,
      target_default_id: targetId,
      source_revision: source.value.revision,
      registry_revision: registry.revision,
    };
  }
  const targetDirectory = path.join(home, "projects", targetId);
  try {
    await fs.stat(targetDirectory);
    throw new Error(
      "Move target already has dashboard state; it will not be overwritten or merged",
    );
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const source = await projectState(fromId, home);
  const serverLock = await serverLockStatus(source.directory);
  return {
    status: "ready",
    project_id: fromId,
    target_root: root,
    target_default_id: targetId,
    source_state_directory: source.directory,
    target_state_directory: targetDirectory,
    source_revision: source.value.revision,
    task_count: source.value.tasks.length,
    question_count: source.value.questions.length,
    answered_question_count: source.value.questions.filter(
      (question) => typeof question.answer === "string",
    ).length,
    server_lock: serverLock,
    registry_revision: registry.revision,
  };
}

export async function previewProjectMove(project, fromId) {
  const home = stateHome();
  return planProjectMove(project, fromId, home);
}

export async function applyProjectMove(project, fromId, expectedRevision) {
  const home = stateHome();
  const release = await acquireProjectIdentityLock(home);
  try {
    const plan = await planProjectMove(project, fromId, home);
    if (plan.status === "already_moved")
      return { ...plan, status: "already_moved" };
    if (plan.status === "same_identity")
      return { ...plan, status: "same_identity" };
    if (
      !Number.isSafeInteger(expectedRevision) ||
      plan.source_revision !== expectedRevision
    )
      throw new Error(
        `Project history changed after preview; preview again (current revision ${plan.source_revision})`,
      );
    await serverLockStatus(plan.source_state_directory, { clearStale: true });
    const registry = await readRegistry(home);
    const id = randomUUID();
    const migration = {
      id,
      project_id: fromId,
      target_root: plan.target_root,
      target_default_id: plan.target_default_id,
      target_key: normalizedRoot(plan.target_root),
      source_revision: plan.source_revision,
      status: "applied",
      applied_at: new Date().toISOString(),
      snapshot: {
        registry_revision: registry.revision,
        previous_target: registry.paths[normalizedRoot(plan.target_root)] || null,
        source_state_directory: plan.source_state_directory,
        task_count: plan.task_count,
        question_count: plan.question_count,
        answered_question_count: plan.answered_question_count,
      },
    };
    const next = {
      ...registry,
      revision: registry.revision + 1,
      paths: {
        ...registry.paths,
        [migration.target_key]: { project_id: fromId, migration_id: id },
      },
      migrations: [...registry.migrations, migration],
    };
    await writeRegistry(next, home);
    return {
      status: "applied",
      migration_id: id,
      project_id: fromId,
      target_root: migration.target_root,
      source_revision: migration.source_revision,
      registry_revision: next.revision,
    };
  } finally {
    await release();
  }
}

export async function rollbackProjectMove(migrationId) {
  if (!migrationIdPattern.test(migrationId || ""))
    throw new Error("--migration-id must be the ID returned by project-move apply");
  const home = stateHome();
  const release = await acquireProjectIdentityLock(home);
  try {
    const registry = await readRegistry(home);
    const migration = registry.migrations.find((item) => item.id === migrationId);
    if (!migration) throw new Error("Project move was not found");
    if (migration.status === "rolled_back")
      return {
        status: "already_rolled_back",
        migration_id: migrationId,
        project_id: migration.project_id,
      };
    const mapping = registry.paths[migration.target_key];
    if (
      mapping?.project_id !== migration.project_id ||
      mapping?.migration_id !== migrationId
    )
      throw new Error("Project identity changed after migration; rollback is unsafe");
    const source = await projectState(migration.project_id, home);
    await serverLockStatus(source.directory, { clearStale: true });
    if (migration.project_id !== migration.target_default_id) {
      const defaultDirectory = path.join(
        home,
        "projects",
        migration.target_default_id,
      );
      try {
        await fs.stat(defaultDirectory);
        throw new Error(
          "A different project's state now occupies the move target; rollback is unsafe",
        );
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    const paths = { ...registry.paths };
    delete paths[migration.target_key];
    const migrations = registry.migrations.map((item) =>
      item.id === migrationId
        ? { ...item, status: "rolled_back", rolled_back_at: new Date().toISOString() }
        : item,
    );
    const next = {
      ...registry,
      revision: registry.revision + 1,
      paths,
      migrations,
    };
    await writeRegistry(next, home);
    return {
      status: "rolled_back",
      migration_id: migrationId,
      project_id: migration.project_id,
      target_root: migration.target_root,
      registry_revision: next.revision,
    };
  } finally {
    await release();
  }
}
