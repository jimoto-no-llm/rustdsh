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
//!   (`codex debug models`, falling back to `$CODEX_HOME/models_cache.json`,
//!   with `~/.codex` as the default Codex home).
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

use std::collections::HashSet;
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
    /// `codex debug models`, falling back to the Codex home's model cache.
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
    let lines: Vec<String> = profile_text.lines().map(str::to_string).collect();
    let site = locate_owned(&lines, source.provider)?;
    match &source.kind {
        SourceKind::CodexCli => codex_catalog(DEFAULT_MAX_TOKENS),
        SourceKind::Live(endpoint) => {
            ensure_rename_supported(&lines, &site)?;
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
            let base = if find_key(&lines, site.provider_line + 1, site.provider_end, "baseURL")
                .is_some()
            {
                scalar_in(&lines, &site, "baseURL").context("unsupported baseURL scalar")?
            } else {
                endpoint.base_url.to_string()
            };
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
    let path = codex_cache_path()?;
    let display = path.display();
    let text = std::fs::read_to_string(&path).with_context(|| {
        format!("neither `codex debug models` nor {display} yielded a model catalog")
    })?;
    let doc: Value = serde_json::from_str(&text)
        .with_context(|| format!("{display} is not the model catalog JSON this build expects"))?;
    let models = catalog_from_json(&doc, max_tokens);
    if models.is_empty() {
        bail!("{display} lists no selectable Codex model");
    }
    Ok(Fetched {
        models,
        label: display.to_string(),
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

fn codex_cache_path() -> Result<PathBuf> {
    let home = if let Some(home) = std::env::var_os("CODEX_HOME").filter(|home| !home.is_empty()) {
        let path = PathBuf::from(home);
        if !path.is_dir() {
            bail!("CODEX_HOME is not an existing directory");
        }
        path.canonicalize()
            .context("failed to canonicalize CODEX_HOME")?
    } else {
        PathBuf::from(crate::inspect::home_dir().context("HOME is not set")?).join(".codex")
    };
    Ok(home.join("models_cache.json"))
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
    let value = key_value(&lines[index], key)?;
    model_scalar(value).ok().filter(|value| !value.is_empty())
}

/// Read one `refs:` entry from the credentials document.
fn credential_ref(name: &str) -> Option<String> {
    let path = format!("{}/.credentials.yaml", dsh_home());
    let text = std::fs::read_to_string(path).ok()?;
    let mut in_refs = false;
    for line in text.lines() {
        let trimmed = line.trim_end();
        if !in_refs {
            in_refs =
                key_value(trimmed, "refs").is_some_and(|value| strip_comment(value).is_empty());
            continue;
        }
        if !trimmed.trim().is_empty() && indent_of(trimmed) == 0 {
            break;
        }
        if indent_of(trimmed) != 2 {
            continue;
        }
        if let Some(value) = key_value(trimmed, name) {
            return model_scalar(value).ok().filter(|value| !value.is_empty());
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
/// Uninterpreted entries must reach the ownership check and be reported as
/// skipped rather than hiding a provider in an uninspected entry.
fn configures(text: &str, provider: &str) -> bool {
    let lines: Vec<String> = text.lines().map(str::to_string).collect();
    let entry = match crate::providers::llm_pi_ai_entry(&lines, crate::locale::Locale::English) {
        Ok(Some(entry)) => entry,
        Ok(None) => return false,
        Err(_) => return true,
    };
    let Some(config) = find_key(&lines, entry + 1, block_end(&lines, entry), "config") else {
        return false;
    };
    let Some(providers) = find_key(&lines, config + 1, block_end(&lines, config), "providers")
    else {
        return false;
    };
    find_key(
        &lines,
        providers + 1,
        block_end(&lines, providers),
        provider,
    )
    .is_some()
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
    if refresh_names {
        ensure_rename_supported(&lines, &site)?;
    }
    let listed = existing_ids(&lines, &site);
    let max_tokens = existing_max_tokens(&lines, &site)?.unwrap_or(DEFAULT_MAX_TOKENS);
    let mut seen: HashSet<&str> = listed.iter().map(String::as_str).collect();
    let missing: Vec<CatalogModel> = catalog
        .iter()
        .filter(|model| seen.insert(model.id.as_str()))
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
    if text.contains("\r\n") && text.replace("\r\n", "").contains('\n') {
        bail!("the profile has mixed line endings; use one line ending before syncing models");
    }

    // Insert missing names from bottom to top so earlier item positions stay
    // valid; an id is a single-line scalar, so inserting after it cannot alter
    // a neighboring block scalar's chomping or trailing blank lines.
    for rename in renamed.iter().rev() {
        if let Some(index) = name_line(&lines, &site, &rename.id) {
            replace_scalar(&mut lines[index], "name", &yaml_scalar(&rename.to));
        } else if let Some(item) = item_line(&lines, &site, &rename.id) {
            let index = item_key_line(&lines, item, site.item_indent, "id")
                .context("model item lost its id before name insertion")?;
            let depth = item_field_indent(&lines, item, site.item_indent)
                .context("model item has no field indentation")?;
            lines.insert(
                index + 1,
                format!("{}name: {}", " ".repeat(depth), yaml_scalar(&rename.to)),
            );
        }
    }
    let site = locate_owned(&lines, provider)?;
    let added: Vec<String> = missing.iter().map(|model| model.id.clone()).collect();
    let block: Vec<String> = missing
        .iter()
        .flat_map(|model| format_model(model, site.item_indent, site.step))
        .collect();
    if let Some(models_line) = site.models_line {
        if key_value(&lines[models_line], "models")
            .is_some_and(|value| strip_comment(value) == "[]")
        {
            // `models: []` is an inline empty sequence: give it a body.
            replace_scalar(&mut lines[models_line], "models", "");
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
            // Keep normal field order, but insert before a final block scalar
            // so none of its blank lines or EOF chomping can move or change.
            let last_field = (site.provider_line + 1..site.provider_end).rfind(|i| {
                indent_of(&lines[*i]) == site.models_indent
                    && !lines[*i].trim().is_empty()
                    && !lines[*i].trim_start().starts_with('#')
            });
            let insert_at = last_field
                .filter(|i| {
                    // A possible block-scalar indicator is sufficient to
                    // choose the earlier, safe insertion point. This also
                    // covers quoted keys, explicit tags and inline comments.
                    strip_comment(&lines[*i]).contains(['|', '>'])
                })
                .unwrap_or(site.provider_end);
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
    let newline = if original.contains("\r\n") {
        "\r\n"
    } else {
        "\n"
    };
    let mut text = lines.join(newline);
    if original.ends_with('\n') {
        text.push_str(newline);
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
    let entry = crate::providers::llm_pi_ai_entry(lines, crate::locale::Locale::English)
        .map_err(anyhow::Error::msg)?
        .ok_or_else(|| {
        anyhow::anyhow!(
            "no llm-pi-ai patch entry: add a `- id: llm-pi-ai` entry with a providers.{provider} block first"
        )
    })?;
    let entry_end = block_end(lines, entry);
    let config = find_key(lines, entry + 1, entry_end, "config")
        .ok_or_else(|| anyhow::anyhow!("the llm-pi-ai entry has no config: block"))?;
    if key_value(&lines[config], "config").is_some_and(|value| !strip_comment(value).is_empty()) {
        bail!("the llm-pi-ai config must be a block mapping");
    }
    let config_end = block_end(lines, config);
    let providers = find_key(lines, config + 1, config_end, "providers")
        .ok_or_else(|| anyhow::anyhow!("the llm-pi-ai config has no providers: block"))?;
    if key_value(&lines[providers], "providers")
        .is_some_and(|value| !strip_comment(value).is_empty())
    {
        bail!("providers must be a block mapping");
    }
    let providers_end = block_end(lines, providers);
    let provider_line = find_key(lines, providers + 1, providers_end, provider).ok_or_else(|| {
        anyhow::anyhow!(
            "the profile does not configure the {provider} provider: add a `{provider}:` block with a models: list"
        )
    })?;
    let provider_indent = indent_of(&lines[provider_line]);
    if key_value(&lines[provider_line], provider)
        .is_some_and(|value| !strip_comment(value).is_empty())
    {
        bail!("the {provider} value is not a block mapping; expand it to a block with a models: list first");
    }
    let provider_end = block_end(lines, provider_line);
    let step = step_after(lines, provider_line, provider_end).unwrap_or(2);
    match find_key(lines, provider_line + 1, provider_end, "models") {
        Some(models_line) => {
            let models_indent = indent_of(&lines[models_line]);
            let value = strip_comment(key_value(&lines[models_line], "models").unwrap_or(""));
            if !value.is_empty() && value != "[]" {
                bail!("expand models to an indented block sequence before syncing");
            }
            let first_content = (models_line + 1..provider_end).find(|i| {
                let body = lines[*i].trim();
                !body.is_empty() && !body.starts_with('#')
            });
            if first_content.is_some_and(|i| {
                indent_of(&lines[i]) <= models_indent && item_body(&lines[i]).is_some()
            }) {
                bail!("expand models to an indented block sequence before syncing");
            }
            let models_end = block_end(lines, models_line);
            for line in &lines[models_line + 1..models_end] {
                let body = line.trim_start();
                let body = body.strip_prefix("- ").unwrap_or(body);
                if key_value(body, "name").is_some_and(|value| {
                    let value = strip_comment(value);
                    value.starts_with('|') || value.starts_with('>')
                }) {
                    bail!("a multiline name cannot be refreshed safely; use a single-line name before syncing models");
                }
            }
            let item_indent = first_item_indent(lines, models_line + 1, models_end)
                .unwrap_or(models_indent + step);
            if first_content.is_some_and(|i| i < models_end && item_body(&lines[i]).is_none()) {
                bail!("models must be an indented block sequence, not a mapping or scalar");
            }
            let site = Site {
                provider_line,
                provider_end,
                models_line: Some(models_line),
                models_end,
                models_indent,
                item_indent,
                step,
            };
            validate_model_items(lines, &site)?;
            Ok(site)
        }
        None => Ok(Site {
            provider_line,
            provider_end,
            models_line: None,
            models_end: 0,
            models_indent: provider_indent + step,
            item_indent: provider_indent + step * 2,
            step,
        }),
    }
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
    let depth = (from..until)
        .filter(|i| !lines[*i].trim().is_empty() && !lines[*i].trim_start().starts_with('#'))
        .map(|i| indent_of(&lines[i]))
        .min()?;
    (from..until).find(|i| {
        indent_of(&lines[*i]) == depth && key_value(lines[*i].trim_start(), key).is_some()
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
        .find(|i| item_body(&lines[*i]).is_some())
        .map(|i| indent_of(&lines[i]))
}

/// The end of the last `- ` item inside a sequence block.
fn last_item_end(lines: &[String], site: &Site) -> Option<usize> {
    let models_line = site.models_line?;
    let models_end = site.models_end.min(lines.len());
    let last = (models_line + 1..models_end)
        .rfind(|i| indent_of(&lines[*i]) == site.item_indent && item_body(&lines[*i]).is_some())?;
    Some(block_end(lines, last))
}

/// The item line that carries `id: <wanted>`.
fn item_line(lines: &[String], site: &Site, wanted: &str) -> Option<usize> {
    let models_line = site.models_line?;
    let end = site.models_end.min(lines.len());
    (models_line + 1..end).find(|i| {
        indent_of(&lines[*i]) == site.item_indent
            && item_body(&lines[*i]).is_some()
            && item_id(lines, *i, site.item_indent).as_deref() == Some(wanted)
    })
}

/// The `name:` line inside one model item.
fn name_line(lines: &[String], site: &Site, wanted: &str) -> Option<usize> {
    let item = item_line(lines, site, wanted)?;
    item_key_line(lines, item, site.item_indent, "name")
}

fn item_field_indent(lines: &[String], item: usize, item_indent: usize) -> Option<usize> {
    let body = item_body(&lines[item])?;
    if !strip_comment(body).is_empty() {
        return Some(lines[item].len() - body.len());
    }
    (item + 1..block_end(lines, item))
        .filter(|i| {
            !lines[*i].trim().is_empty()
                && !lines[*i].trim_start().starts_with('#')
                && indent_of(&lines[*i]) > item_indent
        })
        .map(|i| indent_of(&lines[i]))
        .min()
}

fn item_key_line(lines: &[String], item: usize, item_indent: usize, key: &str) -> Option<usize> {
    if key_value(item_body(&lines[item])?, key).is_some() {
        return Some(item);
    }
    let depth = item_field_indent(lines, item, item_indent)?;
    (item + 1..block_end(lines, item)).find(|i| {
        indent_of(&lines[*i]) == depth && key_value(lines[*i].trim_start(), key).is_some()
    })
}

fn existing_ids(lines: &[String], site: &Site) -> Vec<String> {
    let Some(models_line) = site.models_line else {
        return Vec::new();
    };
    let end = site.models_end.min(lines.len());
    (models_line + 1..end)
        .filter(|i| indent_of(&lines[*i]) == site.item_indent && item_body(&lines[*i]).is_some())
        .filter_map(|i| item_id(lines, i, site.item_indent))
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
            out.push(Rename {
                from: id.clone(),
                id,
                to: model.name.clone(),
            });
            continue;
        };
        let body = item_body(&lines[index]).unwrap_or(lines[index].trim_start());
        let current = model_scalar(key_value(body, "name").unwrap_or("")).unwrap_or_default();
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

/// The raw value after `key:` on one line, when that line opens with `key:`.
fn key_value<'a>(line: &'a str, key: &str) -> Option<&'a str> {
    let colon = key_colon(line, key)?;
    Some(line[colon + 1..].trim())
}

fn key_colon(line: &str, key: &str) -> Option<usize> {
    let colon = line.find(':')?;
    let candidate = line[..colon].trim();
    (candidate == key
        || (candidate.starts_with(['\'', '"'])
            && model_scalar(candidate).ok().as_deref() == Some(key)))
    .then_some(colon)
}

/// A scalar with any trailing YAML comment removed. A `#` inside quotes is
/// content, and a `#` that does not follow whitespace is content too.
fn strip_comment(value: &str) -> &str {
    let bytes = value.as_bytes();
    let mut quote = None;
    let mut previous = None;
    let mut index = 0;
    while index < bytes.len() {
        let byte = bytes[index];
        if let Some(open) = quote {
            if open == b'"' && byte == b'\\' {
                index += 2;
                continue;
            }
            if open == b'\'' && byte == b'\'' && bytes.get(index + 1) == Some(&b'\'') {
                index += 2;
                continue;
            }
            if byte == open {
                quote = None;
            }
        } else if (byte == b'\'' || byte == b'"')
            && matches!(
                previous,
                None | Some(b':') | Some(b',') | Some(b'[') | Some(b'{')
            )
        {
            quote = Some(byte);
        } else if byte == b'#' && (index == 0 || bytes[index - 1].is_ascii_whitespace()) {
            return value[..index].trim_end();
        }
        if !byte.is_ascii_whitespace() {
            previous = Some(byte);
        }
        index += 1;
    }
    value.trim_end()
}

/// The `id:` of one sequence item, whether it opens the item line, sits on a
/// later line of the item, or is written in flow style. A comment after the
/// value must not hide the id: a missed id would be appended a second time.
fn item_id(lines: &[String], item: usize, item_indent: usize) -> Option<String> {
    let head = strip_comment(item_body(&lines[item])?);
    if let Some(value) = key_value(head, "id") {
        return model_scalar(value).ok();
    }
    if head.starts_with('{') {
        return flow_fields(head)?.into_iter().find_map(|field| {
            key_value(field.trim(), "id").and_then(|value| model_scalar(value).ok())
        });
    }
    let index = item_key_line(lines, item, item_indent, "id")?;
    let body = item_body(&lines[index]).unwrap_or(lines[index].trim_start());
    model_scalar(key_value(body, "id")?).ok()
}

fn item_body(line: &str) -> Option<&str> {
    let rest = line.trim_start().strip_prefix('-')?;
    (rest.is_empty() || rest.starts_with(char::is_whitespace)).then(|| rest.trim_start())
}

// Decode single-line quoted strings exactly; aliases, tags, structured values
// and physically multiline strings remain outside this line editor.
fn model_scalar(value: &str) -> Result<String> {
    let value = strip_comment(value);
    if value.starts_with('"') {
        if let Ok(decoded) = serde_json::from_str::<String>(value) {
            return Ok(decoded);
        }
        let inner = value
            .strip_prefix('"')
            .and_then(|value| value.strip_suffix('"'))
            .context("unsupported or multiline quoted model scalar")?;
        return decode_yaml_double(inner);
    }
    if value.starts_with('\'') {
        if value.len() < 2 || !value.ends_with('\'') {
            bail!("unsupported or multiline quoted model scalar");
        }
        return Ok(unquote(value));
    }
    if value.is_empty()
        || value
            .chars()
            .next()
            .is_some_and(|ch| matches!(ch, '!' | '&' | '*' | '|' | '>' | '[' | '{'))
    {
        bail!("unsupported model scalar; use a single-line string");
    }
    Ok(value.to_string())
}

// Same YAML 1.2 escape alphabet used by the existing provider route reader.
fn decode_yaml_double(inner: &str) -> Result<String> {
    let mut out = String::new();
    let mut chars = inner.chars();
    while let Some(ch) = chars.next() {
        if ch != '\\' {
            if matches!(ch, '"' | '\n' | '\r') {
                bail!("unsupported quoted scalar");
            }
            out.push(ch);
            continue;
        }
        let escape = chars.next().context("incomplete quoted scalar escape")?;
        let decoded = match escape {
            '0' => '\0',
            'a' => '\u{7}',
            'b' => '\u{8}',
            't' | '\t' => '\t',
            'n' => '\n',
            'v' => '\u{b}',
            'f' => '\u{c}',
            'r' => '\r',
            'e' => '\u{1b}',
            ' ' => ' ',
            '"' => '"',
            '/' => '/',
            '\\' => '\\',
            'N' => '\u{85}',
            '_' => '\u{a0}',
            'L' => '\u{2028}',
            'P' => '\u{2029}',
            'x' | 'u' | 'U' => {
                let count = match escape {
                    'x' => 2,
                    'u' => 4,
                    _ => 8,
                };
                let digits: String = chars.by_ref().take(count).collect();
                if digits.len() != count || !digits.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                    bail!("invalid quoted scalar Unicode escape");
                }
                char::from_u32(u32::from_str_radix(&digits, 16)?)
                    .context("invalid Unicode scalar")?
            }
            _ => bail!("unsupported quoted scalar escape"),
        };
        out.push(decoded);
    }
    Ok(out)
}

fn flow_fields(head: &str) -> Option<Vec<&str>> {
    let body = strip_comment(head).strip_prefix('{')?.strip_suffix('}')?;
    let mut fields = Vec::new();
    let mut quote = None;
    let mut escaped = false;
    let mut start = 0;
    for (i, ch) in body.char_indices() {
        if escaped {
            escaped = false;
            continue;
        }
        if quote == Some('"') && ch == '\\' {
            escaped = true;
            continue;
        }
        if let Some(open) = quote {
            if ch == open {
                quote = None;
            }
            continue;
        }
        match ch {
            '\'' | '"' => quote = Some(ch),
            '{' | '}' | '[' | ']' => return None,
            ',' => {
                fields.push(body[start..i].trim());
                start = i + 1;
            }
            _ => {}
        }
    }
    if quote.is_some() {
        return None;
    }
    fields.push(body[start..].trim());
    Some(fields)
}

fn validate_model_items(lines: &[String], site: &Site) -> Result<()> {
    let Some(models_line) = site.models_line else {
        return Ok(());
    };
    for i in models_line + 1..site.models_end {
        let line = lines[i].trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if indent_of(&lines[i]) < site.item_indent
            || (indent_of(&lines[i]) == site.item_indent && item_body(&lines[i]).is_none())
        {
            bail!("models must be an indented block sequence");
        }
        let body = item_body(&lines[i]).unwrap_or(lines[i].trim_start());
        if body.starts_with('{') && indent_of(&lines[i]) == site.item_indent {
            let fields = flow_fields(body).context("unsupported flow model item")?;
            for field in fields {
                for key in ["id", "name"] {
                    if let Some(value) = key_value(field, key) {
                        model_scalar(value)?;
                    }
                }
            }
        } else {
            for key in ["id", "name"] {
                if let Some(value) = key_value(body, key) {
                    model_scalar(value)?;
                    let key_indent =
                        indent_of(&lines[i]) + usize::from(item_body(&lines[i]).is_some()) * 2;
                    if (i + 1..site.models_end)
                        .find(|j| {
                            !lines[*j].trim().is_empty() && !lines[*j].trim_start().starts_with('#')
                        })
                        .is_some_and(|j| indent_of(&lines[j]) > key_indent)
                    {
                        bail!("a multiline model scalar cannot be refreshed safely");
                    }
                }
            }
        }
        if indent_of(&lines[i]) == site.item_indent && item_id(lines, i, site.item_indent).is_none()
        {
            bail!("model item must carry a supported single-line id");
        }
    }
    Ok(())
}

fn ensure_rename_supported(lines: &[String], site: &Site) -> Result<()> {
    if let Some(start) = site.models_line {
        if (start + 1..site.models_end).any(|i| {
            indent_of(&lines[i]) == site.item_indent
                && item_body(&lines[i]).is_some_and(|body| body.starts_with('{'))
        }) {
            bail!(
                "flow model names cannot be refreshed safely; expand the item to a block mapping"
            );
        }
    }
    Ok(())
}

fn replace_scalar(line: &mut String, key: &str, replacement: &str) {
    let body = item_body(line).unwrap_or(line.trim_start());
    let colon = line.len() - body.len() + key_colon(body, key).expect("validated scalar key");
    let rest = &line[colon + 1..];
    let start = colon + 1 + rest.len() - rest.trim_start().len();
    let end = start + strip_comment(&line[start..]).len();
    if replacement.is_empty() && line[end..].trim().is_empty() {
        line.truncate(colon + 1);
    } else {
        line.replace_range(start..end, replacement);
    }
}

fn existing_max_tokens(lines: &[String], site: &Site) -> Result<Option<u64>> {
    let Some(start) = site.models_line else {
        return Ok(None);
    };
    (start + 1..site.models_end)
        .filter(|i| indent_of(&lines[*i]) == site.item_indent && item_body(&lines[*i]).is_some())
        .filter_map(|i| {
            let body = item_body(&lines[i])?;
            if body.starts_with('{') {
                return flow_fields(body)?
                    .into_iter()
                    .find_map(|field| key_value(field, "maxTokens").map(max_tokens_scalar));
            }
            let index = item_key_line(lines, i, site.item_indent, "maxTokens")?;
            let body = item_body(&lines[index]).unwrap_or(lines[index].trim_start());
            Some(max_tokens_scalar(key_value(body, "maxTokens")?))
        })
        .collect::<Result<Vec<_>>>()
        .map(|values| values.into_iter().max())
}

/// DSH's js-yaml JSON schema admits radix integers and integral floats;
/// llm-pi-ai requires a positive Number.isInteger value. Do not silently fall
/// back when an explicit cap is a string, alias or unsupported numeric form.
fn max_tokens_scalar(raw: &str) -> Result<u64> {
    let raw = strip_comment(raw);
    let raw = raw
        .strip_prefix("!!int ")
        .or_else(|| raw.strip_prefix("!!float "))
        .unwrap_or(raw)
        .trim();
    let unsigned = raw.strip_prefix('+').unwrap_or(raw);
    let radix = [("0x", 16), ("0o", 8), ("0b", 2)]
        .into_iter()
        .find_map(|(prefix, radix)| unsigned.strip_prefix(prefix).map(|digits| (digits, radix)));
    let value = if let Some((digits, radix)) = radix {
        if digits.is_empty() || !digits.chars().all(|c| c.is_digit(radix)) {
            bail!("maxTokens must be a supported positive YAML integer");
        }
        u64::from_str_radix(digits, radix).context("maxTokens integer is out of range")? as f64
    } else {
        if !raw
            .bytes()
            .all(|c| c.is_ascii_digit() || matches!(c, b'+' | b'-' | b'.' | b'e' | b'E'))
        {
            bail!("maxTokens must be a supported positive YAML integer");
        }
        raw.parse::<f64>().context("unsupported maxTokens scalar")?
    };
    if value <= 0.0 || !value.is_finite() || value.fract() != 0.0 || value >= u64::MAX as f64 {
        bail!("maxTokens must be a positive integer within the supported range");
    }
    Ok(value as u64)
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
    // A compact mapping starts two columns after its dash regardless of the
    // surrounding profile's indentation step.
    let key = " ".repeat(item_indent + 2);
    let nested = " ".repeat(item_indent + 2 + step);
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
    let plain = raw.chars().next().is_some_and(|c| c.is_ascii_alphabetic())
        && !matches!(raw.to_ascii_lowercase().as_str(), "true" | "false" | "null")
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
        let quoted = serde_json::to_string(raw).expect("a string serializes as JSON");
        let mut escaped = String::new();
        for ch in quoted.chars() {
            if matches!(
                ch,
                '\u{7f}'..='\u{9f}' | '\u{2028}' | '\u{2029}' | '\u{fffe}' | '\u{ffff}'
            ) {
                escaped.push_str(&format!("\\u{:04x}", ch as u32));
            } else {
                escaped.push(ch);
            }
        }
        escaped
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
    if reports.iter().any(ProviderReport::changed) {
        let _ = writeln!(std::io::stdout(), "[rdsh] apply with: rdsh models sync");
    }
    Ok(())
}

/// One provider's already-fetched catalog, ready to fold into a profile.
struct ProviderPlan {
    provider: &'static str,
    models: Vec<CatalogModel>,
    refresh_names: bool,
    source: String,
}

/// One provider's outcome for one profile: a fetched catalog, or why it could
/// not be fetched.
enum Planned {
    Ready(ProviderPlan),
    Skipped {
        provider: &'static str,
        reason: String,
    },
}

fn planned_provider(entry: &Planned) -> &'static str {
    match entry {
        Planned::Ready(plan) => plan.provider,
        Planned::Skipped { provider, .. } => provider,
    }
}

/// Fold every planned catalog into one profile while holding the profile lock.
///
/// The document is read *inside* the lock: a snapshot taken before it would
/// drop a concurrent editor's update when this write lands.
fn sync_profile_locked(
    name: &str,
    path: &Path,
    planned: &[Planned],
    dry_run: bool,
) -> Result<Vec<ProviderReport>> {
    let _lock = CredentialFileLock::exclusive_for(path, crate::locale::Locale::English)?;
    let mut text =
        std::fs::read_to_string(path).with_context(|| format!("cannot read {}", path.display()))?;
    let mut reports = Vec::new();
    let mut dirty = false;
    for entry in planned {
        match entry {
            Planned::Skipped { provider, reason } => {
                let mut report = ProviderReport::pending(name, provider);
                report.skipped = Some(reason.clone());
                reports.push(report);
            }
            Planned::Ready(plan) => {
                let mut report = ProviderReport::pending(name, plan.provider);
                report.source = plan.source.clone();
                match apply_profile(&text, plan.provider, &plan.models, plan.refresh_names) {
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
                reports.push(report);
            }
        }
    }
    if dirty && !dry_run {
        match crate::auth::write_creds(&path.display().to_string(), &text) {
            Ok(()) => {
                for report in &mut reports {
                    report.written = report.changed();
                }
            }
            Err(error) => {
                for report in &mut reports {
                    if report.changed() {
                        report.error = Some(format!("{error:#}"));
                    }
                }
            }
        }
    }
    Ok(reports)
}

/// `rdsh models sync`: append missing entries and refresh stale names, or
/// preview with `--dry-run`.
///
/// `auto` is the daily timer's mode. It honours `features.models_sync` and turns
/// every failure into a reported, successful exit: the run it belongs to must
/// not stop because a catalog could not be refreshed. A manual invocation keeps
/// the switch out of the way and keeps its failing status.
pub(crate) fn cmd_models_sync(
    profile: Option<&str>,
    provider: Option<&str>,
    dry_run: bool,
    auto: bool,
    json: bool,
) -> Result<()> {
    match cmd_models_sync_inner(profile, provider, dry_run, auto, json) {
        Err(error) if auto => {
            eprintln!("[rdsh] models sync --auto: {error:#}");
            Ok(())
        }
        other => other,
    }
}

fn cmd_models_sync_inner(
    profile: Option<&str>,
    provider: Option<&str>,
    dry_run: bool,
    auto: bool,
    json: bool,
) -> Result<()> {
    if auto && !crate::rdsh_config::feature_enabled(&crate::rdsh_config::load(), "models_sync") {
        // The timer calls this every day: stay modest, keep `--json` parseable
        // and leave the profiles alone.
        if json {
            println!(
                "{}",
                serde_json::to_string_pretty(&json!({
                    "dry_run": dry_run,
                    "auto": true,
                    "skipped": "models_sync",
                    "profiles": [],
                }))?
            );
        } else {
            println!("[rdsh] models_sync is off; skipping model catalog sync");
        }
        return Ok(());
    }
    let sources = selected_sources(provider)?;
    let profiles = profile_paths(profile)?;
    let mut reports = Vec::new();
    for (name, path) in &profiles {
        // The snapshot only resolves credentials and `baseURL`; the fold below
        // re-reads the document under the lock.
        let snapshot = match std::fs::read_to_string(path) {
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
        let mut planned = Vec::new();
        for source in &sources {
            if !configures(&snapshot, source.provider) {
                continue;
            }
            match fetch_catalog(source, &snapshot) {
                Ok(fetched) => planned.push(Planned::Ready(ProviderPlan {
                    provider: source.provider,
                    models: fetched.models,
                    refresh_names: matches!(source.kind, SourceKind::Live(_)),
                    source: fetched.label,
                })),
                Err(error) => planned.push(Planned::Skipped {
                    provider: source.provider,
                    reason: format!("{error:#}"),
                }),
            }
        }
        if planned.is_empty() {
            continue;
        }
        match sync_profile_locked(name, path, &planned, dry_run) {
            Ok(mut done) => reports.append(&mut done),
            Err(error) => {
                for entry in &planned {
                    let mut report = ProviderReport::pending(name, planned_provider(entry));
                    report.error = Some(format!("{error:#}"));
                    reports.push(report);
                }
            }
        }
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
        return finish_sync(failed, auto);
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
    finish_sync(failed, auto)
}

/// Close a run whose reports carried errors. A manual run keeps its failing
/// status; `--auto` (the daily timer) reports the failure and returns success,
/// so the update run it belongs to is never stopped by an unreachable catalog.
fn finish_sync(failed: bool, auto: bool) -> Result<()> {
    if !failed {
        return Ok(());
    }
    if auto {
        eprintln!("[rdsh] models sync --auto: one or more providers reported errors");
        return Ok(());
    }
    std::process::exit(1)
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

    #[test]
    fn a_trailing_comment_does_not_hide_an_empty_flow_list() {
        let profile = "\
- id: llm-pi-ai
  config:
    providers:
      openai-codex:
        models: [] # filled by rdsh models sync
";
        let applied = apply_profile(profile, CODEX_PROVIDER, &catalog(), false).unwrap();
        assert_eq!(applied.added.len(), 2);
        assert!(applied.text.contains(
            "        models:  # filled by rdsh models sync\n          - id: gpt-6.1-sol\n"
        ));
        assert!(!applied.text.contains("models: []"));
    }

    #[test]
    fn a_trailing_comment_does_not_hide_an_inline_empty_provider() {
        let profile = "\
- id: llm-pi-ai
  config:
    providers:
      openai-codex: {} # expanded later
";
        let error = apply_profile(profile, CODEX_PROVIDER, &catalog(), false).unwrap_err();
        assert!(error.to_string().contains("expand it to a block"));
    }

    #[test]
    fn existing_ids_survive_comments_later_keys_and_flow_style() {
        let profile = "\
- id: llm-pi-ai
  config:
    providers:
      openai-codex:
        models:
          - id: gpt-6.1-sol # already listed
            name: GPT-6.1-Sol
          - name: Daybreak Blue
            id: gpt-daybreak-blue-latest
          - {id: gpt-5.6-sol, name: GPT-5.6 Sol}
";
        let applied = apply_profile(profile, CODEX_PROVIDER, &catalog(), false).unwrap();
        assert_eq!(
            applied.listed,
            vec![
                "gpt-6.1-sol".to_string(),
                "gpt-daybreak-blue-latest".to_string(),
                "gpt-5.6-sol".to_string(),
            ]
        );
        assert!(applied.added.is_empty());
    }

    #[test]
    fn yaml_regression_nonempty_flow_models_are_refused() {
        let profile = "- id: llm-pi-ai\n  config:\n    providers:\n      openai-codex:\n        models: [{id: gpt-5.6-sol, name: Custom}] # keep\n";
        let error = apply_profile(profile, CODEX_PROVIDER, &catalog(), false).unwrap_err();
        assert!(error.to_string().contains("indented block sequence"));
    }

    #[test]
    fn yaml_regression_indentless_models_are_refused() {
        let profile = "- id: llm-pi-ai\n  config:\n    providers:\n      openai-codex:\n        models:\n        - id: gpt-5.6-sol\n          name: Custom\n";
        let error = apply_profile(profile, CODEX_PROVIDER, &catalog(), false).unwrap_err();
        assert!(error.to_string().contains("indented block sequence"));
    }

    #[test]
    fn yaml_regression_multiline_names_are_refused_in_either_key_order() {
        let models = catalog_from_listing(&kimi_listing(), DEFAULT_MAX_TOKENS);
        for indicator in ["|-", ">-"] {
            for item in [
                format!("          - id: kimi-for-coding\n            name: {indicator}\n              Kimi: Legacy\n"),
                format!("          - name: {indicator}\n              Kimi: Legacy\n            id: kimi-for-coding\n"),
            ] {
                let profile = format!("- id: llm-pi-ai\n  config:\n    providers:\n      kimi-coding:\n        models:\n{item}");
                let error = apply_profile(&profile, KIMI_PROVIDER, &models, true).unwrap_err();
                assert!(error.to_string().contains("multiline name"));
            }
        }
    }

    #[test]
    fn yaml_regression_flow_item_trailing_comments_do_not_duplicate_ids() {
        for item in [
            "{id: gpt-6.1-sol, name: Custom} # keep this comment",
            "{name: 'Custom # name', id: gpt-6.1-sol} # keep this comment",
        ] {
            let profile = format!("- id: llm-pi-ai\n  config:\n    providers:\n      openai-codex:\n        models:\n          - {item}\n");
            let applied = apply_profile(&profile, CODEX_PROVIDER, &catalog()[..1], false).unwrap();
            assert_eq!(applied.listed, vec!["gpt-6.1-sol"]);
            assert!(applied.added.is_empty());
            assert_eq!(applied.text, profile);
        }
    }

    #[test]
    fn yaml_regression_crlf_and_trailing_newline_are_preserved() {
        for trailing_newline in [false, true] {
            let profile = if trailing_newline {
                PROFILE
            } else {
                PROFILE.trim_end_matches('\n')
            }
            .replace('\n', "\r\n");
            let applied = apply_profile(&profile, CODEX_PROVIDER, &catalog(), false).unwrap();
            assert_eq!(
                applied.text.matches('\n').count(),
                applied.text.matches("\r\n").count()
            );
            assert_eq!(applied.text.ends_with('\n'), trailing_newline);
            assert!(applied
                .text
                .contains("          - id: gpt-5.6-sol\r\n            name: GPT-5.6 Sol\r\n"));
            assert!(applied
                .text
                .contains("      opencode-go:\r\n        apiKeyEnv: OPENCODE_GO_API_KEY\r\n"));
            let again = apply_profile(&applied.text, CODEX_PROVIDER, &catalog(), false).unwrap();
            assert_eq!(again.text, applied.text);
            assert!(again.added.is_empty());
        }
        let profile = KIMI_PROFILE.replace('\n', "\r\n");
        let models = catalog_from_listing(&kimi_listing(), DEFAULT_MAX_TOKENS);
        let applied = apply_profile(&profile, KIMI_PROVIDER, &models, true).unwrap();
        assert!(applied.text.contains("            name: K2.8 Preview\r\n"));
        assert_eq!(
            applied.text.matches('\n').count(),
            applied.text.matches("\r\n").count()
        );
    }

    #[test]
    fn yaml_regression_mixed_line_endings_are_not_silently_rewritten() {
        let profile = PROFILE.replacen('\n', "\r\n", 1);
        assert_eq!(
            apply_profile(&profile, CODEX_PROVIDER, &[], false)
                .unwrap()
                .text,
            profile
        );
        let error = apply_profile(&profile, CODEX_PROVIDER, &catalog(), false).unwrap_err();
        assert!(error.to_string().contains("mixed line endings"));
    }

    #[test]
    fn yaml_regression_unsupported_profiles_are_not_saved() {
        let dir = std::env::temp_dir().join(format!(
            "rdsh-models-yaml-{}-{}",
            std::process::id(),
            crate::local_http::random_token().unwrap()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("cordis.patch.yml");
        for (provider, profile, models, refresh_names) in [
            (CODEX_PROVIDER, "- id: llm-pi-ai\n  config:\n    providers:\n      openai-codex:\n        models: [{id: old}]\n".to_string(), catalog(), false),
            (CODEX_PROVIDER, "- id: llm-pi-ai\n  config:\n    providers:\n      openai-codex:\n        models:\n        - id: old\n".to_string(), catalog(), false),
            (KIMI_PROVIDER, KIMI_PROFILE.replace("name: kimi-for-coding", "name: |-\n              Kimi: Legacy"), catalog_from_listing(&kimi_listing(), DEFAULT_MAX_TOKENS), true),
        ] {
            std::fs::write(&path, &profile).unwrap();
            let planned = vec![Planned::Ready(ProviderPlan { provider, models, refresh_names, source: "fixture".to_string() })];
            let reports = sync_profile_locked("web", &path, &planned, false).unwrap();
            assert_eq!(std::fs::read_to_string(&path).unwrap(), profile);
            assert!(reports.iter().all(|r| !r.written && r.skipped.is_some()));
        }
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn review_regression_multiline_and_tagged_names_are_refused() {
        for value in [
            "\"Legacy\n              custom\"",
            "'Legacy\n              custom'",
            "Legacy\n              custom",
            "!!str |-\n              Legacy",
        ] {
            let profile = KIMI_PROFILE.replace("name: kimi-for-coding", &format!("name: {value}"));
            let models = catalog_from_listing(&kimi_listing(), DEFAULT_MAX_TOKENS);
            assert!(apply_profile(&profile, KIMI_PROVIDER, &models, true).is_err());
        }
    }

    #[test]
    fn review_regression_scalar_updates_keep_inline_comments() {
        let profile =
            KIMI_PROFILE.replace("name: kimi-for-coding", "name:   kimi-for-coding  # keep");
        let models = catalog_from_listing(&kimi_listing(), DEFAULT_MAX_TOKENS);
        let applied = apply_profile(&profile, KIMI_PROVIDER, &models[..1], true).unwrap();
        assert_eq!(
            applied.text,
            profile.replace(
                "name:   kimi-for-coding  # keep",
                "name:   K2.8 Preview  # keep"
            )
        );
        let profile = "- id: llm-pi-ai\n  config:\n    providers:\n      openai-codex:\n        models: [] # keep\n";
        let applied = apply_profile(profile, CODEX_PROVIDER, &catalog(), false).unwrap();
        assert!(applied.text.contains("        models:  # keep\n"));
    }

    #[test]
    fn review_regression_name_first_updates_and_flow_names_are_refused() {
        let profile = "- id: llm-pi-ai\n  config:\n    providers:\n      kimi-coding:\n        models:\n          - name: kimi-for-coding # keep\n            id: kimi-for-coding\n";
        let models = catalog_from_listing(&kimi_listing(), DEFAULT_MAX_TOKENS);
        let applied = apply_profile(profile, KIMI_PROVIDER, &models[..1], true).unwrap();
        assert_eq!(
            applied.text,
            profile.replace("name: kimi-for-coding", "name: K2.8 Preview")
        );
        let profile = "- id: llm-pi-ai\n  config:\n    providers:\n      kimi-coding:\n        models:\n          - {id: kimi-for-coding, name: kimi-for-coding}\n";
        assert!(apply_profile(profile, KIMI_PROVIDER, &models[..1], true).is_err());
    }

    #[test]
    fn review_regression_bare_dash_items_are_recognized() {
        let profile = "- id: llm-pi-ai\n  config:\n    providers:\n      openai-codex:\n        models:\n          -\n            id: gpt-6.1-sol\n            name: Custom\n";
        let applied = apply_profile(profile, CODEX_PROVIDER, &catalog()[..1], false).unwrap();
        assert_eq!(applied.listed, vec!["gpt-6.1-sol"]);
        assert!(applied.added.is_empty());
        assert_eq!(applied.text, profile);
    }

    #[test]
    fn review_regression_escaped_ids_are_decoded_and_aliases_are_refused() {
        for item in [
            "id: \"gpt\\u002d6.1\\u002dsol\"",
            "{id: \"gpt\\u002d6.1\\u002dsol\", name: Custom}",
        ] {
            let profile = format!("- id: llm-pi-ai\n  config:\n    providers:\n      openai-codex:\n        models:\n          - {item}\n");
            let applied = apply_profile(&profile, CODEX_PROVIDER, &catalog()[..1], false).unwrap();
            assert_eq!(applied.text, profile);
            assert!(applied.added.is_empty());
        }
        let profile = "- id: llm-pi-ai\n  config:\n    providers:\n      openai-codex:\n        models:\n          - id: *model\n";
        assert!(apply_profile(profile, CODEX_PROVIDER, &catalog()[..1], false).is_err());
    }

    #[test]
    fn review_regression_mappings_and_scalar_providers_are_refused() {
        for profile in ["- id: llm-pi-ai\n  config:\n    providers:\n      openai-codex:\n        models:\n          id: old\n          name: Keep\n", "- id: llm-pi-ai\n  config:\n    providers:\n      openai-codex: custom\n"] {
            assert!(apply_profile(profile, CODEX_PROVIDER, &catalog(), false).is_err());
        }
    }

    #[test]
    fn ownership_regression_uses_only_direct_profile_keys() {
        let profile = "- id: llm-pi-ai\n  config:\n    providers:\n      openai-codex:\n        metadata:\n          models:\n            - id: old\n              name: Keep nested\n        models:\n          - id: gpt-6.1-sol\n            name: Already present\n";
        let applied = apply_profile(profile, CODEX_PROVIDER, &catalog()[..1], false).unwrap();
        assert_eq!(applied.text, profile);
        assert_eq!(applied.listed, vec!["gpt-6.1-sol"]);
        assert!(applied.added.is_empty());
        let profile = "- id: llm-pi-ai\n  config:\n    providers:\n      auxiliary:\n        openai-codex:\n          models:\n            - id: old\n              name: Keep nested\n      openai-codex:\n        models:\n          - id: gpt-6.1-sol\n            name: Already present\n";
        let applied = apply_profile(profile, CODEX_PROVIDER, &catalog()[..1], false).unwrap();
        assert_eq!(applied.text, profile);
        assert_eq!(applied.listed, vec!["gpt-6.1-sol"]);
        assert!(applied.added.is_empty());
        let profile = "- id: another-plugin\n  config:\n    metadata:\n      id: llm-pi-ai\n    providers:\n      openai-codex:\n        models:\n          - id: old\n            name: Other plugin\n- id: llm-pi-ai\n  config:\n    providers:\n      openai-codex:\n        models:\n          - id: gpt-6.1-sol\n            name: Already present\n";
        let applied = apply_profile(profile, CODEX_PROVIDER, &catalog()[..1], false).unwrap();
        assert_eq!(applied.text, profile);
        assert_eq!(applied.listed, vec!["gpt-6.1-sol"]);
        assert!(applied.added.is_empty());
        let profile = "- id: llm-pi-ai\n  config:\n    providers:\n      openai-codex:\n        models:\n          - metadata:\n              id: gpt-6.1-sol\n";
        assert!(apply_profile(profile, CODEX_PROVIDER, &catalog()[..1], false).is_err());
    }

    #[test]
    fn ownership_regression_rejects_duplicate_llm_pi_ai_entries() {
        for first_provider in [CODEX_PROVIDER, "unrelated"] {
            for second_entry in ["- id: llm-pi-ai", "- name: '@deepseek-ai/dsh-llm-pi-ai'"] {
                let profile = format!("- id: llm-pi-ai\n  config:\n    providers:\n      {first_provider}:\n        models: []\n{second_entry}\n  config:\n    providers:\n      openai-codex:\n        models: []\n");
                assert!(configures(&profile, CODEX_PROVIDER));
                let error = apply_profile(&profile, CODEX_PROVIDER, &catalog(), false)
                    .unwrap_err()
                    .to_string();
                assert!(error.contains("multiple llm-pi-ai"), "{error}");
            }
        }
    }

    #[test]
    fn ownership_regression_parent_scalars_are_not_mappings() {
        let profile = "- id: llm-pi-ai\n  config:\n    providers: |\n      openai-codex:\n        models: []\n";
        assert!(apply_profile(profile, CODEX_PROVIDER, &catalog()[..1], false).is_err());
        let profile = "- id: llm-pi-ai\n  config: |\n    providers:\n      openai-codex:\n        models: []\n";
        assert!(apply_profile(profile, CODEX_PROVIDER, &catalog()[..1], false).is_err());
    }

    #[test]
    fn ownership_regression_quoted_name_keys_keep_their_spelling() {
        for (head, name) in [
            ("id: kimi-for-coding", "\"name\": Legacy # keep"),
            ("id: kimi-for-coding", "'name': Legacy # keep"),
            ("\"name\": Legacy # keep", "id: kimi-for-coding"),
        ] {
            let profile = format!("- id: llm-pi-ai\n  config:\n    providers:\n      kimi-coding:\n        models:\n          - {head}\n            {name}\n");
            let models = catalog_from_listing(&kimi_listing(), DEFAULT_MAX_TOKENS);
            let applied = apply_profile(&profile, KIMI_PROVIDER, &models[..1], true).unwrap();
            assert_eq!(applied.text, profile.replace("Legacy", "K2.8 Preview"));
            assert_eq!(applied.renamed[0].from, "Legacy");
        }
    }

    #[test]
    fn ownership_regression_borrows_only_real_model_caps_including_flow() {
        for (items, expected) in [
            ("          - {id: old, name: Keep, maxTokens: 8192}\n", 8192),
            ("          - {id: old, name: Keep, \"maxTokens\": 8192}\n", 8192),
            ("          - {id: old, maxTokens: 8192}\n          - id: old-block\n            maxTokens: 16384\n            metadata:\n              maxTokens: 999999\n", 16384),
        ] {
            let profile = format!("- id: llm-pi-ai\n  config:\n    providers:\n      openai-codex:\n        models:\n{items}");
            let applied = apply_profile(&profile, CODEX_PROVIDER, &catalog()[..1], false).unwrap();
            assert!(applied.text.contains(&format!("maxTokens: {expected}\n            input:")));
        }
    }

    #[test]
    fn catalog_regression_compact_item_keys_use_the_dash_column() {
        for step in 1..=8 {
            for state in ["block", "empty", "missing"] {
                let provider = " ".repeat(2 + step * 2);
                let models = " ".repeat(2 + step * 3);
                let item = " ".repeat(2 + step * 4);
                let input = format!("- id: llm-pi-ai\n  config:\n{}providers:\n{provider}openai-codex:\n{models}baseURL: https://127.0.0.1:9\n{}", " ".repeat(2 + step), match state {
                    "block" => format!("{models}models:\n{item}- id: old\n{item}  name: Keep\n"),
                    "empty" => format!("{models}models: [] # keep\n"),
                    _ => String::new(),
                });
                let applied =
                    apply_profile(&input, CODEX_PROVIDER, &catalog()[..1], false).unwrap();
                assert!(
                    applied.text.contains(&format!(
                        "{item}- id: gpt-6.1-sol\n{item}  name: GPT-6.1-Sol\n"
                    )),
                    "step {step}/{state}: {}",
                    applied.text
                );
                let again =
                    apply_profile(&applied.text, CODEX_PROVIDER, &catalog()[..1], false).unwrap();
                assert_eq!(again.text, applied.text);
                assert!(again.added.is_empty());
            }
        }
    }

    #[test]
    fn catalog_regression_duplicate_ids_are_added_only_once() {
        for provider in [CODEX_PROVIDER, KIMI_PROVIDER] {
            let profile = format!("- id: llm-pi-ai\n  config:\n    providers:\n      {provider}:\n        models: []\n");
            let model = catalog()[0].clone();
            let models = vec![model.clone(), model];
            let applied =
                apply_profile(&profile, provider, &models, provider == KIMI_PROVIDER).unwrap();
            assert_eq!(applied.added, vec!["gpt-6.1-sol"]);
            assert_eq!(applied.text.matches("- id: gpt-6.1-sol").count(), 1);
            let again =
                apply_profile(&applied.text, provider, &models, provider == KIMI_PROVIDER).unwrap();
            assert_eq!(again.text, applied.text);
            assert!(again.added.is_empty() && again.renamed.is_empty());
        }
    }

    #[test]
    fn catalog_regression_max_tokens_follow_dsh_numeric_scalars() {
        for cap in [
            "0x2000",
            "0o20000",
            "0b10000000000000",
            "+8192",
            "8192.0",
            "8.192e3",
            "008192",
            "!!int 0x2000",
            "8192",
        ] {
            for flow in [false, true] {
                let item = if flow {
                    format!("          - {{id: old, maxTokens: {cap}}}\n")
                } else {
                    format!("          - id: old\n            maxTokens: {cap} # keep\n")
                };
                let profile = format!("- id: llm-pi-ai\n  config:\n    providers:\n      openai-codex:\n        models:\n{item}");
                let applied =
                    apply_profile(&profile, CODEX_PROVIDER, &catalog()[..1], false).unwrap();
                assert!(
                    applied.text.contains("maxTokens: 8192\n            input:"),
                    "{cap}: {}",
                    applied.text
                );
                assert!(applied.text.contains(&item));
            }
        }
        for cap in [
            "8_192",
            "0",
            "-1",
            "8192.5",
            "'8192'",
            "!!str 8192",
            ".inf",
            "*unknown",
        ] {
            let profile = format!("- id: llm-pi-ai\n  config:\n    providers:\n      openai-codex:\n        models:\n          - id: old\n            maxTokens: {cap}\n");
            assert!(
                apply_profile(&profile, CODEX_PROVIDER, &catalog()[..1], false).is_err(),
                "{cap}"
            );
        }
    }

    #[test]
    fn scalar_semantics_regression_catalog_strings_keep_type_and_value() {
        for value in [
            "123",
            "true",
            "null",
            "False",
            "0x2000",
            ".inf",
            "First\nSecond",
            "a\rb",
            "a\u{85}b",
            "a\u{2028}b",
            "a\u{2029}b",
            " quotes: 'x' ",
            "a\\b",
            "a\tb",
            "日本語",
        ] {
            let scalar = yaml_scalar(value);
            assert!(
                scalar.starts_with('"') || scalar.starts_with('\''),
                "{value:?}: {scalar}"
            );
            assert!(!scalar.contains(['\n', '\r', '\u{85}', '\u{2028}', '\u{2029}']));
            assert_eq!(model_scalar(&scalar).unwrap(), value);
        }
        for escaped in [r#""gpt\u002d6.1\u002dsol""#, r#""gpt\x2d6.1\x2dsol""#] {
            assert_eq!(model_scalar(escaped).unwrap(), "gpt-6.1-sol");
        }
    }

    #[test]
    fn scalar_semantics_regression_provider_values_match_yaml() {
        for (key, value) in [
            ("apiKeyEnv", "RDSH_FIXTURE_KIMI_KEY # keep"),
            ("\"apiKeyEnv\"", "\"RDSH_FIXTURE_KIMI_KEY\" # keep"),
            ("'apiKeyEnv'", "'RDSH_FIXTURE_KIMI_KEY' # keep"),
            ("apiKeyEnv", r#""RDSH_FIXTURE_KIMI_\x4bEY" # keep"#),
        ] {
            let profile = format!("- id: llm-pi-ai\n  config:\n    providers:\n      kimi-coding:\n        {key}: {value}\n        \"baseURL\": \"https://127.0.0.1:9\" # keep\n        models: []\n");
            let lines: Vec<String> = profile.lines().map(str::to_string).collect();
            let site = locate_owned(&lines, KIMI_PROVIDER).unwrap();
            assert_eq!(
                scalar_in(&lines, &site, "apiKeyEnv"),
                Some("RDSH_FIXTURE_KIMI_KEY".to_string())
            );
            assert_eq!(
                scalar_in(&lines, &site, "baseURL"),
                Some("https://127.0.0.1:9".to_string())
            );
        }
        let profile = "- id: \"llm\\u002dpi\\u002dai\"\n  config:\n    providers:\n      kimi-coding:\n        apiKeyEnv: RDSH_FIXTURE_KIMI_KEY\n        models: []\n";
        let lines: Vec<String> = profile.lines().map(str::to_string).collect();
        assert!(locate_owned(&lines, KIMI_PROVIDER).is_ok());
        assert!(configures(profile, KIMI_PROVIDER));
    }

    #[test]
    fn scalar_semantics_regression_missing_kimi_names_are_inserted() {
        let models = catalog_from_listing(&kimi_listing(), DEFAULT_MAX_TOKENS);
        for item in ["          - id: kimi-for-coding\n", "          -\n            id: kimi-for-coding # keep\n", "          - metadata:\n              sentinel: Keep\n            id: kimi-for-coding\n"] {
            let profile = format!("- id: llm-pi-ai\n  config:\n    providers:\n      kimi-coding:\n        models:\n{item}");
            let applied = apply_profile(&profile, KIMI_PROVIDER, &models, true).unwrap();
            assert!(applied.text.contains("            name: K2.8 Preview\n"));
            assert_eq!(applied.renamed[0].id, "kimi-for-coding");
            let again = apply_profile(&applied.text, KIMI_PROVIDER, &models, true).unwrap();
            assert_eq!(again.text, applied.text);
            assert!(again.added.is_empty() && again.renamed.is_empty());
        }
    }

    #[test]
    fn scalar_semantics_regression_new_models_preserve_provider_tail() {
        for scalar in ["|+", ">+", "|", ">-", "|2+"] {
            for tail in ["\n\n", "\n", ""] {
                let profile = format!("- id: llm-pi-ai\n  config:\n    providers:\n      openai-codex:\n        displayName: {scalar}\n          Keep{tail}");
                let applied =
                    apply_profile(&profile, CODEX_PROVIDER, &catalog()[..1], false).unwrap();
                assert!(
                    applied.text.ends_with(&format!(
                        "        displayName: {scalar}\n          Keep{tail}"
                    )),
                    "{scalar}/{tail:?}: {}",
                    applied.text
                );
                let again =
                    apply_profile(&applied.text, CODEX_PROVIDER, &catalog()[..1], false).unwrap();
                assert_eq!(again.text, applied.text);
            }
        }
        for field in [
            "\"display:Name\": |+ # keep: tail",
            "displayName: >+ # keep: tail",
            "displayName: !!str |+",
        ] {
            let tail = format!("        {field}\n          Keep\n\n");
            let profile =
                format!("- id: llm-pi-ai\n  config:\n    providers:\n      openai-codex:\n{tail}");
            let applied = apply_profile(&profile, CODEX_PROVIDER, &catalog()[..1], false).unwrap();
            assert!(applied.text.ends_with(&tail));
        }
    }

    #[test]
    fn a_concurrent_edit_between_fetch_and_lock_is_not_lost() {
        let dir = std::env::temp_dir().join(format!(
            "rdsh-models-lock-{}-{}",
            std::process::id(),
            crate::local_http::random_token().unwrap()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("cordis.patch.yml");
        std::fs::write(&path, PROFILE).unwrap();
        // The catalog was fetched from a snapshot; a live editor then writes.
        std::fs::write(&path, format!("{PROFILE}# written while the fetch ran\n")).unwrap();
        let planned = vec![Planned::Ready(ProviderPlan {
            provider: CODEX_PROVIDER,
            models: catalog(),
            refresh_names: false,
            source: "fixture".to_string(),
        })];
        let reports = sync_profile_locked("web", &path, &planned, false).unwrap();
        let written = std::fs::read_to_string(&path).unwrap();
        assert!(written.contains("# written while the fetch ran"));
        assert!(written.contains("- id: gpt-6.1-sol"));
        assert_eq!(
            reports
                .iter()
                .map(|report| report.added.len())
                .sum::<usize>(),
            2
        );
        assert!(reports.iter().all(|report| report.written));
        std::fs::remove_dir_all(dir).unwrap();
    }
}
