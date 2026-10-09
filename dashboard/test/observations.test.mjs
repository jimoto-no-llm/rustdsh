import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { applyOperation, ProjectStore, publicState, writeJson } from "../state.mjs";
import {
  defaultMaxAgeSeconds,
  normalizeObservation,
  observationView,
  metricView,
  ratioView,
} from "../observations.mjs";
import { tools } from "../mcp.mjs";

const state = () => ({
  schema: 1, revision: 0, project: { id: "fixture" },
  metrics: {}, tasks: [], events: [], questions: [], feedback: [],
});
const report = (overrides = {}) => ({
  kind: "measured",
  observed_at: new Date(Date.now() - 1000).toISOString(),
  source: "provider usage snapshot",
  session_id: "session-A",
  reference: "request-123",
  ...overrides,
});

test("reports distinguish measurements, agent reports, estimates and unavailable data", () => {
  const now = Date.now();
  for (const [kind, label] of [
    ["measured", "実測"], ["agent_reported", "agent報告"],
    ["estimated", "推定"], ["unavailable", "未取得"],
  ]) {
    const observation = normalizeObservation(report({ kind }), { now });
    const view = observationView(kind === "unavailable" ? null : 10, observation, now);
    assert.equal(view.label, label);
    assert.equal(view.freshness, kind === "unavailable" ? "unavailable" : "fresh");
    assert.equal(observation.recorded_at, new Date(now).toISOString());
    assert.equal(observation.session_id, "session-A");
    assert.equal(observation.reference, "request-123");
    assert.equal(observation.max_age_seconds, defaultMaxAgeSeconds);
  }
  const legacyCaller = normalizeObservation(undefined, { now });
  assert.equal(legacyCaller.kind, "agent_reported");
  assert.equal(legacyCaller.observed_at, null);
  assert.equal(observationView(10, legacyCaller, now).freshness, "unknown");
  assert.equal(observationView(10, undefined, now).label, "出所未確認");
});

test("freshness uses observation time and expires without receiving another report", () => {
  const observed = Date.parse("2026-10-05T00:00:00.000Z");
  const observation = normalizeObservation({
    kind: "measured", source: "fixture", observed_at: new Date(observed).toISOString(),
    max_age_seconds: 60,
  }, { now: observed + 120000 });
  assert.equal(observationView(5, observation, observed + 59999).freshness, "fresh");
  assert.equal(observationView(5, observation, observed + 60000).freshness, "stale");
  assert.equal(observationView(5, observation, observed + 120000).current, false);
  assert.equal(observationView(5, observation, observed - 1).freshness, "unknown");
});

test("partial metric updates, task reports and metadata-only writes do not refresh old costs", () => {
  const value = state();
  applyOperation(value, "metrics", {
    total_cost_usd: 90.71,
    observation: report({ observed_at: new Date(Date.now() - 3600000).toISOString() }),
  });
  const previous = structuredClone(value.metric_observations.total_cost_usd);
  applyOperation(value, "metrics", { model_calls: 8, observation: report() });
  applyOperation(value, "task", { id: "T1", title: "Recent task", status: "doing", observation: report() });
  applyOperation(value, "metrics", { observation: report() });
  assert.deepEqual(value.metric_observations.total_cost_usd, previous);
  assert.equal(metricView(value, "total_cost_usd").freshness, "stale");
  assert.equal(metricView(value, "model_calls").freshness, "fresh");
  assert.equal(value.metrics.total_cost_usd, 90.71);
});

test("missing data stays unavailable and explicitly clearing a metric clears its provenance kind", () => {
  const value = state();
  assert.equal(metricView(value, "total_cost_usd").freshness, "unavailable");
  assert.equal(metricView(value, "total_cost_usd").value, undefined);
  applyOperation(value, "metrics", { total_cost_usd: 5, observation: report() });
  applyOperation(value, "metrics", { total_cost_usd: null, observation: report() });
  assert.equal(value.metrics.total_cost_usd, null);
  assert.equal(value.metric_observations.total_cost_usd.kind, "unavailable");
  assert.equal(metricView(value, "total_cost_usd").current, false);
  assert.throws(() => applyOperation(value, "metrics", {
    total_cost_usd: 9, observation: report({ kind: "unavailable" }),
  }), /Unavailable/);
  assert.equal(value.metrics.total_cost_usd, null);
});

test("ratios require a current single snapshot and never combine unrelated updates", () => {
  const value = state();
  applyOperation(value, "metrics", { input_tokens: 1000, cached_input_tokens: 500, observation: report() });
  assert.equal(ratioView(value, "cached_input_tokens", "input_tokens").value, 0.5);
  applyOperation(value, "metrics", { cached_input_tokens: 600, observation: report() });
  assert.deepEqual(ratioView(value, "cached_input_tokens", "input_tokens"), { value: null, reason: "incompatible" });
  applyOperation(value, "metrics", {
    input_tokens: 1000, cached_input_tokens: 600,
    observation: report({ observed_at: new Date(Date.now() - 3600000).toISOString() }),
  });
  assert.equal(ratioView(value, "cached_input_tokens", "input_tokens").value, null);
  applyOperation(value, "metrics", { input_tokens: 0, cached_input_tokens: 0, observation: report() });
  assert.deepEqual(ratioView(value, "cached_input_tokens", "input_tokens"), { value: null, reason: "zero_denominator" });
});

test("session changes clear old session costs while preserving cumulative counters, totals and their age", () => {
  const value = state();
  applyOperation(value, "metrics", {
    session_id: "session-A", session_cost_usd: 3, session_budget_usd: 5,
    input_tokens: 1000, cached_input_tokens: 900, tool_calls: 100, tool_errors: 1,
    total_cost_usd: 8, total_budget_usd: 20, observation: report(),
  });
  const totalObservation = structuredClone(value.metric_observations.total_cost_usd);
  applyOperation(value, "metrics", {
    session_id: "session-B", input_tokens: 10, cached_input_tokens: 5,
    observation: report({ session_id: "session-B" }),
  });
  assert.equal(value.metrics.session_id, "session-B");
  assert.equal(value.metrics.input_tokens, 10);
  for (const key of ["session_cost_usd", "session_budget_usd"]) {
    assert.equal(value.metrics[key], undefined);
    assert.equal(value.metric_observations[key], undefined);
  }
  assert.equal(value.metrics.total_cost_usd, 8);
  assert.equal(value.metrics.total_budget_usd, 20);
  assert.equal(value.metrics.tool_calls, 100);
  assert.equal(value.metric_observations.tool_calls.session_id, "session-A");
  assert.deepEqual(value.metric_observations.total_cost_usd, totalObservation);
});

test("invalid or future metadata and mismatched sessions fail atomically", () => {
  const value = state();
  applyOperation(value, "metrics", { total_cost_usd: 5, observation: report() });
  const before = structuredClone(value);
  for (const observation of [
    null, [], report({ kind: "verified" }), report({ kind: null }),
    report({ source: "" }), report({ observed_at: null }),
    report({ observed_at: "yesterday" }), report({ observed_at: "2026-02-30T00:00:00Z" }),
    report({ observed_at: "2026-10-04T24:00:00Z" }),
    report({ observed_at: new Date(Date.now() + 3600000).toISOString() }),
    report({ max_age_seconds: 0 }), report({ max_age_seconds: null }),
    report({ max_age_seconds: 1.1 }), report({ max_age_seconds: 604801 }),
    report({ session_id: "" }), report({ reference: "x".repeat(2001) }),
    report({ forged_field: "verified" }), report({ toString: "unknown" }),
  ]) {
    assert.throws(() => applyOperation(value, "metrics", { total_cost_usd: 99, observation }));
    assert.deepEqual(value, before);
  }
  assert.throws(() => applyOperation(value, "metrics", {
    session_id: "session-B", total_cost_usd: 99, observation: report(),
  }), /does not match/);
  assert.deepEqual(value, before);
});

test("source, session and target persist for metrics, task status and artifact history", async (t) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "rdsh-observation-test-"));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const project = { id: "fixture", root: temporary, name: "fixture", directory: path.join(temporary, "state") };
  const store = await ProjectStore.open(project);
  await store.mutate("metrics", { total_cost_usd: 5, observation: report() });
  await store.mutate("task", { id: "T1", title: "Validated output", status: "done", observation: report({ reference: "commit-abc" }) });
  await store.mutate("event", { type: "artifact", title: "Build evidence", artifact: "qa/report.txt", observation: report({ kind: "agent_reported", reference: "commit-abc:qa/report.txt" }) });
  const reopened = await ProjectStore.open(project);
  assert.deepEqual(reopened.value, store.value);
  assert.equal(reopened.value.tasks[0].observation.reference, "commit-abc");
  assert.equal(reopened.value.events[0].observation.session_id, "session-A");
  assert.equal(reopened.value.events[0].observation.reference, "commit-abc:qa/report.txt");
  assert.equal(publicState(reopened.value).metric_observations.total_cost_usd.source, "provider usage snapshot");
  const before = structuredClone(reopened.value);
  await assert.rejects(() => reopened.mutate("task", {
    id: "T1", title: "Invalid replacement", status: "done", observation: report({ kind: "invalid" }),
  }));
  assert.deepEqual(reopened.value, before);
  assert.deepEqual((await ProjectStore.open(project)).value, before);
});

test("legacy state remains readable without inventing provenance or observation times", async (t) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "rdsh-observation-legacy-"));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const project = { id: "fixture", directory: temporary };
  const legacy = state();
  legacy.updated_at = new Date().toISOString();
  legacy.metrics.total_cost_usd = 10;
  legacy.tasks.push({ id: "old", title: "Old success", status: "done", updated_at: legacy.updated_at });
  await writeJson(path.join(temporary, "state.json"), legacy);
  const store = await ProjectStore.open(project);
  assert.deepEqual(store.value, legacy);
  assert.equal(metricView(store.value, "total_cost_usd").freshness, "unknown");
  assert.equal(observationView("done", store.value.tasks[0].observation).current, false);
  await store.mutate("event", { title: "New unrelated event" });
  assert.equal(metricView(store.value, "total_cost_usd").freshness, "unknown");
  assert.equal(store.value.metric_observations, undefined);
});

test("MCP discovery advertises the same observation contract on all reporting tools", () => {
  for (const name of ["dashboard_update_metrics", "dashboard_upsert_task", "dashboard_publish_event"]) {
    const schema = tools.find((tool) => tool.name === name).inputSchema.properties.observation;
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual(schema.properties.kind.enum, ["measured", "agent_reported", "estimated", "unavailable"]);
    assert.equal(schema.properties.observed_at.format, "date-time");
  }
});
