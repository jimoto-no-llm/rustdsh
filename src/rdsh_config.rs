//! Unified settings backed by `$DSH_HOME/rdsh.json` (schema v1).
//!
//! `serde_json` + `anyhow` + `std` のみを使います。
//! ファイル欠落は既定値にフォールバックし、不正値は clamp/切詰めで吸収します。
//! 存在するのに壊れた JSON は既定値に置き換えず hard error にします
//!（guard.deny 空での fail-open 起動と `settings set` による上書き消去を防ぐため）。
//! 旧 `rdsh-context.json` は読み取り専用で context 節の補完に使います（書き込みません）。

/// rdsh.json のスキーマ版。
pub const SCHEMA_VERSION: u32 = 1;

const MAX_ITEMS: usize = 50;
const GOAL_CHARS: usize = 2000;
const TEXT_CHARS: usize = 500;
const PATH_CHARS: usize = 300;
const PROFILE_CHARS: usize = 200;
const URL_CHARS: usize = 2000;

// ---- top-level ----

/// rdsh.json 全体 (schema v1)。
#[derive(Debug, Clone, PartialEq)]
pub struct RdshSettings {
    pub schema: u32,
    pub general: GeneralSection,
    pub tokens: TokensSection,
    pub search: SearchSection,
    pub compact: CompactSection,
    pub sessions: SessionsSection,
    pub logs: LogsSection,
    pub serve: ServeSection,
    pub guard: GuardSection,
    pub bench: BenchSection,
    pub setup: SetupSection,
    pub beta: BetaSection,
    pub context: ContextSection,
    pub extras: ExtrasSection,
}

/// Optional server-type features, off by default. Known ids are listed in
/// KNOWN_EXTRAS; unknown entries are ignored by the gate.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct ExtrasSection {
    pub enable: Vec<String>,
}

/// Extra feature ids that can be enabled via `extras.enable`.
/// `serve` = `rdsh serve` dashboard, `search-web` = `rdsh search-web`.
/// Setup itself (`rdsh setup --web`) always runs: it hosts the switches.
pub const KNOWN_EXTRAS: &[&str] = &["serve", "search-web"];

/// True when the named extra is enabled in settings (unknown ids never match).
pub fn extra_enabled(cfg: &RdshSettings, id: &str) -> bool {
    KNOWN_EXTRAS.contains(&id) && cfg.extras.enable.iter().any(|e| e == id)
}

#[derive(Debug, Clone, PartialEq)]
pub struct GeneralSection {
    pub slim: bool,
    pub passthrough: bool,
    pub dry_run: bool,
    pub default_profile: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct TokensSection {
    pub default_budget: usize,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SearchSection {
    pub dir: String,
    pub max: usize,
    pub web_limit: usize,
    pub searxng_url: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CompactSection {
    pub max_tokens: usize,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SessionsSection {
    pub limit: usize,
    pub with_tokens: bool,
    /// Stale-estimate window for growing session files (0 disables).
    pub stale_secs: u64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct LogsSection {
    pub tail: usize,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ServeSection {
    pub port: u16,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct GuardSection {
    pub deny: Vec<String>,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct BenchSection {
    pub n: u32,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct SetupSection {
    /// 0 = ランダムポート。
    pub web_port: u16,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct BetaSection {
    pub context_engine: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ContextSection {
    pub token_budget: usize,
    pub enable_retriever: bool,
    pub enable_packer: bool,
    pub enable_verifier: bool,
    pub goal: String,
    pub decisions: Vec<String>,
    pub constraints: Vec<String>,
    pub working_files: Vec<String>,
    pub open_tasks: Vec<String>,
    pub max_code_hits: usize,
    pub max_sessions: usize,
    pub include_git_diff: bool,
}

impl Default for GeneralSection {
    fn default() -> Self {
        Self {
            slim: true,
            passthrough: false,
            dry_run: false,
            default_profile: String::new(),
        }
    }
}

impl Default for TokensSection {
    fn default() -> Self {
        Self {
            default_budget: 4000,
        }
    }
}

impl Default for SearchSection {
    fn default() -> Self {
        Self {
            dir: ".".to_string(),
            max: 100,
            web_limit: 10,
            searxng_url: String::new(),
        }
    }
}

impl Default for CompactSection {
    fn default() -> Self {
        Self { max_tokens: 8000 }
    }
}

impl Default for SessionsSection {
    fn default() -> Self {
        Self {
            limit: 20,
            with_tokens: false,
            stale_secs: 60,
        }
    }
}

impl Default for LogsSection {
    fn default() -> Self {
        Self { tail: 50 }
    }
}

impl Default for ServeSection {
    fn default() -> Self {
        Self { port: 38080 }
    }
}

impl Default for BenchSection {
    fn default() -> Self {
        Self { n: 5 }
    }
}

impl Default for ContextSection {
    fn default() -> Self {
        Self {
            token_budget: 4000,
            enable_retriever: true,
            enable_packer: true,
            enable_verifier: true,
            goal: String::new(),
            decisions: vec![],
            constraints: vec![],
            working_files: vec![],
            open_tasks: vec![],
            max_code_hits: 20,
            max_sessions: 10,
            include_git_diff: true,
        }
    }
}

impl Default for RdshSettings {
    fn default() -> Self {
        Self {
            schema: SCHEMA_VERSION,
            general: GeneralSection::default(),
            tokens: TokensSection::default(),
            search: SearchSection::default(),
            compact: CompactSection::default(),
            sessions: SessionsSection::default(),
            logs: LogsSection::default(),
            serve: ServeSection::default(),
            guard: GuardSection::default(),
            bench: BenchSection::default(),
            setup: SetupSection::default(),
            beta: BetaSection::default(),
            context: ContextSection::default(),
            extras: ExtrasSection::default(),
        }
    }
}

// ---- public API (Lead の main 配線用: シグネチャ厳守) ----

/// `$DSH_HOME/rdsh.json` のパス。
pub fn settings_path() -> String {
    format!("{}/rdsh.json", crate::inspect::dsh_home())
}

/// 設定を読み込む。ファイル欠落は既定値、不正値は clamp/切詰めで吸収する。
/// context 節が空なら旧 rdsh-context.json で補完する（読み取り専用）。
///
/// 存在するのに壊れた JSON は fail-open しない: エラーを出して exit(1) で
/// 終了する（guard.deny 空での起動を防ぐため）。表示形式は main の cmd
/// エラー処理 (`[rdsh] error: ...` + exit(1)) に合わせている。
/// テストや Result が欲しい呼び出し側は [`try_load`] を使う。
pub fn load() -> RdshSettings {
    match try_load() {
        Ok(cfg) => cfg,
        Err(e) => {
            eprintln!("[rdsh] error: {e:#}");
            std::process::exit(1);
        }
    }
}

/// `load` の実体。ファイル欠落は既定値 (Ok) を返し、有効な設定の
/// 読み込み結果は従来と同一。存在するのに壊れた JSON はファイルパス・
/// 行/列・復旧手順つきの Err を返す（guard 系設定の fail-open 禁止）。
pub fn try_load() -> anyhow::Result<RdshSettings> {
    let path = settings_path();
    let (raw, existed) = match std::fs::read_to_string(&path) {
        Ok(raw) => (raw, true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => (String::new(), false),
        Err(e) => {
            return Err(anyhow::anyhow!("cannot read settings file at {path}: {e}"));
        }
    };
    let parsed: serde_json::Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        // 欠落ファイルは従来どおり Null 扱い（既定値 + legacy 補完）。
        Err(_) if !existed => serde_json::Value::Null,
        Err(e) => {
            return Err(anyhow::anyhow!(
                "invalid settings file at {path}: {e} (line {}, column {}); run `rdsh settings init --force` (rdsh settings reset) to restore defaults",
                e.line(),
                e.column()
            ));
        }
    };
    let has_context = parsed.get("context").is_some_and(|c| !c.is_null());
    let mut cfg = if parsed.is_null() {
        RdshSettings::default()
    } else {
        RdshSettings::from_value(&parsed)
    };
    complement_from_legacy(&mut cfg, has_context);
    Ok(cfg)
}

impl RdshSettings {
    /// `mkdir -p` した上で mode 600 相当で保存する。
    pub fn save(&self) -> anyhow::Result<()> {
        let path = settings_path();
        if let Some(parent) = std::path::Path::new(&path).parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent)?;
            }
        }
        let mut clean = self.clone();
        clean.sanitize();
        let text = serde_json::to_string_pretty(&clean.to_value())?;
        #[cfg(unix)]
        {
            use std::io::Write;
            use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
            let mut opts = std::fs::OpenOptions::new();
            opts.write(true).create(true).truncate(true).mode(0o600);
            let mut f = opts.open(&path)?;
            f.write_all(text.as_bytes())?;
            f.write_all(b"\n")?;
            drop(f);
            let mut perm = std::fs::metadata(&path)?.permissions();
            perm.set_mode(0o600);
            std::fs::set_permissions(&path, perm)?;
        }
        #[cfg(not(unix))]
        {
            std::fs::write(&path, format!("{text}\n"))?;
        }
        Ok(())
    }

    fn from_value(v: &serde_json::Value) -> Self {
        let sec = |key: &str| -> serde_json::Value {
            v.get(key).cloned().unwrap_or(serde_json::Value::Null)
        };
        let g = sec("general");
        let t = sec("tokens");
        let s = sec("search");
        let c = sec("compact");
        let ss = sec("sessions");
        let l = sec("logs");
        let sv = sec("serve");
        let gd = sec("guard");
        let b = sec("bench");
        let su = sec("setup");
        let be = sec("beta");
        let cx = sec("context");
        let mut out = Self {
            schema: SCHEMA_VERSION,
            general: GeneralSection {
                slim: flag(&g, "slim", true),
                passthrough: flag(&g, "passthrough", false),
                dry_run: flag(&g, "dry_run", false),
                default_profile: text(&g, "default_profile", PROFILE_CHARS),
            },
            tokens: TokensSection {
                default_budget: clamp_u64(num(&t, "default_budget"), 4000, 500, 200000) as usize,
            },
            search: SearchSection {
                dir: {
                    let d = text(&s, "dir", PATH_CHARS);
                    if d.trim().is_empty() {
                        ".".to_string()
                    } else {
                        d
                    }
                },
                max: clamp_u64(num(&s, "max"), 100, 1, 100) as usize,
                web_limit: clamp_u64(num(&s, "web_limit"), 10, 1, 100) as usize,
                searxng_url: text(&s, "searxng_url", URL_CHARS),
            },
            compact: CompactSection {
                max_tokens: clamp_u64(num(&c, "max_tokens"), 8000, 500, 200000) as usize,
            },
            sessions: SessionsSection {
                limit: clamp_u64(num(&ss, "limit"), 20, 1, 100) as usize,
                with_tokens: flag(&ss, "with_tokens", false),
                stale_secs: clamp_u64(num(&ss, "stale_secs"), 60, 0, 3600),
            },
            logs: LogsSection {
                tail: clamp_u64(num(&l, "tail"), 50, 1, 500) as usize,
            },
            serve: ServeSection {
                port: clamp_u64(num(&sv, "port"), 38080, 1, 65535) as u16,
            },
            guard: GuardSection {
                deny: list(&gd, "deny", TEXT_CHARS),
                reason: text(&gd, "reason", TEXT_CHARS),
            },
            bench: BenchSection {
                n: clamp_u64(num(&b, "n"), 5, 1, 20) as u32,
            },
            setup: SetupSection {
                web_port: match num(&su, "web_port") {
                    None => 0,
                    Some(0) => 0,
                    Some(n) => n.clamp(1, 65535) as u16,
                },
            },
            beta: BetaSection {
                context_engine: flag(&be, "context_engine", false),
            },
            context: ContextSection {
                token_budget: clamp_u64(num(&cx, "token_budget"), 4000, 500, 200000) as usize,
                enable_retriever: flag(&cx, "enable_retriever", true),
                enable_packer: flag(&cx, "enable_packer", true),
                enable_verifier: flag(&cx, "enable_verifier", true),
                goal: text(&cx, "goal", GOAL_CHARS),
                decisions: list(&cx, "decisions", TEXT_CHARS),
                constraints: list(&cx, "constraints", TEXT_CHARS),
                working_files: {
                    let w = list(&cx, "working_files", PATH_CHARS);
                    if w.is_empty() {
                        list(&cx, "files", PATH_CHARS)
                    } else {
                        w
                    }
                },
                open_tasks: list(&cx, "open_tasks", TEXT_CHARS),
                max_code_hits: clamp_u64(num(&cx, "max_code_hits"), 20, 1, 100) as usize,
                max_sessions: clamp_u64(num(&cx, "max_sessions"), 10, 0, 100) as usize,
                include_git_diff: flag(&cx, "include_git_diff", true),
            },
            extras: ExtrasSection {
                enable: list(&sec("extras"), "enable", TEXT_CHARS)
                    .into_iter()
                    .filter(|e| KNOWN_EXTRAS.contains(&e.as_str()))
                    .collect(),
            },
        };
        out.sanitize();
        out
    }

    /// 不正値の吸収（to_value 経由の正規化）。
    fn sanitize(&mut self) {
        let v = self.to_value();
        *self = Self::from_value_raw(&v);
    }

    /// sanitize の再帰を避ける素朴な正規化。
    fn from_value_raw(v: &serde_json::Value) -> Self {
        let mut out = Self {
            schema: SCHEMA_VERSION,
            ..Self::default()
        };
        let g = v.get("general").cloned().unwrap_or(serde_json::Value::Null);
        out.general.slim = flag(&g, "slim", true);
        out.general.passthrough = flag(&g, "passthrough", false);
        out.general.dry_run = flag(&g, "dry_run", false);
        out.general.default_profile = text(&g, "default_profile", PROFILE_CHARS);
        let t = v.get("tokens").cloned().unwrap_or(serde_json::Value::Null);
        out.tokens.default_budget =
            clamp_u64(num(&t, "default_budget"), 4000, 500, 200000) as usize;
        let s = v.get("search").cloned().unwrap_or(serde_json::Value::Null);
        out.search.dir = {
            let d = text(&s, "dir", PATH_CHARS);
            if d.trim().is_empty() {
                ".".to_string()
            } else {
                d
            }
        };
        out.search.max = clamp_u64(num(&s, "max"), 100, 1, 100) as usize;
        out.search.web_limit = clamp_u64(num(&s, "web_limit"), 10, 1, 100) as usize;
        out.search.searxng_url = text(&s, "searxng_url", URL_CHARS);
        let c = v.get("compact").cloned().unwrap_or(serde_json::Value::Null);
        out.compact.max_tokens = clamp_u64(num(&c, "max_tokens"), 8000, 500, 200000) as usize;
        let ss = v
            .get("sessions")
            .cloned()
            .unwrap_or(serde_json::Value::Null);
        out.sessions.limit = clamp_u64(num(&ss, "limit"), 20, 1, 100) as usize;
        out.sessions.with_tokens = flag(&ss, "with_tokens", false);
        out.sessions.stale_secs = clamp_u64(num(&ss, "stale_secs"), 60, 0, 3600);
        let l = v.get("logs").cloned().unwrap_or(serde_json::Value::Null);
        out.logs.tail = clamp_u64(num(&l, "tail"), 50, 1, 500) as usize;
        let sv = v.get("serve").cloned().unwrap_or(serde_json::Value::Null);
        out.serve.port = clamp_u64(num(&sv, "port"), 38080, 1, 65535) as u16;
        let gd = v.get("guard").cloned().unwrap_or(serde_json::Value::Null);
        out.guard.deny = list(&gd, "deny", TEXT_CHARS);
        out.guard.reason = text(&gd, "reason", TEXT_CHARS);
        let bn = v.get("bench").cloned().unwrap_or(serde_json::Value::Null);
        out.bench.n = clamp_u64(num(&bn, "n"), 5, 1, 20) as u32;
        let su = v.get("setup").cloned().unwrap_or(serde_json::Value::Null);
        out.setup.web_port = match num(&su, "web_port") {
            None => 0,
            Some(0) => 0,
            Some(n) => n.clamp(1, 65535) as u16,
        };
        let be = v.get("beta").cloned().unwrap_or(serde_json::Value::Null);
        out.beta.context_engine = flag(&be, "context_engine", false);
        let ex = v.get("extras").cloned().unwrap_or(serde_json::Value::Null);
        out.extras.enable = list(&ex, "enable", TEXT_CHARS)
            .into_iter()
            .filter(|e| KNOWN_EXTRAS.contains(&e.as_str()))
            .collect();
        let cx = v.get("context").cloned().unwrap_or(serde_json::Value::Null);
        out.context.token_budget = clamp_u64(num(&cx, "token_budget"), 4000, 500, 200000) as usize;
        out.context.enable_retriever = flag(&cx, "enable_retriever", true);
        out.context.enable_packer = flag(&cx, "enable_packer", true);
        out.context.enable_verifier = flag(&cx, "enable_verifier", true);
        out.context.goal = text(&cx, "goal", GOAL_CHARS);
        out.context.decisions = list(&cx, "decisions", TEXT_CHARS);
        out.context.constraints = list(&cx, "constraints", TEXT_CHARS);
        out.context.working_files = {
            let w = list(&cx, "working_files", PATH_CHARS);
            if w.is_empty() {
                list(&cx, "files", PATH_CHARS)
            } else {
                w
            }
        };
        out.context.open_tasks = list(&cx, "open_tasks", TEXT_CHARS);
        out.context.max_code_hits = clamp_u64(num(&cx, "max_code_hits"), 20, 1, 100) as usize;
        out.context.max_sessions = clamp_u64(num(&cx, "max_sessions"), 10, 0, 100) as usize;
        out.context.include_git_diff = flag(&cx, "include_git_diff", true);
        out
    }

    pub fn to_value(&self) -> serde_json::Value {
        serde_json::json!({
            "schema": self.schema,
            "general": {
                "slim": self.general.slim,
                "passthrough": self.general.passthrough,
                "dry_run": self.general.dry_run,
                "default_profile": self.general.default_profile,
            },
            "tokens": { "default_budget": self.tokens.default_budget },
            "search": {
                "dir": self.search.dir,
                "max": self.search.max,
                "web_limit": self.search.web_limit,
                "searxng_url": self.search.searxng_url,
            },
            "compact": { "max_tokens": self.compact.max_tokens },
            "sessions": { "limit": self.sessions.limit, "with_tokens": self.sessions.with_tokens, "stale_secs": self.sessions.stale_secs },
            "logs": { "tail": self.logs.tail },
            "serve": { "port": self.serve.port },
            "guard": { "deny": self.guard.deny, "reason": self.guard.reason },
            "bench": { "n": self.bench.n },
            "setup": { "web_port": self.setup.web_port },
            "beta": { "context_engine": self.beta.context_engine },
            "extras": { "enable": self.extras.enable },
            "context": {
                "token_budget": self.context.token_budget,
                "enable_retriever": self.context.enable_retriever,
                "enable_packer": self.context.enable_packer,
                "enable_verifier": self.context.enable_verifier,
                "goal": self.context.goal,
                "decisions": self.context.decisions,
                "constraints": self.context.constraints,
                "working_files": self.context.working_files,
                "open_tasks": self.context.open_tasks,
                "max_code_hits": self.context.max_code_hits,
                "max_sessions": self.context.max_sessions,
                "include_git_diff": self.context.include_git_diff,
            },
        })
    }

    /// dotted key (`section.field`) の現在値を JSON で返す。section単体も可。
    pub fn get_dotted(&self, key: &str) -> Option<serde_json::Value> {
        let v = self.to_value();
        let key = key.trim().trim_matches('.');
        if key.is_empty() || key == "all" {
            return Some(v);
        }
        let mut cur = &v;
        for part in key.split('.') {
            cur = cur.get(part)?;
        }
        Some(cur.clone())
    }

    /// dotted keyへ値を設定する。不正キーはErr。保存は呼び出し側が行う。
    pub fn set_dotted(&mut self, key: &str, raw: &str) -> anyhow::Result<()> {
        let key = key.trim().trim_matches('.').to_string();
        let bad = || anyhow::anyhow!("unknown settings key: {key} (try: rdsh settings keys)");
        match key.as_str() {
            "general.slim" => self.general.slim = parse_bool(raw)?,
            "general.passthrough" => self.general.passthrough = parse_bool(raw)?,
            "general.dry_run" => self.general.dry_run = parse_bool(raw)?,
            "general.default_profile" => {
                self.general.default_profile = parse_string(raw, PROFILE_CHARS)
            }
            "tokens.default_budget" => {
                self.tokens.default_budget = parse_usize(raw, 4000)? as usize
            }
            "search.dir" => {
                let d = parse_string(raw, PATH_CHARS);
                self.search.dir = if d.trim().is_empty() {
                    ".".to_string()
                } else {
                    d
                };
            }
            "search.max" => self.search.max = parse_usize(raw, 100)? as usize,
            "search.web_limit" => self.search.web_limit = parse_usize(raw, 10)? as usize,
            "search.searxng_url" => self.search.searxng_url = parse_string(raw, URL_CHARS),
            "compact.max_tokens" => self.compact.max_tokens = parse_usize(raw, 8000)? as usize,
            "sessions.limit" => self.sessions.limit = parse_usize(raw, 20)? as usize,
            "sessions.with_tokens" => self.sessions.with_tokens = parse_bool(raw)?,
            "sessions.stale_secs" => self.sessions.stale_secs = parse_usize(raw, 60)? as u64,
            "logs.tail" => self.logs.tail = parse_usize(raw, 50)? as usize,
            "serve.port" => self.serve.port = parse_usize(raw, 38080)? as u16,
            "guard.deny" => self.guard.deny = parse_list(raw, TEXT_CHARS),
            "guard.reason" => self.guard.reason = parse_string(raw, TEXT_CHARS),
            "bench.n" => self.bench.n = parse_usize(raw, 5)? as u32,
            "setup.web_port" => self.setup.web_port = parse_usize(raw, 0)? as u16,
            "beta.context_engine" => self.beta.context_engine = parse_bool(raw)?,
            "extras.enable" => self.extras.enable = parse_list(raw, TEXT_CHARS),
            "context.token_budget" => self.context.token_budget = parse_usize(raw, 4000)? as usize,
            "context.enable_retriever" => self.context.enable_retriever = parse_bool(raw)?,
            "context.enable_packer" => self.context.enable_packer = parse_bool(raw)?,
            "context.enable_verifier" => self.context.enable_verifier = parse_bool(raw)?,
            "context.goal" => self.context.goal = parse_string(raw, GOAL_CHARS),
            "context.decisions" => self.context.decisions = parse_list(raw, TEXT_CHARS),
            "context.constraints" => self.context.constraints = parse_list(raw, TEXT_CHARS),
            "context.working_files" | "context.files" => {
                self.context.working_files = parse_list(raw, PATH_CHARS)
            }
            "context.open_tasks" => self.context.open_tasks = parse_list(raw, TEXT_CHARS),
            "context.max_code_hits" => self.context.max_code_hits = parse_usize(raw, 20)? as usize,
            "context.max_sessions" => self.context.max_sessions = parse_usize(raw, 10)? as usize,
            "context.include_git_diff" => self.context.include_git_diff = parse_bool(raw)?,
            _ => return Err(bad()),
        }
        self.sanitize();
        Ok(())
    }

    /// dotted keyを既定値に戻す。section単体で節全体を初期化する。
    pub fn reset_dotted(&mut self, key: &str) -> anyhow::Result<()> {
        let key = key.trim().trim_matches('.').to_string();
        // 先に未知キー判定（d を動かす前に）
        let known_section = matches!(
            key.as_str(),
            "general"
                | "tokens"
                | "search"
                | "compact"
                | "sessions"
                | "logs"
                | "serve"
                | "guard"
                | "bench"
                | "setup"
                | "beta"
                | "extras"
                | "context"
                | "all"
                | ""
        );
        if !known_section && RdshSettings::default().get_dotted(&key).is_none() {
            return Err(anyhow::anyhow!(
                "unknown settings key: {key} (try: rdsh settings keys)"
            ));
        }
        let d = RdshSettings::default();
        match key.as_str() {
            "general" => self.general = d.general,
            "tokens" => self.tokens = d.tokens,
            "search" => self.search = d.search,
            "compact" => self.compact = d.compact,
            "sessions" => self.sessions = d.sessions,
            "logs" => self.logs = d.logs,
            "serve" => self.serve = d.serve,
            "guard" => self.guard = d.guard,
            "bench" => self.bench = d.bench,
            "setup" => self.setup = d.setup,
            "beta" => self.beta = d.beta,
            "extras" => self.extras = d.extras,
            "context" => self.context = d.context,
            "all" | "" => *self = d,
            _ => {
                // 単項目は既定節から写す
                let tmp = d.clone();
                self.set_dotted_fallback(&key, &tmp)?;
            }
        }
        self.sanitize();
        Ok(())
    }

    fn set_dotted_fallback(&mut self, key: &str, src: &RdshSettings) -> anyhow::Result<()> {
        let v = src
            .get_dotted(key)
            .ok_or_else(|| anyhow::anyhow!("unknown settings key: {key}"))?;
        let raw = if v.is_string() {
            v.as_str().unwrap_or_default().to_string()
        } else {
            serde_json::to_string(&v).unwrap_or_default()
        };
        // 空文字の扱い: 文字列節はそのまま空に戻す
        self.set_dotted(key, &raw)
    }

    /// 設定キー一覧（help用）。
    pub fn keys() -> &'static [&'static str] {
        &[
            "general.slim(bool)",
            "general.passthrough(bool)",
            "general.dry_run(bool)",
            "general.default_profile(string)",
            "tokens.default_budget(500-200000)",
            "search.dir(string)",
            "search.max(1-100)",
            "search.web_limit(1-100)",
            "search.searxng_url(string)",
            "compact.max_tokens(500-200000)",
            "sessions.limit(1-100)",
            "sessions.with_tokens(bool)",
            "sessions.stale_secs(0-3600, 0=off)",
            "logs.tail(1-500)",
            "serve.port(1-65535)",
            "guard.deny(list)",
            "guard.reason(string)",
            "bench.n(1-20)",
            "setup.web_port(0-65535, 0=random)",
            "beta.context_engine(bool, default OFF)",
            "extras.enable(list: serve,search-web; default OFF)",
            "context.token_budget(500-200000)",
            "context.enable_retriever(bool)",
            "context.enable_packer(bool)",
            "context.enable_verifier(bool)",
            "context.goal(string)",
            "context.decisions(list)",
            "context.constraints(list)",
            "context.working_files(list)",
            "context.open_tasks(list)",
            "context.max_code_hits(1-100)",
            "context.max_sessions(0-100)",
            "context.include_git_diff(bool)",
        ]
    }
}

// ---- legacy (旧 rdsh-context.json: 読み取り専用) ----

fn legacy_context_path() -> String {
    format!("{}/rdsh-context.json", crate::inspect::dsh_home())
}

/// context 節が空（未設定または既定値のまま）なら旧ファイルで項目ごとに補完する。
/// 旧ファイルへの書き込みはしない。
fn complement_from_legacy(cfg: &mut RdshSettings, has_context: bool) {
    if has_context && cfg.context != ContextSection::default() {
        return;
    }
    let raw = std::fs::read_to_string(legacy_context_path()).unwrap_or_default();
    if raw.trim().is_empty() {
        return;
    }
    let v: serde_json::Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(_) => return,
    };
    if v.is_null() {
        return;
    }
    let c = &mut cfg.context;
    let budget = clamp_u64(num(&v, "token_budget"), 4000, 500, 200000) as usize;
    if c.token_budget == ContextSection::default().token_budget && budget != c.token_budget {
        c.token_budget = budget;
    }
    if c.enable_retriever && !flag(&v, "enable_retriever", true) {
        c.enable_retriever = false;
    }
    if c.enable_packer && !flag(&v, "enable_packer", true) {
        c.enable_packer = false;
    }
    if c.enable_verifier && !flag(&v, "enable_verifier", true) {
        c.enable_verifier = false;
    }
    if c.goal.is_empty() {
        c.goal = text(&v, "goal", GOAL_CHARS);
    }
    if c.decisions.is_empty() {
        c.decisions = list(&v, "decisions", TEXT_CHARS);
    }
    if c.constraints.is_empty() {
        c.constraints = list(&v, "constraints", TEXT_CHARS);
    }
    if c.working_files.is_empty() {
        let w = list(&v, "working_files", PATH_CHARS);
        c.working_files = if w.is_empty() {
            list(&v, "files", PATH_CHARS)
        } else {
            w
        };
    }
    if c.open_tasks.is_empty() {
        c.open_tasks = list(&v, "open_tasks", TEXT_CHARS);
    }
    if c.max_code_hits == ContextSection::default().max_code_hits {
        if let Some(n) = num(&v, "max_code_hits") {
            c.max_code_hits = n.clamp(1, 100) as usize;
        }
    }
    if c.max_sessions == ContextSection::default().max_sessions {
        if let Some(n) = num(&v, "max_sessions") {
            c.max_sessions = n.clamp(0, 100) as usize;
        }
    }
}

// ---- small JSON helpers ----

fn num(v: &serde_json::Value, key: &str) -> Option<u64> {
    v.get(key).and_then(|x| x.as_u64())
}

fn flag(v: &serde_json::Value, key: &str, default: bool) -> bool {
    v.get(key).and_then(|x| x.as_bool()).unwrap_or(default)
}

fn text(v: &serde_json::Value, key: &str, max_chars: usize) -> String {
    v.get(key)
        .and_then(|x| x.as_str())
        .map(|s| truncate(s, max_chars))
        .unwrap_or_default()
}

fn list(v: &serde_json::Value, key: &str, max_chars: usize) -> Vec<String> {
    match v.get(key).and_then(|x| x.as_array()) {
        Some(arr) => arr
            .iter()
            .filter_map(|x| x.as_str())
            .map(|s| truncate(s, max_chars))
            .filter(|s: &String| !s.trim().is_empty())
            .take(MAX_ITEMS)
            .collect(),
        None => vec![],
    }
}

fn truncate(s: &str, max_chars: usize) -> String {
    s.chars().take(max_chars).collect()
}

fn clamp_u64(n: Option<u64>, default: u64, lo: u64, hi: u64) -> u64 {
    n.unwrap_or(default).clamp(lo, hi)
}

fn parse_bool(raw: &str) -> anyhow::Result<bool> {
    let s = raw.trim().to_lowercase();
    match s.as_str() {
        "true" | "1" | "yes" | "on" | "enable" | "enabled" => Ok(true),
        "false" | "0" | "no" | "off" | "disable" | "disabled" => Ok(false),
        _ => {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(raw.trim()) {
                if let Some(b) = v.as_bool() {
                    return Ok(b);
                }
            }
            Err(anyhow::anyhow!("bool ではありません: {raw} (true/false)"))
        }
    }
}

fn parse_usize(raw: &str, _fallback: u64) -> anyhow::Result<u64> {
    let s = raw.trim();
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(s) {
        if let Some(n) = v.as_u64() {
            return Ok(n);
        }
        if let Some(n) = v.as_i64() {
            if n >= 0 {
                return Ok(n as u64);
            }
        }
    }
    s.parse::<u64>()
        .map_err(|_| anyhow::anyhow!("数値ではありません: {raw}"))
}

fn parse_string(raw: &str, max_chars: usize) -> String {
    let s = raw.trim();
    if (s.starts_with('"') && s.ends_with('"') && s.len() >= 2)
        || (s.starts_with('\'') && s.ends_with('\'') && s.len() >= 2)
    {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(s) {
            if let Some(st) = v.as_str() {
                return truncate(st, max_chars);
            }
        }
        return truncate(&s[1..s.len() - 1], max_chars);
    }
    truncate(s, max_chars)
}

fn parse_list(raw: &str, max_chars: usize) -> Vec<String> {
    let s = raw.trim();
    if s.is_empty() {
        return vec![];
    }
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(s) {
        if let Some(arr) = v.as_array() {
            return arr
                .iter()
                .filter_map(|x| x.as_str().map(|t| truncate(t, max_chars)))
                .filter(|t| !t.trim().is_empty())
                .take(MAX_ITEMS)
                .collect();
        }
        if let Some(st) = v.as_str() {
            return split_list(st, max_chars);
        }
    }
    split_list(s, max_chars)
}

fn split_list(s: &str, max_chars: usize) -> Vec<String> {
    // 改行・カンマ区切りを許容し、JSON配列でなくても1行1件で入る
    let mut out = vec![];
    for part in s.split(['\n', ',']).map(str::trim) {
        if part.is_empty() {
            continue;
        }
        // 余分な引用を剥がす
        let t = part.trim_matches('"').trim_matches('\'').trim();
        if t.is_empty() {
            continue;
        }
        out.push(truncate(t, max_chars));
        if out.len() >= MAX_ITEMS {
            break;
        }
    }
    out
}

#[cfg(test)]
mod rdsh_config_tests {
    use super::*;

    fn lock() -> std::sync::MutexGuard<'static, ()> {
        static M: std::sync::OnceLock<std::sync::Mutex<()>> = std::sync::OnceLock::new();
        M.get_or_init(|| std::sync::Mutex::new(()))
            .lock()
            .unwrap_or_else(|e| e.into_inner())
    }

    /// DSH_HOME を一時 dir に向けて f を実行する（復元・後片付けつき）。
    fn with_home(tag: &str, f: impl FnOnce(&str)) {
        let _guard = lock();
        let dir = std::env::temp_dir().join(format!("rdsh-settings-{}-{tag}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let prev = std::env::var("DSH_HOME").ok();
        std::env::set_var("DSH_HOME", &dir);
        f(&dir.to_string_lossy());
        match prev {
            Some(p) => std::env::set_var("DSH_HOME", p),
            None => std::env::remove_var("DSH_HOME"),
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn defaults_match_spec() {
        let d = RdshSettings::default();
        assert_eq!(d.schema, 1);
        assert!(d.general.slim && !d.general.passthrough && !d.general.dry_run);
        assert_eq!(d.general.default_profile, "");
        assert_eq!(d.tokens.default_budget, 4000);
        assert_eq!(d.search.dir, ".");
        assert_eq!((d.search.max, d.search.web_limit), (100, 10));
        assert_eq!(d.search.searxng_url, "");
        assert_eq!(d.compact.max_tokens, 8000);
        assert_eq!((d.sessions.limit, d.sessions.with_tokens), (20, false));
        assert_eq!(d.logs.tail, 50);
        assert_eq!(d.serve.port, 38080);
        assert!(d.guard.deny.is_empty() && d.guard.reason.is_empty());
        assert_eq!(d.bench.n, 5);
        assert_eq!(d.setup.web_port, 0);
        assert!(!d.beta.context_engine);
        assert_eq!(d.context.token_budget, 4000);
        assert!(d.context.enable_retriever && d.context.enable_packer && d.context.enable_verifier);
        assert!(d.context.goal.is_empty());
        assert!(d.context.decisions.is_empty() && d.context.constraints.is_empty());
        assert!(d.context.working_files.is_empty() && d.context.open_tasks.is_empty());
        assert_eq!((d.context.max_code_hits, d.context.max_sessions), (20, 10));
        assert!(d.context.include_git_diff);
    }

    #[test]
    fn missing_file_returns_default() {
        with_home("missing", |_| {
            assert!(!std::path::Path::new(&settings_path()).exists());
            assert_eq!(load(), RdshSettings::default());
            assert_eq!(try_load().unwrap(), RdshSettings::default());
        });
    }

    #[test]
    fn corrupt_json_is_hard_error_with_location() {
        with_home("corrupt", |_| {
            let p = settings_path();
            std::fs::create_dir_all(std::path::Path::new(&p).parent().unwrap()).unwrap();
            std::fs::write(&p, "{\n  \"search\": {\n    oops\n").unwrap();
            let err = try_load().unwrap_err().to_string();
            assert!(err.contains(&p), "path missing: {err}");
            assert!(err.contains("line"), "line missing: {err}");
            assert!(err.contains("column"), "column missing: {err}");
            assert!(
                err.contains("settings reset"),
                "recovery hint missing: {err}"
            );
            // 壊れファイルは既定値に置き換えない（fail-open 禁止）。
            assert_eq!(
                std::fs::read_to_string(&p).unwrap(),
                "{\n  \"search\": {\n    oops\n"
            );
        });
    }

    #[test]
    fn empty_file_is_hard_error() {
        with_home("empty", |_| {
            let p = settings_path();
            std::fs::create_dir_all(std::path::Path::new(&p).parent().unwrap()).unwrap();
            std::fs::write(&p, "").unwrap();
            let err = try_load().unwrap_err().to_string();
            assert!(err.contains(&p), "path missing: {err}");
            assert!(
                err.contains("settings reset"),
                "recovery hint missing: {err}"
            );
        });
    }

    #[test]
    fn guard_deny_list_survives_reload() {
        with_home("guard", |_| {
            let mut cfg = RdshSettings::default();
            cfg.guard.deny = vec!["rm -rf *".to_string(), "shutdown*".to_string()];
            cfg.guard.reason = "safety".to_string();
            cfg.save().unwrap();
            let back = try_load().unwrap();
            assert_eq!(back.guard.deny, cfg.guard.deny);
            assert_eq!(back.guard.reason, "safety");
            assert_eq!(load(), cfg);
        });
    }

    #[test]
    fn out_of_range_values_are_clamped() {
        with_home("clamp", |_| {
            let p = settings_path();
            std::fs::create_dir_all(std::path::Path::new(&p).parent().unwrap()).unwrap();
            std::fs::write(
                &p,
                serde_json::json!({
                    "tokens": { "default_budget": 9999999 },
                    "compact": { "max_tokens": 1 },
                    "context": { "token_budget": 10 },
                    "search": { "max": 500, "web_limit": 0 },
                    "sessions": { "limit": 0 },
                    "logs": { "tail": 9999 },
                    "bench": { "n": 99 },
                    "serve": { "port": 0 },
                    "setup": { "web_port": 70000 },
                })
                .to_string(),
            )
            .unwrap();
            let c = load();
            assert_eq!(c.tokens.default_budget, 200000);
            assert_eq!(c.compact.max_tokens, 500);
            assert_eq!(c.context.token_budget, 500);
            assert_eq!(c.search.max, 100);
            assert_eq!(c.search.web_limit, 1);
            assert_eq!(c.sessions.limit, 1);
            assert_eq!(c.logs.tail, 500);
            assert_eq!(c.bench.n, 20);
            assert_eq!(c.serve.port, 1);
            assert_eq!(c.setup.web_port, 65535);
        });
    }

    #[test]
    fn setup_web_port_zero_means_random() {
        with_home("webport", |_| {
            let p = settings_path();
            std::fs::create_dir_all(std::path::Path::new(&p).parent().unwrap()).unwrap();
            std::fs::write(
                &p,
                serde_json::json!({ "setup": { "web_port": 0 } }).to_string(),
            )
            .unwrap();
            assert_eq!(load().setup.web_port, 0);
        });
    }

    #[test]
    fn long_strings_and_lists_are_truncated() {
        with_home("trunc", |_| {
            let p = settings_path();
            std::fs::create_dir_all(std::path::Path::new(&p).parent().unwrap()).unwrap();
            let big_goal: String = "あ".repeat(2500);
            let big_path: String = "x".repeat(400);
            let many: Vec<String> = (0..60).map(|i| format!("dec-{i}")).collect();
            std::fs::write(
                &p,
                serde_json::json!({
                    "context": {
                        "goal": big_goal,
                        "decisions": many,
                        "working_files": [big_path],
                    },
                })
                .to_string(),
            )
            .unwrap();
            let c = load();
            assert_eq!(c.context.goal.chars().count(), 2000);
            assert_eq!(c.context.decisions.len(), 50);
            assert_eq!(c.context.working_files[0].chars().count(), 300);
        });
    }

    #[test]
    fn save_roundtrip_and_mode_600() {
        with_home("roundtrip", |dir| {
            let mut cfg = RdshSettings::default();
            cfg.general.default_profile = "tui".to_string();
            cfg.context.goal = "dsh互換性を維持する".to_string();
            cfg.context.working_files = vec!["src/search.rs".to_string()];
            cfg.save().unwrap();
            let p = settings_path();
            assert!(std::path::Path::new(&p).exists());
            assert!(p.starts_with(dir));
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let mode = std::fs::metadata(&p).unwrap().permissions().mode() & 0o777;
                assert_eq!(mode, 0o600, "save は mode 600 相当のはず");
            }
            assert_eq!(load(), cfg);
        });
    }

    #[test]
    fn legacy_file_completes_empty_context_without_writing() {
        with_home("legacy", |_| {
            let legacy = legacy_context_path();
            std::fs::create_dir_all(std::path::Path::new(&legacy).parent().unwrap()).unwrap();
            std::fs::write(
                &legacy,
                serde_json::json!({
                    "token_budget": 6000,
                    "enable_verifier": false,
                    "goal": "旧ファイルのgoal",
                    "files": ["src/tokens.rs"],
                    "open_tasks": ["packing評価"],
                })
                .to_string(),
            )
            .unwrap();
            // rdsh.json は作らない: 補完は読み取り専用。
            let c = load();
            assert_eq!(c.context.token_budget, 6000);
            assert!(!c.context.enable_verifier);
            assert!(c.context.enable_retriever && c.context.enable_packer);
            assert_eq!(c.context.goal, "旧ファイルのgoal");
            assert_eq!(c.context.working_files, vec!["src/tokens.rs".to_string()]);
            assert_eq!(c.context.open_tasks, vec!["packing評価".to_string()]);
            assert!(!std::path::Path::new(&settings_path()).exists());
        });
    }

    #[test]
    fn dotted_get_set_unset_cover_all_sections() {
        let mut c = RdshSettings::default();
        // get
        assert_eq!(c.get_dotted("search.max").unwrap(), serde_json::json!(100));
        assert!(c.get_dotted("beta.context_engine").unwrap().as_bool() == Some(false));
        // set: 数値・真偽・文字・配列
        c.set_dotted("search.max", "42").unwrap();
        assert_eq!(c.search.max, 42);
        c.set_dotted("beta.context_engine", "true").unwrap();
        assert!(c.beta.context_engine);
        c.set_dotted("context.goal", "v2-goal").unwrap();
        assert_eq!(c.context.goal, "v2-goal");
        c.set_dotted("guard.deny", r#"["a*","b"]"#).unwrap();
        assert_eq!(c.guard.deny, vec!["a*".to_string(), "b".to_string()]);
        c.set_dotted("context.working_files", "src/a.rs, src/b.rs")
            .unwrap();
        assert_eq!(c.context.working_files.len(), 2);
        c.set_dotted("serve.port", "38080").unwrap();
        assert_eq!(c.serve.port, 38080);
        assert!(c.set_dotted("unknown.key", "1").is_err());
        // unset: 単項目と節全体
        c.set_dotted("search.max", "7").unwrap();
        c.reset_dotted("search.max").unwrap();
        assert_eq!(c.search.max, 100);
        c.set_dotted("context.goal", "tmp").unwrap();
        c.reset_dotted("context").unwrap();
        assert!(c.context.goal.is_empty());
        c.set_dotted("search.max", "7").unwrap();
        c.reset_dotted("all").unwrap();
        assert_eq!(c, RdshSettings::default());
        assert!(c.reset_dotted("unknown.key").is_err());
    }
}
