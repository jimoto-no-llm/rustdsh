import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_OUTPUT = 1024 * 1024;
const SHA = /^[0-9a-f]{40,64}$/i;
const REMOTE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;
const BRANCH_REF = /^refs\/heads\/[A-Za-z0-9._/-]+$/;
const GRAPHQL = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      url state isDraft headRefName headRefOid baseRefName reviewDecision
      mergeStateStatus mergeable
      statusCheckRollup {
        contexts(first: 100) {
          pageInfo { hasNextPage }
          nodes {
            __typename
            ... on CheckRun {
              name isRequired(pullRequestNumber: $number) status conclusion
              startedAt completedAt detailsUrl
              checkSuite { workflowRun { event } }
            }
            ... on StatusContext {
              context isRequired(pullRequestNumber: $number) state targetUrl createdAt
            }
          }
        }
      }
    }
  }
}`;

async function defaultCommand(command, args, options) {
  const executable =
    process.platform === "win32" && command === "gh" ? "gh.exe" : command;
  return execFileAsync(executable, args, {
    cwd: options.cwd,
    env: {
      ...process.env,
      GH_PROMPT_DISABLED: "1",
      GH_PAGER: "cat",
      PAGER: "cat",
    },
    windowsHide: true,
    timeout: 10000,
    maxBuffer: MAX_OUTPUT,
  });
}

async function output(runCommand, command, args, cwd) {
  const result = await runCommand(command, args, { cwd });
  return typeof result === "string" ? result : (result?.stdout ?? "");
}

function validSha(value) {
  const sha = String(value || "").trim();
  return SHA.test(sha) ? sha.toLowerCase() : null;
}

function safeHttps(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function normalizeCheck(context) {
  if (context?.__typename === "CheckRun") {
    return {
      kind: "check_run",
      name: String(context.name || "名前なし").slice(0, 200),
      required:
        typeof context.isRequired === "boolean" ? context.isRequired : null,
      status: String(context.status || "UNKNOWN").toUpperCase(),
      conclusion: context.conclusion
        ? String(context.conclusion).toUpperCase()
        : null,
      event: context.checkSuite?.workflowRun?.event
        ? String(context.checkSuite.workflowRun.event).slice(0, 80)
        : null,
      started_at: context.startedAt || null,
      completed_at: context.completedAt || null,
      url: safeHttps(context.detailsUrl),
    };
  }
  if (context?.__typename === "StatusContext") {
    return {
      kind: "status_context",
      name: String(context.context || "名前なし").slice(0, 200),
      required:
        typeof context.isRequired === "boolean" ? context.isRequired : null,
      status: String(context.state || "UNKNOWN").toUpperCase(),
      conclusion: String(context.state || "UNKNOWN").toUpperCase(),
      event: null,
      started_at: context.createdAt || null,
      completed_at: null,
      url: safeHttps(context.targetUrl),
    };
  }
  return null;
}

function requiredCheckFailure(check) {
  if (check.required !== true) return false;
  return ["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "STALE"].includes(
    check.conclusion,
  );
}

function requiredCheckPassed(check) {
  if (check.required !== true) return true;
  if (check.kind === "status_context") return check.status === "SUCCESS";
  return (
    check.status === "COMPLETED" &&
    ["SUCCESS", "NEUTRAL"].includes(check.conclusion)
  );
}

export function classifyGitHubStatus(snapshot) {
  if (!snapshot.local_sha) return "unavailable";
  if (!snapshot.upstream) return "push_not_confirmed";
  if (snapshot.remote_error) return "remote_unavailable";
  if (snapshot.target_changed_during_observation)
    return "target_changed_during_observation";
  if (!snapshot.remote_sha || snapshot.local_sha !== snapshot.remote_sha)
    return "push_not_confirmed";
  if (snapshot.dirty) return "local_changes_unpushed";
  if (snapshot.github_error) return "github_unavailable";
  if (snapshot.pr_error || !snapshot.pr) return "pr_unavailable";
  if (snapshot.pr.head_sha !== snapshot.remote_sha) return "pr_head_stale";
  if (!snapshot.checks_available || snapshot.checks_truncated)
    return "checks_unavailable";

  const checks = snapshot.checks || [];
  if (checks.some(requiredCheckFailure)) return "ci_failed";
  if (checks.some((check) => check.required === true && !requiredCheckPassed(check)))
    return "ci_pending";
  if (snapshot.pr.state !== "OPEN") return "pr_closed";
  if (snapshot.pr.is_draft) return "pr_draft";
  if (snapshot.pr.review_decision === "CHANGES_REQUESTED")
    return "review_changes_requested";
  if (snapshot.pr.review_decision === "REVIEW_REQUIRED")
    return "review_required";
  if (
    snapshot.pr.merge_state !== "CLEAN" ||
    snapshot.pr.mergeable !== "MERGEABLE"
  )
    return "merge_blocked";
  if (snapshot.pr.review_decision !== "APPROVED") return "review_unconfirmed";
  return "merge_ready";
}

function report(snapshot) {
  return {
    ...snapshot,
    checked_at: new Date().toISOString(),
    status: classifyGitHubStatus(snapshot),
    required_check_count: (snapshot.checks || []).filter(
      (check) => check.required === true,
    ).length,
  };
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error("Invalid GitHub response");
  }
}

function parseUpstream(value) {
  const [remote, ref] = String(value || "").split("\0");
  const name = (remote || "").trim();
  const branchRef = (ref || "").trim();
  if (!REMOTE.test(name) || name.startsWith("-") || !BRANCH_REF.test(branchRef))
    return null;
  return { remote: name, ref: branchRef };
}

function parseRepo(value) {
  const nameWithOwner = parseJson(value).nameWithOwner;
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(
    String(nameWithOwner || ""),
  );
  if (!match) throw new Error("GitHub repository unavailable");
  return { owner: match[1], name: match[2], name_with_owner: nameWithOwner };
}

function normalizePullRequest(value) {
  const pr = value?.data?.repository?.pullRequest;
  if (!pr) throw new Error("GitHub pull request unavailable");
  const connections = pr.statusCheckRollup?.contexts;
  const rawChecks = Array.isArray(connections?.nodes) ? connections.nodes : [];
  const checks = rawChecks.map(normalizeCheck).filter(Boolean);
  const checksAvailable =
    rawChecks.every((check) => {
      const normalized = normalizeCheck(check);
      return normalized && typeof normalized.required === "boolean";
    }) && !value.errors?.length;
  return {
    pr: {
      url: safeHttps(pr.url),
      state: String(pr.state || "UNKNOWN").toUpperCase(),
      is_draft: Boolean(pr.isDraft),
      head_ref: String(pr.headRefName || "").slice(0, 200),
      head_sha: validSha(pr.headRefOid),
      base_ref: String(pr.baseRefName || "").slice(0, 200),
      review_decision: pr.reviewDecision
        ? String(pr.reviewDecision).toUpperCase()
        : null,
      merge_state: pr.mergeStateStatus
        ? String(pr.mergeStateStatus).toUpperCase()
        : "UNKNOWN",
      mergeable: pr.mergeable ? String(pr.mergeable).toUpperCase() : "UNKNOWN",
    },
    checks,
    checks_available: checksAvailable,
    checks_truncated: Boolean(connections?.pageInfo?.hasNextPage),
  };
}

export async function inspectGitHubStatus({ cwd, runCommand = defaultCommand }) {
  const snapshot = {
    observed_at: new Date().toISOString(),
    local_sha: null,
    branch: null,
    dirty: null,
    upstream: null,
    remote_sha: null,
    remote_error: false,
    target_changed_during_observation: false,
    github_error: false,
    pr_error: false,
    pr: null,
    checks: [],
    checks_available: false,
    checks_truncated: false,
  };

  try {
    snapshot.local_sha = validSha(
      await output(runCommand, "git", ["rev-parse", "--verify", "HEAD"], cwd),
    );
    if (!snapshot.local_sha) return report(snapshot);
    snapshot.branch =
      (await output(runCommand, "git", ["branch", "--show-current"], cwd))
        .trim() || null;
    snapshot.dirty = Boolean(
      (
        await output(
          runCommand,
          "git",
          ["status", "--porcelain=v1", "--untracked-files=normal"],
          cwd,
        )
      ).trim(),
    );
    if (snapshot.branch) {
      const upstream = await output(
        runCommand,
        "git",
        [
          "for-each-ref",
          "--format=%(upstream:remotename)%00%(upstream:remoteref)",
          `refs/heads/${snapshot.branch}`,
        ],
        cwd,
      );
      snapshot.upstream = parseUpstream(upstream);
    }
  } catch {
    return report(snapshot);
  }

  if (!snapshot.upstream) return report(snapshot);
  try {
    const refs = await output(
      runCommand,
      "git",
      ["ls-remote", "--heads", snapshot.upstream.remote, snapshot.upstream.ref],
      cwd,
    );
    const [remoteSha] = refs.trim().split(/\s+/);
    snapshot.remote_sha = validSha(remoteSha);
    if (!snapshot.remote_sha) return report(snapshot);
  } catch {
    snapshot.remote_error = true;
    return report(snapshot);
  }
  if (snapshot.dirty || snapshot.local_sha !== snapshot.remote_sha)
    return report(snapshot);

  let repo;
  try {
    repo = parseRepo(
      await output(runCommand, "gh", ["repo", "view", "--json", "nameWithOwner"], cwd),
    );
  } catch {
    snapshot.github_error = true;
    return report(snapshot);
  }

  let number;
  try {
    const prResult = parseJson(
      await output(runCommand, "gh", ["pr", "view", "--json", "number"], cwd),
    );
    number = Number(prResult.number);
    if (!Number.isSafeInteger(number) || number < 1)
      throw new Error("GitHub pull request unavailable");
  } catch {
    snapshot.pr_error = true;
    return report(snapshot);
  }

  try {
    const graphql = parseJson(
      await output(
        runCommand,
        "gh",
        [
          "api",
          "graphql",
          "-F",
          `owner=${repo.owner}`,
          "-F",
          `name=${repo.name}`,
          "-F",
          `number=${number}`,
          "-f",
          `query=${GRAPHQL}`,
        ],
        cwd,
      ),
    );
    if (graphql.errors?.length) throw new Error("GitHub status unavailable");
    const latest = normalizePullRequest(graphql);
    snapshot.pr = { number, ...latest.pr };
    snapshot.checks = latest.checks;
    snapshot.checks_available = latest.checks_available;
    snapshot.checks_truncated = latest.checks_truncated;
  } catch {
    snapshot.github_error = true;
  }

  if (!snapshot.pr || snapshot.github_error) return report(snapshot);
  try {
    const latestSha = validSha(
      await output(runCommand, "git", ["rev-parse", "--verify", "HEAD"], cwd),
    );
    const latestBranch =
      (await output(runCommand, "git", ["branch", "--show-current"], cwd))
        .trim() || null;
    const latestDirty = Boolean(
      (
        await output(
          runCommand,
          "git",
          ["status", "--porcelain=v1", "--untracked-files=normal"],
          cwd,
        )
      ).trim(),
    );
    const latestUpstreamRaw = await output(
      runCommand,
      "git",
      [
        "for-each-ref",
        "--format=%(upstream:remotename)%00%(upstream:remoteref)",
        `refs/heads/${latestBranch || ""}`,
      ],
      cwd,
    );
    const latestUpstream = parseUpstream(latestUpstreamRaw);
    if (
      latestSha !== snapshot.local_sha ||
      latestBranch !== snapshot.branch ||
      latestDirty ||
      !latestUpstream ||
      latestUpstream.remote !== snapshot.upstream.remote ||
      latestUpstream.ref !== snapshot.upstream.ref
    ) {
      snapshot.local_sha = latestSha;
      snapshot.branch = latestBranch;
      snapshot.dirty = latestDirty;
      snapshot.target_changed_during_observation = true;
      return report(snapshot);
    }
    const latestRemoteText = await output(
      runCommand,
      "git",
      ["ls-remote", "--heads", latestUpstream.remote, latestUpstream.ref],
      cwd,
    );
    const [latestRemoteValue] = latestRemoteText.trim().split(/\s+/);
    const latestRemoteSha = validSha(latestRemoteValue);
    if (latestRemoteSha !== snapshot.remote_sha) {
      snapshot.remote_sha = latestRemoteSha;
      snapshot.target_changed_during_observation = true;
    }
  } catch {
    snapshot.remote_error = true;
  }
  return report(snapshot);
}
