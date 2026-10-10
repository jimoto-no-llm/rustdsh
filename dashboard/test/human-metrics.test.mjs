import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import {
  HumanMetricsStore,
  compareHumanMetricSamples,
  summarizeHumanMetrics,
} from "../human-metrics.mjs";
import { ProjectStore } from "../state.mjs";
import { startDashboard } from "../server.mjs";

const iso = (milliseconds) => new Date(milliseconds).toISOString();
async function temporaryProject(t, prefix) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const projectRoot = path.join(directory, "project");
  const stateDirectory = path.join(directory, "state");
  await fs.mkdir(projectRoot);
  const project = {
    id: "human-metrics-fixture",
    root: projectRoot,
    name: "fixture",
    directory: stateDirectory,
  };
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith(prefix));
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { directory, project, projectRoot };
}
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test("known-time records calculate five distinct metrics and retain no source identifiers", async (t) => {
  const { project } = await temporaryProject(t, "rdsh-human-metrics-");
  const store = await HumanMetricsStore.open(project);
  const state = {
    questions: [
      { id: "question-id-secret", question: "PRIVATE QUESTION BODY", answer: null },
    ],
    tasks: [{ id: "task-id-secret", status: "blocked" }],
    instructions: {
      requests: {
        "command-id-secret": {
          command_id: "command-id-secret",
          text: "PRIVATE INSTRUCTION BODY",
          created_at: "2026-04-01T00:00:00.000Z",
        },
      },
    },
  };
  const start = Date.parse("2026-04-01T00:00:00.000Z");
  assert.equal(store.snapshot(start).question_recurrence.count, null);
  await assert.rejects(
    store.handle(
      { action: "mark_question_recurrence", question_id: "question-id-secret" },
      state,
      start,
    ),
    /disabled/,
  );
  await store.handle(
    { action: "configure", enabled: true, retention_days: 7 },
    state,
    start,
  );
  await store.handle(
    { action: "start_decision_timer", question_id: "question-id-secret" },
    state,
    start + 1_000,
  );
  await store.handle({ action: "pause_timer" }, state, start + 61_000);
  await store.handle({ action: "resume_timer" }, state, start + 3_601_000);
  await store.handle({ action: "finish_timer" }, state, start + 3_631_000);
  await store.handle(
    { action: "mark_question_recurrence", question_id: "question-id-secret" },
    state,
    start + 3_632_000,
  );
  await store.handle(
    { action: "mark_instruction_resend", command_id: "command-id-secret" },
    state,
    start + 3_633_000,
  );
  await store.handle(
    { action: "start_recovery_timer", task_id: "task-id-secret" },
    state,
    start + 7_200_000,
  );
  await store.handle({ action: "finish_timer" }, state, start + 7_500_000);
  assert.equal(await store.recordQueueRevisionConflict(start + 7_501_000), true);

  const summary = store.snapshot(start + 7_600_000);
  assert.equal(summary.decision_time.status, "measured");
  assert.equal(summary.decision_time.sample_count, 1);
  assert.equal(summary.decision_time.total_ms, 90_000);
  assert.equal(summary.decision_time.median_ms, 90_000);
  assert.equal(summary.question_recurrence.count, 1);
  assert.equal(summary.instruction_resend.count, 1);
  assert.equal(summary.recovery_time.sample_count, 1);
  assert.equal(summary.recovery_time.median_ms, 300_000);
  assert.equal(summary.queue_revision_conflicts.count, 1);

  const saved = await fs.readFile(store.file, "utf8");
  for (const privateValue of [
    "question-id-secret",
    "task-id-secret",
    "command-id-secret",
    "PRIVATE QUESTION BODY",
    "PRIVATE INSTRUCTION BODY",
  ])
    assert.equal(saved.includes(privateValue), false, privateValue);
  const exported = JSON.stringify(summary);
  assert.equal(exported.includes("question-id-secret"), false);
  assert.equal(exported.includes("PRIVATE QUESTION BODY"), false);
});

test("missing observations stay unavailable, and abandoned timers are separate from zero", async (t) => {
  const { project } = await temporaryProject(t, "rdsh-human-metrics-missing-");
  const store = await HumanMetricsStore.open(project);
  const state = { questions: [{ id: "Q1", answer: null }], tasks: [] };
  const at = Date.parse("2026-04-01T00:00:00.000Z");
  const beforeEnable = store.snapshot(at);
  assert.equal(beforeEnable.question_recurrence.status, "unavailable");
  assert.equal(beforeEnable.question_recurrence.count, null);
  await store.handle(
    { action: "configure", enabled: true, retention_days: 30 },
    state,
    at,
  );
  const observedZero = store.snapshot(at + 1_000);
  assert.equal(observedZero.question_recurrence.status, "observed");
  assert.equal(observedZero.question_recurrence.count, 0);
  assert.equal(observedZero.decision_time.status, "unavailable");
  assert.equal(observedZero.decision_time.median_ms, null);

  await store.handle(
    { action: "start_decision_timer", question_id: "Q1" },
    state,
    at + 2_000,
  );
  await store.handle(
    { action: "configure", enabled: false, retention_days: 30 },
    state,
    at + 12_000,
  );
  const stopped = store.snapshot(at + 13_000);
  assert.equal(stopped.enabled, false);
  assert.equal(stopped.decision_time.pending_count, 0);
  assert.equal(stopped.decision_time.unpaired_count, 1);
  assert.equal(stopped.question_recurrence.count, 0);
});

test("retention trims raw events and comparison keeps token and human costs independent", () => {
  const now = Date.parse("2026-04-10T00:00:00.000Z");
  const value = {
    schema: 1,
    enabled: true,
    retention_days: 7,
    truncated_before: null,
    coverage_sessions: [
      { from: "2026-03-01T00:00:00.000Z", to: "2026-03-02T00:00:00.000Z" },
      { from: "2026-04-09T00:00:00.000Z", to: null },
    ],
    events: [
      { kind: "question_recurrence", at: "2026-03-01T12:00:00.000Z" },
      { kind: "question_recurrence", at: "2026-04-09T12:00:00.000Z" },
    ],
    active_timer: null,
  };
  const summary = summarizeHumanMetrics(value, now);
  assert.equal(summary.question_recurrence.count, 1);
  assert.equal(summary.coverage.sessions.length, 1);

  const comparison = compareHumanMetricSamples(
    {
      tokens: 10_000,
      decision_time_ms: 120_000,
      question_recurrence: 1,
      instruction_resend: 1,
      recovery_time_ms: 60_000,
      queue_revision_conflicts: 0,
    },
    {
      tokens: 8_000,
      decision_time_ms: 110_000,
      question_recurrence: 2,
      instruction_resend: 3,
      recovery_time_ms: 180_000,
      queue_revision_conflicts: 1,
    },
  );
  assert.equal(comparison.tokens.delta, -2_000);
  assert.equal(comparison.instruction_resend.delta, 2);
  assert.equal(comparison.recovery_time_ms.delta, 120_000);
  assert.equal(comparison.question_recurrence.delta, 1);
  const exportedComparison = compareHumanMetricSamples(
    {
      token_snapshot: { value: 10_000 },
      metrics: {
        instruction_resend: { count: 1 },
        recovery_time: { median_ms: 60_000 },
      },
    },
    {
      token_snapshot: { value: 8_000 },
      metrics: {
        instruction_resend: { count: 3 },
        recovery_time: { median_ms: 180_000 },
      },
    },
  );
  assert.equal(exportedComparison.tokens.delta, -2_000);
  assert.equal(exportedComparison.instruction_resend.delta, 2);
  assert.equal(exportedComparison.recovery_time_ms.delta, 120_000);
});

test("the storage cap marks aggregates partial instead of silently undercounting", async (t) => {
  const { project } = await temporaryProject(t, "rdsh-human-metrics-cap-");
  const store = await HumanMetricsStore.open(project);
  const now = Date.parse("2026-04-10T00:00:00.000Z");
  store.value = {
    schema: 1,
    enabled: true,
    retention_days: 30,
    coverage_sessions: [{ from: iso(now - 24 * 60 * 60 * 1000), to: null }],
    events: Array.from({ length: 10_000 }, () => ({
      kind: "question_recurrence",
      at: iso(now - 1_000),
    })),
    truncated_before: null,
    active_timer: null,
  };
  await store.handle(
    { action: "mark_question_recurrence", question_id: "Q1" },
    { questions: [{ id: "Q1" }] },
    now,
  );
  const summary = store.snapshot(now);
  assert.equal(summary.question_recurrence.status, "partial");
  assert.equal(summary.question_recurrence.count, 10_000);
  assert.equal(summary.coverage.partial, true);
  assert.equal(summary.decision_time.status, "partial");
});

test("a timer older than retention is marked unpaired and cannot block a new measurement", async (t) => {
  const { project } = await temporaryProject(t, "rdsh-human-metrics-expired-");
  const store = await HumanMetricsStore.open(project);
  const state = { questions: [{ id: "Q1", answer: null }], tasks: [] };
  const start = Date.parse("2026-04-01T00:00:00.000Z");
  await store.handle(
    { action: "configure", enabled: true, retention_days: 7 },
    state,
    start,
  );
  await store.handle(
    { action: "start_decision_timer", question_id: "Q1" },
    state,
    start + 1_000,
  );
  await assert.rejects(
    store.handle({ action: "finish_timer" }, state, start + 8 * 24 * 60 * 60 * 1000),
    /There is no active timer/,
  );
  const summary = store.snapshot(start + 8 * 24 * 60 * 60 * 1000);
  assert.equal(summary.active_timer, null);
  assert.equal(summary.decision_time.unpaired_count, 1);
});

test("disabling collection abandons an expired active timer only once", async (t) => {
  const { project } = await temporaryProject(t, "rdsh-human-metrics-disable-");
  const store = await HumanMetricsStore.open(project);
  const state = { questions: [{ id: "Q1", answer: null }], tasks: [] };
  const start = Date.parse("2026-04-01T00:00:00.000Z");
  await store.handle(
    { action: "configure", enabled: true, retention_days: 7 },
    state,
    start,
  );
  await store.handle(
    { action: "start_decision_timer", question_id: "Q1" },
    state,
    start + 1_000,
  );
  await store.handle(
    { action: "configure", enabled: false, retention_days: 7 },
    state,
    start + 8 * 24 * 60 * 60 * 1000,
  );
  const summary = store.snapshot(start + 8 * 24 * 60 * 60 * 1000);
  assert.equal(summary.decision_time.unpaired_count, 1);
  assert.equal(summary.active_timer, null);
});

test("metrics API is browser-only and never appears in MCP project state", async (t) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "rdsh-human-metrics-api-"));
  const previousHome = process.env.RDSH_DASHBOARD_HOME;
  process.env.RDSH_DASHBOARD_HOME = path.join(temporary, "home");
  const projectRoot = path.join(temporary, "project");
  await fs.mkdir(projectRoot);
  const project = {
    id: "human-metrics-api",
    root: projectRoot,
    name: "fixture",
    directory: path.join(temporary, "state"),
  };
  let dashboard;
  t.after(async () => {
    await dashboard?.close();
    if (previousHome === undefined) delete process.env.RDSH_DASHBOARD_HOME;
    else process.env.RDSH_DASHBOARD_HOME = previousHome;
    assert.ok(path.basename(temporary).startsWith("rdsh-human-metrics-api-"));
    await fs.rm(temporary, { recursive: true, force: true });
  });
  const store = await ProjectStore.open(project);
  await store.mutate("question", {
    id: "question-api-secret",
    question: "PRIVATE API QUESTION",
  });
  dashboard = await startDashboard({
    project,
    port: await freePort(),
    tailscale: false,
  });
  const runtime = JSON.parse(
    await fs.readFile(path.join(project.directory, "runtime.json"), "utf8"),
  );
  const browserToken = new URL(runtime.browser_url).hash.slice("#key=".length);
  const browserHeaders = {
    "x-rdsh-browser-token": browserToken,
    "content-type": "application/json",
  };
  await fetch(dashboard.localUrl + "api/human-metrics", {
    headers: browserHeaders,
  }).then(async (response) => {
    assert.equal(response.status, 200);
    assert.equal((await response.json()).enabled, false);
  });
  await assert.rejects(
    fs.access(path.join(project.directory, "human-metrics.json")),
    (error) => error.code === "ENOENT",
  );
  const page = await fetch(dashboard.localUrl, { headers: browserHeaders });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /id="human-metrics"/);
  const script = await fetch(dashboard.localUrl + "human-metrics-ui.mjs");
  assert.equal(script.status, 200);
  assert.match(await script.text(), /集計JSONを保存/);
  assert.equal(
    (
      await fetch(dashboard.localUrl + "api/human-metrics", {
        headers: { authorization: `Bearer ${runtime.mcp_token}` },
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await fetch(dashboard.localUrl + "api/human-metrics", {
        headers: { authorization: `Bearer ${runtime.token}` },
      })
    ).status,
    403,
  );
  const enabled = await fetch(dashboard.localUrl + "api/human-metrics", {
    method: "POST",
    headers: browserHeaders,
    body: JSON.stringify({ action: "configure", enabled: true, retention_days: 30 }),
  });
  assert.equal(enabled.status, 200);
  const recurrence = await fetch(dashboard.localUrl + "api/human-metrics", {
    method: "POST",
    headers: browserHeaders,
    body: JSON.stringify({
      action: "mark_question_recurrence",
      question_id: "question-api-secret",
    }),
  });
  assert.equal(recurrence.status, 200);
  const aggregate = await recurrence.json();
  assert.equal(aggregate.question_recurrence.count, 1);
  assert.equal(JSON.stringify(aggregate).includes("question-api-secret"), false);

  const mcpState = await fetch(dashboard.localUrl + "api/state", {
    headers: { authorization: `Bearer ${runtime.mcp_token}` },
  }).then((response) => response.json());
  assert.equal(Object.hasOwn(mcpState, "human_metrics"), false);
  assert.equal(JSON.stringify(mcpState).includes("human_metrics"), false);
  const saved = await fs.readFile(path.join(project.directory, "human-metrics.json"), "utf8");
  assert.equal(saved.includes("question-api-secret"), false);
  assert.equal(saved.includes("PRIVATE API QUESTION"), false);
});
