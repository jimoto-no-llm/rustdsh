# Dependencies and bounded native Workflow admission

Issue [#15](https://github.com/jimoto-no-llm/rustdsh/issues/15) adds an optional
project-scoped admission ledger beside task schema 1. The original DSH Workflow,
PTC guest, subagent creation, Schedule delivery, profile boot and agent loop retain
execution ownership. The ordinary Rust launcher and `--passthrough` are unchanged.

## Connect an existing run

Use the existing session-ledger to establish a confirmed DSH 0.2.0-rc.2 native
session in this project. `session-ledger start` creates the session and stops its
owned ACP process without sending a prompt. Plan setup sends no model request.

Write an explicit JSON definition, using actual task IDs already in the project:

```json
{
  "plan_id": "feature-plan-1",
  "run_id": "REPLACE_WITH_CONFIRMED_RUN_ID",
  "nodes": [
    { "task_id": "prepare", "depends_on": [], "parent_task_id": null },
    {
      "task_id": "implement",
      "depends_on": ["prepare"],
      "parent_task_id": null
    }
  ],
  "limits": {
    "max_concurrent": 2,
    "max_depth": 2,
    "max_starts": 10,
    "stop_at": "2026-10-10T12:00:00.000Z",
    "stop_on_failure": true
  }
}
```

Choose a future UTC `stop_at` appropriate for the work. This example deadline
is illustrative; an expired plan cannot enable or dispatch a child.

```sh
node dashboard/cli.mjs plan define --project /absolute/project --input-file plan.json
node dashboard/cli.mjs plan inspect --project /absolute/project --plan-id feature-plan-1
node dashboard/cli.mjs plan enforce --project /absolute/project --plan-id feature-plan-1 --run-id EXACT_RUN
```

Definitions are immutable. Invalid drafts remain inspectable, with task-specific
cycle, unknown-task, unknown-wait-node and branch-depth blockers. They cannot
enable. Correct them in a new definition with a new plan ID. `enforce` requires
the exact confirmed run/session, matching project cwd and native version. Each
run binds to one plan; enabling one does not start a CLI or a Workflow.

Subsequent existing `session-ledger resume` and `reply-consumer once|serve`
attachments automatically load this run's plan guard before any send. They use
the existing owned ACP process and process-scope cleanup. A required marker is
written before the bound index: a missing/corrupt index or missing required
marker blocks attachment. Failed or stale writer locks are preserved.

The scoped Node preload requires Node 22.15+ or 24. It checks the whole published
source SHA256 for `dsh-workflow-ptc`, `dsh-subagent` and
`dsh-subagent-spawn-in-process` at 0.2.0-rc.2, and exact adapter markers. An
unrecognized source refuses to load. It changes only this launch's module source
in memory; no installed module, profile or global setting is rewritten.

## Original Workflow task identity

Inside the existing confined Workflow script, identify every child explicitly:

```javascript
return await agent("Implement the declared task", { rdshTaskId: "implement" });
```

The opt-in guest adapter carries this ID across the original child RPC. It does
not infer a task from prompt text or labels. Untagged/undeclared children,
wrong root or branch parent sessions, direct subagent calls and continuable
starts are refused. Only provider instances registered by the audited native
in-process spawn plugin are admitted; aliases configured by that plugin work.
External ACP/SDK providers are refused before their factory because this guard
cannot attest their descendant runtimes. In-process descendants share the same
guard; each declared `parent_task_id` must match a currently running native
claim, and the original `delegationDepthOf` value must fit `max_depth`.

Workflow remains responsible for scripts, existing parallel/pipeline behavior,
native deployment ceilings, event publication, cancellation and disposal. The
admission layer reserves once immediately before calling the original subagent
factory. It does not poll tasks, generate prompts, retry model calls, replace
the Workflow loop, or create another scheduler. Schedule inbox delivery alone
does not satisfy dependencies; execution must occur through the bound attachment.

## Admission and dependency completion

Every child start checks the immutable graph, active root/branch identity,
deadline/operator stop, failure stop condition, total-start count, concurrency
and prerequisite evidence. Reservations across all plans in one project share
an exclusive writer lock; two processes cannot claim the same task. Concurrent
reservations obey both the new plan's ceiling and every active plan's ceiling.
The lock has a bounded contention wait, without clearing an existing owner or
retrying any native execution.

A prerequisite requires all of the following:

- The original task has a `done` report.
- Every declared full acceptance check has a current, intact, successful local
  execution record in `AcceptanceStore`, including source/environment binding
  and command/log integrity.
- If a native claim exists, its result is `completed` and disposal is confirmed.

Reported passes, partial checks, stale/missing/tampered artifacts, a still-held
claim and native `completed` by itself do not open a dependency. Current full
checks are not artistic review, production adoption or a paid provider proof.
Verified tasks are displayed as checked and are not started again.

Each receipt records plan/context/task, parent and published child session,
original native depth, prerequisite evidence IDs, outcome and disposal. Prompt
content, task outputs and provider credentials are not copied to this ledger.
Only confirmed native disposal with a known result releases concurrent capacity.
An unknown startup, rejected result, failed write or failed disposal retains its
claim; an unconfirmed start is never automatically replayed. A task ID has one
start claim across the project, including terminal claims. An intentional new
attempt requires a new explicit task/run/plan; this feature does not authorize
retries or erase earlier attempts. Closing an attachment without terminal child
receipts marks its reserved/running claims unknown and retains capacity. A new
plan does not release those older claims; operator inspection and separate
recovery evidence are required. State is bounded at 20 plans, 200 nodes per
plan, 1000 claims and 2000 audit events, with fail-closed exhaustion.

Deadline, failure and operator stop prevent new starts. They allow already
running native children to settle and leave their original cancellation and
cleanup behavior in place. Stop a plan from the authenticated human browser or:

```sh
node dashboard/cli.mjs plan stop --project /absolute/project --plan-id feature-plan-1
```

The original six MCP tools remain unchanged and cannot enable, stop or authorize
a plan. `GET /api/plans` and `POST /api/plans/stop` are human/admin scoped.
The dependency view shows checked, waiting and admission candidates separately;
candidates are rechecked at dispatch. Blockers navigate to the exact task or a
missing-node explanation. Large graphs start collapsed, render at most 50 rows
per page, and preserve page/expansion across independent refreshes.

## Verification and scope

```sh
npm ci --prefix dashboard
npm test --prefix dashboard
npm install --prefix /isolated/native-plan --ignore-scripts --no-audit --no-fund \
  @deepseek-ai/dsh-workflow-ptc@0.2.0-rc.2 @deepseek-ai/dsh-subagent@0.2.0-rc.2 \
  @deepseek-ai/dsh-subagent-spawn-in-process@0.2.0-rc.2 @deepseek-ai/cordis@4.0.4
RDSH_TEST_PLAN_PACKAGE=/isolated/native-plan/package.json node --test tests/plan-runtime-native.test.mjs
npm test --prefix tests/e2e
```

Linux's tracked ACP test requires a delegated cgroup, as the existing dashboard
tests do; CI gives this test run its own delegated systemd unit. Native tests use
the original engine, guest VM code, subagent service and spawn registration, with
synthetic providers and a PTC host transport fixture. They verify native admission
and cleanup seams, not production PTC confinement or paid model execution. The
browser suite uses a real isolated project HTTP server and local acceptance
commands. Default unwrapped CLIs, independent external processes and arbitrary
shell-launched runtimes are outside this explicit attachment scope.

Recorded QA and actual PNG/GIF captures are in
[the execution-plan evidence](evidence/execution-plan/README.md).
