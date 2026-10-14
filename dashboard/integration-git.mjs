// Only local, fixed-commit operations in a dedicated integration checkout.
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
export class IntegrationError extends Error {
  constructor(code) {
    super("Integration queue: " + code);
    this.code = code;
  }
}
export function check(value, code) {
  if (!value) throw new IntegrationError(code);
}
export const sha = (v) => typeof v === "string" && /^[0-9a-f]{40,64}$/.test(v);
export const samePath = (a, b) =>
  process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
export const within = (root, file) => {
  const relative = path.relative(root, file);
  return (
    relative !== ".." &&
    !relative.startsWith(".." + path.sep) &&
    !path.isAbsolute(relative)
  );
};
export async function git(root, ...args) {
  const { stdout } = await exec("git", ["-C", root, ...args], {
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter(([key]) =>
          /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|TEMP|TMP|COMSPEC|HOME|USERPROFILE|LANG|LC_ALL)$/i.test(
            key,
          ),
        ),
      ),
      GIT_TERMINAL_PROMPT: "0",
      GIT_OPTIONAL_LOCKS: "0",
    },
    shell: false,
    windowsHide: true,
    timeout: 30000,
    maxBuffer: 2 * 1024 * 1024,
    encoding: "utf8",
  });
  return stdout;
}
export async function canonicalFuture(file) {
  let current = path.resolve(file);
  const suffix = [];
  for (;;) {
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
  root = await fs.realpath(root);
  check(
    samePath(
      root,
      await fs.realpath(
        (await git(root, "rev-parse", "--show-toplevel")).trim(),
      ),
    ),
    "exact_git_project_root_required",
  );
  const common = await fs.realpath(
    path.resolve(
      root,
      (await git(root, "rev-parse", "--git-common-dir")).trim(),
    ),
  );
  const head = (await git(root, "rev-parse", "--verify", "HEAD")).trim();
  check(sha(head), "git_head_unavailable");
  const branch =
    (
      await git(root, "symbolic-ref", "--quiet", "--short", "HEAD").catch(
        () => "",
      )
    ).trim() || null;
  return { root, common, head, branch };
}
export async function clean(root) {
  return (
    (await git(root, "status", "--porcelain=v1", "-z", "--untracked-files=all"))
      .length === 0
  );
}
export async function ancestor(root, before, after) {
  check(sha(before) && sha(after), "exact_commit_required");
  try {
    await git(root, "merge-base", "--is-ancestor", before, after);
    return true;
  } catch (error) {
    if (error.code === 1) return false;
    throw error;
  }
}
