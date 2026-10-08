// Checkpoint selection around native ACP lifecycle APIs; no conversation replay.
import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  SessionLedger,
  attachRecordedSession,
  verifyRecordedContext,
} from "./session-ledger.mjs";
import { RunHistory } from "./run-history.mjs";
import { RetryHistory, retryKinds } from "./retry.mjs";
import { createCliAdapter } from "./adapters.mjs";
import { ModelRouting } from "./model-routing.mjs";

const sum = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const digest = (value) =>
  typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const uuid = (value, prefix) =>
  typeof value === "string" &&
  new RegExp(
    "^" +
      prefix +
      "_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
  ).test(value);
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value, keys) =>
  object(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
const integer = (value) => Number.isSafeInteger(value) && value >= 0;
const nativeId = (value) =>
  value === null ||
  (typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    !/[\x00-\x1f\x7f]/.test(value));
const time = (value) =>
  typeof value === "string" &&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) &&
  Number.isFinite(Date.parse(value));
const check = (value, code) => {
  if (!value) throw new CheckpointError(code);
};
export class CheckpointError extends Error {
  constructor(code) {
    super("Checkpoint: " + code);
    this.code = code;
  }
}
const uncertain = (commands) =>
  commands.filter((item) => !["recorded", "acknowledged"].includes(item.phase));
const frame = (event) =>
  event
    ? { event_id: event.event_id, sequence: event.sequence, hash: event.hash }
    : null;

async function journal(project, runId) {
  const history = await RunHistory.open(project),
    loaded = await history.read();
  const run = loaded.runs.get(runId);
  check(run, "run_history_missing");
  const events = loaded.events.filter((event) => event.run_id === runId);
  const confirmed = events.findLast(
    (event) =>
      event.type === "process_exit" ||
      (event.type === "command" && event.data.phase === "acknowledged"),
  );
  const inspection = await history.inspect(runId);
  check(
    inspection.revision === run.revision,
    "journal_changed_during_observation",
  );
  return {
    history,
    run,
    events,
    snapshot: {
      last_event: frame(events.at(-1)),
      last_confirmed_event: frame(confirmed),
      unresolved_count: uncertain(run.commands).length,
      unresolved: uncertain(run.commands)
        .slice(-100)
        .map(({ command_id, operation, phase }) => ({
          command_id,
          operation,
          phase,
        })),
      incomplete_tail_bytes: loaded.tail_bytes,
    },
    inspection,
  };
}
function validateCheckpoint(value, project, id) {
  check(
    exact(value, [
      "schema",
      "project_id",
      "checkpoint_id",
      "run_id",
      "task_id",
      "cli",
      "cli_session_id",
      "binding",
      "cli_version",
      "context",
      "journal",
      "retry_operations",
      "saved_at",
      "checksum",
    ]) &&
      value.schema === 1 &&
      value.project_id === project.id &&
      value.checkpoint_id === id &&
      uuid(id, "cp") &&
      uuid(value.run_id, "run") &&
      nativeId(value.task_id) &&
      ["dsh", "codex", "claude", "kimi"].includes(value.cli) &&
      nativeId(value.cli_session_id) &&
      ["unknown", "reported", "confirmed"].includes(value.binding) &&
      nativeId(value.cli_version) &&
      time(value.saved_at) &&
      digest(value.checksum),
    "invalid_checkpoint",
  );
  check(
    exact(value.context, ["cwd", "branch", "git", "launch", "scope"]) &&
      typeof value.context.cwd === "string" &&
      value.context.cwd.length <= 4096 &&
      !/[\x00-\x1f\x7f]/.test(value.context.cwd) &&
      path.isAbsolute(value.context.cwd) &&
      nativeId(value.context.branch) &&
      exact(value.context.git, ["status", "root", "head"]) &&
      ["observed", "not_a_repository", "unavailable"].includes(
        value.context.git.status,
      ) &&
      exact(value.journal, [
        "last_event",
        "last_confirmed_event",
        "unresolved_count",
        "unresolved",
        "incomplete_tail_bytes",
      ]) &&
      integer(value.journal.unresolved_count) &&
      integer(value.journal.incomplete_tail_bytes) &&
      Array.isArray(value.journal.unresolved) &&
      value.journal.unresolved.length <= 100 &&
      value.journal.unresolved.every(
        (item) =>
          exact(item, ["command_id", "operation", "phase"]) &&
          uuid(item.command_id, "cmd") &&
          ["start", "resume", "send", "interrupt", "stop"].includes(
            item.operation,
          ) &&
          ["dispatched", "notification_sent", "unknown"].includes(item.phase),
      ) &&
      Array.isArray(value.retry_operations) &&
      value.retry_operations.length <= 100 &&
      value.retry_operations.every((item) => uuid(item, "op")),
    "invalid_checkpoint",
  );
  for (const event of [
    value.journal.last_event,
    value.journal.last_confirmed_event,
  ])
    check(
      event === null ||
        (exact(event, ["event_id", "sequence", "hash"]) &&
          uuid(event.event_id, "evt") &&
          integer(event.sequence) &&
          digest(event.hash)),
      "invalid_checkpoint",
    );
  const { checksum, ...body } = value;
  check(sum(body) === checksum, "checkpoint_checksum_mismatch");
  return value;
}
function validateAction(value, id) {
  check(
    exact(value, [
      "schema",
      "checkpoint_id",
      "action_id",
      "mode",
      "status",
      "run_id",
      "cli_session_id",
      "summary_digest",
      "summary_bytes",
      "summary_status",
      "created_at",
      "updated_at",
    ]) &&
      value.schema === 1 &&
      value.checkpoint_id === id &&
      uuid(value.action_id, "recover") &&
      ["resume", "start_new"].includes(value.mode) &&
      ["preparing", "session_attached", "completed", "unknown"].includes(
        value.status,
      ) &&
      (value.run_id === null || uuid(value.run_id, "run")) &&
      nativeId(value.cli_session_id) &&
      (value.summary_digest === null || digest(value.summary_digest)) &&
      integer(value.summary_bytes) &&
      value.summary_bytes <= 65536 &&
      ["not_requested", "pending", "response_observed", "unknown"].includes(
        value.summary_status,
      ) &&
      time(value.created_at) &&
      time(value.updated_at),
    "invalid_recovery_action",
  );
  check(
    value.mode === "resume"
      ? value.summary_digest === null &&
          value.summary_bytes === 0 &&
          value.summary_status === "not_requested"
      : digest(value.summary_digest) &&
          value.summary_bytes > 0 &&
          value.summary_status !== "not_requested",
    "invalid_recovery_action",
  );
  if (["session_attached", "completed"].includes(value.status))
    check(
      uuid(value.run_id, "run") && value.cli_session_id !== null,
      "invalid_recovery_action",
    );
  if (value.mode === "start_new" && value.status === "completed")
    check(
      value.summary_status === "response_observed",
      "invalid_recovery_action",
    );
  return value;
}
async function readJson(file) {
  let handle;
  try {
    handle = await fs.open(file, "r");
    check((await handle.stat()).size <= 128 * 1024, "checkpoint_too_large");
    const bytes = await handle.readFile();
    check(bytes.length <= 128 * 1024, "checkpoint_too_large");
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    if (error instanceof CheckpointError) throw error;
    throw new CheckpointError("invalid_checkpoint_json");
  } finally {
    await handle?.close();
  }
}
async function writeJson(file, value, replace = false) {
  const body = JSON.stringify(value, null, 2) + "\n";
  check(Buffer.byteLength(body) <= 128 * 1024, "checkpoint_too_large");
  const temporary = replace ? file + "." + randomUUID() + ".tmp" : file;
  let handle;
  try {
    handle = await fs.open(temporary, "wx", 0o600);
    await handle.writeFile(body);
    await handle.sync();
    await handle.close();
    handle = null;
    if (replace) await fs.rename(temporary, file);
  } catch {
    throw new CheckpointError("checkpoint_write_unconfirmed");
  } finally {
    await handle?.close();
  }
}
export class Checkpoints {
  constructor(project) {
    this.project = { ...project };
    this.directory = path.join(project.directory, "checkpoints");
  }
  static async open(project) {
    const ledger = await SessionLedger.open(project);
    return new Checkpoints(ledger.project);
  }
  file(id, suffix = ".json") {
    check(uuid(id, "cp"), "exact_checkpoint_id_required");
    return path.join(this.directory, id + suffix);
  }
  async read(id) {
    const value = await readJson(this.file(id));
    check(value, "checkpoint_not_found");
    return validateCheckpoint(value, this.project, id);
  }
  async action(id) {
    const value = await readJson(this.file(id, ".recovery.json"));
    return value === null ? null : validateAction(value, id);
  }
  async saveAction(value) {
    validateAction(value, value.checkpoint_id);
    await writeJson(
      this.file(value.checkpoint_id, ".recovery.json"),
      value,
      true,
    );
  }
  async lease(id, operation) {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const file = this.file(id, ".lock"),
      owner = randomUUID();
    let handle;
    try {
      handle = await fs.open(file, "wx", 0o600);
    } catch (error) {
      throw new CheckpointError(
        error.code === "EEXIST"
          ? "checkpoint_busy"
          : "checkpoint_lock_unavailable",
      );
    }
    try {
      await handle.writeFile(owner);
      await handle.sync();
      return await operation(owner);
    } finally {
      await handle.close();
      try {
        check(
          (await fs.readFile(file, "utf8")) === owner,
          "checkpoint_lock_changed",
        );
        await fs.unlink(file);
      } catch {
        throw new CheckpointError("checkpoint_lock_cleanup_unconfirmed");
      }
    }
  }
  async record({
    run_id,
    command,
    env = process.env,
    retry_operations = [],
  } = {}) {
    env = { ...env };
    if (Array.isArray(command)) command = [...command];
    check(
      Array.isArray(retry_operations) &&
        retry_operations.length <= 100 &&
        new Set(retry_operations).size === retry_operations.length &&
        retry_operations.every((id) => uuid(id, "op")),
      "invalid_retry_references",
    );
    const ledger = await SessionLedger.open(this.project),
      run = await ledger.resolve(run_id);
    const context = await verifyRecordedContext(run, command, env),
      current = await journal(this.project, run_id);
    const retry = await RetryHistory.open(this.project);
    for (const id of retry_operations) await retry.inspect(id);
    const id = "cp_" + randomUUID(),
      body = {
        schema: 1,
        project_id: this.project.id,
        checkpoint_id: id,
        run_id,
        task_id: run.task_id,
        cli: run.cli,
        cli_session_id: run.cli_session_id,
        binding: run.binding,
        cli_version: run.cli_version,
        context,
        journal: current.snapshot,
        retry_operations: [...retry_operations],
        saved_at: new Date().toISOString(),
      };
    const value = { ...body, checksum: sum(body) };
    validateCheckpoint(value, this.project, id);
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    await writeJson(this.file(id), value);
    return value;
  }
  async list() {
    let names;
    try {
      names = await fs.readdir(this.directory);
    } catch (error) {
      if (error.code === "ENOENT") return { checkpoints: [], truncated: false };
      throw new CheckpointError("checkpoints_unavailable");
    }
    const ids = names
      .filter((name) => name.endsWith(".json") && uuid(name.slice(0, -5), "cp"))
      .sort();
    const checkpoints = [];
    for (const name of ids.slice(0, 100))
      checkpoints.push(await this.read(name.slice(0, -5)));
    return { checkpoints, truncated: ids.length > 100 };
  }
  async inspect(
    id,
    {
      command = null,
      env = process.env,
      verify_native = false,
      owned_lock = null,
    } = {},
  ) {
    env = { ...env };
    if (Array.isArray(command)) command = [...command];
    const checkpoint = await this.read(id),
      reasons = [],
      loss = [
        "Checkpoint contains control metadata, not conversation history or external dependency snapshots.",
      ];
    const action = await this.action(id);
    let writer_lock_present = false;
    try {
      await fs.lstat(this.file(id, ".lock"));
      writer_lock_present = true;
    } catch (error) {
      if (error.code !== "ENOENT") reasons.push("checkpoint_lock_unobservable");
    }
    if (
      writer_lock_present &&
      (owned_lock === null ||
        (await fs.readFile(this.file(id, ".lock"), "utf8")) !== owned_lock)
    )
      reasons.push("checkpoint_writer_present");
    // recover holds this exact lock itself; public inspection never steals it.
    if (action !== null)
      reasons.push(
        action.status === "completed"
          ? "checkpoint_already_recovered"
          : "recovery_action_uncertain",
      );
    let record,
      new_run_requires_model_declaration = false,
      current,
      native = { status: "not_checked", resume_verified: false },
      context;
    try {
      record = await (
        await SessionLedger.open(this.project)
      ).resolve(checkpoint.run_id);
      check(
        record.cli_session_id === checkpoint.cli_session_id &&
          record.binding === checkpoint.binding &&
          record.cli_version === checkpoint.cli_version,
        "session_binding_changed",
      );
      new_run_requires_model_declaration =
        (await ModelRouting.open(this.project).read(record)) !== null;
      if (command === null) reasons.push("explicit_original_cli_required");
      else {
        try {
          await fs.realpath(record.cwd);
        } catch {
          throw new CheckpointError("recorded_worktree_unavailable");
        }
        context = await verifyRecordedContext(record, command, env);
        if (sum(context) !== sum(checkpoint.context))
          reasons.push("checkpoint_worktree_or_head_changed");
      }
      current = await journal(this.project, checkpoint.run_id);
      for (const saved of [
        checkpoint.journal.last_event,
        checkpoint.journal.last_confirmed_event,
      ])
        if (
          saved !== null &&
          !current.events.some(
            (event) =>
              event.sequence === saved.sequence &&
              event.event_id === saved.event_id &&
              event.hash === saved.hash,
          )
        )
          reasons.push("checkpoint_event_missing_or_changed");
      if (current.inspection.recovery.repair_required)
        reasons.push("journal_repair_required");
      if (current.snapshot.unresolved_count)
        reasons.push("unconfirmed_control_operation");
      const status = current.inspection.process_observation.status;
      if (
        current.run.scope &&
        current.inspection.scope_observation.status !== "exit_confirmed"
      )
        reasons.push("owned_descendants_unconfirmed");
      if (
        current.run.process &&
        !["gone", "pid_reused", "exit_confirmed", "absence_observed"].includes(
          status,
        )
      )
        reasons.push("owned_process_unconfirmed");
      if (record.binding !== "confirmed" || record.cli_session_id === null)
        reasons.push("native_session_id_unconfirmed");
      const retry = await RetryHistory.open(this.project);
      for (const operation of checkpoint.retry_operations) {
        const observed = await retry.inspect(operation);
        if (
          !retryKinds[observed.kind].idempotent &&
          ![
            "response_observed",
            "reconciled_applied",
            "reconciled_not_applied",
            "not_dispatched",
          ].includes(observed.certainty)
        )
          reasons.push("unconfirmed_external_operation");
        if (observed.writer_lock_present) reasons.push("retry_writer_present");
      }
      if (verify_native && reasons.length === 0) {
        const adapter = createCliAdapter({ command, cwd: record.cwd, env });
        try {
          native = await adapter.inspectSession(record.cli_session_id);
          if (native.cli_version !== record.cli_version)
            reasons.push("cli_version_changed");
        } finally {
          const stopped = await adapter.stop();
          check(stopped.confirmed, "native_probe_stop_unconfirmed");
        }
      }
    } catch (error) {
      const known = new Set([
        "run_not_found",
        "run_history_missing",
        "launch_changed",
        "repository_context_changed",
        "repository_context_unknown",
        "session_scope_changed",
        "session_binding_changed",
        "cli_version_changed",
        "native_probe_stop_unconfirmed",
        "recorded_worktree_unavailable",
      ]);
      reasons.push(
        known.has(error.code) ? error.code : "recovery_observation_unavailable",
      );
    }
    const blocked = reasons.length !== 0;
    const formal =
      !blocked && native.status === "listed" && native.resume_advertised;
    if (!blocked && !formal)
      loss.push(
        native.status === "not_listed"
          ? "The native session is not listed; deletion or expiry cannot be distinguished by ACP."
          : "Current native resume availability has not been confirmed.",
      );
    return {
      checkpoint,
      action,
      native,
      journal: current?.snapshot ?? null,
      candidates: {
        formal_resume: {
          available: formal,
          same_session: true,
          verified_only_after_native_resume: true,
        },
        summary_start_new: {
          available: !blocked && !new_run_requires_model_declaration,
          same_session: false,
          new_run_requires_model_declaration,
          requires_operator_summary: true,
          requires_context_loss_choice: true,
        },
        unavailable: { selected: blocked, reasons: [...new Set(reasons)] },
      },
      lost_context: loss,
      replayed_operations: 0,
      permission_expanded: false,
      uncertainty_since_checkpoint: current
        ? {
            control_event_count: current.events.filter(
              (event) =>
                event.sequence > (checkpoint.journal.last_event?.sequence ?? 0),
            ).length,
            control_events_added:
              current.run.revision >
              (checkpoint.journal.last_event?.sequence ?? 0),
            unresolved_count: current.snapshot.unresolved_count,
          }
        : null,
      writer_lock_present,
      automatic_lock_removal: false,
    };
  }
  async recover(
    id,
    {
      mode,
      command,
      env = process.env,
      summary = null,
      accept_context_loss = false,
    } = {},
  ) {
    check(["resume", "start_new"].includes(mode), "invalid_recovery_mode");
    if (mode === "start_new")
      check(
        accept_context_loss === true &&
          typeof summary === "string" &&
          summary.trim().length > 0 &&
          Buffer.byteLength(summary) <= 65536,
        "explicit_summary_and_context_loss_choice_required",
      );
    else
      check(
        summary === null && !accept_context_loss,
        "resume_has_no_summary_or_context_loss_choice",
      );
    env = { ...env };
    if (Array.isArray(command)) command = [...command];
    return this.lease(id, async (owner) => {
      const previous = await this.action(id);
      if (previous !== null) {
        check(
          previous.mode === mode &&
            previous.summary_digest ===
              (summary === null ? null : sum(summary)),
          "recovery_request_changed",
        );
        check(previous.status === "completed", "recovery_action_uncertain");
        return {
          ...previous,
          reused_recovery: true,
          observation: "historical; no native operation repeated",
        };
      }
      const plan = await this.inspect(id, {
        command,
        env,
        verify_native: true,
        owned_lock: owner,
      });
      check(!plan.candidates.unavailable.selected, "recovery_blocked");
      check(
        mode === "resume"
          ? plan.candidates.formal_resume.available
          : plan.candidates.summary_start_new.available,
        "recovery_mode_unavailable",
      );
      const current = await journal(this.project, plan.checkpoint.run_id);
      check(
        sum(current.snapshot) === sum(plan.journal),
        "recovery_state_changed",
      );
      const created_at = new Date().toISOString();
      const action = {
        schema: 1,
        checkpoint_id: id,
        action_id: "recover_" + randomUUID(),
        mode,
        status: "preparing",
        run_id: null,
        cli_session_id: null,
        summary_digest: summary === null ? null : sum(summary),
        summary_bytes: summary === null ? 0 : Buffer.byteLength(summary),
        summary_status: summary === null ? "not_requested" : "pending",
        created_at,
        updated_at: created_at,
      };
      await this.saveAction(action); // Intent before any session creation or resume.
      let attached;
      try {
        const ledger = await SessionLedger.open(this.project);
        const original = await ledger.resolve(plan.checkpoint.run_id);
        check(
          sum(await verifyRecordedContext(original, command, env)) ===
            sum(plan.checkpoint.context),
          "recovery_context_changed",
        );
        attached = await attachRecordedSession({
          ledger,
          command,
          env,
          cwd: plan.checkpoint.context.cwd,
          task_id: plan.checkpoint.task_id,
          ...(mode === "resume" ? { run_id: plan.checkpoint.run_id } : {}),
        });
        action.run_id = attached.record.run_id;
        action.cli_session_id = attached.record.cli_session_id;
        check(
          attached.record.cli_version === plan.checkpoint.cli_version,
          "cli_version_changed",
        );
        check(
          mode === "resume"
            ? action.cli_session_id === plan.checkpoint.cli_session_id
            : action.cli_session_id !== plan.checkpoint.cli_session_id,
          "native_session_identity_mismatch",
        );
        action.status = "session_attached";
        action.updated_at = new Date().toISOString();
        await this.saveAction(action);
        if (summary !== null) {
          const original = await ledger.resolve(plan.checkpoint.run_id);
          check(
            sum(await verifyRecordedContext(original, command, env)) ===
              sum(plan.checkpoint.context),
            "recovery_context_changed",
          );
          check(
            sum(
              (await journal(this.project, plan.checkpoint.run_id)).snapshot,
            ) === sum(plan.journal),
            "recovery_state_changed",
          );
          await attached.adapter.send(action.cli_session_id, summary);
          action.summary_status = "response_observed";
        }
        const stopped = await attached.adapter.stop();
        check(stopped.confirmed, "recovery_stop_unconfirmed");
        action.status = "completed";
        action.updated_at = new Date().toISOString();
        await this.saveAction(action);
        return {
          ...action,
          reused_recovery: false,
          native_resume_verified: mode === "resume",
          same_session: mode === "resume",
          source_checkpoint: id,
          summary_is_semantic_acceptance: false,
          replayed_operations: 0,
          owned_root_exit_confirmed: true,
        };
      } catch {
        if (attached) {
          try {
            await attached.adapter.stop();
          } catch {
            /* Keep uncertain ownership/history visible. */
          }
        }
        action.status = "unknown";
        if (summary !== null && action.summary_status === "pending")
          action.summary_status = "unknown";
        action.updated_at = new Date().toISOString();
        try {
          await this.saveAction(action);
        } catch {
          /* The flushed intent still prevents replay. */
        }
        throw new CheckpointError("recovery_result_unknown");
      }
    });
  }
}
