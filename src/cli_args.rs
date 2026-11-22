use crate::{auth_sharing, cloud, compaction_cli, locale, swarm, websearch};

use clap::{CommandFactory, FromArgMatches, Parser, Subcommand, ValueEnum};

#[derive(Clone, Copy, Debug, ValueEnum)]
#[value(rename_all = "kebab-case")]
pub(crate) enum ToolChoiceDefaultArg {
    None,
    Auto,
    Required,
}

impl ToolChoiceDefaultArg {
    pub(crate) fn as_str(self) -> &'static str {
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

#[derive(Parser, Debug)]
#[command(
    name = "rdsh",
    version,
    about = "Rust fast launcher for dsh (safe: native fast-paths + passthrough)",
    after_help = "USAGE:\n  rdsh [profile] [--profile <name>] [--patch <yml>...] [app-args...]\n  rdsh <native-subcommand> ...   (swarm|cloud|adapter-catalog|tokens|prune|search|search-web|rustxng|compact|compaction|doctor|bench|serve|native-web|native-tui|sessions|profiles|skills|logs|guard|compute|desktop|plugins|auth|setup|context|deps|settings|features|subagents|provider|task-outcomes|budget-admission|cost-ledger|models|files|question-contracts|answer-applications|instruction-queue|update|worker-scope|dump-config|boot|serial-proxy)\n\nEXAMPLES:\n  rdsh tui                        boot tui profile (slim env ON, delegates to dsh)\n  rdsh --profile web --patch x.yml boot web with overlay\n  rdsh dump-config --profile tui  delegate exact dump to dsh\n  rdsh tokens ./AGENTS.md         estimate input tokens natively\n  rdsh auth --import --provider openai-codex   import only the selected provider\n  rdsh setup                      first-run connect: import, login flow, next steps\n  rdsh provider add hai --model deepseek-v4-flash   register HAI as a dsh route\n  rdsh provider add sarashina    register Sarashina (SARASHINA_API_KEY; mini and nano built in)\n  rdsh provider add local-openai --base-url http://host:8080/v1 --discover --no-key\n  rdsh provider list              presets and per-profile route/key status
  rdsh provider detect            credentials and local servers on this machine
  rdsh provider import --dry-run  what detection would write into the profile\n  rdsh search hello --dir .       fast file search without Node\n  rdsh search-web \"rust async\"      web search via SearXNG (no API key)\n  rdsh models                     list the models a profile is missing or names stale\n  rdsh models sync                add them and refresh stale names\n  rdsh desktop status             detect the Desktop (Electron) app and its reserved profile\n  rdsh desktop install            attach the bundled rdsh plugins to that profile\n  rdsh plugins status             what a profile still misses (essential tier, read-only)\n  rdsh plugins install --profile web   attach the essential plugins after an upgrade\n  rdsh --passthrough tui          no slim env; only rdsh_inspect stays isolated\n  rdsh --dry-run tui -- --resume abc   show what would exec"
)]
pub(crate) struct Cli {
    /// Explicitly share a project file with isolated model tools (repeatable).
    #[arg(long = "share-file", global = true)]
    pub(crate) share_file: Vec<String>,
    #[arg(long = "passthrough", global = true)]
    pub(crate) passthrough: bool,
    #[arg(long = "dry-run", global = true)]
    pub(crate) dry_run: bool,
    /// Force slim delegation (default follows settings general.slim).
    #[arg(long = "slim", default_value_t = false, global = true)]
    pub(crate) slim: bool,
    #[arg(long = "no-slim", global = true)]
    pub(crate) no_slim: bool,
    #[arg(long = "patch", global = true)]
    pub(crate) patch: Vec<String>,
    #[arg(long = "profile", global = true)]
    pub(crate) profile: Option<String>,
    /// Product language for rdsh-owned human-readable output (en, zh-CN, ja).
    #[arg(long = "language", global = true, value_parser = ["en", "zh-CN", "ja"])]
    pub(crate) language: Option<String>,
    #[command(subcommand)]
    pub(crate) command: Option<Commands>,
    #[arg(trailing_var_arg = true, allow_hyphen_values = true)]
    pub(crate) extra: Vec<String>,
}

#[derive(Subcommand, Debug)]
pub(crate) enum ProviderAction {
    /// Built-in presets and, per profile, whether each route and its key exist
    List {
        #[arg(long = "json")]
        json: bool,
    },
    /// Detect provider credentials and local servers on this machine
    Detect {
        #[arg(long = "json")]
        json: bool,
    },
    /// Register the routes detection found, reading models from GET /models
    Import {
        #[arg(long = "profile")]
        profile: Option<String>,
        /// Only these route ids or presets (repeatable)
        #[arg(long = "only")]
        only: Vec<String>,
        /// Do not read model ids from the endpoint
        #[arg(long = "no-discover")]
        no_discover: bool,
        #[arg(long = "json")]
        json: bool,
    },
    /// Add a route to a profile's cordis.patch.yml (llm-pi-ai providers)
    Add {
        /// Preset: mistral, hai, sarashina or local-openai
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
        /// Reasoning levels for every model of the route, e.g. low,medium,high (or none)
        #[arg(long = "effort")]
        effort: Option<String>,
        /// Do not read model capabilities from an Ollama /api/show
        #[arg(long = "no-probe")]
        no_probe: bool,
        /// Input modalities for every model: text,image (text is required)
        #[arg(long = "input")]
        input: Option<String>,
        /// Rewrite the route block when it already exists
        #[arg(long = "replace")]
        replace: bool,
        #[arg(long = "json")]
        json: bool,
    },
}

#[derive(Subcommand, Debug)]
pub(crate) enum Commands {
    /// Delegate swarm orchestration to a pinned Gas City executable.
    Swarm {
        #[command(flatten)]
        options: swarm::SwarmOptions,
        #[command(subcommand)]
        action: swarm::SwarmAction,
    },
    /// Manage opt-in Agent Sandbox claims and cloud execution.
    Cloud {
        #[command(flatten)]
        options: cloud::CloudOptions,
        #[command(subcommand)]
        action: cloud::CloudAction,
    },
    /// Print the fixed dashboard CLI adapter catalog as JSON.
    AdapterCatalog,
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
    /// Web search through SearXNG by default; Ollama and Keenable are explicit hosted providers
    #[command(name = "search-web", after_help = websearch::help(locale::Locale::English))]
    SearchWeb {
        query: String,
        /// Search provider; Keenable sends queries to its hosted search API.
        #[arg(long, value_enum, default_value = "searxng")]
        provider: websearch::Provider,
        /// SearXNG-compatible engine: auto (env, then local rustxng), searxng
        /// (never spawns rustxng), or rustxng (never another engine).
        #[arg(long, value_enum, default_value = "auto")]
        engine: websearch::Engine,
        /// Result limit (default: settings search.web_limit).
        #[arg(long = "limit")]
        limit: Option<usize>,
        #[arg(long = "json")]
        json: bool,
        /// Start the shipped local SearXNG compose service when it is down
        /// (SearXNG provider, loopback endpoint only).
        #[arg(long = "auto-start")]
        auto_start: bool,
    },
    Compact {
        file: String,
        /// Token budget (default: settings compact.max_tokens).
        #[arg(long = "max-tokens")]
        max_tokens: Option<usize>,
    },
    /// Inspect Native Compaction metadata and evaluate compaction costs.
    Compaction {
        #[command(subcommand)]
        action: compaction_cli::Action,
    },
    /// Diagnose the local DSH installation without changing settings.
    Doctor {
        /// Metadata-only JSON; does not read credentials or launch DSH/Node.
        #[arg(long)]
        json: bool,
    },
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
    /// Native Rust reasoning loop, tools and approvals with an independent Web GUI.
    #[command(name = "native-web")]
    NativeWeb {
        #[arg(long, default_value_t = 8791)]
        port: u16,
        #[arg(long)]
        workspace: std::path::PathBuf,
        #[arg(long = "sdk-dir")]
        sdk_dir: Option<std::path::PathBuf>,
        #[arg(long = "dsh-profile")]
        dsh_profile: Option<String>,
        #[arg(long = "dsh-catalog")]
        dsh_catalog: Option<std::path::PathBuf>,
        #[arg(long = "devin-bin")]
        devin_bin: Option<std::path::PathBuf>,
    },
    /// Rust-owned terminal UI with native or DSH tools/plugins backend.
    #[command(name = "native-tui")]
    NativeTui {
        #[arg(long, default_value = "native", value_parser = ["native", "dsh"], help = "Terminal harness backend: Rust native or installed DSH")]
        backend: String,
        #[arg(long)]
        workspace: std::path::PathBuf,
        #[arg(long = "sdk-dir")]
        sdk_dir: Option<std::path::PathBuf>,
        #[arg(long = "dsh-profile")]
        dsh_profile: Option<String>,
        #[arg(long = "dsh-catalog")]
        dsh_catalog: Option<std::path::PathBuf>,
        #[arg(long = "devin-bin")]
        devin_bin: Option<std::path::PathBuf>,
        #[arg(long, requires = "model")]
        provider: Option<String>,
        #[arg(long, requires = "provider")]
        model: Option<String>,
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
    /// Internal JSON bridge for dashboard Git observations
    #[command(name = "worker-git", hide = true)]
    WorkerGit,
    /// Inventory, select and import only explicitly shared credentials
    Auth(auth_sharing::AuthArgs),
    /// Register an OpenAI-compatible endpoint (HAI, a home LLM server) as a
    /// dsh route in a profile: `provider list`, `provider add mistral|hai|sarashina|local-openai`
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
        /// Do not register the routes detection finds (dry-run does it too)
        #[arg(long = "no-auto-import")]
        no_auto_import: bool,
    },
    Bench {
        /// Iterations (default: settings bench.n).
        #[arg(long = "n")]
        n: Option<u32>,
    },
    /// Context engine (experimental): assemble or inject per-turn context, memory, hooks
    Context {
        #[command(subcommand)]
        action: ContextAction,
    },
    /// Static code-dependency graph: persistent index, symbol lookup, change impact
    Deps {
        #[command(subcommand)]
        action: DepsAction,
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
    /// Local rustxng sidecar (single-binary SearXNG-compatible engine):
    /// status, start (on demand) or stop the instance rdsh recorded
    #[command(name = "rustxng")]
    Rustxng {
        #[command(subcommand)]
        action: RustxngAction,
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
    /// Report which essential and recommended plugins a profile is missing,
    /// or attach them without the checkout. The essential tier only lived in
    /// plugins/install.sh, which nothing runs by itself, so an upgraded binary
    /// left the profile manifest untouched and missed every essential package
    #[command(name = "plugins")]
    Plugins {
        #[command(subcommand)]
        action: Option<PluginsAction>,
        /// Machine-readable output (same as the subcommand flag)
        #[arg(long = "json")]
        json: bool,
    },
    /// Files a session declared as deliverables: list them, or save a copy
    Files {
        #[command(subcommand)]
        action: FilesAction,
    },
    /// Keep a CLI-backed provider's model list in step with the local CLI
    /// catalog (Codex today), so a model released after the harness was built
    /// still reaches the model picker
    Models {
        #[command(subcommand)]
        action: Option<ModelsAction>,
        /// Restrict to one provider (default: every source this build reads)
        #[arg(long = "provider")]
        provider: Option<String>,
        /// Machine-readable output
        #[arg(long = "json")]
        json: bool,
    },
}

#[derive(Subcommand, Debug)]
pub(crate) enum PluginsAction {
    /// Read-only: what the profile has, and the exact command that fixes a gap
    Status {
        /// rustdsh checkout (or its plugins/) that carries the bundled plugins
        #[arg(long = "plugins-dir")]
        plugins_dir: Option<String>,
        #[arg(long = "json")]
        json: bool,
    },
    /// Attach the missing essential plugins (and the selected recommended set)
    Install {
        /// Print the commands without running them
        #[arg(long = "dry-run")]
        dry_run: bool,
        /// rustdsh checkout (or its plugins/) that carries the bundled plugins
        #[arg(long = "plugins-dir")]
        plugins_dir: Option<String>,
        /// none | all | starter | id,id (default: the starter set on web/desktop)
        #[arg(long = "recommended")]
        recommended: Option<String>,
        /// Skip the bundled rdsh plugins: a release-only install has no checkout
        #[arg(long = "no-bundled")]
        no_bundled: bool,
        /// Without a checkout, take the plugins of the latest release instead
        /// of the running rdsh's tag
        #[arg(long = "latest")]
        latest: bool,
        #[arg(long = "json")]
        json: bool,
    },
    /// Bring the release copy of the bundled plugins to the latest release
    Update {
        /// Only report installed / latest / update available; change nothing
        #[arg(long = "check")]
        check: bool,
        #[arg(long = "json")]
        json: bool,
        /// Worker for the automatic update (started by rdsh itself)
        #[arg(long = "background", hide = true)]
        background: bool,
    },
}

#[derive(Subcommand, Debug)]
pub(crate) enum FilesAction {
    /// Files the session declared with `present`, newest session by default
    List {
        /// Session id (default: the most recently written transcript)
        #[arg(long)]
        session: Option<String>,
        #[arg(long)]
        json: bool,
    },
    /// Copy one declared file to this machine (the working directory by default)
    Get {
        /// Absolute path reported by `rdsh files list`
        path: String,
        /// Destination file (default: its basename in the working directory)
        #[arg(long)]
        out: Option<String>,
        #[arg(long)]
        session: Option<String>,
        /// Copy any readable file, not only one the session declared
        #[arg(long)]
        force: bool,
    },
}

#[derive(Subcommand, Debug)]
pub(crate) enum ModelsAction {
    /// Append the models the local CLI advertises that the profile lacks
    Sync {
        #[arg(long = "profile")]
        profile: Option<String>,
        /// Restrict to one provider (default: every source this build reads)
        #[arg(long = "provider")]
        provider: Option<String>,
        /// Print what would change without writing the profile
        #[arg(long = "dry-run")]
        dry_run: bool,
        /// Non-interactive run for the daily auto-update timer: a no-op that
        /// exits 0 when `features.models_sync` is off, and never a failing
        /// status
        #[arg(long = "auto")]
        auto: bool,
        #[arg(long = "json")]
        json: bool,
    },
    /// Fill the reasoning levels an Ollama route publishes but the profile
    /// never stored; existing hand-picked levels are left alone
    Efforts {
        #[arg(long = "profile")]
        profile: Option<String>,
        /// Restrict to one route id (ollama, ollama-cloud)
        #[arg(long = "provider")]
        provider: Option<String>,
        /// Print what would change without writing the profile
        #[arg(long = "dry-run")]
        dry_run: bool,
        #[arg(long = "json")]
        json: bool,
    },
}

#[derive(Subcommand, Debug)]
pub(crate) enum WorkerScopeAction {
    /// Read a JSON array of declarations and write JSON result records.
    Validate,
    /// Evaluate write paths, scope intersections, and shared-file policy in one batch.
    Policy,
}

#[derive(Subcommand, Debug)]
pub(crate) enum RustxngAction {
    /// Show the resolved binary, URL, running state and the missing-binary hint
    Status {
        #[arg(long = "json")]
        json: bool,
    },
    /// Start the sidecar when nothing healthy is listening (reuses one that is)
    Start,
    /// Terminate the instance recorded in $DSH_HOME
    Stop,
    /// Install the sidecar binary from the latest RustXNG release
    Install,
    /// Update the rdsh-installed sidecar to the latest RustXNG release
    Update {
        /// Only report installed / latest / update available; change nothing
        #[arg(long = "check")]
        check: bool,
        #[arg(long = "json")]
        json: bool,
        /// Worker for the automatic update (started by rdsh itself)
        #[arg(long = "background", hide = true)]
        background: bool,
    },
}

#[derive(Subcommand, Debug)]
pub(crate) enum DesktopAction {
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
        /// Skip the default sound notifications (github:cwd514/dsh-sound-notifications)
        #[arg(long = "no-sound")]
        no_sound: bool,
        /// Skip the default Git panel (github:yugapor/dsh-gitview)
        #[arg(long = "no-gitview")]
        no_gitview: bool,
        /// Skip the bundled visual answers plugin (dsh-intelligent-ui)
        #[arg(long = "no-intelligent-ui")]
        no_intelligent_ui: bool,
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
    /// Keep the native client's local Web UI running from login (opt-in)
    #[command(name = "web-ui")]
    WebUi {
        #[command(subcommand)]
        action: WebUiAction,
    },
}

#[derive(Subcommand, Debug)]
pub(crate) enum WebUiAction {
    /// Show whether the Web UI service is installed, enabled and running
    Status {
        #[arg(long = "json")]
        json: bool,
    },
    /// Write the user unit and start the Web UI now and at login
    On {
        #[arg(long = "json")]
        json: bool,
    },
    /// Stop the Web UI and remove its autostart link
    Off {
        #[arg(long = "json")]
        json: bool,
    },
}

#[derive(Subcommand, Debug)]
pub(crate) enum FeaturesAction {
    /// Enable one feature: rdsh features on discord
    On { id: String },
    /// Disable one feature: rdsh features off discord
    Off { id: String },
}

#[derive(Subcommand, Debug)]
pub(crate) enum SubagentsAction {
    /// Build a dispatch plan from a request JSON file (docs/SUBAGENT-PLANNING.md)
    Plan {
        /// Request JSON file
        #[arg(long = "input-file")]
        input_file: String,
        /// JSON output (the default; accepted for script compatibility)
        #[arg(long = "json")]
        json: bool,
    },
    /// Print the limits a plan request inherits when it omits limits
    /// (the subagents section of rdsh.json; docs/SUBAGENT-PLANNING.md)
    Defaults {
        /// JSON output (the default; accepted for script compatibility)
        #[arg(long = "json")]
        json: bool,
    },
}

#[derive(Subcommand, Debug)]
pub(crate) enum UpdateAction {
    /// Daily auto-update timer for released rdsh/dsh versions
    Auto {
        #[command(subcommand)]
        action: AutoAction,
    },
}

#[derive(Subcommand, Debug)]
pub(crate) enum AutoAction {
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
        /// Register the sync script even when it is not owned by you or is
        /// group/world-writable
        #[arg(long = "force")]
        force: bool,
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
pub(crate) enum ContextAction {
    /// Assemble the context to pass to the LLM this turn (prototype)
    Build {
        #[arg(long = "query")]
        query: Option<String>,
        #[arg(long = "budget")]
        budget: Option<usize>,
        /// Past sessions to carry over (overrides settings context.max_sessions)
        #[arg(long = "sessions")]
        sessions: Option<usize>,
        /// Exit 3 when the repository changed while the context was assembled
        #[arg(long = "require-stable")]
        require_stable: bool,
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
    /// Emit the hook JSON that injects this turn's context (DSH UserPromptSubmit)
    Inject {
        /// Hook event: user-prompt-submit (default) or session-start
        #[arg(long = "event", default_value = "user-prompt-submit")]
        event: String,
        /// Prompt text; without it the hook payload on stdin is used
        #[arg(long = "query")]
        query: Option<String>,
        /// Past sessions to carry over (default: settings context.inject_session_count)
        #[arg(long = "sessions")]
        sessions: Option<usize>,
        /// Add diagnostics to the emitted JSON (never changes additionalContext)
        #[arg(long = "json")]
        json: bool,
    },
    /// Remember one item: goal / decision / constraint / task / file / note
    Remember {
        text: String,
        /// Item kind (default: note)
        #[arg(long = "kind")]
        kind: Option<String>,
        #[arg(long = "json")]
        json: bool,
    },
    /// List remembered items (active and superseded)
    Memory {
        #[arg(long = "json")]
        json: bool,
    },
    /// Extract memory candidates from a session transcript (dry-run by default)
    Distill {
        /// Transcript path (default: newest session under $DSH_HOME/sessions)
        #[arg(long = "session")]
        session: Option<String>,
        /// Write the extracted items into the memory store
        #[arg(long = "apply")]
        apply: bool,
        #[arg(long = "json")]
        json: bool,
    },
    /// Drop one remembered item from the active set (history is kept)
    Forget {
        id: String,
        #[arg(long = "json")]
        json: bool,
    },
    /// Install the inject hook into a DSH hooks.json (idempotent)
    Hook {
        #[command(subcommand)]
        action: HookAction,
    },
}

#[derive(Subcommand, Debug)]
pub(crate) enum HookAction {
    /// Add the UserPromptSubmit entry that calls rdsh context inject
    Install {
        /// Hook config path (default: $DSH_HOME/hooks.json)
        #[arg(long = "path")]
        path: Option<String>,
        /// rdsh binary to reference (default: rdsh, resolved from PATH)
        #[arg(long = "rdsh")]
        rdsh: Option<String>,
        /// Print the resulting file without writing it
        #[arg(long = "dry-run")]
        dry_run: bool,
        #[arg(long = "json")]
        json: bool,
    },
    /// Show whether the entry is present
    Status {
        #[arg(long = "path")]
        path: Option<String>,
        #[arg(long = "json")]
        json: bool,
    },
    /// Remove the entry (other hooks are left untouched)
    Remove {
        #[arg(long = "path")]
        path: Option<String>,
        #[arg(long = "dry-run")]
        dry_run: bool,
        #[arg(long = "json")]
        json: bool,
    },
}

#[derive(Subcommand, Debug)]
pub(crate) enum DepsAction {
    /// Build or refresh the persistent dependency index
    Build {
        /// Repository root (default: the current directory)
        #[arg(long = "root")]
        root: Option<String>,
        /// Re-parse every file instead of reusing unchanged entries
        #[arg(long = "force")]
        force: bool,
        #[arg(long = "json")]
        json: bool,
    },
    /// Show where a symbol is defined and referenced
    Query {
        symbol: String,
        #[arg(long = "json")]
        json: bool,
    },
    /// List what depends on a file or symbol, and the tests that cover it
    Impact {
        target: String,
        /// Transitive depth (default 3, max 8)
        #[arg(long = "depth")]
        depth: Option<usize>,
        #[arg(long = "json")]
        json: bool,
    },
}

#[derive(Subcommand, Debug)]
pub(crate) enum SettingsAction {
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
pub(crate) const NATIVE_FIRST: &[&str] = &[
    "swarm",
    "cloud",
    "adapter-catalog",
    "boot",
    "dump-config",
    "tokens",
    "prune",
    "search",
    "compact",
    "doctor",
    "bench",
    "serve",
    "native-web",
    "native-tui",
    "sessions",
    "profiles",
    "skills",
    "logs",
    "guard",
    "compute",
    "desktop",
    "plugins",
    "auth",
    "provider",
    "setup",
    "search-web",
    "rustxng",
    "context",
    "deps",
    "settings",
    "features",
    "cost-ledger",
    "models",
    "files",
    "update",
    "serial-proxy",
    "worker-git",
    "subagents",
    "task-outcomes",
    "budget-admission",
    "compaction",
    "question-contracts",
    "answer-applications",
    "instruction-queue",
    "worker-scope",
];

pub(crate) fn parse_cli(locale: locale::Locale) -> Cli {
    let command = localized_command(locale);
    let matches = match command.try_get_matches() {
        Ok(matches) => matches,
        Err(error) => exit_clap_error(locale, error),
    };
    Cli::from_arg_matches(&matches).unwrap_or_else(|error| exit_clap_error(locale, error))
}

/// Keep Clap's detailed parse output intact while leading with rdsh-owned text
/// selected from its structured error kind.
pub(crate) fn exit_clap_error(locale: locale::Locale, error: clap::Error) -> ! {
    use clap::error::ErrorKind;

    if matches!(
        error.kind(),
        ErrorKind::DisplayHelp | ErrorKind::DisplayVersion
    ) {
        error.exit();
    }
    let description = match error.kind() {
        ErrorKind::InvalidValue | ErrorKind::ValueValidation => crate::locale::pick(
            locale,
            "an argument value is invalid",
            "参数值无效",
            "引数の値が無効です",
        ),
        ErrorKind::UnknownArgument | ErrorKind::InvalidSubcommand => crate::locale::pick(
            locale,
            "an argument or command is not recognized",
            "无法识别参数或命令",
            "引数またはコマンドを認識できません",
        ),
        ErrorKind::NoEquals
        | ErrorKind::TooManyValues
        | ErrorKind::TooFewValues
        | ErrorKind::WrongNumberOfValues => crate::locale::pick(
            locale,
            "the number or form of argument values is invalid",
            "参数值的数量或形式无效",
            "引数の値の数または形式が無効です",
        ),
        ErrorKind::ArgumentConflict => crate::locale::pick(
            locale,
            "conflicting arguments were provided",
            "提供的参数相互冲突",
            "競合する引数が指定されました",
        ),
        ErrorKind::MissingRequiredArgument | ErrorKind::MissingSubcommand => crate::locale::pick(
            locale,
            "a required argument or command is missing",
            "缺少必需的参数或命令",
            "必須の引数またはコマンドがありません",
        ),
        ErrorKind::InvalidUtf8 => crate::locale::pick(
            locale,
            "an argument is not valid UTF-8",
            "参数不是有效的 UTF-8",
            "引数が有効な UTF-8 ではありません",
        ),
        ErrorKind::DisplayHelpOnMissingArgumentOrSubcommand => crate::locale::pick(
            locale,
            "a command or argument is required",
            "需要命令或参数",
            "コマンドまたは引数が必要です",
        ),
        ErrorKind::Io | ErrorKind::Format | ErrorKind::DisplayHelp | ErrorKind::DisplayVersion => {
            crate::locale::pick(
                locale,
                "the command-line parser could not format its output",
                "命令行解析器无法格式化输出",
                "コマンドライン解析器が出力を整形できません",
            )
        }
        _ => crate::locale::pick(
            locale,
            "the command-line parser rejected the arguments",
            "命令行解析器拒绝了参数",
            "コマンドライン解析器が引数を拒否しました",
        ),
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

pub(crate) fn localized_command(locale: locale::Locale) -> clap::Command {
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
            let help = if name == "native-tui" && id == "backend" {
                match locale {
                    locale::Locale::Chinese => "终端运行后端：Rust native 或现有 DSH",
                    locale::Locale::Japanese => "端末の実行バックエンド: Rust native または既存DSH",
                    locale::Locale::English => unreachable!(),
                }
            } else if name == "native-tui" && id == "dsh_profile" {
                match locale {
                    locale::Locale::Chinese => "native读取模型注册；DSH模式启动此配置文件",
                    locale::Locale::Japanese => {
                        "nativeではモデル登録を読取、DSHではこのプロファイルを起動"
                    }
                    locale::Locale::English => unreachable!(),
                }
            } else if name == "cost-ledger" && id == "action" {
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
        .mut_subcommands(|subcommand| {
            let subcommand = localize_command_tree(subcommand, locale);
            let about = match (name.as_str(), subcommand.get_name(), locale) {
                ("swarm", "start", locale::Locale::Japanese) => Some("Gas Cityを起動"),
                ("swarm", "stop", locale::Locale::Japanese) => Some("Gas Cityを停止"),
                ("swarm", "start", locale::Locale::Chinese) => Some("启动 Gas City"),
                ("swarm", "stop", locale::Locale::Chinese) => Some("停止 Gas City"),
                _ => None,
            };
            match about {
                Some(about) => subcommand.about(about),
                None => subcommand,
            }
        });
    if let Some(after_help) = localized_after_help(&name, locale) {
        command.after_help(after_help)
    } else {
        command
    }
}

fn localized_command_about(name: &str, locale: locale::Locale) -> Option<&'static str> {
    let (chinese, japanese) = match name {
        "swarm" => (
            "委托固定版本的 Gas City 管理集群",
            "固定版Gas Cityへスウォーム管理を委譲",
        ),
        "cloud" => (
            "管理可选的 Agent Sandbox 云执行环境",
            "任意設定のAgent Sandboxクラウド実行環境を管理",
        ),
        "pool" => ("规划或应用 SandboxWarmPool", "SandboxWarmPoolを計画・適用"),
        "capacity" => ("读取云端容量", "クラウド容量を読み取る"),
        "acquire" => ("为一次尝试领取 Sandbox", "Attempt用Sandboxを確保"),
        "exec" => ("在 Sandbox 中执行一次命令", "Sandbox内でコマンドを1回実行"),
        "inspect" => ("读取 Sandbox 租约状态", "SandboxのLease状態を読み取る"),
        "release" => ("请求释放 Sandbox", "Sandboxの解放を要求"),
        "reconcile" => ("核对未知 Sandbox 状态", "不明なSandbox状態を照合"),
        "load-test" => (
            "使用 Fake Backend 测试控制面",
            "Fake Backendで制御面を負荷試験",
        ),
        "apply" => ("应用已审核的资源计划", "確認済みの資源計画を適用"),
        "rdsh" => (
            "dsh 的 Rust 快速启动器（安全：原生快速路径与透传）",
            "dsh のRust高速ランチャー（安全: ネイティブ高速パスと透過実行）",
        ),
        "adapter-catalog" => (
            "以 JSON 输出仪表板 CLI 适配器的固定目录",
            "ダッシュボードCLIアダプターの固定カタログをJSONで出力",
        ),
        "tokens" => ("原生估算输入令牌数", "入力トークン数をネイティブで推定"),
        "search" => ("高速文件搜索", "高速ファイル検索"),
        "search-web" => (
            "默认使用 SearXNG；可显式选择 Ollama API 或 Keenable 网页搜索",
            "SearXNG が既定です。Ollama API または Keenable は明示選択でWeb検索",
        ),
        "rustxng" => (
            "本地 rustxng 边车（兼容 SearXNG 的单文件引擎）",
            "ローカル rustxng サイドカー（SearXNG互換の単一バイナリエンジン）",
        ),
        "start" => (
            "启动边车（已有健康实例则复用）",
            "サイドカーを起動（健全な既存インスタンスは再利用）",
        ),
        "stop" => (
            "终止 $DSH_HOME 记录的实例",
            "$DSH_HOME に記録したインスタンスを終了",
        ),
        "native-tui" => (
            "启动 Rust 终端界面（native / DSH 工具与插件）",
            "Rust製の端末UIを起動（native / DSHツール・プラグイン）",
        ),
        "native-web" => (
            "启动 Rust 原生推理、工具与审批的独立网页界面",
            "Rust製の推論・ツール・承認を備えた独立Web GUIを起動",
        ),
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
        "detect" => (
            "检测本机的提供方凭据与本地服务器",
            "手元のプロバイダー資格情報とローカルサーバーを検出",
        ),
        "import" => (
            "把检测到的路由写入配置文件并取得模型",
            "検出した経路を設定へ書き込み、モデルを取得",
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
        "defaults" => (
            "输出分派计划继承的默认上限",
            "割り当て計画が継承する既定の上限を出力",
        ),
        "budget-admission" => (
            "应用、验证预算准入记录或输出公开视图",
            "予算受付記録を適用・検証し公開表示を出力",
        ),
        "question-contracts" => (
            "应用、验证问题契约或输出公开视图",
            "質問契約を適用・検証し公開表示を出力",
        ),
        "answer-applications" => (
            "应用、验证回答或输出公开视图与 JSON schema",
            "回答適用を実行・検証し公開表示やJSONスキーマを出力",
        ),
        "instruction-queue" => (
            "验证、提交、解决或控制指令队列",
            "指示キューを検証・送信・解決・制御",
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
        "plugins" => (
            "查看或补装配置文件缺少的必需/推荐插件",
            "プロファイルに不足している必須・推奨プラグインの表示と補完",
        ),
        "web-ui" => (
            "本地 Web UI 的常时启动（默认关闭）",
            "ローカルWeb UIの常時起動（既定はオフ）",
        ),
        "deps" => (
            "静态代码依赖图（rdsh deps）",
            "静的なコード依存グラフ（rdsh deps）",
        ),
        "worker-git" => (
            "在受限工作区中运行的 git 工作进程",
            "制限された作業ツリーで実行する git ワーカー",
        ),
        "inject" => ("向 hook 注入上下文", "フックにコンテキストを注入"),
        "remember" => ("记住一条上下文条目", "コンテキスト項目を記憶"),
        "memory" => ("管理记忆的上下文条目", "記憶したコンテキスト項目を管理"),
        "distill" => ("从会话提炼上下文", "セッションからコンテキストを抽出"),
        "forget" => ("删除记忆的上下文条目", "記憶したコンテキスト項目を削除"),
        "hook" => (
            "安装、确认或移除 context hook",
            "contextフックの導入・確認・削除",
        ),
        "remove" => ("移除 hook/plugin 条目", "フック/プラグイン項目を削除"),
        "query" => ("查询依赖图中的符号", "依存グラフのシンボルを照会"),
        "impact" => ("显示受影响的文件", "影響を受けるファイルを表示"),
        "models" => ("查看与同步模型目录", "モデルカタログの表示と同期"),
        "files" => (
            "列出自会话的交付文件",
            "セッションが作った成果物の一覧と保存",
        ),
        "sync" => (
            "同步配置文件中的模型目录",
            "プロファイルのモデルカタログを同期",
        ),
        "efforts" => (
            "从 Ollama 补全缺失的推理强度",
            "Ollamaが公開する推論段階で不足分を補完",
        ),
        "prune" => ("将文本裁剪到令牌预算", "テキストをトークン予算まで切り詰め"),
        "compact" => ("压缩文本文件", "テキストファイルを圧縮"),
        "compaction" => ("检查会话压缩与费用", "履歴圧縮の記録と費用を確認"),
        "report" => ("只读汇总压缩记录", "圧縮記録を読み取り専用で集計"),
        "decide" => ("计算提前压缩的费用", "早期圧縮の費用を計算"),
        "capabilities" => ("显示支持的压缩方式", "対応する圧縮方式を表示"),
        "doctor" => ("显示诊断摘要", "診断サマリーを表示"),
        "bench" => ("运行启动基准测试", "起動ベンチマークを実行"),
        "boot" => ("启动 dsh 配置文件", "dshプロファイルを起動"),
        "dump-config" => ("输出有效配置", "有効な設定を出力"),
        "build" => ("构建本轮的上下文", "このターンのコンテキストを構築"),
        "status" => ("显示状态", "状態を表示"),
        "explain" => ("解释上下文内容", "コンテキスト内容を説明"),
        "show" => ("显示当前设置", "現在の設定を表示"),
        "path" => ("显示设置文件路径", "設定ファイルのパスを表示"),
        "init" => ("初始化设置或 Gas City", "設定またはGas Cityを初期化"),
        "get" => ("读取一个设置值", "設定値を1つ読み取る"),
        "set" => ("写入一个设置值", "設定値を1つ書き込む"),
        "unset" => ("将设置重置为默认值", "設定を既定値に戻す"),
        "keys" => ("列出可编辑的设置键", "編集可能な設定キーを一覧"),
        "on" => ("启用", "有効にする"),
        "off" => ("禁用", "無効にする"),
        "install" => ("安装插件", "プラグインを導入"),
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
    if name == "search-web" {
        return Some(websearch::help(locale));
    }
    (name == "rdsh").then(|| match locale {
                locale::Locale::Chinese => "用法：\n  rdsh [profile] [--profile <name>] [--patch <yml>...] [app-args...]\n  rdsh <native-subcommand> ...   (swarm|cloud|adapter-catalog|tokens|prune|search|search-web|rustxng|compact|compaction|doctor|bench|serve|native-web|native-tui|sessions|profiles|skills|logs|guard|compute|desktop|plugins|auth|setup|context|settings|features|provider|subagents|task-outcomes|budget-admission|cost-ledger|question-contracts|answer-applications|instruction-queue|update|worker-scope|dump-config|boot|serial-proxy)\n\n示例：\n  rdsh tui                        启动 tui 配置文件（slim 环境开启，委托给 dsh）\n  rdsh --profile web --patch x.yml 使用叠加层启动 web\n  rdsh dump-config --profile tui  委托 dsh 输出准确配置\n  rdsh tokens ./AGENTS.md         原生估算输入令牌数\n  rdsh auth --import --provider openai-codex   只导入选定提供方\n  rdsh provider list              查看预设、路由和密钥状态\n  rdsh provider add hai --model deepseek-v4-flash   注册 HAI 路由\n  rdsh setup                      首次连接：选择共享、登录流程和后续步骤\n  rdsh search hello --dir .       无 Node 的快速文件搜索\n  rdsh search-web \"rust async\"      通过 SearXNG 网页搜索（无需 API 密钥）\n  rdsh desktop status             检测 Desktop（Electron）应用及其保留配置文件\n  rdsh desktop install            将捆绑 rdsh 插件附加到该配置文件\n  rdsh plugins status             查看配置文件仍缺少哪些必需插件（只读）\n  rdsh plugins install --profile web   升级后补装必需插件\n  rdsh --passthrough tui          不使用 slim 环境；必需的工具隔离仍会启用\n  rdsh --dry-run tui -- --resume abc   显示将执行的命令",
                locale::Locale::Japanese => "使い方：\n  rdsh [profile] [--profile <name>] [--patch <yml>...] [app-args...]\n  rdsh <native-subcommand> ...   (swarm|cloud|adapter-catalog|tokens|prune|search|search-web|rustxng|compact|compaction|doctor|bench|serve|native-web|native-tui|sessions|profiles|skills|logs|guard|compute|desktop|plugins|auth|setup|context|settings|features|provider|subagents|task-outcomes|budget-admission|cost-ledger|question-contracts|answer-applications|instruction-queue|update|worker-scope|dump-config|boot|serial-proxy)\n\n例：\n  rdsh tui                        tuiプロファイルを起動（slim環境ON、dshへ委譲）\n  rdsh --profile web --patch x.yml オーバーレイ付きでwebを起動\n  rdsh dump-config --profile tui  dshへ正確な設定出力を委譲\n  rdsh tokens ./AGENTS.md         入力トークン数をネイティブで推定\n  rdsh auth --import --provider openai-codex   選択したプロバイダーだけをインポート\n  rdsh provider list              プリセット・経路・キーの状態を確認\n  rdsh provider add hai --model deepseek-v4-flash   HAI経路を登録\n  rdsh setup                      初回接続: 共有の選択、ログイン手順、次のステップ\n  rdsh search hello --dir .       Nodeなしの高速ファイル検索\n  rdsh search-web \"rust async\"      SearXNGによるWeb検索（APIキー不要）\n  rdsh desktop status             Desktop（Electron）アプリと専用プロファイルを検出\n  rdsh desktop install            同プロファイルに同梱rdshプラグインを追加\n  rdsh plugins status             不足している必須プラグインを表示（読み取り専用）\n  rdsh plugins install --profile web   アップグレード後に必須プラグインを補完\n  rdsh --passthrough tui          slim環境なし。必須のツール分離は維持\n  rdsh --dry-run tui -- --resume abc   実行するコマンドを表示",
                locale::Locale::English => unreachable!(),
            })
}

fn localized_arg_help(id: &str, locale: locale::Locale) -> Option<&'static str> {
    let (chinese, japanese) = match id {
        "gc_binary" => (
            "固定 Gas City 可执行文件的绝对路径",
            "固定Gas City実行ファイルの絶対パス",
        ),
        "gc_sha256" => (
            "Gas City 可执行文件的 SHA-256",
            "Gas City実行ファイルのSHA-256",
        ),
        "city" => ("Gas City 目录的绝对路径", "Gas Cityディレクトリの絶対パス"),
        "backend" => ("云执行后端", "クラウド実行バックエンド"),
        "namespace" => ("Kubernetes 命名空间", "Kubernetes Namespace"),
        "pool" => ("SandboxWarmPool 名称", "SandboxWarmPool名"),
        "template" => ("SandboxTemplate 名称", "SandboxTemplate名"),
        "replicas" => ("预热 Sandbox 数量", "事前起動するSandbox数"),
        "plan_file" => ("资源计划 JSON 文件", "資源計画のJSONファイル"),
        "request_file" => ("Sandbox 请求 JSON 文件", "Sandbox要求のJSONファイル"),
        "lease_file" => ("Sandbox 租约 JSON 文件", "Sandbox LeaseのJSONファイル"),
        "jobs" => ("Fake Backend 任务数量", "Fake Backendのジョブ数"),
        "sessions" => ("保留最近的会话数", "保持する最近のセッション数"),
        "require_stable" => (
            "git 状态或读取的文件变化时以退出码 3 结束",
            "git状態や読み込み済みファイルが変化したら終了コード3で終了",
        ),
        "event" => ("hook 事件名称", "フックイベント名"),
        "text" => ("要记忆的文本", "記憶するテキスト"),
        "kind" => ("条目类型", "項目の種類"),
        "session" => ("会话文件", "セッションファイル"),
        "out" => ("保存目标路径", "保存先のパス"),
        "apply" => ("实际写入结果", "結果を実際に書き込む"),
        "path" => ("文件路径", "ファイルのパス"),
        "rdsh" => ("rdsh 可执行文件路径", "rdsh実行ファイルのパス"),
        "no_sound" => ("不安装声音通知插件", "サウンド通知プラグインを導入しない"),
        "no_gitview" => ("不安装 gitview 插件", "gitviewプラグインを導入しない"),
        "no_intelligent_ui" => (
            "不安装可视化回答插件",
            "ビジュアル回答プラグインを導入しない",
        ),
        "root" => ("项目根目录", "プロジェクトルート"),
        "symbol" => ("符号名称", "シンボル名"),
        "target" => ("目标符号或文件", "対象のシンボルまたはファイル"),
        "depth" => ("依赖图的遍历深度", "依存グラフの探索深度"),
        "share_file" => (
            "与隔离模型工具共享项目文件（可重复）",
            "隔離されたモデルツールとプロジェクトファイルを共有（繰り返し可）",
        ),
        "passthrough" => ("关闭 slim 委托", "slim委譲を無効化"),
        "dry_run" => ("只显示将要执行的操作", "実行せずに内容を表示"),
        "auto" => (
            "每日自动更新定时器使用；功能开关关闭时不执行任何操作并以 0 退出",
            "毎日の自動更新タイマー用。機能スイッチが無効なら何もせず0で終了",
        ),
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
        "check" => (
            "只报告已安装/最新/有可用更新，不下载也不替换",
            "導入済み/最新/更新ありの確認だけを行い、取得も置換もしない",
        ),
        "latest" => (
            "没有检出目录时，使用最新 release 的插件，而不是当前 rdsh 的标签",
            "チェックアウトが無いとき、実行中の rdsh のタグではなく最新 release のプラグインを使う",
        ),
        "background" => (
            "自动更新的后台工作进程（由 rdsh 自行启动）",
            "自動更新のバックグラウンドワーカー（rdsh が自分で起動）",
        ),
        "auto_start" => (
            "SearXNG 未启动时启动同梱的本地 compose 服务（仅回环地址）",
            "SearXNG が停止していれば同梱のローカル compose サービスを起動（ループバック限定）",
        ),
        "engine" => (
            "搜索引擎：auto（先环境变量后本地 rustxng）、searxng（不启动 rustxng）、rustxng",
            "エンジン: auto（環境変数の後にローカル rustxng）、searxng（rustxngを起動しない）、rustxng",
        ),
        "project" => ("按项目筛选", "プロジェクトで絞り込む"),
        "tokens" => ("估算会话令牌数", "セッショントークン数を推定"),
        "tail" => ("显示末尾行数", "末尾から表示する行数"),
        "grep" => ("仅显示匹配文本的行", "一致するテキストの行だけを表示"),
        "workspace" => ("明确授权的本地工作目录", "明示的に使用するローカル作業ディレクトリ"),
        "dsh_profile" => ("读取模型注册的 DSH 配置文件", "モデル登録を読むDSHプロファイル"),
        "dsh_catalog" => ("pi-ai JSON 模型目录", "pi-aiのJSONモデルカタログディレクトリ"),
        "sdk_dir" => ("官方 SDK 桥接目录", "公式SDKブリッジのディレクトリ"),
        "devin_bin" => ("Devin CLI 可执行文件", "Devin CLIの実行ファイル"),
        "port" => ("本地监听端口", "ローカル待受ポート"),
        "import" => ("导入选定凭据", "選択した認証情報をインポート"),
        "provider" => ("提供方标识", "プロバイダーID"),
        "source" => ("凭据来源", "認証情報のソース"),
        "key_ref" => ("凭据引用名称", "認証情報参照名"),
        "open" => ("打开设置目录", "設定ディレクトリを開く"),
        "preset" => (
            "提供方预设：mistral、hai、sarashina、local-openai、ollama",
            "プロバイダープリセット: mistral、hai、sarashina、local-openai、ollama",
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
        "only" => (
            "仅处理这些路由 id 或预设（可重复）",
            "これらの経路idまたはプリセットだけを対象にする（繰り返し可）",
        ),
        "no_discover" => (
            "不从端点读取模型清单",
            "エンドポイントからモデル一覧を取得しない",
        ),
        "input" => (
            "路由内所有模型的输入模态（如 text,image；text 必须包含）",
            "経路内の全モデルの入力モダリティ（例: text,image。text は必須）",
        ),
        "no_probe" => (
            "不读取 Ollama /api/show 的模型能力",
            "Ollama の /api/show からモデル能力を読まない",
        ),
        "no_auto_import" => (
            "不自动注册检测到的路由",
            "検出した経路を自動で登録しない",
        ),
        "effort" => (
            "路由内所有模型的推理强度（如 low,medium,high，或 none）",
            "経路内の全モデルの推論強度（例: low,medium,high、または none）",
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
        "recommended" => (
            "推荐插件的选择：none、all、starter 或逗号分隔的 id",
            "推奨プラグインの指定: none、all、starter、カンマ区切りのid",
        ),
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

#[cfg(test)]
mod cli_catalog_tests {
    use super::Cli;
    use clap::Parser;

    /// NATIVE_FIRST (used by dsh-shadowed dispatch) and the clap Commands
    /// enum must never drift apart: a missing name silently delegates a
    /// native subcommand to dsh instead of running it here.
    #[test]
    fn native_first_matches_subcommands() {
        use clap::error::ErrorKind;
        for name in super::NATIVE_FIRST {
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
                super::NATIVE_FIRST.contains(&name),
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
        for name in super::NATIVE_FIRST {
            if *name == "worker-git" {
                // Internal dashboard bridge is native-first but intentionally hidden from help.
                continue;
            }
            assert!(listed.contains(name), "after_help is missing {name:?}");
        }
    }
}

#[cfg(test)]
mod cli_tree_tests {
    #[test]
    fn every_generated_command_and_argument_id_has_a_localized_help_entry() {
        fn assert_tree(command: &clap::Command, locale: crate::locale::Locale) {
            assert!(
                super::localized_command_about(command.get_name(), locale).is_some(),
                "missing command description for {}",
                command.get_name()
            );
            for arg in command.get_arguments() {
                assert!(
                    super::localized_arg_help(arg.get_id().as_str(), locale).is_some(),
                    "missing argument description for {} in {}",
                    arg.get_id(),
                    command.get_name()
                );
            }
            for subcommand in command.get_subcommands() {
                assert_tree(subcommand, locale);
            }
        }

        let mut command = <super::Cli as clap::CommandFactory>::command();
        command.build();
        for locale in [
            crate::locale::Locale::Chinese,
            crate::locale::Locale::Japanese,
        ] {
            assert_tree(&command, locale);
        }
    }

    #[test]
    fn english_help_uses_the_derive_generated_tree_unchanged() {
        let mut generated = <super::Cli as clap::CommandFactory>::command();
        let mut localized = super::localized_command(crate::locale::Locale::English);
        assert_eq!(
            generated.render_long_help().to_string(),
            localized.render_long_help().to_string()
        );
    }
}
