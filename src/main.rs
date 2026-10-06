use clap::{Parser, Subcommand};
mod auth;
mod compact;
mod context;
mod dsh_args;
mod guard;
mod inspect;
mod local_http;
mod passthrough;
mod rdsh_config;
mod search;
mod serve;
mod setup_web;
mod slim;
mod tokens;
mod websearch;

#[derive(Parser, Debug)]
#[command(
    name = "rdsh",
    version,
    about = "Rust fast launcher for dsh (safe: native fast-paths + passthrough)"
)]
struct Cli {
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
enum Commands {
    Boot {
        #[arg(long = "profile")]
        profile: Option<String>,
        #[arg(long = "from-default-profile")]
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
    /// OAuth auto-recognition: external logins (codex/opencode) mirrored
    /// into $DSH_HOME/.credentials.yaml ("drop in and recognized")
    Auth {
        #[arg(long = "import")]
        import: bool,
        #[arg(long = "json")]
        json: bool,
    },
    /// First-run connect: import what exists, persist env keys, optionally
    /// run the provider login flow or reveal settings dirs, else show next step
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
    /// Hook helper for hooks.json: block stdin text matching --deny (exit 2)
    Guard {
        #[arg(long = "deny")]
        deny: Vec<String>,
        #[arg(long = "reason")]
        reason: Option<String>,
        #[arg(long = "json")]
        json: bool,
    },
    /// Unified rdsh settings (rdsh.json): show values, path, or write defaults
    Settings {
        #[command(subcommand)]
        action: SettingsAction,
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
    "auth",
    "setup",
    "search-web",
    "context",
    "settings",
];

fn invoked_as_dsh() -> bool {
    let argv0 = std::env::args().next().unwrap_or_default();
    std::path::Path::new(&argv0)
        .file_name()
        .and_then(|s| s.to_str())
        // Native Windows installs run as dsh.exe.
        .map(|s| s == "dsh" || s == "dsh.exe")
        .unwrap_or(false)
}

fn main() {
    if invoked_as_dsh() {
        let raw: Vec<String> = std::env::args().skip(1).collect();
        let first_is_native = raw
            .first()
            .map(|s| NATIVE_FIRST.contains(&s.as_str()))
            .unwrap_or(false);
        if !first_is_native {
            let scfg = rdsh_config::load();
            let slim =
                !passthrough::env_passthrough() && !scfg.general.passthrough && scfg.general.slim;
            let dry = passthrough::env_dry() || scfg.general.dry_run;
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
    let cfg = rdsh_config::load();
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
            websearch::cmd_search_web(&query, limit.unwrap_or(cfg.search.web_limit), json)
        }
        Some(Commands::Compact { file, max_tokens }) => {
            compact::cmd_compact(&file, max_tokens.unwrap_or(cfg.compact.max_tokens))
        }
        Some(Commands::Doctor) => doctor(),
        Some(Commands::Sessions {
            project,
            limit,
            tokens,
        }) => inspect::cmd_sessions(
            project,
            limit.unwrap_or(cfg.sessions.limit),
            tokens || cfg.sessions.with_tokens,
        ),
        Some(Commands::Profiles) => inspect::cmd_profiles(),
        Some(Commands::Skills) => inspect::cmd_skills(),
        Some(Commands::Logs { tail, grep, file }) => {
            inspect::cmd_logs(tail.unwrap_or(cfg.logs.tail), grep, file)
        }
        Some(Commands::Serve { port }) => serve::cmd_serve(port.unwrap_or(cfg.serve.port)),
        Some(Commands::Bench { n }) => bench(n.unwrap_or(cfg.bench.n)),
        Some(Commands::Guard { deny, reason, json }) => {
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
            guard::cmd_guard(merged, reason, json)
        }
        Some(Commands::Settings { action }) => match action {
            SettingsAction::Path => {
                println!("{}", rdsh_config::settings_path());
                Ok(())
            }
            SettingsAction::Show { json } => {
                let cfg = rdsh_config::load();
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
                    println!("config: {}", rdsh_config::settings_path());
                    match v.as_object() {
                        Some(map) => {
                            for k in map.keys() {
                                println!("- {k}");
                            }
                            Ok(())
                        }
                        None => Err(anyhow::anyhow!("settings did not render as an object")),
                    }
                }
            }
            SettingsAction::Init { force } => {
                let path = rdsh_config::settings_path();
                if std::path::Path::new(&path).exists() && !force {
                    eprintln!("[rdsh] settings already exist at {path} (use --force to overwrite)");
                    std::process::exit(2);
                }
                match rdsh_config::RdshSettings::default().save() {
                    Ok(()) => {
                        println!("{path}");
                        Ok(())
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
                let mut cfg = rdsh_config::load();
                if let Err(e) = cfg.set_dotted(&key, &value) {
                    Err(e)
                } else if let Err(e) = cfg.save() {
                    Err(e)
                } else {
                    match cfg.get_dotted(&key) {
                        Some(v) => {
                            if v.is_string() {
                                println!("{}={}", key.trim(), v.as_str().unwrap_or_default());
                                Ok(())
                            } else {
                                match serde_json::to_string(&v) {
                                    Ok(text) => {
                                        println!("{}={}", key.trim(), text);
                                        Ok(())
                                    }
                                    Err(e) => Err(anyhow::anyhow!(e)),
                                }
                            }
                        }
                        None => Err(anyhow::anyhow!("set failed: {key}")),
                    }
                }
            }
            SettingsAction::Unset { key } => {
                let mut cfg = rdsh_config::load();
                if let Err(e) = cfg.reset_dotted(&key) {
                    Err(e)
                } else if let Err(e) = cfg.save() {
                    Err(e)
                } else {
                    println!(
                        "reset {} (saved to {})",
                        key.trim(),
                        rdsh_config::settings_path()
                    );
                    Ok(())
                }
            }
            SettingsAction::Keys => {
                for k in rdsh_config::RdshSettings::keys() {
                    println!("{k}");
                }
                Ok(())
            }
        },
        Some(Commands::Context { action }) => {
            if !cfg.beta.context_engine {
                eprintln!(
                    "[rdsh] context engine is OFF by default (experimental) — enable with: rdsh settings set beta.context_engine true"
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
        Some(Commands::Auth { import, json }) => auth::cmd_auth(import, json),
        Some(Commands::Setup {
            open,
            login,
            json,
            yes,
            web,
            port,
        }) => {
            if web {
                setup_web::cmd_setup_web(port.unwrap_or(cfg.setup.web_port))
            } else {
                auth::cmd_setup(open, login, json, yes)
            }
        }
        Some(Commands::DumpConfig { profile, native }) => {
            profile_or_default(profile.or(cli.profile)).and_then(|p| {
                if native {
                    dump_config_native(&p, &cli.patch)
                } else {
                    passthrough::exec_dump_config(&p, &cli.patch, dry, slim)
                }
            })
        }
        Some(Commands::Boot {
            profile,
            from_default_profile,
            args,
        }) => profile_or_default(profile.or(cli.profile)).and_then(|p| {
            passthrough::exec_boot(
                &p,
                from_default_profile.as_deref(),
                &cli.patch,
                &args,
                dry,
                slim,
            )
        }),
        None => {
            let wants_help = cli.extra.iter().any(|a| a == "-h" || a == "--help");
            let parsed = dsh_args::split_launcher_args(cli.profile, cli.extra);
            match parsed {
                dsh_args::Launcher::Help => {
                    if wants_help {
                        print_help();
                        Ok(())
                    } else {
                        // Bare `rdsh` (no profile, no help flag): boot the
                        // resolved default instead of showing help.
                        resolve_default_profile().and_then(|p| {
                            passthrough::exec_boot(&p, None, &cli.patch, &[], dry, slim)
                        })
                    }
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
                dsh_args::Launcher::Dump { profile, patches } => {
                    let mut all = cli.patch;
                    all.extend(patches);
                    passthrough::exec_dump_config(&profile, &all, dry, slim)
                }
                dsh_args::Launcher::Error(msg) => {
                    eprintln!("{msg}");
                    std::process::exit(2);
                }
            }
        }
    };
    if let Err(e) = result {
        eprintln!("[rdsh] error: {e:#}");
        std::process::exit(1);
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

fn profile_or_default(opt: Option<String>) -> anyhow::Result<String> {
    match opt {
        Some(p) => Ok(p),
        None => resolve_default_profile(),
    }
}

fn resolve_default_profile() -> anyhow::Result<String> {
    let env = std::env::var("RDSH_DEFAULT_PROFILE").ok();
    if env
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .is_none()
    {
        let configured = rdsh_config::load().general.default_profile;
        if !configured.trim().is_empty() {
            return Ok(configured.trim().to_string());
        }
    }
    let home = crate::inspect::dsh_home();
    let local_tui = std::path::Path::new(&format!("{home}/profiles/tui")).is_dir();
    pick_default_profile(env.as_deref(), local_tui).map_err(|m| anyhow::anyhow!(m))
}

fn print_help() {
    println!("rdsh: fast Rust launcher for dsh (safe shim)");
    println!();
    println!("USAGE:");
    println!("  rdsh [profile] [--profile <name>] [--patch <yml>...] [app-args...]");
    println!("  rdsh <native-subcommand> ...   (tokens|prune|search|compact|doctor|bench|serve|sessions|profiles|skills|logs|guard|dump-config|boot)");
    println!();
    println!("EXAMPLES:");
    println!("  rdsh tui                        boot tui profile (slim env ON, delegates to dsh)");
    println!("  rdsh --profile web --patch x.yml boot web with overlay");
    println!("  rdsh dump-config --profile tui  delegate exact dump to dsh");
    println!("  rdsh tokens ./AGENTS.md         estimate input tokens natively");
    println!("  rdsh auth --import              mirror codex/opencode OAuth into dsh credentials");
    println!("  rdsh setup                      first-run connect: import, login flow, next steps");
    println!("  rdsh search hello --dir .       fast file search without Node");
    println!("  rdsh search-web \"rust async\"      web search via SearXNG (no API key)");
    println!("  rdsh --passthrough tui          byte-identical delegation, no slim env");
    println!("  rdsh --dry-run tui -- --resume abc   show what would exec");
}

fn dump_config_native(profile: &str, patches: &[String]) -> anyhow::Result<()> {
    let home = crate::inspect::dsh_home();
    // Debug-format {:?} prints like JSON here but doesn't escape the same
    // way; emit a real JSON array so consumers can actually parse it.
    let patches_json = serde_json::json!(patches);
    println!(
        "{{\"profile\": \"{profile}\", \"dsh_home\": \"{home}\", \"patches\": {patches_json}}}"
    );
    let root = format!("{home}/profiles/{profile}");
    match std::fs::read_dir(&root) {
        Ok(entries) => {
            println!("# layers under {root}:");
            let mut names: Vec<String> = entries
                .filter_map(|e| e.ok())
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
    say(format!("[rdsh] slim env: {}", slim::describe()));
    say(format!("[rdsh] auth: {}", auth::summary_line()));
    if let Some(v) = original_version(orig.as_deref().unwrap_or("")) {
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
    for w in node_wrapper_warnings(shadowed) {
        say(w);
    }
    say("[rdsh] note: dsh web GUI and `rdsh serve` both default to 3080; co-use with".to_string());
    say("[rdsh] note: `rdsh serve --port 38080` while dsh web keeps 3080".to_string());
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

/// Wrappers that run `node` on the `dsh` path break once `dsh` is shadowed by
/// the native binary (Node tries to parse the ELF as JS). Scan the local bin
/// dir for text files mentioning both and point at the offending wrappers.
fn node_wrapper_warnings(shadowed: bool) -> Vec<String> {
    let Some(home) = crate::inspect::home_dir() else {
        return vec![];
    };
    let dir = format!("{home}/.local/bin");
    let entries = std::fs::read_dir(&dir).ok();
    let mut hits: Vec<String> = vec![];
    if let Some(entries) = entries {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            let bytes = std::fs::read(&path).unwrap_or_default();
            if bytes.len() > 65536 || bytes.contains(&0) {
                continue;
            }
            let text = String::from_utf8_lossy(&bytes);
            if text.contains("node") && text.contains("dsh") {
                if let Some(name) = path.file_name().and_then(|s| s.to_str()) {
                    hits.push(name.to_string());
                }
            }
            if hits.len() >= 10 {
                break;
            }
        }
    }
    hits.sort();
    hits.into_iter()
        .map(|name| {
            if shadowed {
                format!("[rdsh] warn: ~/.local/bin/{name} calls `node` on a dsh path; while `dsh` is shadowed that path is a native binary — exec `dsh`/`rdsh` directly instead of via `node`")
            } else {
                format!("[rdsh] note: ~/.local/bin/{name} calls `node` on a dsh path; it will break if `dsh` is later shadowed — exec `dsh`/`rdsh` directly instead of via `node`")
            }
        })
        .collect()
}

/// True when `dsh` on PATH resolves to this binary (install.sh --as-dsh state).
fn shadowing_original() -> bool {
    if invoked_as_dsh() {
        return true;
    }
    let me = std::fs::canonicalize(std::env::current_exe().unwrap_or_default()).unwrap_or_default();
    std::env::var("PATH")
        .ok()
        .map(|p| {
            p.split(':').any(|dir| {
                let cand = format!("{dir}/dsh");
                std::fs::canonicalize(&cand)
                    .map(|c| c == me)
                    .unwrap_or(false)
            })
        })
        .unwrap_or(false)
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
}
