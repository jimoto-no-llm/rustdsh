import fs from "node:fs/promises";
import path from "node:path";
import { constants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { stateHome } from "./state.mjs";
import { RunHistory } from "./run-history.mjs";
import {
  readProcessIdentity,
  validProcessIdentity,
  matchProcessIdentity,
} from "./process-identity.mjs";
import { GpuError, gpuRequest, observeGpu } from "./gpu-telemetry.mjs";
import {
  gpuDirectory,
  inspectGpuDirectory,
  lockGpuLedger,
} from "./gpu-lock.mjs";

const maximum = 512 * 1024;
const activeLimit = 128,
  recentLimit = 128;
const exact = (value, keys) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join(",") === [...keys].sort().join(",");
const uuid = (value, prefix) =>
  typeof value === "string" &&
  new RegExp(
    `^${prefix}_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`,
  ).test(value);
const projectId = (id) => typeof id === "string" && /^[0-9a-f]{16}$/.test(id);
const iso = (value) =>
  typeof value === "string" &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;
const hash = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const sameIdentity = (a, b) =>
  validProcessIdentity(a) &&
  validProcessIdentity(b) &&
  ["platform", "pid", "birth", "scope"].every((key) => a[key] === b[key]);
const sameScope = (a, b) =>
  a &&
  b &&
  ["owner_id", "kind", "kernel_id", "root_pid"].every(
    (key) => a[key] === b[key],
  ) &&
  sameIdentity(a.root_identity, b.root_identity);
const empty = () => ({
  schema: 1,
  revision: 0,
  leases: [],
  waiting: [],
  released: [],
});
const check = (ok, code = "gpu_ledger_invalid") => {
  if (!ok) throw new GpuError(code);
};
function validScope(scope, owner) {
  return (
    exact(scope, [
      "owner_id",
      "kind",
      "kernel_id",
      "root_identity",
      "root_pid",
    ]) &&
    scope.owner_id === owner &&
    ["linux_cgroup_v2", "windows_job"].includes(scope.kind) &&
    typeof scope.kernel_id === "string" &&
    /^[a-z0-9_-]{1,80}$/.test(scope.kernel_id) &&
    validProcessIdentity(scope.root_identity) &&
    scope.root_identity.pid === scope.root_pid &&
    scope.root_identity.platform ===
      (scope.kind === "windows_job" ? "win32" : "linux")
  );
}
function validate(state) {
  check(
    exact(state, ["schema", "revision", "leases", "waiting", "released"]) &&
      state.schema === 1 &&
      Number.isSafeInteger(state.revision) &&
      state.revision >= 0,
  );
  check(
    Array.isArray(state.leases) &&
      state.leases.length <= activeLimit &&
      Array.isArray(state.waiting) &&
      state.waiting.length <= recentLimit &&
      Array.isArray(state.released) &&
      state.released.length <= recentLimit,
  );
  const ids = new Set(),
    runs = new Set();
  for (const lease of state.leases) {
    check(
      exact(lease, [
        "lease_id",
        "project_id",
        "run_id",
        "owner_id",
        "controller_identity",
        "request",
        "created_at",
        "heartbeat_at",
        "ttl_ms",
        "phase",
        "scope",
      ]),
    );
    check(
      uuid(lease.lease_id, "lease") &&
        projectId(lease.project_id) &&
        uuid(lease.run_id, "run") &&
        uuid(lease.owner_id, "owner") &&
        validProcessIdentity(lease.controller_identity),
    );
    check(
      !ids.has(lease.lease_id) && !runs.has(lease.project_id + lease.run_id),
    );
    ids.add(lease.lease_id);
    runs.add(lease.project_id + lease.run_id);
    check(
      iso(lease.created_at) &&
        iso(lease.heartbeat_at) &&
        lease.ttl_ms === 30000 &&
        ["reserved", "launching", "bound"].includes(lease.phase),
    );
    check(
      (lease.phase === "bound" && validScope(lease.scope, lease.owner_id)) ||
        (lease.phase !== "bound" && lease.scope === null),
    );
    check(
      JSON.stringify(gpuRequest(lease.request)) ===
        JSON.stringify(lease.request),
    );
  }
  for (const item of state.waiting) {
    check(
      exact(item, [
        "project_id",
        "run_id",
        "owner_id",
        "request",
        "reason",
        "observed_at",
      ]) &&
        projectId(item.project_id) &&
        uuid(item.run_id, "run") &&
        uuid(item.owner_id, "owner") &&
        iso(item.observed_at),
    );
    check(
      [
        "gpu_inventory_unavailable",
        "gpu_device_unavailable",
        "gpu_memory_unavailable",
        "gpu_exclusive_busy",
        "gpu_capacity_insufficient",
        "gpu_run_already_reserved",
        "gpu_ledger_full",
      ].includes(item.reason),
    );
    check(
      JSON.stringify(gpuRequest(item.request)) === JSON.stringify(item.request),
    );
  }
  for (const item of state.released) {
    check(
      exact(item, [
        "lease_id",
        "project_id",
        "run_id",
        "owner_id",
        "request",
        "released_at",
        "reason",
      ]) &&
        uuid(item.lease_id, "lease") &&
        projectId(item.project_id) &&
        uuid(item.run_id, "run") &&
        uuid(item.owner_id, "owner") &&
        iso(item.released_at),
    );
    check(
      [
        "cancelled_before_spawn",
        "unstarted_owner_absent",
        "held_kernel_group_empty",
        "recorded_kernel_group_empty",
      ].includes(item.reason),
    );
    check(
      JSON.stringify(gpuRequest(item.request)) === JSON.stringify(item.request),
    );
  }
}
export async function readGpuJson(file) {
  let handle;
  try {
    const before = await fs.lstat(file);
    check(
      before.isFile() &&
        !before.isSymbolicLink() &&
        before.nlink === 1 &&
        before.size <= maximum,
    );
    handle = await fs.open(
      file,
      constants.O_RDONLY |
        (constants.O_NOFOLLOW || 0) |
        (constants.O_NONBLOCK || 0),
    );
    const opened = await handle.stat();
    check(
      opened.isFile() &&
        opened.size <= maximum &&
        before.dev === opened.dev &&
        before.ino === opened.ino,
    );
    const bytes = await handle.readFile();
    check(bytes.length <= maximum);
    const wrapped = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
    check(
      exact(wrapped, ["payload", "sha256"]) &&
        wrapped.sha256 === hash(wrapped.payload),
    );
    return wrapped.payload;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new GpuError("gpu_ledger_invalid");
  } finally {
    await handle?.close();
  }
}
async function durableWrite(file, payload, exclusive = false) {
  const bytes = Buffer.from(
    JSON.stringify({ payload, sha256: hash(payload) }) + "\n",
  );
  check(bytes.length <= maximum, "gpu_ledger_full");
  const temp = exclusive ? file : `${file}.${randomUUID()}.tmp`;
  const handle = await fs.open(temp, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    if (!exclusive) await fs.rename(temp, file);
    if (process.platform === "linux") {
      const dir = await fs.open(path.dirname(file), "r");
      try {
        await dir.sync();
      } finally {
        await dir.close();
      }
    }
  } finally {
    if (!exclusive)
      await fs.unlink(temp).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
  }
}
// A run's explicit GPU request survives native-session resume, including other
// attachment entry points. Omitting the flag cannot silently drop its lease.
export async function runGpuRequest(
  project,
  run_id,
  requested = null,
  recorded = undefined,
) {
  check(projectId(project.id) && uuid(run_id, "run"), "invalid_gpu_run");
  if (recorded === undefined) {
    const history = await new RunHistory(project).read();
    check(!history.tail_bytes, "gpu_run_history_incomplete");
    recorded = history.runs.get(run_id)?.gpu_request ?? null;
  }
  const directory = path.join(project.directory, "gpu-runs");
  const file = path.join(directory, run_id + ".json");
  let old = await readGpuJson(file);
  if (old) {
    check(
      exact(old, ["schema", "project_id", "run_id", "request"]) &&
        old.schema === 1 &&
        old.project_id === project.id &&
        old.run_id === run_id,
      "gpu_run_invalid",
    );
    const request = gpuRequest(old.request);
    if (recorded !== null)
      check(
        hash(request) === hash(gpuRequest(recorded)),
        "gpu_run_request_changed",
      );
    if (requested !== null)
      check(
        hash(request) === hash(gpuRequest(requested)),
        "gpu_run_request_changed",
      );
    return request;
  }
  check(recorded === null, "gpu_run_request_missing");
  if (requested === null) return null;
  const request = gpuRequest(requested);
  await gpuDirectory(directory);
  try {
    await durableWrite(
      file,
      { schema: 1, project_id: project.id, run_id, request },
      true,
    );
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    old = await runGpuRequest(project, run_id, request, recorded);
    return old;
  }
  return request;
}

export class GpuLeases {
  constructor({
    home = path.join(stateHome(), "gpu-resources"),
    observe = observeGpu,
    observeProcess = readProcessIdentity,
    now = Date.now,
    lockTimeout = 10000,
  } = {}) {
    this.home = path.resolve(home);
    this.file = path.join(this.home, "leases.json");
    this.lock = path.join(this.home, "leases.lock");
    this.observe = observe;
    this.observeProcess = observeProcess;
    this.now = now;
    check(
      Number.isInteger(lockTimeout) &&
        lockTimeout >= 25 &&
        lockTimeout <= 10000,
      "invalid_gpu_lock_timeout",
    );
    this.lockTimeout = lockTimeout;
    this.queue = Promise.resolve();
  }
  async read() {
    const state = (await readGpuJson(this.file)) || empty();
    try {
      validate(state);
    } catch {
      throw new GpuError("gpu_ledger_invalid");
    }
    return state;
  }
  async mutate(operation) {
    const pending = this.queue.then(async () => {
      const unlock = await lockGpuLedger(this.lock, this.lockTimeout);
      try {
        const state = await this.read();
        const before = hash(state);
        const result = await operation(state);
        if (hash(state) !== before) {
          state.revision++;
          validate(state);
          await durableWrite(this.file, state);
        }
        return result;
      } finally {
        await unlock();
      }
    });
    this.queue = pending.catch(() => {});
    return pending;
  }
  async self() {
    this.selfObservation ||= this.observeProcess(process.pid);
    const observed = await this.selfObservation;
    check(
      observed.status === "observed" &&
        validProcessIdentity(observed.identity) &&
        observed.identity.pid === process.pid,
      "gpu_controller_identity_unavailable",
    );
    return observed.identity;
  }
  async owned(state, id) {
    const lease = state.leases.find((item) => item.lease_id === id);
    check(
      lease && sameIdentity(lease.controller_identity, await this.self()),
      "gpu_lease_owner_mismatch",
    );
    return lease;
  }
  release(state, lease, reason) {
    state.leases = state.leases.filter(
      (item) => item.lease_id !== lease.lease_id,
    );
    const { lease_id, project_id, run_id, owner_id, request } = lease;
    state.released.push({
      lease_id,
      project_id,
      run_id,
      owner_id,
      request,
      released_at: new Date(this.now()).toISOString(),
      reason,
    });
    state.released = state.released.slice(-recentLimit);
    return { lease_id, status: "released", reason };
  }
  async recordedExit(lease) {
    try {
      const directory = path.join(
        this.home,
        "..",
        "projects",
        lease.project_id,
      );
      await inspectGpuDirectory(directory);
      const fileStat = await fs.lstat(
        path.join(directory, "run-history.jsonl"),
      );
      if (
        !fileStat.isFile() ||
        fileStat.isSymbolicLink() ||
        fileStat.nlink !== 1
      )
        return false;
      const history = await RunHistory.open({
        id: lease.project_id,
        directory,
      });
      const state = await history.read(),
        run = state.runs.get(lease.run_id);
      return (
        !state.tail_bytes &&
        sameScope(run?.scope?.descriptor, lease.scope) &&
        run.scope.status === "exit_confirmed" &&
        run.scope.remaining_count === 0 &&
        run.scope.remaining_pids.length === 0 &&
        run.scope.stages.some(
          (stage) =>
            stage.owner_id === lease.owner_id &&
            stage.stage === "verification" &&
            stage.phase === "result" &&
            stage.status === "exit_confirmed" &&
            stage.remaining_count === 0 &&
            stage.remaining_pids.length === 0,
        )
      );
    } catch {
      return false;
    }
  }
  async reconcileState(state, { device = null, run = null, limit = 8 } = {}) {
    const candidates = state.leases.filter(
      (lease) =>
        (!device || lease.request.device_id === device) &&
        (this.now() - Date.parse(lease.heartbeat_at) >= lease.ttl_ms ||
          lease.run_id === run),
    );
    const checked = [];
    for (const lease of candidates.slice(0, limit)) {
      if (lease.scope) {
        const process = matchProcessIdentity(
          lease.scope.root_identity,
          await this.observeProcess(lease.scope.root_pid),
        );
        if (
          ["gone", "pid_reused"].includes(process) &&
          (await this.recordedExit(lease))
        )
          checked.push(
            this.release(state, lease, "recorded_kernel_group_empty"),
          );
        else
          checked.push({
            lease_id: lease.lease_id,
            status: "retained",
            reason:
              process === "alive"
                ? "owned_process_alive"
                : "scope_exit_unconfirmed",
            process_observation: process,
          });
      } else {
        const process = matchProcessIdentity(
          lease.controller_identity,
          await this.observeProcess(lease.controller_identity.pid),
        );
        if (
          lease.phase === "reserved" &&
          ["gone", "pid_reused"].includes(process)
        )
          checked.push(this.release(state, lease, "unstarted_owner_absent"));
        else
          checked.push({
            lease_id: lease.lease_id,
            status: "retained",
            reason:
              lease.phase === "launching"
                ? "launch_scope_unconfirmed"
                : process === "alive"
                  ? "controller_alive_heartbeat_expired"
                  : "controller_exit_unconfirmed",
            process_observation: process,
          });
      }
    }
    return { checked, unchecked: Math.max(0, candidates.length - limit) };
  }
  async reconcile() {
    return this.mutate((state) => this.reconcileState(state));
  }
  async acquire({ project, run_id, owner_id, request }) {
    request = gpuRequest(request);
    check(
      projectId(project.id) && uuid(run_id, "run") && uuid(owner_id, "owner"),
      "invalid_gpu_owner",
    );
    const identity = await this.self();
    return this.mutate(async (state) => {
      await this.reconcileState(state, {
        device: request.device_id,
        run: run_id,
      });
      const driver = await this.observe();
      const device = driver.devices.find(
        (item) => item.device_id === request.device_id,
      );
      const holds = state.leases.filter(
        (item) => item.request.device_id === request.device_id,
      );
      const reserved = holds.reduce(
        (n, item) => n + item.request.requested_vram_mib,
        0,
      );
      const available =
        device?.free_mib === null || device?.free_mib === undefined
          ? null
          : Math.max(0, device.free_mib - reserved);
      const reason = state.leases.some(
        (item) => item.project_id === project.id && item.run_id === run_id,
      )
        ? "gpu_run_already_reserved"
        : state.leases.length >= activeLimit
          ? "gpu_ledger_full"
          : driver.status !== "observed"
            ? "gpu_inventory_unavailable"
            : !device
              ? "gpu_device_unavailable"
              : available === null
                ? "gpu_memory_unavailable"
                : holds.some((item) => item.request.mode === "exclusive") ||
                    (request.mode === "exclusive" && holds.length)
                  ? "gpu_exclusive_busy"
                  : available < request.requested_vram_mib
                    ? "gpu_capacity_insufficient"
                    : null;
      state.waiting = state.waiting.filter(
        (item) => item.project_id !== project.id || item.run_id !== run_id,
      );
      if (reason) {
        state.waiting.push({
          project_id: project.id,
          run_id,
          owner_id,
          request,
          reason,
          observed_at: new Date(this.now()).toISOString(),
        });
        state.waiting = state.waiting.slice(-recentLimit);
        return {
          status: "waiting-resource",
          reason,
          project_id: project.id,
          run_id,
          request,
          driver,
          reserved_mib: reserved,
          admission_available_mib: available,
          native_process_started: false,
        };
      }
      const at = new Date(this.now()).toISOString();
      const lease = {
        lease_id: "lease_" + randomUUID(),
        project_id: project.id,
        run_id,
        owner_id,
        controller_identity: identity,
        request,
        created_at: at,
        heartbeat_at: at,
        ttl_ms: 30000,
        phase: "reserved",
        scope: null,
      };
      state.leases.push(lease);
      return { status: "reserved", lease: structuredClone(lease) };
    }).catch((error) => {
      if (error.code !== "gpu_ledger_busy") throw error;
      return {
        status: "waiting-resource",
        reason: "gpu_ledger_busy",
        project_id: project.id,
        run_id,
        request,
        reserved_mib: null,
        admission_available_mib: null,
        ledger_observation: "busy; capacity_unobserved",
        native_process_started: false,
      };
    });
  }
  async beginLaunch(id) {
    return this.mutate(async (state) => {
      const lease = await this.owned(state, id);
      check(lease.phase === "reserved", "gpu_launch_already_intended");
      lease.phase = "launching";
    });
  }
  async bind(id, scope) {
    return this.mutate(async (state) => {
      const lease = await this.owned(state, id);
      check(
        validScope(scope, lease.owner_id),
        "gpu_process_identity_unavailable",
      );
      check(
        lease.phase === "launching" ||
          (lease.phase === "bound" && sameScope(lease.scope, scope)),
        "gpu_scope_changed",
      );
      lease.scope = structuredClone(scope);
      lease.phase = "bound";
      lease.heartbeat_at = new Date(this.now()).toISOString();
    });
  }
  async heartbeat(id) {
    return this.mutate(async (state) => {
      const lease = await this.owned(state, id);
      lease.heartbeat_at = new Date(this.now()).toISOString();
      return structuredClone(lease);
    });
  }
  async assertHeld(id) {
    return structuredClone(await this.owned(await this.read(), id));
  }
  // Used only by the live native adapter before any spawn attempt, never as a
  // user-supplied force-release endpoint or an expiry-based cancellation.
  async cancelUnstarted(id) {
    return this.mutate(async (state) => {
      const lease = await this.owned(state, id);
      check(lease.scope === null, "gpu_spawn_already_bound");
      return this.release(state, lease, "cancelled_before_spawn");
    });
  }
  async releaseFromScope(id, scope) {
    return this.mutate(async (state) => {
      const lease = await this.owned(state, id);
      const descriptor = scope?.descriptor;
      if (
        !descriptor ||
        descriptor.owner_id !== lease.owner_id ||
        (lease.scope && !sameScope(lease.scope, descriptor))
      )
        return { status: "retained", reason: "scope_owner_unconfirmed" };
      // The original adapter's held kernel handle is the authority. A root's
      // exit event, driver PID absence, and heartbeat age are not substitutes.
      const observation = scope.state.confirmed
        ? scope.state
        : await scope.inspect();
      if (
        !observation.confirmed ||
        observation.status !== "exit_confirmed" ||
        observation.remaining_count !== 0 ||
        observation.remaining_pids.length !== 0
      )
        return { status: "retained", reason: "scope_exit_unconfirmed" };
      const root = lease.scope?.root_identity || descriptor.root_identity;
      if (
        root &&
        !["gone", "pid_reused"].includes(
          matchProcessIdentity(root, await this.observeProcess(root.pid)),
        )
      )
        return { status: "retained", reason: "root_exit_unconfirmed" };
      return this.release(state, lease, "held_kernel_group_empty");
    });
  }
  async inspect() {
    const state = await this.read(),
      driver = await this.observe();
    const ids = new Set([
      ...driver.devices.map((item) => item.device_id),
      ...state.leases.map((item) => item.request.device_id),
      ...state.waiting.map((item) => item.request.device_id),
    ]);
    return {
      schema: 1,
      revision: state.revision,
      scope: "cooperative_clients_sharing_this_state_home",
      units: "MiB",
      driver,
      admission_basis:
        "max(0, driver_free_mib - reserved_mib); conservative_double_count_of_managed_usage",
      devices: [...ids].sort().map((id) => {
        const device = driver.devices.find((item) => item.device_id === id);
        const leases = state.leases.filter(
          (item) => item.request.device_id === id,
        );
        const reserved_mib = leases.reduce(
          (n, item) => n + item.request.requested_vram_mib,
          0,
        );
        return {
          device_id: id,
          driver_used_mib: device?.used_mib ?? null,
          driver_free_mib: device?.free_mib ?? null,
          reserved_mib,
          admission_available_mib:
            device?.free_mib === undefined || device.free_mib === null
              ? null
              : Math.max(0, device.free_mib - reserved_mib),
          leases: leases.map((lease) => ({
            ...lease,
            heartbeat_expired:
              this.now() - Date.parse(lease.heartbeat_at) >= lease.ttl_ms,
            release_requires:
              "held_kernel_group_empty_or_matching_durable_receipt_and_actual_root_absence",
          })),
        };
      }),
      waiting: state.waiting,
      recently_released: state.released,
    };
  }
}
