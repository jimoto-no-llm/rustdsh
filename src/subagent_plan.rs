//! Deterministic subagent dispatch planning.
//!
//! Rust port of `dashboard/subagent-plan.mjs` (removed in the same change):
//! compose delegated subagents for one use case — which roles, which model
//! tier, how many items per agent, and in which waves.
//!
//! This is the step before worker workspaces. It reads one local
//! operator-owned request, starts no agent, calls no provider and writes
//! nothing: it turns declared work into a deterministic dispatch plan.
//!
//! The plan is deliberately conservative: a model tier is only used when the
//! operator declared it, items are never split implicitly, and everything the
//! request does not decide is reported as a warning instead of being guessed.

use std::cmp::Ordering;
use std::collections::{BTreeMap, HashSet};
use std::io::{Read, Write};

use anyhow::{anyhow, bail, Context, Result};
use serde::Serialize;
use serde_json::Value;

/// One use case: the agent role, the baseline tier and whether it writes.
#[derive(Debug, Clone, Copy)]
struct UseCase {
    name: &'static str,
    role: &'static str,
    baseline: &'static str,
    read_only: bool,
}

/// `USE_CASES` from the JS planner, in declaration order.
static USE_CASES: [UseCase; 6] = [
    UseCase {
        name: "research",
        role: "research",
        baseline: "balanced",
        read_only: true,
    },
    UseCase {
        name: "review",
        role: "review",
        baseline: "balanced",
        read_only: true,
    },
    UseCase {
        name: "audit",
        role: "scan",
        baseline: "deep",
        read_only: true,
    },
    UseCase {
        name: "implement",
        role: "edit",
        baseline: "balanced",
        read_only: false,
    },
    UseCase {
        name: "fix",
        role: "edit",
        baseline: "fast",
        read_only: false,
    },
    UseCase {
        name: "migrate",
        role: "edit",
        baseline: "deep",
        read_only: false,
    },
];

/// Tier names in cost order; also the agent numbering order.
const TIER_ORDER: [&str; 3] = ["fast", "balanced", "deep"];

/// Cost units per tier (`TIER_COST` from the JS planner).
fn tier_cost(tier: &str) -> i64 {
    match tier {
        "fast" => 1,
        "balanced" => 3,
        "deep" => 9,
        _ => unreachable!("tier names are checked against TIER_ORDER"),
    }
}

/// Risk multipliers (`RISK_WEIGHT`); membership in this list is validation.
const RISK_WEIGHT: [(&str, i64); 4] = [("low", 0), ("normal", 1), ("high", 2), ("security", 4)];

fn risk_weight(risk: &str) -> Option<i64> {
    RISK_WEIGHT
        .iter()
        .find(|(name, _)| *name == risk)
        .map(|(_, weight)| *weight)
}

/// The validated spelling of `risk`, borrowed from the static table.
fn risk_name(value: &Value) -> Option<&'static str> {
    let name = value.as_str()?;
    RISK_WEIGHT
        .iter()
        .find(|(risk, _)| *risk == name)
        .map(|(risk, _)| *risk)
}

/// `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$` (the JS `ID` regex), hand-rolled
/// so the port needs no regex engine.
fn id_ok(value: &str) -> bool {
    let mut chars = value.chars();
    match chars.next() {
        Some(first) if first.is_ascii_alphanumeric() => {}
        _ => return false,
    }
    let mut length = 1;
    for ch in chars {
        length += 1;
        if length > 128 || !(ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | ':' | '-')) {
            return false;
        }
    }
    true
}

/// `^[A-Za-z0-9][A-Za-z0-9._/:+-]{0,127}$` (the JS `LABEL` regex).
fn label_ok(value: &str) -> bool {
    let mut chars = value.chars();
    match chars.next() {
        Some(first) if first.is_ascii_alphanumeric() => {}
        _ => return false,
    }
    let mut length = 1;
    for ch in chars {
        length += 1;
        if length > 128
            || !(ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '/' | ':' | '+' | '-'))
        {
            return false;
        }
    }
    true
}

/// The JS `int` helper: `Number.isSafeInteger(v) && min <= v <= max`.
fn as_js_int(value: &Value) -> Option<i64> {
    match value {
        Value::Number(number) => {
            if let Some(int) = number.as_i64() {
                return Some(int);
            }
            let float = number.as_f64()?;
            if float.is_finite() && float.fract() == 0.0 && float.abs() <= 9_007_199_254_740_991.0 {
                Some(float as i64)
            } else {
                None
            }
        }
        _ => None,
    }
}

/// The error codes the JS `PlanError` carries, e.g. `invalid-item-weight:<id>`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlanError {
    pub code: String,
}

impl PlanError {
    fn new(code: impl Into<String>) -> Self {
        Self { code: code.into() }
    }
}

impl std::fmt::Display for PlanError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let code = &self.code;
        write!(f, "Subagent plan: {code}")
    }
}

impl std::error::Error for PlanError {}

/// A route the operator declared for one tier; `effort` stays null when the
/// request used null.
#[derive(Debug, Clone, Serialize, PartialEq)]
struct Route {
    provider: String,
    model: String,
    effort: Option<String>,
}

/// `readRoute`: exactly `{provider, model, effort}` with `LABEL` values.
fn read_route(value: &Value, tier: &str) -> std::result::Result<Route, PlanError> {
    let invalid = || PlanError::new(format!("invalid-tier:{tier}"));
    let object = value.as_object().ok_or_else(invalid)?;
    if object.len() != 3
        || !["provider", "model", "effort"]
            .iter()
            .all(|key| object.contains_key(*key))
    {
        return Err(invalid());
    }
    let provider = object
        .get("provider")
        .and_then(Value::as_str)
        .ok_or_else(invalid)?;
    let model = object
        .get("model")
        .and_then(Value::as_str)
        .ok_or_else(invalid)?;
    if !label_ok(provider) || !label_ok(model) {
        return Err(invalid());
    }
    let effort = match object.get("effort") {
        Some(Value::Null) => None,
        Some(Value::String(text)) if label_ok(text) => Some(text.clone()),
        _ => return Err(invalid()),
    };
    Ok(Route {
        provider: provider.to_string(),
        model: model.to_string(),
        effort,
    })
}

/// Signals that steer the difficulty score.
#[derive(Debug, Clone)]
struct Signals {
    files: i64,
    risk: &'static str,
    unknown: bool,
}

/// One validated work item. `kind` is validated but never stored: the JS
/// planner returns it and never reads it.
#[derive(Debug, Clone)]
struct Item {
    id: String,
    weight: i64,
    signals: Signals,
}

fn signals_error(id: &str) -> PlanError {
    PlanError::new(format!("invalid-item-signals:{id}"))
}

/// `readItem`: id, optional kind, weight 1..=64 and optional signals.
fn read_item(value: &Value) -> std::result::Result<Item, PlanError> {
    let object = value
        .as_object()
        .ok_or_else(|| PlanError::new("invalid-item"))?;
    let id = object.get("id").and_then(Value::as_str).unwrap_or("");
    if !id_ok(id) {
        return Err(PlanError::new("invalid-item"));
    }
    const ITEM_KEYS: [&str; 4] = ["id", "kind", "weight", "signals"];
    if object.keys().any(|key| !ITEM_KEYS.contains(&key.as_str())) {
        return Err(PlanError::new("invalid-item"));
    }
    // `null` passes the JS regex test (it coerces to the string "null") and
    // then stays null; the value never reaches the plan either way.
    if let Some(kind) = object.get("kind") {
        if !kind.is_null() {
            let kind = kind
                .as_str()
                .ok_or_else(|| PlanError::new(format!("invalid-item-kind:{id}")))?;
            if !label_ok(kind) {
                return Err(PlanError::new(format!("invalid-item-kind:{id}")));
            }
        }
    }
    // Only a missing key defaults to 1; a JSON null is not a safe integer.
    let weight = match object.get("weight") {
        None => 1,
        Some(value) => as_js_int(value)
            .filter(|weight| (1..=64).contains(weight))
            .ok_or_else(|| PlanError::new(format!("invalid-item-weight:{id}")))?,
    };
    let mut signals = Signals {
        files: 0,
        risk: "normal",
        unknown: false,
    };
    if let Some(value) = object.get("signals") {
        let object = value.as_object().ok_or_else(|| signals_error(id))?;
        const SIGNAL_KEYS: [&str; 3] = ["files", "risk", "unknown"];
        if object
            .keys()
            .any(|key| !SIGNAL_KEYS.contains(&key.as_str()))
        {
            return Err(signals_error(id));
        }
        let files = match object.get("files") {
            None => 0,
            Some(value) => as_js_int(value)
                .filter(|files| (0..=100_000).contains(files))
                .ok_or_else(|| signals_error(id))?,
        };
        let risk = match object.get("risk") {
            None => "normal",
            Some(value) => risk_name(value).ok_or_else(|| signals_error(id))?,
        };
        let unknown = match object.get("unknown") {
            None => false,
            Some(Value::Bool(unknown)) => *unknown,
            Some(_) => return Err(signals_error(id)),
        };
        signals = Signals {
            files,
            risk,
            unknown,
        };
    }
    Ok(Item {
        id: id.to_string(),
        weight,
        signals,
    })
}

/// Difficulty score used to pick a tier. Bounded and monotonic in every
/// signal: files cap at 6, risk 0..=4, unknown 2, weight cap at 8.
fn difficulty_score(item: &Item) -> i64 {
    let files = item.signals.files;
    let file_factor = if files <= 0 {
        0
    } else {
        (1 + i64::from(files.ilog2())).min(6)
    };
    let risk = risk_weight(item.signals.risk).expect("risk is validated on read");
    let unknown = if item.signals.unknown { 2 } else { 0 };
    let weight = (item.weight - 1).min(8);
    file_factor + risk + unknown + weight
}

/// One classified item: its score and the tier it was placed on.
#[derive(Debug)]
struct Classified<'a> {
    item: &'a Item,
    score: i64,
    tier: &'static str,
}

/// `chooseTier`: the score picks fast/deep outside 3..=9, the use case's
/// baseline picks the middle. An undeclared tier falls back to the closest
/// declared one and is reported as `tier-missing`.
fn choose_tier(
    score: i64,
    use_case: &UseCase,
    tiers: &BTreeMap<&'static str, Route>,
    warnings: &mut Vec<Warning>,
    item_id: &str,
) -> &'static str {
    let wanted = if score >= 10 {
        "deep"
    } else if score <= 2 {
        "fast"
    } else {
        use_case.baseline
    };
    if tiers.contains_key(wanted) {
        return wanted;
    }
    let wanted_cost = tier_cost(wanted);
    // Closest declared tier by cost; ties prefer the cheaper tier, which is
    // also the JS sort's second key and the declaration order.
    let used = TIER_ORDER
        .iter()
        .filter(|tier| tiers.contains_key(**tier))
        .min_by_key(|tier| ((tier_cost(tier) - wanted_cost).abs(), tier_cost(tier)))
        .copied()
        .expect("no-tiers is refused before any item is classified");
    warnings.push(Warning::TierMissing {
        code: "tier-missing",
        item: item_id.to_string(),
        wanted,
        used,
    });
    used
}

/// Limits after defaults and validation.
#[derive(Debug, Clone, Copy)]
struct Limits {
    max_parallel: i64,
    max_items_per_agent: i64,
    max_weight_per_agent: i64,
    budget_units: Option<i64>,
}

/// One packed agent before it gets its id and role.
#[derive(Debug)]
struct Packed {
    items: Vec<String>,
    weight: i64,
    cost_units: i64,
}

/// `packTier`: first-fit packing in weight desc, score desc, id asc order.
fn pack_tier(tier: &str, items: &[&Classified<'_>], limits: &Limits) -> Vec<Packed> {
    let mut sorted: Vec<&Classified<'_>> = items.to_vec();
    sorted.sort_by(|a, b| {
        b.item
            .weight
            .cmp(&a.item.weight)
            .then_with(|| b.score.cmp(&a.score))
            .then_with(|| a.item.id.cmp(&b.item.id))
    });
    let cost = tier_cost(tier);
    let mut agents: Vec<Packed> = Vec::new();
    for entry in sorted {
        let mut placed = false;
        for agent in agents.iter_mut() {
            if agent.items.len() as i64 >= limits.max_items_per_agent {
                continue;
            }
            if agent.weight + entry.item.weight > limits.max_weight_per_agent {
                continue;
            }
            agent.items.push(entry.item.id.clone());
            agent.weight += entry.item.weight;
            agent.cost_units += cost * entry.item.weight;
            placed = true;
            break;
        }
        if !placed {
            agents.push(Packed {
                items: vec![entry.item.id.clone()],
                weight: entry.item.weight,
                cost_units: cost * entry.item.weight,
            });
        }
    }
    agents
}

/// The dispatch plan, serialized in the JS planner's field order.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Plan {
    use_case: &'static str,
    read_only: bool,
    tiers_used: Vec<&'static str>,
    waves: Vec<Wave>,
    totals: Totals,
    warnings: Vec<Warning>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
struct Wave {
    wave: usize,
    agents: Vec<Agent>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
struct Agent {
    agent_id: String,
    role: &'static str,
    tier: &'static str,
    route: Route,
    items: Vec<String>,
    weight: i64,
    cost_units: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
struct Totals {
    agents: usize,
    items: usize,
    waves: usize,
    cost_units: i64,
}

/// Warnings serialize exactly like the JS planner's objects: code first,
/// then the fields that code carries, with no enum tag.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(untagged)]
enum Warning {
    TierMissing {
        code: &'static str,
        item: String,
        wanted: &'static str,
        used: &'static str,
    },
    ItemTooLarge {
        code: &'static str,
        item: String,
        weight: i64,
        max_weight_per_agent: i64,
    },
    BudgetExceeded {
        code: &'static str,
        cost_units: i64,
        budget_units: i64,
    },
}

impl Warning {
    /// The JS warning sort key: `code`, then `String(item ?? "")`.
    fn sort_key(&self) -> (&'static str, &str) {
        match self {
            Warning::TierMissing { code, item, .. } => (code, item),
            Warning::ItemTooLarge { code, item, .. } => (code, item),
            Warning::BudgetExceeded { code, .. } => (code, ""),
        }
    }
}

/// Ordering used by JavaScript's `localeCompare` for the ASCII identifiers the
/// planner accepts. ICU compares primary weights — `_`, `-`, `:`, `.`, then
/// digits, then case-folded letters — before case, while Rust's byte order
/// puts the punctuation after the letters; warning order would differ for ids
/// such as `pr-460` and `pr.460` without this.
fn locale_cmp(left: &str, right: &str) -> Ordering {
    fn primary(ch: char) -> u32 {
        match ch {
            '_' => 1,
            '-' => 2,
            ':' => 3,
            '.' => 4,
            '0'..='9' => 10 + (ch as u32 - '0' as u32),
            _ => {
                let lower = ch.to_ascii_lowercase();
                if lower.is_ascii_lowercase() {
                    30 + (lower as u32 - 'a' as u32)
                } else {
                    200 + ch as u32
                }
            }
        }
    }
    fn case(ch: char) -> u32 {
        u32::from(ch.is_ascii_uppercase())
    }
    let left_primary: Vec<u32> = left.chars().map(primary).collect();
    let right_primary: Vec<u32> = right.chars().map(primary).collect();
    match left_primary.cmp(&right_primary) {
        Ordering::Equal => {}
        other => return other,
    }
    let left_case: Vec<u32> = left.chars().map(case).collect();
    let right_case: Vec<u32> = right.chars().map(case).collect();
    left_case.cmp(&right_case)
}

/// Build a deterministic dispatch plan, or fail with the first error code the
/// JS planner would report for the same request.
pub fn plan_subagents(request: &Value) -> std::result::Result<Plan, PlanError> {
    let request = request
        .as_object()
        .ok_or_else(|| PlanError::new("invalid-request"))?;
    const REQUEST_KEYS: [&str; 4] = ["use_case", "tiers", "items", "limits"];
    if request
        .keys()
        .any(|key| !REQUEST_KEYS.contains(&key.as_str()))
    {
        return Err(PlanError::new("invalid-request"));
    }
    let use_case_name = request
        .get("use_case")
        .and_then(Value::as_str)
        .unwrap_or("");
    let use_case = USE_CASES
        .iter()
        .find(|candidate| candidate.name == use_case_name)
        .ok_or_else(|| PlanError::new("unknown-use-case"))?;

    let mut warnings: Vec<Warning> = Vec::new();

    // Tiers must be an object of declared routes; an empty object is refused
    // so `tier-missing` can always name a declared fallback.
    let tiers_value = request
        .get("tiers")
        .ok_or_else(|| PlanError::new("invalid-tiers"))?;
    let tiers_object = tiers_value
        .as_object()
        .ok_or_else(|| PlanError::new("invalid-tiers"))?;
    let mut tiers: BTreeMap<&'static str, Route> = BTreeMap::new();
    for (name, value) in tiers_object {
        let tier = TIER_ORDER
            .iter()
            .find(|tier| **tier == name.as_str())
            .ok_or_else(|| PlanError::new(format!("invalid-tier:{name}")))?;
        tiers.insert(*tier, read_route(value, name)?);
    }
    if tiers.is_empty() {
        return Err(PlanError::new("no-tiers"));
    }

    // Items: 1..=200 entries with unique ids, validated in request order.
    let items_value = request
        .get("items")
        .ok_or_else(|| PlanError::new("invalid-items"))?;
    let items_array = match items_value {
        Value::Array(items) if !items.is_empty() && items.len() <= 200 => items,
        _ => return Err(PlanError::new("invalid-items")),
    };
    let items = items_array
        .iter()
        .map(read_item)
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let mut seen: HashSet<&str> = HashSet::new();
    for item in &items {
        if !seen.insert(item.id.as_str()) {
            return Err(PlanError::new(format!("duplicate-item:{}", item.id)));
        }
    }

    let mut limits = Limits {
        max_parallel: 3,
        max_items_per_agent: 3,
        max_weight_per_agent: 9,
        budget_units: None,
    };
    if let Some(limits_value) = request.get("limits") {
        let object = limits_value
            .as_object()
            .ok_or_else(|| PlanError::new("invalid-limits"))?;
        const LIMIT_KEYS: [&str; 4] = [
            "max_parallel",
            "max_items_per_agent",
            "max_weight_per_agent",
            "budget_units",
        ];
        if object.keys().any(|key| !LIMIT_KEYS.contains(&key.as_str())) {
            return Err(PlanError::new("invalid-limits"));
        }
        // Bounds and check order are the JS planner's.
        const BOUNDS: [(&str, i64, i64); 4] = [
            ("max_parallel", 1, 16),
            ("max_items_per_agent", 1, 20),
            ("max_weight_per_agent", 1, 128),
            ("budget_units", 1, 100_000),
        ];
        for (key, min, max) in BOUNDS {
            let Some(value) = object.get(key) else {
                continue;
            };
            if value.is_null() {
                continue;
            }
            let number = as_js_int(value)
                .filter(|number| *number >= min && *number <= max)
                .ok_or_else(|| PlanError::new(format!("invalid-limits:{key}")))?;
            match key {
                "max_parallel" => limits.max_parallel = number,
                "max_items_per_agent" => limits.max_items_per_agent = number,
                "max_weight_per_agent" => limits.max_weight_per_agent = number,
                "budget_units" => limits.budget_units = Some(number),
                _ => unreachable!("BOUNDS keys are exhaustive"),
            }
        }
    }

    let classified: Vec<Classified<'_>> = items
        .iter()
        .map(|item| {
            let score = difficulty_score(item);
            let tier = choose_tier(score, use_case, &tiers, &mut warnings, &item.id);
            Classified { item, score, tier }
        })
        .collect();

    // An item heavier than one agent's whole budget is kept (a planner never
    // splits work silently) and reported.
    for entry in &classified {
        if entry.item.weight > limits.max_weight_per_agent {
            warnings.push(Warning::ItemTooLarge {
                code: "item-too-large",
                item: entry.item.id.clone(),
                weight: entry.item.weight,
                max_weight_per_agent: limits.max_weight_per_agent,
            });
        }
    }

    let mut agents: Vec<Agent> = Vec::new();
    for tier in TIER_ORDER {
        let group: Vec<&Classified<'_>> = classified
            .iter()
            .filter(|entry| entry.tier == tier)
            .collect();
        if group.is_empty() {
            continue;
        }
        let route = tiers
            .get(tier)
            .cloned()
            .expect("items are only classified onto declared tiers");
        for packed in pack_tier(tier, &group, &limits) {
            agents.push(Agent {
                agent_id: format!("{}-{}-{}", use_case.role, tier, agents.len() + 1),
                role: use_case.role,
                tier,
                route: route.clone(),
                items: packed.items,
                weight: packed.weight,
                cost_units: packed.cost_units,
            });
        }
    }

    let mut waves: Vec<Wave> = Vec::new();
    for chunk in agents.chunks(limits.max_parallel as usize) {
        waves.push(Wave {
            wave: waves.len() + 1,
            agents: chunk.to_vec(),
        });
    }
    let wave_count = waves.len();
    let cost_units: i64 = agents.iter().map(|agent| agent.cost_units).sum();
    if let Some(budget_units) = limits.budget_units {
        if cost_units > budget_units {
            warnings.push(Warning::BudgetExceeded {
                code: "budget-exceeded",
                cost_units,
                budget_units,
            });
        }
    }
    warnings.sort_by(|a, b| {
        let (a_code, a_item) = a.sort_key();
        let (b_code, b_item) = b.sort_key();
        locale_cmp(a_code, b_code).then_with(|| locale_cmp(a_item, b_item))
    });

    let mut tiers_used: Vec<&'static str> = Vec::new();
    for agent in &agents {
        if !tiers_used.contains(&agent.tier) {
            tiers_used.push(agent.tier);
        }
    }

    Ok(Plan {
        use_case: use_case.name,
        read_only: use_case.read_only,
        tiers_used,
        waves,
        totals: Totals {
            agents: agents.len(),
            items: items.len(),
            waves: wave_count,
            cost_units,
        },
        warnings,
    })
}

/// Read one request file with the JS CLI's `localJson` rules: a regular file
/// of at most 256 KiB with strict UTF-8 and valid JSON.
fn read_request(input_file: &str) -> Result<Value> {
    let file = std::fs::File::open(input_file)
        .with_context(|| format!("cannot read input JSON {input_file}"))?;
    let metadata = file
        .metadata()
        .with_context(|| format!("cannot read input JSON {input_file}"))?;
    if !metadata.is_file() || metadata.len() > 256 * 1024 {
        bail!("Input JSON must be a regular file of at most 256 KiB");
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(256 * 1024 + 1)
        .read_to_end(&mut bytes)
        .with_context(|| format!("cannot read input JSON {input_file}"))?;
    if bytes.len() > 256 * 1024 {
        bail!("Input JSON exceeds 256 KiB");
    }
    let Ok(text) = std::str::from_utf8(&bytes) else {
        bail!("Input JSON is invalid");
    };
    // TextDecoder("utf-8") in the former dashboard CLI removed a leading BOM.
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    serde_json::from_str(text).map_err(|_| anyhow!("Input JSON is invalid"))
}

/// `rdsh subagents plan --input-file <request-json>`: read one request and
/// print the plan as compact JSON on stdout, like the JS CLI did.
pub fn cmd_plan(input_file: &str) -> Result<()> {
    let request = read_request(input_file)?;
    let plan = plan_subagents(&request)?;
    let text = serde_json::to_string(&plan).context("serialize subagent plan")?;
    let stdout = std::io::stdout();
    let mut handle = stdout.lock();
    writeln!(handle, "{text}")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn route(model: &str, effort: Option<&str>) -> Value {
        json!({ "provider": "example-provider", "model": model, "effort": effort })
    }

    fn tiers() -> Value {
        json!({
            "fast": route("fast-model", Some("low")),
            "balanced": route("balanced-model", Some("medium")),
            "deep": route("deep-model", Some("high")),
        })
    }

    fn item(id: &str) -> Value {
        json!({ "id": id })
    }

    fn plan(request: &Value) -> Plan {
        plan_subagents(request).expect("request should produce a plan")
    }

    fn failing(prefix: &str, request: &Value) {
        let error = plan_subagents(request).expect_err("request should be refused");
        assert!(
            error.code.starts_with(prefix),
            "expected {prefix}, got {}",
            error.code
        );
    }

    fn parse_item(value: Value) -> Item {
        read_item(&value).expect("item should parse")
    }

    fn score(value: Value) -> i64 {
        difficulty_score(&parse_item(value))
    }

    fn all_agents(plan: &Plan) -> Vec<&Agent> {
        plan.waves
            .iter()
            .flat_map(|wave| wave.agents.iter())
            .collect()
    }

    fn ids(agents: &[&Agent]) -> Vec<String> {
        agents
            .iter()
            .flat_map(|agent| agent.items.clone())
            .collect()
    }

    #[test]
    fn rejects_malformed_requests_instead_of_guessing() {
        failing(
            "unknown-use-case",
            &json!({ "use_case": "nope", "tiers": tiers(), "items": [item("a")] }),
        );
        failing(
            "no-tiers",
            &json!({ "use_case": "review", "tiers": {}, "items": [item("a")] }),
        );
        failing(
            "invalid-tiers",
            &json!({ "use_case": "review", "tiers": [], "items": [item("a")] }),
        );
        failing(
            "invalid-tier:",
            &json!({
                "use_case": "review",
                "tiers": { "fast": { "provider": "p", "model": "m" } },
                "items": [item("a")]
            }),
        );
        failing(
            "invalid-items",
            &json!({ "use_case": "review", "tiers": tiers(), "items": [] }),
        );
        failing(
            "duplicate-item",
            &json!({ "use_case": "review", "tiers": tiers(), "items": [item("a"), item("a")] }),
        );
        failing(
            "invalid-item-weight",
            &json!({
                "use_case": "review",
                "tiers": tiers(),
                "items": [{ "id": "a", "weight": 0 }]
            }),
        );
        failing(
            "invalid-item-signals",
            &json!({
                "use_case": "review",
                "tiers": tiers(),
                "items": [{ "id": "a", "signals": { "risk": "extreme" } }]
            }),
        );
        failing(
            "invalid-limits",
            &json!({
                "use_case": "review",
                "tiers": tiers(),
                "items": [item("a")],
                "limits": { "max_parallel": 0 }
            }),
        );
        failing(
            "invalid-request",
            &json!({
                "use_case": "review",
                "tiers": tiers(),
                "items": [item("a")],
                "extra": true
            }),
        );
    }

    #[test]
    fn difficulty_grows_with_files_risk_uncertainty_and_weight() {
        let base = score(json!({
            "id": "a",
            "weight": 1,
            "signals": { "files": 0, "risk": "low", "unknown": false }
        }));
        assert_eq!(base, 0);
        assert!(
            score(json!({
                "id": "a",
                "weight": 1,
                "signals": { "files": 40, "risk": "low" }
            })) > 0
        );
        let security = score(json!({ "id": "a", "weight": 1, "signals": { "risk": "security" } }));
        let high = score(json!({ "id": "a", "weight": 1, "signals": { "risk": "high" } }));
        assert!(security > high);
        assert!(
            score(json!({
                "id": "a",
                "weight": 1,
                "signals": { "risk": "low", "unknown": true }
            })) > base
        );
        assert!(score(json!({ "id": "a", "weight": 8, "signals": { "risk": "low" } })) > base);
        assert!(
            score(json!({
                "id": "a",
                "weight": 64,
                "signals": { "files": 100000, "risk": "security", "unknown": true }
            })) <= 20
        );
        // Exact boundaries: file factor, weight cap and the 2/10 tier cutoffs.
        assert_eq!(
            score(json!({ "id": "a", "weight": 1, "signals": { "files": 1, "risk": "low" } })),
            1
        );
        assert_eq!(
            score(json!({ "id": "a", "weight": 1, "signals": { "files": 2, "risk": "low" } })),
            2
        );
        assert_eq!(
            score(json!({ "id": "a", "weight": 1, "signals": { "files": 3, "risk": "low" } })),
            2
        );
        assert_eq!(
            score(json!({ "id": "a", "weight": 1, "signals": { "files": 31, "risk": "low" } })),
            5
        );
        assert_eq!(
            score(json!({ "id": "a", "weight": 1, "signals": { "files": 32, "risk": "low" } })),
            6
        );
        assert_eq!(
            score(json!({
                "id": "a",
                "weight": 1,
                "signals": { "files": 100000, "risk": "low" }
            })),
            6
        );
        assert_eq!(
            score(json!({ "id": "a", "weight": 9, "signals": { "risk": "low" } })),
            8
        );
        assert_eq!(
            score(json!({ "id": "a", "weight": 64, "signals": { "risk": "low" } })),
            8
        );
        assert_eq!(
            score(json!({ "id": "a", "weight": 3, "signals": { "risk": "low" } })),
            2
        );
        assert_eq!(
            score(json!({
                "id": "a",
                "weight": 5,
                "signals": { "files": 16, "risk": "normal" }
            })),
            10
        );
    }

    #[test]
    fn places_easy_work_on_the_fast_tier_and_hard_work_on_the_deep_tier() {
        let result = plan(&json!({
            "use_case": "implement",
            "tiers": tiers(),
            "items": [
                { "id": "small", "signals": { "files": 1, "risk": "low" } },
                { "id": "hard", "weight": 6, "signals": { "files": 80, "risk": "security", "unknown": true } }
            ]
        }));
        assert_eq!(result.tiers_used, vec!["fast", "deep"]);
        let agents = all_agents(&result);
        let small = agents
            .iter()
            .find(|agent| agent.items.iter().any(|id| id == "small"))
            .expect("small item is placed");
        let hard = agents
            .iter()
            .find(|agent| agent.items.iter().any(|id| id == "hard"))
            .expect("hard item is placed");
        assert_eq!(small.tier, "fast");
        assert_eq!(hard.tier, "deep");
        assert_eq!(hard.route.model, "deep-model");
        assert!(!result.read_only);
    }

    #[test]
    fn tier_choice_uses_the_exact_score_boundaries() {
        // implement's baseline is balanced: 2 -> fast, 3..=9 -> balanced, 10 -> deep.
        for (request_item, tier) in [
            (
                json!({ "id": "s", "weight": 3, "signals": { "risk": "low" } }),
                "fast",
            ),
            (
                json!({ "id": "s", "weight": 4, "signals": { "files": 16, "risk": "normal" } }),
                "balanced",
            ),
            (
                json!({ "id": "s", "weight": 5, "signals": { "files": 16, "risk": "normal" } }),
                "deep",
            ),
        ] {
            let result = plan(
                &json!({ "use_case": "implement", "tiers": tiers(), "items": [request_item] }),
            );
            assert_eq!(result.tiers_used, vec![tier]);
        }
        // audit's baseline is deep: easy work still goes fast, the middle stays deep.
        let easy = plan(&json!({
            "use_case": "audit",
            "tiers": tiers(),
            "items": [{ "id": "a", "weight": 3, "signals": { "risk": "low" } }]
        }));
        assert_eq!(easy.tiers_used, vec!["fast"]);
        let middle = plan(&json!({
            "use_case": "audit",
            "tiers": tiers(),
            "items": [{ "id": "a", "weight": 4, "signals": { "risk": "low" } }]
        }));
        assert_eq!(middle.tiers_used, vec!["deep"]);
        // fix's baseline is fast: hard work goes deep.
        let hard = plan(&json!({
            "use_case": "fix",
            "tiers": tiers(),
            "items": [{ "id": "a", "weight": 5, "signals": { "files": 16, "risk": "normal" } }]
        }));
        assert_eq!(hard.tiers_used, vec!["deep"]);
    }

    #[test]
    fn falls_back_to_a_declared_tier_and_reports_it() {
        let result = plan(&json!({
            "use_case": "review",
            "tiers": { "balanced": route("balanced-model", Some("medium")) },
            "items": [{ "id": "a", "weight": 5, "signals": { "files": 60, "risk": "security", "unknown": true } }]
        }));
        assert_eq!(result.tiers_used, vec!["balanced"]);
        match &result.warnings[0] {
            Warning::TierMissing {
                code,
                item,
                wanted,
                used,
            } => {
                assert_eq!(*code, "tier-missing");
                assert_eq!(item, "a");
                assert_eq!(*wanted, "deep");
                assert_eq!(*used, "balanced");
            }
            other => panic!("expected tier-missing, got {other:?}"),
        }
    }

    #[test]
    fn fallback_picks_the_closest_declared_tier() {
        fn fallback(use_case: &str, declared: Value, work: Value) -> (&'static str, &'static str) {
            let result = plan(&json!({
                "use_case": use_case,
                "tiers": declared,
                "items": [work]
            }));
            match &result.warnings[0] {
                Warning::TierMissing { wanted, used, .. } => (wanted, used),
                other => panic!("expected tier-missing, got {other:?}"),
            }
        }
        // score 20 wants deep; score 2 wants fast; score 3 keeps the review baseline.
        let hard = json!({
            "id": "a",
            "weight": 8,
            "signals": { "files": 90, "risk": "security", "unknown": true }
        });
        let easy = json!({ "id": "a", "weight": 3, "signals": { "risk": "low" } });
        let middle = json!({ "id": "a", "weight": 4, "signals": { "risk": "low" } });
        assert_eq!(
            fallback("review", json!({ "fast": route("m", None) }), hard.clone()),
            ("deep", "fast")
        );
        assert_eq!(
            fallback("review", json!({ "deep": route("m", None) }), easy.clone()),
            ("fast", "deep")
        );
        assert_eq!(
            fallback(
                "review",
                json!({ "fast": route("f", None), "balanced": route("b", None) }),
                hard
            ),
            ("deep", "balanced")
        );
        assert_eq!(
            fallback(
                "review",
                json!({ "balanced": route("b", None), "deep": route("d", None) }),
                easy
            ),
            ("fast", "balanced")
        );
        assert_eq!(
            fallback(
                "implement",
                json!({ "fast": route("f", None), "deep": route("d", None) }),
                middle
            ),
            ("balanced", "fast")
        );
    }

    #[test]
    fn packs_items_into_agents_within_the_declared_limits() {
        let result = plan(&json!({
            "use_case": "review",
            "tiers": tiers(),
            "limits": { "max_items_per_agent": 2, "max_weight_per_agent": 4, "max_parallel": 2 },
            "items": [
                { "id": "a", "weight": 2 },
                { "id": "b", "weight": 2 },
                { "id": "c", "weight": 2 },
                { "id": "d", "weight": 1 }
            ]
        }));
        let agents = all_agents(&result);
        // 2+2 fills one agent, 2+1 the next: packing fills before it spills.
        assert_eq!(agents.len(), 2);
        let sizes: Vec<usize> = agents.iter().map(|agent| agent.items.len()).collect();
        assert_eq!(sizes, vec![2, 2]);
        for agent in &agents {
            assert!(agent.items.len() <= 2);
            assert!(agent.weight <= 4);
        }
        assert_eq!(result.totals.items, 4);
        let mut packed = ids(&agents);
        packed.sort();
        assert_eq!(packed, vec!["a", "b", "c", "d"]);
    }

    #[test]
    fn splits_agents_into_waves_bounded_by_max_parallel() {
        let result = plan(&json!({
            "use_case": "audit",
            "tiers": tiers(),
            "limits": { "max_parallel": 2, "max_items_per_agent": 1, "max_weight_per_agent": 2 },
            "items": [item("a"), item("b"), item("c"), item("d"), item("e")]
        }));
        assert_eq!(result.totals.agents, 5);
        assert_eq!(result.waves.len(), 3);
        for wave in &result.waves {
            assert!(wave.agents.len() <= 2);
        }
        let sizes: Vec<usize> = result.waves.iter().map(|wave| wave.agents.len()).collect();
        assert_eq!(sizes, vec![2, 2, 1]);
    }

    #[test]
    fn numbers_agent_ids_across_tiers() {
        let result = plan(&json!({
            "use_case": "implement",
            "tiers": tiers(),
            "limits": { "max_items_per_agent": 1, "max_weight_per_agent": 2 },
            "items": [
                { "id": "easy" },
                { "id": "hard", "weight": 8, "signals": { "files": 90, "risk": "security", "unknown": true } }
            ]
        }));
        let agent_ids: Vec<&str> = all_agents(&result)
            .iter()
            .map(|agent| agent.agent_id.as_str())
            .collect();
        assert_eq!(agent_ids, vec!["edit-fast-1", "edit-deep-2"]);
        assert_eq!(result.tiers_used, vec!["fast", "deep"]);
    }

    #[test]
    fn warns_instead_of_splitting_an_item_that_cannot_fit_and_keeps_it() {
        let result = plan(&json!({
            "use_case": "migrate",
            "tiers": tiers(),
            "limits": { "max_weight_per_agent": 3 },
            "items": [{ "id": "huge", "weight": 9 }]
        }));
        match &result.warnings[0] {
            Warning::ItemTooLarge {
                code,
                item,
                weight,
                max_weight_per_agent,
            } => {
                assert_eq!(*code, "item-too-large");
                assert_eq!(item, "huge");
                assert_eq!(*weight, 9);
                assert_eq!(*max_weight_per_agent, 3);
            }
            other => panic!("expected item-too-large, got {other:?}"),
        }
        assert_eq!(result.waves[0].agents[0].items, vec!["huge"]);
    }

    #[test]
    fn reports_a_declared_budget_that_the_plan_exceeds() {
        let result = plan(&json!({
            "use_case": "implement",
            "tiers": tiers(),
            "limits": { "budget_units": 2, "max_items_per_agent": 1 },
            "items": [{ "id": "a", "weight": 4 }]
        }));
        match result
            .warnings
            .iter()
            .find(|warning| warning.sort_key().0 == "budget-exceeded")
        {
            Some(Warning::BudgetExceeded {
                cost_units,
                budget_units,
                ..
            }) => {
                assert_eq!(*budget_units, 2);
                assert_eq!(*cost_units, 12);
            }
            other => panic!("expected budget-exceeded, got {other:?}"),
        }
    }

    #[test]
    fn is_deterministic_for_the_same_request_and_marks_read_only_use_cases() {
        let request = json!({
            "use_case": "review",
            "tiers": tiers(),
            "limits": { "max_parallel": 2, "max_items_per_agent": 2, "max_weight_per_agent": 6 },
            "items": [
                { "id": "b", "weight": 2 },
                { "id": "a", "weight": 2 },
                { "id": "c", "weight": 3 },
                { "id": "d", "weight": 1 }
            ]
        });
        let first = plan(&request);
        let second = plan(&request);
        assert_eq!(first, second);
        assert_eq!(
            serde_json::to_string(&first).unwrap(),
            serde_json::to_string(&second).unwrap()
        );
        assert!(first.read_only);
        for agent in all_agents(&first) {
            assert_eq!(agent.role, "review");
        }
        // research is read-only too; audit scans.
        assert!(
            plan(&json!({ "use_case": "research", "tiers": tiers(), "items": [item("a")] }))
                .read_only
        );
        assert!(
            plan(&json!({ "use_case": "audit", "tiers": tiers(), "items": [item("a")] })).read_only
        );
        let audit = plan(&json!({ "use_case": "audit", "tiers": tiers(), "items": [item("a")] }));
        assert_eq!(audit.waves[0].agents[0].role, "scan");
    }

    #[test]
    fn limits_accept_only_their_declared_bounds() {
        plan(
            &json!({ "use_case": "review", "tiers": tiers(), "items": [item("a")], "limits": { "max_parallel": 16 } }),
        );
        plan(
            &json!({ "use_case": "review", "tiers": tiers(), "items": [item("a")], "limits": { "max_items_per_agent": 20 } }),
        );
        plan(
            &json!({ "use_case": "review", "tiers": tiers(), "items": [item("a")], "limits": { "max_weight_per_agent": 128 } }),
        );
        plan(
            &json!({ "use_case": "review", "tiers": tiers(), "items": [item("a")], "limits": { "budget_units": 100000 } }),
        );
        for (key, value) in [
            ("max_parallel", 17),
            ("max_parallel", 0),
            ("max_items_per_agent", 21),
            ("max_weight_per_agent", 129),
            ("budget_units", 100001),
        ] {
            let mut limits = serde_json::Map::new();
            limits.insert(key.to_string(), json!(value));
            failing(
                &format!("invalid-limits:{key}"),
                &json!({
                    "use_case": "review",
                    "tiers": tiers(),
                    "items": [item("a")],
                    "limits": limits
                }),
            );
        }
        // The check order is the JS planner's when several keys are invalid.
        failing(
            "invalid-limits:max_parallel",
            &json!({
                "use_case": "review",
                "tiers": tiers(),
                "items": [item("a")],
                "limits": { "max_weight_per_agent": 0, "max_parallel": 0 }
            }),
        );
        // null and a missing key both keep the default; extra keys are refused.
        let defaults = plan(&json!({
            "use_case": "review",
            "tiers": tiers(),
            "items": [item("a")],
            "limits": { "max_parallel": null, "budget_units": null }
        }));
        assert_eq!(defaults.totals.waves, 1);
        failing(
            "invalid-limits",
            &json!({ "use_case": "review", "tiers": tiers(), "items": [item("a")], "limits": { "extra": 1 } }),
        );
        failing(
            "invalid-limits",
            &json!({ "use_case": "review", "tiers": tiers(), "items": [item("a")], "limits": null }),
        );
    }

    #[test]
    fn accepts_only_the_declared_item_and_label_boundaries() {
        // weight 1..=64; only a missing key defaults.
        plan(&json!({
            "use_case": "fix",
            "tiers": tiers(),
            "items": [{ "id": "a", "weight": 1 }]
        }));
        let heavy = plan(&json!({
            "use_case": "fix",
            "tiers": tiers(),
            "limits": { "max_weight_per_agent": 128, "max_items_per_agent": 20 },
            "items": [{ "id": "a", "weight": 64 }]
        }));
        assert_eq!(all_agents(&heavy)[0].weight, 64);
        for bad in [json!(0), json!(65), json!(2.5), json!("3"), json!(null)] {
            failing(
                "invalid-item-weight:a",
                &json!({ "use_case": "fix", "tiers": tiers(), "items": [{ "id": "a", "weight": bad }] }),
            );
        }
        // id: 1..=128 characters, first character alphanumeric.
        plan(&json!({
            "use_case": "fix",
            "tiers": tiers(),
            "items": [{ "id": "a".repeat(128) }]
        }));
        failing(
            "invalid-item",
            &json!({ "use_case": "fix", "tiers": tiers(), "items": [{ "id": "a".repeat(129) }] }),
        );
        for bad in ["", "-a", ".a", "a/b"] {
            failing(
                "invalid-item",
                &json!({ "use_case": "fix", "tiers": tiers(), "items": [{ "id": bad }] }),
            );
        }
        // LABEL: provider/model 1..=128 with ./_:+-; effort may be null.
        plan(&json!({
            "use_case": "review",
            "tiers": { "fast": route(&"m".repeat(128), None) },
            "items": [item("a")]
        }));
        failing(
            "invalid-tier:fast",
            &json!({
                "use_case": "review",
                "tiers": { "fast": route(&"m".repeat(129), None) },
                "items": [item("a")]
            }),
        );
        failing(
            "invalid-tier:fast",
            &json!({
                "use_case": "review",
                "tiers": { "fast": { "provider": "bad provider", "model": "m", "effort": null } },
                "items": [item("a")]
            }),
        );
        failing(
            "invalid-tier:fast",
            &json!({
                "use_case": "review",
                "tiers": { "fast": { "provider": "p", "model": "m", "effort": "" } },
                "items": [item("a")]
            }),
        );
        let null_effort = plan(&json!({
            "use_case": "review",
            "tiers": { "fast": route("m", None) },
            "items": [item("a")]
        }));
        assert_eq!(all_agents(&null_effort)[0].route.effort, None);
    }

    #[test]
    fn invalid_tiers_report_the_first_error_in_source_order() {
        let request: Value = serde_json::from_str(
            r#"{"use_case":"review","tiers":{"zeta":{"provider":"p","model":"m","effort":null},"alpha":{"provider":"p","model":"m","effort":null}},"items":[{"id":"a"}]}"#,
        )
        .unwrap();

        let error = plan_subagents(&request).expect_err("unknown tiers should be refused");
        assert_eq!(error.code, "invalid-tier:zeta");
    }

    #[test]
    fn item_and_signal_defaults_match_the_request() {
        // kind is validated but never enters the plan; null passes in JS.
        plan(&json!({
            "use_case": "fix",
            "tiers": tiers(),
            "items": [{ "id": "a", "kind": null }]
        }));
        plan(&json!({
            "use_case": "fix",
            "tiers": tiers(),
            "items": [{ "id": "a", "kind": "code.edit" }]
        }));
        failing(
            "invalid-item-kind:a",
            &json!({ "use_case": "fix", "tiers": tiers(), "items": [{ "id": "a", "kind": "bad kind" }] }),
        );
        failing(
            "invalid-item",
            &json!({ "use_case": "fix", "tiers": tiers(), "items": [{ "id": "a", "extra": 1 }] }),
        );
        let defaults = parse_item(json!({ "id": "a" }));
        assert_eq!(defaults.weight, 1);
        assert_eq!(defaults.signals.files, 0);
        assert_eq!(defaults.signals.risk, "normal");
        assert!(!defaults.signals.unknown);
        for value in [
            json!({ "id": "a", "signals": null }),
            json!({ "id": "a", "signals": { "files": null } }),
            json!({ "id": "a", "signals": { "files": 100001 } }),
            json!({ "id": "a", "signals": { "risk": null } }),
            json!({ "id": "a", "signals": { "unknown": "yes" } }),
            json!({ "id": "a", "signals": { "extra": 1 } }),
        ] {
            failing(
                "invalid-item-signals:a",
                &json!({ "use_case": "fix", "tiers": tiers(), "items": [value] }),
            );
        }
    }

    #[test]
    fn accepts_one_and_two_hundred_items_and_refuses_more() {
        assert_eq!(
            plan(&json!({ "use_case": "fix", "tiers": tiers(), "items": [item("only")] }))
                .totals
                .items,
            1
        );
        let two_hundred: Vec<Value> = (0..200)
            .map(|index| json!({ "id": format!("i{index}") }))
            .collect();
        let full = plan(&json!({
            "use_case": "audit",
            "tiers": tiers(),
            "limits": { "max_items_per_agent": 20, "max_weight_per_agent": 128 },
            "items": two_hundred
        }));
        assert_eq!(full.totals.items, 200);
        let too_many: Vec<Value> = (0..201)
            .map(|index| json!({ "id": format!("i{index}") }))
            .collect();
        failing(
            "invalid-items",
            &json!({ "use_case": "audit", "tiers": tiers(), "items": too_many }),
        );
        failing(
            "invalid-items",
            &json!({ "use_case": "audit", "tiers": tiers(), "items": "a" }),
        );
    }

    #[test]
    fn warnings_are_sorted_by_code_then_item() {
        let result = plan(&json!({
            "use_case": "fix",
            "tiers": { "balanced": route("m", Some("medium")) },
            "limits": { "max_weight_per_agent": 3, "budget_units": 1 },
            "items": [
                { "id": "zeta", "weight": 5, "signals": { "files": 90, "risk": "security", "unknown": true } },
                { "id": "alpha", "weight": 9 },
                { "id": "mid", "weight": 7, "signals": { "files": 90, "risk": "security", "unknown": true } }
            ]
        }));
        let keys: Vec<(&str, &str)> = result
            .warnings
            .iter()
            .map(|warning| warning.sort_key())
            .collect();
        assert_eq!(
            keys,
            vec![
                ("budget-exceeded", ""),
                ("item-too-large", "alpha"),
                ("item-too-large", "mid"),
                ("item-too-large", "zeta"),
                ("tier-missing", "alpha"),
                ("tier-missing", "mid"),
                ("tier-missing", "zeta"),
            ]
        );
    }

    #[test]
    fn warning_order_matches_javascript_locale_compare() {
        // JS sorts warnings with localeCompare, which orders `_`, `-`, `:`, `.`
        // before digits and puts lowercase before uppercase.
        let items: Vec<Value> = [
            "a.b", "a-b", "a_b", "a:b", "aB", "ab", "A", "0", "a0", "Z", "z",
        ]
        .iter()
        .map(|id| json!({ "id": id, "weight": 2 }))
        .collect();
        let result = plan(&json!({
            "use_case": "migrate",
            "tiers": tiers(),
            "limits": { "max_weight_per_agent": 1 },
            "items": items
        }));
        let warning_items: Vec<&str> = result
            .warnings
            .iter()
            .map(|warning| warning.sort_key().1)
            .collect();
        assert_eq!(
            warning_items,
            vec!["0", "A", "a_b", "a-b", "a:b", "a.b", "a0", "ab", "aB", "z", "Z"]
        );
    }

    #[test]
    fn serializes_exactly_like_the_js_planner() {
        let result = plan(&json!({
            "use_case": "review",
            "tiers": tiers(),
            "limits": { "max_parallel": 2, "max_items_per_agent": 2, "max_weight_per_agent": 6, "budget_units": 40 },
            "items": [
                { "id": "pr-460", "weight": 4, "signals": { "files": 30, "risk": "security" } },
                { "id": "pr-458", "weight": 2, "signals": { "files": 12 } }
            ]
        }));
        assert_eq!(
            serde_json::to_string(&result).unwrap(),
            r#"{"use_case":"review","read_only":true,"tiers_used":["balanced","deep"],"waves":[{"wave":1,"agents":[{"agent_id":"review-balanced-1","role":"review","tier":"balanced","route":{"provider":"example-provider","model":"balanced-model","effort":"medium"},"items":["pr-458"],"weight":2,"cost_units":6},{"agent_id":"review-deep-2","role":"review","tier":"deep","route":{"provider":"example-provider","model":"deep-model","effort":"high"},"items":["pr-460"],"weight":4,"cost_units":36}]}],"totals":{"agents":2,"items":2,"waves":1,"cost_units":42},"warnings":[{"code":"budget-exceeded","cost_units":42,"budget_units":40}]}"#
        );
    }
}
