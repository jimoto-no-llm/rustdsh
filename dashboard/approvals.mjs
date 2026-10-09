import { object, text, version } from "./contracts.mjs";
import { evaluateOperation } from "./policy.mjs";

const requestKeys = ["id", "expected_version", "task_id", "contract_version", "repository", "run_id", "command_id", "operation", "limits", "expires_at", "source_ref"];
const useKeys = ["id", "request_version", "task_id", "contract_version", "repository", "run_id", "command_id", "operation", "attempt", "cost_usd"];
export function currentRequest(state, id) {
  return state.approval_requests?.find((item) => item.id === id)?.versions.at(-1) || null;
}
function cost(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1000000 ||
      Math.round(value * 1000000) / 1000000 !== value) throw new Error("Invalid declared cost");
  return Math.round(value * 1000000);
}
function expiry(value, now) {
  text(value, "expires_at", 40);
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value || time <= now ||
      time - now > 7 * 86400000) throw new Error("Expiry must be a future UTC timestamp within seven days");
  return value;
}
function policyInput(input) {
  return { task_id: input.task_id, contract_version: input.contract_version,
    repository: input.repository, operation: input.operation };
}
export async function prepareApprovalRequest(state, input, now = Date.now()) {
  object(input, requestKeys);
  text(input.id, "request id", 160);
  version(input.expected_version, 0);
  const previous = currentRequest(state, input.id);
  if (input.expected_version !== (previous?.version || 0))
    throw new Error("Approval request version changed; reload before updating");
  object(input.limits, ["max_cost_usd", "max_attempts"]);
  const maxCost = cost(input.limits.max_cost_usd);
  if (!Number.isSafeInteger(input.limits.max_attempts) || input.limits.max_attempts < 1 || input.limits.max_attempts > 10)
    throw new Error("Invalid retry limit");
  const checked = await evaluateOperation(state, policyInput(input));
  if (checked.decision !== "within_policy") throw new Error("Approval request is outside a parsed task policy");
  return {
    version: (previous?.version || 0) + 1,
    task_id: input.task_id, contract_version: input.contract_version,
    project_id: state.project.id,
    run_id: text(input.run_id, "run_id", 160), command_id: text(input.command_id, "command_id", 160),
    operation_digest: checked.operation_digest, attributes: checked.attributes,
    limits: { max_cost_usd: maxCost / 1000000, max_attempts: input.limits.max_attempts },
    expires_at: expiry(input.expires_at, now), source_ref: text(input.source_ref, "source_ref", 2000),
    created_at: new Date(now).toISOString(), status: "pending",
    approver: null, decided_at: null, decisions: [], uses: [], reserved_cost_microusd: 0,
  };
}
export function decideApproval(state, input, authority, now = Date.now()) {
  if (authority !== "human_browser") throw new Error("Human browser credential required");
  object(input, ["id", "request_version", "decision"]);
  text(input.id, "request id", 160);
  version(input.request_version, 1);
  const request = currentRequest(state, input.id);
  if (!request || request.version !== input.request_version) throw new Error("Approval request version changed or missing");
  if (!["grant", "reject", "revoke"].includes(input.decision)) throw new Error("Invalid approval decision");
  if (input.decision === "revoke") {
    if (request.status !== "granted") throw new Error("Only a granted approval can be revoked");
  } else {
    if (request.status !== "pending") throw new Error("Approval request already decided");
    if (Date.parse(request.expires_at) <= now) throw new Error("Approval request expired");
  }
  request.status = { grant: "granted", reject: "rejected", revoke: "revoked" }[input.decision];
  request.approver = "dashboard_owner";
  request.authenticated_by = "human_browser_credential";
  request.decided_at = new Date(now).toISOString();
  request.decisions ||= [];
  request.decisions.push({ decision: input.decision, approver: request.approver,
    authenticated_by: request.authenticated_by, decided_at: request.decided_at });
}

export async function checkApproval(state, input, now = Date.now()) {
  const result = (decision, reason, extra = {}) => ({
    decision, reason, ...extra, execution: "hold", enforcement: "not_applied",
  });
  try {
    object(input, useKeys);
    text(input.id, "request id", 160);
    version(input.request_version, 1);
    const declaredCost = cost(input.cost_usd);
    version(input.attempt, 1);
    const request = currentRequest(state, input.id);
    if (!request) return result("block", "approval_request_missing");
    if (request.version !== input.request_version) return result("block", "approval_request_version_changed");
    const ref = { request_id: input.id, request_version: request.version };
    if (request.status !== "granted") return result("block", `approval_${request.status}`, ref);
    if (Date.parse(request.expires_at) <= now) return result("block", "approval_expired", ref);
    if (input.task_id !== request.task_id || input.contract_version !== request.contract_version ||
        input.run_id !== request.run_id || input.command_id !== request.command_id)
      return result("block", "approval_context_changed", ref);
    const checked = await evaluateOperation(state, policyInput(input));
    if (checked.decision !== "within_policy") return result(checked.decision, checked.reason, ref);
    if (checked.operation_digest !== request.operation_digest) return result("block", "approval_operation_changed", ref);
    if (input.attempt !== request.uses.length + 1 || input.attempt > request.limits.max_attempts)
      return result("block", "approval_retry_limit_or_replay", ref);
    if (request.reserved_cost_microusd + declaredCost > cost(request.limits.max_cost_usd))
      return result("block", "approval_cost_limit", ref);
    return result("approval_valid", "request_scope_and_limits_match", {
      ...ref, operation_digest: checked.operation_digest,
      attempt: input.attempt, declared_cost_microusd: declaredCost,
    });
  } catch {
    return result("unparsed", "unsupported_or_unresolved_approval_input");
  }
}
export async function claimApproval(state, input, now = Date.now()) {
  const checked = await checkApproval(state, input, now);
  if (checked.decision === "approval_valid") {
    const request = currentRequest(state, input.id);
    request.uses.push({ attempt: input.attempt, reserved_cost_microusd: checked.declared_cost_microusd,
      claimed_at: new Date(now).toISOString(), execution: "not_started" });
    request.reserved_cost_microusd += checked.declared_cost_microusd;
  }
  return { ...checked, reservation: checked.decision === "approval_valid" ? "reserved" : "not_reserved" };
}
