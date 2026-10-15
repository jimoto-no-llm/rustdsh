use clap::{CommandFactory, Parser, Subcommand, ValueEnum};

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
mod answer_applications;
mod auth;
mod auth_sharing;
mod budget_admission;
mod compact;
mod compute;
mod context;
mod desktop;
mod dsh_args;
mod file_lock;
mod file_security;
mod guard;
mod inspect;
mod instruction_queue;
mod js_json;
mod local_http;
mod opencode_header;
mod passthrough;
mod providers;
mod question_contracts;
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

#[derive(Parser, Debug)]
#[command(
    name = "rdsh",
    version,
    about = "Rust fast launcher for dsh (safe: native fast-paths + passthrough)",
    after_help = "USAGE:\n  rdsh [profile] [--profile <name>] [--patch <yml>...] [app-args...]\n  rdsh <native-subcommand> ...   (tokens|prune|search|search-web|compact|doctor|bench|serve|sessions|profiles|skills|logs|guard|compute|desktop|auth|setup|context|settings|features|subagents|provider|task-outcomes|budget-admission|question-contracts|answer-applications|instruction-queue|update|dump-config|boot|serial-proxy)\n\nEXAMPLES:\n  rdsh tui                        boot tui profile (slim env ON, delegates to dsh)\n  rdsh --profile web --patch x.yml boot web with overlay\n  rdsh dump-config --profile tui  delegate exact dump to dsh\n  rdsh tokens ./AGENTS.md         estimate input tokens natively\n  rdsh auth --import --provider openai-codex   import only the selected provider\n  rdsh setup                      first-run connect: import, login flow, next steps\n  rdsh provider add hai --model deepseek-v4-flash   register HAI as a dsh route\n  rdsh provider add sarashina    register Sarashina (SARASHINA_API_KEY; mini and nano built in)\n  rdsh provider add local-openai --base-url http://host:8080/v1 --discover --no-key\n  rdsh provider list              presets and per-profile route/key status\n  rdsh search hello --dir .       fast file search without Node\n  rdsh search-web \"rust async\"      web search via SearXNG (no API key)\n  rdsh desktop status             detect the Desktop (Electron) app and its reserved profile\n  rdsh desktop install            attach the bundled rdsh plugins to that profile\n  rdsh --passthrough tui          no slim env; mandatory tool isolation remains\n  rdsh --dry-run tui -- --resume abc   show what would exec"
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
        #[arg(long = "max-queue", default_value_t = 64)]
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
    /// Typed question contracts: create, revise or cancel one question card,
    /// record the answer to an open card, validate a stored extension by
    /// recomputing every fingerprint, or print the card projection the
    /// dashboard shows. Pure logic: no provider call and no file write
    #[command(name = "question-contracts")]
    QuestionContracts {
        /// apply | validate | public
        action: String,
        /// Request JSON file holding { operation, state, input, now }
        #[arg(long = "input-file")]
        input_file: String,
    },
    /// Human answer application to the exact run/session that asked.
    /// Pure logic: no provider call and no file write.
    #[command(name = "answer-applications")]
    AnswerApplications {
        /// apply | validate | public | schema
        action: String,
        /// Request JSON file holding { operation, state, input, now, live_jobs }
        #[arg(long = "input-file")]
        input_file: String,
    },
    /// Validate and inspect the ordered human-instruction queue.
    /// Pure logic: no provider call and no file write.
    #[command(name = "instruction-queue")]
    InstructionQueue {
        /// validate | context | submit | resolve | control | serve
        action: String,
        /// Request JSON file holding { operation, state, input, context }
        #[arg(long = "input-file")]
        input_file: Option<String>,
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
    "update",
    "serial-proxy",
    "subagents",
    "task-outcomes",
    "budget-admission",
    "question-contracts",
    "answer-applications",
    "instruction-queue",
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
    // NOTE: --version/-V is served by clap itself (prints "rdsh x.y.z", exit 0).
    let cli = Cli::parse();
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
    // Recovery, the pure task-outcome validator and the pure subagent planner
    // do not depend on settings.
    // Commands that use settings still fail closed on a corrupt document.
    let cfg = if matches!(
        &cli.command,
        Some(Commands::Settings {
            action: SettingsAction::Init { force: true }
        }) | Some(Commands::TaskOutcomes { .. })
            | Some(Commands::BudgetAdmission { .. })
            | Some(Commands::QuestionContracts { .. })
            | Some(Commands::AnswerApplications { .. })
            | Some(Commands::InstructionQueue { .. })
            | Some(Commands::Subagents { .. })
    ) {
        rdsh_config::RdshSettings::default()
    } else {
        rdsh_config::load()
    };
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
        Some(Commands::Tokens { files, preview }) => tokens::cmd_tokens(files, preview),
        Some(Commands::Prune { max_tokens, file }) => {
            tokens::cmd_prune(max_tokens.unwrap_or(cfg.tokens.default_budget), file)
        }
        Some(Commands::Search { pattern, dir, max }) => {
            let dir = dir.unwrap_or_else(|| cfg.search.dir.clone());
            search::cmd_search(&pattern, &dir, max.unwrap_or(cfg.search.max))
        }
        Some(Commands::SearchWeb { query, limit, json }) => {
            if !rdsh_config::feature_enabled(&cfg, "search-web") {
                extra_disabled("search-web")
            } else {
                websearch::cmd_search_web(&query, limit.unwrap_or(cfg.search.web_limit), json)
            }
        }
        Some(Commands::Compact { file, max_tokens }) => {
            compact::cmd_compact(&file, max_tokens.unwrap_or(cfg.compact.max_tokens))
        }
        Some(Commands::Doctor) => doctor(),
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
        ),
        Some(Commands::Profiles) => inspect::cmd_profiles(),
        Some(Commands::Skills) => inspect::cmd_skills(),
        Some(Commands::Logs { tail, grep, file }) => {
            inspect::cmd_logs(tail.unwrap_or(cfg.logs.tail), grep, file)
        }
        Some(Commands::Serve { port }) => {
            if !rdsh_config::feature_enabled(&cfg, "serve") {
                extra_disabled("serve")
            } else {
                serve::cmd_serve(port.unwrap_or(cfg.serve.port))
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
        }) => serial_proxy::cmd_serial_proxy(serial_proxy::SerialProxyOptions {
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
        }),
        Some(Commands::Bench { n }) => bench(n.unwrap_or(cfg.bench.n)),
        Some(Commands::Compute { once }) => compute::cmd_compute(once),
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
            guard::cmd_guard(merged, reason, json, policy_file)
        }
        Some(Commands::Update { action }) => match action {
            UpdateAction::Auto { action } => match action {
                AutoAction::Status { json } => update_auto::cmd_update_auto("status", false, json),
                AutoAction::On { dry_run, json } => {
                    update_auto::cmd_update_auto("on", dry_run, json)
                }
                AutoAction::Off { dry_run, json } => {
                    update_auto::cmd_update_auto("off", dry_run, json)
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
                    println!("config: {}", rdsh_config::settings_path());
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
                            "config"
                        } else {
                            "default"
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
                            "config"
                        } else {
                            "default"
                        };
                        println!("{key}  {state}  {source}");
                    }
                    Ok(())
                }
            }
            SettingsAction::Init { force } => {
                let path = rdsh_config::settings_path();
                match rdsh_config::initialize(force) {
                    Ok(true) => {
                        println!("{path}");
                        Ok(())
                    }
                    Ok(false) => {
                        eprintln!(
                            "[rdsh] settings already exist at {path} (use --force to overwrite)"
                        );
                        std::process::exit(2);
                    }
                    Err(e) => Err(e),
                }
            }
            SettingsAction::Get { key, json } => {
                let cfg = rdsh_config::load();
                match cfg.get_dotted(&key) {
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
                        eprintln!("[rdsh] unknown key: {key} (try: rdsh settings keys)");
                        std::process::exit(2);
                    }
                }
            }
            SettingsAction::Set { key, value } => {
                match rdsh_config::update(|cfg| cfg.set_dotted(&key, &value)) {
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
                        None => Err(anyhow::anyhow!("set failed: {key}")),
                    },
                }
            }
            SettingsAction::Unset { key } => {
                match rdsh_config::update(|cfg| cfg.reset_dotted(&key)) {
                    Err(e) => Err(e),
                    Ok(_) => {
                        println!(
                            "reset {} (saved to {})",
                            key.trim(),
                            rdsh_config::settings_path()
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
            task_outcomes::cmd_task_outcomes(&action, &input_file)
        }
        Some(Commands::BudgetAdmission { action, input_file }) => {
            budget_admission::cmd_budget_admission(&action, &input_file)
        }
        Some(Commands::QuestionContracts { action, input_file }) => {
            question_contracts::cmd_question_contracts(&action, &input_file)
        }
        Some(Commands::AnswerApplications { action, input_file }) => {
            answer_applications::cmd_answer_applications(&action, &input_file)
        }
        Some(Commands::InstructionQueue { action, input_file }) => match action.as_str() {
            "serve" if input_file.is_none() => instruction_queue::cmd_instruction_queue_serve(),
            "serve" => Err(anyhow::anyhow!(
                "instruction-queue serve does not accept --input-file"
            )),
            _ => match input_file {
                Some(input_file) => instruction_queue::cmd_instruction_queue(&action, &input_file),
                None => Err(anyhow::anyhow!(
                    "--input-file is required for instruction-queue actions"
                )),
            },
        },
        Some(Commands::Features { action, json }) => match action {
            None => features_list(&cfg, json),
            Some(FeaturesAction::On { id }) => features_toggle(&id, true),
            Some(FeaturesAction::Off { id }) => features_toggle(&id, false),
        },
        Some(Commands::Subagents { action }) => match action {
            SubagentsAction::Plan { input_file, .. } => subagent_plan::cmd_plan(&input_file),
        },
        Some(Commands::Desktop { action, json }) => match action {
            None => desktop::cmd_status(json),
            Some(DesktopAction::Status { json: inner }) => desktop::cmd_status(json || inner),
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
            ),
            Some(DesktopAction::Verify {
                require,
                json: inner,
            }) => desktop::cmd_verify(&require, json || inner),
        },
        Some(Commands::Context { action }) => {
            if !rdsh_config::feature_enabled(&cfg, "context_engine") {
                eprintln!(
                    "[rdsh] context engine is OFF by default (experimental) — enable with: rdsh features on context_engine"
                );
                std::process::exit(2);
            }
            match action {
                ContextAction::Build {
                    query,
                    budget,
                    json,
                } => context::cmd_build(query, budget, json),
                ContextAction::Search { query, max } => {
                    context::cmd_search(query, max.unwrap_or(cfg.context.max_code_hits))
                }
                ContextAction::Status { json } => context::cmd_status(json),
                ContextAction::Explain { query, budget } => context::cmd_explain(query, budget),
            }
        }
        Some(Commands::Auth(args)) => auth::cmd_auth(args, dry),
        Some(Commands::Provider { action }) => match action {
            ProviderAction::List { json } => providers::cmd_list(json),
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
                    setup_web::cmd_setup_web(port.unwrap_or(cfg.setup.web_port))
                } else {
                    Err(anyhow::anyhow!(
                        "rdsh setup --web is off; enable with: rdsh features on setup_web"
                    ))
                }
            } else {
                auth::cmd_setup(open, login, json, yes, dry)
            }
        }
        Some(Commands::DumpConfig { profile, native }) => {
            profile_or_default(profile.or(cli.profile), &cfg.general.default_profile).and_then(
                |p| {
                    if native {
                        dump_config_native(&p, &cli.patch)
                    } else {
                        passthrough::exec_dump_config(
                            &p,
                            None,
                            dsh_args::DumpKind::Config,
                            &cli.patch,
                            dry,
                            slim,
                        )
                    }
                },
            )
        }
        Some(Commands::Boot {
            profile,
            from_default_profile,
            args,
        }) => profile_or_default(profile.or(cli.profile), &cfg.general.default_profile).and_then(
            |p| {
                passthrough::exec_boot(
                    &p,
                    from_default_profile.as_deref(),
                    &cli.patch,
                    &args,
                    dry,
                    slim,
                )
            },
        ),
        None => {
            let parsed = dsh_args::split_launcher_args(cli.profile, cli.extra);
            match parsed {
                dsh_args::Launcher::Help => {
                    // Single source of truth: clap-generated help (see the
                    // #[command] attributes on Cli). Bare `rdsh` and
                    // `-h`/`--help` launcher args land here.
                    let _ = Cli::command().print_help();
                    Ok(())
                }
                dsh_args::Launcher::Plugin { profile, pnpm_args } => {
                    passthrough::exec_plugin(&profile, &pnpm_args, dry, slim)
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
                    )
                }
                dsh_args::Launcher::Error(msg) => {
                    eprintln!("{msg}");
                    std::process::exit(2);
                }
            }
        }
    };
    if let Err(e) = result {
        match e.downcast::<clap::Error>() {
            Ok(error) => error.exit(),
            Err(error) => {
                eprintln!("[rdsh] error: {error:#}");
                std::process::exit(1);
            }
        }
    }
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

fn profile_or_default(opt: Option<String>, configured_default: &str) -> anyhow::Result<String> {
    match opt {
        Some(p) => Ok(p),
        None => resolve_default_profile(configured_default),
    }
}

fn resolve_default_profile(configured_default: &str) -> anyhow::Result<String> {
    let env = std::env::var("RDSH_DEFAULT_PROFILE").ok();
    if !env.as_deref().is_some_and(|e| !e.trim().is_empty())
        && !configured_default.trim().is_empty()
    {
        return Ok(configured_default.trim().to_string());
    }
    let home = crate::inspect::dsh_home();
    let local_tui = std::path::Path::new(&format!("{home}/profiles/tui")).is_dir();
    pick_default_profile(env.as_deref(), local_tui).map_err(|m| anyhow::anyhow!(m))
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

fn dump_config_native(profile: &str, patches: &[String]) -> anyhow::Result<()> {
    let home = crate::inspect::dsh_home();
    println!("{}", native_dump_config_json(profile, &home, patches));
    let root = format!("{home}/profiles/{profile}");
    match std::fs::read_dir(&root) {
        Ok(entries) => {
            println!("# layers under {root}:");
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
            println!("# no local profile dir at {root} (shipped template will be used by dsh)")
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
fn features_list(cfg: &rdsh_config::RdshSettings, json: bool) -> anyhow::Result<()> {
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
    let _ = writeln!(out, "config: {}", rdsh_config::settings_path());
    let _ = writeln!(
        out,
        "{:<24} {:<5} {:<7} what it does",
        "feature", "state", "default"
    );
    for def in rdsh_config::FEATURES {
        let _ = writeln!(
            out,
            "{:<24} {:<5} {:<7} {}",
            def.id,
            if rdsh_config::feature_enabled(cfg, def.id) {
                "on"
            } else {
                "off"
            },
            if def.default { "on" } else { "off" },
            def.summary
        );
    }
    let _ = writeln!(
        out,
        "change one: rdsh features on <id> | rdsh features off <id> | rdsh settings set features.<id> true|false"
    );
    Ok(())
}

/// `rdsh features on|off <id>`: writes features.<id> through the shared lock.
fn features_toggle(id: &str, on: bool) -> anyhow::Result<()> {
    let id = id.trim();
    let def = rdsh_config::feature_def(id)
        .ok_or_else(|| anyhow::anyhow!("unknown feature id: {id} (try: rdsh features)"))?;
    rdsh_config::update(|cfg| {
        cfg.set_dotted(&format!("features.{id}"), if on { "true" } else { "false" })
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
fn extra_disabled(id: &str) -> anyhow::Result<()> {
    Err(anyhow::anyhow!(
        "extra '{id}' is disabled by default; enable with: rdsh features on {id} (or rdsh settings set extras.enable {id})"
    ))
}

fn doctor() -> anyhow::Result<()> {
    use std::io::Write;
    let stdout = std::io::stdout();
    let mut out = stdout.lock();
    // `let _` on purpose: piping to `grep -q` / `head` closes early (EPIPE),
    // which must not abort doctor with a panic.
    let mut say = |s: String| {
        let _ = writeln!(out, "{s}");
    };
    let orig = passthrough::find_original_dsh();
    say(format!(
        "[rdsh] original dsh: {}",
        orig.as_deref().unwrap_or("<not found in PATH>")
    ));
    let home = crate::inspect::dsh_home();
    say(format!("[rdsh] DSH_HOME: {home}"));
    match std::fs::read_dir(format!("{home}/profiles")) {
        Ok(d) => say(format!("[rdsh] profiles: {} local profile(s)", d.count())),
        Err(e) => say(format!("[rdsh] profiles: (unreadable: {e})")),
    }
    // Desktop (Electron) shares $DSH_HOME but keeps its own reserved profile;
    // report both so a missing plugin attachment is visible in doctor.
    let desktop_env = desktop::OsEnv::from_process();
    let desktop_app = desktop::find_app(&desktop_env);
    let desktop_profile = desktop::read_profile(&desktop_env.profile_dir());
    say(format!(
        "[rdsh] desktop: app {} | profile {}",
        desktop_app
            .as_deref()
            .map(|p| p.display().to_string())
            .unwrap_or_else(|| "<not found>".to_string()),
        if desktop_profile.initialized {
            "initialized"
        } else {
            "not initialized"
        }
    ));
    if desktop_profile.initialized {
        let enabled: Vec<&str> = desktop::BUNDLED_PLUGINS
            .iter()
            .copied()
            .filter(|name| desktop_profile.enabled(name))
            .collect();
        say(format!(
            "[rdsh] desktop plugins: {}",
            if enabled.is_empty() {
                "none enabled (run: rdsh desktop install --plugins-dir <checkout>)".to_string()
            } else {
                enabled.join(", ")
            }
        ));
    }
    say(format!("[rdsh] slim env: {}", slim::describe()));
    say(format!("[rdsh] auth: {}", auth::summary_line()));
    if let Some(v) = original_version(orig.as_deref().unwrap_or_default()) {
        say(format!("[rdsh] dsh version: {v}"));
    }
    say(format!("[rdsh] smart-dsh: {}", smart_dsh_status(&home)));
    let shadowed = shadowing_original();
    if shadowed {
        say(
            "[rdsh] note: 'dsh' currently resolves to rdsh; Smart-DSH scripts that locate"
                .to_string(),
        );
        say(
            "[rdsh] note: DSH via PATH need the original: use `dsh-orig` or set DSH_PACKAGE_DIR"
                .to_string(),
        );
    }
    for w in shadow_warnings(shadowed, orig.as_deref()) {
        say(w);
    }
    for w in wrapper_warnings(shadowed) {
        say(w);
    }
    say("[rdsh] note: dsh web GUI defaults to 3080; `rdsh serve` defaults to 38080".to_string());
    say(
        "[rdsh] note: enable the serve extra first; `rdsh serve --port 0` picks a free port"
            .to_string(),
    );
    if orig.is_none() {
        anyhow::bail!("original 'dsh' not found; set DSH_ORIG_BIN or install @deepseek-ai/dsh");
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
fn smart_dsh_status(home: &str) -> String {
    const KNOWN: &[&str] = &["dsh-notify-push", "dsh-esc-stop", "dsh-btw", "dsh-tasks"];
    let pkg = format!("{home}/profiles/web/package.json");
    let text = std::fs::read_to_string(&pkg).unwrap_or_default();
    if text.is_empty() {
        return "(not installed: no web profile package.json)".to_string();
    }
    let found: Vec<&str> = KNOWN.iter().copied().filter(|b| text.contains(b)).collect();
    if found.is_empty() {
        "(not installed in web profile)".to_string()
    } else {
        format!("bundles in web profile: {}", found.join(", "))
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
                format!("[rdsh] warn: {wrapper} calls `node` on a dsh path; while `dsh` is shadowed that path is a native binary — exec `dsh`/`rdsh` directly instead of via `node`")
            } else {
                format!("[rdsh] note: {wrapper} calls `node` on a dsh path; it will break if `dsh` is later shadowed — exec `dsh`/`rdsh` directly instead of via `node`")
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
fn broken_wrapper_reason(dir: &std::path::Path, name: &str, text: &str) -> Option<String> {
    let wrapper = dir.join(name).display().to_string();
    if let Some(line) = text.lines().next().filter(|line| line.starts_with("#!")) {
        if let Some(interp) = shebang_interpreter(line) {
            if command_on_path(&interp).is_none() {
                return Some(format!(
                    "[rdsh] warn: {wrapper} needs '{interp}' on PATH, which is missing; the wrapper cannot run"
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
            "is not executable"
        } else {
            "does not exist"
        };
        return Some(format!(
            "[rdsh] warn: {wrapper} references {p}, which {why}; fix the path or reinstall the wrapper"
        ));
    }
    None
}

/// Broken wrappers found by the shared scan: dangling dsh/rdsh symlinks, a
/// missing shebang interpreter, or an absolute node/dsh/rdsh path that is
/// gone. Advisory only, one line per file, returned as (name, warning) so the
/// node-on-dsh check can skip what is already reported.
fn broken_wrapper_warnings(scan: &WrapperScan, dir: &std::path::Path) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    for (name, target) in &scan.broken_links {
        if !name.contains("dsh") || out.len() >= WRAPPER_WARN_MAX {
            continue;
        }
        let wrapper = dir.join(name).display().to_string();
        out.push((
            name.clone(),
            format!(
                "[rdsh] warn: {wrapper} is a broken symlink -> {target}; recreate or remove it"
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
                format!("[rdsh] warn: {wrapper} is not executable; the wrapper cannot run"),
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
        if let Some(warning) = broken_wrapper_reason(dir, name, text) {
            out.push((name.clone(), warning));
        }
    }
    out
}

/// Every wrapper warning, from one bounded pass over the wrapper dir. A file
/// with a concrete broken path keeps that finding instead of the generic
/// node-on-dsh note.
fn wrapper_warnings(shadowed: bool) -> Vec<String> {
    let Some(dir) = local_bin_dir() else {
        return Vec::new();
    };
    let scan = scan_local_wrappers(&dir);
    let broken = broken_wrapper_warnings(&scan, &dir);
    let broken_names: Vec<String> = broken.iter().map(|(name, _)| name.clone()).collect();
    let mut out: Vec<String> = broken.into_iter().map(|(_, warning)| warning).collect();
    let skip: Vec<&str> = broken_names.iter().map(String::as_str).collect();
    out.extend(node_wrapper_warnings(&scan, &dir, shadowed, &skip));
    out
}

/// Shadowing and install-ledger diagnostics: warnings only, so doctor keeps
/// its exit status (only the missing original at the end is fatal).
fn shadow_warnings(shadowed: bool, orig: Option<&str>) -> Vec<String> {
    let mut out = duplicate_path_warnings();
    out.extend(original_override_warnings());
    out.extend(origin_ledger_warnings(orig));
    if shadowed {
        if let Some(dir) = std::env::current_exe()
            .and_then(std::fs::canonicalize)
            .ok()
            .and_then(|exe| exe.parent().map(std::path::Path::to_path_buf))
        {
            out.extend(shadow_backup_warnings(&dir, orig));
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
fn duplicate_path_warnings() -> Vec<String> {
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
            format!(" (+{extra} more)")
        } else {
            String::new()
        };
        out.push(format!(
            "[rdsh] note: {} '{base}' entries on PATH: {}{extra}; the first one wins",
            hits.len(),
            listed.join(", ")
        ));
    }
    out
}

/// The env override wins over every other original resolution and is taken
/// as-is (find_original_dsh does not validate it), so a typo there breaks
/// delegation while doctor still prints the path.
fn original_override_warnings() -> Vec<String> {
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
        return vec![format!(
            "[rdsh] warn: {key}={value} is not a usable dsh entrypoint; passthrough takes the override as-is, so delegation will fail"
        )];
    }
    Vec::new()
}

/// install.sh --as-dsh records the backup it moved aside in
/// ~/.config/rdsh/origin, and passthrough prefers that path. A stale entry is
/// easy to miss because the failure looks like an ordinary delegation error.
fn origin_ledger_warnings_in(ledger: &std::path::Path, orig: Option<&str>) -> Vec<String> {
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
        return vec![format!(
            "[rdsh] warn: install ledger {} records {recorded}, which no longer exists; run install.sh --restore or remove the file",
            ledger.display()
        )];
    }
    if !usable_original(path) {
        return vec![format!(
            "[rdsh] warn: install ledger {} records {recorded}, which is not executable; passthrough ignores it",
            ledger.display()
        )];
    }
    if orig != Some(recorded) {
        return vec![format!(
            "[rdsh] note: install ledger records {recorded}, but passthrough resolves {} (RDSH_ORIG_BIN/DSH_ORIG_BIN wins over the ledger)",
            orig.unwrap_or("<not found>")
        )];
    }
    Vec::new()
}

fn origin_ledger_warnings(orig: Option<&str>) -> Vec<String> {
    let Some(home) = crate::inspect::home_dir() else {
        return Vec::new();
    };
    let ledger = std::path::Path::new(&home)
        .join(".config")
        .join("rdsh")
        .join("origin");
    origin_ledger_warnings_in(&ledger, orig)
}

/// install.sh --as-dsh parks the original next to the shadowing binary as
/// dsh-orig, and --restore needs that file. dir is the directory of the
/// running binary, i.e. the install prefix in the shadowed layout.
fn shadow_backup_warnings(dir: &std::path::Path, orig: Option<&str>) -> Vec<String> {
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
        return vec![format!(
            "[rdsh] warn: {} exists but is not executable, so shadowed 'dsh' cannot delegate through it; passthrough falls back to {fallback}",
            candidate.display()
        )];
    }
    vec![format!(
        "[rdsh] warn: 'dsh' is shadowed by rdsh with no dsh-orig backup in {}; passthrough falls back to {fallback} and install.sh --restore has nothing to restore",
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

fn bench(n: u32) -> anyhow::Result<()> {
    use std::time::Instant;
    if n == 0 {
        anyhow::bail!("--n must be >= 1");
    }
    let me = std::env::current_exe()?;
    let mut mine = vec![];
    for _ in 0..n {
        let t = Instant::now();
        let st = std::process::Command::new(&me).arg("--version").status()?;
        if !st.success() {
            anyhow::bail!("self --version failed");
        }
        mine.push(t.elapsed());
    }
    println!("[rdsh] rdsh --version x{n}: {}", summarize(&mine));
    if let Some(orig) = passthrough::find_original_dsh() {
        let mut theirs = vec![];
        for _ in 0..n {
            let t = Instant::now();
            let _ = std::process::Command::new(&orig)
                .arg("--version")
                .status()?;
            theirs.push(t.elapsed());
        }
        println!("[dsh ] dsh --version x{n}: {}", summarize(&theirs));
    } else {
        println!("[dsh ] skipped (original not found)");
    }
    Ok(())
}

fn summarize(v: &[std::time::Duration]) -> String {
    let mut s = v.to_vec();
    s.sort();
    let mid = s[s.len() / 2];
    format!("median={mid:?} min={:?} max={:?}", s[0], s[s.len() - 1])
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
        let broken = broken_wrapper_warnings(&scan, &root);
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
        assert!(super::node_wrapper_warnings(&scan, Path::new("unused"), true, &[]).is_empty());
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
        let broken = broken_wrapper_warnings(&scan, &bin);
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
        let warnings = shadow_backup_warnings(&root, Some("/orig/dsh"));
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
            let warnings = shadow_backup_warnings(&root, Some("/orig/dsh"));
            assert_eq!(warnings.len(), 1);
            assert!(warnings[0].contains("not executable"), "{}", warnings[0]);
            make_executable(&backup);
            assert!(shadow_backup_warnings(&root, Some("/orig/dsh")).is_empty());
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn origin_ledger_reports_stale_entries() {
        let root = temp_dir("ledger");
        let ledger = root.join("origin");
        assert!(origin_ledger_warnings_in(&ledger, None).is_empty());

        fs::write(
            &ledger,
            format!("{}\n", root.join("gone-dsh-orig").display()),
        )
        .unwrap();
        let warnings = origin_ledger_warnings_in(&ledger, None);
        assert_eq!(warnings.len(), 1);
        assert!(warnings[0].contains("no longer exists"), "{}", warnings[0]);

        let backup = root.join("dsh-orig");
        fs::write(&backup, "#!/bin/sh\n").unwrap();
        make_executable(&backup);
        fs::write(&ledger, format!("{}\n", backup.display())).unwrap();
        let same = backup.display().to_string();
        assert!(origin_ledger_warnings_in(&ledger, Some(&same)).is_empty());
        let warnings = origin_ledger_warnings_in(&ledger, Some("/other/dsh"));
        assert_eq!(warnings.len(), 1);
        assert!(warnings[0].contains("/other/dsh"), "{}", warnings[0]);

        #[cfg(unix)]
        {
            let plain = root.join("plain-orig");
            fs::write(&plain, "#!/bin/sh\n").unwrap();
            fs::write(&ledger, format!("{}\n", plain.display())).unwrap();
            let warnings = origin_ledger_warnings_in(&ledger, None);
            assert_eq!(warnings.len(), 1);
            assert!(warnings[0].contains("not executable"), "{}", warnings[0]);
        }
        fs::remove_dir_all(root).unwrap();
    }
}
