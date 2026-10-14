//! `rdsh provider`: register an OpenAI-compatible endpoint as a dsh route.
//!
//! DeepSeek Harness ships a pi-ai catalog, and a route that is not in it (HAI,
//! a home llama.cpp / vLLM / LM Studio / Ollama server) has to be declared by
//! hand under `llm-pi-ai` -> `config` -> `providers` in
//! `$DSH_HOME/profiles/<profile>/cordis.patch.yml`: `api`, `baseURL`,
//! `apiKeyEnv` and a non-empty `models:` list. This module writes that block.
//!
//! * Presets: `hai` (fixed endpoint) and `local-openai` (any base URL, any
//!   route id, so several home servers can coexist).
//! * Models come from `--model`, from opencode's `provider.<id>` entry
//!   (`--from-opencode`, JSONC, never its `apiKey`) and from the server's own
//!   `GET {baseURL}/models` (`--discover`).
//! * The write is line surgery: a Cordis override replaces the whole entry
//!   config, so the block is added *inside* the existing `providers:` mapping
//!   and every other byte (other routes, comments, ordering, line endings) is
//!   kept. A layout this module cannot place safely is refused with the YAML to
//!   add by hand. The file is replaced atomically under the profile lock.
//! * The API key never reaches argv, stdout, `--json` or an error message: it
//!   comes from the route's `apiKeyEnv` variable or one stdin line, is stored
//!   as a `.credentials.yaml` ref, and is passed to curl through a config on
//!   stdin.

use std::io::{BufRead, Read, Write};
use std::net::ToSocketAddrs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};
use serde_json::{json, Value};

use crate::auth;
use crate::file_lock::CredentialFileLock;
use crate::inspect::dsh_home;

/// Wire protocol every preset speaks.
const API: &str = "openai-completions";
/// Stored for `--no-key`: not a secret, only something dsh can send.
const PLACEHOLDER_KEY: &str = "no-key";
/// Modalities dsh accepts in a model's `input:`.
const MODALITIES: &[&str] = &["text", "image"];
/// A listing or opencode config larger than this is refused.
const MAX_BODY_BYTES: usize = 8 * 1024 * 1024;
/// Models taken from one listing; a bigger catalog is truncated with a note.
const MAX_MODELS: usize = 500;
const HTTP_TIMEOUT_SECONDS: u64 = 30;

/// A model a preset ships with: used when no other source names one, and to
/// fill the fields of a matching `--model` id.
struct PresetModel {
    id: &'static str,
    name: &'static str,
    context_window: u64,
    max_tokens: u64,
}

struct Preset {
    id: &'static str,
    display_name: &'static str,
    /// Fixed endpoint; `None` when the user must supply one.
    base_url: Option<&'static str>,
    /// Models used when the user gives no `--model` and no other source does.
    default_models: &'static [PresetModel],
    /// Route-level `compat` lines (`key: value`), written beside `models:`.
    compat: &'static [&'static str],
    /// Hard upper bound for `maxTokens` (the API rejects more); applied to
    /// every model of the route, including ones the user names.
    max_tokens_cap: Option<u64>,
    /// `false` when the endpoint has no `GET /models`.
    supports_discovery: bool,
}

const PRESETS: &[Preset] = &[
    Preset {
        id: "hai",
        display_name: "HAI",
        base_url: Some("https://hai-api.hcloud.ltd/v1"),
        default_models: &[],
        compat: &[],
        max_tokens_cap: None,
        supports_discovery: true,
    },
    Preset {
        id: "local-openai",
        display_name: "Local OpenAI-compatible",
        base_url: None,
        default_models: &[],
        compat: &[],
        max_tokens_cap: None,
        supports_discovery: true,
    },
    // Chat Completions rejects fields it does not document (`store`,
    // `stream_options`) and a `max_completion_tokens` above 8000; the compat
    // lines and the maxTokens cap keep dsh from sending them.
    Preset {
        id: "sarashina",
        display_name: "Sarashina",
        base_url: Some("https://api.sarashina.ai/v1"),
        default_models: &[
            PresetModel {
                id: "sarashina3-mini",
                name: "Sarashina3 mini",
                context_window: 128000,
                max_tokens: 8000,
            },
            PresetModel {
                id: "sarashina3-nano",
                name: "Sarashina3 nano",
                context_window: 128000,
                max_tokens: 8000,
            },
        ],
        compat: &["supportsStore: false", "supportsUsageInStreaming: false"],
        max_tokens_cap: Some(8000),
        supports_discovery: false,
    },
];

fn preset(id: &str) -> Option<&'static Preset> {
    PRESETS.iter().find(|p| p.id == id)
}

fn t(ja: &str, en: &str) -> String {
    if auth::is_japanese() {
        ja.to_string()
    } else {
        en.to_string()
    }
}

// --- model and route -----------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Default)]
struct Model {
    id: String,
    name: Option<String>,
    context_window: Option<u64>,
    max_tokens: Option<u64>,
    input: Vec<String>,
}

#[derive(Debug, Clone)]
struct Route {
    id: String,
    display_name: String,
    base_url: String,
    api_key_env: String,
    /// `key: value` lines written under `compat:`; empty writes no block.
    compat: Vec<String>,
    models: Vec<Model>,
}

/// Apply a preset's built-in knowledge to the merged models: fill the fields
/// of its known ids and clamp `maxTokens` to its cap. Returns a note for each
/// id the preset does not know.
fn apply_preset_models(preset: &Preset, models: &mut [Model]) -> Vec<String> {
    let mut notes = Vec::new();
    if preset.default_models.is_empty() && preset.max_tokens_cap.is_none() {
        return notes;
    }
    for model in models.iter_mut() {
        match preset.default_models.iter().find(|d| d.id == model.id) {
            Some(known) => {
                model.name.get_or_insert_with(|| known.name.to_string());
                model.context_window.get_or_insert(known.context_window);
                model.max_tokens.get_or_insert(known.max_tokens);
                if model.input.is_empty() {
                    model.input = vec!["text".to_string()];
                }
            }
            None if !preset.default_models.is_empty() => notes.push(format!(
                "{}: {} is not one of the documented chat models ({}); contextWindow is left to dsh's default",
                preset.id,
                model.id,
                preset
                    .default_models
                    .iter()
                    .map(|d| d.id)
                    .collect::<Vec<_>>()
                    .join(", ")
            )),
            None => {}
        }
        if let Some(cap) = preset.max_tokens_cap {
            model.max_tokens = Some(model.max_tokens.map_or(cap, |m| m.min(cap)));
        }
    }
    notes
}

fn valid_model_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 200 && id.trim() == id && !id.chars().any(|c| c.is_control())
}

/// Fold model lists in priority order: the first list fixes an id's position,
/// later lists only fill fields it left empty.
fn merge_models(groups: Vec<Vec<Model>>) -> Vec<Model> {
    let mut out: Vec<Model> = Vec::new();
    for model in groups.into_iter().flatten() {
        match out.iter_mut().find(|m| m.id == model.id) {
            Some(have) => {
                if have.name.is_none() {
                    have.name = model.name;
                }
                if have.context_window.is_none() {
                    have.context_window = model.context_window;
                }
                if have.max_tokens.is_none() {
                    have.max_tokens = model.max_tokens;
                }
                if have.input.is_empty() {
                    have.input = model.input;
                }
            }
            None => out.push(model),
        }
    }
    out
}

fn route_key_env(id: &str) -> String {
    auth::key_name(id)
}

/// A YAML scalar, plain only when nothing about it could be read as another
/// type or as syntax (numbers, booleans, null, comments, `: `).
fn yaml_scalar(raw: &str) -> String {
    let reserved = matches!(
        raw.to_ascii_lowercase().as_str(),
        "true" | "false" | "yes" | "no" | "on" | "off" | "y" | "n" | "null"
    );
    let plain = !reserved
        && raw.chars().next().is_some_and(|c| c.is_ascii_alphabetic())
        && !raw.ends_with([' ', ':'])
        && !raw.contains(": ")
        && !raw.contains(" #")
        && raw.chars().all(|c| {
            c.is_ascii_alphanumeric()
                || matches!(c, ' ' | '.' | '_' | '-' | '/' | ':' | '(' | ')' | '+')
        });
    if plain {
        raw.to_string()
    } else {
        format!("'{}'", raw.replace('\'', "''"))
    }
}

/// The route as YAML lines whose key sits at `indent`, nesting by `step`.
fn render_route(route: &Route, indent: usize, step: usize) -> Vec<String> {
    let at = |depth: usize| " ".repeat(indent + step * depth);
    // Keys after `- id:` line up with `id`, two columns right of the dash,
    // whatever the file's own indentation step is.
    let item_key = " ".repeat(indent + step * 2 + 2);
    let mut out = vec![
        format!("{}{}:", at(0), route.id),
        format!("{}displayName: {}", at(1), yaml_scalar(&route.display_name)),
        format!("{}apiKeyEnv: {}", at(1), yaml_scalar(&route.api_key_env)),
        format!("{}api: {API}", at(1)),
        format!("{}baseURL: {}", at(1), yaml_scalar(&route.base_url)),
    ];
    if !route.compat.is_empty() {
        out.push(format!("{}compat:", at(1)));
        for line in &route.compat {
            out.push(format!("{}{line}", at(2)));
        }
    }
    out.push(format!("{}models:", at(1)));
    // Only what a source stated is written: an omitted field falls back to
    // the route defaults dsh documents (defaultContextWindow,
    // defaultMaxTokens, defaultInput), never to a number guessed here.
    for model in &route.models {
        out.push(format!("{}- id: {}", at(2), yaml_scalar(&model.id)));
        if let Some(name) = &model.name {
            out.push(format!("{item_key}name: {}", yaml_scalar(name)));
        }
        if let Some(window) = model.context_window {
            out.push(format!("{item_key}contextWindow: {window}"));
        }
        if let Some(max) = model.max_tokens {
            out.push(format!("{item_key}maxTokens: {max}"));
        }
        if !model.input.is_empty() {
            out.push(format!("{item_key}input: [{}]", model.input.join(", ")));
        }
    }
    out
}

/// The whole entry, for the message shown when the file cannot be edited.
fn manual_snippet(route: &Route) -> String {
    let mut lines = vec![
        "- id: llm-pi-ai".to_string(),
        "  config:".to_string(),
        "    providers:".to_string(),
    ];
    lines.extend(render_route(route, 6, 2));
    lines.join("\n")
}

// --- line surgery on cordis.patch.yml ------------------------------------------

fn skippable(line: &str) -> bool {
    let t = line.trim();
    t.is_empty() || t.starts_with('#')
}

fn indent_of(line: &str) -> usize {
    line.len() - line.trim_start().len()
}

/// A scalar with any trailing YAML comment removed.
fn strip_comment(value: &str) -> &str {
    let bytes = value.as_bytes();
    let mut quote = None;
    for (index, byte) in bytes.iter().enumerate() {
        match quote {
            Some(open) => {
                if *byte == open {
                    quote = None;
                }
            }
            None if *byte == b'\'' || *byte == b'"' => quote = Some(*byte),
            None if *byte == b'#' && (index == 0 || matches!(bytes[index - 1], b' ' | b'\t')) => {
                return value[..index].trim_end();
            }
            None => {}
        }
    }
    value.trim_end()
}

fn unquote(value: &str) -> String {
    let v = value.trim();
    if v.len() >= 2 && v.starts_with('\'') && v.ends_with('\'') {
        return v[1..v.len() - 1].replace("''", "'");
    }
    if v.len() >= 2 && v.starts_with('"') && v.ends_with('"') {
        return v[1..v.len() - 1].to_string();
    }
    v.to_string()
}

/// For a line that opens with `key:` (plain or quoted), the value after the
/// colon without a trailing comment; `Some("")` for a block or empty value.
fn key_rest<'a>(line: &'a str, key: &str) -> Option<&'a str> {
    let trimmed = line.trim_start();
    for form in [key.to_string(), format!("\"{key}\""), format!("'{key}'")] {
        if let Some(rest) = trimmed.strip_prefix(form.as_str()) {
            // YAML allows blanks between the key and its colon.
            if let Some(after) = rest.trim_start_matches([' ', '\t']).strip_prefix(':') {
                if after.is_empty() || after.starts_with([' ', '\t', '\r']) {
                    return Some(strip_comment(after.trim()));
                }
            }
        }
    }
    None
}

/// The first line after `start` that is indented no deeper than `start`.
fn block_end(lines: &[String], start: usize) -> usize {
    let depth = indent_of(&lines[start]);
    let mut i = start + 1;
    while i < lines.len() {
        if !skippable(&lines[i]) && indent_of(&lines[i]) <= depth {
            break;
        }
        i += 1;
    }
    i
}

/// One past the last real (non-blank, non-comment) line in `[start, end)`.
fn content_end(lines: &[String], start: usize, end: usize) -> usize {
    (start..end.min(lines.len()))
        .rev()
        .find(|i| !skippable(&lines[*i]))
        .map_or(start + 1, |i| i + 1)
}

/// Indentation of the first real line inside a block, when it is deeper.
fn child_indent(lines: &[String], parent: usize, end: usize) -> Option<usize> {
    let depth = indent_of(&lines[parent]);
    (parent + 1..end.min(lines.len()))
        .find(|i| !skippable(&lines[*i]))
        .map(|i| indent_of(&lines[i]))
        .filter(|indent| *indent > depth)
}

/// The `key:` line among the direct children (`indent` columns) of a block.
fn find_at(lines: &[String], from: usize, until: usize, indent: usize, key: &str) -> Option<usize> {
    (from..until.min(lines.len()))
        .find(|i| indent_of(&lines[*i]) == indent && key_rest(&lines[*i], key).is_some())
}

const PI_AI_ID: &str = "llm-pi-ai";
const PI_AI_NAME: &str = "@deepseek-ai/dsh-llm-pi-ai";

/// The value of `key` on one entry line, read as a YAML scalar (comment
/// stripped, quotes removed). `Ok(None)` when the line is another key,
/// `Err` when the value is in a form this module will not interpret.
fn scalar_key(line: &str, key: &str) -> std::result::Result<Option<String>, String> {
    let Some(rest) = key_rest(line, key) else {
        return Ok(None);
    };
    let unsafe_start =
        rest.is_empty() || rest.starts_with(['|', '>', '[', '{', '&', '*', '!', '?']);
    let escaped = rest.starts_with('"') && rest.contains('\\');
    if unsafe_start || escaped {
        return Err(format!(
            "a top-level `{key}:` value is written in a form rdsh will not interpret"
        ));
    }
    Ok(Some(unquote(rest)))
}

/// The `- id: llm-pi-ai` patch entry (by `id`, or by the plugin `name`). Only
/// keys of the entry itself count: a nested `id:` (inside `insert`, say) does
/// not. `Err` when an entry cannot be read safely or the plugin is declared
/// twice (a later entry replaces the whole config in Cordis).
fn llm_pi_ai_entry(lines: &[String]) -> std::result::Result<Option<usize>, String> {
    let starts: Vec<usize> = (0..lines.len())
        .filter(|i| {
            indent_of(&lines[*i]) == 0
                && lines[*i].starts_with('-')
                && !lines[*i].starts_with("---")
        })
        .collect();
    let mut found = Vec::new();
    for (position, start) in starts.iter().enumerate() {
        let end = starts.get(position + 1).copied().unwrap_or(lines.len());
        if !lines[*start].starts_with("- ") {
            return Err("a patch entry does not start with `- key:` on one line".to_string());
        }
        let col = dash_key_col(&lines[*start]);
        let head = &lines[*start][col..];
        if head.starts_with(['{', '[', '#']) || head.trim().is_empty() {
            return Err(
                "a patch entry is written in flow style or without a first key".to_string(),
            );
        }
        let mut hit = false;
        let candidates = std::iter::once(head).chain(
            (start + 1..end)
                .filter(|i| !skippable(&lines[*i]) && indent_of(&lines[*i]) == col)
                .map(|i| lines[i].trim_start()),
        );
        for text in candidates {
            if scalar_key(text, "id")?.is_some_and(|v| v == PI_AI_ID)
                || scalar_key(text, "name")?.is_some_and(|v| v == PI_AI_NAME)
            {
                hit = true;
            }
        }
        if hit {
            if key_rest(head, "config").is_some() {
                return Err("the llm-pi-ai entry starts with its config key".to_string());
            }
            found.push(*start);
        }
    }
    if found.len() > 1 {
        return Err("llm-pi-ai is declared by more than one patch entry".to_string());
    }
    Ok(found.first().copied())
}

/// Whether a line (comment removed) holds `llm-pi-ai` or the plugin name as a
/// whole scalar token, at any depth and in any position.
fn mentions_pi_ai(line: &str) -> bool {
    let body = strip_comment(line);
    body.split(|c: char| !(c.is_ascii_alphanumeric() || matches!(c, '_' | '@' | '/' | '.' | '-')))
        .any(|tok| tok == PI_AI_ID || tok == PI_AI_NAME)
}

/// `llm_pi_ai_entry`, plus: the document defines llm-pi-ai in exactly one
/// place. Cordis lets a later top-level patch target an entry inserted
/// earlier, so appending a top-level `- id: llm-pi-ai` next to a nested
/// definition would replace that definition's whole config. Any mention
/// outside the entry's own top-level keys (another entry, a nested `insert`,
/// a deeper key) is therefore refused.
fn sole_pi_ai_entry(lines: &[String]) -> std::result::Result<Option<usize>, String> {
    let entry = llm_pi_ai_entry(lines)?;
    let (own, col) = match entry {
        Some(start) => (start..block_end(lines, start), dash_key_col(&lines[start])),
        None => (0..0, 0),
    };
    for (i, line) in lines.iter().enumerate() {
        if !mentions_pi_ai(line) {
            continue;
        }
        let top_key = entry.is_some_and(|s| i == s || indent_of(line) == col);
        if !(own.contains(&i) && top_key) {
            return Err(
                "llm-pi-ai is also mentioned elsewhere in the file (a nested or second definition)"
                    .to_string(),
            );
        }
    }
    Ok(entry)
}

/// Column of the first key on a `- key: v` line.
fn dash_key_col(line: &str) -> usize {
    let after = &line[2..];
    2 + after.len() - after.trim_start().len()
}

#[derive(Debug, Clone, Copy)]
struct Providers {
    line: usize,
    end: usize,
    child_indent: usize,
}

/// Locate `llm-pi-ai` -> `config` -> `providers` without changing anything.
/// `Ok(None)` when any level is absent, `Err` when a level is written in a
/// form this module will not edit.
fn locate_providers(lines: &[String]) -> Result<Option<Providers>> {
    let Some(entry) = llm_pi_ai_entry(lines).map_err(|e| anyhow::anyhow!(e))? else {
        return Ok(None);
    };
    let col = dash_key_col(&lines[entry]);
    let entry_end = block_end(lines, entry);
    let Some(config) = find_at(lines, entry + 1, entry_end, col, "config") else {
        return Ok(None);
    };
    if !key_rest(&lines[config], "config").is_some_and(str::is_empty) {
        bail!("the llm-pi-ai config is written inline on one line");
    }
    let config_end = block_end(lines, config);
    let Some(ci) = child_indent(lines, config, config_end) else {
        return Ok(None);
    };
    let Some(providers) = find_at(lines, config + 1, config_end, ci, "providers") else {
        return Ok(None);
    };
    if !key_rest(&lines[providers], "providers").is_some_and(str::is_empty) {
        bail!("providers is written inline (for example `providers: {{}}`)");
    }
    let end = block_end(lines, providers);
    let child = child_indent(lines, providers, end).unwrap_or(indent_of(&lines[providers]) + 2);
    Ok(Some(Providers {
        line: providers,
        end,
        child_indent: child,
    }))
}

/// What a route block in a profile says, for `provider list`.
#[derive(Debug, Clone, PartialEq, Eq)]
struct RouteInfo {
    id: String,
    base_url: Option<String>,
    api_key_env: Option<String>,
    models: usize,
}

fn split_lines(text: &str) -> Vec<String> {
    text.split('\n').map(str::to_string).collect()
}

fn routes_in(text: &str) -> Vec<RouteInfo> {
    let lines = split_lines(text);
    let Ok(Some(p)) = locate_providers(&lines) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for i in p.line + 1..p.end.min(lines.len()) {
        if skippable(&lines[i]) || indent_of(&lines[i]) != p.child_indent {
            continue;
        }
        let trimmed = lines[i].trim();
        let Some(colon) = trimmed.find(':') else {
            continue;
        };
        let id = unquote(&trimmed[..colon]);
        let end = block_end(&lines, i);
        let inner = child_indent(&lines, i, end);
        let scalar = |key: &str| -> Option<String> {
            let indent = inner?;
            let at = find_at(&lines, i + 1, end, indent, key)?;
            let value = key_rest(&lines[at], key)?;
            (!value.is_empty()).then(|| unquote(value))
        };
        let models = inner
            .and_then(|indent| find_at(&lines, i + 1, end, indent, "models"))
            .map(|m| {
                let mend = block_end(&lines, m);
                let item = (m + 1..mend)
                    .find(|j| lines[*j].trim_start().starts_with("- "))
                    .map(|j| indent_of(&lines[j]));
                item.map_or(0, |item| {
                    (m + 1..mend)
                        .filter(|j| {
                            indent_of(&lines[*j]) == item
                                && lines[*j].trim_start().starts_with("- ")
                        })
                        .count()
                })
            })
            .unwrap_or(0);
        out.push(RouteInfo {
            id,
            base_url: scalar("baseURL"),
            api_key_env: scalar("apiKeyEnv"),
            models,
        });
    }
    out
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Change {
    /// The route block was inserted.
    Added,
    /// An existing block was rewritten.
    Replaced,
    /// A block exists and `--replace` was not given.
    Exists,
    /// `--replace` produced the bytes already present.
    Identical,
}

impl Change {
    fn as_str(self) -> &'static str {
        match self {
            Change::Added => "added",
            Change::Replaced => "replaced",
            Change::Exists => "exists",
            Change::Identical => "unchanged",
        }
    }
    fn writes(self) -> bool {
        matches!(self, Change::Added | Change::Replaced)
    }
}

#[derive(Debug)]
struct Applied {
    text: String,
    change: Change,
}

fn refuse(reason: &str, route: &Route) -> anyhow::Error {
    anyhow::anyhow!(
        "cannot place providers.{} safely: {reason}\nadd this under llm-pi-ai config providers by hand:\n{}",
        route.id,
        manual_snippet(route)
    )
}

/// Read the edited text back: the llm-pi-ai entry is still unique, every
/// route that was there is still found unchanged (except the one being
/// replaced), the new route is found exactly once with what was asked, and its
/// keys sit at consistent columns.
fn verify_written(
    before: &[RouteInfo],
    after: &str,
    route: &Route,
) -> std::result::Result<(), String> {
    let lines = split_lines(after);
    sole_pi_ai_entry(&lines)?.ok_or("the llm-pi-ai entry is not found after the edit")?;
    let provs = locate_providers(&lines)
        .map_err(|e| e.to_string())?
        .ok_or("the providers block is not found after the edit")?;
    let found = routes_in(after);
    if found.iter().filter(|r| r.id == route.id).count() != 1 {
        return Err("the written route is not found exactly once on read-back".to_string());
    }
    for old in before.iter().filter(|r| r.id != route.id) {
        if !found.contains(old) {
            return Err(format!(
                "the existing route `{}` did not survive the edit",
                old.id
            ));
        }
    }
    let new = found
        .iter()
        .find(|r| r.id == route.id)
        .expect("counted above");
    if new.models != route.models.len()
        || new.base_url.as_deref() != Some(route.base_url.as_str())
        || new.api_key_env.as_deref() != Some(route.api_key_env.as_str())
    {
        return Err("the written route differs from the requested one on read-back".to_string());
    }
    // Layout: required keys share one column and model keys follow `- id`.
    let start = (provs.line + 1..provs.end.min(lines.len()))
        .find(|i| {
            indent_of(&lines[*i]) == provs.child_indent && key_rest(&lines[*i], &route.id).is_some()
        })
        .ok_or("the written route is not at the providers child column")?;
    let end = block_end(&lines, start);
    let inner = child_indent(&lines, start, end).ok_or("the written route has no body")?;
    let mut models_at = None;
    for (i, line) in lines.iter().enumerate().take(end).skip(start + 1) {
        if skippable(line) || indent_of(line) != inner {
            continue;
        }
        let known = [
            "displayName",
            "apiKeyEnv",
            "api",
            "baseURL",
            "compat",
            "models",
        ]
        .iter()
        .any(|k| key_rest(line, k).is_some());
        if !known {
            return Err("an unexpected key sits at the route's column".to_string());
        }
        if key_rest(line, "models").is_some() {
            models_at = Some(i);
        }
    }
    let models_at = models_at.ok_or("the written route has no models key")?;
    let mend = block_end(&lines, models_at);
    let mut item_col = None;
    let mut items = 0;
    for line in lines.iter().take(mend).skip(models_at + 1) {
        if skippable(line) {
            continue;
        }
        let col = indent_of(line);
        if line.trim_start().starts_with("- ") {
            if *item_col.get_or_insert(col) != col {
                return Err("model items are at different columns".to_string());
            }
            items += 1;
        } else if item_col.is_none_or(|c| col != c + 2) {
            return Err("a model key is not aligned with its `- id`".to_string());
        }
    }
    if items != route.models.len() {
        return Err("the written models do not match the requested count".to_string());
    }
    Ok(())
}

/// Insert (or with `replace`, rewrite) `route` in the profile patch text.
fn apply_route(text: &str, route: &Route, replace: bool) -> Result<Applied> {
    let crlf = text.contains("\r\n");
    let eol = if crlf { "\r" } else { "" };
    let mut lines = split_lines(text);
    let before = routes_in(text);
    let finish = |lines: Vec<String>, change: Change| -> Result<Applied> {
        let out = Applied {
            text: lines.join("\n"),
            change,
        };
        if change.writes() {
            verify_written(&before, &out.text, route).map_err(|why| refuse(&why, route))?;
        }
        Ok(out)
    };
    let with_eol = |block: Vec<String>| -> Vec<String> {
        block.into_iter().map(|l| format!("{l}{eol}")).collect()
    };
    // The text always ends with "" after a final newline; keep it last.
    let tail_trim = |lines: &Vec<String>| -> usize {
        if lines.last().is_some_and(|l| l.is_empty()) {
            lines.len() - 1
        } else {
            lines.len()
        }
    };

    let has_content = lines.iter().any(|l| !skippable(l));
    let entry = sole_pi_ai_entry(&lines).map_err(|e| refuse(&e, route))?;
    let Some(entry) = entry else {
        if has_content {
            let top_ok = lines
                .iter()
                .filter(|l| !skippable(l) && indent_of(l) == 0)
                .all(|l| l.starts_with("- "));
            let first_ok = lines
                .iter()
                .find(|l| !skippable(l))
                .is_some_and(|l| indent_of(l) == 0);
            if !top_ok || !first_ok {
                return Err(refuse(
                    "the file is not a plain sequence of patch entries",
                    route,
                ));
            }
        }
        let mut block = vec![
            "- id: llm-pi-ai".to_string(),
            "  config:".to_string(),
            "    providers:".to_string(),
        ];
        block.extend(render_route(route, 6, 2));
        let at = if has_content {
            content_end(&lines, 0, tail_trim(&lines))
        } else {
            tail_trim(&lines)
        };
        let at_end = at >= tail_trim(&lines);
        lines.splice(at..at, with_eol(block));
        if at_end && !lines.last().is_some_and(|l| l.is_empty()) {
            lines.push(String::new());
        }
        return finish(lines, Change::Added);
    };

    let col = dash_key_col(&lines[entry]);
    let entry_end = block_end(&lines, entry);
    let Some(config) = find_at(&lines, entry + 1, entry_end, col, "config") else {
        let at = content_end(&lines, entry, entry_end);
        let mut block = vec![
            format!("{}config:", " ".repeat(col)),
            format!("{}providers:", " ".repeat(col + 2)),
        ];
        block.extend(render_route(route, col + 4, 2));
        lines.splice(at..at, with_eol(block));
        return finish(lines, Change::Added);
    };
    if !key_rest(&lines[config], "config").is_some_and(str::is_empty) {
        return Err(refuse(
            "the llm-pi-ai config is written inline on one line",
            route,
        ));
    }
    let config_end = block_end(&lines, config);
    let config_indent = indent_of(&lines[config]);
    let Some(ci) = child_indent(&lines, config, config_end) else {
        let at = config + 1;
        let mut block = vec![format!("{}providers:", " ".repeat(config_indent + 2))];
        block.extend(render_route(route, config_indent + 4, 2));
        lines.splice(at..at, with_eol(block));
        return finish(lines, Change::Added);
    };
    let Some(providers) = find_at(&lines, config + 1, config_end, ci, "providers") else {
        let at = content_end(&lines, config, config_end);
        let mut block = vec![format!("{}providers:", " ".repeat(ci))];
        let step = (ci - config_indent).max(1);
        block.extend(render_route(route, ci + step, step));
        lines.splice(at..at, with_eol(block));
        return finish(lines, Change::Added);
    };
    if !key_rest(&lines[providers], "providers").is_some_and(str::is_empty) {
        return Err(refuse(
            "providers is written inline (for example `providers: {}`)",
            route,
        ));
    }
    let providers_end = block_end(&lines, providers);
    let providers_indent = indent_of(&lines[providers]);
    let child = child_indent(&lines, providers, providers_end).unwrap_or(providers_indent + 2);
    let step = child - providers_indent;
    match find_at(&lines, providers + 1, providers_end, child, &route.id) {
        Some(existing) => {
            if !replace {
                return finish(lines, Change::Exists);
            }
            let end = content_end(&lines, existing, block_end(&lines, existing));
            let block = with_eol(render_route(route, child, step));
            if lines[existing..end] == block[..] {
                return finish(lines, Change::Identical);
            }
            lines.splice(existing..end, block);
            finish(lines, Change::Replaced)
        }
        None => {
            let at = content_end(&lines, providers, providers_end);
            lines.splice(at..at, with_eol(render_route(route, child, step)));
            finish(lines, Change::Added)
        }
    }
}

// --- base URL ------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
struct Base {
    https: bool,
    /// Host as it appears in a URL (IPv6 keeps its brackets).
    host: String,
    port: u16,
    /// Path without a trailing slash; empty for none.
    path: String,
    /// The URL to store: the input without trailing slashes.
    url: String,
}

fn parse_base_url(raw: &str) -> Result<Base> {
    if raw.is_empty() {
        bail!("base URL is empty");
    }
    if raw
        .chars()
        .any(|c| c.is_control() || c.is_whitespace() || c == '\\')
    {
        bail!("base URL contains whitespace or a control character");
    }
    let (https, rest) = if let Some(r) = raw.strip_prefix("https://") {
        (true, r)
    } else if let Some(r) = raw.strip_prefix("http://") {
        (false, r)
    } else {
        bail!("base URL must start with http:// or https://");
    };
    if rest.contains(['?', '#']) {
        bail!("base URL must not carry a query or fragment");
    }
    let (authority, path) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, ""),
    };
    if authority.contains('@') {
        bail!(
            "base URL must not contain credentials (user:pass@); use --key-stdin or {{ID}}_API_KEY"
        );
    }
    let (host, port_text) = if authority.starts_with('[') {
        let end = authority
            .find(']')
            .ok_or_else(|| anyhow::anyhow!("invalid IPv6 host in base URL"))?;
        authority[1..end]
            .parse::<std::net::Ipv6Addr>()
            .map_err(|_| anyhow::anyhow!("invalid IPv6 host in base URL"))?;
        (&authority[..=end], &authority[end + 1..])
    } else {
        let end = authority.find(':').unwrap_or(authority.len());
        let host = &authority[..end];
        if host.is_empty()
            || !host
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b".-_".contains(&b))
        {
            bail!("invalid host in base URL");
        }
        (host, &authority[end..])
    };
    let port = if port_text.is_empty() {
        if https {
            443
        } else {
            80
        }
    } else {
        port_text
            .strip_prefix(':')
            .and_then(|p| p.parse::<u16>().ok())
            .filter(|p| *p != 0)
            .ok_or_else(|| anyhow::anyhow!("invalid port in base URL"))?
    };
    if !path
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b"/._~%:+-".contains(&b))
    {
        bail!("base URL path contains an unsupported character");
    }
    let path = path.trim_end_matches('/').to_string();
    let url = format!(
        "{}://{authority}{path}",
        if https { "https" } else { "http" }
    );
    Ok(Base {
        https,
        host: host.to_string(),
        port,
        path,
        url,
    })
}

// --- opencode ------------------------------------------------------------------

/// Remove `//` and `/* */` comments outside strings, then trailing commas
/// before `}` or `]`, so the result is plain JSON.
fn strip_jsonc(input: &str) -> String {
    let input = input.strip_prefix('\u{feff}').unwrap_or(input);
    let b = input.as_bytes();
    let mut stage = Vec::with_capacity(b.len());
    let mut i = 0;
    let mut in_str = false;
    while i < b.len() {
        let c = b[i];
        if in_str {
            stage.push(c);
            if c == b'\\' && i + 1 < b.len() {
                stage.push(b[i + 1]);
                i += 2;
                continue;
            }
            if c == b'"' {
                in_str = false;
            }
            i += 1;
            continue;
        }
        match c {
            b'"' => {
                in_str = true;
                stage.push(c);
                i += 1;
            }
            b'/' if b.get(i + 1) == Some(&b'/') => {
                while i < b.len() && b[i] != b'\n' {
                    i += 1;
                }
            }
            b'/' if b.get(i + 1) == Some(&b'*') => {
                i += 2;
                while i < b.len() && !(b[i] == b'*' && b.get(i + 1) == Some(&b'/')) {
                    i += 1;
                }
                i = (i + 2).min(b.len());
                stage.push(b' ');
            }
            _ => {
                stage.push(c);
                i += 1;
            }
        }
    }
    let mut out = Vec::with_capacity(stage.len());
    let mut in_str = false;
    let mut i = 0;
    while i < stage.len() {
        let c = stage[i];
        if in_str {
            out.push(c);
            if c == b'\\' && i + 1 < stage.len() {
                out.push(stage[i + 1]);
                i += 2;
                continue;
            }
            if c == b'"' {
                in_str = false;
            }
        } else if c == b'"' {
            in_str = true;
            out.push(c);
        } else if c == b',' {
            let next = stage[i + 1..].iter().find(|x| !x.is_ascii_whitespace());
            if !matches!(next, Some(b'}') | Some(b']')) {
                out.push(c);
            }
        } else {
            out.push(c);
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

struct OpencodeProvider {
    base_url: Option<String>,
    models: Vec<Model>,
}

fn opencode_paths() -> Vec<PathBuf> {
    let mut dirs: Vec<String> = Vec::new();
    if let Some(c) = auth::config_dir() {
        dirs.push(c);
    }
    if let Some(h) = auth::home() {
        let fallback = format!("{h}/.config");
        if !dirs.contains(&fallback) {
            dirs.push(fallback);
        }
    }
    let mut out = Vec::new();
    for d in dirs {
        for name in ["opencode.jsonc", "opencode.json"] {
            out.push(PathBuf::from(&d).join("opencode").join(name));
        }
    }
    out
}

/// `provider.<id>` from the opencode config. Only `options.baseURL` and the
/// model metadata are read; `options.apiKey` is never touched.
fn read_opencode(id: &str) -> Result<OpencodeProvider> {
    let paths = opencode_paths();
    let Some(path) = paths.iter().find(|p| p.is_file()) else {
        bail!(
            "no opencode config found (looked for {})",
            paths
                .iter()
                .map(|p| p.display().to_string())
                .collect::<Vec<_>>()
                .join(", ")
        );
    };
    let meta = std::fs::metadata(path)?;
    if meta.len() as usize > MAX_BODY_BYTES {
        bail!("{} is too large", path.display());
    }
    let raw =
        std::fs::read_to_string(path).with_context(|| format!("cannot read {}", path.display()))?;
    let doc: Value = serde_json::from_str(&strip_jsonc(&raw))
        .with_context(|| format!("{} is not valid JSON/JSONC", path.display()))?;
    parse_opencode_provider(&doc, id).with_context(|| format!("in {}", path.display()))
}

fn parse_opencode_provider(doc: &Value, id: &str) -> Result<OpencodeProvider> {
    let Some(provider) = doc.get("provider").and_then(|p| p.get(id)) else {
        bail!("opencode config has no provider.{id}");
    };
    let base_url = provider
        .get("options")
        .and_then(|o| o.get("baseURL"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let mut models = Vec::new();
    if let Some(map) = provider.get("models").and_then(Value::as_object) {
        for (key, entry) in map {
            if !valid_model_id(key) {
                continue;
            }
            let limit = entry.get("limit");
            let input: Vec<String> = entry
                .get("modalities")
                .and_then(|m| m.get("input"))
                .and_then(Value::as_array)
                .map(|a| {
                    let mut seen: Vec<String> = Vec::new();
                    for v in a.iter().filter_map(Value::as_str) {
                        if MODALITIES.contains(&v) && !seen.iter().any(|s| s == v) {
                            seen.push(v.to_string());
                        }
                    }
                    seen
                })
                .unwrap_or_default();
            models.push(Model {
                id: key.clone(),
                name: entry
                    .get("name")
                    .and_then(Value::as_str)
                    .filter(|n| !n.trim().is_empty() && !n.chars().any(|c| c.is_control()))
                    .map(str::to_string),
                context_window: limit
                    .and_then(|l| l.get("context"))
                    .and_then(Value::as_u64)
                    .filter(|n| *n > 0),
                max_tokens: limit
                    .and_then(|l| l.get("output"))
                    .and_then(Value::as_u64)
                    .filter(|n| *n > 0),
                input,
            });
        }
    }
    Ok(OpencodeProvider { base_url, models })
}

// --- discovery -----------------------------------------------------------------

/// `data[].id` (OpenAI) or `models[].name|model` (Ollama-style).
fn parse_listing(body: &str) -> Result<Vec<Model>> {
    let doc: Value = serde_json::from_str(body).context("the model listing is not JSON")?;
    let mut ids: Vec<String> = Vec::new();
    if let Some(data) = doc.get("data").and_then(Value::as_array) {
        ids.extend(
            data.iter()
                .filter_map(|m| m.get("id").and_then(Value::as_str))
                .map(str::to_string),
        );
    } else if let Some(models) = doc.get("models").and_then(Value::as_array) {
        ids.extend(
            models
                .iter()
                .filter_map(|m| {
                    m.get("name")
                        .or_else(|| m.get("model"))
                        .and_then(Value::as_str)
                })
                .map(str::to_string),
        );
    } else {
        bail!("the model listing has neither data[] nor models[]");
    }
    Ok(ids
        .into_iter()
        .filter(|id| valid_model_id(id))
        .map(|id| Model {
            id,
            ..Model::default()
        })
        .collect())
}

fn auth_value_ok(key: &str) -> bool {
    !key.is_empty() && !key.chars().any(|c| c.is_control() || c.is_whitespace())
}

fn http_get(base: &Base, path: &str, key: Option<&str>) -> Result<String> {
    let deadline = Instant::now() + Duration::from_secs(HTTP_TIMEOUT_SECONDS);
    let bare_host = base.host.trim_matches(['[', ']']);
    let mut stream = None;
    for address in (bare_host, base.port).to_socket_addrs()? {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }
        if let Ok(s) = std::net::TcpStream::connect_timeout(&address, remaining) {
            stream = Some(s);
            break;
        }
    }
    let mut stream = stream.ok_or_else(|| anyhow::anyhow!("cannot reach {}", base.url))?;
    let host_header = if base.port == 80 {
        base.host.clone()
    } else {
        format!("{}:{}", base.host, base.port)
    };
    let mut request = format!(
        "GET {path} HTTP/1.1\r\nHost: {host_header}\r\nUser-Agent: rdsh/{}\r\nAccept: application/json\r\n",
        env!("CARGO_PKG_VERSION")
    );
    if let Some(key) = key {
        request.push_str(&format!("Authorization: Bearer {key}\r\n"));
    }
    request.push_str("Connection: close\r\n\r\n");
    stream.set_write_timeout(Some(Duration::from_secs(HTTP_TIMEOUT_SECONDS)))?;
    stream.write_all(request.as_bytes())?;
    let mut raw = Vec::new();
    let mut chunk = [0u8; 8192];
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            bail!("{} timed out", base.url);
        }
        stream.set_read_timeout(Some(remaining))?;
        let n = stream.read(&mut chunk)?;
        if n == 0 {
            break;
        }
        if raw.len() + n > MAX_BODY_BYTES {
            bail!(
                "{} answered with more than {MAX_BODY_BYTES} bytes",
                base.url
            );
        }
        raw.extend_from_slice(&chunk[..n]);
    }
    parse_http_response(&raw, &base.url)
}

fn parse_http_response(raw: &[u8], url: &str) -> Result<String> {
    let split = raw
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .ok_or_else(|| anyhow::anyhow!("bad HTTP response from {url}"))?;
    let head = String::from_utf8_lossy(&raw[..split]).into_owned();
    let body = &raw[split + 4..];
    let mut head_lines = head.lines();
    let status = head_lines
        .next()
        .and_then(|l| l.split_whitespace().nth(1))
        .and_then(|s| s.parse::<u16>().ok())
        .ok_or_else(|| anyhow::anyhow!("bad HTTP response from {url}"))?;
    if !(200..300).contains(&status) {
        bail!("{url} answered HTTP {status}");
    }
    let chunked = head_lines.any(|l| {
        let lower = l.to_ascii_lowercase();
        lower.starts_with("transfer-encoding:") && lower.contains("chunked")
    });
    let bytes = if chunked {
        decode_chunked(body).ok_or_else(|| anyhow::anyhow!("bad chunked body from {url}"))?
    } else {
        body.to_vec()
    };
    String::from_utf8(bytes).with_context(|| format!("{url} did not answer with UTF-8"))
}

fn decode_chunked(mut body: &[u8]) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    loop {
        let eol = body.windows(2).position(|w| w == b"\r\n")?;
        let size_text = std::str::from_utf8(&body[..eol]).ok()?;
        let size = usize::from_str_radix(size_text.split(';').next()?.trim(), 16).ok()?;
        body = &body[eol + 2..];
        if size == 0 {
            return Some(out);
        }
        let chunk_end = size.checked_add(2)?;
        let next = body.get(chunk_end..)?;
        out.extend_from_slice(body.get(..size)?);
        body = next;
    }
}

fn curl_quote(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

/// The curl config handed over stdin, so the URL and Authorization header
/// stay out of the process list and a redirect cannot leave https.
fn curl_config(url: &str, key: Option<&str>) -> String {
    let mut config = format!("url = {}\n", curl_quote(url));
    if let Some(key) = key {
        config.push_str(&format!(
            "header = {}\n",
            curl_quote(&format!("Authorization: Bearer {key}"))
        ));
    }
    config.push_str("header = \"Accept: application/json\"\n");
    config.push_str("silent\nshow-error\nfail\n");
    config.push_str("proto = \"=https\"\nproto-redir = \"=https\"\n");
    config.push_str(&format!(
        "max-time = {HTTP_TIMEOUT_SECONDS}\nconnect-timeout = 10\n"
    ));
    config
}

fn curl_get(url: &str, key: Option<&str>) -> Result<String> {
    let config = curl_config(url, key);
    let mut child = Command::new("curl")
        .args(["-q", "--config", "-"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .context("could not run curl; install it, or pass --model instead of --discover")?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(config.as_bytes())
            .context("could not send the request to curl")?;
    }
    let mut body = Vec::new();
    if let Some(mut stdout) = child.stdout.take() {
        let mut buffer = [0u8; 8192];
        loop {
            let read = stdout
                .read(&mut buffer)
                .context("could not read curl's output")?;
            if read == 0 {
                break;
            }
            if body.len() + read > MAX_BODY_BYTES {
                let _ = child.kill();
                bail!("{url} answered with more than {MAX_BODY_BYTES} bytes");
            }
            body.extend_from_slice(&buffer[..read]);
        }
    }
    let status = child.wait().context("could not wait for curl")?;
    if !status.success() {
        let mut message = String::new();
        if let Some(mut stderr) = child.stderr.take() {
            let _ = stderr.read_to_string(&mut message);
        }
        let mut message = message.trim().to_string();
        if let Some(key) = key {
            message = message.replace(key, "<redacted>");
        }
        bail!("curl failed for {url} ({status}): {message}");
    }
    String::from_utf8(body).with_context(|| format!("{url} did not answer with UTF-8"))
}

fn discover(base: &Base, key: Option<&str>) -> Result<Vec<Model>> {
    if let Some(key) = key {
        if !auth_value_ok(key) {
            bail!("the API key contains whitespace or a control character");
        }
    }
    let body = if base.https {
        curl_get(&format!("{}/models", base.url), key)?
    } else {
        http_get(base, &format!("{}/models", base.path), key)?
    };
    parse_listing(&body)
}

/// A rendered profile patch, for tests of the credential detection in `auth`.
#[cfg(test)]
pub(crate) fn sample_patch_for_tests(id: &str, default_model: &str) -> String {
    let r = Route {
        id: id.to_string(),
        display_name: "Sample".to_string(),
        base_url: "http://127.0.0.1:1/v1".to_string(),
        api_key_env: route_key_env(id),
        compat: Vec::new(),
        models: vec![Model {
            id: default_model.to_string(),
            ..Model::default()
        }],
    };
    let mut text = apply_route("", &r, false).unwrap().text;
    text.push_str(&format!(
        "- id: agent-default-model\n  config:\n    provider: {id}\n    model: {default_model}\n"
    ));
    text
}

// --- command -------------------------------------------------------------------

pub(crate) struct AddArgs {
    pub preset: String,
    pub profile: Option<String>,
    pub models: Vec<String>,
    pub from_opencode: bool,
    pub discover: bool,
    pub base_url: Option<String>,
    pub id: Option<String>,
    pub name: Option<String>,
    pub key_stdin: bool,
    pub no_key: bool,
    pub replace: bool,
    pub dry_run: bool,
    pub json: bool,
}

fn valid_profile_name(name: &str) -> bool {
    !name.is_empty()
        && name != "."
        && name != ".."
        && !name.contains(['/', '\\'])
        && !name.chars().any(|c| c.is_control())
}

fn read_stdin_key() -> Result<String> {
    let mut line = String::new();
    std::io::stdin()
        .lock()
        .take(1024)
        .read_line(&mut line)
        .context("could not read the API key from stdin")?;
    let key = line.trim().to_string();
    if key.is_empty() {
        bail!("--key-stdin: no key on stdin");
    }
    if !auth_value_ok(&key) || key.len() > 512 {
        bail!("--key-stdin: the key is empty, oversized or contains whitespace");
    }
    Ok(key)
}

/// Write `text` next to `path` and rename it over, keeping the permissions.
fn write_atomic(path: &Path, text: &str) -> Result<()> {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let tmp = path.with_file_name(format!("{name}.tmp.{}", crate::local_http::random_token()?));
    let perms = std::fs::metadata(path).ok().map(|m| m.permissions());
    let result = (|| -> Result<()> {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)?;
        file.write_all(text.as_bytes())?;
        file.sync_all()?;
        drop(file);
        if std::fs::read(&tmp)? != text.as_bytes() {
            bail!("the temporary file does not hold what was written");
        }
        if let Some(perms) = perms {
            std::fs::set_permissions(&tmp, perms)?;
        }
        std::fs::rename(&tmp, path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

fn read_patch(path: &Path) -> Result<String> {
    match std::fs::read_to_string(path) {
        Ok(t) => Ok(t),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(e).with_context(|| format!("cannot read {}", path.display())),
    }
}

/// `rdsh provider add <preset>`.
pub(crate) fn cmd_add(args: AddArgs, configured_default_profile: &str) -> Result<()> {
    let preset = preset(&args.preset).ok_or_else(|| {
        anyhow::anyhow!(
            "unknown provider preset {:?}; available: {}",
            args.preset,
            PRESETS.iter().map(|p| p.id).collect::<Vec<_>>().join(", ")
        )
    })?;
    // Presets with a fixed endpoint are a fixed route: only local-openai is
    // free-form.
    if preset.base_url.is_some() && (args.id.is_some() || args.name.is_some() || args.no_key) {
        bail!(
            "--id, --name and --no-key are for local-openai; {} has a fixed route and needs a key",
            preset.id
        );
    }
    if args.discover && !preset.supports_discovery {
        bail!(
            "{}",
            t(
                &format!(
                    "{} には GET /models がない（404）ため --discover は使えません。--model <id> を指定するか、省略して既定のモデルを使ってください",
                    preset.id
                ),
                &format!(
                    "--discover is not supported for {}: its API has no GET /models (it answers 404). Pass --model <id>, or omit it to use the built-in models",
                    preset.id
                )
            )
        );
    }
    if args.key_stdin && args.no_key {
        bail!("--key-stdin and --no-key cannot be combined");
    }
    let id = args.id.clone().unwrap_or_else(|| preset.id.to_string());
    if !auth::is_record_id(&id) {
        bail!("route id {id:?} must be lowercase letters, digits and '-', starting with a letter");
    }
    let key_env = route_key_env(&id);
    if let Some(name) = &args.name {
        if name.trim().is_empty() || name.chars().any(|c| c.is_control()) {
            bail!("--name is empty or contains a control character");
        }
    }
    let explicit_base = args.base_url.as_deref().map(parse_base_url).transpose()?;
    let mut explicit_models = Vec::new();
    for m in &args.models {
        if !valid_model_id(m) {
            bail!("invalid --model id {m:?}");
        }
        explicit_models.push(Model {
            id: m.clone(),
            ..Model::default()
        });
    }

    // Everything above is checked before the profile or the network is touched.
    let profile = crate::profile_or_default(args.profile.clone(), configured_default_profile)?;
    if !valid_profile_name(&profile) {
        bail!("invalid profile name {profile:?}");
    }
    let profile_dir = PathBuf::from(dsh_home()).join("profiles").join(&profile);
    if !profile_dir.is_dir() {
        bail!(
            "no profile {profile} under {} (see `rdsh profiles`)",
            profile_dir.parent().unwrap_or(&profile_dir).display()
        );
    }
    let patch_path = profile_dir.join("cordis.patch.yml");

    let opencode = if args.from_opencode {
        Some(read_opencode(&id)?)
    } else {
        None
    };
    let base = match (
        &explicit_base,
        opencode.as_ref().and_then(|o| o.base_url.as_deref()),
        preset.base_url,
    ) {
        (Some(b), _, _) => b.clone(),
        (None, Some(url), _) => parse_base_url(url).context("opencode baseURL")?,
        (None, None, Some(url)) => parse_base_url(url)?,
        (None, None, None) => {
            bail!("local-openai needs --base-url (for example http://host:8080/v1)")
        }
    };

    // Key input. The value only ever lives in these locals.
    let stdin_key = if args.key_stdin {
        Some(read_stdin_key()?)
    } else {
        None
    };
    let env_key = std::env::var(&key_env)
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty());
    let refs = auth::stored_refs();
    let has_ref = refs.contains_key(&key_env);

    let route_for = |models: Vec<Model>| Route {
        id: id.clone(),
        display_name: args
            .name
            .clone()
            .unwrap_or_else(|| preset.display_name.to_string()),
        base_url: base.url.clone(),
        api_key_env: key_env.clone(),
        compat: preset.compat.iter().map(|l| l.to_string()).collect(),
        models,
    };

    // A block that already exists is a no-op: skip discovery (a network call).
    let current = read_patch(&patch_path)?;
    let already = locate_providers(&split_lines(&current))
        .ok()
        .flatten()
        .is_some_and(|p| {
            let lines = split_lines(&current);
            find_at(&lines, p.line + 1, p.end, p.child_indent, &id).is_some()
        });

    let skip_existing = already && !args.replace;
    let mut notes: Vec<String> = Vec::new();
    let mut groups = vec![explicit_models];
    if let Some(o) = &opencode {
        groups.push(o.models.clone());
    }
    if args.discover && !skip_existing {
        let key = stdin_key
            .clone()
            .or_else(|| env_key.clone())
            .or_else(|| refs.get(&key_env).cloned())
            .filter(|k| k != PLACEHOLDER_KEY);
        let mut found = discover(&base, key.as_deref())?;
        if found.len() > MAX_MODELS {
            notes.push(format!("model listing truncated to {MAX_MODELS} entries"));
            found.truncate(MAX_MODELS);
        }
        groups.push(found);
    }
    let mut models = merge_models(groups);
    if models.is_empty() {
        models = preset
            .default_models
            .iter()
            .map(|d| Model {
                id: d.id.to_string(),
                ..Model::default()
            })
            .collect();
    }
    notes.extend(apply_preset_models(preset, &mut models));
    if models.is_empty() && !skip_existing {
        bail!("no models: pass --model <id>, or use --from-opencode / --discover");
    }
    let route = route_for(models);

    // Route first, under the profile lock; the document is read inside it.
    let (change, written) = if args.dry_run {
        let applied = apply_route(&current, &route, args.replace)?;
        (applied.change, false)
    } else {
        let _lock = CredentialFileLock::exclusive_for(&patch_path)?;
        let text = read_patch(&patch_path)?;
        let applied = apply_route(&text, &route, args.replace)?;
        if applied.change.writes() {
            write_atomic(&patch_path, &applied.text)?;
            (applied.change, true)
        } else {
            (applied.change, false)
        }
    };

    // Then the key.
    let key_state = if let Some(key) = &stdin_key {
        if args.dry_run {
            "would-store"
        } else if auth::store_ref(&key_env, key)? {
            "stored"
        } else {
            "present"
        }
    } else if let Some(key) = env_key.as_ref().filter(|_| !has_ref) {
        if args.dry_run {
            "would-store"
        } else if auth::store_ref(&key_env, key)? {
            "stored"
        } else {
            "present"
        }
    } else if has_ref || env_key.is_some() {
        "present"
    } else if args.no_key {
        if args.dry_run {
            "would-store-placeholder"
        } else {
            auth::store_ref(&key_env, PLACEHOLDER_KEY)?;
            "placeholder"
        }
    } else {
        "missing"
    };

    let model_ids: Vec<&str> = route.models.iter().map(|m| m.id.as_str()).collect();
    if args.json {
        println!(
            "{}",
            json!({
                "schema": 1,
                "profile": profile,
                "route": route.id,
                "file": patch_path.display().to_string(),
                "change": change.as_str(),
                "written": written,
                "dry_run": args.dry_run,
                "baseURL": route.base_url,
                "api": API,
                "apiKeyEnv": route.api_key_env,
                "key": key_state,
                "models": model_ids,
                "notes": notes,
            })
        );
        return Ok(());
    }
    let file = patch_path.display();
    let verb = match change {
        Change::Added => t("追加しました", "added"),
        Change::Replaced => t("置き換えました", "replaced"),
        Change::Exists => t(
            "既に設定済みです（変更なし。置き換えるには --replace）",
            "already configured, nothing changed (use --replace to rewrite it)",
        ),
        Change::Identical => t(
            "既に同じ内容です（変更なし）",
            "already identical, nothing changed",
        ),
    };
    let dry = if args.dry_run {
        t("[dry-run・書き込みなし] ", "[dry-run, nothing written] ")
    } else {
        String::new()
    };
    println!("[rdsh provider] {dry}{} {}: {verb}", profile, route.id);
    println!("[rdsh provider] file: {file}");
    println!(
        "[rdsh provider] {} ({API}), models: {}",
        route.base_url,
        model_ids.join(", ")
    );
    if args.dry_run && change.writes() {
        println!("{}", manual_snippet(&route));
    }
    for note in &notes {
        println!("[rdsh provider] note: {note}");
    }
    match key_state {
        "stored" => println!(
            "[rdsh provider] {}",
            t(
                &format!("鍵を {key_env} として保存しました"),
                &format!("key saved as {key_env}")
            )
        ),
        "would-store" => println!(
            "[rdsh provider] {}",
            t(&format!("{key_env} を保存します"), &format!("would save {key_env}"))
        ),
        "placeholder" | "would-store-placeholder" => println!(
            "[rdsh provider] {}",
            t(
                &format!("鍵なしのため {key_env} にダミー値を保存します"),
                &format!("no key: stores a placeholder for {key_env}")
            )
        ),
        "present" => println!(
            "[rdsh provider] {}",
            t(&format!("{key_env}: 設定済み"), &format!("{key_env}: present"))
        ),
        _ => println!(
            "[rdsh provider] {}",
            t(
                &format!("{key_env} が未設定です。{key_env}=... を付けて再実行するか、--key-stdin で渡してください"),
                &format!("{key_env} is missing: re-run with {key_env}=... set, or pipe it with --key-stdin")
            )
        ),
    }
    Ok(())
}

/// `rdsh provider list [--json]`.
pub(crate) fn cmd_list(json: bool) -> Result<()> {
    let root = PathBuf::from(dsh_home()).join("profiles");
    let mut names: Vec<String> = std::fs::read_dir(&root)
        .map(|rd| {
            rd.flatten()
                .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .collect()
        })
        .unwrap_or_default();
    names.sort();
    let refs = auth::stored_refs();
    let key_state = |env: &str| -> &'static str {
        if refs.contains_key(env) || auth::env_key_present(env) {
            "present"
        } else {
            "missing"
        }
    };
    let mut profiles = Vec::new();
    for name in &names {
        let text =
            std::fs::read_to_string(root.join(name).join("cordis.patch.yml")).unwrap_or_default();
        let found = routes_in(&text);
        let mut routes = Vec::new();
        for p in PRESETS {
            let hit = found.iter().find(|r| r.id == p.id);
            let env = hit
                .and_then(|r| r.api_key_env.clone())
                .unwrap_or_else(|| route_key_env(p.id));
            routes.push(json!({
                "id": p.id,
                "preset": true,
                "configured": hit.is_some(),
                "baseURL": hit.and_then(|r| r.base_url.clone()),
                "apiKeyEnv": env,
                "key": key_state(&env),
                "models": hit.map_or(0, |r| r.models),
            }));
        }
        for r in found
            .iter()
            .filter(|r| r.base_url.is_some() && preset(&r.id).is_none())
        {
            let env = r
                .api_key_env
                .clone()
                .unwrap_or_else(|| route_key_env(&r.id));
            routes.push(json!({
                "id": r.id,
                "preset": false,
                "configured": true,
                "baseURL": r.base_url,
                "apiKeyEnv": env,
                "key": key_state(&env),
                "models": r.models,
            }));
        }
        profiles.push(json!({"profile": name, "routes": routes}));
    }
    let presets: Vec<Value> = PRESETS
        .iter()
        .map(|p| {
            json!({
                "id": p.id,
                "displayName": p.display_name,
                "api": API,
                "baseURL": p.base_url,
                "apiKeyEnv": route_key_env(p.id),
            })
        })
        .collect();
    if json {
        println!(
            "{}",
            json!({"schema": 1, "presets": presets, "profiles": profiles})
        );
        return Ok(());
    }
    println!("[rdsh provider] presets:");
    for p in PRESETS {
        println!(
            "  {:<13} {} ({}, key {})",
            p.id,
            p.base_url.unwrap_or("--base-url required"),
            API,
            route_key_env(p.id)
        );
    }
    if profiles.is_empty() {
        println!("[rdsh provider] no profiles under {}", root.display());
    }
    for p in &profiles {
        println!(
            "[rdsh provider] profile {}:",
            p["profile"].as_str().unwrap_or("")
        );
        for r in p["routes"].as_array().into_iter().flatten() {
            let configured = r["configured"].as_bool().unwrap_or(false);
            if configured {
                println!(
                    "  {:<13} configured, {} models, {} {}",
                    r["id"].as_str().unwrap_or(""),
                    r["models"],
                    r["apiKeyEnv"].as_str().unwrap_or(""),
                    r["key"].as_str().unwrap_or("")
                );
            } else {
                println!("  {:<13} not configured", r["id"].as_str().unwrap_or(""));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn route(id: &str, models: &[&str]) -> Route {
        Route {
            id: id.to_string(),
            display_name: "HAI".to_string(),
            base_url: "https://hai-api.hcloud.ltd/v1".to_string(),
            api_key_env: route_key_env(id),
            compat: Vec::new(),
            models: models
                .iter()
                .map(|m| Model {
                    id: m.to_string(),
                    ..Model::default()
                })
                .collect(),
        }
    }

    const WITH_OTHER: &str = "# top comment\n- id: llm-pi-ai\n  config:\n    # keep me\n    providers:\n      other:\n        apiKeyEnv: OTHER_API_KEY\n        models:\n          - id: x\n      # between\n- id: agent-default-model\n  config:\n    provider: other\n    model: x\n";

    #[test]
    fn key_names_follow_the_route_id() {
        assert_eq!(route_key_env("hai"), "HAI_API_KEY");
        assert_eq!(route_key_env("local-openai"), "LOCAL_OPENAI_API_KEY");
        assert_eq!(route_key_env("home-gpu"), "HOME_GPU_API_KEY");
    }

    #[test]
    fn jsonc_comments_urls_and_trailing_commas() {
        let src = "{\n  // line\n  \"a\": \"https://x.test/v1\", // after value\n  /* block\n  // inner */ \"b\": [1, 2,],\n  \"c\": \"/* not a comment */\",\n  \"d\": {\"e\": \"q\\\"//z\",},\n}\n";
        let v: Value = serde_json::from_str(&strip_jsonc(src)).unwrap();
        assert_eq!(v["a"], "https://x.test/v1");
        assert_eq!(v["b"], json!([1, 2]));
        assert_eq!(v["c"], "/* not a comment */");
        assert_eq!(v["d"]["e"], "q\"//z");
        // A comma inside a string before a bracket is content.
        let v: Value = serde_json::from_str(&strip_jsonc("{\"a\": \",}\",}")).unwrap();
        assert_eq!(v["a"], ",}");
    }

    #[test]
    fn opencode_models_are_mapped_and_the_api_key_is_ignored() {
        let src = r#"{
  "provider": {
    "hai": {
      "options": { "baseURL": "https://hai.test/v1", "apiKey": "sk-secret" }, // key
      "models": {
        "m1": { "name": "M One", "limit": { "context": 1000, "output": 200 },
                "modalities": { "input": ["text", "image", "audio"], "output": ["text"] } },
        "m2": {},
      }
    }
  }
}"#;
        let doc: Value = serde_json::from_str(&strip_jsonc(src)).unwrap();
        let p = parse_opencode_provider(&doc, "hai").unwrap();
        assert_eq!(p.base_url.as_deref(), Some("https://hai.test/v1"));
        assert_eq!(p.models.len(), 2);
        let m1 = &p.models[0];
        assert_eq!(m1.name.as_deref(), Some("M One"));
        assert_eq!(m1.context_window, Some(1000));
        assert_eq!(m1.max_tokens, Some(200));
        assert_eq!(m1.input, vec!["text", "image"]);
        assert!(parse_opencode_provider(&doc, "nope").is_err());
        let rendered = render_route(&route("hai", &["m1"]), 0, 2).join("\n");
        assert!(!rendered.contains("sk-secret"));
    }

    #[test]
    fn listings_in_openai_and_ollama_shapes() {
        let a = parse_listing(r#"{"data":[{"id":"m1"},{"id":"m2"},{"id":""}]}"#).unwrap();
        assert_eq!(
            a.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
            ["m1", "m2"]
        );
        let b = parse_listing(r#"{"models":[{"name":"llama3:latest"},{"model":"qwen"}]}"#).unwrap();
        assert_eq!(b.len(), 2);
        assert!(parse_listing("{}").is_err());
        assert!(parse_listing("nope").is_err());
    }

    #[test]
    fn chunked_bodies_decode() {
        let raw = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n6;x=1\r\n world\r\n0\r\n\r\n";
        assert_eq!(parse_http_response(raw, "u").unwrap(), "hello world");
        let raw = b"HTTP/1.1 404 Not Found\r\n\r\n";
        assert!(parse_http_response(raw, "u").is_err());
    }

    #[test]
    fn chunked_bodies_reject_size_overflow() {
        for size in [usize::MAX, usize::MAX - 1, usize::MAX - 2] {
            let body = format!("{size:X}\r\nxx");
            assert_eq!(decode_chunked(body.as_bytes()), None);
            let raw = format!("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n{body}");
            assert!(parse_http_response(raw.as_bytes(), "u").is_err());
        }
    }

    #[test]
    fn chunked_bodies_reject_truncated_frames() {
        for body in [
            "",
            "1",
            "1\r",
            "1\r\n",
            "1\r\nx",
            "1\r\nx\r",
            "1\r\nx\r\n",
            "1\r\nx\r\n0",
            "1\r\nx\r\n0\r",
        ] {
            assert_eq!(decode_chunked(body.as_bytes()), None, "{body:?}");
        }
    }

    #[test]
    fn chunked_bodies_keep_extensions_and_zero_termination() {
        assert_eq!(decode_chunked(b"0\r\n\r\n"), Some(Vec::new()));
        assert_eq!(
            decode_chunked(b"1;name=value\r\nx\r\n0;end=value\r\n\r\n"),
            Some(b"x".to_vec())
        );
        assert_eq!(
            decode_chunked(b"1\r\nx\r\n0\r\nTrailer: value\r\n\r\n"),
            Some(b"x".to_vec())
        );
    }

    #[test]
    fn base_urls_are_validated() {
        let b = parse_base_url("http://127.0.0.1:18080/v1/").unwrap();
        assert_eq!((b.https, b.port, b.path.as_str()), (false, 18080, "/v1"));
        assert_eq!(b.url, "http://127.0.0.1:18080/v1");
        assert!(parse_base_url("https://[::1]:8443/v1").unwrap().https);
        assert_eq!(parse_base_url("https://hai.test").unwrap().port, 443);
        for bad in [
            "",
            "hai.test/v1",
            "ftp://x/v1",
            "http://user:pw@host/v1",
            "http://host/v1 x",
            "http://host/v1\n",
            "http://host/v1?x=1",
            "http://host/v1#f",
            "http://ho st/",
            "http://:80/v1",
            "http://host:0/v1",
            "http://host:99999/v1",
            "http://host/v1\\x",
            "http://[zz]/v1",
        ] {
            assert!(parse_base_url(bad).is_err(), "{bad:?} should be refused");
        }
    }

    #[test]
    fn scalars_are_quoted_when_ambiguous() {
        assert_eq!(yaml_scalar("deepseek-v4-flash"), "deepseek-v4-flash");
        assert_eq!(
            yaml_scalar("https://hai-api.hcloud.ltd/v1"),
            "https://hai-api.hcloud.ltd/v1"
        );
        assert_eq!(
            yaml_scalar("DeepSeek V4 Flash (HAI)"),
            "DeepSeek V4 Flash (HAI)"
        );
        assert_eq!(yaml_scalar("123"), "'123'");
        assert_eq!(yaml_scalar("no"), "'no'");
        assert_eq!(yaml_scalar("a: b"), "'a: b'");
        assert_eq!(yaml_scalar("it's #1"), "'it''s #1'");
        assert_eq!(yaml_scalar("4o-mini"), "'4o-mini'");
    }

    #[test]
    fn adding_keeps_every_other_byte() {
        let r = route("hai", &["deepseek-v4-flash"]);
        let out = apply_route(WITH_OTHER, &r, false).unwrap();
        assert_eq!(out.change, Change::Added);
        let block = render_route(&r, 6, 2).join("\n");
        let want = WITH_OTHER.replacen(
            "          - id: x\n",
            &format!("          - id: x\n{block}\n"),
            1,
        );
        assert_eq!(out.text, want);
        assert!(out
            .text
            .contains("      # between\n- id: agent-default-model"));
        let found = routes_in(&out.text);
        assert_eq!(found.len(), 2);
        assert_eq!(found[1].id, "hai");
        assert_eq!(found[1].api_key_env.as_deref(), Some("HAI_API_KEY"));
        assert_eq!(found[1].models, 1);
    }

    #[test]
    fn adding_twice_is_a_no_op_and_replace_rewrites_only_the_block() {
        let r = route("hai", &["m1"]);
        let once = apply_route(WITH_OTHER, &r, false).unwrap().text;
        let again = apply_route(&once, &r, false).unwrap();
        assert_eq!(again.change, Change::Exists);
        assert_eq!(again.text, once);
        let same = apply_route(&once, &r, true).unwrap();
        assert_eq!(same.change, Change::Identical);
        let r2 = route("hai", &["m1", "m2"]);
        let replaced = apply_route(&once, &r2, true).unwrap();
        assert_eq!(replaced.change, Change::Replaced);
        assert_eq!(routes_in(&replaced.text)[1].models, 2);
        assert_eq!(replaced.text.matches("hai:").count(), 1);
        assert!(replaced.text.starts_with("# top comment\n"));
        assert!(replaced.text.ends_with("    model: x\n"));
        assert!(replaced.text.contains("      # between\n"));
    }

    #[test]
    fn a_second_route_does_not_disturb_the_first() {
        let a = apply_route(WITH_OTHER, &route("hai", &["m1"]), false)
            .unwrap()
            .text;
        let b = apply_route(&a, &route("home-gpu", &["m9"]), false)
            .unwrap()
            .text;
        let ids: Vec<String> = routes_in(&b).into_iter().map(|r| r.id).collect();
        assert_eq!(ids, ["other", "hai", "home-gpu"]);
        assert!(b.contains("HOME_GPU_API_KEY"));
        assert!(b.starts_with(&a[..a.find("      # between").unwrap()]));
    }

    #[test]
    fn a_missing_entry_is_created() {
        let r = route("hai", &["m1"]);
        let fresh = apply_route("", &r, false).unwrap().text;
        assert!(fresh.starts_with("- id: llm-pi-ai\n  config:\n    providers:\n      hai:\n"));
        assert!(fresh.ends_with('\n'));
        let existing = "- id: agent-default-model\n  config:\n    provider: hai\n    model: m1\n";
        let out = apply_route(existing, &r, false).unwrap().text;
        assert!(out.starts_with(existing));
        assert_eq!(routes_in(&out).len(), 1);
        let comments_only = apply_route("# nothing yet\n", &r, false).unwrap().text;
        assert!(comments_only.starts_with("# nothing yet\n- id: llm-pi-ai"));
        // No final newline: one is added only after the appended entry.
        let no_nl = apply_route("- id: a\n  x: 1", &r, false).unwrap().text;
        assert!(no_nl.starts_with("- id: a\n  x: 1\n- id: llm-pi-ai"));
        assert!(no_nl.ends_with('\n'));
    }

    #[test]
    fn missing_levels_are_filled_in() {
        let r = route("hai", &["m1"]);
        let no_config = "- id: llm-pi-ai\n- id: next\n";
        let out = apply_route(no_config, &r, false).unwrap().text;
        assert!(out.starts_with("- id: llm-pi-ai\n  config:\n    providers:\n      hai:\n"));
        assert!(out.ends_with("- id: next\n"));
        let no_providers = "- id: llm-pi-ai\n  config:\n    other: 1\n- id: next\n";
        let out = apply_route(no_providers, &r, false).unwrap().text;
        assert!(out.contains("    other: 1\n    providers:\n      hai:\n"));
        assert_eq!(routes_in(&out)[0].id, "hai");
        let named = "- name: \"@deepseek-ai/dsh-llm-pi-ai\"\n  config:\n    providers:\n      a:\n        baseURL: http://x\n";
        let out = apply_route(named, &r, false).unwrap().text;
        assert_eq!(routes_in(&out).len(), 2);
    }

    #[test]
    fn crlf_files_keep_their_line_endings() {
        let text = WITH_OTHER.replace('\n', "\r\n");
        let out = apply_route(&text, &route("hai", &["m1"]), false)
            .unwrap()
            .text;
        assert!(!out.replace("\r\n", "").contains('\n'));
        assert_eq!(routes_in(&out).len(), 2);
    }

    #[test]
    fn unsafe_layouts_are_refused_with_the_manual_yaml() {
        let r = route("hai", &["m1"]);
        for text in [
            "- id: llm-pi-ai\n  config:\n    providers: {}\n",
            "- id: llm-pi-ai\n  config: {}\n",
            "providers:\n  a: 1\n",
            "[]\n",
            "  - id: indented\n",
            "---\n- id: a\n",
        ] {
            let err = apply_route(text, &r, false).unwrap_err().to_string();
            assert!(err.contains("by hand"), "{text:?}: {err}");
            assert!(err.contains("- id: llm-pi-ai"), "{err}");
            assert!(
                err.contains("baseURL: https://hai-api.hcloud.ltd/v1"),
                "{err}"
            );
        }
    }

    fn detailed_route() -> Route {
        let mut r = route("hai", &["m1", "m2"]);
        r.models[0].name = Some("M One".to_string());
        r.models[0].context_window = Some(128000);
        r.models[0].max_tokens = Some(8000);
        r.models[0].input = vec!["text".to_string()];
        r.models[1].name = Some("M Two".to_string());
        r
    }

    /// An existing profile whose nesting is `w` columns per level.
    fn with_width(w: usize) -> String {
        let pad = |n: usize| " ".repeat(n);
        format!(
            "- id: llm-pi-ai\n  config:\n{}providers:\n{}other:\n{}apiKeyEnv: OTHER_API_KEY\n{}models:\n{}- id: x\n{}name: X\n- id: next\n",
            pad(2 + w),
            pad(2 + 2 * w),
            pad(2 + 3 * w),
            pad(2 + 3 * w),
            pad(2 + 4 * w),
            pad(2 + 4 * w + 2),
        )
    }

    #[test]
    fn model_keys_align_with_id_for_every_indent_width() {
        for w in [1, 2, 3, 4] {
            let text = with_width(w);
            let out = apply_route(&text, &detailed_route(), false).unwrap().text;
            let lines: Vec<&str> = out.lines().collect();
            let mut checked = 0;
            for (i, line) in lines.iter().enumerate() {
                let t = line.trim_start();
                if !t.starts_with("- id: m") {
                    continue;
                }
                let dash = line.len() - t.len();
                for next in &lines[i + 1..] {
                    let nt = next.trim_start();
                    if nt.starts_with("- ") || !next.starts_with(' ') {
                        break;
                    }
                    assert_eq!(next.len() - nt.len(), dash + 2, "width {w}: {next:?}");
                    checked += 1;
                }
            }
            assert_eq!(checked, 5, "width {w}\n{out}");
            // Previous route and the new one are both found; the file is unchanged before.
            let ids: Vec<String> = routes_in(&out).into_iter().map(|r| r.id).collect();
            assert_eq!(ids, ["other", "hai"], "width {w}");
            assert!(out.ends_with("- id: next\n"));
            // Compat is beside models, in the same step.
            let mut sarashina = detailed_route();
            sarashina.compat = vec!["supportsStore: false".to_string()];
            let out = apply_route(&text, &sarashina, false).unwrap().text;
            let compat = out.lines().find(|l| l.trim() == "compat:").unwrap();
            let models = out.lines().rev().find(|l| l.trim() == "models:").unwrap();
            assert_eq!(
                compat.len() - compat.trim_start().len(),
                models.len() - models.trim_start().len()
            );
        }
    }

    #[test]
    fn llm_pi_ai_id_spellings_are_one_entry() {
        for head in [
            "- id: llm-pi-ai # custom routes",
            "- id: \"llm-pi-ai\"",
            "- id: 'llm-pi-ai'",
            "- id:   llm-pi-ai",
            "- id: llm-pi-ai   # c",
        ] {
            let text = format!("{head}\n  config:\n    providers:\n      other:\n        apiKeyEnv: O\n        models:\n          - id: x\n");
            let out = apply_route(&text, &route("hai", &["m1"]), false)
                .unwrap()
                .text;
            assert!(out.starts_with(head), "{head}");
            assert_eq!(out.matches("llm-pi-ai").count(), 1, "{head}\n{out}");
            let ids: Vec<String> = routes_in(&out).into_iter().map(|r| r.id).collect();
            assert_eq!(ids, ["other", "hai"], "{head}");
        }
        // The entry may also be named by the plugin and keep id elsewhere.
        let named = "- config:\n    providers: {}\n  name: '@deepseek-ai/dsh-llm-pi-ai' # x\n";
        assert!(apply_route(named, &route("hai", &["m1"]), false).is_err());
    }

    #[test]
    fn ids_that_cannot_be_read_safely_are_refused_not_duplicated() {
        let r = route("hai", &["m1"]);
        for text in [
            "- id: |\n    llm-pi-ai\n  config:\n    providers:\n      a:\n        baseURL: http://x\n",
            "- {id: llm-pi-ai, config: {providers: {}}}\n",
            "- id: [llm-pi-ai]\n",
            "-\n  id: llm-pi-ai\n",
            "- id: \"llm\\x2dpi-ai\"\n  config:\n    providers:\n      a:\n        baseURL: http://x\n",
            "- id: llm-pi-ai\n  config:\n    providers:\n      a:\n        baseURL: http://x\n- id: llm-pi-ai\n  config:\n    providers:\n      b:\n        baseURL: http://y\n",
            "- id: [broken\n- id: llm-pi-ai\n",
        ] {
            let err = apply_route(text, &r, false).unwrap_err().to_string();
            assert!(err.contains("by hand"), "{text:?}: {err}");
        }
    }

    #[test]
    fn other_providers_survive_every_add() {
        let text = "- id: llm-pi-ai # keep\n  config:\n    providers:\n      a:\n        baseURL: http://a\n        models:\n          - id: a1\n      b:\n        baseURL: http://b\n- id: z\n";
        let once = apply_route(text, &route("hai", &["m1"]), false)
            .unwrap()
            .text;
        let twice = apply_route(&once, &route("home", &["m2"]), false)
            .unwrap()
            .text;
        let ids: Vec<String> = routes_in(&twice).into_iter().map(|r| r.id).collect();
        assert_eq!(ids, ["a", "b", "hai", "home"]);
        assert_eq!(twice.matches("llm-pi-ai").count(), 1);
    }

    #[test]
    fn a_nested_llm_pi_ai_is_refused_never_shadowed_by_an_appended_entry() {
        let nested = "- insert:\n    - id: llm-pi-ai\n      name: \"@deepseek-ai/dsh-llm-pi-ai\"\n      config:\n        providers:\n          other:\n            baseURL: http://o\n  config:\n    unrelated: 1\n";
        // A top-level entry that exists, plus a second definition nested elsewhere.
        let with_entry = "- id: llm-pi-ai\n  config:\n    providers:\n      a:\n        baseURL: http://a\n- insert:\n    - id: llm-pi-ai\n      config: {}\n";
        let deeper = "- id: llm-pi-ai\n  config:\n    providers:\n      a:\n        baseURL: http://a\n    note: llm-pi-ai\n";
        let other_entry = "- id: x\n  config:\n    use: llm-pi-ai\n";
        for text in [nested, with_entry, deeper, other_entry] {
            let err = apply_route(text, &route("hai", &["m1"]), false)
                .unwrap_err()
                .to_string();
            assert!(err.contains("by hand"), "{text:?}: {err}");
        }
        // Comments do not count as a mention.
        let commented = "# llm-pi-ai goes here\n- id: x\n";
        assert!(apply_route(commented, &route("hai", &["m1"]), false).is_ok());
    }

    #[test]
    fn blanks_before_the_colon_are_still_the_same_key() {
        for head in [
            "- id : llm-pi-ai",
            "- \"id\" : llm-pi-ai",
            "- 'id'  :  llm-pi-ai",
            "- id\t: llm-pi-ai",
        ] {
            let text = format!(
                "{head}\n  config :\n    providers :\n      other :\n        baseURL : http://o\n        models:\n          - id: o1\n"
            );
            let out = apply_route(&text, &route("hai", &["m1"]), false)
                .unwrap_or_else(|e| panic!("{head}: {e}"))
                .text;
            assert_eq!(out.matches("llm-pi-ai").count(), 1, "{head}\n{out}");
            let ids: Vec<String> = routes_in(&out).into_iter().map(|r| r.id).collect();
            assert_eq!(ids, ["other", "hai"], "{head}\n{out}");
        }
    }

    #[test]
    fn empty_levels_get_children_at_the_right_depth() {
        for (text, _w) in [
            ("- id: llm-pi-ai\n  config:\n", 2),
            (
                "- id: llm-pi-ai\n  config:\n    # nothing yet\n- id: next\n",
                2,
            ),
            ("- id: llm-pi-ai\n  config:\n    providers:\n", 2),
            (
                "- id: llm-pi-ai\n  config:\n    providers:\n      # none\n- id: next\n",
                2,
            ),
            ("-   id: llm-pi-ai\n    config:\n", 2),
            ("- id: llm-pi-ai\n  config:\n   other: 1\n", 1),
            ("- id: llm-pi-ai\n  config:\n    other: 1\n", 2),
            ("- id: llm-pi-ai\n  config:\n      other: 1\n", 4),
        ] {
            let out = apply_route(text, &detailed_route(), false)
                .unwrap_or_else(|e| panic!("{text:?}: {e}"))
                .text;
            let ids: Vec<String> = routes_in(&out).into_iter().map(|r| r.id).collect();
            assert_eq!(ids, ["hai"], "{text:?}\n{out}");
        }
    }

    #[test]
    fn read_back_rejects_a_lost_route_or_misaligned_keys() {
        let r = route("hai", &["m1"]);
        let before = routes_in(WITH_OTHER);
        let good = apply_route(WITH_OTHER, &r, false).unwrap().text;
        assert!(verify_written(&before, &good, &r).is_ok());
        // The existing route vanished.
        let lost = good.replace("      other:", "      other_:");
        assert!(verify_written(&before, &lost, &r)
            .unwrap_err()
            .contains("other"));
        // A model key drifts out of line with its `- id`.
        let drift = good.replace(
            "          - id: m1\n",
            "          - id: m1\n              name: M\n",
        );
        assert!(verify_written(&before, &drift, &r)
            .unwrap_err()
            .contains("aligned"));
        // A second llm-pi-ai entry.
        let dup = format!("{good}- id: llm-pi-ai\n  config: {{}}\n");
        assert!(verify_written(&before, &dup, &r).is_err());
    }

    #[test]
    fn a_quoted_existing_key_is_found() {
        let text = "- id: llm-pi-ai\n  config:\n    providers:\n      \"hai\":\n        baseURL: http://x\n";
        let out = apply_route(text, &route("hai", &["m1"]), false).unwrap();
        assert_eq!(out.change, Change::Exists);
    }

    #[test]
    fn models_merge_in_priority_order() {
        let a = vec![Model {
            id: "x".into(),
            ..Model::default()
        }];
        let b = vec![
            Model {
                id: "x".into(),
                name: Some("X".into()),
                context_window: Some(10),
                ..Model::default()
            },
            Model {
                id: "y".into(),
                ..Model::default()
            },
        ];
        let c = vec![Model {
            id: "z".into(),
            ..Model::default()
        }];
        let merged = merge_models(vec![a, b, c]);
        assert_eq!(
            merged.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
            ["x", "y", "z"]
        );
        assert_eq!(merged[0].name.as_deref(), Some("X"));
        assert_eq!(merged[0].context_window, Some(10));
    }

    fn sarashina_route(models: Vec<Model>) -> Route {
        let p = preset("sarashina").unwrap();
        Route {
            id: p.id.to_string(),
            display_name: p.display_name.to_string(),
            base_url: p.base_url.unwrap().to_string(),
            api_key_env: route_key_env(p.id),
            compat: p.compat.iter().map(|l| l.to_string()).collect(),
            models,
        }
    }

    fn model_ids(ids: &[&str]) -> Vec<Model> {
        ids.iter()
            .map(|id| Model {
                id: id.to_string(),
                ..Model::default()
            })
            .collect()
    }

    #[test]
    fn compat_sits_beside_models_and_is_replaced_with_the_block() {
        let p = preset("sarashina").unwrap();
        let mut models = model_ids(&["sarashina3-mini", "sarashina3-nano"]);
        assert!(apply_preset_models(p, &mut models).is_empty());
        let lines = render_route(&sarashina_route(models.clone()), 6, 2);
        let compat = lines.iter().position(|l| l.ends_with("compat:")).unwrap();
        let models_at = lines.iter().position(|l| l.ends_with("models:")).unwrap();
        assert_eq!(lines[compat], "        compat:");
        assert_eq!(lines[models_at], "        models:");
        assert_eq!(lines[compat + 1], "          supportsStore: false");
        assert_eq!(
            lines[compat + 2],
            "          supportsUsageInStreaming: false"
        );
        assert!(compat < models_at);
        let snippet = manual_snippet(&sarashina_route(models.clone()));
        assert!(snippet.contains("        compat:\n          supportsStore: false\n"));
        // hai renders no compat block at all.
        assert!(!render_route(&route("hai", &["m"]), 6, 2)
            .iter()
            .any(|l| l.contains("compat")));

        let once = apply_route(WITH_OTHER, &sarashina_route(models.clone()), false)
            .unwrap()
            .text;
        assert_eq!(routes_in(&once)[1].models, 2);
        // A stale hand-edited compat is dropped by --replace.
        let stale = once.replace(
            "supportsStore: false",
            "supportsStore: true\n          extra: 1",
        );
        let fixed = apply_route(&stale, &sarashina_route(models), true).unwrap();
        assert_eq!(fixed.change, Change::Replaced);
        assert_eq!(fixed.text, once);
    }

    #[test]
    fn preset_models_fill_known_ids_and_clamp_max_tokens() {
        let p = preset("sarashina").unwrap();
        let mut models = vec![
            Model {
                id: "sarashina3-mini".into(),
                max_tokens: Some(32768),
                ..Model::default()
            },
            Model {
                id: "other".into(),
                context_window: Some(10),
                ..Model::default()
            },
        ];
        let notes = apply_preset_models(p, &mut models);
        assert_eq!(models[0].max_tokens, Some(8000));
        assert_eq!(models[0].context_window, Some(128000));
        assert_eq!(models[0].name.as_deref(), Some("Sarashina3 mini"));
        assert_eq!(models[1].max_tokens, Some(8000));
        assert_eq!(models[1].context_window, Some(10));
        assert_eq!(models[1].name, None);
        assert_eq!(notes.len(), 1);
        assert!(notes[0].contains("other") && notes[0].contains("sarashina3-nano"));
        // A smaller explicit limit is kept.
        let mut small = vec![Model {
            id: "sarashina3-nano".into(),
            max_tokens: Some(1000),
            ..Model::default()
        }];
        apply_preset_models(p, &mut small);
        assert_eq!(small[0].max_tokens, Some(1000));
        // Presets without knowledge leave models alone.
        let mut hai = model_ids(&["m"]);
        assert!(apply_preset_models(preset("hai").unwrap(), &mut hai).is_empty());
        assert_eq!(hai, model_ids(&["m"]));
    }

    #[test]
    fn sarashina_preset_facts() {
        let p = preset("sarashina").unwrap();
        assert_eq!(p.base_url, Some("https://api.sarashina.ai/v1"));
        assert_eq!(route_key_env(p.id), "SARASHINA_API_KEY");
        assert!(!p.supports_discovery);
        assert_eq!(p.default_models.len(), 2);
        assert!(preset("hai").unwrap().supports_discovery);
    }

    #[test]
    fn discover_is_refused_for_sarashina_before_any_profile_access() {
        let err = cmd_add(
            AddArgs {
                preset: "sarashina".into(),
                profile: Some("does-not-exist".into()),
                models: Vec::new(),
                from_opencode: false,
                discover: true,
                base_url: None,
                id: None,
                name: None,
                key_stdin: false,
                no_key: false,
                replace: false,
                dry_run: true,
                json: false,
            },
            "tui",
        )
        .unwrap_err()
        .to_string();
        assert!(
            err.contains("GET /models") || err.contains("/models"),
            "{err}"
        );
        assert!(!err.contains("no profile"), "{err}");
    }

    #[test]
    fn curl_config_hides_the_key_from_argv_and_pins_https() {
        let cfg = curl_config("https://h.test/v1/models", Some("sk-abc"));
        assert!(cfg.contains("Authorization: Bearer sk-abc"));
        assert!(cfg.contains("proto = \"=https\"") && cfg.contains("proto-redir = \"=https\""));
        assert!(!curl_config("https://h.test/v1/models", None).contains("Authorization"));
    }
}
