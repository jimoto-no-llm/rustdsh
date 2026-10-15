//! Reported cost observations for one project period.
//!
//! Rust port of `dashboard/cost-ledger.mjs`. It declares the exact scope of one
//! reporting period, records reported observations against that scope, validates
//! a stored ledger and projects the public view of it, plus the two JSON schemas
//! the dashboard MCP tool advertises.
//!
//! This is reported observations only: no billing scrape, no price lookup and no
//! model call. Amounts are decimal strings carried as integer nanounits, so the
//! arithmetic never rounds through a binary float.
//!
//! The exported actions mirror the JS module one for one:
//!
//! * `declare`  — `declareCostScope(state, input)`
//! * `report`   — `recordCostReport(state, input)`
//! * `validate` — `validateCostLedger(state)`
//! * `public`   — `publicCostLedger(state)`
//! * `schema`   — `costScopeSchema` and `costReportSchema`
//!
//! `dashboard/state.mjs` still imports the JS module on every store open and
//! every `mutate`, `dashboard/mcp.mjs` consumes the schema exports as leaf
//! fragments, and `dashboard/budget-admission.mjs` reads `costSources`. It
//! therefore cannot be deleted without putting a synchronous Rust call on the
//! store's hot path or changing what MCP clients receive. This module lands
//! alongside it; the outputs are byte-identical, and `tests/cost_ledger_cli.rs`
//! pins the same JSON the JS module produced.

use std::io::{Read, Write};

use anyhow::{anyhow, bail, Context, Result};
use serde_json::{json, Map, Value};

/// The four reported sources, in JS declaration order.
const COST_SOURCES: [&str; 4] = [
    "provider_usage",
    "cli_report",
    "api_estimate",
    "invoice_actual",
];

/// `certaintyFor`: the certainty each source kind implies.
fn certainty_for(source_kind: &str) -> Option<&'static str> {
    match source_kind {
        "provider_usage" | "cli_report" => Some("reported"),
        "api_estimate" => Some("estimated"),
        "invoice_actual" => Some("confirmed"),
        _ => None,
    }
}

/// `scale = 1000000000n`: nanounits per whole currency unit.
const SCALE: u128 = 1_000_000_000;

/// `scopeKeys`, in JS declaration order.
const SCOPE_KEYS: [&str; 6] = [
    "scope_id",
    "project_id",
    "period_start",
    "period_end",
    "membership_complete",
    "targets",
];

/// `targetKeys`, in JS declaration order.
const TARGET_KEYS: [&str; 6] = [
    "target_id",
    "worker_id",
    "session_id",
    "run_id",
    "provider",
    "model",
];

/// `reportKeys`, in JS declaration order.
const REPORT_KEYS: [&str; 13] = [
    "event_id",
    "scope_id",
    "target_id",
    "source_kind",
    "source_ref",
    "observed_at",
    "mode",
    "sequence",
    "currency",
    "amount",
    "certainty",
    "tokens",
    "basis",
];

/// `tokenKeys`, in JS declaration order.
const TOKEN_KEYS: [&str; 3] = ["input", "cached_input", "output"];

/// `Number.MAX_SAFE_INTEGER`: the largest integer JS reports exactly.
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;
/// The same value as an integer, for the schemas: `json!(f64)` would print
/// `9007199254740991.0`, which is not what `JSON.stringify` emits.
const MAX_SAFE_INTEGER_JSON: i64 = 9_007_199_254_740_991;

/// The error message the JS module throws. The dashboard carries the whole
/// message instead of a short code, so the port keeps the exact spelling.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CostLedgerError {
    pub message: String,
    pub status: u16,
}

impl CostLedgerError {
    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            status: 400,
        }
    }

    fn conflict(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            status: 409,
        }
    }
}

impl std::fmt::Display for CostLedgerError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Cost ledger: {}", self.message)
    }
}

impl std::error::Error for CostLedgerError {}

type CostResult<T> = std::result::Result<T, CostLedgerError>;

/// `check(ok, reason, status)`: the JS guard, keeping its default 400.
fn check(ok: bool, reason: &str) -> CostResult<()> {
    if ok {
        Ok(())
    } else {
        Err(CostLedgerError::new(reason))
    }
}

/// `check(ok, reason, 409)`.
fn check_conflict(ok: bool, reason: &str) -> CostResult<()> {
    if ok {
        Ok(())
    } else {
        Err(CostLedgerError::conflict(reason))
    }
}

/// `object(value)`: a JSON object, never an array or null.
fn as_object(value: &Value) -> Option<&Map<String, Value>> {
    value.as_object()
}

/// `Object.hasOwn(value, key)`.
fn has_own(object: &Map<String, Value>, key: &str) -> bool {
    object.contains_key(key)
}

/// ECMAScript enumeration visits array-index keys numerically, then other keys
/// in insertion order.
fn js_array_index(key: &str) -> Option<u32> {
    let index = key.parse::<u32>().ok()?;
    (index != u32::MAX && index.to_string() == key).then_some(index)
}

fn js_object_entries(object: &Map<String, Value>) -> Vec<(String, Value)> {
    let mut indices = Vec::new();
    let mut strings = Vec::new();
    for (key, value) in object {
        if let Some(index) = js_array_index(key) {
            indices.push((index, key.clone(), value.clone()));
        } else {
            strings.push((key.clone(), value.clone()));
        }
    }
    indices.sort_by_key(|(index, _, _)| *index);
    indices
        .into_iter()
        .map(|(_, key, value)| (key, value))
        .chain(strings)
        .collect()
}

fn js_object_values(object: &Map<String, Value>) -> Vec<Value> {
    js_object_entries(object)
        .into_iter()
        .map(|(_, value)| value)
        .collect()
}

/// Match safe integer and property-order behavior of `JSON.parse` in JS.
fn normalize_js_value(value: &mut Value) {
    let integer = match value {
        Value::Number(number) => number.as_f64().and_then(|number| {
            (number.fract() == 0.0 && number.abs() <= MAX_SAFE_INTEGER).then_some(number as i64)
        }),
        _ => None,
    };
    if let Some(integer) = integer {
        *value = json!(integer);
        return;
    }
    match value {
        Value::Array(items) => {
            for item in items {
                normalize_js_value(item);
            }
        }
        Value::Object(object) => {
            for item in object.values_mut() {
                normalize_js_value(item);
            }
            let entries = js_object_entries(object);
            object.clear();
            for (key, item) in entries {
                object.insert(key, item);
            }
        }
        _ => {}
    }
}

/// IDs are ASCII by contract. Match the dashboard's default en-US
/// `localeCompare` ordering for punctuation, digits, case and prefixes.
fn js_locale_compare(left: &str, right: &str) -> std::cmp::Ordering {
    if !left.is_ascii() || !right.is_ascii() {
        return left.cmp(right);
    }
    let primary = |text: &str| {
        text.bytes()
            .map(|byte| match byte {
                b'_' => 0,
                b'-' => 1,
                b':' => 2,
                b'.' => 3,
                b'0'..=b'9' => 4 + byte - b'0',
                b'a'..=b'z' => 14 + byte - b'a',
                b'A'..=b'Z' => 14 + byte - b'A',
                _ => 255,
            })
            .collect::<Vec<_>>()
    };
    let case = |text: &str| {
        text.bytes()
            .map(|byte| u8::from(byte.is_ascii_uppercase()))
            .collect::<Vec<_>>()
    };
    primary(left)
        .cmp(&primary(right))
        .then_with(|| case(left).cmp(&case(right)))
}

/// `shape(value, keys)`: an object with exactly those own keys.
fn shape(value: &Value, keys: &[&str]) -> CostResult<()> {
    let ok = match as_object(value) {
        // JS compares the own-key count with the expected key count and then
        // requires every expected key: together that is set equality.
        Some(object) => object.len() == keys.len() && keys.iter().all(|key| has_own(object, key)),
        None => false,
    };
    check(ok, "unexpected or missing fields")
}

fn is_js_trim_character(character: char) -> bool {
    matches!(
        character,
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
}

/// `/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/` plus the JS prototype-name refusal.
fn identifier(value: &Value) -> CostResult<String> {
    let ok = value.as_str().is_some_and(|text| {
        // The pattern is ASCII-only, so a byte walk is the exact character
        // count as well.
        let bytes = text.as_bytes();
        let mut rest = bytes.iter();
        let first_ok = rest.next().is_some_and(u8::is_ascii_alphanumeric);
        first_ok
            && rest.len() <= 159
            && rest.all(|byte| {
                byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-')
            })
            && !matches!(text, "constructor" | "prototype" | "__proto__")
    });
    check(ok, "invalid identifier")?;
    Ok(value
        .as_str()
        .expect("the check accepted a string")
        .to_string())
}

/// `text(value, max)`: a non-blank string of at most `max` characters with no
/// control characters. The JS pattern `[\x00-\x1f\x7f]` rejects the C0 range
/// and DEL, and counts UTF-16 code units.
fn text(value: &Value, max: usize) -> CostResult<String> {
    let ok = value.as_str().is_some_and(|text| {
        !text.chars().all(is_js_trim_character)
            && text.encode_utf16().count() <= max
            && !text.chars().any(|ch| ch <= '\u{1f}' || ch == '\u{7f}')
    });
    check(ok, "invalid source text")?;
    Ok(value
        .as_str()
        .expect("the check accepted a string")
        .to_string())
}

/// `optional(value)`: `null` or the 160-character text check.
fn optional(value: &Value) -> CostResult<Value> {
    if value.is_null() {
        Ok(Value::Null)
    } else {
        Ok(Value::String(text(value, 160)?))
    }
}

/// `time(value)`: a `YYYY-MM-DDTHH:MM:SS[.mmm]Z` instant that JS `Date.parse`
/// accepts and `toISOString()` reproduces for the exact spelling.
///
/// The two JS guards fail on different inputs, and the port must keep them
/// apart: the regex rejects a wrong spelling (`...T01:00:00.5Z`,
/// `...+00:00`) with "UTC timestamp required", while `Date.parse` normalises
/// an out-of-range civil date (`2026-02-30` becomes `2026-03-02`) so that only
/// the canonical comparison can reject it, with "invalid UTC timestamp".
fn time(value: &Value) -> CostResult<String> {
    let Some(text) = value.as_str() else {
        return Err(CostLedgerError::new("UTC timestamp required"));
    };
    let Some((year, month, day, hour, minute, second, millis)) = parse_timestamp(text) else {
        return Err(CostLedgerError::new("UTC timestamp required"));
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
        return Err(CostLedgerError::new("UTC timestamp required"));
    }
    // `new Date(value).toISOString()`: a day past the end of its month rolls
    // into the next one, exactly as `Date` does.
    let day_number = days_from_civil(year as i64, month as i64, 1) + (day as i64 - 1);
    let (canonical_year, canonical_month, canonical_day) = civil_from_days(day_number);
    let canonical = format!(
        "{canonical_year:04}-{canonical_month:02}-{canonical_day:02}T{hour:02}:{minute:02}:{second:02}.{millis:03}Z"
    );
    // `Number.isFinite(Date.parse(value))` holds for every spelling the regex
    // above accepted, so only the canonical comparison can still fail.
    let expected = if text.len() == 20 {
        format!("{}.000Z", &text[..text.len() - 1])
    } else {
        text.to_string()
    };
    check(canonical == expected, "invalid UTC timestamp")?;
    Ok(canonical)
}

/// Match `^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$` and pull the fields.
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
    if bytes.len() != 20 && bytes.len() != 24 {
        return None;
    }
    if bytes[4] != b'-' || bytes[7] != b'-' || bytes[10] != b'T' || bytes[13] != b':' {
        return None;
    }
    if bytes[16] != b':' || *bytes.last()? != b'Z' {
        return None;
    }
    let millis = if bytes.len() == 24 {
        if bytes[19] != b'.' {
            return None;
        }
        digits(20..23)?
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

/// `units(value)`: the nonnegative decimal string as integer nanounits.
fn units(value: &Value) -> CostResult<u128> {
    let parsed = value.as_str().and_then(parse_units);
    match parsed {
        Some(units) => Ok(units),
        None => Err(CostLedgerError::new(
            "amount must be a nonnegative decimal string with at most 9 fractional digits",
        )),
    }
}

/// `^(?:0|[1-9]\d{0,15})(?:\.\d{1,9})?$`, converted with the JS `BigInt`
/// arithmetic: `whole * 10^9 + fraction.padEnd(9, "0")`.
fn parse_units(text: &str) -> Option<u128> {
    let (whole, fraction) = match text.split_once('.') {
        Some((whole, fraction)) => (whole, Some(fraction)),
        None => (text, None),
    };
    let whole_ok = match whole.as_bytes() {
        [b'0'] => true,
        [first, rest @ ..] => {
            first.is_ascii_digit()
                && *first != b'0'
                && rest.len() <= 15
                && rest.iter().all(u8::is_ascii_digit)
        }
        [] => false,
    };
    if !whole_ok {
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

/// `decimal(value)`: integer nanounits back to the canonical decimal string,
/// with trailing fractional zeros stripped.
fn decimal(value: u128) -> String {
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

/// `scopeInput(input, projectId)`: validate one declared period.
fn scope_input(input: &Value, project_id: &str) -> CostResult<Value> {
    shape(input, &SCOPE_KEYS)?;
    let input = as_object(input).expect("shape() accepted an object");
    check(
        input.get("project_id").and_then(Value::as_str) == Some(project_id),
        "scope belongs to another project",
    )?;
    let start = time(input.get("period_start").unwrap_or(&Value::Null))?;
    let end = time(input.get("period_end").unwrap_or(&Value::Null))?;
    check(start < end, "period must have a positive duration")?;
    check(
        input
            .get("membership_complete")
            .is_some_and(Value::is_boolean),
        "membership_complete must be explicit",
    )?;
    let targets = input.get("targets").and_then(Value::as_array);
    check(
        targets.is_some_and(|targets| !targets.is_empty() && targets.len() <= 100),
        "declare 1 to 100 expected targets",
    )?;
    let targets = targets.expect("the check accepted an array");
    let mut ids: Vec<String> = Vec::new();
    let mut identities: Vec<String> = Vec::new();
    let mut normalized: Vec<(String, Value)> = Vec::with_capacity(targets.len());
    for target in targets {
        shape(target, &TARGET_KEYS)?;
        let target = as_object(target).expect("shape() accepted an object");
        let value = target_value(target)?;
        let identity = serde_json::to_string(&Value::Array(vec![
            value["worker_id"].clone(),
            value["session_id"].clone(),
            value["provider"].clone(),
            value["model"].clone(),
        ]))
        .expect("target identities are JSON scalars");
        let target_id = value["target_id"]
            .as_str()
            .expect("id() returned a string")
            .to_string();
        check(
            !ids.contains(&target_id) && !identities.contains(&identity),
            "duplicate target identity",
        )?;
        ids.push(target_id.clone());
        identities.push(identity);
        normalized.push((target_id, Value::Object(value)));
    }
    // `Array.prototype.sort` with the JS comparator: by `target_id` code units.
    normalized.sort_by(|left, right| left.0.cmp(&right.0));
    let targets: Vec<Value> = normalized.into_iter().map(|(_, value)| value).collect();
    let mut scope = Map::new();
    scope.insert(
        "scope_id".into(),
        Value::String(identifier(input.get("scope_id").unwrap_or(&Value::Null))?),
    );
    scope.insert("project_id".into(), Value::String(project_id.to_string()));
    scope.insert("period_start".into(), Value::String(start));
    scope.insert("period_end".into(), Value::String(end));
    scope.insert(
        "membership_complete".into(),
        input
            .get("membership_complete")
            .cloned()
            .unwrap_or(Value::Null),
    );
    scope.insert("targets".into(), Value::Array(targets));
    Ok(Value::Object(scope))
}

/// The six normalized target fields, in JS declaration order.
fn target_value(target: &Map<String, Value>) -> CostResult<Map<String, Value>> {
    let mut value = Map::new();
    value.insert(
        "target_id".into(),
        Value::String(identifier(target.get("target_id").unwrap_or(&Value::Null))?),
    );
    value.insert(
        "worker_id".into(),
        Value::String(identifier(target.get("worker_id").unwrap_or(&Value::Null))?),
    );
    value.insert(
        "session_id".into(),
        Value::String(text(target.get("session_id").unwrap_or(&Value::Null), 160)?),
    );
    value.insert(
        "run_id".into(),
        optional(target.get("run_id").unwrap_or(&Value::Null))?,
    );
    value.insert(
        "provider".into(),
        optional(target.get("provider").unwrap_or(&Value::Null))?,
    );
    value.insert(
        "model".into(),
        optional(target.get("model").unwrap_or(&Value::Null))?,
    );
    Ok(value)
}

/// `reportInput(input, scope)`: validate one reported observation.
fn report_input(input: &Value, scope: &Map<String, Value>) -> CostResult<Value> {
    shape(input, &REPORT_KEYS)?;
    let input = as_object(input).expect("shape() accepted an object");
    let source_kind = input
        .get("source_kind")
        .and_then(Value::as_str)
        .unwrap_or("");
    check(COST_SOURCES.contains(&source_kind), "unknown source kind")?;
    check(
        input.get("scope_id").and_then(Value::as_str)
            == scope.get("scope_id").and_then(Value::as_str),
        "unknown scope",
    )?;
    let target_id = input.get("target_id").cloned().unwrap_or(Value::Null);
    let targets = scope.get("targets").and_then(Value::as_array);
    check(
        if target_id.is_null() {
            source_kind == "invoice_actual"
        } else {
            targets.is_some_and(|targets| {
                targets
                    .iter()
                    .any(|target| target.get("target_id") == Some(&target_id))
            })
        },
        "unknown target; only an unallocated invoice may use null",
    )?;
    let mode = input.get("mode").and_then(Value::as_str).unwrap_or("");
    check(
        matches!(mode, "event" | "cumulative"),
        "invalid report mode",
    )?;
    let sequence = input.get("sequence");
    check(
        sequence.is_some_and(is_safe_integer)
            && sequence.and_then(Value::as_f64).unwrap_or(0.0) >= 1.0,
        "positive stable sequence required",
    )?;
    let currency = input.get("currency").and_then(Value::as_str).unwrap_or("");
    check(
        currency.len() == 3 && currency.bytes().all(|byte| byte.is_ascii_uppercase()),
        "currency must be an explicit three-letter code",
    )?;
    let certainty = input.get("certainty").and_then(Value::as_str).unwrap_or("");
    let amount_input = input.get("amount").cloned().unwrap_or(Value::Null);
    check(
        if amount_input.is_null() {
            certainty == "unknown"
        } else {
            Some(certainty) == certainty_for(source_kind)
        },
        "certainty must match the amount and source",
    )?;
    let amount = if amount_input.is_null() {
        Value::Null
    } else {
        Value::String(decimal(units(&amount_input)?))
    };
    let tokens_input = input.get("tokens").cloned().unwrap_or(Value::Null);
    let tokens = if tokens_input.is_null() {
        Value::Null
    } else {
        shape(&tokens_input, &TOKEN_KEYS)?;
        let tokens_object = as_object(&tokens_input).expect("shape() accepted an object");
        check(
            TOKEN_KEYS.iter().all(|key| {
                let counter = tokens_object.get(*key).unwrap_or(&Value::Null);
                counter.is_null()
                    || (is_safe_integer(counter) && counter.as_f64().unwrap_or(-1.0) >= 0.0)
            }),
            "invalid reported token counter",
        )?;
        let counter = |key: &str| tokens_object.get(key).cloned().unwrap_or(Value::Null);
        let input_counter = counter("input");
        let cached_counter = counter("cached_input");
        check(
            input_counter.is_null()
                || cached_counter.is_null()
                || cached_counter.as_f64().unwrap_or(0.0) <= input_counter.as_f64().unwrap_or(0.0),
            "cached input exceeds input",
        )?;
        // `Object.fromEntries(tokenKeys.map(...))` re-inserts in tokenKeys
        // order, so the stored object always uses the canonical key order.
        let mut tokens = Map::new();
        for key in TOKEN_KEYS {
            tokens.insert(key.to_string(), counter(key));
        }
        Value::Object(tokens)
    };
    let observed = time(input.get("observed_at").unwrap_or(&Value::Null))?;
    check(
        scope
            .get("period_start")
            .and_then(Value::as_str)
            .is_none_or(|start| observed.as_str() >= start),
        "observation precedes its period",
    )?;
    let mut report = Map::new();
    report.insert(
        "event_id".into(),
        Value::String(identifier(input.get("event_id").unwrap_or(&Value::Null))?),
    );
    report.insert(
        "scope_id".into(),
        scope.get("scope_id").cloned().unwrap_or(Value::Null),
    );
    report.insert("target_id".into(), target_id);
    report.insert("source_kind".into(), Value::String(source_kind.to_string()));
    report.insert(
        "source_ref".into(),
        Value::String(text(input.get("source_ref").unwrap_or(&Value::Null), 1000)?),
    );
    report.insert("observed_at".into(), Value::String(observed));
    report.insert("mode".into(), Value::String(mode.to_string()));
    report.insert("sequence".into(), sequence.cloned().unwrap_or(Value::Null));
    report.insert("currency".into(), Value::String(currency.to_string()));
    report.insert("amount".into(), amount);
    report.insert("certainty".into(), Value::String(certainty.to_string()));
    report.insert("tokens".into(), tokens);
    report.insert(
        "basis".into(),
        Value::String(text(input.get("basis").unwrap_or(&Value::Null), 2000)?),
    );
    Ok(Value::Object(report))
}

/// `Number.isSafeInteger(value)`.
fn is_safe_integer(value: &Value) -> bool {
    match value {
        Value::Number(number) => number
            .as_f64()
            .is_some_and(|number| number.fract() == 0.0 && number.abs() <= MAX_SAFE_INTEGER),
        _ => false,
    }
}

/// `JSON.stringify(a) === JSON.stringify(b)`, including key order.
fn equal(left: &Value, right: &Value) -> bool {
    match (serde_json::to_string(left), serde_json::to_string(right)) {
        (Ok(left), Ok(right)) => left == right,
        _ => false,
    }
}

/// `JSON.stringify([scope_id, target_id, source_kind])`: the lane key.
fn lane_key(report: &Value) -> String {
    serde_json::to_string(&Value::Array(vec![
        report.get("scope_id").cloned().unwrap_or(Value::Null),
        report.get("target_id").cloned().unwrap_or(Value::Null),
        report.get("source_kind").cloned().unwrap_or(Value::Null),
    ]))
    .expect("lane keys are JSON scalars")
}

/// One report stream: sequences keyed by `sequence`, insertion ordered.
///
/// JS `Map` iterates in insertion order, which `reportIndex` and
/// `publicCostLedger` both rely on for stable output.
#[derive(Default)]
struct Lane {
    by_sequence: Vec<(Value, Value)>,
}

impl Lane {
    fn get(&self, sequence: &Value) -> Option<&Value> {
        self.by_sequence
            .iter()
            .find(|(key, _)| key == sequence)
            .map(|(_, report)| report)
    }

    fn set(&mut self, sequence: Value, report: Value) {
        self.by_sequence.push((sequence, report));
    }

    /// `[...lane.values()].sort((a, b) => a.sequence - b.sequence)`.
    fn sorted(&self) -> Vec<Value> {
        let mut values: Vec<Value> = self
            .by_sequence
            .iter()
            .map(|(_, report)| report.clone())
            .collect();
        values.sort_by(|left, right| {
            let left = left.get("sequence").and_then(Value::as_f64).unwrap_or(0.0);
            let right = right.get("sequence").and_then(Value::as_f64).unwrap_or(0.0);
            left.partial_cmp(&right)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        values
    }

    fn first(&self) -> Option<&Value> {
        self.by_sequence.first().map(|(_, report)| report)
    }
}

/// `reportIndex(reports)`: lanes keyed by scope/target/source, insertion
/// ordered, with the mode/currency and sequence-conflict guards.
fn report_index(reports: &[Value]) -> CostResult<Vec<(String, Lane)>> {
    let mut lanes: Vec<(String, Lane)> = Vec::new();
    for report in reports {
        let key = lane_key(report);
        let position = lanes.iter().position(|(existing, _)| existing == &key);
        let position = match position {
            Some(position) => position,
            None => {
                lanes.push((key, Lane::default()));
                lanes.len() - 1
            }
        };
        let lane = &mut lanes[position].1;
        let first = lane.first().cloned();
        check_conflict(
            first.as_ref().is_none_or(|first| {
                first.get("mode") == report.get("mode")
                    && first.get("currency") == report.get("currency")
            }),
            "do not mix event/cumulative modes or currencies in one source stream",
        )?;
        let sequence = report.get("sequence").cloned().unwrap_or(Value::Null);
        let prior = lane.get(&sequence).cloned();
        let blanked = |report: &Value| {
            let mut copy = report.clone();
            if let Some(object) = copy.as_object_mut() {
                object.insert("event_id".into(), Value::Null);
                object.insert("received_at".into(), Value::Null);
            }
            copy
        };
        check_conflict(
            prior
                .as_ref()
                .is_none_or(|prior| equal(&blanked(prior), &blanked(report))),
            "sequence already refers to a different observation",
        )?;
        if prior.is_none() {
            lane.set(sequence, report.clone());
        }
    }
    for (_, lane) in &lanes {
        let sorted = lane.sorted();
        let Some(first) = sorted.first() else {
            continue;
        };
        if first.get("mode").and_then(Value::as_str) != Some("cumulative") {
            continue;
        }
        // `const known = {}`: per stream, the highest value seen per counter.
        let mut known: Vec<(String, u128)> = Vec::new();
        let mut previous_time: Option<String> = None;
        for report in &sorted {
            let observed = report
                .get("observed_at")
                .and_then(Value::as_str)
                .unwrap_or("");
            check_conflict(
                previous_time
                    .as_deref()
                    .is_none_or(|previous| observed >= previous),
                "cumulative observation time moved backwards",
            )?;
            previous_time = Some(observed.to_string());
            // `values` keeps `amount` first, then the three token counters.
            let mut values: Vec<(String, Option<u128>)> = vec![(
                "amount".to_string(),
                report
                    .get("amount")
                    .filter(|amount| !amount.is_null())
                    .map(units)
                    .transpose()?,
            )];
            for key in TOKEN_KEYS {
                let counter = report
                    .get("tokens")
                    .and_then(|tokens| tokens.get(key))
                    .filter(|counter| !counter.is_null());
                values.push((
                    key.to_string(),
                    counter
                        .map(|counter| counter.as_u64().map(u128::from).ok_or(()))
                        .transpose()
                        .map_err(|()| CostLedgerError::new("invalid reported token counter"))?,
                ));
            }
            for (key, value) in values {
                let Some(value) = value else { continue };
                let prior = known
                    .iter()
                    .find(|(known_key, _)| known_key == &key)
                    .map(|(_, value)| *value);
                check_conflict(
                    prior.is_none_or(|prior| value >= prior),
                    "cumulative counter decreased; declare a new period for a meter reset",
                )?;
                match known.iter_mut().find(|(known_key, _)| known_key == &key) {
                    Some(entry) => entry.1 = value,
                    None => known.push((key, value)),
                }
            }
        }
    }
    Ok(lanes)
}

/// `registry(state)`: `state.cost_ledger ||= { ... }`.
fn registry(state: &mut Value) -> CostResult<&mut Map<String, Value>> {
    let state_object = state
        .as_object_mut()
        .ok_or_else(|| CostLedgerError::new("invalid ledger identity"))?;
    let missing = state_object.get("cost_ledger").is_none_or(is_js_falsy);
    if missing {
        let project_id = state_object
            .get("project")
            .and_then(|project| project.get("id"))
            .cloned()
            .unwrap_or(Value::Null);
        let mut ledger = Map::new();
        ledger.insert("schema".into(), json!(1));
        ledger.insert("project_id".into(), project_id);
        ledger.insert("scopes".into(), Value::Object(Map::new()));
        ledger.insert("reports".into(), Value::Object(Map::new()));
        state_object.insert("cost_ledger".into(), Value::Object(ledger));
    }
    state_object
        .get_mut("cost_ledger")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| CostLedgerError::new("invalid ledger identity"))
}

/// JavaScript truthiness, for `state.cost_ledger ||= ...`.
fn is_js_falsy(value: &Value) -> bool {
    match value {
        Value::Null => true,
        Value::Bool(value) => !value,
        Value::Number(number) => number.as_f64().is_some_and(|number| number == 0.0),
        Value::String(text) => text.is_empty(),
        Value::Array(_) | Value::Object(_) => false,
    }
}

/// `declareCostScope(state, input)`: declare one scope, idempotently.
pub fn declare_cost_scope(state: &mut Value, input: &Value) -> CostResult<()> {
    normalize_js_value(state);
    let mut input = input.clone();
    normalize_js_value(&mut input);
    let project_id = state
        .get("project")
        .and_then(|project| project.get("id"))
        .and_then(Value::as_str)
        .ok_or_else(|| CostLedgerError::new("invalid ledger identity"))?
        .to_string();
    let scope = scope_input(&input, &project_id)?;
    let scope_id = scope
        .get("scope_id")
        .and_then(Value::as_str)
        .expect("scopeInput() returned scope_id")
        .to_string();
    let ledger = registry(state)?;
    let scopes = ledger
        .get("scopes")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    if let Some(prior) = scopes.get(&scope_id) {
        // `const { declared_at, ...prior } = stored`: the remaining fields keep
        // their stored key order.
        let mut prior = prior.clone();
        if let Some(object) = prior.as_object_mut() {
            object.shift_remove("declared_at");
        }
        check_conflict(equal(&prior, &scope), "scope identity is immutable")?;
        return Ok(());
    }
    check(scopes.len() < 100, "scope retention limit reached")?;
    let declared_at = now_iso();
    let mut stored = scope.as_object().cloned().unwrap_or_default();
    stored.insert("declared_at".into(), Value::String(declared_at));
    ledger
        .get_mut("scopes")
        .and_then(Value::as_object_mut)
        .expect("registry() built an object")
        .insert(scope_id, Value::Object(stored));
    normalize_js_value(state);
    Ok(())
}

/// `recordCostReport(state, input)`: record one observation, idempotently.
pub fn record_cost_report(state: &mut Value, input: &Value) -> CostResult<()> {
    normalize_js_value(state);
    let mut input = input.clone();
    normalize_js_value(&mut input);
    let ledger = state.get("cost_ledger").cloned();
    let scope_id = input.get("scope_id").and_then(Value::as_str).unwrap_or("");
    let scope = ledger
        .as_ref()
        .and_then(Value::as_object)
        .and_then(|ledger| ledger.get("scopes"))
        .and_then(Value::as_object)
        .filter(|scopes| has_own(scopes, scope_id))
        .and_then(|scopes| scopes.get(scope_id))
        .cloned();
    check(
        as_object(&input).is_some() && ledger.is_some() && scope.is_some(),
        "declare the exact scope before reporting",
    )?;
    let scope = scope.expect("the check accepted a scope");
    let scope_object = scope.as_object().expect("stored scopes are objects");
    let report = report_input(&input, scope_object)?;
    let event_id = report
        .get("event_id")
        .and_then(Value::as_str)
        .expect("reportInput() returned event_id")
        .to_string();
    let ledger = state
        .get_mut("cost_ledger")
        .and_then(Value::as_object_mut)
        .expect("the check accepted a ledger");
    let stored_reports = ledger
        .get("reports")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    if let Some(prior) = stored_reports.get(&event_id) {
        let mut prior = prior.clone();
        if let Some(object) = prior.as_object_mut() {
            object.shift_remove("received_at");
        }
        check_conflict(
            equal(&prior, &report),
            "event ID already refers to different data",
        )?;
        return Ok(());
    }
    check(
        stored_reports.len() < 10000,
        "report retention limit reached",
    )?;
    let mut stored = report.as_object().cloned().unwrap_or_default();
    stored.insert("received_at".into(), Value::String(now_iso()));
    let mut combined_reports = stored_reports;
    combined_reports.insert(event_id.clone(), Value::Object(stored.clone()));
    let combined = js_object_values(&combined_reports);
    report_index(&combined)?;
    ledger
        .get_mut("reports")
        .and_then(Value::as_object_mut)
        .expect("registry() built an object")
        .insert(event_id, Value::Object(stored));
    normalize_js_value(state);
    Ok(())
}

/// `validateCostLedger(state)`: a missing document is valid, a malformed one
/// is refused with the JS message.
pub fn validate_cost_ledger(state: &Value) -> CostResult<()> {
    let mut normalized_state = state.clone();
    normalize_js_value(&mut normalized_state);
    let state = &normalized_state;
    // `state.cost_ledger === undefined` returns early. A stored `null` is NOT
    // undefined, so it falls through to `shape` and is refused exactly like any
    // other non-object: the key must be absent, not merely falsy.
    let Some(ledger) = state.get("cost_ledger") else {
        return Ok(());
    };
    shape(ledger, &["schema", "project_id", "scopes", "reports"])?;
    let ledger_object = as_object(ledger).expect("shape() accepted an object");
    check(
        ledger_object.get("schema") == Some(&json!(1))
            && ledger_object.get("project_id") == state.get("project").and_then(|p| p.get("id"))
            && ledger_object.get("scopes").is_some_and(Value::is_object)
            && ledger_object.get("reports").is_some_and(Value::is_object),
        "invalid ledger identity",
    )?;
    let scopes = ledger_object["scopes"]
        .as_object()
        .expect("the identity check accepted scopes");
    let reports = ledger_object["reports"]
        .as_object()
        .expect("the identity check accepted reports");
    check(
        scopes.len() <= 100 && reports.len() <= 10000,
        "retention limit exceeded",
    )?;
    let project_id = state
        .get("project")
        .and_then(|project| project.get("id"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    for (key, scope) in scopes {
        let mut keys = SCOPE_KEYS.to_vec();
        keys.push("declared_at");
        shape(scope, &keys)?;
        let mut input = scope.clone();
        let declared_at = input
            .as_object_mut()
            .and_then(|object| object.shift_remove("declared_at"))
            .unwrap_or(Value::Null);
        check(
            key == scope.get("scope_id").and_then(Value::as_str).unwrap_or(""),
            "invalid stored scope",
        )?;
        let canonical_time = time(&declared_at)?;
        check(
            canonical_time == declared_at.as_str().unwrap_or(""),
            "invalid stored scope",
        )?;
        check(
            equal(&input, &scope_input(&input, &project_id)?),
            "invalid stored scope",
        )?;
    }
    for (key, report) in reports {
        let mut keys = REPORT_KEYS.to_vec();
        keys.push("received_at");
        shape(report, &keys)?;
        let mut input = report.clone();
        let received_at = input
            .as_object_mut()
            .and_then(|object| object.shift_remove("received_at"))
            .unwrap_or(Value::Null);
        let scope_id = input.get("scope_id").and_then(Value::as_str).unwrap_or("");
        check(has_own(scopes, scope_id), "stored report scope missing")?;
        check(
            key == report.get("event_id").and_then(Value::as_str).unwrap_or(""),
            "invalid stored report",
        )?;
        let canonical_time = time(&received_at)?;
        check(
            canonical_time == received_at.as_str().unwrap_or(""),
            "invalid stored report",
        )?;
        check(
            equal(
                &input,
                &report_input(
                    &input,
                    scopes[scope_id]
                        .as_object()
                        .expect("the shape check accepted scopes"),
                )?,
            ),
            "invalid stored report",
        )?;
    }
    let values = js_object_values(reports);
    report_index(&values)?;
    Ok(())
}

/// `publicCostLedger(state)`: the read-only projection, or `null`.
pub fn public_cost_ledger(state: &Value) -> CostResult<Value> {
    let mut normalized_state = state.clone();
    normalize_js_value(&mut normalized_state);
    let state = &normalized_state;
    let ledger = match state.get("cost_ledger") {
        Some(ledger) if !is_js_falsy(ledger) => ledger,
        _ => return Ok(Value::Null),
    };
    let ledger_object = ledger
        .as_object()
        .ok_or_else(|| CostLedgerError::new("invalid ledger identity"))?;
    let reports_object = ledger_object
        .get("reports")
        .and_then(Value::as_object)
        .ok_or_else(|| CostLedgerError::new("invalid ledger identity"))?;
    let reports = js_object_values(reports_object);
    let lanes = report_index(&reports)?;
    // `selected`: the latest cumulative snapshot, or every event report.
    let mut selected: Vec<String> = Vec::new();
    for (_, lane) in &lanes {
        let values = lane.sorted();
        let Some(first) = values.first() else {
            continue;
        };
        let chosen: &[Value] = if first.get("mode").and_then(Value::as_str) == Some("cumulative") {
            &values[values.len() - 1..]
        } else {
            &values
        };
        for report in chosen {
            let event_id = report
                .get("event_id")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            if !selected.contains(&event_id) {
                selected.push(event_id);
            }
        }
    }
    // `byScope` keeps the reports in ledger insertion order.
    let mut by_scope: Vec<(String, Vec<Value>)> = Vec::new();
    for report in &reports {
        let scope_id = report
            .get("scope_id")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let event_id = report
            .get("event_id")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let mut entry = report.clone();
        if let Some(object) = entry.as_object_mut() {
            object.insert("included".into(), Value::Bool(selected.contains(&event_id)));
        }
        match by_scope.iter_mut().find(|(key, _)| key == &scope_id) {
            Some((_, entries)) => entries.push(entry),
            None => by_scope.push((scope_id, vec![entry])),
        }
    }
    let scopes_object = ledger_object
        .get("scopes")
        .and_then(Value::as_object)
        .ok_or_else(|| CostLedgerError::new("invalid ledger identity"))?;
    let mut scopes: Vec<Value> = Vec::with_capacity(scopes_object.len());
    for scope in js_object_values(scopes_object) {
        scopes.push(public_scope(&scope, &by_scope)?);
    }
    // `(a, b) => b.period_start.localeCompare(a.period_start) || a.scope_id...`
    scopes.sort_by(|left, right| {
        let left_start = left
            .get("period_start")
            .and_then(Value::as_str)
            .unwrap_or("");
        let right_start = right
            .get("period_start")
            .and_then(Value::as_str)
            .unwrap_or("");
        right_start.cmp(left_start).then_with(|| {
            js_locale_compare(
                left.get("scope_id").and_then(Value::as_str).unwrap_or(""),
                right.get("scope_id").and_then(Value::as_str).unwrap_or(""),
            )
        })
    });
    let mut output = Map::new();
    output.insert("schema".into(), json!(1));
    output.insert(
        "project_id".into(),
        ledger_object
            .get("project_id")
            .cloned()
            .unwrap_or(Value::Null),
    );
    output.insert("scopes".into(), Value::Array(scopes));
    Ok(Value::Object(output))
}

/// One projected scope: groups, unreported sources and the entry list.
fn public_scope(scope: &Value, by_scope: &[(String, Vec<Value>)]) -> CostResult<Value> {
    let scope_object = scope.as_object().expect("stored scopes are objects");
    let scope_id = scope.get("scope_id").and_then(Value::as_str).unwrap_or("");
    let mut entries = by_scope
        .iter()
        .find(|(key, _)| key == scope_id)
        .map(|(_, entries)| entries.clone())
        .unwrap_or_default();
    // Newest first, then by descending sequence, then by event_id.
    entries.sort_by(|left, right| {
        let left_time = left
            .get("observed_at")
            .and_then(Value::as_str)
            .unwrap_or("");
        let right_time = right
            .get("observed_at")
            .and_then(Value::as_str)
            .unwrap_or("");
        right_time.cmp(left_time).then_with(|| {
            let left_sequence = left.get("sequence").and_then(Value::as_f64).unwrap_or(0.0);
            let right_sequence = right.get("sequence").and_then(Value::as_f64).unwrap_or(0.0);
            right_sequence
                .partial_cmp(&left_sequence)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| {
                    js_locale_compare(
                        left.get("event_id").and_then(Value::as_str).unwrap_or(""),
                        right.get("event_id").and_then(Value::as_str).unwrap_or(""),
                    )
                })
        })
    });
    // `groups` is keyed by [source_kind, currency, level], insertion ordered.
    let mut groups: Vec<(String, Map<String, Value>, Vec<Value>)> = Vec::new();
    for report in entries
        .iter()
        .filter(|entry| entry.get("included").and_then(Value::as_bool) == Some(true))
    {
        let level = if report.get("target_id").is_none_or(Value::is_null) {
            "project_invoice"
        } else {
            "targets"
        };
        let key = serde_json::to_string(&Value::Array(vec![
            report.get("source_kind").cloned().unwrap_or(Value::Null),
            report.get("currency").cloned().unwrap_or(Value::Null),
            Value::String(level.to_string()),
        ]))
        .expect("group keys are JSON scalars");
        match groups.iter_mut().find(|(existing, _, _)| existing == &key) {
            Some((_, _, rows)) => rows.push(report.clone()),
            None => {
                let mut group = Map::new();
                group.insert(
                    "source_kind".into(),
                    report.get("source_kind").cloned().unwrap_or(Value::Null),
                );
                group.insert(
                    "currency".into(),
                    report.get("currency").cloned().unwrap_or(Value::Null),
                );
                group.insert("level".into(), Value::String(level.to_string()));
                groups.push((key, group, vec![report.clone()]));
            }
        }
    }
    let mut totals: Vec<Value> = Vec::with_capacity(groups.len());
    for (_, group, rows) in &groups {
        totals.push(group_total(group, rows, scope_object)?);
    }
    totals.sort_by(|left, right| {
        let index = |group: &Value| {
            COST_SOURCES
                .iter()
                .position(|source| {
                    Some(*source) == group.get("source_kind").and_then(Value::as_str)
                })
                .unwrap_or(usize::MAX)
        };
        index(left)
            .cmp(&index(right))
            .then_with(|| {
                left.get("currency")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .cmp(right.get("currency").and_then(Value::as_str).unwrap_or(""))
            })
            .then_with(|| {
                left.get("level")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .cmp(right.get("level").and_then(Value::as_str).unwrap_or(""))
            })
    });
    let unreported: Vec<Value> = COST_SOURCES
        .iter()
        .filter(|source| {
            !totals
                .iter()
                .any(|group| group.get("source_kind").and_then(Value::as_str) == Some(**source))
        })
        .map(|source| Value::String((*source).to_string()))
        .collect();
    let mut output = scope_object.clone();
    output.insert("groups".into(), Value::Array(totals));
    output.insert("unreported_sources".into(), Value::Array(unreported));
    output.insert("reports".into(), Value::Array(entries));
    Ok(Value::Object(output))
}

/// One group total: amount, certainty, coverage and token sums.
fn group_total(
    group: &Map<String, Value>,
    rows: &[Value],
    scope: &Map<String, Value>,
) -> CostResult<Value> {
    let level = group.get("level").and_then(Value::as_str).unwrap_or("");
    let known: Vec<&Value> = rows
        .iter()
        .filter(|row| row.get("amount").is_some_and(|amount| !amount.is_null()))
        .collect();
    let missing: Vec<Value> = if level == "project_invoice" {
        Vec::new()
    } else {
        scope
            .get("targets")
            .and_then(Value::as_array)
            .map(|targets| {
                targets
                    .iter()
                    .filter(|target| {
                        let target_id = target.get("target_id");
                        let rows_match = |amount_is_null: bool| {
                            rows.iter().any(|row| {
                                row.get("target_id") == target_id
                                    && row.get("amount").is_some_and(Value::is_null)
                                        == amount_is_null
                            })
                        };
                        !rows_match(false) || rows_match(true)
                    })
                    .map(|target| target.get("target_id").cloned().unwrap_or(Value::Null))
                    .collect()
            })
            .unwrap_or_default()
    };
    let any_unknown = rows
        .iter()
        .any(|row| row.get("amount").is_some_and(Value::is_null));
    let partial = scope.get("membership_complete").and_then(Value::as_bool) != Some(true)
        || !missing.is_empty()
        || any_unknown;
    let mut tokens = Map::new();
    for key in TOKEN_KEYS {
        let counters: Vec<Value> = rows
            .iter()
            .map(|row| {
                // `row.tokens?.[key]`: undefined and null both count as absent.
                row.get("tokens")
                    .and_then(|tokens| tokens.get(key))
                    .cloned()
                    .unwrap_or(Value::Null)
            })
            .collect();
        let valid: Vec<u64> = counters
            .iter()
            .filter(|counter| !counter.is_null())
            .filter_map(Value::as_u64)
            .collect();
        let value = if valid.is_empty() {
            Value::Null
        } else {
            Value::String(
                valid
                    .iter()
                    .map(|value| u128::from(*value))
                    .sum::<u128>()
                    .to_string(),
            )
        };
        let mut entry = Map::new();
        entry.insert("value".into(), value);
        entry.insert(
            "partial".into(),
            Value::Bool(valid.len() < rows.len() || partial),
        );
        tokens.insert(key.to_string(), Value::Object(entry));
    }
    let mut sum: u128 = 0;
    for row in &known {
        sum = sum.wrapping_add(units(row.get("amount").unwrap_or(&Value::Null))?);
    }
    let amount = if known.is_empty() {
        Value::Null
    } else {
        Value::String(decimal(sum))
    };
    let certainty = if known.is_empty() {
        "unknown"
    } else {
        certainty_for(
            group
                .get("source_kind")
                .and_then(Value::as_str)
                .unwrap_or(""),
        )
        .unwrap_or("unknown")
    };
    // `[...new Set(known.map(target_id).filter(id => id !== null && !missing.includes(id)))]`
    let mut covered: Vec<Value> = Vec::new();
    for row in &known {
        let target_id = row.get("target_id").cloned().unwrap_or(Value::Null);
        if target_id.is_null() || missing.contains(&target_id) || covered.contains(&target_id) {
            continue;
        }
        covered.push(target_id);
    }
    let observed_at = rows
        .iter()
        .filter_map(|row| row.get("observed_at").and_then(Value::as_str))
        .fold(String::new(), |latest, observed| {
            if observed > latest.as_str() {
                observed.to_string()
            } else {
                latest
            }
        });
    let mut output = group.clone();
    output.insert("amount".into(), amount);
    output.insert("certainty".into(), Value::String(certainty.to_string()));
    output.insert("partial".into(), Value::Bool(partial));
    output.insert("missing_targets".into(), Value::Array(missing));
    output.insert("covered_targets".into(), Value::Array(covered));
    output.insert("included_reports".into(), json!(rows.len()));
    output.insert("observed_at".into(), Value::String(observed_at));
    output.insert("tokens".into(), Value::Object(tokens));
    Ok(Value::Object(output))
}

/// The current instant as `new Date().toISOString()` prints it.
fn now_iso() -> String {
    let seconds = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs() as i64)
        .unwrap_or(0);
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.subsec_millis())
        .unwrap_or(0);
    format_iso(seconds, millis)
}

/// Format `YYYY-MM-DDTHH:MM:SS.mmmZ` from Unix seconds.
fn format_iso(seconds: i64, millis: u32) -> String {
    let days = seconds.div_euclid(86_400);
    let day_seconds = seconds.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    let hour = day_seconds / 3600;
    let minute = (day_seconds % 3600) / 60;
    let second = day_seconds % 60;
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{millis:03}Z")
}

/// Howard Hinnant's `civil_from_days`, for the proleptic Gregorian calendar.
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if month <= 2 { year + 1 } else { year }, month, day)
}

/// `str` / `nullable` / `timestamp` from the JS schema block.
fn schema_string(max: usize) -> Value {
    let mut field = Map::new();
    field.insert("type".into(), json!("string"));
    field.insert("minLength".into(), json!(1));
    field.insert("maxLength".into(), json!(max));
    Value::Object(field)
}

fn schema_nullable(max: usize) -> Value {
    let mut field = Map::new();
    field.insert("type".into(), json!(["string", "null"]));
    field.insert("minLength".into(), json!(1));
    field.insert("maxLength".into(), json!(max));
    Value::Object(field)
}

fn schema_timestamp() -> Value {
    let mut field = Map::new();
    field.insert("type".into(), json!("string"));
    field.insert("format".into(), json!("date-time"));
    Value::Object(field)
}

/// `schema(properties)`: `required` in property order, no extra keys allowed.
fn schema(properties: Map<String, Value>) -> Value {
    let required: Vec<Value> = properties.keys().map(|key| json!(key)).collect();
    let mut object = Map::new();
    object.insert("type".into(), json!("object"));
    object.insert("properties".into(), Value::Object(properties));
    object.insert("required".into(), Value::Array(required));
    object.insert("additionalProperties".into(), json!(false));
    Value::Object(object)
}

/// `costScopeSchema`: the JSON schema for one declared scope.
pub fn cost_scope_schema() -> Value {
    let mut target = Map::new();
    target.insert("target_id".into(), schema_string(160));
    target.insert("worker_id".into(), schema_string(160));
    target.insert("session_id".into(), schema_string(160));
    target.insert("run_id".into(), schema_nullable(160));
    target.insert("provider".into(), schema_nullable(160));
    target.insert("model".into(), schema_nullable(160));
    let mut targets = Map::new();
    targets.insert("type".into(), json!("array"));
    targets.insert("minItems".into(), json!(1));
    targets.insert("maxItems".into(), json!(100));
    targets.insert("items".into(), schema(target));
    let mut properties = Map::new();
    properties.insert("scope_id".into(), schema_string(160));
    properties.insert("project_id".into(), schema_string(160));
    properties.insert("period_start".into(), schema_timestamp());
    properties.insert("period_end".into(), schema_timestamp());
    properties.insert("membership_complete".into(), {
        let mut field = Map::new();
        field.insert("type".into(), json!("boolean"));
        Value::Object(field)
    });
    properties.insert("targets".into(), Value::Object(targets));
    schema(properties)
}

/// `costReportSchema`: the JSON schema for one reported observation.
pub fn cost_report_schema() -> Value {
    let mut token = Map::new();
    for key in TOKEN_KEYS {
        let mut field = Map::new();
        field.insert("type".into(), json!(["integer", "null"]));
        field.insert("minimum".into(), json!(0));
        field.insert("maximum".into(), json!(MAX_SAFE_INTEGER_JSON));
        token.insert(key.to_string(), Value::Object(field));
    }
    let mut tokens = schema(token);
    tokens
        .as_object_mut()
        .expect("schema() built an object")
        .insert("type".into(), json!(["object", "null"]));
    let mut properties = Map::new();
    properties.insert("event_id".into(), schema_string(160));
    properties.insert("scope_id".into(), schema_string(160));
    properties.insert("target_id".into(), schema_nullable(160));
    properties.insert("source_kind".into(), {
        let mut field = Map::new();
        field.insert("enum".into(), json!(COST_SOURCES));
        Value::Object(field)
    });
    properties.insert("source_ref".into(), schema_string(1000));
    properties.insert("observed_at".into(), schema_timestamp());
    properties.insert("mode".into(), {
        let mut field = Map::new();
        field.insert("enum".into(), json!(["event", "cumulative"]));
        Value::Object(field)
    });
    properties.insert("sequence".into(), {
        let mut field = Map::new();
        field.insert("type".into(), json!("integer"));
        field.insert("minimum".into(), json!(1));
        field.insert("maximum".into(), json!(MAX_SAFE_INTEGER_JSON));
        Value::Object(field)
    });
    properties.insert("currency".into(), {
        let mut field = Map::new();
        field.insert("type".into(), json!("string"));
        field.insert("pattern".into(), json!("^[A-Z]{3}$"));
        Value::Object(field)
    });
    properties.insert("amount".into(), {
        let mut field = Map::new();
        field.insert("type".into(), json!(["string", "null"]));
        field.insert(
            "pattern".into(),
            json!("^(?:0|[1-9]\\d{0,15})(?:\\.\\d{1,9})?$"),
        );
        Value::Object(field)
    });
    properties.insert("certainty".into(), {
        let mut field = Map::new();
        field.insert(
            "enum".into(),
            json!(["unknown", "reported", "estimated", "confirmed"]),
        );
        Value::Object(field)
    });
    properties.insert("tokens".into(), tokens);
    properties.insert("basis".into(), schema_string(2000));
    schema(properties)
}

/// Read one JSON file with the dashboard CLI's `localJson` rules: a regular
/// file of at most 256 KiB with strict UTF-8 and valid JSON.
fn read_json(input_file: &str) -> Result<Value> {
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NONBLOCK);
    }
    let file = options
        .open(input_file)
        .with_context(|| format!("cannot read JSON {input_file}"))?;
    let metadata = file
        .metadata()
        .with_context(|| format!("cannot read JSON {input_file}"))?;
    if !metadata.is_file() || metadata.len() > 256 * 1024 {
        bail!("Input JSON must be a regular file of at most 256 KiB");
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(256 * 1024 + 1)
        .read_to_end(&mut bytes)
        .with_context(|| format!("cannot read JSON {input_file}"))?;
    if bytes.len() > 256 * 1024 {
        bail!("Input JSON exceeds 256 KiB");
    }
    let Ok(text) = std::str::from_utf8(&bytes) else {
        bail!("Input JSON is invalid");
    };
    // TextDecoder("utf-8") in the dashboard CLI removed a leading BOM.
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let mut value = serde_json::from_str(text).map_err(|_| anyhow!("Input JSON is invalid"))?;
    normalize_js_value(&mut value);
    Ok(value)
}

/// The document shape both parity actions accept: `{ operation, state, input }`.
fn read_request(document: &Value) -> Result<(String, Value, Value)> {
    let object = document
        .as_object()
        .ok_or_else(|| anyhow!("Input JSON is invalid"))?;
    const CLI_KEYS: [&str; 3] = ["operation", "state", "input"];
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
    Ok((operation, state, input))
}

/// `rdsh cost-ledger <declare|report|validate|public|schema> --input-file`.
///
/// The file holds `{ operation, state, input }`: `state` is the project state
/// document, `input` the scope or report `declare`/`report` merge. `validate`,
/// `public` and `schema` read `state` alone and accept a missing `input`.
pub fn cmd_cost_ledger(action: &str, input_file: &str) -> Result<()> {
    let document = read_json(input_file)?;
    let (operation, mut state, input) = read_request(&document)?;
    if operation != action {
        bail!("Input JSON operation does not match the requested action");
    }
    if matches!(action, "declare" | "report") && !input.is_object() {
        bail!("Input JSON is invalid");
    }
    let mut output = Map::new();
    output.insert("operation".into(), json!(action));
    match action {
        "declare" => {
            declare_cost_scope(&mut state, &input)?;
            output.insert("declared".into(), json!(true));
            output.insert(
                "cost_ledger".into(),
                state.get("cost_ledger").cloned().unwrap_or(Value::Null),
            );
        }
        "report" => {
            record_cost_report(&mut state, &input)?;
            output.insert("recorded".into(), json!(true));
            output.insert(
                "cost_ledger".into(),
                state.get("cost_ledger").cloned().unwrap_or(Value::Null),
            );
        }
        "validate" => {
            validate_cost_ledger(&state)?;
            output.insert("valid".into(), json!(true));
        }
        "public" => {
            output.insert("cost_ledger".into(), public_cost_ledger(&state)?);
        }
        "schema" => {
            output.insert("cost_scope".into(), cost_scope_schema());
            output.insert("cost_report".into(), cost_report_schema());
        }
        other => bail!("unknown cost-ledger action {other}"),
    }
    let mut output = Value::Object(output);
    normalize_js_value(&mut output);
    let text = serde_json::to_string(&output).context("serialize cost ledger")?;
    let stdout = std::io::stdout();
    let mut handle = stdout.lock();
    writeln!(handle, "{text}")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state() -> Value {
        json!({ "schema": 1, "project": { "id": "project-1" } })
    }

    fn scope() -> Value {
        json!({
            "scope_id": "october-workers",
            "project_id": "project-1",
            "period_start": "2026-10-06T00:00:00Z",
            "period_end": "2026-10-07T00:00:00Z",
            "membership_complete": true,
            "targets": [
                {
                    "target_id": "target-1",
                    "worker_id": "worker-1",
                    "session_id": "session-1",
                    "run_id": null,
                    "provider": null,
                    "model": null,
                },
            ],
        })
    }

    fn report() -> Value {
        json!({
            "event_id": "usage-1",
            "scope_id": "october-workers",
            "target_id": "target-1",
            "source_kind": "provider_usage",
            "source_ref": "meter-1",
            "observed_at": "2026-10-06T01:00:00Z",
            "mode": "cumulative",
            "sequence": 1,
            "currency": "USD",
            "amount": "0.1",
            "certainty": "reported",
            "tokens": { "input": 10, "cached_input": 2, "output": 5 },
            "basis": "Fixture provider statement.",
        })
    }

    fn failing<T>(prefix: &str, result: CostResult<T>) {
        let error = result.err().expect("call should be refused");
        assert!(
            error.message.starts_with(prefix),
            "expected {prefix}, got {}",
            error.message
        );
    }

    #[test]
    fn units_and_decimal_round_trip_like_js_bigint() {
        assert_eq!(units(&json!("0")).unwrap(), 0);
        assert_eq!(units(&json!("1")).unwrap(), SCALE);
        assert_eq!(units(&json!("0.1")).unwrap(), 100_000_000);
        assert_eq!(units(&json!("0.000000001")).unwrap(), 1);
        assert_eq!(
            units(&json!("1234567890123456")).unwrap(),
            1_234_567_890_123_456 * SCALE
        );
        failing("amount must be", units(&json!("01")));
        failing("amount must be", units(&json!("-1")));
        failing("amount must be", units(&json!("1e-9")));
        failing("amount must be", units(&json!("0.1234567891")));
        failing("amount must be", units(&json!("12345678901234567")));
        assert_eq!(decimal(0), "0");
        assert_eq!(decimal(100_000_000), "0.1");
        assert_eq!(decimal(1), "0.000000001");
        assert_eq!(decimal(300_000_000), "0.3");
        assert_eq!(decimal(SCALE), "1");
    }

    #[test]
    fn time_requires_the_canonical_utc_spelling() {
        assert_eq!(
            time(&json!("2026-10-06T00:00:00Z")).unwrap(),
            "2026-10-06T00:00:00.000Z"
        );
        assert_eq!(
            time(&json!("2026-10-06T00:00:00.500Z")).unwrap(),
            "2026-10-06T00:00:00.500Z"
        );
        failing(
            "invalid UTC timestamp",
            time(&json!("2026-02-30T01:00:00Z")),
        );
        failing(
            "UTC timestamp required",
            time(&json!("2026-10-06T01:00:00+00:00")),
        );
        failing(
            "UTC timestamp required",
            time(&json!("2026-10-06T01:00:00.5Z")),
        );
        failing("UTC timestamp required", time(&json!(1)));
    }

    #[test]
    fn declare_is_idempotent_and_freezes_identity() {
        let mut state = state();
        declare_cost_scope(&mut state, &scope()).unwrap();
        let stored = state["cost_ledger"]["scopes"]["october-workers"].clone();
        assert_eq!(stored["scope_id"], "october-workers");
        assert_eq!(stored["targets"][0]["target_id"], "target-1");
        assert!(stored["declared_at"].as_str().unwrap().ends_with('Z'));
        // Re-declaring the same identity is a no-op.
        declare_cost_scope(&mut state, &scope()).unwrap();
        let mut changed = scope();
        changed["membership_complete"] = json!(false);
        failing(
            "scope identity is immutable",
            declare_cost_scope(&mut state, &changed),
        );
    }

    #[test]
    fn declare_rejects_another_project_and_duplicate_targets() {
        let mut state = state();
        let mut other = scope();
        other["project_id"] = json!("project-2");
        failing(
            "scope belongs to another project",
            declare_cost_scope(&mut state, &other),
        );
        let mut duplicated = scope();
        let target = duplicated["targets"][0].clone();
        duplicated["targets"] = json!([target.clone(), target]);
        failing(
            "duplicate target identity",
            declare_cost_scope(&mut state, &duplicated),
        );
    }

    #[test]
    fn report_requires_a_declared_scope_and_normalizes_the_amount() {
        let mut state = state();
        failing(
            "declare the exact scope before reporting",
            record_cost_report(&mut state, &report()),
        );
        declare_cost_scope(&mut state, &scope()).unwrap();
        record_cost_report(&mut state, &report()).unwrap();
        let stored = state["cost_ledger"]["reports"]["usage-1"].clone();
        assert_eq!(stored["amount"], "0.1");
        assert_eq!(stored["certainty"], "reported");
        assert_eq!(stored["tokens"]["input"], 10);
        // A repeated identical report is idempotent.
        record_cost_report(&mut state, &report()).unwrap();
        let mut forged = report();
        forged["amount"] = json!("9");
        failing(
            "event ID already refers to different data",
            record_cost_report(&mut state, &forged),
        );
    }

    #[test]
    fn report_rejects_unknown_sources_targets_and_certainty() {
        let mut state = state();
        declare_cost_scope(&mut state, &scope()).unwrap();
        for (patch, message) in [
            (json!({ "source_kind": "guessed" }), "unknown source kind"),
            (json!({ "target_id": "missing" }), "unknown target"),
            (json!({ "currency": "usd" }), "currency must be"),
            (json!({ "mode": "snapshot" }), "invalid report mode"),
            (json!({ "sequence": 0 }), "positive stable sequence"),
            (json!({ "amount": "1e-9" }), "amount must be"),
            (json!({ "certainty": "confirmed" }), "certainty must match"),
            (
                json!({ "tokens": { "input": 1, "cached_input": 2, "output": null } }),
                "cached input exceeds input",
            ),
            (
                json!({ "observed_at": "2026-10-05T23:00:00Z" }),
                "observation precedes",
            ),
            (
                json!({ "unexpected": true }),
                "unexpected or missing fields",
            ),
        ] {
            let mut forged = report();
            for (key, value) in patch.as_object().unwrap() {
                forged[key] = value.clone();
            }
            failing(message, record_cost_report(&mut state, &forged));
        }
    }

    #[test]
    fn cumulative_streams_reject_decreases_and_time_travel() {
        let mut state = state();
        declare_cost_scope(&mut state, &scope()).unwrap();
        record_cost_report(&mut state, &report()).unwrap();
        let mut decreased = report();
        decreased["event_id"] = json!("usage-2");
        decreased["sequence"] = json!(2);
        decreased["amount"] = json!("0.01");
        decreased["observed_at"] = json!("2026-10-06T02:00:00Z");
        failing(
            "cumulative counter decreased",
            record_cost_report(&mut state, &decreased),
        );
        let mut backwards = report();
        backwards["event_id"] = json!("usage-3");
        backwards["sequence"] = json!(3);
        backwards["amount"] = json!("0.2");
        backwards["observed_at"] = json!("2026-10-06T00:30:00Z");
        failing(
            "cumulative observation time moved backwards",
            record_cost_report(&mut state, &backwards),
        );
    }

    #[test]
    fn public_projection_reports_the_latest_cumulative_snapshot() {
        let mut state = state();
        declare_cost_scope(&mut state, &scope()).unwrap();
        record_cost_report(&mut state, &report()).unwrap();
        let mut later = report();
        later["event_id"] = json!("usage-2");
        later["sequence"] = json!(2);
        later["amount"] = json!("0.3");
        later["observed_at"] = json!("2026-10-06T02:00:00Z");
        record_cost_report(&mut state, &later).unwrap();
        let public = public_cost_ledger(&state).unwrap();
        assert_eq!(public["schema"], 1);
        assert_eq!(public["scopes"][0]["scope_id"], "october-workers");
        let group = &public["scopes"][0]["groups"][0];
        assert_eq!(group["source_kind"], "provider_usage");
        assert_eq!(group["amount"], "0.3");
        assert_eq!(group["included_reports"], 1);
        // A cumulative snapshot replaces the earlier one, so only report 2 is
        // included and its own counters are summed.
        assert_eq!(group["tokens"]["input"]["value"], "10");
        assert_eq!(group["partial"], false);
        assert_eq!(
            public["scopes"][0]["unreported_sources"]
                .as_array()
                .unwrap()
                .len(),
            3
        );
        // Entries are newest first: usage-2 (the included snapshot), then
        // usage-1, which that snapshot replaced.
        assert_eq!(public["scopes"][0]["reports"][0]["event_id"], "usage-2");
        assert_eq!(public["scopes"][0]["reports"][0]["included"], true);
        assert_eq!(public["scopes"][0]["reports"][1]["event_id"], "usage-1");
        assert_eq!(public["scopes"][0]["reports"][1]["included"], false);
    }

    #[test]
    fn validate_accepts_a_missing_document_and_the_recorded_one() {
        validate_cost_ledger(&state()).unwrap();
        let mut recorded = state();
        declare_cost_scope(&mut recorded, &scope()).unwrap();
        record_cost_report(&mut recorded, &report()).unwrap();
        validate_cost_ledger(&recorded).unwrap();
        // A tampered stored amount fails inside `reportInput`, so the inner
        // message surfaces (the JS module throws the same one).
        let mut corrupted = recorded.clone();
        corrupted["cost_ledger"]["reports"]["usage-1"]["amount"] = json!("-5");
        failing("amount must be", validate_cost_ledger(&corrupted));
        // An extra key is refused.
        let mut extra = recorded.clone();
        extra["cost_ledger"]["extra"] = json!(1);
        failing("unexpected or missing fields", validate_cost_ledger(&extra));
        // `null` is stored, not absent, so it is refused as well.
        let mut null_ledger = state();
        null_ledger["cost_ledger"] = Value::Null;
        failing(
            "unexpected or missing fields",
            validate_cost_ledger(&null_ledger),
        );
    }

    #[test]
    fn schemas_keep_the_advertised_shape() {
        let scope = cost_scope_schema();
        assert_eq!(scope["type"], "object");
        assert_eq!(scope["additionalProperties"], false);
        let keys: Vec<&String> = scope["properties"].as_object().unwrap().keys().collect();
        assert_eq!(
            keys,
            [
                "scope_id",
                "project_id",
                "period_start",
                "period_end",
                "membership_complete",
                "targets"
            ]
        );
        assert_eq!(
            scope["required"],
            json!([
                "scope_id",
                "project_id",
                "period_start",
                "period_end",
                "membership_complete",
                "targets"
            ])
        );
        let report = cost_report_schema();
        assert_eq!(
            report["properties"]["amount"]["pattern"],
            "^(?:0|[1-9]\\d{0,15})(?:\\.\\d{1,9})?$"
        );
        assert_eq!(
            report["properties"]["source_kind"]["enum"],
            json!(COST_SOURCES)
        );
        assert_eq!(
            report["properties"]["tokens"]["type"],
            json!(["object", "null"])
        );
        assert_eq!(
            report["properties"]["tokens"]["required"],
            json!(["input", "cached_input", "output"])
        );
        assert_eq!(report["properties"]["basis"]["maxLength"], 2000);
    }

    #[test]
    fn identifiers_match_the_js_pattern_and_refuse_prototype_names() {
        assert_eq!(identifier(&json!("a")).unwrap(), "a");
        assert_eq!(identifier(&json!("A1_.:-")).unwrap(), "A1_.:-");
        assert_eq!(identifier(&json!("a".repeat(160))).unwrap().len(), 160);
        failing("invalid identifier", identifier(&json!("_a")));
        failing("invalid identifier", identifier(&json!("a".repeat(161))));
        failing("invalid identifier", identifier(&json!("__proto__")));
        failing("invalid identifier", identifier(&json!("constructor")));
        failing("invalid identifier", identifier(&json!(1)));
    }

    #[test]
    fn source_text_uses_ecmascript_trim_characters() {
        failing("invalid source text", text(&json!("\u{feff}"), 10));
        assert_eq!(text(&json!("\u{0085}"), 10).unwrap(), "\u{0085}");
    }

    #[test]
    fn stored_timestamp_errors_are_preserved() {
        let mut state = state();
        declare_cost_scope(&mut state, &scope()).unwrap();
        state["cost_ledger"]["scopes"]["october-workers"]["declared_at"] = json!("not-a-timestamp");
        failing("UTC timestamp required", validate_cost_ledger(&state));
    }

    #[test]
    fn validation_preserves_object_rest_key_order() {
        let mut state = state();
        declare_cost_scope(&mut state, &scope()).unwrap();
        record_cost_report(&mut state, &report()).unwrap();

        let stored_scope = state["cost_ledger"]["scopes"]["october-workers"]
            .as_object()
            .unwrap()
            .clone();
        let mut reordered_scope = Map::new();
        for (key, value) in stored_scope {
            if key == "period_start" {
                reordered_scope.insert(key, value);
                reordered_scope.insert(
                    "declared_at".into(),
                    state["cost_ledger"]["scopes"]["october-workers"]["declared_at"].clone(),
                );
            } else if key != "declared_at" {
                reordered_scope.insert(key, value);
            }
        }
        state["cost_ledger"]["scopes"]["october-workers"] = Value::Object(reordered_scope);

        let stored_report = state["cost_ledger"]["reports"]["usage-1"]
            .as_object()
            .unwrap()
            .clone();
        let mut reordered_report = Map::new();
        for (key, value) in stored_report {
            if key == "observed_at" {
                reordered_report.insert(key, value);
                reordered_report.insert(
                    "received_at".into(),
                    state["cost_ledger"]["reports"]["usage-1"]["received_at"].clone(),
                );
            } else if key != "received_at" {
                reordered_report.insert(key, value);
            }
        }
        state["cost_ledger"]["reports"]["usage-1"] = Value::Object(reordered_report);
        validate_cost_ledger(&state).unwrap();
    }

    #[test]
    fn public_scope_tie_break_matches_javascript_locale_compare() {
        let mut state = state();
        for scope_id in ["B", "a", "a-b", "a_b"] {
            let mut input = scope();
            input["scope_id"] = json!(scope_id);
            declare_cost_scope(&mut state, &input).unwrap();
        }
        let public = public_cost_ledger(&state).unwrap();
        let ids: Vec<&str> = public["scopes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|scope| scope["scope_id"].as_str().unwrap())
            .collect();
        assert_eq!(ids, ["a", "a_b", "a-b", "B"]);
    }

    #[test]
    fn public_event_tie_break_matches_javascript_locale_compare() {
        let mut state = state();
        declare_cost_scope(&mut state, &scope()).unwrap();
        for (event_id, source_kind) in [("B", "cli_report"), ("a", "api_estimate")] {
            let mut input = report();
            input["event_id"] = json!(event_id);
            input["source_kind"] = json!(source_kind);
            input["mode"] = json!("event");
            input["amount"] = Value::Null;
            input["certainty"] = json!("unknown");
            record_cost_report(&mut state, &input).unwrap();
        }
        let public = public_cost_ledger(&state).unwrap();
        let ids: Vec<&str> = public["scopes"][0]["reports"]
            .as_array()
            .unwrap()
            .iter()
            .map(|report| report["event_id"].as_str().unwrap())
            .collect();
        assert_eq!(ids, ["a", "B"]);
    }

    #[test]
    fn accepted_safe_integer_numbers_are_canonicalized_before_storage() {
        let mut state = state();
        declare_cost_scope(&mut state, &scope()).unwrap();
        let mut floating = report();
        floating["sequence"] = json!(1.0);
        floating["tokens"]["input"] = json!(10.0);
        floating["tokens"]["cached_input"] = json!(2.0);
        floating["tokens"]["output"] = json!(5.0);
        record_cost_report(&mut state, &floating).unwrap();

        let stored = &state["cost_ledger"]["reports"]["usage-1"];
        assert_eq!(serde_json::to_string(&stored["sequence"]).unwrap(), "1");
        assert_eq!(
            serde_json::to_string(&stored["tokens"]["input"]).unwrap(),
            "10"
        );
        record_cost_report(&mut state, &report()).unwrap();

        state["cost_ledger"]["schema"] = json!(1.0);
        validate_cost_ledger(&state).unwrap();
        let public = public_cost_ledger(&state).unwrap();
        assert_eq!(
            public["scopes"][0]["groups"][0]["tokens"]["input"]["value"],
            "10"
        );
    }

    #[test]
    fn json_reader_matches_javascript_integer_keys_and_safe_integers() {
        let path = std::env::temp_dir().join(format!(
            "rdsh-cost-ledger-json-{}-{}.json",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::write(&path, r#"{"10":1.0,"2":2,"name":3e0}"#).unwrap();
        let value = read_json(path.to_str().unwrap()).unwrap();
        let _ = std::fs::remove_file(&path);
        assert_eq!(
            serde_json::to_string(&value).unwrap(),
            r#"{"2":2,"10":1,"name":3}"#
        );
    }
}
