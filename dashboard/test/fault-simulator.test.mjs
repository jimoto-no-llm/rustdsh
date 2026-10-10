import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runFaultSimulation, faultScenarios } from "../fault-simulator.mjs";

const exec = promisify(execFile);
const entry = fileURLToPath(new URL("../fault-simulator.mjs", import.meta.url));
const guard = new URL("../fault-simulator-network.mjs", import.meta.url).href;
async function workspace(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rdsh-fault-test-"));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert(path.basename(root).startsWith("rdsh-fault-test-"));
    await fs.rm(root, { recursive: true, force: true });
  });
  return root;
}

test("all six real control-plane scenarios expose effects, persistence and resource proof without inherited credentials", async (t) => {
  const root = await workspace(t);
  const previous = process.env.PROVIDER_API_KEY;
  process.env.PROVIDER_API_KEY = "fault-test-credential-must-not-be-inherited";
  t.after(() => {
    if (previous === undefined) delete process.env.PROVIDER_API_KEY;
    else process.env.PROVIDER_API_KEY = previous;
  });
  const report = await runFaultSimulation({ outputDirectory: path.join(root, "all"), seed: 1 });
  assert.deepEqual(report.results.map((r) => r.scenario), faultScenarios);
  assert.equal(report.passed, true, JSON.stringify(report.results.filter((r) => !r.passed)));
  assert.deepEqual(report.results.map((r) => r.facts.native_effects), [1, 1, 1, 1, 0, 0]);
  const [duplicate, order, network, restart, disk, gpu] = report.results;
  assert(duplicate.events.some((e) => e.event === "duplicate_command_rejected"));
  assert(order.events.some((e) => e.event === "out_of_order_ack_rejected"));
  assert.equal(network.facts.attempts, 1);
  assert.equal(network.facts.certainty, "reconciled_applied");
  assert.equal(network.facts.resource_release, "confirmed_listener_closed");
  assert.equal(restart.facts.control_process_restarted, true);
  assert.equal(restart.facts.ack, false);
  assert.equal(restart.facts.resource_release, "unconfirmed");
  assert.equal(restart.facts.automatically_restarted, false);
  assert.equal(disk.facts.durable_save, "unconfirmed");
  assert.equal(disk.facts.ack, false);
  assert(disk.events.some((e) => e.event === "injected_ENOSPC" && e.boundary === "sync"));
  assert.equal(gpu.facts.recorded_state, "unknown");
  assert.equal(gpu.facts.ack, false);
  assert(gpu.facts.remaining_count_before_stop > 0);
  for (const result of [duplicate, order, disk, gpu])
    assert.equal(result.facts.resource_release_after_stop, true);
  const manifest = JSON.parse(await fs.readFile(path.join(root, "all", "reproducibility.json"), "utf8"));
  const inputBytes = await fs.readFile(path.join(root, "all", "input.json"));
  assert.equal(manifest.schema, 1);
  assert.equal(manifest.run.input_reference.path, "input.json");
  assert.equal(manifest.run.input_reference.sha256, createHash("sha256").update(inputBytes).digest("hex"));
  assert.match(manifest.target.commit_sha, /^[0-9a-f]{40,64}$/);
  assert.match(manifest.target.tracked_worktree_hash, /^[0-9a-f]{64}$/);
  assert.match(manifest.source.fingerprint_sha256, /^[0-9a-f]{64}$/);
  assert.match(manifest.source.fixture.sha256, /^[0-9a-f]{64}$/);
  assert.equal(manifest.runtime.node, process.version);
  assert(manifest.dependencies.packages.some((item) => item.name === "@agentclientprotocol/sdk"));
  assert.equal(manifest.tools.invoked.length, 0);
  assert(manifest.tools.fixture_protocol_methods.includes("session/prompt"));
  assert.equal(manifest.redaction.environment.variable_names_persisted, false);
  assert.equal(manifest.redaction.environment.variable_values_persisted, false);
  assert(manifest.redaction.environment.credential_like_variable_count > 0);
  assert.equal(manifest.redaction.input.unknown_fields_rejected, true);
  assert.equal(manifest.replayability.same_input_replay_supported, true);
  assert.equal(manifest.replayability.fully_reproducible, false);
  assert.deepEqual(manifest.replayability.external_services, []);
  assert(manifest.replayability.external_dependencies.length > 0);
  assert(manifest.replayability.replay_blocked_cases.length > 0);
  assert.equal(report.reproducibility_manifest.path, "reproducibility.json");
  assert.equal(report.reproducibility_manifest.sha256,
    createHash("sha256").update(await fs.readFile(path.join(root, "all", "reproducibility.json"))).digest("hex"));
  assert.doesNotMatch(JSON.stringify({ report, manifest }), /fault-test-credential-must-not/);
  assert.doesNotMatch(JSON.stringify({ report, manifest }), /PROVIDER_API_KEY/);
  for (const file of ["input.json", "report.json", "reproducibility.json",
    ...faultScenarios.map((name) => path.join(name, "result.json"))])
    assert.doesNotMatch(await fs.readFile(path.join(root, "all", file), "utf8"), /fault-test-credential-must-not/);
  const inputSecret = "fault-test-secret-input-must-not-be-copied";
  const secretInput = path.join(root, "secret-input.json");
  await fs.writeFile(secretInput, JSON.stringify({ ...JSON.parse(inputBytes.toString("utf8")),
    credentials: inputSecret }));
  const rejectedOutput = path.join(root, "secret-replay");
  await assert.rejects(runFaultSimulation({ replay: secretInput, outputDirectory: rejectedOutput }));
  await assert.rejects(fs.stat(rejectedOutput), (failure) => failure.code === "ENOENT");
  assert.doesNotMatch(JSON.stringify({ report, manifest }), new RegExp(inputSecret));
  assert.match(report.source_fingerprint, /^[0-9a-f]{64}$/);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, "all", "report.json"), "utf8")), report);
});

test("CLI replay retains the exact seed and fault point; ENOSPC before write dispatches nothing", async (t) => {
  const root = await workspace(t);
  const first = await runFaultSimulation({ outputDirectory: path.join(root, "first"), scenario: "disk_full", seed: 0 });
  assert.equal(first.passed, true);
  assert(first.results[0].events.some((e) => e.event === "injected_ENOSPC" && e.boundary === "write"));
  const { stdout } = await exec(process.execPath, [entry, "replay", "--manifest",
    path.join(root, "first", "input.json"), "--output", path.join(root, "replay")],
    { windowsHide: true, timeout: 120000, maxBuffer: 256 * 1024 });
  const second = JSON.parse(stdout);
  assert.equal(second.passed, true);
  assert.equal(second.seed, 0);
  assert.equal(second.source_fingerprint, first.source_fingerprint);
  assert.deepEqual(second.results[0].facts, first.results[0].facts);
  assert.deepEqual(second.results[0].events, first.results[0].events);
  for (const report of [first, second]) {
    assert.equal(report.results[0].events.filter((e) => e.event === "injected_ENOSPC").length, 1);
    const attempts = report.results[0].runtime_observations.journal_failures;
    assert(attempts.length > 0);
    assert(attempts.every((attempt, i) => attempt.attempt === i + 1 &&
      attempt.boundary === "write" && Number.isFinite(attempt.elapsed_ms) && attempt.elapsed_ms >= 0));
  }
  assert.deepEqual(await fs.readFile(path.join(root, "first", "input.json")),
    await fs.readFile(path.join(root, "replay", "input.json")));
});

test("invalid plans and existing output paths are rejected before any scenario starts", async (t) => {
  const root = await workspace(t);
  for (const input of [{ seed: -1 }, { seed: 0x100000000 }, { scenario: "arbitrary-command" }]) {
    const directory = path.join(root, "invalid");
    await assert.rejects(runFaultSimulation({ outputDirectory: directory, ...input }));
    await assert.rejects(fs.stat(directory), (error) => error.code === "ENOENT");
  }
  const existing = path.join(root, "user-file");
  await fs.writeFile(existing, "preserve this exact data");
  await assert.rejects(runFaultSimulation({ outputDirectory: existing }), (error) => error.code === "EEXIST");
  assert.equal(await fs.readFile(existing, "utf8"), "preserve this exact data");
  const manifest = path.join(root, "bad.json");
  await fs.writeFile(manifest, JSON.stringify({ schema: 1, seed: 1,
    scenarios: ["network_disconnect"], executable: "/forbidden/real-cli" }));
  await assert.rejects(runFaultSimulation({ replay: manifest, outputDirectory: path.join(root, "bad-replay") }));
  await assert.rejects(fs.stat(path.join(root, "bad-replay")), (error) => error.code === "ENOENT");
});

test("non-loopback TCP, TLS and UDP are denied before opening a connection", async () => {
  const source = `
    const net = await import('node:net');
    const tls = await import('node:tls');
    const udp = await import('node:dgram');
    for (const connect of [() => net.connect({host:'192.0.2.1',port:443}),
      () => tls.connect({host:'api.invalid',port:443}), () => udp.createSocket('udp4')]) {
      try { connect(); throw new Error('network unexpectedly allowed'); }
      catch (error) { if (error.code !== 'simulator_network_denied') throw error; }
    }
    console.log(JSON.stringify(globalThis.rdshFaultNetwork));
  `;
  const { stdout } = await exec(process.execPath, ["--import", guard, "--input-type=module", "-e", source],
    { env: { ...process.env, RDSH_FAULT_ISOLATED: "1" }, windowsHide: true, timeout: 10000 });
  assert.deepEqual(JSON.parse(stdout), { loopback_connections: 0, blocked_connections: 3 });
});
