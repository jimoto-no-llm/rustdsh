import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { writeJson } from "./state.mjs";

const importanceLevels = ["low", "normal", "high", "critical"];
const importanceRank = Object.fromEntries(
  importanceLevels.map((value, index) => [value, index]),
);
const taskEvent = "dashboard.task.updated";
const questionEvent = "dashboard.question.created";
const progressEvent = "dashboard.progress.updated";
const metricsEvent = "dashboard.metrics.updated";
const validId = (value) => /^ntf_[0-9a-f]{64}$/.test(value);
const validEventId = (value) =>
  typeof value === "string" && value.length > 0 && value.length <= 240;
const validIsoDate = (value) =>
  typeof value === "string" && Number.isFinite(Date.parse(value));
const validClock = (value) =>
  typeof value === "string" && /^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/.test(value);
const exactKeys = (value, keys) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));

function fail(code) {
  return Object.assign(new Error(code), { code });
}

function stableId(projectId, key) {
  return `ntf_${createHash("sha256")
    .update(`${projectId}\n${key}`)
    .digest("hex")}`;
}

function snapshotEventId(kind, entityId, timestamp) {
  return `snapshot_${createHash("sha256")
    .update(`${kind}\n${entityId}\n${timestamp || "unknown"}`)
    .digest("hex")}`;
}

function currentEvent(changes, name, entityId) {
  return changes.filter(
    (event) =>
      event?.name === name && event.data?.entity_id === entityId &&
      validEventId(event.eventId),
  );
}

function notificationSources(state, runHistoryEvents = []) {
  const changes = Array.isArray(state.changes) ? state.changes : [];
  const items = [];
  for (const question of state.questions || []) {
    if (
      question.answer !== null ||
      (state.question_contracts?.cards?.[question.id] &&
        state.question_contracts.cards[question.id].status !== "open")
    )
      continue;
    const sourceEvents = currentEvent(changes, questionEvent, question.id);
    const source = sourceEvents.at(-1);
    items.push({
      id: stableId(state.project.id, `question:${question.id}`),
      kind: "question",
      importance: importanceLevels.includes(question.urgency)
        ? question.urgency
        : "normal",
      title: "回答待ち",
      summary: question.question,
      target: { type: "question", id: question.id },
      event_id:
        source?.eventId ??
        snapshotEventId("question", question.id, question.created_at),
      source_event_ids: sourceEvents.slice(-20).map((event) => event.eventId),
      source_event_count: sourceEvents.length,
      created_at: source?.timestamp || question.created_at,
    });
  }

  for (const task of state.tasks || []) {
    if (!["blocked", "done"].includes(task.status)) continue;
    const sourceEvents = currentEvent(changes, taskEvent, task.id);
    const taggedEvents = sourceEvents.filter(
      (event) =>
        event.notification?.kind === "task_status" &&
        event.notification.status === task.status,
    );
    const transitions = taggedEvents.filter(
      (event) =>
        event.notification.previous_status !== task.status ||
        event.notification.previous_title !== event.notification.title ||
        event.notification.previous_blocker !== event.notification.blocker,
    );
    const source = transitions.at(-1) || sourceEvents.at(-1);
    const groupedEvents = taggedEvents.length ? taggedEvents : sourceEvents;
    items.push({
      id: stableId(state.project.id, `task:${task.id}:${task.status}`),
      kind: "task",
      importance: task.status === "blocked" ? "high" : "normal",
      title: task.status === "blocked" ? "ブロック中" : "完了報告",
      summary:
        task.status === "blocked"
          ? `${task.title} · ${task.blocker || "ブロック中と報告されました。"}`
          : `${task.title} · done の報告です。受入検証の結果は別途確認してください。`,
      target: { type: "task", id: task.id },
      event_id:
        source?.eventId ??
        snapshotEventId("task", `${task.id}:${task.status}`, task.updated_at),
      source_event_ids: groupedEvents.slice(-20).map((event) => event.eventId),
      source_event_count: groupedEvents.length,
      created_at: source?.timestamp || task.updated_at,
    });
  }

  for (const [name, kind, title, target] of [
    [progressEvent, "progress", "進捗・成果物の更新", "progress-detail"],
    [metricsEvent, "metrics", "数値報告の更新", "metrics-detail"],
  ]) {
    const sourceEvents = changes.filter(
      (event) => event?.name === name && validEventId(event.eventId),
    );
    if (!sourceEvents.length) continue;
    const latest = sourceEvents.at(-1);
    items.push({
      id: stableId(state.project.id, `project:${kind}`),
      kind,
      importance: "low",
      title,
      summary: String(latest.data?.summary || "更新がありました。").slice(0, 1000),
      target: { type: "section", id: target },
      event_id: latest.eventId,
      source_event_ids: sourceEvents.slice(-20).map((event) => event.eventId),
      source_event_count: sourceEvents.length,
      created_at: latest.timestamp,
    });
  }

  const runGroups = new Map();
  for (const event of Array.isArray(runHistoryEvents) ? runHistoryEvents : []) {
    if (!event || typeof event.run_id !== "string") continue;
    const events = runGroups.get(event.run_id) || [];
    events.push(event);
    runGroups.set(event.run_id, events);
  }
  for (const [runId, events] of runGroups) {
    const terminal = events.findLast(
      (event) =>
        event.type === "transition" &&
        ["succeeded", "failed"].includes(event.data?.to),
    );
    if (!terminal) continue;
    const failed = terminal.data.to === "failed";
    items.push({
      id: stableId(state.project.id, `run:${runId}:${terminal.data.to}`),
      kind: "run",
      importance: failed ? "high" : "normal",
      title: failed ? "実行失敗が記録されました" : "実行完了が記録されました",
      summary: `${runId} · ${terminal.data.reason}`,
      target: { type: "run", id: runId },
      event_id: terminal.event_id,
      source_event_ids: events.slice(-20).map((event) => event.event_id),
      source_event_count: events.length,
      source_events: events.slice(-20).map((event) => ({
        event_id: event.event_id,
        observed_at: event.observed_at,
        type: event.type,
        state: event.type === "transition" ? event.data.to : null,
        reason: event.type === "transition" ? event.data.reason : null,
      })),
      created_at: terminal.observed_at,
    });
  }
  return items;
}

function validateQuietHours(value) {
  if (value === null) return null;
  if (!exactKeys(value, ["start", "end", "time_zone"]) ||
      !validClock(value.start) || !validClock(value.end) ||
      typeof value.time_zone !== "string" || value.time_zone.length > 100)
    throw fail("invalid_quiet_hours");
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value.time_zone }).format(0);
  } catch {
    throw fail("invalid_quiet_hours");
  }
  return { start: value.start, end: value.end, time_zone: value.time_zone };
}

function validatePreferences(value) {
  if (!exactKeys(value, ["minimum_importance", "quiet_hours"]) ||
      !importanceLevels.includes(value.minimum_importance))
    throw fail("invalid_notification_preferences");
  return {
    minimum_importance: value.minimum_importance,
    quiet_hours: validateQuietHours(value.quiet_hours),
  };
}

function quietNow(quietHours, now) {
  if (!quietHours || quietHours.start === quietHours.end) return false;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: quietHours.time_zone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const part = (type) => parts.find((item) => item.type === type)?.value;
  const minute = Number(part("hour")) * 60 + Number(part("minute"));
  const parse = (clock) => {
    const [hour, value] = clock.split(":").map(Number);
    return hour * 60 + value;
  };
  const start = parse(quietHours.start), end = parse(quietHours.end);
  return start < end
    ? minute >= start && minute < end
    : minute >= start || minute < end;
}

function validateSaved(saved) {
  if (!exactKeys(saved, ["schema", "preferences", "reads"]) ||
      saved.schema !== 1 || !saved.reads || typeof saved.reads !== "object" ||
      Array.isArray(saved.reads) || Object.keys(saved.reads).length > 5000)
    throw fail("invalid_notification_state");
  const preferences = validatePreferences(saved.preferences);
  const reads = {};
  for (const [id, read] of Object.entries(saved.reads)) {
    if (
      !validId(id) ||
      !exactKeys(read, ["event_id", "read_at"]) ||
      !validEventId(read.event_id) ||
      !validIsoDate(read.read_at)
    )
      throw fail("invalid_notification_state");
    reads[id] = { event_id: read.event_id, read_at: read.read_at };
  }
  return { preferences, reads };
}

export class NotificationInbox {
  constructor(project, preferences, reads) {
    this.project = project;
    this.file = path.join(project.directory, "notifications.json");
    this.preferences = preferences;
    this.reads = reads;
    this.queue = Promise.resolve();
  }

  static async open(project) {
    const defaults = { minimum_importance: "normal", quiet_hours: null };
    try {
      const saved = validateSaved(
        JSON.parse(await fs.readFile(path.join(project.directory, "notifications.json"), "utf8")),
      );
      return new NotificationInbox(project, saved.preferences, saved.reads);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      return new NotificationInbox(project, defaults, {});
    }
  }

  serial(work) {
    const result = this.queue.then(work);
    this.queue = result.catch(() => {});
    return result;
  }

  async persist(preferences = this.preferences, reads = this.reads) {
    await writeJson(this.file, {
      schema: 1,
      preferences,
      reads,
    });
  }

  snapshot(
    state,
    now = Date.now(),
    runHistoryEvents = [],
    runHistoryStatus = "available",
  ) {
    const all = notificationSources(state, runHistoryEvents).sort((a, b) => {
      const priority = importanceRank[b.importance] - importanceRank[a.importance];
      return priority || Date.parse(b.created_at || 0) - Date.parse(a.created_at || 0);
    });
    const isQuiet = quietNow(this.preferences.quiet_hours, now);
    const minimum = importanceRank[this.preferences.minimum_importance];
    const items = all.map((item) => {
      const read = this.reads[item.id];
      const unread = read?.event_id !== item.event_id;
      const filtered = importanceRank[item.importance] < minimum;
      const held = !filtered && isQuiet && item.importance !== "critical";
      return {
        ...item,
        unread,
        read_at: unread ? null : read.read_at,
        delivery_state: filtered ? "filtered" : held ? "held" : "ready",
      };
    });
    const actionable = items.filter((item) => item.delivery_state !== "filtered");
    const visibleUnread = actionable.filter((item) => item.unread);
    const heldUnread = visibleUnread.filter((item) => item.delivery_state === "held");
    return {
      revision: state.revision,
      observed_at: new Date(now).toISOString(),
      preferences: structuredClone(this.preferences),
      source_status: { run_history: runHistoryStatus },
      unread_count: items.filter((item) => item.unread).length,
      ready_unread_count: visibleUnread.length - heldUnread.length,
      held_count: items.filter((item) => item.delivery_state === "held").length,
      held_unread_count: heldUnread.length,
      filtered_count: items.filter((item) => item.delivery_state === "filtered").length,
      filtered_unread_count: items.filter((item) => item.delivery_state === "filtered" && item.unread).length,
      truncated: actionable.length > 200,
      items: actionable.slice(0, 200),
    };
  }

  async markRead(
    input,
    state,
    runHistoryEvents = [],
    runHistoryStatus = "available",
  ) {
    return await this.serial(async () => {
      if (!exactKeys(input, ["id", "event_id"]) ||
          !validId(input.id) || !validEventId(input.event_id))
        throw fail("invalid_notification_read");
      const item = notificationSources(state, runHistoryEvents).find((candidate) => candidate.id === input.id);
      if (!item) throw fail("notification_not_found");
      if (item.event_id !== input.event_id) throw fail("notification_changed");
      const reads = {
        ...this.reads,
        [input.id]: {
          event_id: input.event_id,
          read_at: new Date().toISOString(),
        },
      };
      const ordered = Object.entries(reads)
        .sort((a, b) => Date.parse(a[1].read_at) - Date.parse(b[1].read_at))
        .slice(-5000);
      const nextReads = Object.fromEntries(ordered);
      await this.persist(this.preferences, nextReads);
      this.reads = nextReads;
      return this.snapshot(state, Date.now(), runHistoryEvents, runHistoryStatus);
    });
  }

  async updatePreferences(
    input,
    state,
    runHistoryEvents = [],
    runHistoryStatus = "available",
  ) {
    return await this.serial(async () => {
      const preferences = validatePreferences(input);
      await this.persist(preferences, this.reads);
      this.preferences = preferences;
      return this.snapshot(state, Date.now(), runHistoryEvents, runHistoryStatus);
    });
  }
}
