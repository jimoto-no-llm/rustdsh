// Reported attention is display data: it never grants permission or runs actions.
const impacts = ["low", "medium", "high", "critical"];
const kinds = ["failure", "dependency"];
const actions = ["reported", "updated", "resolved", "replaced", "reopened"];
const own = (value, key) => Object.hasOwn(value, key);
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
// JSON escapes lone UTF-16 surrogates before URI encoding; valid legacy IDs
// must not be able to break the entire inbox while constructing a group key.
const keyPart = (value) => encodeURIComponent(JSON.stringify(value));

function object(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some((key) => !keys.includes(key)))
    throw new Error(`Invalid ${label}`);
}
function text(value, max, label) {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new Error(`Invalid ${label}`);
  return value;
}
function timestamp(value, label) {
  if (typeof value !== "string") throw new Error(`Invalid ${label}`);
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) throw new Error(`Invalid ${label}; use an ISO date-time with a timezone`);
  const [, year, month, day, hour, minute, second, zone] = match;
  const leap = Number(year) % 4 === 0 && (Number(year) % 100 !== 0 || Number(year) % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (Number(month) < 1 || Number(month) > 12 || Number(day) < 1 ||
      Number(day) > days[Number(month) - 1] || Number(hour) > 23 ||
      Number(minute) > 59 || Number(second) > 59 ||
      (zone !== "Z" && (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4)) > 59)) ||
      !Number.isFinite(Date.parse(value))) throw new Error(`Invalid ${label}`);
  return value;
}

export function normalizeAttention(value, source) {
  if (!["task", "question"].includes(source)) throw new Error("Invalid attention source");
  object(value, ["cause_id", "deadline", "impact", "next_action", ...(source === "task" ? ["kind"] : [])], "attention");
  const result = {};
  if (own(value, "cause_id"))
    result.cause_id = text(value.cause_id, 160, "attention cause_id");
  if (source === "task") {
    if (!kinds.includes(value.kind)) throw new Error("Invalid attention kind");
    result.kind = value.kind;
  }
  if (own(value, "deadline")) result.deadline = timestamp(value.deadline, "attention deadline");
  if (own(value, "impact")) {
    if (!impacts.includes(value.impact)) throw new Error("Invalid attention impact");
    result.impact = value.impact;
  }
  if (own(value, "next_action")) result.next_action = text(value.next_action, 2000, "attention next_action");
  return result;
}

export function attentionSchema(source) {
  const properties = {
    cause_id: { type: "string", minLength: 1, maxLength: 160 },
    deadline: { type: "string", format: "date-time", description: "Reported attention deadline; it does not expire an answer or authorize an action." },
    impact: { enum: impacts },
    next_action: { type: "string", minLength: 1, maxLength: 2000 },
  };
  if (source === "task") properties.kind = { enum: kinds };
  const schema = { type: "object", properties, required: source === "task" ? ["kind"] : [], additionalProperties: false };
  return source === "task" ? { anyOf: [schema, { type: "null" }] } : schema;
}

// Legacy blocked is deliberately unclassified, not an inferred failure/dependency.
function taskReport(task) {
  if (!task || task.status === "done") return null;
  if (own(task, "attention")) return task.attention;
  return task.status === "blocked" ? { kind: "blocked", blocker: task.blocker || "" } : null;
}

function normalizeSnapshot(value) {
  if (value?.kind !== "blocked") return normalizeAttention(value, "task");
  object(value, ["kind", "blocker"], "attention snapshot");
  if (typeof value.blocker !== "string" || value.blocker.length > 2000)
    throw new Error("Invalid attention blocker");
  return { kind: "blocked", blocker: value.blocker };
}

// Only server-generated history is copied. Explicit null also suppresses legacy fallback.
export function updateTaskAttention(task, previous, input, at) {
  if (own(input, "attention_history")) throw new Error("attention_history is server-managed");
  if (previous && own(previous, "attention")) task.attention = previous.attention;
  if (previous && own(previous, "attention_history")) task.attention_history = previous.attention_history;
  if (!own(input, "attention") && task.attention === null && task.status === "blocked" && previous?.status !== "blocked")
    delete task.attention; // A new stopped episode can use the unchanged legacy report format.
  if (own(input, "attention")) {
    task.attention = input.attention === null ? null : normalizeAttention(input.attention, "task");
    if (task.status === "done" && task.attention !== null)
      throw new Error("A done task cannot have active attention");
  }
  if (task.status === "done" && own(task, "attention")) task.attention = null;
  const next = taskReport(task);
  const before = taskReport(previous);
  if (JSON.stringify(next) === JSON.stringify(before) && (!next || task.blocker === previous?.blocker)) return;
  const history = previous?.attention_history || [];
  const action = next === null ? "resolved" : before === null ?
    (history.length ? "reopened" : "reported") :
    before.cause_id !== next.cause_id ? "replaced" : "updated";
  task.attention_history = [...history, {
    sequence: history.length + 1,
    action,
    recorded_at: at,
    title: next === null ? previous.title : task.title,
    blocker: (next === null ? previous.blocker : task.blocker) || "",
    previous_blocker: previous?.blocker || "",
    attention: next ?? before,
    previous_attention: before,
  }];
}

export function validateAttentionState(state) {
  for (const task of state.tasks) {
    if (own(task, "attention") && task.attention !== null) normalizeAttention(task.attention, "task");
    if (!own(task, "attention_history")) continue;
    if (!Array.isArray(task.attention_history)) throw new Error("Invalid attention history");
    for (const [index, item] of task.attention_history.entries()) {
      object(item, ["sequence", "action", "recorded_at", "title", "blocker", "previous_blocker", "attention", "previous_attention"], "attention history record");
      if (item.sequence !== index + 1 || !actions.includes(item.action)) throw new Error("Invalid attention history sequence or action");
      timestamp(item.recorded_at, "attention history timestamp");
      text(item.title, 1000, "attention history title");
      for (const key of ["blocker", "previous_blocker"]) {
        if (own(item, key) && (typeof item[key] !== "string" || item[key].length > 2000))
          throw new Error("Invalid attention history blocker");
      }
      normalizeSnapshot(item.attention);
      if (item.previous_attention !== null) normalizeSnapshot(item.previous_attention);
    }
    const last = task.attention_history.at(-1);
    if (last && JSON.stringify(last.action === "resolved" ? null : normalizeSnapshot(last.attention)) !==
        JSON.stringify(taskReport(task) == null ? null : normalizeSnapshot(taskReport(task))))
      throw new Error("Attention history does not match current attention");
  }
  for (const question of state.questions) {
    if (own(question, "attention")) normalizeAttention(question.attention, "question");
    if (own(question, "attention_history")) throw new Error("Invalid question attention history");
  }
}

export function questionAttentionStatus(state, question, now = Date.now()) {
  if (question.answer !== null) return "answered";
  const card = state.question_contracts?.cards[question.id];
  if (!card) return "open";
  if (card.status !== "open") return card.status;
  const expires = card.snapshot?.decision?.expires_at;
  return expires && Date.parse(expires) <= now ? "expired" : "open";
}

export function buildAttentionHistory(state, now = Date.now()) {
  const history = (state.tasks || []).flatMap((task) =>
    (task.attention_history || []).map((entry) => ({ ...entry, source: "task", id: task.id })),
  );
  const answered = new Set();
  for (const reply of state.feedback || []) {
    if (reply.type !== "question_answered") continue;
    answered.add(reply.question_id);
    history.push({ source: "question", id: reply.question_id, action: "answered",
      title: reply.question, recorded_at: reply.created_at, attention: reply.attention || {} });
  }
  for (const question of state.questions || []) {
    const status = questionAttentionStatus(state, question, now);
    if (status === "open" || (status === "answered" && answered.has(question.id))) continue;
    const card = state.question_contracts?.cards[question.id];
    history.push({ source: "question", id: question.id, action: status,
      title: question.question, attention: question.attention || {},
      recorded_at: status === "answered" ? question.answered_at :
        status === "expired" ? card.snapshot.decision.expires_at : card.updated_at });
  }
  return history;
}

export function buildInbox(state, sort = "priority", now = Date.now()) {
  if (!["priority", "deadline", "impact", "next_action"].includes(sort)) throw new Error("Invalid inbox sort");
  const items = [];
  for (const task of state.tasks) {
    const attention = taskReport(task);
    if (!attention) continue;
    items.push({ source: "task", id: task.id, kind: attention.kind, title: task.title,
      cause_id: attention.cause_id ?? null, deadline: attention.deadline ?? null,
      impact: attention.impact ?? null, next_action: attention.next_action || (attention.kind === "failure" ? "失敗内容を確認" : "停止理由を確認"),
      action_rank: attention.next_action ? 1 : 2, urgency: "normal",
      blocker: task.blocker || attention.blocker || "",
      reported_at: task.attention_history?.[0]?.recorded_at ?? task.updated_at ?? null });
  }
  for (const question of state.questions) {
    if (questionAttentionStatus(state, question, now) !== "open") continue;
    const attention = question.attention || {};
    items.push({ source: "question", id: question.id, kind: "question", title: question.question,
      cause_id: attention.cause_id ?? null, deadline: attention.deadline ?? null,
      impact: attention.impact ?? null, next_action: attention.next_action || "質問に回答",
      action_rank: 0, urgency: question.urgency || "normal",
      reported_at: question.created_at ?? null });
  }
  const groups = new Map();
  const project = keyPart(state.project.id);
  for (const { cause_id, ...item } of items) {
    const id = cause_id === null ? `item:${project}:${item.source}:${keyPart(item.id)}` :
      `cause:${project}:${keyPart(cause_id)}`;
    if (!groups.has(id)) groups.set(id, { id, cause_id, deadline: null, impact: null, next_action: "", urgency: "normal", action_rank: 2, reported_at: null, items: [] });
    const group = groups.get(id);
    group.items.push(item);
    if (item.deadline && (!group.deadline || Date.parse(item.deadline) < Date.parse(group.deadline) ||
        (Date.parse(item.deadline) === Date.parse(group.deadline) && compare(item.deadline, group.deadline) < 0))) group.deadline = item.deadline;
    if (item.impact && impacts.indexOf(item.impact) > impacts.indexOf(group.impact)) group.impact = item.impact;
    if (["normal", "high", "critical"].indexOf(item.urgency) > ["normal", "high", "critical"].indexOf(group.urgency)) group.urgency = item.urgency;
    if (item.reported_at && (!group.reported_at || item.reported_at < group.reported_at)) group.reported_at = item.reported_at;
  }
  for (const group of groups.values()) {
    group.items.sort((a, b) => a.action_rank - b.action_rank || compare(a.id, b.id));
    group.next_action = group.items[0].next_action;
    group.action_rank = group.items[0].action_rank;
  }
  const deadline = (group) => group.deadline ? Date.parse(group.deadline) : Infinity;
  const impact = (group) => group.impact ? -impacts.indexOf(group.impact) : Infinity;
  const priority = (a, b) =>
    compare(["normal", "high", "critical"].indexOf(b.urgency), ["normal", "high", "critical"].indexOf(a.urgency)) ||
    compare(deadline(a), deadline(b)) || compare(impact(a), impact(b)) ||
    compare(a.action_rank, b.action_rank) || compare(a.reported_at || "~", b.reported_at || "~") || compare(a.id, b.id);
  const result = [...groups.values()].sort((a, b) => {
    const order = sort === "deadline" ? compare(deadline(a), deadline(b)) :
      sort === "impact" ? compare(impact(a), impact(b)) :
      sort === "next_action" ? compare(a.action_rank, b.action_rank) : 0;
    return order || priority(a, b);
  });
  return { groups: result, itemCount: items.length };
}
