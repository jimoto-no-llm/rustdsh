import { createHash, randomUUID } from "node:crypto";

export const backupMaximum = 2 * 1024 * 1024;
const types = ["tasks", "answers", "decisions", "evidence"];
const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const integer = (v) => Number.isSafeInteger(v) && v >= 0;
const identifier = (v) =>
  typeof v === "string" &&
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(v) &&
  !Object.hasOwn(Object.prototype, v) &&
  !/^[a-f0-9]{64}$/i.test(v) &&
  !sensitive(v);
const digest = (v) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const time = (v) =>
  typeof v === "string" &&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v) &&
  Number.isFinite(Date.parse(v)) &&
  new Date(v).toISOString() === v;
function check(ok, code, status = 400) {
  if (ok) return;
  const error = new Error(code);
  error.status = status;
  throw error;
}
function keys(v, allowed, required = allowed) {
  check(
    object(v) &&
      Object.keys(v).every((k) => allowed.includes(k)) &&
      required.every((k) => Object.hasOwn(v, k)),
    "invalid_backup_fields",
  );
}
function canonical(v) {
  if (Array.isArray(v)) return v.map(canonical);
  if (object(v))
    return Object.fromEntries(
      Object.keys(v)
        .sort()
        .map((k) => [k, canonical(v[k])]),
    );
  return v;
}
export const backupHash = (v) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(v)))
    .digest("hex");
function sensitive(v) {
  if (
    /(^|\n)\s*(?:const|let|var|class|function|def|import|export)\s+[^\n]*[=({;]/.test(
      v,
    )
  )
    return true;
  if (
    /\b(?:Bearer|Basic)\s+\S+|(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|credential)\s*[=:]|(?:sk[-_]|gh[pousr]_|github_pat_|xox[baprs]-)[A-Za-z0-9_-]{6,}|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|-----BEGIN .*PRIVATE KEY-----|\b[a-f0-9]{64}\b|```/i.test(
      v,
    )
  )
    return true;
  for (const match of v.matchAll(/https?:\/\/[^\s<>"`]+/gi)) {
    try {
      const url = new URL(match[0]);
      if (url.username || url.password || url.search || url.hash) return true;
    } catch {
      return true;
    }
  }
  return false;
}
function safeText(v) {
  return (
    typeof v === "string" &&
    v.trim().length > 0 &&
    v.length <= 8000 &&
    !/[\x00-\x08\x0b-\x1f\x7f\ud800-\udfff]/u.test(v) &&
    !sensitive(v)
  );
}
export function backupSelection(input) {
  keys(
    input,
    ["types", "task_ids", "question_ids", "evidence_ids", "since", "until"],
    ["types"],
  );
  check(
    Array.isArray(input.types) &&
      input.types.length > 0 &&
      input.types.every((v) => types.includes(v)) &&
      new Set(input.types).size === input.types.length,
    "invalid_backup_types",
  );
  const result = { types: [...input.types].sort() };
  for (const name of ["task_ids", "question_ids", "evidence_ids"]) {
    const v = input[name] ?? null;
    check(
      v === null ||
        (Array.isArray(v) &&
          v.length <= 2000 &&
          v.every(identifier) &&
          new Set(v).size === v.length),
      "invalid_backup_selection_ids",
    );
    result[name] = v === null ? null : [...v].sort();
  }
  result.since = input.since ?? null;
  result.until = input.until ?? null;
  check(
    [result.since, result.until].every((v) => v === null || time(v)) &&
      (result.since === null ||
        result.until === null ||
        result.since <= result.until),
    "invalid_backup_time_range",
  );
  return result;
}
const decisionId = (id, revision) =>
  "decision_" + backupHash([id, revision]).slice(0, 32);
const policy = () => ({
  mode: "historical-only",
  execution_authorized: false,
  event_subscriptions_restored: false,
  content_mode: "withheld-or-reviewed-replacement",
});
export function createHistoryBackup(state, acceptance, input, review = null) {
  const selection = backupSelection(input),
    records = {
      tasks: [],
      questions: [],
      answers: [],
      decisions: [],
      evidence: [],
    };
  check(
    !selection.types.includes("evidence") ||
      (selection.since === null && selection.until === null),
    "backup_evidence_range_requires_ids",
  );
  const sourceTasks = new Map(state.tasks.map((v) => [v.id, v]));
  const sourceQuestions = new Map(state.questions.map((v) => [v.id, v]));
  check(
    sourceTasks.size === state.tasks.length &&
      sourceQuestions.size === state.questions.length,
    "backup_duplicate_source_ids",
  );
  const cards = state.question_contracts?.cards ?? {};
  const decisions = new Map(),
    questions = new Map(),
    tasks = new Map();
  const selected = (list, id) => list === null || list.includes(id);
  const within = (v) =>
    time(v) &&
    (selection.since === null || v >= selection.since) &&
    (selection.until === null || v <= selection.until);
  const cardVersions = (id) =>
    Object.hasOwn(cards, id) ? [...cards[id].history, cards[id]] : [];
  function addTask(id) {
    const v = sourceTasks.get(id);
    check(v, "backup_task_reference_missing");
    tasks.set(id, {
      id,
      title: null,
      status: v.status,
      milestone: null,
      blocker: null,
      updated_at: v.updated_at,
    });
  }
  function addQuestion(id, taskId = null) {
    const v = sourceQuestions.get(id);
    check(v, "backup_question_reference_missing");
    const prior = questions.get(id);
    // A revision may have changed its target. The individual decision keeps it.
    questions.set(id, { id, question: null, created_at: v.created_at });
    if (prior) questions.set(id, prior);
    if (taskId) addTask(taskId);
  }
  function addDecision(id, card) {
    const d = card.snapshot.decision,
      taskId = d.target?.task_id ?? null;
    addQuestion(id, taskId);
    const value = {
      id: decisionId(id, card.revision),
      question_id: id,
      task_id: taskId,
      revision: card.revision,
      kind: d.kind,
      source_status: card.status,
      updated_at: card.updated_at,
      choices: d.choices.map((v) => ({ id: v.id, label: null })),
      diff: null,
      impact: null,
      conditions: null,
    };
    decisions.set(value.id, value);
    return value.id;
  }
  function questionSelected(id, card) {
    return (
      selected(selection.question_ids, id) &&
      (selection.task_ids === null ||
        selection.task_ids.includes(card?.snapshot.decision.target?.task_id))
    );
  }
  for (const id of selection.task_ids ?? [])
    check(sourceTasks.has(id), "backup_selected_task_missing");
  for (const id of selection.question_ids ?? [])
    check(sourceQuestions.has(id), "backup_selected_question_missing");
  if (selection.types.includes("tasks"))
    for (const v of sourceTasks.values())
      if (selected(selection.task_ids, v.id) && within(v.updated_at))
        addTask(v.id);
  if (selection.types.includes("decisions"))
    for (const id of sourceQuestions.keys())
      for (const card of cardVersions(id))
        if (questionSelected(id, card) && within(card.updated_at))
          addDecision(id, card);
  if (selection.types.includes("answers"))
    for (const v of state.feedback) {
      const card =
        v.contract_revision === undefined
          ? null
          : cardVersions(v.question_id).find(
              (c) => c.revision === v.contract_revision,
            );
      if (!questionSelected(v.question_id, card) || !within(v.created_at))
        continue;
      check(
        v.contract_revision === undefined || card,
        "backup_answer_revision_missing",
      );
      addQuestion(v.question_id);
      records.answers.push({
        id: `answer_${v.sequence}`,
        sequence: v.sequence,
        question_id: v.question_id,
        decision_id: card ? addDecision(v.question_id, card) : null,
        choice_id: v.choice_id ?? null,
        answer: null,
        created_at: v.created_at,
      });
    }
  if (selection.types.includes("evidence")) {
    check(
      acceptance === null || acceptance.project_id === state.project.id,
      "backup_evidence_project_mismatch",
    );
    for (const id of selection.evidence_ids ?? [])
      check(
        acceptance?.evidence.some((v) => v.evidence_id === id),
        "backup_selected_evidence_missing",
      );
    for (const v of acceptance?.evidence ?? []) {
      if (
        !selected(selection.evidence_ids, v.evidence_id) ||
        !selected(selection.task_ids, v.task_id)
      )
        continue;
      addTask(v.task_id);
      // Only the index reference is transported. No command, log, image, code,
      // file path or signed URL is opened or copied; freshness must be rechecked.
      records.evidence.push({
        id: v.evidence_id,
        task_id: v.task_id,
        criterion_id: v.criterion_id,
        sequence: v.sequence,
        scope: v.scope,
        reference: `rdsh-evidence:${state.project.id}/${v.evidence_id}`,
        freshness: "unverified",
      });
    }
  }
  records.tasks = [...tasks.values()];
  records.questions = [...questions.values()];
  records.decisions = [...decisions.values()];
  for (const list of Object.values(records))
    list.sort((a, b) => a.id.localeCompare(b.id, "en"));
  const archive = {
    format: "rdsh-history",
    schema: 1,
    archive_id: "backup_" + randomUUID(),
    created_at: new Date().toISOString(),
    source: {
      project_id: state.project.id,
      revision: state.revision,
      acceptance_revision: acceptance?.revision ?? null,
    },
    selection,
    policy: policy(),
    records,
    reviewed_fields: [],
    withheld_fields: [],
  };
  const fields = contentFields(records);
  if (review !== null) {
    keys(review, ["source", "selection_digest", "replacements"]);
    check(
      backupHash(review.source) === backupHash(archive.source) &&
        review.selection_digest === backupHash(selection),
      "backup_review_source_changed",
      409,
    );
  } else review = { replacements: [] };
  check(
    Array.isArray(review.replacements) && review.replacements.length <= 10000,
    "invalid_backup_review",
  );
  const replaced = new Set();
  for (const replacement of review.replacements) {
    keys(replacement, ["path", "value"]);
    const field = fields.get(replacement.path);
    check(
      field && !replaced.has(replacement.path) && safeText(replacement.value),
      "invalid_or_sensitive_backup_replacement",
    );
    field.record[field.key] = replacement.value;
    replaced.add(replacement.path);
  }
  archive.reviewed_fields = [...replaced].sort();
  archive.withheld_fields = [...fields.keys()]
    .filter((p) => !replaced.has(p))
    .sort();
  archive.integrity = { algorithm: "sha256", digest: backupHash(archive) };
  validateHistoryBackup(archive);
  return archive;
}
function contentFields(records) {
  const fields = new Map();
  for (const [type, list] of Object.entries(records))
    for (const record of list) {
      const names = {
        tasks: ["title", "milestone", "blocker"],
        questions: ["question"],
        answers: ["answer"],
        decisions: ["diff", "impact", "conditions"],
        evidence: [],
      }[type];
      for (const key of names)
        fields.set(`${type}/${record.id}/${key}`, { record, key });
      if (type === "decisions")
        for (const choice of record.choices)
          fields.set(`${type}/${record.id}/choices/${choice.id}/label`, {
            record: choice,
            key: "label",
          });
    }
  return fields;
}
export function validateHistoryBackup(a) {
  check(
    Buffer.byteLength(JSON.stringify(a)) <= backupMaximum,
    "backup_too_large",
  );
  keys(a, [
    "format",
    "schema",
    "archive_id",
    "created_at",
    "source",
    "selection",
    "policy",
    "records",
    "reviewed_fields",
    "withheld_fields",
    "integrity",
  ]);
  check(
    a.format === "rdsh-history" &&
      a.schema === 1 &&
      typeof a.archive_id === "string" &&
      /^backup_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
        a.archive_id,
      ) &&
      time(a.created_at),
    "invalid_backup_header",
  );
  keys(a.source, ["project_id", "revision", "acceptance_revision"]);
  check(
    typeof a.source.project_id === "string" &&
      /^[a-f0-9]{16}$/.test(a.source.project_id) &&
      integer(a.source.revision) &&
      (a.source.acceptance_revision === null ||
        integer(a.source.acceptance_revision)),
    "invalid_backup_source",
  );
  check(
    backupHash(backupSelection(a.selection)) === backupHash(a.selection),
    "invalid_backup_selection",
  );
  check(
    backupHash(a.policy) === backupHash(policy()),
    "backup_cannot_restore_authority",
  );
  keys(a.records, ["tasks", "questions", "answers", "decisions", "evidence"]);
  for (const list of Object.values(a.records))
    check(
      Array.isArray(list) &&
        list.length <= 2000 &&
        list.every((r) => object(r) && identifier(r.id)) &&
        new Set(list.map((r) => r.id)).size === list.length,
      "invalid_backup_records",
    );
  const taskIds = new Set(a.records.tasks.map((r) => r.id)),
    questionIds = new Set(a.records.questions.map((r) => r.id)),
    decisionIds = new Map(a.records.decisions.map((r) => [r.id, r]));
  for (const r of a.records.tasks) {
    keys(r, ["id", "title", "status", "milestone", "blocker", "updated_at"]);
    check(
      ["todo", "doing", "done", "blocked"].includes(r.status) &&
        time(r.updated_at),
      "invalid_backup_task",
    );
  }
  for (const r of a.records.questions) {
    keys(r, ["id", "question", "created_at"]);
    check(time(r.created_at), "invalid_backup_question");
  }
  for (const r of a.records.decisions) {
    keys(r, [
      "id",
      "question_id",
      "task_id",
      "revision",
      "kind",
      "source_status",
      "updated_at",
      "choices",
      "diff",
      "impact",
      "conditions",
    ]);
    check(
      questionIds.has(r.question_id) &&
        (r.task_id === null || taskIds.has(r.task_id)) &&
        integer(r.revision) &&
        r.revision > 0 &&
        r.id === decisionId(r.question_id, r.revision) &&
        ["consultation", "approval"].includes(r.kind) &&
        ["open", "answered", "cancelled", "superseded"].includes(
          r.source_status,
        ) &&
        time(r.updated_at) &&
        Array.isArray(r.choices) &&
        r.choices.length <= 8,
      "invalid_backup_decision",
    );
    for (const c of r.choices) {
      keys(c, ["id", "label"]);
      check(identifier(c.id), "invalid_backup_choice");
    }
    check(
      new Set(r.choices.map((c) => c.id)).size === r.choices.length,
      "duplicate_backup_choice",
    );
  }
  const sequences = new Set();
  for (const r of a.records.answers) {
    keys(r, [
      "id",
      "sequence",
      "question_id",
      "decision_id",
      "choice_id",
      "answer",
      "created_at",
    ]);
    const d = decisionIds.get(r.decision_id);
    check(
      integer(r.sequence) &&
        r.sequence > 0 &&
        !sequences.has(r.sequence) &&
        r.id === `answer_${r.sequence}` &&
        questionIds.has(r.question_id) &&
        (r.decision_id === null
          ? r.choice_id === null
          : d?.question_id === r.question_id &&
            (r.choice_id === null ||
              d.choices.some((c) => c.id === r.choice_id))) &&
        time(r.created_at),
      "invalid_backup_answer_reference",
    );
    sequences.add(r.sequence);
  }
  for (const r of a.records.evidence) {
    keys(r, [
      "id",
      "task_id",
      "criterion_id",
      "sequence",
      "scope",
      "reference",
      "freshness",
    ]);
    check(
      /^evi_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
        r.id,
      ) &&
        taskIds.has(r.task_id) &&
        identifier(r.criterion_id) &&
        integer(r.sequence) &&
        r.sequence > 0 &&
        ["full", "partial"].includes(r.scope) &&
        r.reference === `rdsh-evidence:${a.source.project_id}/${r.id}` &&
        r.freshness === "unverified",
      "invalid_backup_evidence_reference",
    );
  }
  const fields = contentFields(a.records);
  for (const [p, { record, key }] of fields)
    check(
      record[key] === null || safeText(record[key]),
      "sensitive_backup_content",
    );
  const reviewed = [...fields]
    .filter(([, f]) => f.record[f.key] !== null)
    .map(([p]) => p)
    .sort();
  const withheld = [...fields.keys()]
    .filter((p) => !reviewed.includes(p))
    .sort();
  check(
    JSON.stringify(a.reviewed_fields) === JSON.stringify(reviewed) &&
      JSON.stringify(a.withheld_fields) === JSON.stringify(withheld),
    "invalid_backup_content_review",
  );
  keys(a.integrity, ["algorithm", "digest"]);
  const { integrity, ...body } = a;
  check(
    integrity.algorithm === "sha256" &&
      digest(integrity.digest) &&
      backupHash(body) === integrity.digest,
    "backup_integrity_mismatch",
  );
  return a;
}
export function validateRestoredHistory(state) {
  if (state.history_backups === undefined) return;
  check(
    Array.isArray(state.history_backups) && state.history_backups.length <= 100,
    "invalid_restored_history",
  );
  const archiveIds = new Set(),
    ids = Object.fromEntries(
      ["tasks", "questions", "decisions", "evidence"].map((k) => [
        k,
        new Set(),
      ]),
    );
  for (const entry of state.history_backups) {
    keys(entry, ["archive", "restored_at"]);
    validateHistoryBackup(entry.archive);
    check(
      time(entry.restored_at) && !archiveIds.has(entry.archive.archive_id),
      "duplicate_restored_archive",
    );
    archiveIds.add(entry.archive.archive_id);
    for (const [kind, set] of Object.entries(ids))
      for (const r of entry.archive.records[kind]) {
        check(!set.has(r.id), "backup_id_collision", 409);
        set.add(r.id);
      }
  }
  check(
    Buffer.byteLength(JSON.stringify(state.history_backups)) <= 8 * 1024 * 1024,
    "restored_history_too_large",
  );
  validateHistoryConflicts(state, ids);
  return ids;
}
export function validateHistoryConflicts(state, ids) {
  if (!ids) return;
  for (const [kind, list] of [
    ["tasks", state.tasks],
    ["questions", state.questions],
  ])
    for (const r of list)
      check(!ids[kind].has(r.id), "backup_id_collision", 409);
}
export function restoreHistoryBackup(
  state,
  input,
  evidenceIds = [],
  acceptanceTaskIds = [],
) {
  keys(input, ["archive", "expected_revision"]);
  validateHistoryBackup(input.archive);
  check(
    integer(input.expected_revision) &&
      input.expected_revision === state.revision,
    "backup_restore_revision_changed",
    409,
  );
  check(
    !input.archive.records.evidence.some((r) => evidenceIds.includes(r.id)),
    "backup_id_collision",
    409,
  );
  check(
    !input.archive.records.tasks.some((r) => acceptanceTaskIds.includes(r.id)),
    "backup_id_collision",
    409,
  );
  state.history_backups ||= [];
  state.history_backups.push({
    archive: structuredClone(input.archive),
    restored_at: new Date().toISOString(),
  });
  validateRestoredHistory(state);
  return {
    archive_id: input.archive.archive_id,
    target_project_id: state.project.id,
    mode: "historical-only",
    execution_authorized: false,
  };
}
