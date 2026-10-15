import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  WorkerError,
  headSha,
  requireWorker,
  samePath,
} from "./worker-scopes.mjs";

const exec = promisify(execFile);
// observe-worktree runs up to five Git commands, each bounded to 30s in Rust.
// Keep margin for process-tree cleanup and slow Windows filesystem startup.
export const NATIVE_REQUEST_TIMEOUT_MS = 300_000;
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
async function legacyWorkerGit(root, ...args) {
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
async function legacyCanonicalFuture(file) {
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
async function legacyRepository(root) {
  const canonical = await fs.realpath(root);
  const top = await fs.realpath(
    (await legacyWorkerGit(canonical, "rev-parse", "--show-toplevel")).trim(),
  );
  requireWorker(samePath(canonical, top), "exact_git_project_root_required");
  const common = await fs.realpath(
    path.resolve(
      canonical,
      (await legacyWorkerGit(canonical, "rev-parse", "--git-common-dir")).trim(),
    ),
  );
  const head = (
    await legacyWorkerGit(canonical, "rev-parse", "--verify", "HEAD")
  ).trim();
  requireWorker(headSha(head), "git_head_unavailable");
  const branch =
    (
      await legacyWorkerGit(
        canonical,
        "symbolic-ref",
        "--quiet",
        "--short",
        "HEAD",
      ).catch(() => "")
    ).trim() || null;
  return { root: canonical, git_common_dir: common, head_sha: head, branch };
}
async function legacyDirtyPaths(root) {
  const parts = (
    await legacyWorkerGit(
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
async function legacyChangedPaths(root, from, to) {
  requireWorker(headSha(from) && headSha(to), "invalid_git_comparison");
  return (
    await legacyWorkerGit(
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
async function legacyTrackedPaths(root) {
  return (await legacyWorkerGit(root, "ls-files", "-z", "--cached"))
    .split("\0")
    .filter(Boolean);
}

const NATIVE_UNAVAILABLE = Symbol("native worker-git unavailable");
const workerGitCapabilities = new Map();
// Rust caps each Git stream at 2 MiB; JSON can escape control characters and
// observe-worktree returns the same paths in multiple arrays.
const MAX_NATIVE_STDOUT_BYTES = 64 * 1024 * 1024;
const MAX_NATIVE_STDERR_BYTES = 2 * 1024 * 1024;

function executable(file) {
  try {
    if (!fsSync.statSync(file).isFile()) return false;
    if (process.platform !== "win32") fsSync.accessSync(file, fsSync.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function supportsWorkerGit(file) {
  let stat;
  try {
    stat = fsSync.statSync(file);
  } catch {
    return false;
  }
  const key = [file, stat.dev, stat.ino, stat.size, stat.mtimeMs].join(":");
  let pending = workerGitCapabilities.get(key);
  if (!pending) {
    pending = exec(file, ["worker-git", "--help"], {
      env: environment(),
      windowsHide: true,
      shell: false,
      timeout: 2_000,
      maxBuffer: 64 * 1024,
      encoding: "buffer",
    })
      .then(({ stdout, stderr }) => {
        const help = new TextDecoder("utf-8", { fatal: false }).decode(
          Buffer.concat([stdout, Buffer.from("\n"), stderr]),
        );
        return /Internal JSON bridge for dashboard Git observations/.test(help);
      })
      .catch(() => false);
    workerGitCapabilities.set(key, pending);
  }
  return pending;
}

async function workerGitExecutable() {
  const name = process.platform === "win32" ? "rdsh.exe" : "rdsh";
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const override = process.env.RDSH_BIN;
  if (override && !path.isAbsolute(override)) {
    throw new Error("RDSH_BIN must be an absolute path");
  }
  const candidates = override
    ? [override]
    : [
        path.join(root, "target", "debug", name),
        path.join(root, "target", "release", name),
        ...(process.env.PATH || "")
          .split(path.delimiter)
          .filter((directory) => path.isAbsolute(directory))
          .map((directory) => path.join(directory, name)),
      ];
  for (const candidate of candidates) {
    if (executable(candidate) && (await supportsWorkerGit(candidate))) {
      return candidate;
    }
  }
  return null;
}

async function nativeRequest(request, executablePath = null) {
  executablePath ??= await workerGitExecutable();
  if (!executablePath) return NATIVE_UNAVAILABLE;
  const result = await new Promise((resolve, reject) => {
    const child = spawn(executablePath, ["worker-git"], {
      env: environment(),
      windowsHide: true,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let overflow = false;
    let timedOut = false;
    let stdinError = null;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, NATIVE_REQUEST_TIMEOUT_MS);

    const capture = (chunks, chunk, current, limit) => {
      if (current + chunk.length > limit) {
        overflow = true;
        child.kill();
        return current;
      }
      chunks.push(chunk);
      return current + chunk.length;
    };
    child.stdout.on("data", (chunk) => {
      stdoutBytes = capture(stdout, chunk, stdoutBytes, MAX_NATIVE_STDOUT_BYTES);
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes = capture(stderr, chunk, stderrBytes, MAX_NATIVE_STDERR_BYTES);
    });
    child.stdin.on("error", (error) => {
      stdinError = error;
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (status) => {
      clearTimeout(timer);
      if (timedOut) {
        const error = new Error(
          `rdsh worker-git timed out after ${NATIVE_REQUEST_TIMEOUT_MS / 1000} seconds`,
        );
        error.code = "ETIMEDOUT";
        reject(error);
        return;
      }
      if (overflow) {
        const error = new Error("rdsh worker-git output exceeds the safe limit");
        error.code = "ENOBUFS";
        reject(error);
        return;
      }
      resolve({
        status,
        stdout: Buffer.concat(stdout, stdoutBytes),
        stderr: Buffer.concat(stderr, stderrBytes),
        stdinError,
      });
    });
    child.stdin.end(Buffer.from(JSON.stringify(request)));
  });
  if (result.status !== 0) {
    const detail = new TextDecoder("utf-8", { fatal: false })
      .decode(result.stderr)
      .trim();
    const code = detail.match(/^\[rdsh\] error: ([a-z][a-z0-9_]+)$/)?.[1];
    if (code) throw new WorkerError(code);
    const error = new Error(detail || `rdsh worker-git failed with status ${result.status}`);
    error.code = result.status;
    throw error;
  }
  if (result.stdinError) throw result.stdinError;
  const output = new TextDecoder("utf-8", { fatal: true }).decode(result.stdout);
  return JSON.parse(output);
}

function nativeRequestForGitCommand(root, args) {
  if (
    args.length === 4 &&
    args[0] === "merge-base" &&
    args[1] === "--is-ancestor"
  ) {
    return {
      op: "is-ancestor",
      root,
      ancestor: args[2],
      descendant: args[3],
    };
  }
  if (
    args.length === 10 &&
    args[0] === "-c" &&
    args[1].startsWith("core.hooksPath=") &&
    args[2] === "worktree" &&
    args[3] === "add" &&
    args[4] === "--no-track" &&
    args[5] === "-b" &&
    args[7] === "--"
  ) {
    return {
      op: "add-worktree",
      root,
      hooks: args[1].slice("core.hooksPath=".length),
      branch: args[6],
      path: args[8],
      base: args[9],
    };
  }
  return null;
}

export async function workerGit(root, ...args) {
  const executablePath = await workerGitExecutable();
  if (executablePath) {
    const request = nativeRequestForGitCommand(root, args);
    if (!request) throw new Error("unsupported worker-git compatibility command");
    await nativeRequest(request, executablePath);
    return "";
  }
  return legacyWorkerGit(root, ...args);
}

export async function canonicalFuture(file) {
  const native = await nativeRequest({ op: "canonical-future", path: file });
  return native === NATIVE_UNAVAILABLE ? legacyCanonicalFuture(file) : native;
}

export async function repository(root) {
  const native = await nativeRequest({ op: "repository", root });
  return native === NATIVE_UNAVAILABLE ? legacyRepository(root) : native;
}

export async function dirtyPaths(root) {
  const native = await nativeRequest({ op: "dirty-paths", root });
  return native === NATIVE_UNAVAILABLE ? legacyDirtyPaths(root) : native;
}

export async function changedPaths(root, from, to) {
  const native = await nativeRequest({ op: "changed-paths", root, from, to });
  return native === NATIVE_UNAVAILABLE
    ? legacyChangedPaths(root, from, to)
    : native;
}

export async function trackedPaths(root) {
  const native = await nativeRequest({ op: "tracked-paths", root });
  return native === NATIVE_UNAVAILABLE ? legacyTrackedPaths(root) : native;
}

export async function sourceSnapshot(root) {
  const native = await nativeRequest({ op: "source-snapshot", root });
  if (native !== NATIVE_UNAVAILABLE) return native;
  const info = await legacyRepository(root);
  return {
    ...info,
    dirty_paths: await legacyDirtyPaths(info.root),
  };
}

export async function observeWorktree(root, { git_common_dir, branch, base }) {
  const native = await nativeRequest({
    op: "observe-worktree",
    root,
    git_common_dir,
    branch,
    base,
  });
  if (native !== NATIVE_UNAVAILABLE) return native;

  const current = await legacyRepository(root);
  requireWorker(
    samePath(current.git_common_dir, git_common_dir) &&
      current.branch === branch,
    "worker_worktree_identity_changed",
  );
  await legacyWorkerGit(
    root,
    "merge-base",
    "--is-ancestor",
    base,
    current.head_sha,
  );
  const dirty = await legacyDirtyPaths(root);
  const committed = await legacyChangedPaths(root, base, current.head_sha);
  const changed = [...new Set([...dirty, ...committed])].sort();
  requireWorker(
    (await legacyRepository(root)).head_sha === current.head_sha,
    "worker_head_changed_during_scan",
  );
  return {
    head_sha: current.head_sha,
    dirty_paths: dirty,
    committed_paths: committed,
    changed_paths: changed,
  };
}
