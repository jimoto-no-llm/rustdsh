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
    /// `reasoningEfforts` levels this model publishes, as (label, value).
    reasoning_efforts: &'static [(&'static str, &'static str)],
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
    /// `false` for a server that authenticates nobody (a local runtime).
    needs_key: bool,
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
        needs_key: true,
    },
    Preset {
        id: "local-openai",
        display_name: "Local OpenAI-compatible",
        base_url: None,
        default_models: &[],
        compat: &[],
        max_tokens_cap: None,
        supports_discovery: true,
        needs_key: true,
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
                reasoning_efforts: &[],
            },
            PresetModel {
                id: "sarashina3-nano",
                name: "Sarashina3 nano",
                context_window: 128000,
                max_tokens: 8000,
                reasoning_efforts: &[],
            },
        ],
        compat: &["supportsStore: false", "supportsUsageInStreaming: false"],
        max_tokens_cap: Some(8000),
        supports_discovery: false,
        needs_key: true,
    },
    // Command Code's Provider API is OpenAI-compatible at a fixed base URL, and
    // dsh ships no catalog for it: every model is named here or fetched with
    // --discover. Chat ids use the documented vendor/model form (for example
    // deepseek/deepseek-v4-flash). Claude models are served only on the
    // Anthropic /messages path, which this preset does not write; see
    // docs/PROVIDERS.md for the hand-written route.
    Preset {
        id: "commandcode",
        display_name: "Command Code",
        base_url: Some("https://api.commandcode.ai/provider/v1"),
        default_models: &[],
        compat: &[],
        max_tokens_cap: None,
        supports_discovery: true,
        needs_key: true,
    },
    // Ollama serves an OpenAI-compatible API on a local port and authenticates
    // nobody, so the route stores the placeholder key. gpt-oss publishes three
    // named thinking levels; other models fall back to the route default and
    // can be overridden with --effort.
    Preset {
        id: "ollama",
        display_name: "Ollama",
        base_url: Some("http://127.0.0.1:11434/v1"),
        default_models: &[PresetModel {
            id: "gpt-oss:20b",
            name: "gpt-oss 20B",
            context_window: 131072,
            max_tokens: 32768,
            reasoning_efforts: &[("low", "low"), ("medium", "medium"), ("high", "high")],
        }],
        compat: &[],
        max_tokens_cap: None,
        supports_discovery: true,
        needs_key: false,
    },
    // Ollama Cloud serves the hosted catalog on ollama.com; unlike the local
    // runtime it needs a real key, kept apart from the local route so the two
    // do not share one placeholder.
    Preset {
        id: "ollama-cloud",
        display_name: "Ollama Cloud",
        base_url: Some("https://ollama.com/v1"),
        default_models: &[],
        compat: &[],
        max_tokens_cap: None,
        supports_discovery: true,
        needs_key: true,
    },
];

/// The endpoint a preset writes, for callers that only need the URL.
/// Whether the endpoint offers GET /models, for callers that pick a model source.
pub(crate) fn preset_supports_discovery(id: &str) -> Option<bool> {
    preset(id).map(|p| p.supports_discovery)
}
pub(crate) fn preset_base_url(id: &str) -> Option<&'static str> {
    preset(id).and_then(|p| p.base_url)
}
fn preset(id: &str) -> Option<&'static Preset> {
    PRESETS.iter().find(|p| p.id == id)
}

pub(crate) fn t(locale: crate::locale::Locale, ja: &str, en: &str, zh: &str) -> String {
    match locale {
        crate::locale::Locale::Japanese => ja,
        crate::locale::Locale::English => en,
        crate::locale::Locale::Chinese => zh,
    }
    .to_string()
}

// --- model and route -----------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Default)]
struct Model {
    id: String,
    name: Option<String>,
    context_window: Option<u64>,
    max_tokens: Option<u64>,
    input: Vec<String>,
    /// `reasoningEfforts:` entries; empty writes no block, which leaves the
    /// model as dsh resolves it (reasoning only when its catalog says so).
    reasoning_efforts: Vec<ReasoningEffort>,
}

/// One selectable reasoning level: the label dsh shows and the value it sends.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
struct ReasoningEffort {
    label: String,
    value: String,
}

impl ReasoningEffort {
    fn levels(pairs: &[(&str, &str)]) -> Vec<Self> {
        pairs
            .iter()
            .map(|(label, value)| Self {
                label: (*label).to_string(),
                value: (*value).to_string(),
            })
            .collect()
    }

    /// `low, medium` for the plain case, `low=minimal` to split label from value.
    fn parse_list(raw: &str) -> Option<Vec<Self>> {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            return None;
        }
        let mut out: Vec<Self> = Vec::new();
        for part in trimmed.split(',') {
            let part = part.trim();
            if part.is_empty() {
                return None;
            }
            let (label, value) = match part.split_once('=') {
                Some((label, value)) => (label.trim(), value.trim()),
                None => (part, part),
            };
            if label.is_empty()
                || value.is_empty()
                || label.len() > 40
                || value.len() > 60
                || label.chars().chain(value.chars()).any(|c| c.is_control())
                || out.iter().any(|e| e.label == label)
            {
                return None;
            }
            out.push(Self {
                label: label.to_string(),
                value: value.to_string(),
            });
        }
        Some(out)
    }
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
fn apply_preset_models(
    preset: &Preset,
    models: &mut [Model],
    locale: crate::locale::Locale,
) -> Vec<String> {
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
            None if !preset.default_models.is_empty() => notes.push(localized_format!(locale, "{}: {} is not one of the documented chat models ({}); contextWindow is left to dsh's default", "{}：{} 不在已记录的聊天模型中（{}）；contextWindow 使用 dsh 默认值", "{}: {} は記載されたチャットモデル（{}）に含まれません。contextWindowはdshの既定値を使用します",
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
        if model.reasoning_efforts.is_empty() {
            if let Some(known) = preset.default_models.iter().find(|d| d.id == model.id) {
                model.reasoning_efforts = ReasoningEffort::levels(known.reasoning_efforts);
            }
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
                if have.reasoning_efforts.is_empty() {
                    have.reasoning_efforts = model.reasoning_efforts;
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
        if !model.reasoning_efforts.is_empty() {
            out.push(format!("{item_key}reasoningEfforts:"));
            for effort in &model.reasoning_efforts {
                out.push(format!(
                    "{item_key}  {}: {}",
                    yaml_scalar(&effort.label),
                    yaml_scalar(&effort.value)
                ));
            }
        }
    }
    out
}

/// Model id to the level labels it publishes, for `--json` callers.
fn efforts_by_model(route: &Route) -> serde_json::Map<String, serde_json::Value> {
    route
        .models
        .iter()
        .map(|model| {
            let labels: Vec<&str> = model
                .reasoning_efforts
                .iter()
                .map(|e| e.label.as_str())
                .collect();
            (model.id.clone(), serde_json::json!(labels))
        })
        .collect()
}

/// One ``low, medium, high`` line, or per-model lines when they differ.
fn effort_summary(route: &Route) -> Option<String> {
    let levels = |model: &Model| {
        model
            .reasoning_efforts
            .iter()
            .map(|e| e.label.clone())
            .collect::<Vec<_>>()
            .join(", ")
    };
    // 段階を持たないモデルはここでは挙げない（別の注記が担当する）。
    let listed: Vec<(&str, String)> = route
        .models
        .iter()
        .map(|model| (model.id.as_str(), levels(model)))
        .filter(|(_, levels)| !levels.is_empty())
        .collect();
    let mut unique: Vec<String> = listed.iter().map(|(_, levels)| levels.clone()).collect();
    unique.sort();
    unique.dedup();
    match unique.as_slice() {
        [] => None,
        [only] => Some(only.clone()),
        _ => Some(
            listed
                .iter()
                .map(|(id, levels)| format!("{id}: {levels}"))
                .collect::<Vec<_>>()
                .join("; "),
        ),
    }
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

fn trim_yaml(value: &str) -> &str {
    value.trim_matches([' ', '\t', '\r'])
}

fn skippable(line: &str) -> bool {
    let t = trim_yaml(line);
    t.is_empty() || t.starts_with('#')
}

fn indent_of(line: &str) -> usize {
    line.len() - line.trim_start_matches(' ').len()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    Plain,
    Single,
    Double,
}

/// A run of one line: plain text, or the inside of a quoted scalar.
#[derive(Debug, Clone, Copy)]
struct Piece<'a> {
    kind: Kind,
    text: &'a str,
}

struct Scan<'a> {
    pieces: Vec<Piece<'a>>,
    /// Byte offset where a trailing comment starts (or the line length).
    end: usize,
    /// A quote opened on this line and never closed (a multi-line scalar).
    open: bool,
}

/// Offset of the closing `"` of a double-quoted scalar that starts `s`.
fn double_end(s: &str) -> Option<usize> {
    let b = s.as_bytes();
    let mut i = 1;
    while i < b.len() {
        match b[i] {
            b'\\' => i += 2,
            b'"' => return Some(i),
            _ => i += 1,
        }
    }
    None
}

/// Offset of the closing `'` of a single-quoted scalar that starts `s`.
fn single_end(s: &str) -> Option<usize> {
    let b = s.as_bytes();
    let mut i = 1;
    while i < b.len() {
        if b[i] == b'\'' {
            if b.get(i + 1) == Some(&b'\'') {
                i += 2;
                continue;
            }
            return Some(i);
        }
        i += 1;
    }
    None
}

/// Split one line into plain and quoted runs. A quote only opens a scalar at
/// the start of a token; `#` only starts a comment after a blank.
fn scan_line(line: &str) -> Scan<'_> {
    let b = line.as_bytes();
    let mut pieces = Vec::new();
    let (mut from, mut i) = (0, 0);
    fn plain<'a>(pieces: &mut Vec<Piece<'a>>, line: &'a str, a: usize, z: usize) {
        if a < z {
            pieces.push(Piece {
                kind: Kind::Plain,
                text: &line[a..z],
            });
        }
    }
    while i < b.len() {
        let token_start = i == 0 || matches!(b[i - 1], b' ' | b'\t' | b'[' | b'{' | b',');
        match b[i] {
            q @ (b'"' | b'\'') if token_start => {
                let rest = &line[i..];
                let close = if q == b'"' {
                    double_end(rest)
                } else {
                    single_end(rest)
                };
                let Some(close) = close else {
                    plain(&mut pieces, line, from, line.len());
                    return Scan {
                        pieces,
                        end: line.len(),
                        open: true,
                    };
                };
                plain(&mut pieces, line, from, i);
                pieces.push(Piece {
                    kind: if q == b'"' {
                        Kind::Double
                    } else {
                        Kind::Single
                    },
                    text: &line[i + 1..i + close],
                });
                i += close + 1;
                from = i;
            }
            b'#' if i == 0 || matches!(b[i - 1], b' ' | b'\t') => {
                plain(&mut pieces, line, from, i);
                return Scan {
                    pieces,
                    end: i,
                    open: false,
                };
            }
            _ => i += 1,
        }
    }
    plain(&mut pieces, line, from, line.len());
    Scan {
        pieces,
        end: line.len(),
        open: false,
    }
}

/// A scalar with any trailing YAML comment removed.
fn strip_comment(value: &str) -> &str {
    value[..scan_line(value).end].trim_end_matches([' ', '\t', '\r'])
}

/// Decode the inside of a single-line YAML 1.2 double-quoted scalar.
fn decode_double(
    inner: &str,
    locale: crate::locale::Locale,
) -> std::result::Result<String, String> {
    let mut out = String::new();
    let mut chars = inner.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        let Some(e) = chars.next() else {
            return Err(crate::locale::diagnostic(
                locale,
                "a double-quoted scalar continues on the next line",
            )
            .to_string());
        };
        let hex = |chars: &mut std::str::Chars<'_>, n: usize| -> Option<char> {
            let digits: String = chars.by_ref().take(n).collect();
            if digits.len() != n || !digits.chars().all(|d| d.is_ascii_hexdigit()) {
                return None;
            }
            char::from_u32(u32::from_str_radix(&digits, 16).ok()?)
        };
        let decoded = match e {
            '0' => Some('\0'),
            'a' => Some('\u{7}'),
            'b' => Some('\u{8}'),
            't' | '\t' => Some('\t'),
            'n' => Some('\n'),
            'v' => Some('\u{b}'),
            'f' => Some('\u{c}'),
            'r' => Some('\r'),
            'e' => Some('\u{1b}'),
            ' ' => Some(' '),
            '"' => Some('"'),
            '/' => Some('/'),
            '\\' => Some('\\'),
            'N' => Some('\u{85}'),
            '_' => Some('\u{a0}'),
            'L' => Some('\u{2028}'),
            'P' => Some('\u{2029}'),
            'x' => hex(&mut chars, 2),
            'u' => hex(&mut chars, 4),
            'U' => hex(&mut chars, 8),
            _ => None,
        };
        match decoded {
            Some(d) => out.push(d),
            None => {
                return Err(localized_format!(
                    locale,
                    "an invalid escape `\\{e}` in a double-quoted scalar",
                    "双引号标量中的转义 `\\{e}` 无效",
                    "二重引用符の値のエスケープ `\\{e}` が無効です"
                ))
            }
        }
    }
    Ok(out)
}

/// A whole scalar value (comment already removed) read as YAML. `Err` when it
/// is quoted but not exactly one readable quoted scalar.
fn try_unquote(value: &str, locale: crate::locale::Locale) -> std::result::Result<String, String> {
    let v = trim_yaml(value);
    if v.starts_with('"') {
        return match double_end(v) {
            Some(end) if end == v.len() - 1 => decode_double(&v[1..end], locale),
            _ => Err(crate::locale::diagnostic(
                locale,
                "a double-quoted scalar is not closed cleanly",
            )
            .to_string()),
        };
    }
    if v.starts_with('\'') {
        return match single_end(v) {
            Some(end) if end == v.len() - 1 => Ok(v[1..end].replace("''", "'")),
            _ => Err(crate::locale::diagnostic(
                locale,
                "a single-quoted scalar is not closed cleanly",
            )
            .to_string()),
        };
    }
    Ok(v.to_string())
}

/// `try_unquote`, falling back to the raw text (display only).
fn unquote(value: &str, locale: crate::locale::Locale) -> String {
    try_unquote(value, locale).unwrap_or_else(|_| trim_yaml(value).to_string())
}

/// For a line that opens with `key:` (plain or quoted, escapes decoded), the
/// value after the colon without a trailing comment; `Some("")` for a block or
/// empty value.
fn key_rest<'a>(line: &'a str, key: &str, locale: crate::locale::Locale) -> Option<&'a str> {
    let trimmed = line.trim_start_matches([' ', '\t']);
    let rest = if trimmed.starts_with('"') {
        let end = double_end(trimmed)?;
        (decode_double(&trimmed[1..end], locale).ok()? == key).then_some(&trimmed[end + 1..])?
    } else if trimmed.starts_with('\'') {
        let end = single_end(trimmed)?;
        (trimmed[1..end].replace("''", "'") == key).then_some(&trimmed[end + 1..])?
    } else {
        trimmed.strip_prefix(key)?
    };
    // YAML allows blanks between the key and its colon.
    let after = rest.trim_start_matches([' ', '\t']).strip_prefix(':')?;
    (after.is_empty() || after.starts_with([' ', '\t', '\r']))
        .then(|| strip_comment(trim_yaml(after)))
}

/// Split a mapping key from its value, without reading colons inside quotes.
fn mapping_parts(line: &str) -> Option<(&str, &str)> {
    let line = line.trim_start_matches([' ', '\t']);
    let bytes = line.as_bytes();
    let mut quote = None;
    let mut escaped = false;
    for (index, byte) in bytes.iter().enumerate() {
        if escaped {
            escaped = false;
            continue;
        }
        match quote {
            Some(b'"') if *byte == b'\\' => escaped = true,
            Some(b'\'') if *byte == b'\'' && bytes.get(index + 1) == Some(&b'\'') => {
                escaped = true;
            }
            Some(open) if *byte == open => quote = None,
            Some(_) => {}
            None if index == 0 && matches!(*byte, b'\'' | b'"') => quote = Some(*byte),
            None if *byte == b':'
                && bytes
                    .get(index + 1)
                    .is_none_or(|b| matches!(b, b' ' | b'\t' | b'\r')) =>
            {
                return Some((
                    trim_yaml(&line[..index]),
                    strip_comment(trim_yaml(&line[index + 1..])),
                ));
            }
            None => {}
        }
    }
    None
}

fn block_scalar_header(line: &str) -> Option<(&str, usize)> {
    let mut node = line.trim_start_matches(' ');
    let mut column = indent_of(line);
    let mut sequence_parent = None;
    while node.starts_with("- ") {
        sequence_parent = Some(column);
        let offset = dash_key_col(node);
        column += offset;
        node = &node[offset..];
    }
    let scalar = mapping_parts(node)
        .map(|(_, value)| (value, column))
        .or_else(|| sequence_parent.map(|parent| (strip_comment(trim_yaml(node)), parent)));
    scalar.filter(|(value, _)| {
        value.starts_with(['|', '>'])
            && value[1..]
                .chars()
                .all(|c| matches!(c, '+' | '-' | '1'..='9'))
    })
}

fn scalar_payloads(lines: &[String]) -> Vec<bool> {
    let mut out = vec![false; lines.len()];
    let mut scalar_parent = None;
    for (index, line) in lines.iter().enumerate() {
        if let Some(parent) = scalar_parent {
            if trim_yaml(line).is_empty() || indent_of(line) > parent {
                out[index] = true;
                continue;
            }
            scalar_parent = None;
        }
        if let Some((_, parent)) = block_scalar_header(line) {
            scalar_parent = Some(parent);
        }
    }
    out
}

/// Keep line positions, but mask block-scalar payload while inspecting keys.
/// The original lines are still used for byte-preserving insertion/replacement.
fn structural_lines(lines: &[String]) -> Vec<String> {
    let mut out = lines.to_vec();
    for (line, payload) in out.iter_mut().zip(scalar_payloads(lines)) {
        if payload {
            line.clear();
        }
    }
    out
}

/// A config/providers value must contain mapping keys, never sequence items.
fn mapping_child_indent(
    lines: &[String],
    parent: usize,
    end: usize,
    locale: crate::locale::Locale,
) -> Result<Option<usize>> {
    let structure = structural_lines(lines);
    let next = (parent + 1..structure.len()).find(|i| !skippable(&structure[*i]));
    if next.is_some_and(|i| {
        indent_of(&structure[i]) == indent_of(&structure[parent])
            && structure[i].trim_start_matches(' ').starts_with("- ")
    }) {
        bail!(
            "{}",
            crate::locale::diagnostic(
                locale,
                "config/providers must be a block mapping, not a sequence"
            )
        );
    }
    let Some(child) = child_indent(&structure, parent, end) else {
        return Ok(None);
    };
    let mut keys = Vec::new();
    let mut block_value = false;
    for line in &structure[parent + 1..end] {
        if skippable(line) || indent_of(line) != child {
            continue;
        }
        let trimmed = line.trim_start_matches(' ');
        if trimmed.starts_with("- ") {
            if !block_value {
                bail!(
                    "{}",
                    crate::locale::diagnostic(
                        locale,
                        "config/providers must be a simple block mapping"
                    )
                );
            }
            // An indentless sequence belongs to the preceding key's value;
            // its items are not additional keys of this mapping.
            continue;
        }
        if trimmed.starts_with(['?', '&', '*', '!']) {
            bail!(
                "{}",
                crate::locale::diagnostic(
                    locale,
                    "config/providers must be a simple block mapping"
                )
            );
        }
        let Some((key, value)) = mapping_parts(trimmed) else {
            bail!(
                "{}",
                crate::locale::diagnostic(
                    locale,
                    "config/providers must be a simple block mapping"
                )
            );
        };
        let key = unquote(key, locale);
        if keys.contains(&key) {
            bail!(
                "{}",
                crate::locale::diagnostic(
                    locale,
                    "config/providers contains duplicate mapping keys"
                )
            );
        }
        keys.push(key);
        block_value = value.is_empty();
    }
    Ok(Some(child))
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
    let payload = scalar_payloads(lines);
    (start..end.min(lines.len()))
        .rev()
        .find(|i| {
            !skippable(&lines[*i])
                || (payload[*i] && (*i + 1 < lines.len() || !lines[*i].is_empty()))
        })
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
fn find_at(
    lines: &[String],
    from: usize,
    until: usize,
    indent: usize,
    key: &str,
    locale: crate::locale::Locale,
) -> Option<usize> {
    (from..until.min(lines.len()))
        .find(|i| indent_of(&lines[*i]) == indent && key_rest(&lines[*i], key, locale).is_some())
}

const PI_AI_ID: &str = "llm-pi-ai";
const PI_AI_NAME: &str = "@deepseek-ai/dsh-llm-pi-ai";

/// The value of `key` on one entry line, read as a YAML scalar (comment
/// stripped, quotes removed). `Ok(None)` when the line is another key,
/// `Err` when the value is in a form this module will not interpret.
fn scalar_key(
    line: &str,
    key: &str,
    locale: crate::locale::Locale,
) -> std::result::Result<Option<String>, String> {
    let Some(rest) = key_rest(line, key, locale) else {
        return Ok(None);
    };
    let unsafe_start =
        rest.is_empty() || rest.starts_with(['|', '>', '[', '{', '&', '*', '!', '?']);
    if unsafe_start {
        return Err(localized_format!(
            locale,
            "a top-level `{key}:` value is written in a form rdsh will not interpret",
            "顶层 `{key}:` 值采用 rdsh 不解析的形式",
            "最上位の `{key}:` 値はrdshが解析しない形式です"
        ));
    }
    try_unquote(rest, locale).map(Some).map_err(|why| {
        localized_format!(
            locale,
            "a top-level `{key}:` value cannot be read: {why}",
            "无法读取顶层 `{key}:` 值：{why}",
            "最上位の `{key}:` 値を読み取れません: {why}"
        )
    })
}

/// The `- id: llm-pi-ai` patch entry (by `id`, or by the plugin `name`). Only
/// keys of the entry itself count: a nested `id:` (inside `insert`, say) does
/// not. `Err` when an entry cannot be read safely or the plugin is declared
/// twice (a later entry replaces the whole config in Cordis).
pub(crate) fn llm_pi_ai_entry(
    lines: &[String],
    locale: crate::locale::Locale,
) -> std::result::Result<Option<usize>, String> {
    inspect_patch_entries(lines, false, locale).map_err(|error| error.to_string())
}

/// Check block-mapping keys in one structural view, including existing
/// provider/model mappings. Sequence items open separate mapping scopes.
fn inspect_mapping_keys(lines: &[String], locale: crate::locale::Locale) -> Result<()> {
    let mut scopes: Vec<(usize, Vec<String>)> = Vec::new();
    for line in lines.iter().filter(|line| !skippable(line)) {
        let mut node = line.trim_start_matches(' ');
        let mut column = indent_of(line);
        let mut sequence = false;
        while node.starts_with("- ") {
            let offset = dash_key_col(node);
            column += offset;
            node = &node[offset..];
            sequence = true;
        }
        scopes.retain(|(depth, _)| {
            if sequence {
                *depth < column
            } else {
                *depth <= column
            }
        });
        if node.starts_with("? ") || node.starts_with(": ") {
            bail!(
                "{}",
                crate::locale::diagnostic(
                    locale,
                    "complex YAML mapping keys cannot be inspected safely"
                )
            );
        }
        let Some((key, _)) = mapping_parts(node) else {
            continue;
        };
        if key.chars().next().is_some_and(char::is_whitespace) {
            bail!(
                "{}",
                crate::locale::diagnostic(
                    locale,
                    "a plain YAML key starting with Unicode whitespace cannot be inspected safely"
                )
            );
        }
        if key.starts_with(['!', '&', '*']) {
            bail!(
                "{}",
                crate::locale::diagnostic(
                    locale,
                    "tagged, anchored or aliased YAML keys cannot be inspected safely"
                )
            );
        }
        if scopes.last().is_none_or(|(depth, _)| *depth != column) {
            scopes.push((column, Vec::new()));
        }
        let keys = &mut scopes.last_mut().expect("scope inserted above").1;
        let key = try_unquote(key, locale).map_err(anyhow::Error::msg)?;
        if key == "<<" {
            bail!(
                "{}",
                crate::locale::diagnostic(locale, "YAML merge keys cannot be inspected safely")
            );
        }
        if keys.contains(&key) {
            bail!(
                "{}",
                crate::locale::diagnostic(locale, "the profile contains duplicate mapping keys")
            );
        }
        keys.push(key);
    }
    Ok(())
}

fn inspect_patch_entries(
    lines: &[String],
    for_write: bool,
    locale: crate::locale::Locale,
) -> Result<Option<usize>> {
    let structure = structural_lines(lines);
    let lines = &structure;
    // 一覧では他pluginの設定を編集可能かどうかに依存せず既存routeを読む。
    // 書込時はdocument全体の安全性を検査してから変更する。
    if for_write {
        check_document(lines, locale).map_err(anyhow::Error::msg)?;
        inspect_mapping_keys(lines, locale)?;
    }
    if lines
        .iter()
        .find(|line| !skippable(line))
        .is_some_and(|line| indent_of(line) != 0)
        || lines
            .iter()
            .filter(|line| !skippable(line) && indent_of(line) == 0)
            .any(|line| !line.starts_with("- "))
    {
        bail!(
            "{}",
            crate::locale::diagnostic(locale, "the file is not a plain sequence of patch entries")
        );
    }
    let starts: Vec<usize> = (0..lines.len())
        .filter(|i| indent_of(&lines[*i]) == 0 && lines[*i].starts_with("- "))
        .collect();
    let mut found = None;
    for (position, start) in starts.iter().enumerate() {
        let end = starts.get(position + 1).copied().unwrap_or(lines.len());
        let col = dash_key_col(&lines[*start]);
        let head = trim_yaml(&lines[*start][col..]);
        if head.starts_with(['{', '[', '*', '&', '!']) {
            bail!(
                "{}",
                crate::locale::diagnostic(
                    locale,
                    "the patch entry uses an unsupported inline or aliased mapping"
                )
            );
        }
        if mapping_parts(head).is_none() {
            bail!(
                "{}",
                crate::locale::diagnostic(
                    locale,
                    "the patch entry must be a block mapping, not a scalar"
                )
            );
        }
        let direct: Vec<usize> = std::iter::once(*start)
            .chain((start + 1..end).filter(|i| indent_of(&lines[*i]) == col))
            .collect();
        let mut identifies = false;
        let mut insert = None;
        let mut keys = Vec::new();
        for i in direct {
            let key_line = if i == *start {
                head
            } else {
                trim_yaml(&lines[i])
            };
            if skippable(key_line) {
                continue;
            }
            if mapping_parts(key_line).is_none() {
                bail!(
                    "{}",
                    crate::locale::diagnostic(
                        locale,
                        "the patch entry must contain simple mapping keys"
                    )
                );
            }
            if mapping_parts(key_line).is_some_and(|(key, _)| key == "<<")
                || key_line.starts_with("? ")
                || key_line.starts_with(": ")
            {
                bail!(
                    "{}",
                    crate::locale::diagnostic(
                        locale,
                        "YAML merge or complex mapping keys cannot be inspected safely"
                    )
                );
            }
            if let Some((key, _)) = mapping_parts(key_line) {
                let key = try_unquote(key, locale).map_err(anyhow::Error::msg)?;
                if keys.contains(&key) {
                    bail!(
                        "{}",
                        crate::locale::diagnostic(
                            locale,
                            "the patch entry contains duplicate mapping keys"
                        )
                    );
                }
                keys.push(key);
            }
            identifies |= scalar_key(key_line, "id", locale)
                .map_err(anyhow::Error::msg)?
                .is_some_and(|value| value == PI_AI_ID)
                || scalar_key(key_line, "name", locale)
                    .map_err(anyhow::Error::msg)?
                    .is_some_and(|value| value == PI_AI_NAME);
            if (key_rest(key_line, "id", locale).is_some()
                || key_rest(key_line, "name", locale).is_some())
                && (i + 1..end)
                    .find(|j| !skippable(&lines[*j]))
                    .is_some_and(|j| indent_of(&lines[j]) > col)
            {
                bail!(
                    "{}",
                    crate::locale::diagnostic(
                        locale,
                        "the patch entry identifier uses a multiline YAML scalar"
                    )
                );
            }
            if let Some(value) = key_rest(key_line, "insert", locale) {
                if !value.is_empty() {
                    bail!(
                        "{}",
                        crate::locale::diagnostic(
                            locale,
                            "insert is written inline and cannot be inspected safely"
                        )
                    );
                }
                insert = Some(i);
            }
        }
        if identifies && key_rest(head, "config", locale).is_some() {
            bail!(
                "{}",
                crate::locale::diagnostic(
                    locale,
                    "the llm-pi-ai config shares the sequence marker; edit it by hand"
                )
            );
        }
        if let Some(insert) = insert {
            if identifies {
                bail!(
                    "{}",
                    crate::locale::diagnostic(
                        locale,
                        "the llm-pi-ai entry uses insert; its outer config is not applied"
                    )
                );
            }
            // Inspect the inserted plugin entries as a sequence of mappings,
            // using the same direct-key rules. Descendants such as model ids
            // belong to a plugin's config, not to the plugin's identity.
            let insert_end = (insert + 1..end)
                .find(|i| {
                    !skippable(&lines[*i])
                        && (indent_of(&lines[*i]) < col
                            || (indent_of(&lines[*i]) == col
                                && !lines[*i].trim_start_matches(' ').starts_with("- ")))
                })
                .unwrap_or(end);
            let nested_indent = (insert + 1..insert_end)
                .find(|i| !skippable(&lines[*i]))
                .map(|i| indent_of(&lines[i]));
            if let Some(indent) = nested_indent {
                let nested: Vec<String> = lines[insert + 1..insert_end]
                    .iter()
                    .map(|line| {
                        if skippable(line) {
                            line.clone()
                        } else {
                            line[indent.min(indent_of(line))..].to_string()
                        }
                    })
                    .collect();
                let target =
                    inspect_patch_entries(&nested, for_write, locale).map_err(|error| {
                        anyhow::anyhow!(
                            "{}: {error}",
                            crate::locale::diagnostic(
                                locale,
                                "insert entries cannot be inspected safely"
                            )
                        )
                    })?;
                if target.is_some() {
                    bail!(
                        "{}",
                        crate::locale::diagnostic(
                            locale,
                            "llm-pi-ai is inside insert; edit its providers by hand"
                        )
                    );
                }
            }
        }
        if identifies {
            if found.is_some() {
                bail!(
                    "{}",
                    crate::locale::diagnostic(
                        locale,
                        "multiple llm-pi-ai patch entries cannot be edited safely"
                    )
                );
            }
            found = Some(*start);
        }
    }
    Ok(found)
}

/// Refuse constructs the line scanner cannot resolve: a quoted scalar that
/// continues on another line, an invalid escape, anchors, aliases, tags and
/// flow collections (any of which can carry or rename an `id`). Comments and
/// block scalar bodies are not looked at.
fn check_document(
    lines: &[String],
    locale: crate::locale::Locale,
) -> std::result::Result<(), String> {
    let mut block: Option<usize> = None;
    for line in lines {
        if let Some(depth) = block {
            if trim_yaml(line).is_empty() || indent_of(line) > depth {
                continue;
            }
            block = None;
        }
        if skippable(line) {
            continue;
        }
        let scan = scan_line(line);
        if scan.open {
            return Err(crate::locale::diagnostic(
                locale,
                "a quoted scalar continues on the next line",
            )
            .to_string());
        }
        let mut flat = String::new();
        for piece in &scan.pieces {
            match piece.kind {
                Kind::Double => {
                    decode_double(piece.text, locale)?;
                    flat.push('Q');
                }
                Kind::Single => flat.push('Q'),
                Kind::Plain => flat.push_str(piece.text),
            }
        }
        let chars: Vec<char> = flat.chars().collect();
        let starts = |i: usize| i == 0 || matches!(chars[i - 1], ' ' | '\t' | '[' | '{' | ',');
        for (i, c) in chars.iter().enumerate() {
            let next = chars.get(i + 1).copied();
            match c {
                '&' | '*' | '!' if starts(i) && next.is_some_and(|n| !n.is_whitespace()) => {
                    return Err(crate::locale::diagnostic(
                        locale,
                        "the file uses YAML anchors, aliases or tags",
                    )
                    .to_string());
                }
                '{' if starts(i) => {
                    let inside: String = chars[i + 1..].iter().collect();
                    if !inside.trim_start_matches([' ', '\t']).starts_with('}') {
                        return Err(crate::locale::diagnostic(
                            locale,
                            "the file uses a flow mapping",
                        )
                        .to_string());
                    }
                }
                '[' if starts(i) => {
                    let tail: Vec<char> = chars[i + 1..].to_vec();
                    let carries = tail.iter().enumerate().any(|(j, t)| {
                        matches!(t, '{' | '&' | '*' | '!')
                            || (*t == ':'
                                && tail
                                    .get(j + 1)
                                    .is_none_or(|n| n.is_whitespace() || *n == 'Q'))
                    });
                    if !tail.contains(&']') || carries {
                        return Err(crate::locale::diagnostic(
                            locale,
                            "the file uses a flow sequence that may hold keys",
                        )
                        .to_string());
                    }
                }
                _ => {}
            }
        }
        // A block scalar's body is free text.
        let body = line[..scan.end].trim_end_matches([' ', '\t', '\r']);
        let last = body.rsplit([' ', '\t']).next().unwrap_or("");
        let before = body[..body.len() - last.len()].trim_end_matches([' ', '\t', '\r']);
        let indicator = last.starts_with(['|', '>'])
            && last[1..]
                .chars()
                .all(|c| matches!(c, '+' | '-' | '0'..='9'))
            && scan.pieces.last().is_some_and(|p| p.kind == Kind::Plain)
            && (before.is_empty() || before.ends_with(':') || before.ends_with('-'));
        if indicator {
            let mut col = indent_of(line);
            let mut rest = &line[col..];
            while let Some(r) = rest.strip_prefix("- ") {
                let blanks = r.len() - r.trim_start_matches([' ', '\t']).len();
                col += 2 + blanks;
                rest = r.trim_start_matches([' ', '\t']);
            }
            block = Some(col);
        }
    }
    Ok(())
}

/// The structural inspection also checks inserted entries and duplicate
/// identities; mentions in model ids or prompt text do not define plugins.
fn sole_pi_ai_entry(
    lines: &[String],
    locale: crate::locale::Locale,
) -> std::result::Result<Option<usize>, String> {
    inspect_patch_entries(lines, true, locale).map_err(|error| error.to_string())
}

/// Column of the first key on a `- key: v` line.
fn dash_key_col(line: &str) -> usize {
    let after = &line[2..];
    2 + after.len() - after.trim_start_matches([' ', '\t']).len()
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
fn locate_providers(lines: &[String], locale: crate::locale::Locale) -> Result<Option<Providers>> {
    let structure = structural_lines(lines);
    let lines = &structure;
    let Some(entry) = llm_pi_ai_entry(lines, locale).map_err(anyhow::Error::msg)? else {
        return Ok(None);
    };
    let col = dash_key_col(&lines[entry]);
    let entry_end = block_end(lines, entry);
    let Some(config) = find_at(lines, entry + 1, entry_end, col, "config", locale) else {
        return Ok(None);
    };
    if !key_rest(&lines[config], "config", locale).is_some_and(str::is_empty) {
        bail!(
            "{}",
            crate::locale::diagnostic(locale, "the llm-pi-ai config is written inline on one line")
        );
    }
    let config_end = block_end(lines, config);
    let Some(ci) = mapping_child_indent(lines, config, config_end, locale)? else {
        return Ok(None);
    };
    let Some(providers) = find_at(lines, config + 1, config_end, ci, "providers", locale) else {
        return Ok(None);
    };
    if !key_rest(&lines[providers], "providers", locale).is_some_and(str::is_empty) {
        bail!(
            "{}",
            crate::locale::diagnostic(
                locale,
                "providers is written inline (for example `providers: {}`)"
            )
        );
    }
    let end = block_end(lines, providers);
    let child = mapping_child_indent(lines, providers, end, locale)?
        .unwrap_or(indent_of(&lines[providers]) + 2);
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

fn routes_in(text: &str, locale: crate::locale::Locale) -> Vec<RouteInfo> {
    let lines = structural_lines(&split_lines(text));
    let Ok(Some(p)) = locate_providers(&lines, locale) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for i in p.line + 1..p.end.min(lines.len()) {
        if skippable(&lines[i]) || indent_of(&lines[i]) != p.child_indent {
            continue;
        }
        let trimmed = trim_yaml(&lines[i]);
        let Some(colon) = trimmed.find(':') else {
            continue;
        };
        let id = unquote(&trimmed[..colon], locale);
        let end = block_end(&lines, i);
        let inner = child_indent(&lines, i, end);
        let scalar = |key: &str| -> Option<String> {
            let indent = inner?;
            let at = find_at(&lines, i + 1, end, indent, key, locale)?;
            let value = key_rest(&lines[at], key, locale)?;
            (!value.is_empty()).then(|| unquote(value, locale))
        };
        let models = inner
            .and_then(|indent| find_at(&lines, i + 1, end, indent, "models", locale))
            .map(|m| {
                let mend = block_end(&lines, m);
                let item = (m + 1..mend)
                    .find(|j| lines[*j].trim_start_matches(' ').starts_with("- "))
                    .map(|j| indent_of(&lines[j]));
                item.map_or(0, |item| {
                    (m + 1..mend)
                        .filter(|j| {
                            indent_of(&lines[*j]) == item
                                && lines[*j].trim_start_matches(' ').starts_with("- ")
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

fn refuse(reason: &str, route: &Route, locale: crate::locale::Locale) -> anyhow::Error {
    anyhow::anyhow!("{}", localized_format!(locale, "cannot place providers.{} safely: {reason}\nadd this under llm-pi-ai config providers by hand:\n{}", "无法安全地写入 providers.{}：{reason}\n请手动将以下内容添加到 llm-pi-ai config providers 下：\n{}", "providers.{} を安全に配置できません: {reason}\nllm-pi-ai config providers の下に次の内容を手動で追加してください:\n{}",
        route.id,
        manual_snippet(route)
    ))
}

/// Read the edited text back: the llm-pi-ai entry is still unique, every
/// route that was there is still found unchanged (except the one being
/// replaced), the new route is found exactly once with what was asked, and its
/// keys sit at consistent columns.
fn verify_written(
    before: &[RouteInfo],
    after: &str,
    route: &Route,
    locale: crate::locale::Locale,
) -> std::result::Result<(), String> {
    let lines = split_lines(after);
    sole_pi_ai_entry(&lines, locale)?.ok_or(crate::locale::diagnostic(
        locale,
        "the llm-pi-ai entry is not found after the edit",
    ))?;
    let provs = locate_providers(&lines, locale)
        .map_err(|e| e.to_string())?
        .ok_or(crate::locale::diagnostic(
            locale,
            "the providers block is not found after the edit",
        ))?;
    let found = routes_in(after, locale);
    if found.iter().filter(|r| r.id == route.id).count() != 1 {
        return Err(crate::locale::diagnostic(
            locale,
            "the written route is not found exactly once on read-back",
        )
        .to_string());
    }
    for old in before.iter().filter(|r| r.id != route.id) {
        if !found.contains(old) {
            return Err(localized_format!(
                locale,
                "the existing route `{}` did not survive the edit",
                "编辑后现有路由 `{}` 丢失",
                "編集後に既存の経路 `{}` が失われています",
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
        return Err(crate::locale::diagnostic(
            locale,
            "the written route differs from the requested one on read-back",
        )
        .to_string());
    }
    // Layout: required keys share one column and model keys follow `- id`.
    let start = (provs.line + 1..provs.end.min(lines.len()))
        .find(|i| {
            indent_of(&lines[*i]) == provs.child_indent
                && key_rest(&lines[*i], &route.id, locale).is_some()
        })
        .ok_or(crate::locale::diagnostic(
            locale,
            "the written route is not at the providers child column",
        ))?;
    let end = block_end(&lines, start);
    let inner = child_indent(&lines, start, end).ok_or(crate::locale::diagnostic(
        locale,
        "the written route has no body",
    ))?;
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
        .any(|k| key_rest(line, k, locale).is_some());
        if !known {
            return Err(crate::locale::diagnostic(
                locale,
                "an unexpected key sits at the route's column",
            )
            .to_string());
        }
        if key_rest(line, "models", locale).is_some() {
            models_at = Some(i);
        }
    }
    let models_at = models_at.ok_or(crate::locale::diagnostic(
        locale,
        "the written route has no models key",
    ))?;
    let mend = block_end(&lines, models_at);
    let mut item_col = None;
    let mut items = 0;
    // `reasoningEfforts:` is the one model key whose value is a mapping, so
    // its children sit one level deeper than the model keys themselves.
    let mut nested_under = false;
    for line in lines.iter().take(mend).skip(models_at + 1) {
        if skippable(line) {
            continue;
        }
        let col = indent_of(line);
        if line.trim_start_matches(' ').starts_with("- ") {
            if *item_col.get_or_insert(col) != col {
                return Err(crate::locale::diagnostic(
                    locale,
                    "model items are at different columns",
                )
                .to_string());
            }
            items += 1;
            nested_under = false;
            continue;
        }
        let Some(item) = item_col else {
            return Err(crate::locale::diagnostic(
                locale,
                "a model key is not aligned with its `- id`",
            )
            .to_string());
        };
        if col == item + 2 {
            nested_under = key_rest(line, "reasoningEfforts", locale).is_some();
            continue;
        }
        if nested_under && col == item + 4 {
            continue;
        }
        return Err(crate::locale::diagnostic(
            locale,
            "a model key is not aligned with its `- id`",
        )
        .to_string());
    }
    if items != route.models.len() {
        return Err(crate::locale::diagnostic(
            locale,
            "the written models do not match the requested count",
        )
        .to_string());
    }
    Ok(())
}

/// すべての挿入経路で、EOFのscalarへ区切り改行が混入しないことを確認する。
/// 非empty rangeの明示置換は、指定route内のscalarも置き換える契約に従う。
fn splice_route_checked(
    lines: &mut Vec<String>,
    range: std::ops::Range<usize>,
    block: Vec<String>,
    route: &Route,
    locale: crate::locale::Locale,
) -> Result<()> {
    if range.start == range.end && range.start == lines.len() {
        let payload = scalar_payloads(lines);
        if payload.last() == Some(&true) {
            let header = payload.iter().rposition(|inside| !inside).unwrap();
            let (style, parent) = block_scalar_header(&lines[header]).unwrap();
            // YAML 1.2.2 8.1.1.1: 内容indent以降のTAB/追加空白も値の一部。
            // 暗黙indentで非空行がない場合だけ、最長の空行でindentを決める。
            let content = &lines[header + 1..];
            let content_indent = style
                .chars()
                .find_map(|c| c.to_digit(10))
                .map(|step| parent + step as usize)
                .or_else(|| {
                    content
                        .iter()
                        .find(|line| {
                            !line
                                .trim_end_matches('\r')
                                .trim_start_matches(' ')
                                .is_empty()
                        })
                        .map(|line| indent_of(line))
                })
                .unwrap_or_else(|| content.iter().map(|line| indent_of(line)).max().unwrap());
            let last = lines.last().unwrap().trim_end_matches('\r');
            let last_has_content = last.len() > content_indent
                || (indent_of(last) < content_indent && !last.trim_start_matches(' ').is_empty());
            let adds_scalar_newline =
                !style.contains('-') && (style.contains('+') || last_has_content);
            if adds_scalar_newline {
                return Err(refuse(
                    crate::locale::diagnostic(
                        locale,
                        "appending a block would change the final block scalar value",
                    ),
                    route,
                    locale,
                ));
            }
        }
    }
    lines.splice(range, block);
    Ok(())
}

/// Insert (or with `replace`, rewrite) `route` in the profile patch text.
fn apply_route(
    text: &str,
    route: &Route,
    replace: bool,
    locale: crate::locale::Locale,
) -> Result<Applied> {
    let crlf = text.contains("\r\n");
    let eol = if crlf { "\r" } else { "" };
    let mut lines = split_lines(text);
    let before = routes_in(text, locale);
    let finish = |lines: Vec<String>, change: Change| -> Result<Applied> {
        let out = Applied {
            text: lines.join("\n"),
            change,
        };
        if change.writes() {
            verify_written(&before, &out.text, route, locale)
                .map_err(|why| refuse(&why, route, locale))?;
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

    // Validate every editable container before profile or credential writes.
    locate_providers(&lines, locale).map_err(|error| refuse(&error.to_string(), route, locale))?;
    let has_content = lines.iter().any(|l| !skippable(l));
    let entry = sole_pi_ai_entry(&lines, locale).map_err(|e| refuse(&e, route, locale))?;
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
                    crate::locale::diagnostic(
                        locale,
                        "the file is not a plain sequence of patch entries",
                    ),
                    route,
                    locale,
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
        splice_route_checked(&mut lines, at..at, with_eol(block), route, locale)?;
        if at_end && !lines.last().is_some_and(|l| l.is_empty()) {
            lines.push(String::new());
        }
        return finish(lines, Change::Added);
    };

    let col = dash_key_col(&lines[entry]);
    let entry_end = block_end(&lines, entry);
    let Some(config) = find_at(&lines, entry + 1, entry_end, col, "config", locale) else {
        // エントリに中身があるのに `- ` 直下のカラムにキーが1つも無いレイアウトは
        // 解釈できない。ここで追記すると同じエントリに2つ目の `config:` を作り、
        // YAML の重複マッピングキーになって既存の providers が無言で消える。
        let body = &lines[entry + 1..entry_end.min(lines.len())];
        let has_body = body.iter().any(|l| !skippable(l));
        let has_col_key = body.iter().any(|l| !skippable(l) && indent_of(l) == col);
        if has_body && !has_col_key {
            return Err(refuse(
                crate::locale::diagnostic(
                    locale,
                    "the llm-pi-ai entry is indented in a form this module will not edit",
                ),
                route,
                locale,
            ));
        }
        let at = content_end(&lines, entry, entry_end);
        let mut block = vec![
            format!("{}config:", " ".repeat(col)),
            format!("{}providers:", " ".repeat(col + 2)),
        ];
        block.extend(render_route(route, col + 4, 2));
        splice_route_checked(&mut lines, at..at, with_eol(block), route, locale)?;
        return finish(lines, Change::Added);
    };
    if !key_rest(&lines[config], "config", locale).is_some_and(str::is_empty) {
        return Err(refuse(
            crate::locale::diagnostic(locale, "the llm-pi-ai config is written inline on one line"),
            route,
            locale,
        ));
    }
    let config_end = block_end(&lines, config);
    let config_indent = indent_of(&lines[config]);
    let Some(ci) = child_indent(&lines, config, config_end) else {
        let at = config + 1;
        let mut block = vec![format!("{}providers:", " ".repeat(config_indent + 2))];
        block.extend(render_route(route, config_indent + 4, 2));
        splice_route_checked(&mut lines, at..at, with_eol(block), route, locale)?;
        return finish(lines, Change::Added);
    };
    let Some(providers) = find_at(&lines, config + 1, config_end, ci, "providers", locale) else {
        let at = content_end(&lines, config, config_end);
        let mut block = vec![format!("{}providers:", " ".repeat(ci))];
        let step = (ci - config_indent).max(1);
        block.extend(render_route(route, ci + step, step));
        splice_route_checked(&mut lines, at..at, with_eol(block), route, locale)?;
        return finish(lines, Change::Added);
    };
    if !key_rest(&lines[providers], "providers", locale).is_some_and(str::is_empty) {
        return Err(refuse(
            crate::locale::diagnostic(
                locale,
                "providers is written inline (for example `providers: {}`)",
            ),
            route,
            locale,
        ));
    }
    let providers_end = block_end(&lines, providers);
    let providers_indent = indent_of(&lines[providers]);
    let child = child_indent(&lines, providers, providers_end).unwrap_or(providers_indent + 2);
    let step = child - providers_indent;
    match find_at(
        &lines,
        providers + 1,
        providers_end,
        child,
        &route.id,
        locale,
    ) {
        Some(existing) => {
            if !replace {
                return finish(lines, Change::Exists);
            }
            let end = content_end(&lines, existing, block_end(&lines, existing));
            let block = with_eol(render_route(route, child, step));
            if lines[existing..end] == block[..] {
                return finish(lines, Change::Identical);
            }
            splice_route_checked(&mut lines, existing..end, block, route, locale)?;
            finish(lines, Change::Replaced)
        }
        None => {
            let at = content_end(&lines, providers, providers_end);
            splice_route_checked(
                &mut lines,
                at..at,
                with_eol(render_route(route, child, step)),
                route,
                locale,
            )?;
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

fn parse_base_url(raw: &str, locale: crate::locale::Locale) -> Result<Base> {
    if raw.is_empty() {
        bail!(
            "{}",
            localized_format!(
                locale,
                "base URL is empty",
                "基础 URL 为空",
                "ベースURLが空です"
            )
        );
    }
    if raw
        .chars()
        .any(|c| c.is_control() || c.is_whitespace() || c == '\\')
    {
        bail!(
            "{}",
            localized_format!(
                locale,
                "base URL contains whitespace or a control character",
                "基础 URL 包含空白或控制字符",
                "ベースURLに空白または制御文字が含まれています"
            )
        );
    }
    let (https, rest) = if let Some(r) = raw.strip_prefix("https://") {
        (true, r)
    } else if let Some(r) = raw.strip_prefix("http://") {
        (false, r)
    } else {
        bail!(
            "{}",
            localized_format!(
                locale,
                "base URL must start with http:// or https://",
                "基础 URL 必须以 http:// 或 https:// 开头",
                "ベースURLは http:// または https:// で始めてください"
            )
        );
    };
    if rest.contains(['?', '#']) {
        bail!(
            "{}",
            localized_format!(
                locale,
                "base URL must not carry a query or fragment",
                "基础 URL 不能包含查询或片段",
                "ベースURLにクエリやフラグメントは指定できません"
            )
        );
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
        let end = authority.find(']').ok_or_else(|| {
            anyhow::anyhow!(
                "{}",
                localized_format!(
                    locale,
                    "invalid IPv6 host in base URL",
                    "基础 URL 中的 IPv6 主机无效",
                    "ベースURLのIPv6ホストが無効です"
                )
            )
        })?;
        authority[1..end]
            .parse::<std::net::Ipv6Addr>()
            .map_err(|_| {
                anyhow::anyhow!(
                    "{}",
                    localized_format!(
                        locale,
                        "invalid IPv6 host in base URL",
                        "基础 URL 中的 IPv6 主机无效",
                        "ベースURLのIPv6ホストが無効です"
                    )
                )
            })?;
        (&authority[..=end], &authority[end + 1..])
    } else {
        let end = authority.find(':').unwrap_or(authority.len());
        let host = &authority[..end];
        if host.is_empty()
            || !host
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b".-_".contains(&b))
        {
            bail!(
                "{}",
                localized_format!(
                    locale,
                    "invalid host in base URL",
                    "基础 URL 中的主机无效",
                    "ベースURLのホストが無効です"
                )
            );
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
            .ok_or_else(|| {
                anyhow::anyhow!(
                    "{}",
                    localized_format!(
                        locale,
                        "invalid port in base URL",
                        "基础 URL 中的端口无效",
                        "ベースURLのポートが無効です"
                    )
                )
            })?
    };
    if !path
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b"/._~%:+-".contains(&b))
    {
        bail!(
            "{}",
            localized_format!(
                locale,
                "base URL path contains an unsupported character",
                "基础 URL 路径包含不支持的字符",
                "ベースURLのパスに未対応の文字が含まれています"
            )
        );
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
pub(crate) fn strip_jsonc(input: &str) -> String {
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
fn read_opencode(id: &str, locale: crate::locale::Locale) -> Result<OpencodeProvider> {
    let paths = opencode_paths();
    let Some(path) = paths.iter().find(|p| p.is_file()) else {
        bail!(
            "{}",
            localized_format!(
                locale,
                "no opencode config found (looked for {})",
                "未找到 OpenCode 配置（已检查 {}）",
                "OpenCodeの設定が見つかりません（確認先: {}）",
                paths
                    .iter()
                    .map(|p| p.display().to_string())
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        );
    };
    let meta = std::fs::metadata(path)?;
    if meta.len() as usize > MAX_BODY_BYTES {
        bail!(
            "{}",
            localized_format!(
                locale,
                "{} is too large",
                "{} 过大",
                "{} が大きすぎます",
                path.display()
            )
        );
    }
    let raw = std::fs::read_to_string(path).with_context(|| {
        localized_format!(
            locale,
            "cannot read {}",
            "无法读取 {}",
            "{} を読み取れません",
            path.display()
        )
    })?;
    let doc: Value = serde_json::from_str(&strip_jsonc(&raw)).with_context(|| {
        localized_format!(
            locale,
            "{} is not valid JSON/JSONC",
            "{} 不是有效的 JSON/JSONC",
            "{} が有効なJSON/JSONCではありません",
            path.display()
        )
    })?;
    parse_opencode_provider(&doc, id, locale)
        .with_context(|| localized_format!(locale, "in {}", "在 {} 中", "{} 内", path.display()))
}

fn parse_opencode_provider(
    doc: &Value,
    id: &str,
    locale: crate::locale::Locale,
) -> Result<OpencodeProvider> {
    let Some(provider) = doc.get("provider").and_then(|p| p.get(id)) else {
        bail!(
            "{}",
            localized_format!(
                locale,
                "opencode config has no provider.{id}",
                "OpenCode 配置中没有 provider.{id}",
                "OpenCodeの設定にprovider.{id}がありません"
            )
        );
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
                ..Model::default()
            });
        }
    }
    Ok(OpencodeProvider { base_url, models })
}

// --- discovery -----------------------------------------------------------------

/// `data[].id` (OpenAI) or `models[].name|model` (Ollama-style).
/// Discovery writes OpenAI Chat Completions routes (`API`), so a listed model
/// that declares its `supported_endpoints` is kept only when one of them is the
/// Chat Completions path. Command Code lists Claude models that answer on
/// `/v1/messages` only; a listing without the field is unchanged.
fn serves_chat_completions(model: &Value) -> bool {
    match model.get("supported_endpoints").and_then(Value::as_array) {
        Some(endpoints) => endpoints.iter().filter_map(Value::as_str).any(|endpoint| {
            endpoint
                .trim()
                .trim_end_matches('/')
                .ends_with("chat/completions")
        }),
        None => true,
    }
}

fn parse_listing(body: &str, locale: crate::locale::Locale) -> Result<Vec<Model>> {
    let doc: Value = serde_json::from_str(body).context(crate::locale::diagnostic(
        locale,
        "the model listing is not JSON",
    ))?;
    let mut listed: Vec<(String, Vec<String>)> = Vec::new();
    if let Some(data) = doc.get("data").and_then(Value::as_array) {
        listed.extend(
            data.iter()
                .filter(|m| serves_chat_completions(m))
                .filter_map(|m| {
                    let id = m.get("id").and_then(Value::as_str)?;
                    Some((id.to_string(), input_from_listing(m)))
                }),
        );
    } else if let Some(models) = doc.get("models").and_then(Value::as_array) {
        listed.extend(models.iter().filter_map(|m| {
            let id = m
                .get("name")
                .or_else(|| m.get("model"))
                .and_then(Value::as_str)?;
            Some((id.to_string(), input_from_listing(m)))
        }));
    } else {
        bail!(
            "{}",
            localized_format!(
                locale,
                "the model listing has neither data[] nor models[]",
                "模型清单中没有 data[] 或 models[]",
                "モデル一覧にdata[]もmodels[]もありません"
            )
        );
    }
    Ok(listed
        .into_iter()
        .filter(|(id, _)| valid_model_id(id))
        .map(|(id, input)| Model {
            id,
            input,
            ..Model::default()
        })
        .collect())
}

/// A listing entry's own input modalities, when it declares them in a shape
/// worth trusting: OpenRouter's architecture.input_modalities, a plain
/// input_modalities, or a capabilities name list that says "vision".
fn input_from_listing(entry: &Value) -> Vec<String> {
    let Some(values) = entry
        .get("architecture")
        .and_then(|architecture| architecture.get("input_modalities"))
        .or_else(|| entry.get("input_modalities"))
        .or_else(|| entry.get("capabilities"))
        .and_then(Value::as_array)
    else {
        return Vec::new();
    };
    let mut out: Vec<String> = Vec::new();
    for value in values.iter().filter_map(Value::as_str) {
        let name = match value {
            "vision" => "image",
            other => other,
        };
        if MODALITIES.contains(&name) && !out.iter().any(|seen| seen == name) {
            out.push(name.to_string());
        }
    }
    // dsh always needs text, so an image-only declaration gains it.
    if out.iter().any(|name| name == "image") && !out.iter().any(|name| name == "text") {
        out.insert(0, "text".to_string());
    }
    out
}

/// text,image as the CLI spells it.
fn parse_inputs(raw: &str) -> Option<Vec<String>> {
    let mut out: Vec<String> = Vec::new();
    for part in raw.split(',') {
        let name = part.trim().to_ascii_lowercase();
        if name.is_empty() || !MODALITIES.contains(&name.as_str()) || out.contains(&name) {
            return None;
        }
        out.push(name);
    }
    if !out.iter().any(|name| name == "text") {
        return None;
    }
    Some(out)
}

fn auth_value_ok(key: &str) -> bool {
    !key.is_empty() && !key.chars().any(|c| c.is_control() || c.is_whitespace())
}

fn http_get(
    base: &Base,
    path: &str,
    key: Option<&str>,
    locale: crate::locale::Locale,
) -> Result<String> {
    http_request(base, "GET", path, key, None, locale)
}

/// Ollama の /api/show のように、小さな JSON を送って能力を尋ねる。
fn http_post(
    base: &Base,
    path: &str,
    key: Option<&str>,
    body: &str,
    locale: crate::locale::Locale,
) -> Result<String> {
    http_request(base, "POST", path, key, Some(body), locale)
}

fn http_request(
    base: &Base,
    method: &str,
    path: &str,
    key: Option<&str>,
    body: Option<&str>,
    locale: crate::locale::Locale,
) -> Result<String> {
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
    let mut stream = stream.ok_or_else(|| {
        anyhow::anyhow!(
            "{}",
            localized_format!(
                locale,
                "cannot reach {}",
                "无法连接 {}",
                "{} に接続できません",
                base.url
            )
        )
    })?;
    let host_header = if base.port == 80 {
        base.host.clone()
    } else {
        format!("{}:{}", base.host, base.port)
    };
    let mut request = format!(
        "{method} {path} HTTP/1.1\r\nHost: {host_header}\r\nUser-Agent: rdsh/{}\r\nAccept: application/json\r\n",
        env!("CARGO_PKG_VERSION")
    );
    if let Some(key) = key {
        request.push_str(&format!("Authorization: Bearer {key}\r\n"));
    }
    if let Some(body) = body {
        request.push_str("Content-Type: application/json\r\n");
        request.push_str(&format!("Content-Length: {}\r\n", body.len()));
    }
    request.push_str("Connection: close\r\n\r\n");
    if let Some(body) = body {
        request.push_str(body);
    }
    stream.set_write_timeout(Some(Duration::from_secs(HTTP_TIMEOUT_SECONDS)))?;
    stream.write_all(request.as_bytes())?;
    let mut raw = Vec::new();
    let mut chunk = [0u8; 8192];
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            bail!(
                "{}",
                localized_format!(
                    locale,
                    "{} timed out",
                    "{} 超时",
                    "{} がタイムアウトしました",
                    base.url
                )
            );
        }
        stream.set_read_timeout(Some(remaining))?;
        let n = stream.read(&mut chunk)?;
        if n == 0 {
            break;
        }
        if raw.len() + n > MAX_BODY_BYTES {
            bail!(
                "{}",
                localized_format!(
                    locale,
                    "{} answered with more than {MAX_BODY_BYTES} bytes",
                    "{} 返回内容超过 {MAX_BODY_BYTES} 字节",
                    "{} の応答が {MAX_BODY_BYTES} バイトを超えています",
                    base.url
                )
            );
        }
        raw.extend_from_slice(&chunk[..n]);
    }
    parse_http_response(&raw, &base.url, locale)
}

fn parse_http_response(raw: &[u8], url: &str, locale: crate::locale::Locale) -> Result<String> {
    let split = raw
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .ok_or_else(|| {
            anyhow::anyhow!(
                "{}",
                localized_format!(
                    locale,
                    "bad HTTP response from {url}",
                    "来自 {url} 的 HTTP 响应无效",
                    "{url} のHTTP応答が不正です"
                )
            )
        })?;
    let head = String::from_utf8_lossy(&raw[..split]).into_owned();
    let body = &raw[split + 4..];
    let mut head_lines = head.lines();
    let status = head_lines
        .next()
        .and_then(|l| l.split_whitespace().nth(1))
        .and_then(|s| s.parse::<u16>().ok())
        .ok_or_else(|| {
            anyhow::anyhow!(
                "{}",
                localized_format!(
                    locale,
                    "bad HTTP response from {url}",
                    "来自 {url} 的 HTTP 响应无效",
                    "{url} のHTTP応答が不正です"
                )
            )
        })?;
    if !(200..300).contains(&status) {
        bail!(
            "{}",
            localized_format!(
                locale,
                "{url} answered HTTP {status}",
                "{url} 返回 HTTP {status}",
                "{url} がHTTP {status}を返しました"
            )
        );
    }
    let chunked = head_lines.any(|l| {
        let lower = l.to_ascii_lowercase();
        lower.starts_with("transfer-encoding:") && lower.contains("chunked")
    });
    let bytes = if chunked {
        decode_chunked(body).ok_or_else(|| {
            anyhow::anyhow!(
                "{}",
                localized_format!(
                    locale,
                    "bad chunked body from {url}",
                    "来自 {url} 的分块正文无效",
                    "{url} のチャンク形式の本文が不正です"
                )
            )
        })?
    } else {
        body.to_vec()
    };
    String::from_utf8(bytes).with_context(|| {
        localized_format!(
            locale,
            "{url} did not answer with UTF-8",
            "{url} 未返回 UTF-8 内容",
            "{url} の応答がUTF-8ではありません"
        )
    })
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
    curl_request_config("GET", url, key, None)
}

/// curl に渡す設定。鍵は argv ではなく標準入力の設定本文にだけ載せる。
fn curl_request_config(method: &str, url: &str, key: Option<&str>, body: Option<&str>) -> String {
    let mut config = format!("url = {}\n", curl_quote(url));
    if method != "GET" {
        config.push_str(&format!("request = {}\n", curl_quote(method)));
    }
    if let Some(key) = key {
        config.push_str(&format!(
            "header = {}\n",
            curl_quote(&format!("Authorization: Bearer {key}"))
        ));
    }
    config.push_str("header = \"Accept: application/json\"\n");
    if let Some(body) = body {
        config.push_str("header = \"Content-Type: application/json\"\n");
        config.push_str(&format!("data = {}\n", curl_quote(body)));
    }
    config.push_str("silent\nshow-error\nfail\n");
    config.push_str("proto = \"=https\"\nproto-redir = \"=https\"\n");
    config.push_str(&format!(
        "max-time = {HTTP_TIMEOUT_SECONDS}\nconnect-timeout = 10\n"
    ));
    config
}

fn curl_get(url: &str, key: Option<&str>, locale: crate::locale::Locale) -> Result<String> {
    curl_send(curl_config(url, key), url, key, locale)
}

fn curl_post(
    url: &str,
    key: Option<&str>,
    body: &str,
    locale: crate::locale::Locale,
) -> Result<String> {
    curl_send(
        curl_request_config("POST", url, key, Some(body)),
        url,
        key,
        locale,
    )
}

fn curl_send(
    config: String,
    url: &str,
    key: Option<&str>,
    locale: crate::locale::Locale,
) -> Result<String> {
    let mut child = Command::new("curl")
        .args(["-q", "--config", "-"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .context(crate::locale::diagnostic(
            locale,
            "could not run curl; install it, or pass --model instead of --discover",
        ))?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(config.as_bytes())
            .context(crate::locale::diagnostic(
                locale,
                "could not send the request to curl",
            ))?;
    }
    let mut body = Vec::new();
    if let Some(mut stdout) = child.stdout.take() {
        let mut buffer = [0u8; 8192];
        loop {
            let read = stdout.read(&mut buffer).context(crate::locale::diagnostic(
                locale,
                "could not read curl's output",
            ))?;
            if read == 0 {
                break;
            }
            if body.len() + read > MAX_BODY_BYTES {
                let _ = child.kill();
                bail!(
                    "{}",
                    localized_format!(
                        locale,
                        "{url} answered with more than {MAX_BODY_BYTES} bytes",
                        "{url} 返回内容超过 {MAX_BODY_BYTES} 字节",
                        "{url} の応答が {MAX_BODY_BYTES} バイトを超えています"
                    )
                );
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
        bail!(
            "{}",
            localized_format!(
                locale,
                "curl failed for {url} ({status}): {message}",
                "curl 请求 {url} 失败（{status}）：{message}",
                "{url} へのcurl要求が失敗しました ({status}): {message}"
            )
        );
    }
    String::from_utf8(body).with_context(|| {
        localized_format!(
            locale,
            "{url} did not answer with UTF-8",
            "{url} 未返回 UTF-8 内容",
            "{url} の応答がUTF-8ではありません"
        )
    })
}

/// Ollama の /api/show が返す、推論の制御方法。
#[derive(Debug, Clone, PartialEq, Eq)]
enum Thinking {
    /// モデル定義の段階名（例: low, medium, high）。
    Levels(Vec<String>),
    /// ON/OFF だけを持つ。OpenAI 互換の段階指定では表せない。
    Toggle,
    /// values: [false]。推論に対応しない。
    Unsupported,
    /// thinking が無い、または問い合わせに失敗した。
    Unknown,
}

/// /api/show の応答から thinking を読む。読めなければ Unknown。
fn parse_thinking(body: &str) -> Thinking {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(body) else {
        return Thinking::Unknown;
    };
    let Some(values) = value
        .get("thinking")
        .and_then(|thinking| thinking.get("values"))
        .and_then(|values| values.as_array())
    else {
        return Thinking::Unknown;
    };
    let names: Vec<String> = values
        .iter()
        .filter_map(|value| value.as_str())
        .map(str::to_string)
        .filter(|name| level_name_ok(name))
        .collect();
    if !names.is_empty() {
        return Thinking::Levels(names);
    }
    if values.iter().any(|value| value.as_bool() == Some(true)) {
        Thinking::Toggle
    } else if values.is_empty() {
        Thinking::Unknown
    } else {
        Thinking::Unsupported
    }
}

/// サーバー由来の段階名を、そのまま設定へ書いてよいか。
fn level_name_ok(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 60
        && !name.chars().any(|c| c.is_control() || c.is_whitespace())
        && name
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_alphanumeric())
}

/// OpenAI 互換の base（.../v1）から、Ollama のネイティブ API の根を組み立てる。
fn ollama_native_root(base: &Base) -> Option<Base> {
    let url = base.url.trim_end_matches('/');
    let root = url.strip_suffix("/v1").unwrap_or(url);
    parse_base_url(root, crate::locale::Locale::English).ok()
}

/// POST /api/show が返す能力。
#[derive(Debug, Clone, PartialEq, Eq)]
struct Capabilities {
    thinking: Thinking,
    /// capabilities に "vision" がある（画像入力を申告している）。
    vision: bool,
}

/// /api/show の応答から capabilities と thinking を読む。
fn parse_capabilities(body: &str) -> Capabilities {
    let vision = serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|value| {
            value
                .get("capabilities")
                .and_then(serde_json::Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .filter_map(serde_json::Value::as_str)
                        .any(|name| name == "vision")
                })
        })
        .unwrap_or(false);
    Capabilities {
        thinking: parse_thinking(body),
        vision,
    }
}

/// POST /api/show で、モデルが公開する能力を尋ねる。
fn probe_capabilities(
    base: &Base,
    key: Option<&str>,
    model: &str,
    locale: crate::locale::Locale,
) -> Capabilities {
    let Some(root) = ollama_native_root(base) else {
        return Capabilities {
            thinking: Thinking::Unknown,
            vision: false,
        };
    };
    let path = format!("{}/api/show", root.path);
    let body = serde_json::json!({ "model": model }).to_string();
    let answer = if root.https {
        curl_post(&format!("{}{path}", root.url), key, &body, locale)
    } else {
        http_post(&root, &path, key, &body, locale)
    };
    answer.map_or(
        Capabilities {
            thinking: Thinking::Unknown,
            vision: false,
        },
        |text| parse_capabilities(&text),
    )
}

/// 取得した段階名を reasoningEfforts の形にする。
fn levels_from_names(names: &[String]) -> Vec<ReasoningEffort> {
    names
        .iter()
        .map(|name| ReasoningEffort {
            label: name.clone(),
            value: name.clone(),
        })
        .collect()
}

fn discover(base: &Base, key: Option<&str>, locale: crate::locale::Locale) -> Result<Vec<Model>> {
    if let Some(key) = key {
        if !auth_value_ok(key) {
            bail!(
                "{}",
                localized_format!(
                    locale,
                    "the API key contains whitespace or a control character",
                    "API 密钥包含空白或控制字符",
                    "APIキーに空白または制御文字が含まれています"
                )
            );
        }
    }
    let body = if base.https {
        curl_get(&format!("{}/models", base.url), key, locale)?
    } else {
        http_get(base, &format!("{}/models", base.path), key, locale)?
    };
    parse_listing(&body, locale)
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
    let mut text = apply_route("", &r, false, crate::locale::Locale::English)
        .unwrap()
        .text;
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
    /// `low,medium,high` / `none` for every model of this route.
    pub effort: Option<String>,
    /// Ollama 系で /api/show を読まない。
    pub no_probe: bool,
    /// text,image を全モデルに明示する。
    pub input: Option<String>,
    pub replace: bool,
    /// Suppress this command's own report; the caller aggregates results.
    pub quiet: bool,
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

fn read_stdin_key(locale: crate::locale::Locale) -> Result<String> {
    let mut line = String::new();
    std::io::stdin()
        .lock()
        .take(1024)
        .read_line(&mut line)
        .context(crate::locale::diagnostic(
            locale,
            "could not read the API key from stdin",
        ))?;
    let key = line.trim().to_string();
    if key.is_empty() {
        bail!(
            "{}",
            localized_format!(
                locale,
                "--key-stdin: no key on stdin",
                "--key-stdin：标准输入中没有密钥",
                "--key-stdin: 標準入力にキーがありません"
            )
        );
    }
    if !auth_value_ok(&key) || key.len() > 512 {
        bail!(
            "{}",
            localized_format!(
                locale,
                "--key-stdin: the key is empty, oversized or contains whitespace",
                "--key-stdin：密钥为空、过大或包含空白",
                "--key-stdin: キーが空・大きすぎる・空白を含む、のいずれかです"
            )
        );
    }
    Ok(key)
}

/// Write `text` next to `path` and rename it over, keeping the permissions.
fn write_atomic(path: &Path, text: &str, locale: crate::locale::Locale) -> Result<()> {
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
            bail!(
                "{}",
                localized_format!(
                    locale,
                    "the temporary file does not hold what was written",
                    "临时文件内容与写入内容不同",
                    "一時ファイルの内容が書き込んだ内容と異なります"
                )
            );
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

/// プロファイル設定に既にある経路ID（読み取りのみ。鍵の値は含まない）。
pub(crate) fn configured_route_ids(profile: &str, locale: crate::locale::Locale) -> Vec<String> {
    let path = PathBuf::from(dsh_home())
        .join("profiles")
        .join(profile)
        .join("cordis.patch.yml");
    let text = read_patch(&path, locale).unwrap_or_default();
    routes_in(&text, locale)
        .into_iter()
        .map(|route| route.id)
        .collect()
}

fn read_patch(path: &Path, locale: crate::locale::Locale) -> Result<String> {
    match std::fs::read_to_string(path) {
        Ok(t) => Ok(t),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(e).with_context(|| {
            localized_format!(
                locale,
                "cannot read {}",
                "无法读取 {}",
                "{} を読み取れません",
                path.display()
            )
        }),
    }
}

/// `rdsh provider add <preset>`.
pub(crate) fn cmd_add(
    args: AddArgs,
    configured_default_profile: &str,
    locale: crate::locale::Locale,
) -> Result<()> {
    let preset = preset(&args.preset).ok_or_else(|| {
        anyhow::anyhow!(
            "{}",
            localized_format!(
                locale,
                "unknown provider preset {:?}; available: {}",
                "未知的提供方预设 {:?}；可用预设：{}",
                "不明なプロバイダープリセット {:?}。利用可能: {}",
                args.preset,
                PRESETS.iter().map(|p| p.id).collect::<Vec<_>>().join(", ")
            )
        )
    })?;
    // Presets with a fixed endpoint are a fixed route: only local-openai is
    // free-form.
    if preset.base_url.is_some() && (args.id.is_some() || args.name.is_some()) {
        bail!(
            "{}",
            localized_format!(
                locale,
                "--id and --name are for local-openai; {} has a fixed route",
                "--id 和 --name 仅适用于 local-openai；{} 使用固定路由",
                "--id・--name は local-openai 専用です。{} は固定経路です",
                preset.id
            )
        );
    }
    if args.no_key && preset.needs_key && preset.base_url.is_some() {
        bail!(
            "{}",
            localized_format!(
                locale,
                "--no-key is for a server that authenticates nobody; {} needs an API key",
                "--no-key 用于无需认证的服务器；{} 需要 API 密钥",
                "--no-key は認証のないサーバー向けです。{} はAPIキーが必要です",
                preset.id
            )
        );
    }
    if args.discover && !preset.supports_discovery {
        bail!(
            "{}",
            t(locale,
                &format!(
                    "{} には GET /models がない（404）ため --discover は使えません。--model <id> を指定するか、省略して既定のモデルを使ってください",
                    preset.id
                ),
                &format!(
                    "--discover is not supported for {}: its API has no GET /models (it answers 404). Pass --model <id>, or omit it to use the built-in models",
                    preset.id
                ), &format!("{} 的 API 没有 GET /models（返回 404），不能使用 --discover。请传入 --model <id>，或省略以使用内置模型", preset.id))
        );
    }
    if args.key_stdin && args.no_key {
        bail!(
            "{}",
            localized_format!(
                locale,
                "--key-stdin and --no-key cannot be combined",
                "--key-stdin 与 --no-key 不能同时使用",
                "--key-stdin と --no-key は併用できません"
            )
        );
    }
    let id = args.id.clone().unwrap_or_else(|| preset.id.to_string());
    if !auth::is_record_id(&id) {
        bail!(
            "{}",
            localized_format!(
                locale,
                "route id {id:?} must be lowercase letters, digits and '-', starting with a letter",
                "路由标识 {id:?} 必须以小写字母开头，仅含小写字母、数字和 '-'",
                "経路ID {id:?} は小文字で始まり、小文字・数字・'-' のみ使用できます"
            )
        );
    }
    let key_env = route_key_env(&id);
    if let Some(name) = &args.name {
        if name.trim().is_empty() || name.chars().any(|c| c.is_control()) {
            bail!(
                "{}",
                localized_format!(
                    locale,
                    "--name is empty or contains a control character",
                    "--name 为空或包含控制字符",
                    "--name が空か制御文字を含んでいます"
                )
            );
        }
    }
    let input_override = args.input.clone();
    let effort_override = match args.effort.as_deref() {
        // "none" clears the levels, so dsh resolves the model as non-reasoning.
        Some(raw) if raw.trim().eq_ignore_ascii_case("none") => Some(Vec::new()),
        Some(raw) => match ReasoningEffort::parse_list(raw) {
            Some(levels) => Some(levels),
            None => bail!("{}", localized_format!(locale,
                "--effort takes a comma list such as low,medium,high (label=value also works), or none",
                "--effort 需要 low,medium,high 这样的逗号分隔级别（也可 label=value），或 none",
                "--effort は low,medium,high のようなカンマ区切り（label=value も可）、または none です"
            )),
        },
        None => None,
    };
    let explicit_base = args
        .base_url
        .as_deref()
        .map(|value| parse_base_url(value, locale))
        .transpose()?;
    let mut explicit_models = Vec::new();
    for m in &args.models {
        if !valid_model_id(m) {
            bail!(
                "{}",
                localized_format!(
                    locale,
                    "invalid --model id {m:?}",
                    "--model 标识 {m:?} 无效",
                    "--model ID {m:?} が無効です"
                )
            );
        }
        explicit_models.push(Model {
            id: m.clone(),
            ..Model::default()
        });
    }

    // Everything above is checked before the profile or the network is touched.
    let profile =
        crate::profile_or_default(args.profile.clone(), configured_default_profile, locale)?;
    if !valid_profile_name(&profile) {
        bail!(
            "{}",
            localized_format!(
                locale,
                "invalid profile name {profile:?}",
                "配置文件名 {profile:?} 无效",
                "プロファイル名 {profile:?} が無効です"
            )
        );
    }
    let profile_dir = PathBuf::from(dsh_home()).join("profiles").join(&profile);
    if !profile_dir.is_dir() {
        bail!(
            "{}",
            localized_format!(
                locale,
                "no profile {profile} under {} (see `rdsh profiles`)",
                "{} 下没有配置文件 {profile}（参见 `rdsh profiles`）",
                "{} にプロファイル {profile} がありません（`rdsh profiles` を参照）",
                profile_dir.parent().unwrap_or(&profile_dir).display()
            )
        );
    }
    let patch_path = profile_dir.join("cordis.patch.yml");

    let opencode = if args.from_opencode {
        Some(read_opencode(&id, locale)?)
    } else {
        None
    };
    let base = match (
        &explicit_base,
        opencode.as_ref().and_then(|o| o.base_url.as_deref()),
        preset.base_url,
    ) {
        (Some(b), _, _) => b.clone(),
        (None, Some(url), _) => parse_base_url(url, locale).context("opencode baseURL")?,
        (None, None, Some(url)) => parse_base_url(url, locale)?,
        (None, None, None) => {
            bail!(
                "{}",
                localized_format!(
                    locale,
                    "local-openai needs --base-url (for example http://host:8080/v1)",
                    "local-openai 需要 --base-url（例如 http://host:8080/v1）",
                    "local-openai には --base-url が必要です（例: http://host:8080/v1）"
                )
            )
        }
    };

    // Key input. The value only ever lives in these locals.
    let stdin_key = if args.key_stdin {
        Some(read_stdin_key(locale)?)
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
    let current = read_patch(&patch_path, locale)?;
    let already = locate_providers(&split_lines(&current), locale)
        .ok()
        .flatten()
        .is_some_and(|p| {
            let lines = split_lines(&current);
            find_at(&lines, p.line + 1, p.end, p.child_indent, &id, locale).is_some()
        });

    let skip_existing = already && !args.replace;
    // 推論の制御方法を /api/show から読めるのは Ollama 系のプリセットだけ。
    let read_capabilities = !args.no_probe && matches!(preset.id, "ollama" | "ollama-cloud");
    let mut notes: Vec<String> = Vec::new();
    let mut human_notes: Vec<String> = Vec::new();
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
        let mut found = discover(&base, key.as_deref(), locale)?;
        if found.len() > MAX_MODELS {
            notes.push(format!("model listing truncated to {MAX_MODELS} entries"));
            human_notes.push(localized_format!(
                locale,
                "model listing truncated to {MAX_MODELS} entries",
                "模型清单已截断为 {MAX_MODELS} 条",
                "モデル一覧を {MAX_MODELS} 件に切り詰めました"
            ));
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
    notes.extend(apply_preset_models(
        preset,
        &mut models,
        crate::locale::Locale::English,
    ));
    human_notes.extend(apply_preset_models(preset, &mut models, locale));
    // Ollama 系は /api/show がモデルごとの推論制御を返すので、手入力の代わりに読む。
    // 説明済みのモデルは、下の「段階が無い」注記から外して二重に言わない。
    let mut explained: Vec<String> = Vec::new();
    if read_capabilities && !skip_existing && effort_override.is_none() {
        let key = stdin_key
            .clone()
            .or_else(|| env_key.clone())
            .or_else(|| refs.get(&key_env).cloned())
            .filter(|k| k != PLACEHOLDER_KEY);
        for model in models.iter_mut() {
            if !model.reasoning_efforts.is_empty() {
                continue;
            }
            let capabilities = probe_capabilities(&base, key.as_deref(), &model.id, locale);
            if capabilities.vision && !model.input.iter().any(|name| name == "image") {
                model.input = vec!["text".to_string(), "image".to_string()];
                human_notes.push(localized_format!(
                    locale,
                    "{}: the model reports image input",
                    "{}：模型声明支持图像输入",
                    "{}: 画像入力に対応すると申告しています",
                    model.id
                ));
            }
            match capabilities.thinking {
                Thinking::Levels(names) => {
                    model.reasoning_efforts = levels_from_names(&names);
                    human_notes.push(localized_format!(
                        locale,
                        "{}: the model publishes {}",
                        "{}：模型公开了 {}",
                        "{}: モデルが {} を公開しています",
                        model.id,
                        names.join(", ")
                    ));
                }
                Thinking::Toggle => {
                    explained.push(model.id.clone());
                    human_notes.push(localized_format!(
                        locale,
                        "{}: thinking is on/off only, so no reasoning levels are written",
                        "{}：推理只有开/关，因此不写入推理强度",
                        "{}: 推論がON/OFFのみのため、推論強度は書きません",
                        model.id
                    ));
                }
                Thinking::Unsupported => {
                    explained.push(model.id.clone());
                    human_notes.push(localized_format!(
                        locale,
                        "{}: the model reports no thinking support",
                        "{}：模型报告不支持推理",
                        "{}: モデルは推論非対応と回答しています",
                        model.id
                    ));
                }
                Thinking::Unknown => {}
            }
        }
    }
    if let Some(raw) = input_override.as_deref() {
        let Some(inputs) = parse_inputs(raw) else {
            bail!(
                "{}",
                localized_format!(
                    locale,
                    "--input takes text and/or image, comma separated (text is required)",
                    "--input 接受 text 和/或 image，用逗号分隔（必须包含 text）",
                    "--input は text と image をカンマ区切りで指定します（text は必須）"
                )
            );
        };
        for model in models.iter_mut() {
            model.input = inputs.clone();
        }
    }
    match &effort_override {
        Some(levels) => {
            for model in models.iter_mut() {
                model.reasoning_efforts = levels.clone();
            }
        }
        // dsh resolves a model with no levels as non-reasoning, so say which
        // ones got none instead of guessing a list that fits every server.
        None => {
            let unlevelled: Vec<&str> = models
                .iter()
                .filter(|model| model.reasoning_efforts.is_empty())
                .filter(|model| !explained.iter().any(|id| id == &model.id))
                .map(|model| model.id.as_str())
                .collect();
            if !unlevelled.is_empty() {
                human_notes.push(localized_format!(
                    locale,
                    "no reasoning levels for {}: pass --effort to declare them (dsh treats such a model as non-reasoning)",
                    "{} 没有推理强度：用 --effort 声明（否则 dsh 视为不支持推理）",
                    "{} には推論強度がありません。--effort で宣言できます（未指定のモデルはdshで推論非対応として扱われます）",
                    unlevelled.join(", ")
                ));
            }
        }
    }
    if models.is_empty() && !skip_existing {
        bail!("{}", localized_format!(locale, "no models: pass --model <id>, or use --from-opencode / --discover", "没有模型：请传入 --model <id>，或使用 --from-opencode / --discover", "モデルがありません。--model <id> または --from-opencode / --discover を指定してください"));
    }
    let route = route_for(models);

    // Route first, under the profile lock; the document is read inside it.
    let (change, written) = if args.dry_run {
        let applied = apply_route(&current, &route, args.replace, locale)?;
        (applied.change, false)
    } else {
        let _lock = CredentialFileLock::exclusive_for(&patch_path, locale)?;
        let text = read_patch(&patch_path, locale)?;
        let applied = apply_route(&text, &route, args.replace, locale)?;
        if applied.change.writes() {
            write_atomic(&patch_path, &applied.text, locale)?;
            (applied.change, true)
        } else {
            (applied.change, false)
        }
    };

    // Then the key.
    let key_state = if let Some(key) = &stdin_key {
        if args.dry_run {
            "would-store"
        } else if auth::store_ref(&key_env, key, locale)? {
            "stored"
        } else {
            "present"
        }
    } else if let Some(key) = env_key.as_ref().filter(|_| !has_ref) {
        if args.dry_run {
            "would-store"
        } else if auth::store_ref(&key_env, key, locale)? {
            "stored"
        } else {
            "present"
        }
    } else if has_ref || env_key.is_some() {
        "present"
    } else if args.no_key || !preset.needs_key {
        if args.dry_run {
            "would-store-placeholder"
        } else {
            auth::store_ref(&key_env, PLACEHOLDER_KEY, locale)?;
            "placeholder"
        }
    } else {
        "missing"
    };

    if args.quiet {
        return Ok(());
    }
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
                "reasoningEfforts": efforts_by_model(&route),
                "notes": notes,
            })
        );
        return Ok(());
    }
    let file = patch_path.display();
    let verb = match change {
        Change::Added => t(locale, "追加しました", "added", "已添加"),
        Change::Replaced => t(locale, "置き換えました", "replaced", "已替换"),
        Change::Exists => t(
            locale,
            "既に設定済みです（変更なし。置き換えるには --replace）",
            "already configured, nothing changed (use --replace to rewrite it)",
            "已配置，未作更改（使用 --replace 重写）",
        ),
        Change::Identical => t(
            locale,
            "既に同じ内容です（変更なし）",
            "already identical, nothing changed",
            "内容已相同，未作更改",
        ),
    };
    let dry = if args.dry_run {
        t(
            locale,
            "[dry-run・書き込みなし] ",
            "[dry-run, nothing written] ",
            "[试运行，未写入] ",
        )
    } else {
        String::new()
    };
    println!("[rdsh provider] {dry}{} {}: {verb}", profile, route.id);
    println!(
        "{}",
        localized_format!(
            locale,
            "[rdsh provider] file: {file}",
            "[rdsh provider] 文件：{file}",
            "[rdsh provider] ファイル: {file}"
        )
    );
    println!(
        "{}",
        localized_format!(
            locale,
            "[rdsh provider] {} ({API}), models: {}",
            "[rdsh provider] {} ({API})，模型：{}",
            "[rdsh provider] {} ({API})、モデル: {}",
            route.base_url,
            model_ids.join(", ")
        )
    );
    if let Some(line) = effort_summary(&route) {
        println!(
            "{}",
            localized_format!(
                locale,
                "[rdsh provider] reasoning effort: {line}",
                "[rdsh provider] 推理强度：{line}",
                "[rdsh provider] 推論の強さ: {line}"
            )
        );
    }
    if args.dry_run && change.writes() {
        println!("{}", manual_snippet(&route));
    }
    for note in &human_notes {
        println!(
            "{}",
            localized_format!(
                locale,
                "[rdsh provider] note: {note}",
                "[rdsh provider] 提示：{note}",
                "[rdsh provider] 注記: {note}"
            )
        );
    }
    match key_state {
        "stored" => println!(
            "[rdsh provider] {}",
            t(locale,
                &format!("鍵を {key_env} として保存しました"),
                &format!("key saved as {key_env}"), &format!("密钥已保存为 {key_env}"))
        ),
        "would-store" => println!(
            "[rdsh provider] {}",
            t(locale, &format!("{key_env} を保存します"), &format!("would save {key_env}"), &format!("将保存 {key_env}"))
        ),
        "placeholder" | "would-store-placeholder" => println!(
            "[rdsh provider] {}",
            t(locale,
                &format!("鍵なしのため {key_env} にダミー値を保存します"),
                &format!("no key: stores a placeholder for {key_env}"), &format!("无需密钥：将为 {key_env} 保存占位值"))
        ),
        "present" => println!(
            "[rdsh provider] {}",
            t(locale, &format!("{key_env}: 設定済み"), &format!("{key_env}: present"), &format!("{key_env}：已存在"))
        ),
        _ => println!(
            "[rdsh provider] {}",
            t(locale,
                &format!("{key_env} が未設定です。{key_env}=... を付けて再実行するか、--key-stdin で渡してください"),
                &format!("{key_env} is missing: re-run with {key_env}=... set, or pipe it with --key-stdin"), &format!("缺少 {key_env}：请设置 {key_env}=... 后重试，或通过 --key-stdin 传入"))
        ),
    }
    Ok(())
}

/// `rdsh provider list [--json]`.
pub(crate) fn cmd_list(json: bool, locale: crate::locale::Locale) -> Result<()> {
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
        let found = routes_in(&text, locale);
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
    println!(
        "{}",
        localized_format!(
            locale,
            "[rdsh provider] presets:",
            "[rdsh provider] 预设：",
            "[rdsh provider] プリセット:"
        )
    );
    for p in PRESETS {
        println!(
            "{}",
            localized_format!(
                locale,
                "  {:<13} {} ({}, key {})",
                "  {:<13} {} ({}, 密钥 {})",
                "  {:<13} {} ({}, キー {})",
                p.id,
                p.base_url.unwrap_or(match locale {
                    crate::locale::Locale::English => "--base-url required",
                    crate::locale::Locale::Chinese => "需要 --base-url",
                    crate::locale::Locale::Japanese => "--base-url が必要です",
                }),
                API,
                route_key_env(p.id)
            )
        );
    }
    if profiles.is_empty() {
        println!(
            "{}",
            localized_format!(
                locale,
                "[rdsh provider] no profiles under {}",
                "[rdsh provider] {} 下没有配置文件",
                "[rdsh provider] {} にプロファイルがありません",
                root.display()
            )
        );
    }
    for p in &profiles {
        println!(
            "{}",
            localized_format!(
                locale,
                "[rdsh provider] profile {}:",
                "[rdsh provider] 配置文件 {}：",
                "[rdsh provider] プロファイル {}:",
                p["profile"].as_str().unwrap_or("")
            )
        );
        for r in p["routes"].as_array().into_iter().flatten() {
            let configured = r["configured"].as_bool().unwrap_or(false);
            if configured {
                println!(
                    "{}",
                    localized_format!(
                        locale,
                        "  {:<13} configured, {} models, {} {}",
                        "  {:<13} 已配置，{} 个模型，{} {}",
                        "  {:<13} 設定済み、モデル{}件、{} {}",
                        r["id"].as_str().unwrap_or(""),
                        r["models"],
                        r["apiKeyEnv"].as_str().unwrap_or(""),
                        crate::locale::diagnostic(locale, r["key"].as_str().unwrap_or(""))
                    )
                );
            } else {
                println!(
                    "{}",
                    localized_format!(
                        locale,
                        "  {:<13} not configured",
                        "  {:<13} 未配置",
                        "  {:<13} 未設定",
                        r["id"].as_str().unwrap_or("")
                    )
                );
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ollama_is_keyless_and_publishes_thinking_levels() {
        let p = preset("ollama").expect("ollama preset");
        assert_eq!(p.base_url, Some("http://127.0.0.1:11434/v1"));
        assert!(!p.needs_key);
        let levels: Vec<&str> = p.default_models[0]
            .reasoning_efforts
            .iter()
            .map(|(l, _)| *l)
            .collect();
        assert_eq!(levels, vec!["low", "medium", "high"]);
    }

    #[test]
    fn every_remote_preset_still_needs_a_key() {
        for preset in PRESETS.iter().filter(|p| p.id != "ollama") {
            assert!(preset.needs_key, "{} must keep needing a key", preset.id);
        }
    }

    #[test]
    fn reasoning_efforts_are_written_under_the_model() {
        let mut r = route("ollama", &["gpt-oss:20b"]);
        r.models[0].reasoning_efforts =
            ReasoningEffort::levels(preset("ollama").unwrap().default_models[0].reasoning_efforts);
        let rendered = render_route(&r, 6, 2).join("\n");
        assert!(rendered.contains("reasoningEfforts:"), "{rendered}");
        assert!(rendered.contains("      low: low"), "{rendered}");
        assert!(rendered.contains("      high: high"), "{rendered}");
    }

    #[test]
    fn a_model_without_levels_writes_no_block() {
        let rendered = render_route(&route("ollama", &["m"]), 0, 2).join("\n");
        assert!(!rendered.contains("reasoningEfforts"), "{rendered}");
    }

    #[test]
    fn effort_lists_parse_labels_and_explicit_values() {
        let plain = ReasoningEffort::parse_list("low,medium,high").unwrap();
        assert_eq!(plain[1].label, "medium");
        assert_eq!(plain[1].value, "medium");
        let aliased = ReasoningEffort::parse_list("quick=low, deep=high").unwrap();
        assert_eq!(aliased[0].label, "quick");
        assert_eq!(aliased[0].value, "low");
        assert_eq!(aliased[1].value, "high");
    }

    #[test]
    fn effort_lists_reject_duplicates_and_empty_parts() {
        assert!(ReasoningEffort::parse_list("low,low").is_none());
        assert!(ReasoningEffort::parse_list("low,,high").is_none());
        assert!(ReasoningEffort::parse_list("=high").is_none());
        assert!(ReasoningEffort::parse_list("   ").is_none());
        assert!(ReasoningEffort::parse_list("a\u{7}b").is_none());
    }

    #[test]
    fn preset_levels_reach_only_the_models_the_preset_documents() {
        let preset = preset("ollama").unwrap();
        let mut models = vec![
            Model {
                id: "gpt-oss:20b".to_string(),
                ..Model::default()
            },
            Model {
                id: "other".to_string(),
                ..Model::default()
            },
        ];
        apply_preset_models(preset, &mut models, crate::locale::Locale::English);
        assert_eq!(models[0].reasoning_efforts.len(), 3);
        assert!(models[1].reasoning_efforts.is_empty());
    }

    #[test]
    fn vision_capabilities_become_image_input() {
        let caps = parse_capabilities(
            r#"{"capabilities":["completion","tools","thinking","vision"],"thinking":{"values":["low","high"]}}"#,
        );
        assert!(caps.vision);
        assert_eq!(
            caps.thinking,
            Thinking::Levels(vec!["low".to_string(), "high".to_string()])
        );
        let plain = parse_capabilities(r#"{"capabilities":["completion"],"thinking":{}}"#);
        assert!(!plain.vision);
        assert!(!parse_capabilities("not json").vision);
    }

    #[test]
    fn a_listing_can_declare_image_input() {
        let body = r#"{"data":[
            {"id":"a","architecture":{"input_modalities":["text","image"]}},
            {"id":"b","capabilities":["vision"]},
            {"id":"c"},
            {"id":"d","input_modalities":["image"]}
        ]}"#;
        let models = parse_listing(body, crate::locale::Locale::English).unwrap();
        assert_eq!(models[0].input, vec!["text", "image"]);
        assert_eq!(models[1].input, vec!["text", "image"]);
        assert!(models[2].input.is_empty());
        assert_eq!(models[3].input, vec!["text", "image"]);
    }

    #[test]
    fn the_input_flag_takes_only_known_modalities() {
        assert_eq!(
            parse_inputs("text,image"),
            Some(vec!["text".to_string(), "image".to_string()])
        );
        assert_eq!(
            parse_inputs("IMAGE,TEXT"),
            Some(vec!["image".to_string(), "text".to_string()])
        );
        assert_eq!(parse_inputs("image"), None);
        assert_eq!(parse_inputs("text,audio"), None);
        assert_eq!(parse_inputs("text,text"), None);
        assert_eq!(parse_inputs(""), None);
    }

    #[test]
    fn thiking_levels_come_from_the_show_response() {
        assert_eq!(
            parse_thinking(r#"{"thinking":{"values":["low","medium","high"],"default":"medium"}}"#),
            Thinking::Levels(vec![
                "low".to_string(),
                "medium".to_string(),
                "high".to_string()
            ])
        );
    }

    #[test]
    fn an_on_off_model_reports_toggle_instead_of_levels() {
        assert_eq!(
            parse_thinking(r#"{"thinking":{"values":[true,false]}}"#),
            Thinking::Toggle
        );
        assert_eq!(
            parse_thinking(r#"{"thinking":{"values":[false]}}"#),
            Thinking::Unsupported
        );
    }

    #[test]
    fn a_response_without_thinking_metadata_is_unknown() {
        assert_eq!(parse_thinking("{}"), Thinking::Unknown);
        assert_eq!(parse_thinking(r#"{"thinking":{}}"#), Thinking::Unknown);
        assert_eq!(parse_thinking("not json"), Thinking::Unknown);
        assert_eq!(
            parse_thinking(r#"{"thinking":{"values":[]}}"#),
            Thinking::Unknown
        );
    }

    #[test]
    fn unsafe_level_names_are_dropped_instead_of_written() {
        assert!(!level_name_ok("has space"));
        assert!(!level_name_ok("line\nbreak"));
        assert!(!level_name_ok(""));
        assert!(!level_name_ok("-leading-dash"));
        assert!(level_name_ok("medium"));
        assert_eq!(
            parse_thinking(r#"{"thinking":{"values":["low","two words","high"]}}"#),
            Thinking::Levels(vec!["low".to_string(), "high".to_string()])
        );
    }

    #[test]
    fn the_native_api_root_drops_the_compatibility_prefix() {
        let base =
            parse_base_url("http://127.0.0.1:11434/v1", crate::locale::Locale::English).unwrap();
        let root = ollama_native_root(&base).expect("root");
        assert_eq!(root.url, "http://127.0.0.1:11434");
        assert_eq!(root.path, "");
        let cloud =
            parse_base_url("https://ollama.com/v1", crate::locale::Locale::English).unwrap();
        let root = ollama_native_root(&cloud).expect("root");
        assert_eq!(root.url, "https://ollama.com");
    }

    #[test]
    fn the_probe_reads_thinking_from_a_live_server() {
        let server = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = server.local_addr().unwrap().port();
        let handle = std::thread::spawn(move || {
            for _ in 0..1 {
                let (mut stream, _) = server.accept().unwrap();
                let mut head = Vec::new();
                let mut byte = [0u8; 1];
                while !head.ends_with(b"\r\n\r\n") {
                    if std::io::Read::read(&mut stream, &mut byte).unwrap_or(0) == 0 {
                        break;
                    }
                    head.push(byte[0]);
                }
                let text = String::from_utf8_lossy(&head).into_owned();
                assert!(text.starts_with("POST /api/show "), "{text}");
                assert!(text.contains("Content-Type: application/json"), "{text}");
                // 本文を読まずに閉じると RST になるので、宣言された長さだけ読み切る。
                let length: usize = text
                    .lines()
                    .find_map(|line| {
                        let lower = line.to_ascii_lowercase();
                        lower
                            .starts_with("content-length:")
                            .then(|| line.split(':').nth(1).unwrap_or("0").trim().parse().ok())
                            .flatten()
                    })
                    .unwrap_or(0);
                let mut rest = vec![0u8; length];
                if length > 0 {
                    std::io::Read::read_exact(&mut stream, &mut rest).unwrap();
                }
                let body = r#"{"thinking":{"values":["low","high"],"default":"low"}}"#;
                let reply = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                std::io::Write::write_all(&mut stream, reply.as_bytes()).unwrap();
            }
        });
        let base = parse_base_url(
            &format!("http://127.0.0.1:{port}/v1"),
            crate::locale::Locale::English,
        )
        .unwrap();
        let answer =
            probe_capabilities(&base, None, "gpt-oss:20b", crate::locale::Locale::English).thinking;
        handle.join().unwrap();
        assert_eq!(
            answer,
            Thinking::Levels(vec!["low".to_string(), "high".to_string()])
        );
    }

    #[test]
    fn an_unreachable_server_leaves_the_model_unknown() {
        let base = parse_base_url("http://127.0.0.1:1/v1", crate::locale::Locale::English).unwrap();
        assert_eq!(
            probe_capabilities(&base, None, "x", crate::locale::Locale::English).thinking,
            Thinking::Unknown
        );
    }

    #[test]
    fn curl_post_keeps_the_key_out_of_argv_and_sends_json() {
        let cfg = curl_request_config(
            "POST",
            "https://ollama.com/api/show",
            Some("sk-abc"),
            Some(r#"{"model":"x"}"#),
        );
        assert!(cfg.contains("request = \"POST\""), "{cfg}");
        assert!(cfg.contains("data = "), "{cfg}");
        assert!(cfg.contains("model"), "{cfg}");
        assert!(cfg.contains("Authorization: Bearer sk-abc"), "{cfg}");
        assert!(cfg.contains("proto = \"=https\""), "{cfg}");
    }

    #[test]
    fn effort_summary_collapses_identical_levels() {
        let mut r = route("ollama", &["a", "b"]);
        let levels = ReasoningEffort::levels(&[("low", "low"), ("high", "high")]);
        for m in r.models.iter_mut() {
            m.reasoning_efforts = levels.clone();
        }
        assert_eq!(effort_summary(&r).as_deref(), Some("low, high"));
        r.models[1].reasoning_efforts.clear();
        assert_eq!(effort_summary(&r).as_deref(), Some("low, high"));
        r.models[0].reasoning_efforts.clear();
        assert_eq!(effort_summary(&r), None);
    }
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
        let p = parse_opencode_provider(&doc, "hai", crate::locale::Locale::English).unwrap();
        assert_eq!(p.base_url.as_deref(), Some("https://hai.test/v1"));
        assert_eq!(p.models.len(), 2);
        let m1 = &p.models[0];
        assert_eq!(m1.name.as_deref(), Some("M One"));
        assert_eq!(m1.context_window, Some(1000));
        assert_eq!(m1.max_tokens, Some(200));
        assert_eq!(m1.input, vec!["text", "image"]);
        assert!(parse_opencode_provider(&doc, "nope", crate::locale::Locale::English).is_err());
        let rendered = render_route(&route("hai", &["m1"]), 0, 2).join("\n");
        assert!(!rendered.contains("sk-secret"));
    }

    #[test]
    fn listings_in_openai_and_ollama_shapes() {
        let a = parse_listing(
            r#"{"data":[{"id":"m1"},{"id":"m2"},{"id":""}]}"#,
            crate::locale::Locale::English,
        )
        .unwrap();
        assert_eq!(
            a.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
            ["m1", "m2"]
        );
        let b = parse_listing(
            r#"{"models":[{"name":"llama3:latest"},{"model":"qwen"}]}"#,
            crate::locale::Locale::English,
        )
        .unwrap();
        assert_eq!(b.len(), 2);
        // A model that declares its endpoints is kept only when it serves Chat
        // Completions; a listing without the field is unchanged.
        let c = parse_listing(
            r#"{"data":[
                {"id":"openai/gpt-5","supported_endpoints":["/v1/chat/completions","/v1/responses"]},
                {"id":"claude-sonnet-4-6","supported_endpoints":["/v1/messages"]},
                {"id":"deepseek/deepseek-v4-flash","supported_endpoints":["chat/completions/"]},
                {"id":"plain-model"}
            ]}"#,
            crate::locale::Locale::English,
        )
        .unwrap();
        assert_eq!(
            c.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
            ["openai/gpt-5", "deepseek/deepseek-v4-flash", "plain-model"]
        );
        assert!(parse_listing("{}", crate::locale::Locale::English).is_err());
        assert!(parse_listing("nope", crate::locale::Locale::English).is_err());
    }

    #[test]
    fn chunked_bodies_decode() {
        let raw = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n6;x=1\r\n world\r\n0\r\n\r\n";
        assert_eq!(
            parse_http_response(raw, "u", crate::locale::Locale::English).unwrap(),
            "hello world"
        );
        let raw = b"HTTP/1.1 404 Not Found\r\n\r\n";
        assert!(parse_http_response(raw, "u", crate::locale::Locale::English).is_err());
    }

    #[test]
    fn chunked_bodies_reject_size_overflow() {
        for size in [usize::MAX, usize::MAX - 1, usize::MAX - 2] {
            let body = format!("{size:X}\r\nxx");
            assert_eq!(decode_chunked(body.as_bytes()), None);
            let raw = format!("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n{body}");
            assert!(
                parse_http_response(raw.as_bytes(), "u", crate::locale::Locale::English).is_err()
            );
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
        let b =
            parse_base_url("http://127.0.0.1:18080/v1/", crate::locale::Locale::English).unwrap();
        assert_eq!((b.https, b.port, b.path.as_str()), (false, 18080, "/v1"));
        assert_eq!(b.url, "http://127.0.0.1:18080/v1");
        assert!(
            parse_base_url("https://[::1]:8443/v1", crate::locale::Locale::English)
                .unwrap()
                .https
        );
        assert_eq!(
            parse_base_url("https://hai.test", crate::locale::Locale::English)
                .unwrap()
                .port,
            443
        );
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
            assert!(
                parse_base_url(bad, crate::locale::Locale::English).is_err(),
                "{bad:?} should be refused"
            );
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
        let out = apply_route(WITH_OTHER, &r, false, crate::locale::Locale::English).unwrap();
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
        let found = routes_in(&out.text, crate::locale::Locale::English);
        assert_eq!(found.len(), 2);
        assert_eq!(found[1].id, "hai");
        assert_eq!(found[1].api_key_env.as_deref(), Some("HAI_API_KEY"));
        assert_eq!(found[1].models, 1);
    }

    #[test]
    fn adding_twice_is_a_no_op_and_replace_rewrites_only_the_block() {
        let r = route("hai", &["m1"]);
        let once = apply_route(WITH_OTHER, &r, false, crate::locale::Locale::English)
            .unwrap()
            .text;
        let again = apply_route(&once, &r, false, crate::locale::Locale::English).unwrap();
        assert_eq!(again.change, Change::Exists);
        assert_eq!(again.text, once);
        let same = apply_route(&once, &r, true, crate::locale::Locale::English).unwrap();
        assert_eq!(same.change, Change::Identical);
        let r2 = route("hai", &["m1", "m2"]);
        let replaced = apply_route(&once, &r2, true, crate::locale::Locale::English).unwrap();
        assert_eq!(replaced.change, Change::Replaced);
        assert_eq!(
            routes_in(&replaced.text, crate::locale::Locale::English)[1].models,
            2
        );
        assert_eq!(replaced.text.matches("hai:").count(), 1);
        assert!(replaced.text.starts_with("# top comment\n"));
        assert!(replaced.text.ends_with("    model: x\n"));
        assert!(replaced.text.contains("      # between\n"));
    }

    #[test]
    fn a_second_route_does_not_disturb_the_first() {
        let a = apply_route(
            WITH_OTHER,
            &route("hai", &["m1"]),
            false,
            crate::locale::Locale::English,
        )
        .unwrap()
        .text;
        let b = apply_route(
            &a,
            &route("home-gpu", &["m9"]),
            false,
            crate::locale::Locale::English,
        )
        .unwrap()
        .text;
        let ids: Vec<String> = routes_in(&b, crate::locale::Locale::English)
            .into_iter()
            .map(|r| r.id)
            .collect();
        assert_eq!(ids, ["other", "hai", "home-gpu"]);
        assert!(b.contains("HOME_GPU_API_KEY"));
        assert!(b.starts_with(&a[..a.find("      # between").unwrap()]));
    }

    #[test]
    fn a_missing_entry_is_created() {
        let r = route("hai", &["m1"]);
        let fresh = apply_route("", &r, false, crate::locale::Locale::English)
            .unwrap()
            .text;
        assert!(fresh.starts_with("- id: llm-pi-ai\n  config:\n    providers:\n      hai:\n"));
        assert!(fresh.ends_with('\n'));
        let existing = "- id: agent-default-model\n  config:\n    provider: hai\n    model: m1\n";
        let out = apply_route(existing, &r, false, crate::locale::Locale::English)
            .unwrap()
            .text;
        assert!(out.starts_with(existing));
        assert_eq!(routes_in(&out, crate::locale::Locale::English).len(), 1);
        let comments_only =
            apply_route("# nothing yet\n", &r, false, crate::locale::Locale::English)
                .unwrap()
                .text;
        assert!(comments_only.starts_with("# nothing yet\n- id: llm-pi-ai"));
        // No final newline: one is added only after the appended entry.
        let no_nl = apply_route("- id: a\n  x: 1", &r, false, crate::locale::Locale::English)
            .unwrap()
            .text;
        assert!(no_nl.starts_with("- id: a\n  x: 1\n- id: llm-pi-ai"));
        assert!(no_nl.ends_with('\n'));
    }

    #[test]
    fn missing_levels_are_filled_in() {
        let r = route("hai", &["m1"]);
        let no_config = "- id: llm-pi-ai\n- id: next\n";
        let out = apply_route(no_config, &r, false, crate::locale::Locale::English)
            .unwrap()
            .text;
        assert!(out.starts_with("- id: llm-pi-ai\n  config:\n    providers:\n      hai:\n"));
        assert!(out.ends_with("- id: next\n"));
        let no_providers = "- id: llm-pi-ai\n  config:\n    other: 1\n- id: next\n";
        let out = apply_route(no_providers, &r, false, crate::locale::Locale::English)
            .unwrap()
            .text;
        assert!(out.contains("    other: 1\n    providers:\n      hai:\n"));
        assert_eq!(routes_in(&out, crate::locale::Locale::English)[0].id, "hai");
        let named = "- name: \"@deepseek-ai/dsh-llm-pi-ai\"\n  config:\n    providers:\n      a:\n        baseURL: http://x\n";
        let out = apply_route(named, &r, false, crate::locale::Locale::English)
            .unwrap()
            .text;
        assert_eq!(routes_in(&out, crate::locale::Locale::English).len(), 2);
    }

    #[test]
    fn crlf_files_keep_their_line_endings() {
        let text = WITH_OTHER.replace('\n', "\r\n");
        let out = apply_route(
            &text,
            &route("hai", &["m1"]),
            false,
            crate::locale::Locale::English,
        )
        .unwrap()
        .text;
        assert!(!out.replace("\r\n", "").contains('\n'));
        assert_eq!(routes_in(&out, crate::locale::Locale::English).len(), 2);
    }

    /// `config:` が `id:` より深い（有効な YAML だが `- ` 直下のキーではない）レイアウトは
    /// 解釈できないので refuse する。以前は同じエントリに2つ目の `config:` を追記し、
    /// YAML の重複マッピングキーを作って既存の providers を無言で無効化していた。
    #[test]
    fn deeper_config_indent_is_refused_instead_of_duplicated() {
        let text =
            "- id: llm-pi-ai\n   config:\n      providers:\n         r0:\n            baseURL: http://old\n";
        let err = apply_route(
            text,
            &route("hai", &["m1"]),
            false,
            crate::locale::Locale::English,
        )
        .unwrap_err()
        .to_string();
        assert!(err.contains("by hand"), "{err}");
        assert!(err.contains("- id: llm-pi-ai"), "{err}");
    }

    /// 期待カラムのキーがあるエントリには、これまでどおり config を足せる。
    #[test]
    fn sibling_keys_at_the_expected_column_still_get_config() {
        let text = "- id: llm-pi-ai\n  enabled: true\n- id: next\n";
        let out = apply_route(
            text,
            &route("hai", &["m1"]),
            false,
            crate::locale::Locale::English,
        )
        .unwrap()
        .text;
        assert!(
            out.contains("  enabled: true\n  config:\n    providers:\n      hai:\n"),
            "{out}"
        );
        assert_eq!(routes_in(&out, crate::locale::Locale::English).len(), 1);
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
            let err = apply_route(text, &r, false, crate::locale::Locale::English)
                .unwrap_err()
                .to_string();
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
            let out = apply_route(
                &text,
                &detailed_route(),
                false,
                crate::locale::Locale::English,
            )
            .unwrap()
            .text;
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
            let ids: Vec<String> = routes_in(&out, crate::locale::Locale::English)
                .into_iter()
                .map(|r| r.id)
                .collect();
            assert_eq!(ids, ["other", "hai"], "width {w}");
            assert!(out.ends_with("- id: next\n"));
            // Compat is beside models, in the same step.
            let mut sarashina = detailed_route();
            sarashina.compat = vec!["supportsStore: false".to_string()];
            let out = apply_route(&text, &sarashina, false, crate::locale::Locale::English)
                .unwrap()
                .text;
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
            let out = apply_route(
                &text,
                &route("hai", &["m1"]),
                false,
                crate::locale::Locale::English,
            )
            .unwrap()
            .text;
            assert!(out.starts_with(head), "{head}");
            assert_eq!(out.matches("llm-pi-ai").count(), 1, "{head}\n{out}");
            let ids: Vec<String> = routes_in(&out, crate::locale::Locale::English)
                .into_iter()
                .map(|r| r.id)
                .collect();
            assert_eq!(ids, ["other", "hai"], "{head}");
        }
        // The entry may also be named by the plugin and keep id elsewhere.
        let named = "- config:\n    providers: {}\n  name: '@deepseek-ai/dsh-llm-pi-ai' # x\n";
        assert!(apply_route(
            named,
            &route("hai", &["m1"]),
            false,
            crate::locale::Locale::English
        )
        .is_err());
    }

    #[test]
    fn ids_that_cannot_be_read_safely_are_refused_not_duplicated() {
        let r = route("hai", &["m1"]);
        for text in [
            "- id: |\n    llm-pi-ai\n  config:\n    providers:\n      a:\n        baseURL: http://x\n",
            "- {id: llm-pi-ai, config: {providers: {}}}\n",
            "- id: [llm-pi-ai]\n",
            "-\n  id: llm-pi-ai\n",
            "- id: \"llm\\x2gpi-ai\"\n  config:\n    providers:\n      a:\n        baseURL: http://x\n",
            "- id: llm-pi-ai\n  config:\n    providers:\n      a:\n        baseURL: http://x\n- id: llm-pi-ai\n  config:\n    providers:\n      b:\n        baseURL: http://y\n",
            "- id: [broken\n- id: llm-pi-ai\n",
        ] {
            let err = apply_route(text, &r, false, crate::locale::Locale::English).unwrap_err().to_string();
            assert!(err.contains("by hand"), "{text:?}: {err}");
        }
    }

    #[test]
    fn other_providers_survive_every_add() {
        let text = "- id: llm-pi-ai # keep\n  config:\n    providers:\n      a:\n        baseURL: http://a\n        models:\n          - id: a1\n      b:\n        baseURL: http://b\n- id: z\n";
        let once = apply_route(
            text,
            &route("hai", &["m1"]),
            false,
            crate::locale::Locale::English,
        )
        .unwrap()
        .text;
        let twice = apply_route(
            &once,
            &route("home", &["m2"]),
            false,
            crate::locale::Locale::English,
        )
        .unwrap()
        .text;
        let ids: Vec<String> = routes_in(&twice, crate::locale::Locale::English)
            .into_iter()
            .map(|r| r.id)
            .collect();
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
        for text in [nested, with_entry] {
            let err = apply_route(
                text,
                &route("hai", &["m1"]),
                false,
                crate::locale::Locale::English,
            )
            .unwrap_err()
            .to_string();
            assert!(err.contains("by hand"), "{text:?}: {err}");
        }
        // Direct plugin identities determine the target; these are scalar values.
        for text in [deeper, other_entry] {
            let out = apply_route(
                text,
                &route("hai", &["m1"]),
                false,
                crate::locale::Locale::English,
            )
            .unwrap();
            assert!(out.text.contains("note: llm-pi-ai") || out.text.contains("use: llm-pi-ai"));
            assert!(routes_in(&out.text, crate::locale::Locale::English)
                .iter()
                .any(|item| item.id == "hai"));
        }
        // Comments do not count as a mention.
        let commented = "# llm-pi-ai goes here\n- id: x\n";
        assert!(apply_route(
            commented,
            &route("hai", &["m1"]),
            false,
            crate::locale::Locale::English
        )
        .is_ok());
    }

    #[test]
    fn escaped_nested_ids_are_refused_with_the_file_unchanged() {
        let route = route("hai", &["m1"]);
        for id in [
            r#""llm\u002dpi-ai""#,
            r#""llm\x2dpi-ai""#,
            r#""llm\U0000002dpi-ai""#,
            r#""\x6c\x6cm-pi-ai""#,
            r#""llm-pi-ai""#,
        ] {
            let text = format!(
                "- insert:\n    - id: {id}\n      config:\n        providers:\n          other:\n            baseURL: http://o\n  config:\n    unrelated: 1\n"
            );
            let err = apply_route(&text, &route, false, crate::locale::Locale::English)
                .unwrap_err()
                .to_string();
            assert!(err.contains("by hand"), "{id}: {err}");
        }
    }

    #[test]
    fn an_escaped_top_level_id_is_the_existing_entry() {
        let route = route("hai", &["m1"]);
        for id in [
            r#""llm\u002dpi-ai""#,
            r#""llm\x2dpi-ai""#,
            r#""llm\U0000002dpi-ai""#,
        ] {
            let text = format!(
                "- id: {id}\n  config:\n    providers:\n      other:\n        baseURL: http://o\n"
            );
            let out = apply_route(&text, &route, false, crate::locale::Locale::English)
                .unwrap()
                .text;
            assert!(
                out.contains("other:") && out.contains("hai:"),
                "{id}\n{out}"
            );
            assert_eq!(
                out.lines().filter(|l| l.starts_with("- id:")).count(),
                1,
                "{id}\n{out}"
            );
        }
        let escaped_key = "- \"i\\x64\": llm-pi-ai\n  config:\n    providers:\n      other:\n        baseURL: http://o\n";
        let out = apply_route(escaped_key, &route, false, crate::locale::Locale::English)
            .unwrap()
            .text;
        assert!(out.contains("other:") && out.contains("hai:"), "{out}");
        assert_eq!(out.matches("llm-pi-ai").count(), 1, "{out}");
    }

    #[test]
    fn anchors_aliases_tags_and_flow_collections_are_refused() {
        let route = route("hai", &["m1"]);
        for text in [
            "- id: &x llm-pi-ai\n  config:\n    providers:\n      a:\n        baseURL: http://a\n",
            "- insert:\n    - id: *x\n      config:\n        providers:\n          other:\n            baseURL: http://o\n",
            "- id: x\n  name: !!str y\n",
            "- id: x\n  anchor: &x\n    id: y\n",
            "- id: x\n  items: [{id: y}]\n",
            "- id: x\n  items: {id: y}\n",
            "- id: x\n  items: [a: b]\n",
            "- id: x\n  items: [a,\n    b]\n",
        ] {
            let err = apply_route(text, &route, false, crate::locale::Locale::English).unwrap_err().to_string();
            assert!(err.contains("by hand"), "{text:?}: {err}");
        }
        // Plain scalars with these characters inside, comments, block bodies and
        // flow sequences of plain scalars are fine.
        let fine = "- id: x\n  url: http://h/?a=1&b=2\n  mark: a*b # *x &y !z\n  list: [a, b]\n  empty: {}\n  text: |\n    *x &y !z [{\n  other: 'it''s'\n";
        assert!(apply_route(fine, &route, false, crate::locale::Locale::English).is_ok());
    }

    #[test]
    fn invalid_escapes_and_multiline_quotes_are_refused() {
        let route = route("hai", &["m1"]);
        for text in [
            "- id: llm-pi-ai\n  config:\n    providers:\n      a:\n        baseURL: http://a\n  note: \"bad \\q\"\n",
            "- id: \"llm\\u00zzpi-ai\"\n",
            "- id: \"llm\\x2\"\n",
            "- id: x\n  note: \"folded\n    text\"\n",
            "- id: x\n  note: \"ends with \\\n    escape\"\n",
        ] {
            let err = apply_route(text, &route, false, crate::locale::Locale::English).unwrap_err().to_string();
            assert!(err.contains("by hand"), "{text:?}: {err}");
        }
    }

    #[test]
    fn yaml_double_quoted_escapes_decode() {
        assert_eq!(
            decode_double(
                r#"\0\a\b\t\n\v\f\r\e\ \"\/\\\N\_\L\P\x41\u0042\U00000043"#,
                crate::locale::Locale::English
            )
            .unwrap(),
            "\0\u{7}\u{8}\t\n\u{b}\u{c}\r\u{1b} \"/\\\u{85}\u{a0}\u{2028}\u{2029}ABC"
        );
        for bad in [r"\q", r"\x4", r"\uD800", r"\U00110000", "\\"] {
            assert!(
                decode_double(bad, crate::locale::Locale::English).is_err(),
                "{bad}"
            );
        }
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
            let out = apply_route(
                &text,
                &route("hai", &["m1"]),
                false,
                crate::locale::Locale::English,
            )
            .unwrap_or_else(|e| panic!("{head}: {e}"))
            .text;
            assert_eq!(out.matches("llm-pi-ai").count(), 1, "{head}\n{out}");
            let ids: Vec<String> = routes_in(&out, crate::locale::Locale::English)
                .into_iter()
                .map(|r| r.id)
                .collect();
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
            let out = apply_route(
                text,
                &detailed_route(),
                false,
                crate::locale::Locale::English,
            )
            .unwrap_or_else(|e| panic!("{text:?}: {e}"))
            .text;
            let ids: Vec<String> = routes_in(&out, crate::locale::Locale::English)
                .into_iter()
                .map(|r| r.id)
                .collect();
            assert_eq!(ids, ["hai"], "{text:?}\n{out}");
        }
    }

    #[test]
    fn read_back_rejects_a_lost_route_or_misaligned_keys() {
        let r = route("hai", &["m1"]);
        let before = routes_in(WITH_OTHER, crate::locale::Locale::English);
        let good = apply_route(WITH_OTHER, &r, false, crate::locale::Locale::English)
            .unwrap()
            .text;
        assert!(verify_written(&before, &good, &r, crate::locale::Locale::English).is_ok());
        // The existing route vanished.
        let lost = good.replace("      other:", "      other_:");
        assert!(
            verify_written(&before, &lost, &r, crate::locale::Locale::English)
                .unwrap_err()
                .contains("other")
        );
        // A model key drifts out of line with its `- id`.
        let drift = good.replace(
            "          - id: m1\n",
            "          - id: m1\n              name: M\n",
        );
        assert!(
            verify_written(&before, &drift, &r, crate::locale::Locale::English)
                .unwrap_err()
                .contains("aligned")
        );
        // A second llm-pi-ai entry.
        let dup = format!("{good}- id: llm-pi-ai\n  config: {{}}\n");
        assert!(verify_written(&before, &dup, &r, crate::locale::Locale::English).is_err());
    }

    #[test]
    fn a_quoted_existing_key_is_found() {
        let text = "- id: llm-pi-ai\n  config:\n    providers:\n      \"hai\":\n        baseURL: http://x\n";
        let out = apply_route(
            text,
            &route("hai", &["m1"]),
            false,
            crate::locale::Locale::English,
        )
        .unwrap();
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
        assert!(apply_preset_models(p, &mut models, crate::locale::Locale::English).is_empty());
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

        let once = apply_route(
            WITH_OTHER,
            &sarashina_route(models.clone()),
            false,
            crate::locale::Locale::English,
        )
        .unwrap()
        .text;
        assert_eq!(
            routes_in(&once, crate::locale::Locale::English)[1].models,
            2
        );
        // A stale hand-edited compat is dropped by --replace.
        let stale = once.replace(
            "supportsStore: false",
            "supportsStore: true\n          extra: 1",
        );
        let fixed = apply_route(
            &stale,
            &sarashina_route(models),
            true,
            crate::locale::Locale::English,
        )
        .unwrap();
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
        let notes = apply_preset_models(p, &mut models, crate::locale::Locale::English);
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
        apply_preset_models(p, &mut small, crate::locale::Locale::English);
        assert_eq!(small[0].max_tokens, Some(1000));
        // Presets without knowledge leave models alone.
        let mut hai = model_ids(&["m"]);
        assert!(apply_preset_models(
            preset("hai").unwrap(),
            &mut hai,
            crate::locale::Locale::English
        )
        .is_empty());
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
    fn commandcode_preset_facts() {
        let p = preset("commandcode").unwrap();
        assert_eq!(p.display_name, "Command Code");
        assert_eq!(p.base_url, Some("https://api.commandcode.ai/provider/v1"));
        assert_eq!(route_key_env(p.id), "COMMANDCODE_API_KEY");
        assert!(p.supports_discovery);
        assert!(p.default_models.is_empty());
        assert!(p.compat.is_empty());
        assert_eq!(p.max_tokens_cap, None);
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
                effort: None,
                no_probe: true,
                input: None,
                replace: false,
                quiet: false,
                dry_run: true,
                json: false,
            },
            "tui",
            crate::locale::Locale::English,
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
