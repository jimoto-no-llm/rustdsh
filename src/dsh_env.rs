//! Fallback discovery for the original dsh and for pnpm, plus the Node.js
//! toolchain diagnosis that rdsh doctor prints.
//!
//! Version managers (nvm, fnm, volta) and global package installs (npm, pnpm)
//! expose their commands on PATH only after shell initialization. A
//! non-interactive shell or a service unit therefore reports "original dsh not
//! found" even though it is installed. find_original_dsh consults this module
//! only after PATH and the local backups came up empty, so the resolution order
//! of every currently working setup stays unchanged.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use crate::locale::Locale;

/// doctor and the delegation fallback stay responsive: every probe is killed
/// once it passes this deadline.
const PROBE_TIMEOUT: Duration = Duration::from_secs(2);
/// Enough for a version banner or one "npm root -g" path; a launcher that
/// prints endlessly must not grow our heap.
const PROBE_MAX_BYTES: u64 = 4096;
/// Directory scans are bounded like doctor's PATH scan.
const DIR_SCAN_MAX_ENTRIES: usize = 64;
const PATH_SCAN_MAX_DIRS: usize = 64;
/// A pnpm policy file is small; anything larger is not one we understand.
const CONFIG_MAX_BYTES: u64 = 65536;

/// Run one read-only probe and return its stdout when it exits 0. A failed
/// spawn, a non-zero exit, a timeout and a stuck reader all collapse to None,
/// so callers never have to tell "missing" from "broken" apart.
pub(crate) fn run_bounded_capture(
    mut command: std::process::Command,
    limit: u64,
    timeout: Duration,
) -> Option<Vec<u8>> {
    use std::io::Read;
    use std::process::Stdio;

    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut child = command.spawn().ok()?;
    let stdout = child.stdout.take()?;
    let (sender, receiver) = std::sync::mpsc::channel();
    // A descendant can inherit the pipe and keep it open; the deadline below
    // must not wait on this reader, so it is never joined.
    std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let result = stdout.take(limit).read_to_end(&mut bytes).map(|_| bytes);
        let _ = sender.send(result);
    });
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                if !status.success() {
                    return None;
                }
                break;
            }
            Ok(None) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(10));
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
    receiver
        .recv_timeout(deadline.saturating_duration_since(Instant::now()))
        .ok()?
        .ok()
}

/// First non-empty line of a probe, trimmed. Version banners and "npm root -g"
/// both answer on one line.
pub(crate) fn first_line(bytes: &[u8]) -> Option<String> {
    String::from_utf8_lossy(bytes)
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(str::to_string)
}

/// Executable names a shim directory uses for a tool, in probing order.
/// Windows npm/pnpm shims are batch files rather than symlinks.
pub(crate) fn tool_file_names(tool: &str) -> Vec<String> {
    #[cfg(windows)]
    {
        vec![
            format!("{tool}.cmd"),
            format!("{tool}.exe"),
            format!("{tool}.bat"),
            format!("{tool}.ps1"),
            tool.to_string(),
        ]
    }
    #[cfg(not(windows))]
    {
        vec![tool.to_string()]
    }
}

/// First executable tool on PATH, bounded. An empty PATH entry is skipped like
/// the shell does; only execute-permitted files count.
pub(crate) fn find_on_path(tool: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path).take(PATH_SCAN_MAX_DIRS) {
        if dir.as_os_str().is_empty() {
            continue;
        }
        for name in tool_file_names(tool) {
            let candidate = dir.join(name);
            if crate::executable::is_executable(&candidate) {
                return Some(candidate);
            }
        }
    }
    None
}

/// True when path is runnable as a delegated entrypoint: a plain JavaScript
/// file only has to exist, anything else must be executable. Kept in step with
/// passthrough's rule for the original binary.
fn runnable_entry(path: &Path) -> bool {
    if path.extension().is_some_and(|ext| ext == "js") {
        return path.is_file();
    }
    crate::executable::is_executable(path)
}

fn is_same_file(candidate: &Path, me: Option<&Path>) -> bool {
    let Some(me) = me else {
        return false;
    };
    match (std::fs::canonicalize(candidate), std::fs::canonicalize(me)) {
        (Ok(candidate), Ok(me)) => candidate == me,
        _ => false,
    }
}

/// v20.11.0 and 20.11.0 both name a Node install. Anything else is not a
/// version directory and is ignored rather than guessed at.
pub(crate) fn parse_node_version_dir(name: &str) -> Option<(u64, u64, u64)> {
    let value = name.strip_prefix('v').unwrap_or(name);
    let mut parts = value.split('.');
    let major: u64 = parts.next()?.parse().ok()?;
    let minor: u64 = parts.next()?.parse().ok()?;
    let patch: u64 = parts.next()?.parse().ok()?;
    if parts.next().is_some() {
        return None;
    }
    Some((major, minor, patch))
}

/// Matching Node version directory names, newest first, so a host with several
/// nvm installs delegates to the most recent one. Pure over the names.
pub(crate) fn sort_node_versions_desc(names: &[String]) -> Vec<String> {
    let mut versions: Vec<(String, (u64, u64, u64))> = names
        .iter()
        .filter_map(|name| parse_node_version_dir(name).map(|version| (name.clone(), version)))
        .collect();
    versions.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| b.0.cmp(&a.0)));
    versions.into_iter().map(|(name, _)| name).collect()
}

/// Host directories that exist even when PATH was never initialized by the
/// user's shell profile. Plain values keep the candidate builder pure.
#[derive(Debug, Default, Clone)]
pub(crate) struct ShimEnv {
    pub volta_home: Option<String>,
    pub pnpm_home: Option<String>,
    pub npm_prefix: Option<String>,
}

fn env_value(names: &[&str]) -> Option<String> {
    names
        .iter()
        .find_map(|name| std::env::var(name).ok().filter(|value| !value.is_empty()))
}

pub(crate) fn shim_env() -> ShimEnv {
    ShimEnv {
        volta_home: env_value(&["VOLTA_HOME"]),
        pnpm_home: env_value(&["PNPM_HOME"]),
        // npm reads the lower-case spelling first (npm_config_prefix).
        npm_prefix: env_value(&["npm_config_prefix", "NPM_CONFIG_PREFIX", "PREFIX"]),
    }
}

/// Ordered entrypoints for a tool under the directories a version manager or a
/// global package install uses. Pure over its inputs so tests can build a fake
/// host layout without touching the process environment.
pub(crate) fn fallback_tool_paths(
    home: &Path,
    tool: &str,
    node_versions: &[String],
    env: &ShimEnv,
    npm_root: Option<&Path>,
) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    // nvm: ~/.nvm/versions/node/<version>/bin, newest install first.
    for version in sort_node_versions_desc(node_versions) {
        dirs.push(
            home.join(".nvm")
                .join("versions")
                .join("node")
                .join(version)
                .join("bin"),
        );
    }
    // fnm exposes a single "default" alias instead of a version list.
    dirs.push(
        home.join(".local")
            .join("share")
            .join("fnm")
            .join("aliases")
            .join("default")
            .join("bin"),
    );
    dirs.push(
        home.join(".fnm")
            .join("aliases")
            .join("default")
            .join("bin"),
    );
    // volta keeps shims in one directory.
    dirs.push(match env.volta_home.as_ref() {
        Some(root) => PathBuf::from(root).join("bin"),
        None => home.join(".volta").join("bin"),
    });
    // pnpm's global bin directory is PNPM_HOME itself (pnpm setup adds it to
    // PATH); some layouts keep a bin/ subdirectory.
    let pnpm_home = match env.pnpm_home.as_ref() {
        Some(root) => PathBuf::from(root),
        None => home.join(".local").join("share").join("pnpm"),
    };
    dirs.push(pnpm_home.clone());
    dirs.push(pnpm_home.join("bin"));
    #[cfg(windows)]
    {
        // Windows keeps pnpm's shims outside HOME, so they need their own probe.
        if let Some(root) = env_value(&["LOCALAPPDATA"]) {
            dirs.push(PathBuf::from(root).join("pnpm"));
        }
    }
    // npm global installs. The per-user prefixes mirror sync-dsh.sh's candidate
    // list, so a tree installed outside npm's own global root is still found.
    let mut npm_roots: Vec<PathBuf> = Vec::new();
    if let Some(root) = npm_root {
        npm_roots.push(root.to_path_buf());
    }
    #[cfg(not(windows))]
    {
        npm_roots.push(home.join(".npm-global").join("lib").join("node_modules"));
        npm_roots.push(home.join(".local").join("lib").join("node_modules"));
    }
    if let Some(prefix) = env.npm_prefix.as_ref() {
        #[cfg(windows)]
        dirs.push(PathBuf::from(prefix));
        #[cfg(not(windows))]
        dirs.push(PathBuf::from(prefix).join("bin"));
    }
    #[cfg(not(windows))]
    {
        dirs.push(home.join(".npm-global").join("bin"));
        dirs.push(home.join(".local").join("bin"));
    }
    // <prefix>/bin on Unix, the prefix itself on Windows, plus the ".bin"
    // directory inside the root on every platform.
    for root in &npm_roots {
        #[cfg(windows)]
        {
            if let Some(prefix) = root.parent() {
                dirs.push(prefix.to_path_buf());
            }
        }
        #[cfg(not(windows))]
        {
            if let Some(prefix) = root.parent().and_then(Path::parent) {
                dirs.push(prefix.join("bin"));
            }
        }
        dirs.push(root.join(".bin"));
    }

    let names = tool_file_names(tool);
    let mut out: Vec<PathBuf> = Vec::new();
    for dir in dirs {
        for name in &names {
            let candidate = dir.join(name);
            if !out.contains(&candidate) {
                out.push(candidate);
            }
        }
    }
    if tool == "dsh" {
        // The package entrypoint survives "npm install --no-bin-links", where
        // no dsh shim is written at all. Node runs the .js file directly.
        for root in &npm_roots {
            let entry = root
                .join("@deepseek-ai")
                .join("dsh")
                .join("lib")
                .join("bin.js");
            if !out.contains(&entry) {
                out.push(entry);
            }
        }
    }
    out
}

/// IO wrapper: Node version directory names under ~/.nvm/versions/node.
fn nvm_version_dirs(home: &Path) -> Vec<String> {
    let dir = home.join(".nvm").join("versions").join("node");
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    entries
        .flatten()
        .take(DIR_SCAN_MAX_ENTRIES)
        .filter(|entry| entry.metadata().is_ok_and(|meta| meta.is_dir()))
        .filter_map(|entry| entry.file_name().to_str().map(str::to_owned))
        .collect()
}

/// Newest executable Node under ~/.nvm/versions/node. nvm names its trees
/// vX.Y.Z with no OS/CPU label because they are built for this host, so the
/// dist-tree rules in passthrough do not match them.
pub(crate) fn latest_nvm_node(home: &Path) -> Option<PathBuf> {
    let base = home.join(".nvm").join("versions").join("node");
    for version in sort_node_versions_desc(&nvm_version_dirs(home)) {
        if let Some(node) = nvm_node_in(&base.join(version)) {
            return Some(node);
        }
    }
    None
}

/// The Node inside one nvm version directory, if it is executable.
fn nvm_node_in(version_dir: &Path) -> Option<PathBuf> {
    let node = version_dir
        .join("bin")
        .join(if cfg!(windows) { "node.exe" } else { "node" });
    if crate::executable::is_executable(&node) {
        return Some(node);
    }
    #[cfg(windows)]
    {
        // The official Windows archive keeps node.exe at the tree root.
        let node = version_dir.join("node.exe");
        if crate::executable::is_executable(&node) {
            return Some(node);
        }
    }
    None
}

/// Node that owns a dsh living under one of its ancestors, for the nvm layout
/// the dist-label rule cannot recognize. The parent name is checked so an
/// unrelated vX.Y.Z directory is never mistaken for a Node tree.
pub(crate) fn nvm_node_ancestor(entry: &Path) -> Option<PathBuf> {
    for ancestor in entry.ancestors().skip(1) {
        let Some(name) = ancestor.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        if parse_node_version_dir(name).is_none() {
            continue;
        }
        let parent = ancestor
            .parent()
            .and_then(|parent| parent.file_name())
            .and_then(|name| name.to_str());
        if parent != Some("node") {
            continue;
        }
        if let Some(node) = nvm_node_in(ancestor) {
            return Some(node);
        }
    }
    None
}

/// "npm root -g", resolved without depending on an interactive shell. The
/// probe is cached: discovery and both doctor passes ask for it.
pub(crate) fn npm_global_root() -> Option<PathBuf> {
    static CACHE: std::sync::OnceLock<Option<PathBuf>> = std::sync::OnceLock::new();
    CACHE.get_or_init(probe_npm_global_root).clone()
}

fn probe_npm_global_root() -> Option<PathBuf> {
    if let Some(prefix) = shim_env().npm_prefix {
        #[cfg(windows)]
        let root = PathBuf::from(prefix).join("node_modules");
        #[cfg(not(windows))]
        let root = PathBuf::from(prefix).join("lib").join("node_modules");
        if root.is_dir() {
            return Some(root);
        }
    }
    let mut command = std::process::Command::new(find_on_path("npm")?);
    command.arg("root").arg("-g");
    let bytes = run_bounded_capture(command, PROBE_MAX_BYTES, PROBE_TIMEOUT)?;
    let root = PathBuf::from(first_line(&bytes)?);
    // Only an absolute, existing directory is trusted: npm can print a warning
    // line first, and a relative answer would resolve against our cwd.
    (root.is_absolute() && root.is_dir()).then_some(root)
}

/// First tool under the fallback directories, never our own binary. Callers try
/// PATH and the local backups first; this is the last resort.
pub(crate) fn find_tool_fallback(tool: &str, me: Option<&Path>) -> Option<String> {
    let home = PathBuf::from(crate::inspect::home_dir()?);
    let versions = nvm_version_dirs(&home);
    let env = shim_env();
    // The manager directories cost only stat calls, so they are probed before
    // the npm global root, whose resolution can spawn "npm root -g". A host
    // with an nvm/fnm/volta/pnpm install therefore never pays for that probe.
    let mut candidates = fallback_tool_paths(&home, tool, &versions, &env, None);
    if let Some(root) = npm_global_root() {
        candidates.extend(fallback_tool_paths(
            &home,
            tool,
            &versions,
            &env,
            Some(&root),
        ));
    }
    for candidate in candidates {
        if !runnable_entry(&candidate) || is_same_file(&candidate, me) {
            continue;
        }
        return Some(candidate.to_string_lossy().into_owned());
    }
    None
}

/// major.minor.patch from a version banner. A leading "v" and a pre-release
/// suffix are tolerated; anything else is unknown.
pub(crate) fn parse_version(value: &str) -> Option<(u64, u64, u64)> {
    let value = value.trim();
    let value = value.strip_prefix('v').unwrap_or(value);
    let mut parts = value.split(['.', '-']);
    let major: u64 = parts.next()?.parse().ok()?;
    let minor: u64 = parts.next().unwrap_or("0").parse().ok()?;
    let patch: u64 = parts.next().unwrap_or("0").parse().ok()?;
    Some((major, minor, patch))
}

/// The command that approves pending dependency builds for the installed pnpm.
///
/// pnpm 10 began ignoring dependency build scripts by default. "--all" arrived
/// in 10.32, "-g" was removed in 11.0.0 and restored in 11.24.0, so a single
/// hard-coded command would fail on some releases.
pub(crate) fn approve_builds_command(version: Option<&str>) -> Option<String> {
    let Some((major, minor, _)) = version.and_then(parse_version) else {
        return Some("pnpm approve-builds -g".to_string());
    };
    if major < 10 {
        // pnpm 9 and older ran dependency build scripts by default.
        return None;
    }
    if major == 10 && minor >= 32 {
        return Some("pnpm approve-builds --all -g".to_string());
    }
    if major == 10 {
        return Some("pnpm approve-builds -g".to_string());
    }
    if major == 11 && minor < 24 {
        // No global form in this range (pnpm 11.0.0-11.23.x): decide at install time.
        return Some("pnpm add -g --allow-build=<package> <package>".to_string());
    }
    Some("pnpm approve-builds -g".to_string())
}

/// True when a pnpm config file already allows dependency build scripts.
/// onlyBuiltDependencies (pnpm 10) and allowBuilds (pnpm 11) are matched after
/// dropping the separators and the "[]" array suffix, so both the camelCase and
/// the INI kebab-case spelling count.
pub(crate) fn build_approval_in(config: &str) -> bool {
    config.lines().any(|line| {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') || line.starts_with(';') {
            return false;
        }
        let (key, value) = match line.split_once(['=', ':']) {
            Some((key, value)) => (key, value),
            None => (line, ""),
        };
        let key: String = key
            .trim()
            .trim_end_matches("[]")
            .chars()
            .filter(char::is_ascii_alphanumeric)
            .map(|character| character.to_ascii_lowercase())
            .collect();
        let value = value
            .trim()
            .trim_matches('"')
            .trim_matches('\'')
            .to_ascii_lowercase();
        match key.as_str() {
            // The key alone records the decision: a YAML map or list header has
            // an empty value on its own line.
            "onlybuiltdependencies" | "allowbuilds" => true,
            "dangerouslyallowallbuilds" => value != "false" && value != "0",
            _ => false,
        }
    })
}

fn env_build_approval() -> bool {
    std::env::vars().any(|(name, value)| {
        let name: String = name
            .chars()
            .filter(char::is_ascii_alphanumeric)
            .map(|character| character.to_ascii_lowercase())
            .collect();
        let normalized = name
            .strip_prefix("npmconfig")
            .or_else(|| name.strip_prefix("pnpmconfig"))
            .unwrap_or(&name);
        let value = value.trim().to_ascii_lowercase();
        match normalized {
            "onlybuiltdependencies" | "allowbuilds" => !value.is_empty(),
            "dangerouslyallowallbuilds" => value != "false" && value != "0",
            _ => false,
        }
    })
}

/// pnpm reads its global "rc" from the platform config directory.
fn global_pnpm_config_files() -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    if let Ok(xdg) = std::env::var("XDG_CONFIG_HOME") {
        if !xdg.is_empty() {
            out.push(PathBuf::from(xdg).join("pnpm").join("rc"));
        }
    }
    if let Some(home) = crate::inspect::home_dir() {
        let home = PathBuf::from(home);
        out.push(home.join(".config").join("pnpm").join("rc"));
        #[cfg(target_os = "macos")]
        out.push(
            home.join("Library")
                .join("Preferences")
                .join("pnpm")
                .join("rc"),
        );
    }
    #[cfg(windows)]
    {
        if let Some(root) = env_value(&["LOCALAPPDATA"]) {
            out.push(PathBuf::from(root).join("pnpm").join("config").join("rc"));
        }
    }
    out
}

/// Every place a global build-script policy can live, most specific first: the
/// pnpm config, the pnpm home and the DSH_HOME a plugin install runs in.
fn build_policy_files() -> Vec<PathBuf> {
    let mut out = global_pnpm_config_files();
    let home = crate::inspect::home_dir().map(PathBuf::from);
    let pnpm_home = match shim_env().pnpm_home {
        Some(root) => PathBuf::from(root),
        None => match &home {
            Some(home) => home.join(".local").join("share").join("pnpm"),
            None => PathBuf::new(),
        },
    };
    if !pnpm_home.as_os_str().is_empty() {
        out.push(pnpm_home.join("pnpm-workspace.yaml"));
        // Global installs write the policy into the global packages dir's
        // workspace file; its version component changes between releases.
        if let Ok(entries) = std::fs::read_dir(pnpm_home.join("global")) {
            for entry in entries.flatten().take(DIR_SCAN_MAX_ENTRIES) {
                if entry.metadata().is_ok_and(|meta| meta.is_dir()) {
                    out.push(entry.path().join("pnpm-workspace.yaml"));
                }
            }
        }
    }
    out.push(PathBuf::from(crate::inspect::dsh_home()).join("pnpm-workspace.yaml"));
    out
}

fn read_small_text(path: &Path) -> Option<String> {
    let metadata = std::fs::metadata(path).ok()?;
    if !metadata.is_file() || metadata.len() > CONFIG_MAX_BYTES {
        return None;
    }
    std::fs::read_to_string(path).ok()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum BuildScripts {
    /// No pnpm on this host: nothing to approve.
    Absent,
    /// A global approval setting is already recorded.
    Preapproved,
    /// pnpm's default policy blocks dependency build scripts.
    Blocked,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ToolInfo {
    pub path: String,
    pub version: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct EnvReport {
    pub node: Option<ToolInfo>,
    pub npm: Option<ToolInfo>,
    pub npm_root: Option<String>,
    pub pnpm: Option<ToolInfo>,
    pub build_scripts: BuildScripts,
    /// The policy file the decision came from, when one was read.
    pub build_config: Option<String>,
    /// Complete resolution commands, printed by doctor as-is.
    pub fixes: Vec<String>,
}

fn tool_info(program: Option<PathBuf>) -> Option<ToolInfo> {
    let program = program?;
    let mut command = std::process::Command::new(&program);
    command.arg("--version");
    let version = run_bounded_capture(command, PROBE_MAX_BYTES, PROBE_TIMEOUT)
        .and_then(|bytes| first_line(&bytes));
    Some(ToolInfo {
        path: program.to_string_lossy().into_owned(),
        version,
    })
}

/// Node.js, npm and pnpm as this host actually resolves them, plus the pnpm
/// build-script policy. Every field is best-effort: a probe that fails only
/// makes the report less specific, never an error.
pub(crate) fn diagnose() -> EnvReport {
    let node = tool_info(crate::passthrough::find_node_bin().map(PathBuf::from));
    let npm = tool_info(find_on_path("npm"));
    let npm_root = npm_global_root().map(|path| path.to_string_lossy().into_owned());
    let pnpm = tool_info(find_on_path("pnpm").or_else(|| {
        // The fallback scan needs a HOME; without one PATH is all we have.
        crate::inspect::home_dir()?;
        find_tool_fallback("pnpm", None).map(PathBuf::from)
    }));

    let mut build_config = None;
    let build_scripts = if pnpm.is_none() {
        BuildScripts::Absent
    } else if env_build_approval() {
        BuildScripts::Preapproved
    } else {
        let files = build_policy_files();
        // Report the file that decided, so "allowed by the global config" always
        // names the file a reader can open. Without a decision, report the first
        // policy file that exists.
        let mut first_readable = None;
        let mut approved = None;
        for path in &files {
            let Some(text) = read_small_text(path) else {
                continue;
            };
            if first_readable.is_none() {
                first_readable = Some(path.to_string_lossy().into_owned());
            }
            if build_approval_in(&text) {
                approved = Some(path.to_string_lossy().into_owned());
                break;
            }
        }
        let was_approved = approved.is_some();
        build_config = approved.or(first_readable).or_else(|| {
            files
                .first()
                .map(|path| path.to_string_lossy().into_owned())
        });
        if was_approved {
            BuildScripts::Preapproved
        } else {
            BuildScripts::Blocked
        }
    };

    let mut fixes: Vec<String> = Vec::new();
    let node_version = node
        .as_ref()
        .and_then(|node| node.version.as_deref())
        .and_then(parse_version);
    if !matches!(node_version, Some((major, _, _)) if major >= 22) {
        fixes.push("install Node.js 22+ (nvm install 22 / volta install node@22)".to_string());
    }
    if pnpm.is_none() {
        fixes.push("npm install -g pnpm".to_string());
    } else if build_scripts == BuildScripts::Blocked {
        if let Some(command) =
            approve_builds_command(pnpm.as_ref().and_then(|pnpm| pnpm.version.as_deref()))
        {
            fixes.push(command);
        }
    }

    EnvReport {
        node,
        npm,
        npm_root,
        pnpm,
        build_scripts,
        build_config,
        fixes,
    }
}

fn locale_text(
    locale: Locale,
    english: &'static str,
    chinese: &'static str,
    japanese: &'static str,
) -> &'static str {
    match locale {
        Locale::English => english,
        Locale::Chinese => chinese,
        Locale::Japanese => japanese,
    }
}

/// Localized doctor lines for the environment block. Warnings only: doctor's
/// exit status still depends on the original dsh alone.
pub(crate) fn doctor_lines(report: &EnvReport, locale: Locale) -> Vec<String> {
    let mut out = Vec::new();
    match &report.node {
        Some(node) => {
            let path = node.path.clone();
            let version = node
                .version
                .clone()
                .unwrap_or_else(|| "<unknown version>".to_string());
            out.push(localized_format!(
                locale,
                "[rdsh] node: {path} ({version})",
                "[rdsh] node：{path}（{version}）",
                "[rdsh] node: {path}（{version}）"
            ));
            if let Some((major, _, _)) = node.version.as_deref().and_then(parse_version) {
                if major < 22 {
                    let version = node.version.clone().unwrap_or_default();
                    out.push(localized_format!(
                        locale,
                        "[rdsh] warn: node {version} is older than DSH's Node.js 22 requirement",
                        "[rdsh] 警告：node {version} 低于 DSH 所需的 Node.js 22",
                        "[rdsh] 警告: node {version} はDSHが要求するNode.js 22より古いです"
                    ));
                }
            }
        }
        None => out.push(localized_format!(
            locale,
            "[rdsh] warn: no Node.js runtime found; DSH needs Node.js 22 or newer",
            "[rdsh] 警告：未找到 Node.js 运行时；DSH 需要 Node.js 22 或更高版本",
            "[rdsh] 警告: Node.js ランタイムが見つかりません。DSHにはNode.js 22以上が必要です"
        )),
    }
    match (&report.npm, &report.npm_root) {
        (Some(npm), Some(root)) => {
            let path = npm.path.clone();
            let root = root.clone();
            out.push(localized_format!(
                locale,
                "[rdsh] npm: {path} | global root: {root}",
                "[rdsh] npm：{path} | 全局根目录：{root}",
                "[rdsh] npm: {path} | グローバルルート: {root}"
            ));
        }
        (Some(npm), None) => {
            let path = npm.path.clone();
            out.push(localized_format!(
                locale,
                "[rdsh] npm: {path} | global root: <unresolved>",
                "[rdsh] npm：{path} | 全局根目录：<未解析>",
                "[rdsh] npm: {path} | グローバルルート: <未解決>"
            ));
        }
        (None, _) => out.push(localized_format!(
            locale,
            "[rdsh] npm: <not found on PATH>",
            "[rdsh] npm：<PATH中未找到>",
            "[rdsh] npm: <PATH上に見つかりません>"
        )),
    }
    match &report.pnpm {
        Some(pnpm) => {
            let path = pnpm.path.clone();
            let version = pnpm
                .version
                .clone()
                .unwrap_or_else(|| "<unknown version>".to_string());
            let state = match report.build_scripts {
                BuildScripts::Preapproved => locale_text(
                    locale,
                    "build scripts allowed by the global config",
                    "全局配置允许构建脚本",
                    "グローバル設定でビルドスクリプトを許可済み",
                ),
                _ => locale_text(
                    locale,
                    "build scripts not pre-approved (pnpm 10+ ignores them by default)",
                    "构建脚本未经预先批准（pnpm 10+ 默认忽略）",
                    "ビルドスクリプトは事前承認なし（pnpm 10以降は既定で無視）",
                ),
            };
            out.push(localized_format!(
                locale,
                "[rdsh] pnpm: {path} ({version}) | {state}",
                "[rdsh] pnpm：{path}（{version}）| {state}",
                "[rdsh] pnpm: {path}（{version}）| {state}"
            ));
            if let Some(config) = report.build_config.as_ref() {
                let config = config.clone();
                out.push(localized_format!(
                    locale,
                    "[rdsh] pnpm policy file: {config}",
                    "[rdsh] pnpm 策略文件：{config}",
                    "[rdsh] pnpm ポリシーファイル: {config}"
                ));
            }
        }
        None => out.push(localized_format!(
            locale,
            "[rdsh] pnpm: <not found>; DSH plugin installs run through pnpm",
            "[rdsh] pnpm：<未找到>；DSH 插件安装通过 pnpm 进行",
            "[rdsh] pnpm: <見つかりません>。DSHのプラグイン導入はpnpm経由で実行されます"
        )),
    }
    for command in &report.fixes {
        out.push(localized_format!(
            locale,
            "[rdsh] fix: {command}",
            "[rdsh] 修复：{command}",
            "[rdsh] 修正: {command}"
        ));
    }
    if report.build_scripts == BuildScripts::Blocked && report.pnpm.is_some() {
        out.push(localized_format!(
            locale,
            "[rdsh] note: if an install stops with ERR_PNPM_IGNORED_BUILDS, run the fix above",
            "[rdsh] 提示：若安装因 ERR_PNPM_IGNORED_BUILDS 中止，请运行上面的修复命令",
            "[rdsh] 注記: インストールがERR_PNPM_IGNORED_BUILDSで止まった場合、上の修正コマンドを実行してください"
        ));
    }
    out
}

fn tool_json(tool: &Option<ToolInfo>) -> serde_json::Value {
    match tool {
        Some(tool) => serde_json::json!({
            "found": true,
            "path": tool.path,
            "version": tool.version,
        }),
        None => serde_json::json!({ "found": false, "path": null, "version": null }),
    }
}

/// Machine-readable projection for "rdsh doctor --json". Field names stay
/// stable; the surrounding report keeps its own schema number.
pub(crate) fn json(report: &EnvReport) -> serde_json::Value {
    serde_json::json!({
        "node": tool_json(&report.node),
        "npm": {
            "found": report.npm.is_some(),
            "path": report.npm.as_ref().map(|npm| npm.path.clone()),
            "global_root": report.npm_root,
        },
        "pnpm": {
            "found": report.pnpm.is_some(),
            "path": report.pnpm.as_ref().map(|pnpm| pnpm.path.clone()),
            "version": report.pnpm.as_ref().and_then(|pnpm| pnpm.version.clone()),
            "build_scripts": match report.build_scripts {
                BuildScripts::Absent => "absent",
                BuildScripts::Preapproved => "preapproved",
                BuildScripts::Blocked => "unapproved",
            },
            "policy_file": report.build_config,
        },
        "fixes": report.fixes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strings(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_string()).collect()
    }

    /// One shim path for a directory, using the platform's first file name.
    /// Returned as a path, not a display string: Windows joins with '\' while
    /// the literal above is written with '/', and both spell the same path.
    fn shim(dir: &str, tool: &str) -> PathBuf {
        Path::new(dir).join(tool_file_names(tool)[0].clone())
    }

    fn paths_for(
        home: &Path,
        tool: &str,
        versions: &[String],
        env: &ShimEnv,
        npm_root: Option<&Path>,
    ) -> Vec<PathBuf> {
        fallback_tool_paths(home, tool, versions, env, npm_root)
    }

    fn report(
        node: Option<ToolInfo>,
        npm: Option<ToolInfo>,
        npm_root: Option<&str>,
        pnpm: Option<ToolInfo>,
        build_scripts: BuildScripts,
        fixes: &[&str],
    ) -> EnvReport {
        EnvReport {
            node,
            npm,
            npm_root: npm_root.map(str::to_string),
            pnpm,
            build_scripts,
            build_config: Some("/home/u/.config/pnpm/rc".to_string()),
            fixes: fixes.iter().map(|fix| (*fix).to_string()).collect(),
        }
    }

    #[test]
    fn node_version_directories_sort_newest_first() {
        let names = strings(&[
            "v18.20.4",
            "v22.10.0",
            "not-a-version",
            "v20.11.0",
            "v22.9.0",
        ]);
        assert_eq!(
            sort_node_versions_desc(&names),
            strings(&["v22.10.0", "v22.9.0", "v20.11.0", "v18.20.4"])
        );
        // Numeric, not lexicographic: v9 must sort below v10.
        assert_eq!(
            sort_node_versions_desc(&strings(&["v9.11.2", "v10.0.0"])),
            strings(&["v10.0.0", "v9.11.2"])
        );
        assert_eq!(parse_node_version_dir("v22.10.0"), Some((22, 10, 0)));
        assert_eq!(parse_node_version_dir("20.11.0"), Some((20, 11, 0)));
        assert_eq!(parse_node_version_dir("node-v22.10.0"), None);
    }

    #[test]
    fn fallback_paths_cover_every_documented_manager_in_order() {
        let home = Path::new("/home/u");
        let versions = strings(&["v20.11.0", "v22.10.0"]);
        let paths = paths_for(home, "dsh", &versions, &ShimEnv::default(), None);

        // The newest nvm install is tried first, and only then the others.
        assert_eq!(
            paths[0],
            shim("/home/u/.nvm/versions/node/v22.10.0/bin", "dsh")
        );
        let index = |path: &Path| {
            paths
                .iter()
                .position(|entry| entry.as_path() == path)
                .unwrap()
        };
        let newest = index(&shim("/home/u/.nvm/versions/node/v22.10.0/bin", "dsh"));
        let older = index(&shim("/home/u/.nvm/versions/node/v20.11.0/bin", "dsh"));
        let volta = index(&shim("/home/u/.volta/bin", "dsh"));
        let pnpm = index(&shim("/home/u/.local/share/pnpm", "dsh"));
        let fnm = index(&shim("/home/u/.local/share/fnm/aliases/default/bin", "dsh"));
        // Node version managers first (newest nvm tree, then fnm), then the
        // single-shim managers, so a newer Node install always wins.
        assert!(newest < older && older < fnm && fnm < volta && volta < pnpm);
    }

    #[test]
    fn voluntary_manager_homes_override_the_default_directories() {
        let env = ShimEnv {
            volta_home: Some("/opt/volta".to_string()),
            pnpm_home: Some("/opt/pnpm".to_string()),
            ..ShimEnv::default()
        };
        let paths = paths_for(Path::new("/home/u"), "dsh", &[], &env, None);
        assert!(paths.contains(&shim("/opt/volta/bin", "dsh")));
        assert!(paths.contains(&shim("/opt/pnpm", "dsh")));
        assert!(paths.contains(&shim("/opt/pnpm/bin", "dsh")));
        assert!(!paths.contains(&shim("/home/u/.volta/bin", "dsh")));
    }

    #[test]
    fn npm_global_root_adds_the_prefix_shim_bin_link_and_package_entrypoint() {
        let root = Path::new("/usr/local/lib/node_modules");
        let paths = paths_for(
            Path::new("/home/u"),
            "dsh",
            &[],
            &ShimEnv::default(),
            Some(root),
        );
        assert!(paths.contains(&root.join(".bin").join("dsh")));
        assert!(paths.contains(
            &root
                .join("@deepseek-ai")
                .join("dsh")
                .join("lib")
                .join("bin.js")
        ));
        #[cfg(unix)]
        assert!(paths.contains(&PathBuf::from("/usr/local/bin/dsh")));
        // pnpm has no npm package entrypoint candidate.
        let pnpm_paths = paths_for(
            Path::new("/home/u"),
            "pnpm",
            &[],
            &ShimEnv::default(),
            Some(root),
        );
        assert!(!pnpm_paths.iter().any(|path| path.ends_with("bin.js")));
    }

    #[test]
    fn npm_prefix_env_adds_the_global_bin_directory() {
        let env = ShimEnv {
            npm_prefix: Some("/opt/node".to_string()),
            ..ShimEnv::default()
        };
        let paths = paths_for(Path::new("/home/u"), "dsh", &[], &env, None);
        #[cfg(not(windows))]
        assert!(paths.contains(&shim("/opt/node/bin", "dsh")));
        #[cfg(windows)]
        assert!(paths.contains(&shim("/opt/node", "dsh")));
    }

    #[test]
    fn version_banners_parse_with_and_without_a_prefix() {
        assert_eq!(parse_version("v22.10.0"), Some((22, 10, 0)));
        assert_eq!(parse_version("22.10.0"), Some((22, 10, 0)));
        assert_eq!(parse_version("11.0.0-beta.1"), Some((11, 0, 0)));
        assert_eq!(parse_version("10"), Some((10, 0, 0)));
        assert_eq!(parse_version("not-a-version"), None);
    }

    /// A single hard-coded approve command would fail: "--all" arrived in
    /// 10.32 and "-g" was removed between 11.0.0 and 11.23.x.
    #[test]
    fn approve_builds_command_matches_the_pnpm_release_that_supports_it() {
        assert_eq!(approve_builds_command(Some("9.15.0")), None);
        assert_eq!(
            approve_builds_command(Some("10.12.1")).unwrap(),
            "pnpm approve-builds -g"
        );
        assert_eq!(
            approve_builds_command(Some("10.32.0")).unwrap(),
            "pnpm approve-builds --all -g"
        );
        assert_eq!(
            approve_builds_command(Some("11.0.0")).unwrap(),
            "pnpm add -g --allow-build=<package> <package>"
        );
        assert_eq!(
            approve_builds_command(Some("11.23.9")).unwrap(),
            "pnpm add -g --allow-build=<package> <package>"
        );
        assert_eq!(
            approve_builds_command(Some("11.24.0")).unwrap(),
            "pnpm approve-builds -g"
        );
        assert_eq!(
            approve_builds_command(Some("12.1.0")).unwrap(),
            "pnpm approve-builds -g"
        );
        assert_eq!(
            approve_builds_command(None).unwrap(),
            "pnpm approve-builds -g"
        );
    }

    #[test]
    fn build_approval_only_counts_positive_settings() {
        assert!(build_approval_in(
            "only-built-dependencies[]=sharp
"
        ));
        assert!(build_approval_in(
            "onlyBuiltDependencies:
  - sharp
"
        ));
        assert!(build_approval_in(
            "allowBuilds:
  sharp: true
"
        ));
        assert!(build_approval_in(
            "dangerously-allow-all-builds=true
"
        ));
        assert!(!build_approval_in(
            "dangerously-allow-all-builds=false
"
        ));
        assert!(!build_approval_in(
            "ignoredBuiltDependencies:
  - esbuild
"
        ));
        assert!(!build_approval_in(
            "# onlyBuiltDependencies: sharp
"
        ));
        assert!(!build_approval_in(
            "registry=https://registry.npmjs.org/
"
        ));
    }

    #[test]
    fn nvm_version_dirs_reads_only_real_version_directories() {
        let root = std::env::temp_dir().join(format!(
            "rdsh-dsh-env-{}-{}",
            std::process::id(),
            crate::local_http::random_token().unwrap()
        ));
        let versions = root.join(".nvm").join("versions").join("node");
        std::fs::create_dir_all(versions.join("v22.10.0")).unwrap();
        std::fs::create_dir_all(versions.join("v20.11.0")).unwrap();
        std::fs::write(versions.join("v18.20.4"), "").unwrap();
        assert_eq!(
            sort_node_versions_desc(&nvm_version_dirs(&root)),
            strings(&["v22.10.0", "v20.11.0"])
        );
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn doctor_lines_print_the_pnpm_fix_only_while_builds_are_blocked() {
        let mut report = report(
            Some(ToolInfo {
                path: "/usr/bin/node".to_string(),
                version: Some("v22.10.0".to_string()),
            }),
            None,
            None,
            Some(ToolInfo {
                path: "/home/u/.local/share/pnpm/pnpm".to_string(),
                version: Some("10.32.0".to_string()),
            }),
            BuildScripts::Blocked,
            &["pnpm approve-builds --all -g"],
        );
        let lines = doctor_lines(&report, Locale::English);
        assert!(
            lines
                .iter()
                .any(|line| line.contains("/usr/bin/node (v22.10.0)")),
            "{lines:?}"
        );
        assert!(
            lines
                .iter()
                .any(|line| line.contains("fix: pnpm approve-builds --all -g")),
            "{lines:?}"
        );
        assert!(
            lines
                .iter()
                .any(|line| line.contains("ERR_PNPM_IGNORED_BUILDS")),
            "{lines:?}"
        );

        // An approved policy must stay quiet about the fix.
        report.build_scripts = BuildScripts::Preapproved;
        report.fixes.clear();
        let lines = doctor_lines(&report, Locale::English);
        assert!(
            lines
                .iter()
                .any(|line| line.contains("allowed by the global config")),
            "{lines:?}"
        );
        assert!(!lines.iter().any(|line| line.contains("fix:")), "{lines:?}");
        assert!(
            !lines
                .iter()
                .any(|line| line.contains("ERR_PNPM_IGNORED_BUILDS")),
            "{lines:?}"
        );
    }

    #[test]
    fn doctor_lines_warn_when_node_is_missing_or_older_than_dsh_needs() {
        let report = report(
            Some(ToolInfo {
                path: "/usr/bin/node".to_string(),
                version: Some("v20.11.0".to_string()),
            }),
            None,
            None,
            None,
            BuildScripts::Absent,
            &["install Node.js 22+ (nvm install 22 / volta install node@22)"],
        );
        let lines = doctor_lines(&report, Locale::English);
        assert!(
            lines
                .iter()
                .any(|line| line.contains("older than DSH's Node.js 22 requirement")),
            "{lines:?}"
        );
        let missing = report_without_node();
        let lines = doctor_lines(&missing, Locale::English);
        assert!(
            lines
                .iter()
                .any(|line| line.contains("no Node.js runtime found")),
            "{lines:?}"
        );
    }

    fn report_without_node() -> EnvReport {
        report(
            None,
            None,
            None,
            None,
            BuildScripts::Absent,
            &[
                "install Node.js 22+ (nvm install 22 / volta install node@22)",
                "npm install -g pnpm",
            ],
        )
    }

    #[test]
    fn doctor_lines_localize_the_missing_pnpm_note() {
        let report = report_without_node();
        let japanese = doctor_lines(&report, Locale::Japanese);
        assert!(
            japanese
                .iter()
                .any(|line| line.contains("pnpm: <見つかりません>")),
            "{japanese:?}"
        );
        assert!(
            japanese
                .iter()
                .any(|line| line.contains("修正: npm install -g pnpm")),
            "{japanese:?}"
        );
        let chinese = doctor_lines(&report, Locale::Chinese);
        assert!(
            chinese
                .iter()
                .any(|line| line.contains("修复：npm install -g pnpm")),
            "{chinese:?}"
        );
        let english = doctor_lines(&report, Locale::English);
        assert!(
            english
                .iter()
                .any(|line| line.contains("fix: npm install -g pnpm")),
            "{english:?}"
        );
    }

    #[test]
    fn json_publishes_the_build_policy_state_and_fixes() {
        let report = report(
            Some(ToolInfo {
                path: "/usr/bin/node".to_string(),
                version: Some("v22.10.0".to_string()),
            }),
            Some(ToolInfo {
                path: "/usr/bin/npm".to_string(),
                version: Some("10.9.0".to_string()),
            }),
            Some("/usr/local/lib/node_modules"),
            Some(ToolInfo {
                path: "/home/u/.local/share/pnpm/pnpm".to_string(),
                version: Some("10.32.0".to_string()),
            }),
            BuildScripts::Blocked,
            &["pnpm approve-builds --all -g"],
        );
        let value = json(&report);
        assert_eq!(value["node"]["version"], "v22.10.0");
        assert_eq!(value["npm"]["global_root"], "/usr/local/lib/node_modules");
        assert_eq!(value["pnpm"]["build_scripts"], "unapproved");
        assert_eq!(value["pnpm"]["found"], true);
        assert_eq!(value["fixes"][0], "pnpm approve-builds --all -g");

        let absent = json(&report_without_node());
        assert_eq!(absent["pnpm"]["build_scripts"], "absent");
        assert_eq!(absent["pnpm"]["found"], false);
        assert_eq!(absent["node"]["found"], false);
    }

    fn temp_tree(tag: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "rdsh-dsh-env-{tag}-{}-{}",
            std::process::id(),
            crate::local_http::random_token().unwrap()
        ));
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    fn write_runnable(path: &Path) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, "").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
    }

    fn nvm_node_path(version_dir: &Path) -> PathBuf {
        #[cfg(windows)]
        {
            version_dir.join("node.exe")
        }
        #[cfg(not(windows))]
        {
            version_dir.join("bin").join("node")
        }
    }

    #[test]
    fn nvm_node_discovery_prefers_the_newest_and_checks_the_parent_name() {
        let root = temp_tree("nvm-node");
        let versions = root.join(".nvm").join("versions").join("node");
        for name in ["v20.11.0", "v22.10.0"] {
            write_runnable(&nvm_node_path(&versions.join(name)));
        }
        assert_eq!(
            latest_nvm_node(&root).unwrap(),
            nvm_node_path(&versions.join("v22.10.0"))
        );

        // The Node that owns a dsh inside the tree is that tree's own Node.
        let dsh = versions.join("v20.11.0").join("bin").join("dsh");
        write_runnable(&dsh);
        assert_eq!(
            nvm_node_ancestor(&dsh).unwrap(),
            nvm_node_path(&versions.join("v20.11.0"))
        );

        // A version-shaped directory outside an nvm "node" directory is not a
        // Node install and must stay unknown.
        let stray = root.join("opt").join("v22.10.0").join("bin").join("dsh");
        write_runnable(&stray);
        assert_eq!(nvm_node_ancestor(&stray), None);
        std::fs::remove_dir_all(&root).unwrap();
    }

    /// sync-dsh.sh probes the same per-user prefixes; the discovery list must
    /// not need to spawn npm to see them.
    #[cfg(not(windows))]
    #[test]
    fn per_user_npm_prefixes_are_searched_without_spawning_npm() {
        let paths = paths_for(Path::new("/home/u"), "dsh", &[], &ShimEnv::default(), None);
        assert!(paths.contains(&shim("/home/u/.npm-global/bin", "dsh")));
        assert!(paths.contains(&shim("/home/u/.local/bin", "dsh")));
        let entry = Path::new("/home/u/.npm-global/lib/node_modules/@deepseek-ai/dsh/lib/bin.js");
        assert!(paths.contains(&entry.to_path_buf()));
    }
}
