import fs from "node:fs/promises";
import { openSync, writeSync, closeSync, readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { stateHome, writeJson } from "./state.mjs";
import {
  readProcessIdentity,
  matchProcessIdentity,
  validProcessIdentity,
} from "./process-identity.mjs";

// External agent runners (cursor-agent, devin). Separate from the DSH ACP
// adapter: each job is one non-interactive CLI run, supervised by a detached
// Node process that records output in the job directory.

export const OUTPUT_CAP = 1024 * 1024; // per stream, bytes kept on disk
export const RESULT_TEXT_CAP = 256 * 1024; // characters returned by `result`
export const CURSOR_PROMPT_CAP = 100 * 1024; // argv-delivered prompt
export const PROMPT_CAP = 1024 * 1024;
const EXPORT_CAP = 16 * 1024 * 1024;
const PROBE_TIMEOUT_MS = 15000;
const JOB_ID = /^job_[a-f0-9]{24}$/;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,99}$/;
const PERMISSIONS = ["read-only", "edit", "full"];
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const self = fileURLToPath(import.meta.url);

export class RunnerError extends Error {
  constructor(code, detail = null) {
    super("Agent runner: " + code);
    this.code = code;
    // Non-secret state for diagnosing a failure (never prompt or output text).
    this.detail = detail;
  }
}

// The output is untrusted data: drop ANSI sequences and control characters
// other than newline and tab before it reaches a caller.
export function sanitizeText(value, limit = RESULT_TEXT_CAP) {
  let text = String(value ?? "")
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
  if (text.length > limit) text = text.slice(0, limit);
  return text;
}
const short = (value) =>
  typeof value === "string" ? sanitizeText(value, 200) : null;
const count = (value) =>
  Number.isSafeInteger(value) && value >= 0 ? value : null;

const cursor = {
  id: "cursor-agent",
  executable: "cursor-agent",
  version_command: ["--version"],
  login_command: ["status"],
  permissions: {
    // Mappings onto the CLI's own flags, not an OS boundary. `ask` alone has
    // been reported to run terminal commands in some versions, so the CLI
    // sandbox is requested as well. `edit` has no flag: tools that need
    // approval fail in -p mode.
    "read-only": ["--mode", "ask", "--sandbox", "enabled"],
    edit: [],
    full: ["--force"],
  },
  promptCap: CURSOR_PROMPT_CAP,
  buildArgv({ project, model, resume, permission, prompt }) {
    // A positional starting with "-" would be parsed as an option.
    const text = prompt.startsWith("-") ? " " + prompt : prompt;
    return [
      "-p",
      "--output-format",
      "json",
      "--trust",
      "--workspace",
      project,
      ...(model ? ["--model", model] : []),
      ...(resume ? ["--resume", resume] : []),
      ...cursor.permissions[permission],
      text,
    ];
  },
  async parse({ stdout, stdoutTruncated }) {
    if (stdoutTruncated) throw new RunnerError("output_too_large");
    let value;
    try {
      value = JSON.parse(stdout);
    } catch {
      throw new RunnerError("invalid_json");
    }
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      value.type !== "result" ||
      typeof value.result !== "string"
    )
      throw new RunnerError("invalid_output");
    const usage = {};
    for (const [from, to] of [
      ["inputTokens", "input_tokens"],
      ["outputTokens", "output_tokens"],
      ["cacheReadTokens", "cache_read_tokens"],
      ["cacheWriteTokens", "cache_write_tokens"],
    ])
      if (count(value.usage?.[from]) !== null) usage[to] = value.usage[from];
    const parsed = {
      text: sanitizeText(value.result),
      session_id: short(value.session_id),
      duration_ms: count(value.duration_ms),
      usage,
    };
    if (value.is_error === true) {
      const error = new RunnerError("agent_error");
      error.parsed = parsed;
      throw error;
    }
    return parsed;
  },
};

const devin = {
  id: "devin",
  executable: "devin",
  version_command: ["--version"],
  login_command: ["auth", "status"],
  permissions: {
    // Devin's `auto` mode asks before writes and shell commands, but allow
    // rules in the user's own config still apply. Its `--sandbox` only limits
    // writes to the workspace, so it is deliberately not added here.
    "read-only": ["--permission-mode", "auto"],
    edit: ["--permission-mode", "accept-edits"],
    full: ["--permission-mode", "dangerous"],
  },
  promptCap: PROMPT_CAP,
  buildArgv({ model, resume, permission, trustWorkspace, promptFile, exportFile }) {
    return [
      "-p",
      "--prompt-file",
      promptFile,
      ...devin.permissions[permission],
      "--export",
      exportFile,
      ...(model ? ["--model", model] : []),
      ...(resume ? ["--resume", resume] : []),
      // Only when the operator named the project and accepted the risk.
      ...(trustWorkspace ? ["--respect-workspace-trust", "false"] : []),
    ];
  },
  async parse({ stdout, stdoutTruncated, jobDirectory }) {
    const parsed = {
      text: sanitizeText(stdout),
      truncated: stdoutTruncated,
      export: "unavailable",
      session_id: null,
      model_name: null,
      steps: null,
    };
    try {
      const file = path.join(jobDirectory, "export.json");
      const stat = await fs.stat(file);
      if (!stat.isFile() || stat.size > EXPORT_CAP) return parsed;
      await fs.chmod(file, 0o600).catch(() => {});
      const value = JSON.parse(await fs.readFile(file, "utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value))
        return parsed;
      parsed.export = "available";
      parsed.schema_version = short(value.schema_version);
      parsed.session_id = short(value.session_id);
      parsed.model_name = short(value.agent?.model_name);
      const steps = [value.steps, value.trajectory?.steps, value.trajectory].find(
        Array.isArray,
      );
      parsed.steps = steps ? steps.length : null;
    } catch {
      // Missing or broken export: the text is still the result.
    }
    return parsed;
  },
};

const runners = [cursor, devin];
export const runnerCatalog = () => runners;
export const publicCatalog = () =>
  runners.map((r) => ({
    id: r.id,
    executable: r.executable,
    version_command: [r.executable, ...r.version_command],
    login_command: [r.executable, ...r.login_command],
    permissions: r.permissions,
  }));
function runnerFor(id) {
  const runner = runners.find((r) => r.id === id);
  if (!runner) throw new RunnerError("invalid_runner");
  return runner;
}

// Absolute so the supervisor and the CLIs (which run in the project
// directory) never depend on the working directory of the submitting process.
function jobsRoot() {
  return path.resolve(stateHome(), "agent-jobs");
}
function jobDirectory(id) {
  if (typeof id !== "string" || !JOB_ID.test(id))
    throw new RunnerError("invalid_job_id");
  return path.join(jobsRoot(), id);
}
async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new RunnerError("job_corrupt");
  }
}
const exists = (file) =>
  fs.access(file).then(
    () => true,
    () => false,
  );
function alive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}
// Linux: /proc/<pid>/stat is "pid (comm) state ppid pgrp ...". The comm field
// may contain spaces and parentheses, so parse after its last ")".
export function parseProcStat(text) {
  const end = String(text).lastIndexOf(")");
  if (end < 0) return null;
  const fields = String(text)
    .slice(end + 1)
    .trim()
    .split(/\s+/);
  const pgrp = Number(fields[2]);
  if (!fields[0] || !Number.isInteger(pgrp)) return null;
  return {
    state: fields[0],
    ppid: Number(fields[1]),
    pgrp,
    starttime: fields[19] ?? null, // field 22 of /proc/PID/stat
  };
}
// Scans /proc for the live (non-zombie) members of a group. Zombies cannot
// run anything; a container without a reaping PID 1 keeps them in the group
// forever, so kill(-pgid, 0) alone would report such a group as alive. Only
// ENOENT/ESRCH (the process vanished) counts as "gone"; any other read error
// or unparsable content sets `unknown`, because it hides a possible member.
// `available: false` means /proc itself is not readable.
export function scanProcGroup(pgid, procDir = "/proc") {
  let names;
  try {
    names = readdirSync(procDir);
  } catch {
    return { available: false, live: [], unknown: false };
  }
  const live = [];
  let unknown = false;
  for (const name of names) {
    if (!/^[0-9]+$/.test(name)) continue;
    let text;
    try {
      text = readFileSync(path.join(procDir, name, "stat"), "utf8");
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ESRCH") unknown = true;
      continue;
    }
    const stat = parseProcStat(text);
    if (!stat) {
      unknown = true;
      continue;
    }
    if (stat.pgrp === pgid && stat.state !== "Z" && stat.state !== "X")
      live.push({ pid: Number(name), starttime: stat.starttime });
  }
  return { available: true, live, unknown };
}
// true: a live member exists. false: none. "unknown": none seen but some
// /proc entry could not be read. undefined: /proc is not available.
export function procGroupHasLiveMember(pgid, procDir = "/proc") {
  const scan = scanProcGroup(pgid, procDir);
  if (!scan.available) return undefined;
  if (scan.live.length) return true;
  return scan.unknown ? "unknown" : false;
}
// macOS and other systems without /proc fall back to kill(-pgid, 0); there
// launchd normally reaps orphans, so zombie-only groups are short lived.
export function groupAlive(pgid, procDir) {
  if (process.platform === "win32") return alive(pgid);
  if (!Number.isInteger(pgid) || pgid < 2) return false;
  if (process.platform === "linux" || procDir !== undefined) {
    const live = procGroupHasLiveMember(pgid, procDir);
    if (live === true || live === false) return live;
    // "unknown" (unreadable /proc entry) and undefined (no /proc) fall back to
    // kill(-pgid, 0); only ESRCH establishes that the group is absent.
  }
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}
function signalGroup(pgid, signal) {
  if (!Number.isInteger(pgid) || pgid < 2) return;
  try {
    if (process.platform === "win32")
      execFile("taskkill", ["/pid", String(pgid), "/T", "/F"], () => {});
    else process.kill(-pgid, signal);
  } catch {
    // Already gone.
  }
}
// Stop timings shared by the supervisor and cancel(): cancel must wait at
// least as long as the supervisor may need to stop the group and write its
// result, or a slow stop (e.g. taskkill on Windows) is misreported.
const STOP_TERM_MS = 2000;
const STOP_KILL_MS = 3000;
const TASKKILL_TIMEOUT_MS = 10000;
const PIPE_GRACE_MS = 2000;
// Watcher tick, the cancel stop and the post-exit stop (POSIX) or one taskkill
// (Windows), the pipe grace, and a margin for writing the result.
const SUPERVISOR_STOP_MS =
  100 + Math.max(2 * (STOP_TERM_MS + STOP_KILL_MS), TASKKILL_TIMEOUT_MS) + PIPE_GRACE_MS + 1000;
// How long cancel() waits. A running job is stopped by its supervisor, so the
// wait covers the supervisor's own stop budget, not only this call's
// TERM/KILL budget.
export function cancelWaitMs({ running, termMs, killMs }) {
  return Math.max(termMs + killMs + 3000, running ? SUPERVISOR_STOP_MS : 0);
}
export const supervisorStopMs = () => SUPERVISOR_STOP_MS;
// Runs `taskkill /PID <pid> /T /F` and resolves true only when it succeeded.
// Windows only; the tree is reachable through the leader PID while it lives.
function taskkillTree(pid, timeout = TASKKILL_TIMEOUT_MS) {
  return new Promise((resolve) => {
    try {
      execFile("taskkill", ["/pid", String(pid), "/T", "/F"], { timeout }, (error) =>
        resolve(!error));
    } catch {
      resolve(false);
    }
  });
}
// Windows has no process groups and this runner has no Job Object support, so
// only the leader PID can be observed. The tree can be killed only while the
// leader is alive; once it has exited the descendants cannot be observed, so
// the stop is never reported as confirmed.
async function stopWindowsTree(pgid, { taskkill = taskkillTree, isAlive = alive } = {}) {
  if (!isAlive(pgid)) return { cleanup: "unconfirmed", code: "windows_tree_unobservable" };
  const ok = await taskkill(pgid);
  return {
    cleanup: "unconfirmed",
    code: ok ? "windows_tree_unobservable" : "windows_taskkill_failed",
  };
}
// The one stop routine, used by normal completion and by cancel: TERM the
// group, wait, KILL, wait, then report whether it is really gone. Resolves to
// { cleanup, code } (code only set when the stop is unconfirmed on Windows).
// `platform`, `taskkill` and `isAlive` are test seams for the win32 branch.
export async function stopGroup(
  pgid,
  {
    termMs = STOP_TERM_MS,
    killMs = STOP_KILL_MS,
    platform = process.platform,
    taskkill,
    isAlive,
  } = {},
) {
  if (!pgid) return { cleanup: "confirmed" };
  if (platform === "win32") return stopWindowsTree(pgid, { taskkill, isAlive });
  if (!groupAlive(pgid)) return { cleanup: "confirmed" };
  for (const [signal, limit] of [
    ["SIGTERM", termMs],
    ["SIGKILL", killMs],
  ]) {
    signalGroup(pgid, signal);
    const until = Date.now() + limit;
    while (Date.now() < until && groupAlive(pgid)) await pause(25);
    if (!groupAlive(pgid)) return { cleanup: "confirmed" };
  }
  return { cleanup: groupAlive(pgid) ? "unconfirmed" : "confirmed" };
}
export async function terminateGroup(pgid, options) {
  return (await stopGroup(pgid, options)).cleanup;
}

// Decides whether a recorded group number still belongs to the job, for
// signals sent from outside the supervisor. "owned" only when the recorded
// leader identity matches the live leader. A number alone never counts, and
// neither does the state of the remaining members: once the leader is gone,
// start times do not prove the group is the same one (the number may have been
// recycled by a new group whose own leader has since exited). Leader gone,
// unknown or no recorded identity is "unknown": nothing may be signalled.
// The supervisor's own cleanup (terminateGroup right after the leader exits)
// does not use this check; it has watched the group continuously.
export async function establishOwnership(
  pgid,
  identity,
  { read = readProcessIdentity } = {},
) {
  if (!validProcessIdentity(identity) || !Number.isInteger(pgid) || pgid < 2)
    return "unknown";
  const verdict = matchProcessIdentity(identity, await read(pgid));
  if (verdict === "alive") return "owned";
  if (verdict === "pid_reused") return "pid_reused";
  return "unknown";
}

async function resolveExecutable(runner, explicit) {
  const candidates = [];
  if (explicit !== undefined && explicit !== null) {
    if (typeof explicit !== "string" || !explicit || explicit.includes("\0"))
      throw new RunnerError("executable_not_found");
    candidates.push(path.resolve(explicit));
  } else {
    for (const dir of (process.env.PATH || "").split(path.delimiter)) {
      if (!dir || !path.isAbsolute(dir)) continue;
      candidates.push(
        path.join(
          dir,
          process.platform === "win32" ? runner.executable + ".exe" : runner.executable,
        ),
      );
    }
  }
  for (const candidate of candidates) {
    try {
      const real = await fs.realpath(candidate);
      if (!(await fs.stat(real)).isFile()) continue;
      if (process.platform !== "win32") await fs.access(real, 1);
      return real;
    } catch {
      // Try the next PATH entry.
    }
  }
  throw new RunnerError("executable_not_found");
}
function probe(executable, args) {
  return new Promise((resolve) => {
    execFile(
      executable,
      args,
      {
        timeout: PROBE_TIMEOUT_MS,
        maxBuffer: 64 * 1024,
        windowsHide: true,
        cwd: os.tmpdir(),
        env: process.env,
        shell: false,
      },
      (error, stdout, stderr) =>
        resolve({ ok: !error, stdout: String(stdout), stderr: String(stderr) }),
    );
  });
}
async function probeVersion(runner, executable, entrypoint) {
  const result = await probe(executable, [
    ...(entrypoint ? [entrypoint] : []),
    ...runner.version_command,
  ]);
  const line = sanitizeText(result.stdout, 400).trim().split("\n")[0].slice(0, 200);
  if (!result.ok || !line) throw new RunnerError("version_probe_failed");
  return line;
}
// Exit code and a "Logged in" marker only; the output holds the account
// e-mail address, so only a boolean leaves this function.
async function probeLogin(runner, executable, entrypoint) {
  const result = await probe(executable, [
    ...(entrypoint ? [entrypoint] : []),
    ...runner.login_command,
  ]);
  return result.ok && /Logged in/.test(result.stdout + result.stderr);
}

// Optional script run by `executable` (e.g. a Node-based CLI on Windows, where
// shebang scripts cannot be executed directly).
async function resolveEntrypoint(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !value || value.includes("\0"))
    throw new RunnerError("invalid_entrypoint");
  try {
    const real = await fs.realpath(path.resolve(value));
    if (!(await fs.stat(real)).isFile()) throw new Error();
    return real;
  } catch {
    throw new RunnerError("invalid_entrypoint");
  }
}

function checkToken(value, code) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !TOKEN.test(value))
    throw new RunnerError(code);
  return value;
}

export async function submit({
  runner: runnerId,
  project,
  promptFile,
  model,
  permission = "read-only",
  resume,
  trustWorkspace = false,
  executable,
  entrypoint,
}) {
  const runner = runnerFor(runnerId);
  if (!PERMISSIONS.includes(permission))
    throw new RunnerError("invalid_permission");
  model = checkToken(model, "invalid_model");
  resume = checkToken(resume, "invalid_resume");
  if (trustWorkspace && runner.id !== "devin")
    throw new RunnerError("trust_workspace_unsupported");
  let root;
  try {
    root = await fs.realpath(path.resolve(String(project ?? "")));
    if (!(await fs.stat(root)).isDirectory()) throw new Error();
  } catch {
    throw new RunnerError("invalid_project");
  }
  let prompt;
  try {
    const handle = await fs.open(promptFile, "r");
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new RunnerError("prompt_unreadable");
      if (stat.size > runner.promptCap) throw new RunnerError("prompt_too_large");
      prompt = await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
  } catch (error) {
    throw error instanceof RunnerError ? error : new RunnerError("prompt_unreadable");
  }
  if (Buffer.byteLength(prompt) > runner.promptCap)
    throw new RunnerError("prompt_too_large");
  if (!prompt.trim() || prompt.includes("\0"))
    throw new RunnerError("invalid_prompt");
  const resolved = await resolveExecutable(runner, executable);
  const resolvedEntrypoint = await resolveEntrypoint(entrypoint);
  const version = await probeVersion(runner, resolved, resolvedEntrypoint);

  const id = "job_" + randomBytes(12).toString("hex");
  const directory = jobDirectory(id);
  await fs.mkdir(jobsRoot(), { recursive: true, mode: 0o700 });
  await fs.mkdir(directory, { mode: 0o700 });
  await fs.writeFile(path.join(directory, "prompt.txt"), prompt, { mode: 0o600 });
  const job = {
    id,
    runner: runner.id,
    project: root,
    model,
    permission,
    resume,
    trust_workspace: Boolean(trustWorkspace),
    created_at: new Date().toISOString(),
    executable: resolved,
    entrypoint: resolvedEntrypoint,
    version,
    supervisor_pid: null,
    agent_pid: null,
    agent_pgid: null,
    state: "queued",
  };
  await writeJson(path.join(directory, "job.json"), job);
  const supervisor = spawn(process.execPath, [self, "__supervise", directory], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    shell: false,
    env: process.env,
  });
  supervisor.on("error", () => {});
  supervisor.unref();
  return publicJob(job);
}

function publicJob(job) {
  return {
    id: job.id,
    runner: job.runner,
    project: job.project,
    model: job.model,
    permission: job.permission,
    resume: job.resume,
    trust_workspace: job.trust_workspace,
    created_at: job.created_at,
    executable: job.executable,
    entrypoint: job.entrypoint ?? null,
    version: job.version,
    state: job.state,
  };
}

async function load(id) {
  const directory = jobDirectory(id);
  const job = await readJson(path.join(directory, "job.json"));
  if (!job) throw new RunnerError("job_not_found");
  const result = await readJson(path.join(directory, "result.json"));
  return { directory, job, result };
}

async function writeResult(directory, value, write = writeJson) {
  await write(path.join(directory, "result.json"), value);
}

export async function status(id) {
  const { directory, job, result } = await load(id);
  let final = result;
  if (!final && ["queued", "running"].includes(job.state)) {
    const age = Date.now() - Date.parse(job.created_at);
    const lost = job.supervisor_pid
      ? !alive(job.supervisor_pid)
      : age > 30000; // the supervisor has not announced itself
    if (lost) {
      // The supervisor may have written its result just before dying.
      final =
        (await readJson(path.join(directory, "result.json"))) ||
        (await recordLost(directory));
    }
  }
  const started = Date.parse(job.started_at || job.created_at);
  const finished = final ? Date.parse(final.finished_at) : Date.now();
  return {
    id: job.id,
    runner: job.runner,
    state: final ? final.state : job.state,
    code: final?.code ?? null,
    project: job.project,
    permission: job.permission,
    model: job.model,
    created_at: job.created_at,
    started_at: job.started_at ?? null,
    finished_at: final?.finished_at ?? null,
    elapsed_ms: Math.max(0, finished - started),
    // "confirmed": the agent's process group was verified gone when the job
    // ended. "unconfirmed": it was not; cancel can still act on it.
    cleanup: final ? (final.cleanup ?? null) : null,
    // Why a stop could not be confirmed: "pgid_reused", "ownership_unknown",
    // "windows_tree_unobservable" or "windows_taskkill_failed".
    cleanup_code: final?.cleanup_code ?? null,
    // A confirmed job is not probed again: its number may have been reused.
    agent_group_alive: !final || !job.agent_pgid
      ? null
      : final.cleanup === "confirmed"
        ? false
        : Boolean(groupAlive(job.agent_pgid)),
  };
}
async function recordLost(directory) {
  const job = await readJson(path.join(directory, "job.json"));
  const value = {
    state: "failed",
    code: "supervisor_lost",
    exit_code: null,
    signal: null,
    finished_at: new Date().toISOString(),
    parsed: null,
    // The agent may have outlived its supervisor; keep agent_pgid in job.json.
    ...(process.platform === "win32" && job?.agent_pgid
      ? { cleanup: "unconfirmed", cleanup_code: "windows_tree_unobservable" }
      : {
          cleanup: job?.agent_pgid && groupAlive(job.agent_pgid) ? "unconfirmed" : "confirmed",
        }),
  };
  await writeResult(directory, value);
  return value;
}

export async function result(id) {
  const info = await status(id);
  const { result: stored } = await load(id);
  return {
    ...info,
    provenance: "untrusted_data",
    exit_code: stored?.exit_code ?? null,
    signal: stored?.signal ?? null,
    stdout_truncated: stored?.stdout_truncated ?? false,
    stderr_truncated: stored?.stderr_truncated ?? false,
    result: stored?.parsed ?? null,
  };
}

// Stops the agent's group from outside the supervisor. A running job is
// cancelled through its supervisor (it holds the child handle); a signal is
// sent by number only after the group's ownership is established. A terminal
// job with a confirmed stop is a no-op and is not even probed.
export async function cancel(
  id,
  { termMs = 5000, killMs = 5000, platform = process.platform, taskkill = taskkillTree } = {},
) {
  const win = platform === "win32";
  const { directory } = await load(id);
  const initial = await status(id);
  const first = await load(id);
  const running = ["queued", "running"].includes(initial.state);
  if (!running && first.result?.cleanup === "confirmed") return initial;
  if (!running && !(first.job.agent_pgid && groupAlive(first.job.agent_pgid)))
    return initial;
  const started = Date.now();
  const deadline = started + cancelWaitMs({ running, termMs, killMs });
  if (running) {
    await fs.writeFile(path.join(directory, "cancel"), "", { mode: 0o600 });
    // The supervisor stops the group itself; a lost one is recorded by status.
    while ((await load(id)).result === null && Date.now() < deadline) {
      await status(id);
      await pause(50);
    }
  }
  let { job, result: stored } = await load(id);
  if (!stored)
    throw new RunnerError("cancel_unconfirmed", {
      reason: "no_supervisor_result",
      waited_ms: Date.now() - started,
      job_state: job.state ?? null,
      supervisor_alive: alive(job.supervisor_pid),
      agent_alive: job.agent_pid ? alive(job.agent_pid) : null,
    });
  const lost = stored.code === "supervisor_lost";
  const settle = async (extra) => {
    const next = { ...stored, ...extra };
    if (next.cleanup === "confirmed") delete next.cleanup_code;
    await writeResult(directory, next);
  };
  if (job.agent_pgid && groupAlive(job.agent_pgid)) {
    let verdict = "stuck";
    for (const [signal, limit] of [
      ["SIGTERM", termMs],
      ["SIGKILL", killMs],
    ]) {
      if (!groupAlive(job.agent_pgid)) {
        verdict = "stopped";
        break;
      }
      const owner = await establishOwnership(job.agent_pgid, job.agent_identity);
      if (owner !== "owned") {
        verdict = owner;
        break;
      }
      // Windows: the tree is reachable only through the live leader, and the
      // kill is awaited, not fired and forgotten.
      if (win) await taskkill(job.agent_pgid);
      else signalGroup(job.agent_pgid, signal);
      const until = Date.now() + limit;
      while (Date.now() < until && groupAlive(job.agent_pgid)) await pause(25);
    }
    if (verdict === "stuck" && !groupAlive(job.agent_pgid)) verdict = "stopped";
    if (verdict === "pid_reused") {
      // The number now names someone else's group; the job lost its handle.
      await settle({ cleanup: "unconfirmed", cleanup_code: "pgid_reused" });
      return status(id);
    }
    if (verdict === "unknown") {
      await settle({ cleanup: "unconfirmed", cleanup_code: "ownership_unknown" });
      throw new RunnerError("cancel_unconfirmed");
    }
    if (verdict === "stuck") throw new RunnerError("cancel_unconfirmed");
  }
  if (win) {
    // Descendants of an exited Windows leader cannot be observed, so the stop
    // is never promoted to confirmed. The leader tree has been killed above
    // while the leader was alive; a lost supervisor's job still ends cancelled.
    if (lost || stored.cleanup === "confirmed" || !stored.cleanup_code)
      await settle({
        ...(lost ? { state: "cancelled", code: "cancelled" } : {}),
        cleanup: "unconfirmed",
        cleanup_code: stored.cleanup_code ?? "windows_tree_unobservable",
      });
  } else if (stored.cleanup !== "confirmed" || lost) {
    // The group is now verified gone. A job whose supervisor was lost never
    // reported an outcome, so the cancel is its outcome; other results stay.
    await settle({
      ...(lost ? { state: "cancelled", code: "cancelled" } : {}),
      cleanup: "confirmed",
    });
  }
  return status(id);
}

export async function list({ probe: doProbe = false, limit = 20 } = {}) {
  const catalog = [];
  for (const runner of runners) {
    const entry = {
      ...publicCatalog().find((r) => r.id === runner.id),
    };
    if (doProbe) {
      try {
        const resolved = await resolveExecutable(runner);
        entry.resolved_executable = resolved;
        entry.version = await probeVersion(runner, resolved).catch(() => null);
        entry.logged_in = await probeLogin(runner, resolved);
      } catch (error) {
        entry.resolved_executable = null;
        entry.version = null;
        entry.logged_in = null;
        entry.probe_error = error.code || "probe_failed";
      }
    }
    catalog.push(entry);
  }
  const jobs = [];
  let names = [];
  try {
    names = (await fs.readdir(jobsRoot())).filter((n) => JOB_ID.test(n));
  } catch {
    // No jobs yet.
  }
  for (const name of names) {
    try {
      const info = await status(name);
      jobs.push({
        id: info.id,
        runner: info.runner,
        state: info.state,
        code: info.code,
        created_at: info.created_at,
        elapsed_ms: info.elapsed_ms,
      });
    } catch {
      // Skip unreadable job directories.
    }
  }
  jobs.sort((a, b) => b.created_at.localeCompare(a.created_at));
  return { runners: catalog, jobs: jobs.slice(0, limit) };
}

export async function waitForJob(id, { intervalMs = 200, timeoutMs = 0 } = {}) {
  const started = Date.now();
  for (;;) {
    const info = await status(id);
    if (!["queued", "running"].includes(info.state)) return info;
    if (timeoutMs && Date.now() - started > timeoutMs)
      throw new RunnerError("wait_timeout");
    await pause(intervalMs);
  }
}

// Writes at most `cap` bytes and keeps draining so the child never blocks.
// A write error never throws out of the stream handler: the sink stops
// accepting data and reports once through `onError`. close() is idempotent.
function sink(file, cap, onError, io = { openSync, writeSync, closeSync }) {
  const fd = io.openSync(file, "w", 0o600);
  const state = { bytes: 0, truncated: false };
  let failed = false;
  let closed = false;
  return {
    state,
    write(chunk) {
      if (failed) return;
      const room = cap - state.bytes;
      try {
        if (room > 0) {
          const part = chunk.length > room ? chunk.subarray(0, room) : chunk;
          io.writeSync(fd, part);
          state.bytes += part.length;
        }
      } catch {
        failed = true;
        onError();
        return;
      }
      if (chunk.length > Math.max(room, 0)) state.truncated = true;
    },
    close() {
      if (closed) return;
      closed = true;
      try {
        io.closeSync(fd);
      } catch {}
    },
  };
}
async function readCapped(file, size) {
  const handle = await fs.open(file, "r");
  try {
    const buffer = Buffer.alloc(Math.min(size, OUTPUT_CAP));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

// `deps` is a test seam: writeJson/openSync/writeSync/closeSync default to the
// real ones. The CLI entry below never passes it.
export async function supervise(directory, deps = {}) {
  const write = deps.writeJson ?? writeJson;
  const sinkFs = {
    openSync: deps.openSync ?? openSync,
    writeSync: deps.writeSync ?? writeSync,
    closeSync: deps.closeSync ?? closeSync,
  };
  const jobFile = path.join(directory, "job.json");
  const job = await readJson(jobFile);
  const runner = runnerFor(job.runner);
  const cancelFile = path.join(directory, "cancel");
  const finish = async (fields) => {
    const finished_at = new Date().toISOString();
    await writeResult(directory, {
      cleanup: "confirmed", // no agent process was started
      exit_code: null,
      signal: null,
      stdout_truncated: false,
      stderr_truncated: false,
      parsed: null,
      ...fields,
      finished_at,
    }, write);
    await write(jobFile, { ...job, state: fields.state });
  };
  job.supervisor_pid = process.pid;
  job.started_at = new Date().toISOString();
  job.state = "running";
  await write(jobFile, job);
  if (await exists(cancelFile))
    return finish({ state: "cancelled", code: "cancelled" });

  let prompt;
  try {
    prompt = await fs.readFile(path.join(directory, "prompt.txt"), "utf8");
  } catch {
    return finish({ state: "failed", code: "prompt_unreadable" });
  }
  const argv = runner.buildArgv({
    project: job.project,
    model: job.model,
    resume: job.resume,
    permission: job.permission,
    trustWorkspace: job.trust_workspace,
    promptFile: path.join(directory, "prompt.txt"),
    exportFile: path.join(directory, "export.json"),
    prompt,
  });
  // From the moment the child exists, `fail` is the one way to stop it early:
  // the first reason wins and the group is stopped once.
  let child;
  let failure = null;
  let stopping = null;
  const fail = (code) => {
    failure ??= code;
    stopping ??= stopGroup(child.pid);
  };
  const out = sink(path.join(directory, "stdout"), OUTPUT_CAP, () => fail("output_write_failed"), sinkFs);
  let err;
  try {
    err = sink(path.join(directory, "stderr"), OUTPUT_CAP, () => fail("output_write_failed"), sinkFs);
  } catch {
    out.close();
    return finish({ state: "failed", code: "output_write_failed" });
  }
  try {
    child = spawn(job.executable, [...(job.entrypoint ? [job.entrypoint] : []), ...argv], {
      cwd: job.project,
      env: process.env,
      shell: false,
      detached: true, // own process group, so cancel reaches descendants
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    out.close();
    err.close();
    return finish({ state: "failed", code: "spawn_failed" });
  }
  const exited = new Promise((resolve) => {
    child.once("error", () => resolve({ spawnFailed: true }));
    child.once("exit", (exit_code, signal) => resolve({ exit_code, signal }));
  });
  if (!child.pid) {
    out.close();
    err.close();
    return finish({ state: "failed", code: "spawn_failed" });
  }
  // Registered now: a stream can close before the process exit is observed.
  const closed = [child.stdout, child.stderr].map(
    (stream) => new Promise((resolve) => stream.once("close", resolve)),
  );
  child.stdout.on("data", (chunk) => out.write(chunk));
  child.stderr.on("data", (chunk) => err.write(chunk));
  let exitedAlready = false;
  let cancelling = null;
  let watcher;
  const forward = () => signalGroup(job.agent_pgid, "SIGTERM");
  let identityRead = Promise.resolve();
  try {
    job.agent_pid = child.pid;
    job.agent_pgid = child.pid;
    job.agent_identity = null;
    await write(jobFile, job);
    // cancel() only writes the cancel file; this supervisor holds the child
    // handle, so it is the one that stops the group. The watcher starts before
    // the identity is read (PowerShell on Windows can take seconds), so a cancel
    // that arrives meanwhile is not delayed beyond SUPERVISOR_STOP_MS.
    watcher = setInterval(async () => {
      if (exitedAlready || cancelling || !(await exists(cancelFile))) return;
      if (exitedAlready) return; // the child exited while the file was checked
      cancelling = stopGroup(job.agent_pgid);
    }, 100);
    process.on("SIGTERM", forward);
    process.on("SIGINT", forward);
    // Lets cancel later prove the number still names this job's group. Read in
    // the background and awaited before the result, so job.json is never
    // rewritten after the job has finished.
    identityRead = readProcessIdentity(child.pid)
      .then(async ({ identity }) => {
        if (!identity) return;
        job.agent_identity = identity;
        await write(jobFile, job);
      })
      .catch(() => {});
  } catch {
    // Initialisation failed with a live child: stop it using our own handle
    // (job.json may not name it, so cancel could never find it), release the
    // sinks, then record the failure if that is still possible.
    exitedAlready = true;
    clearInterval(watcher);
    process.off("SIGTERM", forward);
    process.off("SIGINT", forward);
    fail("supervisor_init_failed");
    const stopped = await stopping;
    child.stdout.destroy();
    child.stderr.destroy();
    out.close();
    err.close();
    try {
      await finish({
        state: "failed",
        code: failure,
        cleanup: stopped.cleanup,
        ...(stopped.code ? { cleanup_code: stopped.code } : {}),
      });
    } catch {} // the child is already stopped; nothing more can be recorded
    return;
  }

  const exit = await exited;
  exitedAlready = true;
  clearInterval(watcher);
  await cancelling;
  await identityRead;
  await stopping; // a sink failure may have started the stop
  // Reap leftover descendants right away, by the supervisor's own pgid: this
  // process saw the group non-empty up to the leader's exit, so the number
  // cannot have been recycled yet. No waiting before this, and no external
  // ownership check (that one is only for signals from outside).
  const stopped = await stopGroup(job.agent_pgid);
  const cleanup = stopped.cleanup;
  // Pipes held open by descendants must not stall the job.
  await Promise.race([
    Promise.all(closed),
    pause(PIPE_GRACE_MS),
  ]);
  child.stdout.destroy();
  child.stderr.destroy();
  out.close();
  err.close();

  const base = {
    cleanup,
    ...(stopped.code ? { cleanup_code: stopped.code } : {}),
    exit_code: exit.exit_code ?? null,
    signal: exit.signal ?? null,
    stdout_truncated: out.state.truncated,
    stderr_truncated: err.state.truncated,
  };
  if (failure) return finish({ ...base, state: "failed", code: failure });
  if (exit.spawnFailed)
    return finish({ ...base, state: "failed", code: "spawn_failed" });
  if (await exists(cancelFile))
    return finish({ ...base, state: "cancelled", code: "cancelled" });
  try {
    const stdout = await readCapped(path.join(directory, "stdout"), out.state.bytes);
    const stderr = await readCapped(path.join(directory, "stderr"), err.state.bytes);
    if (exit.signal) throw new RunnerError("terminated_by_signal");
    // Fixed marker, not stderr text, so no raw agent output leaks into codes.
    if (
      runner.id === "devin" &&
      exit.exit_code !== 0 &&
      stderr.includes("Refusing to run in an untrusted workspace")
    )
      throw new RunnerError("workspace_untrusted");
    if (exit.exit_code !== 0) throw new RunnerError("nonzero_exit");
    const parsed = await runner.parse({
      stdout,
      stdoutTruncated: out.state.truncated,
      jobDirectory: directory,
    });
    return finish({ ...base, state: "succeeded", code: null, parsed });
  } catch (error) {
    return finish({
      ...base,
      state: "failed",
      code: error instanceof RunnerError ? error.code : "parse_failed",
      parsed: error.parsed ?? null,
    });
  }
}

if (
  process.argv[2] === "__supervise" &&
  process.argv[1] &&
  path.resolve(process.argv[1]) === self
) {
  supervise(process.argv[3]).catch(async () => {
    // Last resort: an unreadable job is reported by status as supervisor_lost.
    process.exitCode = 1;
  });
}
