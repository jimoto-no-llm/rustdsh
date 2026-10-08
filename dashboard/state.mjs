import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
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
  await fs.writeFile(temp, JSON.stringify(value, null, 2) + "\n", {
    mode: 0o600,
  });
  await fs.rename(temp, file);
}
export class ProjectStore {
  constructor(project, value) {
    this.project = project;
    this.value = value;
  }
  static async open(project) {
    let value;
    try {
      value = JSON.parse(
        await fs.readFile(path.join(project.directory, "state.json"), "utf8"),
      );
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
      value = {
        schema: 1,
        project: { id: project.id, name: project.name, root: project.root },
        revision: 0,
        updated_at: null,
        metrics: {},
        tasks: [],
        questions: [],
        events: [],
        feedback: [],
      };
    }
    if (value.project.id !== project.id || value.schema !== 1)
      throw new Error(
        "Dashboard state belongs to a different project or version",
      );
    validateQuestionContracts(value);
    validateAnswerApplications(value);
    validateInstructions(value);
    return new ProjectStore(project, value);
  }
  async mutate(operation, input) {
    const next = structuredClone(this.value);
    applyOperation(next, operation, input);
    validateInstructions(next);
    return this.commit(next, operation, input);
  }
  async mutateReply(operation, input, context) {
    const next = structuredClone(this.value);
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
    next.revision++;
    next.updated_at = new Date().toISOString();
    const names = {
      answer: "dashboard.answer.created",
      question: "dashboard.question.created",
      task: "dashboard.task.updated",
      event: "dashboard.progress.updated",
      metrics: "dashboard.metrics.updated",
    };
    const summary =
      operation === "answer"
        ? input.answer
        : operation === "question"
          ? input.question || input.cancel_reason
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
          entity_id: input.id || "",
          summary: String(summary).slice(0, 1000),
        },
        cursor: null,
      });
      next.changes = next.changes.slice(-10000);
    }
    await writeJson(path.join(this.project.directory, "state.json"), next);
    this.value = next;
    return next;
  }
}
export function publicState(value, observations, deliveries) {
  const { changes, ...visible } = value;
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
          (key) => !metricNames.includes(key) && key !== "session_id",
        )
      )
        throw new Error("Unknown metric");
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
        state.metrics[key] = n;
      }
      if ("session_id" in input)
        state.metrics.session_id = text(input.session_id, "session_id", 160);
      const m = state.metrics;
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
      break;
    }
    case "task": {
      // #12 task contract (display-only): title holds the purpose, the project
      // root/id holds the target repo, and status/milestone/blocker hold the
      // exit conditions. This store never grants action approval; callers
      // must check the active revision before starting work. Schema frozen.
      // #14 outcome card: keep title/status/milestone/blocker/updated_at on
      // one card; "done" is not "verified" until a check result is recorded.
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
      };
      const index = state.tasks.findIndex((item) => item.id === task.id);
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
