import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { prepareContract } from "./contracts.mjs";
import { evaluateOperation } from "./policy.mjs";
import { prepareApprovalRequest, decideApproval, claimApproval, checkApproval, startApproval, finishApproval } from "./approvals.mjs";
import { applyTaskOutcomes, validateTaskOutcomes } from "./task-outcomes.mjs";
import { normalizeObservation } from "./observations.mjs";
import {
  changeQuestionContract,
  answerQuestionContract,
  publicQuestionContracts,
  feedbackValidity,
  validateQuestionContracts,
} from "./question-contracts.mjs";
import {
  registerReplyConsumer,
  recordAnswerApplication,
  validateReplyRecipient,
  applyReplyAck,
  publicAnswerApplications,
  validateAnswerApplications,
  replyQueueBlocker,
  replyQueueIndex,
} from "./answer-applications.mjs";
import {
  submitInstruction,
  resolveInstruction,
  applyInstructionControl,
  validateInstructions,
  queueRevision,
} from "./instruction-queue.mjs";
import {
  declareCostScope,
  recordCostReport,
  validateCostLedger,
  publicCostLedger,
} from "./cost-ledger.mjs";
import {
  applyBudgetOperation,
  validateBudgetAdmission,
  publicBudgetAdmission,
} from "./budget-admission.mjs";
import {
  restoreHistoryBackup,
  validateRestoredHistory,
  validateHistoryConflicts,
} from "./history-backup.mjs";

// Bucket D display notes (no schema change; schema stays 1):
// #12 task contract, #13 review inbox, #14 outcome cards, #15 dependencies.
// Legacy field shapes remain unchanged. Optional question_contracts metadata
// has its own schema and explicit revision contract (#40).

export const metricNames = [
  "total_cost_usd",
  "total_budget_usd",
  "session_cost_usd",
  "session_budget_usd",
  "input_tokens",
  "cached_input_tokens",
  "model_calls",
  "tool_calls",
  "tool_errors",
  "context_misses",
  "auto_continues",
  "refusals",
  "api_errors",
];
export function stateHome() {
  return (
    process.env.RDSH_DASHBOARD_HOME ||
    path.join(
      process.env.LOCALAPPDATA || path.join(os.homedir(), ".local", "state"),
      "rdsh",
      "dashboard",
    )
  );
}
export async function identity(project) {
  const root = await fs.realpath(path.resolve(project));
  if (!(await fs.stat(root)).isDirectory())
    throw new Error("Project must be a directory");
  const normalized = process.platform === "win32" ? root.toLowerCase() : root;
  const id = createHash("sha256").update(normalized).digest("hex").slice(0, 16);
  return {
    id,
    root,
    name: path.basename(root),
    directory: path.join(stateHome(), "projects", id),
  };
}
export async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await fs.writeFile(temp, JSON.stringify(value, null, 2) + "\n", {
      mode: 0o600,
    });
    await fs.rename(temp, file);
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

function stateIntegrityKeyPath(project) {
  return path.join(project.directory, "state-integrity.key");
}

function stateIntegrityMarkerPath(project) {
  return path.join(project.directory, "state-integrity.enabled");
}

function stateIntegrityMigrationPath(project) {
  return path.join(project.directory, "state-integrity.pending");
}

async function fileExists(file) {
  try {
    await fs.access(file);
    return true;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return false;
  }
}

function statePayloadDigest(value) {
  const { state_auth: _stateAuth, ...payload } = value;
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

async function readIntegrityMigration(project) {
  let value;
  try {
    value = JSON.parse(
      await fs.readFile(stateIntegrityMigrationPath(project), "utf8"),
    );
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  const keys = Object.keys(value || {}).sort();
  if (
    keys.join(",") !== "project_id,schema,state_sha256" ||
    value.schema !== 1 ||
    value.project_id !== project.id ||
    !/^[0-9a-f]{64}$/.test(value.state_sha256 || "")
  )
    throw new Error("Dashboard state integrity migration record is invalid");
  return value;
}

async function writeIntegrityMigration(project, value) {
  const record = {
    schema: 1,
    project_id: project.id,
    state_sha256: statePayloadDigest(value),
  };
  await writeJson(stateIntegrityMigrationPath(project), record);
  return record;
}

async function writeStateIntegrityMarker(project) {
  const file = stateIntegrityMarkerPath(project);
  try {
    await fs.writeFile(file, `${project.id}\n`, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
}

async function loadStateIntegrityKey(
  project,
  { hadStateSeal, stateExists, migrationPending },
) {
  const file = stateIntegrityKeyPath(project);
  try {
    const key = await fs.readFile(file);
    if (key.byteLength !== 32)
      throw new Error("Dashboard state integrity key is invalid");
    return { key, existed: true };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    if (hadStateSeal || (stateExists && !migrationPending))
      throw new Error("Dashboard state integrity key is missing; refusing state");
  }
  await fs.mkdir(project.directory, { recursive: true });
  const generated = randomBytes(32);
  try {
    await fs.writeFile(file, generated, { flag: "wx", mode: 0o600 });
    return { key: generated, existed: false };
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const key = await fs.readFile(file);
    if (key.byteLength !== 32)
      throw new Error("Dashboard state integrity key is invalid");
    return { key, existed: true };
  }
}

async function persistStateIntegrityKey(project, key) {
  const file = stateIntegrityKeyPath(project);
  await fs.mkdir(project.directory, { recursive: true });
  try {
    await fs.writeFile(file, key, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const existing = await fs.readFile(file);
    if (
      existing.byteLength !== key.byteLength ||
      !timingSafeEqual(existing, key)
    )
      throw new Error("Dashboard state integrity key changed; refusing state");
  }
}

function stateMac(value, key) {
  const { state_auth: _stateAuth, ...payload } = value;
  return createHmac("sha256", key).update(JSON.stringify(payload)).digest("hex");
}

function sealState(value, key) {
  delete value.state_auth;
  value.state_auth = { schema: 1, mac: stateMac(value, key) };
  return value;
}

function verifyStateSeal(value, key) {
  const actual = value.state_auth?.mac;
  if (value.state_auth?.schema !== 1 || !/^[0-9a-f]{64}$/.test(actual || ""))
    return false;
  const expected = stateMac(value, key);
  return timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));
}

function validateStoredState(value, project) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.project?.id !== project.id ||
    value.schema !== 1
  )
    throw new Error("Dashboard state belongs to a different project or version");
  validateQuestionContracts(value);
  validateAnswerApplications(value);
  validateInstructions(value);
  validateCostLedger(value);
  validateBudgetAdmission(value);
  validateTaskOutcomes(value);
  validateRestoredHistory(value);
}

export class ProjectStore {
  constructor(project, value, integrityKey) {
    this.project = project;
    this.value = value;
    this.integrityKey = integrityKey;
    this.historyIds = validateRestoredHistory(value);
    this.protectedHistory = freezeHistory(value.history_backups);
  }
  clone() {
    const { history_backups, ...value } = this.value;
    const next = structuredClone(value);
    if (history_backups !== undefined) next.history_backups = history_backups;
    return next;
  }
  static async open(project) {
    let value;
    const stateFile = path.join(project.directory, "state.json");
    let stateExists = true;
    try {
      value = JSON.parse(await fs.readFile(stateFile, "utf8"));
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
      stateExists = false;
      value = {
        schema: 1,
        project: { id: project.id, name: project.name, root: project.root },
        revision: 0,
        updated_at: null,
        metrics: {},
        tasks: [],
        contracts: [],
        questions: [],
        events: [],
        feedback: [],
      };
    }
    const hadStateSeal = Boolean(value?.state_auth);
    let migration = await readIntegrityMigration(project);
    const markerExists = await fileExists(stateIntegrityMarkerPath(project));
    const keyExists = await fileExists(stateIntegrityKeyPath(project));
    if (!stateExists && (markerExists || migration))
      throw new Error("Dashboard state is missing; refusing to recreate state");

    if (hadStateSeal) {
      const keyState = await loadStateIntegrityKey(project, {
        hadStateSeal: true,
        stateExists,
        migrationPending: Boolean(migration),
      });
      if (!keyState.existed || !verifyStateSeal(value, keyState.key))
        throw new Error("Dashboard state integrity check failed; refusing state");
      validateStoredState(value, project);
      await writeStateIntegrityMarker(project);
      if (migration)
        await fs.rm(stateIntegrityMigrationPath(project), { force: true });
      return new ProjectStore(project, value, keyState.key);
    }

    if (stateExists) {
      if (markerExists)
        throw new Error("Dashboard state integrity seal is missing; refusing state");
      if (migration) {
        if (migration.state_sha256 !== statePayloadDigest(value))
          throw new Error("Dashboard state migration check failed; refusing state");
      } else {
        if (keyExists)
          throw new Error("Dashboard state integrity seal is missing; refusing state");
        validateStoredState(value, project);
        migration = await writeIntegrityMigration(project, value);
      }
      validateStoredState(value, project);
      const keyState = await loadStateIntegrityKey(project, {
        hadStateSeal: false,
        stateExists: true,
        migrationPending: true,
      });
      sealState(value, keyState.key);
      await writeJson(stateFile, value);
      await writeStateIntegrityMarker(project);
      await fs.rm(stateIntegrityMigrationPath(project), { force: true });
      return new ProjectStore(project, value, keyState.key);
    }

    if (migration)
      throw new Error("Dashboard state migration record has no state to recover");
    const keyState = await loadStateIntegrityKey(project, {
      hadStateSeal: false,
      stateExists: false,
      migrationPending: false,
    });
    validateStoredState(value, project);
    sealState(value, keyState.key);
    return new ProjectStore(project, value, keyState.key);
  }
  async mutate(operation, input, authority = "agent") {
    const next = this.clone();
    if (operation === "contract") {
      if (authority !== "local_administrator")
        throw new Error("Only the local administrator can change a task contract");
      const version = await prepareContract(next, input);
      next.contracts ||= [];
      let history = next.contracts.find((item) => item.task_id === input.task_id);
      if (!history) {
        history = { task_id: input.task_id, versions: [] };
        next.contracts.push(history);
      }
      history.versions.push(version);
    } else if (operation === "approval_request") {
      const version = await prepareApprovalRequest(next, input);
      next.approval_requests ||= [];
      let history = next.approval_requests.find((item) => item.id === input.id);
      if (!history) {
        history = { id: input.id, versions: [] };
        next.approval_requests.push(history);
      }
      history.versions.push(version);
    } else if (operation === "approval_decision") {
      decideApproval(next, input, authority);
    } else if (["approval_claim", "approval_check", "approval_start"].includes(operation)) {
      const result = operation === "approval_claim" ? await claimApproval(next, input)
        : operation === "approval_start" ? await startApproval(next, input)
          : await checkApproval(next, input);
      next.approval_checks ||= [];
      next.approval_checks.push({ checked_at: new Date().toISOString(), ...result });
      next.approval_checks = next.approval_checks.slice(-1000);
    } else if (operation === "approval_finish") {
      const result = finishApproval(next, input);
      next.approval_checks ||= [];
      next.approval_checks.push({ checked_at: new Date().toISOString(), ...result });
      next.approval_checks = next.approval_checks.slice(-1000);
    } else if (operation === "policy") {
      const result = await evaluateOperation(next, input);
      next.policy_checks ||= [];
      next.policy_checks.push({
        id: `policy_${next.revision + 1}`, checked_at: new Date().toISOString(), ...result,
      });
      next.policy_checks = next.policy_checks.slice(-1000);
    } else {
      applyOperation(next, operation, input);
    }
    validateInstructions(next);
    validateCostLedger(next);
    validateTaskOutcomes(next);
    return this.commit(next, operation, input);
  }
  async mutateReply(operation, input, context) {
    const next = this.clone();
    const handlers = {
      register: registerReplyConsumer,
      ack: applyReplyAck,
      instruction_submit: submitInstruction,
      instruction_resolve: resolveInstruction,
      control: applyInstructionControl,
    };
    const result = handlers[operation](next, input, context);
    validateAnswerApplications(next);
    validateInstructions(next);
    await this.commit(next);
    return structuredClone(result);
  }
  async commit(next, operation = null, input = {}) {
    const historyChanged = next.history_backups !== this.protectedHistory;
    const historyIds = historyChanged
      ? validateRestoredHistory(next)
      : this.historyIds;
    validateHistoryConflicts(next, historyIds);
    next.revision++;
    next.updated_at = new Date().toISOString();
    const names = {
      answer: "dashboard.answer.created",
      question: "dashboard.question.created",
      task: "dashboard.task.updated",
      event: "dashboard.progress.updated",
      metrics: "dashboard.metrics.updated",
      contract: "dashboard.contract.updated",
      policy: "dashboard.policy.checked",
      approval_request: "dashboard.approval.requested",
      approval_decision: "dashboard.approval.decided",
      approval_claim: "dashboard.approval.claimed",
      approval_check: "dashboard.approval.checked",
      approval_start: "dashboard.approval.started",
      approval_finish: "dashboard.approval.finished",
    };
    const summary =
      operation === "answer"
        ? input.answer
        : operation === "question"
          ? input.question || input.cancel_reason
          : operation === "contract"
            ? "タスク契約を更新"
            : operation === "policy"
              ? "操作構造を照合"
              : operation?.startsWith("approval_")
                ? "操作承認の台帳を更新"
                : input.title || "指標を更新";
    if (operation) {
      next.changes ||= [];
      next.changes.push({
        eventId: `evt_${this.project.id}_${next.revision}`,
        name: names[operation],
        timestamp: next.updated_at,
        data: {
          project_id: this.project.id,
          revision: next.revision,
          entity_id: input?.id || input?.task_id || "",
          summary: String(summary).slice(0, 1000),
        },
        cursor: null,
      });
      next.changes = next.changes.slice(-10000);
    }
    sealState(next, this.integrityKey);
    await persistStateIntegrityKey(this.project, this.integrityKey);
    await writeJson(path.join(this.project.directory, "state.json"), next);
    // The atomic state rename is the commit point. Keep this store aligned
    // with durable state before writing the recoverable integrity marker, so
    // a marker write failure cannot make a later mutation overwrite this one.
    if (historyChanged) {
      this.protectedHistory = freezeHistory(next.history_backups);
      this.historyIds = historyIds;
    }
    this.value = next;
    await writeStateIntegrityMarker(this.project);
    return next;
  }
  async mutateBudget(operation, input) {
    const next = this.clone();
    const result = applyBudgetOperation(next, operation, input);
    await this.commit(next);
    return structuredClone(result);
  }
  async restoreBackup(input, evidenceIds, acceptanceTaskIds) {
    const next = structuredClone(this.value);
    const result = restoreHistoryBackup(
      next,
      input,
      evidenceIds,
      acceptanceTaskIds,
    );
    await this.commit(next);
    return { ...result, revision: next.revision };
  }
}
function freezeHistory(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freezeHistory(child);
    Object.freeze(value);
  }
  return value;
}
export function publicState(value, observations, deliveries, budgetJobs) {
  const { changes, state_auth: _stateAuth, ...visible } = value;
  if (value.cost_ledger) visible.cost_ledger = publicCostLedger(value);
  if (value.budget_admission)
    visible.budget_admission = publicBudgetAdmission(value, budgetJobs);
  visible.input_queue_revision = queueRevision(value);
  if (visible.instructions) {
    visible.instructions = structuredClone(visible.instructions);
    const queueIndex = replyQueueIndex(value);
    for (const command of Object.values(visible.instructions.commands)) {
      const observation = observations?.[command.consumer_id] || {
        status: "unknown",
        reason: "live_consumer_not_observed",
        observed_at: null,
        owner_id: null,
      };
      command.target_observation = observation;
      command.display_phase =
        command.phase === "started" &&
        (observation.status !== "available" ||
          observation.owner_id !== command.attempt_owner_id)
          ? "unknown"
          : ["saved", "read"].includes(command.phase) &&
              observation.status === "unavailable"
            ? "unapplied"
            : command.phase;
      command.execution_authorized = false;
      const blocker = ["saved", "read"].includes(command.phase)
        ? replyQueueBlocker(value, command, queueIndex)
        : null;
      command.queue_blocker = blocker
        ? { command_id: blocker.command_id, phase: blocker.phase }
        : null;
    }
  }
  const contracts = publicQuestionContracts(value);
  const applications = publicAnswerApplications(
    value,
    observations,
    deliveries,
  );
  const result = contracts
    ? {
        ...visible,
        question_contracts: contracts,
        feedback: value.feedback.map((message) =>
          feedbackValidity(value, message),
        ),
      }
    : visible;
  return applications
    ? { ...result, answer_applications: applications }
    : result;
}
function text(value, label, max = 8000) {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new Error(
      `${label} must be a non-empty string (max ${max} characters)`,
    );
  return value;
}
function oneOf(value, values, label) {
  if (!values.includes(value)) throw new Error(`Invalid ${label}`);
  return value;
}
export function applyOperation(state, operation, input) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Expected an object");
  switch (operation) {
    case "metrics": {
      if (
        Object.keys(input).some(
          (key) => !metricNames.includes(key) &&
            !["session_id", "observation", "cost_scope", "cost_report"].includes(key),
        )
      )
        throw new Error("Unknown metric");
      const now = Date.now();
      const sessionId = "session_id" in input
        ? text(input.session_id, "session_id", 160)
        : null;
      const observation = {
        ...normalizeObservation(input.observation, { now, sessionId }),
        report_id: randomBytes(16).toString("hex"),
      };
      const metrics = { ...state.metrics };
      const observations = { ...state.metric_observations };
      // Session-scoped costs must not inherit values from the previous session.
      if (sessionId && sessionId !== metrics.session_id) {
        for (const key of ["session_cost_usd", "session_budget_usd"]) {
          delete metrics[key];
          delete observations[key];
        }
      }
      for (const key of metricNames) {
        if (!(key in input)) continue;
        const n = input[key];
        if (
          n !== null &&
          (typeof n !== "number" ||
            !Number.isFinite(n) ||
            n < 0 ||
            (!key.endsWith("_usd") && !Number.isInteger(n)))
        )
          throw new Error(`Invalid ${key}`);
        if (n !== null && observation.kind === "unavailable")
          throw new Error("Unavailable observations cannot contain numeric values");
        metrics[key] = n;
        observations[key] = {
          ...observation,
          kind: n === null ? "unavailable" : observation.kind,
          reference: observation.reference ?? key,
        };
      }
      if (sessionId) {
        metrics.session_id = sessionId;
        observations.session_id = {
          ...observation,
          reference: observation.reference ?? sessionId,
        };
      }
      const m = metrics;
      if (
        m.cached_input_tokens != null &&
        m.input_tokens != null &&
        m.cached_input_tokens > m.input_tokens
      )
        throw new Error("Cached tokens exceed input tokens");
      if (
        m.tool_errors != null &&
        m.tool_calls != null &&
        m.tool_errors > m.tool_calls
      )
        throw new Error("Tool errors exceed tool calls");
      state.metrics = metrics;
      state.metric_observations = observations;
      if ("cost_scope" in input) declareCostScope(state, input.cost_scope);
      if ("cost_report" in input) recordCostReport(state, input.cost_report);
      break;
    }
    case "task": {
      // #12 task contract (display-only): title holds the purpose, the project
      // root/id holds the target repo, and status/milestone/blocker hold the
      // exit conditions. This store never grants action approval; callers
      // must check the active revision before starting work. Schema frozen.
      const task = {
        id: text(input.id, "id", 160),
        title: text(input.title, "title", 1000),
        status: oneOf(
          input.status,
          ["todo", "doing", "done", "blocked"],
          "task status",
        ),
        milestone: input.milestone
          ? text(input.milestone, "milestone", 160)
          : "",
        blocker: input.blocker ? text(input.blocker, "blocker", 2000) : "",
        updated_at: new Date().toISOString(),
        observation: normalizeObservation(input.observation, {
          reference: input.id,
        }),
      };
      const index = state.tasks.findIndex((item) => item.id === task.id);
      applyTaskOutcomes(state, input);
      if (index < 0) state.tasks.push(task);
      else state.tasks[index] = task;
      break;
    }
    case "question": {
      if (
        input.decision !== undefined ||
        input.action !== undefined ||
        input.expected_revision !== undefined
      ) {
        changeQuestionContract(state, input);
        validateReplyRecipient(
          state,
          state.question_contracts.cards[input.id].snapshot.decision,
        );
        break;
      }
      // #13 review inbox: the inbox shows only answer === null, ordered by
      // urgency then created_at. Plain event/metrics appends must not raise
      // warnings there; answering removes the item but keeps this history.
      const question = {
        id: text(input.id, "id", 160),
        question: text(input.question, "question"),
        urgency: oneOf(
          input.urgency || "normal",
          ["normal", "high", "critical"],
          "urgency",
        ),
        default_action: input.default_action
          ? text(input.default_action, "default_action", 2000)
          : "",
        created_at: new Date().toISOString(),
        answer: null,
      };
      if (state.questions.some((item) => item.id === question.id))
        throw new Error(
          "Question id already exists; use a new id for a follow-up",
        );
      state.questions.push(question);
      break;
    }
    case "answer": {
      // #13 review inbox (cont.): an answer keeps the original question in
      // feedback and drops it from the pending inbox; duplicates by id stay
      // rejected so follow-ups need a new id.
      const question = state.questions.find((item) => item.id === input.id);
      if (!question) throw new Error("Question not found");
      if (question.answer !== null)
        throw new Error("Question already answered");
      question.answer = text(input.answer, "answer");
      question.answered_at = new Date().toISOString();
      const contract = answerQuestionContract(state, question, input);
      state.feedback.push({
        sequence: (state.feedback.at(-1)?.sequence || 0) + 1,
        type: "question_answered",
        question_id: question.id,
        question: question.question,
        answer: question.answer,
        created_at: question.answered_at,
        ...(contract || {}),
      });
      recordAnswerApplication(state, state.feedback.at(-1));
      break;
    }
    case "event": {
      const event = {
        event_id: randomUUID(),
        sequence: (state.events.at(-1)?.sequence || 0) + 1,
        type: oneOf(
          input.type || "progress",
          ["progress", "artifact", "note"],
          "event type",
        ),
        title: text(input.title, "title", 1000),
        detail: input.detail ? text(input.detail, "detail") : "",
        artifact: input.artifact ? text(input.artifact, "artifact", 2000) : "",
        created_at: new Date().toISOString(),
        observation: normalizeObservation(input.observation, {
          reference: input.artifact || null,
        }),
      };
      state.events.push(event);
      // Full state and all feedback are durable; retain the latest 1000 display events.
      // #15 dependencies (display-only): no DAG/claim fields in schema 1 by
      // design. The UI collapses large graphs and shows only runnable items;
      // concurrency/depth/stop limits are enforced by the caller's plan.
      state.events = state.events.slice(-1000);
      break;
    }
    default:
      throw new Error("Unknown operation");
  }
}
