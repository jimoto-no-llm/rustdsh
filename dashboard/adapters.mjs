// CLI clients only: the agent loop, tools, persistence and profile boot stay in DSH.
import { client, methods, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import { EventEmitter } from "node:events";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { realpath, stat } from "node:fs/promises";

export const operations = Object.freeze([
  "start",
  "resume",
  "send",
  "interrupt",
  "stop",
  "usage",
]);
const versions = ["0.2.0-rc.2"];
const maxFrame = 1024 * 1024;
const stopReasons = new Set([
  "end_turn",
  "max_tokens",
  "max_turn_requests",
  "refusal",
  "cancelled",
]);
const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const identifier = (v) =>
  typeof v === "string" &&
  v.length > 0 &&
  v.length <= 256 &&
  !/[\x00-\x1f\x7f]/.test(v);
const run = promisify(execFile);

export class AdapterError extends Error {
  constructor(code, operation) {
    super("CLI adapter: " + code + (operation ? " (" + operation + ")" : ""));
    this.code = code;
    this.operation = operation || null;
  }
}

export function adapterCatalog() {
  return ["dsh", "codex", "claude", "kimi"].map((id) => ({
    id,
    protocol: id === "dsh" ? "acp-stdio-v1" : null,
    verified_versions: id === "dsh" ? [...versions] : [],
    verification:
      id === "dsh"
        ? "versioned wire fixtures and isolated DSH ACP lifecycle smoke"
        : "no implementation or verified CLI version",
    operations: Object.fromEntries(
      operations.map((name) => [
        name,
        {
          status:
            id === "dsh"
              ? "requires_version_and_protocol_check"
              : "unsupported",
          method:
            id !== "dsh"
              ? null
              : {
                  start: "session/new",
                  resume: "session/resume",
                  send: "session/prompt",
                  interrupt: "session/cancel",
                  stop: "session/close then owned process exit",
                  usage: "session/update:usage_update",
                }[name],
        },
      ]),
    ),
  }));
}

export function createCliAdapter(options = {}) {
  return new CliAdapter(options);
}

class CliAdapter extends EventEmitter {
  constructor({
    cli = "dsh",
    command = null,
    cwd = process.cwd(),
    env = process.env,
    profile = "acp",
    requestTimeout = 15000,
    stopTimeout = 3000,
    onOwnedSpawn = null,
  } = {}) {
    super();
    if (!adapterCatalog().some((a) => a.id === cli))
      throw new AdapterError("unknown_cli");
    if (
      command !== null &&
      (!Array.isArray(command) ||
        !command.length ||
        command.length > 8 ||
        command.some((v) => typeof v !== "string" || !v || v.includes("\0")))
    )
      throw new AdapterError("invalid_command");
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(profile))
      throw new AdapterError("invalid_profile");
    for (const value of [requestTimeout, stopTimeout])
      if (!Number.isInteger(value) || value < 50 || value > 600000)
        throw new AdapterError("invalid_timeout");
    if (onOwnedSpawn !== null && typeof onOwnedSpawn !== "function")
      throw new AdapterError("invalid_spawn_observer");
    this.cli = cli;
    this.command = command === null ? null : [...command]; // Operator argv, never a shell.
    this.cwd = cwd;
    this.env = { ...env };
    this.profile = profile;
    this.requestTimeout = requestTimeout;
    this.stopTimeout = stopTimeout;
    this.onOwnedSpawn = onOwnedSpawn;
    this.version = null;
    this.processVersion = null;
    this.health = cli === "dsh" ? "unverified" : "unsupported";
    this.sessions = new Set();
    this.prompts = new Set();
    this.meters = new Map();
    this.disabled = new Set();
    this.stopping = false;
    this.stopped = false;
    this.nextSequence = 0;
  }

  capabilities() {
    const ready =
      this.health === "compatible" &&
      this.connection &&
      !this.connection.signal.aborted &&
      !this.stopping;
    return {
      cli: this.cli,
      protocol: this.cli === "dsh" ? "acp-stdio-v1" : null,
      verified_versions: this.cli === "dsh" ? [...versions] : [],
      detected_version: this.version,
      active_process_version:
        this.child && !this.stopped ? this.processVersion : null,
      health: this.health,
      operations: Object.fromEntries(
        operations.map((name) => {
          const advertised =
            name !== "resume" ||
            object(this.negotiated?.sessionCapabilities?.resume);
          const supported = Boolean(
            ready && advertised && !this.disabled.has(name),
          );
          return [
            name,
            {
              supported,
              status: supported
                ? "supported"
                : this.health === "version_matched"
                  ? "requires_protocol_check"
                  : "unsupported",
              reason: supported
                ? null
                : this.cli !== "dsh"
                  ? "unsupported_cli"
                  : this.disabled.has(name)
                    ? "protocol_mismatch"
                    : ready && !advertised
                      ? "not_advertised"
                      : this.health,
            },
          ];
        }),
      ),
      usage_scope: "context_occupancy_tokens; not billable usage or cost",
      interrupt_ack:
        "notification sent; confirmed only by cancelled prompt result",
    };
  }

  record(type, data = {}) {
    const event = {
      sequence: ++this.nextSequence,
      type,
      cli: this.cli,
      cli_version: this.processVersion || this.version,
      observed_at: new Date().toISOString(),
      provenance: { source: "cli_adapter", trust: "untrusted_data" },
      ...data,
    };
    this.emit("event", event);
    return event;
  }

  async probe({ signal } = {}) {
    this.probeFailureCategory = null;
    if (this.cli !== "dsh") return this.capabilities();
    if (this.health === "incompatible" || this.stopped)
      return this.capabilities(); // Protocol failures require an explicit new adapter.
    if (!this.command) {
      this.health = "executable_required";
      return this.capabilities();
    }
    const connected =
      this.health === "compatible" &&
      this.connection &&
      !this.connection.signal.aborted;
    try {
      this.cwd = await realpath(this.cwd);
      if (!(await stat(this.cwd)).isDirectory()) throw new Error();
    } catch {
      this.health = "invalid_cwd";
      return this.capabilities();
    }
    try {
      const { stdout } = await run(
        this.command[0],
        [...this.command.slice(1), "--version"],
        {
          cwd: this.cwd,
          env: this.env,
          windowsHide: true,
          shell: false,
          timeout: Math.min(this.requestTimeout, 5000),
          maxBuffer: 4096,
          signal,
        },
      );
      const candidate = stdout.trim();
      this.version = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-z0-9.-]+)?$/.test(candidate)
        ? candidate
        : null;
      if (!versions.includes(this.version)) {
        this.health = "unverified_version";
        return this.capabilities();
      }
      this.health = connected ? "compatible" : "version_matched";
    } catch (error) {
      this.health = "cli_unavailable";
      this.probeFailureCategory =
        error.killed || ["ETIMEDOUT", "ABORT_ERR"].includes(error.code)
          ? "timeout"
          : ["EAGAIN", "EMFILE", "ENFILE"].includes(error.code)
            ? "unavailable"
            : [
                  "ENOENT",
                  "EACCES",
                  "ENOEXEC",
                  "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
                ].includes(error.code)
              ? "permanent"
              : "unknown";
    }
    return this.capabilities();
  }

  invalidate() {
    if (this.health === "incompatible") return;
    this.health = "incompatible";
    this.record("incompatible");
    this.connection?.close(new AdapterError("protocol_mismatch"));
    if (this.child && !this.stopped) {
      this.child.kill("SIGTERM");
      this.killTimer = setTimeout(() => {
        if (!this.stopped) this.child.kill("SIGKILL");
      }, this.stopTimeout);
      this.killTimer.unref();
    }
  }

  async connect() {
    if (this.connecting) return this.connecting;
    this.connecting = this.open();
    try {
      return await this.connecting;
    } catch (error) {
      await this.stop().catch(() => {});
      throw error;
    }
  }

  async open() {
    await this.probe();
    if (this.health !== "version_matched")
      throw new AdapterError(this.health, "start");
    this.processVersion = this.version;
    // ACP is a shipped DSH profile; --from-default-profile is for custom targets.
    this.child = spawn(
      this.command[0],
      [...this.command.slice(1), "--profile", this.profile],
      {
        cwd: this.cwd,
        env: this.env,
        windowsHide: true,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    // Never forward stderr or peer error strings; either can contain secrets.
    this.child.stderr.resume();
    this.child.stdin.on("error", () =>
      this.connection?.close(new AdapterError("transport_failed")),
    );
    this.exit = new Promise((resolve) => {
      let settled = false;
      const finish = (outcome) => {
        if (settled) return;
        settled = true;
        this.stopped = true;
        clearTimeout(this.killTimer);
        this.exitOutcome = outcome;
        this.connection?.close(new AdapterError("process_exited"));
        if (!this.stopping && this.health !== "incompatible")
          this.health = "process_exited";
        this.record("process_exit", outcome);
        resolve(outcome);
      };
      this.child.once("error", () =>
        finish({ code: null, signal: null, error: "spawn_failed" }),
      );
      this.child.once("exit", (code, signal) => finish({ code, signal }));
    });
    // A durable caller can bind the owned PID before the first protocol request.
    if (this.onOwnedSpawn) await this.onOwnedSpawn(this.child.pid);
    const requests = new Map();
    let buffer = Buffer.alloc(0);
    let controller;
    const fail = () => {
      this.invalidate();
      try {
        controller.error(new AdapterError("protocol_mismatch"));
      } catch {}
    };
    const readable = new ReadableStream({
      start: (c) => {
        controller = c;
        this.child.stdout.on("data", (chunk) => {
          buffer = Buffer.concat([buffer, chunk]);
          let newline;
          while ((newline = buffer.indexOf(10)) !== -1) {
            const line = buffer.subarray(0, newline);
            buffer = buffer.subarray(newline + 1);
            if (line.length > maxFrame) {
              fail();
              return;
            }
            if (!line.toString("utf8").trim()) continue;
            try {
              const text = new TextDecoder("utf-8", { fatal: true }).decode(
                line,
              );
              const msg = JSON.parse(text);
              this.acceptFrame(msg, requests, c);
            } catch {
              fail();
              return;
            }
          }
          if (buffer.length > maxFrame) fail();
        });
        this.child.stdout.once("end", () => {
          if (buffer.length && buffer.toString("utf8").trim()) fail();
          else {
            if (!this.stopping && this.health !== "incompatible")
              this.health = "transport_closed";
            try {
              c.close();
            } catch {}
          }
        });
        this.child.stdout.once("error", fail);
      },
    });
    const writable = new WritableStream({
      write: (message) => {
        if (Object.hasOwn(message, "id") && message.method)
          requests.set(message.id, message.method);
        return this.writeFrame(message);
      },
      close: () => this.child.stdin.end(),
      abort: () => this.child.stdin.end(),
    });
    this.connection = client({ name: "rdsh-cli-adapter" }).connect({
      readable,
      writable,
    });
    const result = await this.request(
      methods.agent.initialize,
      {
        protocolVersion: PROTOCOL_VERSION,
        clientInfo: { name: "rdsh-cli-adapter", version: "1" },
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
      },
      "initialize",
    );
    this.negotiated = result.agentCapabilities;
    this.health = "compatible";
    this.record("initialized");
    return this.capabilities();
  }

  writeFrame(message) {
    return new Promise((resolve, reject) => {
      if (!this.child?.stdin.writable)
        return reject(new AdapterError("process_exited"));
      this.child.stdin.write(JSON.stringify(message) + "\n", (error) =>
        error ? reject(new AdapterError("transport_failed")) : resolve(),
      );
    });
  }

  acceptFrame(msg, requests, controller) {
    if (!object(msg) || msg.jsonrpc !== "2.0") throw new Error();
    if (typeof msg.method === "string") {
      if (Object.hasOwn(msg, "result") || Object.hasOwn(msg, "error"))
        throw new Error();
      if (Object.hasOwn(msg, "id")) {
        if (!identifier(msg.id) && !Number.isSafeInteger(msg.id))
          throw new Error();
        // Client filesystem, terminal and permission requests are never execution authority.
        const denied = msg.method === methods.client.session.requestPermission;
        const response = denied
          ? {
              jsonrpc: "2.0",
              id: msg.id,
              result: { outcome: { outcome: "cancelled" } },
            }
          : {
              jsonrpc: "2.0",
              id: msg.id,
              error: { code: -32601, message: "Client capability unavailable" },
            };
        this.writeFrame(response).catch(() => this.invalidate());
        this.record("client_request_denied");
        return;
      }
      if (msg.method !== methods.client.session.update) {
        this.record("unsupported_notification");
        return;
      }
      const params = msg.params;
      if (
        !object(params) ||
        !identifier(params.sessionId) ||
        !object(params.update) ||
        typeof params.update.sessionUpdate !== "string"
      )
        throw new Error();
      if (!this.sessions.has(params.sessionId)) return;
      const update = params.update;
      if (update.sessionUpdate === "usage_update") {
        if (
          !Number.isSafeInteger(update.used) ||
          update.used < 0 ||
          !Number.isSafeInteger(update.size) ||
          update.size < 0
        )
          throw new Error();
        this.meters.set(params.sessionId, {
          context_tokens: update.used,
          context_capacity: update.size,
          billable_tokens: null,
          cost: null,
          source: "acp_usage_update",
          observed_at: new Date().toISOString(),
        });
      }
      this.record("session_update", { session_id: params.sessionId, update });
      return;
    }
    if (!Object.hasOwn(msg, "id") || !requests.has(msg.id)) throw new Error();
    const method = requests.get(msg.id);
    requests.delete(msg.id);
    if (Object.hasOwn(msg, "error")) {
      if (
        Object.hasOwn(msg, "result") ||
        !object(msg.error) ||
        !Number.isSafeInteger(msg.error.code) ||
        typeof msg.error.message !== "string"
      )
        throw new Error();
      // Prevent SDK diagnostics or consumer exceptions from copying secret peer text.
      controller.enqueue({
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: msg.error.code, message: "CLI returned an ACP error" },
      });
      return;
    }
    if (!object(msg.result)) throw new Error();
    const result = msg.result;
    if (
      method === methods.agent.initialize &&
      (result.protocolVersion !== PROTOCOL_VERSION ||
        !object(result.agentCapabilities) ||
        result.agentInfo?.name !== "deepseek-harness-acp")
    )
      throw new Error();
    if (method === methods.agent.session.new && !identifier(result.sessionId))
      throw new Error();
    if (
      method === methods.agent.session.prompt &&
      !stopReasons.has(result.stopReason)
    )
      throw new Error();
    controller.enqueue(msg);
  }

  async request(method, params, operation, timeout = this.requestTimeout) {
    let timer;
    try {
      return await Promise.race([
        this.connection.agent.request(method, params),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            this.invalidate();
            reject(new AdapterError("timeout_result_unknown", operation));
          }, timeout);
        }),
      ]);
    } catch (error) {
      if (error instanceof AdapterError) throw error;
      if (error.code === -32601) this.disabled.add(operation);
      throw new AdapterError(
        this.health === "incompatible"
          ? "protocol_mismatch"
          : this.stopped
            ? "process_exited"
            : this.connection.signal.aborted
              ? "connection_closed"
              : "cli_error",
        operation,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  requireOperation(name, sessionId) {
    if (!this.capabilities().operations[name]?.supported)
      throw new AdapterError("unsupported", name);
    if (
      sessionId !== undefined &&
      (!identifier(sessionId) || !this.sessions.has(sessionId))
    )
      throw new AdapterError("session_not_attached", name);
  }

  async start() {
    await this.connect();
    this.requireOperation("start");
    const result = await this.request(
      methods.agent.session.new,
      { cwd: this.cwd, mcpServers: [] },
      "start",
    );
    if (this.sessions.has(result.sessionId)) {
      this.invalidate();
      throw new AdapterError("duplicate_session", "start");
    }
    this.sessions.add(result.sessionId);
    return this.record("started", { session_id: result.sessionId });
  }

  async resume(sessionId) {
    if (!identifier(sessionId))
      throw new AdapterError("invalid_session", "resume");
    await this.connect();
    this.requireOperation("resume");
    if (this.sessions.has(sessionId))
      throw new AdapterError("already_attached", "resume");
    await this.request(
      methods.agent.session.resume,
      { sessionId, cwd: this.cwd, mcpServers: [] },
      "resume",
    );
    this.sessions.add(sessionId);
    return this.record("resumed", { session_id: sessionId });
  }

  async send(sessionId, text) {
    this.requireOperation("send", sessionId);
    if (
      typeof text !== "string" ||
      !text.trim() ||
      Buffer.byteLength(text) > 65536
    )
      throw new AdapterError("invalid_prompt", "send");
    if (this.prompts.has(sessionId)) throw new AdapterError("busy", "send");
    this.prompts.add(sessionId);
    this.record("prompt_requested", { session_id: sessionId });
    try {
      const result = await this.request(
        methods.agent.session.prompt,
        { sessionId, prompt: [{ type: "text", text }] },
        "send",
      );
      return this.record("prompt_completed", {
        session_id: sessionId,
        stop_reason: result.stopReason,
      });
    } finally {
      this.prompts.delete(sessionId);
    }
  }

  async interrupt(sessionId) {
    this.requireOperation("interrupt", sessionId);
    await this.connection.agent.notify(methods.agent.session.cancel, {
      sessionId,
    });
    return this.record("interrupt_requested", {
      session_id: sessionId,
      acknowledged: false,
    });
  }

  usage(sessionId) {
    this.requireOperation("usage", sessionId);
    const measurement = this.meters.get(sessionId);
    return {
      session_id: sessionId,
      status: measurement ? "observed" : "unavailable",
      measurement: measurement ? structuredClone(measurement) : null,
    };
  }

  async stop() {
    if (this.cli !== "dsh") throw new AdapterError("unsupported", "stop");
    if (!this.child) return { status: "not_running", confirmed: true };
    if (this.stopped)
      return { status: "stopped", confirmed: true, ...this.exitOutcome };
    if (this.stoppingPromise) return this.stoppingPromise;
    this.stoppingPromise = this.finishStop();
    return this.stoppingPromise;
  }

  async finishStop() {
    this.stopping = true;
    const wait = async () => {
      let timer;
      const result = await Promise.race([
        this.exit,
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(null), this.stopTimeout);
        }),
      ]);
      clearTimeout(timer);
      return result;
    };
    if (
      this.health === "compatible" &&
      object(this.negotiated?.sessionCapabilities?.close)
    ) {
      await Promise.allSettled(
        [...this.sessions].map((sessionId) =>
          this.request(
            methods.agent.session.close,
            { sessionId },
            "stop",
            Math.min(this.requestTimeout, this.stopTimeout),
          ),
        ),
      );
    }
    this.child.stdin.end();
    let outcome = await wait();
    if (!outcome) {
      this.child.kill("SIGTERM");
      outcome = await wait();
    }
    if (!outcome) {
      this.child.kill("SIGKILL");
      outcome = await wait();
    }
    this.connection?.close();
    if (!outcome) throw new AdapterError("stop_unconfirmed", "stop");
    if (this.health !== "incompatible") this.health = "stopped";
    return this.record("stopped", { confirmed: true, ...outcome });
  }
}
