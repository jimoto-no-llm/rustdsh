//! Keep a CLI-backed provider's model list in step with the local CLI catalog.
//!
//! DeepSeek Harness answers "which models can this provider serve?" for a
//! provider it ships a catalog for from the catalog bundled in its
//! `@earendil-works/pi-ai` dependency. That file is generated when the package
//! is published, so a model released afterwards is simply absent — Codex's
//! `gpt-6.1-sol` was missing from the harness catalog while the Codex CLI had
//! been serving it for weeks. A profile that lists `models:` explicitly also
//! *replaces* the bundled catalog for that route, so the new model has to be
//! named there by hand.
//!
//! This module closes that gap from the CLI side: it reads the catalog the
//! local Codex CLI already maintains (`codex debug models`, falling back to
//! `~/.codex/models_cache.json`) and appends the ids a profile does not carry
//! yet. It only ever *adds* entries: an existing entry, its comments, and every
//! other byte of the profile are left alone, and a profile whose structure this
//! module does not recognize is refused instead of rewritten.
//!
//! Upstream reference: `packages/llm/llm-pi-ai` in deepseek-ai/deepseek-harness
//! (`resolveRouteModels` replaces the catalog with a configured `models` list;
//! `discoverModels` answers catalog providers from pi-ai without a network
//! call).

use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{bail, Context, Result};
use serde_json::{json, Value};

use crate::file_lock::CredentialFileLock;
use crate::inspect::dsh_home;

/// Provider route whose local CLI catalog this module can read.
pub(crate) const CODEX_PROVIDER: &str = "openai-codex";
/// Output cap used when the profile has no sibling entry to borrow one from.
/// pi-ai's own Codex catalog declares 128000 for every model it ships.
const DEFAULT_MAX_TOKENS: u64 = 128_000;
/// Thinking levels the harness accepts, in its escalation order. A level the
/// CLI advertises but this list does not name (`ultra`) is left out rather than
/// mapped onto a level the harness would refuse.
const HARNESS_LEVELS: &[&str] = &["off", "minimal", "low", "medium", "high", "xhigh", "max"];
/// Modalities the harness can carry; anything else is dropped.
const HARNESS_MODALITIES: &[&str] = &["text", "image"];
/// A local catalog larger than this is refused rather than buffered.
const MAX_CATALOG_BYTES: usize = 8 * 1024 * 1024;

/// One model the local CLI advertises, in the shape a harness `models:` entry
/// needs. `max_tokens` is filled per profile (see [`analyze_profile`]).
///
/// `efforts` deliberately never carries `off`. The harness reads a declared
/// `off: null` as "leave the level out of pi-ai's `thinkingLevelMap`", and
/// pi-ai then sends `reasoning.effort: "none"` for a model whose map has no
/// `off` key — which the Codex backend refuses (`'none' is not supported with
/// the 'gpt-6.1-sol' model`). Leaving `off` undeclared instead pins it to
/// `null`, which is what pi-ai's own catalog entry for this model does and what
/// keeps the request free of a `reasoning` block when no effort is chosen.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CatalogModel {
    pub id: String,
    pub name: String,
    pub context_window: u64,
    pub max_tokens: u64,
    pub input: Vec<String>,
    pub efforts: Vec<String>,
}

/// What one profile already lists and what the CLI adds to it.
#[derive(Debug)]
pub(crate) struct Analysis {
    /// Ids the profile already carries, in file order.
    pub existing: Vec<String>,
    /// CLI models the profile does not carry, ready to append.
    pub missing: Vec<CatalogModel>,
}

/// Read every candidate model from one `codex debug models` document.
///
/// Hidden models (`visibility: "hide"`) and models the CLI marks as not
/// API-servable are skipped: they are not selectable in Codex either, and
/// adding them would put ids in the picker that every request refuses.
pub(crate) fn catalog_from_json(doc: &Value, max_tokens: u64) -> Vec<CatalogModel> {
    let Some(entries) = doc.get("models").and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in entries {
        if entry
            .get("visibility")
            .and_then(Value::as_str)
            .is_some_and(|v| v != "list")
        {
            continue;
        }
        if entry.get("supported_in_api").and_then(Value::as_bool) == Some(false) {
            continue;
        }
        let Some(id) = entry.get("slug").and_then(Value::as_str) else {
            continue;
        };
        if id.is_empty() || id.chars().any(char::is_whitespace) {
            continue;
        }
        let context_window = entry
            .get("context_window")
            .and_then(Value::as_u64)
            .or_else(|| entry.get("max_context_window").and_then(Value::as_u64))
            .filter(|value| *value > 0);
        let Some(context_window) = context_window else {
            continue;
        };
        let name = entry
            .get("display_name")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .unwrap_or(id);
        let mut input: Vec<String> = entry
            .get("input_modalities")
            .and_then(Value::as_array)
            .map(|modalities| {
                modalities
                    .iter()
                    .filter_map(Value::as_str)
                    .filter(|m| HARNESS_MODALITIES.contains(m))
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default();
        if input.is_empty() {
            input.push("text".to_string());
        }
        out.push(CatalogModel {
            id: id.to_string(),
            name: name.to_string(),
            context_window,
            max_tokens,
            input,
            efforts: advertised_levels(entry),
        });
    }
    out
}

/// The CLI's reasoning efforts reduced to levels the harness understands, in
/// the harness's own escalation order.
fn advertised_levels(entry: &Value) -> Vec<String> {
    let advertised: Vec<&str> = entry
        .get("supported_reasoning_levels")
        .and_then(Value::as_array)
        .map(|levels| {
            levels
                .iter()
                .filter_map(|level| level.get("effort").and_then(Value::as_str))
                .collect()
        })
        .unwrap_or_default();
    HARNESS_LEVELS
        .iter()
        .filter(|level| **level != "off" && advertised.contains(level))
        .map(|level| (*level).to_string())
        .collect()
}

/// The local Codex catalog and the label describing where it came from.
///
/// `codex debug models` is authoritative and account-aware; the app's cache
/// file carries the same document for installs where the CLI is not on `PATH`.
pub(crate) fn codex_catalog(max_tokens: u64) -> Result<(Vec<CatalogModel>, String)> {
    if let Some(text) = codex_cli_catalog() {
        if let Ok(doc) = serde_json::from_str::<Value>(&text) {
            let models = catalog_from_json(&doc, max_tokens);
            if !models.is_empty() {
                return Ok((models, "codex debug models".to_string()));
            }
        }
    }
    let path = codex_cache_path().context("HOME is not set")?;
    let text = std::fs::read_to_string(&path).with_context(|| {
        format!("neither `codex debug models` nor {path} yielded a model catalog")
    })?;
    let doc: Value = serde_json::from_str(&text)
        .with_context(|| format!("{path} is not the model catalog JSON this build expects"))?;
    let models = catalog_from_json(&doc, max_tokens);
    if models.is_empty() {
        bail!("{path} lists no selectable Codex model");
    }
    Ok((models, path))
}

fn codex_cli_catalog() -> Option<String> {
    let output = Command::new("codex")
        .args(["debug", "models"])
        .output()
        .ok()?;
    if !output.status.success() || output.stdout.len() > MAX_CATALOG_BYTES {
        return None;
    }
    String::from_utf8(output.stdout).ok()
}

fn codex_cache_path() -> Option<String> {
    crate::inspect::home_dir().map(|home| format!("{home}/.codex/models_cache.json"))
}

/// Every profile whose patch layer may carry a harness `models:` list.
///
/// An explicit `--profile` names one directory and fails when it is not a
/// profile; otherwise every profile with a `cordis.patch.yml` is considered.
pub(crate) fn profile_paths(only: Option<&str>) -> Result<Vec<(String, PathBuf)>> {
    let root = PathBuf::from(dsh_home()).join("profiles");
    if let Some(name) = only {
        let dir = root.join(name);
        let patch = dir.join("cordis.patch.yml");
        if !patch.is_file() {
            bail!(
                "no profile {name} with a cordis.patch.yml under {}",
                root.display()
            );
        }
        return Ok(vec![(name.to_string(), patch)]);
    }
    let mut out = Vec::new();
    let entries =
        std::fs::read_dir(&root).with_context(|| format!("cannot read {}", root.display()))?;
    for entry in entries.flatten() {
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let patch = entry.path().join("cordis.patch.yml");
        if !patch.is_file() {
            continue;
        }
        out.push((entry.file_name().to_string_lossy().into_owned(), patch));
    }
    out.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(out)
}

/// Read one profile and report which CLI models its `openai-codex` list lacks.
pub(crate) fn analyze_profile(
    text: &str,
    provider: &str,
    catalog: &[CatalogModel],
) -> Result<Analysis> {
    let lines: Vec<String> = text.lines().map(str::to_string).collect();
    let site = locate_owned(&lines, provider)?;
    let existing = existing_ids(&lines, &site);
    let max_tokens = existing_max_tokens(&lines, &site).unwrap_or(DEFAULT_MAX_TOKENS);
    let missing = catalog
        .iter()
        .filter(|model| !existing.contains(&model.id))
        .map(|model| CatalogModel {
            max_tokens,
            ..model.clone()
        })
        .collect();
    Ok(Analysis { existing, missing })
}

/// Append the models an earlier [`analyze_profile`] found missing.
///
/// Returns the new document and the ids added. An up-to-date profile is
/// returned unchanged, so a repeated run is a no-op and a caller can compare
/// strings to decide whether to write at all.
pub(crate) fn apply_profile(
    text: &str,
    provider: &str,
    catalog: &[CatalogModel],
) -> Result<(String, Vec<String>)> {
    let analysis = analyze_profile(text, provider, catalog)?;
    if analysis.missing.is_empty() {
        return Ok((text.to_string(), Vec::new()));
    }
    let mut lines: Vec<String> = text.lines().map(str::to_string).collect();
    let site = locate_owned(&lines, provider)?;
    let added: Vec<String> = analysis.missing.iter().map(|m| m.id.clone()).collect();
    let block: Vec<String> = analysis
        .missing
        .iter()
        .flat_map(|model| format_model(model, site.item_indent, site.step))
        .collect();

    if let Some(models_line) = site.models_line {
        if lines[models_line].trim_end().ends_with("[]") {
            // `models: []` is an inline empty sequence: give it a body.
            lines[models_line] = format!("{}models:", " ".repeat(site.models_indent));
            lines.splice(models_line + 1..models_line + 1, block);
            return Ok((join(lines, text), added));
        }
    }
    match site.models_line {
        Some(models_line) => {
            let insert_at = last_item_end(&lines, &site).unwrap_or(models_line + 1);
            lines.splice(insert_at..insert_at, block);
        }
        None => {
            // `openai-codex:` exists but carries no models list yet: append the
            // new list after the provider's last existing key.
            let insert_at = (site.provider_line + 1..site.provider_end)
                .rfind(|i| !lines[*i].trim().is_empty())
                .map(|i| i + 1)
                .unwrap_or(site.provider_line + 1);
            let mut header = vec![format!("{}models:", " ".repeat(site.models_indent))];
            header.extend(block);
            lines.splice(insert_at..insert_at, header);
        }
    }
    Ok((join(lines, text), added))
}

fn join(lines: Vec<String>, original: &str) -> String {
    let mut text = lines.join("\n");
    if original.ends_with('\n') {
        text.push('\n');
    }
    text
}

/// One profile's `openai-codex` section, located by 1-based-safe line index.
#[derive(Debug, Clone, Copy)]
struct Site {
    provider_line: usize,
    provider_end: usize,
    models_line: Option<usize>,
    /// One past the models sequence (the first line indented no deeper than
    /// `models:`); 0 when the provider has no models list yet.
    models_end: usize,
    models_indent: usize,
    item_indent: usize,
    step: usize,
}

fn locate_owned(lines: &[String], provider: &str) -> Result<Site> {
    let entry = llm_pi_ai_entry(lines).ok_or_else(|| {
        anyhow::anyhow!(
            "no llm-pi-ai patch entry: add a `- id: llm-pi-ai` entry with a providers.{provider} block first"
        )
    })?;
    let entry_end = block_end(lines, entry);
    let config = find_key(lines, entry + 1, entry_end, "config")
        .ok_or_else(|| anyhow::anyhow!("the llm-pi-ai entry has no config: block"))?;
    let config_end = block_end(lines, config);
    let providers = find_key(lines, config + 1, config_end, "providers")
        .ok_or_else(|| anyhow::anyhow!("the llm-pi-ai config has no providers: block"))?;
    let providers_end = block_end(lines, providers);
    let provider_line = find_key(lines, providers + 1, providers_end, provider).ok_or_else(|| {
        anyhow::anyhow!(
            "the profile does not configure the {provider} provider: add a `{provider}:` block with a models: list"
        )
    })?;
    let provider_indent = indent_of(&lines[provider_line]);
    let trimmed = lines[provider_line].trim_end();
    let provider_inline_empty = trimmed.ends_with("{}");
    let provider_end = block_end(lines, provider_line);
    let step = step_after(lines, provider_line, provider_end).unwrap_or(2);
    match find_key(lines, provider_line + 1, provider_end, "models") {
        Some(models_line) => {
            let models_indent = indent_of(&lines[models_line]);
            let models_end = block_end(lines, models_line);
            let item_indent = first_item_indent(lines, models_line + 1, models_end)
                .unwrap_or(models_indent + step);
            Ok(Site {
                provider_line,
                provider_end,
                models_line: Some(models_line),
                models_end,
                models_indent,
                item_indent,
                step,
            })
        }
        None => {
            if provider_inline_empty {
                bail!(
                    "the {provider} block is written as `{provider}: {{}}` on one line; expand it to a block with a models: list first"
                );
            }
            Ok(Site {
                provider_line,
                provider_end,
                models_line: None,
                models_end: 0,
                models_indent: provider_indent + step,
                item_indent: provider_indent + step * 2,
                step,
            })
        }
    }
}

/// The index of the `- id: llm-pi-ai` (or matching `name:`) patch entry. The
/// identifying key may sit on the `- ` line itself or on the line below it.
fn llm_pi_ai_entry(lines: &[String]) -> Option<usize> {
    let starts: Vec<usize> = (0..lines.len())
        .filter(|i| indent_of(&lines[*i]) == 0 && lines[*i].starts_with("- "))
        .collect();
    for (position, start) in starts.iter().enumerate() {
        let end = starts.get(position + 1).copied().unwrap_or(lines.len());
        let head = lines[*start]
            .trim_start()
            .strip_prefix("- ")
            .unwrap_or("")
            .trim();
        if identifies_llm_pi_ai(head) {
            return Some(*start);
        }
        if (start + 1..end).any(|i| identifies_llm_pi_ai(lines[i].trim())) {
            return Some(*start);
        }
    }
    None
}

fn identifies_llm_pi_ai(trimmed: &str) -> bool {
    matches!(
        trimmed,
        "id: llm-pi-ai"
            | "name: \"@deepseek-ai/dsh-llm-pi-ai\""
            | "name: '@deepseek-ai/dsh-llm-pi-ai'"
            | "name: @deepseek-ai/dsh-llm-pi-ai"
    )
}

/// The first line after `start` that is indented no deeper than `start`.
fn block_end(lines: &[String], start: usize) -> usize {
    let depth = indent_of(&lines[start]);
    let mut i = start + 1;
    while i < lines.len() {
        let trimmed = lines[i].trim();
        if !trimmed.is_empty() && !trimmed.starts_with('#') && indent_of(&lines[i]) <= depth {
            break;
        }
        i += 1;
    }
    i
}

/// A `key:` line (or `key: something`) within `[from, until)`.
fn find_key(lines: &[String], from: usize, until: usize, key: &str) -> Option<usize> {
    (from..until).find(|i| {
        let trimmed = lines[*i].trim_start();
        trimmed
            .strip_prefix(key)
            .is_some_and(|rest| rest.starts_with(':') || rest.starts_with(": "))
    })
}

/// The indentation of the first content line inside a block.
fn step_after(lines: &[String], start: usize, end: usize) -> Option<usize> {
    let depth = indent_of(&lines[start]);
    (start + 1..end)
        .find(|i| {
            let trimmed = lines[*i].trim();
            !trimmed.is_empty() && !trimmed.starts_with('#') && indent_of(&lines[*i]) > depth
        })
        .map(|i| indent_of(&lines[i]) - depth)
}

fn first_item_indent(lines: &[String], from: usize, until: usize) -> Option<usize> {
    (from..until)
        .find(|i| lines[*i].trim_start().starts_with("- "))
        .map(|i| indent_of(&lines[i]))
}

/// The end of the last `- ` item inside a sequence block.
fn last_item_end(lines: &[String], site: &Site) -> Option<usize> {
    let models_line = site.models_line?;
    let models_end = site.models_end.min(lines.len());
    let last = (models_line + 1..models_end).rfind(|i| {
        indent_of(&lines[*i]) == site.item_indent && lines[*i].trim_start().starts_with("- ")
    })?;
    Some(block_end(lines, last))
}

fn existing_ids(lines: &[String], site: &Site) -> Vec<String> {
    let Some(models_line) = site.models_line else {
        return Vec::new();
    };
    let end = site.models_end.min(lines.len());
    (models_line + 1..end)
        .filter(|i| {
            indent_of(&lines[*i]) == site.item_indent && lines[*i].trim_start().starts_with("- ")
        })
        .filter_map(|i| inline_id(&lines[i]))
        .collect()
}

/// The `id:` of one `- id: <value>` sequence item.
fn inline_id(line: &str) -> Option<String> {
    let body = line.trim_start().strip_prefix("- ")?;
    let value = body.trim_start().strip_prefix("id:")?.trim();
    Some(unquote(value))
}

fn existing_max_tokens(lines: &[String], site: &Site) -> Option<u64> {
    let models_line = site.models_line?;
    let end = site.models_end.min(lines.len());
    (models_line + 1..end)
        .filter_map(|i| {
            let value = lines[i].trim().strip_prefix("maxTokens:")?.trim();
            unquote(value).parse::<u64>().ok()
        })
        .max()
}

fn unquote(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.len() >= 2 && trimmed.starts_with('\'') && trimmed.ends_with('\'') {
        return trimmed[1..trimmed.len() - 1].replace("''", "'");
    }
    if trimmed.len() >= 2 && trimmed.starts_with('"') && trimmed.ends_with('"') {
        return trimmed[1..trimmed.len() - 1].to_string();
    }
    trimmed.to_string()
}

fn indent_of(line: &str) -> usize {
    line.len() - line.trim_start().len()
}

fn format_model(model: &CatalogModel, item_indent: usize, step: usize) -> Vec<String> {
    let item = " ".repeat(item_indent);
    let key = " ".repeat(item_indent + step);
    let nested = " ".repeat(item_indent + step * 2);
    let mut out = vec![
        format!("{item}- id: {}", yaml_scalar(&model.id)),
        format!("{key}name: {}", yaml_scalar(&model.name)),
        format!("{key}contextWindow: {}", model.context_window),
        format!("{key}maxTokens: {}", model.max_tokens),
        format!("{key}input:"),
    ];
    for modality in &model.input {
        out.push(format!("{nested}- {}", yaml_scalar(modality)));
    }
    if !model.efforts.is_empty() {
        out.push(format!("{key}reasoningEfforts:"));
        for level in &model.efforts {
            out.push(format!("{nested}{level}: {level}"));
        }
    }
    out
}

/// Render a YAML scalar, quoting anything that would not survive as a plain
/// one. Model ids and display names are ordinary words today; quoting keeps a
/// future name with a colon or a leading digit from breaking the profile.
fn yaml_scalar(raw: &str) -> String {
    let plain = !raw.is_empty()
        && !raw.starts_with(' ')
        && !raw.ends_with(' ')
        && !raw.contains(": ")
        && !raw.contains(" #")
        && raw
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | ' '))
        && !raw.starts_with('-');
    if plain {
        raw.to_string()
    } else {
        format!("'{}'", raw.replace('\'', "''"))
    }
}

/// `rdsh models`: report what each profile is missing, writing nothing.
pub(crate) fn cmd_models_show(profile: Option<&str>, json: bool) -> Result<()> {
    let (catalog, source) = codex_catalog(DEFAULT_MAX_TOKENS)?;
    let profiles = profile_paths(profile)?;
    let mut reports = Vec::new();
    for (name, path) in &profiles {
        let text = std::fs::read_to_string(path)
            .with_context(|| format!("cannot read {}", path.display()))?;
        let report = match analyze_profile(&text, CODEX_PROVIDER, &catalog) {
            Ok(analysis) => json!({
                "profile": name,
                "path": path.display().to_string(),
                "listed": analysis.existing,
                "missing": analysis.missing.iter().map(|m| &m.id).collect::<Vec<_>>(),
            }),
            Err(error) => json!({
                "profile": name,
                "path": path.display().to_string(),
                "skipped": format!("{error:#}"),
            }),
        };
        reports.push(report);
    }
    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&json!({
                "provider": CODEX_PROVIDER,
                "source": source,
                "profiles": reports,
            }))?
        );
        return Ok(());
    }
    use std::io::Write;
    let _ = writeln!(
        std::io::stdout(),
        "[rdsh models] provider {CODEX_PROVIDER} · catalog: {source}"
    );
    for report in &reports {
        if let Some(skipped) = report.get("skipped").and_then(Value::as_str) {
            let _ = writeln!(
                std::io::stdout(),
                "  {}  skipped: {skipped}",
                report["profile"].as_str().unwrap_or("?")
            );
            continue;
        }
        let missing: Vec<&str> = report["missing"]
            .as_array()
            .map(|ids| ids.iter().filter_map(Value::as_str).collect())
            .unwrap_or_default();
        let listed = report["listed"].as_array().map(Vec::len).unwrap_or(0);
        if missing.is_empty() {
            let _ = writeln!(
                std::io::stdout(),
                "  {}  up to date ({listed} listed)",
                report["profile"].as_str().unwrap_or("?")
            );
        } else {
            let _ = writeln!(
                std::io::stdout(),
                "  {}  missing {}: {}",
                report["profile"].as_str().unwrap_or("?"),
                missing.len(),
                missing.join(", ")
            );
        }
    }
    let _ = writeln!(std::io::stdout(), "[rdsh] add them with: rdsh models sync");
    Ok(())
}

/// `rdsh models sync`: append the missing entries, or preview with `--dry-run`.
pub(crate) fn cmd_models_sync(profile: Option<&str>, dry_run: bool, json: bool) -> Result<()> {
    let (catalog, source) = codex_catalog(DEFAULT_MAX_TOKENS)?;
    let profiles = profile_paths(profile)?;
    let mut reports = Vec::new();
    for (name, path) in &profiles {
        let path_text = path.display().to_string();
        let report = match std::fs::read_to_string(path) {
            Ok(text) => match apply_profile(&text, CODEX_PROVIDER, &catalog) {
                Ok((updated, added)) => {
                    let mut written = false;
                    let mut error = None;
                    if !added.is_empty() && !dry_run {
                        match write_profile(path, &updated) {
                            Ok(()) => written = true,
                            Err(e) => error = Some(format!("{e:#}")),
                        }
                    }
                    json!({
                        "profile": name,
                        "path": path_text,
                        "added": added,
                        "written": written,
                        "dry_run": dry_run || added.is_empty(),
                        "error": error,
                    })
                }
                Err(e) => json!({
                    "profile": name,
                    "path": path_text,
                    "skipped": format!("{e:#}"),
                }),
            },
            Err(e) => json!({
                "profile": name,
                "path": path_text,
                "skipped": format!("cannot read {path_text}: {e}"),
            }),
        };
        reports.push(report);
    }
    let failed = reports
        .iter()
        .filter_map(|r| r.get("error").and_then(Value::as_str))
        .count();
    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&json!({
                "provider": CODEX_PROVIDER,
                "source": source,
                "dry_run": dry_run,
                "profiles": reports,
            }))?
        );
        if failed > 0 {
            std::process::exit(1);
        }
        return Ok(());
    }
    use std::io::Write;
    let mut wrote_any = false;
    for report in &reports {
        let name = report["profile"].as_str().unwrap_or("?");
        if let Some(skipped) = report.get("skipped").and_then(Value::as_str) {
            let _ = writeln!(std::io::stdout(), "  {name}  skipped: {skipped}");
            continue;
        }
        let added: Vec<&str> = report["added"]
            .as_array()
            .map(|ids| ids.iter().filter_map(Value::as_str).collect())
            .unwrap_or_default();
        if let Some(error) = report.get("error").and_then(Value::as_str) {
            let _ = writeln!(std::io::stdout(), "  {name}  error: {error}");
            continue;
        }
        if added.is_empty() {
            let _ = writeln!(std::io::stdout(), "  {name}  up to date");
        } else if dry_run {
            let _ = writeln!(
                std::io::stdout(),
                "  {name}  would add {}: {}",
                added.len(),
                added.join(", ")
            );
        } else {
            wrote_any = true;
            let _ = writeln!(
                std::io::stdout(),
                "  {name}  added {}: {}",
                added.len(),
                added.join(", ")
            );
        }
    }
    if wrote_any {
        let _ = writeln!(
            std::io::stdout(),
            "[rdsh] restart the harness (or reload its config) to pick up the new models"
        );
    }
    if failed > 0 {
        std::process::exit(1);
    }
    Ok(())
}

/// Replace one profile document atomically, under the harness's own lock
/// protocol so a live config edit and this sync cannot interleave.
fn write_profile(path: &Path, text: &str) -> Result<()> {
    let _lock = CredentialFileLock::exclusive_for(path)?;
    crate::auth::write_creds(&path.display().to_string(), text)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn catalog() -> Vec<CatalogModel> {
        vec![
            CatalogModel {
                id: "gpt-6.1-sol".to_string(),
                name: "GPT-6.1-Sol".to_string(),
                context_window: 272_000,
                max_tokens: DEFAULT_MAX_TOKENS,
                input: vec!["text".to_string(), "image".to_string()],
                efforts: vec![
                    "low".to_string(),
                    "medium".to_string(),
                    "high".to_string(),
                    "xhigh".to_string(),
                    "max".to_string(),
                ],
            },
            CatalogModel {
                id: "gpt-daybreak-blue-latest".to_string(),
                name: "Daybreak Blue".to_string(),
                context_window: 272_000,
                max_tokens: DEFAULT_MAX_TOKENS,
                input: vec!["text".to_string()],
                efforts: Vec::new(),
            },
        ]
    }

    const PROFILE: &str = "\
- id: llm-pi-ai
  name: \"@deepseek-ai/dsh-llm-pi-ai\"
  config:
    providers:
      openai-codex:
        models:
          - id: gpt-5.6-sol
            name: GPT-5.6 Sol
            contextWindow: 272000
            maxTokens: 128000
            input:
              - text
              - image
      opencode-go:
        apiKeyEnv: OPENCODE_GO_API_KEY
        models:
          - id: deepseek-v4.1-flash
            name: DeepSeek V4.1 Flash
- id: agent-default-model
  name: \"@deepseek-ai/dsh-agent-default-model\"
  config:
    provider: opencode-go
    model: deepseek-v4.1-flash
";

    #[test]
    fn catalog_skips_hidden_and_remaps_efforts() {
        let doc = serde_json::json!({
            "models": [
                {
                    "slug": "gpt-6.1-sol",
                    "display_name": "GPT-6.1-Sol",
                    "visibility": "list",
                    "supported_in_api": true,
                    "context_window": 272000,
                    "input_modalities": ["text", "image", "audio"],
                    "supported_reasoning_levels": [
                        {"effort": "low"}, {"effort": "medium"}, {"effort": "ultra"}
                    ]
                },
                {"slug": "gpt-reserve", "visibility": "hide", "context_window": 272000},
                {"slug": "no-api", "supported_in_api": false, "context_window": 272000},
                {"slug": "", "visibility": "list", "context_window": 272000},
                {"slug": "no-context", "visibility": "list"}
            ]
        });
        let models = catalog_from_json(&doc, DEFAULT_MAX_TOKENS);
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].id, "gpt-6.1-sol");
        assert_eq!(
            models[0].input,
            vec!["text".to_string(), "image".to_string()]
        );
        // `ultra` is not a harness level: it is dropped, not remapped.
        assert_eq!(
            models[0].efforts,
            vec!["low".to_string(), "medium".to_string()]
        );
    }

    #[test]
    fn cache_document_without_visibility_is_accepted() {
        let doc = serde_json::json!({
            "models": [{"slug": "gpt-6-sol", "display_name": "GPT-6-Sol", "context_window": 272000}]
        });
        let models = catalog_from_json(&doc, DEFAULT_MAX_TOKENS);
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].input, vec!["text".to_string()]);
        assert!(models[0].efforts.is_empty());
    }

    #[test]
    fn sync_appends_only_missing_models_and_keeps_the_rest_byte_for_byte() {
        let (updated, added) = apply_profile(PROFILE, CODEX_PROVIDER, &catalog()).unwrap();
        assert_eq!(
            added,
            vec![
                "gpt-6.1-sol".to_string(),
                "gpt-daybreak-blue-latest".to_string()
            ]
        );
        // The existing entry, its sibling provider, and the second patch entry
        // are untouched.
        assert!(updated.starts_with(PROFILE.split("          - id: gpt-5.6-sol").next().unwrap()));
        assert!(updated.contains(
            "          - id: gpt-5.6-sol\n            name: GPT-5.6 Sol\n            contextWindow: 272000"
        ));
        assert!(updated.contains("      opencode-go:\n        apiKeyEnv: OPENCODE_GO_API_KEY"));
        assert!(updated.ends_with(
            "- id: agent-default-model\n  name: \"@deepseek-ai/dsh-agent-default-model\"\n  config:\n    provider: opencode-go\n    model: deepseek-v4.1-flash\n"
        ));
        assert!(updated.contains(
            "          - id: gpt-6.1-sol\n            name: GPT-6.1-Sol\n            contextWindow: 272000\n            maxTokens: 128000\n            input:\n              - text\n              - image\n            reasoningEfforts:\n              low: low\n"
        ));
        // The added non-reasoning model has no reasoningEfforts block.
        let tail = &updated[updated.find("- id: gpt-daybreak-blue-latest").unwrap()..];
        assert!(!tail.starts_with("- id: gpt-daybreak-blue-latest\n            name: Daybreak Blue\n            contextWindow: 272000\n            maxTokens: 128000\n            input:\n              - text\n            reasoningEfforts"));
    }

    #[test]
    fn sync_reuses_the_sibling_output_cap() {
        let profile = PROFILE.replace("maxTokens: 128000", "maxTokens: 64000");
        let (updated, _) = apply_profile(&profile, CODEX_PROVIDER, &catalog()).unwrap();
        assert!(updated.contains("- id: gpt-6.1-sol\n            name: GPT-6.1-Sol\n            contextWindow: 272000\n            maxTokens: 64000"));
    }

    #[test]
    fn sync_is_idempotent() {
        let (once, _) = apply_profile(PROFILE, CODEX_PROVIDER, &catalog()).unwrap();
        let (twice, added) = apply_profile(&once, CODEX_PROVIDER, &catalog()).unwrap();
        assert!(added.is_empty());
        assert_eq!(once, twice);
    }

    #[test]
    fn sync_creates_a_models_list_when_the_provider_has_none() {
        let profile = "\
- id: llm-pi-ai
  config:
    providers:
      openai-codex:
        api: openai-codex-responses
- id: agent-default-model
  config:
    provider: openai-codex
    model: gpt-6-sol
";
        let (updated, added) = apply_profile(profile, CODEX_PROVIDER, &catalog()).unwrap();
        assert_eq!(added.len(), 2);
        assert!(updated.contains(
            "      openai-codex:\n        api: openai-codex-responses\n        models:\n          - id: gpt-6.1-sol\n"
        ));
        // The following patch entry keeps its own indentation.
        assert!(updated.ends_with("- id: agent-default-model\n  config:\n    provider: openai-codex\n    model: gpt-6-sol\n"));
    }

    #[test]
    fn sync_expands_an_inline_empty_models_list() {
        let profile = "\
- id: llm-pi-ai
  config:
    providers:
      openai-codex:
        models: []
";
        let (updated, added) = apply_profile(profile, CODEX_PROVIDER, &catalog()).unwrap();
        assert_eq!(added.len(), 2);
        assert!(updated.contains("        models:\n          - id: gpt-6.1-sol\n"));
        assert!(!updated.contains("models: []"));
    }

    #[test]
    fn a_sibling_list_under_the_provider_is_not_read_as_models() {
        // `headers:` sits at the same indentation as `models:`, so its items
        // share the models item indentation. The scan must stop at the key.
        let profile = "\
- id: llm-pi-ai
  config:
    providers:
      openai-codex:
        models:
          - id: gpt-5.6-sol
            maxTokens: 64000
        headers:
          - id: not-a-model
            value: x
";
        let analysis = analyze_profile(profile, CODEX_PROVIDER, &catalog()).unwrap();
        assert_eq!(analysis.existing, vec!["gpt-5.6-sol".to_string()]);
        assert_eq!(analysis.missing.len(), 2);
        // The sibling list is not the sibling whose cap we borrow either: the
        // models entry is the only maxTokens source.
        assert_eq!(analysis.missing[0].max_tokens, 64_000);
        let (updated, _) = apply_profile(profile, CODEX_PROVIDER, &catalog()).unwrap();
        assert!(updated.contains(
            "          - id: gpt-daybreak-blue-latest\n            name: Daybreak Blue\n            contextWindow: 272000\n            maxTokens: 64000\n            input:\n              - text\n        headers:\n"
        ));
    }

    #[test]
    fn sync_refuses_a_profile_without_the_provider_block() {
        let profile = "\
- id: llm-pi-ai
  config:
    providers:
      opencode-go:
        models: []
";
        let error = apply_profile(profile, CODEX_PROVIDER, &catalog()).unwrap_err();
        assert!(error
            .to_string()
            .contains("does not configure the openai-codex"));
    }

    #[test]
    fn sync_refuses_a_profile_without_the_llm_pi_ai_entry() {
        let error = apply_profile(
            "- id: agent-default-model\n  config:\n    provider: openai-codex\n",
            CODEX_PROVIDER,
            &catalog(),
        )
        .unwrap_err();
        assert!(error.to_string().contains("no llm-pi-ai patch entry"));
    }

    #[test]
    fn sync_refuses_an_inline_empty_provider_block() {
        let profile = "\
- id: llm-pi-ai
  config:
    providers:
      openai-codex: {}
";
        let error = apply_profile(profile, CODEX_PROVIDER, &catalog()).unwrap_err();
        assert!(error.to_string().contains("expand it to a block"));
    }

    #[test]
    fn text_without_a_trailing_newline_keeps_none() {
        let profile = PROFILE.trim_end_matches('\n');
        let (updated, _) = apply_profile(profile, CODEX_PROVIDER, &catalog()).unwrap();
        assert!(!updated.ends_with('\n'));
    }
}
