//! Budget admission decisions for one project book.
//!
//! Rust port of `dashboard/budget-admission.mjs`. It applies one admission
//! operation to a project state document, validates a stored book by replaying
//! its operation log, and projects the public view the dashboard shows.
//!
//! This is admission control only: it reserves and settles reported money, it
//! never calls a provider, writes a file or releases a reservation on its own.
//! Amounts are decimal strings carried as integer nanounits, so the arithmetic
//! never rounds through a binary float.
//!
//! The exported actions mirror the JS module one for one:
//!
//! * `apply`    — `applyBudgetOperation(state, operation, input, now)`
//! * `validate` — `validateBudgetAdmission(state)`
//! * `public`   — `publicBudgetAdmission(state, liveJobs)`
//!
//! `dashboard/state.mjs` still imports the JS module in-process and calls
//! `validateBudgetAdmission` on every store open, `applyBudgetOperation` on
//! every budget `mutate` and `publicBudgetAdmission` on every public state
//! projection; `dashboard/budget-server.mjs` imports its `BudgetError` for the
//! status mapping. Deleting the JS module would therefore put a synchronous
//! Rust call on the store's hot path. This module lands alongside it; the
//! outputs are byte-identical, and `tests/budget_admission_cli.rs` pins the
//! same JSON the JS module produced.

use std::collections::BTreeMap;
use std::io::{Read, Write};

use anyhow::{anyhow, bail, Context, Result};
use serde_json::{json, Map, Value};

/// `scale = 1000000000n`: nanounits per whole currency unit.
const SCALE: u128 = 1_000_000_000;

/// `costSources` from `dashboard/cost-ledger.mjs`, in declaration order.
const COST_SOURCES: [&str; 4] = [
    "provider_usage",
    "cli_report",
    "api_estimate",
    "invoice_actual",
];

/// `policyKeys`, derived from the `object(input, [...])` call in `operate`.
const POLICY_KEYS: [&str; 15] = [
    "policy_id",
    "expected_revision",
    "run_id",
    "period_start",
    "period_end",
    "currency",
    "source_kind",
    "baseline",
    "baseline_basis",
    "soft_limit",
    "hard_limit",
    "call_reservation",
    "paused",
    "active",
    "reason",
];

/// `jobKeys`.
const JOB_KEYS: [&str; 3] = ["job_id", "run_id", "worker_id"];

/// `jobOnlyKeys`.
const JOB_ONLY_KEYS: [&str; 1] = ["job_id"];

/// `callKeys`.
const CALL_KEYS: [&str; 6] = [
    "job_id",
    "call_id",
    "session_id",
    "provider",
    "model",
    "purpose",
];

/// `finishKeys`.
const FINISH_KEYS: [&str; 4] = ["job_id", "call_id", "outcome", "tokens"];

/// `tokenKeys`.
const TOKEN_KEYS: [&str; 4] = ["input", "cached_input", "cache_write", "output"];

/// `usageKeys`.
const USAGE_KEYS: [&str; 8] = [
    "event_id",
    "call_id",
    "amount",
    "currency",
    "source_kind",
    "source_ref",
    "observed_at",
    "basis",
];

/// `immutableKeys`.
const IMMUTABLE_KEYS: [&str; 7] = [
    "run_id",
    "period_start",
    "period_end",
    "currency",
    "source_kind",
    "baseline",
    "baseline_basis",
];

/// `Number.MAX_SAFE_INTEGER`: the largest integer JS reports exactly.
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

/// `budget_audit_full` and the three per-collection caps all share this limit.
const AUDIT_LIMIT: usize = 10_000;
/// `budget_policies_full`.
const POLICY_LIMIT: usize = 100;

/// The error the JS module throws. The dashboard carries the whole message
/// instead of a short code, and derives the HTTP status from the message
/// suffix, so the port keeps the exact spelling and the same 400/409 split.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BudgetError {
    pub message: String,
    pub status: u16,
}

impl BudgetError {
    fn new(message: impl Into<String>) -> Self {
        let message = message.into();
        // `code.endsWith("conflict") ? 409 : 400`.
        let status = if message.ends_with("conflict") {
            409
        } else {
            400
        };
        Self { message, status }
    }

    /// `fail(code)`: the message is the code.
    fn code(code: &str) -> Self {
        Self::new(code)
    }
}

impl std::fmt::Display for BudgetError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Budget admission: {}", self.message)
    }
}

impl std::error::Error for BudgetError {}

type BudgetResult<T> = std::result::Result<T, BudgetError>;

/// `fail(code)`.
fn fail<T>(code: &str) -> BudgetResult<T> {
    Err(BudgetError::code(code))
}

/// `object(input, keys)`: an object whose every own key is in `keys`.
fn object<'a>(value: &'a Value, keys: &[&str]) -> BudgetResult<&'a Map<String, Value>> {
    match value.as_object() {
        Some(object) if object.keys().all(|key| keys.contains(&key.as_str())) => Ok(object),
        _ => fail("budget_invalid_input"),
    }
}

/// `Object.hasOwn(Object.prototype, value)`: the three legacy prototype names.
///
/// The check is on `Object.prototype`, so any value colliding with one of its
/// own properties is refused. Only `constructor`, `toString` and `__proto__`
/// are reachable through the identifier pattern, since it forbids neither
/// letters nor underscores.
fn is_prototype_name(value: &str) -> bool {
    matches!(
        value,
        "constructor"
            | "toString"
            | "toLocaleString"
            | "valueOf"
            | "hasOwnProperty"
            | "isPrototypeOf"
            | "propertyIsEnumerable"
            | "__defineGetter__"
            | "__defineSetter__"
            | "__lookupGetter__"
            | "__lookupSetter__"
            | "__proto__"
    )
}

/// `id(value)`: `/^[a-zA-Z0-9_.:-]{1,160}$/` plus the prototype-name refusal.
fn id(value: &Value) -> BudgetResult<String> {
    let Some(text) = value.as_str() else {
        return fail("budget_invalid_id");
    };
    // The pattern is ASCII-only, so a byte walk is the exact character count
    // as well.
    let bytes = text.as_bytes();
    let ok = !bytes.is_empty()
        && bytes.len() <= 160
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
        && !is_prototype_name(text);
    if !ok {
        return fail("budget_invalid_id");
    }
    Ok(text.to_string())
}

/// `text(value, max)`: a non-blank string of at most `max` characters with no
/// control character.
///
/// The JS pattern `[\x00-\x1f]` rejects the C0 range only (DEL passes), and
/// `String.prototype.length` and `.trim()` both work on UTF-16 code units.
fn text_max(value: &Value, max: usize) -> BudgetResult<String> {
    let Some(text) = value.as_str() else {
        return fail("budget_invalid_text");
    };
    let ok = !trim_js(text).is_empty()
        && text.encode_utf16().count() <= max
        && !text.chars().any(|ch| ch <= '\u{1f}');
    if !ok {
        return fail("budget_invalid_text");
    }
    Ok(text.to_string())
}

/// `text(value)`: the JS default limit of 1000 characters.
fn text(value: &Value) -> BudgetResult<String> {
    text_max(value, 1000)
}

/// ECMAScript `String.prototype.trim()`: WhiteSpace plus line terminators.
fn trim_js(text: &str) -> &str {
    let is_space = |ch: char| {
        matches!(
            ch,
            '\u{0009}'..='\u{000d}'
                | '\u{0020}'
                | '\u{00a0}'
                | '\u{1680}'
                | '\u{2000}'..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
        )
    };
    text.trim_matches(is_space)
}

/// `time(value)`: a `YYYY-MM-DDTHH:MM:SS[.mmm]Z` instant whose canonical
/// `toISOString()` spelling equals the input.
///
/// Unlike the cost-ledger port, the budget pattern is anchored on a required
/// `Z`, so a missing fraction and a 1..3 digit fraction are the only accepted
/// spellings; anything else fails the regex before `Date.parse` is consulted.
fn time(value: &Value) -> BudgetResult<String> {
    let Some(text) = value.as_str() else {
        return fail("budget_invalid_time");
    };
    let Some((year, month, day, hour, minute, second, millis)) = parse_timestamp(text) else {
        return fail("budget_invalid_time");
    };
    // `Number.isFinite(Date.parse(value))`: the Date parser rejects a month
    // outside 1..=12, a day outside 1..=31, hour 24 and the 60th minute or
    // second, but it *normalises* a day that overflows a shorter month
    // (2026-02-30 becomes 2026-03-02). The canonical check below then rejects
    // any spelling the parser had to normalise.
    if !(1..=12).contains(&month)
        || !(1..=31).contains(&day)
        || hour > 23
        || minute > 59
        || second > 59
    {
        return fail("budget_invalid_time");
    }
    let day_number = days_from_civil(year as i64, month as i64, 1) + (day as i64 - 1);
    let (canonical_year, canonical_month, canonical_day) = civil_from_days(day_number);
    let canonical = format!(
        "{canonical_year:04}-{canonical_month:02}-{canonical_day:02}T{hour:02}:{minute:02}:{second:02}.{millis:03}Z"
    );
    // `value.replace(/(?:\.(\d{1,3}))?Z$/, (_, part = "") => `.${part.padEnd(3,"0")}Z`)`.
    let expected = match text.len() {
        20 => format!("{}.000Z", &text[..19]),
        22 => format!("{}00Z", &text[..21]),
        23 => format!("{}0Z", &text[..22]),
        _ => text.to_string(),
    };
    if canonical != expected {
        return fail("budget_invalid_time");
    }
    Ok(canonical)
}

/// Match `^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$` and pull the fields.
#[allow(clippy::type_complexity)]
fn parse_timestamp(text: &str) -> Option<(i32, u32, u32, u32, u32, u32, u32)> {
    let bytes = text.as_bytes();
    let digits = |range: std::ops::Range<usize>| -> Option<u32> {
        let slice = bytes.get(range)?;
        if slice.iter().all(u8::is_ascii_digit) {
            std::str::from_utf8(slice).ok()?.parse().ok()
        } else {
            None
        }
    };
    // 20 bytes with no fraction, 22..=24 with one to three fraction digits.
    if !matches!(bytes.len(), 20 | 22 | 23 | 24) {
        return None;
    }
    if bytes[4] != b'-' || bytes[7] != b'-' || bytes[10] != b'T' || bytes[13] != b':' {
        return None;
    }
    if bytes[16] != b':' || *bytes.last()? != b'Z' {
        return None;
    }
    let millis = if bytes.len() > 20 {
        if bytes[19] != b'.' {
            return None;
        }
        let mut value = digits(20..(bytes.len() - 1))?;
        // `part.padEnd(3, "0")`.
        for _ in 0..(3 - (bytes.len() - 21)) {
            value *= 10;
        }
        value
    } else {
        0
    };
    Some((
        digits(0..4)? as i32,
        digits(5..7)?,
        digits(8..10)?,
        digits(11..13)?,
        digits(14..16)?,
        digits(17..19)?,
        millis,
    ))
}

/// Howard Hinnant's `days_from_civil`: the inverse of [`civil_from_days`].
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let yoe = year - era * 400;
    let mp = if month > 2 { month - 3 } else { month + 9 };
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// `civil_from_days`: days since 1970-01-01 back to a civil date.
fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// `units(value)`: the nonnegative decimal string as integer nanounits.
fn units(value: &str) -> BudgetResult<u128> {
    match parse_units(value) {
        Some(units) => Ok(units),
        None => fail("budget_invalid_amount"),
    }
}

/// `units(value)` where the JS caller already checked the `.test()` pattern;
/// reaching the parser with a bad string means the caller skipped that guard.
fn units_of(value: &Value) -> BudgetResult<u128> {
    match value.as_str() {
        Some(text) => units(text),
        None => fail("budget_invalid_amount"),
    }
}

/// `^\d{1,16}(?:\.\d{1,9})?$`, converted with the JS `BigInt` arithmetic:
/// `BigInt(whole) * scale + BigInt(part.padEnd(9, "0"))`.
///
/// JS writes `""` for the empty fraction (`"1.".split(".")` gives `""`), so
/// `BigInt("")` is `0n`, but the pattern already requires 1..=9 digits and this
/// parser is only reached through it.
fn parse_units(text: &str) -> Option<u128> {
    let (whole, fraction) = match text.split_once('.') {
        Some((whole, fraction)) => (whole, Some(fraction)),
        None => (text, None),
    };
    if whole.is_empty() || whole.len() > 16 || !whole.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let fraction_value = match fraction {
        None => 0,
        Some(fraction) => {
            if fraction.is_empty()
                || fraction.len() > 9
                || !fraction.bytes().all(|byte| byte.is_ascii_digit())
            {
                return None;
            }
            let mut padded = fraction.to_string();
            while padded.len() < 9 {
                padded.push('0');
            }
            padded.parse::<u128>().ok()?
        }
    };
    whole
        .parse::<u128>()
        .ok()?
        .checked_mul(SCALE)?
        .checked_add(fraction_value)
}

/// `money(value)`: integer nanounits back to the canonical decimal string,
/// with trailing fractional zeros stripped.
fn money(value: u128) -> String {
    let fraction = (value % SCALE).to_string();
    let fraction = format!("{fraction:0>9}");
    let fraction = fraction.trim_end_matches('0');
    let whole = value / SCALE;
    if fraction.is_empty() {
        whole.to_string()
    } else {
        format!("{whole}.{fraction}")
    }
}

/// `amount(value)`: `null` stays `null`, otherwise the canonical decimal.
fn amount(value: &Value) -> BudgetResult<Value> {
    if value.is_null() {
        return Ok(Value::Null);
    }
    Ok(Value::String(money(units_of(value)?)))
}

/// `ledger(state)`: the book, created with the JS field order when absent.
///
/// `state.budget_admission ||= {...}` only replaces a *falsy* value, so a
/// stored `null` (or `false`, `0`, `""`) is recreated while any other value is
/// used as-is and fails the later shape checks.
fn ledger(state: &mut Value) -> BudgetResult<()> {
    let Some(object) = state.as_object_mut() else {
        return fail("budget_invalid_input");
    };
    let present = object.get("budget_admission").map(|value| !is_falsy(value));
    if present != Some(true) {
        let project_id = object
            .get("project")
            .and_then(|project| project.get("id"))
            .cloned()
            .unwrap_or(Value::Null);
        let mut book = Map::new();
        book.insert("schema".into(), json!(1));
        book.insert("project_id".into(), project_id);
        for key in ["policies", "jobs", "calls", "receipts"] {
            book.insert(key.into(), Value::Object(Map::new()));
        }
        book.insert("decisions".into(), Value::Array(Vec::new()));
        book.insert("operations".into(), Value::Array(Vec::new()));
        object.insert("budget_admission".into(), Value::Object(book));
    }
    Ok(())
}

/// JavaScript truthiness for the JSON values `||=` observes.
fn is_falsy(value: &Value) -> bool {
    match value {
        Value::Null => true,
        Value::Bool(flag) => !flag,
        Value::Number(number) => number.as_f64().is_none_or(|value| value == 0.0),
        Value::String(text) => text.is_empty(),
        _ => false,
    }
}

/// The book as an object, after [`ledger`] has guaranteed the slot.
fn book_of(state: &Value) -> BudgetResult<&Map<String, Value>> {
    state
        .get("budget_admission")
        .and_then(Value::as_object)
        .ok_or_else(|| BudgetError::code("budget_invalid_input"))
}

/// `same(a, b)`: `JSON.stringify(a) === JSON.stringify(b)`.
///
/// `preserve_order` makes the serializer walk the map in insertion order, which
/// is the same order `JSON.stringify` walks a JS object, so a plain string
/// comparison is the exact JS behaviour.
fn same(left: &Value, right: &Value) -> bool {
    left == right
}

/// `decision(book, kind, data, now)`: append one audit entry.
///
/// The JS object literal spells `sequence`, `kind`, then the spread `data`,
/// then `recorded_at`. A `data` key that collides with `sequence` or `kind`
/// keeps its original position but takes the spread value, which is what
/// `Map::insert` on an existing key does too.
fn decision(
    book: &mut Map<String, Value>,
    kind: &str,
    data: Map<String, Value>,
    now: &str,
) -> BudgetResult<()> {
    let decisions = book
        .get_mut("decisions")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| BudgetError::code("budget_invalid_store"))?;
    let fail_full = decisions.len() >= AUDIT_LIMIT;
    if fail_full {
        return fail("budget_audit_full");
    }
    let mut entry = Map::new();
    entry.insert("sequence".into(), json!(decisions.len() + 1));
    entry.insert("kind".into(), json!(kind));
    for (key, value) in data {
        entry.insert(key, value);
    }
    entry.insert("recorded_at".into(), json!(now));
    decisions.push(Value::Object(entry));
    Ok(())
}

/// One policy's running totals: the JS `totalsByBook` cache entry.
#[derive(Debug, Clone, Default)]
struct Totals {
    /// `spent`: `null` when the policy has no baseline to anchor on.
    spent: Option<u128>,
    reserved: u128,
    executing: u64,
    awaiting: u64,
}

/// `totals(book, policy)`: the cached aggregate plus its `effective` sum.
///
/// The JS cache is a `WeakMap` from the book to a `Map` keyed by `policy_id`,
/// recomputed from the calls the first time a policy is seen and then updated
/// incrementally by [`update_cached_call_totals`]. The port keeps the same
/// per-book cache so the incremental updates stay observable.
fn totals(
    book: &Map<String, Value>,
    policy: &Map<String, Value>,
    cache: &mut TotalsCache,
) -> Totals {
    let policy_id = policy
        .get("policy_id")
        .and_then(Value::as_str)
        .unwrap_or("");
    if let Some(total) = cache.get(policy_id) {
        return total;
    }
    let baseline = policy.get("baseline").unwrap_or(&Value::Null);
    let mut total = Totals {
        spent: if baseline.is_null() {
            None
        } else {
            units_of(baseline).ok()
        },
        ..Totals::default()
    };
    if baseline.is_null() {
        total.spent = None;
    }
    if let Some(calls) = book.get("calls").and_then(Value::as_object) {
        for call in calls.values() {
            let Some(call) = call.as_object() else {
                continue;
            };
            let includes = call
                .get("policy_ids")
                .and_then(Value::as_array)
                .is_some_and(|ids| ids.iter().any(|id| id.as_str() == Some(policy_id)));
            if !includes {
                continue;
            }
            if !call.get("amount").unwrap_or(&Value::Null).is_null() {
                if let (Some(spent), Ok(amount)) = (
                    total.spent,
                    units_of(call.get("amount").unwrap_or(&Value::Null)),
                ) {
                    total.spent = Some(spent + amount);
                }
            } else {
                if let Ok(reservation) = units_of(call.get("reservation").unwrap_or(&Value::Null)) {
                    total.reserved += reservation;
                }
                if call.get("finished_at").unwrap_or(&Value::Null).is_null() {
                    total.executing += 1;
                } else {
                    total.awaiting += 1;
                }
            }
        }
    }
    cache.set(policy_id.to_string(), total.clone());
    total
}

/// `seedCachedPolicyTotals(book, policy)`.
fn seed_cached_policy_totals(cache: &mut TotalsCache, policy: &Map<String, Value>) {
    let policy_id = policy
        .get("policy_id")
        .and_then(Value::as_str)
        .unwrap_or("");
    let baseline = policy.get("baseline").unwrap_or(&Value::Null);
    cache.set(
        policy_id.to_string(),
        Totals {
            spent: if baseline.is_null() {
                None
            } else {
                units_of(baseline).ok()
            },
            ..Totals::default()
        },
    );
}

/// `updateCachedCallTotals(book, call, update)`: mutate the cached entry of
/// every policy the call touches.
fn update_cached_call_totals(
    cache: &mut TotalsCache,
    call: &Map<String, Value>,
    update: impl Fn(&mut Totals),
) {
    let Some(policy_ids) = call.get("policy_ids").and_then(Value::as_array) else {
        return;
    };
    for policy_id in policy_ids {
        let Some(policy_id) = policy_id.as_str() else {
            continue;
        };
        if let Some(total) = cache.get_mut(policy_id) {
            update(total);
        }
    }
}

/// The `WeakMap`-per-book policy total cache, kept as a plain map because one
/// CLI invocation only ever owns one book.
#[derive(Debug, Default)]
struct TotalsCache {
    entries: BTreeMap<String, Totals>,
}

impl TotalsCache {
    fn get(&self, policy_id: &str) -> Option<Totals> {
        self.entries.get(policy_id).cloned()
    }

    fn get_mut(&mut self, policy_id: &str) -> Option<&mut Totals> {
        self.entries.get_mut(policy_id)
    }

    fn set(&mut self, policy_id: String, total: Totals) {
        self.entries.insert(policy_id, total);
    }
}

/// `matched(book, runId)`: the active policies that scope this run, in the
/// book's insertion order.
fn matched(book: &Map<String, Value>, run_id: &str) -> Vec<Map<String, Value>> {
    let Some(policies) = book.get("policies").and_then(Value::as_object) else {
        return Vec::new();
    };
    policies
        .values()
        .filter_map(Value::as_object)
        .filter(|policy| {
            policy.get("active").and_then(Value::as_bool) == Some(true)
                && match policy.get("run_id") {
                    Some(Value::Null) | None => true,
                    Some(value) => value.as_str() == Some(run_id),
                }
        })
        .cloned()
        .collect()
}

/// `units(p.call_reservation)` for a policy the callers already validated.
fn reservation_of(policy: &Map<String, Value>) -> u128 {
    policy
        .get("call_reservation")
        .and_then(Value::as_str)
        .and_then(parse_units)
        .unwrap_or(0)
}

/// `units(p.soft_limit)` / `units(p.hard_limit)`.
fn limit_of(policy: &Map<String, Value>, key: &str) -> u128 {
    policy
        .get(key)
        .and_then(Value::as_str)
        .and_then(parse_units)
        .unwrap_or(0)
}

/// `assess(book, runId, now, reserve)`: whether the run may admit a call.
fn assess(
    book: &Map<String, Value>,
    cache: &mut TotalsCache,
    run_id: &str,
    now: &str,
    reserve: bool,
) -> Map<String, Value> {
    let policies = matched(book, run_id);
    let mut reason: Option<&'static str> = if policies.is_empty() {
        Some("budget_policy_missing")
    } else {
        None
    };
    let mut warning = false;
    let pending = if reserve {
        policies.iter().map(reservation_of).max().unwrap_or(0)
    } else {
        0
    };
    for policy in &policies {
        let total = totals(book, policy, cache);
        let effective = total.spent.map(|spent| spent + total.reserved);
        warning |= effective.is_some_and(|value| value + pending >= limit_of(policy, "soft_limit"));
        let period_start = policy
            .get("period_start")
            .and_then(Value::as_str)
            .unwrap_or("");
        let period_end = policy
            .get("period_end")
            .and_then(Value::as_str)
            .unwrap_or("");
        let paused = policy.get("paused").and_then(Value::as_bool) == Some(true);
        if paused {
            reason.get_or_insert("budget_paused");
        } else if now < period_start || now >= period_end {
            reason.get_or_insert("budget_period_closed");
        } else if effective.is_none() {
            reason.get_or_insert("budget_spend_unknown");
        } else if effective.is_some_and(|value| {
            value >= limit_of(policy, "hard_limit")
                || value + pending > limit_of(policy, "hard_limit")
        }) {
            reason.get_or_insert("budget_hard_limit");
        }
    }
    // `new Set(policies.map((p) => JSON.stringify([...])))`: the four-element
    // tuple serialises with no key ordering to worry about.
    let mut contexts: Vec<String> = Vec::new();
    for policy in &policies {
        let tuple = Value::Array(vec![
            policy.get("source_kind").cloned().unwrap_or(Value::Null),
            policy.get("currency").cloned().unwrap_or(Value::Null),
            policy.get("period_start").cloned().unwrap_or(Value::Null),
            policy.get("period_end").cloned().unwrap_or(Value::Null),
        ]);
        let text = serde_json::to_string(&tuple).unwrap_or_default();
        if !contexts.contains(&text) {
            contexts.push(text);
        }
    }
    if contexts.len() > 1 {
        reason.get_or_insert("budget_accounting_mismatch");
    }
    let mut policy_ids: Vec<String> = policies
        .iter()
        .map(|policy| {
            policy
                .get("policy_id")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string()
        })
        .collect();
    policy_ids.sort();
    let mut result = Map::new();
    result.insert("allowed".into(), json!(reason.is_none()));
    result.insert("warning".into(), json!(warning));
    result.insert(
        "reason".into(),
        match reason {
            Some(reason) => json!(reason),
            None => Value::Null,
        },
    );
    result.insert(
        "policy_ids".into(),
        Value::Array(policy_ids.into_iter().map(Value::String).collect()),
    );
    result
}

/// `applyBudgetOperation(state, operation, input, now)`.
///
/// `now` is passed in rather than read from the clock so the caller can pin it;
/// the CLI takes it from the request document.
pub fn apply_budget_operation(
    state: &mut Value,
    operation: &str,
    input: &Value,
    now: &str,
) -> BudgetResult<Value> {
    let now = time(&Value::String(now.to_string()))?;
    let mut cache = TotalsCache::default();
    ledger(state)?;
    let operation_count = book_of(state)?
        .get("operations")
        .and_then(Value::as_array)
        .map(Vec::len)
        .unwrap_or(0);
    if operation_count >= AUDIT_LIMIT {
        return fail("budget_audit_full");
    }
    let result = operate(state, &mut cache, operation, input, &now)?;
    let book = state
        .get_mut("budget_admission")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| BudgetError::code("budget_invalid_store"))?;
    let operations = book
        .get_mut("operations")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| BudgetError::code("budget_invalid_store"))?;
    let mut entry = Map::new();
    entry.insert("operation".into(), json!(operation));
    // `structuredClone(input)`: the stored copy must not alias the caller's.
    entry.insert("input".into(), input.clone());
    entry.insert("recorded_at".into(), json!(now));
    operations.push(Value::Object(entry));
    Ok(result)
}

/// `operate(state, operation, input, now)`.
fn operate(
    state: &mut Value,
    cache: &mut TotalsCache,
    operation: &str,
    input: &Value,
    now: &str,
) -> BudgetResult<Value> {
    match operation {
        "policy" => operate_policy(state, cache, input, now),
        "job" => operate_job(state, cache, input, now),
        "ready" | "close" => operate_hook(state, operation, input, now),
        "call" => operate_call(state, cache, input, now),
        "finish" => operate_finish(state, cache, input, now),
        "usage" => operate_usage(state, cache, input, now),
        _ => fail("budget_unknown_operation"),
    }
}

/// `operation === "policy"`.
fn operate_policy(
    state: &mut Value,
    cache: &mut TotalsCache,
    input: &Value,
    now: &str,
) -> BudgetResult<Value> {
    let input = object(input, &POLICY_KEYS)?.clone();
    let policy_id = id(input.get("policy_id").unwrap_or(&Value::Null))?;
    let previous = book_of(state)?
        .get("policies")
        .and_then(Value::as_object)
        .and_then(|policies| policies.get(&policy_id))
        .and_then(Value::as_object)
        .cloned();
    let expected_revision = input.get("expected_revision").unwrap_or(&Value::Null);
    let revision_ok = expected_revision
        .as_f64()
        .is_some_and(|value| value.fract() == 0.0 && value.abs() <= MAX_SAFE_INTEGER);
    let expected_revision = expected_revision.as_f64().unwrap_or(f64::NAN);
    let stored_revision = previous
        .as_ref()
        .and_then(|policy| policy.get("revision"))
        .and_then(Value::as_f64)
        .unwrap_or(0.0);
    if !revision_ok || expected_revision != stored_revision {
        return fail("budget_policy_revision_conflict");
    }

    let mut policy = Map::new();
    policy.insert("policy_id".into(), json!(policy_id));
    // `expected_revision + 1`: JS numbers are all doubles, but `JSON.stringify`
    // prints an integral value with no `.0`, so the sum is emitted as an
    // integer. `json!(f64)` would print `1.0`.
    policy.insert(
        "revision".into(),
        Value::Number(serde_json::Number::from((expected_revision + 1.0) as i64)),
    );
    policy.insert(
        "run_id".into(),
        match input.get("run_id") {
            Some(Value::Null) | None => Value::Null,
            Some(value) => json!(id(value)?),
        },
    );
    policy.insert(
        "period_start".into(),
        json!(time(input.get("period_start").unwrap_or(&Value::Null))?),
    );
    policy.insert(
        "period_end".into(),
        json!(time(input.get("period_end").unwrap_or(&Value::Null))?),
    );
    policy.insert(
        "currency".into(),
        input.get("currency").cloned().unwrap_or(Value::Null),
    );
    policy.insert(
        "source_kind".into(),
        input.get("source_kind").cloned().unwrap_or(Value::Null),
    );
    policy.insert(
        "baseline".into(),
        amount(input.get("baseline").unwrap_or(&Value::Null))?,
    );
    policy.insert(
        "baseline_basis".into(),
        json!(text(input.get("baseline_basis").unwrap_or(&Value::Null))?),
    );
    policy.insert(
        "soft_limit".into(),
        amount(input.get("soft_limit").unwrap_or(&Value::Null))?,
    );
    policy.insert(
        "hard_limit".into(),
        amount(input.get("hard_limit").unwrap_or(&Value::Null))?,
    );
    policy.insert(
        "call_reservation".into(),
        amount(input.get("call_reservation").unwrap_or(&Value::Null))?,
    );
    policy.insert(
        "paused".into(),
        input.get("paused").cloned().unwrap_or(Value::Null),
    );
    policy.insert(
        "active".into(),
        input.get("active").cloned().unwrap_or(Value::Null),
    );
    let reason = text(input.get("reason").unwrap_or(&Value::Null))?;

    let currency = policy.get("currency").and_then(Value::as_str).unwrap_or("");
    let source_kind = policy
        .get("source_kind")
        .and_then(Value::as_str)
        .unwrap_or("");
    let shape_ok = currency.len() == 3
        && currency.bytes().all(|byte| byte.is_ascii_uppercase())
        && COST_SOURCES.contains(&source_kind)
        && policy.get("paused").is_some_and(Value::is_boolean)
        && policy.get("active").is_some_and(Value::is_boolean)
        && policy
            .get("period_start")
            .and_then(Value::as_str)
            .unwrap_or("")
            < policy
                .get("period_end")
                .and_then(Value::as_str)
                .unwrap_or("")
        && !policy.get("soft_limit").unwrap_or(&Value::Null).is_null()
        && !policy.get("hard_limit").unwrap_or(&Value::Null).is_null()
        && !policy
            .get("call_reservation")
            .unwrap_or(&Value::Null)
            .is_null()
        && limit_of(&policy, "soft_limit") <= limit_of(&policy, "hard_limit")
        && reservation_of(&policy) != 0;
    if !shape_ok {
        return fail("budget_invalid_policy");
    }

    if let Some(previous) = &previous {
        for key in IMMUTABLE_KEYS {
            if policy.get(key) != previous.get(key) {
                return fail("budget_accounting_immutable_conflict");
            }
        }
        let active = policy.get("active").and_then(Value::as_bool) == Some(true);
        let has_open_call = book_of(state)?
            .get("calls")
            .and_then(Value::as_object)
            .is_some_and(|calls| {
                calls.values().filter_map(Value::as_object).any(|call| {
                    call.get("policy_ids")
                        .and_then(Value::as_array)
                        .is_some_and(|ids| ids.iter().any(|id| id.as_str() == Some(&policy_id)))
                        && call.get("amount").unwrap_or(&Value::Null).is_null()
                })
            });
        if !active && has_open_call {
            return fail("budget_unconfirmed_calls_conflict");
        }
    } else {
        let count = book_of(state)?
            .get("policies")
            .and_then(Value::as_object)
            .map(Map::len)
            .unwrap_or(0);
        if count >= POLICY_LIMIT {
            return fail("budget_policies_full");
        }
    }

    let book = state
        .get_mut("budget_admission")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| BudgetError::code("budget_invalid_store"))?;
    if previous.is_none() {
        seed_cached_policy_totals(cache, &policy);
    }
    book.get_mut("policies")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| BudgetError::code("budget_invalid_store"))?
        .insert(policy_id, Value::Object(policy.clone()));

    let mut data = Map::new();
    data.insert("policy".into(), Value::Object(policy.clone()));
    data.insert("reason".into(), json!(reason));
    data.insert("actor".into(), json!("local_administrator"));
    let book = state
        .get_mut("budget_admission")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| BudgetError::code("budget_invalid_store"))?;
    decision(book, "policy", data, now)?;
    Ok(Value::Object(policy))
}

/// `operation === "job"`.
fn operate_job(
    state: &mut Value,
    cache: &mut TotalsCache,
    input: &Value,
    now: &str,
) -> BudgetResult<Value> {
    let input = object(input, &JOB_KEYS)?.clone();
    let job_id = id(input.get("job_id").unwrap_or(&Value::Null))?;
    let run_id = id(input.get("run_id").unwrap_or(&Value::Null))?;
    let worker_id = id(input.get("worker_id").unwrap_or(&Value::Null))?;
    let exists = book_of(state)?
        .get("jobs")
        .and_then(Value::as_object)
        .is_some_and(|jobs| jobs.contains_key(&job_id));
    if exists {
        return fail("budget_job_replay_conflict");
    }
    let count = book_of(state)?
        .get("jobs")
        .and_then(Value::as_object)
        .map(Map::len)
        .unwrap_or(0);
    if count >= AUDIT_LIMIT {
        return fail("budget_jobs_full");
    }
    let result = assess(book_of(state)?, cache, &run_id, now, false);
    let mut data = Map::new();
    data.insert("job_id".into(), json!(job_id));
    data.insert("run_id".into(), json!(run_id));
    data.insert("worker_id".into(), json!(worker_id));
    for (key, value) in result.clone() {
        data.insert(key, value);
    }
    let book = state
        .get_mut("budget_admission")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| BudgetError::code("budget_invalid_store"))?;
    decision(book, "job", data, now)?;

    if result.get("allowed").and_then(Value::as_bool) == Some(true) {
        let mut job = Map::new();
        job.insert("job_id".into(), json!(job_id));
        job.insert("run_id".into(), json!(run_id));
        job.insert("worker_id".into(), json!(worker_id));
        job.insert("admitted_at".into(), json!(now));
        job.insert("registered_at".into(), Value::Null);
        job.insert("closed_at".into(), Value::Null);
        state
            .get_mut("budget_admission")
            .and_then(Value::as_object_mut)
            .and_then(|book| book.get_mut("jobs"))
            .and_then(Value::as_object_mut)
            .ok_or_else(|| BudgetError::code("budget_invalid_store"))?
            .insert(job_id.clone(), Value::Object(job));
    }
    let mut output = Map::new();
    output.insert("job_id".into(), json!(job_id));
    for (key, value) in result {
        output.insert(key, value);
    }
    Ok(Value::Object(output))
}

/// `operation === "ready" || operation === "close"`.
fn operate_hook(
    state: &mut Value,
    operation: &str,
    input: &Value,
    now: &str,
) -> BudgetResult<Value> {
    let input = object(input, &JOB_ONLY_KEYS)?.clone();
    let job_id = id(input.get("job_id").unwrap_or(&Value::Null))?;
    let job = book_of(state)?
        .get("jobs")
        .and_then(Value::as_object)
        .and_then(|jobs| jobs.get(&job_id))
        .and_then(Value::as_object)
        .cloned();
    let Some(mut job) = job else {
        return fail("budget_job_unavailable");
    };
    if !job.get("closed_at").unwrap_or(&Value::Null).is_null() {
        return fail("budget_job_unavailable");
    }
    if operation == "ready" {
        if !job.get("registered_at").unwrap_or(&Value::Null).is_null() {
            return fail("budget_hook_replay_conflict");
        }
        job.insert("registered_at".into(), json!(now));
    } else {
        job.insert("closed_at".into(), json!(now));
    }
    let stored_job_id = job.get("job_id").cloned().unwrap_or(Value::Null);
    state
        .get_mut("budget_admission")
        .and_then(Value::as_object_mut)
        .and_then(|book| book.get_mut("jobs"))
        .and_then(Value::as_object_mut)
        .ok_or_else(|| BudgetError::code("budget_invalid_store"))?
        .insert(job_id, Value::Object(job.clone()));

    let mut data = Map::new();
    data.insert("job_id".into(), stored_job_id);
    let book = state
        .get_mut("budget_admission")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| BudgetError::code("budget_invalid_store"))?;
    decision(book, operation, data, now)?;
    Ok(Value::Object(job))
}

/// `operation === "call"`.
fn operate_call(
    state: &mut Value,
    cache: &mut TotalsCache,
    input: &Value,
    now: &str,
) -> BudgetResult<Value> {
    let input = object(input, &CALL_KEYS)?.clone();
    let job_id = id(input.get("job_id").unwrap_or(&Value::Null))?;
    let call_id = id(input.get("call_id").unwrap_or(&Value::Null))?;
    let job = book_of(state)?
        .get("jobs")
        .and_then(Value::as_object)
        .and_then(|jobs| jobs.get(&job_id))
        .and_then(Value::as_object)
        .cloned();
    let Some(job) = job else {
        return fail("budget_hook_unavailable");
    };
    if !job.get("closed_at").unwrap_or(&Value::Null).is_null()
        || job.get("registered_at").unwrap_or(&Value::Null).is_null()
    {
        return fail("budget_hook_unavailable");
    }
    let replay = book_of(state)?
        .get("calls")
        .and_then(Value::as_object)
        .is_some_and(|calls| calls.contains_key(&call_id));
    if replay {
        let mut output = Map::new();
        output.insert("allowed".into(), json!(false));
        output.insert("reason".into(), json!("budget_call_replay"));
        output.insert("call_id".into(), json!(call_id));
        return Ok(Value::Object(output));
    }
    let count = book_of(state)?
        .get("calls")
        .and_then(Value::as_object)
        .map(Map::len)
        .unwrap_or(0);
    if count >= AUDIT_LIMIT {
        return fail("budget_calls_full");
    }
    let session_id = match input.get("session_id") {
        Some(Value::Null) | None => Value::Null,
        Some(value) => json!(text_max(value, 160)?),
    };
    let provider = text_max(input.get("provider").unwrap_or(&Value::Null), 160)?;
    let model = text_max(input.get("model").unwrap_or(&Value::Null), 160)?;
    let purpose = match input.get("purpose") {
        Some(Value::Null) | None => Value::Null,
        Some(value) => json!(text_max(value, 80)?),
    };
    let run_id = job
        .get("run_id")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let result = assess(book_of(state)?, cache, &run_id, now, true);

    let mut data = Map::new();
    data.insert("call_id".into(), json!(call_id));
    data.insert("job_id".into(), json!(job_id));
    data.insert("provider".into(), json!(provider));
    data.insert("model".into(), json!(model));
    data.insert("session_id".into(), session_id.clone());
    for (key, value) in result.clone() {
        data.insert(key, value);
    }
    let book = state
        .get_mut("budget_admission")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| BudgetError::code("budget_invalid_store"))?;
    decision(book, "call", data, now)?;

    if result.get("allowed").and_then(Value::as_bool) != Some(true) {
        let mut output = Map::new();
        output.insert("call_id".into(), json!(call_id));
        for (key, value) in result {
            output.insert(key, value);
        }
        return Ok(Value::Object(output));
    }
    let policy_ids: Vec<String> = result
        .get("policy_ids")
        .and_then(Value::as_array)
        .map(|ids| {
            ids.iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    let policies = book_of(state)?
        .get("policies")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let selected: Vec<Map<String, Value>> = policy_ids
        .iter()
        .filter_map(|policy_id| policies.get(policy_id).and_then(Value::as_object).cloned())
        .collect();
    let reservation = selected.iter().map(reservation_of).max().unwrap_or(0);
    // `policies[0]`: `assess` always found at least one matching policy here,
    // because an empty match is a denial.
    let Some(first) = selected.first() else {
        return fail("budget_policy_missing");
    };
    let currency = first.get("currency").cloned().unwrap_or(Value::Null);
    let source_kind = first.get("source_kind").cloned().unwrap_or(Value::Null);

    let mut call = Map::new();
    call.insert("call_id".into(), json!(call_id));
    call.insert("job_id".into(), json!(job_id));
    call.insert(
        "run_id".into(),
        job.get("run_id").cloned().unwrap_or(Value::Null),
    );
    call.insert(
        "worker_id".into(),
        job.get("worker_id").cloned().unwrap_or(Value::Null),
    );
    call.insert("session_id".into(), session_id);
    call.insert("provider".into(), json!(provider));
    call.insert("model".into(), json!(model));
    call.insert("purpose".into(), purpose);
    call.insert(
        "policy_ids".into(),
        Value::Array(policy_ids.into_iter().map(Value::String).collect()),
    );
    call.insert("currency".into(), currency.clone());
    call.insert("source_kind".into(), source_kind);
    call.insert("reservation".into(), json!(money(reservation)));
    call.insert("admitted_at".into(), json!(now));
    call.insert("finished_at".into(), Value::Null);
    call.insert("outcome".into(), Value::Null);
    call.insert("tokens".into(), Value::Null);
    call.insert("amount".into(), Value::Null);
    call.insert("receipt_id".into(), Value::Null);
    update_cached_call_totals(cache, &call, |total| {
        total.reserved += reservation;
        total.executing += 1;
    });
    state
        .get_mut("budget_admission")
        .and_then(Value::as_object_mut)
        .and_then(|book| book.get_mut("calls"))
        .and_then(Value::as_object_mut)
        .ok_or_else(|| BudgetError::code("budget_invalid_store"))?
        .insert(call_id.clone(), Value::Object(call));

    let mut output = Map::new();
    output.insert("call_id".into(), json!(call_id));
    output.insert("reservation".into(), json!(money(reservation)));
    output.insert("currency".into(), currency);
    for (key, value) in result {
        output.insert(key, value);
    }
    Ok(Value::Object(output))
}

/// `operation === "finish"`.
fn operate_finish(
    state: &mut Value,
    cache: &mut TotalsCache,
    input: &Value,
    now: &str,
) -> BudgetResult<Value> {
    let input = object(input, &FINISH_KEYS)?.clone();
    let call_id = id(input.get("call_id").unwrap_or(&Value::Null))?;
    let job_id = id(input.get("job_id").unwrap_or(&Value::Null))?;
    let call = book_of(state)?
        .get("calls")
        .and_then(Value::as_object)
        .and_then(|calls| calls.get(&call_id))
        .and_then(Value::as_object)
        .cloned();
    let Some(mut call) = call else {
        return fail("budget_call_missing");
    };
    if call.get("job_id").and_then(Value::as_str) != Some(job_id.as_str()) {
        return fail("budget_call_missing");
    }
    let outcome = input.get("outcome").cloned().unwrap_or(Value::Null);
    if !matches!(
        outcome.as_str(),
        Some("finished" | "interrupted" | "failed")
    ) {
        return fail("budget_invalid_outcome");
    }
    let mut tokens = Value::Null;
    if !input.get("tokens").unwrap_or(&Value::Null).is_null() {
        let tokens_input =
            object(input.get("tokens").unwrap_or(&Value::Null), &TOKEN_KEYS)?.clone();
        let mut stored = Map::new();
        for key in TOKEN_KEYS {
            let value = tokens_input.get(key).cloned().unwrap_or(Value::Null);
            if !value.is_null() {
                let ok = value
                    .as_f64()
                    .is_some_and(|number| number.fract() == 0.0 && number >= 0.0)
                    && value.as_f64().unwrap_or(f64::NAN) <= MAX_SAFE_INTEGER;
                if !ok {
                    return fail("budget_invalid_tokens");
                }
            }
            stored.insert(key.to_string(), value);
        }
        tokens = Value::Object(stored);
    }

    if !call.get("finished_at").unwrap_or(&Value::Null).is_null() {
        if call.get("outcome") != Some(&outcome)
            || !same(call.get("tokens").unwrap_or(&Value::Null), &tokens)
        {
            return fail("budget_finish_conflict");
        }
        return Ok(Value::Object(call));
    }
    call.insert("finished_at".into(), json!(now));
    call.insert("outcome".into(), outcome);
    call.insert("tokens".into(), tokens);
    if call.get("amount").unwrap_or(&Value::Null).is_null() {
        update_cached_call_totals(cache, &call, |total| {
            total.executing = total.executing.saturating_sub(1);
            total.awaiting += 1;
        });
    }
    state
        .get_mut("budget_admission")
        .and_then(Value::as_object_mut)
        .and_then(|book| book.get_mut("calls"))
        .and_then(Value::as_object_mut)
        .ok_or_else(|| BudgetError::code("budget_invalid_store"))?
        .insert(call_id.clone(), Value::Object(call.clone()));

    let mut data = Map::new();
    data.insert(
        "call_id".into(),
        call.get("call_id").cloned().unwrap_or(Value::Null),
    );
    data.insert(
        "outcome".into(),
        input.get("outcome").cloned().unwrap_or(Value::Null),
    );
    let book = state
        .get_mut("budget_admission")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| BudgetError::code("budget_invalid_store"))?;
    decision(book, "finish", data, now)?;
    Ok(Value::Object(call))
}

/// `operation === "usage"`.
fn operate_usage(
    state: &mut Value,
    cache: &mut TotalsCache,
    input: &Value,
    now: &str,
) -> BudgetResult<Value> {
    let input = object(input, &USAGE_KEYS)?.clone();
    let mut receipt = Map::new();
    receipt.insert(
        "event_id".into(),
        json!(id(input.get("event_id").unwrap_or(&Value::Null))?),
    );
    receipt.insert(
        "call_id".into(),
        json!(id(input.get("call_id").unwrap_or(&Value::Null))?),
    );
    receipt.insert(
        "amount".into(),
        amount(input.get("amount").unwrap_or(&Value::Null))?,
    );
    receipt.insert(
        "currency".into(),
        input.get("currency").cloned().unwrap_or(Value::Null),
    );
    receipt.insert(
        "source_kind".into(),
        input.get("source_kind").cloned().unwrap_or(Value::Null),
    );
    receipt.insert(
        "source_ref".into(),
        json!(text(input.get("source_ref").unwrap_or(&Value::Null))?),
    );
    receipt.insert(
        "observed_at".into(),
        json!(time(input.get("observed_at").unwrap_or(&Value::Null))?),
    );
    receipt.insert(
        "basis".into(),
        json!(text(input.get("basis").unwrap_or(&Value::Null))?),
    );
    let event_id = receipt
        .get("event_id")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let call_id = receipt
        .get("call_id")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();

    let old = book_of(state)?
        .get("receipts")
        .and_then(Value::as_object)
        .and_then(|receipts| receipts.get(&event_id))
        .cloned();
    if let Some(old) = old {
        if !same(&old, &Value::Object(receipt)) {
            return fail("budget_receipt_conflict");
        }
        return Ok(old);
    }
    let call = book_of(state)?
        .get("calls")
        .and_then(Value::as_object)
        .and_then(|calls| calls.get(&call_id))
        .and_then(Value::as_object)
        .cloned();
    let Some(mut call) = call else {
        return fail("budget_call_not_finished");
    };
    if call.get("finished_at").unwrap_or(&Value::Null).is_null() {
        return fail("budget_call_not_finished");
    }
    let receipt_currency = receipt
        .get("currency")
        .and_then(Value::as_str)
        .unwrap_or("");
    let receipt_source = receipt
        .get("source_kind")
        .and_then(Value::as_str)
        .unwrap_or("");
    let receipt_observed = receipt
        .get("observed_at")
        .and_then(Value::as_str)
        .unwrap_or("");
    let call_finished = call
        .get("finished_at")
        .and_then(Value::as_str)
        .unwrap_or("");
    if receipt_currency != call.get("currency").and_then(Value::as_str).unwrap_or("")
        || receipt_source
            != call
                .get("source_kind")
                .and_then(Value::as_str)
                .unwrap_or("")
        || receipt_observed < call_finished
        || receipt_observed > now
    {
        return fail("budget_receipt_context_conflict");
    }
    if !call.get("receipt_id").unwrap_or(&Value::Null).is_null()
        && receipt.get("amount") != call.get("amount")
    {
        return fail("budget_settlement_conflict");
    }
    let count = book_of(state)?
        .get("receipts")
        .and_then(Value::as_object)
        .map(Map::len)
        .unwrap_or(0);
    if count >= AUDIT_LIMIT {
        return fail("budget_receipts_full");
    }
    state
        .get_mut("budget_admission")
        .and_then(Value::as_object_mut)
        .and_then(|book| book.get_mut("receipts"))
        .and_then(Value::as_object_mut)
        .ok_or_else(|| BudgetError::code("budget_invalid_store"))?
        .insert(event_id.clone(), Value::Object(receipt.clone()));

    if !receipt.get("amount").unwrap_or(&Value::Null).is_null() {
        let amount_units = units_of(receipt.get("amount").unwrap_or(&Value::Null))?;
        if call.get("amount").unwrap_or(&Value::Null).is_null() {
            let reservation = call
                .get("reservation")
                .and_then(Value::as_str)
                .and_then(parse_units)
                .unwrap_or(0);
            let finished = !call.get("finished_at").unwrap_or(&Value::Null).is_null();
            update_cached_call_totals(cache, &call, |total| {
                total.reserved = total.reserved.saturating_sub(reservation);
                if let Some(spent) = total.spent.as_mut() {
                    *spent += amount_units;
                }
                if finished {
                    total.awaiting = total.awaiting.saturating_sub(1);
                } else {
                    total.executing = total.executing.saturating_sub(1);
                }
            });
        }
        let amount_value = receipt.get("amount").cloned().unwrap_or(Value::Null);
        if call.get("receipt_id").unwrap_or(&Value::Null).is_null() {
            call.insert("receipt_id".into(), json!(event_id));
        }
        call.insert("amount".into(), amount_value);
        state
            .get_mut("budget_admission")
            .and_then(Value::as_object_mut)
            .and_then(|book| book.get_mut("calls"))
            .and_then(Value::as_object_mut)
            .ok_or_else(|| BudgetError::code("budget_invalid_store"))?
            .insert(call_id, Value::Object(call));
    }

    let mut data = receipt.clone();
    data.insert("actor".into(), json!("local_administrator"));
    let book = state
        .get_mut("budget_admission")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| BudgetError::code("budget_invalid_store"))?;
    decision(book, "usage", data, now)?;
    Ok(Value::Object(receipt))
}

/// `validateBudgetAdmission(state)`: replay the stored operation log and
/// require the result to equal the stored book.
pub fn validate_budget_admission(state: &Value) -> BudgetResult<()> {
    let Some(book) = state.get("budget_admission") else {
        return Ok(());
    };
    let store_ok = book.as_object().is_some_and(|book| {
        book.get("schema").and_then(Value::as_i64) == Some(1)
            && book.get("project_id") == state.get("project").and_then(|project| project.get("id"))
            && book
                .get("operations")
                .and_then(Value::as_array)
                .is_some_and(|operations| operations.len() <= AUDIT_LIMIT)
    });
    if !store_ok {
        return fail("budget_invalid_store");
    }
    // Replay canonical records, so damaged amounts, policy revisions and scope
    // IDs cannot quietly turn into a zero-spend admission after a restart.
    let mut replay = Map::new();
    replay.insert(
        "project".into(),
        state.get("project").cloned().unwrap_or(Value::Null),
    );
    let mut replay = Value::Object(replay);
    let operations = book
        .get("operations")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for operation in operations {
        let operation_name = operation
            .get("operation")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let input = operation.get("input").cloned().unwrap_or(Value::Null);
        let recorded_at = operation
            .get("recorded_at")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        apply_budget_operation(&mut replay, &operation_name, &input, &recorded_at)?;
    }
    if !same(replay.get("budget_admission").unwrap_or(&Value::Null), book) {
        return fail("budget_invalid_audit");
    }
    Ok(())
}

/// `publicBudgetAdmission(state, liveJobs)`.
///
/// `now` is passed in rather than read from the clock, matching the CLI
/// contract that every externally observed value comes from the request.
pub fn public_budget_admission(state: &Value, live_jobs: &Value, now: &str) -> BudgetResult<Value> {
    let Some(book) = state.get("budget_admission") else {
        return Ok(Value::Null);
    };
    if is_falsy(book) {
        return Ok(Value::Null);
    }
    let book = book
        .as_object()
        .ok_or_else(|| BudgetError::code("budget_invalid_store"))?;
    let mut cache = TotalsCache::default();
    let mut output = Map::new();
    output.insert("schema".into(), json!(1));
    output.insert(
        "project_id".into(),
        book.get("project_id").cloned().unwrap_or(Value::Null),
    );

    let mut policies = Vec::new();
    for policy in book
        .get("policies")
        .and_then(Value::as_object)
        .map(|policies| policies.values().cloned().collect::<Vec<_>>())
        .unwrap_or_default()
    {
        let Some(policy) = policy.as_object() else {
            continue;
        };
        let total = totals(book, policy, &mut cache);
        let effective = total.spent.map(|spent| spent + total.reserved);
        let hard_limit = limit_of(policy, "hard_limit");
        let soft_limit = limit_of(policy, "soft_limit");
        let reservation = reservation_of(policy);
        let active = policy.get("active").and_then(Value::as_bool) == Some(true);
        let paused = policy.get("paused").and_then(Value::as_bool) == Some(true);
        let period_start = policy
            .get("period_start")
            .and_then(Value::as_str)
            .unwrap_or("");
        let period_end = policy
            .get("period_end")
            .and_then(Value::as_str)
            .unwrap_or("");
        let mut entry = policy.clone();
        entry.insert(
            "spent".into(),
            match total.spent {
                Some(spent) => json!(money(spent)),
                None => Value::Null,
            },
        );
        entry.insert("reserved".into(), json!(money(total.reserved)));
        entry.insert(
            "effective".into(),
            match effective {
                Some(value) => json!(money(value)),
                None => Value::Null,
            },
        );
        entry.insert("executing".into(), json!(total.executing));
        entry.insert("awaiting_usage".into(), json!(total.awaiting));
        entry.insert(
            "next_call_fits".into(),
            json!(
                active
                    && !paused
                    && now >= period_start
                    && now < period_end
                    && effective.is_some_and(|value| value < hard_limit)
                    && effective.is_some_and(|value| value + reservation <= hard_limit)
            ),
        );
        let status = if !active {
            "inactive"
        } else if paused {
            "paused"
        } else if now < period_start || now >= period_end {
            "period_closed"
        } else if effective.is_none() {
            "unknown"
        } else if effective.is_some_and(|value| value >= hard_limit) {
            "blocked"
        } else if effective.is_some_and(|value| value >= soft_limit) {
            "warning"
        } else {
            "within_budget"
        };
        entry.insert("status".into(), json!(status));
        entry.insert(
            "overspend".into(),
            match total.spent {
                Some(spent) if spent > hard_limit => json!(money(spent - hard_limit)),
                _ => json!("0"),
            },
        );
        policies.push(Value::Object(entry));
    }
    output.insert("policies".into(), Value::Array(policies));

    let mut jobs = Vec::new();
    for job in book
        .get("jobs")
        .and_then(Value::as_object)
        .map(|jobs| jobs.values().cloned().collect::<Vec<_>>())
        .unwrap_or_default()
    {
        let Some(job) = job.as_object() else {
            continue;
        };
        let job_id = job.get("job_id").and_then(Value::as_str).unwrap_or("");
        let enforcement = if !job.get("closed_at").unwrap_or(&Value::Null).is_null() {
            "stopped"
        } else if live_jobs.get(job_id) == Some(&Value::Bool(true)) {
            "guard_registered"
        } else {
            "unknown"
        };
        let mut entry = job.clone();
        entry.insert("enforcement".into(), json!(enforcement));
        jobs.push(Value::Object(entry));
    }
    output.insert("jobs".into(), Value::Array(jobs));

    let mut calls = Vec::new();
    for call in book
        .get("calls")
        .and_then(Value::as_object)
        .map(|calls| calls.values().cloned().collect::<Vec<_>>())
        .unwrap_or_default()
    {
        let Some(call) = call.as_object() else {
            continue;
        };
        let accounting = if call.get("amount").unwrap_or(&Value::Null).is_null() {
            "unconfirmed"
        } else {
            "source_reported"
        };
        let mut entry = call.clone();
        entry.insert("accounting".into(), json!(accounting));
        calls.push(Value::Object(entry));
    }
    output.insert("calls".into(), Value::Array(calls));
    output.insert(
        "decisions".into(),
        book.get("decisions").cloned().unwrap_or(Value::Null),
    );
    Ok(Value::Object(output))
}

/// Read one JSON request document, refusing anything over 256 KiB.
fn read_json(input_file: &str) -> Result<Value> {
    const MAX_INPUT_BYTES: usize = 256 * 1024;
    let metadata =
        std::fs::metadata(input_file).with_context(|| format!("cannot read JSON {input_file}"))?;
    if !metadata.is_file() || metadata.len() > MAX_INPUT_BYTES as u64 {
        bail!("Input JSON must be a regular file of at most 256 KiB");
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    std::fs::File::open(input_file)
        .with_context(|| format!("cannot read JSON {input_file}"))?
        .take((MAX_INPUT_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .with_context(|| format!("cannot read JSON {input_file}"))?;
    if bytes.len() > MAX_INPUT_BYTES {
        bail!("Input JSON exceeds 256 KiB");
    }
    let Ok(text) = std::str::from_utf8(&bytes) else {
        bail!("Input JSON is invalid");
    };
    // TextDecoder("utf-8") in the dashboard CLI removed a leading BOM.
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    serde_json::from_str(text).map_err(|_| anyhow!("Input JSON is invalid"))
}

/// The document shape every action accepts: `{ operation, state, input, now,
/// live_jobs }`. Only `operation` and `state` are always required.
fn read_request(document: &Value) -> Result<(String, Value, Value, String, Value)> {
    let object = document
        .as_object()
        .ok_or_else(|| anyhow!("Input JSON is invalid"))?;
    const CLI_KEYS: [&str; 5] = ["operation", "state", "input", "now", "live_jobs"];
    if object.keys().any(|key| !CLI_KEYS.contains(&key.as_str())) {
        bail!("Input JSON is invalid");
    }
    let operation = object
        .get("operation")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let state = object
        .get("state")
        .filter(|value| value.is_object())
        .cloned()
        .ok_or_else(|| anyhow!("Input JSON is invalid"))?;
    let input = object.get("input").cloned().unwrap_or(Value::Null);
    let now = object
        .get("now")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let live_jobs = object.get("live_jobs").cloned().unwrap_or(Value::Null);
    Ok((operation, state, input, now, live_jobs))
}

/// `rdsh budget-admission <apply|validate|public> --input-file`.
///
/// The file holds `{ operation, state, input, now, live_jobs }`: `state` is the
/// project state document, `input` the operation `apply` merges and `now` the
/// timestamp the JS caller would have read from the clock. `validate` and
/// `public` read `state` alone and accept a missing `input`.
/// The admission operations `apply` accepts, in JS declaration order.
const ALL_OPERATIONS: [&str; 7] = ["policy", "job", "ready", "close", "call", "finish", "usage"];

/// `rdsh budget-admission <apply|validate|public> --input-file`.
///
/// The file holds `{ operation, state, input, now, live_jobs }`. For `apply`,
/// `operation` names the JS admission operation (`policy`, `job`, `ready`,
/// `close`, `call`, `finish`, `usage`) and `input` is the payload it merges;
/// `state` is the project state document and `now` is the timestamp the JS
/// caller would have read from the clock. `validate` and `public` read `state`
/// alone and accept a missing `input`; `public` may carry `live_jobs`.
pub fn cmd_budget_admission(action: &str, input_file: &str) -> Result<()> {
    let document = read_json(input_file)?;
    let (operation, mut state, input, now, live_jobs) = read_request(&document)?;
    let now = if now.is_empty() {
        return Err(BudgetError::code("budget_invalid_time").into());
    } else {
        now
    };
    let mut output = Map::new();
    match action {
        "apply" => {
            // The document's operation selects the admission operation, so the
            // action name is not repeated in it.
            if !ALL_OPERATIONS.contains(&operation.as_str()) {
                bail!("Input JSON operation does not match the requested action");
            }
            if !input.is_object() {
                bail!("Input JSON is invalid");
            }
            output.insert("operation".into(), json!(operation));
            let result = apply_budget_operation(&mut state, &operation, &input, &now)?;
            output.insert("result".into(), result);
            output.insert(
                "budget_admission".into(),
                state
                    .get("budget_admission")
                    .cloned()
                    .unwrap_or(Value::Null),
            );
        }
        "validate" | "public" => {
            // These read the state alone; the operation field is advisory and
            // must not name a write the action does not perform.
            if operation != action {
                bail!("Input JSON operation does not match the requested action");
            }
            output.insert("operation".into(), json!(action));
            if action == "validate" {
                validate_budget_admission(&state)?;
                output.insert("valid".into(), json!(true));
            } else {
                output.insert(
                    "budget_admission".into(),
                    public_budget_admission(&state, &live_jobs, &now)?,
                );
            }
        }
        other => bail!("unknown budget-admission action {other}"),
    }
    let text =
        serde_json::to_string(&Value::Object(output)).context("serialize budget admission")?;
    let stdout = std::io::stdout();
    let mut handle = stdout.lock();
    writeln!(handle, "{text}")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// One policy with an explicit baseline, so the spend is known.
    fn policy(baseline: &Value) -> Value {
        json!({
            "policy_id": "project-budget",
            "expected_revision": 0,
            "run_id": null,
            "period_start": "2026-10-01T00:00:00Z",
            "period_end": "2026-11-01T00:00:00Z",
            "currency": "USD",
            "source_kind": "provider_usage",
            "baseline": baseline,
            "baseline_basis": "Fixture baseline.",
            "soft_limit": "1",
            "hard_limit": "2",
            "call_reservation": "0.3",
            "paused": false,
            "active": true,
            "reason": "Fixture policy.",
        })
    }

    fn state() -> Value {
        json!({ "schema": 1, "project": { "id": "project-1" } })
    }

    const NOW: &str = "2026-10-15T00:00:00Z";

    fn failing<T>(code: &str, result: BudgetResult<T>) {
        let error = result.err().expect("call should be refused");
        assert_eq!(error.message, code);
    }

    #[test]
    fn money_and_units_round_trip_like_js_bigint() {
        assert_eq!(units("0").unwrap(), 0);
        assert_eq!(units("1").unwrap(), SCALE);
        assert_eq!(units("0.1").unwrap(), 100_000_000);
        assert_eq!(units("0.000000001").unwrap(), 1);
        assert_eq!(
            units("1234567890123456").unwrap(),
            1_234_567_890_123_456 * SCALE
        );
        // The JS pattern only needs 1..=16 digits, so a leading zero is legal
        // here (unlike the cost-ledger amount).
        assert_eq!(units("01").unwrap(), SCALE);
        failing("budget_invalid_amount", units("-1"));
        failing("budget_invalid_amount", units("1e-9"));
        failing("budget_invalid_amount", units("0.1234567891"));
        failing("budget_invalid_amount", units("12345678901234567"));
        assert_eq!(money(0), "0");
        assert_eq!(money(100_000_000), "0.1");
        assert_eq!(money(1), "0.000000001");
    }

    #[test]
    fn id_refuses_prototype_names_and_overlong_values() {
        assert_eq!(id(&json!("job-1")).unwrap(), "job-1");
        assert_eq!(id(&json!("a.b_c:d-e")).unwrap(), "a.b_c:d-e");
        failing("budget_invalid_id", id(&json!("")));
        failing("budget_invalid_id", id(&json!("a b")));
        failing("budget_invalid_id", id(&json!("__proto__")));
        failing("budget_invalid_id", id(&json!("constructor")));
        failing("budget_invalid_id", id(&json!("a".repeat(161))));
        assert_eq!(id(&json!("a".repeat(160))).unwrap().len(), 160);
    }

    #[test]
    fn time_accepts_only_the_canonical_utc_spelling() {
        assert_eq!(
            time(&json!("2026-10-15T00:00:00Z")).unwrap(),
            "2026-10-15T00:00:00.000Z"
        );
        assert_eq!(
            time(&json!("2026-10-15T00:00:00.5Z")).unwrap(),
            "2026-10-15T00:00:00.500Z"
        );
        assert_eq!(
            time(&json!("2026-10-15T00:00:00.25Z")).unwrap(),
            "2026-10-15T00:00:00.250Z"
        );
        assert_eq!(
            time(&json!("2026-10-15T00:00:00.125Z")).unwrap(),
            "2026-10-15T00:00:00.125Z"
        );
        // A day that overflows its month is normalised by `Date.parse` and the
        // canonical comparison rejects it.
        failing("budget_invalid_time", time(&json!("2026-02-30T00:00:00Z")));
        failing("budget_invalid_time", time(&json!("2026-13-01T00:00:00Z")));
        failing("budget_invalid_time", time(&json!("2026-10-15T24:00:00Z")));
        failing("budget_invalid_time", time(&json!("2026-10-15T00:60:00Z")));
        failing("budget_invalid_time", time(&json!("2026-10-15T00:00:60Z")));
        failing("budget_invalid_time", time(&json!("2026-10-15T00:00:00")));
        failing(
            "budget_invalid_time",
            time(&json!("2026-10-15T00:00:00.1234Z")),
        );
        failing("budget_invalid_time", time(&json!(1)));
        // 2026-10-15 is 20_741 days after the epoch
        // (`Date.UTC(2026, 9, 15) / 86_400_000`).
        assert_eq!(days_from_civil(2026, 10, 15), 20_741);
        assert_eq!(civil_from_days(20_741), (2026, 10, 15));
    }

    #[test]
    fn text_rejects_blank_control_and_overlong_values() {
        assert_eq!(text_max(&json!("ok"), 10).unwrap(), "ok");
        // U+3000 is ECMAScript WhiteSpace, so it satisfies the non-blank
        // check, but `text()` returns the value untrimmed.
        assert_eq!(
            text_max(&json!("\u{3000}ok\u{3000}"), 10).unwrap(),
            "\u{3000}ok\u{3000}"
        );
        failing("budget_invalid_text", text_max(&json!(""), 10));
        failing("budget_invalid_text", text_max(&json!("\u{3000}"), 10));
        failing("budget_invalid_text", text_max(&json!("  "), 10));
        failing("budget_invalid_text", text_max(&json!("a\u{0}b"), 10));
        // DEL is not in `[\x00-\x1f]`, so it passes.
        assert!(text_max(&json!("a\u{7f}b"), 10).is_ok());
        failing("budget_invalid_text", text_max(&json!("12345678901"), 10));
    }

    #[test]
    fn policy_revision_must_be_a_safe_integer_and_match() {
        let mut state = state();
        apply_budget_operation(&mut state, "policy", &policy(&json!("0")), NOW).unwrap();
        // Replaying revision 0 again conflicts.
        failing(
            "budget_policy_revision_conflict",
            apply_budget_operation(&mut state, "policy", &policy(&json!("0")), NOW),
        );
        let mut next = policy(&json!("0"));
        next["expected_revision"] = json!(1);
        apply_budget_operation(&mut state, "policy", &next, NOW).unwrap();
        let mut bad = policy(&json!("0"));
        bad["expected_revision"] = json!(1.5);
        failing(
            "budget_policy_revision_conflict",
            apply_budget_operation(&mut state, "policy", &bad, NOW),
        );
    }

    #[test]
    fn hard_limit_and_unknown_spend_deny_a_job() {
        for baseline in [json!("2"), json!(null)] {
            let mut state = state();
            apply_budget_operation(&mut state, "policy", &policy(&baseline), NOW).unwrap();
            let result = apply_budget_operation(
                &mut state,
                "job",
                &json!({ "job_id": "job-1", "run_id": "run-1", "worker_id": "w1" }),
                NOW,
            )
            .unwrap();
            assert_eq!(result["allowed"], false);
            assert_eq!(
                state["budget_admission"]["jobs"].as_object().unwrap().len(),
                0
            );
        }
        // A soft-only crossing warns but admits.
        let mut state = state();
        apply_budget_operation(&mut state, "policy", &policy(&json!("1")), NOW).unwrap();
        let result = apply_budget_operation(
            &mut state,
            "job",
            &json!({ "job_id": "job-1", "run_id": "run-1", "worker_id": "w1" }),
            NOW,
        )
        .unwrap();
        assert_eq!(result["warning"], true);
        assert_eq!(result["allowed"], true);
    }

    #[test]
    fn apply_records_the_operation_and_validate_replays_it() {
        let mut state = state();
        apply_budget_operation(&mut state, "policy", &policy(&json!("0.1")), NOW).unwrap();
        apply_budget_operation(
            &mut state,
            "job",
            &json!({ "job_id": "job-1", "run_id": "run-1", "worker_id": "w1" }),
            NOW,
        )
        .unwrap();
        validate_budget_admission(&state).unwrap();
        // A damaged stored amount is caught by the replay.
        let mut damaged = state.clone();
        damaged["budget_admission"]["policies"]["project-budget"]["baseline"] = json!("9");
        failing("budget_invalid_audit", validate_budget_admission(&damaged));
    }

    #[test]
    fn a_null_stored_book_is_recreated_like_the_js_or_assignment() {
        let mut state = json!({
            "schema": 1,
            "project": { "id": "p1" },
            "budget_admission": null,
        });
        apply_budget_operation(&mut state, "policy", &policy(&json!("0")), NOW).unwrap();
        assert_eq!(state["budget_admission"]["schema"], 1);
        assert_eq!(state["budget_admission"]["project_id"], "p1");
    }

    #[test]
    fn public_projection_reports_status_overspend_and_accounting() {
        let mut state = state();
        apply_budget_operation(&mut state, "policy", &policy(&json!("0")), NOW).unwrap();
        let view = public_budget_admission(&state, &Value::Null, NOW).unwrap();
        assert_eq!(view["policies"][0]["status"], "within_budget");
        assert_eq!(view["policies"][0]["overspend"], "0");
        assert_eq!(view["policies"][0]["spent"], "0");
        assert_eq!(view["policies"][0]["reserved"], "0");
        assert_eq!(view["policies"][0]["next_call_fits"], true);
        let empty = json!({ "schema": 1, "project": { "id": "p1" } });
        assert_eq!(
            public_budget_admission(&empty, &Value::Null, NOW).unwrap(),
            Value::Null
        );
    }
}
