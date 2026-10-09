import fs from "node:fs/promises";
import { activeContract, object, text, version, storedDirectoryUnchanged, checkContract } from "./contracts.mjs";

// No OS sandbox adapter is registered in this release. A request, environment
// variable, approval, or reported capability can never supply one.
export async function checkWorkerStart(state, input) {
  const result = (decision, reason, details = {}) => ({
    decision, reason, ...details, execution: "not_started", enforcement: "not_applied",
    effective_permissions: null, fallback: "disabled",
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
    for (const root of policy.read_roots)
      if (!await storedDirectoryUnchanged(root)) return result("block", "read_root_changed");
    for (const rule of policy.executables) {
      let unchanged = false;
      try { unchanged = await fs.realpath(rule.file) === rule.file && (await fs.stat(rule.file)).isFile(); }
      catch { /* Stored executable disappeared or became inaccessible. */ }
      if (!unchanged)
        return result("block", "executable_changed_or_unavailable");
    }
    return result("hold", "enforcement_adapter_unavailable", {
      task_id: input.task_id, contract_version: contract.version, run_id: input.run_id,
      worker_role: input.worker_role,
      requested_permissions: structuredClone({
        repository: contract.repository,
        read_roots: policy.read_roots,
        write_roots: input.worker_role === "review" ? [] : contract.write_roots,
        executables: input.worker_role === "review" ? [] : policy.executables,
        network_origins: input.worker_role === "review" ? [] : policy.network_origins,
      }),
      required_enforcement: ["filesystem_read", "filesystem_write", "network", "exact_command_arguments",
        "child_process_inheritance", "symlink_and_hardlink_escape", "race_safe_access"],
    });
  } catch {
    return result("unparsed", "unsupported_or_unresolved_worker_request");
  }
}
