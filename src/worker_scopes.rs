use anyhow::{Context, Result};
use serde_json::{Map, Value};
use std::io::{self, Read, Write};

const MAX_INPUT_BYTES: usize = 2 * 1024 * 1024;

pub fn cmd_validate() -> Result<()> {
    let mut input = Vec::new();
    io::stdin()
        .take((MAX_INPUT_BYTES + 1) as u64)
        .read_to_end(&mut input)
        .context("read worker scope declarations")?;
    if input.len() > MAX_INPUT_BYTES {
        anyhow::bail!("worker scope input exceeds 2 MiB");
    }
    let input: Value = serde_json::from_slice(&input).context("parse worker scope declarations")?;
    let values = input
        .as_array()
        .context("worker scope declarations must be a JSON array")?;
    let output: Vec<Value> = values.iter().map(declaration_result).collect();
    let stdout = io::stdout();
    let mut stdout = stdout.lock();
    serde_json::to_writer(&mut stdout, &output)?;
    writeln!(stdout)?;
    Ok(())
}

fn declaration_result(input: &Value) -> Value {
    match declaration(input) {
        Ok(value) => serde_json::json!({ "ok": true, "value": value }),
        Err(code) => serde_json::json!({ "ok": false, "code": code }),
    }
}

fn declaration(input: &Value) -> std::result::Result<Value, String> {
    let object = input
        .as_object()
        .ok_or_else(|| "invalid_worker_declaration".to_string())?;
    const ALLOWED: &[&str] = &[
        "worker_id",
        "role",
        "read_paths",
        "write_paths",
        "modules",
        "forbidden_paths",
        "lease_seconds",
    ];
    if object.keys().any(|key| !ALLOWED.contains(&key.as_str())) {
        return Err("invalid_worker_declaration".into());
    }

    let worker_id = object.get("worker_id").and_then(Value::as_str);
    let role = object.get("role").and_then(Value::as_str);
    if !worker_id.is_some_and(valid_worker_id) || !matches!(role, Some("edit" | "review")) {
        return Err("invalid_worker_role_or_id".into());
    }
    let role = role.unwrap();

    let reads = paths(object.get("read_paths"), false)?;
    let writes = match object.get("write_paths") {
        None | Some(Value::Null) if role == "review" => Vec::new(),
        None | Some(Value::Null) => return Err("invalid_scope_paths".into()),
        value => paths(value, role == "review")?,
    };
    if role == "review" && !writes.is_empty() {
        return Err("review_worker_is_read_only".into());
    }
    if writes
        .iter()
        .any(|write| !reads.iter().any(|read| covers(read, write)))
    {
        return Err("write_scope_must_be_readable".into());
    }
    let forbidden = match object.get("forbidden_paths") {
        None | Some(Value::Null) => Vec::new(),
        value => paths(value, true)?,
    };
    if forbidden.iter().any(|path| path == ".") {
        return Err("all_paths_forbidden".into());
    }

    let modules = object
        .get("modules")
        .and_then(Value::as_array)
        .filter(|values| {
            !values.is_empty()
                && values.len() <= 32
                && values
                    .iter()
                    .all(|value| value.as_str().is_some_and(valid_module_name))
        })
        .ok_or_else(|| "invalid_worker_modules".to_string())?;
    let mut modules: Vec<String> = modules
        .iter()
        .map(|value| value.as_str().unwrap().to_string())
        .collect();
    modules.sort();
    modules.dedup();

    let lease_seconds = object
        .get("lease_seconds")
        .and_then(safe_integer)
        .filter(|value| (1..=604_800).contains(value))
        .ok_or_else(|| "invalid_lease_seconds".to_string())?;

    let mut normalized = Map::new();
    normalized.insert("worker_id".into(), Value::String(worker_id.unwrap().into()));
    normalized.insert("role".into(), Value::String(role.into()));
    normalized.insert(
        "read_paths".into(),
        Value::Array(reads.into_iter().map(Value::String).collect()),
    );
    normalized.insert(
        "write_paths".into(),
        Value::Array(writes.into_iter().map(Value::String).collect()),
    );
    normalized.insert(
        "modules".into(),
        Value::Array(modules.into_iter().map(Value::String).collect()),
    );
    normalized.insert(
        "forbidden_paths".into(),
        Value::Array(forbidden.into_iter().map(Value::String).collect()),
    );
    normalized.insert("lease_seconds".into(), Value::from(lease_seconds));
    Ok(Value::Object(normalized))
}

fn paths(value: Option<&Value>, empty: bool) -> std::result::Result<Vec<String>, String> {
    let values = value
        .and_then(Value::as_array)
        .filter(|values| values.len() <= 64 && (empty || !values.is_empty()))
        .ok_or_else(|| "invalid_scope_paths".to_string())?;
    let mut normalized = Vec::with_capacity(values.len());
    for value in values {
        normalized.push(relative_scope(value)?);
    }
    normalized.sort_by(|left, right| js_string_cmp(left, right));
    normalized.dedup();
    Ok(normalized)
}

fn relative_scope(value: &Value) -> std::result::Result<String, String> {
    let value = value
        .as_str()
        .filter(|value| {
            !value.is_empty()
                && value.encode_utf16().count() <= 512
                && !value.starts_with('/')
                && !value.chars().any(|c| {
                    c <= '\u{1f}'
                        || c == '\u{7f}'
                        || matches!(c, '\\' | ':' | '*' | '?' | '[' | ']')
                })
        })
        .ok_or_else(|| "invalid_scope_path".to_string())?;
    if value == "." {
        return Ok(value.into());
    }
    let normalized = value.strip_suffix('/').unwrap_or(value);
    if normalized.is_empty()
        || normalized
            .split('/')
            .any(|part| part.is_empty() || matches!(part, "." | ".."))
        || covers(".git", normalized)
    {
        return Err("invalid_scope_path".into());
    }
    Ok(normalized.into())
}

fn covers(scope: &str, file: &str) -> bool {
    let (scope, file) = if cfg!(windows) {
        (scope.to_lowercase(), file.to_lowercase())
    } else {
        (scope.to_string(), file.to_string())
    };
    scope == "." || file == scope || file.starts_with(&(scope + "/"))
}

fn valid_worker_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    (1..=40).contains(&bytes.len())
        && bytes[0].is_ascii_lowercase()
        && bytes[1..]
            .iter()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'-')
}

fn valid_module_name(value: &str) -> bool {
    let bytes = value.as_bytes();
    (1..=80).contains(&bytes.len())
        && bytes[0].is_ascii_alphanumeric()
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(*byte, b'.' | b'_' | b'/' | b'-'))
}

fn safe_integer(value: &Value) -> Option<u64> {
    let number = value.as_f64()?;
    if number.is_finite()
        && number.fract() == 0.0
        && (0.0..=9_007_199_254_740_991.0).contains(&number)
    {
        Some(number as u64)
    } else {
        None
    }
}

fn js_string_cmp(left: &str, right: &str) -> std::cmp::Ordering {
    left.encode_utf16().cmp(right.encode_utf16())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn declarations_preserve_the_dashboard_validation_contract() {
        let value = declaration(&json!({
            "worker_id": "editor-a",
            "role": "edit",
            "read_paths": ["src", "."],
            "write_paths": ["src/b", "src/a", "src/a"],
            "modules": ["zeta", "alpha", "alpha"],
            "forbidden_paths": ["src/private"],
            "lease_seconds": 60
        }))
        .unwrap();
        assert_eq!(value["read_paths"], json!([".", "src"]));
        assert_eq!(value["write_paths"], json!(["src/a", "src/b"]));
        assert_eq!(value["modules"], json!(["alpha", "zeta"]));
    }

    #[test]
    fn omitted_write_paths_are_allowed_only_for_review_workers() {
        let edit = json!({
            "worker_id": "editor-a",
            "role": "edit",
            "read_paths": ["."],
            "modules": ["runtime"],
            "lease_seconds": 60
        });
        assert_eq!(declaration(&edit), Err("invalid_scope_paths".into()));

        let review = json!({
            "worker_id": "reviewer-a",
            "role": "review",
            "read_paths": ["."],
            "modules": ["runtime"],
            "lease_seconds": 60
        });
        assert_eq!(declaration(&review).unwrap()["write_paths"], json!([]));
    }

    #[test]
    fn paths_reject_parent_and_git_metadata_segments() {
        for invalid in ["../secret", "src/../secret", ".git/config"] {
            assert_eq!(
                relative_scope(&json!(invalid)),
                Err("invalid_scope_path".into())
            );
        }
        if cfg!(windows) {
            assert_eq!(
                relative_scope(&json!("src/.GIT/config")),
                Err("invalid_scope_path".into())
            );
        } else {
            assert_eq!(
                relative_scope(&json!("src/.GIT/config")),
                Ok("src/.GIT/config".into())
            );
        }
    }

    #[test]
    fn js_path_order_uses_utf16_code_units() {
        let mut values = vec!["\u{10000}".to_string(), "\u{e000}".to_string()];
        values.sort_by(|left, right| js_string_cmp(left, right));
        assert_eq!(values, ["\u{10000}", "\u{e000}"]);
    }
}
