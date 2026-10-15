import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { identity, ProjectStore, publicState } from "../state.mjs";
import { startDashboard } from "../server.mjs";
import { costRequest } from "../cost-client.mjs";
import { executeTool, tools } from "../mcp.mjs";
import { costScope, costReport } from "./fixtures/cost-report.mjs";
const exec = promisify(execFile);
const cli = fileURLToPath(new URL("../cli.mjs", import.meta.url));
async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rdsh-cost-test-"));
  const cwd = path.join(root, "project");
  await fs.mkdir(cwd);
  const project = await identity(cwd);
  project.directory = path.join(root, "state", "projects", project.id);
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("rdsh-cost-test-"));
    await fs.rm(root, { recursive: true });
  });
  return { root, project, store: await ProjectStore.open(project) };
}
const view = (store) => publicState(store.value).cost_ledger.scopes[0];
const group = (
  store,
  source = "provider_usage",
  currency = "USD",
  level = "targets",
) =>
  view(store).groups.find(
    (group) =>
      group.source_kind === source &&
      group.currency === currency &&
      group.level === level,
  );
async function freePort() {
  const socket = net.createServer();
  await new Promise((resolve) => socket.listen(0, "127.0.0.1", resolve));
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  return port;
}

test("two independent workers sum exactly; identical IDs, reordered JSON and repeated cumulative reports never add", async (t) => {
  const { store, project } = await setup(t);
  await store.mutate("metrics", {
    total_cost_usd: 8.7,
    cost_scope: costScope(project.id),
  });
  const first = costReport();
  await store.mutate("metrics", {
    cost_scope: costScope(project.id, {
      targets: costScope(project.id).targets.reverse(),
    }),
  });
  await store.mutate("metrics", { cost_report: first });
  await store.mutate("metrics", {
    cost_report: Object.fromEntries(Object.entries(first).reverse()),
  });
  await store.mutate("metrics", {
    cost_report: costReport({
      event_id: "meter-reported-again",
      amount: "0.100000000",
    }),
  });
  await store.mutate("metrics", {
    cost_report: costReport({
      event_id: "usage-2",
      target_id: "target-2",
      amount: "0.2",
    }),
  });
  await store.mutate("metrics", {
    cost_report: costReport({
      event_id: "unchanged-new-snapshot",
      sequence: 2,
      observed_at: "2026-10-06T02:00:00Z",
    }),
  });
  assert.equal(group(store).amount, "0.3");
  assert.equal(group(store).included_reports, 2);
  assert.equal(group(store).tokens.input.value, "20");
  assert.equal(group(store).partial, false);
  assert.equal(store.value.metrics.total_cost_usd, 8.7);
  const before = JSON.stringify(store.value);
  await assert.rejects(
    store.mutate("metrics", { cost_report: { ...first, amount: "9" } }),
    /event ID/,
  );
  await assert.rejects(
    store.mutate("metrics", {
      cost_report: {
        ...first,
        event_id: "duplicate-native-observation",
        amount: "9",
      },
    }),
    /sequence/,
  );
  assert.equal(JSON.stringify(store.value), before);
  const reloaded = await ProjectStore.open(project);
  assert.equal(group(reloaded).amount, "0.3");
  assert.equal(
    view(reloaded).reports.filter((report) => report.included).length,
    2,
  );
});

test("out-of-order cumulative snapshots replace earlier totals; decreasing/reset counters and mixed deltas fail", async (t) => {
  const { store, project } = await setup(t);
  await store.mutate("metrics", { cost_scope: costScope(project.id) });
  await store.mutate("metrics", {
    cost_report: costReport({
      event_id: "latest",
      sequence: 3,
      amount: "0.3",
      observed_at: "2026-10-06T03:00:00Z",
    }),
  });
  await store.mutate("metrics", { cost_report: costReport() });
  await store.mutate("metrics", {
    cost_report: costReport({
      event_id: "middle",
      sequence: 2,
      amount: "0.2",
      observed_at: "2026-10-06T02:00:00Z",
    }),
  });
  assert.equal(group(store).amount, "0.3");
  assert.equal(group(store).included_reports, 1);
  for (const patch of [
    { amount: "0.01" },
    { tokens: { input: 1, cached_input: 0, output: 0 } },
    { currency: "JPY" },
    { mode: "event" },
    { observed_at: "2026-10-06T00:30:00Z" },
  ])
    await assert.rejects(
      store.mutate("metrics", {
        cost_report: costReport({
          event_id: "bad-reset",
          sequence: 4,
          observed_at: "2026-10-06T04:00:00Z",
          ...patch,
        }),
      }),
    );
  assert.equal(group(store).amount, "0.3");
  await store.mutate("metrics", {
    cost_report: costReport({
      event_id: "latest-unavailable",
      sequence: 4,
      amount: null,
      certainty: "unknown",
      observed_at: "2026-10-06T04:00:00Z",
    }),
  });
  assert.equal(group(store).amount, null);
  assert.equal(group(store).certainty, "unknown");
  assert.equal(
    view(store).reports.find((report) => report.event_id === "middle").included,
    false,
  );
});

test("provider, CLI, explicit estimate and a different invoice retain separate amounts, references and period", async (t) => {
  const { store, project } = await setup(t);
  await store.mutate("metrics", { cost_scope: costScope(project.id) });
  for (const [kind, amount, certainty] of [
    ["provider_usage", "0.1", "reported"],
    ["cli_report", "0.12", "reported"],
    ["api_estimate", "0.15", "estimated"],
    ["invoice_actual", "0.09", "confirmed"],
  ])
    for (let worker = 1; worker <= 2; worker++)
      await store.mutate("metrics", {
        cost_report: costReport({
          event_id: `${kind}-${worker}`,
          target_id: `target-${worker}`,
          source_kind: kind,
          amount,
          certainty,
          source_ref: `${kind}-statement`,
          basis:
            kind === "api_estimate"
              ? "Fixture declared rate USD 0.015 per reported token; not a current price."
              : "Fixture external statement; no reconciliation.",
        }),
      });
  assert.equal(group(store).amount, "0.2");
  assert.equal(group(store, "cli_report").amount, "0.24");
  assert.equal(group(store, "api_estimate").amount, "0.3");
  assert.equal(group(store, "invoice_actual").amount, "0.18");
  assert.equal(view(store).period_start, "2026-10-06T00:00:00.000Z");
  assert.equal(view(store).period_end, "2026-10-07T00:00:00.000Z");
  assert.equal(
    view(store).reports.find(
      (report) => report.source_kind === "invoice_actual",
    ).source_ref,
    "invoice_actual-statement",
  );
  await store.mutate("metrics", {
    cost_report: costReport({
      event_id: "invoice-total",
      target_id: null,
      source_kind: "invoice_actual",
      amount: "0.17",
      certainty: "confirmed",
      currency: "JPY",
    }),
  });
  assert.equal(
    group(store, "invoice_actual", "JPY", "project_invoice").amount,
    "0.17",
  );
  assert.equal(group(store, "invoice_actual").amount, "0.18");
});

test("missing workers and unknown amounts stay partial; unknown population and mixed currencies cannot become a full total", async (t) => {
  const { store, project } = await setup(t);
  await store.mutate("metrics", { cost_scope: costScope(project.id) });
  await store.mutate("metrics", { cost_report: costReport() });
  assert.equal(group(store).partial, true);
  assert.deepEqual(group(store).missing_targets, ["target-2"]);
  await store.mutate("metrics", {
    cost_report: costReport({
      event_id: "missing-cost",
      target_id: "target-2",
      amount: null,
      certainty: "unknown",
      tokens: null,
    }),
  });
  assert.equal(group(store).amount, "0.1");
  assert.deepEqual(group(store).covered_targets, ["target-1"]);
  assert.deepEqual(view(store).unreported_sources, [
    "cli_report",
    "api_estimate",
    "invoice_actual",
  ]);
  await store.mutate("metrics", {
    cost_scope: costScope(project.id, {
      scope_id: "undeclared-population",
      membership_complete: false,
    }),
  });
  for (const worker of [1, 2])
    await store.mutate("metrics", {
      cost_report: costReport({
        scope_id: "undeclared-population",
        event_id: `population-${worker}`,
        target_id: `target-${worker}`,
        currency: worker === 1 ? "USD" : "JPY",
      }),
    });
  const latest = publicState(store.value).cost_ledger.scopes.find(
    (scope) => scope.scope_id === "undeclared-population",
  );
  assert.equal(latest.groups.length, 2);
  assert.ok(
    latest.groups.every(
      (group) => group.partial && group.missing_targets.length === 1,
    ),
  );
});

test("independent event sequences add once; an unknown event in a worker keeps its subtotal partial", async (t) => {
  const { store, project } = await setup(t);
  await store.mutate("metrics", { cost_scope: costScope(project.id) });
  for (const sequence of [1, 2])
    await store.mutate("metrics", {
      cost_report: costReport({
        event_id: `request-${sequence}`,
        mode: "event",
        sequence,
        amount: "0.000000001",
      }),
    });
  await store.mutate("metrics", {
    cost_report: costReport({
      event_id: "request-again",
      mode: "event",
      sequence: 2,
      amount: "0.000000001",
    }),
  });
  assert.equal(group(store).amount, "0.000000002");
  await store.mutate("metrics", {
    cost_report: costReport({
      event_id: "unknown-event",
      mode: "event",
      sequence: 3,
      amount: null,
      certainty: "unknown",
    }),
  });
  assert.equal(group(store).amount, "0.000000002");
  assert.equal(group(store).partial, true);
  assert.deepEqual(group(store).missing_targets, ["target-1", "target-2"]);
  assert.deepEqual(group(store).covered_targets, []);
});

test("scope identity, source certainty, dates and malformed persisted ledger fail without rewriting evidence", async (t) => {
  const { store, project } = await setup(t);
  assert.equal(publicState(store.value).cost_ledger, undefined);
  await store.mutate("metrics", { cost_scope: costScope(project.id) });
  await assert.rejects(
    store.mutate("metrics", {
      cost_scope: costScope(project.id, { project_id: "another-project" }),
    }),
    /another project/,
  );
  await assert.rejects(
    store.mutate("metrics", {
      cost_scope: costScope(project.id, { membership_complete: false }),
    }),
    /immutable/,
  );
  for (const patch of [
    { amount: 0.1 },
    { amount: "-1" },
    { amount: "1e-9" },
    { amount: "0.1234567891" },
    { certainty: "confirmed" },
    { target_id: "missing" },
    { event_id: "__proto__" },
    { observed_at: "2026-02-30T01:00:00Z" },
    { observed_at: "2026-10-06T01:00:00+00:00" },
    { tokens: { input: 1, cached_input: 2, output: null } },
    { source_kind: "api_estimate", certainty: "estimated", basis: "" },
    { unexpected: true },
  ])
    await assert.rejects(
      store.mutate("metrics", { cost_report: costReport(patch) }),
    );
  await store.mutate("metrics", { cost_report: costReport() });
  const corrupted = structuredClone(store.value);
  corrupted.cost_ledger.reports["usage-1"].amount = "-5";
  const file = path.join(project.directory, "state.json"),
    bytes = JSON.stringify(corrupted);
  await fs.writeFile(file, bytes);
  await assert.rejects(ProjectStore.open(project), /Cost ledger/);
  assert.equal(await fs.readFile(file, "utf8"), bytes);
});

test("existing MCP metrics tool records ledger reports; old metrics and exactly six tool names remain compatible", async (t) => {
  const { store, project } = await setup(t);
  const api = {
    mutate: (...args) => store.mutate(...args),
    getState: async () => publicState(store.value),
  };
  const result = await executeTool(api, "dashboard_update_metrics", {
    cost_scope: costScope(project.id),
    cost_report: costReport(),
    model_calls: 3,
  });
  assert.equal(result.project, project.id);
  assert.equal(
    (await executeTool(api, "dashboard_get_state")).metrics.model_calls,
    3,
  );
  assert.equal(group(store).amount, "0.1");
  assert.equal(tools.length, 6);
  assert.ok(
    tools.find((tool) => tool.name === "dashboard_update_metrics").inputSchema
      .properties.cost_report,
  );
});

test("HTTP parallel worker reports, lost response retry, browser read-only and public CLI share one durable ledger", async (t) => {
  const f = await setup(t),
    dashboard = await startDashboard({
      project: f.project,
      port: await freePort(),
      tailscale: false,
    });
  t.after(() => dashboard.close());
  const runtime = JSON.parse(
    await fs.readFile(path.join(f.project.directory, "runtime.json"), "utf8"),
  );
  const human = {
    "x-rdsh-browser-token": new URL(runtime.browser_url).hash.slice(5),
  };
  const file = path.join(f.root, "input.json"),
    env = { ...process.env, RDSH_DASHBOARD_HOME: path.join(f.root, "state") };
  const run = async (action, input) => {
    if (input) await fs.writeFile(file, JSON.stringify(input));
    const { stdout } = await exec(
      process.execPath,
      [
        cli,
        "cost-ledger",
        action,
        "--project",
        f.project.root,
        ...(input ? ["--input-file", file] : []),
      ],
      { env },
    );
    return JSON.parse(stdout);
  };
  await run("declare", costScope(f.project.id));
  const lost = async (url, options) => {
    const response = await fetch(url, options);
    assert.equal(response.status, 200);
    await response.json();
    throw new Error("fixture lost response after commit");
  };
  await assert.rejects(
    costRequest(f.project, "report", costReport(), lost),
    /lost response/,
  );
  await Promise.all([
    costRequest(f.project, "report", costReport()),
    costRequest(
      f.project,
      "report",
      costReport({
        event_id: "worker-two",
        target_id: "target-2",
        amount: "0.2",
      }),
    ),
  ]);
  const report = await run("inspect");
  assert.equal(report.cost_ledger.scopes[0].groups[0].amount, "0.3");
  assert.equal(report.cost_ledger.scopes[0].reports.length, 2);
  assert.equal(
    (await fetch(dashboard.localUrl + "api/state", { headers: human })).status,
    200,
  );
  assert.equal(
    (
      await fetch(dashboard.localUrl + "api/update/metrics", {
        method: "POST",
        headers: { ...human, "content-type": "application/json" },
        body: JSON.stringify({ cost_report: costReport() }),
      })
    ).status,
    403,
  );
  assert.equal((await fetch(dashboard.localUrl + "api/state")).status, 401);
  assert.equal(
    (await fetch(dashboard.localUrl + "cost-ledger-ui.mjs")).status,
    200,
  );
  assert.equal(
    (await fs.readdir(f.project.directory)).includes("session-ledger.json"),
    false,
  );
  runtime.local_url = "https://billing.example/";
  await fs.writeFile(
    path.join(f.project.directory, "runtime.json"),
    JSON.stringify(runtime),
  );
  await assert.rejects(
    costRequest(f.project, "report", costReport(), () =>
      assert.fail("must not fetch external URL"),
    ),
    /loopback/,
  );
});
