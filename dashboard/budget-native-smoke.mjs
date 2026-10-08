#!/usr/bin/env node
// Explicit, isolated QA only: native installed DSH + a local model adapter fixture.
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseArgs } from "node:util";
import { identity } from "./state.mjs";
import { startDashboard } from "./server.mjs";
import { budgetRequest } from "./budget-client.mjs";
import { SessionLedger, attachRecordedSession } from "./session-ledger.mjs";
import { createBudgetHook } from "../plugins/rdsh-budget-guard/index.js";
import { budgetPolicy } from "./test/fixtures/budget-policy.mjs";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
const { values } = parseArgs({
  options: { entrypoint: { type: "string" }, modules: { type: "string" } },
});
if (
  !values.entrypoint ||
  !values.modules ||
  !path.isAbsolute(values.entrypoint) ||
  !path.isAbsolute(values.modules)
)
  throw new Error(
    "Specify --entrypoint and --modules for the installed native DSH",
  );
const load = (name) =>
  import(
    pathToFileURL(
      path.join(values.modules, "@deepseek-ai", name, "lib/index.js"),
    ).href
  );
const [{ Context }, { LlmRuntime, LlmAdapter }] = await Promise.all([
  load("cordis"),
  load("dsh-llm"),
]);
const packageInfo = JSON.parse(
  await fs.readFile(
    path.join(path.dirname(values.entrypoint), "../package.json"),
    "utf8",
  ),
);
assert.equal(packageInfo.version, "0.2.0-rc.2");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "rdsh-budget-native-"));
let dashboard;
const exec = promisify(execFile);
try {
  const cwd = path.join(root, "project");
  await fs.mkdir(cwd);
  await exec("git", ["-C", cwd, "init", "-b", "budget-native-qa"]);
  await exec("git", [
    "-C",
    cwd,
    "-c",
    "user.name=Budget QA",
    "-c",
    "user.email=budget@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--allow-empty",
    "-m",
    "fixture",
  ]);
  const project = await identity(cwd);
  project.directory = path.join(root, "state");
  const socket = net.createServer();
  await new Promise((r) => socket.listen(0, "127.0.0.1", r));
  const port = socket.address().port;
  await new Promise((r) => socket.close(r));
  dashboard = await startDashboard({ project, port, tailscale: false });
  const p = budgetPolicy({
    baseline: "0",
    soft_limit: "0.3",
    hard_limit: "0.3",
  });
  await budgetRequest(project, "policy", p);
  const env = {
    ...process.env,
    HOME: root,
    USERPROFILE: root,
    DSH_HOME: path.join(root, "dsh"),
    XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_DATA_HOME: path.join(root, "data"),
    APPDATA: path.join(root, "data"),
    LOCALAPPDATA: path.join(root, "local"),
  };
  const ledger = await SessionLedger.open(project);
  const attached = await attachRecordedSession({
    ledger,
    command: [process.execPath, values.entrypoint],
    env,
    budget: { worker_id: "native-acp-bootstrap" },
    requestTimeout: 30000,
  });
  assert.equal(
    attached.adapter.capabilities().budget_enforcement.supported,
    true,
  );
  const nativeAttachment = {
    cli_version: attached.record.cli_version,
    session_id_from_original_DSH: attached.record.cli_session_id !== null,
    profile_patch_registered: true,
    prompt_sent: false,
  };
  await attached.adapter.stop();
  const runtime = JSON.parse(
    await fs.readFile(path.join(project.directory, "runtime.json"), "utf8"),
  );
  const post = async (route, input) => {
    const response = await fetch(`${dashboard.localUrl}api/budget/${route}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${runtime.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(input),
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  let dispatches = 0;
  const receivedRoutes = [];
  class FixtureAdapter extends LlmAdapter {
    async *stream(options) {
      dispatches++;
      receivedRoutes.push({ provider: options.provider, model: options.model });
      yield { type: "block-start", index: 0, blockType: "text" };
      yield { type: "text-delta", index: 0, text: "fixture" };
      yield {
        type: "block-end",
        index: 0,
        block: { type: "text", text: "fixture" },
      };
      yield {
        type: "usage",
        usage: { inputTokens: 3, cacheReadTokens: 2, outputTokens: 4 },
      };
      yield { type: "finish", reason: { kind: "stop" } };
    }
  }
  const contexts = [];
  for (const worker of [1, 2]) {
    const g = await post("launch", {
      worker_id: `native-worker-${worker}`,
      run_id: `fixture-run-${worker}`,
      cli: "dsh",
      version: packageInfo.version,
    });
    assert.equal(g.allowed, true);
    const ctx = new Context();
    const llm = new LlmRuntime(ctx);
    ctx.on(
      "llm/stream",
      createBudgetHook({
        base: dashboard.localUrl,
        key: g.key,
        job_id: g.job_id,
      }).stream,
      { prepend: true },
    );
    llm.registerAdapter(["fixture-provider"], new FixtureAdapter());
    contexts.push({ ctx, llm });
  }
  const request = Object.freeze({
    provider: "fixture-provider",
    model: "fixture-model",
    sessionId: "fixture-native-session",
    messages: Object.freeze([]),
  });
  const consume = async (llm) => {
    const chunks = [];
    for await (const chunk of llm.stream(request)) chunks.push(chunk);
    assert.equal(chunks.at(-1).reason.kind, "stop");
    return chunks.length;
  };
  const outcomes = await Promise.allSettled(
    contexts.map(({ llm }) => consume(llm)),
  );
  assert.equal(outcomes.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(dispatches, 1);
  const beforeUsage = await budgetRequest(project, "inspect");
  assert.equal(beforeUsage.policies[0].reserved, "0.3");
  const call = beforeUsage.calls[0];
  await post("usage", {
    event_id: "native-fixture-delayed-usage",
    call_id: call.call_id,
    amount: "0.4",
    source_kind: "provider_usage",
    currency: "USD",
    source_ref: "local native-adapter fixture",
    observed_at: new Date().toISOString(),
    basis: "Fixture fee amount; not a real provider charge",
  });
  await assert.rejects(consume(contexts[0].llm), /budget_hard_limit/);
  assert.equal(dispatches, 1);
  const after = await budgetRequest(project, "inspect");
  assert.equal(after.policies[0].overspend, "0.1");
  const noJob = await post("launch", {
    worker_id: "native-worker-3",
    run_id: "fixture-run-3",
    cli: "dsh",
    version: packageInfo.version,
  });
  assert.equal(noJob.allowed, false);
  const enforcementDispatches = dispatches;
  await budgetRequest(project, "policy", {
    ...p,
    expected_revision: 1,
    hard_limit: "100",
    reason: "Fixture administrator raises cap for latency measurement",
  });
  const latencies = [];
  for (let index = 0; index < 10; index++) {
    const started = performance.now();
    await consume(contexts[0].llm);
    latencies.push(performance.now() - started);
    const calls = (await budgetRequest(project, "inspect")).calls;
    const current = calls.at(-1);
    await post("usage", {
      event_id: `latency-fixture-${index}`,
      call_id: current.call_id,
      amount: "0",
      source_kind: "provider_usage",
      currency: "USD",
      source_ref: "zero fee local fixture",
      observed_at: new Date().toISOString(),
      basis: "Local adapter timing fixture; no real provider request",
    });
  }
  const ordered = [...latencies].sort((a, b) => a - b);
  console.log(
    JSON.stringify(
      {
        nativeAttachment,
        native_runtime: "original dsh-llm LlmRuntime + Cordis waterfall",
        concurrent_workers: 2,
        permitted_provider_dispatches: enforcementDispatches,
        denied_model_calls: 2,
        denied_new_jobs: 1,
        receivedRoutes,
        outstanding_before_usage: beforeUsage.policies[0].reserved,
        late_usage_amount: "0.4",
        overspend: after.policies[0].overspend,
        actual_provider_requests: 0,
        price_lookup: "not_performed",
        invoice_verification: "not_performed",
        gate_latency_fixture: {
          count: latencies.length,
          mean_ms: latencies.reduce((a, b) => a + b, 0) / latencies.length,
          median_ms: (ordered[4] + ordered[5]) / 2,
          max_ms: ordered.at(-1),
          samples_ms: latencies,
          scope:
            "original LlmRuntime local chunks + durable admission/finish HTTP; excludes external usage receipt",
        },
      },
      null,
      2,
    ),
  );
} finally {
  await dashboard?.close();
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(root).startsWith("rdsh-budget-native-"));
  await fs.rm(root, { recursive: true });
}
