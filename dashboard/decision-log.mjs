import { randomBytes } from "node:crypto";

const statuses = ["current", "replaced", "withdrawn", "hold"];

function required(value, label, max) {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new Error(`${label} must be a non-empty string (max ${max} characters)`);
  return value.trim();
}

function optional(value, label, max) {
  if (value == null || value === "") return "";
  if (typeof value !== "string" || value.length > max)
    throw new Error(`${label} must be a string (max ${max} characters)`);
  return value.trim();
}

function decisionLog(state) {
  state.decision_log ||= { schema: 1, records: [] };
  return state.decision_log;
}

function byId(state) {
  return new Map((state.decision_log?.records || []).map((record) => [record.id, record]));
}

export function recordDecision(state, input) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Expected an object");
  const actionFields =
    input.action === "hold" || input.action === "withdraw"
      ? ["action", "id", "reason"]
      : [
          "action",
          "id",
          "subject",
          "policy",
          "rationale",
          "change_summary",
          "status",
          "status_reason",
          "task_id",
          "question_id",
          "supersedes_id",
        ];
  if (Object.keys(input).some((key) => !actionFields.includes(key)))
    throw new Error("Unknown decision field");
  const log = decisionLog(state);
  if (input.action === "hold" || input.action === "withdraw") {
    const record = byId(state).get(required(input.id, "id", 160));
    if (!record) throw new Error("Decision not found");
    if (record.status !== "current")
      throw new Error("Only a current decision can be held or withdrawn");
    record.status = input.action === "hold" ? "hold" : "withdrawn";
    record.status_changed_at = new Date().toISOString();
    record.status_reason = optional(input.reason, "reason", 2000);
    return record;
  }
  if (input.action !== undefined && input.action !== "record")
    throw new Error("Invalid decision action");

  const subject = required(input.subject, "subject", 200);
  const policy = required(input.policy, "policy", 8000);
  const rationale = optional(input.rationale, "rationale", 8000);
  const changeSummary = optional(input.change_summary, "change_summary", 4000);
  const status = input.status || "current";
  if (!["current", "hold"].includes(status))
    throw new Error("New decisions must be current or hold");
  const records = log.records;
  const supersedesId = input.supersedes_id
    ? required(input.supersedes_id, "supersedes_id", 160)
    : null;
  const sameSubject = records.filter((record) => record.subject === subject);
  const current = sameSubject.find((record) => record.status === "current");
  let previous = null;
  if (supersedesId) {
    previous = byId(state).get(supersedesId);
    if (!previous) throw new Error("Decision to replace not found");
    if (previous.subject !== subject)
      throw new Error("A decision can only replace the same subject");
    if (!["current", "hold", "withdrawn"].includes(previous.status))
      throw new Error("Only a current, held, or withdrawn decision can be replaced");
    if (current && current.id !== previous.id)
      throw new Error("Another current decision exists for this subject");
    if (previous.replaced_by_id)
      throw new Error("Decision already has a replacement");
    if (status !== "current")
      throw new Error("A replacement decision must be current");
  } else if (sameSubject.length) {
    throw new Error("Choose the prior decision explicitly before recording another version");
  }

  let question = null;
  if (input.question_id) {
    const source = state.questions.find((item) => item.id === input.question_id);
    if (!source || source.answer === null)
      throw new Error("Choose a question with a saved answer");
    const contract = state.question_contracts?.cards?.[source.id];
    question = {
      id: source.id,
      revision: contract?.revision || null,
      status: contract?.status || "unversioned",
      question: source.question,
      answer: source.answer,
      answered_at: source.answered_at,
    };
  }
  const taskId = input.task_id ? required(input.task_id, "task_id", 160) : null;
  if (taskId && !state.tasks.some((task) => task.id === taskId))
    throw new Error("Task not found");

  const id = input.id
    ? required(input.id, "id", 160)
    : `decision_${randomBytes(12).toString("hex")}`;
  if (records.some((record) => record.id === id))
    throw new Error("Decision id already exists");
  const now = new Date().toISOString();
  const record = {
    id,
    subject,
    policy,
    rationale,
    change_summary: changeSummary,
    status,
    created_by: "human",
    created_at: now,
    status_changed_at: status === "current" ? null : now,
    status_reason:
      status === "hold"
        ? optional(input.status_reason, "status_reason", 2000)
        : "",
    task_id: taskId,
    question,
    supersedes_id: supersedesId,
    replaced_by_id: null,
  };
  if (previous) {
    previous.status = "replaced";
    previous.status_changed_at = now;
    previous.replaced_by_id = id;
  }
  records.push(record);
  return record;
}

export function validateDecisionLog(state) {
  const log = state.decision_log;
  if (log === undefined) return;
  if (
    !log ||
    log.schema !== 1 ||
    !Array.isArray(log.records)
  )
    throw new Error("Invalid decision log");
  const ids = new Set();
  const currentSubjects = new Set();
  for (const record of log.records) {
    if (
      !record ||
      typeof record !== "object" ||
      typeof record.id !== "string" ||
      !record.id ||
      ids.has(record.id) ||
      typeof record.subject !== "string" ||
      !record.subject.trim() ||
      record.subject.length > 200 ||
      typeof record.policy !== "string" ||
      !record.policy.trim() ||
      record.policy.length > 8000 ||
      typeof record.rationale !== "string" ||
      record.rationale.length > 8000 ||
      typeof record.change_summary !== "string" ||
      record.change_summary.length > 4000 ||
      !statuses.includes(record.status) ||
      record.created_by !== "human" ||
      !Number.isFinite(Date.parse(record.created_at)) ||
      (record.status_changed_at !== null &&
        !Number.isFinite(Date.parse(record.status_changed_at))) ||
      (record.status !== "current" && record.status_changed_at === null) ||
      (record.status === "current" && record.status_changed_at !== null) ||
      (record.status === "replaced") !== Boolean(record.replaced_by_id) ||
      typeof record.status_reason !== "string" ||
      (record.task_id !== null && typeof record.task_id !== "string") ||
      (record.supersedes_id !== null && typeof record.supersedes_id !== "string") ||
      (record.replaced_by_id !== null && typeof record.replaced_by_id !== "string")
    )
      throw new Error("Invalid decision record");
    if (record.question !== null) {
      if (
        !record.question ||
        typeof record.question.id !== "string" ||
        (record.question.revision !== null &&
          !Number.isInteger(record.question.revision)) ||
        typeof record.question.status !== "string" ||
        typeof record.question.question !== "string" ||
        typeof record.question.answer !== "string" ||
        !Number.isFinite(Date.parse(record.question.answered_at))
      )
        throw new Error("Invalid decision question reference");
    }
    ids.add(record.id);
    if (record.status === "current") {
      if (currentSubjects.has(record.subject))
        throw new Error("Multiple current decisions for one subject");
      currentSubjects.add(record.subject);
    }
  }
  const records = new Map(log.records.map((record) => [record.id, record]));
  const positions = new Map(log.records.map((record, index) => [record.id, index]));
  for (const record of log.records) {
    if (record.supersedes_id) {
      const previous = records.get(record.supersedes_id);
      if (
        !previous ||
        positions.get(previous.id) >= positions.get(record.id) ||
        previous.subject !== record.subject ||
        previous.status !== "replaced" ||
        previous.replaced_by_id !== record.id
      )
        throw new Error("Broken decision replacement link");
    }
    if (record.replaced_by_id) {
      const replacement = records.get(record.replaced_by_id);
      if (
        !replacement ||
        positions.get(replacement.id) <= positions.get(record.id) ||
        replacement.subject !== record.subject ||
        replacement.supersedes_id !== record.id ||
        record.status !== "replaced"
      )
        throw new Error("Broken decision replacement link");
    }
  }
}

export function publicDecisionReferences(state) {
  const records = byId(state);
  return (state.tasks || []).map((task) => {
    if (!task.policy_decision_id) return task;
    const record = records.get(task.policy_decision_id);
    let replacement = record?.replaced_by_id
      ? records.get(record.replaced_by_id)
      : null;
    while (replacement?.status === "replaced" && replacement.replaced_by_id)
      replacement = records.get(replacement.replaced_by_id);
    const confirmationRequired = !record || record.status !== "current";
    return {
      ...task,
      decision_reference: {
        id: task.policy_decision_id,
        status: record?.status || "missing",
        policy: record?.policy || null,
        replacement_id: replacement?.id || null,
        replacement_policy: replacement?.policy || null,
        replacement_status: replacement?.status || null,
        confirmation_required: confirmationRequired,
        reason: !record
          ? "参照先の決定が見つかりません"
          : record.status === "replaced"
            ? "置換済みの決定を参照しています。現行方針を確認してください"
            : record.status === "hold"
              ? "保留中の決定を参照しています。再確認してください"
              : record.status === "withdrawn"
                ? "撤回済みの決定を参照しています。再確認してください"
                : "",
      },
    };
  });
}
