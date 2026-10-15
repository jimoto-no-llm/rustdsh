import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { classifyGitHubStatus, inspectGitHubStatus } from "../github-status.mjs";
import { identity } from "../state.mjs";
import { startDashboard } from "../server.mjs";

const shaA = "a".repeat(40);
const shaB = "b".repeat(40);

function readySnapshot(overrides = {}) {
  return {
    local_sha: shaA,
    dirty: false,
    upstream: { remote: "origin", ref: "refs/heads/topic" },
    remote_sha: shaA,
    remote_error: false,
    github_error: false,
    pr_error: false,
    pr: {
      head_sha: shaA,
      state: "OPEN",
      is_draft: false,
      review_decision: "APPROVED",
      merge_state: "CLEAN",
      mergeable: "MERGEABLE",
    },
    checks_available: true,
    checks_truncated: false,
    checks: [],
    ...overrides,
  };
}

test("merge-ready requires exact pushed and PR head SHAs plus GitHub approval", () => {
  assert.equal(classifyGitHubStatus(readySnapshot()), "merge_ready");
  assert.equal(
    classifyGitHubStatus(
      readySnapshot({ remote_sha: shaB, pr: { ...readySnapshot().pr, head_sha: shaB } }),
    ),
    "push_not_confirmed",
  );
  assert.equal(
    classifyGitHubStatus(
      readySnapshot({ pr: { ...readySnapshot().pr, head_sha: shaB } }),
    ),
    "pr_head_stale",
  );
  assert.equal(
    classifyGitHubStatus(readySnapshot({ dirty: true })),
    "local_changes_unpushed",
  );
  assert.equal(
    classifyGitHubStatus(
      readySnapshot({ target_changed_during_observation: true }),
    ),
    "target_changed_during_observation",
  );
});

test("required checks and review blockers are conservative; optional failures stay visible", () => {
  const requiredPending = {
    kind: "check_run",
    required: true,
    status: "IN_PROGRESS",
    conclusion: null,
  };
  const requiredFailed = {
    kind: "check_run",
    required: true,
    status: "COMPLETED",
    conclusion: "FAILURE",
  };
  assert.equal(
    classifyGitHubStatus(readySnapshot({ checks: [requiredPending] })),
    "ci_pending",
  );
  assert.equal(
    classifyGitHubStatus(readySnapshot({ checks: [requiredFailed] })),
    "ci_failed",
  );
  assert.equal(
    classifyGitHubStatus(
      readySnapshot({
        checks: [{ ...requiredFailed, required: false }],
      }),
    ),
    "merge_ready",
  );
  assert.equal(
    classifyGitHubStatus(
      readySnapshot({ pr: { ...readySnapshot().pr, review_decision: "REVIEW_REQUIRED" } }),
    ),
    "review_required",
  );
  assert.equal(
    classifyGitHubStatus(
      readySnapshot({ pr: { ...readySnapshot().pr, review_decision: "CHANGES_REQUESTED" } }),
    ),
    "review_changes_requested",
  );
  assert.equal(
    classifyGitHubStatus(
      readySnapshot({ checks_available: false, checks: [] }),
    ),
    "checks_unavailable",
  );
});

test("collector binds required check and event data to the exact remote PR head", async () => {
  const calls = [];
  const graph = {
    data: {
      repository: {
        pullRequest: {
          url: "https://github.com/example/project/pull/3",
          state: "OPEN",
          isDraft: false,
          headRefName: "topic",
          headRefOid: shaA,
          baseRefName: "main",
          reviewDecision: "APPROVED",
          mergeStateStatus: "CLEAN",
          mergeable: "MERGEABLE",
          statusCheckRollup: {
            contexts: {
              pageInfo: { hasNextPage: false },
              nodes: [
                {
                  __typename: "CheckRun",
                  name: "test",
                  isRequired: true,
                  status: "COMPLETED",
                  conclusion: "SUCCESS",
                  startedAt: "2026-10-10T00:00:00Z",
                  completedAt: "2026-10-10T00:01:00Z",
                  detailsUrl: "https://github.com/example/project/actions/runs/1",
                  checkSuite: { workflowRun: { event: "pull_request" } },
                },
              ],
            },
          },
        },
      },
    },
  };
  const runCommand = async (command, args) => {
    calls.push([command, args]);
    if (command === "git" && args[0] === "rev-parse") return { stdout: `${shaA}\n` };
    if (command === "git" && args[0] === "branch") return { stdout: "topic\n" };
    if (command === "git" && args[0] === "status") return { stdout: "" };
    if (command === "git" && args[0] === "for-each-ref")
      return { stdout: "origin\0refs/heads/topic\n" };
    if (command === "git" && args[0] === "ls-remote")
      return { stdout: `${shaA}\trefs/heads/topic\n` };
    if (command === "gh" && args[0] === "repo")
      return { stdout: '{"nameWithOwner":"example/project"}' };
    if (command === "gh" && args[0] === "pr")
      return { stdout: '{"number":3}' };
    if (command === "gh" && args[0] === "api")
      return { stdout: JSON.stringify(graph) };
    throw new Error(`Unexpected command ${command} ${args[0]}`);
  };
  const result = await inspectGitHubStatus({ cwd: "project", runCommand });
  assert.equal(result.status, "merge_ready");
  assert.equal(result.local_sha, shaA);
  assert.equal(result.remote_sha, shaA);
  assert.equal(result.pr.head_sha, shaA);
  assert.equal(result.required_check_count, 1);
  assert.equal(result.checks[0].event, "pull_request");
  assert.equal(result.checks[0].required, true);
  assert.ok(calls.some(([command, args]) => command === "gh" && args[0] === "api"));

  let shiftRemote = false;
  const changingRunCommand = async (command, args, options) => {
    if (command === "gh" && args[0] === "api") shiftRemote = true;
    if (command === "git" && args[0] === "ls-remote" && shiftRemote)
      return { stdout: `${shaB}\trefs/heads/topic\n` };
    return runCommand(command, args, options);
  };
  const changedDuringRead = await inspectGitHubStatus({
    cwd: "project",
    runCommand: changingRunCommand,
  });
  assert.equal(changedDuringRead.status, "target_changed_during_observation");
  assert.equal(changedDuringRead.remote_sha, shaB);
});

test("dirty local state short-circuits GitHub requests and cannot inherit old green checks", async () => {
  let githubCalls = 0;
  const runCommand = async (command, args) => {
    if (command === "git" && args[0] === "rev-parse") return { stdout: `${shaA}\n` };
    if (command === "git" && args[0] === "branch") return { stdout: "topic\n" };
    if (command === "git" && args[0] === "status") return { stdout: " M dashboard/app.mjs\n" };
    if (command === "git" && args[0] === "for-each-ref")
      return { stdout: "origin\0refs/heads/topic\n" };
    if (command === "git" && args[0] === "ls-remote")
      return { stdout: `${shaA}\trefs/heads/topic\n` };
    githubCalls += 1;
    throw new Error("GitHub must not be queried while local changes are unpushed");
  };
  const result = await inspectGitHubStatus({ cwd: "project", runCommand });
  assert.equal(result.status, "local_changes_unpushed");
  assert.equal(result.dirty, true);
  assert.equal(githubCalls, 0);
});

test("GitHub status endpoint is browser-authenticated and read-only", async (t) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "rdsh-github-status-"));
  const previousHome = process.env.RDSH_DASHBOARD_HOME;
  process.env.RDSH_DASHBOARD_HOME = path.join(temporary, "state");
  let dashboard;
  t.after(async () => {
    await dashboard?.close();
    if (previousHome === undefined) delete process.env.RDSH_DASHBOARD_HOME;
    else process.env.RDSH_DASHBOARD_HOME = previousHome;
    await fs.rm(temporary, { recursive: true, force: true });
  });

  const projectDirectory = path.join(temporary, "project");
  await fs.mkdir(projectDirectory);
  const project = await identity(projectDirectory);
  const reserve = net.createServer();
  await new Promise((resolve) => reserve.listen(0, "127.0.0.1", resolve));
  const port = reserve.address().port;
  await new Promise((resolve) => reserve.close(resolve));
  let inspected = 0;
  dashboard = await startDashboard({
    project,
    port,
    tailscale: false,
    githubStatusInspector: async ({ cwd }) => {
      inspected += 1;
      assert.equal(cwd, project.directory);
      return { ...readySnapshot(), observed_at: "2026-10-10T00:00:00Z", status: "merge_ready" };
    },
  });

  const endpoint = dashboard.localUrl + "api/github/status";
  assert.equal((await fetch(endpoint)).status, 401);
  const runtime = JSON.parse(
    await fs.readFile(path.join(project.directory, "runtime.json"), "utf8"),
  );
  assert.equal(
    (
      await fetch(endpoint, {
        headers: { authorization: `Bearer ${runtime.mcp_token}` },
      })
    ).status,
    401,
  );
  const token = new URL(dashboard.browserUrl).hash.slice(5);
  const response = await fetch(endpoint, {
    headers: { "x-rdsh-browser-token": token },
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, "merge_ready");
  assert.equal(inspected, 1);
  assert.equal(
    (
      await fetch(endpoint, {
        method: "POST",
        headers: { "x-rdsh-browser-token": token },
      })
    ).status,
    404,
  );
  assert.equal(inspected, 1);
});
