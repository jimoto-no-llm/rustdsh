import { AcceptanceStore } from "./acceptance.mjs";

function conditionView(condition) {
  const full = condition.full_result;
  return {
    criterion_id: condition.criterion.id,
    description: condition.criterion.description,
    verified: condition.verified_full_check,
    status: condition.status,
    reason: full?.reason || null,
    source: full?.source || null,
    scope: full?.scope || null,
    freshness: full?.freshness?.state || "unknown",
    freshness_reason: full?.freshness?.reason || null,
    evidence_id: full?.evidence_id || null,
    finished_at: full?.finished_at || null,
    partial_status: condition.partial_result?.status || null,
  };
}
// Read-only: execution remains in the existing explicit acceptance CLI.
export async function inspectTaskOutcomes(project, state, selector) {
  const keys = Object.keys(selector);
  if (
    keys.length !== 1 ||
    !["task_id", "milestone_id"].includes(keys[0]) ||
    typeof selector[keys[0]] !== "string" ||
    !selector[keys[0]].trim() ||
    selector[keys[0]].length > 160
  )
    throw new Error("Select exactly one task_id or milestone_id");
  const acceptance = await AcceptanceStore.open(project);
  const reports = new Map();
  async function inspect(id) {
    if (!reports.has(id))
      reports.set(
        id,
        acceptance
          .inspect(id)
          .then((view) => ({
            status: view.verification.status,
            conditions: view.conditions.map(conditionView),
          }))
          .catch(() => ({ status: "unknown", conditions: [] })),
      );
    return reports.get(id);
  }
  let result;
  if (selector.task_id !== undefined) {
    const task = state.tasks.find((item) => item.id === selector.task_id);
    if (!task) throw new Error("Task not found");
    const report = state.task_outcomes?.tasks.find(
      (item) => item.task_id === task.id,
    );
    const acceptanceTask = report?.acceptance_task_id || task.id;
    const view = await inspect(acceptanceTask);
    result = {
      task_id: task.id,
      acceptance_task_id: acceptanceTask,
      reported_status: task.status,
      ...view,
      reported_done_with_verified_checks:
        task.status === "done" && view.status === "verified_checks",
    };
  } else {
    const contract = state.task_outcomes?.milestones.find(
      (item) => item.id === selector.milestone_id,
    );
    if (!contract) throw new Error("Milestone contract not found");
    const conditions = [];
    for (const criterion of contract.criteria) {
      const view = await inspect(criterion.task_id);
      const observed = view.conditions.find(
        (item) => item.criterion_id === criterion.criterion_id,
      );
      const matched = observed?.description === criterion.description;
      conditions.push({
        ...criterion,
        verified: Boolean(matched && observed.verified),
        status: matched
          ? observed.status
          : view.status === "unknown"
            ? "unknown"
            : observed
              ? "definition_changed"
              : "not-defined",
        freshness: matched ? observed.freshness : "unknown",
        reason: matched ? observed.freshness_reason || observed.reason : null,
      });
    }
    const verifiedCount = conditions.filter((item) => item.verified).length;
    result = {
      milestone_id: contract.id,
      title: contract.title,
      conditions,
      verified_count: verifiedCount,
      condition_count: conditions.length,
      all_declared_full_checks_pass: verifiedCount === conditions.length,
    };
  }
  return {
    ...result,
    state_revision: state.revision,
    observed_at: new Date().toISOString(),
    checks_executed: 0,
    human_review: "not_assessed",
    production_adoption: "not_assessed",
  };
}
