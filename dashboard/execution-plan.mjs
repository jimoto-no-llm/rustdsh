// Durable admission beside task schema 1. The original Workflow owns execution.
import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { ProjectStore, identity } from "./state.mjs";
import { AcceptanceStore } from "./acceptance.mjs";
import { contractStatus } from "./question-contracts.mjs";
import { publicBudgetAdmission } from "./budget-admission.mjs";

const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const text = (v) =>
  typeof v === "string" &&
  v.length > 0 &&
  v.length <= 160 &&
  !/[\x00-\x1f\x7f]/.test(v);
const exact = (v, keys) =>
  object(v) &&
  Object.keys(v).length === keys.length &&
  keys.every((k) => Object.hasOwn(v, k));
const integer = (v, min, max) =>
  Number.isSafeInteger(v) && v >= min && v <= max;
const date = (v) =>
  typeof v === "string" &&
  Number.isFinite(Date.parse(v)) &&
  new Date(v).toISOString() === v;
const active = (c) => ["reserved", "running", "unknown"].includes(c.phase);
const hash = (v) =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex");
function moneyUnits(value) {
  if (typeof value !== "string" || !/^\d{1,16}(?:\.\d{1,9})?$/.test(value))
    return null;
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole) * 1000000000n + BigInt(fraction.padEnd(9, "0"));
}
function recipeTaskDigest(state, taskIds) {
  const tasks = new Map(state.tasks.map((task) => [task.id, task]));
  return hash([...taskIds].sort().map((id) => {
    const task = tasks.get(id);
    return task ? {
      id: task.id,
      title: task.title,
      milestone: task.milestone,
      blocker: task.blocker,
    } : { id, missing: true };
  }));
}
function recipeBudgetDigest(state, runId) {
  const policies = state.budget_admission?.policies || {};
  return hash(Object.values(policies)
    .filter((policy) => policy.active && (policy.run_id === null || policy.run_id === runId))
    .map((policy) => ({
      policy_id: policy.policy_id,
      revision: policy.revision,
      run_id: policy.run_id,
      active: policy.active,
      paused: policy.paused,
      soft_limit: policy.soft_limit,
      hard_limit: policy.hard_limit,
      period_start: policy.period_start,
      period_end: policy.period_end,
      call_reservation: policy.call_reservation,
    }))
    .sort((a, b) => a.policy_id.localeCompare(b.policy_id)));
}
function recipeSnapshotReason(state, plan) {
  const recipe = plan.definition.recipe;
  if (!recipe) return null;
  if (
    recipe.task_digest !== recipeTaskDigest(
      state,
      plan.definition.nodes.map((node) => node.task_id),
    ) ||
    recipe.budget_digest !== recipeBudgetDigest(
      state,
      plan.definition.run_id,
    )
  )
    return "recipe_target_changed";
  return null;
}
function recipeBudgetBaselineMatches(state, plan, runId) {
  const recipe = plan.definition.recipe,
    policies = (publicBudgetAdmission(state)?.policies || []).filter((policy) =>
      policy.active && !policy.paused && (policy.run_id === null || policy.run_id === runId),
    );
  if (!recipe || policies.length !== recipe.budget_baseline.length) return false;
  const max = moneyUnits(recipe.max_budget_usd);
  if (max === null) return false;
  return recipe.budget_baseline.every((saved) => {
    const current = policies.find((policy) => policy.policy_id === saved.policy_id),
      effective = moneyUnits(current?.effective),
      limit = moneyUnits(current?.hard_limit);
    return Boolean(
      current &&
        current.currency === saved.currency &&
        current.effective === saved.current_effective &&
        current.hard_limit === saved.hard_limit &&
        ["within_budget", "warning"].includes(current.status) &&
        effective !== null &&
        limit !== null &&
        effective <= limit &&
        max <= limit - effective,
    );
  });
}
function recipeApprovalReason(state, plan, node) {
  if (!node?.approval) return null;
  const ref = node.approval,
    card = state.question_contracts?.cards?.[ref.question_id];
  if (!card) return "recipe_approval_missing";
  if (card.revision !== ref.revision || card.fingerprint !== ref.fingerprint)
    return "recipe_approval_changed";
  const decision = card.snapshot?.decision,
    target = decision?.target;
  if (
    decision?.kind !== "approval" ||
    target?.task_id !== node.task_id ||
    target?.run_id !== plan.definition.run_id ||
    target?.session_id !== plan.binding?.session_id ||
    target?.action_id !== ref.action_id ||
    target?.revision !== ref.action_revision
  )
    return "recipe_approval_target_changed";
  const status = contractStatus(card);
  if (status === "expired") return "recipe_approval_expired";
  if (status === "cancelled") return "recipe_approval_cancelled";
  if (status !== "answered") return "recipe_approval_pending";
  if (card.answer?.choice_id !== "approve" || card.answer?.contract_fingerprint !== ref.fingerprint)
    return "recipe_approval_rejected";
  return null;
}
export class PlanError extends Error {
  constructor(code) {
    super("Execution plan: " + code);
    this.code = code;
  }
}
const check = (v, code) => {
  if (!v) throw new PlanError(code);
};
export function planDefinition(v) {
  check(
    object(v) &&
      Object.keys(v).every((key) => ["plan_id", "run_id", "nodes", "limits", "recipe"].includes(key)) &&
      ["plan_id", "run_id", "nodes", "limits"].every((key) => Object.hasOwn(v, key)) &&
      text(v.plan_id) &&
      text(v.run_id),
    "invalid_plan",
  );
  check(
    Array.isArray(v.nodes) && integer(v.nodes.length, 1, 200),
    "invalid_plan_nodes",
  );
  const ids = new Set();
  for (const n of v.nodes) {
    check(
      object(n) &&
        Object.keys(n).every((key) => ["task_id", "depends_on", "parent_task_id", "approval"].includes(key)) &&
        ["task_id", "depends_on", "parent_task_id"].every((key) => Object.hasOwn(n, key)) &&
        text(n.task_id) &&
        !ids.has(n.task_id) &&
        (n.parent_task_id === null || text(n.parent_task_id)) &&
        Array.isArray(n.depends_on) &&
        n.depends_on.length <= 200 &&
        n.depends_on.every(text) &&
        new Set(n.depends_on).size === n.depends_on.length,
      "invalid_plan_node",
    );
    if (n.approval !== undefined)
      check(
        exact(n.approval, ["question_id", "revision", "fingerprint", "action_id", "action_revision"]) &&
          text(n.approval.question_id) &&
          integer(n.approval.revision, 1, Number.MAX_SAFE_INTEGER) &&
          /^[a-f0-9]{64}$/.test(n.approval.fingerprint) &&
          text(n.approval.action_id) &&
          /^[a-f0-9]{64}$/.test(n.approval.action_revision),
        "invalid_plan_approval",
      );
    ids.add(n.task_id);
  }
  if (v.recipe !== undefined)
    check(
      exact(v.recipe, ["recipe_id", "revision", "digest", "project_id", "target_hash", "session_id", "branch", "git_head", "scope_digest", "task_digest", "budget_digest", "budget_baseline", "max_budget_usd", "steps"]) &&
        text(v.recipe.recipe_id) &&
        integer(v.recipe.revision, 1, Number.MAX_SAFE_INTEGER) &&
        /^[a-f0-9]{64}$/.test(v.recipe.digest) &&
        text(v.recipe.project_id) &&
        /^[a-f0-9]{64}$/.test(v.recipe.target_hash) &&
        text(v.recipe.session_id) &&
        (v.recipe.branch === null || text(v.recipe.branch, 1000)) &&
        (v.recipe.git_head === null || /^[a-f0-9]{40}$/i.test(v.recipe.git_head)) &&
        /^[a-f0-9]{64}$/.test(v.recipe.scope_digest) &&
        /^[a-f0-9]{64}$/.test(v.recipe.task_digest) &&
        /^[a-f0-9]{64}$/.test(v.recipe.budget_digest) &&
        typeof v.recipe.max_budget_usd === "string" &&
        /^\d{1,6}(?:\.\d{1,4})?$/.test(v.recipe.max_budget_usd) &&
        Array.isArray(v.recipe.budget_baseline) &&
        v.recipe.budget_baseline.length >= 1 &&
        v.recipe.budget_baseline.length <= 100 &&
        v.recipe.budget_baseline.every((policy) =>
          exact(policy, ["policy_id", "currency", "current_effective", "hard_limit"]) &&
          text(policy.policy_id) &&
          policy.currency === "USD" &&
          moneyUnits(policy.current_effective) !== null &&
          moneyUnits(policy.hard_limit) !== null,
        ) &&
        new Set(v.recipe.budget_baseline.map((policy) => policy.policy_id)).size === v.recipe.budget_baseline.length &&
        Array.isArray(v.recipe.steps) &&
        v.recipe.steps.length === v.nodes.length &&
        v.recipe.steps.every((step, index) =>
          exact(step, ["key", "task_id", "task_status", "purpose", "risk", "approval_required", "inputs", "exit_conditions"]) &&
          text(step.key) &&
          step.task_id === v.nodes[index].task_id &&
          ["todo", "doing", "done", "blocked", "unknown"].includes(step.task_status) &&
          typeof step.purpose === "string" &&
          step.purpose.trim().length > 0 &&
          step.purpose.length <= 1000 &&
          !/[\x00-\x1f\x7f]/.test(step.purpose) &&
          ["read_only", "workspace_write", "network", "publish", "billing", "credential", "merge"].includes(step.risk) &&
          typeof step.approval_required === "boolean" &&
          (step.risk === "read_only" || step.approval_required) &&
          (!v.nodes[index].approval || step.approval_required) &&
          object(step.inputs) &&
          Object.keys(step.inputs).length <= 3 &&
          Object.keys(step.inputs).every((key) =>
            ["task.title", "task.milestone", "task.blocker"].includes(key) &&
            (step.inputs[key] === null ||
              (typeof step.inputs[key] === "string" && step.inputs[key].length <= 2000)),
          ) &&
          Array.isArray(step.exit_conditions) &&
          step.exit_conditions.length >= 1 &&
          step.exit_conditions.length <= 2 &&
          step.exit_conditions.every((condition) =>
            ["dependencies.verified", "original_workflow.completed"].includes(condition),
          ) &&
          new Set(step.exit_conditions).size === step.exit_conditions.length,
        ),
      "invalid_plan_recipe",
    );
  const l = v.limits;
  check(
    exact(l, [
      "max_concurrent",
      "max_depth",
      "max_starts",
      "stop_at",
      "stop_on_failure",
    ]) &&
      integer(l.max_concurrent, 1, 200) &&
      integer(l.max_depth, 1, 32) &&
      integer(l.max_starts, 1, 1000) &&
      date(l.stop_at) &&
      typeof l.stop_on_failure === "boolean",
    "invalid_plan_limits",
  );
  return structuredClone(v);
}
function recipeApprovalsComplete(definition) {
  return !definition.recipe || definition.recipe.steps.every((step, index) =>
    !step.approval_required || Boolean(definition.nodes[index].approval),
  );
}
// Drafts may contain graph errors so operators can inspect their blockers.
export function graphProblems(definition, taskIds) {
  const nodes = new Map(definition.nodes.map((n) => [n.task_id, n])),
    issues = [];
  const add = (code, task_id, related_task_id = null) =>
    issues.push({ code, task_id, related_task_id });
  for (const n of nodes.values()) {
    if (!taskIds.has(n.task_id)) add("unknown_task", n.task_id);
    for (const d of n.depends_on)
      if (!nodes.has(d)) add("unknown_dependency", n.task_id, d);
    if (n.parent_task_id !== null && !nodes.has(n.parent_task_id))
      add("unknown_parent", n.task_id, n.parent_task_id);
  }
  for (const kind of ["dependency", "branch"]) {
    const colors = new Map();
    const visit = (id, depth) => {
      if (!nodes.has(id)) return;
      if (colors.get(id) === 1) {
        add(kind + "_cycle", id);
        return;
      }
      if (colors.get(id) === 2) return;
      colors.set(id, 1);
      const n = nodes.get(id);
      const links =
        kind === "dependency"
          ? n.depends_on
          : n.parent_task_id === null
            ? []
            : [n.parent_task_id];
      for (const link of links) visit(link, depth + 1);
      colors.set(id, 2);
    };
    for (const id of nodes.keys()) visit(id, 1);
  }
  if (
    !issues.some(
      (p) => p.code === "branch_cycle" || p.code === "unknown_parent",
    )
  ) {
    for (const n of nodes.values()) {
      let depth = 1,
        p = n;
      while (p.parent_task_id !== null) {
        depth++;
        p = nodes.get(p.parent_task_id);
      }
      if (depth > definition.limits.max_depth)
        add("branch_depth_limit", n.task_id, n.parent_task_id);
    }
  }
  return issues;
}
async function readJson(file) {
  let h;
  try {
    h = await fs.open(file, "r");
    const s = await h.stat();
    check(s.isFile() && s.size <= 4 * 1024 * 1024, "plan_state_invalid");
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(await h.readFile()),
    );
  } catch (e) {
    if (e.code === "ENOENT") return null;
    if (e instanceof PlanError) throw e;
    throw new PlanError("plan_state_unreadable");
  } finally {
    await h?.close();
  }
}
async function writeJson(file, value) {
  const temp = file + "." + randomUUID() + ".tmp";
  let h;
  try {
    h = await fs.open(temp, "wx", 0o600);
    await h.writeFile(JSON.stringify(value) + "\n");
    await h.sync();
    await h.close();
    h = null;
    await fs.rename(temp, file);
  } catch {
    throw new PlanError("plan_write_unconfirmed");
  } finally {
    await h?.close();
    await fs.unlink(temp).catch(() => {});
  }
}
function database(v, project) {
  check(
    exact(v, [
      "schema",
      "project_id",
      "revision",
      "plans",
      "claims",
      "events",
    ]) &&
      v.schema === 1 &&
      v.project_id === project.id &&
      integer(v.revision, 0, Number.MAX_SAFE_INTEGER - 1) &&
      Array.isArray(v.plans) &&
      v.plans.length <= 20 &&
      Array.isArray(v.claims) &&
      v.claims.length <= 1000 &&
      Array.isArray(v.events) &&
      v.events.length <= 2000,
    "plan_state_invalid",
  );
  const ids = new Set();
  for (const p of v.plans) {
    check(
      exact(p, [
        "definition",
        "binding",
        "context_hash",
        "created_at",
        "enabled_at",
        "stopped_at",
        "stop_reason",
      ]) && !ids.has(p.definition?.plan_id),
      "plan_state_invalid",
    );
    planDefinition(p.definition);
    check(recipeApprovalsComplete(p.definition), "plan_state_invalid");
    ids.add(p.definition.plan_id);
    check(
      p.binding === null ||
        (exact(p.binding, ["run_id", "session_id", "cwd", "cli_version"]) &&
          p.binding.run_id === p.definition.run_id &&
          text(p.binding.session_id) &&
          path.isAbsolute(p.binding.cwd) &&
          p.binding.cli_version === "0.2.0-rc.2"),
      "plan_state_invalid",
    );
    check(
      p.context_hash ===
        hash({ definition: p.definition, binding: p.binding }) &&
        date(p.created_at) &&
        (p.enabled_at === null || date(p.enabled_at)) &&
        (p.stopped_at === null || date(p.stopped_at)) &&
        (p.stop_reason === null || text(p.stop_reason)) &&
        (p.enabled_at === null || p.binding !== null),
      "plan_state_invalid",
    );
  }
  const claims = new Set(),
    tasks = new Set(),
    children = new Set();
  for (const c of v.claims) {
    const p = v.plans.find((p) => p.definition.plan_id === c.plan_id);
    check(
      exact(c, [
        "claim_id",
        "plan_id",
        "context_hash",
        "task_id",
        "parent_session_id",
        "child_session_id",
        "native_depth",
        "phase",
        "outcome",
        "reserved_at",
        "finished_at",
        "prerequisites",
      ]) &&
        text(c.claim_id) &&
        !claims.has(c.claim_id) &&
        !tasks.has(c.task_id) &&
        p &&
        p.context_hash === c.context_hash &&
        p.definition.nodes.some((n) => n.task_id === c.task_id) &&
        text(c.parent_session_id) &&
        (c.child_session_id === null ||
          (text(c.child_session_id) && !children.has(c.child_session_id))) &&
        integer(c.native_depth, 1, 32) &&
        ["reserved", "running", "unknown", "finished"].includes(c.phase) &&
        (c.outcome === null ||
          ["completed", "error", "cancelled", "unknown"].includes(c.outcome)) &&
        date(c.reserved_at) &&
        (c.finished_at === null || date(c.finished_at)) &&
        Array.isArray(c.prerequisites) &&
        c.prerequisites.every(
          (r) =>
            exact(r, ["task_id", "evidence_ids"]) &&
            text(r.task_id) &&
            Array.isArray(r.evidence_ids) &&
            r.evidence_ids.every(text),
        ),
      "plan_state_invalid",
    );
    claims.add(c.claim_id);
    tasks.add(c.task_id);
    if (c.child_session_id) children.add(c.child_session_id);
  }
  for (const [i, e] of v.events.entries())
    check(
      exact(e, ["sequence", "plan_id", "task_id", "action", "reason", "at"]) &&
        e.sequence === i + 1 &&
        ids.has(e.plan_id) &&
        (e.task_id === null || text(e.task_id)) &&
        text(e.action) &&
        (e.reason === null || text(e.reason)) &&
        date(e.at),
      "plan_state_invalid",
    );
  return v;
}
export class ExecutionPlans {
  constructor(project) {
    this.project = { ...project };
    this.directory = path.join(project.directory, "execution-plans");
    this.index = path.join(this.directory, "index.json");
  }
  static open(project) {
    check(
      object(project) &&
        text(project.id) &&
        path.isAbsolute(project.root) &&
        path.isAbsolute(project.directory),
      "invalid_plan_project",
    );
    return new ExecutionPlans(project);
  }
  async read() {
    return database(
      (await readJson(this.index)) ?? {
        schema: 1,
        project_id: this.project.id,
        revision: 0,
        plans: [],
        claims: [],
        events: [],
      },
      this.project,
    );
  }
  async mutate(operation) {
    await fs.mkdir(this.directory, { recursive: true });
    const lock = path.join(this.directory, "writer.lock"),
      owner = randomUUID();
    let h;
    for (let attempt = 0; attempt <= 100; attempt++) {
      try {
        h = await fs.open(lock, "wx", 0o600);
        break;
      } catch (e) {
        if (e.code !== "EEXIST") throw new PlanError("plan_lock_unavailable");
        if (attempt === 100) throw new PlanError("plan_busy");
        await delay(20);
      }
    }
    try {
      await h.writeFile(owner);
      await h.sync();
      const v = await this.read(),
        result = await operation(v);
      v.revision++;
      database(v, this.project);
      await writeJson(this.index, v);
      return result;
    } finally {
      await h.close();
      check((await fs.readFile(lock, "utf8")) === owner, "plan_lock_changed");
      await fs.unlink(lock);
    }
  }
  find(v, id) {
    const p = v.plans.find((p) => p.definition.plan_id === id);
    check(p, "plan_not_found");
    return p;
  }
  event(v, p, task_id, action, reason = null) {
    check(v.events.length < 2000, "plan_audit_full");
    v.events.push({
      sequence: v.events.length + 1,
      plan_id: p.definition.plan_id,
      task_id,
      action,
      reason,
      at: new Date().toISOString(),
    });
  }
  async define(input) {
    const definition = planDefinition(input);
    check(recipeApprovalsComplete(definition), "recipe_approval_required");
    return this.mutate((v) => {
      check(
        v.plans.length < 20 &&
          !v.plans.some((p) => p.definition.plan_id === definition.plan_id),
        "plan_id_unavailable",
      );
      const p = {
        definition,
        binding: null,
        context_hash: hash({ definition, binding: null }),
        created_at: new Date().toISOString(),
        enabled_at: null,
        stopped_at: null,
        stop_reason: null,
      };
      v.plans.push(p);
      this.event(v, p, null, "defined");
      return p;
    });
  }
  async problems(p) {
    const s = await ProjectStore.open(this.project);
    return graphProblems(p.definition, new Set(s.value.tasks.map((t) => t.id)));
  }
  stopReason(v, p) {
    if (!p.enabled_at) return "plan_not_enabled";
    if (p.stopped_at) return p.stop_reason;
    if (Date.parse(p.definition.limits.stop_at) <= Date.now())
      return "plan_expired";
    if (
      p.definition.limits.stop_on_failure &&
      v.claims.some(
        (c) =>
          c.plan_id === p.definition.plan_id &&
          ["error", "cancelled", "unknown"].includes(c.outcome),
      )
    )
      return "child_failed_or_unconfirmed";
    return null;
  }
  async enforce(id, record) {
    let context = null;
    try {
      if (typeof record?.cwd === "string" && path.isAbsolute(record.cwd))
        context = await identity(record.cwd);
    } catch {
      // A missing or inaccessible native cwd cannot bind an execution plan.
    }
    check(
      record?.binding === "confirmed" &&
        record.cli === "dsh" &&
        record.cli_version === "0.2.0-rc.2" &&
        text(record.cli_session_id) &&
        context?.id === this.project.id,
      "plan_native_context_unconfirmed",
    );
    return this.mutate(async (v) => {
      const p = this.find(v, id);
      check(p.definition.run_id === record.run_id, "plan_run_mismatch");
      check(!p.enabled_at && !p.stopped_at, "plan_already_bound");
      if (p.definition.recipe) {
        const recipe = p.definition.recipe,
          state = await ProjectStore.open(this.project);
        const { WorkflowRecipes } = await import("./workflow-recipes.mjs");
        let savedVersion;
        try {
          savedVersion = await WorkflowRecipes.open(this.project).get(
            recipe.recipe_id,
            recipe.revision,
          );
        } catch {
          throw new PlanError("recipe_version_unavailable");
        }
        check(
          savedVersion.digest === recipe.digest,
          "recipe_version_changed",
        );
        check(
          recipe.project_id === this.project.id &&
            recipe.session_id === record.cli_session_id &&
            text(recipe.branch) &&
            /^[a-f0-9]{40}$/i.test(recipe.git_head || "") &&
            recipe.branch === record.branch &&
            recipe.git_head === record.git?.head &&
            recipe.scope_digest === hash(record.scope) &&
            recipe.task_digest === recipeTaskDigest(
              state.value,
              p.definition.nodes.map((node) => node.task_id),
            ) &&
            recipe.budget_digest === recipeBudgetDigest(state.value, record.run_id) &&
            recipeBudgetBaselineMatches(state.value, p, record.run_id) &&
            !recipeSnapshotReason(state.value, p),
          "recipe_target_changed",
        );
      }
      check(!(await this.problems(p)).length, "plan_graph_invalid");
      check(
        Date.parse(p.definition.limits.stop_at) > Date.now(),
        "plan_expired",
      );
      check(
        !v.plans.some(
          (q) => q.enabled_at && q.binding.run_id === record.run_id,
        ),
        "run_plan_already_bound",
      );
      p.binding = {
        run_id: record.run_id,
        session_id: record.cli_session_id,
        cwd: record.cwd,
        cli_version: record.cli_version,
      };
      p.context_hash = hash({ definition: p.definition, binding: p.binding });
      p.enabled_at = new Date().toISOString();
      // A lost index must not silently turn a bound resume into an unguarded run.
      const marker = {
        schema: 1,
        plan_id: id,
        run_id: record.run_id,
        session_id: record.cli_session_id,
        context_hash: p.context_hash,
      };
      const file = this.requiredFile(record),
        previous = await readJson(file);
      if (previous !== null)
        check(
          JSON.stringify(previous) === JSON.stringify(marker),
          "plan_required_marker_changed",
        );
      else {
        let h;
        try {
          h = await fs.open(file, "wx", 0o600);
          await h.writeFile(JSON.stringify(marker));
          await h.sync();
        } catch {
          throw new PlanError("plan_required_write_unconfirmed");
        } finally {
          await h?.close();
        }
      }
      this.event(v, p, null, "enabled");
      return p;
    });
  }
  requiredFile(record) {
    check(text(record?.run_id), "exact_run_id_required");
    return path.join(this.directory, hash(record.run_id) + ".required.json");
  }
  async required(record) {
    const marker = await readJson(this.requiredFile(record)),
      p =
        (await this.read()).plans.find(
          (p) => p.enabled_at && p.binding.run_id === record.run_id,
        ) ?? null;
    if (marker === null) {
      check(p === null, "plan_required_marker_missing");
      return null;
    }
    check(
      exact(marker, [
        "schema",
        "plan_id",
        "run_id",
        "session_id",
        "context_hash",
      ]) &&
        marker.schema === 1 &&
        p &&
        marker.plan_id === p.definition.plan_id &&
        marker.run_id === record.run_id &&
        marker.session_id === record.cli_session_id &&
        marker.context_hash === p.context_hash,
      "plan_required_state_unconfirmed",
    );
    return p;
  }
  async stop(id) {
    return this.mutate((v) => {
      const p = this.find(v, id);
      if (!p.stopped_at) {
        p.stopped_at = new Date().toISOString();
        p.stop_reason = "operator_stopped";
        this.event(v, p, null, "stopped");
      }
      return p;
    });
  }
  async prerequisites(node, cache = new Map(), book = null) {
    book ??= await this.read();
    const acceptance = await AcceptanceStore.open(this.project),
      receipts = [],
      blockers = [];
    for (const id of node.depends_on) {
      if (!cache.has(id)) cache.set(id, acceptance.inspect(id));
      const s = await cache.get(id);
      const claim = book.claims.find((c) => c.task_id === id);
      if (
        !s.reported_done_with_verified_checks ||
        (claim && (claim.phase !== "finished" || claim.outcome !== "completed"))
      )
        blockers.push({
          code: "prerequisite_unverified",
          task_id: node.task_id,
          related_task_id: id,
        });
      else
        receipts.push({
          task_id: id,
          evidence_ids: s.conditions.map((c) => c.full_result.evidence_id),
        });
    }
    return { receipts, blockers };
  }
  async admit(id, context_hash, { task_id, parent_session_id, native_depth }) {
    check(
      text(task_id) && text(parent_session_id) && integer(native_depth, 1, 32),
      "task_context_required",
    );
    const result = await this.mutate(async (v) => {
      const p = this.find(v, id),
        n = p.definition.nodes.find((n) => n.task_id === task_id);
      let reason =
        context_hash !== p.context_hash
          ? "plan_context_changed"
          : this.stopReason(v, p);
      const problems = await this.problems(p);
      reason ||= problems.length ? "plan_graph_invalid" : null;
      reason ||= !n ? "undeclared_task" : null;
      if (!reason && p.definition.recipe) {
        const state = await ProjectStore.open(this.project);
        reason = recipeSnapshotReason(state.value, p);
      }
      if (!reason && n?.approval) {
        const state = await ProjectStore.open(this.project);
        reason = recipeApprovalReason(state.value, p, n);
      }
      const parent = v.claims.find(
        (c) =>
          c.child_session_id === parent_session_id &&
          c.phase === "running" &&
          c.plan_id === id,
      );
      reason ||=
        n &&
        (n.parent_task_id === null
          ? parent_session_id !== p.binding.session_id
          : !parent || parent.task_id !== n.parent_task_id)
          ? "branch_parent_mismatch"
          : null;
      reason ||=
        native_depth > p.definition.limits.max_depth
          ? "native_depth_limit"
          : null;
      reason ||= v.claims.some((c) => c.task_id === task_id)
        ? "task_already_claimed"
        : null;
      reason ||=
        v.claims.filter((c) => c.plan_id === id).length >=
        p.definition.limits.max_starts
          ? "total_start_limit"
          : null;
      const live = v.claims.filter(active);
      const ceilings = [
        p,
        ...v.plans.filter((q) =>
          live.some((c) => c.plan_id === q.definition.plan_id),
        ),
      ];
      reason ||= ceilings.some(
        (q) => live.length >= q.definition.limits.max_concurrent,
      )
        ? "concurrency_limit"
        : null;
      let prerequisites = { receipts: [], blockers: [] };
      if (!reason) {
        prerequisites = await this.prerequisites(n, new Map(), v);
        reason = prerequisites.blockers.length
          ? "prerequisite_unverified"
          : this.stopReason(v, p);
        if (
          !reason &&
          !(
            await this.prerequisites(
              { ...n, depends_on: [task_id] },
              new Map(),
              v,
            )
          ).blockers.length
        )
          reason = "task_already_verified";
      }
      if (reason) {
        this.event(v, p, task_id, "denied", reason);
        return { allowed: false, reason };
      }
      check(v.claims.length < 1000, "claim_limit");
      const c = {
        claim_id: "claim_" + randomUUID(),
        plan_id: id,
        context_hash,
        task_id,
        parent_session_id,
        child_session_id: null,
        native_depth,
        phase: "reserved",
        outcome: null,
        reserved_at: new Date().toISOString(),
        finished_at: null,
        prerequisites: prerequisites.receipts,
      };
      v.claims.push(c);
      this.event(v, p, task_id, "reserved");
      return { allowed: true, claim: structuredClone(c) };
    });
    if (!result.allowed) throw new PlanError(result.reason);
    return result.claim;
  }
  async beforeDispatch(claim) {
    const v = await this.read(),
      p = this.find(v, claim.plan_id),
      c = v.claims.find((c) => c.claim_id === claim.claim_id);
    check(
      c?.phase === "reserved" &&
        c.context_hash === claim.context_hash &&
        c.task_id === claim.task_id,
      "claim_context_changed",
    );
    const reason = this.stopReason(v, p);
    check(!reason, reason);
    const result = await this.prerequisites(
      p.definition.nodes.find((n) => n.task_id === c.task_id),
      new Map(),
      v,
    );
    check(!result.blockers.length, "prerequisite_unverified");
    check(!(await this.problems(p)).length, "plan_graph_invalid");
    // Acceptance observation performs I/O. An operator may stop the plan while
    // those checks are running; read admission authority again after them.
    const current = await this.read(),
      finalPlan = this.find(current, claim.plan_id),
      finalClaim = current.claims.find((c) => c.claim_id === claim.claim_id);
    check(
      finalPlan.context_hash === claim.context_hash &&
        finalClaim?.phase === "reserved",
      "claim_context_changed",
    );
    const finalReason = this.stopReason(current, finalPlan);
    check(!finalReason, finalReason);
    const finalNode = finalPlan.definition.nodes.find(
        (node) => node.task_id === finalClaim.task_id,
      ),
      finalState = await ProjectStore.open(this.project),
      snapshotReason = recipeSnapshotReason(finalState.value, finalPlan),
      approvalReason = recipeApprovalReason(finalState.value, finalPlan, finalNode);
    check(!snapshotReason, snapshotReason);
    check(!approvalReason, approvalReason);
  }
  async update(claim_id, action, input = null) {
    return this.mutate((v) => {
      const c = v.claims.find((c) => c.claim_id === claim_id);
      check(c, "claim_not_found");
      const p = this.find(v, c.plan_id);
      if (action === "started") {
        check(
          c.phase === "reserved" &&
            text(input) &&
            !v.claims.some((c) => c.child_session_id === input),
          "child_context_invalid",
        );
        c.child_session_id = input;
        c.phase = "running";
      } else if (action === "outcome") {
        check(
          ["completed", "error", "cancelled", "unknown"].includes(input) &&
            c.phase === "running",
          "invalid_child_outcome",
        );
        c.outcome = input;
      } else if (action === "disposed") {
        check(
          c.phase === "running" &&
            c.outcome !== null &&
            c.outcome !== "unknown",
          "child_result_unconfirmed",
        );
        c.phase = "finished";
        c.finished_at = new Date().toISOString();
      } else if (action === "unknown") {
        check(active(c), "claim_already_finished");
        c.phase = "unknown";
        c.outcome = "unknown";
      } else if (action === "not_dispatched") {
        check(c.phase === "reserved", "dispatch_state_unconfirmed");
        c.phase = "finished";
        c.outcome = "cancelled";
        c.finished_at = new Date().toISOString();
      } else throw new PlanError("invalid_claim_action");
      this.event(v, p, c.task_id, action);
      return structuredClone(c);
    });
  }
  async attachmentEnded(id, context_hash) {
    const current = await this.read();
    if (
      !current.claims.some(
        (c) => c.plan_id === id && ["reserved", "running"].includes(c.phase),
      )
    )
      return;
    await this.mutate((v) => {
      const p = this.find(v, id);
      check(p.context_hash === context_hash, "plan_context_changed");
      for (const c of v.claims.filter(
        (c) => c.plan_id === id && ["reserved", "running"].includes(c.phase),
      )) {
        c.phase = "unknown";
        c.outcome = "unknown";
        this.event(v, p, c.task_id, "attachment_ended_without_child_receipt");
      }
    });
  }
  async inspect(id = null) {
    const v = await this.read(),
      selected = id === null ? v.plans : [this.find(v, id)],
      plans = [],
      cache = new Map(),
      live = v.claims.filter(active),
      projectState = await ProjectStore.open(this.project);
    for (const p of selected) {
      const problems = await this.problems(p),
        reason = this.stopReason(v, p),
        snapshotReason = recipeSnapshotReason(projectState.value, p),
        nodes = [];
      for (const n of p.definition.nodes) {
        const c = v.claims.find((c) => c.task_id === n.task_id),
          pre = await this.prerequisites(n, cache, v),
          verified = !(
            await this.prerequisites(
              { ...n, depends_on: [n.task_id] },
              cache,
              v,
            )
          ).blockers.length;
        const blockers = [
          ...problems.filter((x) => x.task_id === n.task_id),
          ...pre.blockers,
        ];
        const approvalReason = recipeApprovalReason(projectState.value, p, n);
        const add = (code) =>
          blockers.push({ code, task_id: n.task_id, related_task_id: null });
        if (approvalReason) add(approvalReason);
        if (snapshotReason) add(snapshotReason);
        if (problems.length) add("plan_graph_invalid");
        if (
          live.length >= p.definition.limits.max_concurrent ||
          v.plans.some(
            (q) =>
              live.some((c) => c.plan_id === q.definition.plan_id) &&
              live.length >= q.definition.limits.max_concurrent,
          )
        )
          add("concurrency_limit");
        if (
          v.claims.filter((c) => c.plan_id === p.definition.plan_id).length >=
          p.definition.limits.max_starts
        )
          add("total_start_limit");
        if (
          n.parent_task_id !== null &&
          !v.claims.some(
            (c) =>
              c.plan_id === p.definition.plan_id &&
              c.task_id === n.parent_task_id &&
              c.child_session_id !== null &&
              c.phase === "running",
          )
        )
          blockers.push({
            code: "branch_parent_unavailable",
            task_id: n.task_id,
            related_task_id: n.parent_task_id,
          });
        if (reason)
          blockers.push({
            code: reason,
            task_id: n.task_id,
            related_task_id: null,
          });
        if (c)
          blockers.push({
            code:
              c.phase === "finished" ? "already_started" : "task_claim_held",
            task_id: n.task_id,
            related_task_id: null,
          });
        nodes.push({
          ...n,
          state: verified
            ? "verified"
            : (c?.phase ?? (blockers.length ? "waiting" : "runnable")),
          blockers,
          child_session_id: c?.child_session_id ?? null,
          outcome: c?.outcome ?? null,
        });
      }
      plans.push({
        plan_id: p.definition.plan_id,
        run_id: p.definition.run_id,
        recipe: p.definition.recipe
          ? {
              recipe_id: p.definition.recipe.recipe_id,
              revision: p.definition.recipe.revision,
              digest: p.definition.recipe.digest,
              target_hash: p.definition.recipe.target_hash,
              max_budget_usd: p.definition.recipe.max_budget_usd,
              budget_baseline: structuredClone(p.definition.recipe.budget_baseline),
              resolved_steps: structuredClone(p.definition.recipe.steps),
            }
          : null,
        limits: p.definition.limits,
        context_hash: p.context_hash,
        enabled: Boolean(p.enabled_at),
        stop_reason: reason,
        preflight: problems,
        nodes,
        active_claims: v.claims.filter(
          (c) => c.plan_id === p.definition.plan_id && active(c),
        ).length,
        starts: v.claims.filter((c) => c.plan_id === p.definition.plan_id)
          .length,
      });
    }
    return {
      schema: 1,
      revision: v.revision,
      plans,
      events: v.events.slice(-100),
      enforcement_scope: "explicitly_bound_native_workflow_process",
      native_execution_verified: false,
      acceptance: "current_full_local_checks_and_reported_done_required",
    };
  }
}
