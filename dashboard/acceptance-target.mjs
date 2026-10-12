// Local code/environment observations only; no native agent or provider query.
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
export const checksum = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const localEnvironment = () => ({
  platform: process.platform,
  architecture: process.arch,
  os_release: os.release(),
  node_version: process.version,
});
export class AcceptanceError extends Error {
  constructor(code) {
    super("Acceptance: " + code);
    this.code = code;
  }
}
export function requireValue(value, code) {
  if (!value) throw new AcceptanceError(code);
}
function relativePath(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 1024 &&
    !path.isAbsolute(value) &&
    !/[\x00-\x1f\x7f\\]/.test(value) &&
    !value
      .split("/")
      .some(
        (part) =>
          !part ||
          part === "." ||
          part === ".." ||
          part === ".git",
      ) &&
    !value.includes(":")
  );
}
export function relativeInput(value) {
  return (
    relativePath(value) &&
    value.split("/").every((part) => !part.toLowerCase().startsWith(".env"))
  );
}
function protectedWorktreePath(value) {
  return value
    .split("/")
    .some((part) => part.toLowerCase().startsWith(".env"));
}
const within = (root, file) => {
  const value = path.relative(root, file);
  return (
    value !== ".." &&
    !value.startsWith(".." + path.sep) &&
    !path.isAbsolute(value)
  );
};
export async function observedFile(root, relative, { worktree = false } = {}) {
  if (worktree && !relativePath(relative))
    return { path: relative, sha256: null, bytes: 0, unobservable: true };
  requireValue(
    worktree ? relativePath(relative) : relativeInput(relative),
    "invalid_input_path",
  );
  let file;
  try {
    file = await fs.realpath(path.join(root, relative));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return { path: relative, sha256: null, bytes: 0, missing: true };
  }
  requireValue(within(root, file), "input_outside_project");
  const resolvedRelative = path.relative(root, file).split(path.sep).join("/");
  if (
    worktree &&
    (protectedWorktreePath(relative) || protectedWorktreePath(resolvedRelative))
  )
    return { path: relative, sha256: null, bytes: 0, unobservable: true };
  const stat = await fs.stat(file);
  requireValue(
    stat.isFile() && stat.size <= 64 * 1024 * 1024,
    "input_unobservable",
  );
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(file)) {
    bytes += chunk.length;
    requireValue(bytes <= 64 * 1024 * 1024, "input_too_large");
    hash.update(chunk);
  }
  const after = await fs.stat(file);
  requireValue(
    after.size === stat.size &&
      after.mtimeMs === stat.mtimeMs &&
      bytes === stat.size,
    "input_changed_during_observation",
  );
  return { path: relative, sha256: hash.digest("hex"), bytes };
}
export async function observeTarget(project, inputs) {
  const environment = localEnvironment(),
    result = {
      observed_at: new Date().toISOString(),
      head_sha: null,
      branch: null,
      inputs_hash: null,
      worktree_hash: null,
      worktree_complete: true,
      environment,
      environment_hash: checksum(environment),
      status: "unknown",
      reason: null,
    };
  try {
    const root = await fs.realpath(project.root);
    const gitEnv = Object.fromEntries(
      Object.entries(process.env).filter(([key]) =>
        /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|TEMP|TMP|COMSPEC|HOME|USERPROFILE|LANG|LC_ALL)$/i.test(
          key,
        ),
      ),
    );
    const git = async (...args) =>
      (
        await exec("git", ["-C", root, ...args], {
          env: gitEnv,
          windowsHide: true,
          shell: false,
          timeout: 5000,
          maxBuffer: 1024 * 1024,
        })
      ).stdout;
    const gitRoot = await fs.realpath(
      (await git("rev-parse", "--show-toplevel")).trim(),
    );
    requireValue(
      process.platform === "win32"
        ? root.toLowerCase() === gitRoot.toLowerCase()
        : root === gitRoot,
      "exact_git_project_root_required",
    );
    result.head_sha = (await git("rev-parse", "--verify", "HEAD")).trim();
    requireValue(
      /^[0-9a-f]{40,64}$/.test(result.head_sha),
      "git_head_unobservable",
    );
    result.branch =
      (
        await git("symbolic-ref", "--quiet", "--short", "HEAD").catch(() => "")
      ).trim() || null;
    const names = [
      ...new Set(
        (
          await git(
            "ls-files",
            "-z",
            "--cached",
            "--others",
            "--exclude-standard",
          )
        )
          .split("\0")
          .filter(Boolean),
      ),
    ].sort();
    requireValue(names.length <= 5000, "worktree_too_large");
    requireValue(
      Array.isArray(inputs) &&
        inputs.length > 0 &&
        inputs.every(relativeInput),
      "invalid_input_path",
    );
    const data = new Map();
    let total = 0;
    for (const name of names) {
      const file = path.resolve(root, name);
      // Acceptance storage cannot influence its own code snapshot.
      if (within(project.directory, file)) continue;
      // Never read dotenv-like worktree paths. Keep only an opaque path marker
      // so a changed file set remains visible, and keep currentness unknown
      // while any such unobserved input could affect the check.
      const observed = await observedFile(root, name, { worktree: true });
      if (observed.unobservable) result.worktree_complete = false;
      total += observed.bytes;
      requireValue(total <= 256 * 1024 * 1024, "worktree_too_large");
      data.set(name, observed);
    }
    result.inputs_hash = checksum(
      inputs.map(
        (name) =>
          data.get(name) ?? {
            path: name,
            sha256: null,
            bytes: 0,
            missing: true,
          },
      ),
    );
    result.worktree_hash = checksum([...data.values()]);
    requireValue(
      (await git("rev-parse", "--verify", "HEAD")).trim() === result.head_sha,
      "git_head_changed_during_observation",
    );
    requireValue(
      inputs.every((name) => data.get(name)?.sha256),
      "criterion_inputs_missing_or_ignored",
    );
    result.status = "observed";
  } catch (error) {
    result.reason =
      error instanceof AcceptanceError
        ? error.code
        : "target_observation_unavailable";
  }
  return result;
}
export function freshness(record, current, criterionHash) {
  if (record.criterion_hash !== criterionHash)
    return { state: "stale", reason: "acceptance_definition_changed" };
  if (
    record.target.worktree_complete === false ||
    current.worktree_complete === false
  )
    return { state: "unknown", reason: "impact_scope_unknown" };
  if (
    record.stable_target &&
    record.target.status === "observed" &&
    current.reason === "criterion_inputs_missing_or_ignored" &&
    current.inputs_hash !== record.target.inputs_hash
  )
    return { state: "stale", reason: "related_input_missing_or_ignored" };
  if (
    !record.stable_target ||
    record.target.status !== "observed" ||
    current.status !== "observed"
  )
    return { state: "unknown", reason: "target_or_execution_scope_unverified" };
  if (
    record.target.head_sha !== current.head_sha ||
    record.target.branch !== current.branch
  )
    return { state: "stale", reason: "git_target_changed" };
  if (record.target.inputs_hash !== current.inputs_hash)
    return { state: "stale", reason: "related_input_changed" };
  if (record.target.environment_hash !== current.environment_hash)
    return { state: "stale", reason: "environment_changed" };
  if (record.target.worktree_hash !== current.worktree_hash)
    return { state: "unknown", reason: "impact_scope_unknown" };
  return { state: "current", reason: null };
}
