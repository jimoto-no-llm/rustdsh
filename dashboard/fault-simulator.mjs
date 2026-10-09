// Opt-in offline diagnostics. Every run writes a new directory and retains failures.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { parseArgs, isDeepStrictEqual } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { readProcessIdentity, matchProcessIdentity } from "./process-identity.mjs";

export const faultScenarios = Object.freeze([
  "duplicate_events", "out_of_order", "network_disconnect", "restart", "disk_full", "gpu_loss",
]);
const worker = fileURLToPath(new URL("./fault-simulator-worker.mjs", import.meta.url));
const networkGuard = new URL("./fault-simulator-network.mjs", import.meta.url).href;
const dashboardDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryDirectory = path.resolve(dashboardDirectory, "..");
const execFileAsync = promisify(execFile);
const fixtureFiles = ["fault-simulator-cli.mjs", "fault-simulator-worker.mjs",
  "fault-simulator-trace.mjs", "fault-simulator-network.mjs"];
const fixtureMethods = ["initialize", "session/new", "session/resume", "session/list",
  "session/prompt", "session/cancel", "session/close"];
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
async function fingerprintFiles(names) {
  const hash = createHash("sha256");
  for (const name of names) {
    hash.update(name + "\0");
    hash.update(await fs.readFile(path.join(dashboardDirectory, name)));
  }
  return hash.digest("hex");
}
async function sourceFingerprint() {
  return fingerprintFiles(["fault-simulator.mjs", ...fixtureFiles, "adapters.mjs",
    "tracked-adapter.mjs", "session-ledger.mjs", "run-history.mjs", "process-scope.mjs",
    "process-scope-backends.mjs", "process-identity.mjs", "retry.mjs", "package-lock.json"]);
}
async function targetSnapshot() {
  try {
    const options = { cwd: repositoryDirectory, windowsHide: true, timeout: 5000,
      maxBuffer: 1024 * 1024, encoding: "utf8" };
    const { stdout: commitOutput } = await execFileAsync("git", ["rev-parse", "HEAD"], options);
    const commit = commitOutput.trim();
    check(/^[0-9a-f]{40,64}$/.test(commit), "target_commit_unavailable");
    // Hash Git's tracked-file diff metadata without retaining filenames or contents.
    const { stdout: diff } = await execFileAsync("git", ["diff", "--raw", "--no-renames", "HEAD"], options);
    return {
      commit_sha: commit,
      tracked_worktree_hash: createHash("sha256").update(commit + "\0" + diff).digest("hex"),
      tracked_worktree_dirty: diff.length > 0,
      worktree_hash_scope: "HEAD and tracked index/working-tree diff; untracked and ignored files excluded",
      status: "captured",
    };
  } catch {
    return {
      commit_sha: null,
      tracked_worktree_hash: null,
      tracked_worktree_dirty: null,
      worktree_hash_scope: "unavailable",
      status: "unavailable",
    };
  }
}
async function dependencySnapshot() {
  try {
    const lockPath = path.join(dashboardDirectory, "package-lock.json");
    const lockBytes = await fs.readFile(lockPath);
    const lock = JSON.parse(lockBytes.toString("utf8"));
    const packages = [];
    for (const [lockPath, entry] of Object.entries(lock.packages || {})) {
      const marker = "node_modules/";
      const index = lockPath.lastIndexOf(marker);
      if (index < 0 || typeof entry.version !== "string") continue;
      const installPath = lockPath.slice(index + marker.length);
      const name = installPath.split("/node_modules/").at(-1);
      let installedVersion = null;
      try {
        const installed = JSON.parse(await fs.readFile(path.join(dashboardDirectory,
          "node_modules", installPath, "package.json"), "utf8"));
        if (typeof installed.version === "string") installedVersion = installed.version;
      } catch { /* A lockfile pin is not proof that a package is installed here. */ }
      packages.push({ name, locked_version: entry.version, installed_version: installedVersion,
        status: installedVersion === null ? "version_unavailable" :
          installedVersion === entry.version ? "verified" : "version_mismatch" });
    }
    packages.sort((a, b) => a.name.localeCompare(b.name) || a.locked_version.localeCompare(b.locked_version));
    const unavailable = packages.filter((item) => item.status === "version_unavailable")
      .map(({ name, locked_version }) => ({ name, locked_version, status: "installed_version_unavailable" }));
    const mismatched = packages.filter((item) => item.status === "version_mismatch")
      .map(({ name, locked_version, installed_version }) =>
        ({ name, locked_version, installed_version, status: "version_mismatch" }));
    return {
      source: "dashboard/package-lock.json",
      source_sha256: createHash("sha256").update(lockBytes).digest("hex"),
      packages,
      unavailable_versions: unavailable,
      version_mismatches: mismatched,
      status: "captured",
    };
  } catch {
    return { source: "dashboard/package-lock.json", source_sha256: null, packages: [],
      unavailable_versions: [{ name: "dashboard dependencies", status: "lockfile_unavailable" }],
      version_mismatches: [],
      status: "unavailable" };
  }
}
function environmentOmissions() {
  const names = Object.keys(process.env);
  return {
    variable_names_persisted: false,
    variable_values_persisted: false,
    omitted_variable_count: names.length,
    credential_like_variable_count: names.filter((name) =>
      /(token|key|secret|password|credential|auth|cookie)/i.test(name)).length,
    policy: "environment names and values are not copied into the run manifest",
  };
}
async function reproducibilityManifest(input, inputBytes, fingerprint) {
  const dependencies = await dependencySnapshot();
  const target = await targetSnapshot();
  const fixtureHash = await fingerprintFiles(fixtureFiles);
  return {
    schema: 1,
    kind: "rdsh-offline-run-reproducibility",
    created_at: new Date().toISOString(),
    run: {
      input_reference: { path: "input.json",
        sha256: createHash("sha256").update(inputBytes).digest("hex") },
      configuration: {
        scenarios: input.scenarios,
        seed: input.seed,
        logical_clock: input.clock,
        fault_points: input.fault_points,
        network_policy: "literal_loopback_only; TLS and UDP denied",
        worker_environment: "strict_allowlist; provider credentials, proxy values and NODE_OPTIONS omitted",
        output_reference: ".",
      },
    },
    target,
    source: { fingerprint_sha256: fingerprint,
      fingerprint_scope: "simulator, fixture, adapter, ledger, run-history, process-scope, process identity, retry and dependency lock files",
      fixture: { id: "offline-control-plane-v1", sha256: fixtureHash,
        files: fixtureFiles, reported_cli_version: "0.2.0-rc.2",
        protocol_methods: fixtureMethods } },
    runtime: { node: process.version, node_versions: { ...process.versions },
      platform: process.platform, architecture: process.arch, kernel_release: os.release() },
    dependencies,
    tools: { invoked: [], fixture_protocol_methods: fixtureMethods,
      note: "The mock ACP peer exposes protocol methods; no provider/model tools are invoked." },
    redaction: {
      environment: environmentOmissions(),
      input: { raw_payload_persisted: false,
        accepted_fields: ["schema", "simulator_version", "seed", "scenarios", "clock", "fault_points"],
        unknown_fields_rejected: true },
      secrets: { values_persisted: false, omission_facts_recorded: true },
    },
    replayability: {
      classification: "bounded_offline_fixture",
      same_input_replay_supported: true,
      fully_reproducible: false,
      fixed_scope: ["scenario selection", "seed and logical clock", "fixture source", "locked package versions"],
      external_dependencies: [{ name: "host process and filesystem behavior", version: os.release(),
        pinned: false }],
      external_services: [],
      unavailable_versions: dependencies.unavailable_versions,
      version_mismatches: dependencies.version_mismatches,
      replay_blocked_cases: ["real provider or model behavior", "physical GPU behavior",
        "host process scheduling, native identifiers and filesystem timing"],
    },
    output: { directory_reference: ".", source_report_reference: "report.json" },
  };
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
  const inputBytes = Buffer.from(json(input));
  await fs.writeFile(path.join(directory, "input.json"), inputBytes, { flag: "wx", mode: 0o600 });
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
  const reproducibility = await reproducibilityManifest(input, inputBytes, fingerprint);
  const reproducibilityBytes = Buffer.from(json(reproducibility));
  await fs.writeFile(path.join(directory, "reproducibility.json"), reproducibilityBytes,
    { flag: "wx", mode: 0o600 });
  const report = { schema: 1, simulator_version: 1, seed: input.seed,
    source_fingerprint: fingerprint, output_directory: ".",
    reproducibility_manifest: { path: "reproducibility.json",
      sha256: createHash("sha256").update(reproducibilityBytes).digest("hex") },
    runtime: { platform: process.platform, node: process.versions.node },
    source_fingerprint_scope: "simulator, fixtures, adapters, session-ledger, run-history, process-scope, process identity, retry and dashboard package-lock",
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
