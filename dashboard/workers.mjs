// Opt-in workspace allocation. Never starts an agent, merges, pushes or removes worktrees.
import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  WorkerError,
  requireWorker,
  declaration,
  leaseSeconds,
  workerId,
  headSha,
  mayWrite,
  intersections,
  sharedFile,
  samePath,
  within,
} from "./worker-scopes.mjs";
import {
  canonicalFuture,
  repository,
  workerGit,
  dirtyPaths,
  changedPaths,
  trackedPaths,
} from "./worker-git.mjs";

const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const exact = (v, keys) =>
  object(v) && Object.keys(v).sort().join("|") === [...keys].sort().join("|");
const timestamp = (v) =>
  typeof v === "string" &&
  Number.isFinite(Date.parse(v)) &&
  new Date(v).toISOString() === v;
const revision = (v) => Number.isSafeInteger(v) && v >= 0;
const limit = 2 * 1024 * 1024;

export class WorkerWorkspaces {
  constructor(project, git, directory, now) {
    this.project = { ...project };
    this.git = git;
    this.directory = directory;
    this.file = path.join(directory, "registry.json");
    this.lock = path.join(directory, "registry.lock");
    this.now = now;
  }
  static async open(project, { now = Date.now } = {}) {
    requireWorker(
      object(project) &&
        typeof project.id === "string" &&
        /^[0-9a-f]{16}$/.test(project.id) &&
        typeof project.root === "string" &&
        typeof project.directory === "string" &&
        typeof now === "function",
      "invalid_project",
    );
    const git = await repository(project.root);
    const directory = await canonicalFuture(
      path.join(project.directory, "workers"),
    );
    requireWorker(
      !within(git.root, directory) && !within(git.git_common_dir, directory),
      "worker_storage_must_be_outside_project",
    );
    return new WorkerWorkspaces(
      { ...project, root: git.root },
      git,
      directory,
      now,
    );
  }
  slot(id) {
    return path.join(this.directory, "worktrees", id);
  }
  empty() {
    return {
      schema: 1,
      project_id: this.project.id,
      root: this.git.root,
      git_common_dir: this.git.git_common_dir,
      revision: 0,
      workers: [],
    };
  }
  validate(state) {
    requireWorker(
      exact(state, [
        "schema",
        "project_id",
        "root",
        "git_common_dir",
        "revision",
        "workers",
      ]) &&
        state.schema === 1 &&
        state.project_id === this.project.id &&
        state.root === this.git.root &&
        state.git_common_dir === this.git.git_common_dir &&
        revision(state.revision) &&
        Array.isArray(state.workers) &&
        state.workers.length <= 256,
      "invalid_worker_registry",
    );
    const ids = new Set(),
      branches = new Set();
    for (const row of state.workers) {
      requireWorker(
        exact(row, [
          "worker_id",
          "lease_id",
          "declaration",
          "worktree",
          "branch",
          "base_sha",
          "created_at",
          "expires_at",
          "released_at",
          "state",
          "error",
          "source_before",
        ]),
        "invalid_worker_record",
      );
      requireWorker(
        workerId(row.worker_id) &&
          !ids.has(row.worker_id) &&
          /^wrk_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
            row.lease_id,
          ) &&
          row.branch ===
            `codex/worker-${row.worker_id}-${row.lease_id.slice(4)}` &&
          !branches.has(row.branch) &&
          row.worktree === this.slot(row.worker_id) &&
          headSha(row.base_sha) &&
          timestamp(row.created_at) &&
          timestamp(row.expires_at) &&
          (row.released_at === null || timestamp(row.released_at)) &&
          ["provisioning", "ready", "provision_failed", "released"].includes(
            row.state,
          ) &&
          [null, "git_worktree_creation_unconfirmed"].includes(row.error),
        "invalid_worker_record",
      );
      requireWorker(
        JSON.stringify(declaration(row.declaration)) ===
          JSON.stringify(row.declaration) &&
          row.declaration.worker_id === row.worker_id,
        "invalid_worker_scope",
      );
      requireWorker(
        exact(row.source_before, ["head_sha", "branch", "dirty_paths"]) &&
          row.source_before.head_sha === row.base_sha &&
          (row.source_before.branch === null ||
            typeof row.source_before.branch === "string") &&
          Array.isArray(row.source_before.dirty_paths) &&
          row.source_before.dirty_paths.every((v) => typeof v === "string"),
        "invalid_worker_source_snapshot",
      );
      requireWorker(
        (row.state === "released") === (row.released_at !== null),
        "invalid_worker_release",
      );
      ids.add(row.worker_id);
      branches.add(row.branch);
    }
    return state;
  }
  async read() {
    let handle,
      present = false;
    try {
      const before = await fs.lstat(this.file);
      present = true;
      requireWorker(
        before.isFile() &&
          !before.isSymbolicLink() &&
          before.nlink === 1 &&
          before.size <= limit,
        "worker_registry_unobservable",
      );
      handle = await fs.open(
        this.file,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
      const opened = await handle.stat();
      requireWorker(
        opened.isFile() &&
          opened.nlink === 1 &&
          opened.size <= limit &&
          opened.dev === before.dev &&
          opened.ino === before.ino,
        "worker_registry_unobservable",
      );
      const bytes = await handle.readFile();
      requireWorker(bytes.length <= limit, "worker_registry_too_large");
      return this.validate(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
      );
    } catch (error) {
      if (error.code === "ENOENT" && !present) return this.empty();
      if (error instanceof WorkerError) throw error;
      throw new WorkerError("worker_registry_unreadable");
    } finally {
      await handle?.close();
    }
  }
  async write(state) {
    this.validate(state);
    const bytes = JSON.stringify(state, null, 2) + "\n";
    requireWorker(
      Buffer.byteLength(bytes) <= limit,
      "worker_registry_too_large",
    );
    const temp = path.join(this.directory, "registry-" + randomUUID() + ".tmp");
    let output;
    try {
      output = await fs.open(temp, "wx", 0o600);
      await output.writeFile(bytes);
      await output.sync();
      await output.close();
      output = null;
      await fs.rename(temp, this.file);
      if (process.platform !== "win32") {
        const parent = await fs.open(this.directory, "r");
        try {
          await parent.sync();
        } finally {
          await parent.close();
        }
      }
    } finally {
      await output?.close();
      await fs.unlink(temp).catch((e) => {
        if (e.code !== "ENOENT") throw e;
      });
    }
  }
  async mutate(expectedRevision, change) {
    requireWorker(
      revision(expectedRevision),
      "expected_registry_revision_required",
    );
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    requireWorker(
      samePath(await fs.realpath(this.directory), this.directory),
      "worker_storage_identity_changed",
    );
    let lock;
    try {
      lock = await fs.open(this.lock, "wx", 0o600);
    } catch (error) {
      throw new WorkerError(
        error.code === "EEXIST"
          ? "worker_registry_busy"
          : "worker_registry_write_failed",
      );
    }
    try {
      const state = await this.read();
      requireWorker(
        state.revision === expectedRevision,
        "worker_registry_revision_changed",
      );
      return await change(state);
    } finally {
      await lock.close();
      await fs.unlink(this.lock);
    }
  }
  async source() {
    const info = await repository(this.git.root);
    requireWorker(
      samePath(info.git_common_dir, this.git.git_common_dir),
      "source_repository_identity_changed",
    );
    return {
      head_sha: info.head_sha,
      branch: info.branch,
      dirty_paths: await dirtyPaths(info.root),
    };
  }
  async observe(row) {
    const lease =
      row.state === "released"
        ? "released"
        : this.now() >= Date.parse(row.expires_at)
          ? "expired"
          : "active";
    const result = {
      worker_id: row.worker_id,
      state: row.state,
      lease: { state: lease, expires_at: row.expires_at },
      role: row.declaration.role,
      declaration: structuredClone(row.declaration),
      worktree: row.worktree,
      branch: row.branch,
      base_sha: row.base_sha,
      tree: {
        status: "unavailable",
        dirty: null,
        head_sha: null,
        dirty_paths: [],
        committed_paths: [],
        changed_paths: [],
        scope_violations: [],
        reason: "worktree_unavailable",
      },
    };
    try {
      requireWorker(
        samePath(await fs.realpath(row.worktree), row.worktree),
        "worker_worktree_identity_changed",
      );
      const current = await repository(row.worktree);
      requireWorker(
        samePath(current.git_common_dir, this.git.git_common_dir) &&
          current.branch === row.branch,
        "worker_worktree_identity_changed",
      );
      await workerGit(
        row.worktree,
        "merge-base",
        "--is-ancestor",
        row.base_sha,
        current.head_sha,
      );
      const dirty = await dirtyPaths(row.worktree);
      const committed = await changedPaths(
        row.worktree,
        row.base_sha,
        current.head_sha,
      );
      const changed = [...new Set([...dirty, ...committed])].sort();
      requireWorker(
        (await repository(row.worktree)).head_sha === current.head_sha,
        "worker_head_changed_during_scan",
      );
      result.tree = {
        status: "observed",
        dirty: dirty.length > 0,
        head_sha: current.head_sha,
        dirty_paths: dirty,
        committed_paths: committed,
        changed_paths: changed,
        scope_violations: changed.filter((p) => !mayWrite(row.declaration, p)),
        reason: null,
      };
    } catch (error) {
      result.tree.reason =
        error instanceof WorkerError
          ? error.code
          : "worker_git_observation_unavailable";
    }
    return result;
  }
  async planWith(state, request) {
    const scope = declaration(request);
    const source = await this.source();
    const warnings = [];
    if (state.workers.some((w) => w.worker_id === scope.worker_id))
      warnings.push({
        code: "worker_id_already_allocated",
        worker_id: scope.worker_id,
      });
    try {
      await fs.lstat(this.slot(scope.worker_id));
      warnings.push({
        code: "worktree_path_already_exists",
        worker_id: scope.worker_id,
      });
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    for (const file of source.dirty_paths.filter((p) => mayWrite(scope, p)))
      warnings.push({ code: "human_dirty_scope_overlap", path: file });
    const shared = [
      ...new Set([
        ...(await trackedPaths(this.git.root)).filter(sharedFile),
        ...scope.write_paths.filter(sharedFile),
      ]),
    ];
    for (const row of state.workers) {
      const overlap = intersections(scope, row.declaration);
      for (const file of overlap)
        warnings.push({
          code:
            row.state === "released"
              ? "released_worker_scope_overlap"
              : "worker_scope_overlap",
          worker_id: row.worker_id,
          path: file,
        });
      for (const file of shared.filter(
        (p) => mayWrite(scope, p) && mayWrite(row.declaration, p),
      ))
        warnings.push({
          code:
            row.state === "released"
              ? "released_shared_file_overlap"
              : "shared_file_overlap",
          worker_id: row.worker_id,
          path: file,
        });
    }
    return {
      project_id: this.project.id,
      revision: state.revision,
      source,
      declaration: scope,
      proposed_worktree: this.slot(scope.worker_id),
      warnings,
      can_prepare: warnings.every((w) => w.code.startsWith("released_")),
      runtime_policy:
        "declarations_and_git_change_scan; native_DSH_tool_policy_and_sandbox_are_separate",
    };
  }
  async plan(request) {
    return this.planWith(await this.read(), request);
  }
  async prepare(request, { expectedRevision, expectedHead } = {}) {
    requireWorker(headSha(expectedHead), "expected_source_head_required");
    return this.mutate(expectedRevision, async (state) => {
      const plan = await this.planWith(state, request);
      requireWorker(
        plan.source.head_sha === expectedHead,
        "source_head_changed",
      );
      requireWorker(
        plan.can_prepare,
        "worker_preparation_conflict",
        plan.warnings,
      );
      requireWorker(state.workers.length < 256, "worker_registry_full");
      const leaseId = "wrk_" + randomUUID();
      const row = {
        worker_id: plan.declaration.worker_id,
        lease_id: leaseId,
        declaration: plan.declaration,
        worktree: plan.proposed_worktree,
        branch: `codex/worker-${plan.declaration.worker_id}-${leaseId.slice(4)}`,
        base_sha: expectedHead,
        created_at: new Date(this.now()).toISOString(),
        expires_at: new Date(
          this.now() + plan.declaration.lease_seconds * 1000,
        ).toISOString(),
        released_at: null,
        state: "provisioning",
        error: null,
        source_before: plan.source,
      };
      state.workers.push(row);
      state.revision++;
      await this.write(state);
      try {
        const hooks = path.join(this.directory, "empty-hooks");
        await fs.mkdir(hooks, { recursive: true, mode: 0o700 });
        requireWorker(
          samePath(await fs.realpath(hooks), hooks) &&
            (await fs.readdir(hooks)).length === 0,
          "worker_hooks_directory_not_empty",
        );
        await fs.mkdir(path.dirname(row.worktree), {
          recursive: true,
          mode: 0o700,
        });
        await workerGit(
          this.git.root,
          "-c",
          `core.hooksPath=${hooks}`,
          "worktree",
          "add",
          "--no-track",
          "-b",
          row.branch,
          "--",
          row.worktree,
          row.base_sha,
        );
        const observed = await this.observe(row);
        requireWorker(
          observed.tree.status === "observed" &&
            !observed.tree.dirty &&
            observed.tree.head_sha === row.base_sha,
          "worker_creation_observation_failed",
        );
        row.state = "ready";
      } catch {
        row.state = "provision_failed";
        row.error = "git_worktree_creation_unconfirmed";
      }
      state.revision++;
      await this.write(state);
      return {
        revision: state.revision,
        worker: await this.observe(row),
        source_after: await this.source(),
        provisioning_error: row.error,
      };
    });
  }
  async inspect() {
    const state = await this.read(),
      source = await this.source();
    const workers = [];
    for (const row of state.workers) workers.push(await this.observe(row));
    const conflicts = [];
    for (const worker of workers)
      for (const file of source.dirty_paths) {
        if (
          mayWrite(worker.declaration, file) ||
          worker.tree.changed_paths.some((p) => samePath(p, file))
        )
          conflicts.push({
            code: sharedFile(file)
              ? "human_shared_file_changes"
              : "human_worker_scope_overlap",
            workers: ["source", worker.worker_id],
            path: file,
          });
      }
    for (let a = 0; a < workers.length; a++)
      for (let b = a + 1; b < workers.length; b++) {
        const x = workers[a],
          y = workers[b];
        for (const file of x.tree.changed_paths.filter((p) =>
          y.tree.changed_paths.some((v) => samePath(p, v)),
        ))
          conflicts.push({
            code: sharedFile(file)
              ? "shared_file_changes"
              : "overlapping_changes",
            workers: [x.worker_id, y.worker_id],
            path: file,
          });
      }
    return {
      project_id: this.project.id,
      revision: state.revision,
      source,
      workers,
      conflicts,
      observed_at: new Date(this.now()).toISOString(),
      runtime_policy:
        "declarations_and_git_change_scan; native_DSH_tool_policy_and_sandbox_are_separate",
    };
  }
  async renew(id, seconds, expectedRevision) {
    requireWorker(workerId(id), "invalid_worker_id");
    leaseSeconds(seconds);
    return this.mutate(expectedRevision, async (state) => {
      const row = state.workers.find((r) => r.worker_id === id);
      requireWorker(row && row.state === "ready", "ready_worker_required");
      requireWorker(
        (await this.observe(row)).tree.status === "observed",
        "worker_worktree_unobservable",
      );
      row.expires_at = new Date(this.now() + seconds * 1000).toISOString();
      state.revision++;
      await this.write(state);
      return { revision: state.revision, worker: await this.observe(row) };
    });
  }
  async release(id, expectedRevision) {
    requireWorker(workerId(id), "invalid_worker_id");
    return this.mutate(expectedRevision, async (state) => {
      const row = state.workers.find((r) => r.worker_id === id);
      requireWorker(
        row && row.state !== "released",
        "unreleased_worker_required",
      );
      row.state = "released";
      row.released_at = new Date(this.now()).toISOString();
      state.revision++;
      await this.write(state);
      return { revision: state.revision, worker: await this.observe(row) };
    });
  }
}
