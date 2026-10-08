import { createHash } from "node:crypto";

const own = (value) =>
  value && typeof value === "object" && !Array.isArray(value);
function check(condition, message, conflict = false) {
  if (condition) return;
  const error = new Error(message);
  if (conflict) error.status = 409;
  throw error;
}
function keys(value, allowed) {
  check(
    own(value) && Object.keys(value).every((key) => allowed.includes(key)),
    "Unknown question contract field",
  );
}
function text(value, label, max = 2000) {
  check(
    typeof value === "string" && value.trim() && value.length <= max,
    `Invalid ${label}`,
  );
  return value;
}
const optional = (value, label, max) =>
  value == null || value === "" ? "" : text(value, label, max);
const identifier = (value, label) => {
  const result = text(value, label, 160);
  check(
    !["__proto__", "constructor", "prototype"].includes(result),
    `Invalid ${label}`,
  );
  return result;
};
const digest = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
function timestamp(value) {
  if (value == null) return null;
  check(
    typeof value === "string" && Number.isFinite(Date.parse(value)),
    "Invalid expires_at",
  );
  return new Date(value).toISOString();
}

// Optional, separately versioned metadata. Legacy question/feedback field shapes
// and the six-tool inventory remain compatible; no action authority is created.
export function normalizeDecision(input) {
  keys(input, [
    "kind",
    "target",
    "choices",
    "recommended_choice",
    "recommendation_reason",
    "diff",
    "impact",
    "conditions",
    "cost",
    "expires_at",
    "consumer_id",
  ]);
  check(
    ["consultation", "approval"].includes(input.kind),
    "Invalid question kind",
  );
  let target = null;
  if (input.target != null) {
    keys(input.target, [
      "task_id",
      "run_id",
      "session_id",
      "action_id",
      "revision",
    ]);
    target = Object.fromEntries(
      ["task_id", "run_id", "session_id", "action_id"].map((key) => [
        key,
        input.target[key] == null ? null : identifier(input.target[key], key),
      ]),
    );
    target.revision = identifier(input.target.revision, "target revision");
    check(
      Object.values(target).slice(0, 4).some(Boolean),
      "Target requires an entity id",
    );
  }
  const choices = input.choices ?? [];
  check(
    Array.isArray(choices) && choices.length <= 8,
    "At most eight choices are allowed",
  );
  const normalizedChoices = choices.map((choice) => {
    keys(choice, ["id", "label", "detail"]);
    return {
      id: identifier(choice.id, "choice id"),
      label: text(choice.label, "choice label", 160),
      detail: optional(choice.detail, "choice detail"),
    };
  });
  check(
    new Set(normalizedChoices.map((choice) => choice.id)).size ===
      choices.length,
    "Duplicate choice id",
  );
  const recommended = input.recommended_choice ?? null;
  check(
    recommended === null ||
      normalizedChoices.some((choice) => choice.id === recommended),
    "Recommended choice does not exist",
  );
  const recommendationReason = optional(
    input.recommendation_reason,
    "recommendation reason",
  );
  check(
    recommended === null || recommendationReason,
    "A recommendation requires its reason",
  );
  let cost = null;
  if (input.cost != null) {
    keys(input.cost, ["currency", "max", "description"]);
    check(
      input.cost.currency === "USD" &&
        (input.cost.max === null ||
          (typeof input.cost.max === "number" &&
            Number.isFinite(input.cost.max) &&
            input.cost.max >= 0)),
      "Cost requires USD and a nonnegative limit or null",
    );
    cost = {
      currency: "USD",
      max: input.cost.max,
      description: optional(input.cost.description, "cost description"),
    };
  }
  const result = {
    kind: input.kind,
    target,
    choices: normalizedChoices,
    recommended_choice: recommended,
    recommendation_reason: recommendationReason,
    diff: optional(input.diff, "diff", 8000),
    impact: optional(input.impact, "impact", 8000),
    conditions: optional(input.conditions, "conditions", 8000),
    cost,
    expires_at: timestamp(input.expires_at),
  };
  // Omit this optional field for old cards so their canonical fingerprints
  // and stored revisions remain byte-compatible.
  if (input.consumer_id !== undefined) {
    result.consumer_id = identifier(input.consumer_id, "consumer_id");
    check(
      target?.run_id && target?.session_id,
      "An answer consumer requires exact run/session IDs",
    );
  }
  if (result.kind === "approval") {
    check(
      target?.action_id &&
        target.revision &&
        result.diff &&
        result.impact &&
        result.conditions &&
        cost,
      "Approval requires a versioned action, diff, impact, conditions and explicit cost (null means unknown)",
    );
    check(
      choices.length >= 2,
      "Approval requires at least two explicit choices",
    );
  }
  return result;
}

function snapshot(input) {
  const urgency = input.urgency || "normal";
  check(["normal", "high", "critical"].includes(urgency), "Invalid urgency");
  return {
    question: text(input.question, "question", 8000),
    urgency,
    default_action: optional(input.default_action, "default_action"),
    decision: normalizeDecision(input.decision),
  };
}
function current(state, id, expected) {
  const cards = state.question_contracts?.cards;
  const card = cards && Object.hasOwn(cards, id) ? cards[id] : undefined;
  check(card, "Typed question not found");
  check(
    Number.isSafeInteger(expected) && expected === card.revision,
    "質問の版が変わりました。対象と条件を確認して再判断してください。",
    true,
  );
  return card;
}

export function changeQuestionContract(state, input) {
  const action = input.action ?? "create";
  keys(input, [
    "id",
    "question",
    "urgency",
    "default_action",
    "decision",
    "action",
    "expected_revision",
    "cancel_reason",
  ]);
  check(
    ["create", "revise", "cancel"].includes(action),
    "Invalid question action",
  );
  const id = identifier(input.id, "question id");
  const now = new Date().toISOString();
  if (action === "cancel") {
    check(
      !["question", "urgency", "default_action", "decision"].some(
        (key) => key in input,
      ),
      "Cancellation cannot replace question contents",
    );
    const card = current(state, id, input.expected_revision);
    const reason = text(input.cancel_reason, "cancel reason");
    if (card.status !== "cancelled") {
      card.status = "cancelled";
      card.cancel_reason = reason;
      card.updated_at = now;
    } else
      check(
        card.cancel_reason === reason,
        "Question already cancelled for another reason",
        true,
      );
    return;
  }
  check(
    input.cancel_reason === undefined,
    "cancel_reason requires cancellation",
  );
  const value = snapshot(input);
  const previous =
    state.question_contracts &&
    Object.hasOwn(state.question_contracts.cards, id)
      ? state.question_contracts.cards[id]
      : undefined;
  let history = [],
    revision = 1,
    createdAt = now;
  if (action === "revise") {
    const card = current(state, id, input.expected_revision);
    check(digest(value) !== card.fingerprint, "Question contract is unchanged");
    check(
      card.history.length < 1000,
      "Question revision history limit reached; create a new question id",
    );
    const { history: oldHistory, ...old } = card;
    history = [
      ...oldHistory,
      {
        ...old,
        status: "superseded",
        invalidated_at: now,
        invalidation_reason: "question_contract_changed",
      },
    ];
    revision = card.revision + 1;
    createdAt = card.created_at;
  } else {
    check(
      input.expected_revision === undefined,
      "Creating a question cannot specify an existing revision",
    );
    check(
      !previous && !state.questions.some((question) => question.id === id),
      "Question id already exists; use revise for a typed question",
    );
  }
  state.question_contracts ||= { schema: 1, cards: {} };
  state.question_contracts.cards[id] = {
    revision,
    fingerprint: digest(value),
    snapshot: value,
    status: "open",
    created_at: createdAt,
    updated_at: now,
    answer: null,
    cancel_reason: null,
    history,
  };
  const question = {
    id,
    question: value.question,
    urgency: value.urgency,
    default_action: value.default_action,
    created_at: createdAt,
    answer: null,
  };
  const index = state.questions.findIndex((question) => question.id === id);
  if (index < 0) state.questions.push(question);
  else state.questions[index] = question;
}

export function contractStatus(card, now = Date.now()) {
  if (card.status === "cancelled") return "cancelled";
  if (
    card.snapshot.decision.expires_at &&
    Date.parse(card.snapshot.decision.expires_at) <= now
  )
    return "expired";
  return card.status;
}
export function answerQuestionContract(state, question, input) {
  keys(input, [
    "id",
    "answer",
    "expected_revision",
    "contract_fingerprint",
    "choice_id",
  ]);
  const card = state.question_contracts?.cards[question.id];
  if (!card) {
    check(
      !["contract_fingerprint", "choice_id", "expected_revision"].some(
        (key) => key in input,
      ),
      "Legacy consultation cannot accept a typed decision answer",
    );
    return null;
  }
  current(state, question.id, input.expected_revision);
  check(
    input.contract_fingerprint === card.fingerprint,
    "質問の対象・条件が変わりました。更新内容を確認して再回答してください。",
    true,
  );
  check(
    contractStatus(card) === "open",
    "期限切れ・取消し・回答済みの質問には回答できません。",
    true,
  );
  const decision = card.snapshot.decision;
  const choiceId = input.choice_id ?? null;
  check(
    choiceId === null ||
      decision.choices.some((choice) => choice.id === choiceId),
    "Choice does not exist in this question revision",
  );
  card.status = "answered";
  card.updated_at = question.answered_at;
  card.answer = {
    text: question.answer,
    choice_id: choiceId,
    answered_at: question.answered_at,
    contract_fingerprint: card.fingerprint,
  };
  return {
    contract_fingerprint: card.fingerprint,
    contract_revision: card.revision,
    question_kind: decision.kind,
    target: structuredClone(decision.target),
    choice_id: choiceId,
    execution_authorized: false,
  };
}

function changedFields(before, after) {
  const labels = {
    question: "問い",
    urgency: "緊急度",
    default_action: "参考の行動",
    kind: "質問の型",
    target: "対象・版",
    choices: "選択肢",
    recommended_choice: "推奨",
    recommendation_reason: "推奨理由",
    diff: "差分",
    impact: "影響",
    conditions: "条件",
    cost: "費用上限",
    expires_at: "期限",
    consumer_id: "回答consumer",
  };
  const previous = { ...before, ...before.decision },
    next = { ...after, ...after.decision };
  return Object.keys(labels)
    .filter(
      (key) => JSON.stringify(previous[key]) !== JSON.stringify(next[key]),
    )
    .map((key) => labels[key]);
}
export function publicQuestionContracts(state) {
  if (!state.question_contracts) return undefined;
  return {
    schema: 1,
    cards: Object.fromEntries(
      Object.entries(state.question_contracts.cards).map(([id, card]) => [
        id,
        {
          ...structuredClone(card),
          status: contractStatus(card),
          changed_fields: card.history.length
            ? changedFields(card.history.at(-1).snapshot, card.snapshot)
            : [],
          execution_authorized: false,
        },
      ]),
    ),
  };
}
export function feedbackValidity(state, message) {
  if (!message.contract_fingerprint) return message;
  const card = state.question_contracts?.cards[message.question_id];
  const valid =
    card?.revision === message.contract_revision &&
    card?.fingerprint === message.contract_fingerprint &&
    contractStatus(card) === "answered";
  return {
    ...message,
    contract_validity: valid ? "current" : "invalidated",
    invalidation_reason: valid
      ? null
      : card?.revision !== message.contract_revision ||
          card?.fingerprint !== message.contract_fingerprint
        ? "question_contract_changed"
        : contractStatus(card),
    execution_authorized: false,
  };
}
export function validateQuestionContracts(state) {
  if (state.question_contracts === undefined) return;
  const extension = state.question_contracts;
  keys(extension, ["schema", "cards"]);
  check(
    extension.schema === 1 && own(extension.cards),
    "Unsupported question contract schema",
  );
  for (const [id, card] of Object.entries(extension.cards)) {
    identifier(id, "question id");
    check(
      own(card) &&
        Number.isSafeInteger(card.revision) &&
        card.revision >= 1 &&
        ["open", "answered", "cancelled"].includes(card.status) &&
        Array.isArray(card.history) &&
        card.history.length === card.revision - 1 &&
        card.history.length <= 1000,
      "Invalid question contract history",
    );
    const records = [...card.history, card];
    for (const [index, record] of records.entries()) {
      keys(record, [
        "revision",
        "fingerprint",
        "snapshot",
        "status",
        "created_at",
        "updated_at",
        "answer",
        "cancel_reason",
        ...(index < card.history.length
          ? ["invalidated_at", "invalidation_reason"]
          : ["history"]),
      ]);
      keys(record.snapshot, [
        "question",
        "urgency",
        "default_action",
        "decision",
      ]);
      check(
        record.revision === index + 1 &&
          record.fingerprint ===
            digest(
              snapshot({
                ...record.snapshot,
                decision: record.snapshot.decision,
              }),
            ) &&
          Number.isFinite(Date.parse(record.created_at)) &&
          Number.isFinite(Date.parse(record.updated_at)),
        "Question contract snapshot is corrupt",
      );
      check(
        record.answer === null ||
          (own(record.answer) &&
            typeof record.answer.text === "string" &&
            record.answer.contract_fingerprint === record.fingerprint &&
            Number.isFinite(Date.parse(record.answer.answered_at)) &&
            (record.answer.choice_id === null ||
              record.snapshot.decision.choices.some(
                (choice) => choice.id === record.answer.choice_id,
              ))),
        "Invalid question contract answer",
      );
      if (record.answer)
        keys(record.answer, [
          "text",
          "choice_id",
          "answered_at",
          "contract_fingerprint",
        ]);
      if (index < card.history.length)
        check(
          record.status === "superseded" &&
            Number.isFinite(Date.parse(record.invalidated_at)) &&
            record.invalidation_reason === "question_contract_changed",
          "Invalid superseded question",
        );
    }
    const question = state.questions.find((question) => question.id === id);
    check(
      question &&
        question.question === card.snapshot.question &&
        question.urgency === card.snapshot.urgency &&
        question.default_action === card.snapshot.default_action &&
        question.answer === (card.answer?.text ?? null) &&
        (card.status !== "answered" || card.answer) &&
        (card.status !== "open" || card.answer === null) &&
        (card.status !== "cancelled" || typeof card.cancel_reason === "string"),
      "Question and contract snapshot disagree",
    );
  }
}
