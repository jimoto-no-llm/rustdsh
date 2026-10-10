import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ProjectStore, identity } from "../state.mjs";
import { ReviewEvidenceStore } from "../review-evidence.mjs";
import { WorkerWorkspaces } from "../workers.mjs";

const exec = promisify(execFile);
const git = async (cwd, ...args) =>
  (await exec("git", ["-C", cwd, ...args], { windowsHide: true })).stdout.trim();
const error = (code) => (value) => value.message === `Review evidence: ${code}`;

async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rdsh-review-evidence-"));
  const repo = path.join(root, "project");
  await fs.mkdir(path.join(repo, "src"), { recursive: true });
  await git(repo, "init", "-b", "review-fixture");
  await git(repo, "config", "user.name", "Review Evidence QA");
  await git(repo, "config", "user.email", "review@example.invalid");
  await git(repo, "config", "commit.gpgsign", "false");
  await fs.writeFile(path.join(repo, "src/app.txt"), "before\n");
  await git(repo, "add", ".");
  await git(repo, "commit", "-m", "base");
  const baseSha = await git(repo, "rev-parse", "HEAD");
  await fs.writeFile(path.join(repo, "src/app.txt"), "after\n");
  await git(repo, "add", ".");
  await git(repo, "commit", "-m", "target");
  const headSha = await git(repo, "rev-parse", "HEAD");
  const project = await identity(repo);
  project.directory = path.join(root, "state");
  const projectStore = await ProjectStore.open(project);
  await projectStore.mutate("task", {
    id: "change",
    title: "Review fixture change",
    status: "doing",
  });
  const workers = await WorkerWorkspaces.open(project);
  const prepare = async (worker_id, role, write_paths) => {
    const request = {
      worker_id,
      role,
      read_paths: ["."],
      write_paths,
      modules: ["src"],
      forbidden_paths: [],
      lease_seconds: 300,
    };
    const plan = await workers.plan(request);
    assert.equal(plan.can_prepare, true, JSON.stringify(plan.warnings));
    const result = await workers.prepare(request, {
      expectedRevision: plan.revision,
      expectedHead: plan.source.head_sha,
    });
    assert.equal(result.provisioning_error, null);
    assert.equal(result.worker.tree.head_sha, headSha);
    return result.worker;
  };
  const implementation = await prepare("implementer", "edit", ["src"]);
  const reviewer = await prepare("reviewer", "review", []);
  const inspection = await workers.inspect();
  const reviews = await ReviewEvidenceStore.open(project);
  const input = {
    review_id: "review-run-1",
    task_id: "change",
    implementation_worker_id: implementation.worker_id,
    reviewer_worker_id: reviewer.worker_id,
    base_sha: baseSha,
    head_sha: headSha,
    availability: "complete",
    findings: [],
    unverified: [],
    evidence_refs: [{ label: "target commit", reference: headSha }],
  };
  t.after(async () => {
    assert.ok(path.basename(root).startsWith("rdsh-review-evidence-"));
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, repo, project, projectStore, workers, inspection, reviews, input, baseSha, headSha };
}

test("review reports bind separate worker roles and an exact binary diff, then stale on task or source changes", async (t) => {
  const f = await setup(t);
  const stored = await f.reviews.record(f.input, {
    state: f.projectStore.value,
    workerInspection: f.inspection,
  });
  assert.equal(stored.idempotent, false);
  assert.equal(stored.report.reviewer_context.implementation_role, "edit");
  assert.equal(stored.report.reviewer_context.reviewer_role, "review");
  assert.deepEqual(stored.report.reviewer_context.reviewer_write_paths, []);
  assert.equal(stored.report.target.head_sha, f.headSha);
  const { stdout: patch } = await exec(
    "git",
    [
      "-C",
      f.repo,
      "diff",
      "--binary",
      "--full-index",
      "--no-color",
      "--no-ext-diff",
      "--no-textconv",
      "--no-renames",
      f.baseSha,
      f.headSha,
      "--",
    ],
    { windowsHide: true, encoding: "buffer" },
  );
  assert.equal(
    stored.report.target.diff_sha256,
    createHash("sha256").update(patch).digest("hex"),
  );
  assert.match(stored.report.report_digest, /^[0-9a-f]{64}$/);
  const idempotent = await f.reviews.record(f.input, {
    state: f.projectStore.value,
    workerInspection: f.inspection,
  });
  assert.equal(idempotent.idempotent, true);
  let listed = await f.reviews.list({ tasks: f.projectStore.value.tasks });
  assert.equal(listed.reports[0].review_status, "clear");
  assert.equal(
    listed.reports[0].completion_readiness,
    "caller_reported_clear_for_human_decision",
  );
  assert.doesNotMatch(JSON.stringify(listed), /approved|approval_granted/i);

  f.projectStore.value.tasks[0].updated_at = new Date(Date.now() + 1000).toISOString();
  listed = await f.reviews.list({ tasks: f.projectStore.value.tasks });
  assert.equal(listed.reports[0].review_status, "stale");
  assert.equal(listed.reports[0].freshness_reason, "task_changed_after_review");

  await fs.writeFile(path.join(f.repo, "src/app.txt"), "changed after review\n");
  await git(f.repo, "add", ".");
  await git(f.repo, "commit", "-m", "change source after review");
  listed = await f.reviews.list({ tasks: f.projectStore.value.tasks });
  assert.equal(listed.reports[0].freshness_reason, "task_changed_after_review");
  f.projectStore.value.tasks[0].updated_at = stored.report.task_updated_at;
  listed = await f.reviews.list({ tasks: f.projectStore.value.tasks });
  assert.equal(listed.reports[0].freshness_reason, "source_head_changed_after_review");

  const reopened = await ReviewEvidenceStore.open(f.project);
  assert.equal((await reopened.list({ tasks: f.projectStore.value.tasks })).reports.length, 1);
});

test("review evidence rejects self-review, writable reviewer, changed targets, and unsafe finding paths", async (t) => {
  const f = await setup(t);
  await assert.rejects(
    f.reviews.record(
      { ...f.input, reviewer_worker_id: f.input.implementation_worker_id },
      { state: f.projectStore.value, workerInspection: f.inspection },
    ),
    error("independent_workers_required"),
  );
  await assert.rejects(
    f.reviews.record(
      { ...f.input, head_sha: f.baseSha },
      { state: f.projectStore.value, workerInspection: f.inspection },
    ),
    error("workers_must_review_same_clean_target"),
  );
  await assert.rejects(
    f.reviews.record(
      {
        ...f.input,
        findings: [
          { severity: "major", title: "unsafe", detail: "path escape", path: "../secret" },
        ],
      },
      { state: f.projectStore.value, workerInspection: f.inspection },
    ),
    error("invalid_finding_path"),
  );
  const updated = await f.workers.inspect();
  updated.workers.find((worker) => worker.worker_id === "reviewer").declaration.write_paths = ["src"];
  await assert.rejects(
    f.reviews.record(f.input, { state: f.projectStore.value, workerInspection: updated }),
    error("active_read_only_review_worker_required"),
  );
});

test("unavailable reports remain unknown and duplicate IDs cannot replace evidence", async (t) => {
  const f = await setup(t);
  const unavailable = {
    ...f.input,
    availability: "unavailable",
    unverified: ["reviewer could not inspect the target"],
  };
  const result = await f.reviews.record(unavailable, {
    state: f.projectStore.value,
    workerInspection: f.inspection,
  });
  const listed = await f.reviews.list({ tasks: f.projectStore.value.tasks });
  assert.equal(listed.reports[0].review_status, "unavailable");
  assert.equal(listed.reports[0].completion_readiness, "unknown");
  await assert.rejects(
    f.reviews.record(
      { ...unavailable, unverified: ["different report"] },
      { state: f.projectStore.value, workerInspection: f.inspection },
    ),
    error("review_id_conflict"),
  );
  assert.equal(result.revision, 1);
});
