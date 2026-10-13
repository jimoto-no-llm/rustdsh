//! Keep a provider's model list in step with the provider's own catalog.
//!
//! DeepSeek Harness answers "which models can this provider serve?" for a
//! provider it ships a catalog for from the catalog bundled in its
//! `@earendil-works/pi-ai` dependency. That file is generated when the package
//! is published, so anything the provider changes afterwards is invisible:
//! Codex's `gpt-6.1-sol` was missing from the harness entirely, and Kimi Code's
//! stable `kimi-for-coding` id had been upgraded in place to "K2.8 Preview"
//! while the harness — and even pi-ai 1.2.0 — still carried the old name. A
//! profile that lists `models:` for the route also *replaces* the bundled
//! catalog, so whatever the provider says has to be named there by hand.
//!
//! This module closes that gap from the provider side. Two sources are known:
//!
//! * `openai-codex` — the catalog the local Codex CLI already maintains
//!   (`codex debug models`, falling back to `~/.codex/models_cache.json`).
//!   Entries are only *added*: the CLI's display-name style differs from the
//!   profile's, so an existing entry keeps the name it has.
//! * `kimi-coding` — the provider's own listing endpoint
//!   (`GET https://api.kimi.com/coding/v1/models`) read with the profile's API
//!   key. That listing is the only place the current display name lives, so an
//!   existing entry's `name:` is refreshed from it.
//!
//! In both cases nothing is ever deleted, every other byte of the profile is
//! preserved, an up-to-date profile is not rewritten, and a profile whose
//! structure this module does not recognize is refused instead of rewritten.
//!
//! Upstream reference: `packages/llm/llm-pi-ai` in deepseek-ai/deepseek-harness
//! (`resolveRouteModels` replaces the catalog with a configured `models` list;
//! `discoverModels` answers catalog providers from pi-ai without a network
//! call, which is why a provider's live listing never reaches the picker).

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use anyhow::{bail, Context, Result};
use serde_json::{json, Value};

use crate::file_lock::CredentialFileLock;
use crate::inspect::dsh_home;

/// Provider route served by the local Codex CLI catalog.
pub(crate) const CODEX_PROVIDER: &str = "openai-codex";
/// Provider route served by its own listing endpoint.
pub(crate) const KIMI_PROVIDER: &str = "kimi-coding";
/// Output cap used when the profile has no sibling entry to borrow one from.
/// pi-ai's own Codex catalog declares 128000 for every model it ships.
const DEFAULT_MAX_TOKENS: u64 = 128_000;
/// Thinking levels the harness accepts, in its escalation order. A level the
/// provider advertises but this list does not name is left out rather than
/// mapped onto a level the harness would refuse.
const HARNESS_LEVELS: &[&str] = &["off", "minimal", "low", "medium", "high", "xhigh", "max"];
/// Modalities the harness can carry; anything else is dropped.
const HARNESS_MODALITIES: &[&str] = &["text", "image"];
/// A catalog larger than this is refused rather than buffered.
const MAX_CATALOG_BYTES: usize = 8 * 1024 * 1024;
/// Wall-clock bound handed to curl for one listing request.
const LISTING_TIMEOUT_SECONDS: u64 = 30;

/// One model a provider advertises, in the shape a harness `models:` entry
/// needs. `max_tokens` is filled per profile (see [`plan_profile`]).
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

/// One provider whose catalog this module knows how to read.
struct CatalogSource {
    provider: &'static str,
    kind: SourceKind,
}

enum SourceKind {
    /// `codex debug models`, falling back to `~/.codex/models_cache.json`.
    CodexCli,
    /// The provider's own listing endpoint, read with the profile's API key.
    Live(LiveEndpoint),
}

struct LiveEndpoint {
    base_url: &'static str,
    path: &'static str,
    /// Header that carries the credential.
    key_header: &'static str,
    extra_headers: &'static [(&'static str, &'static str)],
}

/// Every provider this module can synchronize. A provider a profile does not
/// configure is skipped, so the table can grow without changing behavior.
const SOURCES: &[CatalogSource] = &[
    CatalogSource {
        provider: CODEX_PROVIDER,
        kind: SourceKind::CodexCli,
    },
    CatalogSource {
        provider: KIMI_PROVIDER,
        kind: SourceKind::Live(LiveEndpoint {
            base_url: "https://api.kimi.com/coding",
            path: "/v1/models?limit=1000",
            key_header: "x-api-key",
            extra_headers: &[("anthropic-version", "2023-06-01")],
        }),
    },
];

/// One `name:` line the provider's catalog has moved on from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Rename {
    pub id: String,
    pub from: String,
    pub to: String,
}

/// The result of folding one provider's catalog into one profile.
#[derive(Debug)]
pub(crate) struct Applied {
    pub text: String,
    /// Ids the profile carried before the fold, in file order.
    pub listed: Vec<String>,
    pub added: Vec<String>,
    pub renamed: Vec<Rename>,
}

/// Read every candidate model from one Codex `debug models` document.
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
        out.push(CatalogModel {
            id: id.to_string(),
            name: name.to_string(),
            context_window,
            max_tokens,
            input: modalities_from(
                entry
                    .get("input_modalities")
                    .and_then(Value::as_array)
                    .map(|modalities| modalities.iter().filter_map(Value::as_str).collect()),
                entry.get("supports_image_in").and_then(Value::as_bool),
            ),
            efforts: advertised_levels(efforts_from(
                entry.get("supported_reasoning_levels"),
                entry.get("think_efforts"),
            )),
        });
    }
    out
}

/// Read every candidate model from one provider listing document
/// (`GET {base}/v1/models`): the shape DSH's own discovery parser reads, plus
/// the reasoning-effort map Kimi Code publishes.
pub(crate) fn catalog_from_listing(doc: &Value, max_tokens: u64) -> Vec<CatalogModel> {
    let Some(entries) = doc.get("data").and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in entries {
        let Some(id) = entry.get("id").and_then(Value::as_str) else {
            continue;
        };
        if id.is_empty() || id.chars().any(char::is_whitespace) {
            continue;
        }
        let context_window = entry
            .get("context_length")
            .and_then(Value::as_u64)
            .or_else(|| {
                entry
                    .get("limit")
                    .and_then(|limit| limit.get("context"))
                    .and_then(Value::as_u64)
            })
            .filter(|value| *value > 0);
        let Some(context_window) = context_window else {
            continue;
        };
        let name = entry
            .get("display_name")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .unwrap_or(id);
        out.push(CatalogModel {
            id: id.to_string(),
            name: name.to_string(),
            context_window,
            max_tokens,
            input: modalities_from(
                entry
                    .get("modalities")
                    .and_then(|modalities| modalities.get("input"))
                    .and_then(Value::as_array)
                    .map(|modalities| modalities.iter().filter_map(Value::as_str).collect()),
                entry.get("supports_image_in").and_then(Value::as_bool),
            ),
            efforts: advertised_levels(efforts_from(
                entry
                    .get("reasoning")
                    .and_then(|reasoning| reasoning.get("effort"))
                    .and_then(|effort| effort.get("valid")),
                entry.get("think_efforts"),
            )),
        });
    }
    out
}

/// A provider's reasoning efforts reduced to levels the harness understands,
/// in the harness's own escalation order.
fn advertised_levels(advertised: Vec<&str>) -> Vec<String> {
    HARNESS_LEVELS
        .iter()
        .filter(|level| **level != "off" && advertised.contains(level))
        .map(|level| (*level).to_string())
        .collect()
}

/// The reasoning levels a document names, accepting every spelling seen in the
/// wild: `["low", …]`, `[{"effort": "low"}, …]`, and `valid_efforts`.
fn efforts_from<'a>(levels: Option<&'a Value>, think: Option<&'a Value>) -> Vec<&'a str> {
    if let Some(list) = levels.and_then(Value::as_array) {
        let named: Vec<&str> = list
            .iter()
            .filter_map(|level| {
                level
                    .as_str()
                    .or_else(|| level.get("effort").and_then(Value::as_str))
            })
            .collect();
        if !named.is_empty() {
            return named;
        }
    }
    think
        .and_then(|think| think.get("valid_efforts"))
        .and_then(Value::as_array)
        .map(|levels| levels.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default()
}

/// Input modalities reduced to what the harness can carry, defaulting to text.
fn modalities_from(named: Option<Vec<&str>>, supports_image: Option<bool>) -> Vec<String> {
    let mut input: Vec<String> = named
        .unwrap_or_default()
        .into_iter()
        .filter(|m| HARNESS_MODALITIES.contains(m))
        .map(str::to_string)
        .collect();
    if input.is_empty() {
        input.push("text".to_string());
        if supports_image == Some(true) {
            input.push("image".to_string());
        }
    }
    input
}

/// One provider's catalog, plus the label describing where it came from.
struct Fetched {
    models: Vec<CatalogModel>,
    label: String,
}

/// Read one provider's catalog for one profile. A live listing needs the
/// profile's own API key, so it is resolved per profile rather than once.
fn fetch_catalog(source: &CatalogSource, profile_text: &str) -> Result<Fetched> {
    match &source.kind {
        SourceKind::CodexCli => codex_catalog(DEFAULT_MAX_TOKENS),
        SourceKind::Live(endpoint) => {
            let lines: Vec<String> = profile_text.lines().map(str::to_string).collect();
            let site = locate_owned(&lines, source.provider)?;
            let key_env = scalar_in(&lines, &site, "apiKeyEnv").ok_or_else(|| {
                anyhow::anyhow!(
                    "the {} block has no apiKeyEnv: entry, so its listing cannot be read (the subscription login is not used to list)",
                    source.provider
                )
            })?;
            let key = credential_ref(&key_env)
                .or_else(|| std::env::var(&key_env).ok().filter(|v| !v.trim().is_empty()))
                .ok_or_else(|| {
                    anyhow::anyhow!(
                        "no credential for {key_env}: store it (`rdsh auth --import --ref {key_env}`) or export it"
                    )
                })?;
            let base = scalar_in(&lines, &site, "baseURL")
                .unwrap_or_else(|| endpoint.base_url.to_string());
            let url = format!("{}{}", base.trim_end_matches('/'), endpoint.path);
            let body = curl_json(endpoint, &url, &key)?;
            let doc: Value = serde_json::from_str(&body)
                .with_context(|| format!("{url} did not answer with a JSON model listing"))?;
            let models = catalog_from_listing(&doc, DEFAULT_MAX_TOKENS);
            if models.is_empty() {
                bail!("{url} lists no selectable {} model", source.provider);
            }
            Ok(Fetched { models, label: url })
        }
    }
}

/// The local Codex catalog and the label describing where it came from.
///
/// `codex debug models` is authoritative and account-aware; the app's cache
/// file carries the same document for installs where the CLI is not on `PATH`.
fn codex_catalog(max_tokens: u64) -> Result<Fetched> {
    if let Some(text) = codex_cli_catalog() {
        if let Ok(doc) = serde_json::from_str::<Value>(&text) {
            let models = catalog_from_json(&doc, max_tokens);
            if !models.is_empty() {
                return Ok(Fetched {
                    models,
                    label: "codex debug models".to_string(),
                });
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
    Ok(Fetched {
        models,
        label: path,
    })
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

/// The curl config file that describes one listing request. The credential
/// travels here, on stdin, rather than in argv.
fn curl_config(endpoint: &LiveEndpoint, url: &str, key: &str) -> String {
    let mut config = String::new();
    config.push_str(&format!("url = {}\n", curl_quote(url)));
    config.push_str(&format!(
        "header = {}\n",
        curl_quote(&format!("{}: {}", endpoint.key_header, key))
    ));
    for (name, value) in endpoint.extra_headers {
        config.push_str(&format!(
            "header = {}\n",
            curl_quote(&format!("{name}: {value}"))
        ));
    }
    config.push_str("header = \"accept: application/json\"\n");
    config.push_str("silent\nshow-error\n");
    config.push_str("proto = \"=https\"\nproto-redir = \"=https\"\n");
    config.push_str(&format!(
        "max-time = {LISTING_TIMEOUT_SECONDS}\nconnect-timeout = 10\n"
    ));
    config
}

/// Read one listing endpoint with curl, keeping the credential out of argv.
///
/// The request is described in a curl config file on stdin, so the API key
/// never reaches the process list, and the transfer is pinned to HTTPS so a
/// redirect cannot downgrade it. Stdout is read with the same size ceiling the
/// parser assumes.
fn curl_json(endpoint: &LiveEndpoint, url: &str, key: &str) -> Result<String> {
    let config = curl_config(endpoint, url, key);
    let mut child = Command::new("curl")
        .arg("--config")
        .arg("-")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .context("could not run curl; install it, or enter this provider's models by hand")?;
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
            if body.len() + read > MAX_CATALOG_BYTES {
                let _ = child.kill();
                bail!("{url} answered with more than {MAX_CATALOG_BYTES} bytes");
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
        bail!(
            "curl failed for {url} ({}): {}",
            status,
            message.trim().replace(key, "<redacted>")
        );
    }
    String::from_utf8(body).with_context(|| format!("{url} did not answer with UTF-8"))
}

/// Quote one curl config value. curl's config parser reads a double-quoted
/// string with backslash escapes, so both characters are escaped.
fn curl_quote(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

/// The value of one scalar key inside a provider block.
fn scalar_in(lines: &[String], site: &Site, key: &str) -> Option<String> {
    let index = find_key(lines, site.provider_line + 1, site.provider_end, key)?;
    let value = lines[index].trim_start().strip_prefix(key)?.trim_start();
    let value = value.strip_prefix(':')?.trim();
    (!value.is_empty()).then(|| unquote(value))
}

/// Read one `refs:` entry from the credentials document.
fn credential_ref(name: &str) -> Option<String> {
    let path = format!("{}/.credentials.yaml", dsh_home());
    let text = std::fs::read_to_string(path).ok()?;
    let mut in_refs = false;
    for line in text.lines() {
        let trimmed = line.trim_end();
        if !in_refs {
            in_refs = trimmed == "refs:";
            continue;
        }
        if !trimmed.trim().is_empty() && indent_of(trimmed) == 0 {
            break;
        }
        if indent_of(trimmed) != 2 {
            continue;
        }
        let Some((key, value)) = trimmed.trim().split_once(':') else {
            continue;
        };
        if key == name {
            let value = unquote(value);
            if !value.is_empty() {
                return Some(value);
            }
        }
    }
    None
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

/// The providers named by `--provider`, or every known source.
fn selected_sources(provider: Option<&str>) -> Result<Vec<&'static CatalogSource>> {
    match provider {
        None => Ok(SOURCES.iter().collect()),
        Some(name) => {
            let found: Vec<&CatalogSource> = SOURCES
                .iter()
                .filter(|source| source.provider == name)
                .collect();
            if found.is_empty() {
                let known: Vec<&str> = SOURCES.iter().map(|s| s.provider).collect();
                bail!(
                    "no catalog source for provider \"{name}\"; this build reads {}",
                    known.join(", ")
                );
            }
            Ok(found)
        }
    }
}

/// Whether a profile configures a provider at all. A provider a profile does
/// not name is not this command's business, so it is not reported.
fn configures(text: &str, provider: &str) -> bool {
    text.lines()
        .any(|line| line.trim_start().starts_with(&format!("{provider}:")))
}

/// Read one profile and fold one provider's catalog into it.
///
/// `refresh_names` is set for live listings, whose display names are the
/// provider's current ones; the Codex CLI's hyphenated names are not imposed on
/// entries a person already named.
pub(crate) fn apply_profile(
    text: &str,
    provider: &str,
    catalog: &[CatalogModel],
    refresh_names: bool,
) -> Result<Applied> {
    let mut lines: Vec<String> = text.lines().map(str::to_string).collect();
    let site = locate_owned(&lines, provider)?;
    let listed = existing_ids(&lines, &site);
    let max_tokens = existing_max_tokens(&lines, &site).unwrap_or(DEFAULT_MAX_TOKENS);
    let missing: Vec<CatalogModel> = catalog
        .iter()
        .filter(|model| !listed.contains(&model.id))
        .map(|model| CatalogModel {
            max_tokens,
            ..model.clone()
        })
        .collect();
    let renamed = if refresh_names {
        plan_renames(&lines, &site, catalog)
    } else {
        Vec::new()
    };
    if missing.is_empty() && renamed.is_empty() {
        return Ok(Applied {
            text: text.to_string(),
            listed,
            added: Vec::new(),
            renamed,
        });
    }

    for rename in &renamed {
        if let Some(index) = name_line(&lines, &site, &rename.id) {
            lines[index] = format!(
                "{}name: {}",
                " ".repeat(indent_of(&lines[index])),
                yaml_scalar(&rename.to)
            );
        }
    }
    let added: Vec<String> = missing.iter().map(|model| model.id.clone()).collect();
    let block: Vec<String> = missing
        .iter()
        .flat_map(|model| format_model(model, site.item_indent, site.step))
        .collect();
    if let Some(models_line) = site.models_line {
        if lines[models_line].trim_end().ends_with("[]") {
            // `models: []` is an inline empty sequence: give it a body.
            lines[models_line] = format!("{}models:", " ".repeat(site.models_indent));
            lines.splice(models_line + 1..models_line + 1, block);
            return Ok(Applied {
                text: join(lines, text),
                listed,
                added,
                renamed,
            });
        }
    }
    match site.models_line {
        Some(models_line) => {
            let insert_at = last_item_end(&lines, &site).unwrap_or(models_line + 1);
            lines.splice(insert_at..insert_at, block);
        }
        None => {
            // The provider block carries no models list yet: append the new
            // list after its last existing key.
            let insert_at = (site.provider_line + 1..site.provider_end)
                .rfind(|i| !lines[*i].trim().is_empty())
                .map(|i| i + 1)
                .unwrap_or(site.provider_line + 1);
            let mut header = vec![format!("{}models:", " ".repeat(site.models_indent))];
            header.extend(block);
            lines.splice(insert_at..insert_at, header);
        }
    }
    Ok(Applied {
        text: join(lines, text),
        listed,
        added,
        renamed,
    })
}

fn join(lines: Vec<String>, original: &str) -> String {
    let mut text = lines.join("\n");
    if original.ends_with('\n') {
        text.push('\n');
    }
    text
}

/// One profile's provider section, located by line index.
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

/// The item line that carries `id: <wanted>`.
fn item_line(lines: &[String], site: &Site, wanted: &str) -> Option<usize> {
    let models_line = site.models_line?;
    let end = site.models_end.min(lines.len());
    (models_line + 1..end).find(|i| {
        indent_of(&lines[*i]) == site.item_indent
            && lines[*i].trim_start().starts_with("- ")
            && inline_id(&lines[*i]).as_deref() == Some(wanted)
    })
}

/// The `name:` line inside one model item.
fn name_line(lines: &[String], site: &Site, wanted: &str) -> Option<usize> {
    let item = item_line(lines, site, wanted)?;
    let end = block_end(lines, item);
    find_key(lines, item + 1, end, "name")
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

/// Existing entries whose `name:` the provider's catalog has moved on from.
fn plan_renames(lines: &[String], site: &Site, catalog: &[CatalogModel]) -> Vec<Rename> {
    let mut out = Vec::new();
    for id in existing_ids(lines, site) {
        let Some(model) = catalog.iter().find(|model| model.id == id) else {
            continue;
        };
        let Some(index) = name_line(lines, site, &id) else {
            continue;
        };
        let current = unquote(
            lines[index]
                .trim_start()
                .strip_prefix("name")
                .and_then(|rest| rest.strip_prefix(':'))
                .unwrap_or("")
                .trim(),
        );
        if current != model.name && !name_already_current(&current, &model.name) {
            out.push(Rename {
                id,
                from: current,
                to: model.name.clone(),
            });
        }
    }
    out
}

/// Whether an existing name already carries the provider's current one.
///
/// "Kimi K3" and "Kimi K3-256K" already say what the listing's "K3" and
/// "K3-256k" say, so renaming them would only churn a person's own wording.
/// A placeholder ("kimi-for-coding") or a retired product name ("Kimi For
/// Coding HighSpeed" for "K2.7 Code Highspeed") does not, and is refreshed.
fn name_already_current(current: &str, live: &str) -> bool {
    let normalise = |value: &str| -> String {
        value
            .chars()
            .filter(char::is_ascii_alphanumeric)
            .flat_map(char::to_lowercase)
            .collect()
    };
    let live = normalise(live);
    !live.is_empty() && normalise(current).contains(&live)
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

/// What one provider did to one profile, for the human and JSON reports.
struct ProviderReport {
    profile: String,
    provider: String,
    source: String,
    listed: Vec<String>,
    added: Vec<String>,
    renamed: Vec<Rename>,
    written: bool,
    skipped: Option<String>,
    error: Option<String>,
}

impl ProviderReport {
    fn pending(profile: &str, provider: &str) -> Self {
        Self {
            profile: profile.to_string(),
            provider: provider.to_string(),
            source: String::new(),
            listed: Vec::new(),
            added: Vec::new(),
            renamed: Vec::new(),
            written: false,
            skipped: None,
            error: None,
        }
    }

    fn changed(&self) -> bool {
        !self.added.is_empty() || !self.renamed.is_empty()
    }

    fn to_json(&self) -> Value {
        json!({
            "profile": self.profile,
            "provider": self.provider,
            "source": self.source,
            "listed": self.listed,
            "added": self.added,
            "renamed": self.renamed.iter().map(|rename| json!({
                "id": rename.id,
                "from": rename.from,
                "to": rename.to,
            })).collect::<Vec<_>>(),
            "written": self.written,
            "skipped": self.skipped,
            "error": self.error,
        })
    }
}

fn render_renames(renames: &[Rename]) -> String {
    renames
        .iter()
        .map(|rename| format!("{} -> {}", rename.from, rename.to))
        .collect::<Vec<_>>()
        .join(", ")
}

/// `rdsh models`: report what each profile is missing, writing nothing.
pub(crate) fn cmd_models_show(
    profile: Option<&str>,
    provider: Option<&str>,
    json: bool,
) -> Result<()> {
    let sources = selected_sources(provider)?;
    let profiles = profile_paths(profile)?;
    let mut reports = Vec::new();
    for (name, path) in &profiles {
        let text = std::fs::read_to_string(path)
            .with_context(|| format!("cannot read {}", path.display()))?;
        for source in &sources {
            if !configures(&text, source.provider) {
                continue;
            }
            let mut report = ProviderReport::pending(name, source.provider);
            match fetch_catalog(source, &text) {
                Ok(fetched) => {
                    report.source = fetched.label;
                    let refresh_names = matches!(source.kind, SourceKind::Live(_));
                    match apply_profile(&text, source.provider, &fetched.models, refresh_names) {
                        Ok(applied) => {
                            report.listed = applied.listed;
                            report.added = applied.added;
                            report.renamed = applied.renamed;
                        }
                        Err(error) => report.skipped = Some(format!("{error:#}")),
                    }
                }
                Err(error) => report.skipped = Some(format!("{error:#}")),
            }
            reports.push(report);
        }
    }
    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&json!({
                "profiles": reports.iter().map(ProviderReport::to_json).collect::<Vec<_>>(),
            }))?
        );
        return Ok(());
    }
    use std::io::Write as _;
    let _ = writeln!(std::io::stdout(), "[rdsh models]");
    for report in &reports {
        let label = format!("{} {}", report.profile, report.provider);
        if let Some(skipped) = &report.skipped {
            let _ = writeln!(std::io::stdout(), "  {label}  skipped: {skipped}");
        } else if report.changed() {
            let mut parts = Vec::new();
            if !report.added.is_empty() {
                parts.push(format!(
                    "missing {}: {}",
                    report.added.len(),
                    report.added.join(", ")
                ));
            }
            if !report.renamed.is_empty() {
                parts.push(format!("stale names: {}", render_renames(&report.renamed)));
            }
            let _ = writeln!(std::io::stdout(), "  {label}  {}", parts.join("; "));
        } else {
            let _ = writeln!(
                std::io::stdout(),
                "  {label}  up to date ({} listed) · {}",
                report.listed.len(),
                report.source
            );
        }
    }
    let _ = writeln!(std::io::stdout(), "[rdsh] apply with: rdsh models sync");
    Ok(())
}

/// `rdsh models sync`: append missing entries and refresh stale names, or
/// preview with `--dry-run`.
pub(crate) fn cmd_models_sync(
    profile: Option<&str>,
    provider: Option<&str>,
    dry_run: bool,
    json: bool,
) -> Result<()> {
    let sources = selected_sources(provider)?;
    let profiles = profile_paths(profile)?;
    let mut reports = Vec::new();
    for (name, path) in &profiles {
        let mut text = match std::fs::read_to_string(path) {
            Ok(text) => text,
            Err(error) => {
                // Which providers it names cannot be known without the file,
                // so every selected source reports the read failure.
                for source in &sources {
                    let mut report = ProviderReport::pending(name, source.provider);
                    report.skipped = Some(format!("cannot read {}: {error}", path.display()));
                    reports.push(report);
                }
                continue;
            }
        };
        let mut dirty = false;
        let mut pending: Vec<ProviderReport> = Vec::new();
        for source in &sources {
            if !configures(&text, source.provider) {
                continue;
            }
            let mut report = ProviderReport::pending(name, source.provider);
            match fetch_catalog(source, &text) {
                Ok(fetched) => {
                    report.source = fetched.label;
                    let refresh_names = matches!(source.kind, SourceKind::Live(_));
                    match apply_profile(&text, source.provider, &fetched.models, refresh_names) {
                        Ok(applied) => {
                            let Applied {
                                text: updated,
                                listed,
                                added,
                                renamed,
                            } = applied;
                            let changed = !added.is_empty() || !renamed.is_empty();
                            report.listed = listed;
                            report.added = added;
                            report.renamed = renamed;
                            if changed {
                                text = updated;
                                dirty = true;
                            }
                        }
                        Err(error) => report.skipped = Some(format!("{error:#}")),
                    }
                }
                Err(error) => report.skipped = Some(format!("{error:#}")),
            }
            pending.push(report);
        }
        if dirty && !dry_run {
            match write_profile(path, &text) {
                Ok(()) => {
                    for report in &mut pending {
                        report.written = report.changed();
                    }
                }
                Err(error) => {
                    for report in &mut pending {
                        if report.changed() {
                            report.error = Some(format!("{error:#}"));
                        }
                    }
                }
            }
        }
        reports.extend(pending);
    }
    let failed = reports.iter().any(|report| report.error.is_some());
    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&json!({
                "dry_run": dry_run,
                "profiles": reports.iter().map(ProviderReport::to_json).collect::<Vec<_>>(),
            }))?
        );
        if failed {
            std::process::exit(1);
        }
        return Ok(());
    }
    use std::io::Write as _;
    for report in &reports {
        let label = format!("{} {}", report.profile, report.provider);
        if let Some(skipped) = &report.skipped {
            let _ = writeln!(std::io::stdout(), "  {label}  skipped: {skipped}");
            continue;
        }
        if let Some(error) = &report.error {
            let _ = writeln!(std::io::stdout(), "  {label}  error: {error}");
            continue;
        }
        if !report.changed() {
            let _ = writeln!(std::io::stdout(), "  {label}  up to date");
            continue;
        }
        let mut parts = Vec::new();
        if !report.added.is_empty() {
            parts.push(format!(
                "{} {}",
                if dry_run { "would add" } else { "added" },
                report.added.join(", ")
            ));
        }
        if !report.renamed.is_empty() {
            parts.push(format!(
                "{} {}",
                if dry_run { "would rename" } else { "renamed" },
                render_renames(&report.renamed)
            ));
        }
        let _ = writeln!(std::io::stdout(), "  {label}  {}", parts.join("; "));
    }
    if reports.iter().any(|report| report.written) {
        let _ = writeln!(
            std::io::stdout(),
            "[rdsh] restart the harness (or reload its config) to pick up the new models"
        );
    }
    if failed {
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

    /// The Kimi block as it exists before the K2.8 rename.
    const KIMI_PROFILE: &str = "\
- id: llm-pi-ai
  config:
    providers:
      kimi-coding:
        models:
          - id: k3
            name: Kimi K3
            contextWindow: 1048576
            maxTokens: 131072
            input:
              - text
              - image
          - id: kimi-for-coding
            name: kimi-for-coding
            contextWindow: 1048576
            maxTokens: 32768
            input:
              - text
              - image
        apiKeyEnv: KIMI_CODING_API_KEY
";

    fn kimi_listing() -> Value {
        json!({
            "data": [
                {
                    "id": "kimi-for-coding",
                    "display_name": "K2.8 Preview",
                    "context_length": 1048576,
                    "supports_image_in": true,
                    "modalities": {"input": ["text", "image", "video"]},
                    "reasoning": {"effort": {"valid": ["low", "high", "max"], "default": "max"}}
                },
                {
                    "id": "k3",
                    "display_name": "K3",
                    "context_length": 1048576,
                    "think_efforts": {"valid_efforts": ["low", "high", "max"]}
                },
                {
                    "id": "k3-1m",
                    "display_name": "K3 1M",
                    "context_length": 1048576
                }
            ]
        })
    }

    #[test]
    fn catalog_skips_hidden_and_remaps_efforts() {
        let doc = json!({
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
        let doc = json!({
            "models": [{"slug": "gpt-6-sol", "display_name": "GPT-6-Sol", "context_window": 272000}]
        });
        let models = catalog_from_json(&doc, DEFAULT_MAX_TOKENS);
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].input, vec!["text".to_string()]);
        assert!(models[0].efforts.is_empty());
    }

    #[test]
    fn listing_maps_display_names_efforts_and_modalities() {
        let models = catalog_from_listing(&kimi_listing(), DEFAULT_MAX_TOKENS);
        assert_eq!(
            models.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
            vec!["kimi-for-coding", "k3", "k3-1m"]
        );
        assert_eq!(models[0].name, "K2.8 Preview");
        assert_eq!(
            models[0].efforts,
            vec!["low".to_string(), "high".to_string(), "max".to_string()]
        );
        // Video is dropped: the harness cannot carry it.
        assert_eq!(
            models[0].input,
            vec!["text".to_string(), "image".to_string()]
        );
        // The `think_efforts` spelling works too.
        assert_eq!(
            models[1].efforts,
            vec!["low".to_string(), "high".to_string(), "max".to_string()]
        );
        assert_eq!(models[2].input, vec!["text".to_string()]);
    }

    #[test]
    fn sync_appends_only_missing_models_and_keeps_the_rest_byte_for_byte() {
        let applied = apply_profile(PROFILE, CODEX_PROVIDER, &catalog(), false).unwrap();
        assert_eq!(
            applied.added,
            vec![
                "gpt-6.1-sol".to_string(),
                "gpt-daybreak-blue-latest".to_string()
            ]
        );
        assert!(applied.renamed.is_empty());
        let updated = applied.text;
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
    }

    #[test]
    fn sync_reuses_the_sibling_output_cap() {
        let profile = PROFILE.replace("maxTokens: 128000", "maxTokens: 64000");
        let applied = apply_profile(&profile, CODEX_PROVIDER, &catalog(), false).unwrap();
        assert!(applied.text.contains(
            "- id: gpt-6.1-sol\n            name: GPT-6.1-Sol\n            contextWindow: 272000\n            maxTokens: 64000"
        ));
    }

    #[test]
    fn sync_is_idempotent() {
        let once = apply_profile(PROFILE, CODEX_PROVIDER, &catalog(), false).unwrap();
        let twice = apply_profile(&once.text, CODEX_PROVIDER, &catalog(), false).unwrap();
        assert!(twice.added.is_empty());
        assert_eq!(once.text, twice.text);
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
        let applied = apply_profile(profile, CODEX_PROVIDER, &catalog(), false).unwrap();
        assert_eq!(applied.added.len(), 2);
        assert!(applied.text.contains(
            "      openai-codex:\n        api: openai-codex-responses\n        models:\n          - id: gpt-6.1-sol\n"
        ));
        assert!(applied.text.ends_with(
            "- id: agent-default-model\n  config:\n    provider: openai-codex\n    model: gpt-6-sol\n"
        ));
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
        let applied = apply_profile(profile, CODEX_PROVIDER, &catalog(), false).unwrap();
        assert_eq!(applied.added.len(), 2);
        assert!(applied
            .text
            .contains("        models:\n          - id: gpt-6.1-sol\n"));
        assert!(!applied.text.contains("models: []"));
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
        let applied = apply_profile(profile, CODEX_PROVIDER, &catalog(), false).unwrap();
        assert_eq!(applied.listed, vec!["gpt-5.6-sol".to_string()]);
        assert_eq!(applied.added.len(), 2);
        // The sibling list is not the sibling whose cap we borrow either: the
        // models entry is the only maxTokens source.
        assert!(applied
            .text
            .contains("maxTokens: 64000\n            input:"));
        assert!(applied.text.contains(
            "          - id: gpt-daybreak-blue-latest\n            name: Daybreak Blue\n            contextWindow: 272000\n            maxTokens: 64000\n            input:\n              - text\n        headers:\n"
        ));
    }

    #[test]
    fn live_listing_renames_only_the_stale_name_line() {
        let models = catalog_from_listing(&kimi_listing(), DEFAULT_MAX_TOKENS);
        let applied = apply_profile(KIMI_PROFILE, KIMI_PROVIDER, &models, true).unwrap();
        assert_eq!(applied.added, vec!["k3-1m".to_string()]);
        // Renames are reported in file order. "Kimi K3" already carries the
        // listing's "K3", so it is left alone; the placeholder is not.
        assert_eq!(
            applied.renamed,
            vec![Rename {
                id: "kimi-for-coding".to_string(),
                from: "kimi-for-coding".to_string(),
                to: "K2.8 Preview".to_string(),
            }]
        );
        assert!(applied
            .text
            .contains("          - id: kimi-for-coding\n            name: K2.8 Preview\n"));
        assert!(applied
            .text
            .contains("          - id: k3\n            name: Kimi K3\n"));
        // Everything else survives: the context window, the cap, the sibling
        // entry's own fields, and the apiKeyEnv line.
        assert!(applied
            .text
            .contains("            contextWindow: 1048576\n            maxTokens: 32768\n"));
        assert!(applied
            .text
            .contains("        apiKeyEnv: KIMI_CODING_API_KEY\n"));
        // And a second pass is a no-op.
        let again = apply_profile(&applied.text, KIMI_PROVIDER, &models, true).unwrap();
        assert!(again.added.is_empty() && again.renamed.is_empty());
        assert_eq!(again.text, applied.text);
    }

    #[test]
    fn a_name_that_already_carries_the_live_one_is_not_churned() {
        assert!(name_already_current("Kimi K3", "K3"));
        assert!(name_already_current("Kimi K3-256K", "K3-256k"));
        assert!(!name_already_current("kimi-for-coding", "K2.8 Preview"));
        assert!(!name_already_current(
            "Kimi For Coding HighSpeed",
            "K2.7 Code Highspeed"
        ));
        // An entry with no name at all gets the listing's.
        assert!(!name_already_current("", "K3"));
    }

    #[test]
    fn codex_entries_keep_their_own_display_names() {
        let models = catalog_from_json(
            &json!({"models": [{
                "slug": "gpt-5.6-sol",
                "display_name": "GPT-5.6-Sol",
                "visibility": "list",
                "context_window": 272000
            }]}),
            DEFAULT_MAX_TOKENS,
        );
        let applied = apply_profile(PROFILE, CODEX_PROVIDER, &models, false).unwrap();
        assert!(applied.renamed.is_empty());
        assert!(applied.added.is_empty());
        assert!(applied.text.contains("name: GPT-5.6 Sol"));
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
        let error = apply_profile(profile, CODEX_PROVIDER, &catalog(), false).unwrap_err();
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
            false,
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
        let error = apply_profile(profile, CODEX_PROVIDER, &catalog(), false).unwrap_err();
        assert!(error.to_string().contains("expand it to a block"));
    }

    #[test]
    fn text_without_a_trailing_newline_keeps_none() {
        let profile = PROFILE.trim_end_matches('\n');
        let applied = apply_profile(profile, CODEX_PROVIDER, &catalog(), false).unwrap();
        assert!(!applied.text.ends_with('\n'));
    }

    #[test]
    fn scalar_reads_only_the_named_key() {
        let lines: Vec<String> = KIMI_PROFILE.lines().map(str::to_string).collect();
        let site = locate_owned(&lines, KIMI_PROVIDER).unwrap();
        assert_eq!(
            scalar_in(&lines, &site, "apiKeyEnv"),
            Some("KIMI_CODING_API_KEY".to_string())
        );
        assert_eq!(scalar_in(&lines, &site, "baseURL"), None);
    }

    #[test]
    fn curl_config_quotes_secrets_and_pins_https() {
        let endpoint = LiveEndpoint {
            base_url: "https://api.kimi.com/coding",
            path: "/v1/models",
            key_header: "x-api-key",
            extra_headers: &[("anthropic-version", "2023-06-01")],
        };
        let config = curl_config(
            &endpoint,
            "https://api.kimi.com/coding/v1/models",
            "sk-a\"b",
        );
        assert!(config.contains("header = \"x-api-key: sk-a\\\"b\""));
        assert!(config.contains("proto = \"=https\""));
        assert!(config.contains("proto-redir = \"=https\""));
        assert!(!config.contains("sk-a\"b\n"));
    }

    #[test]
    fn a_provider_the_profile_never_names_is_not_this_command_s_business() {
        assert!(configures(KIMI_PROFILE, KIMI_PROVIDER));
        assert!(!configures(KIMI_PROFILE, CODEX_PROVIDER));
        assert!(!configures(PROFILE, KIMI_PROVIDER));
    }
}
