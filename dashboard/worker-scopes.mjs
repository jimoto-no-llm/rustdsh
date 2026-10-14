// Declarations and observed changes. Runtime tool/sandbox policy remains in DSH.
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export class WorkerError extends Error {
  constructor(code, details = null) {
    super("Worker workspaces: " + code);
    this.code = code;
    this.details = details;
  }
}
export function requireWorker(value, code, details = null) {
  if (!value) throw new WorkerError(code, details);
}
export const workerId = (v) =>
  typeof v === "string" && /^[a-z][a-z0-9-]{0,39}$/.test(v);
export const headSha = (v) =>
  typeof v === "string" && /^[0-9a-f]{40,64}$/.test(v);
export const covers = (scope, file) => {
  if (process.platform === "win32") {
    scope = scope.toLowerCase();
    file = file.toLowerCase();
  }
  return scope === "." || file === scope || file.startsWith(scope + "/");
};
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
function relativeScope(value) {
  requireWorker(
    typeof value === "string" &&
      value.length > 0 &&
      value.length <= 512 &&
      !/[\x00-\x1f\x7f\\:*?\[\]]/.test(value) &&
      !path.isAbsolute(value),
    "invalid_scope_path",
  );
  if (value === ".") return value;
  const normalized = value.endsWith("/") ? value.slice(0, -1) : value;
  requireWorker(
    normalized.split("/").every((p) => p && p !== "." && p !== "..") &&
      !covers(".git", normalized),
    "invalid_scope_path",
  );
  return normalized;
}
function paths(input, { empty = false } = {}) {
  requireWorker(
    Array.isArray(input) && input.length <= 64 && (empty || input.length > 0),
    "invalid_scope_paths",
  );
  return [...new Set(input.map(relativeScope))].sort();
}
export function leaseSeconds(value) {
  requireWorker(
    Number.isSafeInteger(value) && value >= 1 && value <= 604800,
    "invalid_lease_seconds",
  );
  return value;
}
function legacyDeclaration(input) {
  const allowed = [
    "worker_id",
    "role",
    "read_paths",
    "write_paths",
    "modules",
    "forbidden_paths",
    "lease_seconds",
  ];
  requireWorker(
    input &&
      typeof input === "object" &&
      !Array.isArray(input) &&
      Object.keys(input).every((k) => allowed.includes(k)),
    "invalid_worker_declaration",
  );
  requireWorker(
    workerId(input.worker_id) && ["edit", "review"].includes(input.role),
    "invalid_worker_role_or_id",
  );
  const reads = paths(input.read_paths);
  const writes = paths(input.write_paths ?? [], {
    empty: input.role === "review",
  });
  requireWorker(
    input.role !== "review" || writes.length === 0,
    "review_worker_is_read_only",
  );
  requireWorker(
    writes.every((p) => reads.some((r) => covers(r, p))),
    "write_scope_must_be_readable",
  );
  const forbidden = paths(input.forbidden_paths ?? [], { empty: true });
  requireWorker(!forbidden.includes("."), "all_paths_forbidden");
  requireWorker(
    Array.isArray(input.modules) &&
      input.modules.length > 0 &&
      input.modules.length <= 32 &&
      input.modules.every(
        (v) =>
          typeof v === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,79}$/.test(v),
      ),
    "invalid_worker_modules",
  );
  return {
    worker_id: input.worker_id,
    role: input.role,
    read_paths: reads,
    write_paths: writes,
    modules: [...new Set(input.modules)].sort(),
    forbidden_paths: forbidden,
    lease_seconds: leaseSeconds(input.lease_seconds),
  };
}

function executable(file) {
  try {
    if (!fs.statSync(file).isFile()) return false;
    if (process.platform !== "win32") fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function rdshExecutable() {
  if (process.env.RDSH_BIN) return path.resolve(process.env.RDSH_BIN);
  const executableName = process.platform === "win32" ? "rdsh.exe" : "rdsh";
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const candidates = [
    path.join(root, "target", "debug", executableName),
    path.join(root, "target", "release", executableName),
    ...(process.env.PATH || "").split(path.delimiter).map((directory) =>
      path.join(directory, executableName),
    ),
  ];
  return candidates.find(executable) ?? null;
}

function normalizedDeclaration(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WorkerError("native_worker_policy_unavailable");
  }
  return {
    worker_id: value.worker_id,
    role: value.role,
    read_paths: value.read_paths,
    write_paths: value.write_paths,
    modules: value.modules,
    forbidden_paths: value.forbidden_paths,
    lease_seconds: value.lease_seconds,
  };
}

function legacyDeclarationResults(inputs) {
  return inputs.map((input) => {
    try {
      return { ok: true, value: legacyDeclaration(input) };
    } catch (error) {
      if (error instanceof WorkerError) return { ok: false, code: error.code };
      throw error;
    }
  });
}

export function declarationResults(inputs) {
  requireWorker(Array.isArray(inputs), "invalid_scope_declarations");
  if (inputs.length === 0) return [];
  const binary = rdshExecutable();
  if (!binary) return legacyDeclarationResults(inputs);

  const output = spawnSync(binary, ["worker-scope", "validate"], {
    input: JSON.stringify(inputs),
    encoding: "utf8",
    windowsHide: true,
    shell: false,
    timeout: 10_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (output.error?.code === "ENOENT" && !process.env.RDSH_BIN) {
    return legacyDeclarationResults(inputs);
  }
  if (output.error || output.status !== 0) {
    throw new WorkerError("native_worker_policy_unavailable");
  }
  let parsed;
  try {
    parsed = JSON.parse(output.stdout);
  } catch {
    throw new WorkerError("native_worker_policy_unavailable");
  }
  if (!Array.isArray(parsed) || parsed.length !== inputs.length) {
    throw new WorkerError("native_worker_policy_unavailable");
  }
  return parsed.map((result) => {
    if (result?.ok === true) {
      return { ok: true, value: normalizedDeclaration(result.value) };
    }
    if (
      result?.ok === false &&
      typeof result.code === "string" &&
      /^[a-z0-9_]+$/.test(result.code)
    ) {
      return { ok: false, code: result.code };
    }
    throw new WorkerError("native_worker_policy_unavailable");
  });
}

export function declaration(input) {
  const result = declarationResults([input])[0];
  if (!result.ok) throw new WorkerError(result.code);
  return result.value;
}
export function mayWrite(scope, file) {
  return (
    !covers(".git", file) &&
    scope.write_paths.some((p) => covers(p, file)) &&
    !scope.forbidden_paths.some((p) => covers(p, file))
  );
}
export function intersections(a, b) {
  const overlaps = [];
  for (const x of a.write_paths)
    for (const y of b.write_paths) {
      const narrow = covers(x, y) ? y : covers(y, x) ? x : null;
      if (narrow && mayWrite(a, narrow) && mayWrite(b, narrow))
        overlaps.push(narrow);
    }
  return [...new Set(overlaps)].sort();
}
export function sharedFile(file) {
  return (
    /^(?:Cargo\.(?:lock|toml)|package(?:-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|go\.(?:mod|sum)|pyproject\.toml|uv\.lock|(?:tsconfig|config|settings)(?:\.[^.]+)?\.json)$/i.test(
      file.split("/").at(-1),
    ) || file.startsWith(".github/workflows/")
  );
}
