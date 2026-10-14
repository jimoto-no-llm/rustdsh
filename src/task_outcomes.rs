//! Optional task outcome reports and fixed milestone contracts.
//!
//! Rust port of `dashboard/task-outcomes.mjs`. It validates the optional
//! `outcome` report and the fixed `milestone_contract` of one task mutation
//! request against a project state document, and prints the resulting
//! `task_outcomes` metadata plus the two JSON schemas the dashboard MCP tool
//! advertises.
//!
//! This is pure logic: no execution, no check results, no filesystem writes.
//! `done` stays a report and never becomes proof of verification. A milestone
//! ID freezes its criteria; changing them requires a new ID.
//!
//! The exported actions mirror the JS module one for one:
//!
//! * `apply`  — `applyTaskOutcomes(state, input)`
//! * `validate` — `validateTaskOutcomes(state)`
//! * `schema` — `outcomeSchema` and `milestoneSchema`
//!
//! Unlike `subagent-plan.mjs`, `dashboard/task-outcomes.mjs` is still imported
//! in-process by `dashboard/state.mjs` (on every open and every `mutate`) and
//! by `dashboard/mcp.mjs` (for the schemas the MCP tool advertises), so the JS
//! module cannot be deleted without either putting a synchronous Rust call on
//! the store's hot path or changing the schema the MCP client receives. This
//! module therefore lands alongside it; the outputs are byte-identical, and
//! `tests/task_outcomes_cli.rs` pins the same JSON the JS module produced.

use std::collections::HashSet;
use std::io::Write;

use anyhow::{anyhow, bail, Context, Result};
use serde_json::{json, Map, Value};

/// The five optional report fields, in JS declaration order.
const REPORT_FIELDS: [&str; 5] = [
    "purpose",
    "owner",
    "latest_outcome",
    "next_step",
    "acceptance_task_id",
];

/// Per-field length limits (`limits` from the JS module).
fn field_limit(key: &str) -> Option<usize> {
    match key {
        "purpose" => Some(4000),
        "owner" => Some(1000),
        "latest_outcome" => Some(4000),
        "next_step" => Some(2000),
        "acceptance_task_id" => Some(160),
        _ => None,
    }
}

/// One milestone may fix at most this many criteria.
const MAX_CRITERIA: usize = 50;
/// Tasks and milestones each cap at this many entries.
const MAX_ENTRIES: usize = 200;

/// The error message the JS module throws. The dashboard carries the whole
/// message instead of a short code, so the port keeps the exact spelling.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutcomeError {
    pub message: String,
}

impl OutcomeError {
    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

impl std::fmt::Display for OutcomeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Task outcomes: {}", self.message)
    }
}

impl std::error::Error for OutcomeError {}

type OutcomeResult<T> = std::result::Result<T, OutcomeError>;

/// `object(value)`: a JSON object, never an array or null.
fn as_object(value: &Value) -> Option<&Map<String, Value>> {
    value.as_object()
}

/// `fields(value, keys)`: an object whose every key is in `keys`.
fn fields(value: &Value, keys: &[&str]) -> bool {
    match as_object(value) {
        Some(object) => object.keys().all(|key| keys.contains(&key.as_str())),
        None => false,
    }
}

/// `String.prototype.trim()`: ECMAScript white space plus the line
/// terminators. Rust's `char::is_whitespace` already covers U+FEFF, the one
/// code point where a naive `trim()` would disagree.
fn is_js_space(ch: char) -> bool {
    ch.is_whitespace() || matches!(ch, '\u{2028}' | '\u{2029}')
}

/// `text(value, maximum)`: a string whose trimmed length is non-empty and
/// whose raw length is at most `maximum`.
fn text(value: &Value, maximum: usize) -> bool {
    match value.as_str() {
        Some(text) => {
            text.trim_matches(is_js_space).chars().count() > 0 && text.chars().count() <= maximum
        }
        None => false,
    }
}

/// `/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/` (the criterion ID pattern),
/// hand-rolled so the port needs no regex engine.
fn criterion_id_ok(value: &str) -> bool {
    let mut chars = value.chars();
    match chars.next() {
        Some(first) if first.is_ascii_alphanumeric() => {}
        _ => return false,
    }
    let mut length = 1;
    for ch in chars {
        length += 1;
        if length > 128 || !(ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-')) {
            return false;
        }
    }
    true
}

/// `text(value)`: the default 160-character string check.
fn short_text(value: &Value) -> bool {
    text(value, 160)
}

/// The validated shape of one `milestone_contract` criterion. Fields are
/// stored in the JS declaration order the output uses.
#[derive(Debug, Clone, PartialEq)]
struct Criterion {
    task_id: Value,
    criterion_id: Value,
    description: Value,
}

impl Criterion {
    fn to_value(&self) -> Value {
        let mut object = Map::new();
        object.insert("task_id".into(), self.task_id.clone());
        object.insert("criterion_id".into(), self.criterion_id.clone());
        object.insert("description".into(), self.description.clone());
        Value::Object(object)
    }
}

/// One fixed milestone contract.
#[derive(Debug, Clone, PartialEq)]
struct Milestone {
    id: Value,
    title: Value,
    criteria: Vec<Criterion>,
}

impl Milestone {
    /// `{ id, title, criteria }` in that key order.
    fn to_value(&self) -> Value {
        let mut object = Map::new();
        object.insert("id".into(), self.id.clone());
        object.insert("title".into(), self.title.clone());
        object.insert(
            "criteria".into(),
            Value::Array(self.criteria.iter().map(Criterion::to_value).collect()),
        );
        Value::Object(object)
    }
}

/// `JSON.stringify([criterion.task_id, criterion.criterion_id])` — the
/// duplicate key of the JS `Set` over stringified pairs.
fn criterion_key(criterion: &Criterion) -> String {
    serde_json::to_string(&Value::Array(vec![
        criterion.task_id.clone(),
        criterion.criterion_id.clone(),
    ]))
    .expect("criterion IDs are JSON scalars")
}

fn require(condition: bool, message: &str) -> OutcomeResult<()> {
    if condition {
        Ok(())
    } else {
        Err(OutcomeError::new(message))
    }
}

/// `report(input)`: five allowed fields, each `null` or a limited string,
/// returned as a copy that keeps the caller's own key order.
fn report(input: &Value) -> OutcomeResult<Value> {
    if !fields(input, &REPORT_FIELDS) {
        return Err(OutcomeError::new("Invalid outcome report fields"));
    }
    let object = as_object(input).expect("fields() accepted an object");
    for (key, value) in object {
        let limit = field_limit(key).expect("fields() rejected unknown keys");
        if !(value.is_null() || text(value, limit)) {
            return Err(OutcomeError::new(format!("Invalid outcome {key}")));
        }
    }
    Ok(input.clone())
}

/// `milestone(input)`: validate one fixed contract and copy just its three
/// fields, so unknown keys never reach the stored metadata.
fn milestone(input: &Value) -> OutcomeResult<Milestone> {
    let object = as_object(input);
    require(
        fields(input, &["id", "title", "criteria"])
            && object.is_some_and(|object| {
                object.get("id").is_some_and(short_text)
                    && object.get("title").is_some_and(|t| text(t, 1000))
            }),
        "Invalid milestone contract",
    )?;
    let object = object.expect("fields() accepted an object");
    let criteria = object
        .get("criteria")
        .and_then(Value::as_array)
        .ok_or_else(|| OutcomeError::new("Invalid milestone criteria"))?;
    require(
        !criteria.is_empty() && criteria.len() <= MAX_CRITERIA,
        "Invalid milestone criteria",
    )?;
    let mut normalized = Vec::with_capacity(criteria.len());
    for criterion in criteria {
        let criterion_object = as_object(criterion);
        let valid = fields(criterion, &["task_id", "criterion_id", "description"])
            && criterion_object.is_some_and(|object| {
                object.get("task_id").is_some_and(short_text)
                    && object
                        .get("criterion_id")
                        .and_then(Value::as_str)
                        .is_some_and(criterion_id_ok)
                    && object.get("description").is_some_and(|d| text(d, 1000))
            });
        require(valid, "Invalid milestone criterion")?;
        let object = criterion_object.expect("fields() accepted an object");
        normalized.push(Criterion {
            task_id: object["task_id"].clone(),
            criterion_id: object["criterion_id"].clone(),
            description: object["description"].clone(),
        });
    }
    let mut seen = HashSet::new();
    for criterion in &normalized {
        let key = criterion_key(criterion);
        require(seen.insert(key), "Duplicate milestone criterion")?;
    }
    Ok(Milestone {
        id: object["id"].clone(),
        title: object["title"].clone(),
        criteria: normalized,
    })
}

/// The `{ schema, tasks, milestones }` document `applyTaskOutcomes` keeps.
fn empty_outcomes() -> Value {
    let mut object = Map::new();
    object.insert("schema".into(), json!(1));
    object.insert("tasks".into(), Value::Array(Vec::new()));
    object.insert("milestones".into(), Value::Array(Vec::new()));
    Value::Object(object)
}

/// `applyTaskOutcomes(state, input)`: merge the optional report and the fixed
/// milestone contract into a copy of `state.task_outcomes`. Returns `None`
/// when the request carries neither key, exactly like the JS early return.
pub fn apply_task_outcomes(state: &Value, input: &Value) -> OutcomeResult<Option<Value>> {
    let input_object = as_object(input).expect("the CLI checks the request object");
    if !input_object.contains_key("outcome") && !input_object.contains_key("milestone_contract") {
        return Ok(None);
    }
    let state_object = as_object(state).expect("the CLI checks the state object");
    let mut next = match state_object.get("task_outcomes") {
        Some(value) if !value.is_null() => value.clone(),
        _ => empty_outcomes(),
    };
    let next_object = next.as_object_mut().expect("task_outcomes is an object");
    if let Some(outcome) = input_object.get("outcome") {
        let update = report(outcome)?;
        let id = input_object.get("id").cloned().unwrap_or(Value::Null);
        let tasks = next_object
            .get_mut("tasks")
            .and_then(Value::as_array_mut)
            .expect("task_outcomes.tasks is an array");
        let index = tasks
            .iter()
            .position(|item| as_object(item).is_some_and(|item| item.get("task_id") == Some(&id)));
        // `{ ...current, ...update }`: the existing report keeps its key order,
        // new fields append in the order the request declared them.
        let value = match index {
            Some(index) => {
                let mut merged = as_object(&tasks[index])
                    .expect("stored tasks are objects")
                    .clone();
                let patch = as_object(&update).expect("report() returned an object");
                for (key, value) in patch {
                    merged.insert(key.clone(), value.clone());
                }
                Value::Object(merged)
            }
            None => {
                let mut merged = Map::new();
                merged.insert("task_id".into(), id);
                let patch = as_object(&update).expect("report() returned an object");
                for (key, value) in patch {
                    merged.insert(key.clone(), value.clone());
                }
                Value::Object(merged)
            }
        };
        match index {
            Some(index) => tasks[index] = value,
            None => {
                require(tasks.len() < MAX_ENTRIES, "Outcome task limit reached")?;
                tasks.push(value);
            }
        }
    }
    if let Some(contract) = input_object.get("milestone_contract") {
        let value = milestone(contract)?;
        require(
            input_object.get("milestone") == Some(&value.id),
            "Milestone contract must match the task milestone",
        )?;
        let milestones = next_object
            .get_mut("milestones")
            .and_then(Value::as_array_mut)
            .expect("task_outcomes.milestones is an array");
        let stored = value.to_value();
        let index = milestones
            .iter()
            .position(|item| as_object(item).is_some_and(|item| item.get("id") == Some(&value.id)));
        match index {
            Some(index) => {
                // Stored milestones keep the canonical key order, so comparing
                // the serialized text matches the JS stringify comparison.
                require(
                    milestones[index] == stored,
                    "Milestone criteria are fixed; declare changed criteria with a new milestone ID",
                )?;
            }
            None => {
                require(milestones.len() < MAX_ENTRIES, "Milestone limit reached")?;
                milestones.push(stored);
            }
        }
    }
    Ok(Some(next))
}

/// `validateTaskOutcomes(state)`: accept a missing document, reject a
/// malformed one. Tasks must name a declared task, every report field must
/// hold its limit, milestones must re-validate and stay unique.
pub fn validate_task_outcomes(state: &Value) -> OutcomeResult<()> {
    let state_object = as_object(state).expect("the CLI checks the state object");
    let Some(value) = state_object.get("task_outcomes") else {
        return Ok(());
    };
    let valid = fields(value, &["schema", "tasks", "milestones"])
        && as_object(value).is_some_and(|object| {
            object.get("schema") == Some(&json!(1))
                && object
                    .get("tasks")
                    .and_then(Value::as_array)
                    .is_some_and(|tasks| tasks.len() <= MAX_ENTRIES)
                && object
                    .get("milestones")
                    .and_then(Value::as_array)
                    .is_some_and(|milestones| milestones.len() <= MAX_ENTRIES)
        });
    require(valid, "Invalid task outcomes")?;
    let object = as_object(value).expect("fields() accepted an object");
    let tasks = object["tasks"]
        .as_array()
        .expect("the shape check accepted tasks");
    let declared = state_object
        .get("tasks")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    let mut keys = [
        "task_id",
        "purpose",
        "owner",
        "latest_outcome",
        "next_step",
        "acceptance_task_id",
    ]
    .to_vec();
    let mut ids: HashSet<String> = HashSet::new();
    for task in tasks {
        let task_object = as_object(task);
        let task_id = task_object.and_then(|object| object.get("task_id"));
        let declared_task = task_id.is_some_and(|id| {
            declared
                .iter()
                .any(|item| as_object(item).and_then(|item| item.get("id")) == Some(id))
        });
        let valid = fields(task, &keys)
            && task_id.is_some_and(short_text)
            && declared_task
            && task_id
                .and_then(|id| serde_json::to_string(id).ok())
                .is_some_and(|id| !ids.contains(&id));
        require(valid, "Invalid outcome task")?;
        let task_id = task_id.expect("the shape check accepted task_id");
        ids.insert(serde_json::to_string(task_id).expect("task_id is a JSON scalar"));
        // `const { task_id, ...details } = task` then `report(details)`.
        let mut details = Map::new();
        for (key, value) in task_object.expect("fields() accepted an object") {
            if key != "task_id" {
                details.insert(key.clone(), value.clone());
            }
        }
        report(&Value::Object(details))?;
    }
    keys.clear();
    let milestones = object["milestones"]
        .as_array()
        .expect("the shape check accepted milestones");
    let mut milestone_ids: HashSet<String> = HashSet::new();
    for item in milestones {
        let normalized = milestone(item)?;
        let id = serde_json::to_string(&normalized.id).expect("milestone id is a JSON scalar");
        require(milestone_ids.insert(id), "Duplicate milestone")?;
    }
    Ok(())
}

/// `outcomeSchema`: the JSON schema the MCP tool advertises for one report.
pub fn outcome_schema() -> Value {
    let mut properties = Map::new();
    for key in REPORT_FIELDS {
        let mut field = Map::new();
        field.insert("type".into(), json!(["string", "null"]));
        field.insert("minLength".into(), json!(1));
        field.insert(
            "maxLength".into(),
            json!(field_limit(key).expect("known report field")),
        );
        properties.insert(key.to_string(), Value::Object(field));
    }
    let mut schema = Map::new();
    schema.insert("type".into(), json!("object"));
    schema.insert("additionalProperties".into(), json!(false));
    schema.insert("properties".into(), Value::Object(properties));
    Value::Object(schema)
}

/// `milestoneSchema`: the JSON schema for one fixed milestone contract.
pub fn milestone_schema() -> Value {
    let mut task_id = Map::new();
    task_id.insert("type".into(), json!("string"));
    task_id.insert("minLength".into(), json!(1));
    task_id.insert("maxLength".into(), json!(160));
    let mut criterion_id = Map::new();
    criterion_id.insert("type".into(), json!("string"));
    criterion_id.insert(
        "pattern".into(),
        json!("^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$"),
    );
    let mut description = Map::new();
    description.insert("type".into(), json!("string"));
    description.insert("minLength".into(), json!(1));
    description.insert("maxLength".into(), json!(1000));
    let mut item_properties = Map::new();
    item_properties.insert("task_id".into(), Value::Object(task_id));
    item_properties.insert("criterion_id".into(), Value::Object(criterion_id));
    item_properties.insert("description".into(), Value::Object(description));
    let mut item = Map::new();
    item.insert("type".into(), json!("object"));
    item.insert("additionalProperties".into(), json!(false));
    item.insert(
        "required".into(),
        json!(["task_id", "criterion_id", "description"]),
    );
    item.insert("properties".into(), Value::Object(item_properties));
    let mut criteria = Map::new();
    criteria.insert("type".into(), json!("array"));
    criteria.insert("minItems".into(), json!(1));
    criteria.insert("maxItems".into(), json!(MAX_CRITERIA));
    criteria.insert("items".into(), Value::Object(item));
    let mut id = Map::new();
    id.insert("type".into(), json!("string"));
    id.insert("minLength".into(), json!(1));
    id.insert("maxLength".into(), json!(160));
    let mut title = Map::new();
    title.insert("type".into(), json!("string"));
    title.insert("minLength".into(), json!(1));
    title.insert("maxLength".into(), json!(1000));
    let mut properties = Map::new();
    properties.insert("id".into(), Value::Object(id));
    properties.insert("title".into(), Value::Object(title));
    properties.insert("criteria".into(), Value::Object(criteria));
    let mut schema = Map::new();
    schema.insert("type".into(), json!("object"));
    schema.insert("additionalProperties".into(), json!(false));
    schema.insert("required".into(), json!(["id", "title", "criteria"]));
    schema.insert("properties".into(), Value::Object(properties));
    Value::Object(schema)
}

/// Read one JSON file with the dashboard CLI's `localJson` rules: a regular
/// file of at most 256 KiB with strict UTF-8 and valid JSON.
fn read_json(input_file: &str) -> Result<Value> {
    let metadata =
        std::fs::metadata(input_file).with_context(|| format!("cannot read JSON {input_file}"))?;
    if !metadata.is_file() || metadata.len() > 256 * 1024 {
        bail!("Input JSON must be a regular file of at most 256 KiB");
    }
    let bytes =
        std::fs::read(input_file).with_context(|| format!("cannot read JSON {input_file}"))?;
    if bytes.len() > 256 * 1024 {
        bail!("Input JSON exceeds 256 KiB");
    }
    let Ok(text) = std::str::from_utf8(&bytes) else {
        bail!("Input JSON is invalid");
    };
    // TextDecoder("utf-8") in the dashboard CLI removed a leading BOM.
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    serde_json::from_str(text).map_err(|_| anyhow!("Input JSON is invalid"))
}

/// `rdsh task-outcomes <apply|validate|schema> --input-file <json>`.
///
/// The file holds `{ operation, state, input }`: `state` is the project state
/// document, `input` the task mutation request `apply` merges. `validate` and
/// `schema` read `state` alone and accept a missing `input`.
pub fn cmd_task_outcomes(action: &str, input_file: &str) -> Result<()> {
    let document = read_json(input_file)?;
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
        .unwrap_or("");
    if operation != action {
        bail!("Input JSON operation does not match the requested action");
    }
    let state = object
        .get("state")
        .filter(|value| value.is_object())
        .ok_or_else(|| anyhow!("Input JSON is invalid"))?;
    let input = object.get("input").cloned().unwrap_or(Value::Null);
    if action == "apply" && !input.is_object() {
        bail!("Input JSON is invalid");
    }
    let mut output = Map::new();
    output.insert("operation".into(), json!(action));
    match action {
        "apply" => {
            let next = apply_task_outcomes(state, &input)?;
            output.insert("applied".into(), json!(true));
            output.insert(
                "task_outcomes".into(),
                match next {
                    Some(value) => value,
                    // The JS early return leaves the state untouched.
                    None => state
                        .as_object()
                        .and_then(|state| state.get("task_outcomes"))
                        .cloned()
                        .unwrap_or(Value::Null),
                },
            );
        }
        "validate" => {
            validate_task_outcomes(state)?;
            output.insert("valid".into(), json!(true));
        }
        "schema" => {
            output.insert("outcome".into(), outcome_schema());
            output.insert("milestone_contract".into(), milestone_schema());
        }
        other => bail!("unknown task-outcomes action {other}"),
    }
    let text =
        serde_json::to_string(&Value::Object(output)).context("serialize task outcomes result")?;
    let stdout = std::io::stdout();
    let mut handle = stdout.lock();
    writeln!(handle, "{text}")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn state() -> Value {
        json!({
            "schema": 1,
            "tasks": [{ "id": "goal", "title": "Goal", "status": "done" }],
        })
    }

    fn contract() -> Value {
        json!({
            "id": "M1",
            "title": "Milestone",
            "criteria": [
                { "task_id": "goal", "criterion_id": "value", "description": "value is right" },
            ],
        })
    }

    /// A state document that already stores `task_outcomes`.
    fn state_with(task_outcomes: &Value) -> Value {
        let mut state = state();
        state["task_outcomes"] = task_outcomes.clone();
        state
    }

    fn failing<T>(prefix: &str, result: OutcomeResult<T>) {
        let error = result.err().expect("call should be refused");
        assert!(
            error.message.starts_with(prefix),
            "expected {prefix}, got {}",
            error.message
        );
    }

    #[test]
    fn apply_reports_nothing_without_outcome_or_contract() {
        let result = apply_task_outcomes(&state(), &json!({ "id": "goal" })).unwrap();
        assert!(result.is_none());
    }

    #[test]
    fn apply_creates_and_patches_reports_like_the_js_module() {
        let first = apply_task_outcomes(
            &state(),
            &json!({
                "id": "goal",
                "outcome": { "purpose": "ship", "owner": null },
            }),
        )
        .unwrap()
        .unwrap();
        assert_eq!(
            first,
            json!({
                "schema": 1,
                "tasks": [{ "task_id": "goal", "purpose": "ship", "owner": null }],
                "milestones": [],
            })
        );
        let patched = apply_task_outcomes(
            &state_with(&first),
            &json!({
                "id": "goal",
                "outcome": { "latest_outcome": "done", "owner": null },
            }),
        )
        .unwrap()
        .unwrap();
        assert_eq!(
            patched,
            json!({
                "schema": 1,
                "tasks": [{
                    "task_id": "goal",
                    "purpose": "ship",
                    "owner": null,
                    "latest_outcome": "done",
                }],
                "milestones": [],
            })
        );
    }

    #[test]
    fn apply_rejects_forged_and_malformed_reports() {
        failing(
            "Invalid outcome report fields",
            apply_task_outcomes(
                &state(),
                &json!({ "id": "goal", "outcome": { "verified": true } }),
            ),
        );
        failing(
            "Invalid outcome owner",
            apply_task_outcomes(
                &state(),
                &json!({ "id": "goal", "outcome": { "owner": "x".repeat(1001) } }),
            ),
        );
        failing(
            "Invalid outcome purpose",
            apply_task_outcomes(
                &state(),
                &json!({ "id": "goal", "outcome": { "purpose": "  " } }),
            ),
        );
    }

    #[test]
    fn apply_freezes_milestone_criteria_under_one_id() {
        let stored = apply_task_outcomes(
            &state(),
            &json!({ "id": "goal", "milestone": "M1", "milestone_contract": contract() }),
        )
        .unwrap()
        .unwrap();
        assert_eq!(stored["milestones"].as_array().unwrap().len(), 1);
        // The same contract is idempotent.
        let again = apply_task_outcomes(
            &state_with(&stored),
            &json!({ "id": "goal", "milestone": "M1", "milestone_contract": contract() }),
        )
        .unwrap()
        .unwrap();
        assert_eq!(again, stored);
        failing(
            "Milestone criteria are fixed",
            apply_task_outcomes(
                &state_with(&stored),
                &json!({
                    "id": "goal",
                    "milestone": "M1",
                    "milestone_contract": {
                        "id": "M1",
                        "title": "Milestone",
                        "criteria": [{
                            "task_id": "goal",
                            "criterion_id": "other",
                            "description": "different",
                        }],
                    },
                }),
            ),
        );
        failing(
            "Duplicate milestone criterion",
            apply_task_outcomes(
                &state(),
                &json!({
                    "id": "goal",
                    "milestone": "M1",
                    "milestone_contract": {
                        "id": "M1",
                        "title": "Milestone",
                        "criteria": [
                        { "task_id": "goal", "criterion_id": "value", "description": "value is right" },
                        { "task_id": "goal", "criterion_id": "value", "description": "value is right" },
                    ],
                    },
                }),
            ),
        );
        failing(
            "Milestone contract must match the task milestone",
            apply_task_outcomes(
                &state(),
                &json!({ "id": "goal", "milestone": "M2", "milestone_contract": contract() }),
            ),
        );
    }

    #[test]
    fn validate_accepts_a_missing_document_and_the_applied_one() {
        validate_task_outcomes(&state()).unwrap();
        let stored = apply_task_outcomes(
            &state(),
            &json!({
                "id": "goal",
                "outcome": { "acceptance_task_id": "goal" },
                "milestone": "M1",
                "milestone_contract": contract(),
            }),
        )
        .unwrap()
        .unwrap();
        let mut document = state();
        document["task_outcomes"] = stored;
        validate_task_outcomes(&document).unwrap();
    }

    #[test]
    fn validate_rejects_unknown_tasks_and_duplicates() {
        let mut document = state();
        document["task_outcomes"] = json!({
            "schema": 1,
            "tasks": [{ "task_id": "ghost" }],
            "milestones": [],
        });
        failing("Invalid outcome task", validate_task_outcomes(&document));
        let mut duplicated = state();
        duplicated["task_outcomes"] = json!({
            "schema": 1,
            "tasks": [{ "task_id": "goal" }, { "task_id": "goal" }],
            "milestones": [],
        });
        failing("Invalid outcome task", validate_task_outcomes(&duplicated));
        let mut extra = state();
        extra["task_outcomes"] = json!({ "schema": 1, "tasks": [], "milestones": [], "extra": 1 });
        failing("Invalid task outcomes", validate_task_outcomes(&extra));
    }

    #[test]
    fn schemas_keep_the_advertised_shape() {
        let outcome = outcome_schema();
        assert_eq!(outcome["additionalProperties"], json!(false));
        assert_eq!(outcome["properties"]["owner"]["maxLength"], json!(1000));
        assert_eq!(
            outcome["properties"]["purpose"]["type"],
            json!(["string", "null"])
        );
        let milestone = milestone_schema();
        assert_eq!(milestone["required"], json!(["id", "title", "criteria"]));
        assert_eq!(milestone["properties"]["criteria"]["maxItems"], json!(50));
        assert_eq!(
            milestone["properties"]["criteria"]["items"]["properties"]["criterion_id"]["pattern"],
            json!("^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$")
        );
    }

    #[test]
    fn criterion_ids_follow_the_js_pattern() {
        assert!(criterion_id_ok("a"));
        assert!(criterion_id_ok("A1._-"));
        assert!(!criterion_id_ok(""));
        assert!(!criterion_id_ok("_a"));
        assert!(!criterion_id_ok(&"a".repeat(129)));
        assert!(criterion_id_ok(&"a".repeat(128)));
    }
}
