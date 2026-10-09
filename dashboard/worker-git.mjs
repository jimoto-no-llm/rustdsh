import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { headSha, requireWorker, samePath } from "./worker-scopes.mjs";

const exec = promisify(execFile);
const environment = () => ({
  ...Object.fromEntries(
    Object.entries(process.env).filter(([key]) =>
      /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|TEMP|TMP|COMSPEC|HOME|USERPROFILE|LANG|LC_ALL)$/i.test(
        key,
      ),
    ),
  ),
  GIT_TERMINAL_PROMPT: "0",
  GIT_OPTIONAL_LOCKS: "0",
});
export async function workerGit(root, ...args) {
  const { stdout } = await exec("git", ["-C", root, ...args], {
    env: environment(),
    windowsHide: true,
    shell: false,
    timeout: 30000,
    maxBuffer: 2 * 1024 * 1024,
    encoding: "buffer",
  });
  return new TextDecoder("utf-8", { fatal: true }).decode(stdout);
}
export async function canonicalFuture(file) {
  let current = path.resolve(file);
  const suffix = [];
  while (true) {
    try {
      return path.join(await fs.realpath(current), ...suffix);
    } catch (error) {
      if (error.code !== "ENOENT" || path.dirname(current) === current)
        throw error;
      suffix.unshift(path.basename(current));
      current = path.dirname(current);
    }
  }
}
export async function repository(root) {
  const canonical = await fs.realpath(root);
  const top = await fs.realpath(
    (await workerGit(canonical, "rev-parse", "--show-toplevel")).trim(),
  );
  requireWorker(samePath(canonical, top), "exact_git_project_root_required");
  const common = await fs.realpath(
    path.resolve(
      canonical,
      (await workerGit(canonical, "rev-parse", "--git-common-dir")).trim(),
    ),
  );
  const head = (
    await workerGit(canonical, "rev-parse", "--verify", "HEAD")
  ).trim();
  requireWorker(headSha(head), "git_head_unavailable");
  const branch =
    (
      await workerGit(
        canonical,
        "symbolic-ref",
        "--quiet",
        "--short",
        "HEAD",
      ).catch(() => "")
    ).trim() || null;
  return { root: canonical, git_common_dir: common, head_sha: head, branch };
}
export async function dirtyPaths(root) {
  const parts = (
    await workerGit(
      root,
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
    )
  ).split("\0");
  const names = [];
  for (let i = 0; i < parts.length; i++) {
    const item = parts[i];
    if (!item) continue;
    requireWorker(
      item.length >= 4 && item[2] === " ",
      "git_status_unobservable",
    );
    names.push(item.slice(3));
    if (/[RC]/.test(item.slice(0, 2))) {
      requireWorker(Boolean(parts[i + 1]), "git_status_unobservable");
      names.push(parts[++i]);
    }
  }
  return [...new Set(names)].sort();
}
export async function changedPaths(root, from, to) {
  requireWorker(headSha(from) && headSha(to), "invalid_git_comparison");
  return (
    await workerGit(
      root,
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--no-renames",
      "--name-only",
      "-z",
      from,
      to,
      "--",
    )
  )
    .split("\0")
    .filter(Boolean)
    .sort();
}
export async function trackedPaths(root) {
  return (await workerGit(root, "ls-files", "-z", "--cached"))
    .split("\0")
    .filter(Boolean);
}
