import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  matchProcessIdentity,
  readProcessIdentity,
  validProcessIdentity,
} from "./process-identity.mjs";

const execFile = promisify(execFileCallback);
const validPid = (pid) =>
  Number.isSafeInteger(pid) && pid > 0 && pid <= 2147483647;
const cliKinds = new Set(["dsh", "rdsh", "other"]);
const maximumObservedProcesses = 32;

async function ownerFingerprint(pid, scope) {
  let owner;
  try {
    if (process.platform === "linux") {
      const status = await fs.readFile(`/proc/${pid}/status`, "utf8");
      const uids = /^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/m.exec(status);
      if (!uids) return null;
      owner = `uid:${uids.slice(1).join(":")}`;
    } else if (process.platform === "win32") {
      const script = `$ErrorActionPreference='Stop'; try { $p=Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'; if (!$p) { @{status='gone'} | ConvertTo-Json -Compress; exit }; $r=Invoke-CimMethod -InputObject $p -MethodName GetOwnerSid; if ($r.ReturnValue -ne 0 -or !$r.Sid) { throw 'owner unavailable' }; @{status='observed';sid=$r.Sid} | ConvertTo-Json -Compress } catch { '{"status":"unknown"}' }`;
      const executable = path.join(
        process.env.SystemRoot || "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      );
      const { stdout } = await execFile(
        executable,
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
        { windowsHide: true, shell: false, timeout: 5000, maxBuffer: 4096 },
      );
      const result = JSON.parse(stdout);
      if (result.status !== "observed" || typeof result.sid !== "string")
        return null;
      owner = `sid:${result.sid.toLowerCase()}`;
    } else return null;
  } catch {
    return null;
  }
  return createHash("sha256").update(`${scope}\n${owner}`).digest("hex");
}

export async function observeExternalProcess(pid) {
  if (!validPid(pid)) return { status: "unknown", identity: null };
  for (let attempt = 0; attempt < 2; attempt++) {
    const before = await readProcessIdentity(pid);
    if (before.status !== "observed" || !validProcessIdentity(before.identity))
      return before;
    const owner = await ownerFingerprint(pid, before.identity.scope);
    if (!owner) return { status: "unknown", identity: null };
    const after = await readProcessIdentity(pid);
    if (
      matchProcessIdentity(before.identity, after) === "alive" &&
      validProcessIdentity(after.identity)
    )
      return {
        status: "observed",
        identity: after.identity,
        owner_fingerprint: owner,
      };
  }
  return { status: "unknown", identity: null };
}

export function observedCliStatus(record, observation) {
  const processStatus = matchProcessIdentity(record.identity, observation);
  if (processStatus !== "alive") return processStatus;
  if (!/^[a-f0-9]{64}$/.test(observation.owner_fingerprint || ""))
    return "unknown";
  return observation.owner_fingerprint === record.owner_fingerprint
    ? "alive"
    : "owner_mismatch";
}

const labels = {
  alive: "接続中・読取専用",
  gone: "プロセス終了を確認",
  pid_reused: "PID再利用・接続無効",
  owner_mismatch: "所有者変更・接続無効",
  unknown: "識別情報を確認できません",
};

function validateRecord(record) {
  if (
    !record ||
    typeof record !== "object" ||
    typeof record.id !== "string" ||
    !(record.task_id === null || typeof record.task_id === "string") ||
    !validPid(record.pid) ||
    !cliKinds.has(record.cli_kind) ||
    !validProcessIdentity(record.identity) ||
    record.identity.pid !== record.pid ||
    typeof record.owner_fingerprint !== "string" ||
    !/^[a-f0-9]{64}$/.test(record.owner_fingerprint) ||
    !Number.isFinite(Date.parse(record.registered_at))
  )
    throw new Error("Corrupt observed CLI record");
}

async function atomicWrite(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify(value, null, 2) + "\n", {
      mode: 0o600,
    });
    await fs.rename(temporary, file);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

export class ObservedCliStore {
  constructor(project, value, observe = observeExternalProcess) {
    this.project = project;
    this.value = value;
    this.observe = observe;
    this.queue = Promise.resolve();
  }

  static async open(project, options = {}) {
    const file = path.join(project.directory, "observed-cli.json");
    let value;
    try {
      value = JSON.parse(await fs.readFile(file, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      value = { schema: 1, project_id: project.id, revision: 0, processes: [] };
    }
    if (
      value?.schema !== 1 ||
      value.project_id !== project.id ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0 ||
    !Array.isArray(value.processes) ||
    value.processes.length > maximumObservedProcesses
    )
      throw new Error(
        "Observed CLI records belong to a different project or version",
      );
    for (const record of value.processes) validateRecord(record);
    if (
      new Set(value.processes.map((record) => record.id)).size !==
      value.processes.length
    )
      throw new Error("Observed CLI record IDs are duplicated");
    return new ObservedCliStore(project, value, options.observe);
  }

  serialize(operation) {
    const task = this.queue.then(operation);
    this.queue = task.catch(() => {});
    return task;
  }

  register(input, state) {
    return this.serialize(async () => {
      if (
        !input ||
        typeof input !== "object" ||
        Array.isArray(input) ||
        Object.keys(input).some(
          (key) => !["pid", "task_id", "cli_kind"].includes(key),
        )
      )
        throw new Error("Invalid observed CLI fields");
      if (!validPid(input.pid))
        throw new Error("pid must be a positive process ID");
      if (!cliKinds.has(input.cli_kind)) throw new Error("Select a supported CLI kind");
      const taskId =
        input.task_id === undefined ||
        input.task_id === null ||
        input.task_id === ""
          ? null
          : input.task_id;
      if (
        taskId !== null &&
        (typeof taskId !== "string" ||
          !state.tasks.some((task) => task.id === taskId))
      )
        throw new Error("Select a task that is still present in this project");
      if (this.value.processes.length >= maximumObservedProcesses)
        throw new Error("Observed CLI record limit reached");
      if (this.value.processes.some((record) => record.pid === input.pid))
        throw new Error("This process is already registered in the project");
      const observation = await this.observe(input.pid);
      if (
        observation.status !== "observed" ||
        !validProcessIdentity(observation.identity) ||
        observation.identity.pid !== input.pid ||
        typeof observation.owner_fingerprint !== "string" ||
        !/^[a-f0-9]{64}$/.test(observation.owner_fingerprint)
      )
        throw new Error(
          "Process identity and owner could not be verified; no registration was saved",
        );
      const record = {
        id: randomUUID(),
        task_id: taskId,
        cli_kind: input.cli_kind,
        pid: input.pid,
        identity: observation.identity,
        owner_fingerprint: observation.owner_fingerprint,
        registered_at: new Date().toISOString(),
      };
      const next = structuredClone(this.value);
      next.revision++;
      next.processes.push(record);
      await atomicWrite(path.join(this.project.directory, "observed-cli.json"), next);
      this.value = next;
      return structuredClone(record);
    });
  }

  unregister(input) {
    return this.serialize(async () => {
      if (typeof input.id !== "string" || !input.id)
        throw new Error("id is required");
      const next = structuredClone(this.value);
      const index = next.processes.findIndex((record) => record.id === input.id);
      if (index < 0) throw new Error("Observed CLI registration not found");
      next.processes.splice(index, 1);
      next.revision++;
      await atomicWrite(path.join(this.project.directory, "observed-cli.json"), next);
      this.value = next;
      return { removed: true, revision: next.revision };
    });
  }

  async inspect(state) {
    const records = this.value.processes;
    const processes = new Array(records.length);
    let nextIndex = 0;
    const workers = Array.from(
      { length: Math.min(4, records.length) },
      async () => {
        while (nextIndex < records.length) {
          const index = nextIndex++;
          const record = records[index];
          let observation;
          try {
            observation = await this.observe(record.pid);
          } catch {
            observation = { status: "unknown", identity: null };
          }
          const status = observedCliStatus(record, observation);
          processes[index] = {
            id: record.id,
            task_id: record.task_id,
            cli_kind: record.cli_kind,
            pid: record.pid,
            registered_at: record.registered_at,
            status,
            status_label: labels[status],
            task_present:
              record.task_id === null ||
              state.tasks.some((task) => task.id === record.task_id),
            observed_at: new Date().toISOString(),
          };
        }
      },
    );
    await Promise.all(workers);
    return { revision: this.value.revision, processes };
  }
}
