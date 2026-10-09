// This worker is killed only at an explicit restart checkpoint by its parent.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { isDeepStrictEqual } from "node:util";
import { identity } from "./state.mjs";
import { RunHistory } from "./run-history.mjs";
import { SessionLedger, attachRecordedSession } from "./session-ledger.mjs";
import { RetryHistory, RetryFailure, runWithRetry } from "./retry.mjs";
import { createFaultTrace } from "./fault-simulator-trace.mjs";

const config = JSON.parse(process.argv[2]);
if (
  process.env.RDSH_FAULT_ISOLATED !== "1" ||
  !globalThis.rdshFaultNetwork ||
  (await fs.readFile(path.join(config.root, ".fault-simulator-owned"), "utf8")) !==
    "rdsh-fault-simulator-v1\n"
)
  throw new Error("Missing isolated simulator ownership marker");
const trace = path.join(config.root, "mock-cli.jsonl");
const checks = [];
const { events, observe, journalFailure, clock, runtime_observations } = createFaultTrace(config.seed);
const verify = (name, actual, expected) =>
  checks.push({ name, expected, actual, passed: isDeepStrictEqual(actual, expected) });
const id = (label) => {
  const value = createHash("sha256")
    .update(`${config.seed}:${config.scenario}:${label}`).digest("hex").slice(0, 32);
  return "cmd_" + [value.slice(0, 8), value.slice(8, 12), value.slice(12, 16),
    value.slice(16, 20), value.slice(20)].join("-");
};
const rows = async () => (await fs.readFile(trace, "utf8").catch(() => ""))
  .split("\n").filter(Boolean).map(JSON.parse);
const effects = async () => (await rows()).filter((r) => r.type === "effect").length;
const project = await identity(path.join(config.root, "project"));
project.directory = path.join(config.root, "state");
const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|TEMP|TMP|COMSPEC|LANG|LC_ALL)$/i.test(key))),
  HOME: config.root,
  USERPROFILE: config.root,
  DSH_HOME: path.join(config.root, "dsh"),
  RDSH_DASHBOARD_HOME: path.join(config.root, "home"),
  GIT_CEILING_DIRECTORIES: config.root,
  RDSH_FAULT_ISOLATED: "1",
  RDSH_FAULT_SCENARIO: config.scenario,
  RDSH_FAULT_TRACE: trace,
};
const fixture = fileURLToPath(new URL("./fault-simulator-cli.mjs", import.meta.url));
let attached = null, peer = null, diskArmed = false;
const open = fs.open;
const safeCode = (failure) => /^[a-zA-Z0-9_]{1,100}$/.test(failure?.code || "")
  ? failure.code : "simulator_operation_failed";
verify("provider credentials, proxies and Node loaders are not inherited",
  Object.keys(process.env).some((key) => /KEY|TOKEN|PASSWORD|SECRET|PROXY|^NODE_OPTIONS$/i.test(key)), false);
let facts = {}, failure = null;
try {
  if (config.recovery) {
    const history = await RunHistory.open(config.recovery.project);
    const before = await fs.readFile(history.file);
    const count = await effects();
    const first = await history.inspect(config.recovery.run_id);
    const second = await history.inspect(config.recovery.run_id);
    const command = first.commands.find((c) => c.command_id === id("send"));
    verify("one committed mock effect", count, 1);
    verify("lost native result remains unknown", command.recovery_outcome, "unknown");
    verify("no invented native ack", command.ack_id, null);
    verify("reads never replay commands", second.recovery.replayed_commands, 0);
    verify("reads never restart CLI", second.recovery.automatically_restarted, false);
    verify("reads leave effects unchanged", await effects(), count);
    verify("reads leave journal unchanged", (await fs.readFile(history.file)).equals(before), true);
    verify("lost scope authority is not reconstructed", second.scope_observation.stop_authority, false);
    verify("lost empty-group proof remains unconfirmed", second.scope_observation.status, "unverifiable");
    facts = { native_effects: count, ack: false, recorded_state: second.recorded_state,
      effective_state: second.state, resource_release: "unconfirmed", automatically_restarted: false };
    observe("read_only_recovery", facts);
  } else if (config.scenario === "network_disconnect") {
    peer = spawn(process.execPath, [fixture, "--fixture-http"], {
      cwd: config.root, env, windowsHide: true,
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    peer.stderr.resume();
    const [ready] = await once(peer, "message");
    if (ready.type !== "ready" || !Number.isInteger(ready.port)) throw new Error();
    const base = `http://127.0.0.1:${ready.port}`;
    const history = await RetryHistory.open(project);
    const scope = createHash("sha256").update("fixed-loopback-mock-effect").digest("hex");
    let queries = 0;
    const options = {
      history, kind: "external_send", scope_digest: scope,
      authorize: async () => ({ allowed: true, scope_digest: scope }),
      now: clock.now,
      wait: clock.wait,
      budget: { max_attempts: 3, total_ms: 10000, base_ms: 10, max_delay_ms: 100 },
      execute: async (context) => {
        observe("mock_send_dispatched");
        try {
          await fetch(base + "/effect", { method: "POST",
            body: JSON.stringify({ operation_id: context.operation_id, scope_digest: scope }),
            signal: AbortSignal.timeout(5000) });
          throw new Error("The configured response loss did not occur");
        } catch (error) {
          if (error.message === "The configured response loss did not occur") throw error;
          observe("tcp_response_lost");
          throw new RetryFailure("unavailable");
        }
      },
      reconcile: async (context) => {
        queries++;
        const receipt = await (await fetch(base + "/receipt", {
          signal: AbortSignal.timeout(5000) })).json();
        if (receipt.operation_id !== context.operation_id || receipt.scope_digest !== scope)
          throw new Error("Wrong mock receipt");
        observe("authoritative_mock_receipt_read");
        return { operation_id: context.operation_id, scope_digest: scope,
          outcome: receipt.outcome, source: "authoritative_operation_status",
          evidence_id: "loopback-fixture-receipt", observed_at: new Date().toISOString() };
      },
    };
    const result = await runWithRetry(options);
    verify("response was physically lost", (await rows()).some((r) => r.type === "network_disconnect"), true);
    verify("one external mock effect", await effects(), 1);
    verify("no second dispatch", result.attempts, 1);
    verify("exact receipt reconciliation", result.certainty, "reconciled_applied");
    verify("reconciled result", result.status, "completed");
    const replay = await runWithRetry({ ...options, operation_id: result.operation_id });
    verify("same operation reuses saved result", replay.reused_operation, true);
    verify("recovery never re-queries or sends", queries, 1);
    verify("recovery leaves side effect count unchanged", await effects(), 1);
    facts = { native_effects: 1, attempts: result.attempts, certainty: result.certainty,
      retry_state: result.status, ack: "authoritative_mock_receipt", resource_release: "pending_listener_close" };
  } else {
    const ledger = await SessionLedger.open(project);
    attached = await attachRecordedSession({ ledger, command: [process.execPath, fixture],
      env, requestTimeout: config.scenario === "restart" ? 30000 : 5000, stopTimeout: 300 });
    const { adapter, history, record } = attached;
    observe("native_session_attached");
    // ENOSPC is injected into the real journal write/fsync, in this worker only.
    fs.open = async (...args) => {
      const handle = await open(...args);
      if (path.resolve(String(args[0])) === history.file && args[1] === "a") {
        const method = config.seed % 2 === 0 ? "write" : "sync";
        const original = handle[method].bind(handle);
        handle[method] = async (...values) => {
          if (!diskArmed) return original(...values);
          journalFailure(method);
          throw Object.assign(new Error("Simulated full journal device"), { code: "ENOSPC" });
        };
      }
      return handle;
    };
    if (config.scenario === "restart") {
      adapter.on("event", (event) => {
        if (event.type !== "session_update" ||
            event.update?.content?.text !== "fault-effect-committed") return;
        process.send({ type: "restart_checkpoint", run_id: record.run_id,
          project, root_pid: adapter.child.pid,
          root_identity: adapter.ownedScope.descriptor.root_identity });
      });
      await adapter.send(record.cli_session_id, "fixed simulator effect", { command_id: id("send") });
      throw new Error("The parent did not stop at the restart checkpoint");
    }
    if (config.scenario === "out_of_order") {
      const later = await history.recordCommand(record.run_id, "send", id("later"));
      const before = await fs.readFile(history.file);
      let rejected;
      try { await history.commandPhase(later, "acknowledged", "prompt_result_received"); }
      catch (error) { rejected = safeCode(error); }
      verify("ack before dispatch is rejected", rejected, "invalid_history");
      verify("rejected ack does not change committed history", (await fs.readFile(history.file)).equals(before), true);
      observe("out_of_order_ack_rejected");
    }
    diskArmed = config.scenario === "disk_full";
    let sent, sendError;
    try {
      sent = await adapter.send(record.cli_session_id, "fixed simulator effect", { command_id: id("send") });
    } catch (error) { sendError = safeCode(error); }
    if (config.scenario === "duplicate_events") {
      let duplicate;
      try { await adapter.send(record.cli_session_id, "fixed simulator effect", { command_id: id("send") }); }
      catch (error) { duplicate = safeCode(error); }
      verify("same command never dispatches twice", duplicate, "duplicate_command");
      verify("duplicate peer event was injected", (await rows()).filter((r) => r.type === "duplicate_event").length, 2);
      observe("duplicate_command_rejected");
    }
    const observed = await history.inspect(record.run_id);
    const command = observed.commands.find((c) => c.command_id === id("send"));
    const acknowledgements = observed.commands.filter((c) => c.operation === "send" && c.ack_id !== null).length;
    const live = await adapter.ownedScope.inspect();
    if (config.scenario === "disk_full") {
      verify("journal ENOSPC was injected", events.some((e) => e.event === "injected_ENOSPC"), true);
      verify("no persisted-success response", sent === undefined, true);
      verify("write failure is returned", sendError, "history_write_failed");
      verify("no native effect before durable dispatch", await effects(), 0);
      verify("no fabricated native ack", acknowledgements, 0);
    } else if (config.scenario === "gpu_loss") {
      verify("GPU disappearance came from mock peer", (await rows()).some((r) => r.type === "mock_gpu_lost"), true);
      verify("native failure remains unknown", command.phase, "unknown");
      verify("GPU failure is not task completion", observed.recorded_state, "unknown");
      verify("no native success ack", acknowledgements, 0);
      verify("lost mock device grants no new effect", await effects(), 0);
      verify("GPU loss leaves the owned process running", live.status, "running");
      verify("GPU loss has no empty-group proof", live.confirmed, false);
      verify("GPU loss retains real process membership", live.remaining_count > 0, true);
    } else {
      verify("one native mock effect", await effects(), 1);
      verify("one native command ack", acknowledgements, 1);
      verify("prompt response preserves waiting-human", observed.recorded_state, "waiting-human");
    }
    facts = { native_effects: await effects(), ack: acknowledgements > 0,
      recorded_state: observed.recorded_state, effective_state: observed.state,
      send_error: sendError || null, durable_save: diskArmed ? "unconfirmed" : "confirmed",
      resource_release_before_stop: live.resources_released ?? "unconfirmed",
      remaining_count_before_stop: live.remaining_count };
    observe("control_result_observed", facts);
  }
} catch (error) {
  failure = { phase: events.at(-1)?.event || "setup", code: safeCode(error) };
} finally {
  if (attached) {
    let stopped, stopError;
    try { stopped = await attached.adapter.stop(); }
    catch (error) { stopped = error.process_result; stopError = safeCode(error); }
    verify("owned group stop confirmed", stopped?.confirmed, true);
    verify("owned group resources released", stopped?.scope?.resources_released, true);
    if (diskArmed)
      verify("owned cleanup preserves persistence uncertainty", stopError, "history_unconfirmed_after_owned_stop");
    facts.resource_release_after_stop = stopped?.scope?.resources_released ?? false;
    observe("owned_stop_observed", { confirmed: stopped?.confirmed ?? false, history_error: stopError || null });
  }
  diskArmed = false;
  fs.open = open;
  if (peer) {
    const closed = once(peer, "close");
    peer.send({ type: "stop" });
    const [reply] = await once(peer, "message");
    await closed;
    verify("loopback listener closed", reply.type, "listener_closed");
    facts.resource_release = "confirmed_listener_closed";
  }
}
const result = { scenario: config.scenario, seed: config.seed, passed: !failure && checks.every((c) => c.passed),
  failure, checks, facts, events, runtime_observations, network: globalThis.rdshFaultNetwork };
await new Promise((resolve) => process.send({ type: "result", result }, resolve));
process.disconnect();
