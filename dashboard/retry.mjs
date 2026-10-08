// Bounded transport retry, never an agent loop or permission grant.
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";

export const retryKinds = Object.freeze({
  cli_version_probe: Object.freeze({ effect: "read_only", idempotent: true }),
  cli_usage_read: Object.freeze({ effect: "read_only", idempotent: true }),
  acp_prompt: Object.freeze({ effect: "possible_write", idempotent: false }),
  external_send: Object.freeze({ effect: "external_write", idempotent: false }),
  git_commit: Object.freeze({ effect: "external_write", idempotent: false }),
  payment: Object.freeze({ effect: "external_write", idempotent: false }),
});
const categories = [
  "rate_limited",
  "unavailable",
  "timeout",
  "auth_denied",
  "permanent",
  "unknown",
];
const temporary = (category) =>
  ["rate_limited", "unavailable", "timeout"].includes(category);
const statuses = [
  "planned",
  "preparing",
  "dispatching",
  "reconciling",
  "waiting",
  "completed",
  "blocked",
  "budget_exhausted",
  "unknown",
];
const certaintyValues = [
  "not_dispatched",
  "response_observed",
  "reconciled_applied",
  "reconciled_not_applied",
  "unknown",
];
const steps = [
  "planned",
  "authority_rejected",
  "attempt_started",
  "prepare_failed",
  "dispatching",
  "response_observed",
  "execute_failed",
  "reconcile_started",
  "reconcile_result",
  "waiting",
  "stopped",
];
const reasons = [
  null,
  "scope_not_authorized",
  "attempt_budget_exhausted",
  "elapsed_budget_exhausted",
  "delay_budget_exhausted",
  "authentication_required",
  "permanent_failure",
  "unclassified_failure",
  "reconciliation_unavailable",
  "reconciliation_unverified",
  "reconciliation_authority_rejected",
  "confirmed_applied",
  "confirmed_not_applied",
  "retry_scheduled",
  "response_observed",
];
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value, fields) =>
  object(value) &&
  Object.keys(value).length === fields.length &&
  fields.every((key) => Object.hasOwn(value, key));
const opId = (value) =>
  typeof value === "string" &&
  /^op_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
    value,
  );
const digest = (value) =>
  typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const integer = (value, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) =>
  Number.isSafeInteger(value) && value >= minimum && value <= maximum;
const time = (value) =>
  typeof value === "string" &&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) &&
  Number.isFinite(Date.parse(value));
const sum = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export class RetryError extends Error {
  constructor(code) {
    super("Retry: " + code);
    this.code = code;
  }
}
export class RetryFailure extends Error {
  constructor(category, retry_after_ms = null) {
    if (
      !categories.includes(category) ||
      (retry_after_ms !== null && !integer(retry_after_ms, 0, 600000))
    )
      throw new RetryError("invalid_failure_category");
    super("Retry failure: " + category);
    this.category = category;
    this.retry_after_ms = retry_after_ms;
  }
}
class Deadline extends Error {}
const check = (value, code) => {
  if (!value) throw new RetryError(code);
};
export function retryBudget(input = {}) {
  check(
    object(input) &&
      Object.keys(input).every((key) =>
        ["max_attempts", "total_ms", "base_ms", "max_delay_ms"].includes(key),
      ),
    "invalid_budget",
  );
  const budget = {
    max_attempts: input.max_attempts ?? 3,
    total_ms: input.total_ms ?? 10000,
    base_ms: input.base_ms ?? 200,
    max_delay_ms: input.max_delay_ms ?? 2000,
  };
  check(
    integer(budget.max_attempts, 1, 20) &&
      integer(budget.total_ms, 1, 600000) &&
      integer(budget.base_ms, 1, 60000) &&
      integer(budget.max_delay_ms, budget.base_ms, 60000),
    "invalid_budget",
  );
  return budget;
}
function validateRecord(value, project, id) {
  check(
    exact(value, [
      "schema",
      "project_id",
      "operation_id",
      "kind",
      "scope_digest",
      "budget",
      "status",
      "certainty",
      "attempts",
      "elapsed_ms",
      "wait_ms",
      "created_at",
      "updated_at",
      "next_attempt_at",
      "history",
    ]),
    "invalid_retry_history",
  );
  check(
    value.schema === 1 &&
      value.project_id === project.id &&
      value.operation_id === id &&
      opId(id) &&
      Object.hasOwn(retryKinds, value.kind) &&
      digest(value.scope_digest),
    "invalid_retry_history",
  );
  check(
    JSON.stringify(retryBudget(value.budget)) ===
      JSON.stringify(value.budget) &&
      statuses.includes(value.status) &&
      certaintyValues.includes(value.certainty) &&
      integer(value.attempts, 0, value.budget.max_attempts) &&
      integer(value.elapsed_ms) &&
      integer(value.wait_ms) &&
      time(value.created_at) &&
      time(value.updated_at) &&
      (value.next_attempt_at === null || time(value.next_attempt_at)),
    "invalid_retry_history",
  );
  check(
    Array.isArray(value.history) &&
      value.history.length >= 1 &&
      value.history.length <= 300,
    "invalid_retry_history",
  );
  for (const [index, event] of value.history.entries())
    check(
      exact(event, [
        "sequence",
        "step",
        "attempt",
        "category",
        "reason",
        "elapsed_ms",
        "wait_ms",
        "next_attempt_at",
        "reconciliation",
        "evidence_digest",
        "observed_at",
      ]) &&
        event.sequence === index + 1 &&
        steps.includes(event.step) &&
        integer(event.attempt, 0, value.attempts) &&
        (event.category === null || categories.includes(event.category)) &&
        reasons.includes(event.reason) &&
        integer(event.elapsed_ms) &&
        integer(event.wait_ms) &&
        (event.next_attempt_at === null || time(event.next_attempt_at)) &&
        [null, "applied", "not_applied", "unknown"].includes(
          event.reconciliation,
        ) &&
        (event.evidence_digest === null || digest(event.evidence_digest)) &&
        time(event.observed_at),
      "invalid_retry_history",
    );
  return value;
}
const publicRecord = (record) => ({
  ...structuredClone(record),
  recorded_status: record.status,
  status: [
    "planned",
    "preparing",
    "dispatching",
    "reconciling",
    "waiting",
  ].includes(record.status)
    ? "unknown"
    : record.status,
  recovery: "read_only; no automatic replay",
  permission_expanded: false,
});
export class RetryHistory {
  constructor(project) {
    this.project = { ...project };
    this.directory = path.join(project.directory, "retries");
  }
  static async open(project) {
    check(
      object(project) &&
        typeof project.id === "string" &&
        /^[a-zA-Z0-9_-]{1,160}$/.test(project.id) &&
        typeof project.directory === "string" &&
        path.isAbsolute(project.directory),
      "invalid_project",
    );
    return new RetryHistory(project);
  }
  file(id) {
    check(opId(id), "exact_operation_id_required");
    return path.join(this.directory, id + ".json");
  }
  async read(id) {
    let handle;
    try {
      handle = await fs.open(this.file(id), "r");
      check(
        (await handle.stat()).size <= 128 * 1024,
        "retry_history_too_large",
      );
      const bytes = await handle.readFile();
      check(bytes.length <= 128 * 1024, "retry_history_too_large");
      return validateRecord(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
        this.project,
        id,
      );
    } catch (error) {
      if (error.code === "ENOENT") return null;
      if (error instanceof RetryError) throw error;
      throw new RetryError("invalid_retry_history");
    } finally {
      await handle?.close();
    }
  }
  async inspect(id) {
    const record = await this.read(id);
    check(record, "operation_not_found");
    let locked = false;
    try {
      await fs.lstat(path.join(this.directory, id + ".lock"));
      locked = true;
    } catch (error) {
      if (error.code !== "ENOENT")
        throw new RetryError("retry_lock_unobservable");
    }
    return {
      ...publicRecord(record),
      writer_lock_present: locked,
      automatic_lock_removal: false,
    };
  }
  async list() {
    let names;
    try {
      names = await fs.readdir(this.directory);
    } catch (error) {
      if (error.code === "ENOENT") return { operations: [] };
      throw new RetryError("retry_history_unavailable");
    }
    const ids = names
      .filter((name) => name.endsWith(".json") && opId(name.slice(0, -5)))
      .sort()
      .slice(0, 100);
    const operations = [];
    for (const name of ids)
      operations.push(await this.inspect(name.slice(0, -5)));
    return {
      operations,
      truncated:
        names.filter(
          (name) => name.endsWith(".json") && opId(name.slice(0, -5)),
        ).length > ids.length,
    };
  }
  async save(record) {
    validateRecord(record, this.project, record.operation_id);
    const body = JSON.stringify(record, null, 2) + "\n";
    check(Buffer.byteLength(body) <= 128 * 1024, "retry_history_too_large");
    const file = this.file(record.operation_id),
      temporary = file + "." + randomUUID() + ".tmp";
    let handle;
    try {
      handle = await fs.open(temporary, "wx", 0o600);
      await handle.writeFile(body);
      await handle.sync();
      await handle.close();
      handle = null;
      await fs.rename(temporary, file);
    } catch {
      throw new RetryError("retry_history_write_unconfirmed");
    } finally {
      await handle?.close();
    }
  }
  async lease(id, operation) {
    this.file(id);
    await fs.mkdir(this.directory, { recursive: true });
    const file = path.join(this.directory, id + ".lock"),
      owner = JSON.stringify({ owner_id: randomUUID(), pid: process.pid });
    let handle;
    try {
      handle = await fs.open(file, "wx", 0o600);
    } catch (error) {
      if (error.code === "EEXIST") throw new RetryError("operation_busy");
      throw new RetryError("retry_lock_unavailable");
    }
    try {
      await handle.writeFile(owner);
      await handle.sync();
      return await operation();
    } finally {
      await handle.close();
      try {
        check(
          (await fs.readFile(file, "utf8")) === owner,
          "retry_lock_changed",
        );
        await fs.unlink(file);
      } catch {
        throw new RetryError("retry_lock_cleanup_unconfirmed");
      }
    }
  }
}
async function bounded(callback, context, milliseconds) {
  if (milliseconds <= 0) throw new Deadline();
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(() =>
        callback({ ...context, signal: controller.signal }),
      ),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Deadline());
        }, milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
function receipt(value, context) {
  return (
    exact(value, [
      "operation_id",
      "scope_digest",
      "outcome",
      "source",
      "evidence_id",
      "observed_at",
    ]) &&
    value.operation_id === context.operation_id &&
    value.scope_digest === context.scope_digest &&
    ["applied", "not_applied", "unknown"].includes(value.outcome) &&
    value.source === "authoritative_operation_status" &&
    typeof value.evidence_id === "string" &&
    /^[a-zA-Z0-9._:/-]{1,256}$/.test(value.evidence_id) &&
    time(value.observed_at)
  );
}
export async function runWithRetry({
  history,
  operation_id = "op_" + randomUUID(),
  kind,
  scope_digest,
  budget = {},
  authorize,
  prepare = null,
  execute,
  reconcile = null,
  now = () => performance.now(),
  wait = (ms, signal) => delay(ms, undefined, { signal }),
} = {}) {
  check(
    history instanceof RetryHistory &&
      opId(operation_id) &&
      Object.hasOwn(retryKinds, kind) &&
      digest(scope_digest) &&
      typeof authorize === "function" &&
      typeof execute === "function" &&
      (prepare === null || typeof prepare === "function") &&
      (reconcile === null || typeof reconcile === "function"),
    "invalid_operation",
  );
  budget = retryBudget(budget);
  const context = Object.freeze({ operation_id, kind, scope_digest });
  return history.lease(operation_id, async () => {
    const previous = await history.read(operation_id);
    if (previous) {
      check(
        previous.kind === kind && previous.scope_digest === scope_digest,
        "operation_changed",
      );
      return { ...publicRecord(previous), reused_operation: true };
    }
    const started = now();
    check(Number.isFinite(started), "invalid_clock");
    let record = {
      schema: 1,
      project_id: history.project.id,
      ...context,
      budget,
      status: "planned",
      certainty: "not_dispatched",
      attempts: 0,
      elapsed_ms: 0,
      wait_ms: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      next_attempt_at: null,
      history: [],
    };
    let lastClock = started;
    const elapsed = () => {
      const clock = now();
      check(Number.isFinite(clock) && clock >= lastClock, "invalid_clock");
      lastClock = clock;
      return Math.ceil(clock - started);
    };
    const left = () => Math.max(0, budget.total_ms - elapsed());
    const event = async (step, details = {}) => {
      record.elapsed_ms = elapsed();
      record.updated_at = new Date().toISOString();
      record.history.push({
        sequence: record.history.length + 1,
        step,
        attempt: record.attempts,
        category: null,
        reason: null,
        elapsed_ms: record.elapsed_ms,
        wait_ms: record.wait_ms,
        next_attempt_at: record.next_attempt_at,
        reconciliation: null,
        evidence_digest: null,
        observed_at: record.updated_at,
        ...details,
      });
      await history.save(record);
    };
    const finish = async (status, reason, category = null) => {
      record.status = status;
      record.next_attempt_at = null;
      await event("stopped", { reason, category });
      return { ...publicRecord(record), reused_operation: false };
    };
    const allowed = async (action) => {
      try {
        const result = await bounded(authorize, { ...context, action }, left());
        return (
          exact(result, ["allowed", "scope_digest"]) &&
          result.allowed === true &&
          result.scope_digest === scope_digest
        );
      } catch {
        return false;
      }
    };
    await event("planned");
    while (true) {
      if (!left())
        return finish("budget_exhausted", "elapsed_budget_exhausted");
      if (record.attempts >= budget.max_attempts)
        return finish("budget_exhausted", "attempt_budget_exhausted");
      if (!(await allowed("execute"))) {
        if (!left())
          return finish("budget_exhausted", "elapsed_budget_exhausted");
        await event("authority_rejected", { reason: "scope_not_authorized" });
        return finish("blocked", "scope_not_authorized");
      }
      if (!left())
        return finish("budget_exhausted", "elapsed_budget_exhausted");
      record.attempts++;
      record.status = "preparing";
      record.certainty = "not_dispatched";
      await event("attempt_started");
      let failure,
        dispatched = false;
      try {
        if (prepare) await bounded(prepare, context, left());
        if (!left()) throw new Deadline();
        if (!(await allowed("execute"))) {
          if (!left()) throw new Deadline();
          await event("authority_rejected", { reason: "scope_not_authorized" });
          return finish("blocked", "scope_not_authorized");
        }
        record.status = "dispatching";
        record.certainty = "unknown";
        await event("dispatching");
        if (!left()) {
          record.certainty = "not_dispatched";
          return finish("budget_exhausted", "elapsed_budget_exhausted");
        }
        dispatched = true;
        await bounded(execute, context, left());
        record.status = "completed";
        record.certainty = "response_observed";
        await event("response_observed", { reason: "response_observed" });
        return { ...publicRecord(record), reused_operation: false };
      } catch (error) {
        if (error instanceof RetryError) throw error;
        if (error instanceof Deadline)
          return finish(
            "budget_exhausted",
            "elapsed_budget_exhausted",
            "timeout",
          );
        failure =
          error instanceof RetryFailure ? error : new RetryFailure("unknown");
        await event(dispatched ? "execute_failed" : "prepare_failed", {
          category: failure.category,
        });
      }
      if (["auth_denied", "permanent", "unknown"].includes(failure.category))
        return finish(
          dispatched ? "unknown" : "blocked",
          failure.category === "auth_denied"
            ? "authentication_required"
            : failure.category === "permanent"
              ? "permanent_failure"
              : "unclassified_failure",
          failure.category,
        );
      if (dispatched && !retryKinds[kind].idempotent) {
        if (!reconcile)
          return finish(
            "unknown",
            "reconciliation_unavailable",
            failure.category,
          );
        if (!left())
          return finish(
            "budget_exhausted",
            "elapsed_budget_exhausted",
            failure.category,
          );
        if (!(await allowed("reconcile"))) {
          if (!left())
            return finish(
              "budget_exhausted",
              "elapsed_budget_exhausted",
              failure.category,
            );
          return finish(
            "unknown",
            "reconciliation_authority_rejected",
            failure.category,
          );
        }
        record.status = "reconciling";
        await event("reconcile_started");
        let result;
        try {
          result = await bounded(reconcile, context, left());
        } catch (error) {
          if (error instanceof Deadline)
            return finish(
              "budget_exhausted",
              "elapsed_budget_exhausted",
              "timeout",
            );
          return finish(
            "unknown",
            "reconciliation_unverified",
            failure.category,
          );
        }
        if (!receipt(result, context))
          return finish(
            "unknown",
            "reconciliation_unverified",
            failure.category,
          );
        await event("reconcile_result", {
          reconciliation: result.outcome,
          evidence_digest: sum(result),
        });
        if (result.outcome === "applied") {
          record.certainty = "reconciled_applied";
          return finish("completed", "confirmed_applied", failure.category);
        }
        if (result.outcome === "unknown")
          return finish(
            "unknown",
            "reconciliation_unverified",
            failure.category,
          );
        record.certainty = "reconciled_not_applied";
      }
      if (!temporary(failure.category))
        return finish("unknown", "unclassified_failure", failure.category);
      if (record.attempts >= budget.max_attempts)
        return finish(
          "budget_exhausted",
          "attempt_budget_exhausted",
          failure.category,
        );
      if (failure.retry_after_ms > budget.max_delay_ms)
        return finish(
          "budget_exhausted",
          "delay_budget_exhausted",
          failure.category,
        );
      const milliseconds = Math.max(
        Math.min(
          budget.max_delay_ms,
          budget.base_ms * 2 ** (record.attempts - 1),
        ),
        failure.retry_after_ms || 0,
      );
      if (milliseconds >= left())
        return finish(
          "budget_exhausted",
          "elapsed_budget_exhausted",
          failure.category,
        );
      record.status = "waiting";
      record.next_attempt_at = new Date(
        Date.now() + milliseconds,
      ).toISOString();
      await event("waiting", {
        reason: "retry_scheduled",
        category: failure.category,
      });
      try {
        const before = elapsed();
        await bounded(
          ({ signal }) => wait(milliseconds, signal),
          context,
          left(),
        );
        record.wait_ms += elapsed() - before;
      } catch {
        return finish(
          "budget_exhausted",
          "elapsed_budget_exhausted",
          "timeout",
        );
      }
      record.next_attempt_at = null;
    }
  });
}
