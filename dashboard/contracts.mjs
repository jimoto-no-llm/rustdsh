import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

const contractKeys = [
  "task_id", "expected_version", "purpose", "repository", "allowed_scope",
  "write_roots", "forbidden_actions", "completion_conditions", "change_reason", "operation_policy",
];
const checkKeys = ["task_id", "contract_version", "repository", "cwd", "write_paths"];

export function object(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some((key) => !keys.includes(key)))
    throw new Error("Unsupported contract input fields");
}
export function text(value, label, max = 8000) {
  if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0"))
    throw new Error(`Invalid ${label}`);
  return value;
}
export function strings(value, label, minimum = 0) {
  if (!Array.isArray(value) || value.length < minimum || value.length > 100)
    throw new Error(`Invalid ${label}`);
  return value.map((item) => text(item, label, 2000));
}
export function version(value, minimum) {
  if (!Number.isSafeInteger(value) || value < minimum)
    throw new Error("Invalid contract version");
}
export function contains(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." &&
    !relative.startsWith(".." + path.sep));
}
export function filePath(value, label) {
  text(value, label, 2000);
  // Reject ambiguous traversal, device paths and Windows alternate data streams.
  // A preflight never interprets these as a supported filesystem operation.
  if (value.split(/[\\/]/).includes("..")) throw new Error("Path traversal is unsupported");
  if (process.platform === "win32" &&
      (value.startsWith("\\\\") || /^[a-z]:(?![\\/])/i.test(value) ||
       /:/.test(value.replace(/^[a-z]:/i, "")) ||
       value.split(/[\\/]/).some((part) =>
         (/[. ]$/.test(part) && part !== ".") ||
         /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))))
    throw new Error("Ambiguous Windows path is unsupported");
  return value;
}
export async function directory(value, label) {
  filePath(value, label);
  if (!path.isAbsolute(value)) throw new Error(`${label} must be absolute`);
  try {
    const real = await fs.realpath(value);
    if (!(await fs.stat(real)).isDirectory()) throw new Error("Not a directory");
    return real;
  } catch {
    throw new Error(`Cannot resolve ${label} as a directory`);
  }
}
export function activeContract(state, taskId) {
  return state.contracts?.find((item) => item.task_id === taskId)?.versions.at(-1) || null;
}

export function digest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
export function networkOrigin(value) {
  const url = new URL(text(value, "network origin", 2000));
  if (url.protocol !== "https:" || url.username || url.password || url.hash ||
      url.search || url.pathname !== "/") throw new Error("Invalid network origin");
  return url.origin;
}
async function prepareOperationPolicy(input, repository) {
  if (input === undefined) return { schema: 1, read_roots: [], executables: [], network_origins: [] };
  object(input, ["schema", "read_roots", "executables", "network_origins"]);
  if (input.schema !== 1) throw new Error("Unsupported operation policy schema");
  const roots = [];
  for (const value of strings(input.read_roots, "read_roots")) {
    const root = await directory(value, "read root");
    if (!contains(repository, root)) throw new Error("Read root is outside the repository");
    if (!roots.includes(root)) roots.push(root);
  }
  if (!Array.isArray(input.executables) || input.executables.length > 100)
    throw new Error("Invalid executable policy");
  const executables = [];
  for (const command of input.executables) {
    object(command, ["file", "args"]);
    filePath(command.file, "executable");
    if (!path.isAbsolute(command.file)) throw new Error("Executable must be absolute");
    let file;
    try {
      file = await fs.realpath(command.file);
      if (!(await fs.stat(file)).isFile()) throw new Error("Not a file");
    } catch { throw new Error("Cannot resolve executable file"); }
    const args = strings(command.args, "arguments");
    executables.push({ file, argument_count: args.length, arguments_digest: digest(args) });
  }
  const origins = strings(input.network_origins, "network_origins").map(networkOrigin);
  return { schema: 1, read_roots: roots, executables, network_origins: [...new Set(origins)] };
}

export async function prepareContract(state, input) {
  object(input, contractKeys);
  const taskId = text(input.task_id, "task_id", 160);
  version(input.expected_version, 0);
  if (!state.tasks.some((task) => task.id === taskId)) throw new Error("Task not found");
  const current = activeContract(state, taskId);
  if (input.expected_version !== (current?.version || 0))
    throw new Error("Contract version changed; reload before updating");
  const repository = await directory(input.repository, "repository");
  if (repository !== await directory(state.project.root, "project repository"))
    throw new Error("Contract repository must match this project");
  const writeRoots = [];
  for (const value of strings(input.write_roots, "write_roots")) {
    const root = await directory(value, "write root");
    if (!contains(repository, root)) throw new Error("Write root is outside the repository");
    if (!writeRoots.includes(root)) writeRoots.push(root);
  }
  return {
    version: (current?.version || 0) + 1,
    purpose: text(input.purpose, "purpose"),
    repository,
    allowed_scope: text(input.allowed_scope, "allowed_scope"),
    write_roots: writeRoots,
    operation_policy: await prepareOperationPolicy(input.operation_policy, repository),
    forbidden_actions: strings(input.forbidden_actions, "forbidden_actions"),
    completion_conditions: strings(input.completion_conditions, "completion_conditions", 1),
    change_reason: text(input.change_reason, "change_reason", 2000),
    changed_at: new Date().toISOString(),
    authority: "local_administrator",
    // This is a binding for future approval checks, never an approval itself.
    approval_reuse: "requires_revalidation",
  };
}

export async function storedDirectoryUnchanged(root) {
  try { return await directory(root, "stored root") === root; }
  catch { return false; }
}

export async function destination(value, cwd, repository) {
  filePath(value, "write path");
  const components = path.relative(repository, path.resolve(cwd, value)).split(path.sep).filter(Boolean);
  let current = repository;
  for (let index = 0; index < components.length; index++) {
    const candidate = path.join(current, components[index]);
    try {
      await fs.lstat(candidate);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      return path.join(current, ...components.slice(index));
    }
    // A dangling link fails here. Check each existing prefix so a link leaving
    // the repo cannot reenter it through a second link and appear in scope.
    current = await fs.realpath(candidate);
    if (!contains(repository, current)) return current;
  }
  return current;
}

export async function checkContract(state, input) {
  const result = (decision, reason, contract = null) => ({
    decision, reason, task_id: typeof input?.task_id === "string" ? input.task_id.slice(0, 160) : null,
    contract_version: contract?.version || null,
    approval: "not_evaluated", enforcement: "preflight_only",
  });
  try {
    object(input, checkKeys);
    text(input.task_id, "task_id", 160);
    version(input.contract_version, 1);
    const writes = strings(input.write_paths, "write_paths");
    const contract = activeContract(state, input.task_id);
    if (!contract) return result("block", "contract_missing");
    if (input.contract_version !== contract.version)
      return result("block", "contract_version_changed", contract);
    const repository = await directory(input.repository, "repository");
    if (repository !== contract.repository ||
        repository !== await directory(state.project.root, "project repository"))
      return result("block", "repository_outside_contract", contract);
    const cwd = await directory(input.cwd, "cwd");
    if (!contains(repository, cwd)) return result("block", "cwd_outside_contract", contract);
    // Stored canonical roots must still resolve to themselves; retargeted links
    // cannot widen a contract that was saved earlier.
    for (const root of contract.write_roots)
      if (!await storedDirectoryUnchanged(root))
        return result("block", "write_root_changed", contract);
    for (const value of writes) {
      const lexical = path.resolve(cwd, filePath(value, "write path"));
      if (!contains(repository, lexical) ||
          !contract.write_roots.some((root) => contains(root, lexical)))
        return result("block", "write_outside_contract", contract);
      const resolved = await destination(value, cwd, repository);
      if (!contains(repository, resolved) ||
          !contract.write_roots.some((root) => contains(root, lexical) && contains(root, resolved)))
        return result("block", "write_outside_contract", contract);
    }
    return result("within_scope", "declared_paths_within_contract", contract);
  } catch {
    // Do not echo supplied paths, free text, or OS errors into diagnostics.
    return result("unparsed", "unsupported_or_unresolved_input");
  }
}
