// Explicit local checks and reported evidence, independent of task status/schema.
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { ProjectStore } from "./state.mjs";
import {
  AcceptanceError,
  requireValue as check,
  checksum,
  relativeInput,
  observeTarget,
  freshness,
} from "./acceptance-target.mjs";

const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value, keys) =>
  object(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
const text = (value, max = 1000) =>
  typeof value === "string" &&
  value.trim().length > 0 &&
  value.length <= max &&
  !/[\x00-\x1f\x7f]/.test(value);
const id = (value) =>
  typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value);
const evidenceId = (value) =>
  typeof value === "string" &&
  /^evi_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
    value,
  );
const digest = (value) =>
  typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const integer = (value) => Number.isSafeInteger(value) && value >= 0;
const time = (value) =>
  typeof value === "string" &&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) &&
  Number.isFinite(Date.parse(value));
const results = ["pass", "fail", "blocked", "not-run"];
const bytesHash = (bytes) => createHash("sha256").update(bytes).digest("hex");
function criteria(input) {
  check(
    Array.isArray(input) && input.length > 0 && input.length <= 50,
    "invalid_acceptance_criteria",
  );
  const normalized = input.map((value) => {
    check(
      exact(value, ["id", "description", "inputs"]) &&
        id(value.id) &&
        text(value.description) &&
        Array.isArray(value.inputs) &&
        value.inputs.length > 0 &&
        value.inputs.length <= 1000 &&
        value.inputs.every(relativeInput) &&
        new Set(value.inputs).size === value.inputs.length,
      "invalid_acceptance_criterion",
    );
    return {
      id: value.id,
      description: value.description,
      inputs: [...value.inputs].sort(),
    };
  });
  check(
    new Set(normalized.map((value) => value.id)).size === normalized.length,
    "duplicate_acceptance_criterion",
  );
  return normalized;
}
async function readJson(file, maximum = 2 * 1024 * 1024) {
  let handle;
  try {
    handle = await fs.open(file, "r");
    check((await handle.stat()).size <= maximum, "acceptance_file_too_large");
    const bytes = await handle.readFile();
    check(bytes.length <= maximum, "acceptance_file_too_large");
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    if (error instanceof AcceptanceError) throw error;
    throw new AcceptanceError("invalid_acceptance_json");
  } finally {
    await handle?.close();
  }
}
async function writeJson(file, value) {
  const body = JSON.stringify(value, null, 2) + "\n";
  check(
    Buffer.byteLength(body) <= 2 * 1024 * 1024,
    "acceptance_file_too_large",
  );
  const temporary = file + "." + randomUUID() + ".tmp";
  let handle;
  try {
    handle = await fs.open(temporary, "wx", 0o600);
    await handle.writeFile(body);
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temporary, file);
  } catch {
    throw new AcceptanceError("acceptance_write_unconfirmed");
  } finally {
    await handle?.close();
  }
}
function database(value, project) {
  check(
    exact(value, ["schema", "project_id", "revision", "tasks", "evidence"]) &&
      value.schema === 1 &&
      value.project_id === project.id &&
      integer(value.revision) &&
      Array.isArray(value.tasks) &&
      value.tasks.length <= 200 &&
      Array.isArray(value.evidence) &&
      value.evidence.length <= 2000,
    "invalid_acceptance_database",
  );
  const taskIds = new Set(),
    recordIds = new Set();
  for (const task of value.tasks) {
    check(
      exact(task, ["id", "criteria", "updated_at"]) &&
        text(task.id, 160) &&
        time(task.updated_at) &&
        !taskIds.has(task.id),
      "invalid_acceptance_database",
    );
    check(
      JSON.stringify(criteria(task.criteria)) === JSON.stringify(task.criteria),
      "invalid_acceptance_database",
    );
    taskIds.add(task.id);
  }
  for (const [index, item] of value.evidence.entries()) {
    check(
      exact(item, [
        "sequence",
        "evidence_id",
        "task_id",
        "criterion_id",
        "scope",
      ]) &&
        item.sequence === index + 1 &&
        evidenceId(item.evidence_id) &&
        text(item.task_id, 160) &&
        id(item.criterion_id) &&
        ["full", "partial"].includes(item.scope) &&
        !recordIds.has(item.evidence_id),
      "invalid_acceptance_database",
    );
    recordIds.add(item.evidence_id);
  }
  return value;
}
function target(value) {
  check(
    exact(value, [
      "observed_at",
      "head_sha",
      "branch",
      "inputs_hash",
      "worktree_hash",
      "environment",
      "environment_hash",
      "status",
      "reason",
    ]) &&
      time(value.observed_at) &&
      (value.head_sha === null || /^[0-9a-f]{40,64}$/.test(value.head_sha)) &&
      (value.branch === null || text(value.branch, 256)) &&
      (value.inputs_hash === null || digest(value.inputs_hash)) &&
      (value.worktree_hash === null || digest(value.worktree_hash)) &&
      digest(value.environment_hash) &&
      exact(value.environment, [
        "platform",
        "architecture",
        "os_release",
        "node_version",
      ]) &&
      Object.values(value.environment).every((item) => text(item, 256)) &&
      checksum(value.environment) === value.environment_hash &&
      ["observed", "unknown"].includes(value.status) &&
      (value.reason === null || id(value.reason)),
    "invalid_evidence_target",
  );
}
function evidence(value, project, reference) {
  check(
    exact(value, [
      "schema",
      "project_id",
      "evidence_id",
      "sequence",
      "task_id",
      "criterion_id",
      "criterion_hash",
      "scope",
      "source",
      "status",
      "phase",
      "reason",
      "command",
      "exit_code",
      "target",
      "stable_target",
      "artifacts",
      "started_at",
      "finished_at",
      "record_hash",
    ]) &&
      value.schema === 1 &&
      value.project_id === project.id &&
      reference.evidence_id === value.evidence_id &&
      reference.sequence === value.sequence &&
      value.task_id === reference.task_id &&
      value.criterion_id === reference.criterion_id &&
      value.scope === reference.scope &&
      digest(value.criterion_hash) &&
      ["local_runner", "operator_reported"].includes(value.source) &&
      results.includes(value.status) &&
      ["intent", "dispatching", "finished"].includes(value.phase) &&
      (value.reason === null || text(value.reason, 2000)) &&
      (value.exit_code === null || Number.isSafeInteger(value.exit_code)) &&
      typeof value.stable_target === "boolean" &&
      time(value.started_at) &&
      (value.finished_at === null || time(value.finished_at)) &&
      digest(value.record_hash),
    "invalid_acceptance_evidence",
  );
  target(value.target);
  check(
    value.command === null ||
      (exact(value.command, [
        "executable",
        "arguments_digest",
        "argument_count",
        "private_argv_file",
      ]) &&
        path.isAbsolute(value.command.executable) &&
        digest(value.command.arguments_digest) &&
        integer(value.command.argument_count) &&
        value.command.argument_count <= 63 &&
        value.command.private_argv_file === "command.json"),
    "invalid_acceptance_evidence",
  );
  check(
    Array.isArray(value.artifacts) &&
      value.artifacts.length <= 8 &&
      value.artifacts.every(
        (item) =>
          exact(item, [
            "name",
            "mime",
            "sha256",
            "bytes",
            "captured_at",
            "imported_at",
            "source",
          ]) &&
          /^[a-z0-9.-]{1,80}$/.test(item.name) &&
          ["text/plain", "image/png", "image/jpeg"].includes(item.mime) &&
          digest(item.sha256) &&
          integer(item.bytes) &&
          (item.captured_at === null || time(item.captured_at)) &&
          time(item.imported_at) &&
          ["local_runner_log", "operator_supplied_image"].includes(item.source),
      ),
    "invalid_acceptance_evidence",
  );
  const { record_hash, ...body } = value;
  check(checksum(body) === record_hash, "evidence_checksum_mismatch");
  return value;
}
async function savedArtifact(directory, name, bytes, mime, source) {
  const file = path.join(directory, name);
  const handle = await fs.open(file, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  return {
    name,
    mime,
    sha256: bytesHash(bytes),
    bytes: bytes.length,
    captured_at:
      source === "operator_supplied_image" ? null : new Date().toISOString(),
    imported_at: new Date().toISOString(),
    source,
  };
}
const stable = (before, after) =>
  before.status === "observed" &&
  after.status === "observed" &&
  [
    "head_sha",
    "branch",
    "inputs_hash",
    "worktree_hash",
    "environment_hash",
  ].every((key) => before[key] === after[key]);
export class AcceptanceStore {
  constructor(project) {
    this.project = { ...project };
    this.directory = path.join(project.directory, "acceptance");
    this.index = path.join(this.directory, "index.json");
  }
  static async open(project) {
    check(
      object(project) &&
        text(project.id, 160) &&
        path.isAbsolute(project.directory) &&
        path.isAbsolute(project.root),
      "invalid_acceptance_project",
    );
    const root = await fs.realpath(project.root);
    check((await fs.stat(root)).isDirectory(), "invalid_acceptance_project");
    const store = new AcceptanceStore({ ...project, root });
    await store.read();
    return store;
  }
  async read() {
    return database(
      (await readJson(this.index)) ?? {
        schema: 1,
        project_id: this.project.id,
        revision: 0,
        tasks: [],
        evidence: [],
      },
      this.project,
    );
  }
  async mutate(operation) {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const file = path.join(this.directory, "index.lock"),
      owner = randomUUID();
    let handle;
    try {
      handle = await fs.open(file, "wx", 0o600);
    } catch (error) {
      throw new AcceptanceError(
        error.code === "EEXIST"
          ? "acceptance_busy"
          : "acceptance_lock_unavailable",
      );
    }
    try {
      await handle.writeFile(owner);
      await handle.sync();
      const next = await this.read(),
        result = await operation(next);
      next.revision++;
      database(next, this.project);
      await writeJson(this.index, next);
      return result;
    } finally {
      await handle.close();
      try {
        check(
          (await fs.readFile(file, "utf8")) === owner,
          "acceptance_lock_changed",
        );
        await fs.unlink(file);
      } catch {
        throw new AcceptanceError("acceptance_lock_cleanup_unconfirmed");
      }
    }
  }
  async taskStatus(taskId) {
    const store = await ProjectStore.open(this.project);
    const task = store.value.tasks.find((item) => item.id === taskId);
    return task && ["todo", "doing", "done", "blocked"].includes(task.status)
      ? task.status
      : "unknown";
  }
  async define(taskId, input) {
    check(text(taskId, 160), "exact_task_id_required");
    const normalized = criteria(input);
    check((await this.taskStatus(taskId)) !== "unknown", "task_not_found");
    return this.mutate((value) => {
      const item = {
          id: taskId,
          criteria: normalized,
          updated_at: new Date().toISOString(),
        },
        index = value.tasks.findIndex((task) => task.id === taskId);
      if (index < 0) {
        check(value.tasks.length < 200, "acceptance_task_limit");
        value.tasks.push(item);
      } else value.tasks[index] = item;
      return item;
    });
  }
  async criterion(taskId, criterionId) {
    const value = (await this.read()).tasks
      .find((task) => task.id === taskId)
      ?.criteria.find((item) => item.id === criterionId);
    check(value, "acceptance_criterion_not_found");
    return value;
  }
  recordDirectory(id) {
    check(evidenceId(id), "exact_evidence_id_required");
    return path.join(this.directory, "evidence", id);
  }
  async reserve(taskId, criterion, scope) {
    check(["full", "partial"].includes(scope), "invalid_test_scope");
    return this.mutate((value) => {
      check(value.evidence.length < 2000, "evidence_limit");
      check(
        checksum(
          value.tasks
            .find((task) => task.id === taskId)
            ?.criteria.find((item) => item.id === criterion.id),
        ) === checksum(criterion),
        "acceptance_definition_changed",
      );
      const reference = {
        sequence: value.evidence.length + 1,
        evidence_id: "evi_" + randomUUID(),
        task_id: taskId,
        criterion_id: criterion.id,
        scope,
      };
      value.evidence.push(reference);
      return reference;
    });
  }
  async saveRecord(value) {
    const { record_hash: ignored, ...body } = value;
    value.record_hash = checksum(body);
    evidence(value, this.project, value);
    await writeJson(
      path.join(this.recordDirectory(value.evidence_id), "record.json"),
      value,
    );
  }
  async loadRecord(reference) {
    const value = await readJson(
      path.join(this.recordDirectory(reference.evidence_id), "record.json"),
    );
    if (value === null) return null;
    return evidence(value, this.project, reference);
  }
  async perform({
    task_id,
    criterion_id,
    scope = "full",
    argv = null,
    timeout_ms = 60000,
    reported = null,
    images = [],
  } = {}) {
    check(
      text(task_id, 160) && id(criterion_id),
      "invalid_acceptance_selector",
    );
    check(
      Array.isArray(images) &&
        images.length <= 4 &&
        images.every(relativeInput),
      "invalid_image_references",
    );
    if (argv !== null)
      check(
        Array.isArray(argv) &&
          argv.length > 0 &&
          argv.length <= 64 &&
          path.isAbsolute(argv[0]) &&
          argv.every(
            (item) =>
              typeof item === "string" &&
              item.length > 0 &&
              item.length <= 65536 &&
              !item.includes("\0"),
          ) &&
          Number.isSafeInteger(timeout_ms) &&
          timeout_ms >= 500 &&
          timeout_ms <= 600000 &&
          reported === null,
        "explicit_test_argv_required",
      );
    else
      check(
        exact(reported, ["status", "reason"]) &&
          results.includes(reported.status) &&
          text(reported.reason, 2000),
        "reported_result_and_reason_required",
      );
    if (argv) argv = [...argv];
    const criterion = await this.criterion(task_id, criterion_id),
      observed = await observeTarget(this.project, criterion.inputs);
    const reference = await this.reserve(task_id, criterion, scope),
      directory = this.recordDirectory(reference.evidence_id);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const record = {
      schema: 1,
      project_id: this.project.id,
      ...reference,
      criterion_hash: checksum(criterion),
      source: argv ? "local_runner" : "operator_reported",
      status: "not-run",
      phase: "intent",
      reason: "execution_not_observed",
      command: argv
        ? {
            executable: argv[0],
            arguments_digest: checksum(argv.slice(1)),
            argument_count: argv.length - 1,
            private_argv_file: "command.json",
          }
        : null,
      exit_code: null,
      target: observed,
      stable_target: false,
      artifacts: [],
      started_at: new Date().toISOString(),
      finished_at: null,
      record_hash: "0".repeat(64),
    };
    await this.saveRecord(record);
    if (argv) {
      await writeJson(path.join(directory, "command.json"), { argv });
      if (observed.status !== "observed") {
        record.status = "blocked";
        record.reason = observed.reason;
      } else {
        const home = path.join(directory, "home");
        await fs.mkdir(home, { mode: 0o700 });
        const env = Object.fromEntries(
          Object.entries(process.env).filter(([key]) =>
            /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|TEMP|TMP|COMSPEC|LANG|LC_ALL)$/i.test(
              key,
            ),
          ),
        );
        Object.assign(env, {
          HOME: home,
          USERPROFILE: home,
          DSH_HOME: path.join(home, "dsh"),
          RDSH_DASHBOARD_HOME: path.join(home, "dashboard"),
          CI: "true",
        });
        record.phase = "dispatching";
        record.status = "blocked";
        record.reason = "execution_outcome_unconfirmed";
        await this.saveRecord(record);
        const outcome = await new Promise((resolve) =>
          execFile(
            argv[0],
            argv.slice(1),
            {
              cwd: this.project.root,
              env,
              windowsHide: true,
              shell: false,
              timeout: timeout_ms,
              maxBuffer: 1024 * 1024,
              encoding: "buffer",
              killSignal: "SIGKILL",
            },
            (error, stdout, stderr) =>
              resolve({
                error,
                stdout: stdout ?? Buffer.alloc(0),
                stderr: stderr ?? Buffer.alloc(0),
              }),
          ),
        );
        record.exit_code =
          outcome.error === null
            ? 0
            : typeof outcome.error.code === "number"
              ? outcome.error.code
              : null;
        record.status =
          outcome.error === null
            ? "pass"
            : record.exit_code !== null
              ? "fail"
              : "blocked";
        record.reason =
          outcome.error === null
            ? null
            : record.exit_code !== null
              ? "test_exit_nonzero"
              : "test_transport_or_deadline_unconfirmed";
        record.artifacts.push(
          await savedArtifact(
            directory,
            "stdout.log",
            outcome.stdout,
            "text/plain",
            "local_runner_log",
          ),
        );
        record.artifacts.push(
          await savedArtifact(
            directory,
            "stderr.log",
            outcome.stderr,
            "text/plain",
            "local_runner_log",
          ),
        );
      }
    } else {
      record.status = reported.status;
      record.reason = reported.reason;
    }
    for (const [index, relative] of images.entries()) {
      const file = await fs.realpath(path.join(this.project.root, relative));
      const local = path.relative(this.project.root, file);
      check(
        local !== ".." &&
          !local.startsWith(".." + path.sep) &&
          !path.isAbsolute(local),
        "image_outside_project",
      );
      check(
        (await fs.stat(file)).isFile() &&
          (await fs.stat(file)).size <= 8 * 1024 * 1024,
        "image_too_large",
      );
      const bytes = await fs.readFile(file);
      check(bytes.length <= 8 * 1024 * 1024, "image_too_large");
      const png = bytes
          .subarray(0, 8)
          .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
        jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
      check(png || jpeg, "unsupported_evidence_image");
      record.artifacts.push(
        await savedArtifact(
          directory,
          `image-${index}.${png ? "png" : "jpg"}`,
          bytes,
          png ? "image/png" : "image/jpeg",
          "operator_supplied_image",
        ),
      );
    }
    record.stable_target = stable(
      observed,
      await observeTarget(this.project, criterion.inputs),
    );
    if (
      !record.stable_target &&
      record.source === "local_runner" &&
      record.status === "pass"
    ) {
      record.status = "blocked";
      record.reason = "target_changed_or_unobservable_during_test";
    }
    record.phase = "finished";
    record.finished_at = new Date().toISOString();
    await this.saveRecord(record);
    return {
      evidence_id: record.evidence_id,
      status: record.status,
      source: record.source,
      scope: record.scope,
      exit_code: record.exit_code,
      reason: record.reason,
      target: record.target,
      private_record_directory: directory,
      permission_expanded: false,
    };
  }
  async inspect(taskId) {
    check(text(taskId, 160), "exact_task_id_required");
    const value = await this.read(),
      definition = value.tasks.find((item) => item.id === taskId),
      task_status = await this.taskStatus(taskId);
    const conditions = [];
    const observations = new Map();
    for (const criterion of definition?.criteria ?? []) {
      const scopeKey = checksum(criterion.inputs);
      if (!observations.has(scopeKey))
        observations.set(
          scopeKey,
          await observeTarget(this.project, criterion.inputs),
        );
      const current = observations.get(scopeKey),
        records = [];
      for (const reference of value.evidence.filter(
        (item) => item.task_id === taskId && item.criterion_id === criterion.id,
      )) {
        const record = await this.loadRecord(reference);
        if (record === null)
          records.push({
            ...reference,
            status: "blocked",
            phase: "intent",
            freshness: {
              state: "unknown",
              reason: "evidence_record_unconfirmed",
            },
            eligible_pass: false,
          });
        else {
          const fresh = freshness(record, current, checksum(criterion));
          let command_integrity =
            record.command === null ? "not_applicable" : "unknown";
          if (record.command !== null) {
            try {
              const file = path.join(
                this.recordDirectory(record.evidence_id),
                "command.json",
              );
              const stat = await fs.lstat(file);
              if (!stat.isFile()) command_integrity = "changed";
              else {
                const saved = await readJson(file);
                command_integrity =
                  saved === null
                    ? "missing"
                    : exact(saved, ["argv"]) &&
                        Array.isArray(saved.argv) &&
                        saved.argv.length ===
                          record.command.argument_count + 1 &&
                        saved.argv[0] === record.command.executable &&
                        checksum(saved.argv.slice(1)) ===
                          record.command.arguments_digest
                      ? "intact"
                      : "changed";
              }
            } catch (error) {
              command_integrity =
                error.code === "ENOENT"
                  ? "missing"
                  : error instanceof AcceptanceError
                    ? "changed"
                    : "unknown";
            }
          }
          const artifacts = [];
          for (const artifact of record.artifacts) {
            let validity = "unknown";
            try {
              const file = path.join(
                  this.recordDirectory(record.evidence_id),
                  artifact.name,
                ),
                stat = await fs.lstat(file);
              if (
                !stat.isFile() ||
                stat.size !== artifact.bytes ||
                stat.size > 8 * 1024 * 1024
              )
                validity = "changed";
              else
                validity =
                  bytesHash(await fs.readFile(file)) === artifact.sha256
                    ? "intact"
                    : "changed";
            } catch (error) {
              if (error.code === "ENOENT") validity = "missing";
            }
            artifacts.push({
              ...artifact,
              integrity: validity,
              target: record.target,
              freshness: fresh,
              target_binding:
                artifact.source === "local_runner_log"
                  ? "observed_execution"
                  : "operator_supplied; capture_target_unverified",
              visual_review: "not_assessed",
            });
          }
          const eligible_pass =
            record.source === "local_runner" &&
            record.phase === "finished" &&
            record.status === "pass" &&
            record.exit_code === 0 &&
            command_integrity === "intact" &&
            fresh.state === "current" &&
            artifacts.every((artifact) => artifact.integrity === "intact") &&
            ["stdout.log", "stderr.log"].every((name) =>
              artifacts.some(
                (artifact) =>
                  artifact.name === name &&
                  artifact.source === "local_runner_log",
              ),
            );
          records.push({
            ...record,
            freshness: fresh,
            command_integrity,
            eligible_pass,
            private_record_directory: this.recordDirectory(record.evidence_id),
            artifacts,
          });
        }
      }
      const full = records.findLast((item) => item.scope === "full") ?? null,
        partial = records.findLast((item) => item.scope === "partial") ?? null;
      conditions.push({
        criterion,
        current_target: current,
        full_result: full,
        partial_result: partial,
        evidence: records,
        status: full?.status ?? "not-run",
        verified_full_check: Boolean(full?.eligible_pass),
      });
    }
    const verified =
      conditions.length > 0 &&
      conditions.every((item) => item.verified_full_check);
    return {
      task_id: taskId,
      reported_task_status: task_status,
      acceptance_defined: Boolean(definition),
      conditions,
      verification: {
        all_declared_full_checks_pass: verified,
        status: verified ? "verified_checks" : "unverified",
        source:
          "local_test_execution_and_current_code_environment_observations",
        human_review: "not_assessed",
        production_adoption: "not_assessed",
      },
      reported_done_with_verified_checks: task_status === "done" && verified,
      replayed_tests: 0,
      permission_expanded: false,
    };
  }
}
