import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { fork, execFile } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { identity } from "../state.mjs";
import { GpuLeases, runGpuRequest } from "../gpu-leases.mjs";
import {
  gpuRequest,
  parseGpuInventory,
  observeGpu,
} from "../gpu-telemetry.mjs";
import { SessionLedger, attachRecordedSession } from "../session-ledger.mjs";
import { RunHistory } from "../run-history.mjs";
import { readProcessIdentity } from "../process-identity.mjs";

const exec = promisify(execFile);
const device = "GPU-00000000-0000-0000-0000-000000000001";
const request = {
  device_id: device,
  requested_vram_mib: 4096,
  mode: "exclusive",
};
const inventory = `${device}, 16384, 2048, 12288\n`;
const peer = fileURLToPath(
  new URL("./fixtures/gpu-acp-cli.mjs", import.meta.url),
);
const workerFile = fileURLToPath(
  new URL("./fixtures/gpu-worker.mjs", import.meta.url),
);
const cli = fileURLToPath(new URL("../cli.mjs", import.meta.url));
const code = (expected) => (error) => error.code === expected;
const owner = () => "owner_" + randomUUID();
const run = () => "run_" + randomUUID();
async function waitFor(check, timeout = 10000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("GPU fixture did not reach the expected state");
}
async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rdsh-gpu-"));
  const cwd = path.join(root, "project");
  await fs.mkdir(cwd);
  await exec("git", ["-C", cwd, "init", "-b", "gpu-qa"]);
  await exec("git", [
    "-C",
    cwd,
    "-c",
    "user.name=GPU QA",
    "-c",
    "user.email=gpu@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--allow-empty",
    "-m",
    "fixture",
  ]);
  const project = await identity(cwd);
  project.directory = path.join(root, "dashboard", "projects", project.id);
  const env = {
    ...process.env,
    RDSH_DASHBOARD_HOME: path.join(root, "dashboard"),
    HOME: root,
    USERPROFILE: root,
    DSH_HOME: path.join(root, "dsh"),
    XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_DATA_HOME: path.join(root, "data"),
    APPDATA: path.join(root, "data"),
    LOCALAPPDATA: path.join(root, "local"),
    GIT_CEILING_DIRECTORIES: root,
    RDSH_GPU_FIXTURE_HOME: path.join(root, "dashboard", "gpu-resources"),
    RDSH_GPU_FIXTURE_ENTRY: path.join(root, "entry.json"),
    RDSH_ADAPTER_FIXTURE_TRACE: path.join(root, "trace.jsonl"),
  };
  delete env.CUDA_VISIBLE_DEVICES;
  delete env.NVIDIA_VISIBLE_DEVICES;
  const leases = new GpuLeases({
    home: env.RDSH_GPU_FIXTURE_HOME,
    observe: async () => parseGpuInventory(inventory),
  });
  const ledger = await SessionLedger.open(project);
  const adapters = [],
    workers = [];
  t.after(async () => {
    const results = await Promise.allSettled(
      adapters.map((adapter) => adapter.stop()),
    );
    for (const child of workers) {
      if (child.exitCode === null) {
        const ended = once(child, "exit");
        child.send({ operation: "crash" });
        await ended;
      }
    }
    const failures = results.filter((result) => result.status === "rejected");
    if (failures.length) throw failures[0].reason;
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert(path.basename(root).startsWith("rdsh-gpu-"));
    await fs.rm(root, { recursive: true, force: true });
  });
  async function worker() {
    const child = fork(workerFile, [], {
      execPath: process.execPath,
      env,
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    workers.push(child);
    child.stderr.resume();
    assert.deepEqual((await once(child, "message"))[0], { ready: true });
    return child;
  }
  return {
    root,
    project,
    env,
    leases,
    ledger,
    adapters,
    worker,
    command: [process.execPath, peer],
  };
}

test("UUID inventory retains unavailable values and rejects malformed/duplicate/ordinal requests", async () => {
  assert.equal(parseGpuInventory(inventory).devices[0].free_mib, 12288);
  assert.equal(
    parseGpuInventory(`${device}, 16384, N/A, [N/A]`).devices[0].used_mib,
    null,
  );
  for (const text of [
    inventory + inventory,
    `${device}, 16, -1, 2`,
    `${device}, 16, 1, 17`,
    `${device}, 16, 1`,
    "secret-driver-stderr",
    "",
  ])
    assert.throws(() => parseGpuInventory(text));
  for (const invalid of [
    { ...request, device_id: "0" },
    { ...request, requested_vram_mib: 0 },
    { ...request, mode: "auto" },
    { ...request, force: true },
  ])
    assert.throws(() => gpuRequest(invalid));
  const calls = [];
  const observed = await observeGpu({
    execImpl: async (executable, args, options) => {
      calls.push({ executable, args, options });
      return { stdout: inventory };
    },
  });
  assert.equal(observed.status, "observed");
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.windowsHide, true);
  assert(
    calls[0].args.every(
      (arg) => !arg.includes("reset") && !arg.includes("compute-mode"),
    ),
  );
  const unavailable = await observeGpu({
    execImpl: async () => {
      throw new Error("private-command-error");
    },
  });
  assert.equal(unavailable.status, "unavailable");
  assert(!JSON.stringify(unavailable).includes("private-command-error"));
});

test("two actual processes competing across projects get exactly one exclusive reservation", async (t) => {
  const { project, leases, worker } = await setup(t);
  const [a, b] = await Promise.all([worker(), worker()]);
  const reads = [once(a, "message"), once(b, "message")];
  a.send({
    operation: "acquire",
    home: leases.home,
    inventory,
    input: { project, run_id: run(), owner_id: owner(), request },
  });
  b.send({
    operation: "acquire",
    home: leases.home,
    inventory,
    input: {
      project: { ...project, id: "a".repeat(16) },
      run_id: run(),
      owner_id: owner(),
      request,
    },
  });
  const results = (await Promise.all(reads)).map((messages) => {
    assert(!messages[0].error, messages[0].error);
    return messages[0].result;
  });
  assert.deepEqual(results.map((result) => result.status).sort(), [
    "reserved",
    "waiting-resource",
  ]);
  assert.equal(
    results.find((result) => result.reason).reason,
    "gpu_exclusive_busy",
  );
  assert.equal((await leases.read()).leases.length, 1);
  const ends = [once(a, "exit"), once(b, "exit")];
  a.send({ operation: "crash" });
  b.send({ operation: "crash" });
  await Promise.all(ends);
  leases.now = () => Date.now() + 31000;
  const reconciled = await leases.reconcile();
  assert.equal(reconciled.checked[0].reason, "unstarted_owner_absent");
  assert.equal((await leases.read()).leases.length, 0);
});

test("an abruptly exited writer releases the OS lock without stale-file deletion", async (t) => {
  const { project, leases, worker } = await setup(t);
  const child = await worker(),
    locked = once(child, "message");
  child.send({ operation: "lock", home: leases.home });
  assert.deepEqual((await locked)[0], { locked: true });
  const ended = once(child, "exit");
  child.send({ operation: "crash" });
  assert.equal((await ended)[0], 23);
  const result = await leases.acquire({
    project,
    run_id: run(),
    owner_id: owner(),
    request,
  });
  assert.equal(result.status, "reserved");
  await leases.cancelUnstarted(result.lease.lease_id);
  assert((await fs.stat(leases.lock)).isFile());
});

test("a live writer lock produces an explicit GPU admission wait without guessing capacity", async (t) => {
  const { project, leases, worker } = await setup(t);
  const child = await worker(),
    locked = once(child, "message");
  child.send({ operation: "lock", home: leases.home });
  assert.deepEqual((await locked)[0], { locked: true });
  const contender = new GpuLeases({
    home: leases.home,
    observe: async () => {
      throw new Error("No inventory query may run outside the lock");
    },
    lockTimeout: 50,
  });
  const result = await contender.acquire({
    project,
    run_id: run(),
    owner_id: owner(),
    request,
  });
  assert.equal(result.status, "waiting-resource");
  assert.equal(result.reason, "gpu_ledger_busy");
  assert.equal(result.request.device_id, device);
  assert.equal(result.admission_available_mib, null);
  assert.equal(result.native_process_started, false);
});

test("shared VRAM requests subtract all reservations while showing driver usage separately", async (t) => {
  const { project, leases } = await setup(t);
  const first = await leases.acquire({
    project,
    run_id: run(),
    owner_id: owner(),
    request: { ...request, mode: "shared", requested_vram_mib: 8192 },
  });
  const second = await leases.acquire({
    project,
    run_id: run(),
    owner_id: owner(),
    request: { ...request, mode: "shared", requested_vram_mib: 4097 },
  });
  assert.equal(second.status, "waiting-resource");
  assert.equal(second.reason, "gpu_capacity_insufficient");
  assert.equal(second.admission_available_mib, 4096);
  const report = await leases.inspect();
  assert.equal(report.devices[0].driver_used_mib, 2048);
  assert.equal(report.devices[0].reserved_mib, 8192);
  assert.equal(report.devices[0].driver_free_mib, 12288);
  await leases.cancelUnstarted(first.lease.lease_id);
});

test("capacity wait records the target and starts no version probe or ACP peer", async (t) => {
  const { ledger, leases, command, env } = await setup(t);
  await assert.rejects(
    attachRecordedSession({
      ledger,
      command,
      env,
      gpu: { ...request, requested_vram_mib: 13000 },
      gpuLeases: leases,
    }),
    (error) => {
      assert.equal(error.code, "gpu_waiting_resource");
      assert.equal(error.report.request.device_id, device);
      assert.equal(error.report.reason, "gpu_capacity_insufficient");
      assert.equal(error.report.native_process_started, false);
      return true;
    },
  );
  assert.equal((await leases.read()).leases.length, 0);
  assert.equal((await leases.read()).waiting.length, 1);
  const recorded = (await ledger.list())[0];
  assert.equal(
    (await (await RunHistory.open(ledger.project)).inspect(recorded.run_id))
      .state,
    "waiting-resource",
  );
  await assert.rejects(fs.access(env.RDSH_ADAPTER_FIXTURE_TRACE), {
    code: "ENOENT",
  });
  await assert.rejects(fs.access(env.RDSH_GPU_FIXTURE_ENTRY), {
    code: "ENOENT",
  });
});

test("the original ACP peer sees a prior reservation, and resume restores its GPU request", async (t) => {
  const { ledger, leases, command, env, adapters } = await setup(t);
  const first = await attachRecordedSession({
    ledger,
    command,
    env,
    gpu: request,
    gpuLeases: leases,
    stopTimeout: 200,
  });
  adapters.push(first.adapter);
  const entry = JSON.parse(
    await fs.readFile(env.RDSH_GPU_FIXTURE_ENTRY, "utf8"),
  );
  assert.equal(entry.lease_id, first.gpu.lease_id);
  assert.equal(entry.device_id, device);
  assert.equal((await leases.read()).leases[0].phase, "bound");
  assert.equal(
    (await first.adapter.send(first.record.cli_session_id, "fixture only"))
      .stop_reason,
    "end_turn",
  );
  await first.adapter.stop();
  assert.equal((await leases.read()).leases.length, 0);
  assert.equal(
    (await leases.read()).released.at(-1).reason,
    "held_kernel_group_empty",
  );
  const second = await attachRecordedSession({
    ledger,
    run_id: first.record.run_id,
    command,
    env,
    gpuLeases: leases,
    stopTimeout: 200,
  });
  adapters.push(second.adapter);
  assert.deepEqual(second.gpu.request, request);
  assert.notEqual(second.gpu.lease_id, first.gpu.lease_id);
  assert.equal(second.record.cli_session_id, first.record.cli_session_id);
  await second.adapter.stop();
  assert.equal((await leases.read()).leases.length, 0);
  await assert.rejects(
    runGpuRequest(ledger.project, first.record.run_id, {
      ...request,
      requested_vram_mib: 1024,
    }),
    code("gpu_run_request_changed"),
  );
});

test("retry-start explicitly retries the same never-dispatched GPU run after capacity recovers", async (t) => {
  const { ledger, leases, command, env, adapters } = await setup(t);
  leases.observe = async () =>
    parseGpuInventory(`${device}, 16384, 15000, 1024`);
  let pending;
  await assert.rejects(
    attachRecordedSession({
      ledger,
      command,
      env,
      gpu: request,
      gpuLeases: leases,
    }),
    (error) => {
      pending = error.report.run_id;
      return error.code === "gpu_waiting_resource";
    },
  );
  await assert.rejects(
    attachRecordedSession({
      ledger,
      run_id: pending,
      command,
      env,
      gpuLeases: leases,
    }),
    code("session_id_unknown"),
  );
  leases.observe = async () => parseGpuInventory(inventory);
  const retried = await attachRecordedSession({
    ledger,
    run_id: pending,
    retryStart: true,
    command,
    env,
    gpuLeases: leases,
    stopTimeout: 200,
  });
  adapters.push(retried.adapter);
  assert.equal(retried.record.run_id, pending);
  assert.deepEqual(retried.gpu.request, request);
  assert.equal(
    (await retried.history.inspect(pending)).commands[0].operation,
    "start",
  );
  assert.equal((await leases.read()).waiting.length, 0);
  await retried.adapter.stop();
  await assert.rejects(
    attachRecordedSession({
      ledger,
      run_id: pending,
      retryStart: true,
      command,
      env,
      gpuLeases: leases,
    }),
    code("pending_gpu_start_required"),
  );
});

test("resuming an existing GPU session can wait without probing and then resume its exact native ID", async (t) => {
  const { ledger, leases, command, env, adapters } = await setup(t);
  const first = await attachRecordedSession({
    ledger,
    command,
    env,
    gpu: request,
    gpuLeases: leases,
    stopTimeout: 200,
  });
  adapters.push(first.adapter);
  await first.adapter.stop();
  const before = await fs.readFile(env.RDSH_ADAPTER_FIXTURE_TRACE, "utf8");
  leases.observe = async () =>
    parseGpuInventory(`${device}, 16384, 15000, 1024`);
  await assert.rejects(
    attachRecordedSession({
      ledger,
      run_id: first.record.run_id,
      command,
      env,
      gpuLeases: leases,
    }),
    code("gpu_waiting_resource"),
  );
  assert.equal(
    (await first.history.inspect(first.record.run_id)).state,
    "waiting-resource",
  );
  assert.equal(
    await fs.readFile(env.RDSH_ADAPTER_FIXTURE_TRACE, "utf8"),
    before,
  );
  leases.observe = async () => parseGpuInventory(inventory);
  const resumed = await attachRecordedSession({
    ledger,
    run_id: first.record.run_id,
    command,
    env,
    gpuLeases: leases,
    stopTimeout: 200,
  });
  adapters.push(resumed.adapter);
  assert.equal(resumed.record.cli_session_id, first.record.cli_session_id);
  await resumed.adapter.stop();
});

test("an abnormal root exit retains its GPU reservation while owned detached descendants live", async (t) => {
  const { root, ledger, leases, command, env, adapters } = await setup(t);
  const exitFile = path.join(root, "exit-root"),
    children = path.join(root, "owned-children.jsonl");
  const attached = await attachRecordedSession({
    ledger,
    command,
    env: {
      ...env,
      RDSH_ADAPTER_FIXTURE_MODE: "descendants",
      RDSH_ADAPTER_FIXTURE_CHILD_TRACE: children,
      RDSH_GPU_FIXTURE_EXIT_FILE: exitFile,
    },
    gpu: request,
    gpuLeases: leases,
    stopTimeout: 200,
  });
  adapters.push(attached.adapter);
  assert((await attached.adapter.ownedScope.inspect()).remaining_count >= 3);
  await fs.writeFile(exitFile, "exit only this fixture's root");
  await waitFor(() => attached.adapter.stopped);
  const scope = await attached.adapter.ownedScope.inspect();
  assert.equal(scope.status, "running");
  assert(scope.remaining_count >= 2);
  leases.now = () => Date.now() + 31000;
  const result = await leases.reconcile();
  assert.equal(result.checked[0].reason, "scope_exit_unconfirmed");
  assert.equal((await leases.read()).leases[0].lease_id, attached.gpu.lease_id);
  await attached.adapter.stop();
  assert.equal((await leases.read()).leases.length, 0);
  assert.equal(attached.adapter.ownedScope.state.remaining_count, 0);
});

test("losing the durable lease blocks the next native send, and confirmed stop restores release", async (t) => {
  const { ledger, leases, command, env, adapters } = await setup(t);
  const attached = await attachRecordedSession({
    ledger,
    command,
    env,
    gpu: request,
    gpuLeases: leases,
    stopTimeout: 200,
  });
  adapters.push(attached.adapter);
  const bytes = await fs.readFile(leases.file);
  const trace = await fs.readFile(env.RDSH_ADAPTER_FIXTURE_TRACE, "utf8");
  await fs.appendFile(leases.file, "partial-write");
  await assert.rejects(
    attached.adapter.send(attached.record.cli_session_id, "must not dispatch"),
    code("gpu_ledger_invalid"),
  );
  assert.equal(
    await fs.readFile(env.RDSH_ADAPTER_FIXTURE_TRACE, "utf8"),
    trace,
  );
  await fs.writeFile(leases.file, bytes);
  await attached.adapter.stop();
  assert.equal((await leases.read()).leases.length, 0);
});

test("N/A, missing devices and unavailable driver data produce waits rather than invented capacity", async (t) => {
  const { project, leases } = await setup(t);
  for (const [sample, reason] of [
    [
      parseGpuInventory(`${device}, 16384, [N/A], [N/A]`),
      "gpu_memory_unavailable",
    ],
    [
      parseGpuInventory(
        `GPU-00000000-0000-0000-0000-000000000002, 16384, 0, 16384`,
      ),
      "gpu_device_unavailable",
    ],
    [{ status: "unavailable", devices: [] }, "gpu_inventory_unavailable"],
  ]) {
    leases.observe = async () => sample;
    const result = await leases.acquire({
      project,
      run_id: run(),
      owner_id: owner(),
      request,
    });
    assert.equal(result.status, "waiting-resource");
    assert.equal(result.reason, reason);
    assert.equal(result.admission_available_mib, null);
  }
  assert.equal((await leases.read()).leases.length, 0);
});

test("expired heartbeat cannot release an alive owner or an unbound launch with an absent owner", async (t) => {
  const { project, leases } = await setup(t);
  const reserved = await leases.acquire({
    project,
    run_id: run(),
    owner_id: owner(),
    request,
  });
  leases.now = () => Date.now() + 31000;
  assert.equal(
    (await leases.reconcile()).checked[0].reason,
    "controller_alive_heartbeat_expired",
  );
  await leases.beginLaunch(reserved.lease.lease_id);
  const actual = reserved.lease.controller_identity;
  leases.observeProcess = async () => ({
    status: "gone",
    platform: actual.platform,
    scope: actual.scope,
  });
  const reconciliation = await leases.reconcile();
  assert.equal(reconciliation.checked[0].reason, "launch_scope_unconfirmed");
  assert.equal((await leases.read()).leases.length, 1);
});

test("root absence and PID reuse need a matching durable kernel-empty receipt", async (t) => {
  const { project, leases } = await setup(t);
  const history = await RunHistory.open(project),
    id = run();
  const acquired = await leases.acquire({
    project,
    run_id: id,
    owner_id: history.owner_id,
    request,
  });
  await leases.beginLaunch(acquired.lease.lease_id);
  const self = (await readProcessIdentity(process.pid)).identity;
  const root = { ...self, pid: 2147483640, birth: "12345" };
  const scope = {
    owner_id: history.owner_id,
    kind: process.platform === "win32" ? "windows_job" : "linux_cgroup_v2",
    kernel_id: history.owner_id,
    root_identity: root,
    root_pid: root.pid,
  };
  await leases.bind(acquired.lease.lease_id, scope);
  leases.now = () => Date.now() + 31000;
  leases.observeProcess = async (pid) =>
    pid === root.pid
      ? { status: "observed", identity: { ...root, birth: "12346" } }
      : { status: "observed", identity: self };
  assert.equal(
    (await leases.reconcile()).checked[0].reason,
    "scope_exit_unconfirmed",
  );
  await history.register(id);
  await history.transition(id, "starting", "request_recorded");
  await history.scopeIntent(id);
  await history.bindScope(id, scope);
  await history.bindProcess(id, root);
  const stage = {
    owner_id: history.owner_id,
    stage: "verification",
    phase: "result",
    status: "exit_confirmed",
    reason: null,
    deadline_ms: null,
    observed_at: new Date().toISOString(),
    remaining_pids: [],
    remaining_count: 0,
  };
  await history.stopStage(id, stage);
  await fs.appendFile(history.file, "incomplete-tail");
  assert.equal((await leases.reconcile()).checked[0].status, "retained");
  const bytes = await fs.readFile(history.file);
  await fs.writeFile(
    history.file,
    bytes.subarray(0, bytes.lastIndexOf(10) + 1),
  );
  const result = await leases.reconcile();
  assert.equal(result.checked[0].status, "released");
  assert.equal(result.checked[0].reason, "recorded_kernel_group_empty");
});

test("corrupt or hard-linked ledger fails before native dispatch", async (t) => {
  const { project, leases, ledger, command, env } = await setup(t);
  const held = await leases.acquire({
    project,
    run_id: run(),
    owner_id: owner(),
    request,
  });
  await leases.cancelUnstarted(held.lease.lease_id);
  await fs.link(leases.file, path.join(leases.home, "alias.json"));
  await assert.rejects(
    attachRecordedSession({
      ledger,
      command,
      env,
      gpu: request,
      gpuLeases: leases,
    }),
    code("gpu_ledger_invalid"),
  );
  await fs.unlink(path.join(leases.home, "alias.json"));
  await fs.appendFile(leases.file, "partial");
  await assert.rejects(leases.inspect(), code("gpu_ledger_invalid"));
  await assert.rejects(fs.access(env.RDSH_GPU_FIXTURE_ENTRY), {
    code: "ENOENT",
  });
});

test("a different kernel descriptor or host observation cannot reclaim an expired reservation", async (t) => {
  const { project, leases } = await setup(t);
  const history = await RunHistory.open(project),
    id = run();
  const acquired = await leases.acquire({
    project,
    run_id: id,
    owner_id: history.owner_id,
    request,
  });
  const self = (await readProcessIdentity(process.pid)).identity;
  const root = { ...self, pid: 2147483640, birth: "12345" };
  const descriptor = {
    owner_id: history.owner_id,
    kind: process.platform === "win32" ? "windows_job" : "linux_cgroup_v2",
    kernel_id: history.owner_id,
    root_identity: root,
    root_pid: root.pid,
  };
  await leases.beginLaunch(acquired.lease.lease_id);
  await leases.bind(acquired.lease.lease_id, descriptor);
  await history.register(id);
  await history.transition(id, "starting", "request_recorded");
  await history.scopeIntent(id);
  await history.bindScope(id, { ...descriptor, kernel_id: "different_scope" });
  await history.bindProcess(id, root);
  await history.stopStage(id, {
    owner_id: history.owner_id,
    stage: "verification",
    phase: "result",
    status: "exit_confirmed",
    reason: null,
    deadline_ms: null,
    observed_at: new Date().toISOString(),
    remaining_pids: [],
    remaining_count: 0,
  });
  leases.now = () => Date.now() + 31000;
  leases.observeProcess = async () => ({
    status: "gone",
    platform: root.platform,
    scope: "f".repeat(64),
  });
  assert.equal(
    (await leases.reconcile()).checked[0].process_observation,
    "unknown",
  );
  leases.observeProcess = async () => ({
    status: "gone",
    platform: root.platform,
    scope: root.scope,
  });
  assert.equal(
    (await leases.reconcile()).checked[0].reason,
    "scope_exit_unconfirmed",
  );
  assert.equal((await leases.read()).leases.length, 1);
});

test("an ordinal/disabled visibility mask cannot be widened by a GPU request", async (t) => {
  const { ledger, leases, command, env } = await setup(t);
  for (const mask of ["0", "-1", ""])
    await assert.rejects(
      attachRecordedSession({
        ledger,
        command,
        env: { ...env, CUDA_VISIBLE_DEVICES: mask },
        gpu: request,
        gpuLeases: leases,
      }),
      code("gpu_visibility_unverified"),
    );
  await assert.rejects(fs.access(env.RDSH_GPU_FIXTURE_ENTRY), {
    code: "ENOENT",
  });
});

test("CLI inspection is read-only and an unavailable requested UUID produces a temporary wait", async (t) => {
  const { project, env, root } = await setup(t);
  const inspected = JSON.parse(
    (await exec(process.execPath, [cli, "gpu", "inspect"], { env })).stdout,
  );
  assert.equal(inspected.scope, "cooperative_clients_sharing_this_state_home");
  await assert.rejects(
    fs.access(path.join(root, "dashboard", "gpu-resources")),
    { code: "ENOENT" },
  );
  await assert.rejects(
    exec(
      process.execPath,
      [
        cli,
        "session-ledger",
        "start",
        "--project",
        project.root,
        "--executable",
        process.execPath,
        "--entrypoint",
        peer,
        "--gpu-request",
        JSON.stringify(request),
      ],
      { env },
    ),
    (error) => {
      assert.equal(error.code, 75);
      const report = JSON.parse(error.stdout);
      assert.equal(report.status, "waiting-resource");
      assert.equal(report.request.device_id, device);
      assert.equal(report.native_process_started, false);
      return true;
    },
  );
  await assert.rejects(fs.access(env.RDSH_GPU_FIXTURE_ENTRY), {
    code: "ENOENT",
  });
});
