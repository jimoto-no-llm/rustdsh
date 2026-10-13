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
/// Third-party Web UI plugins installed by default (both MIT, used with upstream
/// permission; see Credits in README.md). They are fetched from GitHub at
/// install time so fixes arrive without a rustdsh release.
pub const SOUND_SPEC: &str = "github:cwd514/dsh-sound-notifications";
pub const GITVIEW_SPEC: &str = "github:yugapor/dsh-gitview";
/// Default third-party specs attached alongside the bundled plugins.
pub const DEFAULT_THIRD_PARTY: &[&str] = &[SOUND_SPEC, GITVIEW_SPEC];
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
    /// `RDSH_PLUGINS_DIR`: rustdsh checkout (or its plugins directory).
    pub plugins_dir: Option<PathBuf>,
    /// `APPDIR`: the mount point an AppImage runtime exports while it runs.
    pub appimage_dir: Option<PathBuf>,
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
            plugins_dir: var("RDSH_PLUGINS_DIR"),
            appimage_dir: var("APPDIR"),
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
            // Linux has no published Desktop release, so these cover what a
            // Fedora test actually has: an extracted AppImage, a development
            // build, or an unpacked copy under a user directory.
            if let Some(dir) = &env.appimage_dir {
                out.push(dir.clone());
            }
            out.push(PathBuf::from("/opt").join(APP_NAME));
            out.push(env.home.join(".local").join("share").join(APP_NAME));
            out.push(env.home.join(".local").join("opt").join(APP_NAME));
            out.push(env.home.join("squashfs-root"));
            out.push(PathBuf::from("squashfs-root"));
        }
    }
    out
}

/// First existing application directory, whether or not it carries a command.
pub fn find_app(env: &OsEnv) -> Option<PathBuf> {
    app_candidates(env).into_iter().find(|dir| dir.is_dir())
}

/// Resolve a possibly relative path against the current directory.
fn absolute(path: &Path) -> PathBuf {
    if path.is_absolute() {
        return path.to_path_buf();
    }
    std::env::current_dir()
        .map(|cwd| cwd.join(path))
        .unwrap_or_else(|_| path.to_path_buf())
}

/// True when a path looks like `<app>/resources/runtime/cli/bin/<dsh>`.
/// macOS uses `Contents/Resources`, so the check is case-insensitive.
fn is_desktop_runtime_path(path: &Path) -> bool {
    let text = path.to_string_lossy().to_ascii_lowercase();
    text.contains("/resources/runtime/cli/bin/")
        || text.contains("\\resources\\runtime\\cli\\bin\\")
}

/// Scan PATH-like directories for the Desktop-installed command. The app's
/// "Manage dsh Command..." can put exactly that command on PATH even when the
/// application lives outside the standard location.
fn scan_paths(dirs: impl Iterator<Item = PathBuf>) -> Option<PathBuf> {
    for dir in dirs {
        for name in ["dsh", "dsh.cmd", "dsh.exe"] {
            let candidate = dir.join(name);
            if candidate.is_file() && is_desktop_runtime_path(&candidate) {
                return Some(candidate);
            }
        }
    }
    None
}

fn desktop_command_on_path() -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    scan_paths(std::env::split_paths(&path))
}

/// Locate the Desktop-installed command: explicit env first, then every
/// candidate application directory, then a `dsh` on PATH that clearly lives
/// inside the application's runtime.
pub fn find_command(env: &OsEnv) -> Option<CommandRuntime> {
    if let Some(path) = &env.desktop_cli {
        // Install runs the command from the plugin directory, so a relative
        // override has to be pinned to the working directory first.
        let candidate = absolute(path);
        if candidate.is_file() {
            return Some(CommandRuntime {
                path: candidate,
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
    desktop_command_on_path().map(|path| CommandRuntime {
        path,
        source: "desktop-runtime-on-path",
        app: None,
    })
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

/// Parse the pieces of a profile manifest this module reads. A manifest that
/// exists but does not parse yields a reason instead of a silent empty state.
pub fn parse_profile(text: &str) -> (BTreeSet<String>, Vec<String>, Option<String>) {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(text) else {
        return (
            BTreeSet::new(),
            Vec::new(),
            Some("package.json is not valid JSON".to_string()),
        );
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
    (dependencies, bundles, None)
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
            let (dependencies, bundles, error) = parse_profile(&text);
            state.dependencies = dependencies;
            state.bundles = bundles;
            state.error = error;
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
        Err(err) => state.error = Some(err.to_string()),
    }
    state
}

/// A directory that directly contains the bundled plugin packages. The probe
/// reads the manifest so a stray or broken file is not mistaken for a checkout.
fn is_plugins_dir(dir: &Path) -> bool {
    let manifest = dir.join("rdsh-settings").join("package.json");
    let Ok(text) = std::fs::read_to_string(&manifest) else {
        return false;
    };
    serde_json::from_str::<serde_json::Value>(&text)
        .ok()
        .and_then(|value| {
            value
                .get("name")
                .and_then(|name| name.as_str())
                .map(str::to_string)
        })
        .is_some_and(|name| name == "rdsh-settings")
}

/// Resolve the rustdsh checkout (or its `plugins/` directory) that carries the
/// bundled plugins. Both `<checkout>` and `<checkout>/plugins` are accepted.
pub fn resolve_plugins_dir(explicit: Option<&str>, env: &OsEnv) -> Result<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    let mut push = |dir: PathBuf| {
        if !candidates.contains(&dir) {
            candidates.push(dir);
        }
    };
    if let Some(dir) = explicit {
        push(PathBuf::from(dir));
    }
    if let Some(dir) = &env.plugins_dir {
        push(dir.clone());
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
/// How one Desktop command must be executed.
#[derive(Debug, PartialEq, Eq)]
enum Invocation {
    /// Execute the file itself.
    Direct,
    /// Run it through `sh` (a shell script without the execute bit).
    ViaSh,
    /// Windows `.cmd`/`.bat` launchers cannot be created as a process
    /// directly, so they go through `cmd /C`.
    ViaCmd,
}

fn invocation_for(cli: &Path, windows: bool, executable: bool) -> Invocation {
    let text = cli.to_string_lossy().to_ascii_lowercase();
    if text.ends_with(".cmd") || text.ends_with(".bat") {
        return Invocation::ViaCmd;
    }
    if !windows && !executable {
        return Invocation::ViaSh;
    }
    Invocation::Direct
}

/// Quote one token for a `cmd.exe` command line.
fn quote_for_cmd(token: &str) -> String {
    let mut out = String::with_capacity(token.len() + 2);
    out.push('"');
    for ch in token.chars() {
        if ch == '"' {
            out.push('"');
        }
        out.push(ch);
    }
    out.push('"');
    out
}

/// The exact command line to hand to `cmd.exe`. It is wrapped in one quoting
/// pair so the packaged path survives its space
/// (`...\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd`), and
/// `/S` makes cmd strip exactly that outer pair.
fn windows_cmd_line(cli: &Path, args: &[String]) -> String {
    let mut line = String::from("\"");
    line.push_str(&quote_for_cmd(&cli.to_string_lossy()));
    for arg in args {
        line.push(' ');
        line.push_str(&quote_for_cmd(arg));
    }
    line.push('"');
    line
}

/// Windows `.cmd`/`.bat` launchers are started through `cmd.exe`.
///
/// The line must be passed as a raw argument: `Command::arg` applies C-runtime
/// quoting, which escapes the inner quotes as `\"` - cmd.exe does not understand
/// that and reads the mangled path as a UNC path ("The network path was not
/// found."). `/D` skips AutoRun commands for a reproducible launch.
#[cfg(windows)]
fn windows_command(cli: &Path, args: &[String]) -> Command {
    use std::os::windows::process::CommandExt;
    let mut command = Command::new("cmd");
    command.arg("/D").arg("/S").arg("/C");
    command.raw_arg(windows_cmd_line(cli, args));
    command
}

/// Non-Windows build of the same helper: never executed, but it keeps the
/// command construction testable on every platform.
#[cfg(not(windows))]
fn windows_command(cli: &Path, args: &[String]) -> Command {
    let mut command = Command::new("cmd");
    command
        .arg("/D")
        .arg("/S")
        .arg("/C")
        .arg(windows_cmd_line(cli, args));
    command
}

/// Build the full invocation for the Desktop command runtime.
fn command_for(cli: &Path, args: &[String]) -> Command {
    match invocation_for(cli, cfg!(windows), is_executable(cli)) {
        Invocation::ViaCmd => windows_command(cli, args),
        Invocation::ViaSh => {
            let mut command = Command::new("sh");
            command.arg(cli).args(args);
            command
        }
        Invocation::Direct => {
            let mut command = Command::new(cli);
            command.args(args);
            command
        }
    }
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
            if env.platform != "macos" && env.platform != "windows" {
                // Linux has no published Desktop build, so name the two ways a
                // Fedora test can still have one.
                out!(
                    "[rdsh] desktop app: Linux is not a published Desktop target; for an AppImage run"
                );
                out!(
                    "[rdsh] desktop app:   ./<file>.AppImage --appimage-extract  then  DSH_DESKTOP_APP_DIR=$PWD/squashfs-root"
                );
                out!(
                    "[rdsh] desktop app: for a development build set DSH_DESKTOP_CLI=<app>/resources/runtime/cli/bin/dsh"
                );
            }
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
    no_sound: bool,
    no_gitview: bool,
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
        for spec in DEFAULT_THIRD_PARTY {
            if (*spec == SOUND_SPEC && no_sound) || (*spec == GITVIEW_SPEC && no_gitview) {
                continue;
            }
            let label = spec
                .trim_end_matches('/')
                .rsplit('/')
                .next()
                .unwrap_or(spec)
                .to_string();
            targets.push(Target {
                label,
                spec: spec.to_string(),
            });
        }
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

/// Everything `rdsh desktop install` needs, in one place: the CLI grows a
/// flag now and then, and a struct keeps that growth out of the call site.
#[derive(Debug, Clone, Default)]
pub struct InstallOptions {
    pub plugins_dir: Option<String>,
    pub packages: Vec<String>,
    pub no_bundled: bool,
    pub dry_run: bool,
    pub compute: bool,
    pub no_sound: bool,
    pub no_gitview: bool,
    pub json: bool,
}

/// `rdsh desktop install` - forward `plugin --profile desktop add` to the
/// Desktop-installed command runtime.
pub fn cmd_install(options: InstallOptions) -> Result<()> {
    let InstallOptions {
        plugins_dir,
        packages,
        no_bundled,
        dry_run,
        compute,
        no_sound,
        no_gitview,
        json: json_out,
    } = options;
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
    let (targets, plugins_root) = desktop_targets(
        plugins_dir.as_deref(),
        &packages,
        no_bundled,
        compute,
        no_sound,
        no_gitview,
        &env,
    )?;
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
        let mut command = command_for(&runtime.path, &args);
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
                "running": {
                    "hint": running.as_ref().map(|p| p.display().to_string()),
                },
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
            plugins_dir: None,
            appimage_dir: None,
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
    fn linux_candidates_cover_appimage_and_extracted_layouts() {
        let root = temp_root("linux");
        let mut env = base_env(&root);
        let extracted = root.join("squashfs-root");
        let candidates = app_candidates(&env);
        assert!(candidates.contains(&root.join("home/squashfs-root")));
        assert!(candidates.contains(&PathBuf::from("squashfs-root")));
        // An AppImage runtime exports APPDIR; it must win over the guesses.
        env.appimage_dir = Some(extracted.clone());
        assert_eq!(app_candidates(&env)[0], extracted);
        std::fs::remove_dir_all(&root).unwrap();
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
    fn malformed_profile_is_reported_not_silently_empty() {
        let root = temp_root("malformed");
        let dir = root.join("profiles/desktop");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("package.json"), b"THIS IS NOT JSON").unwrap();
        let state = read_profile(&dir);
        assert!(
            state.initialized,
            "existence is what the profile manager checks"
        );
        assert!(state.bundles.is_empty());
        assert_eq!(
            state.error.as_deref(),
            Some("package.json is not valid JSON")
        );
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn relative_paths_are_pinned_to_the_working_directory() {
        // The override is relative to the process working directory, not to the
        // plugin directory install later switches into.
        let cwd = std::env::current_dir().unwrap();
        assert_eq!(absolute(Path::new("dsh")), cwd.join("dsh"));
        // An already absolute path is returned unchanged on every platform.
        let already_absolute = cwd.join("sub").join("dsh");
        assert_eq!(absolute(&already_absolute), already_absolute);
    }

    #[test]
    fn invocation_choices_follow_the_platform() {
        assert_eq!(
            invocation_for(Path::new("C:\\x\\dsh.cmd"), true, true),
            Invocation::ViaCmd
        );
        assert_eq!(
            invocation_for(Path::new("C:\\x\\dsh.cmd"), false, true),
            Invocation::ViaCmd
        );
        assert_eq!(
            invocation_for(Path::new("C:\\x\\dsh.exe"), true, false),
            Invocation::Direct
        );
        assert_eq!(
            invocation_for(Path::new("/x/dsh"), false, false),
            Invocation::ViaSh
        );
        assert_eq!(
            invocation_for(Path::new("/x/dsh"), false, true),
            Invocation::Direct
        );
    }

    #[test]
    fn windows_launchers_are_quoted_as_one_command_line() {
        // The packaged path contains a space, so the whole line is wrapped in
        // one quoting pair that cmd.exe strips before executing.
        let cli = r"C:\Program Files\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd";
        let spec = r"C:\Program Files\plugins\rdsh-settings";
        let args: Vec<String> = ["plugin", "--profile", "desktop", "add", spec]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let line = windows_cmd_line(Path::new(cli), &args);
        assert_eq!(
            line,
            format!("\"\"{cli}\" \"plugin\" \"--profile\" \"desktop\" \"add\" \"{spec}\"\"")
        );
        // One pair of outer quotes for cmd /S to strip.
        assert!(line.starts_with("\"\"") && line.ends_with("\"\""));

        let command = windows_command(Path::new(cli), &args);
        assert_eq!(command.get_program(), "cmd");
        // The raw argument form is Windows-only; the switches are checked there.
        #[cfg(not(windows))]
        {
            let got: Vec<String> = command
                .get_args()
                .map(|arg| arg.to_string_lossy().to_string())
                .collect();
            assert_eq!(got[0..3], ["/D", "/S", "/C"]);
            assert_eq!(got[3], line);
        }
    }

    #[test]
    fn plugins_dir_rejects_a_broken_manifest() {
        let root = temp_root("brokenmanifest");
        let plugins = root.join("plugins");
        std::fs::create_dir_all(plugins.join("rdsh-settings")).unwrap();
        std::fs::write(plugins.join("rdsh-settings/package.json"), b"not json {{{").unwrap();
        assert!(!is_plugins_dir(&plugins));
        std::fs::write(
            plugins.join("rdsh-settings/package.json"),
            b"{\"name\":\"something-else\"}",
        )
        .unwrap();
        assert!(!is_plugins_dir(&plugins));
        std::fs::write(
            plugins.join("rdsh-settings/package.json"),
            b"{\"name\":\"rdsh-settings\"}",
        )
        .unwrap();
        assert!(is_plugins_dir(&plugins));
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
    fn desktop_runtime_paths_and_path_scan() {
        assert!(is_desktop_runtime_path(Path::new(
            "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
        )));
        assert!(is_desktop_runtime_path(Path::new(
            r"C:\Users\u\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"
        )));
        assert!(!is_desktop_runtime_path(Path::new("/usr/local/bin/dsh")));

        let root = temp_root("pathscan");
        let plain = root.join("usr/local/bin");
        std::fs::create_dir_all(&plain).unwrap();
        std::fs::write(plain.join("dsh"), b"#!/bin/sh\n").unwrap();
        // Built component-wise so the fixture uses native separators.
        let app_bin = root
            .join("app")
            .join("resources")
            .join("runtime")
            .join("cli")
            .join("bin");
        std::fs::create_dir_all(&app_bin).unwrap();
        std::fs::write(app_bin.join("dsh"), b"#!/bin/sh\n").unwrap();
        assert_eq!(scan_paths([plain.clone()].into_iter()), None);
        assert_eq!(
            scan_paths([plain.clone(), app_bin.clone()].into_iter()),
            Some(app_bin.join("dsh"))
        );
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

        // RDSH_PLUGINS_DIR (OsEnv::plugins_dir) is the second source, before the
        // working directory.
        let mut with_env = base_env(&root);
        with_env.plugins_dir = Some(plugins.clone());
        assert_eq!(resolve_plugins_dir(None, &with_env).unwrap(), plugins);
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

        let (targets, dir) = desktop_targets(
            Some(checkout.to_str().unwrap()),
            &[],
            false,
            false,
            false,
            false,
            &env,
        )
        .unwrap();
        assert_eq!(targets.len(), 3);
        assert_eq!(targets[0].label, "rdsh-settings");
        assert_eq!(
            Path::new(&targets[0].spec),
            checkout.join("plugins").join("rdsh-settings")
        );
        assert_eq!(targets[1].label, "dsh-sound-notifications");
        assert_eq!(targets[2].label, "dsh-gitview");
        assert!(dir.unwrap().ends_with("plugins"));

        let (targets, _) = desktop_targets(
            Some(checkout.to_str().unwrap()),
            &[],
            false,
            false,
            true,
            true,
            &env,
        )
        .unwrap();
        assert_eq!(targets.len(), 1);
        assert_eq!(targets[0].label, "rdsh-settings");

        let packages = vec![
            "@deepseek-ai/dsh-tool-present".to_string(),
            "github:owner/repo".to_string(),
        ];
        let (targets, dir) =
            desktop_targets(None, &packages, true, false, false, false, &env).unwrap();
        assert_eq!(targets.len(), 2);
        assert_eq!(targets[0].label, "dsh-tool-present");
        assert_eq!(targets[1].label, "repo");
        assert!(dir.is_none());
        assert!(desktop_targets(None, &[], true, false, false, false, &env).is_err());
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
