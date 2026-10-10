import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { randomUUID } from "node:crypto";
import { stateHome } from "./state.mjs";
import {
  matchProcessIdentity,
  readProcessIdentity,
  validProcessIdentity,
} from "./process-identity.mjs";

const MiB = 1024 * 1024;
const maxWaitMs = 600000;
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value, keys) =>
  object(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
const positive = (value, maximum) =>
  Number.isFinite(value) && value > 0 && value <= maximum;
const portValue = (value) =>
  value === null ||
  (Number.isSafeInteger(value) && value >= 1 && value <= 65535);
const sameIdentity = (a, b) =>
  validProcessIdentity(a) &&
  validProcessIdentity(b) &&
  a.platform === b.platform &&
  a.pid === b.pid &&
  a.birth === b.birth &&
  a.scope === b.scope;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class ResourceAdmissionError extends Error {
  constructor(code, details = null) {
    super(code);
    this.code = code;
    this.details = details;
  }
}

function fail(code, details) {
  throw new ResourceAdmissionError(code, details);
}

function freshState() {
  return {
    schema: 1,
    policy: { max_heavy_builds: 1 },
    leases: {},
  };
}

function validateState(state) {
  if (
    !exact(state, ["schema", "policy", "leases"]) ||
    state.schema !== 1 ||
    !exact(state.policy, ["max_heavy_builds"]) ||
    !Number.isSafeInteger(state.policy.max_heavy_builds) ||
    state.policy.max_heavy_builds < 1 ||
    state.policy.max_heavy_builds > 64 ||
    !object(state.leases)
  )
    fail("resource_state_corrupt");
  for (const [key, lease] of Object.entries(state.leases)) {
    if (
      !exact(lease, [
        "lease_id",
        "kind",
        "cpu_cores",
        "memory_mib",
        "requested_port",
        "port",
        "phase",
        "owner_identity",
        "process_identity",
        "supervisor_identity",
        "scope_kind",
        "scope_id",
        "scope_path",
        "created_at",
      ]) ||
      lease.lease_id !== key ||
      !/^[0-9a-f-]{36}$/.test(key) ||
      !["heavy-build", "test-server", "other"].includes(lease.kind) ||
      !positive(lease.cpu_cores, 4096) ||
      !Number.isSafeInteger(lease.memory_mib) ||
      lease.memory_mib < 1 ||
      !portValue(lease.requested_port) ||
      !portValue(lease.port) ||
      !["starting", "prepared", "running", "unknown"].includes(lease.phase) ||
      !validProcessIdentity(lease.owner_identity) ||
      (lease.process_identity !== null &&
        !validProcessIdentity(lease.process_identity)) ||
      (lease.supervisor_identity !== null &&
        !validProcessIdentity(lease.supervisor_identity)) ||
      (lease.scope_kind !== null &&
        !["linux_cgroup_v2", "windows_job"].includes(lease.scope_kind)) ||
      (lease.scope_id !== null &&
        (typeof lease.scope_id !== "string" ||
          !/^[a-zA-Z0-9_-]{1,80}$/.test(lease.scope_id))) ||
      (lease.scope_path !== null &&
        (typeof lease.scope_path !== "string" ||
          !path.isAbsolute(lease.scope_path))) ||
      (lease.phase === "starting" &&
        (lease.process_identity !== null ||
          lease.supervisor_identity !== null ||
          lease.scope_kind !== null ||
          lease.scope_id !== null ||
          lease.scope_path !== null)) ||
      (["prepared", "running"].includes(lease.phase) &&
        ((lease.process_identity !== null &&
          !validProcessIdentity(lease.process_identity)) ||
          !validProcessIdentity(lease.supervisor_identity) ||
          !lease.scope_kind ||
          !lease.scope_id ||
          (lease.scope_kind === "linux_cgroup_v2" &&
            typeof lease.scope_path !== "string"))) ||
      typeof lease.created_at !== "string" ||
      !Number.isFinite(Date.parse(lease.created_at))
    )
      fail("resource_state_corrupt");
  }
  return state;
}

async function observeOwnedScope(lease) {
  if (lease.scope_kind === "linux_cgroup_v2") {
    const root = path.resolve("/sys/fs/cgroup");
    const candidate = path.resolve(lease.scope_path || "");
    if (
      !lease.scope_path ||
      (candidate !== root && !candidate.startsWith(root + path.sep))
    )
      return "unknown";
    try {
      const real = await fs.realpath(candidate);
      if (real !== candidate) return "unknown";
      const stat = await fs.stat(real);
      if (String(stat.ino) !== lease.scope_id) return "unknown";
      const events = await fs.readFile(path.join(real, "cgroup.events"), "utf8");
      const populated = events.match(/^populated ([01])$/m)?.[1];
      return populated === "0" ? "empty" : populated === "1" ? "populated" : "unknown";
    } catch (error) {
      // The supervisor only removes its private cgroup after observing it empty.
      return error.code === "ENOENT" ? "empty" : "unknown";
    }
  }
  if (lease.scope_kind === "windows_job") {
    // The supervisor holds the final job handle; it exits only after an empty-job proof.
    return "empty";
  }
  return "unknown";
}

function validateRequest(input) {
  if (
    !object(input) ||
    Object.keys(input).some(
      (key) =>
        ![
          "kind",
          "cpu_cores",
          "memory_mib",
          "port",
          "wait_ms",
        ].includes(key),
    ) ||
    !["heavy-build", "test-server", "other"].includes(input.kind) ||
    !positive(input.cpu_cores, 4096) ||
    !Number.isSafeInteger(input.memory_mib) ||
    input.memory_mib < 1 ||
    (input.port !== undefined &&
      input.port !== null &&
      (!Number.isSafeInteger(input.port) || input.port < 1024 || input.port > 65535)) ||
    (input.wait_ms !== undefined &&
      (!Number.isSafeInteger(input.wait_ms) ||
        input.wait_ms < 0 ||
        input.wait_ms > maxWaitMs))
  )
    fail("resource_request_invalid");
  return {
    kind: input.kind,
    cpu_cores: input.cpu_cores,
    memory_mib: input.memory_mib,
    port: input.port ?? null,
    wait_ms: input.wait_ms ?? 0,
  };
}

async function readCgroupLimits() {
  if (process.platform !== "linux")
    return {
      status: "unknown",
      source: process.platform === "win32" ? "windows-job" : "unsupported",
      cpu_cores: null,
      memory_mib: null,
      memory_available_mib: null,
    };
  try {
    const membership = await fs.readFile("/proc/self/cgroup", "utf8");
    const line = membership
      .split(/\r?\n/)
      .find((item) => item.startsWith("0::"));
    if (!line) throw new Error("cgroup_v2_unavailable");
    const relative = line.slice(3).replace(/^\/+/, "");
    const root = path.resolve("/sys/fs/cgroup");
    const leaf = path.resolve(root, relative);
    if (leaf !== root && !leaf.startsWith(root + path.sep))
      throw new Error("cgroup_path_invalid");
    let cpu = null;
    let memory = null;
    let memoryAvailable = null;
    let memoryHeadroomUnknown = false;
    for (
      let directory = leaf;
      directory === root || directory.startsWith(root + path.sep);
      directory = path.dirname(directory)
    ) {
      const cpuMax = await fs
        .readFile(path.join(directory, "cpu.max"), "utf8")
        .catch(() => null);
      if (cpuMax) {
        const fields = cpuMax.trim().split(/\s+/);
        if (fields.length === 2 && fields[0] !== "max") {
          const quota = Number(fields[0]),
            period = Number(fields[1]);
          if (
            Number.isSafeInteger(quota) &&
            quota > 0 &&
            Number.isSafeInteger(period) &&
            period > 0
          ) {
            const cores = quota / period;
            cpu = cpu === null ? cores : Math.min(cpu, cores);
          }
        }
      }
      const memoryMax = await fs
        .readFile(path.join(directory, "memory.max"), "utf8")
        .catch(() => null);
      if (memoryMax && memoryMax.trim() !== "max") {
        const bytes = Number(memoryMax.trim());
        if (Number.isSafeInteger(bytes) && bytes > 0) {
          memory = memory === null ? bytes : Math.min(memory, bytes);
          const current = await fs
            .readFile(path.join(directory, "memory.current"), "utf8")
            .catch(() => null);
          if (current) {
            const used = Number(current.trim());
            if (Number.isSafeInteger(used) && used >= 0) {
              const remaining = Math.max(0, bytes - used);
              memoryAvailable =
                memoryAvailable === null
                  ? remaining
                  : Math.min(memoryAvailable, remaining);
            } else memoryHeadroomUnknown = true;
          } else memoryHeadroomUnknown = true;
        }
      }
      if (directory === root) break;
    }
    return {
      status: "observed",
      source: "cgroup-v2",
      cpu_cores: cpu,
      memory_mib: memory === null ? null : Math.floor(memory / MiB),
      memory_available_mib:
        memory === null || memoryHeadroomUnknown || memoryAvailable === null
          ? null
          : Math.floor(memoryAvailable / MiB),
    };
  } catch {
    return {
      status: "unknown",
      source: "cgroup-v2",
      cpu_cores: null,
      memory_mib: null,
      memory_available_mib: null,
    };
  }
}

export async function observeHostResources() {
  const hostCpu = Math.max(1, os.availableParallelism?.() || os.cpus().length);
  const totalMiB = Math.max(1, Math.floor(os.totalmem() / MiB));
  const freeMiB = Math.max(0, Math.floor(os.freemem() / MiB));
  const enforced = await readCgroupLimits();
  const cpuCapacity =
    enforced.status === "observed" && enforced.cpu_cores !== null
      ? Math.min(hostCpu, enforced.cpu_cores)
      : hostCpu;
  const memoryCapacity =
    enforced.status === "observed" && enforced.memory_mib !== null
      ? Math.min(totalMiB, enforced.memory_mib)
      : totalMiB;
  const memoryAvailable =
    enforced.status === "observed" &&
    enforced.memory_mib !== null
      ? Math.min(freeMiB, enforced.memory_available_mib ?? 0)
      : freeMiB;
  return {
    observed_at: new Date().toISOString(),
    host: {
      cpu_cores: hostCpu,
      memory_total_mib: totalMiB,
      memory_available_mib: freeMiB,
    },
    enforced_limits: enforced,
    recommendation: {
      cpu_cores: cpuCapacity,
      memory_total_mib: memoryCapacity,
      memory_available_mib: Math.min(memoryCapacity, memoryAvailable),
      basis:
        enforced.status === "observed" &&
        (enforced.cpu_cores !== null || enforced.memory_mib !== null)
          ? "host-and-observed-container-headroom"
          : "host-headroom-only",
    },
  };
}

export function probePort(port) {
  const attempt = (host, options = {}) =>
    new Promise((resolve) => {
      const server = net.createServer();
      server.once("error", (error) => {
        if (error.code === "EADDRINUSE") resolve("busy");
        else if (
          ["EAFNOSUPPORT", "EADDRNOTAVAIL", "EINVAL", "ENOTSUP"].includes(
            error.code,
          )
        )
          resolve("unsupported");
        else resolve("unknown");
      });
      server.listen(
        { host, port, exclusive: true, ...options },
        () => server.close(() => resolve("available")),
      );
    });
  return attempt("::", { ipv6Only: false }).then((ipv6) => {
    if (ipv6 === "busy" || ipv6 === "unknown") return ipv6;
    return attempt("127.0.0.1").then((ipv4) => {
      if (ipv4 === "busy" || ipv4 === "unknown") return ipv4;
      return ipv6 === "available" || ipv4 === "available"
        ? "available"
        : "unknown";
    });
  });
}

function validLock(value) {
  return (
    exact(value, ["schema", "token", "pid_identity"]) &&
    value.schema === 1 &&
    /^[0-9a-f-]{36}$/.test(value.token) &&
    validProcessIdentity(value.pid_identity)
  );
}

async function createLock(file, pidIdentity) {
  const token = randomUUID();
  const temp = file + "." + token + ".tmp";
  const data = {
    schema: 1,
    token,
    pid_identity: pidIdentity,
  };
  try {
    await fs.writeFile(temp, JSON.stringify(data) + "\n", {
      flag: "wx",
      mode: 0o600,
    });
    const handle = await fs.open(temp, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.link(temp, file);
    return token;
  } finally {
    await fs.unlink(temp).catch(() => {});
  }
}

async function readLock(file) {
  try {
    const value = JSON.parse(await fs.readFile(file, "utf8"));
    if (!validLock(value)) fail("resource_lock_corrupt");
    return value;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    if (error instanceof ResourceAdmissionError) throw error;
    fail("resource_lock_corrupt");
  }
}

async function releaseLock(file, token) {
  const record = await readLock(file);
  if (record?.token === token) await fs.unlink(file).catch(() => {});
}

export class ResourceAdmission {
  constructor({
    directory = path.join(stateHome(), "resource-admission"),
    readIdentity = readProcessIdentity,
    observe = observeHostResources,
    checkPort = probePort,
    observeScope = observeOwnedScope,
    clock = () => Date.now(),
    sleep = pause,
  } = {}) {
    this.directory = directory;
    this.stateFile = path.join(directory, "reservations.json");
    this.lockFile = path.join(directory, "reservations.lock");
    this.recoveryFile = path.join(directory, "reservations.recovery");
    this.readIdentity = readIdentity;
    this.observe = observe;
    this.checkPort = checkPort;
    this.observeScope = observeScope;
    this.clock = clock;
    this.sleep = sleep;
    this.identityPromise = null;
  }

  async #currentIdentity() {
    this.identityPromise ??= this.readIdentity(process.pid);
    const result = await this.identityPromise;
    if (result?.status !== "observed" || !validProcessIdentity(result.identity))
      fail("resource_process_identity_unavailable");
    return result.identity;
  }

  async #recover(lock) {
    const owner = await this.#currentIdentity();
    const deadline = this.clock() + 3000;
    let recoveryToken = null;
    while (this.clock() < deadline) {
      try {
        recoveryToken = await createLock(this.recoveryFile, owner);
        break;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        const recovery = await readLock(this.recoveryFile);
        if (!recovery) continue;
        const live = matchProcessIdentity(
          recovery.pid_identity,
          await this.readIdentity(recovery.pid_identity.pid),
        );
        if (live === "gone" || live === "pid_reused")
          fail("resource_recovery_lock_stale");
        await this.sleep(20);
      }
    }
    if (!recoveryToken) fail("resource_lock_timeout");
    try {
      const current = await readLock(this.lockFile);
      if (current?.token !== lock.token) return;
      const live = matchProcessIdentity(
        current.pid_identity,
        await this.readIdentity(current.pid_identity.pid),
      );
      if (live === "gone" || live === "pid_reused")
        await fs.unlink(this.lockFile).catch((error) => {
          if (error.code !== "ENOENT") throw error;
        });
    } finally {
      await releaseLock(this.recoveryFile, recoveryToken);
    }
  }

  async #locked(callback) {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const owner = await this.#currentIdentity();
    const deadline = this.clock() + 10000;
    let token = null;
    while (this.clock() < deadline) {
      try {
        token = await createLock(this.lockFile, owner);
        break;
      } catch (error) {
        if (error.code !== "EEXIST") {
          if (["EPERM", "EACCES", "EXDEV", "ENOTSUP"].includes(error.code))
            fail("resource_lock_unavailable", { system_code: error.code });
          throw error;
        }
        const current = await readLock(this.lockFile);
        if (!current) continue;
        const live = matchProcessIdentity(
          current.pid_identity,
          await this.readIdentity(current.pid_identity.pid),
        );
        if (live === "gone" || live === "pid_reused") {
          await this.#recover(current);
          continue;
        }
        if (live === "unknown")
          fail("resource_lock_owner_unverifiable");
        await this.sleep(20);
      }
    }
    if (!token) fail("resource_lock_timeout");
    try {
      const state = await this.#load();
      const result = await callback(state, owner);
      validateState(state);
      await this.#save(state);
      return result;
    } finally {
      await releaseLock(this.lockFile, token);
    }
  }

  async #load() {
    try {
      return validateState(
        JSON.parse(await fs.readFile(this.stateFile, "utf8")),
      );
    } catch (error) {
      if (error.code === "ENOENT") return freshState();
      if (error instanceof ResourceAdmissionError) throw error;
      fail("resource_state_corrupt");
    }
  }

  async #save(state) {
    const temp = this.stateFile + "." + randomUUID() + ".tmp";
    try {
      await fs.writeFile(temp, JSON.stringify(state, null, 2) + "\n", {
        flag: "wx",
        mode: 0o600,
      });
      await fs.rename(temp, this.stateFile);
    } finally {
      await fs.unlink(temp).catch(() => {});
    }
  }

  async #reconcile(state) {
    for (const [id, lease] of Object.entries(state.leases)) {
      if (lease.phase === "starting") {
        const owner = matchProcessIdentity(
          lease.owner_identity,
          await this.readIdentity(lease.owner_identity.pid),
        );
        if (owner === "gone" || owner === "pid_reused")
          delete state.leases[id];
        // Keep a starting lease retryable when identity lookup is transiently
        // unavailable; it has no process scope yet and may still be abandoned.
        continue;
      }
      if (!lease.supervisor_identity) {
        lease.phase = "unknown";
        continue;
      }
      const root = lease.process_identity
        ? matchProcessIdentity(
            lease.process_identity,
            await this.readIdentity(lease.process_identity.pid),
          )
        : "unknown";
      const supervisor = matchProcessIdentity(
        lease.supervisor_identity,
        await this.readIdentity(lease.supervisor_identity.pid),
      );
      if (
        (lease.process_identity && root === "unknown") ||
        supervisor === "unknown"
      ) {
        lease.phase = "unknown";
        continue;
      }
      if (
        (!lease.process_identity || ["gone", "pid_reused"].includes(root)) &&
        ["gone", "pid_reused"].includes(supervisor) &&
        (await this.observeScope(lease)) === "empty"
      ) {
        delete state.leases[id];
      } else if (root !== "alive" && supervisor !== "alive") {
        lease.phase = "unknown";
      }
    }
  }

  async #selectPort(requested, leases) {
    if (requested === null) return { requested_port: null, port: null };
    const reserved = new Set(
      Object.values(leases)
        .map((lease) => lease.port)
        .filter((port) => port !== null),
    );
    const last = Math.min(65535, requested + 100);
    for (let port = requested; port <= last; port++) {
      if (reserved.has(port)) continue;
      const status = await this.checkPort(port);
      if (status === "unknown") fail("resource_port_probe_unknown", { port });
      if (status === "available")
        return { requested_port: requested, port };
    }
    fail("resource_port_unavailable", {
      requested_port: requested,
      searched_through: last,
    });
  }

  async inspect() {
    return this.#locked(async (state) => {
      await this.#reconcile(state);
      const host = await this.observe();
      const leases = Object.values(state.leases).map((lease) => ({
        ...lease,
        owner_identity: undefined,
        process_identity: undefined,
      }));
      const cpuReserved = leases.reduce((sum, lease) => sum + lease.cpu_cores, 0);
      const memoryReserved = leases.reduce(
        (sum, lease) => sum + lease.memory_mib,
        0,
      );
      const heavyBuilds = leases.filter(
        (lease) => lease.kind === "heavy-build",
      ).length;
      return {
        policy: structuredClone(state.policy),
        host,
        reservations: leases,
        recommendation_remaining: {
          cpu_cores: Math.max(0, host.recommendation.cpu_cores - cpuReserved),
          memory_mib: Math.max(
            0,
            host.recommendation.memory_available_mib - memoryReserved,
          ),
          heavy_build_slots: Math.max(
            0,
            state.policy.max_heavy_builds - heavyBuilds,
          ),
        },
      };
    });
  }

  async configure(input) {
    if (
      !exact(input, ["max_heavy_builds"]) ||
      !Number.isSafeInteger(input.max_heavy_builds) ||
      input.max_heavy_builds < 1 ||
      input.max_heavy_builds > 64
    )
      fail("resource_policy_invalid");
    return this.#locked(async (state) => {
      await this.#reconcile(state);
      state.policy.max_heavy_builds = input.max_heavy_builds;
      return structuredClone(state.policy);
    });
  }

  async reserve(input) {
    const request = validateRequest(input);
    const deadline = this.clock() + request.wait_ms;
    while (true) {
      try {
        return await this.#locked(async (state, ownerIdentity) => {
          await this.#reconcile(state);
          const host = await this.observe();
          const active = Object.values(state.leases);
          const cpuReserved = active.reduce(
            (sum, lease) => sum + lease.cpu_cores,
            0,
          );
          const memoryReserved = active.reduce(
            (sum, lease) => sum + lease.memory_mib,
            0,
          );
          const heavyBuilds = active.filter(
            (lease) => lease.kind === "heavy-build",
          ).length;
          const recommendation = host.recommendation;
          if (
            request.cpu_cores > recommendation.cpu_cores ||
            request.memory_mib > host.recommendation.memory_total_mib
          )
            fail("resource_request_exceeds_capacity", {
              requested_cpu_cores: request.cpu_cores,
              requested_memory_mib: request.memory_mib,
              recommendation,
              enforced_limits: host.enforced_limits,
            });
          const available = {
            cpu_cores: Math.max(0, recommendation.cpu_cores - cpuReserved),
            memory_mib: Math.max(
              0,
              recommendation.memory_available_mib - memoryReserved,
            ),
            heavy_build_slots: Math.max(
              0,
              state.policy.max_heavy_builds - heavyBuilds,
            ),
          };
          if (
            request.cpu_cores > available.cpu_cores ||
            request.memory_mib > available.memory_mib ||
            (request.kind === "heavy-build" && available.heavy_build_slots < 1)
          )
            fail("resource_capacity_unavailable", {
              available,
              requested: {
                cpu_cores: request.cpu_cores,
                memory_mib: request.memory_mib,
                kind: request.kind,
              },
              retry_after_ms: 250,
            });
          const ports = await this.#selectPort(request.port, state.leases);
          const leaseId = randomUUID();
          state.leases[leaseId] = {
            lease_id: leaseId,
            kind: request.kind,
            cpu_cores: request.cpu_cores,
            memory_mib: request.memory_mib,
            requested_port: ports.requested_port,
            port: ports.port,
            phase: "starting",
            owner_identity: ownerIdentity,
            process_identity: null,
            supervisor_identity: null,
            scope_kind: null,
            scope_id: null,
            scope_path: null,
            created_at: new Date(this.clock()).toISOString(),
          };
          return {
            lease_id: leaseId,
            ...ports,
            kind: request.kind,
            cpu_cores: request.cpu_cores,
            memory_mib: request.memory_mib,
            owner_identity: ownerIdentity,
            host,
            available_before: available,
          };
        });
      } catch (error) {
        if (
          error.code !== "resource_capacity_unavailable" ||
          this.clock() >= deadline
        )
          throw error;
        await this.sleep(Math.min(250, Math.max(1, deadline - this.clock())));
      }
    }
  }

  async bind(
    leaseId,
    ownerIdentity,
    processIdentity,
    { supervisorIdentity, scopeKind, scopeId, scopePath } = {},
  ) {
    if (
      typeof leaseId !== "string" ||
      !/^[0-9a-f-]{36}$/.test(leaseId) ||
      !validProcessIdentity(ownerIdentity) ||
      (processIdentity !== null && !validProcessIdentity(processIdentity)) ||
      !validProcessIdentity(supervisorIdentity) ||
      !["linux_cgroup_v2", "windows_job"].includes(scopeKind) ||
      typeof scopeId !== "string" ||
      !/^[a-zA-Z0-9_-]{1,80}$/.test(scopeId) ||
      (scopeKind === "linux_cgroup_v2" &&
        (typeof scopePath !== "string" || !path.isAbsolute(scopePath))) ||
      (scopeKind === "windows_job" && scopePath !== null)
    )
      fail("resource_process_identity_invalid");
    return this.#locked(async (state) => {
      const lease = state.leases[leaseId];
      if (
        !lease ||
        lease.phase !== "starting" ||
        !sameIdentity(lease.owner_identity, ownerIdentity)
      )
        fail("resource_lease_conflict");
      lease.process_identity = processIdentity;
      lease.supervisor_identity = supervisorIdentity;
      lease.scope_kind = scopeKind;
      lease.scope_id = scopeId;
      lease.scope_path = scopePath;
      lease.phase = "prepared";
      return { lease_id: leaseId, phase: lease.phase };
    });
  }

  async activate(leaseId, ownerIdentity, processIdentity) {
    if (
      typeof leaseId !== "string" ||
      !/^[0-9a-f-]{36}$/.test(leaseId) ||
      !validProcessIdentity(ownerIdentity) ||
      (processIdentity !== null && !validProcessIdentity(processIdentity))
    )
      fail("resource_process_identity_invalid");
    return this.#locked(async (state) => {
      const lease = state.leases[leaseId];
      if (
        !lease ||
        lease.phase !== "prepared" ||
        !sameIdentity(lease.owner_identity, ownerIdentity) ||
        !(
          lease.process_identity === null
            ? processIdentity === null
            : sameIdentity(lease.process_identity, processIdentity)
        )
      )
        fail("resource_lease_conflict");
      lease.phase = "running";
      return { lease_id: leaseId, phase: lease.phase };
    });
  }

  async attachProcess(leaseId, ownerIdentity, processIdentity) {
    if (
      typeof leaseId !== "string" ||
      !/^[0-9a-f-]{36}$/.test(leaseId) ||
      !validProcessIdentity(ownerIdentity) ||
      !validProcessIdentity(processIdentity)
    )
      fail("resource_process_identity_invalid");
    return this.#locked(async (state) => {
      const lease = state.leases[leaseId];
      if (
        !lease ||
        lease.phase !== "running" ||
        !sameIdentity(lease.owner_identity, ownerIdentity) ||
        (lease.process_identity !== null &&
          !sameIdentity(lease.process_identity, processIdentity))
      )
        fail("resource_lease_conflict");
      lease.process_identity = processIdentity;
      return { lease_id: leaseId, attached: true };
    });
  }

  async abandon(leaseId, ownerIdentity) {
    if (!validProcessIdentity(ownerIdentity)) fail("resource_process_identity_invalid");
    return this.#locked(async (state) => {
      const lease = state.leases[leaseId];
      if (!lease) return { released: true };
      if (
        lease.phase !== "starting" ||
        !sameIdentity(lease.owner_identity, ownerIdentity)
      )
        fail("resource_lease_conflict");
      delete state.leases[leaseId];
      return { released: true };
    });
  }

  async finish(leaseId, processIdentity, proof) {
    if (
      typeof leaseId !== "string" ||
      !/^[0-9a-f-]{36}$/.test(leaseId) ||
      (processIdentity !== null && !validProcessIdentity(processIdentity)) ||
      !object(proof) ||
      typeof proof.confirmed !== "boolean" ||
      typeof proof.resources_released !== "boolean"
    )
      fail("resource_exit_unverified");
    return this.#locked(async (state) => {
      const lease = state.leases[leaseId];
      if (!lease) return { released: true };
      if (
        !["prepared", "running", "unknown"].includes(lease.phase) ||
        !(
          processIdentity === null
            ? lease.process_identity === null
            : sameIdentity(lease.process_identity, processIdentity)
        )
      )
        fail("resource_lease_conflict");
      if (!proof.confirmed || !proof.resources_released) {
        lease.phase = "unknown";
        return { released: false, phase: lease.phase };
      }
      const status = processIdentity
        ? matchProcessIdentity(
            processIdentity,
            await this.readIdentity(processIdentity.pid),
          )
        : "unknown";
      const supervisorStatus = validProcessIdentity(lease.supervisor_identity)
        ? matchProcessIdentity(
            lease.supervisor_identity,
            await this.readIdentity(lease.supervisor_identity.pid),
          )
        : "unknown";
      const scopeStatus = await this.observeScope(lease);
      if (
        (processIdentity &&
          status !== "gone" &&
          status !== "pid_reused") ||
        (supervisorStatus !== "gone" && supervisorStatus !== "pid_reused") ||
        scopeStatus !== "empty"
      ) {
        lease.phase = "unknown";
        return {
          released: false,
          identity_status: status,
          supervisor_status: supervisorStatus,
          scope_status: scopeStatus,
          phase: lease.phase,
        };
      }
      delete state.leases[leaseId];
      return { released: true };
    });
  }

  async markUnknown(leaseId, ownerIdentity) {
    if (
      typeof leaseId !== "string" ||
      !/^[0-9a-f-]{36}$/.test(leaseId) ||
      !validProcessIdentity(ownerIdentity)
    )
      fail("resource_process_identity_invalid");
    return this.#locked(async (state) => {
      const lease = state.leases[leaseId];
      if (!lease) return { retained: false };
      if (
        lease.phase !== "starting" ||
        !sameIdentity(lease.owner_identity, ownerIdentity)
      )
        fail("resource_lease_conflict");
      lease.phase = "unknown";
      return { retained: true, phase: lease.phase };
    });
  }
}
