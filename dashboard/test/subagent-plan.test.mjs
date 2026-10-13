import test from "node:test";
import assert from "node:assert/strict";
import { planSubagents, difficultyScore, PlanError, USE_CASES } from "../subagent-plan.mjs";

const route = (model, effort = "medium") => ({ provider: "example-provider", model, effort });
const tiers = { fast: route("fast-model", "low"), balanced: route("balanced-model"), deep: route("deep-model", "high") };
const item = (id, extra = {}) => ({ id, ...extra });

function failing(code, request) {
  assert.throws(() => planSubagents(request), (error) => error instanceof PlanError && error.code.startsWith(code), code);
}

test("rejects malformed requests instead of guessing", () => {
  failing("unknown-use-case", { use_case: "nope", tiers, items: [item("a")] });
  failing("no-tiers", { use_case: "review", tiers: {}, items: [item("a")] });
  failing("invalid-tiers", { use_case: "review", tiers: [], items: [item("a")] });
  failing("invalid-tier:", { use_case: "review", tiers: { ...tiers, fast: { provider: "p", model: "m" } }, items: [item("a")] });
  failing("invalid-items", { use_case: "review", tiers, items: [] });
  failing("duplicate-item", { use_case: "review", tiers, items: [item("a"), item("a")] });
  failing("invalid-item-weight", { use_case: "review", tiers, items: [item("a", { weight: 0 })] });
  failing("invalid-item-signals", { use_case: "review", tiers, items: [item("a", { signals: { risk: "extreme" } })] });
  failing("invalid-limits", { use_case: "review", tiers, items: [item("a")], limits: { max_parallel: 0 } });
  failing("invalid-request", { use_case: "review", tiers, items: [item("a")], extra: true });
});

test("difficulty grows with files, risk, uncertainty and weight", () => {
  const base = { weight: 1, signals: { files: 0, risk: "low", unknown: false } };
  assert.equal(difficultyScore(base), 0);
  assert.ok(difficultyScore({ ...base, signals: { ...base.signals, files: 40 } }) > 0);
  assert.ok(difficultyScore({ ...base, signals: { ...base.signals, risk: "security" } }) > difficultyScore({ ...base, signals: { ...base.signals, risk: "high" } }));
  assert.ok(difficultyScore({ ...base, signals: { ...base.signals, unknown: true } }) > difficultyScore(base));
  assert.ok(difficultyScore({ ...base, weight: 8 }) > difficultyScore(base));
  assert.ok(difficultyScore({ weight: 64, signals: { files: 100000, risk: "security", unknown: true } }) <= 20);
});

test("places easy work on the fast tier and hard work on the deep tier", () => {
  const plan = planSubagents({
    use_case: "implement",
    tiers,
    items: [item("small", { signals: { files: 1, risk: "low" } }), item("hard", { weight: 6, signals: { files: 80, risk: "security", unknown: true } })],
  });
  const byTier = Object.fromEntries(plan.tiers_used.map((tier) => [tier, true]));
  assert.deepEqual(byTier, { fast: true, deep: true });
  const small = plan.waves.flatMap((w) => w.agents).find((agent) => agent.items.includes("small"));
  const hard = plan.waves.flatMap((w) => w.agents).find((agent) => agent.items.includes("hard"));
  assert.equal(small.tier, "fast");
  assert.equal(hard.tier, "deep");
  assert.equal(hard.route.model, "deep-model");
});

test("falls back to a declared tier and reports it", () => {
  const plan = planSubagents({
    use_case: "review",
    tiers: { balanced: route("balanced-model") },
    items: [item("a", { weight: 5, signals: { files: 60, risk: "security", unknown: true } })],
  });
  assert.deepEqual(plan.tiers_used, ["balanced"]);
  assert.equal(plan.warnings[0].code, "tier-missing");
  assert.equal(plan.warnings[0].wanted, "deep");
  assert.equal(plan.warnings[0].used, "balanced");
});

test("packs items into agents within the declared limits", () => {
  const plan = planSubagents({
    use_case: "review",
    tiers,
    limits: { max_items_per_agent: 2, max_weight_per_agent: 4, max_parallel: 2 },
    items: [item("a", { weight: 2 }), item("b", { weight: 2 }), item("c", { weight: 2 }), item("d", { weight: 1 })],
  });
  const agents = plan.waves.flatMap((wave) => wave.agents);
  // 2+2 fills one agent, 2+1 the next: packing fills before it spills.
  assert.equal(agents.length, 2);
  assert.deepEqual(agents.map((agent) => agent.items.length), [2, 2]);
  for (const agent of agents) {
    assert.ok(agent.items.length <= 2);
    assert.ok(agent.weight <= 4);
  }
  assert.equal(plan.totals.items, 4);
  assert.deepEqual(agents.flatMap((agent) => agent.items).sort(), ["a", "b", "c", "d"]);
});

test("splits agents into waves bounded by max_parallel", () => {
  const plan = planSubagents({
    use_case: "audit",
    tiers,
    limits: { max_parallel: 2, max_items_per_agent: 1, max_weight_per_agent: 2 },
    items: [item("a"), item("b"), item("c"), item("d"), item("e")],
  });
  assert.equal(plan.totals.agents, 5);
  assert.equal(plan.waves.length, 3);
  for (const wave of plan.waves) assert.ok(wave.agents.length <= 2);
  assert.deepEqual(plan.waves.map((wave) => wave.agents.length), [2, 2, 1]);
});

test("warns instead of splitting an item that cannot fit, and keeps it in the plan", () => {
  const plan = planSubagents({
    use_case: "migrate",
    tiers,
    limits: { max_weight_per_agent: 3 },
    items: [item("huge", { weight: 9 })],
  });
  assert.equal(plan.warnings[0].code, "item-too-large");
  assert.equal(plan.warnings[0].item, "huge");
  assert.deepEqual(plan.waves[0].agents[0].items, ["huge"]);
});

test("reports a declared budget that the plan exceeds", () => {
  const plan = planSubagents({
    use_case: "implement",
    tiers,
    limits: { budget_units: 2, max_items_per_agent: 1 },
    items: [item("a", { weight: 4 })],
  });
  assert.equal(plan.warnings.find((warning) => warning.code === "budget-exceeded").budget_units, 2);
});

test("is deterministic for the same request and marks read-only use cases", () => {
  const request = {
    use_case: "review",
    tiers,
    limits: { max_parallel: 2, max_items_per_agent: 2, max_weight_per_agent: 6 },
    items: [item("b", { weight: 2 }), item("a", { weight: 2 }), item("c", { weight: 3 }), item("d", { weight: 1 })],
  };
  const first = planSubagents(request);
  const second = planSubagents(request);
  assert.deepEqual(first, second);
  assert.equal(first.read_only, true);
  assert.equal(USE_CASES.review.read_only, true);
  for (const agent of first.waves.flatMap((wave) => wave.agents)) assert.equal(agent.role, "review");
});
