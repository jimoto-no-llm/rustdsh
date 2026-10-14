import { execFile, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { realpath } from "node:fs/promises";

const helper = fileURLToPath(
  new URL("./process-scope-supervisor.mjs", import.meta.url),
);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const exec = promisify(execFile);
// This digest is the reviewed Node 22 Linux/arm64 image present in the supported
// Colima acceptance environment. A worker never accepts a moving image tag.
export const dockerWorkerImage =
  "node@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392";
const dockerId = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const inside = (child, parent) => child === parent || child.startsWith(parent + path.sep);
const dockerPath = (value) => typeof value === "string" && !/[\r\n,]/.test(value);
const dockerContext = "colima";
const controlEnvironment = () => {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) if (key.startsWith("DOCKER_")) delete environment[key];
  return environment;
};

async function dockerExecutable(value) {
  const candidates = value === undefined
    ? process.platform === "darwin"
      ? ["/opt/homebrew/bin/docker", "/usr/local/bin/docker"]
      : ["/usr/bin/docker", "/usr/local/bin/docker"]
    : [value];
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || !path.isAbsolute(candidate) || candidate.includes("\0")) continue;
    try { return await realpath(candidate); } catch {}
  }
  throw new ScopeError("ownership_unavailable");
}

function dockerEndpoint(value) {
  if (typeof value !== "string" || !value.startsWith("unix://"))
    throw new ScopeError("ownership_unavailable");
  const socket = value.slice("unix://".length);
  if (!path.isAbsolute(socket) || socket.includes("\0"))
    throw new ScopeError("ownership_unavailable");
  return socket;
}

async function colimaTransport(dockerBin) {
  const options = {
    env: controlEnvironment(),
    windowsHide: true,
    maxBuffer: 4096,
    timeout: 5000,
  };
  try {
    const context = await exec(dockerBin, [
      "--context", dockerContext, "context", "inspect", dockerContext,
      "--format", "{{.Endpoints.docker.Host}}",
    ], options);
    const socket = dockerEndpoint(context.stdout.trim());
    const expected = path.join(
      await realpath(os.homedir()), ".colima", "default", "docker.sock",
    );
    if (socket !== expected) throw new Error();
    const endpoint = "unix://" + expected;
    const engine = await exec(
      dockerBin,
      ["--host", endpoint, "info", "--format", "{{.ID}}"],
      options,
    );
    const engineId = engine.stdout.trim();
    if (!/^[a-zA-Z0-9._-]{1,256}$/.test(engineId)) throw new Error();
    return { endpoint, engineId };
  } catch {
    throw new ScopeError("ownership_unavailable");
  }
}

// Docker receives only fixed transport arguments. Workload command and env are
// sent over the attached supervisor stdin after the container has started.
export async function dockerWorkerLaunch({ command, cwd, dockerWorker }) {
  if (!dockerWorker || typeof dockerWorker !== "object")
    throw new ScopeError("ownership_unavailable");
  if (
    dockerWorker.image !== undefined &&
    dockerWorker.image !== dockerWorkerImage
  )
    throw new ScopeError("ownership_unavailable");
  if (
    !Array.isArray(dockerWorker.mountRoots) ||
    !dockerWorker.mountRoots.length ||
    dockerWorker.mountRoots.some(
      (root) => typeof root !== "string" || !path.isAbsolute(root) || root.includes("\0"),
    )
  )
    throw new ScopeError("ownership_unavailable");
  const workspace = await realpath(cwd).catch(() => {
    throw new ScopeError("ownership_unavailable");
  });
  const roots = await Promise.all(
    dockerWorker.mountRoots.map((root) => realpath(root)),
  ).catch(() => {
    throw new ScopeError("ownership_unavailable");
  });
  if (!dockerPath(workspace) || !roots.every(dockerPath) || !roots.some((root) => inside(workspace, root)))
    throw new ScopeError("ownership_unavailable");
  // The worker image owns this executable. A native Node/Mach-O path is never
  // translated into a Linux command by guesswork.
  if (command[0] !== "/usr/local/bin/node")
    throw new ScopeError("ownership_unavailable");
  const mapArgument = (value) => {
    if (!path.isAbsolute(value)) return value;
    // Retain lexical paths for not-yet-created output files while accepting
    // macOS's /var -> /private/var canonicalization for existing inputs.
    const supplied = path.resolve(cwd), absolute = path.resolve(value);
    if (inside(absolute, supplied))
      return "/workspace" + path.sep + path.relative(supplied, absolute);
    throw new ScopeError("ownership_unavailable");
  };
  const dockerBin = await dockerExecutable(dockerWorker.dockerBin);
  const transport = await colimaTransport(dockerBin);
  return {
    command: [command[0], ...command.slice(1).map(mapArgument)],
    cwd: "/workspace",
    workspace,
    mountRoots: roots,
    image: dockerWorkerImage,
    dockerBin,
    execution_platform: "linux",
    transport: "colima_docker",
    context: dockerContext,
    endpoint: transport.endpoint,
    engine_id: transport.engineId,
  };
}

export async function createDockerWorkerController(launch, ownerId) {
  if (!path.isAbsolute(launch.dockerBin))
    throw new ScopeError("ownership_unavailable");
  const pinnedTransport = await colimaTransport(launch.dockerBin);
  if (
    (launch.endpoint !== undefined && launch.endpoint !== pinnedTransport.endpoint) ||
    (launch.engine_id !== undefined && launch.engine_id !== pinnedTransport.engineId)
  )
    throw new ScopeError("ownership_unavailable");
  launch = {
    ...launch,
    endpoint: pinnedTransport.endpoint,
    engine_id: pinnedTransport.engineId,
  };
  let deadline = Infinity;
  const run = async (args) => {
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw new ScopeError("monitor_lost");
    return await
    exec(launch.dockerBin, args, {
      env: controlEnvironment(),
      windowsHide: true,
      maxBuffer: 64 * 1024,
      timeout: Math.max(1, Math.min(5000, Math.floor(remaining))),
    });
  };
  const docker = (...args) => run(["--host", launch.endpoint, ...args]);
  try {
    const transport = await colimaTransport(launch.dockerBin);
    if (transport.endpoint !== launch.endpoint || transport.engineId !== launch.engine_id)
      throw new Error();
    const version = await docker("version", "--format", "{{.Server.Os}}/{{.Server.Arch}}");
    if (!/^linux\/[a-z0-9_/-]+$/.test(version.stdout.trim())) throw new Error();
  } catch { throw new ScopeError("ownership_unavailable"); }
  const name = `rdsh-${ownerId}`;
  const helperDirectory = path.dirname(helper);
  if (!dockerPath(helperDirectory)) throw new ScopeError("ownership_unavailable");
  const recovery = async () => {
    try {
      const { stdout } = await docker("inspect", "--format", "{{.Id}}\n{{index .Config.Labels \"rdsh.owner\"}}", name);
      const [found, label] = stdout.trim().split("\n");
      if (!dockerId(found)) return { status: "unavailable" };
      return label === ownerId
        ? { status: "owned", id: found }
        : { status: "foreign" };
    } catch (error) {
      if (
        error?.code === 1 &&
        /No such (object|container)/i.test(String(error.stderr))
      )
        return { status: "missing" };
      return { status: "unavailable" };
    }
  };
  const cleanupRecovered = async (id) => {
    try {
      const { stdout } = await docker("inspect", "--format", "{{.State.Status}}", id);
      const state = stdout.trim();
      if (state === "running") await docker("kill", id);
      else if (!(["created", "exited"].includes(state))) return false;
      await docker("rm", "-f", id);
      return (await recovery()).status === "missing";
    } catch {
      return false;
    }
  };
  const createArgs = [
    "create", "--name", name,
    "-i",
    "--label", "rdsh.owner=" + ownerId,
    "--network", "none",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "--mount", `type=bind,src=${launch.workspace},dst=/workspace`,
    "--mount", `type=bind,src=${helperDirectory},dst=/rdsh-worker,readonly`,
    "--workdir", "/workspace",
    "--entrypoint", "/usr/local/bin/node",
    launch.image,
    "/rdsh-worker/process-scope-supervisor.mjs",
  ];
  let id;
  try {
    ({ stdout: id } = await docker(...createArgs));
  } catch {
    const found = await recovery();
    if (found.status === "owned") id = found.id;
    else if (found.status === "unavailable")
      throw new ScopeError("cleanup_unconfirmed");
    else throw new ScopeError("ownership_unavailable");
  }
  id = id?.trim();
  if (!dockerId(id)) {
    const found = await recovery();
    if (found.status === "owned") {
      if (!(await cleanupRecovered(found.id)))
        throw new ScopeError("cleanup_unconfirmed");
    } else if (found.status === "unavailable")
      throw new ScopeError("cleanup_unconfirmed");
    throw new ScopeError("ownership_unavailable");
  }
  let stopping = false,
    started = false;
  const rawState = async () => {
    const { stdout } = await docker("inspect", "--format", "{{.State.Status}}", id);
    const state = stdout.trim();
    if (["created", "running", "exited", "dead", "paused", "restarting", "removing"].includes(state)) return state;
    throw new ScopeError("monitor_lost");
  };
  const inspect = async () => {
    try {
      const state = await rawState();
      if (state === "running")
        return {
          status: "running", remaining_pids: [], remaining_count: null, members_truncated: true,
        };
      if (started && state === "exited")
        return {
          status: "exit_confirmed", remaining_pids: [], remaining_count: 0, members_truncated: false,
        };
    } catch {}
    throw new ScopeError("monitor_lost");
  };
  const stopAndRemove = async (timeout = 5000) => {
    stopping = true;
    deadline = performance.now() + timeout;
    try {
      if ((await rawState()) === "running") await docker("kill", id);
      if ((await rawState()) === "created") {
        await docker("rm", id);
        return true;
      }
      for (let i = 0; i < 50; i++) {
        if ((await inspect()).status === "exit_confirmed") {
          await docker("rm", id);
          return true;
        }
        await pause(20);
      }
    } catch {}
    return false;
  };
  return {
    id,
    markStarted() { started = true; },
    get stopping() { return stopping; },
    inspect,
    async kill() {
      stopping = true;
      if ((await rawState()) === "running") await docker("kill", id);
      return { status: "requested", reason: "docker_exact_container_kill" };
    },
    async remove() {
      if ((await inspect()).status !== "exit_confirmed") return false;
      await docker("rm", id);
      return true;
    },
    stopAndRemove,
    setDeadline(value) { deadline = value; },
  };
}
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

export function handleSupervisorResponse(frame, pending) {
  if (
    frame?.type !== "response" ||
    !Number.isSafeInteger(frame.id) ||
    frame.id < 1
  )
    return false;
  const request = pending.get(frame.id);
  if (!request) return true; // The request timed out; discard its late reply.
  pending.delete(frame.id);
  if (frame.error) request.reject(new ScopeError("ownership_unverifiable"));
  else request.resolve(frame.result);
  return true;
}

export async function spawnOwnedProcess({
  command,
  cwd,
  env = process.env,
  owner_id = "owner_" + randomUUID(),
  wsl = null,
  wslNode = "/root/.local/opt/rdsh-node/bin/node",
  dockerWorker = null,
  cgroupParent = null,
  onStage = async () => {},
  startupTimeoutMs = 10000,
}) {
  if (
    !Array.isArray(command) ||
    !command.length ||
    command.some((s) => typeof s !== "string" || !s || s.includes("\0")) ||
    !/^owner_[a-f0-9-]{36}$/.test(owner_id)
  )
    throw new ScopeError("invalid_launch");
  if (
    !Number.isInteger(startupTimeoutMs) ||
    startupTimeoutMs < 50 ||
    startupTimeoutMs > 600000
  )
    throw new ScopeError("invalid_deadline");
  let launcher = [process.execPath, helper],
    framed = false,
    docker = null,
    dockerLaunch = null;
  if (wsl) {
    if (process.platform !== "win32" || !/^[a-zA-Z0-9._-]{1,80}$/.test(wsl))
      throw new ScopeError("ownership_unavailable");
    const linuxHelper = helper
      .replace(/\\/g, "/")
      .replace(/^([a-zA-Z]):/, (_, drive) => "/mnt/" + drive.toLowerCase());
    if (!wslNode.startsWith("/") || wslNode.includes("\0"))
      throw new ScopeError("ownership_unavailable");
    // A bare name would be searched in the inherited working directory first (CWE-427).
    const wslExe = path.join(
      process.env.SystemRoot || "C:\\Windows",
      "System32",
      "wsl.exe",
    );
    launcher = [wslExe, "-d", wsl, "--exec", wslNode, linuxHelper];
    framed = true;
  }
  if (dockerWorker) {
    if (wsl) throw new ScopeError("ownership_unavailable");
    dockerLaunch = await dockerWorkerLaunch({ command, cwd, dockerWorker });
    docker = await createDockerWorkerController(dockerLaunch, owner_id);
    launcher = [dockerLaunch.dockerBin, "--host", dockerLaunch.endpoint, "start", "-ai", docker.id];
    framed = true;
    docker.markStarted();
  }
  let monitor;
  try { monitor = spawn(launcher[0], launcher.slice(1), {
    cwd: wsl || docker ? undefined : cwd,
    // Docker transport owns its host environment. The workload environment is
    // sent only in the framed start payload below.
    env: docker ? controlEnvironment() : wsl ? process.env : env,
    windowsHide: true,
    shell: false,
    stdio: framed
      ? ["pipe", "pipe", "pipe"]
      : ["pipe", "pipe", "pipe", "pipe", "pipe", "pipe"],
  }); } catch (error) {
    if (docker && !(await docker.stopAndRemove(5000)))
      throw new ScopeError("cleanup_unconfirmed");
    throw error;
  }
  const monitorExit = new Promise((resolve) => {
    // `close` follows process exit and drains its output, including the exact
    // startup-cleanup result sent by the supervisor.
    monitor.once("close", (code, signal) =>
      resolve({ exited: monitor.pid != null, code, signal }),
    );
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
    startupCleanupConfirmed = null,
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
  const awaitMonitorExit = async (timeout) => {
    let timer;
    try {
      return await Promise.race([
        monitorExit,
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new ScopeError("monitor_exit_timeout")),
            timeout,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  const cancelStartup = async (cause) => {
    if (docker) {
      if (await docker.stopAndRemove(5000)) throw cause;
      throw new ScopeError("cleanup_unconfirmed");
    }
    try {
      monitor.stdin.end();
    } catch {}
    let exit;
    try {
      exit = await awaitMonitorExit(5000);
    } catch (error) {
      if (error.code !== "monitor_exit_timeout") throw cause;
    }
    if (exit) {
      if (!exit.exited) throw cause;
      if (startupCleanupConfirmed === true && exit.code === 0) throw cause;
      throw new ScopeError("cleanup_unconfirmed");
    }
    // Killing the exact supervisor bounds the orphan risk, but cannot prove
    // that a process group it created is empty. Keep that distinction visible.
    if (
      monitor.pid != null &&
      monitor.exitCode === null &&
      monitor.signalCode === null
    ) {
      try {
        monitor.kill("SIGTERM");
      } catch {}
      try {
        await awaitMonitorExit(1000);
      } catch {
        try {
          monitor.kill("SIGKILL");
        } catch {}
        try {
          await awaitMonitorExit(1000);
        } catch {
          throw new ScopeError("cleanup_unconfirmed");
        }
      }
      if (startupCleanupConfirmed === true) throw cause;
      throw new ScopeError("cleanup_unconfirmed");
    }
    throw new ScopeError("cleanup_unconfirmed");
  };
  const lose = (code = "ownership_unavailable") => {
    if (disposed || lost) return;
    lost = true;
    readyReject(new ScopeError(code));
    for (const { reject } of pending.values())
      reject(new ScopeError("monitor_lost"));
    pending.clear();
    child.emit("error", new ScopeError("monitor_lost"));
  };
  monitor.on("error", () => lose());
  monitor.on("exit", () => {
    if (!docker?.stopping) lose();
  });
  monitor.stdin.on("error", () => lose());
  monitor.stdout.on("data", (chunk) => {
    if (disposed) return;
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
        if (frame.type === "startup_cleanup") {
          startupCleanupConfirmed = frame.confirmed === true;
          continue;
        }
        if (lost) continue;
        if (frame.type === "ready") {
          initial = frame;
          if (Number.isSafeInteger(frame.pid) && frame.pid > 0) child.pid = frame.pid;
          readyResolve(frame);
        } else if (frame.type === "root_exit") {
          child.exitOutcome = { code: frame.code, signal: frame.signal };
          child.emit("exit", frame.code, frame.signal);
        } else if (["stdout", "stderr"].includes(frame.type) && framed)
          child[frame.type].write(Buffer.from(frame.data, "base64"));
        else if (frame.type === "monitor_error")
          lose(
            frame.reason === "cleanup_unconfirmed"
              ? "cleanup_unconfirmed"
              : "ownership_unavailable",
          );
        else if (!handleSupervisorResponse(frame, pending)) throw new Error();
      } catch {
        lose();
      }
    }
  });
  const request = async (op, timeout = 5000) => {
    if (docker) {
      if (op === "snapshot") return docker.inspect();
      if (op === "term")
        return {
          status: "unsupported",
          reason: "docker_worker_graceful_uses_protocol_and_stdin_eof",
        };
      if (op === "kill") return docker.kill();
      if (op === "dispose") return { closed: await docker.remove() };
    }
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
    command: dockerLaunch?.command ?? command,
    cwd: dockerLaunch?.cwd ?? cwd,
    env: wsl && env === process.env ? null : env,
    framed,
    cgroup_parent: cgroupParent,
    docker_worker: docker !== null,
    docker_container_id: docker?.id ?? null,
  });
  try {
    await Promise.race([
      ready,
      new Promise((_, reject) => {
        readyTimer = setTimeout(
          () => reject(new ScopeError("ownership_unavailable")),
          startupTimeoutMs,
        );
      }),
    ]);
  } catch (error) {
    await cancelStartup(error);
  } finally {
    clearTimeout(readyTimer);
  }
  const descriptor = {
    owner_id,
    kind: initial.kind,
    kernel_id: initial.kernel_id,
    root_identity: initial.identity,
    root_pid: Number.isSafeInteger(initial.pid) ? initial.pid : null,
    ...(initial.execution_platform
      ? {
          execution_platform: initial.execution_platform,
          transport: initial.transport,
        }
      : {}),
  };
  let latest = {
    ...descriptor,
    status: "running",
    confirmed: false,
    remaining_pids: child.pid ? [child.pid] : [],
    remaining_count: child.pid ? 1 : null,
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
      if (docker) {
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
        resourcesReleased = true;
        return;
      }
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
        if (docker) docker.setDeadline(performance.now() + gracefulTimeout + killTimeout);
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
