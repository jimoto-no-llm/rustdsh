// Compose delegated subagents for one use case: which roles, which model tier,
// how many items per agent, and in which waves.
//
// This is the step before the worktree allocator in `workers.mjs`. It reads a
// local operator-owned request, starts no agent, calls no provider and writes
// nothing: it turns declared work into a deterministic dispatch plan that an
// operator (or a script) can hand to the existing worker/runtime tooling.
//
// The plan is deliberately conservative: a model tier is only used when the
// operator declared it, items are never split implicitly, and everything the
// request does not decide is reported as a warning instead of being guessed.

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const LABEL = /^[A-Za-z0-9][A-Za-z0-9._/:+-]{0,127}$/;
const TIER_ORDER = ["fast", "balanced", "deep"];
const TIER_COST = { fast: 1, balanced: 3, deep: 9 };
const RISK_WEIGHT = { low: 0, normal: 1, high: 2, security: 4 };

export const USE_CASES = {
  research: { role: "research", baseline: "balanced", read_only: true },
  review: { role: "review", baseline: "balanced", read_only: true },
  audit: { role: "scan", baseline: "deep", read_only: true },
  implement: { role: "edit", baseline: "balanced", read_only: false },
  fix: { role: "edit", baseline: "fast", read_only: false },
  migrate: { role: "edit", baseline: "deep", read_only: false },
};

export class PlanError extends Error {
  constructor(code) {
    super("Subagent plan: " + code);
    this.name = "PlanError";
    this.code = code;
  }
}

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const exact = (v, keys) =>
  isObject(v) && Object.keys(v).length === keys.length && keys.every((k) => Object.hasOwn(v, k));
const int = (v, min, max) => Number.isSafeInteger(v) && v >= min && v <= max;

function readRoute(value, tier) {
  if (!exact(value, ["provider", "model", "effort"])) throw new PlanError("invalid-tier:" + tier);
  if (!LABEL.test(value.provider) || !LABEL.test(value.model)) throw new PlanError("invalid-tier:" + tier);
  if (value.effort !== null && !LABEL.test(value.effort)) throw new PlanError("invalid-tier:" + tier);
  return { provider: value.provider, model: value.model, effort: value.effort };
}

function readItem(value) {
  if (!isObject(value) || !ID.test(value.id ?? "")) throw new PlanError("invalid-item");
  const allowed = ["id", "kind", "weight", "signals"];
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new PlanError("invalid-item");
  if (value.kind !== undefined && !LABEL.test(value.kind)) throw new PlanError("invalid-item-kind:" + value.id);
  const weight = value.weight === undefined ? 1 : value.weight;
  if (!int(weight, 1, 64)) throw new PlanError("invalid-item-weight:" + value.id);
  let signals = { files: 0, risk: "normal", unknown: false };
  if (value.signals !== undefined) {
    if (!isObject(value.signals)) throw new PlanError("invalid-item-signals:" + value.id);
    const keys = ["files", "risk", "unknown"];
    if (Object.keys(value.signals).some((key) => !keys.includes(key))) throw new PlanError("invalid-item-signals:" + value.id);
    const files = value.signals.files === undefined ? 0 : value.signals.files;
    if (!int(files, 0, 100000)) throw new PlanError("invalid-item-signals:" + value.id);
    const risk = value.signals.risk === undefined ? "normal" : value.signals.risk;
    if (!Object.hasOwn(RISK_WEIGHT, risk)) throw new PlanError("invalid-item-signals:" + value.id);
    const unknown = value.signals.unknown === undefined ? false : value.signals.unknown;
    if (typeof unknown !== "boolean") throw new PlanError("invalid-item-signals:" + value.id);
    signals = { files, risk, unknown };
  }
  return { id: value.id, kind: value.kind ?? null, weight, signals };
}

/** Difficulty score used to pick a tier. Bounded and monotonic in every signal. */
export function difficultyScore(item) {
  const fileFactor = item.signals.files <= 0 ? 0 : Math.min(6, 1 + Math.floor(Math.log2(item.signals.files)));
  const risk = RISK_WEIGHT[item.signals.risk];
  const unknown = item.signals.unknown ? 2 : 0;
  const weight = Math.min(8, item.weight - 1);
  return fileFactor + risk + unknown + weight;
}

function chooseTier(score, useCase, tiers, warnings, itemId) {
  const baseline = USE_CASES[useCase].baseline;
  let wanted = baseline;
  if (score >= 10) wanted = "deep";
  else if (score <= 2) wanted = "fast";
  if (tiers[wanted]) return wanted;
  const fallback = TIER_ORDER.filter((tier) => tiers[tier])
    .sort((a, b) => Math.abs(TIER_COST[a] - TIER_COST[wanted]) - Math.abs(TIER_COST[b] - TIER_COST[wanted]) || TIER_COST[a] - TIER_COST[b])[0];
  warnings.push({ code: "tier-missing", item: itemId, wanted, used: fallback });
  return fallback;
}

/** Pack one tier's items into agents of bounded item count and weight. */
function packTier(tier, items, limits) {
  const sorted = [...items].sort((a, b) => b.weight - a.weight || b.score - a.score || (a.id < b.id ? -1 : 1));
  const agents = [];
  for (const item of sorted) {
    let placed = false;
    for (const agent of agents) {
      if (agent.items.length >= limits.max_items_per_agent) continue;
      if (agent.weight + item.weight > limits.max_weight_per_agent) continue;
      agent.items.push(item.id);
      agent.weight += item.weight;
      agent.cost_units += TIER_COST[tier] * item.weight;
      if (item.score > agent.top_score) agent.top_score = item.score;
      placed = true;
      break;
    }
    if (!placed) {
      agents.push({
        items: [item.id],
        weight: item.weight,
        cost_units: TIER_COST[tier] * item.weight,
        top_score: item.score,
      });
    }
  }
  return agents;
}

export function planSubagents(request) {
  if (!isObject(request)) throw new PlanError("invalid-request");
  const allowed = ["use_case", "tiers", "items", "limits"];
  if (Object.keys(request).some((key) => !allowed.includes(key))) throw new PlanError("invalid-request");
  if (!Object.hasOwn(USE_CASES, request.use_case ?? "")) throw new PlanError("unknown-use-case");

  const warnings = [];
  const tiers = {};
  if (!isObject(request.tiers)) throw new PlanError("invalid-tiers");
  for (const [tier, value] of Object.entries(request.tiers)) {
    if (!TIER_ORDER.includes(tier)) throw new PlanError("invalid-tier:" + tier);
    tiers[tier] = readRoute(value, tier);
  }
  if (Object.keys(tiers).length === 0) throw new PlanError("no-tiers");

  if (!Array.isArray(request.items) || request.items.length === 0 || request.items.length > 200) throw new PlanError("invalid-items");
  const items = request.items.map(readItem);
  const seen = new Set();
  for (const item of items) {
    if (seen.has(item.id)) throw new PlanError("duplicate-item:" + item.id);
    seen.add(item.id);
  }

  let limits = { max_parallel: 3, max_items_per_agent: 3, max_weight_per_agent: 9, budget_units: null };
  if (request.limits !== undefined) {
    if (!isObject(request.limits)) throw new PlanError("invalid-limits");
    const keys = ["max_parallel", "max_items_per_agent", "max_weight_per_agent", "budget_units"];
    if (Object.keys(request.limits).some((key) => !keys.includes(key))) throw new PlanError("invalid-limits");
    const bounds = { max_parallel: [1, 16], max_items_per_agent: [1, 20], max_weight_per_agent: [1, 128], budget_units: [1, 100000] };
    for (const [key, [min, max]] of Object.entries(bounds)) {
      if (request.limits[key] === undefined || request.limits[key] === null) continue;
      if (!int(request.limits[key], min, max)) throw new PlanError("invalid-limits:" + key);
      limits[key] = request.limits[key];
    }
  }

  const classified = items.map((item) => {
    const score = difficultyScore(item);
    const tier = chooseTier(score, request.use_case, tiers, warnings, item.id);
    return { ...item, score, tier };
  });
  for (const item of classified) {
    if (item.weight > limits.max_weight_per_agent) {
      warnings.push({ code: "item-too-large", item: item.id, weight: item.weight, max_weight_per_agent: limits.max_weight_per_agent });
    }
  }

  const agents = [];
  for (const tier of TIER_ORDER) {
    const group = classified.filter((item) => item.tier === tier);
    if (group.length === 0) continue;
    for (const agent of packTier(tier, group, limits)) {
      agents.push({
        agent_id: `${USE_CASES[request.use_case].role}-${tier}-${agents.length + 1}`,
        role: USE_CASES[request.use_case].role,
        tier,
        route: tiers[tier],
        items: agent.items,
        weight: agent.weight,
        cost_units: agent.cost_units,
      });
    }
  }

  const waves = [];
  for (let index = 0; index < agents.length; index += limits.max_parallel) {
    waves.push({ wave: waves.length + 1, agents: agents.slice(index, index + limits.max_parallel) });
  }
  const costUnits = agents.reduce((sum, agent) => sum + agent.cost_units, 0);
  if (limits.budget_units !== null && costUnits > limits.budget_units) {
    warnings.push({ code: "budget-exceeded", cost_units: costUnits, budget_units: limits.budget_units });
  }
  if (warnings.length > 0) warnings.sort((a, b) => a.code.localeCompare(b.code) || String(a.item ?? "").localeCompare(String(b.item ?? "")));

  return {
    use_case: request.use_case,
    read_only: USE_CASES[request.use_case].read_only,
    tiers_used: [...new Set(agents.map((agent) => agent.tier))],
    waves,
    totals: { agents: agents.length, items: items.length, waves: waves.length, cost_units: costUnits },
    warnings,
  };
}
