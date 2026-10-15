import fs from "node:fs/promises";
import { activeContract, contains, object, text, version, storedDirectoryUnchanged, checkContract } from "./contracts.mjs";
import { probeSandbox } from "./worker-sandbox.mjs";

// This checks the real Linux sandbox profile used by the approved-operation
// executor. It never starts an LLM worker or enables direct DSH tool calls.
export async function checkWorkerStart(state, input, { probe = probeSandbox } = {}) {
  const result = (decision, reason, details = {}) => ({
    ...details, decision, reason, execution: "not_started",
    enforcement: decision === "ready" ? "available" : "not_applied",
    effective_permissions: details.effective_permissions ?? null, fallback: "disabled",
  });
  try {
    object(input, ["task_id", "contract_version", "repository", "run_id", "worker_role"]);
    text(input.task_id, "task_id", 160);
    version(input.contract_version, 1);
    text(input.run_id, "run_id", 160);
    if (!["review", "implementation"].includes(input.worker_role)) throw new Error("Unknown worker role");
    const checked = await checkContract(state, {
      task_id: input.task_id, contract_version: input.contract_version,
      repository: input.repository, cwd: input.repository, write_paths: [],
    });
    if (checked.decision !== "within_scope") return result(checked.decision, checked.reason);
    const contract = activeContract(state, input.task_id);
    const policy = contract.operation_policy || { read_roots: [], executables: [], network_origins: [] };
    const workerRoles = contract.worker_roles || ["review"];
    if (!workerRoles.includes(input.worker_role))
      return result("block", "worker_role_outside_contract");
    const readRoots = policy.read_roots || [];
    const writeRoots = contract.write_roots || [];
    if (!Array.isArray(readRoots) || !Array.isArray(writeRoots) ||
        [...readRoots, ...writeRoots].some((root) => !contains(contract.repository, root)))
      return result("block", "sandbox_root_outside_contract");
    for (const root of readRoots)
      if (!await storedDirectoryUnchanged(root)) return result("block", "read_root_changed");
    for (const rule of policy.executables) {
      let unchanged = false;
      try { unchanged = await fs.realpath(rule.file) === rule.file && (await fs.stat(rule.file)).isFile(); }
      catch { /* Stored executable disappeared or became inaccessible. */ }
      if (!unchanged)
        return result("block", "executable_changed_or_unavailable");
    }
    const permissions = {
      repository: contract.repository,
      read_roots: readRoots,
      write_roots: input.worker_role === "review" ? [] : writeRoots,
      executables: input.worker_role === "review" ? [] : policy.executables,
      network_origins: input.worker_role === "review" ? [] : policy.network_origins,
    };
    const sandbox = await probe();
    if (!sandbox.supported)
      return result("hold", sandbox.reason || "sandbox_probe_failed", {
        task_id: input.task_id, contract_version: contract.version, run_id: input.run_id,
        worker_role: input.worker_role, requested_permissions: permissions,
        required_enforcement: ["filesystem_read", "filesystem_write", "network",
          "exact_command_arguments", "child_process_inheritance", "symlink_and_hardlink_escape"],
      });
    return result("ready", "sandboxed_operation_executor_available", {
      task_id: input.task_id, contract_version: contract.version, run_id: input.run_id,
      worker_role: input.worker_role,
      requested_permissions: structuredClone(permissions),
      required_enforcement: ["filesystem_read", "filesystem_write", "network",
        "exact_command_arguments", "child_process_inheritance", "symlink_and_hardlink_escape"],
      effective_permissions: structuredClone({
        ...permissions, backend: sandbox.backend, verified: true,
      }),
    });
  } catch {
    return result("unparsed", "unsupported_or_unresolved_worker_request");
  }
}
