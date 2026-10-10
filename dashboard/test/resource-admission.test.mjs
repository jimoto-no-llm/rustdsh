import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { Writable } from "node:stream";
import { ResourceAdmission } from "../resource-admission.mjs";
import { runResourceCommand } from "../resource-runner.mjs";

const scope = "a".repeat(64);
const identity = (pid, birth = String(pid)) => ({
  platform: "linux",
  pid,
  birth,
  scope,
});
const host = {
  observed_at: "2026-01-01T00:00:00.000Z",
  host: {
    cpu_cores: 4,
    memory_total_mib: 8192,
    memory_available_mib: 4096,
  },
  enforced_limits: {
    status: "unknown",
    source: "fixture",
    cpu_cores: null,
    memory_mib: null,
    memory_available_mib: null,
  },
  recommendation: {
    cpu_cores: 4,
    memory_total_mib: 8192,
    memory_available_mib: 4096,
    basis: "host-headroom-only",
  },
};
const request = (extra = {}) => ({
  kind: "heavy-build",
  cpu_cores: 2,
  memory_mib: 512,
  ...extra,
});
const workerFixture = fileURLToPath(
  new URL("./fixtures/resource-reservation-worker.mjs", import.meta.url),
);
const dashboardCli = fileURLToPath(new URL("../cli.mjs", import.meta.url));

function firstJsonLine(child) {
  return new Promise((resolve, reject) => {
    let text = "";
    const timer = setTimeout(() => {
      child.stdout.off("data", onData);
      reject(new Error("resource worker response timed out"));
    }, 10000);
    const onData = (chunk) => {
      text += chunk.toString();
      const newline = text.indexOf("\n");
      if (newline < 0) return;
      clearTimeout(timer);
      child.stdout.off("data", onData);
      try {
        resolve(JSON.parse(text.slice(0, newline)));
      } catch (error) {
        reject(error);
      }
    };
    child.stdout.on("data", onData);
    child.once("error", (error) => {
      clearTimeout(timer);
      child.stdout.off("data", onData);
      reject(error);
    });
  });
}

async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "rdsh-resources-"),
  );
  const current = identity(process.pid, "1");
  const identities = new Map([[current.pid, current]]);
  const states = new Map([[current.pid, "observed"]]);
  const scopes = new Map();
  const readIdentity = async (pid) => {
    const expected = identities.get(pid);
    if (!expected) return { status: "unknown", identity: null };
    const status = states.get(pid) || "observed";
    if (status === "gone")
      return {
        status,
        identity: null,
        platform: expected.platform,
        scope: expected.scope,
      };
    if (status === "unknown") return { status, identity: null };
    return {
      status: "observed",
      identity:
        status === "pid_reused"
          ? { ...expected, birth: "999999" }
          : expected,
    };
  };
  t.after(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });
  const make = () =>
    new ResourceAdmission({
      directory,
      readIdentity,
      observe: async () => structuredClone(host),
      checkPort: async (port) =>
        options.busyPorts?.has(port) ? "busy" : "available",
      observeScope: async (lease) => scopes.get(lease.lease_id) || "empty",
    });
  return {
    directory,
    current,
    identities,
    states,
    scopes,
    readIdentity,
    make,
  };
}

test("cross-process admission serializes the heavy-build ceiling", async (t) => {
  const f = await fixture(t);
  const first = f.make(),
    second = f.make();
  const results = await Promise.allSettled([
    first.reserve(request()),
    second.reserve(request()),
  ]);
  assert.equal(results.filter((row) => row.status === "fulfilled").length, 1);
  const rejected = results.find((row) => row.status === "rejected");
  assert.equal(rejected.reason.code, "resource_capacity_unavailable");
  const lease = results.find((row) => row.status === "fulfilled").value;
  await first.abandon(lease.lease_id, f.current);
});

test("transient owner identity uncertainty keeps a starting lease retryable", async (t) => {
  const f = await fixture(t);
  const manager = f.make();
  const lease = await manager.reserve(request());
  f.states.set(f.current.pid, "unknown");
  let view = await manager.inspect();
  assert.equal(view.reservations[0].phase, "starting");
  f.states.set(f.current.pid, "gone");
  view = await manager.inspect();
  assert.deepEqual(view.reservations, []);
});

test("CPU and memory reservations gate start and a released heavy-build slot can be awaited", async (t) => {
  const f = await fixture(t);
  const first = f.make(),
    second = f.make();
  await assert.rejects(
    first.reserve(request({ kind: "other", cpu_cores: 5 })),
    (error) => error.code === "resource_request_exceeds_capacity",
  );

  const memoryLease = await first.reserve(
    request({ kind: "other", cpu_cores: 1, memory_mib: 4000 }),
  );
  await assert.rejects(
    second.reserve(
      request({ kind: "other", cpu_cores: 1, memory_mib: 512 }),
    ),
    (error) => error.code === "resource_capacity_unavailable",
  );
  await first.abandon(memoryLease.lease_id, f.current);

  const cpuLease = await first.reserve(
    request({ kind: "other", cpu_cores: 4, memory_mib: 1 }),
  );
  await assert.rejects(
    second.reserve(request({ kind: "other", cpu_cores: 1, memory_mib: 1 })),
    (error) => error.code === "resource_capacity_unavailable",
  );
  await first.abandon(cpuLease.lease_id, f.current);

  const heavyLease = await first.reserve(request({ wait_ms: 0 }));
  const waiting = second.reserve(request({ wait_ms: 800 }));
  const release = setTimeout(
    () => void first.abandon(heavyLease.lease_id, f.current),
    50,
  );
  const next = await waiting;
  clearTimeout(release);
  assert.equal(next.kind, "heavy-build");
  await second.abandon(next.lease_id, f.current);
});

test("separate processes share the heavy-build reservation ledger", async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "rdsh-resource-processes-"),
  );
  const children = [];
  t.after(async () => {
    for (const child of children) {
      if (child.exitCode === null) child.kill();
    }
    await Promise.all(
      children
        .filter((child) => child.exitCode === null)
        .map((child) => once(child, "exit").catch(() => {})),
    );
    await fs.rm(directory, { recursive: true, force: true });
  });

  const first = spawn(process.execPath, [workerFixture, directory], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.push(first);
  const firstExit = once(first, "exit");
  assert.equal((await firstJsonLine(first)).status, "reserved");

  const second = spawn(process.execPath, [workerFixture, directory], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.push(second);
  const secondExit = once(second, "exit");
  const rejected = await firstJsonLine(second);
  assert.deepEqual(rejected, {
    status: "rejected",
    code: "resource_capacity_unavailable",
  });
  assert.equal((await secondExit)[0], 0);

  first.stdin.end("release\n");
  assert.equal((await firstExit)[0], 0);
  const manager = new ResourceAdmission({ directory });
  assert.deepEqual((await manager.inspect()).reservations, []);
});

test("port reservations skip both a live OS port and an rdsh-owned port", async (t) => {
  const f = await fixture(t, { busyPorts: new Set([5050]) });
  const manager = f.make();
  const first = await manager.reserve(
    request({ kind: "test-server", port: 5050 }),
  );
  const second = await manager.reserve(
    request({ kind: "test-server", port: 5050 }),
  );
  assert.equal(first.requested_port, 5050);
  assert.equal(first.port, 5051);
  assert.equal(second.port, 5052);
  await manager.abandon(first.lease_id, f.current);
  await manager.abandon(second.lease_id, f.current);
});

test("reconciliation retains an unverified process tree and releases only after the supervisor and kernel scope are empty", async (t) => {
  const f = await fixture(t);
  const manager = f.make();
  const lease = await manager.reserve(request({ kind: "other" }));
  const child = identity(32001, "101");
  const supervisor = identity(32002, "202");
  f.identities.set(child.pid, child);
  f.identities.set(supervisor.pid, supervisor);
  await manager.bind(lease.lease_id, f.current, child, {
    supervisorIdentity: supervisor,
    scopeKind: "linux_cgroup_v2",
    scopeId: "42",
    scopePath: "/sys/fs/cgroup/rdsh-fixture",
  });
  await manager.activate(lease.lease_id, f.current, child);
  f.states.set(child.pid, "gone");
  f.states.set(supervisor.pid, "gone");
  f.scopes.set(lease.lease_id, "populated");
  let view = await manager.inspect();
  assert.equal(view.reservations.length, 1);
  assert.equal(view.reservations[0].phase, "unknown");
  f.scopes.set(lease.lease_id, "empty");
  view = await manager.inspect();
  assert.deepEqual(view.reservations, []);
});

test("an unverifiable process identity keeps its reservation", async (t) => {
  const f = await fixture(t);
  const manager = f.make();
  const lease = await manager.reserve(request({ kind: "other" }));
  const child = identity(33001, "301");
  const supervisor = identity(33002, "302");
  f.identities.set(child.pid, child);
  f.identities.set(supervisor.pid, supervisor);
  await manager.bind(lease.lease_id, f.current, child, {
    supervisorIdentity: supervisor,
    scopeKind: "linux_cgroup_v2",
    scopeId: "43",
    scopePath: "/sys/fs/cgroup/rdsh-fixture",
  });
  await manager.activate(lease.lease_id, f.current, child);
  f.states.set(child.pid, "gone");
  f.states.set(supervisor.pid, "unknown");
  const view = await manager.inspect();
  assert.equal(view.reservations.length, 1);
  assert.equal(view.reservations[0].phase, "unknown");
});

test("port probe detects a listening loopback service", async (t) => {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { probePort } = await import("../resource-admission.mjs");
  assert.equal(await probePort(port), "busy");
});

test(
  "a managed command releases its lease only after the owned process scope exits",
  { skip: !["linux", "win32"].includes(process.platform) },
  async (t) => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "rdsh-resource-run-"),
    );
    t.after(async () => {
      await fs.rm(directory, { recursive: true, force: true });
    });
    const manager = new ResourceAdmission({
      directory: path.join(directory, "state"),
      observe: async () => structuredClone(host),
      checkPort: async () => "available",
    });
    const sink = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
    const status = await runResourceCommand(
      manager,
      request({ kind: "other" }),
      {
        command: process.execPath,
        args: ["-e", "process.exit(0)"],
        cwd: directory,
      },
      { stdout: sink, stderr: sink },
    );
    assert.equal(status, 0);
    assert.deepEqual((await manager.inspect()).reservations, []);
  },
);

test(
  "resources run CLI accepts its argv file and releases its temporary reservation",
  { skip: !["linux", "win32"].includes(process.platform) },
  async (t) => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "rdsh-resource-cli-"),
    );
    const stateHome = path.join(directory, "state-home");
    const requestFile = path.join(directory, "request.json");
    const argvFile = path.join(directory, "argv.json");
    const env = { ...process.env, RDSH_DASHBOARD_HOME: stateHome };
    await fs.writeFile(
      requestFile,
      JSON.stringify({
        kind: "other",
        cpu_cores: 1,
        memory_mib: 1,
        wait_ms: 0,
      }),
    );
    await fs.writeFile(
      argvFile,
      JSON.stringify({
        command: process.execPath,
        args: ["-e", "process.exit(0)"],
        cwd: directory,
      }),
    );
    const child = spawn(
      process.execPath,
      [
        dashboardCli,
        "resources",
        "run",
        "--request-file",
        requestFile,
        "--argv-file",
        argvFile,
      ],
      { cwd: directory, env, stdio: ["ignore", "pipe", "pipe"] },
    );
    t.after(async () => {
      if (child.exitCode === null) {
        const exited = once(child, "exit");
        child.kill();
        await exited.catch(() => {});
      }
      await fs.rm(directory, { recursive: true, force: true });
    });
    let stdout = "",
      stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    const [code] = await once(child, "exit");
    assert.equal(code, 0, stderr);
    assert.match(stderr, /resource-reservation-acquired/);
    assert.equal(stdout, "");
    const manager = new ResourceAdmission({
      directory: path.join(stateHome, "resource-admission"),
    });
    assert.deepEqual((await manager.inspect()).reservations, []);
  },
);
