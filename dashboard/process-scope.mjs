import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

const helper = fileURLToPath(
  new URL("./process-scope-supervisor.mjs", import.meta.url),
);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const unverifiableScope = () => ({
  status: "unverifiable",
  confirmed: false,
  reason: "ownership_monitor_unavailable",
  remaining_pids: [],
  remaining_count: null,
  members_truncated: true,
});
export class ScopeError extends Error {
  constructor(code) {
    super("Owned process scope: " + code);
    this.code = code;
  }
}

export async function spawnOwnedProcess({
  command,
  cwd,
  env = process.env,
  owner_id = "owner_" + randomUUID(),
  wsl = null,
  wslNode = "/root/.local/opt/rdsh-node/bin/node",
  cgroupParent = null,
  onStage = async () => {},
}) {
  if (
    !Array.isArray(command) ||
    !command.length ||
    command.some((s) => typeof s !== "string" || !s || s.includes("\0")) ||
    !/^owner_[a-f0-9-]{36}$/.test(owner_id)
  )
    throw new ScopeError("invalid_launch");
  let launcher = [process.execPath, helper],
    framed = false;
  if (wsl) {
    if (process.platform !== "win32" || !/^[a-zA-Z0-9._-]{1,80}$/.test(wsl))
      throw new ScopeError("ownership_unavailable");
    const linuxHelper = helper
      .replace(/\\/g, "/")
      .replace(/^([a-zA-Z]):/, (_, drive) => "/mnt/" + drive.toLowerCase());
    if (!wslNode.startsWith("/") || wslNode.includes("\0"))
      throw new ScopeError("ownership_unavailable");
    launcher = ["wsl.exe", "-d", wsl, "--exec", wslNode, linuxHelper];
    framed = true;
  }
  const monitor = spawn(launcher[0], launcher.slice(1), {
    cwd: wsl ? undefined : cwd,
    env: wsl ? process.env : env,
    windowsHide: true,
    shell: false,
    stdio: framed
      ? ["pipe", "pipe", "pipe"]
      : ["pipe", "pipe", "pipe", "pipe", "pipe", "pipe"],
  });
  const monitorExit = new Promise((resolve) => {
    monitor.once("exit", resolve);
    monitor.once("error", resolve);
  });
  monitor.stderr.resume(); // Transport diagnostics can contain environment information.
  const child = new EventEmitter();
  child.on("error", () => {});
  child.stdout = framed ? new PassThrough() : monitor.stdio[4];
  child.stderr = framed ? new PassThrough() : monitor.stdio[5];
  const write = (frame) => monitor.stdin.write(JSON.stringify(frame) + "\n");
  child.stdin = framed
    ? new Writable({
        write(chunk, encoding, callback) {
          try {
            write({ op: "stdin", data: Buffer.from(chunk).toString("base64") });
            callback();
          } catch {
            callback(new ScopeError("monitor_lost"));
          }
        },
        final(callback) {
          try {
            write({ op: "eof" });
            callback();
          } catch {
            callback(new ScopeError("monitor_lost"));
          }
        },
      })
    : monitor.stdio[3];
  child.stdin.on("error", () => {});
  let lost = false,
    disposed = false,
    resourcesReleased = false,
    sequence = 0,
    buffer = "",
    stopping = null,
    initial;
  const pending = new Map();
  let readyResolve, readyReject;
  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const lose = () => {
    if (disposed || lost) return;
    lost = true;
    readyReject(new ScopeError("ownership_unavailable"));
    for (const { reject } of pending.values())
      reject(new ScopeError("monitor_lost"));
    pending.clear();
    child.emit("error", new ScopeError("monitor_lost"));
  };
  monitor.on("error", lose);
  monitor.on("exit", lose);
  monitor.stdin.on("error", lose);
  monitor.stdout.on("data", (chunk) => {
    if (lost || disposed) return;
    buffer += chunk.toString("utf8");
    if (buffer.length > 2 * 1024 * 1024) {
      lose();
      return;
    }
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      try {
        const frame = JSON.parse(line);
        if (frame.type === "ready") {
          initial = frame;
          child.pid = frame.pid;
          readyResolve(frame);
        } else if (frame.type === "root_exit") {
          child.exitOutcome = { code: frame.code, signal: frame.signal };
          child.emit("exit", frame.code, frame.signal);
        } else if (["stdout", "stderr"].includes(frame.type) && framed)
          child[frame.type].write(Buffer.from(frame.data, "base64"));
        else if (frame.type === "response" && pending.has(frame.id)) {
          const p = pending.get(frame.id);
          pending.delete(frame.id);
          if (frame.error) p.reject(new ScopeError("ownership_unverifiable"));
          else p.resolve(frame.result);
        } else if (frame.type === "monitor_error") lose();
        else throw new Error();
      } catch {
        lose();
      }
    }
  });
  const request = async (op, timeout = 5000) => {
    if (lost || disposed) throw new ScopeError("monitor_lost");
    const id = ++sequence;
    let timer;
    try {
      return await new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        timer = setTimeout(() => {
          pending.delete(id);
          reject(new ScopeError("monitor_timeout"));
        }, timeout);
        write({ id, op });
      });
    } finally {
      clearTimeout(timer);
    }
  };
  let readyTimer;
  write({
    op: "start",
    owner_id,
    command,
    cwd,
    env: wsl && env === process.env ? null : env,
    framed,
    cgroup_parent: cgroupParent,
  });
  try {
    await Promise.race([
      ready,
      new Promise((_, reject) => {
        readyTimer = setTimeout(
          () => reject(new ScopeError("ownership_unavailable")),
          10000,
        );
      }),
    ]);
  } catch (error) {
    monitor.stdin.end();
    throw error;
  } finally {
    clearTimeout(readyTimer);
  }
  const descriptor = {
    owner_id,
    kind: initial.kind,
    kernel_id: initial.kernel_id,
    root_identity: initial.identity,
    root_pid: initial.pid,
  };
  let latest = {
    ...descriptor,
    status: "running",
    confirmed: false,
    remaining_pids: [child.pid],
    remaining_count: 1,
    members_truncated: true,
  };
  const inspect = async () => {
    if (disposed && latest.confirmed) return structuredClone(latest);
    try {
      latest = {
        ...descriptor,
        ...(await request("snapshot")),
        confirmed: false,
      };
      latest.confirmed = latest.status === "exit_confirmed";
    } catch {
      latest = { ...descriptor, ...unverifiableScope() };
    }
    return structuredClone(latest);
  };
  const record = async (stage, phase, result, deadline_ms = null) => {
    const event = {
      owner_id,
      stage,
      phase,
      status: result.status,
      reason: result.reason ?? null,
      deadline_ms,
      observed_at: new Date().toISOString(),
      remaining_pids: result.remaining_pids ?? [],
      remaining_count: result.remaining_count ?? null,
    };
    await onStage(event);
    child.emit("scope_stage", event);
  };
  const dispose = async () => {
    disposed = (await request("dispose")).closed;
    if (disposed) {
      let timer;
      try {
        await Promise.race([
          monitorExit,
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(new ScopeError("cleanup_unconfirmed")),
              5000,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      resourcesReleased = true;
    }
  };
  const wait = async (budget) => {
    const end = performance.now() + budget;
    while (true) {
      const result = await inspect();
      if (result.status !== "running" || performance.now() >= end)
        return result;
      await pause(Math.min(25, Math.max(0, end - performance.now())));
    }
  };
  return {
    child,
    descriptor,
    inspect,
    release: () => request("release"),
    get state() {
      return structuredClone(
        lost && !disposed
          ? { ...descriptor, ...unverifiableScope() }
          : {
              ...latest,
              status:
                stopping && latest.status === "running"
                  ? "stopping"
                  : latest.status,
            },
      );
    },
    async stop({
      interrupt = async () => ({
        status: "unsupported",
        reason: "no_input_interrupt_capability",
      }),
      graceful = async () => ({ status: "requested", reason: "stdin_eof" }),
      gracefulTimeout = 3000,
      killTimeout = 3000,
    } = {}) {
      for (const ms of [gracefulTimeout, killTimeout])
        if (!Number.isInteger(ms) || ms < 50 || ms > 600000)
          throw new ScopeError("invalid_deadline");
      if (stopping) return stopping;
      stopping = (async () => {
        latest = { ...latest, status: "stopping", confirmed: false };
        const before = await inspect();
        if (before.status !== "running") {
          await record("verification", "result", before);
          if (before.confirmed) {
            try {
              await dispose();
            } catch {
              /* Retain exit proof, expose unreleased resources. */
            }
          }
          return { ...before, resources_released: resourcesReleased };
        }
        for (const [stage, callback] of [
          ["input_interrupt", interrupt],
          ["graceful", graceful],
        ]) {
          await record(
            stage,
            "request",
            { status: "requested", reason: "explicit_owned_stop" },
            gracefulTimeout,
          );
          let timer, result;
          try {
            result = await Promise.race([
              callback(),
              new Promise((resolve) => {
                timer = setTimeout(
                  () =>
                    resolve({
                      status: "unverifiable",
                      reason: "stage_deadline",
                    }),
                  gracefulTimeout,
                );
              }),
            ]);
          } catch {
            result = { status: "unverifiable", reason: "stage_failed" };
          } finally {
            clearTimeout(timer);
          }
          await record(stage, "result", result);
        }
        child.stdin.end();
        await record(
          "termination",
          "request",
          { status: "requested", reason: "graceful_shutdown" },
          gracefulTimeout,
        );
        let term;
        try {
          term = await request("term");
        } catch {
          term = {
            status: "unverifiable",
            reason: "ownership_monitor_unavailable",
          };
        }
        await record("termination", "result", term);
        let result = await wait(gracefulTimeout);
        if (result.status === "running") {
          await record(
            "kill",
            "request",
            { status: "requested", reason: "graceful_deadline_exceeded" },
            killTimeout,
          );
          let killed;
          try {
            killed = await request("kill");
          } catch {
            killed = {
              status: "unverifiable",
              reason: "ownership_monitor_unavailable",
            };
          }
          await record("kill", "result", killed);
          result = await wait(killTimeout);
        }
        if (result.status === "running")
          result = {
            ...result,
            status: "unverifiable",
            confirmed: false,
            reason: "owned_descendants_remaining",
          };
        await record("verification", "result", result);
        if (result.confirmed) {
          try {
            await dispose();
          } catch {
            /* Exit proof survives later cleanup failure. */
          }
        }
        return { ...result, resources_released: resourcesReleased };
      })();
      return stopping;
    },
    disconnectMonitor() {
      lose();
      monitor.stdin.end();
    },
  };
}
