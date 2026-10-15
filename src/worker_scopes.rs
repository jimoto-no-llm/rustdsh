//! Pure worker-scope validation and batched policy evaluation from stdin.
//!
//! Canonical declaration codes, path ordering and JSON records match the
//! dashboard engine. Only CLI-owned diagnostics use the resolved locale;
//! parser and operating-system reasons remain unchanged in their error chain.
use crate::locale::{self, Locale};
use anyhow::{Context, Result};
use serde_json::{Map, Value};
use std::io::{self, Read, Write};

const MAX_INPUT_BYTES: usize = 2 * 1024 * 1024;
const MAX_POLICY_BATCH_ITEMS: usize = 4096;

/// Validate stdin declarations without reading settings or changing JSON values.
pub fn cmd_validate(locale: Locale) -> Result<()> {
    let input = read_input("worker scope declarations", locale)?;
    let values = input.as_array().context(locale::diagnostic(
        locale,
        "worker scope declarations must be a JSON array",
    ))?;
    let output: Vec<Value> = values.iter().map(declaration_result).collect();
    let stdout = io::stdout();
    let mut stdout = stdout.lock();
    serde_json::to_writer(&mut stdout, &output)
        .context(locale::diagnostic(locale, "serialize worker scope results"))?;
    writeln!(stdout).context(locale::diagnostic(locale, "write worker scope results"))?;
    Ok(())
}

/// Evaluate a stdin policy batch without changing canonical policy results.
pub fn cmd_policy(locale: Locale) -> Result<()> {
    let input = read_input("worker scope policy batch", locale)?;
    let object = input.as_object().context(locale::diagnostic(
        locale,
        "worker scope policy batch must be a JSON object",
    ))?;
    const ALLOWED: &[&str] = &["write_checks", "intersections", "shared_files"];
    if object.keys().any(|key| !ALLOWED.contains(&key.as_str())) {
        anyhow::bail!(
            locale::diagnostic(locale, "unknown worker scope policy batch field").to_string()
        );
    }

    let mut write_checks = Vec::new();
    for check in optional_array(object, "write_checks", locale)? {
        let check = check.as_object().context(locale::diagnostic(
            locale,
            "write check must be a JSON object",
        ))?;
        if check
            .keys()
            .any(|key| !matches!(key.as_str(), "scope" | "files"))
        {
            anyhow::bail!(locale::diagnostic(locale, "unknown write check field").to_string());
        }
        let scope = declaration(
            check
                .get("scope")
                .context(locale::diagnostic(locale, "write check is missing scope"))?,
        )
        .map_err(anyhow::Error::msg)
        .context(locale::diagnostic(locale, "invalid write check scope"))?;
        let files = check
            .get("files")
            .and_then(Value::as_array)
            .context(locale::diagnostic(
                locale,
                "write check files must be a JSON array",
            ))?;
        let mut results = Vec::with_capacity(files.len());
        for file in files {
            let file = file.as_str().context(locale::diagnostic(
                locale,
                "write check file must be a string",
            ))?;
            results.push(may_write(&scope, file));
        }
        write_checks.push(results);
        if write_checks.len() > MAX_POLICY_BATCH_ITEMS {
            anyhow::bail!(
                locale::diagnostic(locale, "too many worker scope write checks").to_string()
            );
        }
    }

    let mut intersections = Vec::new();
    for pair in optional_array(object, "intersections", locale)? {
        let pair = pair.as_object().context(locale::diagnostic(
            locale,
            "scope intersection must be a JSON object",
        ))?;
        if pair
            .keys()
            .any(|key| !matches!(key.as_str(), "left" | "right"))
        {
            anyhow::bail!(
                locale::diagnostic(locale, "unknown scope intersection field").to_string()
            );
        }
        let left = declaration(pair.get("left").context(locale::diagnostic(
            locale,
            "scope intersection is missing left",
        ))?)
        .map_err(anyhow::Error::msg)
        .context(locale::diagnostic(locale, "invalid left scope"))?;
        let right = declaration(pair.get("right").context(locale::diagnostic(
            locale,
            "scope intersection is missing right",
        ))?)
        .map_err(anyhow::Error::msg)
        .context(locale::diagnostic(locale, "invalid right scope"))?;
        intersections.push(scope_intersections(&left, &right));
        if intersections.len() > MAX_POLICY_BATCH_ITEMS {
            anyhow::bail!(
                locale::diagnostic(locale, "too many worker scope intersections").to_string()
            );
        }
    }

    let mut shared_files = Vec::new();
    for file in optional_array(object, "shared_files", locale)? {
        let file = file.as_str().context(locale::diagnostic(
            locale,
            "shared file path must be a string",
        ))?;
        shared_files.push(is_shared_file(file));
        if shared_files.len() > MAX_POLICY_BATCH_ITEMS {
            anyhow::bail!(locale::diagnostic(locale, "too many shared file checks").to_string());
        }
    }

    let output = serde_json::json!({
        "write_checks": write_checks,
        "intersections": intersections,
        "shared_files": shared_files,
    });
    let stdout = io::stdout();
    let mut stdout = stdout.lock();
    serde_json::to_writer(&mut stdout, &output)
        .context(locale::diagnostic(locale, "serialize worker scope results"))?;
    writeln!(stdout).context(locale::diagnostic(locale, "write worker scope results"))?;
    Ok(())
}

fn read_input(context: &str, locale: Locale) -> Result<Value> {
    let mut input = Vec::new();
    io::stdin()
        .take((MAX_INPUT_BYTES + 1) as u64)
        .read_to_end(&mut input)
        .with_context(|| locale::diagnostic(locale, &format!("read {context}")).to_owned())?;
    if input.len() > MAX_INPUT_BYTES {
        anyhow::bail!(locale::diagnostic(locale, "worker scope input exceeds 2 MiB").to_string());
    }
    serde_json::from_slice(&input)
        .with_context(|| locale::diagnostic(locale, &format!("parse {context}")).to_owned())
}

fn optional_array<'a>(
    object: &'a Map<String, Value>,
    key: &str,
    locale: Locale,
) -> Result<&'a [Value]> {
    match object.get(key) {
        None | Some(Value::Null) => Ok(&[]),
        Some(Value::Array(values)) if values.len() <= MAX_POLICY_BATCH_ITEMS => Ok(values),
        Some(Value::Array(_)) => {
            anyhow::bail!("{} {key}", locale::diagnostic(locale, "too many values in"))
        }
        Some(_) => anyhow::bail!(
            "{key}{}",
            locale::diagnostic(locale, " must be a JSON array")
        ),
    }
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
        || is_git_metadata_path(normalized)
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

fn is_git_metadata_path(path: &str) -> bool {
    path.split('/').any(|component| {
        if cfg!(windows) {
            component.eq_ignore_ascii_case(".git")
        } else {
            component == ".git"
        }
    })
}

fn may_write(scope: &Value, file: &str) -> bool {
    if is_git_metadata_path(file) {
        return false;
    }
    let includes = |key: &str| {
        scope
            .get(key)
            .and_then(Value::as_array)
            .is_some_and(|paths| {
                paths
                    .iter()
                    .filter_map(Value::as_str)
                    .any(|path| covers(path, file))
            })
    };
    includes("write_paths") && !includes("forbidden_paths")
}

fn scope_intersections(left: &Value, right: &Value) -> Vec<String> {
    let left_paths = left
        .get("write_paths")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str);
    let right_paths: Vec<&str> = right
        .get("write_paths")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect();
    let mut overlaps = Vec::new();
    for left_path in left_paths {
        for right_path in &right_paths {
            let narrow = if covers(left_path, right_path) {
                Some(*right_path)
            } else if covers(right_path, left_path) {
                Some(left_path)
            } else {
                None
            };
            if let Some(narrow) = narrow {
                if may_write(left, narrow) && may_write(right, narrow) {
                    overlaps.push(narrow.to_string());
                }
            }
        }
    }
    overlaps.sort_by(|left, right| js_string_cmp(left, right));
    overlaps.dedup();
    overlaps
}

fn is_shared_file(file: &str) -> bool {
    let basename = file.rsplit('/').next().unwrap_or_default();
    let basename = basename.to_ascii_lowercase();
    const EXACT: &[&str] = &[
        "cargo.lock",
        "cargo.toml",
        "package.json",
        "package-lock.json",
        "pnpm-lock.yaml",
        "yarn.lock",
        "bun.lockb",
        "bun.lock",
        "go.mod",
        "go.sum",
        "pyproject.toml",
        "uv.lock",
    ];
    if EXACT.contains(&basename.as_str()) || file.starts_with(".github/workflows/") {
        return true;
    }
    ["tsconfig", "config", "settings"].iter().any(|prefix| {
        let Some(suffix) = basename.strip_prefix(prefix) else {
            return false;
        };
        if suffix == ".json" {
            return true;
        }
        let Some(suffix) = suffix
            .strip_prefix('.')
            .and_then(|suffix| suffix.strip_suffix(".json"))
        else {
            return false;
        };
        !suffix.is_empty() && !suffix.contains('.')
    })
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
        for invalid in [
            "../secret",
            "src/../secret",
            ".git/config",
            "src/.git/config",
        ] {
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
