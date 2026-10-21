//! 手元の環境から、どのプロバイダーが使える状態かを割り出す。
//!
//! dsh 本体は既知のプロバイダーをカタログで解決するので、rdsh が経路を書く
//! 必要はない。ここでは (1) dsh がそのまま使えるもの、(2) rdsh で経路を
//! 登録する必要があるもの、を分けて報告する。読み取り専用で、見つけた鍵の
//! 値は決して出力しない。

use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::json;

use crate::locale::{self, Locale};
use crate::providers;

/// dsh 0.2.1-rc.2 の PROVIDER_DATA（@deepseek-ai/dsh-llm-pi-ai）に載って
/// いるプロバイダーの抜粋と、その認証に使う環境変数。ここにある id は dsh が
/// 自分で解決するため、rdsh は経路を書かない。
const DSH_KNOWN: &[(&str, &[&str])] = &[
    ("anthropic", &["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN"]),
    ("baseten", &["BASETEN_API_KEY"]),
    ("cerebras", &["CEREBRAS_API_KEY"]),
    ("deepseek", &["DEEPSEEK_API_KEY"]),
    ("fireworks", &["FIREWORKS_API_KEY"]),
    ("github-copilot", &["COPILOT_GITHUB_TOKEN"]),
    ("google", &["GEMINI_API_KEY"]),
    ("groq", &["GROQ_API_KEY"]),
    ("huggingface", &["HF_TOKEN"]),
    ("kimi-coding", &["KIMI_API_KEY"]),
    ("minimax", &["MINIMAX_API_KEY"]),
    ("mistral", &["MISTRAL_API_KEY"]),
    ("moonshotai", &["MOONSHOT_API_KEY"]),
    ("nvidia", &["NVIDIA_API_KEY"]),
    ("openai", &["OPENAI_API_KEY"]),
    ("opencode", &["OPENCODE_API_KEY"]),
    ("opencode-go", &["OPENCODE_GO_API_KEY", "OPENCODE_API_KEY"]),
    ("openrouter", &["OPENROUTER_API_KEY"]),
    ("together", &["TOGETHER_API_KEY"]),
    ("xai", &["XAI_API_KEY"]),
    ("zai", &["ZAI_API_KEY"]),
];

/// 環境変数が入っていれば rdsh の経路を登録できるプリセット。
const ENV_PRESETS: &[(&str, &str)] = &[
    ("commandcode", "COMMANDCODE_API_KEY"),
    ("hai", "HAI_API_KEY"),
    ("sarashina", "SARASHINA_API_KEY"),
    ("ollama-cloud", "OLLAMA_CLOUD_API_KEY"),
];

/// 待ち受けていれば経路を作れるローカルサーバー。
const LOCAL_PORTS: &[(u16, &str)] = &[
    (11434, "ollama"),
    (8080, "llama.cpp"),
    (8000, "vLLM"),
    (1234, "LM Studio"),
];

/// 他ツールの設定ファイル。存在と中身の形だけを見る。
const OTHER_CONFIGS: &[(&str, &str)] = &[
    ("codex", ".codex/auth.json"),
    ("claude", ".claude.json"),
    ("gemini", ".gemini/settings.json"),
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum KeyState {
    /// 環境変数に入っている（そのままコピーできる）。
    Env,
    /// 別ツールが保存している（rdsh は読まない）。
    Elsewhere,
    /// サーバーが認証を求めない。
    NotNeeded,
    /// 手掛かりが無い。
    Missing,
}

impl KeyState {
    fn as_str(self) -> &'static str {
        match self {
            Self::Env => "env",
            Self::Elsewhere => "elsewhere",
            Self::NotNeeded => "not-needed",
            Self::Missing => "missing",
        }
    }
}

/// dsh がそのまま使えると分かったプロバイダー。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Known {
    pub provider: &'static str,
    pub evidence: String,
}

/// rdsh で経路を登録できる（または登録が必要な）候補。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Candidate {
    pub preset: String,
    /// local-openai のときだけ、経路 id を上書きする。
    pub route_id: Option<String>,
    pub label: String,
    pub base_url: Option<String>,
    pub key_state: KeyState,
    pub models: Vec<String>,
    /// 例: env:MOONSHOT_API_KEY, opencode:opencode.jsonc, port:11434。
    pub source: String,
    pub note: Option<String>,
}

impl Candidate {
    /// 今すぐ経路を書けるか。鍵が要るのに手掛かりが無いものは書かない。
    fn writable(&self) -> bool {
        matches!(self.key_state, KeyState::Env | KeyState::NotNeeded)
    }

    fn route_name(&self) -> String {
        self.route_id.clone().unwrap_or_else(|| self.preset.clone())
    }
}

/// 検出に使う環境。テストから差し替えられるようにまとめて渡す。
pub(crate) struct Scan<'a> {
    pub home: Option<PathBuf>,
    pub config: Option<PathBuf>,
    pub getenv: &'a dyn Fn(&str) -> Option<String>,
    pub port_open: &'a dyn Fn(u16) -> bool,
    pub dsh_home: Option<PathBuf>,
}

fn real_getenv(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

fn real_port_open(port: u16) -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    TcpStream::connect_timeout(&addr, Duration::from_millis(250)).is_ok()
}

impl Scan<'static> {
    pub(crate) fn real() -> Scan<'static> {
        Scan {
            home: crate::auth::home().map(PathBuf::from),
            config: crate::auth::config_dir().map(PathBuf::from),
            getenv: &real_getenv,
            port_open: &real_port_open,
            dsh_home: Some(PathBuf::from(crate::inspect::dsh_home())),
        }
    }
}

/// 検出結果。
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub(crate) struct Detected {
    pub known: Vec<Known>,
    pub candidates: Vec<Candidate>,
}

pub(crate) fn detect(scan: &Scan<'_>) -> Detected {
    let mut out = Detected::default();

    // 1. dsh がそのまま使えるプロバイダー。
    let stored = dsh_stored_refs(scan);
    for (provider, envs) in DSH_KNOWN {
        let hit = envs.iter().find(|name| (scan.getenv)(name).is_some());
        // dsh は環境変数名でキーを保存するので、名前で突き合わせる。
        let stored_name = stored.iter().find(|name| envs.contains(&name.as_str()));
        let evidence = match (hit, stored_name) {
            (Some(name), _) => format!("env:{name}"),
            (None, Some(name)) => format!("dsh:credentials({name})"),
            (None, None) => continue,
        };
        out.known.push(Known { provider, evidence });
    }
    // 他ツールの設定に鍵があれば、それも手掛かりとして出す。
    for (tool, relative) in OTHER_CONFIGS {
        let Some(path) = scan.home.as_ref().map(|h| h.join(relative)) else {
            continue;
        };
        if !path.is_file() || !file_mentions_key(&path) {
            continue;
        }
        let provider = match *tool {
            "codex" => "openai",
            "claude" => "anthropic",
            _ => "google",
        };
        if out.known.iter().any(|k| k.provider == provider) {
            continue;
        }
        out.known.push(Known {
            provider,
            evidence: format!("file:{}", path.display()),
        });
    }

    // 2. rdsh で登録する候補: 環境変数。
    for (preset, env) in ENV_PRESETS {
        let stored_here = stored.iter().any(|name| name == env);
        if (scan.getenv)(env).is_none() && !stored_here {
            let similar = similar_ref(&stored, env);
            if let Some(name) = similar {
                out.candidates.push(Candidate {
                    preset: (*preset).to_string(),
                    route_id: None,
                    label: (*preset).to_string(),
                    base_url: providers::preset_base_url(preset).map(str::to_string),
                    key_state: KeyState::Missing,
                    models: Vec::new(),
                    source: format!("dsh:credentials({name})"),
                    note: Some(format!(
                        "dsh に {name} が保存済みですが、この経路のキー名は {env} です",
                    )),
                });
            }
            continue;
        }
        let source = if (scan.getenv)(env).is_some() {
            format!("env:{env}")
        } else {
            format!("dsh:credentials({env})")
        };
        out.candidates.push(Candidate {
            preset: (*preset).to_string(),
            route_id: None,
            label: (*preset).to_string(),
            base_url: providers::preset_base_url(preset).map(str::to_string),
            key_state: KeyState::Env,
            models: Vec::new(),
            source,
            note: None,
        });
    }

    // 3. rdsh で登録する候補: 待ち受け中のローカルサーバー。
    for (port, label) in LOCAL_PORTS {
        if !(scan.port_open)(*port) {
            continue;
        }
        if *port == 11434 {
            out.candidates.push(Candidate {
                preset: "ollama".to_string(),
                route_id: None,
                label: (*label).to_string(),
                base_url: providers::preset_base_url("ollama").map(str::to_string),
                key_state: KeyState::NotNeeded,
                models: Vec::new(),
                source: format!("port:{port}"),
                note: None,
            });
        } else {
            out.candidates.push(Candidate {
                preset: "local-openai".to_string(),
                route_id: None,
                label: format!("{label} (127.0.0.1:{port})"),
                base_url: Some(format!("http://127.0.0.1:{port}/v1")),
                key_state: KeyState::NotNeeded,
                models: Vec::new(),
                source: format!("port:{port}"),
                note: None,
            });
        }
    }

    // 4. rdsh で登録する候補: OpenCode の独自プロバイダー。
    for path in opencode_paths(scan) {
        let Some(doc) = read_jsonc(&path) else {
            continue;
        };
        let Some(map) = doc.get("provider").and_then(|p| p.as_object()) else {
            continue;
        };
        for (id, entry) in map {
            if DSH_KNOWN.iter().any(|(name, _)| name == id) {
                continue;
            }
            let base_url = entry
                .get("options")
                .and_then(|o| o.get("baseURL"))
                .and_then(|v| v.as_str())
                .map(str::to_string);
            let models: Vec<String> = entry
                .get("models")
                .and_then(|m| m.as_object())
                .map(|m| m.keys().cloned().collect())
                .unwrap_or_default();
            let local = base_url
                .as_deref()
                .is_some_and(|u| u.contains("127.0.0.1") || u.contains("localhost"));
            let key_state = if local {
                KeyState::NotNeeded
            } else if opencode_has_key(scan, id) {
                KeyState::Elsewhere
            } else {
                KeyState::Missing
            };
            out.candidates.push(Candidate {
                preset: "local-openai".to_string(),
                route_id: Some(id.clone()),
                label: id.clone(),
                base_url,
                key_state,
                models,
                source: format!("opencode:{}", path.display()),
                note: None,
            });
        }
    }
    out
}

/// 同じ接頭辞で終わりだけ違うキー名（COMMANDCODE_GOAT_API_KEY など）。
fn similar_ref(stored: &[String], env: &str) -> Option<String> {
    let prefix = env.trim_end_matches("API_KEY");
    if prefix.is_empty() {
        return None;
    }
    stored
        .iter()
        .find(|name| name.starts_with(prefix) && name.ends_with("API_KEY"))
        .cloned()
}
fn dsh_stored_refs(scan: &Scan<'_>) -> Vec<String> {
    let Some(home) = &scan.dsh_home else {
        return Vec::new();
    };
    let Ok(text) = std::fs::read_to_string(home.join(".credentials.yaml")) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    let mut in_refs = false;
    for line in text.lines() {
        if line.starts_with("refs:") {
            in_refs = true;
            continue;
        }
        if in_refs {
            if !line.starts_with(' ') && !line.trim().is_empty() {
                break;
            }
            // 行は "  NAME: <秘密の値>" なので、名前だけを取り出す。
            let name = line.trim().split(':').next().unwrap_or_default().trim();
            if !name.is_empty() {
                out.push(name.to_string());
            }
        }
    }
    out
}

/// 設定ファイルに鍵らしき項目があるか。値は読まない。
fn file_mentions_key(path: &Path) -> bool {
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    if meta.len() > 1024 * 1024 {
        return false;
    }
    let Ok(text) = std::fs::read_to_string(path) else {
        return false;
    };
    ["api_key", "API_KEY", "access_token", "oauth"]
        .iter()
        .any(|needle| text.contains(needle))
}

fn opencode_paths(scan: &Scan<'_>) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Some(c) = &scan.config {
        dirs.push(c.clone());
    }
    if let Some(h) = &scan.home {
        let fallback = h.join(".config");
        if !dirs.contains(&fallback) {
            dirs.push(fallback);
        }
    }
    let mut out = Vec::new();
    for dir in dirs {
        for name in ["opencode.jsonc", "opencode.json"] {
            out.push(dir.join("opencode").join(name));
        }
    }
    out
}

fn read_jsonc(path: &Path) -> Option<serde_json::Value> {
    let meta = std::fs::metadata(path).ok()?;
    if meta.len() > 8 * 1024 * 1024 {
        return None;
    }
    let raw = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&providers::strip_jsonc(&raw)).ok()
}

fn opencode_has_key(scan: &Scan<'_>, id: &str) -> bool {
    let Some(home) = &scan.home else {
        return false;
    };
    let Some(doc) = read_jsonc(&home.join(".local/share/opencode/auth.json")) else {
        return false;
    };
    doc.get(id).is_some()
}

/// 人間向けの表示。
pub(crate) fn print(detected: &Detected, locale: Locale) {
    if detected.known.is_empty() && detected.candidates.is_empty() {
        println!(
            "{}",
            locale::diagnostic(
                locale,
                "nothing found on this machine: no provider credentials or local servers"
            )
        );
        return;
    }
    if !detected.known.is_empty() {
        println!(
            "{}",
            providers::t(
                locale,
                "[rdsh provider] dsh がそのまま使えます（登録不要）:",
                "[rdsh provider] dsh can use these as-is (no route needed):",
                "[rdsh provider] dsh 可直接使用（无需注册）："
            )
        );
        for known in &detected.known {
            println!("  {:<16} {}", known.provider, known.evidence);
        }
    }
    if !detected.candidates.is_empty() {
        println!(
            "{}",
            providers::t(
                locale,
                "[rdsh provider] rdsh で経路を登録できます:",
                "[rdsh provider] rdsh can register these routes:",
                "[rdsh provider] rdsh 可注册以下路由："
            )
        );
        for candidate in &detected.candidates {
            let key = match candidate.key_state {
                KeyState::Env => {
                    providers::t(locale, "キー: 環境変数", "key: env", "密钥：环境变量")
                }
                KeyState::Elsewhere => providers::t(
                    locale,
                    "キー: 他ツール",
                    "key: other tool",
                    "密钥：其他工具",
                ),
                KeyState::NotNeeded => providers::t(locale, "キー不要", "no key", "无需密钥"),
                KeyState::Missing => {
                    providers::t(locale, "キー未検出", "key not found", "未检测到密钥")
                }
            };
            println!(
                "  {:<16} {:<34} {:<12} {}",
                candidate.route_name(),
                candidate.base_url.as_deref().unwrap_or("-"),
                key,
                candidate.source
            );
            if let Some(note) = &candidate.note {
                println!("      {note}");
            }
        }
    }
}

pub(crate) fn to_json(detected: &Detected) -> serde_json::Value {
    json!({
        "schema": 1,
        "dshKnown": detected.known.iter().map(|k| json!({
            "provider": k.provider,
            "evidence": k.evidence,
        })).collect::<Vec<_>>(),
        "routes": detected.candidates.iter().map(|c| json!({
            "preset": c.preset,
            "route": c.route_name(),
            "baseURL": c.base_url,
            "key": c.key_state.as_str(),
            "models": c.models,
            "source": c.source,
            "writable": c.writable(),
            "note": c.note,
        })).collect::<Vec<_>>(),
    })
}

/// 検出だけを行う。
pub(crate) fn cmd_detect(json: bool, locale: Locale) -> anyhow::Result<()> {
    let detected = detect(&Scan::real());
    if json {
        println!("{}", serde_json::to_string_pretty(&to_json(&detected))?);
    } else {
        print(&detected, locale);
    }
    Ok(())
}

pub(crate) struct ImportArgs {
    pub profile: Option<String>,
    pub only: Vec<String>,
    pub discover: bool,
    pub dry_run: bool,
    pub json: bool,
}

struct Outcome {
    route: String,
    preset: String,
    ok: bool,
    error: Option<String>,
}

/// 検出した候補のうち、今すぐ書けるものを経路として登録する。
pub(crate) fn cmd_import(
    args: ImportArgs,
    configured_default_profile: &str,
    locale: Locale,
) -> anyhow::Result<()> {
    let detected = detect(&Scan::real());
    let mut outcomes: Vec<Outcome> = Vec::new();
    for candidate in &detected.candidates {
        let route = candidate.route_name();
        if !args.only.is_empty()
            && !args
                .only
                .iter()
                .any(|want| want == &route || want == &candidate.preset)
        {
            continue;
        }
        if !candidate.writable() {
            outcomes.push(Outcome {
                route,
                preset: candidate.preset.clone(),
                ok: false,
                error: Some(
                    locale::diagnostic(
                        locale,
                        "no key on this machine: pass --key-stdin to store one",
                    )
                    .to_string(),
                ),
            });
            continue;
        }
        let models = candidate.models.clone();
        let discover = args.discover
            && models.is_empty()
            && providers::preset_supports_discovery(&candidate.preset).unwrap_or(false);
        let add = providers::AddArgs {
            preset: candidate.preset.clone(),
            profile: args.profile.clone(),
            models,
            from_opencode: false,
            discover,
            base_url: candidate.base_url.clone(),
            id: candidate.route_id.clone(),
            name: None,
            key_stdin: false,
            no_key: matches!(candidate.key_state, KeyState::NotNeeded),
            effort: None,
            replace: false,
            quiet: true,
            dry_run: args.dry_run,
            json: false,
        };
        let result = providers::cmd_add(add, configured_default_profile, locale);
        match result {
            Ok(()) => outcomes.push(Outcome {
                route,
                preset: candidate.preset.clone(),
                ok: true,
                error: None,
            }),
            Err(error) => outcomes.push(Outcome {
                route,
                preset: candidate.preset.clone(),
                ok: false,
                error: Some(error.to_string()),
            }),
        }
    }

    if args.json {
        let payload = json!({
            "schema": 1,
            "dry_run": args.dry_run,
            "routes": outcomes.iter().map(|o| json!({
                "route": o.route,
                "preset": o.preset,
                "ok": o.ok,
                "error": o.error,
            })).collect::<Vec<_>>(),
        });
        println!("{}", serde_json::to_string_pretty(&payload)?);
        return Ok(());
    }
    if outcomes.is_empty() {
        println!(
            "{}",
            locale::diagnostic(locale, "nothing to import: no writable route was detected")
        );
        return Ok(());
    }
    for outcome in &outcomes {
        let mark = if outcome.ok {
            providers::t(locale, "登録", "added", "已注册")
        } else {
            providers::t(locale, "未登録", "skipped", "未注册")
        };
        match &outcome.error {
            Some(error) => println!("  {:<16} {}: {error}", outcome.route, mark),
            None => println!("  {:<16} {}", outcome.route, mark),
        }
    }
    Ok(())
}

/// setup からの自動登録。書き込める経路だけを対象にし、既にある経路は触らない。
/// 追加できた経路名を返す。鍵は決して作らない（無いものは対象外）。
pub(crate) fn auto_import(
    profile: &str,
    configured_default_profile: &str,
    locale: Locale,
) -> Vec<String> {
    let detected = detect(&Scan::real());
    if detected.candidates.is_empty() {
        return Vec::new();
    }
    let existing = providers::configured_route_ids(profile, locale);
    let mut added: Vec<String> = Vec::new();
    for candidate in &detected.candidates {
        if !candidate.writable() {
            continue;
        }
        let route = candidate.route_name();
        if existing.iter().any(|id| id == &route) {
            continue;
        }
        let add = providers::AddArgs {
            preset: candidate.preset.clone(),
            profile: Some(profile.to_string()),
            models: candidate.models.clone(),
            from_opencode: false,
            discover: candidate.models.is_empty()
                && providers::preset_supports_discovery(&candidate.preset).unwrap_or(false),
            base_url: candidate.base_url.clone(),
            id: candidate.route_id.clone(),
            name: None,
            key_stdin: false,
            no_key: matches!(candidate.key_state, KeyState::NotNeeded),
            effort: None,
            replace: false,
            quiet: true,
            dry_run: false,
            json: false,
        };
        if providers::cmd_add(add, configured_default_profile, locale).is_ok() {
            added.push(route);
        }
    }
    added
}

/// 既に設定に書かれている経路ID（読み取りのみ）。
pub(crate) fn registered_routes(profile: &str, locale: Locale) -> Vec<String> {
    providers::configured_route_ids(profile, locale)
}

/// rdsh setup とその status JSON に差し込むための検出結果。
pub(crate) fn detected_json(profile: &str) -> serde_json::Value {
    let detected = detect(&Scan::real());
    let existing = providers::configured_route_ids(profile, Locale::Japanese);
    let mut value = to_json(&detected);
    if let Some(routes) = value.get_mut("routes").and_then(|v| v.as_array_mut()) {
        for route in routes {
            let registered = route
                .get("route")
                .and_then(|v| v.as_str())
                .is_some_and(|id| existing.iter().any(|known| known == id));
            route["registered"] = serde_json::json!(registered);
        }
    }
    value
}

/// rdsh setup の案内に続けて出す短い要約。読み取りのみで、何も書かない。
pub(crate) fn print_setup_block(locale: Locale, registered: &[String]) {
    let detected = detect(&Scan::real());
    if detected.known.is_empty() && detected.candidates.is_empty() {
        return;
    }
    if !detected.known.is_empty() {
        let names: Vec<&str> = detected.known.iter().map(|known| known.provider).collect();
        let joined = names.join(", ");
        println!(
            "{}",
            providers::t(
                locale,
                &format!("[rdsh setup] dsh がそのまま使えます（登録不要）: {joined}"),
                &format!("[rdsh setup] dsh can use these as-is (no route needed): {joined}"),
                &format!("[rdsh setup] dsh 可直接使用（无需注册）：{joined}"),
            )
        );
    }
    let is_added = |route: &str| registered.iter().any(|name| name == route);
    let label = |candidate: &Candidate| {
        let base = format!(
            "{} ({})",
            candidate.route_name(),
            candidate.base_url.as_deref().unwrap_or("-")
        );
        match is_added(&candidate.route_name()) {
            true => format!(
                "{base} {}",
                providers::t(locale, "登録済み", "registered", "已注册")
            ),
            false => base,
        }
    };
    let writable: Vec<String> = detected
        .candidates
        .iter()
        .filter(|candidate| candidate.writable())
        .map(label)
        .collect();
    let pending = detected
        .candidates
        .iter()
        .any(|candidate| candidate.writable() && !is_added(&candidate.route_name()));
    let blocked: Vec<String> = detected
        .candidates
        .iter()
        .filter(|candidate| !candidate.writable())
        .map(|candidate| candidate.route_name())
        .collect();
    if !writable.is_empty() {
        let joined = writable.join(", ");
        println!(
            "{}",
            providers::t(
                locale,
                &format!("[rdsh setup] 登録できる経路: {joined}"),
                &format!("[rdsh setup] routes detected: {joined}"),
                &format!("[rdsh setup] 检测到的路由：{joined}"),
            )
        );
    }
    if pending {
        println!(
            "{}",
            providers::t(
                locale,
                "[rdsh setup] 残りは rdsh provider import で登録できます",
                "[rdsh setup] run rdsh provider import for the rest",
                "[rdsh setup] 其余可用 rdsh provider import 注册",
            )
        );
    }
    if !blocked.is_empty() {
        let joined = blocked.join(", ");
        println!(
            "{}",
            providers::t(
                locale,
                &format!(
                    "[rdsh setup] 鍵が見つからないため保留: {joined}（rdsh provider add <preset> --key-stdin）"
                ),
                &format!(
                    "[rdsh setup] waiting for a key: {joined} (rdsh provider add <preset> --key-stdin)"
                ),
                &format!(
                    "[rdsh setup] 因缺少密钥而暂缓：{joined}（rdsh provider add <preset> --key-stdin）"
                ),
            )
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    const SECRET: &str = "sentinel-secret-value";

    fn temp_home(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("rdsh-detect-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("temp home");
        dir
    }

    fn write(path: &Path, body: &str) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("parent");
        }
        std::fs::write(path, body).expect("write");
    }

    fn with_scan<R>(
        home: &Path,
        env: &HashMap<String, String>,
        ports: &[u16],
        run: impl FnOnce(&Scan<'_>) -> R,
    ) -> R {
        let getenv = |name: &str| env.get(name).cloned();
        let port_open = |port: u16| ports.contains(&port);
        let scan = Scan {
            home: Some(home.to_path_buf()),
            config: Some(home.join(".config")),
            getenv: &getenv,
            port_open: &port_open,
            dsh_home: Some(home.to_path_buf()),
        };
        run(&scan)
    }
    fn env_with(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
            .collect()
    }

    #[test]
    fn a_codex_key_file_marks_openai_as_usable() {
        let home = temp_home("codex");
        write(
            &home.join(".codex/auth.json"),
            "{\"OPENAI_API_KEY\": \"x\", \"auth_mode\": \"apikey\"}",
        );
        let env = HashMap::new();
        let found = with_scan(&home, &env, &[], detect);
        assert!(
            found
                .known
                .iter()
                .any(|k| k.provider == "openai" && k.evidence.starts_with("file:")),
            "{:?}",
            found.known
        );
    }

    #[test]
    fn dsh_stored_key_names_map_to_providers() {
        let home = temp_home("creds");
        write(
            &home.join(".credentials.yaml"),
            "version: 1\nrecords: {}\nrefs:\n  DEEPSEEK_API_KEY: sk-x\n",
        );
        let env = HashMap::new();
        let found = with_scan(&home, &env, &[], detect);
        assert!(
            found
                .known
                .iter()
                .any(|k| k.provider == "deepseek" && k.evidence.contains("DEEPSEEK_API_KEY")),
            "{:?}",
            found.known
        );
    }

    #[test]
    fn a_listening_local_server_becomes_a_keyless_route() {
        let home = temp_home("port");
        let env = HashMap::new();
        let found = with_scan(&home, &env, &[11434, 8080], detect);
        let ollama = found
            .candidates
            .iter()
            .find(|c| c.preset == "ollama")
            .expect("ollama candidate");
        assert_eq!(ollama.key_state, KeyState::NotNeeded);
        assert!(ollama.writable());
        let llama = found
            .candidates
            .iter()
            .find(|c| c.base_url.as_deref() == Some("http://127.0.0.1:8080/v1"))
            .expect("local-openai candidate");
        assert_eq!(llama.preset, "local-openai");
        assert!(llama.writable());
    }

    #[test]
    fn an_environment_key_makes_a_preset_writable() {
        let home = temp_home("env");
        let env = env_with(&[("HAI_API_KEY", SECRET)]);
        let found = with_scan(&home, &env, &[], detect);
        let hai = found
            .candidates
            .iter()
            .find(|c| c.preset == "hai")
            .expect("hai candidate");
        assert_eq!(hai.key_state, KeyState::Env);
        assert!(hai.writable());
        assert_eq!(
            hai.base_url.as_deref(),
            Some("https://hai-api.hcloud.ltd/v1")
        );
    }

    #[test]
    fn a_differently_named_stored_key_is_reported_but_not_imported() {
        let home = temp_home("similar");
        write(
            &home.join(".credentials.yaml"),
            "version: 1\nrecords: {}\nrefs:\n  COMMANDCODE_GOAT_API_KEY: SENTINEL\n",
        );
        let env = HashMap::new();
        let found = with_scan(&home, &env, &[], detect);
        let commandcode = found
            .candidates
            .iter()
            .find(|c| c.preset == "commandcode")
            .expect("commandcode candidate");
        assert_eq!(commandcode.key_state, KeyState::Missing);
        assert!(!commandcode.writable());
        assert!(commandcode.note.is_some());
        assert!(commandcode.source.contains("COMMANDCODE_GOAT_API_KEY"));
    }

    #[test]
    fn an_opencode_custom_provider_becomes_a_route() {
        let home = temp_home("opencode");
        write(
            &home.join(".config/opencode/opencode.jsonc"),
            "{\n  // local gateway\n  \"provider\": {\n    \"gateway\": {\n      \"options\": { \"baseURL\": \"http://127.0.0.1:8787/v1\" },\n      \"models\": { \"gpt-4o\": {}, \"gpt-4.1\": {} }\n    }\n  }\n}\n",
        );
        let env = HashMap::new();
        let found = with_scan(&home, &env, &[], detect);
        let gateway = found
            .candidates
            .iter()
            .find(|c| c.route_id.as_deref() == Some("gateway"))
            .expect("gateway candidate");
        assert_eq!(gateway.preset, "local-openai");
        assert_eq!(gateway.key_state, KeyState::NotNeeded);
        assert_eq!(gateway.models.len(), 2);
        assert!(gateway.writable());
    }

    #[test]
    fn a_provider_dsh_already_knows_is_not_turned_into_a_route() {
        let home = temp_home("known");
        write(
            &home.join(".config/opencode/opencode.jsonc"),
            "{\"provider\": {\"moonshotai\": {\"options\": {\"baseURL\": \"https://api.moonshot.ai/v1\"}}}}",
        );
        let env = env_with(&[("MOONSHOT_API_KEY", SECRET)]);
        let found = with_scan(&home, &env, &[], detect);
        assert!(found.known.iter().any(|k| k.provider == "moonshotai"));
        assert!(
            !found
                .candidates
                .iter()
                .any(|c| c.route_id.as_deref() == Some("moonshotai")),
            "{:?}",
            found.candidates
        );
    }

    #[test]
    fn the_report_never_carries_a_key_value() {
        let home = temp_home("secret");
        write(
            &home.join(".credentials.yaml"),
            &format!("version: 1\nrecords: {{}}\nrefs:\n  HAI_API_KEY: {SECRET}\n"),
        );
        write(
            &home.join(".codex/auth.json"),
            &format!("{{\"OPENAI_API_KEY\": \"{SECRET}\"}}"),
        );
        let env = env_with(&[("COMMANDCODE_API_KEY", SECRET)]);
        let found = with_scan(&home, &env, &[11434], detect);
        let text = serde_json::to_string(&to_json(&found)).expect("json");
        assert!(!text.contains(SECRET), "{text}");
        assert!(!format!("{found:?}").contains(SECRET));
    }
}
