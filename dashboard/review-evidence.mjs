import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { repository, dirtyPaths, workerGit } from "./worker-git.mjs";
import { samePath } from "./worker-scopes.mjs";

const exec = promisify(execFile);
const maximumBytes = 16 * 1024 * 1024;
const maximumReports = 1000;
const exact = (value, keys) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join("|") === [...keys].sort().join("|");
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const sha = (value) => typeof value === "string" && /^[0-9a-f]{40,64}$/.test(value);
const fail = (code) => {
  throw new Error(`Review evidence: ${code}`);
};
const text = (value, label, maximum = 2000) => {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > maximum ||
    /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)
  )
    fail(`invalid_${label}`);
  return value.trim();
};
const timestamp = (value) =>
  typeof value === "string" &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;
const safeRelativePath = (value) => {
  const result = text(value, "finding_path", 512);
  if (
    result.includes("\\") ||
    path.posix.isAbsolute(result) ||
    result.split("/").some((part) => !part || part === "." || part === "..")
  )
    fail("invalid_finding_path");
  return result;
};
const digest = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

function normalizeInput(input) {
  if (
    !exact(input, [
      "review_id",
      "task_id",
      "implementation_worker_id",
      "reviewer_worker_id",
      "base_sha",
      "head_sha",
      "availability",
      "findings",
      "unverified",
      "evidence_refs",
    ])
  )
    fail("invalid_report_fields");
  const reviewId = text(input.review_id, "review_id", 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(reviewId))
    fail("invalid_review_id");
  if (!sha(input.base_sha) || !sha(input.head_sha)) fail("invalid_target_sha");
  if (!["complete", "partial", "unavailable"].includes(input.availability))
    fail("invalid_availability");
  if (!Array.isArray(input.findings) || input.findings.length > 100)
    fail("invalid_findings");
  const findings = input.findings.map((finding) => {
    if (
      !object(finding) ||
      Object.keys(finding).some(
        (key) => !["severity", "title", "detail", "path", "line"].includes(key),
      )
    )
      fail("invalid_finding_fields");
    const normalized = {
      severity: finding.severity,
      title: text(finding.title, "finding_title", 300),
      detail: text(finding.detail, "finding_detail", 4000),
    };
    if (!["critical", "major", "minor", "info"].includes(normalized.severity))
      fail("invalid_finding_severity");
    if (finding.path !== undefined)
      normalized.path = safeRelativePath(finding.path);
    if (finding.line !== undefined) {
      if (!Number.isSafeInteger(finding.line) || finding.line < 1)
        fail("invalid_finding_line");
      normalized.line = finding.line;
    }
    return normalized;
  });
  if (!Array.isArray(input.unverified) || input.unverified.length > 100)
    fail("invalid_unverified");
  const unverified = input.unverified.map((item) =>
    text(item, "unverified_item", 1000),
  );
  if (!Array.isArray(input.evidence_refs) || input.evidence_refs.length > 100)
    fail("invalid_evidence_refs");
  const evidenceRefs = input.evidence_refs.map((item) => {
    if (!exact(item, ["label", "reference"])) fail("invalid_evidence_ref");
    return {
      label: text(item.label, "evidence_label", 200),
      reference: text(item.reference, "evidence_reference", 1000),
    };
  });
  if (input.availability === "unavailable" && findings.length)
    fail("unavailable_review_cannot_claim_findings");
  if (input.availability === "unavailable" && !unverified.length)
    fail("unavailable_review_requires_reason");
  if (
    input.availability === "complete" &&
    unverified.length > 0 &&
    findings.length === 0
  )
    fail("incomplete_review_cannot_be_complete");
  return {
    review_id: reviewId,
    task_id: text(input.task_id, "task_id", 160),
    implementation_worker_id: text(
      input.implementation_worker_id,
      "implementation_worker_id",
      40,
    ),
    reviewer_worker_id: text(input.reviewer_worker_id, "reviewer_worker_id", 40),
    base_sha: input.base_sha,
    head_sha: input.head_sha,
    availability: input.availability,
    findings,
    unverified,
    evidence_refs: evidenceRefs,
  };
}

function gitEnvironment() {
  const keep = /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|TEMP|TMP|COMSPEC|HOME|USERPROFILE|LANG|LC_ALL)$/i;
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([key]) => keep.test(key)),
    ),
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
  };
}
async function diffDigest(root, base, head) {
  let result;
  try {
    result = await exec(
      "git",
      [
        "-C",
        root,
        "diff",
        "--binary",
        "--full-index",
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        "--no-renames",
        base,
        head,
        "--",
      ],
      {
        env: gitEnvironment(),
        windowsHide: true,
        shell: false,
        timeout: 30000,
        maxBuffer: 64 * 1024 * 1024,
        encoding: "buffer",
      },
    );
  } catch (error) {
    if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER")
      fail("diff_exceeds_64_mib_limit");
    fail("target_diff_unavailable");
  }
  return createHash("sha256").update(result.stdout).digest("hex");
}

function validateStoredReport(report, projectId) {
  if (
    !exact(report, [
      "review_id",
      "project_id",
      "task_id",
      "task_updated_at",
      "implementation_worker_id",
      "reviewer_worker_id",
      "target",
      "availability",
      "findings",
      "unverified",
      "evidence_refs",
      "reviewer_context",
      "report_digest",
      "created_at",
    ]) ||
    report.project_id !== projectId ||
    !timestamp(report.task_updated_at) ||
    !timestamp(report.created_at) ||
    !object(report.target) ||
    !exact(report.target, ["base_sha", "head_sha", "diff_sha256"]) ||
    !sha(report.target.base_sha) ||
    !sha(report.target.head_sha) ||
    !/^[0-9a-f]{64}$/.test(report.target.diff_sha256) ||
    !/^[0-9a-f]{64}$/.test(report.report_digest) ||
    !object(report.reviewer_context) ||
    !exact(report.reviewer_context, [
      "implementation_role",
      "reviewer_role",
      "reviewer_write_paths",
      "distinct_worktree",
    ]) ||
    report.reviewer_context.implementation_role !== "edit" ||
    report.reviewer_context.reviewer_role !== "review" ||
    report.reviewer_context.distinct_worktree !== true ||
    !Array.isArray(report.reviewer_context.reviewer_write_paths) ||
    report.reviewer_context.reviewer_write_paths.length !== 0
  )
    fail("stored_report_invalid");
  const input = normalizeInput({
    review_id: report.review_id,
    task_id: report.task_id,
    implementation_worker_id: report.implementation_worker_id,
    reviewer_worker_id: report.reviewer_worker_id,
    base_sha: report.target.base_sha,
    head_sha: report.target.head_sha,
    availability: report.availability,
    findings: report.findings,
    unverified: report.unverified,
    evidence_refs: report.evidence_refs,
  });
  const payload = {
    ...input,
    project_id: report.project_id,
    task_updated_at: report.task_updated_at,
    target: report.target,
    reviewer_context: report.reviewer_context,
  };
  if (digest(payload) !== report.report_digest) fail("stored_report_digest_mismatch");
  return report;
}

export class ReviewEvidenceStore {
  constructor(project, { now = Date.now } = {}) {
    this.project = { ...project };
    this.now = now;
    this.file = path.join(project.directory, "review-evidence.json");
    this.lock = path.join(project.directory, "review-evidence.lock");
  }
  static async open(project, options) {
    const store = new ReviewEvidenceStore(project, options);
    await store.read();
    return store;
  }
  empty() {
    return { schema: 1, project_id: this.project.id, revision: 0, reports: [] };
  }
  async read() {
    let handle;
    let present = false;
    try {
      const before = await fs.lstat(this.file);
      present = true;
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > maximumBytes)
        fail("file_unobservable");
      handle = await fs.open(
        this.file,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
      const opened = await handle.stat();
      if (!opened.isFile() || opened.nlink !== 1 || opened.size > maximumBytes || opened.dev !== before.dev || opened.ino !== before.ino)
        fail("file_changed_during_read");
      const bytes = await handle.readFile();
      if (bytes.length > maximumBytes) fail("file_too_large");
      const document = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      if (
        !exact(document, ["schema", "project_id", "revision", "reports"]) ||
        document.schema !== 1 ||
        document.project_id !== this.project.id ||
        !Number.isSafeInteger(document.revision) ||
        document.revision < 0 ||
        !Array.isArray(document.reports) ||
        document.reports.length > maximumReports
      )
        fail("document_invalid");
      for (const report of document.reports) validateStoredReport(report, this.project.id);
      if (new Set(document.reports.map((r) => r.review_id)).size !== document.reports.length)
        fail("duplicate_review_id");
      return document;
    } catch (error) {
      if (error.code === "ENOENT" && !present) return this.empty();
      if (error.message?.startsWith("Review evidence:")) throw error;
      fail("file_unreadable");
    } finally {
      await handle?.close();
    }
  }
  async write(document) {
    const bytes = Buffer.from(JSON.stringify(document, null, 2) + "\n");
    if (bytes.length > maximumBytes) fail("file_too_large");
    await fs.mkdir(this.project.directory, { recursive: true, mode: 0o700 });
    if (!samePath(await fs.realpath(this.project.directory), this.project.directory))
      fail("storage_identity_changed");
    const temporary = path.join(this.project.directory, `review-evidence-${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await fs.open(temporary, "wx", 0o600);
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      handle = null;
      await fs.rename(temporary, this.file);
      if (process.platform !== "win32") {
        const parent = await fs.open(this.project.directory, "r");
        try {
          await parent.sync();
        } finally {
          await parent.close();
        }
      }
    } finally {
      await handle?.close();
      await fs.unlink(temporary).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  }
  async record(input, { state, workerInspection }) {
    const normalized = normalizeInput(input);
    const task = state.tasks.find((candidate) => candidate.id === normalized.task_id);
    if (!task) fail("task_not_found");
    if (!timestamp(task.updated_at)) fail("task_revision_unavailable");
    if (!workerInspection || workerInspection.project_id !== this.project.id)
      fail("worker_registry_unavailable");
    const implementation = workerInspection.workers.find(
      (worker) => worker.worker_id === normalized.implementation_worker_id,
    );
    const reviewer = workerInspection.workers.find(
      (worker) => worker.worker_id === normalized.reviewer_worker_id,
    );
    if (!implementation || !reviewer || implementation.worker_id === reviewer.worker_id)
      fail("independent_workers_required");
    if (
      implementation.state !== "ready" ||
      implementation.lease?.state !== "active" ||
      implementation.role !== "edit" ||
      reviewer.state !== "ready" ||
      reviewer.lease?.state !== "active" ||
      reviewer.role !== "review" ||
      reviewer.declaration?.write_paths?.length !== 0
    )
      fail("active_read_only_review_worker_required");
    if (
      implementation.worktree === reviewer.worktree ||
      implementation.branch === reviewer.branch ||
      implementation.tree?.status !== "observed" ||
      reviewer.tree?.status !== "observed" ||
      implementation.tree.dirty !== false ||
      reviewer.tree.dirty !== false ||
      implementation.tree.head_sha !== normalized.head_sha ||
      reviewer.tree.head_sha !== normalized.head_sha
    )
      fail("workers_must_review_same_clean_target");
    if (
      !workerInspection.source ||
      workerInspection.source.head_sha !== normalized.head_sha ||
      workerInspection.source.dirty_paths?.length !== 0
    )
      fail("source_target_changed_or_dirty");
    try {
      await workerGit(this.project.root, "merge-base", "--is-ancestor", normalized.base_sha, normalized.head_sha);
    } catch {
      fail("base_is_not_ancestor_of_target");
    }
    const diffSha = await diffDigest(this.project.root, normalized.base_sha, normalized.head_sha);
    const target = {
      base_sha: normalized.base_sha,
      head_sha: normalized.head_sha,
      diff_sha256: diffSha,
    };
    const { base_sha: _baseSha, head_sha: _headSha, ...reportFields } = normalized;
    const reviewerContext = {
      implementation_role: "edit",
      reviewer_role: "review",
      reviewer_write_paths: [],
      distinct_worktree: true,
    };
    const digestPayload = {
      ...normalized,
      project_id: this.project.id,
      task_updated_at: task.updated_at,
      target,
      reviewer_context: reviewerContext,
    };
    const body = {
      ...reportFields,
      project_id: this.project.id,
      task_updated_at: task.updated_at,
      target,
      reviewer_context: reviewerContext,
    };
    const reportDigest = digest(digestPayload);
    const report = {
      ...body,
      report_digest: reportDigest,
      created_at: new Date(this.now()).toISOString(),
    };
    let lock;
    try {
      lock = await fs.open(this.lock, "wx", 0o600);
    } catch (error) {
      fail(error.code === "EEXIST" ? "writer_busy" : "write_failed");
    }
    try {
      const document = await this.read();
      const previous = document.reports.find((item) => item.review_id === report.review_id);
      if (previous) {
        if (previous.report_digest !== reportDigest) fail("review_id_conflict");
        return { revision: document.revision, report: previous, idempotent: true };
      }
      if (document.reports.length >= maximumReports) fail("report_limit_reached");
      document.reports.push(report);
      document.revision++;
      await this.write(document);
      return { revision: document.revision, report, idempotent: false };
    } finally {
      await lock.close();
      await fs.unlink(this.lock);
    }
  }
  async list({ tasks = [], current = null, taskId = null } = {}) {
    const document = await this.read();
    let snapshot = current;
    if (document.reports.length && snapshot === null) {
      try {
        const source = await repository(this.project.root);
        snapshot = { head_sha: source.head_sha, dirty_paths: await dirtyPaths(this.project.root) };
      } catch {
        snapshot = { head_sha: null, dirty_paths: null };
      }
    }
    const reports = document.reports
      .filter((report) => taskId === null || report.task_id === taskId)
      .map((report) => {
        const task = tasks.find((candidate) => candidate.id === report.task_id);
        let freshness = "unknown";
        let freshness_reason = "current_target_unavailable";
        if (!task) freshness_reason = "task_not_found";
        else if (!snapshot || !snapshot.head_sha || !Array.isArray(snapshot.dirty_paths))
          freshness_reason = "current_target_unavailable";
        else if (task.updated_at !== report.task_updated_at) {
          freshness = "stale";
          freshness_reason = "task_changed_after_review";
        } else if (snapshot.head_sha !== report.target.head_sha) {
          freshness = "stale";
          freshness_reason = "source_head_changed_after_review";
        } else if (snapshot.dirty_paths.length > 0) {
          freshness = "stale";
          freshness_reason = "source_has_uncommitted_changes";
        } else {
          freshness = "current";
          freshness_reason = null;
        }
        let review_status;
        if (freshness !== "current") review_status = freshness === "stale" ? "stale" : "unknown";
        else if (report.availability === "unavailable") review_status = "unavailable";
        else if (report.findings.length) review_status = "findings";
        else if (report.availability !== "complete" || report.unverified.length)
          review_status = "partial";
        else review_status = "clear";
        return {
          ...report,
          freshness,
          freshness_reason,
          review_status,
          completion_readiness:
            review_status === "clear"
              ? "caller_reported_clear_for_human_decision"
              : review_status === "findings"
                ? "caller_reported_findings_for_human_decision"
                : "unknown",
        };
      })
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
    return { revision: document.revision, reports };
  }
}
