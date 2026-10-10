// Local operator CLI. Registration cannot dispatch commands or publish changes.
import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ProjectStore } from "./state.mjs";
import { AcceptanceStore } from "./acceptance.mjs";
import { checksum, relativeInput } from "./acceptance-target.mjs";
import {
  IntegrationError,
  check,
  sha,
  samePath,
  within,
  git,
  canonicalFuture,
  repository,
  clean,
  ancestor,
} from "./integration-git.mjs";

const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const exact = (v, keys) =>
  object(v) && Object.keys(v).sort().join("|") === [...keys].sort().join("|");
const revision = (v) => Number.isSafeInteger(v) && v >= 0;
const text = (v, max = 1000) =>
  typeof v === "string" &&
  v.length > 0 &&
  v.length <= max &&
  !/[\x00-\x1f\x7f]/.test(v);
const uuid = (v) =>
  typeof v === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);
const time = (v) =>
  typeof v === "string" &&
  Number.isFinite(Date.parse(v)) &&
  new Date(v).toISOString() === v;
const limit = 2 * 1024 * 1024;
function checks(input) {
  check(
    Array.isArray(input) && input.length > 0 && input.length <= 20,
    "full_checks_required",
  );
  const ids = new Set();
  for (const item of input) {
    check(
      exact(item, ["id", "description", "inputs", "argv", "timeout_ms"]) &&
        /^[a-z][a-z0-9-]{0,39}$/.test(item.id) &&
        !ids.has(item.id) &&
        text(item.description) &&
        Array.isArray(item.inputs) &&
        item.inputs.length > 0 &&
        item.inputs.length <= 1000 &&
        item.inputs.every(relativeInput) &&
        new Set(item.inputs).size === item.inputs.length &&
        Array.isArray(item.argv) &&
        item.argv.length > 0 &&
        item.argv.length <= 64 &&
        item.argv.every(
          (arg) =>
            typeof arg === "string" &&
            arg.length > 0 &&
            arg.length <= 65536 &&
            !arg.includes("\0"),
        ) &&
        path.isAbsolute(item.argv[0]) &&
        Number.isSafeInteger(item.timeout_ms) &&
        item.timeout_ms >= 500 &&
        item.timeout_ms <= 600000,
      "invalid_full_check",
    );
    ids.add(item.id);
  }
  return structuredClone(input);
}
export class IntegrationQueue {
  constructor(project, source, directory) {
    this.project = { ...project, root: source.root };
    this.source = source;
    this.directory = directory;
    this.file = path.join(directory, "registry.json");
    this.lock = path.join(directory, "registry.lock");
    this.worktree = path.join(directory, "worktree");
    this.hooks = path.join(directory, "empty-hooks");
  }
  static async open(project) {
    check(
      object(project) &&
        /^[0-9a-f]{16}$/.test(project.id) &&
        path.isAbsolute(project.root) &&
        path.isAbsolute(project.directory),
      "invalid_project",
    );
    const source = await repository(project.root);
    const directory = await canonicalFuture(
      path.join(project.directory, "integration"),
    );
    check(
      !within(source.root, directory) && !within(source.common, directory),
      "integration_storage_must_be_outside_project",
    );
    const store = new IntegrationQueue(project, source, directory);
    await store.read();
    return store;
  }
  empty() {
    return {
      schema: 1,
      project_id: this.project.id,
      root: this.source.root,
      git_common_dir: this.source.common,
      revision: 0,
      queue: null,
    };
  }
  verify(state) {
    check(
      exact(state, [
        "schema",
        "project_id",
        "root",
        "git_common_dir",
        "revision",
        "queue",
      ]) &&
        state.schema === 1 &&
        state.project_id === this.project.id &&
        state.root === this.source.root &&
        state.git_common_dir === this.source.common &&
        revision(state.revision),
      "invalid_integration_registry",
    );
    const q = state.queue;
    if (q === null) return state;
    check(
      exact(q, [
        "id",
        "base_sha",
        "target_sha",
        "branch",
        "worktree",
        "state",
        "checks",
        "created_at",
        "requires_validation",
        "entries",
        "attempts",
      ]) &&
        uuid(q.id) &&
        sha(q.base_sha) &&
        sha(q.target_sha) &&
        q.branch === "codex/integration-" + q.id &&
        q.worktree === this.worktree &&
        ["provisioning", "ready", "provision_failed"].includes(q.state) &&
        time(q.created_at) &&
        typeof q.requires_validation === "boolean" &&
        Array.isArray(q.entries) &&
        q.entries.length <= 256 &&
        Array.isArray(q.attempts) &&
        q.attempts.length <= 256,
      "invalid_integration_queue",
    );
    checks(q.checks);
    check(
      q.requires_validation ||
        (q.target_sha === q.base_sha &&
          !q.entries.some((e) => e.state === "integrated")),
      "invalid_integration_validation_gate",
    );
    const heads = new Set();
    for (const [index, entry] of q.entries.entries()) {
      check(
        exact(entry, [
          "sequence",
          "label",
          "source_base_sha",
          "source_head_sha",
          "state",
          "target_before",
          "target_after",
          "reason",
          "conflicts",
        ]) &&
          entry.sequence === index + 1 &&
          text(entry.label, 120) &&
          sha(entry.source_base_sha) &&
          sha(entry.source_head_sha) &&
          !heads.has(entry.source_head_sha) &&
          [
            "queued",
            "applying",
            "integrated",
            "conflict",
            "unconfirmed",
            "rejected",
          ].includes(entry.state) &&
          (entry.target_before === null || sha(entry.target_before)) &&
          (entry.target_after === null || sha(entry.target_after)) &&
          (entry.reason === null || text(entry.reason)) &&
          Array.isArray(entry.conflicts) &&
          entry.conflicts.length <= 1000 &&
          entry.conflicts.every((v) => text(v)),
        "invalid_integration_entry",
      );
      check(
        entry.state !== "integrated" ||
          (sha(entry.target_before) &&
            sha(entry.target_after) &&
            entry.reason === null),
        "invalid_integration_result",
      );
      heads.add(entry.source_head_sha);
    }
    for (const attempt of q.attempts) {
      check(
        exact(attempt, [
          "id",
          "target_sha",
          "phase",
          "status",
          "reason",
          "results",
        ]) &&
          uuid(attempt.id) &&
          sha(attempt.target_sha) &&
          ["running", "finished"].includes(attempt.phase) &&
          ["unconfirmed", "passed", "failed", "blocked"].includes(
            attempt.status,
          ) &&
          (attempt.reason === null || text(attempt.reason)) &&
          Array.isArray(attempt.results) &&
          attempt.results.length <= q.checks.length,
        "invalid_validation_attempt",
      );
      for (const [index, r] of attempt.results.entries())
        check(
          exact(r, [
            "check_id",
            "evidence_id",
            "status",
            "exit_code",
            "reason",
          ]) &&
            r.check_id === q.checks[index].id &&
            /^evi_[0-9a-f-]{36}$/.test(r.evidence_id) &&
            ["pass", "fail", "blocked", "not-run"].includes(r.status) &&
            (r.exit_code === null || Number.isSafeInteger(r.exit_code)) &&
            (r.reason === null || text(r.reason)),
          "invalid_validation_result",
        );
      check(
        attempt.status !== "passed" ||
          (attempt.phase === "finished" &&
            attempt.results.length === q.checks.length &&
            attempt.results.every(
              (r) => r.status === "pass" && r.exit_code === 0,
            )),
        "invalid_validation_pass",
      );
    }
    return state;
  }
  async read() {
    let handle,
      present = false;
    try {
      const before = await fs.lstat(this.file);
      present = true;
      check(
        before.isFile() && before.nlink === 1 && before.size <= limit,
        "integration_registry_unobservable",
      );
      handle = await fs.open(
        this.file,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
      const opened = await handle.stat();
      check(
        opened.isFile() &&
          opened.nlink === 1 &&
          opened.size <= limit &&
          opened.dev === before.dev &&
          opened.ino === before.ino,
        "integration_registry_unobservable",
      );
      const bytes = await handle.readFile();
      check(bytes.length <= limit, "integration_registry_too_large");
      return this.verify(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
      );
    } catch (error) {
      if (error.code === "ENOENT" && !present) return this.empty();
      if (error instanceof IntegrationError) throw error;
      throw new IntegrationError("integration_registry_unreadable");
    } finally {
      await handle?.close();
    }
  }
  async save(state) {
    state.revision++;
    this.verify(state);
    const bytes = JSON.stringify(state, null, 2) + "\n";
    check(Buffer.byteLength(bytes) <= limit, "integration_registry_too_large");
    const temp = path.join(this.directory, randomUUID() + ".tmp");
    let handle;
    try {
      handle = await fs.open(temp, "wx", 0o600);
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      handle = null;
      await fs.rename(temp, this.file);
      if (process.platform !== "win32") {
        const parent = await fs.open(this.directory, "r");
        try {
          await parent.sync();
        } finally {
          await parent.close();
        }
      }
    } finally {
      await handle?.close();
      await fs.unlink(temp).catch((e) => {
        if (e.code !== "ENOENT") throw e;
      });
    }
  }
  async mutate(expectedRevision, operation) {
    check(revision(expectedRevision), "expected_revision_required");
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    check(
      samePath(await fs.realpath(this.directory), this.directory),
      "integration_storage_identity_changed",
    );
    let handle;
    try {
      handle = await fs.open(this.lock, "wx", 0o600);
    } catch (e) {
      throw new IntegrationError(
        e.code === "EEXIST"
          ? "integration_queue_busy"
          : "integration_lock_failed",
      );
    }
    try {
      const state = await this.read();
      check(
        state.revision === expectedRevision,
        "integration_revision_changed",
      );
      return await operation(state);
    } finally {
      await handle.close();
      await fs.unlink(this.lock);
    }
  }
  queue(state) {
    check(state.queue?.state === "ready", "integration_checkout_not_ready");
    return state.queue;
  }
  validationProject(q) {
    return {
      id: this.project.id,
      name: "Integration queue",
      root: q.worktree,
      directory: path.join(this.directory, "verification"),
    };
  }
  async target(q) {
    try {
      const info = await repository(q.worktree);
      check(
        samePath(info.common, this.source.common) &&
          samePath(info.root, q.worktree) &&
          info.branch === q.branch,
        "integration_checkout_identity_changed",
      );
      return {
        status: "observed",
        head_sha: info.head,
        clean: await clean(q.worktree),
        reason: null,
      };
    } catch (e) {
      return {
        status: "unavailable",
        head_sha: null,
        clean: null,
        reason:
          e instanceof IntegrationError
            ? e.code
            : "integration_checkout_unavailable",
      };
    }
  }
  async guardedTarget(q, expectedHead) {
    check(sha(expectedHead), "expected_head_required");
    const target = await this.target(q);
    check(
      target.status === "observed" && target.clean,
      "integration_checkout_dirty_or_unavailable",
    );
    check(
      target.head_sha === expectedHead && q.target_sha === expectedHead,
      "integration_target_changed",
    );
    return target;
  }
  async verification(q, target) {
    const result = {
      verified: false,
      status: "not-run",
      reason: "full_validation_required",
      retryable: false,
      checks: [],
    };
    const attempt = q.attempts.at(-1);
    if (!attempt) {
      result.retryable =
        target.clean === true && target.head_sha === q.target_sha;
      return result;
    }
    if (attempt.phase !== "finished")
      return {
        ...result,
        status: "unconfirmed",
        reason: "validation_outcome_unconfirmed",
      };
    if (
      target.status !== "observed" ||
      !target.clean ||
      target.head_sha !== q.target_sha ||
      attempt.target_sha !== target.head_sha
    )
      return {
        ...result,
        status: "stale",
        reason: "validation_target_changed_or_unavailable",
      };
    try {
      const store = await AcceptanceStore.open(this.validationProject(q)),
        report = await store.inspect("integration");
      result.checks = q.checks.map((c, index) => {
        const condition = report.conditions.find(
            (row) => row.criterion.id === c.id,
          ),
          record = condition?.full_result;
        const eligible = Boolean(
          record?.eligible_pass &&
            record.evidence_id === attempt.results[index]?.evidence_id &&
            checksum(condition.criterion) ===
              checksum({
                id: c.id,
                description: c.description,
                inputs: [...c.inputs].sort(),
              }) &&
            record.command?.executable === c.argv[0] &&
            record.command?.arguments_digest === checksum(c.argv.slice(1)) &&
            record.target.head_sha === q.target_sha,
        );
        return {
          id: c.id,
          status: record?.status ?? "not-run",
          verified: eligible,
          reason: record?.reason ?? record?.freshness?.reason ?? null,
          evidence_id: record?.evidence_id ?? null,
        };
      });
      result.verified =
        attempt.status === "passed" && result.checks.every((c) => c.verified);
      result.status = result.verified
        ? "passed"
        : attempt.status === "failed"
          ? "failed"
          : "blocked";
      result.reason = result.verified
        ? null
        : (attempt.reason ?? "full_validation_evidence_not_current");
      result.retryable = true;
    } catch {
      result.status = "blocked";
      result.reason = "validation_evidence_unavailable";
    }
    return result;
  }
  async describe(state) {
    if (!state.queue)
      return {
        revision: state.revision,
        queue: null,
        publish_authority: false,
      };
    const q = state.queue,
      target = await this.target(q),
      validation = await this.verification(q, target);
    const next = q.entries.find(
      (e) => !["integrated", "rejected"].includes(e.state),
    );
    return {
      revision: state.revision,
      queue: structuredClone(q),
      target,
      validation,
      next_sequence: next?.sequence ?? null,
      next_integration: next
        ? {
            sequence: next.sequence,
            state: next.state,
            reason: next.reason,
            retryable:
              q.attempts.at(-1)?.phase !== "running" &&
              ["queued", "conflict"].includes(next.state) &&
              target.clean === true &&
              target.head_sha === q.target_sha &&
              (!q.requires_validation || validation.verified),
          }
        : null,
      can_apply:
        q.state === "ready" &&
        q.attempts.at(-1)?.phase !== "running" &&
        target.clean === true &&
        target.head_sha === q.target_sha &&
        Boolean(next && ["queued", "conflict"].includes(next.state)) &&
        (!q.requires_validation || validation.verified),
      ready_for_review:
        q.entries.length > 0 &&
        q.entries.every((e) => e.state === "integrated") &&
        validation.verified,
      publish_authority: false,
      human_review: "not_assessed",
      production_adoption: "not_assessed",
    };
  }
  async inspect() {
    return this.describe(await this.read());
  }
  async init(input, { expectedRevision, expectedHead } = {}) {
    check(exact(input, ["checks"]), "invalid_queue_definition");
    const suite = checks(input.checks);
    return this.mutate(expectedRevision, async (state) => {
      check(state.queue === null, "integration_queue_already_exists");
      check(
        sha(expectedHead) &&
          (await repository(this.source.root)).head === expectedHead,
        "source_head_changed",
      );
      const id = randomUUID();
      const q = (state.queue = {
        id,
        base_sha: expectedHead,
        target_sha: expectedHead,
        branch: "codex/integration-" + id,
        worktree: this.worktree,
        state: "provisioning",
        checks: suite,
        created_at: new Date().toISOString(),
        requires_validation: false,
        entries: [],
        attempts: [],
      });
      await this.save(state);
      try {
        await fs.mkdir(this.hooks, { mode: 0o700 });
        await git(
          this.source.root,
          "-c",
          "core.hooksPath=" + this.hooks,
          "worktree",
          "add",
          "--no-guess-remote",
          "-b",
          q.branch,
          q.worktree,
          expectedHead,
        );
        const project = this.validationProject(q);
        await (
          await ProjectStore.open(project)
        ).mutate("task", {
          id: "integration",
          title: "All declared integration checks",
          status: "doing",
        });
        await (
          await AcceptanceStore.open(project)
        ).define(
          "integration",
          suite.map(({ id, description, inputs }) => ({
            id,
            description,
            inputs,
          })),
        );
        q.state = "ready";
      } catch {
        q.state = "provision_failed";
      }
      await this.save(state);
      return this.describe(state);
    });
  }
  async enqueue(input, expectedRevision) {
    check(
      exact(input, ["label", "source_base_sha", "source_head_sha"]) &&
        text(input.label, 120) &&
        sha(input.source_base_sha) &&
        sha(input.source_head_sha),
      "invalid_integration_source",
    );
    return this.mutate(expectedRevision, async (state) => {
      const q = this.queue(state);
      check(
        q.entries.length < 256 &&
          !q.entries.some((e) => e.source_head_sha === input.source_head_sha),
        "duplicate_or_full_queue",
      );
      for (const ref of [input.source_base_sha, input.source_head_sha])
        check(
          (
            await git(
              this.source.root,
              "rev-parse",
              "--verify",
              ref + "^{commit}",
            )
          ).trim() === ref,
          "exact_commit_required",
        );
      check(
        (await ancestor(
          this.source.root,
          input.source_base_sha,
          input.source_head_sha,
        )) &&
          (await ancestor(
            this.source.root,
            input.source_base_sha,
            q.target_sha,
          )) &&
          !(await ancestor(
            this.source.root,
            input.source_head_sha,
            q.target_sha,
          )),
        "source_range_not_applicable",
      );
      q.entries.push({
        sequence: q.entries.length + 1,
        ...input,
        state: "queued",
        target_before: null,
        target_after: null,
        reason: null,
        conflicts: [],
      });
      await this.save(state);
      return this.describe(state);
    });
  }
  async apply({ expectedRevision, expectedHead } = {}) {
    return this.mutate(expectedRevision, async (state) => {
      const q = this.queue(state),
        target = await this.guardedTarget(q, expectedHead);
      check(
        q.attempts.at(-1)?.phase !== "running",
        "interrupted_operation_requires_inspection",
      );
      check(
        !q.requires_validation || (await this.verification(q, target)).verified,
        "previous_integration_validation_required",
      );
      const entry = q.entries.find(
        (e) => !["integrated", "rejected"].includes(e.state),
      );
      check(
        entry && ["queued", "conflict"].includes(entry.state),
        "next_integration_not_retryable",
      );
      entry.state = "applying";
      entry.target_before = q.target_sha;
      entry.reason = "integration_outcome_unconfirmed";
      entry.conflicts = [];
      await this.save(state);
      let tree;
      try {
        tree = (
          await git(
            q.worktree,
            "merge-tree",
            "--write-tree",
            "--name-only",
            "-z",
            q.target_sha,
            entry.source_head_sha,
          )
        )
          .split("\0")[0]
          .trim();
      } catch (e) {
        entry.state = e.code === 1 ? "conflict" : "unconfirmed";
        entry.reason =
          e.code === 1
            ? "source_merge_conflict"
            : "merge_tree_outcome_unconfirmed";
        if (e.code === 1)
          entry.conflicts = (e.stdout ?? "")
            .split("\0")
            .slice(1)
            .filter((v, i, all) => text(v) && all.slice(0, i).every(Boolean))
            .slice(0, 1000);
      }
      if (tree)
        try {
          check(sha(tree), "integration_tree_unavailable");
          await this.guardedTarget(q, expectedHead);
          const commit = (
            await git(
              q.worktree,
              "-c",
              "commit.gpgsign=false",
              "commit-tree",
              tree,
              "-p",
              q.target_sha,
              "-p",
              entry.source_head_sha,
              "-m",
              `Integration ${entry.sequence}: ${entry.label}`,
            )
          ).trim();
          check(sha(commit), "integration_commit_unavailable");
          await this.guardedTarget(q, expectedHead);
          await git(
            q.worktree,
            "-c",
            "core.hooksPath=" + this.hooks,
            "merge",
            "--ff-only",
            "--no-overwrite-ignore",
            "--no-edit",
            commit,
          );
          const after = await this.target(q);
          check(
            after.clean && after.head_sha === commit,
            "integration_checkout_changed_during_apply",
          );
          entry.state = "integrated";
          entry.target_after = commit;
          entry.reason = null;
          q.target_sha = commit;
          q.requires_validation = true;
        } catch {
          entry.state = "unconfirmed";
          entry.reason = "integration_outcome_unconfirmed";
        }
      await this.save(state);
      return this.describe(state);
    });
  }
  async validate({ expectedRevision, expectedHead } = {}) {
    return this.mutate(expectedRevision, async (state) => {
      const q = this.queue(state);
      await this.guardedTarget(q, expectedHead);
      check(
        !q.entries.some((e) => ["applying", "unconfirmed"].includes(e.state)) &&
          q.attempts.at(-1)?.phase !== "running",
        "interrupted_operation_requires_inspection",
      );
      check(q.attempts.length < 256, "validation_history_full");
      const attempt = {
        id: randomUUID(),
        target_sha: q.target_sha,
        phase: "running",
        status: "unconfirmed",
        reason: "validation_outcome_unconfirmed",
        results: [],
      };
      q.attempts.push(attempt);
      await this.save(state);
      let dispatching = false;
      try {
        const store = await AcceptanceStore.open(this.validationProject(q));
        for (const c of q.checks) {
          await this.guardedTarget(q, expectedHead);
          dispatching = true;
          const r = await store.perform({
            task_id: "integration",
            criterion_id: c.id,
            scope: "full",
            argv: c.argv,
            timeout_ms: c.timeout_ms,
          });
          dispatching = false;
          attempt.results.push({
            check_id: c.id,
            evidence_id: r.evidence_id,
            status: r.status,
            exit_code: r.exit_code,
            reason: r.reason,
          });
          await this.save(state);
        }
        await this.guardedTarget(q, expectedHead);
        attempt.status = attempt.results.every((r) => r.status === "pass")
          ? "passed"
          : attempt.results.some((r) => r.status === "fail")
            ? "failed"
            : "blocked";
        attempt.reason =
          attempt.status === "passed"
            ? null
            : "declared_full_checks_did_not_pass";
      } catch {
        attempt.status = dispatching ? "unconfirmed" : "blocked";
        attempt.reason = "validation_target_or_execution_unconfirmed";
      }
      attempt.phase = dispatching ? "running" : "finished";
      await this.save(state);
      return this.describe(state);
    });
  }
  async retarget({ expectedRevision, expectedHead } = {}) {
    return this.mutate(expectedRevision, async (state) => {
      const q = this.queue(state),
        target = await this.target(q);
      check(
        sha(expectedHead) &&
          target.clean &&
          target.head_sha === expectedHead &&
          (await ancestor(q.worktree, q.target_sha, expectedHead)),
        "retarget_requires_clean_descendant",
      );
      check(
        !q.entries.some((e) => ["applying", "unconfirmed"].includes(e.state)) &&
          q.attempts.at(-1)?.phase !== "running",
        "interrupted_operation_requires_inspection",
      );
      q.target_sha = expectedHead;
      q.requires_validation = true;
      await this.save(state);
      return this.describe(state);
    });
  }
  async reject(input, expectedRevision) {
    check(
      exact(input, ["reason"]) && text(input.reason),
      "rejection_reason_required",
    );
    return this.mutate(expectedRevision, async (state) => {
      const q = this.queue(state),
        entry = q.entries.find(
          (e) => !["integrated", "rejected"].includes(e.state),
        );
      check(
        entry && ["queued", "conflict"].includes(entry.state),
        "next_integration_not_retryable",
      );
      entry.state = "rejected";
      entry.reason = input.reason;
      await this.save(state);
      return this.describe(state);
    });
  }
}
