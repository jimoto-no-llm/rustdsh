import { spawn as nodeSpawn } from "node:child_process";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";

export async function resolveRdshExecutable(env = process.env, platform = process.platform) {
  const override = env.RDSH_BIN;
  if (override) {
    if (!path.isAbsolute(override))
      throw new Error("RDSH_BIN must be an absolute path");
    return override;
  }
  const name = platform === "win32" ? "rdsh.exe" : "rdsh";
  for (const directory of (env.PATH || "").split(path.delimiter)) {
    if (!path.isAbsolute(directory)) continue;
    const candidate = path.join(directory, name);
    try {
      if (!(await fs.stat(candidate)).isFile()) continue;
      if (platform !== "win32") await fs.access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Keep looking through PATH.
    }
  }
  return null;
}

export function supportsInstructionQueueServe(
  executable,
  { prefixArgs = [], spawnProcess = nodeSpawn, timeoutMs = 3_000 } = {},
) {
  if (!path.isAbsolute(executable)) return Promise.resolve(false);
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let timer;
    const finish = (supported) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(supported);
    };
    let child;
    try {
      child = spawnProcess(
        executable,
        [...prefixArgs, "instruction-queue", "serve"],
        { stdio: ["ignore", "ignore", "ignore"], windowsHide: true },
      );
    } catch {
      finish(false);
      return;
    }
    timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    timer.unref?.();
    child.once("error", () => finish(false));
    child.once("close", (code) => finish(!timedOut && code === 0));
  });
}

export class InstructionQueueWorker {
  constructor(
    executable,
    {
      prefixArgs = [],
      spawnProcess = nodeSpawn,
      requestTimeoutMs = 30_000,
      closeTimeoutMs = 1_000,
    } = {},
  ) {
    if (!path.isAbsolute(executable))
      throw new Error("rdsh executable must be an absolute path");
    this.executable = executable;
    this.prefixArgs = prefixArgs;
    this.spawnProcess = spawnProcess;
    this.requestTimeoutMs = requestTimeoutMs;
    this.closeTimeoutMs = closeTimeoutMs;
    this.record = null;
    this.pending = null;
    this.queue = Promise.resolve();
    this.closing = false;
    this.closed = false;
    this.closePromise = null;
  }

  request(document) {
    if (this.closing || this.closed)
      return Promise.reject(new Error("Rust instruction worker is closed"));
    const operation = this.queue.then(() => this.requestOne(document));
    this.queue = operation.catch(() => {});
    return operation;
  }

  async close() {
    if (this.closePromise) return this.closePromise;
    if (this.closed) return;
    this.closing = true;
    this.closePromise = (async () => {
      await this.queue;
      const record = this.record;
      if (!record) {
        this.closed = true;
        return;
      }
      let timer;
      if (record.child.exitCode === null && record.child.signalCode === null) {
        timer = setTimeout(() => record.child.kill("SIGKILL"), this.closeTimeoutMs);
        timer.unref?.();
        record.child.stdin.end();
      }
      await record.closed;
      clearTimeout(timer);
      if (this.record === record) this.record = null;
      this.closed = true;
    })();
    return this.closePromise;
  }

  async requestOne(document) {
    const record = await this.ensureChild();
    return new Promise((resolve, reject) => {
      const pending = { record, resolve, reject, timer: null };
      this.pending = pending;
      pending.timer = setTimeout(() => {
        const error = new Error("Rust instruction worker timed out");
        error.status = 504;
        this.fail(record, error);
      }, this.requestTimeoutMs);
      pending.timer.unref?.();
      try {
        const body = JSON.stringify(document);
        if (typeof body !== "string")
          throw new Error("Instruction worker request is not JSON serializable");
        record.child.stdin.write(`${body}\n`);
      } catch (error) {
        this.fail(record, error);
      }
    });
  }

  async ensureChild() {
    if (this.record?.failed) {
      const failed = this.record;
      await failed.closed;
      if (this.record === failed) this.record = null;
    }
    if (this.record) return this.record;
    const child = this.spawnProcess(
      this.executable,
      [...this.prefixArgs, "instruction-queue", "serve"],
      { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
    );
    let resolveClosed;
    const record = {
      child,
      reader: createInterface({ input: child.stdout, crlfDelay: Infinity }),
      failed: false,
      closed: new Promise((resolve) => {
        resolveClosed = resolve;
      }),
    };
    this.record = record;
    child.stderr.resume();
    record.reader.on("line", (line) => this.receive(record, line));
    child.stdin.on("error", (error) => this.fail(record, error));
    child.once("error", (error) => this.fail(record, error));
    child.once("close", (code, signal) => {
      const description = signal
        ? `signal ${signal}`
        : `code ${code ?? "unknown"}`;
      this.fail(
        record,
        Object.assign(
          new Error(`Rust instruction worker exited unexpectedly (${description})`),
          { status: 500 },
        ),
      );
      resolveClosed();
      if (this.record === record) this.record = null;
    });
    return record;
  }

  receive(record, line) {
    const pending = this.pending;
    if (this.record !== record || pending?.record !== record) {
      this.fail(record, new Error("Rust instruction worker returned an unsolicited response"));
      return;
    }
    let response;
    try {
      response = JSON.parse(line);
    } catch {
      this.fail(record, new Error("Rust instruction worker returned invalid JSON"));
      return;
    }
    if (!response || typeof response !== "object" || Array.isArray(response)) {
      this.fail(record, new Error("Rust instruction worker returned an invalid response"));
      return;
    }
    this.pending = null;
    clearTimeout(pending.timer);
    if (Object.hasOwn(response, "error")) {
      const error = new Error(String(response.error));
      error.status = Number.isInteger(response.status) ? response.status : 500;
      pending.reject(error);
      return;
    }
    pending.resolve(response);
  }

  fail(record, error) {
    if (this.record !== record || record.failed) return;
    record.failed = true;
    record.reader.close();
    if (record.child.exitCode === null && record.child.signalCode === null)
      record.child.kill("SIGKILL");
    const pending = this.pending;
    if (pending?.record !== record) return;
    this.pending = null;
    clearTimeout(pending.timer);
    if (!Number.isInteger(error.status)) error.status = 500;
    pending.reject(error);
  }
}
