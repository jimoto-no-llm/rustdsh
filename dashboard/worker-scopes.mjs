// Declarations and observed changes. Runtime tool/sandbox policy remains in DSH.
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MAX_NATIVE_POLICY_BATCH_ITEMS = 4096;
const workerScopeCapabilities = new Map();

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
const isGitMetadataPath = (file) =>
  file.split("/").some((component) =>
    process.platform === "win32"
      ? component.toLowerCase() === ".git"
      : component === ".git",
  );
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
      !isGitMetadataPath(normalized),
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

function supportsWorkerScope(file) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return false;
  }
  const cacheKey = [file, stat.dev, stat.ino, stat.size, stat.mtimeMs].join(":");
  const cached = workerScopeCapabilities.get(cacheKey);
  if (cached !== undefined) return cached;

  const result = spawnSync(file, ["--help"], {
    encoding: "utf8",
    windowsHide: true,
    shell: false,
    timeout: 2_000,
    maxBuffer: 64 * 1024,
  });
  const help = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const supported =
    !result.error &&
    result.status === 0 &&
    /(?:^|\r?\n)\s*worker-scope\s{2,}\S/.test(help);
  workerScopeCapabilities.set(cacheKey, supported);
  return supported;
}

function rdshExecutable() {
  if (process.env.RDSH_BIN) {
    if (!path.isAbsolute(process.env.RDSH_BIN)) {
      throw new WorkerError("invalid_rdsh_bin");
    }
    return path.resolve(process.env.RDSH_BIN);
  }
  const executableName = process.platform === "win32" ? "rdsh.exe" : "rdsh";
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const candidates = [
    path.join(root, "target", "debug", executableName),
    path.join(root, "target", "release", executableName),
  ];
  return candidates.find((candidate) =>
    executable(candidate) && supportsWorkerScope(candidate),
  ) ?? null;
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

function legacyPolicyResults(input) {
  return {
    write_checks: (input.write_checks ?? []).map(({ scope, files }) =>
      files.map((file) => mayWrite(scope, file)),
    ),
    intersections: (input.intersections ?? []).map(({ left, right }) =>
      intersections(left, right),
    ),
    shared_files: (input.shared_files ?? []).map(sharedFile),
  };
}

export function policyResults(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new WorkerError("invalid_scope_policy_batch");
  }
  const request = {
    write_checks: input.write_checks ?? [],
    intersections: input.intersections ?? [],
    shared_files: input.shared_files ?? [],
  };
  if (
    !Array.isArray(request.write_checks) ||
    !Array.isArray(request.intersections) ||
    !Array.isArray(request.shared_files)
  ) {
    throw new WorkerError("invalid_scope_policy_batch");
  }
  if (
    request.write_checks.length === 0 &&
    request.intersections.length === 0 &&
    request.shared_files.length === 0
  ) {
    return { write_checks: [], intersections: [], shared_files: [] };
  }

  if (
    request.write_checks.length > MAX_NATIVE_POLICY_BATCH_ITEMS ||
    request.intersections.length > MAX_NATIVE_POLICY_BATCH_ITEMS ||
    request.shared_files.length > MAX_NATIVE_POLICY_BATCH_ITEMS
  ) {
    return legacyPolicyResults(request);
  }

  const binary = rdshExecutable();
  if (!binary) return legacyPolicyResults(request);
  const serialized = JSON.stringify(request);
  if (Buffer.byteLength(serialized) > 2 * 1024 * 1024) {
    return legacyPolicyResults(request);
  }
  const output = spawnSync(binary, ["worker-scope", "policy"], {
    input: serialized,
    encoding: "utf8",
    windowsHide: true,
    shell: false,
    timeout: 10_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (output.error?.code === "ENOENT" && !process.env.RDSH_BIN) {
    return legacyPolicyResults(request);
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
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !Array.isArray(parsed.write_checks) ||
    parsed.write_checks.length !== request.write_checks.length ||
    !Array.isArray(parsed.intersections) ||
    parsed.intersections.length !== request.intersections.length ||
    !Array.isArray(parsed.shared_files) ||
    parsed.shared_files.length !== request.shared_files.length
  ) {
    throw new WorkerError("native_worker_policy_unavailable");
  }
  const writeChecksValid = parsed.write_checks.every(
    (results, index) =>
      Array.isArray(results) &&
      results.length === request.write_checks[index].files.length &&
      results.every((value) => typeof value === "boolean"),
  );
  const intersectionsValid = parsed.intersections.every(
    (paths) =>
      Array.isArray(paths) && paths.every((value) => typeof value === "string"),
  );
  if (
    !writeChecksValid ||
    !intersectionsValid ||
    !parsed.shared_files.every((value) => typeof value === "boolean")
  ) {
    throw new WorkerError("native_worker_policy_unavailable");
  }
  return parsed;
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
    !isGitMetadataPath(file) &&
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
