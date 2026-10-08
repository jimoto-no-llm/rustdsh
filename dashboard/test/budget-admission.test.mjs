import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { identity, ProjectStore, publicState } from "../state.mjs";
import {
  applyBudgetOperation,
  validateBudgetAdmission,
} from "../budget-admission.mjs";
import { startDashboard } from "../server.mjs";
import { SessionLedger, attachRecordedSession } from "../session-ledger.mjs";
import { createCliAdapter } from "../adapters.mjs";
import { createBudgetHook } from "../../plugins/rdsh-budget-guard/index.js";
import { budgetRequest } from "../budget-client.mjs";
import { budgetPolicy } from "./fixtures/budget-policy.mjs";
const exec = promisify(execFile);
const cli = fileURLToPath(new URL("../cli.mjs", import.meta.url));
async function freePort() {
  const socket = net.createServer();
  await new Promise((r) => socket.listen(0, "127.0.0.1", r));
  const port = socket.address().port;
  await new Promise((r) => socket.close(r));
  return port;
}
async function setup(t, server = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rdsh-budget-test-"));
  const cwd = path.join(root, "project");
  await fs.mkdir(cwd);
  const project = await identity(cwd);
  project.directory = path.join(root, "dashboard", "projects", project.id);
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("rdsh-budget-test-"));
    await fs.rm(root, { recursive: true });
  });
  const store = await ProjectStore.open(project);
  if (!server) return { root, project, store };
  const dashboard = await startDashboard({
    project,
    port: await freePort(),
    tailscale: false,
  });
  t.after(() => dashboard.close());
  const runtime = JSON.parse(
    await fs.readFile(path.join(project.directory, "runtime.json"), "utf8"),
  );
  const post = async (
    route,
    input,
    headers = { authorization: `Bearer ${runtime.token}` },
  ) => {
    const response = await fetch(`${dashboard.localUrl}api/budget/${route}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(input),
    });
    return { status: response.status, result: await response.json() };
  };
  const launch = async (worker = "worker-1", run = "run-1") => {
    const { status, result } = await post("launch", {
      worker_id: worker,
      run_id: run,
      cli: "dsh",
      version: "0.2.0-rc.2",
    });
    assert.equal(status, 200);
    assert.equal(result.allowed, true);
    return result;
  };
  return { root, project, store, dashboard, runtime, post, launch };
}
const view = (store) => publicState(store.value).budget_admission;
function localJob(state, jobId = "job-1", runId = "run-1") {
  assert.equal(
    applyBudgetOperation(state, "job", {
      job_id: jobId,
      run_id: runId,
      worker_id: jobId,
    }).allowed,
    true,
  );
  applyBudgetOperation(state, "ready", { job_id: jobId });
}
function call(job_id = "job-1", call_id = randomUUID()) {
  return {
    job_id,
    call_id,
    session_id: "native-session-1",
    provider: "fixture-provider",
    model: "fixture-model",
    purpose: null,
  };
}
const finish = (job_id, call_id) => ({
  job_id,
  call_id,
  outcome: "finished",
  tokens: null,
});
const receipt = (call_id, amount = "0.4", patch = {}) => ({
  event_id: randomUUID(),
  call_id,
  amount,
  source_kind: "provider_usage",
  currency: "USD",
  source_ref: "fixture-meter-only",
  observed_at: new Date().toISOString(),
  basis: "Fixture settled usage; no invoice verified",
  ...patch,
});

test("soft warns without denying; hard and unknown spend reject a new job", async (t) => {
  const { store } = await setup(t);
  const p = budgetPolicy({ baseline: "0.599999999" });
  await store.mutateBudget("policy", p);
  assert.equal(view(store).policies[0].status, "within_budget");
  assert.equal(
    (
      await store.mutateBudget("job", {
        job_id: "job-1",
        run_id: "run-1",
        worker_id: "worker-1",
      })
    ).allowed,
    true,
  );
  const state = { project: store.value.project };
  applyBudgetOperation(state, "policy", budgetPolicy({ baseline: "0.6" }));
  assert.equal(
    applyBudgetOperation(state, "job", {
      job_id: "soft",
      run_id: "r",
      worker_id: "w",
    }).warning,
    true,
  );
  for (const baseline of ["1", null]) {
    const blocked = { project: store.value.project };
    applyBudgetOperation(blocked, "policy", budgetPolicy({ baseline }));
    assert.equal(
      applyBudgetOperation(blocked, "job", {
        job_id: "hard",
        run_id: "r",
        worker_id: "w",
      }).allowed,
      false,
    );
    assert.equal(Object.keys(blocked.budget_admission.jobs).length, 0);
  }
  await assert.rejects(
    store.mutateBudget("policy", { ...p, expected_revision: 1, baseline: "0" }),
    /immutable_conflict/,
  );
  await assert.rejects(
    store.mutateBudget("policy", {
      ...p,
      expected_revision: 0,
      hard_limit: "2",
    }),
    /revision_conflict/,
  );
});

test("project and run policies reserve once each; decimal values, period and source stay exact", async (t) => {
  const { store } = await setup(t);
  const p = budgetPolicy({ baseline: "0", call_reservation: "0.2" });
  await store.mutateBudget("policy", p);
  await store.mutateBudget("policy", {
    ...p,
    policy_id: "run-budget",
    run_id: "run-1",
    call_reservation: "0.8",
  });
  localJob(store.value);
  assert.equal(
    applyBudgetOperation(store.value, "call", call("job-1", "c1")).allowed,
    true,
  );
  assert.deepEqual(
    view(store).policies.map((p) => p.reserved),
    ["0.8", "0.8"],
  );
  assert.equal(
    applyBudgetOperation(store.value, "call", call("job-1", "c2")).allowed,
    false,
  );
  for (const baseline of [0, "NaN", "-1", "0.0000000001"]) {
    await assert.rejects(
      store.mutateBudget("policy", { ...p, policy_id: "bad", baseline }),
      /invalid_amount/,
    );
  }
  await assert.rejects(
    store.mutateBudget("policy", { ...p, policy_id: "__proto__" }),
    /invalid_id/,
  );
  await assert.rejects(
    store.mutateBudget("policy", {
      ...p,
      policy_id: "bad-time",
      period_start: "2026-02-30T00:00:00Z",
    }),
    /invalid_time/,
  );
  const mixed = { project: store.value.project };
  applyBudgetOperation(mixed, "policy", p);
  applyBudgetOperation(mixed, "policy", {
    ...p,
    policy_id: "different-currency",
    run_id: "run-1",
    currency: "JPY",
  });
  assert.equal(
    applyBudgetOperation(mixed, "job", {
      job_id: "no",
      run_id: "run-1",
      worker_id: "w",
    }).reason,
    "budget_accounting_mismatch",
  );
  const expired = { project: store.value.project };
  applyBudgetOperation(expired, "policy", {
    ...p,
    period_start: "2020-01-01T00:00:00Z",
    period_end: "2020-02-01T00:00:00Z",
  });
  assert.equal(
    applyBudgetOperation(expired, "job", {
      job_id: "no",
      run_id: "r",
      worker_id: "w",
    }).reason,
    "budget_period_closed",
  );
});

test("two workers atomically reserve the remaining budget; late usage can exceed hard and never changes routes", async (t) => {
  const f = await setup(t, true);
  await budgetRequest(
    f.project,
    "policy",
    budgetPolicy({
      baseline: "0",
      soft_limit: "0.3",
      hard_limit: "0.3",
      call_reservation: "0.3",
    }),
  );
  const a = await f.launch("worker-1", "run-1"),
    b = await f.launch("worker-2", "run-2");
  let starts = 0;
  const options = Object.freeze({
    provider: "fixture-provider",
    model: "fixture-model",
    sessionId: "native-1",
    messages: Object.freeze([]),
  });
  const hooks = [a, b].map((g) =>
    createBudgetHook({
      base: f.dashboard.localUrl,
      key: g.key,
      job_id: g.job_id,
    }),
  );
  const consume = async (hook) => {
    for await (const chunk of hook.stream(options, async function* () {
      starts++;
      yield {
        type: "usage",
        usage: { inputTokens: 3, cacheReadTokens: 2, outputTokens: 4 },
      };
      yield { type: "finish", reason: { kind: "stop" } };
    }))
      assert.ok(chunk);
  };
  const responses = await Promise.allSettled(hooks.map(consume));
  assert.equal(responses.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(starts, 1);
  assert.equal(options.model, "fixture-model");
  assert.equal(options.provider, "fixture-provider");
  let state = (await f.post("inspect", {})).result;
  assert.equal(state.policies[0].awaiting_usage, 1);
  assert.equal(state.policies[0].reserved, "0.3");
  const item = state.calls[0];
  assert.deepEqual(item.tokens, {
    input: 3,
    cached_input: 2,
    cache_write: null,
    output: 4,
  });
  assert.equal(
    (await f.post("usage", receipt(item.call_id, "0.4"))).status,
    200,
  );
  state = (await f.post("inspect", {})).result;
  assert.equal(state.policies[0].overspend, "0.1");
  assert.equal(state.policies[0].reserved, "0");
  assert.equal(
    (
      await f.post("launch", {
        worker_id: "third",
        run_id: "run-3",
        cli: "dsh",
        version: "0.2.0-rc.2",
      })
    ).result.allowed,
    false,
  );
  await assert.rejects(consume(hooks[0]), /budget_hard_limit/);
  assert.equal(starts, 1);
});

test("lost admission response keeps the charge reservation; no retry, duplicate dispatch or restart release", async (t) => {
  const f = await setup(t, true);
  await budgetRequest(f.project, "policy", budgetPolicy({ baseline: "0" }));
  const g = await f.launch();
  let starts = 0,
    admissionRequests = 0;
  const lost = async (url, options) => {
    const response = await fetch(url, options);
    if (String(url).endsWith("/call")) {
      admissionRequests++;
      await response.text();
      throw new Error("lost admission response");
    }
    return response;
  };
  const hook = createBudgetHook({
    base: f.dashboard.localUrl,
    key: g.key,
    job_id: g.job_id,
    fetchImpl: lost,
  });
  await assert.rejects(async () => {
    for await (const _ of hook.stream(
      { provider: "fixture-provider", model: "fixture-model" },
      async function* () {
        starts++;
        yield {};
      },
    )) {
    }
  }, /lost admission/);
  assert.equal(starts, 0);
  assert.equal(admissionRequests, 1);
  const state = (await f.post("inspect", {})).result;
  assert.equal(state.policies[0].executing, 1);
  assert.equal(state.policies[0].reserved, "0.3");
  const duplicate = await f.post(
    "producer/call",
    call(g.job_id, state.calls[0].call_id),
    { "x-rdsh-budget-token": g.key },
  );
  assert.equal(duplicate.result.allowed, false);
  assert.equal(duplicate.result.reason, "budget_call_replay");
  await f.dashboard.close();
  const store = await ProjectStore.open(f.project);
  assert.equal(view(store).policies[0].reserved, "0.3");
  assert.equal(view(store).jobs[0].enforcement, "unknown");
  const damaged = structuredClone(store.value);
  damaged.budget_admission.calls[state.calls[0].call_id].reservation = "0";
  assert.throws(() => validateBudgetAdmission(damaged), /invalid_audit/);
});

test("only local admin changes policy or settles fees; producer key cannot create jobs or escape its job", async (t) => {
  const f = await setup(t, true),
    p = budgetPolicy();
  for (const headers of [
    { authorization: `Bearer ${f.runtime.mcp_token}` },
    { "x-rdsh-browser-token": new URL(f.runtime.browser_url).hash.slice(5) },
  ]) {
    assert.ok([401, 403].includes((await f.post("policy", p, headers)).status));
  }
  await budgetRequest(f.project, "policy", p);
  assert.equal(
    (
      await f.post("launch", {
        worker_id: "w",
        run_id: "r",
        cli: "codex",
        version: "0.2.0-rc.2",
      })
    ).status,
    400,
  );
  const g = await f.launch();
  const header = { "x-rdsh-budget-token": g.key };
  assert.equal(
    (await f.post("policy", { ...p, hard_limit: "20" }, header)).status,
    401,
  );
  assert.equal(
    (await f.post("producer/call", call(g.job_id), header)).status,
    400,
  );
  await f.post(
    "producer/ready",
    { job_id: g.job_id, hook_version: 1, cli_version: "0.2.0-rc.2" },
    header,
  );
  assert.equal(
    (await f.post("producer/call", call("another-job"), header)).status,
    403,
  );
  assert.equal(
    (
      await f.post(
        "producer/ready",
        { job_id: g.job_id, hook_version: 1, cli_version: "0.2.0-rc.2" },
        header,
      )
    ).status,
    409,
  );
  await f.post("revoke", { job_id: g.job_id });
  assert.equal(
    (await f.post("producer/call", call(g.job_id), header)).status,
    403,
  );
  assert.equal(
    createCliAdapter({ cli: "codex" }).capabilities().budget_enforcement
      .supported,
    false,
  );
  assert.equal(
    createCliAdapter().capabilities().budget_enforcement.supported,
    false,
  );
});

test("unknown receipt retains reservation; receipts are idempotent and cannot change source or completed money", async (t) => {
  const { store, project } = await setup(t);
  await store.mutateBudget("policy", budgetPolicy());
  localJob(store.value);
  const c = call("job-1", "c1");
  applyBudgetOperation(store.value, "call", c);
  await assert.rejects(
    store.mutateBudget("usage", receipt(c.call_id)),
    /not_finished/,
  );
  await store.mutateBudget("finish", finish("job-1", "c1"));
  const unknown = receipt("c1", null);
  await store.mutateBudget("usage", unknown);
  assert.equal(view(store).policies[0].reserved, "0.3");
  await assert.rejects(
    store.mutateBudget("policy", {
      ...budgetPolicy(),
      ...store.value.budget_admission.operations[0].input,
      expected_revision: 1,
      active: false,
    }),
    /unconfirmed_calls_conflict/,
  );
  const known = receipt("c1", "0.4");
  await store.mutateBudget("usage", known);
  await store.mutateBudget("usage", known);
  assert.equal(view(store).policies[0].spent, "0.7");
  assert.equal(view(store).policies[0].reserved, "0");
  await assert.rejects(
    store.mutateBudget("usage", { ...known, amount: "0.5" }),
    /receipt_conflict/,
  );
  await assert.rejects(
    store.mutateBudget("usage", receipt("c1", "0.2")),
    /settlement_conflict/,
  );
  await assert.rejects(
    store.mutateBudget("usage", receipt("c1", "0.4", { currency: "JPY" })),
    /context_conflict/,
  );
  assert.equal(view(await ProjectStore.open(project)).policies[0].spent, "0.7");
});

test("real CLI input-file policy/inspect uses admin credential and rejects stray enforcement flags", async (t) => {
  const f = await setup(t, true),
    input = path.join(f.root, "policy.json");
  await fs.writeFile(input, JSON.stringify(budgetPolicy()));
  const env = {
    ...process.env,
    RDSH_DASHBOARD_HOME: path.join(f.root, "dashboard"),
  };
  await exec(
    process.execPath,
    [
      cli,
      "budget",
      "policy",
      "--project",
      f.project.root,
      "--input-file",
      input,
    ],
    { env },
  );
  const { stdout } = await exec(
    process.execPath,
    [cli, "budget", "inspect", "--project", f.project.root],
    { env },
  );
  assert.equal(JSON.parse(stdout).policies[0].effective, "0.3");
  await assert.rejects(
    exec(
      process.execPath,
      [cli, "adapters", "--budget-guard", "--worker-id", "w"],
      { env },
    ),
    /Budget enforcement requires/,
  );
});

test("guarded attachment verifies hook, scopes cleanup, and rejects hard job before native session starts", async (t) => {
  const f = await setup(t, true);
  await exec("git", ["-C", f.project.root, "init", "-b", "budget-fixture"]);
  await exec("git", [
    "-C",
    f.project.root,
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
  const p = budgetPolicy();
  await budgetRequest(f.project, "policy", p);
  const env = {
    ...process.env,
    HOME: f.root,
    USERPROFILE: f.root,
    DSH_HOME: path.join(f.root, "dsh"),
    RDSH_ADAPTER_FIXTURE_TRACE: path.join(f.root, "trace.jsonl"),
  };
  const ledger = await SessionLedger.open(f.project);
  const command = [
    process.execPath,
    fileURLToPath(new URL("./fixtures/budget-acp-cli.mjs", import.meta.url)),
  ];
  const attached = await attachRecordedSession({
    ledger,
    command,
    env,
    budget: { worker_id: "worker-1" },
  });
  assert.equal(
    attached.adapter.capabilities().budget_enforcement.supported,
    true,
  );
  await attached.adapter.stop();
  assert.equal(
    (await f.post("inspect", {})).result.jobs[0].enforcement,
    "stopped",
  );
  assert.equal(
    (await fs.readdir(f.project.directory)).some((name) =>
      name.endsWith(".patch.yml"),
    ),
    false,
  );
  const trace = await fs.readFile(path.join(f.root, "trace.jsonl"), "utf8");
  await budgetRequest(f.project, "policy", {
    ...p,
    expected_revision: 1,
    hard_limit: "0.3",
    soft_limit: "0.3",
    reason: "Fixture operator lowers cap",
  });
  await assert.rejects(
    attachRecordedSession({
      ledger,
      command,
      env,
      budget: { worker_id: "worker-2" },
    }),
    /New job blocked/,
  );
  assert.equal(
    await fs.readFile(path.join(f.root, "trace.jsonl"), "utf8"),
    trace,
  );
});
