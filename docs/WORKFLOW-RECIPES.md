# Reusable workflow recipes

Recipes store a revisioned mapping from repeatable workflow steps to existing
project task IDs. The dashboard previews that mapping, then can create a disabled
bounded plan for one confirmed native DSH run. The original DSH Workflow remains
the execution owner; recipes do not create a second agent loop or grant new
permissions.

## Define a recipe

Save this JSON as `recipe.json` and create revision 1 with:

```sh
rdsh-dashboard recipe save --project /path/to/project \
  --input-file recipe.json --expected-revision 0
```

Use the returned current revision as `--expected-revision` when saving an update.
Earlier revisions remain available to `recipe inspect --expected-revision N`.

```json
{
  "schema": 1,
  "recipe_id": "issue-review",
  "name": "Issue investigation and implementation",
  "purpose": "Investigate, implement, and verify through the existing DSH Workflow",
  "scope_mode": "inherit",
  "branch_mode": "inherit",
  "max_budget_usd": "1.00",
  "steps": [
    {
      "key": "inspect",
      "purpose": "Inspect the issue and existing project contract",
      "risk": "read_only",
      "depends_on": [],
      "parent_key": null,
      "inputs": ["task.title", "task.milestone", "task.blocker"],
      "exit_conditions": ["original_workflow.completed"],
      "approval": null
    },
    {
      "key": "implement",
      "purpose": "Implement the approved task in the existing workspace",
      "risk": "workspace_write",
      "depends_on": ["inspect"],
      "parent_key": "inspect",
      "inputs": ["task.title", "task.milestone", "task.blocker"],
      "exit_conditions": ["dependencies.verified", "original_workflow.completed"],
      "approval": {
        "question": "Approve this workspace change?",
        "diff": "Only the mapped task and its stated scope",
        "impact": "Files in the existing workspace may change",
        "conditions": "Publishing, billing, credentials, and merge remain separate decisions"
      }
    }
  ],
  "limits": {
    "max_concurrent": 2,
    "max_depth": 2,
    "max_starts": 2,
    "deadline_minutes": 120,
    "stop_on_failure": true
  }
}
```

`inputs` selects existing task fields, which the preview resolves and snapshots.
`exit_conditions` records the existing Workflow completion and verified-dependency
conditions. A dependency graph is explicit through `depends_on`; native branch
parentage is explicit through `parent_key`. Risky steps must include a typed
approval description with a diff, impact, conditions, and an explicit cost
ceiling.

## Preview and apply

The bindings file maps every recipe step to one existing project task ID:

```json
{
  "inspect": "issue-66",
  "implement": "implementation-task-66"
}
```

Preview an exact confirmed run and a fresh plan ID:

```sh
rdsh-dashboard recipe preview --project /path/to/project \
  --recipe-id issue-review --run-id run_<uuid> --plan-id issue-review-run-1 \
  --input-file bindings.json
```

Review the target repository, run and native session, task fields, branch and
commit, environment scope digest, budget-policy effective amount and remaining
hard limit, dependency and parent graph, approvals, and
concurrency/depth/start/deadline limits. Unknown run, task, environment-scope,
branch, or budget data blocks apply. DSH action permissions are not independently
enumerated; the recipe inherits the existing native DSH authority and grants no
new capabilities. The run task must map to a root step. Its budget ceiling is
compared with each active matching policy's remaining limit; the existing budget
guard remains responsible for actual spend enforcement.

Use `--expected-revision N` on preview/apply to pin a prior saved version. Without
it, the current recipe revision is used, and apply rejects a newer or changed
preview.

Pass the preview token to `recipe apply` after reviewing the result:

```sh
rdsh-dashboard recipe apply --project /path/to/project \
  --recipe-id issue-review --run-id run_<uuid> --plan-id issue-review-run-1 \
  --input-file bindings.json --preview-token <token>
```

Apply re-resolves the same recipe version, run, tasks, branch, scope, and budget
policy. A changed preview is rejected. It creates the typed approval cards and
a disabled execution plan that records the recipe revision and resolved step
conditions on the exact run. It does not start a process or send a message.
Answer each risky-step card separately in the dashboard, then explicitly bind
the plan with `plan enforce`. The bounded plan rechecks the target contract and
approval before each native step; a changed or unanswered approval blocks that
step. DSH's original workflow and existing project budget controls continue to
own task execution and native authority.

## CLI compatibility evidence

The [before/after output diff](evidence/workflow-recipes/cli-output.diff) runs
`recipe list` against an isolated empty project on the parent CLI and this
implementation.
