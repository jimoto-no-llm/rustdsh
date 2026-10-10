import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";

const schema = 1;
const retentionChoices = [7, 30, 90];
const maxEvents = 10_000;
const dayMs = 24 * 60 * 60 * 1000;
const durationKinds = new Set(["decision_time", "recovery_time"]);
const countKinds = new Set([
  "question_recurrence",
  "instruction_resend",
  "queue_revision_conflict",
  "abandoned_decision_timer",
  "abandoned_recovery_timer",
]);

function timestamp(value, label = "timestamp") {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)))
    throw new Error(`Invalid ${label}`);
  return new Date(Date.parse(value)).toISOString();
}

function emptyState() {
  return {
    schema,
    enabled: false,
    retention_days: 30,
    coverage_sessions: [],
    events: [],
    truncated_before: null,
    active_timer: null,
  };
}

function validateState(value) {
  if (
    !value ||
    value.schema !== schema ||
    typeof value.enabled !== "boolean" ||
    !retentionChoices.includes(value.retention_days) ||
    !Array.isArray(value.coverage_sessions) ||
    value.coverage_sessions.length > 1000 ||
    !Array.isArray(value.events) ||
    value.events.length > maxEvents ||
    (value.truncated_before !== null && typeof value.truncated_before !== "string") ||
    !Object.hasOwn(value, "active_timer") ||
    Object.keys(value).some(
      (key) =>
        !["schema", "enabled", "retention_days", "coverage_sessions", "events", "truncated_before", "active_timer"].includes(key),
    )
  )
    throw new Error("Invalid local human metrics data");
  for (const session of value.coverage_sessions) {
    if (
      !session ||
      Object.keys(session).some((key) => !["from", "to"].includes(key))
    )
      throw new Error("Invalid local human metrics coverage");
    timestamp(session.from, "coverage start");
    if (session.to !== null) timestamp(session.to, "coverage end");
  }
  if (value.enabled && value.coverage_sessions.at(-1)?.to !== null)
    throw new Error("Enabled local human metrics require an open coverage session");
  if (!value.enabled && value.coverage_sessions.at(-1)?.to === null)
    throw new Error("Disabled local human metrics cannot have an open coverage session");
  if (value.truncated_before !== null) timestamp(value.truncated_before, "truncation marker");
  for (const event of value.events) {
    if (!event || typeof event !== "object")
      throw new Error("Invalid local human metrics event");
    timestamp(event.at);
    if (durationKinds.has(event.kind)) {
      timestamp(event.started_at, "timer start");
      if (!Number.isSafeInteger(event.duration_ms) || event.duration_ms < 0)
        throw new Error("Invalid local human metrics duration");
      if (Object.keys(event).some((key) => !["kind", "at", "started_at", "duration_ms"].includes(key)))
        throw new Error("Unknown local human metrics event field");
    } else if (countKinds.has(event.kind)) {
      if (Object.keys(event).some((key) => !["kind", "at"].includes(key)))
        throw new Error("Unknown local human metrics event field");
    } else {
      throw new Error("Unknown local human metrics event kind");
    }
  }
  if (value.active_timer !== null) {
    const timer = value.active_timer;
    if (
      !timer ||
      Object.keys(timer).some(
        (key) =>
          !["kind", "state", "started_at", "resumed_at", "elapsed_ms"].includes(key),
      ) ||
      !["decision", "recovery"].includes(timer.kind) ||
      !["running", "paused"].includes(timer.state) ||
      (timer.kind === "recovery" && timer.state !== "running") ||
      !Number.isSafeInteger(timer.elapsed_ms) ||
      timer.elapsed_ms < 0
    )
      throw new Error("Invalid active local human metrics timer");
    timestamp(timer.started_at, "timer start");
    if (timer.resumed_at !== null) timestamp(timer.resumed_at, "timer resume");
    if (timer.state === "running" && timer.resumed_at === null)
      throw new Error("Running timer is missing its resume time");
    if (timer.state === "paused" && timer.resumed_at !== null)
      throw new Error("Paused timer cannot have a resume time");
  }
  return value;
}

function trimEvents(value, now) {
  const cutoff = now - value.retention_days * dayMs;
  if (value.active_timer && Date.parse(value.active_timer.started_at) < cutoff) {
    const kind =
      value.active_timer.kind === "decision"
        ? "abandoned_decision_timer"
        : "abandoned_recovery_timer";
    value.active_timer = null;
    value.events.push({ kind, at: new Date(now).toISOString() });
  }
  value.events = value.events.filter((event) => Date.parse(event.at) >= cutoff);
  if (value.events.length > maxEvents) {
    const dropped = value.events.splice(0, value.events.length - maxEvents);
    const lastDropped = dropped.at(-1)?.at;
    if (
      lastDropped &&
      (!value.truncated_before ||
        Date.parse(lastDropped) > Date.parse(value.truncated_before))
    )
      value.truncated_before = lastDropped;
  }
  if (
    value.truncated_before &&
    Date.parse(value.truncated_before) < cutoff
  )
    value.truncated_before = null;
  value.coverage_sessions = value.coverage_sessions
    .filter((session) => session.to === null || Date.parse(session.to) >= cutoff)
    .slice(-1000);
}

function median(values) {
  if (!values.length) return null;
  const ordered = values.slice().sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2
    ? ordered[middle]
    : Math.round((ordered[middle - 1] + ordered[middle]) / 2);
}

function timeMetric(events, kind, abandonedKind, pending, enabled, partial) {
  const values = events
    .filter((event) => event.kind === kind)
    .map((event) => event.duration_ms);
  return {
    status: partial
      ? "partial"
      : enabled && values.length
        ? "measured"
        : "unavailable",
    sample_count: values.length,
    total_ms: values.length ? values.reduce((sum, item) => sum + item, 0) : null,
    median_ms: median(values),
    pending_count: pending ? 1 : 0,
    unpaired_count: events.filter((event) => event.kind === abandonedKind).length,
  };
}

function countMetric(events, kind, enabled, partial) {
  const count = events.filter((event) => event.kind === kind).length;
  return {
    status: !enabled ? "unavailable" : partial ? "partial" : "observed",
    count: enabled ? count : null,
  };
}

export function summarizeHumanMetrics(value, now = Date.now()) {
  validateState(value);
  const cutoff = now - value.retention_days * dayMs;
  const events = value.events.filter(
    (event) =>
      Date.parse(event.at) >= cutoff &&
      (event.started_at === undefined || Date.parse(event.started_at) >= cutoff),
  );
  const timer = value.active_timer;
  const timerIsRecent = timer && Date.parse(timer.started_at) >= cutoff;
  const coverageSessions = value.coverage_sessions
    .filter((session) => session.to === null || Date.parse(session.to) >= cutoff)
    .map((session) => ({
      from: new Date(Math.max(cutoff, Date.parse(session.from))).toISOString(),
      to: new Date(Math.min(now, session.to ? Date.parse(session.to) : now)).toISOString(),
    }));
  const historyAvailable = coverageSessions.length > 0;
  const partial = Boolean(
    value.truncated_before && Date.parse(value.truncated_before) >= cutoff,
  );
  return {
    enabled: value.enabled,
    retention_days: value.retention_days,
    coverage: {
      status: !historyAvailable
        ? "unavailable"
        : value.enabled
          ? "recording"
          : "stopped",
      from: coverageSessions[0]?.from ?? null,
      to: coverageSessions.at(-1)?.to ?? null,
      sessions: coverageSessions,
      partial,
    },
    decision_time: timeMetric(
      events,
      "decision_time",
      "abandoned_decision_timer",
      value.enabled && timerIsRecent && timer.kind === "decision",
      historyAvailable,
      partial,
    ),
    question_recurrence: countMetric(
      events,
      "question_recurrence",
      historyAvailable,
      partial,
    ),
    instruction_resend: countMetric(
      events,
      "instruction_resend",
      historyAvailable,
      partial,
    ),
    recovery_time: timeMetric(
      events,
      "recovery_time",
      "abandoned_recovery_timer",
      value.enabled && timerIsRecent && timer.kind === "recovery",
      historyAvailable,
      partial,
    ),
    queue_revision_conflicts: countMetric(
      events,
      "queue_revision_conflict",
      historyAvailable,
      partial,
    ),
    active_timer: value.enabled && timerIsRecent
      ? {
          kind: timer.kind,
          state: timer.state,
          elapsed_ms:
            timer.elapsed_ms +
            (timer.state === "running" ? Math.max(0, now - Date.parse(timer.resumed_at)) : 0),
        }
      : null,
  };
}

// Comparison deliberately keeps token use, recurrence, resend and recovery as
// separate dimensions. It never rolls them into a single quality score.
export function compareHumanMetricSamples(before, after) {
  const dimensions = [
    ["tokens", "tokens"],
    ["decision_time_ms", "decision_time_ms"],
    ["question_recurrence", "question_recurrence"],
    ["instruction_resend", "instruction_resend"],
    ["recovery_time_ms", "recovery_time_ms"],
    ["queue_revision_conflicts", "queue_revision_conflicts"],
  ];
  return Object.fromEntries(
    dimensions.map(([name, key]) => {
      const valueOf = (sample) => {
        if (typeof sample?.[key] === "number") return sample[key];
        if (key === "tokens") return sample?.token_snapshot?.value ?? null;
        const metricKey = {
          decision_time_ms: "decision_time",
          question_recurrence: "question_recurrence",
          instruction_resend: "instruction_resend",
          recovery_time_ms: "recovery_time",
          queue_revision_conflicts: "queue_revision_conflicts",
        }[key];
        const metric = sample?.metrics?.[metricKey];
        return key.endsWith("_ms") ? metric?.median_ms ?? null : metric?.count ?? null;
      };
      const left = valueOf(before),
        right = valueOf(after);
      const known =
        typeof left === "number" &&
        Number.isFinite(left) &&
        typeof right === "number" &&
        Number.isFinite(right);
      return [
        name,
        known
          ? { status: "compared", before: left, after: right, delta: right - left }
          : { status: "unavailable", before: null, after: null, delta: null },
      ];
    }),
  );
}

export class HumanMetricsStore {
  constructor(project) {
    this.file = path.join(project.directory, "human-metrics.json");
    this.value = null;
  }

  static async open(project) {
    const store = new HumanMetricsStore(project);
    try {
      store.value = validateState(
        JSON.parse(await fs.readFile(store.file, "utf8")),
      );
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      store.value = emptyState();
      return store;
    }
    const beforeEvents = store.value.events.length;
    const beforeCoverage = store.value.coverage_sessions.length;
    const beforeTruncated = store.value.truncated_before;
    const beforeTimer = store.value.active_timer;
    trimEvents(store.value, Date.now());
    if (
      store.value.events.length !== beforeEvents ||
      store.value.coverage_sessions.length !== beforeCoverage ||
      store.value.truncated_before !== beforeTruncated ||
      store.value.active_timer !== beforeTimer
    )
      await store.save();
    return store;
  }

  async save() {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify(this.value, null, 2) + "\n", {
        mode: 0o600,
      });
      await fs.rename(temporary, this.file);
    } catch (error) {
      await fs.unlink(temporary).catch(() => {});
      throw error;
    }
  }

  snapshot(now = Date.now()) {
    return summarizeHumanMetrics(this.value, now);
  }

  requireEnabled() {
    if (!this.value.enabled)
      throw new Error("Local human metrics are disabled");
  }

  append(kind, at, fields = {}) {
    this.value.events.push({ kind, at, ...fields });
    trimEvents(this.value, Date.parse(at));
  }

  async handle(input, state, now = Date.now()) {
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new Error("Expected a local human metrics operation");
    const at = new Date(now).toISOString();
    const action = input.action;
    const allowedFields = {
      configure: ["action", "enabled", "retention_days"],
      clear: ["action"],
      start_decision_timer: ["action", "question_id"],
      start_recovery_timer: ["action", "task_id"],
      pause_timer: ["action"],
      resume_timer: ["action"],
      finish_timer: ["action"],
      mark_question_recurrence: ["action", "question_id"],
      mark_instruction_resend: ["action", "command_id"],
    };
    if (!Object.hasOwn(allowedFields, action))
      throw new Error("Unknown local human metrics operation");
    if (Object.keys(input).some((key) => !allowedFields[action].includes(key)))
      throw new Error("Unknown local human metrics field");

    if (action === "configure") {
      if (typeof input.enabled !== "boolean")
        throw new Error("enabled must be a boolean");
      if (!retentionChoices.includes(input.retention_days))
        throw new Error("retention_days must be 7, 30, or 90");
      this.value.retention_days = input.retention_days;
      if (input.enabled && !this.value.enabled) {
        this.value.enabled = true;
        this.value.coverage_sessions.push({ from: at, to: null });
      } else if (!input.enabled && this.value.enabled) {
        this.value.enabled = false;
        this.value.coverage_sessions.at(-1).to = at;
        if (this.value.active_timer) {
          const kind = this.value.active_timer.kind;
          this.value.active_timer = null;
          this.append(
            kind === "decision"
              ? "abandoned_decision_timer"
              : "abandoned_recovery_timer",
            at,
          );
        }
      }
    } else if (action === "clear") {
      const { enabled, retention_days } = this.value;
      this.value = emptyState();
      this.value.enabled = enabled;
      this.value.retention_days = retention_days;
      if (enabled) this.value.coverage_sessions.push({ from: at, to: null });
    } else {
      this.requireEnabled();
      if (
        this.value.active_timer &&
        Date.parse(this.value.active_timer.started_at) <
          now - this.value.retention_days * dayMs
      ) {
        trimEvents(this.value, now);
        validateState(this.value);
        await this.save();
      }
      if (action === "start_decision_timer") {
        if (
          !state.questions?.some(
            (question) => question.id === input.question_id && question.answer === null,
          )
        )
          throw new Error("Choose an unanswered question for decision timing");
        if (this.value.active_timer) throw new Error("A timer is already running");
        this.value.active_timer = {
          kind: "decision",
          state: "running",
          started_at: at,
          resumed_at: at,
          elapsed_ms: 0,
        };
      } else if (action === "start_recovery_timer") {
        if (
          !state.tasks?.some(
            (task) => task.id === input.task_id && task.status === "blocked",
          )
        )
          throw new Error("Choose a currently blocked task for recovery timing");
        if (this.value.active_timer) throw new Error("A timer is already running");
        this.value.active_timer = {
          kind: "recovery",
          state: "running",
          started_at: at,
          resumed_at: at,
          elapsed_ms: 0,
        };
      } else if (action === "pause_timer") {
        const timer = this.value.active_timer;
        if (!timer || timer.kind !== "decision" || timer.state !== "running")
          throw new Error("Only a running decision timer can be paused");
        timer.elapsed_ms += Math.max(0, now - Date.parse(timer.resumed_at));
        timer.state = "paused";
        timer.resumed_at = null;
      } else if (action === "resume_timer") {
        const timer = this.value.active_timer;
        if (!timer || timer.kind !== "decision" || timer.state !== "paused")
          throw new Error("Only a paused decision timer can be resumed");
        timer.state = "running";
        timer.resumed_at = at;
      } else if (action === "finish_timer") {
        const timer = this.value.active_timer;
        if (!timer) throw new Error("There is no active timer");
        const duration =
          timer.elapsed_ms +
          (timer.state === "running" ? Math.max(0, now - Date.parse(timer.resumed_at)) : 0);
        this.append(
          timer.kind === "decision" ? "decision_time" : "recovery_time",
          at,
          { started_at: timer.started_at, duration_ms: Math.round(duration) },
        );
        this.value.active_timer = null;
      } else if (action === "mark_question_recurrence") {
        if (!state.questions?.some((question) => question.id === input.question_id))
          throw new Error("Choose a recorded question");
        this.append("question_recurrence", at);
      } else if (action === "mark_instruction_resend") {
        if (!state.instructions?.requests?.[input.command_id])
          throw new Error("Choose a recorded instruction");
        this.append("instruction_resend", at);
      }
    }
    trimEvents(this.value, now);
    validateState(this.value);
    await this.save();
    return this.snapshot(now);
  }

  async recordQueueRevisionConflict(now = Date.now()) {
    if (!this.value.enabled) return false;
    const at = new Date(now).toISOString();
    this.append("queue_revision_conflict", at);
    validateState(this.value);
    await this.save();
    return true;
  }
}
