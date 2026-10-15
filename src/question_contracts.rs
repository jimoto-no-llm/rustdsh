//! Typed question contracts for one project state document.
//!
//! Rust port of `dashboard/question-contracts.mjs`. It normalises a typed
//! question decision, applies one `question`/`answer` mutation to the stored
//! cards, projects the public view the dashboard shows, recomputes the
//! validity of one stored feedback message and validates a whole extension.
//!
//! Every export is pure logic over the state document: no file, no clock, no
//! network. The three actions mirror the JS exports one for one:
//!
//! * `apply`    — `changeQuestionContract` / `answerQuestionContract`
//! * `public`   — `publicQuestionContracts` / `feedbackValidity`
//! * `validate` — `validateQuestionContracts`
//!
//! `dashboard/state.mjs` still imports the JS module in-process and calls
//! `validateQuestionContracts` on every store open, `changeQuestionContract`
//! and `answerQuestionContract` on every `question`/`answer` mutation, and
//! `publicQuestionContracts`/`feedbackValidity` on every public projection, so
//! deleting the JS module would put a synchronous Rust call on the store's hot
//! path. This module lands alongside it; the outputs are byte-identical, and
//! `tests/question_contracts_cli.rs` pins the same JSON the JS module produced.

use std::io::Write;

use anyhow::{anyhow, bail, Context, Result};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

/// The error the JS module throws with `check(condition, message, conflict)`,
/// carrying the 409 marker `error.status = 409` the dashboard maps to HTTP.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QuestionError {
    pub message: String,
    /// `conflict`, which `dashboard/state.mjs` turns into an HTTP 409.
    pub conflict: bool,
}

impl QuestionError {
    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            conflict: false,
        }
    }

    fn conflict(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            conflict: true,
        }
    }
}

impl std::fmt::Display for QuestionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Question contracts: {}", self.message)
    }
}

impl std::error::Error for QuestionError {}

type QuestionResult<T> = std::result::Result<T, QuestionError>;

/// `check(condition, message)`.
fn check(condition: bool, message: &str) -> QuestionResult<()> {
    if condition {
        Ok(())
    } else {
        Err(QuestionError::new(message))
    }
}

/// `check(condition, message, true)`.
fn check_conflict(condition: bool, message: &str) -> QuestionResult<()> {
    if condition {
        Ok(())
    } else {
        Err(QuestionError::conflict(message))
    }
}

/// `own(value)`: a non-null object that is not an array.
fn own(value: &Value) -> bool {
    value.is_object()
}

/// `keys(value, allowed)`: an object whose every own key is in `allowed`.
///
/// JS treats `undefined` and `null` the same here, so a missing value fails.
fn keys(value: Option<&Value>, allowed: &[&str]) -> QuestionResult<()> {
    let valid = value.is_some_and(|value| {
        own(value)
            && value
                .as_object()
                .expect("own() proved an object")
                .keys()
                .all(|key| allowed.contains(&key.as_str()))
    });
    check(valid, "Unknown question contract field")
}

/// `value == null`, the loose check JS uses before an optional access.
fn is_nullish(value: Option<&Value>) -> bool {
    value.is_none_or(Value::is_null)
}

/// The ECMAScript `String.prototype.trim` whitespace set.
fn is_js_space(character: char) -> bool {
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

/// The UTF-16 code unit count, which is what `value.length` reports in JS.
fn utf16_len(text: &str) -> usize {
    text.chars().map(char::len_utf16).sum()
}

/// `text(value, label, max)`: a string that trims to something and fits `max`.
fn text(value: Option<&Value>, label: &str, max: usize) -> QuestionResult<String> {
    let valid = value
        .and_then(Value::as_str)
        .is_some_and(|text| text.trim_matches(is_js_space).chars().next().is_some())
        && value
            .and_then(Value::as_str)
            .is_some_and(|text| utf16_len(text) <= max);
    if !valid {
        return Err(QuestionError::new(format!("Invalid {label}")));
    }
    Ok(value
        .and_then(Value::as_str)
        .expect("validated above")
        .to_string())
}

/// `optional(value, label, max)`: `""` for a nullish or empty value.
fn optional(value: Option<&Value>, label: &str, max: usize) -> QuestionResult<String> {
    match value {
        None | Some(Value::Null) => Ok(String::new()),
        Some(Value::String(text_value)) if text_value.is_empty() => Ok(String::new()),
        Some(value) => text(Some(value), label, max),
    }
}

/// `identifier(value, label)`: text that is not a prototype-pollution name.
fn identifier(value: Option<&Value>, label: &str) -> QuestionResult<String> {
    let result = text(value, label, 160)?;
    check(
        !["__proto__", "constructor", "prototype"].contains(&result.as_str()),
        &format!("Invalid {label}"),
    )?;
    Ok(result)
}

/// `digest(value)`: the sha256 hex of `JSON.stringify(value)`.
fn digest(value: &Value) -> String {
    let json = crate::js_json::stringify(value);
    let mut hasher = Sha256::new();
    hasher.update(json.as_bytes());
    let bytes = hasher.finalize();
    let mut hex = String::with_capacity(64);
    for byte in bytes {
        hex.push_str(&format!("{byte:02x}"));
    }
    hex
}

/// `timestamp(value)`: `null`, or the canonical `toISOString()` spelling.
///
/// `Date.parse` accepts more spellings than `toISOString` emits, so the port
/// reparses whatever the JS parser accepts and returns the canonical instant —
/// which is exactly what `new Date(value).toISOString()` does.
fn timestamp(value: Option<&Value>) -> QuestionResult<Value> {
    if is_nullish(value) {
        return Ok(Value::Null);
    }
    let Some(text) = value.and_then(Value::as_str) else {
        return Err(QuestionError::new("Invalid expires_at"));
    };
    let Some(instant) = parse_js_date(text) else {
        return Err(QuestionError::new("Invalid expires_at"));
    };
    Ok(Value::String(instant))
}

/// The ISO date and date-time spellings needed to match the JavaScript module:
/// date-only UTC, local date-times, and explicit `Z`/numeric offsets.
fn parse_js_date(text: &str) -> Option<String> {
    parse_iso_millis(text).map(format_iso)
}

/// Parse an ISO date to the ECMAScript millisecond instant, shared by every
/// contract expiry and answer-feedback guard.
pub(crate) fn parse_iso_millis(text: &str) -> Option<i64> {
    let bytes = text.as_bytes();
    let digits = |range: std::ops::Range<usize>| -> Option<u32> {
        let slice = bytes.get(range)?;
        if slice.iter().all(u8::is_ascii_digit) {
            std::str::from_utf8(slice).ok()?.parse().ok()
        } else {
            None
        }
    };
    let (year, month_start) = match bytes.first().copied()? {
        sign @ (b'+' | b'-') => {
            if bytes.get(7) != Some(&b'-') {
                return None;
            }
            let magnitude = digits_abs(bytes, 1..7)? as i64;
            if sign == b'-' && magnitude == 0 {
                return None;
            }
            (if sign == b'-' { -magnitude } else { magnitude }, 8)
        }
        _ => {
            if bytes.get(4) != Some(&b'-') {
                return None;
            }
            (digits(0..4)? as i64, 5)
        }
    };
    let month_end = month_start + 2;
    if bytes.get(month_end) != Some(&b'-') {
        return None;
    }
    let day_start = month_end + 1;
    let date_length = day_start + 2;
    if bytes.len() < date_length {
        return None;
    }
    let month = digits(month_start..month_end)? as i64;
    let day = digits(day_start..date_length)? as i64;
    // The ECMAScript Date parser normalises a day that overflows a short month
    // (2026-02-30 becomes 2026-03-02), so the day only has to be 1..=31 here.
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    // ECMAScript interprets an ISO date-only form as midnight UTC.
    if bytes.len() == date_length {
        return time_clip(days_from_civil(year, month, day) * 86_400_000);
    }
    // The ISO `T` separator is standard. JavaScript engines also accept a
    // space in this position, so keep that common Date.parse spelling.
    if !matches!(bytes.get(date_length), Some(b'T' | b' ')) || bytes.len() < date_length + 6 {
        return None;
    }
    if bytes[date_length + 3] != b':' {
        return None;
    }
    let (hour, minute) = (
        digits(date_length + 1..date_length + 3)? as i64,
        digits(date_length + 4..date_length + 6)? as i64,
    );
    let mut cursor = date_length + 6;
    let second = if bytes.get(cursor) == Some(&b':') {
        cursor += 1;
        let second = digits(cursor..cursor + 2)? as i64;
        cursor += 2;
        second
    } else {
        0
    };
    if hour > 24 || minute > 59 || second > 59 {
        return None;
    }
    let mut millis = 0i64;
    if let Some(fraction) = text.get(cursor..)?.strip_prefix('.') {
        let end = fraction
            .find(|character: char| !character.is_ascii_digit())
            .unwrap_or(fraction.len());
        if end == 0 {
            return None;
        }
        // Only the first three digits reach the instant; the Date parser
        // truncates rather than rounds.
        let mut padded = fraction[..end].to_string();
        while padded.len() < 3 {
            padded.push('0');
        }
        millis = padded[..3].parse().ok()?;
        cursor += 1 + end;
    }
    let rest = text.get(cursor..)?;
    let offset = match rest.as_bytes() {
        [b'Z'] | [b'z'] => Some((b'Z', 0i64, 0i64)),
        [sign @ (b'+' | b'-'), _, _, _, _] => {
            let hours = digits_abs(rest.as_bytes(), 1..3)? as i64;
            let minutes = digits_abs(rest.as_bytes(), 3..5)? as i64;
            Some((*sign, hours, minutes))
        }
        [sign @ (b'+' | b'-'), _, _, b':', _, _] => {
            let hours = digits_abs(rest.as_bytes(), 1..3)? as i64;
            let minutes = digits_abs(rest.as_bytes(), 4..6)? as i64;
            Some((*sign, hours, minutes))
        }
        [] => None,
        _ => return None,
    };
    if hour == 24 && (minute != 0 || second != 0 || millis != 0) {
        return None;
    }
    let local_seconds =
        days_from_civil(year, month, day) * 86_400 + hour * 3_600 + minute * 60 + second;
    if let Some(offset) = offset {
        let offset = match offset {
            (b'Z' | b'z', _, _) => 0,
            (sign, hours, minutes) if hours <= 23 && minutes <= 59 => {
                let total = hours * 3_600_000 + minutes * 60_000;
                if sign == b'+' {
                    total
                } else {
                    -total
                }
            }
            _ => return None,
        };
        return time_clip(local_seconds * 1000 + millis - offset);
    }

    // A date-time without an explicit zone is interpreted in the process's
    // local timezone by JavaScript. Normalize overflowing day/hour fields
    // before handing the wall time to the platform timezone converter.
    let local_days = local_seconds.div_euclid(86_400);
    let local_time = local_seconds.rem_euclid(86_400);
    let (local_year, local_month, local_day) = civil_from_days(local_days);
    let local_hour = local_time / 3_600;
    let local_minute = local_time % 3_600 / 60;
    let local_second = local_time % 60;
    local_datetime_millis(
        local_year,
        local_month,
        local_day,
        local_hour,
        local_minute,
        local_second,
        millis,
    )
    .and_then(time_clip)
}

fn time_clip(millis: i64) -> Option<i64> {
    const LIMIT: i64 = 8_640_000_000_000_000;
    (-LIMIT..=LIMIT).contains(&millis).then_some(millis)
}

#[cfg(unix)]
fn local_datetime_millis(
    year: i64,
    month: i64,
    day: i64,
    hour: i64,
    minute: i64,
    second: i64,
    millis: i64,
) -> Option<i64> {
    let mut local: libc::tm = unsafe { std::mem::zeroed() };
    local.tm_year = i32::try_from(year - 1900).ok()?;
    local.tm_mon = i32::try_from(month - 1).ok()?;
    local.tm_mday = i32::try_from(day).ok()?;
    local.tm_hour = i32::try_from(hour).ok()?;
    local.tm_min = i32::try_from(minute).ok()?;
    local.tm_sec = i32::try_from(second).ok()?;
    local.tm_isdst = -1;
    let seconds = unsafe { libc::mktime(&mut local) } as i64;
    seconds.checked_mul(1000)?.checked_add(millis)
}

#[cfg(windows)]
#[repr(C)]
struct WindowsSystemTime {
    year: u16,
    month: u16,
    day_of_week: u16,
    day: u16,
    hour: u16,
    minute: u16,
    second: u16,
    milliseconds: u16,
}

#[cfg(windows)]
#[link(name = "kernel32")]
unsafe extern "system" {
    fn TzSpecificLocalTimeToSystemTime(
        timezone: *const std::ffi::c_void,
        local: *const WindowsSystemTime,
        utc: *mut WindowsSystemTime,
    ) -> i32;
}

#[cfg(windows)]
fn local_datetime_millis(
    year: i64,
    month: i64,
    day: i64,
    hour: i64,
    minute: i64,
    second: i64,
    millis: i64,
) -> Option<i64> {
    let local = WindowsSystemTime {
        year: u16::try_from(year).ok()?,
        month: u16::try_from(month).ok()?,
        day_of_week: 0,
        day: u16::try_from(day).ok()?,
        hour: u16::try_from(hour).ok()?,
        minute: u16::try_from(minute).ok()?,
        second: u16::try_from(second).ok()?,
        milliseconds: u16::try_from(millis).ok()?,
    };
    let mut utc = WindowsSystemTime {
        year: 0,
        month: 0,
        day_of_week: 0,
        day: 0,
        hour: 0,
        minute: 0,
        second: 0,
        milliseconds: 0,
    };
    let success = unsafe { TzSpecificLocalTimeToSystemTime(std::ptr::null(), &local, &mut utc) };
    if success == 0 {
        return None;
    }
    let days = days_from_civil(utc.year.into(), utc.month.into(), utc.day.into());
    let seconds = days * 86_400
        + i64::from(utc.hour) * 3_600
        + i64::from(utc.minute) * 60
        + i64::from(utc.second);
    seconds
        .checked_mul(1000)?
        .checked_add(i64::from(utc.milliseconds))
}

#[cfg(not(any(unix, windows)))]
fn local_datetime_millis(
    _year: i64,
    _month: i64,
    _day: i64,
    _hour: i64,
    _minute: i64,
    _second: i64,
    _millis: i64,
) -> Option<i64> {
    None
}

fn digits_abs(bytes: &[u8], range: std::ops::Range<usize>) -> Option<u32> {
    let slice = bytes.get(range)?;
    if slice.iter().all(u8::is_ascii_digit) {
        std::str::from_utf8(slice).ok()?.parse().ok()
    } else {
        None
    }
}

/// `new Date(millis).toISOString()`, including the extended year form the JS
/// spec uses outside 0000..9999.
fn format_iso(millis: i64) -> String {
    let seconds = millis.div_euclid(1000);
    let remainder = millis.rem_euclid(1000);
    let days = seconds.div_euclid(86_400);
    let time = seconds.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    let (hour, minute, second) = (time / 3600, (time % 3600) / 60, time % 60);
    let calendar = if (0..=9999).contains(&year) {
        format!("{year:04}-{month:02}-{day:02}")
    } else if year < 0 {
        format!("-{:06}-{month:02}-{day:02}", -year)
    } else {
        format!("+{year:06}-{month:02}-{day:02}")
    };
    format!("{calendar}T{hour:02}:{minute:02}:{second:02}.{remainder:03}Z")
}

/// Howard Hinnant's `days_from_civil`: days since 1970-01-01 for a civil date.
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

/// `Number.isFinite(Date.parse(value))`.
fn parseable(value: Option<&Value>) -> bool {
    value
        .and_then(Value::as_str)
        .and_then(parse_js_date)
        .is_some()
}

/// `Number.isSafeInteger(value)`.
fn is_safe_integer(value: Option<&Value>) -> bool {
    value
        .and_then(Value::as_i64)
        .is_some_and(|number| (-9_007_199_254_740_991..=9_007_199_254_740_991).contains(&number))
}

/// `JSON.stringify(a) !== JSON.stringify(b)`.
fn differs(left: Option<&Value>, right: Option<&Value>) -> bool {
    // `JSON.stringify(undefined)` is `undefined`, which never equals a
    // string, so a missing key differs from any present value.
    let render = |value: Option<&Value>| value.map(crate::js_json::stringify);
    render(left) != render(right)
}

/// The keys `normalizeDecision` accepts, in JS declaration order.
const DECISION_KEYS: [&str; 11] = [
    "kind",
    "target",
    "choices",
    "recommended_choice",
    "recommendation_reason",
    "diff",
    "impact",
    "conditions",
    "cost",
    "expires_at",
    "consumer_id",
];

/// `normalizeDecision(input)`: the validated, canonical decision record.
fn normalize_decision(input: Option<&Value>) -> QuestionResult<Value> {
    keys(input, &DECISION_KEYS)?;
    let kind = input.and_then(|value| value.get("kind"));
    check(
        kind.and_then(Value::as_str)
            .is_some_and(|kind| ["consultation", "approval"].contains(&kind)),
        "Invalid question kind",
    )?;
    let target_input = input.and_then(|value| value.get("target"));
    let target = if is_nullish(target_input) {
        Value::Null
    } else {
        keys(
            target_input,
            &["task_id", "run_id", "session_id", "action_id", "revision"],
        )?;
        let target_input = target_input.expect("checked above");
        let mut fields = Vec::with_capacity(4);
        for key in ["task_id", "run_id", "session_id", "action_id"] {
            let value = target_input.get(key);
            fields.push(if is_nullish(value) {
                None
            } else {
                Some(identifier(value, key)?)
            });
        }
        check(
            fields.iter().any(Option::is_some),
            "Target requires an entity id",
        )?;
        let mut target = Map::new();
        for (key, field) in ["task_id", "run_id", "session_id", "action_id"]
            .into_iter()
            .zip(fields)
        {
            target.insert(key.to_string(), field.map_or(Value::Null, Value::String));
        }
        target.insert(
            "revision".to_string(),
            Value::String(identifier(target_input.get("revision"), "target revision")?),
        );
        Value::Object(target)
    };
    let choices_input = match input.and_then(|value| value.get("choices")) {
        Some(Value::Null) | None => Vec::new(),
        Some(Value::Array(choices)) => choices.clone(),
        // `input.choices ?? []` keeps any other value, and the `Array.isArray`
        // guard below rejects it.
        Some(other) => {
            check(false, "At most eight choices are allowed")?;
            let _ = other;
            unreachable!("the guard above always throws")
        }
    };
    check(
        choices_input.len() <= 8,
        "At most eight choices are allowed",
    )?;
    let mut normalized_choices = Vec::with_capacity(choices_input.len());
    for choice in &choices_input {
        keys(Some(choice), &["id", "label", "detail"])?;
        let mut output = Map::new();
        output.insert(
            "id".to_string(),
            Value::String(identifier(choice.get("id"), "choice id")?),
        );
        output.insert(
            "label".to_string(),
            Value::String(text(choice.get("label"), "choice label", 160)?),
        );
        output.insert(
            "detail".to_string(),
            Value::String(optional(choice.get("detail"), "choice detail", 2000)?),
        );
        normalized_choices.push(Value::Object(output));
    }
    // `new Set(ids).size === choices.length`: every id is a string already.
    let mut seen = std::collections::HashSet::with_capacity(normalized_choices.len());
    for choice in &normalized_choices {
        seen.insert(choice["id"].as_str().expect("choice ids are strings"));
    }
    check(seen.len() == choices_input.len(), "Duplicate choice id")?;
    let recommended = match input.and_then(|value| value.get("recommended_choice")) {
        Some(Value::Null) | None => Value::Null,
        Some(value) => value.clone(),
    };
    check(
        recommended.is_null()
            || normalized_choices
                .iter()
                .any(|choice| choice["id"] == recommended),
        "Recommended choice does not exist",
    )?;
    let recommendation_reason = optional(
        input.and_then(|value| value.get("recommendation_reason")),
        "recommendation reason",
        2000,
    )?;
    check(
        recommended.is_null() || !recommendation_reason.is_empty(),
        "A recommendation requires its reason",
    )?;
    // `result.cost` stays absent unless the input carried a non-null one, so an
    // approval with `cost: undefined` reports the missing-cost message.
    let mut cost = None;
    let cost_input = input.and_then(|value| value.get("cost"));
    if !is_nullish(cost_input) {
        keys(cost_input, &["currency", "max", "description"])?;
        let cost_input = cost_input.expect("checked above");
        let maximum = cost_input.get("max");
        let valid_max = match maximum {
            None => false,
            Some(Value::Null) => true,
            Some(value) => match value.as_f64() {
                // `typeof value === "number" && Number.isFinite(value)`.
                Some(number) => number.is_finite() && number >= 0.0,
                None => false,
            },
        };
        check(
            cost_input.get("currency").and_then(Value::as_str) == Some("USD") && valid_max,
            "Cost requires USD and a nonnegative limit or null",
        )?;
        let mut output = Map::new();
        output.insert("currency".to_string(), Value::String("USD".to_string()));
        output.insert("max".to_string(), maximum.cloned().unwrap_or(Value::Null));
        output.insert(
            "description".to_string(),
            Value::String(optional(
                cost_input.get("description"),
                "cost description",
                2000,
            )?),
        );
        cost = Some(Value::Object(output));
    }
    // The JS object literal fixes this insertion order; `json!` would sort it.
    let mut result = Map::new();
    result.insert(
        "kind".to_string(),
        Value::String(kind.and_then(Value::as_str).expect("validated").to_string()),
    );
    result.insert("target".to_string(), target);
    result.insert("choices".to_string(), Value::Array(normalized_choices));
    result.insert("recommended_choice".to_string(), recommended);
    result.insert(
        "recommendation_reason".to_string(),
        Value::String(recommendation_reason),
    );
    result.insert(
        "diff".to_string(),
        Value::String(optional(
            input.and_then(|value| value.get("diff")),
            "diff",
            8000,
        )?),
    );
    result.insert(
        "impact".to_string(),
        Value::String(optional(
            input.and_then(|value| value.get("impact")),
            "impact",
            8000,
        )?),
    );
    result.insert(
        "conditions".to_string(),
        Value::String(optional(
            input.and_then(|value| value.get("conditions")),
            "conditions",
            8000,
        )?),
    );
    result.insert("cost".to_string(), cost.unwrap_or(Value::Null));
    result.insert(
        "expires_at".to_string(),
        timestamp(input.and_then(|value| value.get("expires_at")))?,
    );
    let consumer = input.and_then(|value| value.get("consumer_id"));
    if consumer.is_some() {
        result.insert(
            "consumer_id".to_string(),
            Value::String(identifier(consumer, "consumer_id")?),
        );
        let target = result["target"].clone();
        let has_run = target.get("run_id").is_some_and(|value| !value.is_null());
        let has_session = target
            .get("session_id")
            .is_some_and(|value| !value.is_null());
        check(
            has_run && has_session,
            "An answer consumer requires exact run/session IDs",
        )?;
    }
    if result["kind"] == json!("approval") {
        let target = &result["target"];
        let versioned = target.get("action_id").is_some_and(|v| !v.is_null())
            && target
                .get("revision")
                .and_then(Value::as_str)
                .is_some_and(|revision| !revision.is_empty());
        let non_empty = |key: &str| result[key].as_str().is_some_and(|value| !value.is_empty());
        check(
            versioned
                && non_empty("diff")
                && non_empty("impact")
                && non_empty("conditions")
                && !result["cost"].is_null(),
            "Approval requires a versioned action, diff, impact, conditions and explicit cost (null means unknown)",
        )?;
        check(
            result["choices"]
                .as_array()
                .is_some_and(|choices| choices.len() >= 2),
            "Approval requires at least two explicit choices",
        )?;
    }
    Ok(Value::Object(result))
}

/// `snapshot(input)`: the immutable part of a typed question.
fn snapshot(input: &Value) -> QuestionResult<Value> {
    let urgency = match input.get("urgency") {
        // `input.urgency || "normal"`: every falsy JavaScript value falls back.
        Some(Value::Null) | None => "normal".to_string(),
        Some(Value::Bool(false)) => "normal".to_string(),
        Some(Value::String(text)) if text.is_empty() => "normal".to_string(),
        Some(Value::Number(number)) if number.as_f64() == Some(0.0) => "normal".to_string(),
        Some(value) => match value.as_str() {
            Some(urgency) => urgency.to_string(),
            None => String::new(),
        },
    };
    check(
        ["normal", "high", "critical"].contains(&urgency.as_str()),
        "Invalid urgency",
    )?;
    let mut output = Map::new();
    output.insert(
        "question".to_string(),
        Value::String(text(input.get("question"), "question", 8000)?),
    );
    output.insert("urgency".to_string(), Value::String(urgency));
    output.insert(
        "default_action".to_string(),
        Value::String(optional(
            input.get("default_action"),
            "default_action",
            2000,
        )?),
    );
    output.insert(
        "decision".to_string(),
        normalize_decision(input.get("decision"))?,
    );
    Ok(Value::Object(output))
}

/// `current(state, id, expected)`: the card at `expected`, or the 409 message
/// the Japanese dashboard shows when the question moved on.
fn current(state: &Value, id: &str, expected: Option<&Value>) -> QuestionResult<Value> {
    let cards = state
        .get("question_contracts")
        .and_then(|extension| extension.get("cards"));
    let card = cards
        .and_then(Value::as_object)
        .and_then(|cards| cards.get(id))
        .cloned();
    check(card.is_some(), "Typed question not found")?;
    let card = card.expect("checked above");
    check_conflict(
        is_safe_integer(expected) && expected == card.get("revision"),
        "質問の版が変わりました。対象と条件を確認して再判断してください。",
    )?;
    Ok(card)
}

/// `changedFields(before, after)`: the Japanese labels of what a revision moved.
fn changed_fields(before: &Value, after: &Value) -> Vec<Value> {
    const LABELS: [(&str, &str); 14] = [
        ("question", "問い"),
        ("urgency", "緊急度"),
        ("default_action", "参考の行動"),
        ("kind", "質問の型"),
        ("target", "対象・版"),
        ("choices", "選択肢"),
        ("recommended_choice", "推奨"),
        ("recommendation_reason", "推奨理由"),
        ("diff", "差分"),
        ("impact", "影響"),
        ("conditions", "条件"),
        ("cost", "費用上限"),
        ("expires_at", "期限"),
        ("consumer_id", "回答consumer"),
    ];
    let mut fields = Vec::new();
    for (key, label) in LABELS {
        let previous = before.get(key).or_else(|| {
            before
                .get("decision")
                .and_then(|decision| decision.get(key))
        });
        let next = after
            .get(key)
            .or_else(|| after.get("decision").and_then(|decision| decision.get(key)));
        if differs(previous, next) {
            fields.push(Value::String(label.to_string()));
        }
    }
    fields
}

/// `contractStatus(card, now)`: the derived status the public view reports.
///
/// `now` arrives as the JS caller's millisecond clock value; a nullish or
/// unparseable `expires_at` never expires.
fn contract_status(card: &Value, now_millis: Option<i64>) -> String {
    let stored = card.get("status").and_then(Value::as_str).unwrap_or("");
    if stored == "cancelled" {
        return "cancelled".to_string();
    }
    let expires_at = card
        .get("snapshot")
        .and_then(|snapshot| snapshot.get("decision"))
        .and_then(|decision| decision.get("expires_at"));
    if let (Some(expires), Some(now)) = (expires_at.and_then(Value::as_str), now_millis) {
        if parse_iso_millis(expires).is_some_and(|millis| millis <= now) {
            return "expired".to_string();
        }
    }
    stored.to_string()
}

/// The `state.question_contracts` extension, when the state carries one.
fn extension(state: &Value) -> Option<&Value> {
    state
        .get("question_contracts")
        .filter(|extension| !extension.is_null())
}

/// `validateQuestionContracts(state)`.
fn validate_question_contracts(state: &Value) -> QuestionResult<()> {
    let Some(extension) = state.get("question_contracts") else {
        return Ok(());
    };
    keys(Some(extension), &["schema", "cards"])?;
    let cards = extension.get("cards");
    check(
        extension.get("schema") == Some(&json!(1)) && cards.is_some_and(own),
        "Unsupported question contract schema",
    )?;
    let cards = cards.expect("checked above");
    for (id, card) in cards.as_object().expect("own() proved an object") {
        identifier(Some(&Value::String(id.clone())), "question id")?;
        let history = card.get("history");
        let valid = own(card)
            && is_safe_integer(card.get("revision"))
            && card
                .get("revision")
                .and_then(Value::as_i64)
                .is_some_and(|revision| revision >= 1)
            && card
                .get("status")
                .and_then(Value::as_str)
                .is_some_and(|status| ["open", "answered", "cancelled"].contains(&status))
            && history.is_some_and(Value::is_array)
            && history.and_then(Value::as_array).is_some_and(|history| {
                history.len() as i64
                    == card.get("revision").and_then(Value::as_i64).unwrap_or(0) - 1
            })
            && history
                .and_then(Value::as_array)
                .is_some_and(|history| history.len() <= 1000);
        check(valid, "Invalid question contract history")?;
        let history = history
            .and_then(Value::as_array)
            .expect("checked above")
            .clone();
        let mut records = history.clone();
        records.push(card.clone());
        for (index, record) in records.iter().enumerate() {
            let superseded = index < history.len();
            let mut allowed = vec![
                "revision",
                "fingerprint",
                "snapshot",
                "status",
                "created_at",
                "updated_at",
                "answer",
                "cancel_reason",
            ];
            if superseded {
                allowed.extend(["invalidated_at", "invalidation_reason"]);
            } else {
                allowed.push("history");
            }
            keys(Some(record), &allowed)?;
            let stored_snapshot = record.get("snapshot");
            keys(
                stored_snapshot,
                &["question", "urgency", "default_action", "decision"],
            )?;
            let snapshot_value = stored_snapshot.expect("checked above");
            let normalized_snapshot = snapshot(snapshot_value)?;
            check(
                record.get("revision") == Some(&json!(index + 1))
                    && record
                        .get("fingerprint")
                        .and_then(Value::as_str)
                        .is_some_and(|fingerprint| fingerprint == digest(&normalized_snapshot))
                    && parseable(record.get("created_at"))
                    && parseable(record.get("updated_at")),
                "Question contract snapshot is corrupt",
            )?;
            let answer = record.get("answer");
            let valid_answer = match answer {
                Some(Value::Null) => true,
                Some(answer) => {
                    let choice_id_valid = answer.get("choice_id").is_some_and(|choice_id| {
                        choice_id.is_null()
                            || snapshot_value
                                .get("decision")
                                .and_then(|decision| decision.get("choices"))
                                .and_then(Value::as_array)
                                .is_some_and(|choices| {
                                    choices
                                        .iter()
                                        .any(|choice| choice.get("id") == Some(choice_id))
                                })
                    });
                    own(answer)
                        && answer.get("text").is_some_and(Value::is_string)
                        && answer.get("contract_fingerprint") == record.get("fingerprint")
                        && parseable(answer.get("answered_at"))
                        && choice_id_valid
                }
                None => false,
            };
            check(valid_answer, "Invalid question contract answer")?;
            if let Some(answer) = answer.filter(|answer| !answer.is_null()) {
                keys(
                    Some(answer),
                    &["text", "choice_id", "answered_at", "contract_fingerprint"],
                )?;
            }
            if superseded {
                check(
                    record.get("status").and_then(Value::as_str) == Some("superseded")
                        && parseable(record.get("invalidated_at"))
                        && record.get("invalidation_reason").and_then(Value::as_str)
                            == Some("question_contract_changed"),
                    "Invalid superseded question",
                )?;
            }
        }
        let question = state
            .get("questions")
            .and_then(Value::as_array)
            .and_then(|questions| {
                questions
                    .iter()
                    .find(|question| question.get("id").and_then(Value::as_str) == Some(id))
            });
        let snapshot = card.get("snapshot").expect("checked above");
        let answer_text = card
            .get("answer")
            .and_then(|answer| answer.get("text"))
            .cloned()
            .unwrap_or(Value::Null);
        let status = card.get("status").and_then(Value::as_str).unwrap_or("");
        let has_answer = card.get("answer").is_some_and(|answer| !answer.is_null());
        check(
            question.is_some_and(|question| {
                question.get("question") == snapshot.get("question")
                    && question.get("urgency") == snapshot.get("urgency")
                    && question.get("default_action") == snapshot.get("default_action")
                    && question.get("answer").cloned().unwrap_or(Value::Null) == answer_text
                    && (status != "answered" || has_answer)
                    && (status != "open" || !has_answer)
                    && (status != "cancelled"
                        || card.get("cancel_reason").is_some_and(Value::is_string))
            }),
            "Question and contract snapshot disagree",
        )?;
    }
    Ok(())
}

/// `publicQuestionContracts(state)`: the card projection the dashboard shows.
fn public_question_contracts(state: &Value, now_millis: Option<i64>) -> Value {
    let Some(extension) = extension(state) else {
        // `state.question_contracts === undefined` leaves the projection alone.
        return Value::Null;
    };
    let mut cards = Map::new();
    if let Some(stored) = extension.get("cards").and_then(Value::as_object) {
        for (id, card) in stored {
            let mut output = card.as_object().cloned().unwrap_or_default();
            output.insert(
                "status".to_string(),
                Value::String(contract_status(card, now_millis)),
            );
            let history = card
                .get("history")
                .and_then(Value::as_array)
                .filter(|history| !history.is_empty());
            output.insert(
                "changed_fields".to_string(),
                match history.and_then(|history| history.last()) {
                    Some(previous) => Value::Array(changed_fields(
                        previous.get("snapshot").unwrap_or(&Value::Null),
                        card.get("snapshot").unwrap_or(&Value::Null),
                    )),
                    None => Value::Array(Vec::new()),
                },
            );
            output.insert("execution_authorized".to_string(), Value::Bool(false));
            cards.insert(id.clone(), Value::Object(output));
        }
    }
    let mut output = Map::new();
    output.insert("schema".to_string(), json!(1));
    output.insert("cards".to_string(), Value::Object(cards));
    Value::Object(output)
}

/// `feedbackValidity(state, message)`: the message with its contract verdict.
///
/// A message without a `contract_fingerprint` is returned untouched, which is
/// how legacy feedback keeps its exact stored bytes.
fn feedback_validity(state: &Value, message: &Value, now_millis: Option<i64>) -> Value {
    let Some(fingerprint) = message
        .get("contract_fingerprint")
        .filter(|value| !value.is_null())
        .and_then(Value::as_str)
    else {
        return message.clone();
    };
    let card = state
        .get("question_contracts")
        .and_then(|extension| extension.get("cards"))
        .and_then(|cards| cards.get(message.get("question_id").and_then(Value::as_str)?))
        .cloned();
    let matches = card.as_ref().is_some_and(|card| {
        card.get("revision").cloned().unwrap_or(Value::Null)
            == message
                .get("contract_revision")
                .cloned()
                .unwrap_or(Value::Null)
            && card.get("fingerprint").and_then(Value::as_str) == Some(fingerprint)
    });
    let valid = matches
        && card
            .as_ref()
            .is_some_and(|card| contract_status(card, now_millis) == "answered");
    let reason = if valid {
        Value::Null
    } else if matches {
        Value::String(
            card.as_ref()
                .map(|card| contract_status(card, now_millis))
                .unwrap_or_default(),
        )
    } else {
        Value::String("question_contract_changed".to_string())
    };
    let mut output = message.as_object().cloned().unwrap_or_default();
    output.insert(
        "contract_validity".to_string(),
        Value::String(if valid { "current" } else { "invalidated" }.to_string()),
    );
    output.insert("invalidation_reason".to_string(), reason);
    output.insert("execution_authorized".to_string(), Value::Bool(false));
    Value::Object(output)
}

/// `changeQuestionContract(state, input)`: create, revise or cancel one card.
///
/// Returns `undefined` in JS, which the JSON output carries as `null`.
fn change_question_contract(state: &mut Value, input: &Value, now: &str) -> QuestionResult<Value> {
    let action = match input.get("action") {
        Some(Value::Null) | None => "create".to_string(),
        Some(value) => match value.as_str() {
            Some(action) => action.to_string(),
            // `input.action ?? "create"` keeps any other value; the guard below
            // rejects it with the same message.
            None => String::new(),
        },
    };
    keys(
        Some(input),
        &[
            "id",
            "question",
            "urgency",
            "default_action",
            "decision",
            "action",
            "expected_revision",
            "cancel_reason",
        ],
    )?;
    check(
        ["create", "revise", "cancel"].contains(&action.as_str()),
        "Invalid question action",
    )?;
    let id = identifier(input.get("id"), "question id")?;
    // The caller supplies the validated instant, as the JS store does.
    let now = now.to_string();
    if action == "cancel" {
        check(
            !["question", "urgency", "default_action", "decision"]
                .iter()
                .any(|key| input.get(*key).is_some()),
            "Cancellation cannot replace question contents",
        )?;
        let mut card = current(state, &id, input.get("expected_revision"))?;
        let reason = text(input.get("cancel_reason"), "cancel reason", 2000)?;
        if card.get("status").and_then(Value::as_str) != Some("cancelled") {
            let object = card.as_object_mut().expect("current() returns a card");
            object.insert("status".to_string(), json!("cancelled"));
            object.insert("cancel_reason".to_string(), json!(reason));
            object.insert("updated_at".to_string(), json!(now));
        } else {
            check_conflict(
                card.get("cancel_reason").and_then(Value::as_str) == Some(reason.as_str()),
                "Question already cancelled for another reason",
            )?;
        }
        write_card(state, &id, card)?;
        return Ok(Value::Null);
    }
    check(
        input.get("cancel_reason").is_none(),
        "cancel_reason requires cancellation",
    )?;
    let value = snapshot(input)?;
    // `previous` reads the card before `revise` replaces it.
    let previous = state
        .get("question_contracts")
        .and_then(|extension| extension.get("cards"))
        .and_then(|cards| cards.get(&id))
        .is_some();
    let mut history: Vec<Value> = Vec::new();
    let mut revision = 1i64;
    let mut created_at = now.clone();
    if action == "revise" {
        let card = current(state, &id, input.get("expected_revision"))?;
        check(
            digest(&value)
                != card
                    .get("fingerprint")
                    .and_then(Value::as_str)
                    .unwrap_or(""),
            "Question contract is unchanged",
        )?;
        let existing = card
            .get("history")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        check(
            existing.len() < 1000,
            "Question revision history limit reached; create a new question id",
        )?;
        history = existing;
        // `const { history: oldHistory, ...old } = card` keeps the remaining
        // keys in their stored order, then the three mutations append.
        let mut superseded = card.clone();
        let object = superseded
            .as_object_mut()
            .expect("current() returns a card");
        object.remove("history");
        object.insert("status".to_string(), json!("superseded"));
        object.insert("invalidated_at".to_string(), json!(now));
        object.insert(
            "invalidation_reason".to_string(),
            json!("question_contract_changed"),
        );
        history.push(superseded);
        revision = card.get("revision").and_then(Value::as_i64).unwrap_or(0) + 1;
        created_at = card
            .get("created_at")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
    } else {
        check(
            input.get("expected_revision").is_none(),
            "Creating a question cannot specify an existing revision",
        )?;
        let listed = state
            .get("questions")
            .and_then(Value::as_array)
            .is_some_and(|questions| {
                questions
                    .iter()
                    .any(|question| question.get("id").and_then(Value::as_str) == Some(id.as_str()))
            });
        check(
            !previous && !listed,
            "Question id already exists; use revise for a typed question",
        )?;
    }
    let mut card = Map::new();
    card.insert("revision".to_string(), json!(revision));
    card.insert("fingerprint".to_string(), json!(digest(&value)));
    card.insert("snapshot".to_string(), value.clone());
    card.insert("status".to_string(), json!("open"));
    card.insert("created_at".to_string(), json!(created_at));
    card.insert("updated_at".to_string(), json!(now));
    card.insert("answer".to_string(), Value::Null);
    card.insert("cancel_reason".to_string(), Value::Null);
    card.insert("history".to_string(), Value::Array(history));
    let stored = Value::Object(card);
    write_card(state, &id, stored.clone())?;
    set_question_record(state, &id, &stored, input)?;
    Ok(Value::Null)
}

/// `state.question_contracts ||= { schema: 1, cards: {} }` then `cards[id] = card`.
fn write_card(state: &mut Value, id: &str, card: Value) -> QuestionResult<()> {
    if state.get("question_contracts").is_none_or(Value::is_null) {
        let mut extension = Map::new();
        extension.insert("schema".to_string(), json!(1));
        extension.insert("cards".to_string(), Value::Object(Map::new()));
        state["question_contracts"] = Value::Object(extension);
    }
    let cards = state["question_contracts"]["cards"]
        .as_object_mut()
        .expect("the extension above always carries a cards object");
    cards.insert(id.to_string(), card);
    Ok(())
}

/// The `state.questions` record the snapshot mirrors.
///
/// JS mutates the existing record's index in place, so the array order is
/// preserved and only the mirrored fields move.
fn set_question_record(
    state: &mut Value,
    id: &str,
    card: &Value,
    input: &Value,
) -> QuestionResult<()> {
    let snapshot = card.get("snapshot").cloned().unwrap_or(Value::Null);
    let index = state
        .get("questions")
        .and_then(Value::as_array)
        .and_then(|questions| {
            questions
                .iter()
                .position(|question| question.get("id").and_then(Value::as_str) == Some(id))
        });
    let mut record = Map::new();
    record.insert("id".to_string(), json!(id));
    record.insert(
        "question".to_string(),
        snapshot.get("question").cloned().unwrap_or(Value::Null),
    );
    record.insert(
        "urgency".to_string(),
        snapshot.get("urgency").cloned().unwrap_or(Value::Null),
    );
    record.insert(
        "default_action".to_string(),
        snapshot
            .get("default_action")
            .cloned()
            .unwrap_or(Value::Null),
    );
    record.insert(
        "created_at".to_string(),
        card.get("created_at").cloned().unwrap_or(Value::Null),
    );
    record.insert("answer".to_string(), Value::Null);
    // A cancel keeps the mirrored answer the revision carried; create and
    // revise both start from `answer: null` because the snapshot changed.
    if input.get("action").and_then(Value::as_str) == Some("cancel") {
        if let Some(existing) = index
            .and_then(|index| state.get("questions").and_then(|q| q.get(index)))
            .and_then(|question| question.get("answer"))
            .cloned()
        {
            record.insert("answer".to_string(), existing);
        }
    }
    let record = Value::Object(record);
    if let Some(index) = index {
        state["questions"][index] = record;
    } else {
        if state.get("questions").is_none_or(Value::is_null) {
            state["questions"] = Value::Array(Vec::new());
        }
        state["questions"]
            .as_array_mut()
            .expect("the array above always exists")
            .push(record);
    }
    Ok(())
}

/// `answerQuestionContract(state, question, input)`.
///
/// Returns the answer record, or `null` for a legacy consultation that has no
/// typed card yet.
fn answer_question_contract(
    state: &mut Value,
    question: &Value,
    input: &Value,
    now_millis: Option<i64>,
) -> QuestionResult<Value> {
    keys(
        Some(input),
        &[
            "id",
            "answer",
            "expected_revision",
            "contract_fingerprint",
            "choice_id",
        ],
    )?;
    let id = question
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    // `state.question_contracts?.cards[question.id]` uses a plain index read,
    // so a prototype name resolves to a function on the JS side and is truthy;
    // an own-property read is the correct behaviour for a JSON state document.
    let card = state
        .get("question_contracts")
        .and_then(|extension| extension.get("cards"))
        .and_then(|cards| cards.get(&id))
        .cloned();
    let Some(_card) = card else {
        check(
            !["contract_fingerprint", "choice_id", "expected_revision"]
                .iter()
                .any(|key| input.get(*key).is_some()),
            "Legacy consultation cannot accept a typed decision answer",
        )?;
        return Ok(Value::Null);
    };
    let mut card = current(state, &id, input.get("expected_revision"))?;
    check_conflict(
        input.get("contract_fingerprint").and_then(Value::as_str)
            == card.get("fingerprint").and_then(Value::as_str),
        "質問の対象・条件が変わりました。更新内容を確認して再回答してください。",
    )?;
    check_conflict(
        contract_status(&card, now_millis) == "open",
        "期限切れ・取消し・回答済みの質問には回答できません。",
    )?;
    let choice_id = match input.get("choice_id") {
        Some(Value::Null) | None => Value::Null,
        Some(value) => value.clone(),
    };
    let choices_exist = card
        .get("snapshot")
        .and_then(|snapshot| snapshot.get("decision"))
        .and_then(|decision| decision.get("choices"))
        .and_then(Value::as_array)
        .is_some_and(|choices| {
            choices
                .iter()
                .any(|choice| Some(&choice["id"]) == Some(&choice_id))
        });
    check(
        choice_id.is_null() || choices_exist,
        "Choice does not exist in this question revision",
    )?;
    let answered_at = question.get("answered_at").cloned().unwrap_or(Value::Null);
    let fingerprint = card.get("fingerprint").cloned().unwrap_or(Value::Null);
    {
        let object = card.as_object_mut().expect("current() returns a card");
        object.insert("status".to_string(), json!("answered"));
        object.insert("updated_at".to_string(), answered_at.clone());
        let mut answer = Map::new();
        answer.insert(
            "text".to_string(),
            question.get("answer").cloned().unwrap_or(Value::Null),
        );
        answer.insert("choice_id".to_string(), choice_id.clone());
        answer.insert("answered_at".to_string(), answered_at);
        answer.insert("contract_fingerprint".to_string(), fingerprint.clone());
        object.insert("answer".to_string(), Value::Object(answer));
    }
    write_card(state, &id, card.clone())?;
    if let Some(index) = state
        .get("questions")
        .and_then(Value::as_array)
        .and_then(|questions| {
            questions
                .iter()
                .position(|entry| entry.get("id").and_then(Value::as_str) == Some(&id))
        })
    {
        state["questions"][index]["answer"] =
            question.get("answer").cloned().unwrap_or(Value::Null);
        state["questions"][index]["answered_at"] =
            question.get("answered_at").cloned().unwrap_or(Value::Null);
    }
    let kind = card
        .get("snapshot")
        .and_then(|snapshot| snapshot.get("decision"))
        .and_then(|decision| decision.get("kind"))
        .cloned()
        .unwrap_or(Value::Null);
    let target = card
        .get("snapshot")
        .and_then(|snapshot| snapshot.get("decision"))
        .and_then(|decision| decision.get("target"))
        .cloned()
        .unwrap_or(Value::Null);
    let mut output = Map::new();
    output.insert("contract_fingerprint".to_string(), fingerprint);
    output.insert(
        "contract_revision".to_string(),
        card.get("revision").cloned().unwrap_or(Value::Null),
    );
    output.insert("question_kind".to_string(), kind);
    output.insert("target".to_string(), target);
    output.insert("choice_id".to_string(), choice_id);
    output.insert("execution_authorized".to_string(), Value::Bool(false));
    Ok(Value::Object(output))
}

/// Read one JSON request document, refusing anything over 256 KiB.
fn read_json(input_file: &str, locale: crate::locale::Locale) -> Result<Value> {
    let file = open_json_input(input_file).with_context(|| {
        localized_format!(
            locale,
            "cannot read JSON {}",
            "无法读取 JSON {}",
            "JSONを読み取れません {}",
            input_file
        )
    })?;
    read_json_file(file, input_file, locale)
}

fn read_json_file(
    file: std::fs::File,
    input_file: &str,
    locale: crate::locale::Locale,
) -> Result<Value> {
    use std::io::Read;

    const MAX_INPUT_BYTES: usize = 256 * 1024;
    let metadata = file.metadata().with_context(|| {
        localized_format!(
            locale,
            "cannot read JSON {}",
            "无法读取 JSON {}",
            "JSONを読み取れません {}",
            input_file
        )
    })?;
    if !metadata.is_file() || metadata.len() > MAX_INPUT_BYTES as u64 {
        bail!(crate::locale::diagnostic(
            locale,
            "Input JSON must be a regular file of at most 256 KiB"
        )
        .to_string());
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take((MAX_INPUT_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .with_context(|| {
            localized_format!(
                locale,
                "cannot read JSON {}",
                "无法读取 JSON {}",
                "JSONを読み取れません {}",
                input_file
            )
        })?;
    if bytes.len() > MAX_INPUT_BYTES {
        bail!(crate::locale::diagnostic(locale, "Input JSON exceeds 256 KiB").to_string());
    }
    let Ok(text) = std::str::from_utf8(&bytes) else {
        bail!(crate::locale::diagnostic(locale, "Input JSON is invalid").to_string());
    };
    // TextDecoder("utf-8") in the dashboard CLI removed a leading BOM.
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    serde_json::from_str(text).map_err(|_| {
        anyhow!(crate::locale::diagnostic(locale, "Input JSON is invalid").to_string())
    })
}

#[cfg(unix)]
fn open_json_input(input_file: &str) -> std::io::Result<std::fs::File> {
    use std::os::unix::fs::OpenOptionsExt;

    std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_CLOEXEC | libc::O_NONBLOCK)
        .open(input_file)
}

#[cfg(not(unix))]
fn open_json_input(input_file: &str) -> std::io::Result<std::fs::File> {
    std::fs::File::open(input_file)
}

/// The document shape every action accepts: `{ operation, state, input, now }`.
/// Only `operation` and `state` are always required.
fn read_request(
    document: &Value,
    locale: crate::locale::Locale,
) -> Result<(String, Value, Value, String)> {
    let object = document.as_object().ok_or_else(|| {
        anyhow!(crate::locale::diagnostic(locale, "Input JSON is invalid").to_string())
    })?;
    const CLI_KEYS: [&str; 5] = ["operation", "state", "input", "now", "live_jobs"];
    if object.keys().any(|key| !CLI_KEYS.contains(&key.as_str())) {
        bail!(crate::locale::diagnostic(locale, "Input JSON is invalid").to_string());
    }
    let operation = object
        .get("operation")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    if operation.is_empty() {
        bail!(crate::locale::diagnostic(locale, "Input JSON is invalid").to_string());
    }
    let state = object
        .get("state")
        .filter(|value| value.is_object())
        .cloned()
        .ok_or_else(|| {
            anyhow!(crate::locale::diagnostic(locale, "Input JSON is invalid").to_string())
        })?;
    let input = object.get("input").cloned().unwrap_or(Value::Null);
    let now = object
        .get("now")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    Ok((operation, state, input, now))
}

/// The `apply` operations, in the order the JS module declares them.
const APPLY_OPERATIONS: [&str; 2] = ["question", "answer"];

/// `rdsh question-contracts <apply|validate|public> --input-file`.
///
/// The file holds `{ operation, state, input, now }`. `state` is the project
/// state document; `input` is the payload the operation merges
/// (`operation: "question"` drives `changeQuestionContract`, `"answer"` drives
/// `answerQuestionContract` from `state.questions`); `now` is the instant the
/// JS caller would have read from the clock. `validate` and `public` read
/// `state` alone and accept a missing `input`.
pub fn cmd_question_contracts(
    action: &str,
    input_file: &str,
    locale: crate::locale::Locale,
) -> Result<()> {
    cmd_question_contracts_inner(action, input_file, locale).map_err(|error| {
        if let Some(reason) = error.downcast_ref::<QuestionError>() {
            anyhow!(
                "{}: {}",
                crate::locale::diagnostic(locale, "Question contracts"),
                reason.message
            )
        } else {
            error
        }
    })
}

fn cmd_question_contracts_inner(
    action: &str,
    input_file: &str,
    locale: crate::locale::Locale,
) -> Result<()> {
    let document = read_json(input_file, locale)?;
    let (operation, mut state, input, now) = read_request(&document, locale)?;
    if now.is_empty() {
        return Err(QuestionError::new("Invalid expires_at").into());
    }
    let canonical_now =
        parse_js_date(&now).ok_or_else(|| QuestionError::new("Invalid expires_at"))?;
    let now_instant =
        parse_iso_millis(&canonical_now).ok_or_else(|| QuestionError::new("Invalid expires_at"))?;
    let mut output = Map::new();
    match action {
        "apply" => {
            // The document's operation selects the JS entry point, so the
            // action name is not repeated in it.
            if !APPLY_OPERATIONS.contains(&operation.as_str()) {
                bail!(crate::locale::diagnostic(
                    locale,
                    "Input JSON operation does not match the requested action"
                )
                .to_string());
            }
            if !input.is_object() {
                bail!(crate::locale::diagnostic(locale, "Input JSON is invalid").to_string());
            }
            output.insert("operation".into(), json!(operation));
            let result = if operation == "question" {
                change_question_contract(&mut state, &input, &canonical_now)?
            } else {
                let mut question = state
                    .get("questions")
                    .and_then(Value::as_array)
                    .and_then(|questions| {
                        input
                            .get("id")
                            .and_then(Value::as_str)
                            .and_then(|id| {
                                questions.iter().find(|question| {
                                    question.get("id").and_then(Value::as_str) == Some(id)
                                })
                            })
                            .cloned()
                    })
                    .ok_or_else(|| QuestionError::new("Typed question not found"))?;
                question["answer"] = Value::String(text(input.get("answer"), "answer", 2000)?);
                question["answered_at"] = Value::String(canonical_now.clone());
                let result =
                    answer_question_contract(&mut state, &question, &input, Some(now_instant))?;
                if result.is_null() {
                    let question_id = question.get("id").and_then(Value::as_str);
                    if let Some(record) = state
                        .get_mut("questions")
                        .and_then(Value::as_array_mut)
                        .and_then(|questions| {
                            questions.iter_mut().find(|record| {
                                record.get("id").and_then(Value::as_str) == question_id
                            })
                        })
                    {
                        record["answer"] = question["answer"].clone();
                        record["answered_at"] = question["answered_at"].clone();
                    }
                }
                result
            };
            output.insert("result".into(), result);
            output.insert(
                "question_contracts".into(),
                state
                    .get("question_contracts")
                    .cloned()
                    .unwrap_or(Value::Null),
            );
            output.insert(
                "questions".into(),
                state.get("questions").cloned().unwrap_or(Value::Null),
            );
        }
        "validate" | "public" => {
            // These read the state alone; the operation field is advisory and
            // must not name a write the action does not perform.
            if operation != action {
                bail!(crate::locale::diagnostic(
                    locale,
                    "Input JSON operation does not match the requested action"
                )
                .to_string());
            }
            output.insert("operation".into(), json!(action));
            if action == "validate" {
                validate_question_contracts(&state)?;
                output.insert("valid".into(), json!(true));
            } else {
                output.insert(
                    "question_contracts".into(),
                    public_question_contracts(&state, Some(now_instant)),
                );
                output.insert(
                    "feedback".into(),
                    match input.get("message") {
                        Some(message) => feedback_validity(&state, message, Some(now_instant)),
                        None => Value::Null,
                    },
                );
            }
        }
        other => bail!(
            "{} {other}",
            crate::locale::diagnostic(locale, "unknown question-contracts action")
        ),
    }
    let text = crate::js_json::stringify(&Value::Object(output));
    let stdout = std::io::stdout();
    let mut handle = stdout.lock();
    handle
        .write_all(text.as_bytes())
        .context(crate::locale::diagnostic(locale, "write question contracts").to_string())?;
    handle
        .write_all(b"\n")
        .context(crate::locale::diagnostic(locale, "write question contracts").to_string())?;
    handle
        .flush()
        .context(crate::locale::diagnostic(locale, "flush question contracts").to_string())?;
    Ok(())
}

#[cfg(test)]
mod input_tests {
    use super::*;

    #[test]
    fn input_json_uses_the_open_file_if_its_path_is_replaced() {
        let root = std::env::temp_dir().join(format!(
            "rdsh-question-contracts-read-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
        ));
        std::fs::create_dir(&root).unwrap();
        let path = root.join("input.json");
        std::fs::write(
            &path,
            r#"{"operation":"validate","state":{},"now":"2026-10-15T00:00:00.000Z"}"#,
        )
        .unwrap();

        let file = open_json_input(path.to_str().unwrap()).unwrap();
        std::fs::rename(&path, root.join("opened.json")).unwrap();
        std::fs::write(&path, "not the validated input").unwrap();

        let parsed =
            read_json_file(file, path.to_str().unwrap(), crate::locale::Locale::English).unwrap();
        assert_eq!(parsed["operation"], "validate");
        assert_eq!(parsed["state"], json!({}));
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[cfg(test)]
mod date_tests {
    use super::parse_js_date;

    #[test]
    fn date_parser_accepts_standard_date_and_timezone_spellings() {
        assert_eq!(
            parse_js_date("2026-06-01"),
            Some("2026-06-01T00:00:00.000Z".to_string())
        );
        assert_eq!(
            parse_js_date("2026-06-01 09:30:00+0930"),
            Some("2026-06-01T00:00:00.000Z".to_string())
        );
        assert!(parse_js_date("2026-06-01T09:30:00").is_some());
        assert_eq!(
            parse_js_date("2026-06-01T24:00:00Z"),
            Some("2026-06-02T00:00:00.000Z".to_string())
        );
        assert_eq!(parse_js_date("2026-06-01T24:01:00Z"), None);
        assert_eq!(parse_js_date("2026-06-01T09:30+09"), None);
        assert_eq!(
            parse_js_date("2026-06-01T09:30+0900"),
            Some("2026-06-01T00:30:00.000Z".to_string())
        );
    }

    #[test]
    fn expanded_years_roundtrip_and_obey_time_clip() {
        for (input, expected) in [
            (
                "9999-12-31T23:59:59.000-01:00",
                "+010000-01-01T00:59:59.000Z",
            ),
            ("+010000-01-01T00:59:59.000Z", "+010000-01-01T00:59:59.000Z"),
            ("-000001-01-01T00:00:00.000Z", "-000001-01-01T00:00:00.000Z"),
            ("+000099-01-01T00:00:00.000Z", "0099-01-01T00:00:00.000Z"),
            ("+000000-01-01T00:00:00.000Z", "0000-01-01T00:00:00.000Z"),
            ("+275760-09-13T00:00:00.000Z", "+275760-09-13T00:00:00.000Z"),
            ("-271821-04-20T00:00:00.000Z", "-271821-04-20T00:00:00.000Z"),
        ] {
            assert_eq!(parse_js_date(input).as_deref(), Some(expected), "{input}");
        }
        assert_eq!(parse_js_date("-000000-01-01T00:00:00.000Z"), None);
        assert_eq!(parse_js_date("+275760-09-13T00:00:00.001Z"), None);
        assert_eq!(parse_js_date("-271821-04-19T23:59:59.999Z"), None);
    }
}
