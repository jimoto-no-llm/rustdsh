import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { ProjectStore, writeJson } from "./state.mjs";
import { SessionLedger } from "./session-ledger.mjs";
import { publicBudgetAdmission } from "./budget-admission.mjs";
import { graphProblems, planDefinition } from "./execution-plan.mjs";

const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const text = (v, max = 160) =>
  typeof v === "string" && v.trim().length > 0 && v.length <= max && !/[\x00-\x1f\x7f]/.test(v);
const exact = (v, keys) => object(v) && Object.keys(v).length === keys.length && keys.every((key) => Object.hasOwn(v, key));
const hash = (v) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const digest = (v) => /^[a-f0-9]{64}$/.test(v);
const idPattern = /^[a-z][a-z0-9_-]{0,63}$/;
const riskKinds = new Set(["read_only", "workspace_write", "network", "publish", "billing", "credential", "merge"]);
const inputFields = new Set(["task.title", "task.milestone", "task.blocker"]);
const exitConditions = new Set(["dependencies.verified", "original_workflow.completed"]);
const moneyUnits = (v) => {
  if (typeof v !== "string" || !/^\d{1,9}(?:\.\d{1,9})?$/.test(v)) return null;
  const [whole, fraction = ""] = v.split(".");
  return BigInt(whole) * 1000000000n + BigInt(fraction.padEnd(9, "0"));
};
const moneyString = (value) => {
  const whole = value / 1000000000n,
    fraction = String(value % 1000000000n).padStart(9, "0").replace(/0+$/, "");
  return String(whole) + (fraction ? "." + fraction : "");
};
const budgetDigest = (state, runId) => {
  const policies = state.budget_admission?.policies || {};
  return hash(Object.values(policies)
    .filter((p) => p.active && (p.run_id === null || p.run_id === runId))
    .map((p) => ({
      policy_id: p.policy_id,
      revision: p.revision,
      run_id: p.run_id,
      active: p.active,
      paused: p.paused,
      soft_limit: p.soft_limit,
      hard_limit: p.hard_limit,
      period_start: p.period_start,
      period_end: p.period_end,
      call_reservation: p.call_reservation,
    }))
    .sort((a, b) => a.policy_id.localeCompare(b.policy_id)));
};
const taskDigest = (state, taskIds) => {
  const byId = new Map(state.tasks.map((task) => [task.id, task]));
  return hash([...taskIds].sort().map((id) => {
    const task = byId.get(id);
    return task ? {
      id: task.id,
      title: task.title,
      milestone: task.milestone,
      blocker: task.blocker,
    } : { id, missing: true };
  }));
};

export class RecipeError extends Error {
  constructor(code) {
    super("Workflow recipe: " + code);
    this.code = code;
  }
}
const check = (value, code) => {
  if (!value) throw new RecipeError(code);
};

export function recipeDefinition(input) {
  check(exact(input, ["schema", "recipe_id", "name", "purpose", "scope_mode", "branch_mode", "max_budget_usd", "steps", "limits"]) &&
    input.schema === 1 && text(input.recipe_id) && idPattern.test(input.recipe_id) &&
    text(input.name, 160) && text(input.purpose, 2000) &&
    input.scope_mode === "inherit" && input.branch_mode === "inherit", "invalid_recipe");
  check(typeof input.max_budget_usd === "string" && /^\d{1,6}(?:\.\d{1,4})?$/.test(input.max_budget_usd) &&
    moneyUnits(input.max_budget_usd) !== null, "invalid_recipe_budget");
  check(Array.isArray(input.steps) && input.steps.length >= 1 && input.steps.length <= 200, "invalid_recipe_steps");
  const keys = new Set();
  const steps = input.steps.map((step) => {
    check(object(step) && Object.keys(step).every((key) => ["key", "purpose", "risk", "depends_on", "parent_key", "inputs", "exit_conditions", "approval"].includes(key)) &&
      ["key", "purpose", "risk", "depends_on", "parent_key", "inputs", "exit_conditions"].every((key) => Object.hasOwn(step, key)) &&
      text(step.key, 64) && idPattern.test(step.key) && !keys.has(step.key) && text(step.purpose, 1000) && riskKinds.has(step.risk) &&
      Array.isArray(step.depends_on) && step.depends_on.length <= 200 && step.depends_on.every((id) => text(id, 64) && idPattern.test(id)) &&
      new Set(step.depends_on).size === step.depends_on.length &&
      Array.isArray(step.inputs) && step.inputs.length <= 3 && step.inputs.every((field) => inputFields.has(field)) && new Set(step.inputs).size === step.inputs.length &&
      Array.isArray(step.exit_conditions) && step.exit_conditions.length >= 1 && step.exit_conditions.length <= 2 && step.exit_conditions.every((condition) => exitConditions.has(condition)) && new Set(step.exit_conditions).size === step.exit_conditions.length &&
      (step.parent_key === null || (text(step.parent_key, 64) && idPattern.test(step.parent_key))), "invalid_recipe_step");
    check(step.approval === null || (exact(step.approval, ["question", "diff", "impact", "conditions"]) &&
      text(step.approval.question, 1000) && text(step.approval.diff, 4000) && text(step.approval.impact, 4000) && text(step.approval.conditions, 4000)), "invalid_recipe_approval");
    check(step.risk === "read_only" ? step.approval === null || object(step.approval) : object(step.approval), "risky_recipe_step_requires_approval");
    keys.add(step.key);
    return structuredClone(step);
  });
  for (const step of steps) {
    check(step.depends_on.every((key) => keys.has(key)) && (step.parent_key === null || keys.has(step.parent_key)), "unknown_recipe_step");
  }
  const l = input.limits;
  check(exact(l, ["max_concurrent", "max_depth", "max_starts", "deadline_minutes", "stop_on_failure"]) &&
    Number.isSafeInteger(l.max_concurrent) && l.max_concurrent >= 1 && l.max_concurrent <= 200 &&
    Number.isSafeInteger(l.max_depth) && l.max_depth >= 1 && l.max_depth <= 32 &&
    Number.isSafeInteger(l.max_starts) && l.max_starts >= 1 && l.max_starts <= 1000 &&
    Number.isSafeInteger(l.deadline_minutes) && l.deadline_minutes >= 1 && l.deadline_minutes <= 10080 &&
    typeof l.stop_on_failure === "boolean", "invalid_recipe_limits");
  const aliases = new Map(steps.map((step) => [step.key, step.key]));
  const problems = graphProblems({
    nodes: steps.map((step) => ({
      task_id: step.key,
      depends_on: step.depends_on,
      parent_task_id: step.parent_key,
    })),
    limits: { max_depth: l.max_depth },
  }, new Set(aliases.keys()));
  check(problems.length === 0, "invalid_recipe_graph");
  return {
    schema: 1,
    recipe_id: input.recipe_id,
    name: input.name,
    purpose: input.purpose,
    scope_mode: "inherit",
    branch_mode: "inherit",
    max_budget_usd: input.max_budget_usd,
    steps,
    limits: structuredClone(l),
  };
}

function emptyBook(project) {
  return { schema: 1, project_id: project.id, revision: 0, recipes: [] };
}
function validateBook(value, project) {
  check(exact(value, ["schema", "project_id", "revision", "recipes"]) && value.schema === 1 &&
    value.project_id === project.id && Number.isSafeInteger(value.revision) && value.revision >= 0 &&
    Array.isArray(value.recipes) && value.recipes.length <= 50, "recipe_store_invalid");
  const ids = new Set();
  for (const entry of value.recipes) {
    check(exact(entry, ["recipe_id", "current_revision", "versions"]) && text(entry.recipe_id) &&
      !ids.has(entry.recipe_id) && Number.isSafeInteger(entry.current_revision) && entry.current_revision >= 1 &&
      Array.isArray(entry.versions) && entry.versions.length === entry.current_revision && entry.versions.length <= 50, "recipe_store_invalid");
    ids.add(entry.recipe_id);
    for (const [index, version] of entry.versions.entries()) {
      check(exact(version, ["revision", "digest", "definition", "created_at"]) && version.revision === index + 1 &&
        digest(version.digest) && version.digest === hash(recipeDefinition(version.definition)) &&
        version.definition.recipe_id === entry.recipe_id && Number.isFinite(Date.parse(version.created_at)), "recipe_store_invalid");
    }
    check(entry.current_revision === entry.versions.at(-1).revision, "recipe_store_invalid");
  }
  return value;
}

async function readJson(file) {
  let handle;
  try {
    handle = await fs.open(file, "r");
    const stat = await handle.stat();
    check(stat.isFile() && stat.size <= 4 * 1024 * 1024, "recipe_store_invalid");
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await handle.readFile()));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    if (error instanceof RecipeError) throw error;
    throw new RecipeError("recipe_store_unreadable");
  } finally {
    await handle?.close();
  }
}

export class WorkflowRecipes {
  constructor(project) {
    check(object(project) && text(project.id) && path.isAbsolute(project.directory) && path.isAbsolute(project.root), "invalid_project");
    this.project = { ...project };
    this.directory = path.join(project.directory, "workflow-recipes");
    this.index = path.join(this.directory, "index.json");
  }
  static open(project) {
    return new WorkflowRecipes(project);
  }
  async read() {
    const value = await readJson(this.index);
    return validateBook(value ?? emptyBook(this.project), this.project);
  }
  async mutate(operation) {
    await fs.mkdir(this.directory, { recursive: true });
    const lock = path.join(this.directory, "writer.lock"), owner = randomUUID();
    let handle;
    for (let attempt = 0; attempt <= 100; attempt++) {
      try { handle = await fs.open(lock, "wx", 0o600); break; }
      catch (error) {
        if (error.code !== "EEXIST") throw new RecipeError("recipe_lock_unavailable");
        if (attempt === 100) throw new RecipeError("recipe_busy");
        await delay(20);
      }
    }
    try {
      await handle.writeFile(owner);
      await handle.sync();
      const book = await this.read();
      const result = await operation(book);
      book.revision++;
      validateBook(book, this.project);
      await writeJson(this.index, book);
      return structuredClone(result);
    } finally {
      await handle.close();
      check((await fs.readFile(lock, "utf8")) === owner, "recipe_lock_changed");
      await fs.unlink(lock);
    }
  }
  async save(input, expectedRevision) {
    const definition = recipeDefinition(input);
    check(Number.isSafeInteger(expectedRevision) && expectedRevision >= 0, "invalid_expected_revision");
    return this.mutate((book) => {
      let entry = book.recipes.find((item) => item.recipe_id === definition.recipe_id);
      if (!entry) {
        check(expectedRevision === 0 && book.recipes.length < 50, "recipe_revision_changed");
        entry = { recipe_id: definition.recipe_id, current_revision: 0, versions: [] };
        book.recipes.push(entry);
      }
      check(entry.current_revision === expectedRevision, "recipe_revision_changed");
      check(entry.versions.length < 50, "recipe_history_full");
      const version = {
        revision: entry.current_revision + 1,
        digest: hash(definition),
        definition,
        created_at: new Date().toISOString(),
      };
      entry.versions.push(version);
      entry.current_revision = version.revision;
      return structuredClone(version);
    });
  }
  async list() {
    const book = await this.read();
    return book.recipes.map((entry) => ({
      recipe_id: entry.recipe_id,
      current_revision: entry.current_revision,
      name: entry.versions.at(-1).definition.name,
      digest: entry.versions.at(-1).digest,
      created_at: entry.versions.at(-1).created_at,
    }));
  }
  async get(recipeId, revision = null) {
    check(text(recipeId) && Number.isSafeInteger(revision ?? 1) && (revision === null || revision >= 1), "invalid_recipe_reference");
    const entry = (await this.read()).recipes.find((item) => item.recipe_id === recipeId);
    check(entry, "recipe_not_found");
    const found = entry.versions.find((item) => item.revision === (revision ?? entry.current_revision));
    check(found, "recipe_revision_not_found");
    return structuredClone(found);
  }
  async preview(recipeId, revision, runId, bindings, planId, now = Date.now()) {
    const version = await this.get(recipeId, revision);
    const [run, store] = await Promise.all([
      SessionLedger.open(this.project).then((ledger) => ledger.resolve(runId)),
      ProjectStore.open(this.project),
    ]);
    return previewRecipe({
      project: this.project,
      version,
      run,
      state: store.value,
      bindings,
      planId,
      now,
    });
  }
}

export function previewRecipe({ project, version, run, state, bindings, planId, now = Date.now() }) {
  const recipe = recipeDefinition(version.definition);
  check(text(planId) && idPattern.test(planId) && text(run?.run_id) && object(state) && object(bindings), "invalid_recipe_target");
  const blockers = [];
  const add = (code, detail = null) => blockers.push({ code, detail });
  const ledgerReady = run.project_id === project.id && text(run.run_id);
  if (!ledgerReady || run.binding !== "confirmed" || run.cli !== "dsh" || run.cli_version !== "0.2.0-rc.2" || !text(run.cli_session_id))
    add("run_binding_unconfirmed");
  const cwd = path.resolve(run.cwd || "");
  const relative = path.relative(project.root, cwd);
  if (!path.isAbsolute(cwd) || relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative))
    add("run_outside_project");
  if (!text(run.branch, 1000) || run.git?.status !== "observed" || !/^[a-f0-9]{40}$/i.test(run.git?.head || ""))
    add("branch_state_unknown");
  if (!object(run.scope)) add("permission_scope_unknown");
  const stepKeys = recipe.steps.map((step) => step.key);
  const bindingKeys = Object.keys(bindings);
  if (bindingKeys.length !== stepKeys.length || stepKeys.some((key) => !Object.hasOwn(bindings, key)))
    add("recipe_bindings_incomplete");
  const taskById = new Map(state.tasks.map((task) => [task.id, task]));
  const targetIds = recipe.steps.map((step) => bindings[step.key]).filter((id) => text(id));
  if (targetIds.length !== recipe.steps.length || new Set(targetIds).size !== recipe.steps.length)
    add("recipe_bindings_invalid");
  const targets = recipe.steps.map((step) => {
    const id = bindings[step.key], task = taskById.get(id);
    if (!task) add("task_not_found", { step: step.key, task_id: id });
    return {
      step: step.key,
      task_id: id,
      title: task?.title ?? null,
      status: task?.status ?? "unknown",
      purpose: step.purpose,
      risk: step.risk,
      approval_required: step.approval !== null,
      inputs: Object.fromEntries(step.inputs.map((field) => [
        field,
        field === "task.title" ? task?.title ?? null
          : field === "task.milestone" ? task?.milestone ?? null
            : task?.blocker ?? null,
      ])),
      exit_conditions: structuredClone(step.exit_conditions),
      depends_on: step.depends_on.map((key) => bindings[key]),
      parent_task_id: step.parent_key === null ? null : bindings[step.parent_key],
    };
  });
  const rootSteps = recipe.steps.filter((step) => step.parent_key === null);
  if (!text(run.task_id, 160)) add("run_task_unknown");
  else if (!rootSteps.some((step) => bindings[step.key] === run.task_id))
    add("run_task_not_bound_as_root");
  const policy = publicBudgetAdmission(state);
  const activePolicies = (policy?.policies || []).filter((item) => item.active &&
    (item.run_id === null || item.run_id === run.run_id));
  const requestedBudget = moneyUnits(recipe.max_budget_usd);
  if (!activePolicies.length) add("budget_policy_missing");
  for (const item of activePolicies) {
    const limit = moneyUnits(item.hard_limit), effective = moneyUnits(item.effective);
    if (item.currency !== "USD") add("budget_currency_mismatch", { policy_id: item.policy_id, currency: item.currency });
    if (!["within_budget", "warning"].includes(item.status))
      add("budget_policy_unavailable", { policy_id: item.policy_id, status: item.status });
    if (effective === null) add("budget_spend_unknown", { policy_id: item.policy_id });
    else if (limit === null || effective > limit || requestedBudget > limit - effective)
      add("budget_policy_below_recipe_max", {
        policy_id: item.policy_id,
        current_effective: item.effective,
        hard_limit: item.hard_limit,
        remaining: limit === null || effective > limit ? "0" : moneyString(limit - effective),
      });
  }
  const stopAt = new Date(now + recipe.limits.deadline_minutes * 60000).toISOString();
  const nodeByKey = new Map(recipe.steps.map((step) => [step.key, bindings[step.key]]));
  const definition = {
    plan_id: planId,
    run_id: run.run_id,
    nodes: recipe.steps.map((step) => ({
      task_id: nodeByKey.get(step.key),
      depends_on: step.depends_on.map((key) => nodeByKey.get(key)),
      parent_task_id: step.parent_key === null ? null : nodeByKey.get(step.parent_key),
    })),
    limits: {
      max_concurrent: recipe.limits.max_concurrent,
      max_depth: recipe.limits.max_depth,
      max_starts: recipe.limits.max_starts,
      stop_at: stopAt,
      stop_on_failure: recipe.limits.stop_on_failure,
    },
  };
  const actualGraphProblems = graphProblems(definition, new Set(state.tasks.map((task) => task.id)));
  for (const issue of actualGraphProblems) add("plan_" + issue.code, issue);
  const scopeDigest = hash(run.scope);
  const currentTaskDigest = taskDigest(state, targetIds);
  const currentBudgetDigest = budgetDigest(state, run.run_id),
    budgetBaseline = activePolicies.map((item) => ({
      policy_id: item.policy_id,
      currency: item.currency,
      current_effective: item.effective,
      hard_limit: item.hard_limit,
    })).sort((a, b) => a.policy_id.localeCompare(b.policy_id));
  const targetHash = hash({
    project_id: project.id,
    project_root: project.root,
    run_id: run.run_id,
    session_id: run.cli_session_id,
    recipe_digest: version.digest,
    cwd,
    branch: run.branch,
    git_head: run.git?.head ?? null,
    scope_digest: scopeDigest,
    task_digest: currentTaskDigest,
    budget_digest: currentBudgetDigest,
    budget_baseline: budgetBaseline,
    bindings: targets.map((item) => [item.step, item.task_id]),
  });
  definition.recipe = {
    recipe_id: recipe.recipe_id,
    revision: version.revision,
    digest: version.digest,
    project_id: project.id,
    target_hash: targetHash,
    session_id: run.cli_session_id,
    branch: run.branch,
    git_head: run.git?.head ?? null,
    scope_digest: scopeDigest,
    task_digest: currentTaskDigest,
    budget_digest: currentBudgetDigest,
    budget_baseline: budgetBaseline,
    max_budget_usd: recipe.max_budget_usd,
    steps: targets.map((item) => ({
      key: item.step,
      task_id: item.task_id,
      task_status: item.status,
      purpose: item.purpose,
      risk: item.risk,
      approval_required: item.approval_required,
      inputs: item.inputs,
      exit_conditions: item.exit_conditions,
    })),
  };
  const safeDefinition = blockers.length ? null : planDefinition(definition);
  const preview = {
    schema: 1,
    status: blockers.length ? "blocked" : "ready",
    recipe: { recipe_id: recipe.recipe_id, revision: version.revision, digest: version.digest, name: recipe.name },
    target: {
      project_id: project.id,
      project_root: project.root,
      run_id: run.run_id,
      task_id: run.task_id,
      native_session_id: run.cli_session_id,
      branch: run.branch,
      git_head: run.git?.head ?? null,
      branch_policy: "inherit; no checkout or branch change",
      permission_policy: "inherit current DSH permissions; this recipe grants none",
      permission_snapshot: "DSH action permissions are not independently enumerated; environment scope digest only",
      scope_digest: scopeDigest,
    },
    bindings: targets,
    budget: {
      requested_max_usd: recipe.max_budget_usd,
      policy_ids: activePolicies.map((item) => item.policy_id).sort(),
      policies: activePolicies.map((item) => {
        const limit = moneyUnits(item.hard_limit),
          effective = moneyUnits(item.effective);
        return {
          policy_id: item.policy_id,
          run_id: item.run_id,
          currency: item.currency,
          current_effective: item.effective,
          hard_limit: item.hard_limit,
          remaining:
            limit === null || effective === null || effective > limit
              ? "0"
              : moneyString(limit - effective),
          status: item.status,
        };
      }),
      policy_digest: currentBudgetDigest,
      comparison: activePolicies.length ? "requested ceiling checked against each active run/project remaining hard limit" : "unknown",
    },
    approvals: targets.filter((item) => item.approval_required).map((item) => ({
      step: item.step,
      task_id: item.task_id,
      status: "separate typed human approval required before this step can start",
    })),
    limits: definition.limits,
    blockers,
    plan_definition: safeDefinition,
  };
  const tokenLimits = { ...preview.limits },
    tokenPlan = preview.plan_definition ? structuredClone(preview.plan_definition) : null;
  delete tokenLimits.stop_at;
  if (tokenPlan) delete tokenPlan.limits.stop_at;
  preview.preview_token = hash({
    recipe: preview.recipe,
    target: preview.target,
    bindings: preview.bindings,
    budget: preview.budget,
    approvals: preview.approvals,
    limits: { ...tokenLimits, deadline_minutes: recipe.limits.deadline_minutes },
    blockers: preview.blockers,
    plan_definition: tokenPlan,
  });
  return preview;
}

export function recipeApprovalQuestion({ questionId, planId, targetHash, run, taskId, step, budget, expiresAt }) {
  const actionId = "recipe_" + hash({ plan_id: planId, task_id: taskId }).slice(0, 48);
  return {
    id: questionId,
    question: step.approval.question,
    urgency: "high",
    default_action: "対象・差分・影響・費用を確認するまで実行しない",
    decision: {
      kind: "approval",
      target: {
        task_id: taskId,
        run_id: run.run_id,
        session_id: run.cli_session_id,
        action_id: actionId,
        revision: targetHash,
      },
      choices: [
        { id: "approve", label: "この工程だけ承認", detail: step.purpose },
        { id: "reject", label: "承認しない", detail: "この工程は開始しない" },
      ],
      diff: step.approval.diff,
      impact: step.approval.impact,
      conditions: step.approval.conditions,
      cost: {
        currency: "USD",
        max: Number(budget),
        description:
          "Whole-recipe review ceiling, not an extra per-step allowance; the existing run/project budget guard remains authoritative",
      },
      expires_at: expiresAt,
    },
    ref: {
      action_id: actionId,
      action_revision: targetHash,
    },
  };
}

export function taskStateDigest(state, taskIds) {
  return taskDigest(state, taskIds);
}
export function currentBudgetDigest(state, runId) {
  return budgetDigest(state, runId);
}
export function scopeDigest(scope) {
  return hash(scope);
}
