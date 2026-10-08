// Reproducible transport/ledger evidence with a fixed inventory and original
// ACP peer fixtures. No GPU allocations, model calls, credentials or real jobs.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { identity } from "../state.mjs";
import { GpuLeases, runGpuRequest } from "../gpu-leases.mjs";
import { parseGpuInventory, observeGpu } from "../gpu-telemetry.mjs";
import { SessionLedger, attachRecordedSession } from "../session-ledger.mjs";

const exec = promisify(execFile);
const root = await fs.mkdtemp(path.join(os.tmpdir(), "rdsh-gpu-evidence-"));
const cwd = path.join(root, "project");
await fs.mkdir(cwd);
await exec("git", ["-C", cwd, "init", "-b", "gpu-evidence"]);
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
project.directory = path.join(root, "state", "projects", project.id);
const env = {
  ...process.env,
  RDSH_DASHBOARD_HOME: path.join(root, "state"),
  HOME: root,
  USERPROFILE: root,
  DSH_HOME: path.join(root, "dsh"),
  XDG_CONFIG_HOME: path.join(root, "config"),
  XDG_DATA_HOME: path.join(root, "data"),
  APPDATA: path.join(root, "data"),
  LOCALAPPDATA: path.join(root, "local"),
  GIT_CEILING_DIRECTORIES: root,
  RDSH_GPU_FIXTURE_HOME: path.join(root, "state", "gpu-resources"),
  RDSH_GPU_FIXTURE_ENTRY: path.join(root, "entry.json"),
};
delete env.CUDA_VISIBLE_DEVICES;
delete env.NVIDIA_VISIBLE_DEVICES;
const device = "GPU-00000000-0000-0000-0000-000000000001";
const request = {
  device_id: device,
  requested_vram_mib: 4096,
  mode: "exclusive",
};
const stock = (free = 12288) =>
  parseGpuInventory(`${device}, 16384, 2048, ${free}`);
const leases = new GpuLeases({
  home: env.RDSH_GPU_FIXTURE_HOME,
  observe: async () => stock(),
});
const ledger = await SessionLedger.open(project);
const peer = (name) => [
  process.execPath,
  fileURLToPath(new URL(`./fixtures/${name}.mjs`, import.meta.url)),
];
const active = [];
const timings = {
  disabled: { attach_ms: [], send_ms: [], stop_ms: [] },
  leased: { attach_ms: [], send_ms: [], stop_ms: [] },
};
const sourceFiles = [
  "package.json",
  "package-lock.json",
  "process-scope.mjs",
  "process-scope-backends.mjs",
  "tracked-adapter.mjs",
  "gpu-telemetry.mjs",
  "gpu-lock.mjs",
  "gpu-leases.mjs",
  "gpu-attachment.mjs",
  "session-ledger.mjs",
  "run-history.mjs",
  "releases.mjs",
  "cli.mjs",
  "state.mjs",
  "test/gpu-evidence.mjs",
  "test/fixtures/acp-cli.mjs",
  "test/fixtures/gpu-acp-cli.mjs",
];
const digest = createHash("sha256");
for (const file of sourceFiles) {
  digest.update(file + "\0");
  digest.update(await fs.readFile(new URL("../" + file, import.meta.url)));
}
const median = (samples) =>
  [...samples].sort((a, b) => a - b)[Math.floor(samples.length / 2)];
try {
  const missing = "run_" + randomUUID(),
    lookup = [];
  for (let i = 0; i < 200; i++) {
    const at = performance.now();
    assert.equal(await runGpuRequest(project, missing), null);
    lookup.push(performance.now() - at);
  }
  for (let repetition = 0; repetition < 3; repetition++) {
    for (const mode of ["disabled", "leased"]) {
      const at = performance.now();
      const attached = await attachRecordedSession({
        ledger,
        command: peer(mode === "leased" ? "gpu-acp-cli" : "acp-cli"),
        env,
        gpu: mode === "leased" ? request : null,
        gpuLeases: leases,
        stopTimeout: 1000,
      });
      active.push(attached.adapter);
      timings[mode].attach_ms.push(performance.now() - at);
      for (let i = 0; i < 8; i++) {
        const start = performance.now();
        assert.equal(
          (
            await attached.adapter.send(
              attached.record.cli_session_id,
              "fixture transport measurement",
            )
          ).stop_reason,
          "end_turn",
        );
        timings[mode].send_ms.push(performance.now() - start);
      }
      const stopping = performance.now();
      await attached.adapter.stop();
      timings[mode].stop_ms.push(performance.now() - stopping);
      assert.equal((await leases.read()).leases.length, 0);
    }
  }
  // Same low driver inventory: opt-in changes the admission outcome before ACP.
  leases.observe = async () => stock(1024);
  const before = await attachRecordedSession({
    ledger,
    command: peer("acp-cli"),
    env,
    stopTimeout: 1000,
  });
  active.push(before.adapter);
  await before.adapter.stop();
  let waiting;
  try {
    await attachRecordedSession({
      ledger,
      command: peer("gpu-acp-cli"),
      env,
      gpu: request,
      gpuLeases: leases,
    });
  } catch (error) {
    assert.equal(error.code, "gpu_waiting_resource");
    waiting = error.report;
  }
  assert.equal(waiting.reason, "gpu_capacity_insufficient");
  const observed = await leases.inspect();
  const report = {
    schema: 1,
    platform: process.platform,
    node: process.version,
    at: new Date().toISOString(),
    runtime_source_sha256: digest.digest("hex"),
    source_files: sourceFiles,
    scope:
      "fixed_driver_inventory_and_original_ACP_peer; actual_kernel_process_ownership; no_GPU_workload_or_model",
    marker_miss_200: {
      median_ms: median(lookup),
      p95_ms: [...lookup].sort((a, b) => a - b)[189],
    },
    transport_samples: {
      attach_per_mode: 3,
      send_per_mode: 24,
      stop_per_mode: 3,
    },
    timings,
    medians: Object.fromEntries(
      Object.entries(timings).map(([mode, measurements]) => [
        mode,
        Object.fromEntries(
          Object.entries(measurements).map(([kind, values]) => [
            kind,
            median(values),
          ]),
        ),
      ]),
    ),
    before_after_low_capacity: {
      before: {
        opt_in: false,
        native_process_started: true,
        process_stop: "owned_group_exit_confirmed",
        reservation_mib: 0,
      },
      after: {
        opt_in: true,
        status: waiting.status,
        reason: waiting.reason,
        device_id: waiting.request.device_id,
        requested_vram_mib: waiting.request.requested_vram_mib,
        driver_free_mib: waiting.driver.devices[0].free_mib,
        reserved_mib: waiting.reserved_mib,
        native_process_started: waiting.native_process_started,
      },
    },
    final_active_reservations: observed.devices.reduce(
      (n, item) => n + item.leases.length,
      0,
    ),
    recently_released: observed.recently_released.map((item) => ({
      reason: item.reason,
      requested_vram_mib: item.request.requested_vram_mib,
    })),
    physical_GPU_workload_tested: false,
  };
  if (process.argv.includes("--hardware-metadata")) {
    const real = await observeGpu();
    report.read_only_hardware = {
      ...real,
      devices: real.devices.map(({ device_id, ...memory }) => ({
        device_id_sha256: createHash("sha256").update(device_id).digest("hex"),
        ...memory,
      })),
      UUIDs_redacted: true,
      allocations_performed: 0,
    };
  }
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
} finally {
  const stopped = await Promise.allSettled(
    active.map((adapter) => adapter.stop()),
  );
  const failed = stopped.find((result) => result.status === "rejected");
  if (failed) throw failed.reason;
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
  assert(path.basename(root).startsWith("rdsh-gpu-evidence-"));
  await fs.rm(root, { recursive: true, force: true });
}
