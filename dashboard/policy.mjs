import fs from "node:fs/promises";
import path from "node:path";
import {
  object, text, strings, version, filePath, directory, destination,
  contains, activeContract, checkContract, digest, storedDirectoryUnchanged,
} from "./contracts.mjs";

export const operationTools = ["file.read", "file.write", "process.exec", "network.request"];
export const operationCheckKeys = ["task_id", "contract_version", "repository", "operation"];
const shellFile = (file) => /^(?:ba|da|z|fi|k|a)?sh(?:\.exe)?$|^(?:cmd|powershell|pwsh)(?:\.exe)?$/i.test(path.basename(file));

// This is an explicit rdsh schema, not an inference about any external CLI's
// tool names. An adapter must translate and enforce the result at its boundary.
export function parseOperation(value) {
  object(value, ["schema", "tool_name", "tool_input"]);
  if (value.schema !== "rdsh.operation.v1" || !operationTools.includes(value.tool_name))
    throw new Error("Unknown operation schema or tool");
  const input = value.tool_input;
  const schemas = {
    "file.read": ["cwd", "path"],
    "file.write": ["cwd", "path", "content"],
    "process.exec": ["cwd", "executable", "args"],
    "network.request": ["cwd", "url", "method", "body"],
  };
  object(input, schemas[value.tool_name]);
  filePath(input.cwd, "cwd");
  if (!path.isAbsolute(input.cwd)) throw new Error("cwd must be absolute");
  const parsed = { tool: value.tool_name, cwd: input.cwd };
  if (value.tool_name.startsWith("file.")) {
    parsed.path = filePath(input.path, "target path");
    if (value.tool_name === "file.write") {
      if (typeof input.content !== "string" || Buffer.byteLength(input.content) > 65536)
        throw new Error("Invalid write content");
      parsed.data_digest = digest(input.content);
      parsed.data_bytes = Buffer.byteLength(input.content);
    }
  } else if (value.tool_name === "process.exec") {
    parsed.executable = filePath(input.executable, "executable");
    if (!path.isAbsolute(parsed.executable)) throw new Error("Executable must be absolute");
    if (shellFile(parsed.executable))
      throw new Error("Shell syntax is unsupported");
    const args = strings(input.args, "arguments");
    parsed.argument_count = args.length;
    parsed.arguments_digest = digest(args);
  } else {
    const url = new URL(text(input.url, "url", 4000));
    if (url.protocol !== "https:" || url.username || url.password || url.hash)
      throw new Error("Unsupported network URL");
    if (!["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"].includes(input.method))
      throw new Error("Unsupported HTTP method");
    if (typeof input.body !== "string" || Buffer.byteLength(input.body) > 65536 ||
        (["GET", "HEAD"].includes(input.method) && input.body !== ""))
      throw new Error("Invalid request body");
    parsed.origin = url.origin;
    // URL query and body can contain secrets; only their digest is retained.
    parsed.url_digest = digest(url.href);
    parsed.method = input.method;
    parsed.data_digest = digest(input.body);
    parsed.data_bytes = Buffer.byteLength(input.body);
  }
  return parsed;
}

export async function evaluateOperation(state, input) {
  const result = (decision, reason, details = {}) => ({
    decision, reason, ...details,
    layers: { pattern: "not_evaluated", structure: decision, enforcement: "not_applied" },
    execution: "hold", approval: "not_evaluated",
  });
  try {
    object(input, operationCheckKeys);
    text(input.task_id, "task_id", 160);
    version(input.contract_version, 1);
    const operation = parseOperation(input.operation);
    const contract = activeContract(state, input.task_id);
    const context = await checkContract(state, {
      task_id: input.task_id, contract_version: input.contract_version,
      repository: input.repository, cwd: operation.cwd,
      write_paths: operation.tool === "file.write" ? [operation.path] : [],
    });
    if (context.decision !== "within_scope") return result(context.decision, context.reason);
    const policy = contract.operation_policy || { read_roots: [], executables: [], network_origins: [] };
    operation.cwd = await directory(operation.cwd, "cwd");
    if (operation.tool.startsWith("file.")) {
      const lexical = path.resolve(operation.cwd, operation.path);
      if (!contains(contract.repository, lexical)) return result("block", "target_outside_repository");
      const resolved = await destination(operation.path, operation.cwd, contract.repository);
      if (!contains(contract.repository, resolved)) return result("block", "target_outside_repository");
      if (operation.tool === "file.read") {
        for (const root of policy.read_roots)
          if (!await storedDirectoryUnchanged(root)) return result("block", "read_root_changed");
        if (!policy.read_roots.some((root) => contains(root, lexical) && contains(root, resolved)))
          return result("block", "read_outside_policy");
        if (!(await fs.stat(resolved)).isFile()) return result("unparsed", "read_target_not_file");
      }
      operation.path = resolved;
    } else if (operation.tool === "process.exec") {
      let executable, isFile;
      const savedExecutable = policy.executables.some((rule) => rule.file === operation.executable);
      try {
        executable = await fs.realpath(operation.executable);
        isFile = (await fs.stat(executable)).isFile();
      }
      catch {
        if (savedExecutable)
          return result("block", "executable_changed_or_unavailable");
        throw new Error("Unresolved executable");
      }
      if (savedExecutable && (!isFile || executable !== operation.executable))
        return result("block", "executable_changed_or_unavailable");
      if (shellFile(executable) || !isFile)
        return result("unparsed", "shell_or_executable_unsupported");
      if (!policy.executables.some((rule) => rule.file === executable &&
          rule.argument_count === operation.argument_count && rule.arguments_digest === operation.arguments_digest))
        return result("block", "executable_or_arguments_outside_policy");
      operation.executable = executable;
    } else if (!policy.network_origins.includes(operation.origin)) {
      return result("block", "network_origin_outside_policy");
    }
    const binding = {
      project_id: state.project.id, task_id: input.task_id,
      contract_version: contract.version, repository: contract.repository, operation,
    };
    return result("within_policy", "structured_attributes_within_policy", {
      task_id: input.task_id, contract_version: contract.version,
      operation_digest: digest(binding),
      // This view contains no raw body, query string or argument values.
      attributes: operation,
    });
  } catch {
    return result("unparsed", "unsupported_or_unresolved_operation");
  }
}
