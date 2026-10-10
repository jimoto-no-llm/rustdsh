// Opt-in offline diagnostics. Every run writes a new directory and retains failures.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { parseArgs, isDeepStrictEqual } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { readProcessIdentity, matchProcessIdentity } from "./process-identity.mjs";

export const faultScenarios = Object.freeze([
  "duplicate_events", "out_of_order", "network_disconnect", "restart", "disk_full", "gpu_loss",
]);
const worker = fileURLToPath(new URL("./fault-simulator-worker.mjs", import.meta.url));
const networkGuard = new URL("./fault-simulator-network.mjs", import.meta.url).href;
const check = (condition, code) => {
  if (!condition) throw Object.assign(new Error("Fault simulator: " + code), { code });
};
const json = (value) => JSON.stringify(value, null, 2) + "\n";
function manifest(seed, scenario) {
  check(Number.isInteger(seed) && seed >= 0 && seed <= 0xffffffff, "invalid_seed");
  check(scenario === "all" || faultScenarios.includes(scenario), "invalid_scenario");
  return { schema: 1, simulator_version: 1, seed,
    scenarios: scenario === "all" ? [...faultScenarios] : [scenario],
    clock: { type: "logical", origin_ms: 0, step_ms: 1 + (seed % 7) },
    fault_points: { restart: "mock_effect_before_native_ack", disk_full: seed % 2 === 0 ? "write" : "sync" } };
}
async function readManifest(file) {
  const handle = await fs.open(file, "r");
  try {
    check((await handle.stat()).size <= 16 * 1024, "manifest_too_large");
    const input = JSON.parse(await handle.readFile("utf8"));
    check(Array.isArray(input.scenarios), "invalid_manifest");
    const scenario = input.scenarios.length === 1 ? input.scenarios[0] : "all";
    check(isDeepStrictEqual(input, manifest(input.seed, scenario)), "invalid_manifest");
    return input;
  } catch (failure) {
    if (failure.code) throw failure;
    check(false, "invalid_manifest");
  } finally { await handle.close(); }
}
async function sourceFingerprint() {
  const hash = createHash("sha256");
  for (const name of ["fault-simulator.mjs", "fault-simulator-worker.mjs", "fault-simulator-trace.mjs", "fault-simulator-cli.mjs",
    "fault-simulator-network.mjs", "adapters.mjs", "tracked-adapter.mjs", "session-ledger.mjs",
    "run-history.mjs", "process-identity.mjs", "process-identity-windows.mjs",
    "process-scope.mjs", "process-scope-backends.mjs", "retry.mjs"]) {
    hash.update(name + "\0");
    hash.update(await fs.readFile(new URL(name, import.meta.url)));
  }
  return hash.digest("hex");
}
function isolatedEnv(root) {
  return {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|TEMP|TMP|COMSPEC|LANG|LC_ALL)$/i.test(key))),
    HOME: root, USERPROFILE: root, RDSH_FAULT_ISOLATED: "1",
  };
}
async function childRun(config) {
  const child = spawn(process.execPath, ["--import", networkGuard, worker, JSON.stringify(config)], {
    cwd: config.root, env: isolatedEnv(config.root), windowsHide: true,
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  let diagnostic = "";
  child.stderr.on("data", (part) => {
    if (Buffer.byteLength(diagnostic) < 16 * 1024) diagnostic += part.toString("utf8");
  });
  let result = null, checkpoint = null, checkpointFailure = null;
  const outcome = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      // The captured ChildProcess belongs to this exact scenario; no PID search.
      child.kill("SIGKILL");
      checkpointFailure = "scenario_deadline_exceeded";
    }, 120000);
    child.on("error", (failure) => { clearTimeout(timer); reject(failure); });
    child.on("message", async (message) => {
      if (message?.type === "result") result = message.result;
      else if (message?.type === "restart_checkpoint" && config.scenario === "restart" && !config.recovery && !checkpoint) {
        checkpoint = message;
        if (!checkpoint.root_identity) {
          const observed = await readProcessIdentity(checkpoint.root_pid);
          checkpoint.root_identity = observed.identity;
        }
        child.kill("SIGKILL");
      }
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
  if (diagnostic)
    await fs.writeFile(path.join(config.root, config.recovery ? "recovery-stderr.log" : "worker-stderr.log"),
      diagnostic.slice(0, 16 * 1024), { flag: "wx", mode: 0o600 });
  if (checkpoint && !checkpointFailure && !result) {
    check(outcome.signal === "SIGKILL", "restart_checkpoint_not_killed");
    check(checkpoint.root_identity, "fixture_process_identity_unavailable");
    const end = Date.now() + 15000;
    let rootExited = false;
    while (Date.now() < end) {
      const observed = await readProcessIdentity(checkpoint.root_pid);
      if (["gone", "pid_reused"].includes(matchProcessIdentity(checkpoint.root_identity, observed))) {
        rootExited = true;
        break;
      }
      await delay(100);
    }
    check(rootExited, "owned_mock_root_exit_unconfirmed");
    const recovered = await childRun({ ...config, recovery: checkpoint });
    recovered.events.unshift({ logical_time_ms: 0, event: "control_process_killed_after_effect_before_ack" });
    recovered.facts.control_process_restarted = true;
    recovered.facts.mock_root_exit_observed = true;
    return recovered;
  }
  check(!checkpointFailure, checkpointFailure);
  check(outcome.code === 0 && result, "scenario_worker_failed");
  check(result.scenario === config.scenario && result.seed === config.seed &&
    Array.isArray(result.checks) && result.checks.length > 0, "invalid_worker_result");
  return result;
}

export async function runFaultSimulation({ outputDirectory, scenario = "all", seed = 1, replay = null } = {}) {
  const input = replay === null ? manifest(seed, scenario) : await readManifest(replay);
  check(typeof outputDirectory === "string" && outputDirectory.length > 0 &&
    !/[\x00-\x1f]/.test(outputDirectory), "new_output_directory_required");
  const directory = path.resolve(outputDirectory);
  // Existing files/directories and symbolic links are never reused or overwritten.
  await fs.mkdir(directory, { mode: 0o700 });
  await fs.writeFile(path.join(directory, "input.json"), json(input), { flag: "wx", mode: 0o600 });
  const fingerprint = await sourceFingerprint();
  const results = [];
  for (const name of input.scenarios) {
    const root = path.join(directory, name);
    await fs.mkdir(root, { mode: 0o700 });
    await fs.mkdir(path.join(root, "project"));
    await fs.writeFile(path.join(root, ".fault-simulator-owned"), "rdsh-fault-simulator-v1\n", { flag: "wx", mode: 0o600 });
    let result;
    try { result = await childRun({ root, scenario: name, seed: input.seed }); }
    catch (failure) {
      result = { scenario: name, seed: input.seed, passed: false,
        failure: { phase: "scenario_worker", code: /^[a-zA-Z0-9_]{1,100}$/.test(failure.code || "")
          ? failure.code : "scenario_worker_failed" }, checks: [], events: [] };
    }
    results.push(result);
    await fs.writeFile(path.join(root, "result.json"), json(result), { flag: "wx", mode: 0o600 });
  }
  const report = { schema: 1, simulator_version: 1, seed: input.seed,
    source_fingerprint: fingerprint, output_directory: directory,
    runtime: { platform: process.platform, node: process.versions.node },
    source_fingerprint_scope: "simulator files, adapters, tracked-adapter, session-ledger, run-history, process-identity, process-scope, process-scope-backends and retry",
    verification_scope: "offline_control_plane_with_mock_CLI_and_mock_GPU; no_real_model_or_GPU_verification",
    passed: results.every((r) => r.passed), results };
  await fs.writeFile(path.join(directory, "report.json"), json(report), { flag: "wx", mode: 0o600 });
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values, positionals } = parseArgs({ allowPositionals: true, options: {
      output: { type: "string" }, scenario: { type: "string" }, seed: { type: "string" },
      manifest: { type: "string" }, help: { type: "boolean" },
    } });
    if (values.help) {
      console.log("node dashboard/fault-simulator.mjs run --output <new-directory> [--scenario <name|all>] [--seed <uint32>]\nnode dashboard/fault-simulator.mjs replay --manifest <input.json> --output <new-directory>\nScenarios: " + faultScenarios.join(", "));
    } else {
      check(positionals.length === 1 && ["run", "replay"].includes(positionals[0]), "run_or_replay_required");
      check(positionals[0] === "replay" ? values.manifest && !values.seed && !values.scenario : !values.manifest, "invalid_replay_options");
      check(values.seed === undefined || /^(0|[1-9][0-9]{0,9})$/.test(values.seed), "invalid_seed");
      const result = await runFaultSimulation({ outputDirectory: values.output,
        scenario: values.scenario || "all", seed: values.seed === undefined ? 1 : Number(values.seed),
        replay: positionals[0] === "replay" ? values.manifest : null });
      console.log(json(result));
      if (!result.passed) process.exitCode = 1;
    }
  } catch (failure) {
    console.error(json({ error: /^[a-zA-Z0-9_]{1,100}$/.test(failure.code || "") ? failure.code : "simulator_failed" }));
    process.exitCode = 1;
  }
}
