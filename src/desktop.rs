//! DeepSeek Harness Desktop (Electron) integration.
//!
//! The Desktop application is an Electron shell around the complete dsh Web
//! application. It owns the reserved `desktop` profile under
//! `$DSH_HOME/profiles/desktop` and ships its own command runtime at
//! `resources/runtime/cli/bin/dsh` (`dsh.cmd` on Windows). The npm `dsh`
//! CLI refuses to boot or manage that profile, so plugins are attached either
//! through the Desktop-installed command or through the app's own Plugins page.
//!
//! This module only detects that state and forwards
//! `plugin --profile desktop add <package>` to the Desktop command. It never
//! boots the profile, never writes the profile manifest, and never replaces the
//! bundled runtime (see docs/DESKTOP-INTEGRATION.md).
//!
//! Upstream reference: `apps/desktop/README.md` in deepseek-ai/deepseek-harness
//! (sections "Bundled command runtime" and "Installation ownership").

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{bail, Context, Result};
use serde_json::json;

/// Write a line and ignore a closed pipe: `rdsh desktop status | head` must not
/// panic with EPIPE (the same rule doctor follows).
macro_rules! out {
    ($($arg:tt)*) => {{
        use std::io::Write;
        let _ = writeln!(std::io::stdout(), $($arg)*);
    }};
}

/// The stderr counterpart of [`out!`].
macro_rules! err {
    ($($arg:tt)*) => {{
        use std::io::Write;
        let _ = writeln!(std::io::stderr(), $($arg)*);
    }};
}

/// Reserved profile name owned by the Electron application.
pub const PROFILE: &str = "desktop";
/// Bundled rdsh plugins that can be attached to a DSH profile.
pub const BUNDLED_PLUGINS: &[&str] = &["rdsh-settings", "rdsh-compute"];
/// Product name used by the macOS bundle and the Windows install directory.
const APP_NAME: &str = "DeepSeek Harness";
/// Upstream's own refusal text; keeping the intent verbatim keeps the fix obvious.
const PROFILE_NOT_INITIALIZED: &str =
    "Open DeepSeek Harness Desktop once to initialize its profile, then fully quit it before attaching rdsh plugins";

/// Process environment reduced to the values detection needs.
#[derive(Debug, Clone, Default)]
pub struct OsEnv {
    pub platform: String,
    pub home: PathBuf,
    pub dsh_home: PathBuf,
    pub app_data: Option<PathBuf>,
    pub local_app_data: Option<PathBuf>,
    pub program_files: Option<PathBuf>,
    pub xdg_config_home: Option<PathBuf>,
    /// `DSH_DESKTOP_APP_DIR`: explicit application directory.
    pub desktop_app_dir: Option<PathBuf>,
    /// `DSH_DESKTOP_CLI`: explicit Desktop-installed command runtime.
    pub desktop_cli: Option<PathBuf>,
    /// `DSH_DESKTOP_USER_DATA_DIR`: Electron userData override (development).
    pub desktop_user_data: Option<PathBuf>,
}

impl OsEnv {
    pub fn from_process() -> Self {
        let var = |key: &str| {
            std::env::var_os(key)
                .map(PathBuf::from)
                .filter(|p| !p.as_os_str().is_empty())
        };
        let home = var("HOME")
            .or_else(|| var("USERPROFILE"))
            .unwrap_or_else(|| PathBuf::from("."));
        let xdg_config_home = var("XDG_CONFIG_HOME").or_else(|| Some(home.join(".config")));
        OsEnv {
            platform: std::env::consts::OS.to_string(),
            dsh_home: PathBuf::from(crate::inspect::dsh_home()),
            home,
            app_data: var("APPDATA"),
            local_app_data: var("LOCALAPPDATA"),
            program_files: var("ProgramFiles").or_else(|| var("ProgramW6432")),
            xdg_config_home,
            desktop_app_dir: var("DSH_DESKTOP_APP_DIR"),
            desktop_cli: var("DSH_DESKTOP_CLI"),
            desktop_user_data: var("DSH_DESKTOP_USER_DATA_DIR"),
        }
    }

    /// `$DSH_HOME/profiles/desktop`
    pub fn profile_dir(&self) -> PathBuf {
        self.dsh_home.join("profiles").join(PROFILE)
    }
}

/// The Desktop-installed command runtime.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandRuntime {
    pub path: PathBuf,
    /// `DSH_DESKTOP_CLI` when the path was given explicitly, `detected` otherwise.
    pub source: &'static str,
    /// Application directory the runtime was found in, when it was detected.
    pub app: Option<PathBuf>,
}

/// Read-only snapshot of the Desktop profile manifest.
#[derive(Debug, Clone, Default)]
pub struct ProfileState {
    pub path: PathBuf,
    pub initialized: bool,
    /// `dependencies` keys (installed packages).
    pub dependencies: BTreeSet<String>,
    /// `dsh.profile.bundles` (enabled bundles, in composition order).
    pub bundles: Vec<String>,
    pub error: Option<String>,
}

impl ProfileState {
    pub fn installed(&self, name: &str) -> bool {
        self.dependencies.contains(name)
    }

    /// A bundle is enabled by its package name; a scoped alias such as
    /// `\@local/rdsh-settings` also enables `rdsh-settings`.
    pub fn enabled(&self, name: &str) -> bool {
        self.bundles
            .iter()
            .any(|b| b == name || b.rsplit('/').next() == Some(name))
    }
}

/// Candidate `Contents/Resources`-style roots inside one application directory.
fn runtime_roots(app: &Path) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if app.extension().is_some_and(|ext| ext == "app") || app.join("Contents").is_dir() {
        roots.push(app.join("Contents").join("Resources"));
    }
    roots.push(app.join("resources"));
    roots
}

/// `<app>/resources/runtime/cli/bin/dsh` (and the `.cmd` variant).
pub fn cli_paths(app: &Path, platform: &str) -> Vec<PathBuf> {
    let names: [&str; 2] = if platform == "windows" {
        ["dsh.cmd", "dsh"]
    } else {
        ["dsh", "dsh.cmd"]
    };
    let mut out = Vec::new();
    for root in runtime_roots(app) {
        for name in names {
            out.push(root.join("runtime").join("cli").join("bin").join(name));
        }
    }
    out
}

/// Standard installation locations for the Desktop application.
pub fn app_candidates(env: &OsEnv) -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(dir) = &env.desktop_app_dir {
        out.push(dir.clone());
    }
    match env.platform.as_str() {
        "macos" => {
            out.push(PathBuf::from("/Applications").join(format!("{APP_NAME}.app")));
            out.push(
                env.home
                    .join("Applications")
                    .join(format!("{APP_NAME}.app")),
            );
        }
        "windows" => {
            if let Some(dir) = &env.local_app_data {
                out.push(dir.join("Programs").join(APP_NAME));
            }
            if let Some(dir) = &env.program_files {
                out.push(dir.join(APP_NAME));
            }
        }
        _ => {
            out.push(PathBuf::from("/opt").join(APP_NAME));
            out.push(env.home.join(".local").join("share").join(APP_NAME));
            out.push(env.home.join(".local").join("opt").join(APP_NAME));
        }
    }
    out
}

/// First existing application directory, whether or not it carries a command.
pub fn find_app(env: &OsEnv) -> Option<PathBuf> {
    app_candidates(env).into_iter().find(|dir| dir.is_dir())
}

/// Locate the Desktop-installed command: explicit env first, then every
/// candidate application directory.
pub fn find_command(env: &OsEnv) -> Option<CommandRuntime> {
    if let Some(path) = &env.desktop_cli {
        if path.is_file() {
            return Some(CommandRuntime {
                path: path.clone(),
                source: "DSH_DESKTOP_CLI",
                app: None,
            });
        }
    }
    for app in app_candidates(env) {
        if !app.is_dir() {
            continue;
        }
        for candidate in cli_paths(&app, &env.platform) {
            if candidate.is_file() {
                return Some(CommandRuntime {
                    path: candidate,
                    source: "detected",
                    app: Some(app),
                });
            }
        }
    }
    None
}

/// Electron's userData directory (the app's own settings, not `$DSH_HOME`).
pub fn user_data_dir(env: &OsEnv) -> Option<PathBuf> {
    if let Some(dir) = &env.desktop_user_data {
        return Some(dir.clone());
    }
    match env.platform.as_str() {
        "macos" => Some(
            env.home
                .join("Library")
                .join("Application Support")
                .join("@deepseek-ai")
                .join("dsh-desktop"),
        ),
        "windows" => env
            .app_data
            .as_ref()
            .map(|dir| dir.join("@deepseek-ai").join("dsh-desktop")),
        _ => env
            .xdg_config_home
            .as_ref()
            .map(|dir| dir.join("@deepseek-ai").join("dsh-desktop")),
    }
}

/// `SingletonLock` is a hint that Electron is running. It can survive a crash,
/// so it is reported as a hint and never blocks an operation by itself.
pub fn running_hint(env: &OsEnv) -> Option<PathBuf> {
    let lock = user_data_dir(env)?.join("SingletonLock");
    lock.exists().then_some(lock)
}

/// Parse the pieces of a profile manifest this module reads.
pub fn parse_profile(text: &str) -> (BTreeSet<String>, Vec<String>) {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(text) else {
        return (BTreeSet::new(), Vec::new());
    };
    let dependencies = value
        .get("dependencies")
        .and_then(|d| d.as_object())
        .map(|d| d.keys().cloned().collect())
        .unwrap_or_default();
    let bundles = value
        .get("dsh")
        .and_then(|d| d.get("profile"))
        .and_then(|p| p.get("bundles"))
        .and_then(|b| b.as_array())
        .map(|b| {
            b.iter()
                .filter_map(|entry| entry.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    (dependencies, bundles)
}

pub fn read_profile(dir: &Path) -> ProfileState {
    let path = dir.join("package.json");
    let mut state = ProfileState {
        path: path.clone(),
        ..Default::default()
    };
    match std::fs::read_to_string(&path) {
        Ok(text) => {
            state.initialized = true;
            let (dependencies, bundles) = parse_profile(&text);
            state.dependencies = dependencies;
            state.bundles = bundles;
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
        Err(err) => state.error = Some(err.to_string()),
    }
    state
}

/// A directory that directly contains the bundled plugin packages.
fn is_plugins_dir(dir: &Path) -> bool {
    dir.join("rdsh-settings").join("package.json").is_file()
}

/// Resolve the rustdsh checkout (or its `plugins/` directory) that carries the
/// bundled plugins. Both `<checkout>` and `<checkout>/plugins` are accepted.
pub fn resolve_plugins_dir(explicit: Option<&str>, _env: &OsEnv) -> Result<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    let mut push = |dir: PathBuf| {
        if !candidates.contains(&dir) {
            candidates.push(dir);
        }
    };
    if let Some(dir) = explicit {
        push(PathBuf::from(dir));
    }
    if let Some(dir) = std::env::var_os("RDSH_PLUGINS_DIR") {
        if !dir.is_empty() {
            push(PathBuf::from(dir));
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        push(cwd);
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            push(dir.join("..").join("share").join("rdsh"));
            push(dir.to_path_buf());
        }
    }
    let mut tried = Vec::new();
    for candidate in candidates {
        if is_plugins_dir(&candidate) {
            return Ok(candidate);
        }
        let nested = candidate.join("plugins");
        if is_plugins_dir(&nested) {
            return Ok(nested);
        }
        tried.push(candidate);
    }
    bail!(
        "no rustdsh checkout with plugins/ found (tried: {}); pass --plugins-dir <checkout> or set RDSH_PLUGINS_DIR",
        tried
            .iter()
            .map(|p| p.display().to_string())
            .collect::<Vec<_>>()
            .join(", ")
    )
}

fn is_executable(path: &Path) -> bool {
    let Ok(metadata) = std::fs::metadata(path) else {
        return false;
    };
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        let _ = metadata;
        true
    }
}

/// Build the invocation for the Desktop command runtime. Windows `.cmd`
/// launchers go through `cmd /C`; a non-executable shell script goes through
/// `sh`, so a checkout-permission surprise cannot hide the real error.
fn command_for(cli: &Path) -> Command {
    let text = cli.to_string_lossy().to_ascii_lowercase();
    if text.ends_with(".cmd") || text.ends_with(".bat") {
        let mut command = Command::new("cmd");
        command.arg("/C").arg(cli);
        return command;
    }
    if !cfg!(windows) && !is_executable(cli) {
        let mut command = Command::new("sh");
        command.arg(cli);
        return command;
    }
    Command::new(cli)
}

fn plugin_selection(compute: bool) -> Vec<&'static str> {
    if compute {
        BUNDLED_PLUGINS.to_vec()
    } else {
        BUNDLED_PLUGINS[..1].to_vec()
    }
}

fn plugin_json(state: &ProfileState, name: &str) -> serde_json::Value {
    json!({
        "name": name,
        "installed": state.installed(name),
        "enabled": state.enabled(name),
    })
}

/// Directory form of the profile path, for humans and JSON labels.
fn profile_dir_label(state: &ProfileState) -> String {
    state
        .path
        .parent()
        .map(|dir| dir.display().to_string())
        .unwrap_or_else(|| state.path.display().to_string())
}

fn plugin_state(state: &ProfileState, name: &str) -> &'static str {
    if state.enabled(name) {
        "enabled"
    } else if state.installed(name) {
        "installed (not enabled)"
    } else {
        "absent"
    }
}

/// `rdsh desktop` / `rdsh desktop status` - read-only detection.
pub fn cmd_status(json_out: bool) -> Result<()> {
    let env = OsEnv::from_process();
    let app = find_app(&env);
    let command = find_command(&env);
    let cli_env_problem = env
        .desktop_cli
        .as_ref()
        .filter(|path| !path.is_file())
        .map(|path| path.display().to_string());
    let profile = read_profile(&env.profile_dir());
    let running = running_hint(&env);

    if json_out {
        let value = json!({
            "schema": 1,
            "app": {
                "path": app.as_ref().map(|p| p.display().to_string()),
                "candidates": app_candidates(&env).iter().map(|p| p.display().to_string()).collect::<Vec<_>>(),
            },
            "command": {
                "path": command.as_ref().map(|c| c.path.display().to_string()),
                "source": command.as_ref().map(|c| c.source),
                "problem": cli_env_problem,
            },
            "profile": {
                "dir": profile_dir_label(&profile),
                "path": profile.path.display().to_string(),
                "initialized": profile.initialized,
                "error": profile.error,
                "dependencies": profile.dependencies.iter().cloned().collect::<Vec<_>>(),
                "bundles": profile.bundles.clone(),
                "plugins": BUNDLED_PLUGINS.iter().map(|name| plugin_json(&profile, name)).collect::<Vec<_>>(),
            },
            "running": {
                "hint": running.as_ref().map(|p| p.display().to_string()),
            },
            "available": app.is_some() || command.is_some(),
        });
        out!("{}", serde_json::to_string_pretty(&value)?);
        return Ok(());
    }

    match &app {
        Some(path) => out!("[rdsh] desktop app: {}", path.display()),
        None => {
            out!("[rdsh] desktop app: <not found>");
            out!(
                "[rdsh] desktop app candidates: {}",
                app_candidates(&env)
                    .iter()
                    .map(|p| p.display().to_string())
                    .collect::<Vec<_>>()
                    .join(", ")
            );
            out!(
                "[rdsh] desktop app: set DSH_DESKTOP_APP_DIR or DSH_DESKTOP_CLI if it lives elsewhere"
            );
        }
    }
    match &command {
        Some(runtime) => out!(
            "[rdsh] desktop command: {} (source: {})",
            runtime.path.display(),
            runtime.source
        ),
        None => out!(
            "[rdsh] desktop command: <not found> (install it from the app menu: Manage dsh Command...)"
        ),
    }
    if let Some(problem) = &cli_env_problem {
        out!("[rdsh] desktop command: DSH_DESKTOP_CLI points at a missing file: {problem}");
    }
    out!(
        "[rdsh] desktop profile: {} ({})",
        profile_dir_label(&profile),
        if profile.initialized {
            "initialized"
        } else {
            "not initialized"
        }
    );
    if let Some(error) = &profile.error {
        out!("[rdsh] desktop profile: unreadable: {error}");
    }
    for name in BUNDLED_PLUGINS {
        out!(
            "[rdsh] desktop plugin {name}: {}",
            plugin_state(&profile, name)
        );
    }
    if let Some(lock) = &running {
        out!(
            "[rdsh] desktop: Electron looks like it is running ({}); quit it before plugin changes",
            lock.display()
        );
    }
    out!("[rdsh] desktop: attach plugins with `rdsh desktop install --plugins-dir <rustdsh checkout>`");
    out!("[rdsh] desktop: the app's own Plugins page can install the same packages");
    Ok(())
}

/// One package the Desktop command should add: a bundled plugin resolved from
/// the local checkout, or a caller-supplied spec (registry name, git URL, path).
struct Target {
    label: String,
    spec: String,
}

fn desktop_targets(
    plugins_dir: Option<&str>,
    packages: &[String],
    no_bundled: bool,
    compute: bool,
    env: &OsEnv,
) -> Result<(Vec<Target>, Option<PathBuf>)> {
    let mut targets = Vec::new();
    let mut root = None;
    if !no_bundled {
        let plugins_root = resolve_plugins_dir(plugins_dir, env)?;
        for name in plugin_selection(compute) {
            targets.push(Target {
                label: name.to_string(),
                // Plugin specs stay slash-separated: Windows path separators
                // would leak into a spec that is handed to the desktop CLI.
                spec: plugins_root
                    .join(name)
                    .display()
                    .to_string()
                    .replace('\\', "/"),
            });
        }
        root = Some(plugins_root);
    }
    for spec in packages {
        let label = spec
            .trim_end_matches('/')
            .rsplit('/')
            .next()
            .unwrap_or(spec)
            .to_string();
        targets.push(Target {
            label,
            spec: spec.clone(),
        });
    }
    if targets.is_empty() {
        bail!("nothing to install: pass --package <spec> or drop --no-bundled");
    }
    Ok((targets, root))
}

/// `rdsh desktop install` - forward `plugin --profile desktop add` to the
/// Desktop-installed command runtime.
pub fn cmd_install(
    plugins_dir: Option<&str>,
    packages: &[String],
    no_bundled: bool,
    dry_run: bool,
    compute: bool,
    json_out: bool,
) -> Result<()> {
    let env = OsEnv::from_process();
    let profile_dir = env.profile_dir();
    let profile = read_profile(&profile_dir);
    if !profile.initialized {
        bail!("{PROFILE_NOT_INITIALIZED}: {}", profile_dir.display());
    }
    if let Some(problem) = env.desktop_cli.as_ref().filter(|path| !path.is_file()) {
        bail!(
            "DSH_DESKTOP_CLI points at a missing file: {}",
            problem.display()
        );
    }
    let Some(runtime) = find_command(&env) else {
        bail!(
            "Desktop command runtime not found; open DeepSeek Harness once and use Manage dsh Command... -> Install, or set DSH_DESKTOP_CLI to resources/runtime/cli/bin/dsh (dsh.cmd on Windows). The app's own Plugins page can install the same packages without the command"
        );
    };
    let (targets, plugins_root) =
        desktop_targets(plugins_dir, packages, no_bundled, compute, &env)?;
    let running = running_hint(&env);

    if !json_out {
        out!("[rdsh] desktop command: {}", runtime.path.display());
        out!("[rdsh] desktop profile: {}", profile_dir.display());
        if let Some(root) = &plugins_root {
            out!("[rdsh] plugin sources: {}", root.display());
        }
        if let Some(lock) = &running {
            err!(
                "[rdsh] warning: DeepSeek Harness looks like it is running ({}); quit it first",
                lock.display()
            );
        }
    }

    let mut actions = Vec::new();
    let mut failures = Vec::new();
    for target in &targets {
        let name = &target.label;
        let args = vec![
            "plugin".to_string(),
            "--profile".to_string(),
            PROFILE.to_string(),
            "add".to_string(),
            target.spec.clone(),
        ];
        if dry_run {
            if json_out {
                actions.push(json!({
                    "plugin": name,
                    "status": "dry-run",
                    "command": runtime.path.display().to_string(),
                    "args": args,
                }));
            } else {
                out!(
                    "[rdsh] dry-run: {} {}",
                    runtime.path.display(),
                    args.join(" ")
                );
            }
            continue;
        }
        if !json_out {
            out!("[rdsh] installing {name} into the desktop profile...");
        }
        let mut command = command_for(&runtime.path);
        command.args(&args);
        if let Some(root) = &plugins_root {
            command.current_dir(root);
        }
        let output = command
            .output()
            .with_context(|| format!("failed to run {}", runtime.path.display()))?;
        let ok = output.status.success();
        if !ok {
            failures.push(format!(
                "{name} (exit {})",
                output.status.code().unwrap_or(-1)
            ));
        }
        if json_out {
            actions.push(json!({
                "plugin": name,
                "status": if ok { "installed" } else { "failed" },
                "exit": output.status.code(),
                "stderr_tail": tail(&String::from_utf8_lossy(&output.stderr), 8),
            }));
        } else {
            out!("[rdsh] {} {name}", if ok { "installed" } else { "failed" });
            let combined = format!(
                "{}{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            for line in tail(&combined, 8).lines() {
                err!("[rdsh] {line}");
            }
        }
    }

    if json_out {
        out!(
            "{}",
            serde_json::to_string_pretty(&json!({
                "schema": 1,
                "dry_run": dry_run,
                "profile": profile_dir.display().to_string(),
                "command": runtime.path.display().to_string(),
                "plugins_dir": plugins_root.as_ref().map(|p| p.display().to_string()),
                "actions": actions,
                "failed": failures,
            }))?
        );
    } else if !dry_run {
        out!("[rdsh] next: quit and reopen DeepSeek Harness, then run `rdsh desktop verify`");
        if compute {
            out!("[rdsh] note: the compute bridge stays off until `rdsh features on compute`");
        }
    }
    if !failures.is_empty() {
        bail!("desktop plugin install failed: {}", failures.join(", "));
    }
    Ok(())
}

fn tail(text: &str, lines: usize) -> String {
    let all: Vec<&str> = text.lines().collect();
    all[all.len().saturating_sub(lines)..].join("\n")
}

/// `rdsh desktop verify` - exit nonzero when a required plugin is not enabled.
pub fn cmd_verify(require: &[String], json_out: bool) -> Result<()> {
    let env = OsEnv::from_process();
    let profile = read_profile(&env.profile_dir());
    let required: Vec<String> = if require.is_empty() {
        vec!["rdsh-settings".to_string()]
    } else {
        require.to_vec()
    };
    let missing: Vec<String> = required
        .iter()
        .filter(|name| !profile.enabled(name))
        .cloned()
        .collect();
    if json_out {
        out!(
            "{}",
            serde_json::to_string_pretty(&json!({
                "schema": 1,
                "profile": profile_dir_label(&profile),
                "initialized": profile.initialized,
                "required": required,
                "missing": missing,
                "plugins": BUNDLED_PLUGINS.iter().map(|name| plugin_json(&profile, name)).collect::<Vec<_>>(),
            }))?
        );
    } else {
        if !profile.initialized {
            out!(
                "[rdsh] desktop profile: {} (not initialized)",
                profile_dir_label(&profile)
            );
        }
        for name in BUNDLED_PLUGINS {
            out!(
                "[rdsh] desktop plugin {name}: {}",
                plugin_state(&profile, name)
            );
        }
    }
    if !missing.is_empty() {
        bail!(
            "desktop profile has no enabled rdsh plugin: {} (run `rdsh desktop install`)",
            missing.join(", ")
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_root(tag: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir =
            std::env::temp_dir().join(format!("rdsh-desktop-{tag}-{}-{nonce}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn base_env(root: &Path) -> OsEnv {
        OsEnv {
            platform: "linux".to_string(),
            home: root.join("home"),
            dsh_home: root.join("home").join(".dsh"),
            app_data: Some(root.join("appdata")),
            local_app_data: Some(root.join("localappdata")),
            program_files: Some(root.join("programfiles")),
            xdg_config_home: Some(root.join("home").join(".config")),
            desktop_app_dir: None,
            desktop_cli: None,
            desktop_user_data: None,
        }
    }

    #[test]
    fn cli_paths_cover_macos_bundle_and_plain_install() {
        let app = PathBuf::from("/Applications/DeepSeek Harness.app");
        let paths = cli_paths(&app, "macos");
        assert_eq!(
            paths[0],
            PathBuf::from(
                "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
            )
        );
        assert!(paths.iter().any(|p| p
            == &PathBuf::from("/Applications/DeepSeek Harness.app/resources/runtime/cli/bin/dsh")));
        let win = cli_paths(&PathBuf::from("C:/Apps/DeepSeek Harness"), "windows");
        assert!(win[0].ends_with("resources/runtime/cli/bin/dsh.cmd"));
    }

    #[test]
    fn app_candidates_follow_the_platform() {
        let root = temp_root("candidates");
        let mut env = base_env(&root);
        assert!(app_candidates(&env)
            .iter()
            .any(|p| p == &root.join("home/.local/share/DeepSeek Harness")));
        env.platform = "macos".to_string();
        assert_eq!(
            app_candidates(&env)[0],
            PathBuf::from("/Applications/DeepSeek Harness.app")
        );
        env.platform = "windows".to_string();
        assert_eq!(
            app_candidates(&env)[0],
            root.join("localappdata/Programs/DeepSeek Harness")
        );
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn profile_state_reads_dependencies_and_bundles() {
        let root = temp_root("profile");
        let dir = root.join("profiles/desktop");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("package.json"),
            r#"{
  "dependencies": {"rdsh-settings": "link:/repo/plugins/rdsh-settings"},
  "dsh": {"profile": {"bundles": ["@deepseek-ai/dsh-base", "@local/rdsh-settings"]}}
}"#,
        )
        .unwrap();
        let state = read_profile(&dir);
        assert!(state.initialized);
        assert!(state.installed("rdsh-settings"));
        assert!(state.enabled("rdsh-settings"), "scoped alias must count");
        assert!(!state.enabled("rdsh-compute"));
        assert!(state.error.is_none());
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn missing_profile_is_reported_not_created() {
        let root = temp_root("missing");
        let state = read_profile(&root.join("profiles/desktop"));
        assert!(!state.initialized);
        assert!(!state.path.exists());
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn command_detection_prefers_env_then_app() {
        let root = temp_root("command");
        let mut env = base_env(&root);
        assert!(find_command(&env).is_none());

        let app = root.join("apps/DeepSeek Harness");
        let cli = app.join("resources/runtime/cli/bin/dsh");
        std::fs::create_dir_all(cli.parent().unwrap()).unwrap();
        std::fs::write(&cli, b"#!/bin/sh\n").unwrap();
        env.desktop_app_dir = Some(app.clone());
        let found = find_command(&env).unwrap();
        assert_eq!(found.path, cli);
        assert_eq!(found.source, "detected");
        assert_eq!(found.app.as_deref(), Some(app.as_path()));

        let explicit = root.join("elsewhere/dsh");
        std::fs::create_dir_all(explicit.parent().unwrap()).unwrap();
        std::fs::write(&explicit, b"#!/bin/sh\n").unwrap();
        env.desktop_cli = Some(explicit.clone());
        let found = find_command(&env).unwrap();
        assert_eq!(found.path, explicit);
        assert_eq!(found.source, "DSH_DESKTOP_CLI");

        env.desktop_cli = Some(root.join("missing-dsh"));
        assert_eq!(find_command(&env).unwrap().path, cli);
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn running_hint_uses_the_electron_singleton_lock() {
        let root = temp_root("running");
        let env = base_env(&root);
        let user_data = env
            .xdg_config_home
            .clone()
            .unwrap()
            .join("@deepseek-ai")
            .join("dsh-desktop");
        std::fs::create_dir_all(&user_data).unwrap();
        assert!(running_hint(&env).is_none());
        std::fs::write(user_data.join("SingletonLock"), b"").unwrap();
        assert_eq!(running_hint(&env).unwrap(), user_data.join("SingletonLock"));
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn plugins_dir_accepts_a_checkout_or_its_plugins_directory() {
        let root = temp_root("plugins");
        let env = base_env(&root);
        let checkout = root.join("rustdsh");
        let plugins = checkout.join("plugins");
        std::fs::create_dir_all(plugins.join("rdsh-settings")).unwrap();
        // A directory without rdsh-settings is skipped. The repository checkout
        // (the test working directory) can still satisfy the lookup, so only the
        // rejected path is asserted here.
        let empty = root.join("empty");
        std::fs::create_dir_all(&empty).unwrap();
        if let Ok(found) = resolve_plugins_dir(Some(empty.to_str().unwrap()), &env) {
            assert_ne!(found, empty);
        }
        std::fs::write(
            plugins.join("rdsh-settings/package.json"),
            b"{\"name\":\"rdsh-settings\"}",
        )
        .unwrap();
        assert_eq!(
            resolve_plugins_dir(Some(checkout.to_str().unwrap()), &env).unwrap(),
            plugins
        );
        assert_eq!(
            resolve_plugins_dir(Some(plugins.to_str().unwrap()), &env).unwrap(),
            plugins
        );
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn desktop_targets_mix_bundled_plugins_and_packages() {
        let root = temp_root("targets");
        let env = base_env(&root);
        let checkout = root.join("rustdsh");
        std::fs::create_dir_all(checkout.join("plugins/rdsh-settings")).unwrap();
        std::fs::write(
            checkout.join("plugins/rdsh-settings/package.json"),
            b"{\"name\":\"rdsh-settings\"}",
        )
        .unwrap();

        let (targets, dir) =
            desktop_targets(Some(checkout.to_str().unwrap()), &[], false, false, &env).unwrap();
        assert_eq!(targets.len(), 1);
        assert_eq!(targets[0].label, "rdsh-settings");
        assert!(targets[0].spec.ends_with("plugins/rdsh-settings"));
        assert!(dir.unwrap().ends_with("plugins"));

        let packages = vec![
            "@deepseek-ai/dsh-tool-present".to_string(),
            "github:owner/repo".to_string(),
        ];
        let (targets, dir) = desktop_targets(None, &packages, true, false, &env).unwrap();
        assert_eq!(targets.len(), 2);
        assert_eq!(targets[0].label, "dsh-tool-present");
        assert_eq!(targets[1].label, "repo");
        assert!(dir.is_none());
        assert!(desktop_targets(None, &[], true, false, &env).is_err());
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn compute_is_opt_in() {
        assert_eq!(plugin_selection(false), vec!["rdsh-settings"]);
        assert_eq!(
            plugin_selection(true),
            vec!["rdsh-settings", "rdsh-compute"]
        );
    }

    #[test]
    fn tail_keeps_the_last_lines() {
        assert_eq!(tail("a\nb\nc", 2), "b\nc");
        assert_eq!(tail("a", 5), "a");
    }
}
