import { object, text, version } from "./contracts.mjs";
import { evaluateOperation } from "./policy.mjs";
import { checkApproval } from "./approvals.mjs";
import { checkWorkerStart } from "./enforcement.mjs";
import { validateExternalSource, sourceMetadata } from "./provenance.mjs";

export const name = "rdsh-task-guard";
export const inject = ["tools"];

// Explicit subset of @deepseek-ai/dsh-tool-fs 0.2.0-rc.2. Offsets, escalation,
// editors, shell tools, PTC transports and every unknown tool fail closed.
export function dshOperation(exec, repository) {
  const input = exec.arguments;
  if (exec.name === "read") {
    object(input, ["file_path"]);
    return { schema: "rdsh.operation.v1", tool_name: "file.read",
      tool_input: { cwd: repository, path: input.file_path } };
  }
  if (exec.name === "write") {
    object(input, ["file_path", "content"]);
    return { schema: "rdsh.operation.v1", tool_name: "file.write",
      tool_input: { cwd: repository, path: input.file_path, content: input.content } };
  }
  throw new Error("Unsupported DSH tool");
}

export function apply(ctx, config) { return attachDshGuard(ctx, config); }

// Programmatic integration into a dedicated host context, not a modification of
// the user's installed DSH composition. readState/recordCheck are host services;
// none of these bindings are exposed as model-facing tools or grants.
export function attachDshGuard(ctx, config) {
  object(config, ["task", "readState", "recordCheck"]);
  const task = structuredClone(config.task);
  object(task, ["task_id", "contract_version", "repository", "run_id", "worker_role"]);
  text(task.task_id, "task_id", 160);
  version(task.contract_version, 1);
  text(task.repository, "repository", 4000);
  text(task.run_id, "run_id", 160);
  if (!["review", "implementation"].includes(task.worker_role) ||
      typeof config.readState !== "function" || typeof config.recordCheck !== "function" ||
      typeof ctx.tools?.guard !== "function" || typeof ctx.on !== "function")
    throw new Error("DSH monotonic guard and host check services required");
  Object.freeze(task);
  const reasons = new WeakMap(), bindings = new Map();
  let stopped = false;
  // Register denial before any asynchronous work. A skipped/failed pre-execute
  // listener, fake token, later allow/ask, or missing OS backend never opens it.
  ctx.tools.guard((exec) => stopped ? "rdsh:guard_stopped" :
    reasons.get(exec.token) || "rdsh:execution_not_checked");
  ctx.on("tools/pre-execute", async (exec) => {
    if (stopped) return { kind: "deny", reason: "rdsh:guard_stopped" };
    let report;
    try {
      const state = structuredClone(await config.readState());
      const binding = bindings.get(exec.callId);
      bindings.delete(exec.callId);
      const provenance = (binding?.sources || []).map(sourceMetadata);
      const worker = await checkWorkerStart(state, task);
      let policy = { decision: "unparsed", reason: "unsupported_dsh_tool_or_input" };
      let approval = { decision: "block", reason: "approval_binding_missing" };
      try {
        const operation = dshOperation(exec, task.repository);
        policy = await evaluateOperation(state, { task_id: task.task_id,
          contract_version: task.contract_version, repository: task.repository, operation });
        if (binding?.approval) approval = await checkApproval(state, {
          ...binding.approval, task_id: task.task_id, contract_version: task.contract_version,
          repository: task.repository, run_id: task.run_id, command_id: exec.callId, operation,
        });
      } catch { /* Unsupported tool fields never fall back to string matching. */ }
      const reason = policy.decision !== "within_policy" ? policy.reason :
        approval.decision !== "approval_valid" ? approval.reason : worker.reason;
      report = { schema: "rdsh.dsh-guard-check.v1", checked_at: new Date().toISOString(),
        ...task, command_id: text(exec.callId, "command_id", 160),
        tool_name: text(exec.name, "tool name", 160), policy, approval, worker, provenance,
        decision: "hold", reason, execution: "not_started", enforcement: "not_applied",
        fallback: "disabled", reservation: "not_reserved",
        uninspected_paths: ["session_replay", "compaction", "context_injection", "direct_backend_access"] };
      // Deliberately no claim or allow path: no complete OS adapter is registered.
      await config.recordCheck(structuredClone(report));
      reasons.set(exec.token, `rdsh:${reason}`);
    } catch {
      reasons.set(exec.token, "rdsh:check_or_audit_failed");
    }
    return { kind: "deny", reason: reasons.get(exec.token) };
  });
  return Object.freeze({
    async ready() {
      if (stopped) throw new Error("DSH guard stopped");
      return checkWorkerStart(structuredClone(await config.readState()), task);
    },
    bindCall(callId, binding) {
      if (stopped) throw new Error("DSH guard stopped");
      text(callId, "command_id", 160);
      object(binding, ["approval", "sources"]);
      if (bindings.has(callId) || bindings.size >= 1000) throw new Error("Duplicate or excessive call bindings");
      if (!Array.isArray(binding.sources) || binding.sources.length > 32) throw new Error("Invalid source bindings");
      if (binding.approval !== null) {
        object(binding.approval, ["id", "request_version", "attempt", "cost_usd"]);
        text(binding.approval.id, "request id", 160);
        version(binding.approval.request_version, 1);
        version(binding.approval.attempt, 1);
      }
      bindings.set(callId, { approval: structuredClone(binding.approval),
        sources: binding.sources.map(validateExternalSource) });
    },
    stop() { stopped = true; bindings.clear(); },
  });
}
