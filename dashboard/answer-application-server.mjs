import { randomBytes, timingSafeEqual } from "node:crypto";
import { SessionLedger } from "./session-ledger.mjs";
import { RunHistory } from "./run-history.mjs";
import {
  matchProcessIdentity,
  readProcessIdentity,
} from "./process-identity.mjs";
import {
  replyCheck,
  replyKeys,
  replyCommand,
  replyMessage,
} from "./answer-applications.mjs";
import { feedbackValidity } from "./question-contracts.mjs";
import {
  allInputCommands,
  inputSequence,
  queueSequence,
  instructionContext,
} from "./instruction-queue.mjs";

const equal = (a, b) =>
  typeof a === "string" &&
  typeof b === "string" &&
  Buffer.byteLength(a) === Buffer.byteLength(b) &&
  timingSafeEqual(Buffer.from(a), Buffer.from(b));
const results = {
  prompt_result_received: ["succeeded", "native_prompt_completed"],
  cancelled_result: ["failed", "native_prompt_cancelled"],
  prompt_refused: ["failed", "native_prompt_refused"],
  prompt_limit_reached: ["failed", "native_prompt_limit"],
};

// Credentials exist only in this live server. A project MCP/browser credential
// cannot manufacture a target acknowledgement. Restart requires explicit
// reattachment to the same ledger run and native session, never a new session.
export class AnswerApplicationServer {
  constructor(project, getState, mutate) {
    this.project = project;
    this.getState = getState;
    this.mutate = mutate;
    this.credentials = new Map();
  }
  async history() {
    return (await RunHistory.open(this.project)).read();
  }
  async observe(
    consumer,
    loaded,
    credential = this.credentials.get(consumer.consumer_id),
  ) {
    const at = new Date().toISOString();
    const run = loaded.runs.get(consumer.run_id);
    const base = {
      status: "unknown",
      reason: "target_not_observed",
      observed_at: at,
      owner_id: null,
    };
    if (
      !run ||
      run.native_session_id !== consumer.session_id ||
      loaded.tail_bytes
    )
      return base;
    if (
      ["exit_confirmed", "absence_observed"].includes(run.process?.status) ||
      run.scope?.status === "exit_confirmed" ||
      ["disconnected", "succeeded", "failed"].includes(run.state)
    )
      return { ...base, status: "unavailable", reason: "target_process_ended" };
    const observed = matchProcessIdentity(
      run.process?.identity,
      await readProcessIdentity(run.process?.pid),
    );
    if (["gone", "pid_reused"].includes(observed))
      return { ...base, status: "unavailable", reason: "target_process_ended" };
    if (!credential || credential.lease_until <= Date.now())
      return { ...base, reason: "consumer_connection_unverified" };
    if (
      observed !== "alive" ||
      run.scope?.status !== "running" ||
      run.scope?.owner_id !== credential.owner_id ||
      run.process?.owner_id !== credential.owner_id ||
      !["waiting-human", "running"].includes(run.state)
    )
      return base;
    return {
      ...base,
      status: "available",
      reason: "registered_owner_and_native_session",
      owner_id: credential.owner_id,
    };
  }
  async observations() {
    const consumers = Object.values(
      this.getState().answer_applications?.consumers || {},
    );
    if (!consumers.length) return {};
    let loaded;
    try {
      loaded = await this.history();
    } catch {
      return {};
    }
    const entries = [],
      queue = [...consumers];
    await Promise.all(
      Array.from({ length: Math.min(4, queue.length) }, async () => {
        while (queue.length) {
          const consumer = queue.shift();
          entries.push([
            consumer.consumer_id,
            await this.observe(consumer, loaded),
          ]);
        }
      }),
    );
    return Object.fromEntries(entries);
  }
  async register(input) {
    replyKeys(input, ["run_id", "session_id", "owner_id"]);
    const ledger = await SessionLedger.open(this.project),
      record = await ledger.resolve(input.run_id);
    replyCheck(
      record.binding === "confirmed" &&
        record.cli_session_id === input.session_id,
      "A confirmed, exact native session is required",
    );
    const loaded = await this.history();
    const credential = {
      owner_id: input.owner_id,
      token: randomBytes(32).toString("hex"),
      lease_until: Date.now() + 30000,
    };
    const observed = await this.observe(
      { run_id: record.run_id, session_id: record.cli_session_id },
      loaded,
      credential,
    );
    replyCheck(
      observed.status === "available",
      "The attached ACP owner/run/session is not live or cannot be verified",
    );
    const consumer = await this.mutate("register", record);
    this.credentials.set(consumer.consumer_id, credential);
    return { consumer, token: credential.token, lease_ms: 30000 };
  }
  authenticate(id, token) {
    const consumer = this.getState().answer_applications?.consumers[id];
    const credential = this.credentials.get(id);
    replyCheck(
      consumer && equal(token, credential?.token),
      "Consumer credential required",
      401,
    );
    credential.lease_until = Date.now() + 30000;
    return { consumer, credential };
  }
  async read(id, token, after) {
    replyCheck(
      Number.isSafeInteger(after) && after >= 0,
      "Invalid feedback cursor",
      400,
    );
    const { consumer, credential } = this.authenticate(id, token);
    const state = this.getState(),
      loaded = await this.history();
    const messages = allInputCommands(state)
      .filter(
        (command) =>
          inputSequence(command) > after && command.consumer_id === id,
      )
      .sort((a, b) => inputSequence(a) - inputSequence(b))
      .map((command) => {
        const message = replyMessage(state, command);
        return {
          ...(command.source_kind === "instruction"
            ? message
            : feedbackValidity(state, message)),
          sequence: inputSequence(command),
          application: structuredClone(command),
        };
      });
    return {
      messages,
      next_cursor: Math.max(queueSequence(state), after),
      controls: Object.values(state.instructions?.requests || {})
        .filter((r) => r.consumer_id === id && r.control)
        .map((r) => ({
          command_id: r.command_id,
          ...structuredClone(r.control),
        })),
      target_observation: await this.observe(consumer, loaded, credential),
    };
  }
  proof(command, loaded) {
    if (!command.native_command_id) return null;
    const native = loaded.commands.get(command.native_command_id),
      result = results[native?.outcome];
    if (
      !native ||
      native.run_id !== command.run_id ||
      native.operation !== "send" ||
      native.input_hash !== command.input_hash ||
      native.phase !== "acknowledged" ||
      !result ||
      Date.parse(native.recorded_at) < Date.parse(command.started_at) ||
      loaded.tail_bytes
    )
      return null;
    // The event history identifies the owner at dispatch time even after an
    // explicit same-session resume acquires a different kernel process scope.
    const index = loaded.events.findIndex(
      (event) =>
        event.type === "command" &&
        event.data.command_id === command.native_command_id &&
        event.data.phase === "recorded",
    );
    const bound = loaded.events
      .slice(0, index)
      .findLast(
        (event) =>
          event.run_id === command.run_id && event.type === "scope_bound",
      );
    if (
      index < 0 ||
      bound?.data.owner_id !== command.attempt_owner_id ||
      loaded.runs.get(command.run_id)?.native_session_id !== command.session_id
    )
      return null;
    return { phase: result[0], reason: result[1], at: native.updated_at };
  }
  async instructionContext(id) {
    const result = instructionContext(this.getState(), id);
    return {
      ...result,
      target_observation: await this.observe(
        result.consumer,
        await this.history(),
      ),
    };
  }
  async instruction(input, actor, resolve = false) {
    const state = this.getState();
    const id = resolve
      ? state.instructions?.requests[input.command_id]?.consumer_id
      : input.consumer_id;
    const consumer = state.answer_applications?.consumers[id];
    replyCheck(consumer, "Unknown exact instruction recipient", 400);
    const observed = await this.observe(consumer, await this.history());
    return this.mutate(
      resolve ? "instruction_resolve" : "instruction_submit",
      input,
      {
        actor,
        available: observed.status === "available",
        owner_id: observed.owner_id,
      },
    );
  }
  cancelProof(control, consumer, loaded) {
    const native = loaded.commands.get(control.native_command_id);
    if (
      !native ||
      native.run_id !== consumer.run_id ||
      native.operation !== "interrupt" ||
      native.phase !== "notification_sent" ||
      Date.parse(native.recorded_at) < Date.parse(control.started_at) ||
      loaded.tail_bytes ||
      loaded.runs.get(consumer.run_id)?.native_session_id !==
        consumer.session_id
    )
      return false;
    const index = loaded.events.findIndex(
      (e) =>
        e.type === "command" &&
        e.data.command_id === control.native_command_id &&
        e.data.phase === "recorded",
    );
    const bound = loaded.events
      .slice(0, index)
      .findLast(
        (e) => e.run_id === consumer.run_id && e.type === "scope_bound",
      );
    return index >= 0 && bound?.data.owner_id === control.owner_id;
  }
  async control(input, token) {
    const { consumer, credential } = this.authenticate(
      input.consumer_id,
      token,
    );
    const request = this.getState().instructions?.requests[input.command_id];
    replyCheck(
      request?.consumer_id === consumer.consumer_id && request.control,
      "Exact interrupt recipient required",
    );
    const parent = replyCommand(
        this.getState(),
        request.control.target_command_id,
        consumer,
      ),
      loaded = await this.history();
    const observed = await this.observe(consumer, loaded, credential);
    const parentProof = this.proof(parent, loaded);
    if (
      input.phase === "begin" &&
      request.control.phase === "pending" &&
      !parentProof
    ) {
      replyCheck(
        !loaded.commands.has(input.native_command_id),
        "Native cancel command already exists",
      );
      const native = loaded.commands.get(
        request.control.target_native_command_id,
      );
      const last = [...loaded.commands.values()].findLast(
        (c) => c.run_id === consumer.run_id && c.operation === "send",
      );
      replyCheck(
        native?.phase === "dispatched" &&
          last?.command_id === native.command_id,
        "Exact target prompt is not the dispatched native input",
      );
    }
    return this.mutate("control", input, {
      consumer,
      owner_id: credential.owner_id,
      available: observed.status === "available",
      parent_proof: parentProof,
      cancel_proof: this.cancelProof(request.control, consumer, loaded),
    });
  }
  async ack(input, token) {
    replyKeys(input, [
      "consumer_id",
      "command_id",
      "phase",
      "attempt_id",
      "native_command_id",
    ]);
    const { consumer, credential } = this.authenticate(
      input.consumer_id,
      token,
    );
    const command = replyCommand(this.getState(), input.command_id, consumer),
      loaded = await this.history();
    const observed = await this.observe(consumer, loaded, credential);
    if (input.phase === "begin" && command.phase === "read")
      replyCheck(
        !loaded.commands.has(input.native_command_id),
        "Native command already exists; application blocked",
      );
    const result = await this.mutate("ack", input, {
      consumer,
      owner_id: credential.owner_id,
      available: observed.status === "available",
      proof: input.phase === "reconcile" ? this.proof(command, loaded) : null,
    });
    return { ...result, target_observation: observed };
  }
}
