import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { identity, ProjectStore } from "../state.mjs";
import { ExecutionPlans } from "../execution-plan.mjs";
import { SessionLedger } from "../session-ledger.mjs";
import {
  RecipeError,
  WorkflowRecipes,
  previewRecipe,
  recipeApprovalQuestion,
  recipeDefinition,
} from "../workflow-recipes.mjs";
import { budgetPolicy } from "./fixtures/budget-policy.mjs";

const exec = promisify(execFile),
  fail = (code) => (error) => error.code === code,
  cli = fileURLToPath(new URL("../cli.mjs", import.meta.url));

function recipeDefinitionFixture() {
  return {
    schema: 1,
    recipe_id: "review-flow",
    name: "レビュー作業",
    purpose: "調査、実装、検証の順に既存Workflowで進める",
    scope_mode: "inherit",
    branch_mode: "inherit",
    max_budget_usd: "0.5",
    steps: [
      {
        key: "inspect",
        purpose: "既存資料とtaskを調べる",
        risk: "read_only",
        depends_on: [],
        parent_key: null,
        inputs: ["task.title", "task.milestone"],
        exit_conditions: ["original_workflow.completed"],
        approval: null,
      },
      {
        key: "change",
        purpose: "taskに沿ってworkspaceを変更する",
        risk: "workspace_write",
        depends_on: [],
        parent_key: "inspect",
        inputs: ["task.title", "task.blocker"],
        exit_conditions: ["dependencies.verified", "original_workflow.completed"],
        approval: {
          question: "このworkspace変更を許可しますか？",
          diff: "確認済みの対象task内だけを編集します",
          impact: "対象workspaceのファイルが変わります",
          conditions: "公開、課金、mergeは別の明示承認が必要です",
        },
      },
    ],
    limits: {
      max_concurrent: 2,
      max_depth: 2,
      max_starts: 2,
      deadline_minutes: 60,
      stop_on_failure: true,
    },
  };
}

async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rdsh-recipe-test-")),
    cwd = path.join(root, "project");
  await fs.mkdir(cwd);
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) =>
      /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|TEMP|TMP|COMSPEC|LANG|LC_ALL)$/i.test(key),
    ),
  );
  Object.assign(env, {
    HOME: root,
    USERPROFILE: root,
    RDSH_DASHBOARD_HOME: path.join(root, "dashboard"),
    GIT_CEILING_DIRECTORIES: root,
  });
  await fs.writeFile(path.join(cwd, "README.md"), "recipe fixture\n");
  await exec("git", ["-C", cwd, "init", "-b", "recipe-qa"], { env });
  await exec("git", ["-C", cwd, "add", "--", "README.md"], { env });
  await exec("git", [
    "-C", cwd, "-c", "user.name=Recipe Fixture", "-c", "user.email=recipe@example.invalid",
    "-c", "commit.gpgsign=false", "commit", "-m", "Fixture",
  ], { env });
  const project = await identity(cwd);
  project.directory = path.join(root, "dashboard", "projects", project.id);
  const store = await ProjectStore.open(project);
  await store.mutate("task", { id: "task-root", title: "Inspect issue", status: "todo" });
  await store.mutate("task", { id: "task-change", title: "Implement issue", status: "todo" });
  await store.mutateBudget("policy", budgetPolicy({ hard_limit: "1" }));
  const ledger = await SessionLedger.open(project),
    reported = await ledger.record({
      task_id: "task-root",
      cli_session_id: "native-recipe-fixture",
      cwd,
      command: [process.execPath],
      env,
    }),
    run = await ledger.confirm(reported.run_id, "native-recipe-fixture", "0.2.0-rc.2");
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("rdsh-recipe-test-"));
    await fs.rm(root, { recursive: true });
  });
  return { root, cwd, project, store, run, env };
}

test("recipe schema requires explicit approval for risky steps and rejects cycles", () => {
  const value = recipeDefinitionFixture();
  const unsafe = structuredClone(value);
  unsafe.steps[1].approval = null;
  assert.throws(() => recipeDefinition(unsafe), fail("risky_recipe_step_requires_approval"));
  const cyclic = structuredClone(value);
  cyclic.steps[0].depends_on = ["change"];
  cyclic.steps[1].depends_on = ["inspect"];
  assert.throws(() => recipeDefinition(cyclic), fail("invalid_recipe_graph"));
});

test("recipe versions use optimistic revisions and preview is read-only and target-bound", async (t) => {
  const f = await setup(t), recipes = WorkflowRecipes.open(f.project),
    first = await recipes.save(recipeDefinitionFixture(), 0);
  assert.equal(first.revision, 1);
  await assert.rejects(recipes.save(recipeDefinitionFixture(), 0), fail("recipe_revision_changed"));
  const bindings = { inspect: "task-root", change: "task-change" };
  const preview = await recipes.preview("review-flow", 1, f.run.run_id, bindings, "recipe-plan");
  assert.equal(preview.status, "ready");
  assert.equal(preview.target.permission_policy, "inherit current DSH permissions; this recipe grants none");
  assert.equal(preview.bindings[1].parent_task_id, "task-root");
  assert.equal(preview.approvals.length, 1);
  assert.equal(preview.budget.policies[0].current_effective, "0.3");
  assert.equal(preview.budget.policies[0].remaining, "0.7");
  await assert.rejects(fs.access(path.join(f.project.directory, "execution-plans", "index.json")));
  assert.deepEqual(f.store.value.questions, []);

  const bindingsFile = path.join(f.root, "bindings.json");
  await fs.writeFile(bindingsFile, JSON.stringify(bindings));
  const runCli = (...args) => exec(process.execPath, [cli, ...args], {
    env: f.env,
    windowsHide: true,
  });
  const cliPreview = JSON.parse((await runCli(
    "recipe", "preview", "--project", f.cwd, "--recipe-id", "review-flow",
    "--run-id", f.run.run_id, "--plan-id", "cli-plan", "--input-file", bindingsFile,
  )).stdout);
  const applied = JSON.parse((await runCli(
    "recipe", "apply", "--project", f.cwd, "--recipe-id", "review-flow",
    "--run-id", f.run.run_id, "--plan-id", "cli-plan", "--input-file", bindingsFile,
    "--preview-token", cliPreview.preview_token,
  )).stdout);
  assert.equal(applied.status, "disabled_plan_created");
  assert.equal(applied.execution_started, false);
  assert.equal(applied.approval_question_ids.length, 1);
  assert.equal(applied.plan.enabled_at, null);

  const blocked = previewRecipe({
    project: f.project,
    version: first,
    run: { ...f.run, scope: null },
    state: { ...f.store.value, budget_admission: undefined },
    bindings,
    planId: "blocked-plan",
  });
  assert.equal(blocked.status, "blocked");
  assert.ok(blocked.blockers.some((item) => item.code === "permission_scope_unknown"));
  assert.ok(blocked.blockers.some((item) => item.code === "budget_policy_missing"));
  assert.equal(blocked.plan_definition, null);
});

test("resolved recipe version is bound to the run; risky step waits for its own typed approval", async (t) => {
  const f = await setup(t), recipes = WorkflowRecipes.open(f.project),
    version = await recipes.save(recipeDefinitionFixture(), 0),
    preview = await recipes.preview("review-flow", version.revision, f.run.run_id,
      { inspect: "task-root", change: "task-change" }, "recipe-plan");
  assert.equal(preview.status, "ready");
  const definition = structuredClone(preview.plan_definition),
    step = version.definition.steps[1],
    questionId = "recipe_" + randomUUID();
  const { ref, ...question } = recipeApprovalQuestion({
    questionId,
    planId: "recipe-plan",
    targetHash: definition.recipe.target_hash,
    run: f.run,
    taskId: "task-change",
    step,
    budget: version.definition.max_budget_usd,
    expiresAt: definition.limits.stop_at,
  });
  await f.store.mutate("question", question);
  const card = f.store.value.question_contracts.cards[questionId];
  definition.nodes[1].approval = {
    question_id: questionId,
    revision: card.revision,
    fingerprint: card.fingerprint,
    action_id: ref.action_id,
    action_revision: ref.action_revision,
  };
  const plans = ExecutionPlans.open(f.project);
  await plans.define(definition);
  const bound = await plans.enforce("recipe-plan", f.run);
  assert.equal(bound.binding.session_id, f.run.cli_session_id);
  const inspect = await plans.inspect("recipe-plan");
  assert.equal(inspect.plans[0].recipe.revision, version.revision);
  assert.equal(inspect.plans[0].recipe.resolved_steps[1].task_id, "task-change");
  assert.equal(inspect.plans[0].recipe.resolved_steps[1].task_status, "todo");
  assert.equal(inspect.plans[0].recipe.max_budget_usd, "0.5");
  assert.equal(inspect.plans[0].recipe.budget_baseline[0].current_effective, "0.3");

  const rootClaim = await plans.admit("recipe-plan", bound.context_hash, {
    task_id: "task-root", parent_session_id: f.run.cli_session_id, native_depth: 1,
  });
  await plans.update(rootClaim.claim_id, "started", "native-child-root");
  await assert.rejects(
    plans.admit("recipe-plan", bound.context_hash, {
      task_id: "task-change", parent_session_id: "native-child-root", native_depth: 2,
    }),
    fail("recipe_approval_pending"),
  );
  await f.store.mutate("answer", {
    id: questionId,
    answer: "この工程だけ承認",
    expected_revision: card.revision,
    contract_fingerprint: card.fingerprint,
    choice_id: "approve",
  });
  const next = await plans.admit("recipe-plan", bound.context_hash, {
    task_id: "task-change", parent_session_id: "native-child-root", native_depth: 2,
  });
  await assert.doesNotReject(plans.beforeDispatch(next));

  const priorPolicy = f.store.value.budget_admission.policies["project-budget"],
    { revision, ...policy } = priorPolicy;
  await f.store.mutateBudget("policy", {
    ...policy,
    expected_revision: revision,
    hard_limit: "0.9",
    reason: "Fixture policy changed after recipe preview",
  });
  await assert.rejects(plans.beforeDispatch(next), fail("recipe_target_changed"));
});

test("changing a bound recipe task contract makes its preview stale before the run starts", async (t) => {
  const f = await setup(t), recipes = WorkflowRecipes.open(f.project),
    version = await recipes.save(recipeDefinitionFixture(), 0),
    preview = await recipes.preview("review-flow", version.revision, f.run.run_id,
      { inspect: "task-root", change: "task-change" }, "stale-plan");
  assert.equal(preview.status, "ready");
  await f.store.mutate("task", { id: "task-change", title: "Different target", status: "todo" });
  const definition = structuredClone(preview.plan_definition),
    step = version.definition.steps[1],
    questionId = "recipe_" + randomUUID(),
    { ref, ...question } = recipeApprovalQuestion({
      questionId,
      planId: "stale-plan",
      targetHash: definition.recipe.target_hash,
      run: f.run,
      taskId: "task-change",
      step,
      budget: version.definition.max_budget_usd,
      expiresAt: definition.limits.stop_at,
    });
  await f.store.mutate("question", question);
  const card = f.store.value.question_contracts.cards[questionId];
  definition.nodes[1].approval = {
    question_id: questionId,
    revision: card.revision,
    fingerprint: card.fingerprint,
    action_id: ref.action_id,
    action_revision: ref.action_revision,
  };
  await ExecutionPlans.open(f.project).define(definition);
  await assert.rejects(
    ExecutionPlans.open(f.project).enforce("stale-plan", f.run),
    fail("recipe_target_changed"),
  );
});

test("new budget reservations after preview invalidate the reviewed remaining budget", async (t) => {
  const f = await setup(t), recipes = WorkflowRecipes.open(f.project),
    version = await recipes.save(recipeDefinitionFixture(), 0),
    preview = await recipes.preview("review-flow", version.revision, f.run.run_id,
      { inspect: "task-root", change: "task-change" }, "budget-stale-plan");
  assert.equal(preview.status, "ready");
  const definition = structuredClone(preview.plan_definition),
    step = version.definition.steps[1],
    questionId = "recipe_" + randomUUID(),
    { ref, ...question } = recipeApprovalQuestion({
      questionId,
      planId: "budget-stale-plan",
      targetHash: definition.recipe.target_hash,
      run: f.run,
      taskId: "task-change",
      step,
      budget: version.definition.max_budget_usd,
      expiresAt: definition.limits.stop_at,
    });
  await f.store.mutate("question", question);
  const card = f.store.value.question_contracts.cards[questionId];
  definition.nodes[1].approval = {
    question_id: questionId,
    revision: card.revision,
    fingerprint: card.fingerprint,
    action_id: ref.action_id,
    action_revision: ref.action_revision,
  };
  const plans = ExecutionPlans.open(f.project);
  await plans.define(definition);
  await f.store.mutateBudget("job", {
    job_id: "external-fixture-job",
    run_id: "run_other",
    worker_id: "worker_other",
  });
  await f.store.mutateBudget("ready", { job_id: "external-fixture-job" });
  await f.store.mutateBudget("call", {
    job_id: "external-fixture-job",
    call_id: randomUUID(),
    session_id: "native-external-fixture",
    provider: "fixture-provider",
    model: "fixture-model",
    purpose: null,
  });
  await assert.rejects(
    plans.enforce("budget-stale-plan", f.run),
    fail("recipe_target_changed"),
  );
});
