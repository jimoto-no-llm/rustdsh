// Format only rdsh-owned presentation text; supplied values keep their bytes.
macro_rules! localized_format {
    ($locale:expr, $english:literal, $chinese:literal, $japanese:literal $(, $value:expr)* $(,)?) => {
        match $locale {
            crate::locale::Locale::English => format!($english $(, $value)*),
            crate::locale::Locale::Chinese => format!($chinese $(, $value)*),
            crate::locale::Locale::Japanese => format!($japanese $(, $value)*),
        }
    };
}

use clap::{CommandFactory, FromArgMatches, Parser, Subcommand, ValueEnum};

#[derive(Clone, Copy, Debug, ValueEnum)]
#[value(rename_all = "kebab-case")]
enum ToolChoiceDefaultArg {
    None,
    Auto,
    Required,
}

impl ToolChoiceDefaultArg {
    fn as_str(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Auto => "auto",
            Self::Required => "required",
        }
    }
}

fn parse_positive_usize(value: &str) -> Result<usize, String> {
    let parsed = value
        .parse::<usize>()
        .map_err(|_| "must be a positive integer".to_string())?;
    if parsed == 0 {
        return Err("must be greater than zero".to_string());
    }
    Ok(parsed)
}

fn parse_positive_finite(value: &str) -> Result<f64, String> {
    let parsed = value
        .parse::<f64>()
        .map_err(|_| "must be a positive finite number".to_string())?;
    if !parsed.is_finite() || parsed <= 0.0 {
        return Err("must be a positive finite number".to_string());
    }
    Ok(parsed)
}
mod auth;
mod auth_sharing;
mod budget_admission;
mod compact;
mod compute;
mod context;
mod cost_ledger;
mod desktop;
mod dsh_args;
mod file_lock;
mod file_security;
mod guard;
mod inspect;
mod local_http;
mod locale;
#[cfg(test)]
mod locale_test;
mod opencode_header;
mod passthrough;
mod providers;
mod rdsh_config;
mod search;
mod serial_proxy;
mod serve;
mod setup_web;
mod shutdown;
mod slim;
mod subagent_plan;
mod task_outcomes;
mod token_handoff;
mod tokens;
mod tool_security;
mod update_auto;
mod websearch;
mod worker_scopes;

#[derive(Parser, Debug)]
#[command(
    name = "rdsh",
    version,
    about = "Rust fast launcher for dsh (safe: native fast-paths + passthrough)",
    after_help = "USAGE:\n  rdsh [profile] [--profile <name>] [--patch <yml>...] [app-args...]\n  rdsh <native-subcommand> ...   (tokens|prune|search|search-web|compact|doctor|bench|serve|sessions|profiles|skills|logs|guard|compute|desktop|auth|setup|context|settings|features|subagents|provider|task-outcomes|budget-admission|cost-ledger|update|worker-scope|dump-config|boot|serial-proxy)\n\nEXAMPLES:\n  rdsh tui                        boot tui profile (slim env ON, delegates to dsh)\n  rdsh --profile web --patch x.yml boot web with overlay\n  rdsh dump-config --profile tui  delegate exact dump to dsh\n  rdsh tokens ./AGENTS.md         estimate input tokens natively\n  rdsh auth --import --provider openai-codex   import only the selected provider\n  rdsh setup                      first-run connect: import, login flow, next steps\n  rdsh provider add hai --model deepseek-v4-flash   register HAI as a dsh route\n  rdsh provider add sarashina    register Sarashina (SARASHINA_API_KEY; mini and nano built in)\n  rdsh provider add local-openai --base-url http://host:8080/v1 --discover --no-key\n  rdsh provider list              presets and per-profile route/key status\n  rdsh search hello --dir .       fast file search without Node\n  rdsh search-web \"rust async\"      web search via SearXNG (no API key)\n  rdsh desktop status             detect the Desktop (Electron) app and its reserved profile\n  rdsh desktop install            attach the bundled rdsh plugins to that profile\n  rdsh --passthrough tui          no slim env; mandatory tool isolation remains\n  rdsh --dry-run tui -- --resume abc   show what would exec"
)]
struct Cli {
    /// Explicitly share a project file with isolated model tools (repeatable).
    #[arg(long = "share-file", global = true)]
    share_file: Vec<String>,
    #[arg(long = "passthrough", global = true)]
    passthrough: bool,
    #[arg(long = "dry-run", global = true)]
    dry_run: bool,
    /// Force slim delegation (default follows settings general.slim).
    #[arg(long = "slim", default_value_t = false, global = true)]
    slim: bool,
    #[arg(long = "no-slim", global = true)]
    no_slim: bool,
    #[arg(long = "patch", global = true)]
    patch: Vec<String>,
    #[arg(long = "profile", global = true)]
    profile: Option<String>,
    /// Product language for rdsh-owned human-readable output (en, zh-CN, ja).
    #[arg(long = "language", global = true, value_parser = ["en", "zh-CN", "ja"])]
    language: Option<String>,
    #[command(subcommand)]
    command: Option<Commands>,
    #[arg(trailing_var_arg = true, allow_hyphen_values = true)]
    extra: Vec<String>,
}

#[derive(Subcommand, Debug)]
enum ProviderAction {
    /// Built-in presets and, per profile, whether each route and its key exist
    List {
        #[arg(long = "json")]
        json: bool,
    },
    /// Add a route to a profile's cordis.patch.yml (llm-pi-ai providers)
    Add {
        /// Preset: hai, sarashina or local-openai
        preset: String,
        #[arg(long = "profile")]
        profile: Option<String>,
        /// Model id to declare (repeatable)
        #[arg(long = "model")]
        model: Vec<String>,
        /// Take baseURL and models from opencode's provider.<id> entry
        #[arg(long = "from-opencode")]
        from_opencode: bool,
        /// Read the model ids from GET {baseURL}/models
        #[arg(long = "discover")]
        discover: bool,
        #[arg(long = "base-url")]
        base_url: Option<String>,
        /// Route id (local-openai only; default local-openai)
        #[arg(long = "id")]
        id: Option<String>,
        /// Display name (local-openai only)
        #[arg(long = "name")]
        name: Option<String>,
        /// Read the API key from one stdin line and store it as a ref
        #[arg(long = "key-stdin")]
        key_stdin: bool,
        /// Server needs no key: store a placeholder (local-openai only)
        #[arg(long = "no-key")]
        no_key: bool,
        /// Rewrite the route block when it already exists
        #[arg(long = "replace")]
        replace: bool,
        #[arg(long = "json")]
        json: bool,
    },
}

#[derive(Subcommand, Debug)]
enum Commands {
    Boot {
        #[arg(long = "profile")]
        profile: Option<String>,
        #[arg(
            long = "from-default-profile",
            value_parser = clap::builder::NonEmptyStringValueParser::new()
        )]
        from_default_profile: Option<String>,
        #[arg(trailing_var_arg = true, allow_hyphen_values = true)]
        args: Vec<String>,
    },
    #[command(name = "dump-config")]
    DumpConfig {
        #[arg(long = "profile")]
        profile: Option<String>,
        #[arg(long = "native")]
        native: bool,
    },
    Tokens {
        files: Vec<String>,
        #[arg(long = "preview", default_value_t = 0)]
        preview: usize,
    },
    Prune {
        /// Trim to budget (default: settings tokens.default_budget).
        #[arg(long = "max-tokens")]
        max_tokens: Option<usize>,
        file: Option<String>,
    },
    Search {
        pattern: String,
        /// Search root (default: settings search.dir).
        #[arg(long = "dir")]
        dir: Option<String>,
        /// Max hits (default: settings search.max).
        #[arg(long = "max")]
        max: Option<usize>,
    },
    /// Web search through SearXNG (default http://127.0.0.1:8888, $SEARXNG_URL wins)
    #[command(name = "search-web")]
    SearchWeb {
        query: String,
        /// Result limit (default: settings search.web_limit).
        #[arg(long = "limit")]
        limit: Option<usize>,
        #[arg(long = "json")]
        json: bool,
    },
    Compact {
        file: String,
        /// Token budget (default: settings compact.max_tokens).
        #[arg(long = "max-tokens")]
        max_tokens: Option<usize>,
    },
    Doctor,
    /// List sessions under $DSH_HOME (newest first, Node-free)
    Sessions {
        #[arg(long = "project")]
        project: Option<String>,
        /// Session count (default: settings sessions.limit).
        #[arg(long = "limit")]
        limit: Option<usize>,
        /// Estimate tokens via zstd decompression (falls back to stored-bytes/4)
        #[arg(long = "tokens")]
        tokens: bool,
        /// Machine-readable JSON for sidecar use
        #[arg(long = "json")]
        json: bool,
    },
    /// List local profiles (Node-free)
    Profiles,
    /// List installed skills (Node-free)
    Skills,
    /// Show $DSH_HOME logs: latest file tail + optional grep (Node-free)
    Logs {
        /// Tail lines (default: settings logs.tail).
        #[arg(long = "tail")]
        tail: Option<usize>,
        #[arg(long = "grep")]
        grep: Option<String>,
        #[arg(long = "file")]
        file: Option<String>,
    },
    /// Start the local dashboard (127.0.0.1 only, read-only API)
    Serve {
        /// Listen port (default: settings serve.port).
        #[arg(long = "port")]
        port: Option<u16>,
    },
    /// Local reverse proxy with upstream concurrency and rate limits
    #[command(name = "serial-proxy")]
    SerialProxy {
        /// Upstream HTTP(S) base URL
        #[arg(long)]
        upstream: String,
        #[arg(long, default_value_t = 18080)]
        port: u16,
        #[arg(long, default_value = "127.0.0.1")]
        host: String,
        #[arg(long = "allow-remote")]
        allow_remote: bool,
        #[arg(long, default_value_t = 1, value_parser = parse_positive_usize)]
        max: usize,
        #[arg(long = "queue-timeout", default_value = "600", value_parser = parse_positive_finite)]
        queue_timeout: f64,
        #[arg(long = "max-queue", default_value_t = 64, value_parser = parse_positive_usize)]
        max_queue: usize,
        #[arg(long = "tool-choice-default", value_enum)]
        tool_choice_default: Option<ToolChoiceDefaultArg>,
        #[arg(long = "max-body-bytes", default_value_t = 8 * 1024 * 1024, value_parser = parse_positive_usize)]
        max_body_bytes: usize,
        #[arg(long, value_parser = parse_positive_usize)]
        rpm: Option<usize>,
    },
    /// Inventory, select and import only explicitly shared credentials
    Auth(auth_sharing::AuthArgs),
    /// Register an OpenAI-compatible endpoint (HAI, a home LLM server) as a
    /// dsh route in a profile: `provider list`, `provider add hai|sarashina|local-openai`
    Provider {
        #[command(subcommand)]
        action: ProviderAction,
    },
    /// First-run connect: sync selected credentials, optionally run login
    /// or reveal settings dirs, else show the next step
    Setup {
        #[arg(long = "open")]
        open: bool,
        #[arg(long = "login")]
        login: bool,
        #[arg(long = "json")]
        json: bool,
        #[arg(long = "yes")]
        yes: bool,
        /// Floating glass setup UI on localhost (auto-opens a browser tab)
        #[arg(long = "web")]
        web: bool,
        /// Local port for --web (0 = random, default: settings setup.web_port).
        #[arg(long = "port")]
        port: Option<u16>,
    },
    Bench {
        /// Iterations (default: settings bench.n).
        #[arg(long = "n")]
        n: Option<u32>,
    },
    /// Context engine prototype (test): rebuild per-turn context from local files
    Context {
        #[command(subcommand)]
        action: ContextAction,
    },
    /// Resident pure-compute worker (stdio NDJSON, opt-in Web PoC).
    /// No filesystem/auth/session access; DSH keeps the original path.
    Compute {
        /// Handle one request line then exit (for IPC cost comparison).
        #[arg(long = "once")]
        once: bool,
    },
    /// Validate and normalize dashboard worker workspace declarations from stdin.
    #[command(name = "worker-scope")]
    WorkerScope {
        #[command(subcommand)]
        action: WorkerScopeAction,
    },
    /// Hook helper for hooks.json: block stdin text matching --deny (exit 2)
    Guard {
        #[arg(long = "deny")]
        deny: Vec<String>,
        /// Apply an opt-in structured hook policy; unknown tools are blocked.
        #[arg(long = "policy-file")]
        policy_file: Option<String>,
        #[arg(long = "reason")]
        reason: Option<String>,
        #[arg(long = "json")]
        json: bool,
    },
    /// Auto-update timer: status, on, or off (daily systemd user timer)
    #[command(name = "update")]
    Update {
        #[command(subcommand)]
        action: UpdateAction,
    },
    /// Unified rdsh settings (rdsh.json): show values, path, or write defaults
    Settings {
        #[command(subcommand)]
        action: SettingsAction,
    },
    /// Task outcome reports and fixed milestone contracts: merge one optional
    /// report into a project state, validate a stored document, or print the
    /// two JSON schemas the dashboard MCP tool advertises
    #[command(name = "task-outcomes")]
    TaskOutcomes {
        /// apply | validate | schema
        action: String,
        /// Request JSON file holding { operation, state, input }
        #[arg(long = "input-file")]
        input_file: String,
    },
    /// Admission budget book for one project: apply one policy/job/call/
    /// finish/usage operation, validate a stored book by replaying its
    /// operation log, or print the public projection the dashboard shows.
    /// Pure logic: no provider call and no file write
    #[command(name = "budget-admission")]
    BudgetAdmission {
        /// apply | validate | public
        action: String,
        /// Request JSON file holding { operation, state, input, now, live_jobs }
        #[arg(long = "input-file")]
        input_file: String,
    },
    /// Feature switches: list every optional capability, or turn one on/off
    Features {
        #[command(subcommand)]
        action: Option<FeaturesAction>,
        /// Machine-readable list
        #[arg(long = "json")]
        json: bool,
    },
    /// Deterministic subagent dispatch planning: read one request file and
    /// print the plan; starts no agent, calls no provider and writes nothing
    Subagents {
        #[command(subcommand)]
        action: SubagentsAction,
    },
    /// Reported cost observations: declare one scope, record one report,
    /// validate a stored ledger, project the public view, or print the two
    /// JSON schemas the dashboard MCP tool advertises
    #[command(name = "cost-ledger")]
    CostLedger {
        /// declare | report | validate | public | schema
        action: String,
        /// Request JSON file holding { operation, state, input }
        #[arg(long = "input-file")]
        input_file: String,
    },
    /// DeepSeek Harness Desktop (Electron): detect the app, its reserved
    /// profile and its bundled command runtime, then attach rdsh plugins
    #[command(name = "desktop")]
    Desktop {
        #[command(subcommand)]
        action: Option<DesktopAction>,
        /// Machine-readable output (same as the subcommand flag)
        #[arg(long = "json")]
        json: bool,
    },
}

#[derive(Subcommand, Debug)]
enum WorkerScopeAction {
    /// Read a JSON array of declarations and write JSON result records.
    Validate,
    /// Evaluate write paths, scope intersections, and shared-file policy in one batch.
    Policy,
}

#[derive(Subcommand, Debug)]
enum DesktopAction {
    /// Show the detected app, profile, command runtime, and plugin state
    Status {
        #[arg(long = "json")]
        json: bool,
    },
    /// Attach plugins to the desktop profile through the Desktop command
    Install {
        /// Print the commands without running them
        #[arg(long = "dry-run")]
        dry_run: bool,
        /// rustdsh checkout (or its plugins/) that carries the bundled plugins
        #[arg(long = "plugins-dir")]
        plugins_dir: Option<String>,
        /// Also install rdsh-compute (resident compute bridge)
        #[arg(long = "compute")]
        compute: bool,
        /// Extra package spec to add (name, git URL, or path; repeatable)
        #[arg(long = "package")]
        package: Vec<String>,
        /// Install only the --package specs, without the bundled plugins
        #[arg(long = "no-bundled")]
        no_bundled: bool,
        #[arg(long = "json")]
        json: bool,
    },
    /// Exit nonzero unless the desktop profile has the required plugin enabled
    Verify {
        /// Plugin that must be enabled (repeatable; default: rdsh-settings)
        #[arg(long = "require")]
        require: Vec<String>,
        #[arg(long = "json")]
        json: bool,
    },
}

#[derive(Subcommand, Debug)]
enum FeaturesAction {
    /// Enable one feature: rdsh features on discord
    On { id: String },
    /// Disable one feature: rdsh features off discord
    Off { id: String },
}

#[derive(Subcommand, Debug)]
enum SubagentsAction {
    /// Build a dispatch plan from a request JSON file (docs/SUBAGENT-PLANNING.md)
    Plan {
        /// Request JSON file
        #[arg(long = "input-file")]
        input_file: String,
        /// JSON output (the default; accepted for script compatibility)
        #[arg(long = "json")]
        json: bool,
    },
}

#[derive(Subcommand, Debug)]
enum UpdateAction {
    /// Daily auto-update timer for released rdsh/dsh versions
    Auto {
        #[command(subcommand)]
        action: AutoAction,
    },
}

#[derive(Subcommand, Debug)]
enum AutoAction {
    /// Show the unit directory, updater script and timer state
    Status {
        #[arg(long = "json")]
        json: bool,
    },
    /// Install and start the daily auto-update timer
    On {
        #[arg(long = "dry-run")]
        dry_run: bool,
        #[arg(long = "json")]
        json: bool,
    },
    /// Stop and remove the auto-update timer
    Off {
        #[arg(long = "dry-run")]
        dry_run: bool,
        #[arg(long = "json")]
        json: bool,
    },
}

#[derive(Subcommand, Debug)]
enum ContextAction {
    /// Assemble the context to pass to the LLM this turn (prototype)
    Build {
        #[arg(long = "query")]
        query: Option<String>,
        #[arg(long = "budget")]
        budget: Option<usize>,
        #[arg(long = "json")]
        json: bool,
    },
    /// Search code + sessions for query-related info only (prototype)
    Search {
        query: String,
        /// Max hits (default: settings context.max_code_hits).
        #[arg(long = "max")]
        max: Option<usize>,
    },
    /// Show current goal, memory, and token usage (prototype)
    Status {
        #[arg(long = "json")]
        json: bool,
    },
    /// Explain why each section was included (prototype)
    Explain {
        #[arg(long = "query")]
        query: Option<String>,
        #[arg(long = "budget")]
        budget: Option<usize>,
    },
}

#[derive(Subcommand, Debug)]
enum SettingsAction {
    /// Show current settings (rdsh.json with legacy fallback)
    Show {
        #[arg(long = "json")]
        json: bool,
    },
    /// Print the settings file path
    Path,
    /// Write defaults to the settings file (use --force to overwrite)
    Init {
        #[arg(long = "force")]
        force: bool,
    },
    /// Get one value: rdsh settings get search.max / context.goal / beta.context_engine
    Get {
        key: String,
        #[arg(long = "json")]
        json: bool,
    },
    /// Set one value: rdsh settings set search.max 50 / guard.deny '["a*"]' / context.goal "方針"
    Set { key: String, value: String },
    /// Reset to defaults: rdsh settings unset search.max (or a whole section like context)
    Unset { key: String },
    /// List editable keys
    Keys,
}

/// First-arg subcommands owned by rdsh. When installed as `dsh`, anything else
/// is delegated verbatim to the original binary (so `dsh --profile tui`,
/// `dsh --version`, `dsh --help` stay byte-identical).
/// NOTE: a profile literally named like these (bare `dsh tokens`) is shadowed;
/// boot it with `dsh --profile tokens` instead.
const NATIVE_FIRST: &[&str] = &[
    "boot",
    "dump-config",
    "tokens",
    "prune",
    "search",
    "compact",
    "doctor",
    "bench",
    "serve",
    "sessions",
    "profiles",
    "skills",
    "logs",
    "guard",
    "compute",
    "desktop",
    "auth",
    "provider",
    "setup",
    "search-web",
    "context",
    "settings",
    "features",
    "cost-ledger",
    "update",
    "serial-proxy",
    "subagents",
    "task-outcomes",
    "budget-admission",
    "worker-scope",
];

fn invoked_as_dsh() -> bool {
    let argv0 = std::env::args().next().unwrap_or_default();
    std::path::Path::new(&argv0)
        .file_name()
        .and_then(|s| s.to_str())
        // Native Windows installs run as dsh.exe.
        .is_some_and(|s| s == "dsh" || s == "dsh.exe")
}

fn main() {
    if invoked_as_dsh() {
        let raw: Vec<String> = std::env::args().skip(1).collect();
        let first_is_native = raw
            .first()
            .is_some_and(|s| NATIVE_FIRST.contains(&s.as_str()));
        if !first_is_native {
            std::env::set_var("RDSH_SHARED_FILES", "[]");
            let scfg = rdsh_config::load();
            let slim =
                !passthrough::env_passthrough() && !scfg.general.passthrough && scfg.general.slim;
            let dry = passthrough::env_dry() || scfg.general.dry_run;
            crate::slim::configure(&scfg);
            crate::tool_security::configure(agent_tool_sandbox(&scfg, false));
            if let Err(e) = passthrough::exec_raw(&raw, dry, slim) {
                eprintln!("[rdsh] error: {e:#}");
                std::process::exit(1);
            }
            return;
        }
        // else: fall through to the normal CLI (rdsh-native subcommand)
    }
    // Avoid reading settings only when Clap itself recognizes a version
    // display. Values after `--` and native positional arguments can use the
    // same bytes, so scanning raw argv would exit before their command runs.
    if let Err(error) = Cli::try_parse_from(std::env::args_os()) {
        if error.kind() == clap::error::ErrorKind::DisplayVersion {
            error.exit();
        }
    }
    // Build the same derive-generated tree for parsing and help.  `dsh`
    // passthrough above never reaches this tree.
    let parse_locale = match requested_locale() {
        Ok(locale) => locale,
        Err((locale, error)) => {
            eprintln!(
                "[rdsh] {}: {error:#}",
                locale::message(locale, locale::Message::SettingsRead)
            );
            std::process::exit(1);
        }
    };
    let cli = parse_cli(parse_locale);
    if let Some(Commands::WorkerScope { action }) = &cli.command {
        let result = match action {
            WorkerScopeAction::Validate => worker_scopes::cmd_validate(parse_locale),
            WorkerScopeAction::Policy => worker_scopes::cmd_policy(parse_locale),
        };
        if let Err(error) = result {
            eprintln!(
                "[rdsh] {}: {error:#}",
                locale::message(parse_locale, locale::Message::Error)
            );
            std::process::exit(2);
        }
        return;
    }

    // Fast path: empty share list is by far the common case; skip JSON serializer.
    // Same bytes out ("[]"), one allocation saved per invocation.
    if cli.share_file.is_empty() {
        std::env::set_var("RDSH_SHARED_FILES", "[]");
    } else {
        std::env::set_var(
            "RDSH_SHARED_FILES",
            serde_json::to_string(&cli.share_file).unwrap(),
        );
    }
    // Recovery, pure task-outcome and cost-ledger validators, and the pure
    // subagent planner do not depend on settings. Commands that use settings
    // still fail closed on a corrupt document.
    let cfg = if matches!(
        &cli.command,
        Some(Commands::Settings {
            action: SettingsAction::Init { force: true }
        }) | Some(Commands::TaskOutcomes { .. })
            | Some(Commands::BudgetAdmission { .. })
            | Some(Commands::Subagents { .. })
            | Some(Commands::CostLedger { .. })
    ) {
        rdsh_config::RdshSettings::default()
    } else {
        rdsh_config::load_with_locale(parse_locale)
    };
    let locale = locale::current(cli.language.as_deref(), &cfg.general.language);
    // Feature switches (rdsh features) steer the delegated-run env and the
    // native session caches; an explicit environment variable still wins.
    crate::slim::configure(&cfg);
    crate::tool_security::configure(agent_tool_sandbox(&cfg, !cli.share_file.is_empty()));
    if !rdsh_config::feature_enabled(&cfg, "sessions_token_cache")
        && std::env::var_os("RDSH_TOKENS_CACHE").is_none()
    {
        std::env::set_var("RDSH_TOKENS_CACHE", "0");
    }
    let pass = cli.passthrough || passthrough::env_passthrough() || cfg.general.passthrough;
    let slim = !cli.no_slim && !pass && (cli.slim || cfg.general.slim);
    let dry = cli.dry_run || passthrough::env_dry() || cfg.general.dry_run;
    let result: anyhow::Result<()> = match cli.command {
        Some(Commands::Tokens { files, preview }) => tokens::cmd_tokens(files, preview, locale),
        Some(Commands::Prune { max_tokens, file }) => tokens::cmd_prune(
            max_tokens.unwrap_or(cfg.tokens.default_budget),
            file,
            locale,
        ),
        Some(Commands::Search { pattern, dir, max }) => {
            let dir = dir.unwrap_or_else(|| cfg.search.dir.clone());
            search::cmd_search(&pattern, &dir, max.unwrap_or(cfg.search.max), locale)
        }
        Some(Commands::SearchWeb { query, limit, json }) => {
            if !rdsh_config::feature_enabled(&cfg, "search-web") {
                extra_disabled("search-web", locale)
            } else {
                websearch::cmd_search_web(
                    &query,
                    limit.unwrap_or(cfg.search.web_limit),
                    json,
                    locale,
                )
            }
        }
        Some(Commands::Compact { file, max_tokens }) => {
            compact::cmd_compact(&file, max_tokens.unwrap_or(cfg.compact.max_tokens), locale)
        }
        Some(Commands::Doctor) => doctor(locale),
        Some(Commands::Sessions {
            project,
            limit,
            tokens,
            json,
        }) => inspect::cmd_sessions(
            project,
            limit.unwrap_or(cfg.sessions.limit),
            tokens || cfg.sessions.with_tokens,
            json,
            cfg.sessions.stale_secs,
            locale,
        ),
        Some(Commands::Profiles) => inspect::cmd_profiles(locale),
        Some(Commands::Skills) => inspect::cmd_skills(locale),
        Some(Commands::Logs { tail, grep, file }) => {
            inspect::cmd_logs(tail.unwrap_or(cfg.logs.tail), grep, file, locale)
        }
        Some(Commands::Serve { port }) => {
            if !rdsh_config::feature_enabled(&cfg, "serve") {
                extra_disabled("serve", locale)
            } else {
                serve::cmd_serve(port.unwrap_or(cfg.serve.port), locale)
            }
        }
        Some(Commands::SerialProxy {
            upstream,
            port,
            host,
            allow_remote,
            max,
            queue_timeout,
            max_queue,
            tool_choice_default,
            max_body_bytes,
            rpm,
        }) => serial_proxy::cmd_serial_proxy(
            serial_proxy::SerialProxyOptions {
                upstream,
                port,
                host,
                allow_remote,
                max,
                queue_timeout,
                max_queue,
                tool_choice_default: tool_choice_default.map(|choice| choice.as_str().to_string()),
                max_body_bytes,
                rpm,
            },
            locale,
        ),
        Some(Commands::Bench { n }) => bench(n.unwrap_or(cfg.bench.n), locale),
        Some(Commands::Compute { once }) => compute::cmd_compute(once, locale),
        Some(Commands::WorkerScope { .. }) => {
            unreachable!("worker-scope returns before settings load")
        }

        Some(Commands::Guard {
            deny,
            policy_file,
            reason,
            json,
        }) => {
            let mut merged = cfg.guard.deny.clone();
            merged.extend(deny);
            let reason = reason.or_else(|| {
                let r = cfg.guard.reason.trim().to_string();
                if r.is_empty() {
                    None
                } else {
                    Some(r)
                }
            });
            guard::cmd_guard(merged, reason, json, policy_file, locale)
        }
        Some(Commands::Update { action }) => match action {
            UpdateAction::Auto { action } => match action {
                AutoAction::Status { json } => {
                    update_auto::cmd_update_auto("status", false, json, locale)
                }
                AutoAction::On { dry_run, json } => {
                    update_auto::cmd_update_auto("on", dry_run, json, locale)
                }
                AutoAction::Off { dry_run, json } => {
                    update_auto::cmd_update_auto("off", dry_run, json, locale)
                }
            },
        },
        Some(Commands::Settings { action }) => match action {
            SettingsAction::Path => {
                println!("{}", rdsh_config::settings_path());
                Ok(())
            }
            SettingsAction::Show { json } => {
                // Reuse outer cfg (same file, same parse); second load was pure overhead.
                let v = cfg.to_value();
                if json {
                    match serde_json::to_string_pretty(&v) {
                        Ok(text) => {
                            println!("{text}");
                            Ok(())
                        }
                        Err(e) => Err(anyhow::anyhow!(e)),
                    }
                } else {
                    // Effective values per editable key with their source:
                    // `config` = explicitly present in rdsh.json,
                    // `default` = built-in fallback. `settings keys` remains
                    // the editable-key list.
                    println!(
                        "{}: {}",
                        match locale {
                            locale::Locale::English => "config",
                            locale::Locale::Chinese => "配置",
                            locale::Locale::Japanese => "設定",
                        },
                        rdsh_config::settings_path()
                    );
                    let raw: serde_json::Value =
                        std::fs::read_to_string(rdsh_config::settings_path())
                            .ok()
                            .and_then(|text| serde_json::from_str(&text).ok())
                            .unwrap_or_default();
                    for annotated in rdsh_config::RdshSettings::keys() {
                        let key = annotated.split('(').next().unwrap_or(annotated);
                        let value = cfg.get_dotted(key).unwrap_or_default();
                        let rendered = match value {
                            serde_json::Value::String(s) => s,
                            v => serde_json::to_string(&v).unwrap_or_else(|_| "-".to_string()),
                        };
                        let source = if settings_key_in_file(&raw, key) {
                            match locale {
                                locale::Locale::English => "config",
                                locale::Locale::Chinese => "配置",
                                locale::Locale::Japanese => "設定",
                            }
                        } else {
                            match locale {
                                locale::Locale::English => "default",
                                locale::Locale::Chinese => "默认",
                                locale::Locale::Japanese => "既定値",
                            }
                        };
                        println!("{key}  {rendered}  {source}");
                    }
                    // Features show their effective state, not just what is written.
                    for annotated in rdsh_config::RdshSettings::feature_keys() {
                        let key = annotated.split('(').next().unwrap_or(annotated.as_str());
                        let id = key.strip_prefix("features.").unwrap_or(key);
                        let state = if rdsh_config::feature_enabled(&cfg, id) {
                            "true"
                        } else {
                            "false"
                        };
                        let source = if rdsh_config::feature_is_explicit(&cfg, id) {
                            match locale {
                                locale::Locale::English => "config",
                                locale::Locale::Chinese => "配置",
                                locale::Locale::Japanese => "設定",
                            }
                        } else {
                            match locale {
                                locale::Locale::English => "default",
                                locale::Locale::Chinese => "默认",
                                locale::Locale::Japanese => "既定値",
                            }
                        };
                        println!("{key}  {state}  {source}");
                    }
                    Ok(())
                }
            }
            SettingsAction::Init { force } => {
                let path = rdsh_config::settings_path();
                match rdsh_config::initialize(force, locale) {
                    Ok(true) => {
                        println!("{path}");
                        Ok(())
                    }
                    Ok(false) => {
                        eprintln!(
                            "[rdsh] {} {path} ({})",
                            locale::message(locale, locale::Message::SettingsExists),
                            match locale {
                                locale::Locale::English => "use --force to overwrite",
                                locale::Locale::Chinese => "使用 --force 覆盖",
                                locale::Locale::Japanese => "上書きするには --force を使います",
                            }
                        );
                        std::process::exit(2);
                    }
                    Err(e) => Err(e),
                }
            }
            SettingsAction::Get { key, json } => match cfg.get_dotted(&key) {
                Some(v) => {
                    if json || v.is_object() || v.is_array() {
                        match serde_json::to_string_pretty(&v) {
                            Ok(text) => {
                                println!("{text}");
                                Ok(())
                            }
                            Err(e) => Err(anyhow::anyhow!(e)),
                        }
                    } else if let Some(s) = v.as_str() {
                        println!("{s}");
                        Ok(())
                    } else {
                        println!("{v}");
                        Ok(())
                    }
                }
                None => {
                    eprintln!(
                        "[rdsh] {}: {key} ({})",
                        locale::message(locale, locale::Message::UnknownSetting),
                        match locale {
                            locale::Locale::English => "try: rdsh settings keys",
                            locale::Locale::Chinese => "请尝试: rdsh settings keys",
                            locale::Locale::Japanese => "rdsh settings keys を実行してください",
                        }
                    );
                    std::process::exit(2);
                }
            },
            SettingsAction::Set { key, value } => {
                match rdsh_config::update(locale, |cfg| {
                    cfg.set_dotted_with_locale(&key, &value, locale)
                }) {
                    Err(e) => Err(e),
                    Ok((cfg, ())) => match cfg.get_dotted(&key) {
                        Some(v) => {
                            if v.is_string() {
                                println!("{}={}", key.trim(), v.as_str().unwrap_or_default());
                                Ok(())
                            } else {
                                match serde_json::to_string(&v) {
                                    Ok(text) => {
                                        println!("{}={text}", key.trim());
                                        Ok(())
                                    }
                                    Err(e) => Err(anyhow::anyhow!(e)),
                                }
                            }
                        }
                        None => Err(anyhow::anyhow!(match locale {
                            locale::Locale::English => format!("set failed: {key}"),
                            locale::Locale::Chinese => format!("设置失败: {key}"),
                            locale::Locale::Japanese => format!("設定に失敗しました: {key}"),
                        })),
                    },
                }
            }
            SettingsAction::Unset { key } => {
                match rdsh_config::update(locale, |cfg| cfg.reset_dotted_with_locale(&key, locale))
                {
                    Err(e) => Err(e),
                    Ok(_) => {
                        println!(
                            "{} {} ({})",
                            locale::message(locale, locale::Message::Reset),
                            key.trim(),
                            match locale {
                                locale::Locale::English =>
                                    format!("saved to {}", rdsh_config::settings_path()),
                                locale::Locale::Chinese =>
                                    format!("已保存到 {}", rdsh_config::settings_path()),
                                locale::Locale::Japanese =>
                                    format!("{} に保存しました", rdsh_config::settings_path()),
                            },
                        );
                        Ok(())
                    }
                }
            }
            SettingsAction::Keys => {
                for k in rdsh_config::RdshSettings::keys() {
                    println!("{k}");
                }
                for k in rdsh_config::RdshSettings::feature_keys() {
                    println!("{k}");
                }
                Ok(())
            }
        },
        Some(Commands::TaskOutcomes { action, input_file }) => {
            task_outcomes::cmd_task_outcomes(&action, &input_file, locale)
        }
        Some(Commands::BudgetAdmission { action, input_file }) => {
            budget_admission::cmd_budget_admission(&action, &input_file, locale)
        }
        Some(Commands::Features { action, json }) => match action {
            None => features_list(&cfg, json, locale),
            Some(FeaturesAction::On { id }) => features_toggle(&id, true, locale),
            Some(FeaturesAction::Off { id }) => features_toggle(&id, false, locale),
        },
        Some(Commands::Subagents { action }) => match action {
            SubagentsAction::Plan { input_file, .. } => {
                subagent_plan::cmd_plan(&input_file, locale)
            }
        },
        Some(Commands::CostLedger { action, input_file }) => {
            cost_ledger::cmd_cost_ledger(&action, &input_file, locale)
        }
        Some(Commands::Desktop { action, json }) => match action {
            None => desktop::cmd_status(json, locale),
            Some(DesktopAction::Status { json: inner }) => {
                desktop::cmd_status(json || inner, locale)
            }
            Some(DesktopAction::Install {
                dry_run,
                plugins_dir,
                compute,
                package,
                no_bundled,
                json: inner,
            }) => desktop::cmd_install(
                plugins_dir.as_deref(),
                &package,
                no_bundled,
                dry_run,
                compute,
                json || inner,
                locale,
            ),
            Some(DesktopAction::Verify {
                require,
                json: inner,
            }) => desktop::cmd_verify(&require, json || inner, locale),
        },
        Some(Commands::Context { action }) => {
            if !rdsh_config::feature_enabled(&cfg, "context_engine") {
                eprintln!(
                    "[rdsh] {}",
                    locale::ui_message(locale, locale::UiMessage::ContextDisabled)
                );
                std::process::exit(2);
            }
            match action {
                ContextAction::Build {
                    query,
                    budget,
                    json,
                } => context::cmd_build(query, budget, json, locale),
                ContextAction::Search { query, max } => {
                    context::cmd_search(query, max.unwrap_or(cfg.context.max_code_hits), locale)
                }
                ContextAction::Status { json } => context::cmd_status(json, locale),
                ContextAction::Explain { query, budget } => {
                    context::cmd_explain(query, budget, locale)
                }
            }
        }
        Some(Commands::Auth(args)) => auth::cmd_auth(args, dry, locale),
        Some(Commands::Provider { action }) => match action {
            ProviderAction::List { json } => providers::cmd_list(json, locale),
            ProviderAction::Add {
                preset,
                profile,
                model,
                from_opencode,
                discover,
                base_url,
                id,
                name,
                key_stdin,
                no_key,
                replace,
                json,
            } => providers::cmd_add(
                providers::AddArgs {
                    preset,
                    profile: profile.or(cli.profile),
                    models: model,
                    from_opencode,
                    discover,
                    base_url,
                    id,
                    name,
                    key_stdin,
                    no_key,
                    replace,
                    // The global flag only: general.dry_run in settings is
                    // about delegated launches, not about file edits.
                    dry_run: cli.dry_run,
                    json,
                },
                &cfg.general.default_profile,
                locale,
            ),
        },
        Some(Commands::Setup {
            open,
            login,
            json,
            yes,
            web,
            port,
        }) => {
            if web && !dry {
                if rdsh_config::feature_enabled(&cfg, "setup_web") {
                    setup_web::cmd_setup_web(port.unwrap_or(cfg.setup.web_port), locale)
                } else {
                    Err(anyhow::anyhow!(match locale {
                        locale::Locale::English => {
                            "rdsh setup --web is off; enable with: rdsh features on setup_web"
                        }
                        locale::Locale::Chinese => {
                            "rdsh setup --web 已关闭；请启用：rdsh features on setup_web"
                        }
                        locale::Locale::Japanese => {
                            "rdsh setup --web はオフです。有効化: rdsh features on setup_web"
                        }
                    }))
                }
            } else {
                auth::cmd_setup(open, login, json, yes, dry, locale)
            }
        }
        Some(Commands::DumpConfig { profile, native }) => profile_or_default(
            profile.or(cli.profile),
            &cfg.general.default_profile,
            locale,
        )
        .and_then(|p| {
            if native {
                dump_config_native(&p, &cli.patch, locale)
            } else {
                passthrough::exec_dump_config(
                    &p,
                    None,
                    dsh_args::DumpKind::Config,
                    &cli.patch,
                    dry,
                    slim,
                    locale,
                )
            }
        }),
        Some(Commands::Boot {
            profile,
            from_default_profile,
            args,
        }) => profile_or_default(
            profile.or(cli.profile),
            &cfg.general.default_profile,
            locale,
        )
        .and_then(|p| {
            passthrough::exec_boot(
                &p,
                from_default_profile.as_deref(),
                &cli.patch,
                &args,
                dry,
                slim,
                locale,
            )
        }),
        None => {
            let parsed = dsh_args::split_launcher_args(cli.profile, cli.extra);
            match parsed {
                dsh_args::Launcher::Help => {
                    let _ = localized_command(locale).print_help();
                    Ok(())
                }
                dsh_args::Launcher::Plugin { profile, pnpm_args } => {
                    passthrough::exec_plugin(&profile, &pnpm_args, dry, slim, locale)
                }
                dsh_args::Launcher::Boot {
                    profile,
                    from_default,
                    patches,
                    app_args,
                } => {
                    let mut all = cli.patch;
                    all.extend(patches);
                    passthrough::exec_boot(
                        &profile,
                        from_default.as_deref(),
                        &all,
                        &app_args,
                        dry,
                        slim,
                        locale,
                    )
                }
                dsh_args::Launcher::Dump {
                    profile,
                    from_default,
                    kind,
                    patches,
                } => {
                    let mut all = cli.patch;
                    all.extend(patches);
                    passthrough::exec_dump_config(
                        &profile,
                        from_default.as_deref(),
                        kind,
                        &all,
                        dry,
                        slim,
                        locale,
                    )
                }
                dsh_args::Launcher::Error(msg) => {
                    eprintln!("{}", localized_launcher_error(locale, &msg));
                    std::process::exit(2);
                }
            }
        }
    };
    if let Err(e) = result {
        match e.downcast::<clap::Error>() {
            Ok(error) => exit_clap_error(locale, error),
            Err(error) => {
                let diagnostic = error
                    .chain()
                    .map(|cause| {
                        if let Some(error) = cause.downcast_ref::<subagent_plan::PlanError>() {
                            localized_format!(
                                locale,
                                "Subagent plan: {}",
                                "子代理计划：{}",
                                "サブエージェント計画: {}",
                                error.code
                            )
                        } else if let Some(error) =
                            cause.downcast_ref::<task_outcomes::OutcomeError>()
                        {
                            let translated = locale::diagnostic(locale, &error.message);
                            let message = if translated != error.message {
                                translated.to_string()
                            } else if let Some(key) = error.message.strip_prefix("Invalid outcome ")
                            {
                                localized_format!(
                                    locale,
                                    "Invalid outcome {key}",
                                    "结果 {key} 无效",
                                    "結果の {key} が無効です"
                                )
                            } else {
                                locale::diagnostic(locale, &error.message).to_string()
                            };
                            localized_format!(
                                locale,
                                "Task outcomes: {message}",
                                "任务结果：{message}",
                                "タスク結果: {message}"
                            )
                        } else {
                            locale::diagnostic(locale, &cause.to_string()).to_string()
                        }
                    })
                    .collect::<Vec<_>>()
                    .join(": ");
                eprintln!(
                    "[rdsh] {}: {diagnostic}",
                    locale::message(locale, locale::Message::Error)
                );
                std::process::exit(1);
            }
        }
    }
}

fn localized_launcher_error(locale: locale::Locale, message: &str) -> String {
    if locale == locale::Locale::English {
        return message.to_string();
    }
    let translated = match message {
        "error: plugin needs pnpm arguments to forward (e.g. add <package>)" => match locale {
            locale::Locale::Chinese => "错误：plugin 需要转发 pnpm 参数（例如 add <package>）",
            locale::Locale::Japanese => "エラー: plugin には転送する pnpm 引数が必要です（例: add <package>）",
            locale::Locale::English => unreachable!(),
        },
        "error: --profile <name> is required" => match locale {
            locale::Locale::Chinese => "错误：需要 --profile <name>",
            locale::Locale::Japanese => "エラー: --profile <name> が必要です",
            locale::Locale::English => unreachable!(),
        },
        "error: select a profile only once" => match locale {
            locale::Locale::Chinese => "错误：只能选择一次配置文件",
            locale::Locale::Japanese => "エラー: プロファイルは一度だけ選択してください",
            locale::Locale::English => unreachable!(),
        },
        "error: --profile needs a name" => match locale {
            locale::Locale::Chinese => "错误：--profile 需要名称",
            locale::Locale::Japanese => "エラー: --profile には名前が必要です",
            locale::Locale::English => unreachable!(),
        },
        "error: --from-default-profile needs a name" => match locale {
            locale::Locale::Chinese => "错误：--from-default-profile 需要名称",
            locale::Locale::Japanese => "エラー: --from-default-profile には名前が必要です",
            locale::Locale::English => unreachable!(),
        },
        "error: --patch needs a path" => match locale {
            locale::Locale::Chinese => "错误：--patch 需要路径",
            locale::Locale::Japanese => "エラー: --patch にはパスが必要です",
            locale::Locale::English => unreachable!(),
        },
        "error: profile desktop is managed exclusively by the Electron application" => match locale {
            locale::Locale::Chinese => "错误：desktop 配置文件仅由 Electron 应用管理",
            locale::Locale::Japanese => "エラー: desktop プロファイルは Electron アプリケーションのみが管理します",
            locale::Locale::English => unreachable!(),
        },
        "error: --dump-config, --dump-default-config, and --dump-config-schema are mutually exclusive" => match locale {
            locale::Locale::Chinese => "错误：--dump-config、--dump-default-config 和 --dump-config-schema 不能同时使用",
            locale::Locale::Japanese => "エラー: --dump-config、--dump-default-config、--dump-config-schema は同時に使用できません",
            locale::Locale::English => unreachable!(),
        },
        "error: config dumps take no app arguments" => match locale {
            locale::Locale::Chinese => "错误：配置转储不接受应用参数",
            locale::Locale::Japanese => "エラー: 設定ダンプはアプリ引数を受け取りません",
            locale::Locale::English => unreachable!(),
        },
        "error: --dump-default-config prints the bundle layers and takes no --patch" => match locale {
            locale::Locale::Chinese => "错误：--dump-default-config 打印捆绑层且不接受 --patch",
            locale::Locale::Japanese => "エラー: --dump-default-config はバンドルレイヤーを出力し、--patch を受け取りません",
            locale::Locale::English => unreachable!(),
        },
        _ => message,
    };
    translated.to_string()
}

fn requested_locale() -> Result<locale::Locale, (locale::Locale, anyhow::Error)> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let explicit = args.iter().enumerate().find_map(|(index, arg)| {
        arg.strip_prefix("--language=").or_else(|| {
            (arg == "--language")
                .then(|| args.get(index + 1).map(String::as_str))
                .flatten()
        })
    });
    let early_locale = locale::current(explicit, "auto");
    if settings_independent_invocation() {
        return Ok(early_locale);
    }
    let settings = match rdsh_config::try_load_with_locale(early_locale) {
        Ok(settings) => settings,
        Err(error) => {
            // Pure worker-scope help has the same settings independence as its commands.
            if worker_scope_help_requested() {
                return Ok(early_locale);
            }
            return Err((early_locale, error));
        }
    };
    let setting = settings.general.language;
    Ok(locale::current(explicit, &setting))
}

/// Classify help with Clap's grammar, keeping option values and literal flags out.
fn worker_scope_help_requested() -> bool {
    if !matches!(Cli::try_parse_from(std::env::args_os()), Err(help) if help.kind() == clap::error::ErrorKind::DisplayHelp)
    {
        return false;
    }
    fn parse_help_as_flag(command: clap::Command) -> clap::Command {
        command
            .disable_help_flag(true)
            .disable_help_subcommand(true)
            .subcommand_required(false)
            .arg_required_else_help(false)
            .arg(
                clap::Arg::new("help")
                    .long("help")
                    .short('h')
                    .action(clap::ArgAction::SetTrue),
            )
            .mut_subcommands(parse_help_as_flag)
    }
    let command = parse_help_as_flag(Cli::command())
        .subcommand(clap::Command::new("help").arg(clap::Arg::new("command").num_args(0..)));
    let Ok(matches) = command.try_get_matches() else {
        return false;
    };
    if matches.get_flag("help") {
        return false;
    }
    match matches.subcommand() {
        Some(("worker-scope", worker)) => {
            let mut selected = worker;
            loop {
                if selected.get_flag("help") {
                    break true;
                }
                let Some((_, child)) = selected.subcommand() else {
                    break false;
                };
                selected = child;
            }
        }
        Some(("help", help)) => help
            .get_many::<String>("command")
            .and_then(|mut path| path.next())
            .is_some_and(|name| name == "worker-scope"),
        _ => false,
    }
}

/// Recovery and pure JSON commands resolve language from flags or the process
/// environment without opening an unrelated settings file.
fn settings_independent_invocation() -> bool {
    matches!(
        Cli::try_parse_from(std::env::args_os()),
        Ok(Cli {
            command: Some(
                Commands::Settings {
                    action: SettingsAction::Init { force: true }
                } | Commands::TaskOutcomes { .. }
                    | Commands::Subagents { .. }
                    | Commands::BudgetAdmission { .. }
                    | Commands::CostLedger { .. }
                    | Commands::WorkerScope { .. }
            ),
            ..
        })
    )
}

fn parse_cli(locale: locale::Locale) -> Cli {
    let command = localized_command(locale);
    let matches = match command.try_get_matches() {
        Ok(matches) => matches,
        Err(error) => exit_clap_error(locale, error),
    };
    Cli::from_arg_matches(&matches).unwrap_or_else(|error| exit_clap_error(locale, error))
}

/// Keep Clap's detailed parse output intact while leading with rdsh-owned text
/// selected from its structured error kind.
fn exit_clap_error(locale: locale::Locale, error: clap::Error) -> ! {
    use clap::error::ErrorKind;

    if matches!(
        error.kind(),
        ErrorKind::DisplayHelp | ErrorKind::DisplayVersion
    ) {
        error.exit();
    }
    let description = match error.kind() {
        ErrorKind::InvalidValue | ErrorKind::ValueValidation => match locale {
            locale::Locale::English => "an argument value is invalid",
            locale::Locale::Chinese => "参数值无效",
            locale::Locale::Japanese => "引数の値が無効です",
        },
        ErrorKind::UnknownArgument | ErrorKind::InvalidSubcommand => match locale {
            locale::Locale::English => "an argument or command is not recognized",
            locale::Locale::Chinese => "无法识别参数或命令",
            locale::Locale::Japanese => "引数またはコマンドを認識できません",
        },
        ErrorKind::NoEquals
        | ErrorKind::TooManyValues
        | ErrorKind::TooFewValues
        | ErrorKind::WrongNumberOfValues => match locale {
            locale::Locale::English => "the number or form of argument values is invalid",
            locale::Locale::Chinese => "参数值的数量或形式无效",
            locale::Locale::Japanese => "引数の値の数または形式が無効です",
        },
        ErrorKind::ArgumentConflict => match locale {
            locale::Locale::English => "conflicting arguments were provided",
            locale::Locale::Chinese => "提供的参数相互冲突",
            locale::Locale::Japanese => "競合する引数が指定されました",
        },
        ErrorKind::MissingRequiredArgument | ErrorKind::MissingSubcommand => match locale {
            locale::Locale::English => "a required argument or command is missing",
            locale::Locale::Chinese => "缺少必需的参数或命令",
            locale::Locale::Japanese => "必須の引数またはコマンドがありません",
        },
        ErrorKind::InvalidUtf8 => match locale {
            locale::Locale::English => "an argument is not valid UTF-8",
            locale::Locale::Chinese => "参数不是有效的 UTF-8",
            locale::Locale::Japanese => "引数が有効な UTF-8 ではありません",
        },
        ErrorKind::DisplayHelpOnMissingArgumentOrSubcommand => match locale {
            locale::Locale::English => "a command or argument is required",
            locale::Locale::Chinese => "需要命令或参数",
            locale::Locale::Japanese => "コマンドまたは引数が必要です",
        },
        ErrorKind::Io | ErrorKind::Format | ErrorKind::DisplayHelp | ErrorKind::DisplayVersion => {
            match locale {
                locale::Locale::English => "the command-line parser could not format its output",
                locale::Locale::Chinese => "命令行解析器无法格式化输出",
                locale::Locale::Japanese => "コマンドライン解析器が出力を整形できません",
            }
        }
        _ => match locale {
            locale::Locale::English => "the command-line parser rejected the arguments",
            locale::Locale::Chinese => "命令行解析器拒绝了参数",
            locale::Locale::Japanese => "コマンドライン解析器が引数を拒否しました",
        },
    };
    eprintln!(
        "[rdsh] {}: {description}",
        locale::message(locale, locale::Message::InvalidArguments)
    );
    eprintln!(
        "[rdsh] {}:",
        locale::message(locale, locale::Message::ExternalDiagnostic)
    );
    eprint!("{}", error.render());
    std::process::exit(error.exit_code());
}

fn localized_command(locale: locale::Locale) -> clap::Command {
    let mut command = Cli::command();
    if locale != locale::Locale::English {
        // Clap inserts its help flags and `help` subcommand while building.
        // Build first so those generated user-interface entries receive the
        // same translated headings and descriptions as derive-defined items.
        command.build();
    }
    localize_command_tree(command, locale)
}

fn localize_command_tree(command: clap::Command, locale: locale::Locale) -> clap::Command {
    if locale == locale::Locale::English {
        return command;
    }
    let name = command.get_name().to_string();
    let about = localized_command_about(&name, locale)
        .unwrap_or_else(|| panic!("missing localized command description for {name}"));
    let command = command
        .about(about)
        .help_template(match locale {
            locale::Locale::Chinese => {
                "{about-with-newline}用法：{usage}\n\n{all-args}{after-help}"
            }
            locale::Locale::Japanese => {
                "{about-with-newline}使い方: {usage}\n\n{all-args}{after-help}"
            }
            locale::Locale::English => unreachable!(),
        })
        .subcommand_help_heading(match locale {
            locale::Locale::Chinese => "命令",
            locale::Locale::Japanese => "コマンド",
            locale::Locale::English => unreachable!(),
        })
        .mut_args(|arg| {
            let heading = if arg.is_positional() {
                match locale {
                    locale::Locale::Chinese => "参数",
                    locale::Locale::Japanese => "引数",
                    locale::Locale::English => unreachable!(),
                }
            } else {
                match locale {
                    locale::Locale::Chinese => "选项",
                    locale::Locale::Japanese => "オプション",
                    locale::Locale::English => unreachable!(),
                }
            };
            let arg = arg.help_heading(heading);
            let id = arg.get_id().to_string();
            let help = if name == "cost-ledger" && id == "action" {
                match locale {
                    locale::Locale::Chinese => {
                        "操作：declare | report | validate | public | schema"
                    }
                    locale::Locale::Japanese => {
                        "操作: declare | report | validate | public | schema"
                    }
                    locale::Locale::English => unreachable!(),
                }
            } else {
                localized_arg_help(&id, locale)
                    .unwrap_or_else(|| panic!("missing localized argument description for {id}"))
            };
            let arg = arg.help(help);
            if id == "language" {
                arg.hide_possible_values(true)
            } else {
                arg
            }
        })
        .mut_subcommands(|subcommand| localize_command_tree(subcommand, locale));
    if let Some(after_help) = localized_after_help(&name, locale) {
        command.after_help(after_help)
    } else {
        command
    }
}

fn localized_command_about(name: &str, locale: locale::Locale) -> Option<&'static str> {
    let (chinese, japanese) = match name {
        "rdsh" => (
            "dsh 的 Rust 快速启动器（安全：原生快速路径与透传）",
            "dsh のRust高速ランチャー（安全: ネイティブ高速パスと透過実行）",
        ),
        "tokens" => ("原生估算输入令牌数", "入力トークン数をネイティブで推定"),
        "search" => ("高速文件搜索", "高速ファイル検索"),
        "search-web" => ("通过 SearXNG 进行网页搜索", "SearXNG によるWeb検索"),
        "serve" => (
            "启动本地仪表板（仅 127.0.0.1，只读 API）",
            "ローカルダッシュボードを起動（127.0.0.1のみ、読み取り専用API）",
        ),
        "sessions" => (
            "列出 $DSH_HOME 下的会话（最新优先，无 Node）",
            "$DSH_HOME 配下のセッションを一覧（新しい順、Node不要）",
        ),
        "profiles" => (
            "列出本地配置文件（无 Node）",
            "ローカルプロファイルを一覧（Node不要）",
        ),
        "skills" => (
            "列出已安装技能（无 Node）",
            "インストール済みスキルを一覧（Node不要）",
        ),
        "logs" => ("显示 $DSH_HOME 日志", "$DSH_HOME のログを表示"),
        "auth" => (
            "列出并按来源选择共享凭据",
            "認証情報を一覧し共有するソースを選択",
        ),
        "setup" => ("首次连接模型", "初回のモデル接続"),
        "auto" => ("每日自动更新计时器", "毎日の自動更新タイマー"),
        "provider" => (
            "配置 OpenAI 兼容的提供方路由",
            "OpenAI互換プロバイダーの経路を設定",
        ),
        "list" => (
            "列出预设、配置文件路由和密钥状态",
            "プリセット・プロファイルの経路・キーの状態を一覧",
        ),
        "add" => (
            "将提供方路由添加到配置文件",
            "プロファイルへプロバイダー経路を追加",
        ),
        "serial-proxy" => (
            "启动限制并发和速率的本地反向代理",
            "同時実行数と速度を制限するローカル逆プロキシを起動",
        ),
        "subagents" => (
            "生成确定性的子代理分派计划",
            "決定的なサブエージェント割り当て計画を作成",
        ),
        "plan" => (
            "读取请求并生成分派计划，不启动代理",
            "要求を読み取り割り当て計画を作成（エージェントは起動しません）",
        ),
        "budget-admission" => (
            "应用、验证预算准入记录或输出公开视图",
            "予算受付記録を適用・検証し公開表示を出力",
        ),
        "cost-ledger" => (
            "声明、记录、验证费用台账或输出公开视图与 JSON schema",
            "費用台帳を宣言・記録・検証し公開表示やJSONスキーマを出力",
        ),
        "worker-scope" => (
            "从标准输入验证并规范化工作区范围声明",
            "標準入力からワーカー作業範囲を検証・正規化",
        ),
        "validate" => (
            "读取声明的 JSON 数组并输出结果记录",
            "宣言のJSON配列を読み取り結果レコードを出力",
        ),
        "policy" => (
            "批量判断写入路径、范围交集和共享文件策略",
            "書き込み範囲・範囲の交差・共有ファイル判定を一括実行",
        ),
        "task-outcomes" => (
            "应用或验证任务结果与固定里程碑",
            "タスク結果と固定マイルストーンを適用・検証",
        ),
        "update" => ("管理自动更新计时器", "自動更新タイマーを管理"),
        "context" => ("上下文引擎原型", "コンテキストエンジン試作"),
        "compute" => ("常驻纯计算工作进程", "常駐の純粋計算ワーカー"),
        "guard" => (
            "hooks.json 的输入阻止辅助程序",
            "hooks.json用の入力ブロック補助",
        ),
        "settings" => ("统一 rdsh 设置", "統合rdsh設定"),
        "features" => ("功能开关", "機能スイッチ"),
        "desktop" => (
            "DeepSeek Harness Desktop 集成",
            "DeepSeek Harness Desktop連携",
        ),
        "prune" => ("将文本裁剪到令牌预算", "テキストをトークン予算まで切り詰め"),
        "compact" => ("压缩文本文件", "テキストファイルを圧縮"),
        "doctor" => ("显示诊断摘要", "診断サマリーを表示"),
        "bench" => ("运行启动基准测试", "起動ベンチマークを実行"),
        "boot" => ("启动 dsh 配置文件", "dshプロファイルを起動"),
        "dump-config" => ("输出有效配置", "有効な設定を出力"),
        "build" => ("构建本轮的上下文", "このターンのコンテキストを構築"),
        "status" => ("显示状态", "状態を表示"),
        "explain" => ("解释上下文内容", "コンテキスト内容を説明"),
        "show" => ("显示当前设置", "現在の設定を表示"),
        "path" => ("显示设置文件路径", "設定ファイルのパスを表示"),
        "init" => ("写入默认设置", "既定の設定を書き込む"),
        "get" => ("读取一个设置值", "設定値を1つ読み取る"),
        "set" => ("写入一个设置值", "設定値を1つ書き込む"),
        "unset" => ("将设置重置为默认值", "設定を既定値に戻す"),
        "keys" => ("列出可编辑的设置键", "編集可能な設定キーを一覧"),
        "on" => ("启用", "有効にする"),
        "off" => ("禁用", "無効にする"),
        "install" => ("安装桌面应用集成", "デスクトップアプリ連携をインストール"),
        "verify" => ("验证桌面应用集成", "デスクトップアプリ連携を検証"),
        "help" => ("显示帮助", "ヘルプを表示"),
        _ => return None,
    };
    Some(match locale {
        locale::Locale::Chinese => chinese,
        locale::Locale::Japanese => japanese,
        locale::Locale::English => unreachable!(),
    })
}

fn localized_after_help(name: &str, locale: locale::Locale) -> Option<&'static str> {
    (name == "rdsh").then(|| match locale {
        locale::Locale::Chinese => "用法：\n  rdsh [profile] [--profile <name>] [--patch <yml>...] [app-args...]\n  rdsh <native-subcommand> ...   (tokens|prune|search|search-web|compact|doctor|bench|serve|sessions|profiles|skills|logs|guard|compute|desktop|auth|setup|context|settings|features|provider|subagents|task-outcomes|budget-admission|cost-ledger|update|worker-scope|dump-config|boot|serial-proxy)\n\n示例：\n  rdsh tui                        启动 tui 配置文件（slim 环境开启，委托给 dsh）\n  rdsh --profile web --patch x.yml 使用叠加层启动 web\n  rdsh dump-config --profile tui  委托 dsh 输出准确配置\n  rdsh tokens ./AGENTS.md         原生估算输入令牌数\n  rdsh auth --import --provider openai-codex   只导入选定提供方\n  rdsh provider list              查看预设、路由和密钥状态\n  rdsh provider add hai --model deepseek-v4-flash   注册 HAI 路由\n  rdsh setup                      首次连接：选择共享、登录流程和后续步骤\n  rdsh search hello --dir .       无 Node 的快速文件搜索\n  rdsh search-web \"rust async\"      通过 SearXNG 网页搜索（无需 API 密钥）\n  rdsh desktop status             检测 Desktop（Electron）应用及其保留配置文件\n  rdsh desktop install            将捆绑 rdsh 插件附加到该配置文件\n  rdsh --passthrough tui          不使用 slim 环境；必需的工具隔离仍会启用\n  rdsh --dry-run tui -- --resume abc   显示将执行的命令",
        locale::Locale::Japanese => "使い方：\n  rdsh [profile] [--profile <name>] [--patch <yml>...] [app-args...]\n  rdsh <native-subcommand> ...   (tokens|prune|search|search-web|compact|doctor|bench|serve|sessions|profiles|skills|logs|guard|compute|desktop|auth|setup|context|settings|features|provider|subagents|task-outcomes|budget-admission|cost-ledger|update|worker-scope|dump-config|boot|serial-proxy)\n\n例：\n  rdsh tui                        tuiプロファイルを起動（slim環境ON、dshへ委譲）\n  rdsh --profile web --patch x.yml オーバーレイ付きでwebを起動\n  rdsh dump-config --profile tui  dshへ正確な設定出力を委譲\n  rdsh tokens ./AGENTS.md         入力トークン数をネイティブで推定\n  rdsh auth --import --provider openai-codex   選択したプロバイダーだけをインポート\n  rdsh provider list              プリセット・経路・キーの状態を確認\n  rdsh provider add hai --model deepseek-v4-flash   HAI経路を登録\n  rdsh setup                      初回接続: 共有の選択、ログイン手順、次のステップ\n  rdsh search hello --dir .       Nodeなしの高速ファイル検索\n  rdsh search-web \"rust async\"      SearXNGによるWeb検索（APIキー不要）\n  rdsh desktop status             Desktop（Electron）アプリと専用プロファイルを検出\n  rdsh desktop install            同プロファイルに同梱rdshプラグインを追加\n  rdsh --passthrough tui          slim環境なし。必須のツール分離は維持\n  rdsh --dry-run tui -- --resume abc   実行するコマンドを表示",
        locale::Locale::English => unreachable!(),
    })
}

fn localized_arg_help(id: &str, locale: locale::Locale) -> Option<&'static str> {
    let (chinese, japanese) = match id {
        "share_file" => (
            "与隔离模型工具共享项目文件（可重复）",
            "隔離されたモデルツールとプロジェクトファイルを共有（繰り返し可）",
        ),
        "passthrough" => ("关闭 slim 委托", "slim委譲を無効化"),
        "dry_run" => ("只显示将要执行的操作", "実行せずに内容を表示"),
        "slim" => ("强制 slim 委托", "slim委譲を強制"),
        "no_slim" => ("关闭 slim 委托", "slim委譲を無効化"),
        "patch" => (
            "应用配置叠加层（可重复）",
            "設定オーバーレイを適用（繰り返し可）",
        ),
        "profile" => ("要使用的配置文件", "使用するプロファイル"),
        "language" => (
            "rdsh 自身的显示语言：en、zh-CN 或 ja",
            "rdsh自身の表示言語: en、zh-CN、ja",
        ),
        "preview" => ("显示预览字符数", "プレビューする文字数"),
        "extra" | "args" => ("传递给 dsh 的应用参数", "dshへ渡すアプリ引数"),
        "from_default_profile" => ("默认配置文件的来源", "既定プロファイルの由来"),
        "native" => ("在 rdsh 中输出原生配置", "rdshでネイティブ設定を出力"),
        "files" => ("要估算的文件", "推定するファイル"),
        "file" => ("要处理的文件", "処理するファイル"),
        "pattern" => ("要搜索的文本", "検索するテキスト"),
        "query" => ("搜索查询", "検索クエリ"),
        "max_tokens" => ("令牌预算", "トークン予算"),
        "dir" => ("搜索根目录", "検索ルート"),
        "max" => ("最大命中数", "最大ヒット数"),
        "limit" => ("结果上限", "結果上限"),
        "json" => ("输出机器可读 JSON", "機械可読JSONを出力"),
        "project" => ("按项目筛选", "プロジェクトで絞り込む"),
        "tokens" => ("估算会话令牌数", "セッショントークン数を推定"),
        "tail" => ("显示末尾行数", "末尾から表示する行数"),
        "grep" => ("仅显示匹配文本的行", "一致するテキストの行だけを表示"),
        "port" => ("本地监听端口", "ローカル待受ポート"),
        "import" => ("导入选定凭据", "選択した認証情報をインポート"),
        "provider" => ("提供方标识", "プロバイダーID"),
        "source" => ("凭据来源", "認証情報のソース"),
        "key_ref" => ("凭据引用名称", "認証情報参照名"),
        "open" => ("打开设置目录", "設定ディレクトリを開く"),
        "preset" => (
            "提供方预设：hai、sarashina、local-openai",
            "プロバイダープリセット: hai、sarashina、local-openai",
        ),
        "model" => (
            "要声明的模型标识（可重复）",
            "宣言するモデルID（繰り返し可）",
        ),
        "from_opencode" => (
            "从 OpenCode 读取端点与模型",
            "OpenCodeからエンドポイントとモデルを読み取る",
        ),
        "discover" => (
            "通过 GET /models 获取模型标识",
            "GET /models からモデルIDを取得",
        ),
        "base_url" => ("提供方 API 基础 URL", "プロバイダーAPIのベースURL"),
        "name" => ("local-openai 的显示名称", "local-openai の表示名"),
        "key_stdin" => (
            "从标准输入读取一行 API 密钥并保存为引用",
            "標準入力からAPIキーを1行読み取り参照として保存",
        ),
        "no_key" => (
            "无需密钥的 local-openai 服务",
            "キー不要のlocal-openaiサーバー",
        ),
        "replace" => ("重写现有路由区块", "既存の経路ブロックを置き換え"),
        "select" => (
            "允许将来导入 SOURCE:CREDENTIAL（可重复）",
            "SOURCE:CREDENTIAL の今後のインポートを許可（繰り返し可）",
        ),
        "unselect" => (
            "停止将来导入，保留已保存的凭据副本",
            "今後のインポートを停止（保存済み認証情報のコピーは保持）",
        ),
        "input_file" => ("请求 JSON 文件", "要求JSONファイル"),
        "upstream" => ("上游 HTTP(S) 基础 URL", "上流HTTP(S)ベースURL"),
        "host" => ("代理监听地址", "プロキシの待ち受けアドレス"),
        "allow_remote" => ("允许非环回地址监听", "ループバック以外での待ち受けを許可"),
        "queue_timeout" => (
            "排队超时（秒，正有限数）",
            "待機タイムアウト（秒・正の有限数）",
        ),
        "max_queue" => ("队列容量", "待機キューの容量"),
        "tool_choice_default" => (
            "默认工具选择：none、auto、required",
            "既定のツール選択: none、auto、required",
        ),
        "max_body_bytes" => ("请求正文大小上限（字节）", "要求本文の最大バイト数"),
        "rpm" => ("每分钟请求数上限", "1分あたりの要求数の上限"),

        "login" => ("启动提供方登录", "プロバイダーのログインを起動"),
        "yes" => (
            "非交互运行；不自动授权保存密钥",
            "非対話で実行（キー保存を自動で許可しません）",
        ),
        "web" => (
            "在本机浏览器中打开设置页面",
            "ローカルブラウザーで設定ページを開く",
        ),
        "n" => ("迭代次数", "反復回数"),
        "action" | "command" => ("要执行的子命令", "実行するサブコマンド"),
        "once" => ("处理一行请求后退出", "1行のリクエストを処理して終了"),
        "deny" => ("要拒绝的匹配模式", "拒否する一致パターン"),
        "policy_file" => ("结构化 hook 策略文件", "構造化hookポリシーファイル"),
        "reason" => ("拒绝原因", "拒否理由"),
        "budget" => ("令牌预算", "トークン予算"),
        "force" => ("覆盖现有设置", "既存設定を上書き"),
        "key" => ("设置键", "設定キー"),
        "value" => ("设置值", "設定値"),
        "id" => ("标识（提供方路由或功能）", "ID（プロバイダー経路・機能）"),
        "plugins_dir" => (
            "插件所在的 rustdsh 目录",
            "プラグインを含むrustdshディレクトリ",
        ),
        "compute" => ("同时安装 rdsh-compute", "rdsh-compute もインストール"),
        "package" => (
            "要添加的软件包规范（可重复）",
            "追加するパッケージ指定（繰り返し可）",
        ),
        "no_bundled" => ("不安装捆绑插件", "同梱プラグインをインストールしない"),
        "require" => (
            "必须启用的插件（可重复）",
            "有効化が必要なプラグイン（繰り返し可）",
        ),
        "help" => ("显示帮助", "ヘルプを表示"),
        "version" => ("显示版本", "バージョンを表示"),
        "subcommand" => ("要显示帮助的子命令", "ヘルプを表示するサブコマンド"),
        _ => return None,
    };
    Some(match locale {
        locale::Locale::Chinese => chinese,
        locale::Locale::Japanese => japanese,
        locale::Locale::English => unreachable!(),
    })
}

// Default profile order: RDSH_DEFAULT_PROFILE, then a local tui profile,
// else a guided error (dsh 0.2.0 ships acp, web, headless, sdk and
// sdk-minimal templates, but no tui template, so a bare default of tui
// would fail on fresh environments).
fn pick_default_profile(env: Option<&str>, local_tui: bool) -> Result<String, String> {
    if let Some(name) = env.map(str::trim).filter(|s| !s.is_empty()) {
        return Ok(name.to_string());
    }
    if local_tui {
        return Ok("tui".to_string());
    }
    Err("no profile specified and no local \u{2018}tui\u{2019} profile found (dsh 0.2.0 ships acp, web, headless, sdk and sdk-minimal templates, but no tui template). Boot with --profile <name> (e.g. --profile web) or set RDSH_DEFAULT_PROFILE=<name>".to_string())
}

fn profile_or_default(
    opt: Option<String>,
    configured_default: &str,
    locale: locale::Locale,
) -> anyhow::Result<String> {
    match opt {
        Some(p) => Ok(p),
        None => resolve_default_profile(configured_default, locale),
    }
}

fn resolve_default_profile(
    configured_default: &str,
    locale: locale::Locale,
) -> anyhow::Result<String> {
    let env = std::env::var("RDSH_DEFAULT_PROFILE").ok();
    if env.as_deref().is_none_or(|e| e.trim().is_empty()) && !configured_default.trim().is_empty() {
        return Ok(configured_default.trim().to_string());
    }
    let home = crate::inspect::dsh_home();
    let local_tui = std::path::Path::new(&format!("{home}/profiles/tui")).is_dir();
    pick_default_profile(env.as_deref(), local_tui).map_err(|m| {
        anyhow::anyhow!(match locale {
            locale::Locale::English => m,
            locale::Locale::Chinese => "未指定配置文件且未找到本地 ‘tui’ 配置文件（dsh 0.2.0 提供 acp、web、headless、sdk 和 sdk-minimal 模板，但不提供 tui 模板）。请使用 --profile <name> 启动（例如 --profile web），或设置 RDSH_DEFAULT_PROFILE=<name>".to_string(),
            locale::Locale::Japanese => "プロファイルが指定されず、ローカルの ‘tui’ プロファイルも見つかりません（dsh 0.2.0 には acp、web、headless、sdk、sdk-minimal テンプレートがありますが tui テンプレートはありません）。--profile <name>（例: --profile web）で起動するか、RDSH_DEFAULT_PROFILE=<name> を設定してください".to_string(),
        })
    })
}

/// True when `dotted` (e.g. `search.max`) is explicitly present (non-null)
/// in the raw rdsh.json text. Used by `settings show` to label each
/// effective value `config` vs `default`.
fn settings_key_in_file(raw: &serde_json::Value, dotted: &str) -> bool {
    let mut node = raw;
    for part in dotted.split('.') {
        match node.get(part) {
            Some(next) if !next.is_null() => node = next,
            _ => return false,
        }
    }
    true
}

fn dump_config_native(
    profile: &str,
    patches: &[String],
    locale: locale::Locale,
) -> anyhow::Result<()> {
    let home = crate::inspect::dsh_home();
    println!("{}", native_dump_config_json(profile, &home, patches));
    let root = format!("{home}/profiles/{profile}");
    match std::fs::read_dir(&root) {
        Ok(entries) => {
            println!(
                "# {} {root}:",
                match locale {
                    locale::Locale::English => "layers under",
                    locale::Locale::Chinese => "以下层级",
                    locale::Locale::Japanese => "次の配下のレイヤー",
                }
            );
            let mut names: Vec<String> = entries
                .filter_map(Result::ok)
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .collect();
            names.sort();
            for n in names.iter().take(50) {
                println!("  - {n}");
            }
        }
        Err(_) => {
            println!(
                "# {} {root} ({})",
                match locale {
                    locale::Locale::English => "no local profile dir at",
                    locale::Locale::Chinese => "没有本地配置文件目录：",
                    locale::Locale::Japanese => "ローカルプロファイルディレクトリがありません:",
                },
                match locale {
                    locale::Locale::English => "shipped template will be used by dsh",
                    locale::Locale::Chinese => "dsh 将使用随附模板",
                    locale::Locale::Japanese => "dsh は同梱テンプレートを使用します",
                }
            )
        }
    }
    Ok(())
}

fn native_dump_config_json(profile: &str, home: &str, patches: &[String]) -> String {
    serde_json::json!({
        "profile": profile,
        "dsh_home": home,
        "patches": patches,
    })
    .to_string()
}

/// Delegated agent tools: normal file access by default. The strict boundary
/// applies when the setting is explicit, when `--share-file` is used, or when
/// `RDSH_SECURITY=1` forces it.
fn agent_tool_sandbox(cfg: &rdsh_config::RdshSettings, share_files_requested: bool) -> bool {
    if rdsh_config::feature_is_explicit(cfg, "agent_tool_sandbox") {
        return rdsh_config::feature_enabled(cfg, "agent_tool_sandbox");
    }
    share_files_requested
}

/// `rdsh features`: every optional capability with its effective state.
fn features_list(
    cfg: &rdsh_config::RdshSettings,
    json: bool,
    locale: locale::Locale,
) -> anyhow::Result<()> {
    use std::io::Write;
    // `let _` on purpose: piping to `head` closes early (EPIPE) and must not
    // abort the listing with a panic.
    let stdout = std::io::stdout();
    let mut out = stdout.lock();
    if json {
        let payload = serde_json::json!({
            "config": rdsh_config::settings_path(),
            "features": rdsh_config::RdshSettings::feature_state(cfg),
        });
        let _ = writeln!(out, "{}", serde_json::to_string_pretty(&payload)?);
        return Ok(());
    }
    let _ = writeln!(
        out,
        "{}: {}",
        match locale {
            locale::Locale::English => "config",
            locale::Locale::Chinese => "配置",
            locale::Locale::Japanese => "設定",
        },
        rdsh_config::settings_path()
    );
    let _ = writeln!(
        out,
        "{:<24} {:<5} {:<7} {}",
        match locale {
            locale::Locale::English => "feature",
            locale::Locale::Chinese => "功能",
            locale::Locale::Japanese => "機能",
        },
        match locale {
            locale::Locale::English => "state",
            locale::Locale::Chinese => "状态",
            locale::Locale::Japanese => "状態",
        },
        match locale {
            locale::Locale::English => "default",
            locale::Locale::Chinese => "默认",
            locale::Locale::Japanese => "既定",
        },
        match locale {
            locale::Locale::English => "what it does",
            locale::Locale::Chinese => "说明",
            locale::Locale::Japanese => "説明",
        }
    );
    for def in rdsh_config::FEATURES {
        let _ = writeln!(
            out,
            "{:<24} {:<5} {:<7} {}",
            def.id,
            if rdsh_config::feature_enabled(cfg, def.id) {
                match locale {
                    locale::Locale::English => "on",
                    locale::Locale::Chinese => "开启",
                    locale::Locale::Japanese => "オン",
                }
            } else {
                match locale {
                    locale::Locale::English => "off",
                    locale::Locale::Chinese => "关闭",
                    locale::Locale::Japanese => "オフ",
                }
            },
            if def.default {
                match locale {
                    locale::Locale::English => "on",
                    locale::Locale::Chinese => "开启",
                    locale::Locale::Japanese => "オン",
                }
            } else {
                match locale {
                    locale::Locale::English => "off",
                    locale::Locale::Chinese => "关闭",
                    locale::Locale::Japanese => "オフ",
                }
            },
            feature_summary(locale, def)
        );
    }
    let _ = writeln!(
        out,
        "{}",
        match locale {
            locale::Locale::English => "change one: rdsh features on <id> | rdsh features off <id> | rdsh settings set features.<id> true|false",
            locale::Locale::Chinese => "修改一项：rdsh features on <id> | rdsh features off <id> | rdsh settings set features.<id> true|false",
            locale::Locale::Japanese => "変更: rdsh features on <id> | rdsh features off <id> | rdsh settings set features.<id> true|false",
        }
    );
    Ok(())
}

fn feature_summary(locale: locale::Locale, def: &rdsh_config::FeatureDef) -> &'static str {
    if locale == locale::Locale::English {
        return def.summary;
    }
    let (chinese, japanese) = match def.id {
        "discord" => ("Discord Rich Presence（需要运行 DSH Web 服务）", "Discord Rich Presence（DSH Web サービスの起動が必要）"),
        "update_check" => ("检查 rustdsh 更新并显示更新横幅", "rustdsh の更新を確認して更新バナーを表示"),
        "update_notifications" => ("发现更新时发送通知", "更新が見つかったときに通知する"),
        "sound" => ("允许安装 DSH 声音通知（installer SOUND=1）", "DSH サウンド通知の導入を許可（installer SOUND=1）"),
        "serve" => ("本地只读仪表板（rdsh serve）", "ローカル読み取り専用ダッシュボード（rdsh serve）"),
        "search-web" => ("SearXNG Web 搜索（rdsh search-web）", "SearXNG Web 検索（rdsh search-web）"),
        "context_engine" => ("实验性的每轮上下文引擎（rdsh context）", "実験的なターン単位コンテキストエンジン（rdsh context）"),
        "compute" => ("允许常驻计算桥（RDSH_COMPUTE=1）", "常駐コンピュートブリッジを許可（RDSH_COMPUTE=1）"),
        "budget_guard" => ("DSH 插件中的预算保护 hook", "DSH プラグイン内の予算ガードフック"),
        "agent_tool_sandbox" => ("将委派的代理工具限制为 --share-file 文件（无网络、无主机写入）", "委譲したエージェントツールを --share-file のファイルに制限（ネットワーク・ホスト書き込みなし）"),
        "release_probe" => ("在设置环境时运行发布资格检查", "環境設定時にリリース適格性プローブを実行"),
        "setup_web" => ("rdsh setup --web 本地设置页面", "rdsh setup --web ローカル設定ページ"),
        "sessions_token_cache" => ("缓存解压后会话的令牌数", "展開済みセッションのトークン数をキャッシュ"),
        "node_compile_cache" => ("委派运行的 Node 编译缓存（Node >= 22.1）", "委譲実行用の Node コンパイルキャッシュ（Node >= 22.1）"),
        _ => return def.summary,
    };
    match locale {
        locale::Locale::Chinese => chinese,
        locale::Locale::Japanese => japanese,
        locale::Locale::English => unreachable!(),
    }
}

/// `rdsh features on|off <id>`: writes features.<id> through the shared lock.
fn features_toggle(id: &str, on: bool, locale: locale::Locale) -> anyhow::Result<()> {
    let id = id.trim();
    let def = rdsh_config::feature_def(id).ok_or_else(|| {
        anyhow::anyhow!(
            "{}: {id} ({})",
            match locale {
                locale::Locale::English => "unknown feature id",
                locale::Locale::Chinese => "未知功能 ID",
                locale::Locale::Japanese => "不明な機能 ID",
            },
            match locale {
                locale::Locale::English => "try: rdsh features",
                locale::Locale::Chinese => "请尝试: rdsh features",
                locale::Locale::Japanese => "rdsh features を実行してください",
            }
        )
    })?;
    rdsh_config::update(locale, |cfg| {
        cfg.set_dotted_with_locale(
            &format!("features.{id}"),
            if on { "true" } else { "false" },
            locale,
        )
    })?;
    println!(
        "features.{id} = {} ({})",
        if on { "true" } else { "false" },
        def.summary
    );
    Ok(())
}

/// Server-type extras are off by default: refuse with enable guidance.
/// Setup is not an extra: `features.setup_web` (default on) gates it instead.
fn extra_disabled(id: &str, locale: locale::Locale) -> anyhow::Result<()> {
    let text = match locale {
        locale::Locale::English => format!("extra '{id}' is disabled by default; enable with: rdsh features on {id} (or rdsh settings set extras.enable {id})"),
        locale::Locale::Chinese => format!("附加功能 '{id}' 默认关闭；请使用以下命令启用：rdsh features on {id}（或 rdsh settings set extras.enable {id}）"),
        locale::Locale::Japanese => format!("追加機能 '{id}' は既定で無効です。有効化: rdsh features on {id}（または rdsh settings set extras.enable {id}）"),
    };
    Err(anyhow::Error::msg(text))
}

fn doctor(locale: locale::Locale) -> anyhow::Result<()> {
    use std::io::Write;
    let stdout = std::io::stdout();
    let mut out = stdout.lock();
    // `let _` on purpose: piping to `grep -q` / `head` closes early (EPIPE),
    // which must not abort doctor with a panic.
    let mut say = |s: String| {
        let _ = writeln!(out, "{s}");
    };
    let text = |english: &'static str, chinese: &'static str, japanese: &'static str| match locale {
        locale::Locale::English => english,
        locale::Locale::Chinese => chinese,
        locale::Locale::Japanese => japanese,
    };
    let orig = passthrough::find_original_dsh();
    say(format!(
        "[rdsh] {}: {}",
        match locale {
            locale::Locale::English => "original dsh",
            locale::Locale::Chinese => "原始 dsh",
            locale::Locale::Japanese => "元の dsh",
        },
        orig.as_deref().unwrap_or("<not found in PATH>")
    ));
    let home = crate::inspect::dsh_home();
    say(format!("[rdsh] DSH_HOME: {home}"));
    match std::fs::read_dir(format!("{home}/profiles")) {
        Ok(d) => say(format!(
            "[rdsh] {}: {} {}",
            text("profiles", "配置文件", "プロファイル"),
            d.count(),
            text(
                "local profile(s)",
                "个本地配置文件",
                "件のローカルプロファイル"
            )
        )),
        Err(e) => say(format!(
            "[rdsh] {}: ({}: {e})",
            text("profiles", "配置文件", "プロファイル"),
            text("unreadable", "无法读取", "読み取れません")
        )),
    }
    // Desktop (Electron) shares $DSH_HOME but keeps its own reserved profile;
    // report both so a missing plugin attachment is visible in doctor.
    let desktop_env = desktop::OsEnv::from_process();
    let desktop_app = desktop::find_app(&desktop_env);
    let desktop_profile = desktop::read_profile(&desktop_env.profile_dir());
    say(format!(
        "[rdsh] {}: {} {} | {} {}",
        text("desktop", "桌面", "デスクトップ"),
        text("app", "应用", "アプリ"),
        desktop_app
            .as_deref()
            .map(|p| p.display().to_string())
            .unwrap_or_else(|| format!("<{}>", text("not found", "未找到", "見つかりません"))),
        text("profile", "配置文件", "プロファイル"),
        if desktop_profile.initialized {
            text("initialized", "已初始化", "初期化済み")
        } else {
            text("not initialized", "未初始化", "未初期化")
        }
    ));
    if desktop_profile.initialized {
        let enabled: Vec<&str> = desktop::BUNDLED_PLUGINS
            .iter()
            .copied()
            .filter(|name| desktop_profile.enabled(name))
            .collect();
        say(format!(
            "[rdsh] {} {}: {}",
            text("desktop", "桌面", "デスクトップ"),
            text("plugins", "插件", "プラグイン"),
            if enabled.is_empty() {
                text(
                    "none enabled (run: rdsh desktop install --plugins-dir <checkout>)",
                    "没有已启用项（运行：rdsh desktop install --plugins-dir <checkout>）",
                    "有効なものはありません（rdsh desktop install --plugins-dir <checkout> を実行）",
                )
                .to_string()
            } else {
                enabled.join(", ")
            }
        ));
    }
    say(format!(
        "[rdsh] {}: {}",
        text("slim env", "精简环境", "slim 環境"),
        slim::describe()
    ));
    say(format!(
        "[rdsh] {}: {}",
        text("auth", "认证", "認証"),
        auth::summary_line(locale)
    ));
    if let Some(v) = original_version(orig.as_deref().unwrap_or_default()) {
        say(format!(
            "[rdsh] dsh {}: {v}",
            text("version", "版本", "バージョン")
        ));
    }
    say(format!(
        "[rdsh] smart-dsh: {}",
        smart_dsh_status(&home, locale)
    ));
    let shadowed = shadowing_original();
    if shadowed {
        say(format!(
            "[rdsh] {}: {}",
            text("note", "提示", "注記"),
            text(
                "'dsh' currently resolves to rdsh; Smart-DSH scripts that locate",
                "'dsh' 当前解析为 rdsh；查找 DSH 的 Smart-DSH 脚本",
                "'dsh' は現在 rdsh に解決されます。DSH を探す Smart-DSH スクリプトは"
            )
        ));
        say(format!("[rdsh] {}: {}", text("note", "提示", "注記"), text("DSH via PATH need the original: use `dsh-orig` or set DSH_PACKAGE_DIR", "若要通过 PATH 使用 DSH，需要原始版本：请使用 `dsh-orig` 或设置 DSH_PACKAGE_DIR", "PATH 経由で DSH を使うには元の実行ファイルが必要です。`dsh-orig` を使うか DSH_PACKAGE_DIR を設定してください")));
    }
    for w in shadow_warnings(shadowed, orig.as_deref(), locale) {
        say(w);
    }
    for w in wrapper_warnings(shadowed, locale) {
        say(w);
    }
    say(format!(
        "[rdsh] {}: {}",
        text("note", "提示", "注記"),
        text(
            "dsh web GUI defaults to 3080; `rdsh serve` defaults to 38080",
            "dsh Web GUI 默认使用 3080；`rdsh serve` 默认使用 38080",
            "dsh Web GUI の既定は 3080、`rdsh serve` の既定は 38080 です"
        )
    ));
    say(format!(
        "[rdsh] {}: {}",
        text("note", "提示", "注記"),
        text(
            "enable the serve extra first; `rdsh serve --port 0` picks a free port",
            "请先启用 serve 附加功能；`rdsh serve --port 0` 会选择空闲端口",
            "先に serve 追加機能を有効にしてください。`rdsh serve --port 0` は空きポートを選びます"
        )
    ));
    if orig.is_none() {
        anyhow::bail!(match locale {
            locale::Locale::English => {
                "original 'dsh' not found; set DSH_ORIG_BIN or install @deepseek-ai/dsh"
            }
            locale::Locale::Chinese => {
                "未找到原始 'dsh'；请设置 DSH_ORIG_BIN 或安装 @deepseek-ai/dsh"
            }
            locale::Locale::Japanese => {
                "元の 'dsh' が見つかりません。DSH_ORIG_BIN を設定するか @deepseek-ai/dsh をインストールしてください"
            }
        });
    }
    Ok(())
}

/// Best-effort `dsh --version` readout for doctor (never fails the command).
fn original_version(orig: &str) -> Option<String> {
    if orig.is_empty() {
        return None;
    }
    let out = if orig.ends_with(".js") {
        std::process::Command::new("node")
            .arg(orig)
            .arg("--version")
            .output()
            .ok()?
    } else {
        std::process::Command::new(orig)
            .arg("--version")
            .output()
            .ok()?
    };
    if !out.status.success() {
        return None;
    }
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .next()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Smart-DSH (https://github.com/hikarioyama/Smart-DSH) is a DSH web-profile
/// plugin bundle, not a competing binary: report which of its bundles the web
/// profile currently wires in (read-only package.json scan).
fn smart_dsh_status(home: &str, locale: locale::Locale) -> String {
    const KNOWN: &[&str] = &["dsh-notify-push", "dsh-esc-stop", "dsh-btw", "dsh-tasks"];
    let pkg = format!("{home}/profiles/web/package.json");
    let text = std::fs::read_to_string(&pkg).unwrap_or_default();
    if text.is_empty() {
        return match locale {
            locale::Locale::English => "(not installed: no web profile package.json)",
            locale::Locale::Chinese => "（未安装：没有 Web 配置文件 package.json）",
            locale::Locale::Japanese => "（未導入: Web プロファイルの package.json がありません）",
        }
        .to_string();
    }
    let found: Vec<&str> = KNOWN.iter().copied().filter(|b| text.contains(b)).collect();
    if found.is_empty() {
        match locale {
            locale::Locale::English => "(not installed in web profile)",
            locale::Locale::Chinese => "（未安装在 Web 配置文件中）",
            locale::Locale::Japanese => "（Web プロファイルに導入されていません）",
        }
        .to_string()
    } else {
        format!(
            "{}: {}",
            match locale {
                locale::Locale::English => "bundles in web profile",
                locale::Locale::Chinese => "Web 配置文件中的捆绑包",
                locale::Locale::Japanese => "Web プロファイルのバンドル",
            },
            found.join(", ")
        )
    }
}

/// Text wrappers and dangling links kept from one bounded pass over the local
/// bin dir, shared by the wrapper checks so `doctor` never reads it twice.
struct WrapperScan {
    texts: Vec<(String, String)>,
    broken_links: Vec<(String, String)>,
    non_executable: Vec<String>,
}

/// Bounds for the wrapper-dir pass and the PATH probes below: `doctor` is a
/// diagnostic and must stay fast even when the bin dir is unusual.
const WRAPPER_DIR_MAX_ENTRIES: usize = 256;
const WRAPPER_TEXT_MAX_BYTES: u64 = 65536;
const WRAPPER_TEXT_MAX_FILES: usize = 64;
const WRAPPER_WARN_MAX: usize = 10;
const PATH_SCAN_MAX_DIRS: usize = 64;

/// Wrapper dir used by the installers: ~/.local/bin on Unix and
/// %LOCALAPPDATA%\rdsh\bin on Windows. PATH is not scanned: a checkout
/// target dir or /usr/bin would only add noise.
#[cfg(not(windows))]
fn local_bin_dir() -> Option<std::path::PathBuf> {
    let home = crate::inspect::home_dir()?;
    Some(std::path::Path::new(&home).join(".local").join("bin"))
}

#[cfg(windows)]
fn local_bin_dir() -> Option<std::path::PathBuf> {
    std::env::var_os("LOCALAPPDATA")
        .map(std::path::PathBuf::from)
        .map(|path| path.join("rdsh").join("bin"))
}

/// One bounded pass over the wrapper dir. Size-gate before reading: the dir can
/// hold huge binaries and reading them fully just to discard costs seconds in
/// doctor.
fn scan_local_wrappers(dir: &std::path::Path) -> WrapperScan {
    let mut scan = WrapperScan {
        texts: Vec::new(),
        broken_links: Vec::new(),
        non_executable: Vec::new(),
    };
    let Ok(entries) = std::fs::read_dir(dir) else {
        return scan;
    };
    for entry in entries.flatten().take(WRAPPER_DIR_MAX_ENTRIES) {
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        let path = entry.path();
        // Symlink first: a dangling link looks absent to metadata()/is_file().
        if std::fs::symlink_metadata(&path).is_ok_and(|m| m.file_type().is_symlink())
            && std::fs::metadata(&path).is_err()
        {
            let target = std::fs::read_link(&path)
                .map(|p| p.display().to_string())
                .unwrap_or_else(|_| "<unreadable>".to_string());
            scan.broken_links.push((name, target));
            continue;
        }
        if scan.texts.len() >= WRAPPER_TEXT_MAX_FILES || !path.is_file() {
            continue;
        }
        if std::fs::metadata(&path).is_ok_and(|m| m.len() > WRAPPER_TEXT_MAX_BYTES) {
            continue;
        }
        let bytes = std::fs::read(&path).unwrap_or_default();
        if bytes.len() as u64 > WRAPPER_TEXT_MAX_BYTES || bytes.contains(&0) {
            continue;
        }
        let text = String::from_utf8_lossy(&bytes).into_owned();
        #[cfg(unix)]
        if name.contains("dsh")
            && (text.starts_with("#!") || text.contains("exec "))
            && !is_executable_file(&path)
        {
            scan.non_executable.push(name.clone());
        }
        scan.texts.push((name, text));
    }
    scan
}

/// Wrappers that run `node` on the `dsh` path break once `dsh` is shadowed by
/// the native binary (Node tries to parse the ELF as JS). Point at the
/// offending wrappers found by the shared scan. `skip` names the files the
/// broken-wrapper check already reported, so one file never yields two lines.
fn node_wrapper_warnings(
    scan: &WrapperScan,
    dir: &std::path::Path,
    shadowed: bool,
    skip: &[&str],
    locale: locale::Locale,
) -> Vec<String> {
    let mut hits: Vec<String> = scan
        .texts
        .iter()
        .filter(|(name, text)| {
            let tokens = text.lines().filter_map(shell_words);
            let mut has_node = false;
            let mut has_dsh = false;
            for line in tokens {
                for token in line {
                    let base = token.rsplit(['/', '\\']).next().unwrap_or_default();
                    has_node |= base == "node" || base == "node.exe";
                    has_dsh |= token.contains("dsh");
                }
            }
            has_node && has_dsh && !skip.contains(&name.as_str())
        })
        .map(|(name, _)| name.clone())
        .collect();
    hits.sort();
    hits.truncate(WRAPPER_WARN_MAX);
    hits.into_iter()
        .map(|name| {
            let wrapper = dir.join(&name).display().to_string();
            if shadowed {
                localized_format!(locale, "[rdsh] warn: {wrapper} calls `node` on a dsh path; while `dsh` is shadowed that path is a native binary — exec `dsh`/`rdsh` directly instead of via `node`", "[rdsh] 警告：{wrapper} 通过 `node` 调用 dsh 路径；当前 dsh 被遮蔽，该路径是原生程序。请直接执行 `dsh`/`rdsh`", "[rdsh] 警告: {wrapper} は dsh パスを `node` で呼び出します。現在はネイティブバイナリなので `dsh`/`rdsh` を直接実行してください")
            } else {
                localized_format!(locale, "[rdsh] note: {wrapper} calls `node` on a dsh path; it will break if `dsh` is later shadowed — exec `dsh`/`rdsh` directly instead of via `node`", "[rdsh] 提示：{wrapper} 通过 `node` 调用 dsh 路径；以后遮蔽 dsh 会失败。请直接执行 `dsh`/`rdsh`", "[rdsh] 注記: {wrapper} は dsh パスを `node` で呼び出します。後で dsh が隠蔽されると失敗するため `dsh`/`rdsh` を直接実行してください")
            }
        })
        .collect()
}

/// Split the simple shell-like syntax used by wrapper lines while preserving
/// quoted paths. An unmatched quote is unknown and is left undiagnosed.
fn shell_words(line: &str) -> Option<Vec<String>> {
    #[derive(Clone, Copy)]
    enum Quote {
        Single,
        Double,
    }

    let mut words = Vec::new();
    let mut word = String::new();
    let mut quote = None;
    let mut escaped = false;
    let mut active = false;
    for character in line.chars() {
        if escaped {
            word.push(character);
            active = true;
            escaped = false;
            continue;
        }
        match quote {
            Some(Quote::Single) if character == char::from(39) => quote = None,
            Some(Quote::Single) => word.push(character),
            Some(Quote::Double) if character == '"' => quote = None,
            Some(Quote::Double) if character == char::from(92) => escaped = true,
            Some(Quote::Double) => word.push(character),
            None if character == '#' && !active => break,
            None if character == char::from(92) => {
                escaped = true;
                active = true;
            }
            None if character == char::from(39) => {
                quote = Some(Quote::Single);
                active = true;
            }
            None if character == '"' => {
                quote = Some(Quote::Double);
                active = true;
            }
            None if character.is_whitespace()
                || matches!(
                    character,
                    ';' | '|' | '&' | '(' | ')' | '{' | '}' | '<' | '>'
                ) =>
            {
                if active {
                    words.push(std::mem::take(&mut word));
                    active = false;
                }
            }
            None => {
                word.push(character);
                active = true;
            }
        }
    }
    if escaped || quote.is_some() {
        return None;
    }
    if active {
        words.push(word);
    }
    Some(words)
}

fn env_assignment(token: &str) -> bool {
    let Some((name, _)) = token.split_once('=') else {
        return false;
    };
    let mut characters = name.chars();
    characters
        .next()
        .is_some_and(|first| first == '_' || first.is_ascii_alphabetic())
        && characters.all(|character| character == '_' || character.is_ascii_alphanumeric())
}

/// Interpreter a shebang needs at run time. env's split-string mode supports
/// options and assignments before the command; unsupported forms are unknown,
/// so doctor leaves them alone instead of reporting a false missing program.
fn shebang_interpreter(line: &str) -> Option<String> {
    let content = line.trim_start().strip_prefix("#!")?;
    let tokens = shell_words(content)?;
    let program = tokens.first()?;
    if program != "env" && !program.ends_with("/env") {
        return Some(program.clone());
    }
    let arguments = &tokens[1..];
    let split = matches!(
        arguments.first().map(String::as_str),
        Some("-S" | "--split-string")
    );
    if !split {
        let command = arguments.first()?;
        return (!command.starts_with('-') && !env_assignment(command)).then(|| command.clone());
    }

    let mut index = 1;
    while let Some(argument) = arguments.get(index) {
        match argument.as_str() {
            "--" => {
                index += 1;
                break;
            }
            "-i" | "--ignore-environment" => index += 1,
            "-u" | "--unset" | "-C" | "--chdir" => {
                arguments.get(index + 1)?;
                index += 2;
            }
            value if value.starts_with("--unset=") || value.starts_with("--chdir=") => index += 1,
            value if value.starts_with('-') => return None,
            value if env_assignment(value) => index += 1,
            value => return Some(value.to_string()),
        }
    }
    arguments
        .get(index)
        .cloned()
        .filter(|value| !value.starts_with('-'))
}

/// Absolute node/dsh/rdsh paths a wrapper passes around, e.g.
/// exec /opt/node/bin/node /opt/dsh/lib/bin.js. Only program-shaped tokens
/// count and comments are skipped, so unrelated absolute paths (PATH=...,
/// log files, notes about old locations) stay quiet.
fn referenced_binary_paths(text: &str) -> Vec<String> {
    const PROGRAMS: &[&str] = &[
        "node",
        "node.exe",
        "dsh",
        "dsh.exe",
        "rdsh",
        "rdsh.exe",
        "dsh-orig",
        "dsh-orig.exe",
        "dsh.orig",
        "dsh.real",
    ];
    let mut out: Vec<String> = Vec::new();
    for line in text.lines() {
        let Some(tokens) = shell_words(line) else {
            continue;
        };
        for token in tokens {
            // Unix absolute paths only: Windows path syntax is never parsed from
            // wrapper text (the executability probe covers native installs).
            if !token.starts_with('/') {
                continue;
            }
            let base = token.rsplit('/').next().unwrap_or_default();
            let program_like = PROGRAMS.contains(&base)
                || (base.ends_with(".js") && token.split('/').any(|part| part == "dsh"));
            if program_like && !out.iter().any(|seen| seen == &token) {
                out.push(token);
            }
            if out.len() >= 8 {
                return out;
            }
        }
    }
    out
}

/// Read-only executable probe matching passthrough's is_executable_candidate:
/// mode bits owned by another permission class must not count.
fn is_executable_file(path: &std::path::Path) -> bool {
    let Ok(metadata) = std::fs::metadata(path) else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::ffi::CString;
        use std::os::unix::ffi::OsStrExt;
        let Ok(c_path) = CString::new(path.as_os_str().as_bytes()) else {
            return false;
        };
        // SAFETY: c_path is NUL-terminated and AT_FDCWD keeps this read-only.
        unsafe {
            libc::faccessat(
                libc::AT_FDCWD,
                c_path.as_ptr(),
                libc::X_OK,
                libc::AT_EACCESS,
            ) == 0
        }
    }
    #[cfg(not(unix))]
    {
        true
    }
}

/// A .js entrypoint only has to exist (Node runs it); anything else must be
/// executable. Mirrors passthrough's runnable-original rule.
fn usable_original(path: &std::path::Path) -> bool {
    if path.extension().is_some_and(|ext| ext == "js") {
        path.is_file()
    } else {
        is_executable_file(path)
    }
}

/// First executable name on PATH, bounded by PATH_SCAN_MAX_DIRS. An absolute
/// name is checked directly, so a shebang like #!/bin/sh works too.
fn command_on_path(name: &str) -> Option<std::path::PathBuf> {
    let path_var = std::env::var_os("PATH")?;
    command_on_path_in(name, &path_var)
}

/// Resolve a command without running it. Match Command::new's PATH behavior
/// closely enough for diagnostics, including the Windows .exe convention.
fn command_on_path_in(name: &str, path_var: &std::ffi::OsStr) -> Option<std::path::PathBuf> {
    let path = std::path::Path::new(name);
    let has_separator = name.contains('/') || (cfg!(windows) && name.contains('\\'));
    if path.is_absolute() || has_separator {
        if is_executable_file(path) {
            return Some(path.to_path_buf());
        }
        #[cfg(windows)]
        if path.extension().is_none() {
            let with_exe = path.with_extension("exe");
            if is_executable_file(&with_exe) {
                return Some(with_exe);
            }
        }
        return None;
    }

    #[cfg(windows)]
    let executable_name = if path.extension().is_none() {
        format!("{name}.exe")
    } else {
        name.to_string()
    };
    #[cfg(not(windows))]
    let executable_name = name.to_string();

    let directories: Vec<std::path::PathBuf> = std::env::split_paths(path_var)
        .take(PATH_SCAN_MAX_DIRS)
        .collect();
    #[cfg(windows)]
    let directories = {
        let mut directories = directories;
        if let Ok(executable) = std::env::current_exe() {
            if let Some(parent) = executable.parent() {
                directories.push(parent.to_path_buf());
            }
        }
        if let Some(root) = std::env::var_os("SystemRoot").map(std::path::PathBuf::from) {
            directories.push(root.join("System32"));
            directories.push(root);
        }
        directories
    };
    directories
        .into_iter()
        .take(PATH_SCAN_MAX_DIRS)
        .map(|directory| directory.join(&executable_name))
        .find(|candidate| is_executable_file(candidate))
}

/// Why one wrapper in the local bin dir cannot run, if the scan can tell. Only
/// the first problem is reported: one line per file.
fn broken_wrapper_reason(
    dir: &std::path::Path,
    name: &str,
    text: &str,
    locale: locale::Locale,
) -> Option<String> {
    let wrapper = dir.join(name).display().to_string();
    if let Some(line) = text.lines().next().filter(|line| line.starts_with("#!")) {
        if let Some(interp) = shebang_interpreter(line) {
            if command_on_path(&interp).is_none() {
                return Some(localized_format!(locale, "[rdsh] warn: {wrapper} needs '{interp}' on PATH, which is missing; the wrapper cannot run", "[rdsh] 警告：{wrapper} 需要 PATH 中的 '{interp}'，但未找到；包装程序无法运行", "[rdsh] 警告: {wrapper} に必要な '{interp}' がPATHにありません。ラッパーを実行できません"
                ));
            }
        }
    }
    for p in referenced_binary_paths(text) {
        let path = std::path::Path::new(&p);
        if usable_original(path) {
            continue;
        }
        let why = if path.exists() {
            locale::diagnostic(locale, "is not executable")
        } else {
            locale::diagnostic(locale, "does not exist")
        };
        return Some(localized_format!(locale, "[rdsh] warn: {wrapper} references {p}, which {why}; fix the path or reinstall the wrapper", "[rdsh] 警告：{wrapper} 引用的 {p} {why}；请修正路径或重新安装包装程序", "[rdsh] 警告: {wrapper} の参照先 {p} は{why}。パスを修正するかラッパーを再インストールしてください"
        ));
    }
    None
}

/// Broken wrappers found by the shared scan: dangling dsh/rdsh symlinks, a
/// missing shebang interpreter, or an absolute node/dsh/rdsh path that is
/// gone. Advisory only, one line per file, returned as (name, warning) so the
/// node-on-dsh check can skip what is already reported.
fn broken_wrapper_warnings(
    scan: &WrapperScan,
    dir: &std::path::Path,
    locale: locale::Locale,
) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    for (name, target) in &scan.broken_links {
        if !name.contains("dsh") || out.len() >= WRAPPER_WARN_MAX {
            continue;
        }
        let wrapper = dir.join(name).display().to_string();
        out.push((
            name.clone(),
            localized_format!(
                locale,
                "[rdsh] warn: {wrapper} is a broken symlink -> {target}; recreate or remove it",
                "[rdsh] 警告：{wrapper} 是失效的符号链接 -> {target}；请重新创建或移除",
                "[rdsh] 警告: {wrapper} はリンク切れです -> {target}。再作成または削除してください"
            ),
        ));
    }
    for name in &scan.non_executable {
        if out.len() >= WRAPPER_WARN_MAX {
            break;
        }
        if name.contains("dsh") {
            let wrapper = dir.join(name).display().to_string();
            out.push((
                name.clone(),
                localized_format!(
                    locale,
                    "[rdsh] warn: {wrapper} is not executable; the wrapper cannot run",
                    "[rdsh] 警告：{wrapper} 不可执行；包装程序无法运行",
                    "[rdsh] 警告: {wrapper} に実行権限がありません。ラッパーを実行できません"
                ),
            ));
        }
    }
    for (name, text) in &scan.texts {
        if out.len() >= WRAPPER_WARN_MAX {
            break;
        }
        if scan.non_executable.contains(name) || !(name.contains("dsh") || text.contains("dsh")) {
            continue;
        }
        if let Some(warning) = broken_wrapper_reason(dir, name, text, locale) {
            out.push((name.clone(), warning));
        }
    }
    out
}

/// Every wrapper warning, from one bounded pass over the wrapper dir. A file
/// with a concrete broken path keeps that finding instead of the generic
/// node-on-dsh note.
fn wrapper_warnings(shadowed: bool, locale: locale::Locale) -> Vec<String> {
    let Some(dir) = local_bin_dir() else {
        return Vec::new();
    };
    let scan = scan_local_wrappers(&dir);
    let broken = broken_wrapper_warnings(&scan, &dir, locale);
    let broken_names: Vec<String> = broken.iter().map(|(name, _)| name.clone()).collect();
    let mut out: Vec<String> = broken.into_iter().map(|(_, warning)| warning).collect();
    let skip: Vec<&str> = broken_names.iter().map(String::as_str).collect();
    out.extend(node_wrapper_warnings(&scan, &dir, shadowed, &skip, locale));
    out
}

/// Shadowing and install-ledger diagnostics: warnings only, so doctor keeps
/// its exit status (only the missing original at the end is fatal).
fn shadow_warnings(shadowed: bool, orig: Option<&str>, locale: locale::Locale) -> Vec<String> {
    let mut out = duplicate_path_warnings(locale);
    out.extend(original_override_warnings(locale));
    out.extend(origin_ledger_warnings(orig, locale));
    if shadowed {
        if let Some(dir) = std::env::current_exe()
            .and_then(std::fs::canonicalize)
            .ok()
            .and_then(|exe| exe.parent().map(std::path::Path::to_path_buf))
        {
            out.extend(shadow_backup_warnings(&dir, orig, locale));
        }
    }
    out
}

/// PATH entries holding an executable base name (dsh/rdsh), in resolution
/// order, deduplicated by canonical path and bounded by PATH_SCAN_MAX_DIRS.
fn path_binary_hits_in(path_var: &std::ffi::OsStr, base: &str) -> Vec<std::path::PathBuf> {
    #[cfg(windows)]
    let names = [format!("{base}.exe"), base.to_string()];
    #[cfg(not(windows))]
    let names = [base.to_string()];

    let mut hits: Vec<std::path::PathBuf> = Vec::new();
    let mut seen: Vec<std::path::PathBuf> = Vec::new();
    for dir in std::env::split_paths(path_var).take(PATH_SCAN_MAX_DIRS) {
        if dir.as_os_str().is_empty() {
            continue;
        }
        for name in &names {
            let candidate = dir.join(name);
            if !is_executable_file(&candidate) {
                continue;
            }
            let key = std::fs::canonicalize(&candidate).unwrap_or_else(|_| candidate.clone());
            if seen.contains(&key) {
                continue;
            }
            seen.push(key);
            hits.push(candidate);
            break;
        }
    }
    hits
}

/// Report dsh/rdsh resolving to more than one PATH entry: whichever comes
/// first wins, so a stale copy earlier in PATH silently shadows the real one.
fn duplicate_path_warnings(locale: locale::Locale) -> Vec<String> {
    let Some(path_var) = std::env::var_os("PATH") else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for base in ["dsh", "rdsh"] {
        let hits = path_binary_hits_in(&path_var, base);
        if hits.len() < 2 {
            continue;
        }
        let listed: Vec<String> = hits
            .iter()
            .take(4)
            .map(|p| p.display().to_string())
            .collect();
        let extra = hits.len() - listed.len();
        let extra = if extra > 0 {
            localized_format!(
                locale,
                " (+{extra} more)",
                "（另有 {extra} 个）",
                "（ほか{extra}件）"
            )
        } else {
            String::new()
        };
        out.push(localized_format!(
            locale,
            "[rdsh] note: {} '{base}' entries on PATH: {}{extra}; the first one wins",
            "[rdsh] 提示：PATH 中有 {} 个 '{base}'：{}{extra}；使用第一个",
            "[rdsh] 注記: PATHに '{base}' が{}件あります: {}{extra}。最初のものを使用します",
            hits.len(),
            listed.join(", ")
        ));
    }
    out
}

/// The env override wins over every other original resolution and is taken
/// as-is (find_original_dsh does not validate it), so a typo there breaks
/// delegation while doctor still prints the path.
fn original_override_warnings(locale: locale::Locale) -> Vec<String> {
    for key in ["RDSH_ORIG_BIN", "DSH_ORIG_BIN"] {
        let Ok(value) = std::env::var(key) else {
            continue;
        };
        if value.is_empty() {
            continue;
        }
        let path_var = std::env::var_os("PATH").unwrap_or_default();
        let path = std::path::Path::new(&value);
        // `passthrough` sends `.js` overrides to Node as a file argument,
        // which resolves relative to CWD and does not search PATH.
        let node_entrypoint = path.extension().is_some_and(|ext| ext == "js");
        let explicit_path = value.contains('/') || (cfg!(windows) && value.contains('\\'));
        let usable = if node_entrypoint || explicit_path {
            usable_original(path)
        } else {
            command_on_path_in(&value, &path_var).is_some()
        };
        if usable {
            return Vec::new();
        }
        return vec![localized_format!(locale, "[rdsh] warn: {key}={value} is not a usable dsh entrypoint; passthrough takes the override as-is, so delegation will fail", "[rdsh] 警告：{key}={value} 不是可用的 dsh 入口；passthrough 原样使用此覆盖值，委托将失败", "[rdsh] 警告: {key}={value} は使用可能なdsh起動先ではありません。passthroughは指定値をそのまま使うため、委譲に失敗します"
        )];
    }
    Vec::new()
}

/// install.sh --as-dsh records the backup it moved aside in
/// ~/.config/rdsh/origin, and passthrough prefers that path. A stale entry is
/// easy to miss because the failure looks like an ordinary delegation error.
fn origin_ledger_warnings_in(
    ledger: &std::path::Path,
    orig: Option<&str>,
    locale: locale::Locale,
) -> Vec<String> {
    let Ok(metadata) = std::fs::metadata(ledger) else {
        return Vec::new();
    };
    // One path line: keep the read bounded even if the file was replaced.
    if !metadata.is_file() || metadata.len() > 4096 {
        return Vec::new();
    }
    let Ok(recorded) = std::fs::read_to_string(ledger) else {
        return Vec::new();
    };
    let recorded = recorded.trim();
    if recorded.is_empty() {
        return Vec::new();
    }
    let path = std::path::Path::new(recorded);
    if !path.exists() {
        return vec![localized_format!(locale, "[rdsh] warn: install ledger {} records {recorded}, which no longer exists; run install.sh --restore or remove the file", "[rdsh] 警告：安装记录 {} 中的 {recorded} 已不存在；请运行 install.sh --restore 或移除该记录文件", "[rdsh] 警告: インストール記録 {} の {recorded} が存在しません。install.sh --restore を実行するか記録ファイルを削除してください",
            ledger.display()
        )];
    }
    if !usable_original(path) {
        return vec![localized_format!(locale, "[rdsh] warn: install ledger {} records {recorded}, which is not executable; passthrough ignores it", "[rdsh] 警告：安装记录 {} 中的 {recorded} 不可执行；passthrough 将忽略它", "[rdsh] 警告: インストール記録 {} の {recorded} に実行権限がありません。passthroughは使用しません",
            ledger.display()
        )];
    }
    if orig != Some(recorded) {
        return vec![localized_format!(locale, "[rdsh] note: install ledger records {recorded}, but passthrough resolves {} (RDSH_ORIG_BIN/DSH_ORIG_BIN wins over the ledger)", "[rdsh] 提示：安装记录为 {recorded}，但 passthrough 使用 {}（RDSH_ORIG_BIN/DSH_ORIG_BIN 优先于安装记录）", "[rdsh] 注記: インストール記録は {recorded} ですが、passthroughは {} を使用します（RDSH_ORIG_BIN/DSH_ORIG_BINが優先）",
            orig.unwrap_or("<not found>")
        )];
    }
    Vec::new()
}

fn origin_ledger_warnings(orig: Option<&str>, locale: locale::Locale) -> Vec<String> {
    let Some(home) = crate::inspect::home_dir() else {
        return Vec::new();
    };
    let ledger = std::path::Path::new(&home)
        .join(".config")
        .join("rdsh")
        .join("origin");
    origin_ledger_warnings_in(&ledger, orig, locale)
}

/// install.sh --as-dsh parks the original next to the shadowing binary as
/// dsh-orig, and --restore needs that file. dir is the directory of the
/// running binary, i.e. the install prefix in the shadowed layout.
fn shadow_backup_warnings(
    dir: &std::path::Path,
    orig: Option<&str>,
    locale: locale::Locale,
) -> Vec<String> {
    #[cfg(windows)]
    const BACKUPS: &[&str] = &["dsh-orig.exe", "dsh-orig", "dsh.orig", "dsh.real"];
    #[cfg(not(windows))]
    const BACKUPS: &[&str] = &["dsh-orig", "dsh.orig", "dsh.real"];

    let mut unrunnable: Option<std::path::PathBuf> = None;
    for name in BACKUPS {
        let candidate = dir.join(name);
        if is_executable_file(&candidate) {
            return Vec::new();
        }
        if unrunnable.is_none() && candidate.exists() {
            unrunnable = Some(candidate);
        }
    }
    let fallback = orig.unwrap_or("<not found>");
    if let Some(candidate) = unrunnable {
        return vec![localized_format!(locale, "[rdsh] warn: {} exists but is not executable, so shadowed 'dsh' cannot delegate through it; passthrough falls back to {fallback}", "[rdsh] 警告：{} 存在但不可执行，被遮蔽的 'dsh' 无法通过它委托；passthrough 回退到 {fallback}", "[rdsh] 警告: {} は存在しますが実行できず、隠蔽された 'dsh' の委譲先にできません。passthroughは {fallback} を使用します",
            candidate.display()
        )];
    }
    vec![localized_format!(locale, "[rdsh] warn: 'dsh' is shadowed by rdsh with no dsh-orig backup in {}; passthrough falls back to {fallback} and install.sh --restore has nothing to restore", "[rdsh] 警告：'dsh' 被 rdsh 遮蔽，且 {} 没有 dsh-orig 备份；passthrough 回退到 {fallback}，install.sh --restore 无法恢复", "[rdsh] 警告: 'dsh' がrdshに隠蔽されていますが、{} にdsh-origのバックアップがありません。passthroughは {fallback} を使用し、install.sh --restore では復元できません",
        dir.display()
    )]
}

/// True when `dsh` on PATH resolves to this binary (install.sh --as-dsh state).
fn shadowing_original() -> bool {
    if invoked_as_dsh() {
        return true;
    }
    let Ok(me) = std::env::current_exe().and_then(std::fs::canonicalize) else {
        return false;
    };
    std::env::var_os("PATH").is_some_and(|path| path_shadows_current(&path, &me))
}

fn path_shadows_current(path: &std::ffi::OsStr, me: &std::path::Path) -> bool {
    #[cfg(windows)]
    const NAMES: &[&str] = &["dsh", "dsh.exe"];
    #[cfg(not(windows))]
    const NAMES: &[&str] = &["dsh"];

    std::env::split_paths(path).any(|dir| {
        NAMES.iter().any(|name| {
            std::fs::canonicalize(dir.join(name)).is_ok_and(|candidate| candidate.as_path() == me)
        })
    })
}

fn bench(n: u32, locale: locale::Locale) -> anyhow::Result<()> {
    use std::time::Instant;
    if n == 0 {
        anyhow::bail!(match locale {
            locale::Locale::English => "--n must be >= 1",
            locale::Locale::Chinese => "--n 必须 >= 1",
            locale::Locale::Japanese => "--n は 1 以上である必要があります",
        });
    }
    let me = std::env::current_exe()?;
    let mut mine = vec![];
    for _ in 0..n {
        let t = Instant::now();
        let st = std::process::Command::new(&me).arg("--version").status()?;
        if !st.success() {
            anyhow::bail!(match locale {
                locale::Locale::English => "self --version failed",
                locale::Locale::Chinese => "自身的 --version 失败",
                locale::Locale::Japanese => "自身の --version が失敗しました",
            });
        }
        mine.push(t.elapsed());
    }
    println!("[rdsh] rdsh --version x{n}: {}", summarize(&mine, locale));
    if let Some(orig) = passthrough::find_original_dsh() {
        let mut theirs = vec![];
        for _ in 0..n {
            let t = Instant::now();
            let _ = std::process::Command::new(&orig)
                .arg("--version")
                .status()?;
            theirs.push(t.elapsed());
        }
        println!("[dsh ] dsh --version x{n}: {}", summarize(&theirs, locale));
    } else {
        println!(
            "[dsh ] {}",
            match locale {
                locale::Locale::English => "skipped (original not found)",
                locale::Locale::Chinese => "已跳过（未找到原始版本）",
                locale::Locale::Japanese => "スキップ（元のバージョンが見つかりません）",
            }
        );
    }
    Ok(())
}

fn summarize(v: &[std::time::Duration], locale: locale::Locale) -> String {
    let mut s = v.to_vec();
    s.sort();
    let mid = s[s.len() / 2];
    match locale {
        locale::Locale::English => {
            format!("median={mid:?} min={:?} max={:?}", s[0], s[s.len() - 1])
        }
        locale::Locale::Chinese => format!(
            "中位数={mid:?} 最小值={:?} 最大值={:?}",
            s[0],
            s[s.len() - 1]
        ),
        locale::Locale::Japanese => {
            format!("中央値={mid:?} 最小={:?} 最大={:?}", s[0], s[s.len() - 1])
        }
    }
}

#[cfg(test)]
mod default_profile_tests {
    use super::{pick_default_profile, Cli};
    use clap::Parser;

    #[test]
    fn env_wins() {
        assert_eq!(pick_default_profile(Some("web"), false).unwrap(), "web");
        assert_eq!(pick_default_profile(Some(" web "), true).unwrap(), "web");
    }

    #[test]
    fn local_tui_fallback() {
        assert_eq!(pick_default_profile(None, true).unwrap(), "tui");
        assert_eq!(pick_default_profile(Some(""), true).unwrap(), "tui");
    }

    #[test]
    fn guided_error_without_either() {
        let err = pick_default_profile(None, false).unwrap_err();
        assert!(err.contains("RDSH_DEFAULT_PROFILE"), "{err}");
        assert!(err.contains("--profile"), "{err}");
    }

    /// NATIVE_FIRST (used by dsh-shadowed dispatch) and the clap Commands
    /// enum must never drift apart: a missing name silently delegates a
    /// native subcommand to dsh instead of running it here.
    #[test]
    fn native_first_matches_subcommands() {
        use clap::error::ErrorKind;
        for name in crate::NATIVE_FIRST {
            // Some subcommands require positional args (e.g. `search`), so a
            // bare-name parse may legitimately fail — but never with
            // InvalidSubcommand, which is what a missing Commands entry yields.
            if let Err(e) = Cli::try_parse_from(["rdsh", name]) {
                assert_ne!(
                    e.kind(),
                    ErrorKind::InvalidSubcommand,
                    "NATIVE_FIRST entry {name:?} has no matching subcommand"
                );
            }
        }
    }

    /// 逆方向: Commands にある subcommand は必ず NATIVE_FIRST にも要る。
    /// 抜けていると `dsh <name>` として起動されたとき元 dsh へ逐語委譲され、
    /// ネイティブ実装が黙って動かなくなる。
    #[test]
    fn every_subcommand_is_native_first() {
        use clap::CommandFactory;
        for sub in Cli::command().get_subcommands() {
            let name = sub.get_name();
            assert!(
                crate::NATIVE_FIRST.contains(&name),
                "subcommand {name:?} is missing from NATIVE_FIRST"
            );
        }
    }

    #[test]
    fn boot_rejects_empty_from_default_profile() {
        assert!(Cli::try_parse_from([
            "rdsh",
            "boot",
            "--profile",
            "rescue",
            "--from-default-profile",
            "",
        ])
        .is_err());
    }

    #[test]
    fn boot_preserves_valid_from_default_profile() {
        let parsed = Cli::try_parse_from([
            "rdsh",
            "boot",
            "--profile",
            "rescue",
            "--from-default-profile",
            "web",
        ])
        .unwrap();
        match parsed.command {
            Some(super::Commands::Boot {
                profile,
                from_default_profile,
                args,
            }) => {
                assert_eq!(profile.as_deref(), Some("rescue"));
                assert_eq!(from_default_profile.as_deref(), Some("web"));
                assert!(args.is_empty());
            }
            _ => panic!("expected boot"),
        }
    }

    /// The `--help` USAGE line must list every native subcommand: a missing
    /// name makes the documented surface smaller than the real one.
    #[test]
    fn after_help_lists_every_native_subcommand() {
        use clap::CommandFactory;
        let mut cmd = Cli::command();
        // 折り返しで改行が入るため、空白を畳んでから USAGE 行の一覧を読む。
        let flat = cmd
            .render_help()
            .to_string()
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        let listed: Vec<&str> = flat
            .split('(')
            .find_map(|part| part.split(')').next().filter(|l| l.contains("|prune|")))
            .expect("USAGE line should list native subcommands")
            .split('|')
            .collect();
        for name in crate::NATIVE_FIRST {
            assert!(listed.contains(name), "after_help is missing {name:?}");
        }
    }
}

#[cfg(test)]
mod native_dump_tests {
    use super::native_dump_config_json;

    #[test]
    fn native_dump_escapes_untrusted_profile_and_home_strings() {
        let profile = "profile \"quoted\"\\name\nnext";
        let home = "C:\\Users\\a \"quoted\"\\folder";
        let patches = vec!["patch \"one\"\\overlay.yml".to_string()];

        let encoded = native_dump_config_json(profile, home, &patches);
        let decoded: serde_json::Value = serde_json::from_str(&encoded).unwrap();

        assert_eq!(decoded["profile"], profile);
        assert_eq!(decoded["dsh_home"], home);
        assert_eq!(decoded["patches"], serde_json::json!(patches));
    }
}

#[cfg(test)]
mod shadowing_original_tests {
    use super::path_shadows_current;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn searches_os_path_components_for_platform_binary_name() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root =
            std::env::temp_dir().join(format!("rdsh-shadow-path-{}-{nonce}", std::process::id()));
        let decoy = root.join("first");
        let binary_dir = root.join("second");
        fs::create_dir_all(&decoy).unwrap();
        fs::create_dir_all(&binary_dir).unwrap();

        #[cfg(windows)]
        const TEST_NAMES: &[&str] = &["dsh", "dsh.exe"];
        #[cfg(not(windows))]
        const TEST_NAMES: &[&str] = &["dsh"];

        for binary_name in TEST_NAMES {
            let candidate = binary_dir.join(*binary_name);
            fs::write(&candidate, b"test executable path").unwrap();
        }
        let current = fs::canonicalize(binary_dir.join(TEST_NAMES[0])).unwrap();
        let path = std::env::join_paths([decoy.as_os_str(), binary_dir.as_os_str()]).unwrap();
        for binary_name in TEST_NAMES {
            let candidate = fs::canonicalize(binary_dir.join(*binary_name)).unwrap();
            assert!(path_shadows_current(&path, &candidate), "{binary_name}");
        }

        let path_without_candidate = std::env::join_paths([decoy.as_os_str()]).unwrap();
        assert!(!path_shadows_current(&path_without_candidate, &current));
        fs::remove_dir_all(root).unwrap();
    }
}

#[cfg(test)]
mod doctor_wrapper_tests {
    use super::{
        broken_wrapper_warnings, origin_ledger_warnings_in, path_binary_hits_in,
        referenced_binary_paths, scan_local_wrappers, shadow_backup_warnings, shebang_interpreter,
    };
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(tag: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir =
            std::env::temp_dir().join(format!("rdsh-doctor-{tag}-{}-{nonce}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[cfg(unix)]
    fn make_executable(path: &Path) {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
    }

    #[cfg(not(unix))]
    fn make_executable(_path: &Path) {}

    #[test]
    fn shebang_and_reference_parsing() {
        assert_eq!(
            shebang_interpreter("#!/usr/bin/env -S node --x").as_deref(),
            Some("node")
        );
        assert_eq!(
            shebang_interpreter("#!/usr/bin/node").as_deref(),
            Some("/usr/bin/node")
        );
        assert_eq!(shebang_interpreter("#!/bin/sh").as_deref(), Some("/bin/sh"));
        assert_eq!(shebang_interpreter("#!/usr/bin/env"), None);
        assert_eq!(
            shebang_interpreter("#!/usr/bin/env -S NODE_NO_WARNINGS=1 node"),
            Some("node".to_string())
        );
        assert_eq!(
            shebang_interpreter("#!/usr/bin/env --unsupported node"),
            None
        );
        assert_eq!(shebang_interpreter("echo hi"), None);

        // Comments (including stale old locations) and quoted paths must not
        // become false findings.
        let refs = referenced_binary_paths(
            "exec /opt/node-v22/bin/node /opt/dsh/lib/bin.js\nPATH=/opt/bin:$PATH\nexec \"/opt/dsh stable/bin/rdsh\" \"$@\" # old: /opt/dead/dsh/bin.js\n# /etc/hosts\n",
        );
        assert_eq!(
            refs,
            vec![
                "/opt/node-v22/bin/node".to_string(),
                "/opt/dsh/lib/bin.js".to_string(),
                "/opt/dsh stable/bin/rdsh".to_string()
            ]
        );
    }

    #[cfg(unix)]
    #[test]
    fn non_executable_local_wrapper_is_reported() {
        let root = temp_dir("non-executable");
        let wrapper = root.join("dsh-disabled");
        fs::write(&wrapper, "#!/bin/sh\nexec rdsh \"$@\"\n").unwrap();

        let scan = scan_local_wrappers(&root);
        let broken = broken_wrapper_warnings(&scan, &root, crate::locale::Locale::English);
        assert!(
            broken
                .iter()
                .any(|(name, warning)| name == "dsh-disabled" && warning.contains("not executable")),
            "{broken:?}"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn node_wrapper_diagnostic_ignores_comments() {
        let scan = super::WrapperScan {
            texts: vec![(
                "dsh-wrapper".to_string(),
                "exec rdsh \"$@\" # old: node /opt/dsh/lib/bin.js\n".to_string(),
            )],
            broken_links: Vec::new(),
            non_executable: Vec::new(),
        };
        assert!(super::node_wrapper_warnings(
            &scan,
            Path::new("unused"),
            true,
            &[],
            crate::locale::Locale::English
        )
        .is_empty());
    }

    #[test]
    fn broken_wrappers_are_reported_but_healthy_ones_are_not() {
        let root = temp_dir("broken");
        let bin = root.join("bin");
        fs::create_dir_all(&bin).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(root.join("gone").join("dsh.js"), bin.join("dsh-broken"))
            .unwrap();

        #[cfg(unix)]
        let dead_text =
            "#!/bin/sh\nexec /nonexistent-node/bin/node /nonexistent-dsh/lib/bin.js \"$@\"\n";
        #[cfg(not(unix))]
        let dead_text = "exec /nonexistent-node/bin/node /nonexistent-dsh/lib/bin.js %*\n";
        let dead = bin.join("dsh-dead-node");
        fs::write(&dead, dead_text).unwrap();
        make_executable(&dead);

        #[cfg(unix)]
        const HEALTHY: &str = "#!/bin/sh\nexec rdsh \"$@\"\n";
        #[cfg(not(unix))]
        const HEALTHY: &str = "exec rdsh \"$@\"\n";
        let healthy = bin.join("rdsh-ok");
        fs::write(&healthy, HEALTHY).unwrap();
        make_executable(&healthy);

        let scan = scan_local_wrappers(&bin);
        let broken = broken_wrapper_warnings(&scan, &bin, crate::locale::Locale::English);
        let lines: Vec<&str> = broken.iter().map(|(_, warning)| warning.as_str()).collect();
        #[cfg(unix)]
        assert!(
            lines
                .iter()
                .any(|w| w.contains("dsh-broken") && w.contains("broken symlink")),
            "{lines:?}"
        );
        let dead_warning = lines
            .iter()
            .find(|w| w.contains("dsh-dead-node"))
            .expect("a wrapper pointing at a removed node/dsh path must be reported");
        assert!(
            dead_warning.contains("/nonexistent-node/bin/node"),
            "{dead_warning}"
        );
        assert!(
            dead_warning.contains(&dead.display().to_string()),
            "diagnostic must show the directory scanned for wrappers: {dead_warning}"
        );
        assert!(!lines.iter().any(|w| w.contains("rdsh-ok")), "{lines:?}");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn path_hits_follow_path_order_and_skip_non_candidates() {
        let root = temp_dir("path");
        let first = root.join("first");
        let second = root.join("second");
        let empty = root.join("empty");
        fs::create_dir_all(&first).unwrap();
        fs::create_dir_all(&second).unwrap();
        // A directory named dsh never resolves as a binary on any platform.
        fs::create_dir_all(empty.join("dsh")).unwrap();
        for dir in [&first, &second] {
            let dsh = dir.join("dsh");
            fs::write(&dsh, "#!/bin/sh\n").unwrap();
            make_executable(&dsh);
        }
        let path = std::env::join_paths([first.as_os_str(), empty.as_os_str(), second.as_os_str()])
            .unwrap();
        assert_eq!(
            path_binary_hits_in(&path, "dsh"),
            vec![first.join("dsh"), second.join("dsh")]
        );

        #[cfg(unix)]
        {
            // Mode bits alone must not accept a file nobody can execute.
            let noexec = root.join("noexec");
            fs::create_dir_all(&noexec).unwrap();
            fs::write(noexec.join("dsh"), "#!/bin/sh\n").unwrap();
            let path = std::env::join_paths([noexec.as_os_str()]).unwrap();
            assert!(path_binary_hits_in(&path, "dsh").is_empty());
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn shadow_backup_reports_missing_and_unusable_backups() {
        let root = temp_dir("backup");
        let warnings =
            shadow_backup_warnings(&root, Some("/orig/dsh"), crate::locale::Locale::English);
        assert_eq!(warnings.len(), 1);
        assert!(
            warnings[0].contains("no dsh-orig backup"),
            "{}",
            warnings[0]
        );
        assert!(warnings[0].contains("/orig/dsh"), "{}", warnings[0]);

        #[cfg(unix)]
        {
            let backup = root.join("dsh-orig");
            fs::write(&backup, "#!/bin/sh\n").unwrap();
            let warnings =
                shadow_backup_warnings(&root, Some("/orig/dsh"), crate::locale::Locale::English);
            assert_eq!(warnings.len(), 1);
            assert!(warnings[0].contains("not executable"), "{}", warnings[0]);
            make_executable(&backup);
            assert!(shadow_backup_warnings(
                &root,
                Some("/orig/dsh"),
                crate::locale::Locale::English
            )
            .is_empty());
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn origin_ledger_reports_stale_entries() {
        let root = temp_dir("ledger");
        let ledger = root.join("origin");
        assert!(
            origin_ledger_warnings_in(&ledger, None, crate::locale::Locale::English).is_empty()
        );

        fs::write(
            &ledger,
            format!("{}\n", root.join("gone-dsh-orig").display()),
        )
        .unwrap();
        let warnings = origin_ledger_warnings_in(&ledger, None, crate::locale::Locale::English);
        assert_eq!(warnings.len(), 1);
        assert!(warnings[0].contains("no longer exists"), "{}", warnings[0]);

        let backup = root.join("dsh-orig");
        fs::write(&backup, "#!/bin/sh\n").unwrap();
        make_executable(&backup);
        fs::write(&ledger, format!("{}\n", backup.display())).unwrap();
        let same = backup.display().to_string();
        assert!(
            origin_ledger_warnings_in(&ledger, Some(&same), crate::locale::Locale::English)
                .is_empty()
        );
        let warnings =
            origin_ledger_warnings_in(&ledger, Some("/other/dsh"), crate::locale::Locale::English);
        assert_eq!(warnings.len(), 1);
        assert!(warnings[0].contains("/other/dsh"), "{}", warnings[0]);

        #[cfg(unix)]
        {
            let plain = root.join("plain-orig");
            fs::write(&plain, "#!/bin/sh\n").unwrap();
            fs::write(&ledger, format!("{}\n", plain.display())).unwrap();
            let warnings = origin_ledger_warnings_in(&ledger, None, crate::locale::Locale::English);
            assert_eq!(warnings.len(), 1);
            assert!(warnings[0].contains("not executable"), "{}", warnings[0]);
        }
        fs::remove_dir_all(root).unwrap();
    }
}
