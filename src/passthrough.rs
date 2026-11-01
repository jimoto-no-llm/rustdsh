//! Env overrides for drop-in `dsh` mode (see install.sh --as-dsh).
//! RDSH_PASSTHROUGH=1 disables slim env; RDSH_DRY_RUN=1 only prints the exec.
use crate::executable::is_executable as is_executable_candidate;
use std::ffi::{OsStr, OsString};

pub fn env_passthrough() -> bool {
    std::env::var("RDSH_PASSTHROUGH").is_ok_and(|v| v == "1")
}

pub fn env_dry() -> bool {
    std::env::var("RDSH_DRY_RUN").is_ok_and(|v| v == "1")
}

fn origin_file() -> Option<String> {
    // install.ps1 records the backup here on native Windows (USERPROFILE).
    let home = crate::inspect::home_dir()?;
    let p = format!("{home}/.config/rdsh/origin");
    let s = std::fs::read_to_string(p).ok()?;
    let s = s.trim().to_string();
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

/// Warn when an explicitly selected original (env var or origin file) looks
/// risky: not a regular file, not owned by us, or group/world-writable.
/// Advisory only — the selection still wins so existing setups keep working.
#[cfg(unix)]
fn warn_if_risky_origin(path: &str, via: &str) {
    use std::os::unix::fs::MetadataExt;
    let Ok(md) = std::fs::metadata(path) else {
        return;
    };
    let mut why: Vec<&str> = vec![];
    if !md.is_file() {
        why.push("not a regular file");
    }
    // SAFETY: getuid takes no arguments and always succeeds.
    if md.uid() != unsafe { libc::getuid() } {
        why.push("not owned by you");
    }
    if md.mode() & 0o022 != 0 {
        why.push("group/world-writable");
    }
    if !why.is_empty() {
        eprintln!(
            "[rdsh] warning: original dsh from {via} ({path}) is {} — check it before delegating",
            why.join(" and ")
        );
    }
}

#[cfg(not(unix))]
fn warn_if_risky_origin(_path: &str, _via: &str) {}
/// True when `path` is runnable as the original DSH: an executable binary,
/// or a `.js` entry launched via Node (regular file suffices there).
fn is_runnable_original(path: &std::path::Path) -> bool {
    if path.extension().is_some_and(|e| e == "js") {
        return path.is_file();
    }
    is_executable_candidate(path)
}

/// True when the delegated entrypoint is a Node script, which must run through
/// a Node runtime (that runtime is also what carries the always-on preload).
///
/// The name alone does not decide: `install.sh --as-dsh` backs the original up
/// as the extension-less `dsh-orig`, which is still a Node script. Native
/// executables and shell wrappers keep their direct exec either way.
fn is_node_entrypoint(orig: &str) -> bool {
    orig.ends_with(".js") || node_shebang(std::path::Path::new(orig))
}

/// True when `path` starts with a shebang that runs `node` with no arguments of
/// its own (`#!/usr/bin/env node`, `#!/usr/bin/node`, `#!/usr/bin/env -S node`).
/// A shebang that passes flags (`env -S node --x`) or a shell wrapper
/// (`#!/bin/sh`) is left alone, so nothing that works today changes meaning.
fn node_shebang(path: &std::path::Path) -> bool {
    let Some(line) = shebang_line(path) else {
        return false;
    };
    let tokens: Vec<&[u8]> = line
        .split(|byte| *byte == b' ' || *byte == b'\t')
        .filter(|token| !token.is_empty())
        .collect();
    let Some(program) = tokens.first().and_then(|token| token.strip_prefix(b"#!")) else {
        return false;
    };
    let is_node = |token: &[u8]| token == b"node" || token.ends_with(b"/node");
    let arguments: Vec<&[u8]> = tokens[1..]
        .iter()
        .copied()
        .filter(|token| *token != b"-S")
        .collect();
    if is_node(program) {
        arguments.is_empty()
    } else if program == b"env" || program.ends_with(b"/env") {
        matches!(arguments.as_slice(), [only] if is_node(only))
    } else {
        false
    }
}

/// Read the first line of `path` (following symlinks) when it is a shebang.
fn shebang_line(path: &std::path::Path) -> Option<Vec<u8>> {
    use std::io::Read;
    let mut head = [0u8; 256];
    let mut file = std::fs::File::open(path).ok()?;
    let read = file.read(&mut head).ok()?;
    let head = &head[..read];
    if !head.starts_with(b"#!") {
        return None;
    }
    let end = head
        .iter()
        .position(|byte| *byte == b'\n' || *byte == b'\r')
        .unwrap_or(head.len());
    Some(head[..end].to_vec())
}

/// Locate the original Node-based dsh (never ourselves).
pub fn find_original_dsh() -> Option<String> {
    // Canonical name first, legacy DSH_ORIG_BIN kept as fallback.
    for key in ["RDSH_ORIG_BIN", "DSH_ORIG_BIN"] {
        if let Ok(p) = std::env::var(key) {
            if !p.is_empty() {
                warn_if_risky_origin(&p, key);
                return Some(p);
            }
        }
    }
    if let Some(p) = origin_file() {
        if is_runnable_original(std::path::Path::new(&p)) {
            warn_if_risky_origin(&p, "origin file");
            return Some(p);
        }
    }
    let me = std::env::current_exe().ok();
    // Sibling backups created by install.sh --as-dsh (same dir as our binary).
    if let Some(exe) = &me {
        if let Some(dir) = exe.parent() {
            // dsh-orig.exe covers native Windows installs (binary is dsh.exe there).
            for name in ["dsh-orig", "dsh.orig", "dsh.real", "dsh-orig.exe"] {
                let cand = dir.join(name);
                if is_runnable_original(&cand) {
                    return Some(cand.to_string_lossy().into_owned());
                }
            }
        }
    }
    if let Ok(path) = std::env::var("PATH") {
        // split_paths handles : on unix and ; on Windows.
        for dir in std::env::split_paths(&path) {
            #[cfg(target_os = "windows")]
            let names = ["dsh.exe", "dsh"];
            #[cfg(not(target_os = "windows"))]
            let names = ["dsh"];
            for n in names {
                let cand = dir.join(n);
                if !is_executable_candidate(&cand) {
                    continue;
                }
                let mut skip = false;
                if let (Some(m), Ok(c)) = (&me, std::fs::canonicalize(&cand)) {
                    if let Ok(m) = std::fs::canonicalize(m) {
                        skip = m == c;
                    }
                }
                if !skip {
                    return Some(cand.to_string_lossy().into_owned());
                }
            }
        }
    }
    if let Some(home) = crate::inspect::home_dir() {
        for cand in [
            format!("{home}/.local/bin/dsh.orig"),
            format!("{home}/.local/bin/dsh-orig"),
        ] {
            if is_executable_candidate(std::path::Path::new(&cand)) {
                return Some(cand);
            }
        }
        if let Some(tree) = latest_node_tree_for(&format!("{home}/.local/opt")) {
            let cand = format!("{tree}/lib/node_modules/@deepseek-ai/dsh/lib/bin.js");
            if is_runnable_original(std::path::Path::new(&cand)) {
                return Some(cand);
            }
        }
    }
    // Last resort, strictly after every location above: a version manager
    // (nvm, fnm, volta) or a global package install (pnpm, npm) that a
    // non-interactive shell never put on PATH. Appending keeps the resolution
    // order of an existing setup identical, so only a host that previously
    // failed to find any dsh gains a candidate here.
    crate::dsh_env::find_tool_fallback("dsh", me.as_deref())
}

// Rust target mapped to Node dist labels (node-v<VERSION>-<os>-<arch>).
fn current_os_arch() -> (&'static str, &'static str) {
    let os = if cfg!(target_os = "windows") {
        "win"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else {
        "linux"
    };
    let arch = if cfg!(target_arch = "aarch64") {
        "arm64"
    } else {
        "x64"
    };
    (os, arch)
}

// Parse node-v<major>.<minor>.<patch>-<os>-<arch>; returns version + labels.
// Names without a recognizable os/arch suffix return None so trees built
// for another OS/CPU are never selected.
pub fn parse_node_tree_version(dir_name: &str) -> Option<((u64, u64, u64), String, String)> {
    let rest = dir_name.strip_prefix("node-v")?;
    let mut parts = rest.split('-');
    let ver = parts.next()?;
    let nums: Vec<&str> = ver.split('.').collect();
    if nums.len() != 3 {
        return None;
    }
    let major: u64 = nums[0].parse().ok()?;
    let minor: u64 = nums[1].parse().ok()?;
    let patch: u64 = nums[2].parse().ok()?;
    let os = parts.next()?.to_string();
    let arch = parts.next()?.to_string();
    if parts.next().is_some() {
        return None;
    }
    if arch.is_empty() || os.is_empty() {
        return None;
    }
    Some(((major, minor, patch), os, arch))
}

// Latest node-v* tree under opt_dir matching this OS/CPU. Pure over the
// entry names so tests stay hermetic; IO version below wraps it.
pub fn pick_latest_node_tree<'a>(
    names: &'a [String],
    want_os: &str,
    want_arch: &str,
) -> Option<&'a str> {
    let mut best: Option<(&'a str, (u64, u64, u64))> = None;
    for n in names {
        if let Some((v, os, arch)) = parse_node_tree_version(n) {
            if os == want_os && arch == want_arch {
                let take = match &best {
                    None => true,
                    Some((_, bv)) => v > *bv,
                };
                if take {
                    best = Some((n.as_str(), v));
                }
            }
        }
    }
    best.map(|(n, _)| n)
}

// IO wrapper: scan opt_dir for the newest matching node-v* tree.
pub fn latest_node_tree_for(opt_dir: &str) -> Option<String> {
    let (want_os, want_arch) = current_os_arch();
    let entries = std::fs::read_dir(opt_dir).ok()?;
    let mut names: Vec<String> = Vec::new();
    for e in entries.flatten() {
        if e.metadata().is_ok_and(|m| m.is_dir()) {
            if let Some(n) = e.file_name().to_str().map(str::to_owned) {
                names.push(n);
            }
        }
    }
    pick_latest_node_tree(&names, want_os, want_arch).map(|n| format!("{opt_dir}/{n}"))
}

// Newest matching tree under ~/.local/opt.
pub fn latest_node_tree() -> Option<String> {
    let home = crate::inspect::home_dir()?;
    latest_node_tree_for(&format!("{home}/.local/opt"))
}

// Node binary to run .js delegations: PATH lookup checks effective execute
// permission without spawning (`node --version` costs ~14ms per delegation),
// else the newest matching tree under ~/.local/opt.
pub fn find_node_bin() -> Option<String> {
    #[cfg(target_os = "windows")]
    const NAMES: &[&str] = &["node.exe", "node.cmd", "node.bat", "node"];
    #[cfg(not(target_os = "windows"))]
    const NAMES: &[&str] = &["node"];
    if let Ok(path) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path) {
            for n in NAMES {
                let cand = dir.join(n);
                if is_executable_candidate(&cand) {
                    return Some(cand.to_string_lossy().into_owned());
                }
            }
        }
    }
    if let Some(tree) = latest_node_tree() {
        #[cfg(target_os = "windows")]
        let cand = format!("{tree}/bin/node.exe");
        #[cfg(not(target_os = "windows"))]
        let cand = format!("{tree}/bin/node");
        if is_executable_candidate(std::path::Path::new(&cand)) {
            return Some(cand);
        }
    }
    // nvm keeps its trees outside ~/.local/opt, and a non-interactive shell
    // never put them on PATH either. Same last-resort position as dsh above.
    let home = crate::inspect::home_dir()?;
    crate::dsh_env::latest_nvm_node(std::path::Path::new(&home))
        .map(|node| node.to_string_lossy().into_owned())
}

// A versioned Node installation can contain native DSH dependencies built for
// its interpreter. Prefer that interpreter over an older distribution Node on
// PATH, resolving launcher symlinks first. Other OS/CPU trees are not usable.
fn node_for_dsh(orig: &str) -> Option<String> {
    let entry = std::fs::canonicalize(orig).ok()?;
    let (wanted_os, wanted_arch) = current_os_arch();
    for ancestor in entry.ancestors().skip(1) {
        let Some((_, os, arch)) = ancestor
            .file_name()
            .and_then(|name| name.to_str())
            .and_then(parse_node_tree_version)
        else {
            continue;
        };
        if os != wanted_os || arch != wanted_arch {
            continue;
        }
        let node = ancestor
            .join("bin")
            .join(if cfg!(windows) { "node.exe" } else { "node" });
        if is_executable_candidate(&node) {
            return Some(node.to_string_lossy().into_owned());
        }
        #[cfg(windows)]
        {
            // The official Windows archive keeps node.exe at the tree root.
            let node = ancestor.join("node.exe");
            if is_executable_candidate(&node) {
                return Some(node.to_string_lossy().into_owned());
            }
        }
    }
    // nvm names its trees vX.Y.Z without an OS/CPU label (they are built for
    // this host), so they need their own ancestor rule.
    crate::dsh_env::nvm_node_ancestor(&entry).map(|node| node.to_string_lossy().into_owned())
}

/// Read-only runtime selection shared by delegation and doctor.
pub(crate) fn selected_node(orig: &str) -> Option<String> {
    node_for_dsh(orig).or_else(find_node_bin)
}

/// Profile whose first load benefits from the higher gzip level. Other
/// profiles are left completely alone.
const WEB_PROFILE: &str = "web";

/// Compose a profile tree through `dsh --dump-config` and return its stdout.
///
/// `--dump-config` runs the same patch algorithm as a real mount, so what it
/// prints is exactly what the profile would boot with. It never binds a port.
fn dump_composed_config(orig: &str, profile: &str) -> Option<String> {
    let mut cmd = base_cmd(orig, false, true, crate::locale::Locale::English).ok()?;
    cmd.arg("--profile")
        .arg(profile)
        .arg("--dump-config")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());
    let output = cmd.output().ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8(output.stdout).ok()
}

/// Write the generated overlay and return its path.
///
/// The file lands beside the settings document rather than in the profile, so
/// nothing rdsh writes can ever be mistaken for a profile the user owns. A
/// stable name means repeated boots reuse one small file instead of filling
/// the directory.
fn write_overlay(body: &str) -> std::io::Result<String> {
    let dir = format!("{}/webui", crate::inspect::dsh_home());
    std::fs::create_dir_all(&dir)?;
    let path = format!("{dir}/gzip-level.patch.yml");
    std::fs::write(&path, body)?;
    Ok(path)
}

/// Build the gzip-level overlay for `profile`, or `None` to leave the command
/// untouched.
///
/// Every failure path returns `None` on purpose: a missing `dsh`, an
/// unreadable dump, an unexpected config shape or an unwritable cache dir must
/// only cost the optimization, never the boot. This is the whole reason the
/// level is applied as an extra layer instead of by editing the profile.
fn gzip_overlay(orig: &str, profile: &str) -> Option<String> {
    if profile != WEB_PROFILE {
        return None;
    }
    // Settings can switch the layer off entirely; the env below still tunes the
    // level when it is on.
    if !crate::rdsh_config::feature_enabled(
        &crate::rdsh_config::load(),
        crate::webui_gzip::FEATURE_ID,
    ) {
        return None;
    }
    let configured = crate::webui_gzip::DEFAULT_COMPRESSION_LEVEL;
    let level = crate::webui_gzip::resolve_level(
        std::env::var(crate::webui_gzip::ENV_LEVEL).ok().as_deref(),
        configured,
    );
    if !crate::webui_gzip::is_worth_applying(level) {
        return None;
    }
    let composed = dump_composed_config(orig, profile)?;
    let overlay = crate::webui_gzip::overlay_for(&composed, level)?;
    write_overlay(&overlay).ok()
}

/// Append the generated overlay to a boot/dump command.
///
/// `dsh` applies `--patch` overlays in the order given, so inserting ours
/// before the caller's list keeps every explicit `--patch` authoritative.
/// Returns true when an overlay was added.
/// Path (relative to a DSH install root) of the frontend bundle's asset tree.
const FRONTEND_ASSETS_REL: &str = "node_modules/@deepseek-ai/dsh-web-frontend/dist/assets";

/// Locate the frontend `dist/assets` tree that belongs to `orig`.
///
/// `orig` reaches rdsh in three shapes and all of them are handled:
///
/// - `~/.local/bin/dsh-orig`, a symlink to `<tree>/bin/dsh`
/// - `<tree>/bin/dsh` itself
/// - `<pkg>/lib/bin.js` inside the installed package
///
/// The layout is walked instead of hard-coded so a relocated install still
/// resolves. `RDSH_WEB_ASSETS_DIST` overrides the search outright.
fn find_frontend_assets_dir(orig: &str) -> Option<std::path::PathBuf> {
    if let Ok(explicit) = std::env::var("RDSH_WEB_ASSETS_DIST") {
        if !explicit.is_empty() {
            let p = std::path::PathBuf::from(&explicit);
            return p.is_dir().then_some(p);
        }
    }
    let real = std::fs::canonicalize(orig).unwrap_or_else(|_| std::path::PathBuf::from(orig));
    for ancestor in real.ancestors() {
        // <pkg>/lib/bin.js  ->  <pkg>/node_modules/...
        let inside_pkg = ancestor.join(FRONTEND_ASSETS_REL);
        if inside_pkg.is_dir() {
            return Some(inside_pkg);
        }
        // <tree>/bin/dsh  ->  <tree>/lib/node_modules/@deepseek-ai/dsh/node_modules/...
        let under_tree = ancestor
            .join("lib")
            .join("node_modules")
            .join("@deepseek-ai")
            .join("dsh")
            .join(FRONTEND_ASSETS_REL);
        if under_tree.is_dir() {
            return Some(under_tree);
        }
    }
    // Last resort: the installed tree that find_original_dsh() would pick.
    let home = crate::inspect::home_dir()?;
    let tree = latest_node_tree_for(&format!("{home}/.local/opt"))?;
    let cand = std::path::PathBuf::from(tree)
        .join("lib")
        .join("node_modules")
        .join("@deepseek-ai")
        .join("dsh")
        .join(FRONTEND_ASSETS_REL);
    cand.is_dir().then_some(cand)
}

/// Read the DSH profile from delegated arguments (`--profile web` / `--profile=web`).
///
/// Only the profile flag is inspected; every other argument is left to DSH.
fn profile_of<T: AsRef<OsStr>>(args: &[T]) -> Option<&str> {
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        let arg = arg.as_ref();
        if arg == "--profile" {
            return iter.next().and_then(|value| value.as_ref().to_str());
        }
        if let Some(value) = arg
            .to_str()
            .and_then(|value| value.strip_prefix("--profile="))
        {
            return Some(value);
        }
    }
    None
}

/// Precompress the web shell assets once and point DSH at the result.
///
/// The compression itself is the expensive part (brotli q11 over the shell), so
/// it happens here, in Rust, once per DSH version, and lands in an on-disk
/// cache. DSH then serves the precompressed bytes and never compresses at
/// request time. Everything is best-effort: a missing tree, an unwritable cache
/// or a disabled feature simply leaves `RDSH_WEB_ASSETS` unset, and DSH behaves
/// exactly as it does today.
fn apply_web_assets(cmd: &mut std::process::Command, orig: &str, profile: &str) {
    if profile != WEB_PROFILE {
        return;
    }
    // An explicit value in the environment always wins.
    if std::env::var_os("RDSH_WEB_ASSETS").is_some() {
        return;
    }
    if !crate::rdsh_config::feature_enabled(
        &crate::rdsh_config::load(),
        crate::webui_assets::FEATURE_ID,
    ) {
        return;
    }
    let Some(dist) = find_frontend_assets_dir(orig) else {
        return;
    };
    let home = crate::inspect::dsh_home();
    let Some(cache) = crate::webui_assets::prepare(std::path::Path::new(&home), &dist) else {
        return;
    };
    cmd.env("RDSH_WEB_ASSETS", cache);
}

fn apply_gzip_overlay(cmd: &mut std::process::Command, orig: &str, profile: &str) -> bool {
    let Some(path) = gzip_overlay(orig, profile) else {
        return false;
    };
    cmd.arg("--patch").arg(path);
    true
}

fn base_cmd(
    orig: &str,
    dry: bool,
    metadata_only: bool,
    locale: crate::locale::Locale,
) -> anyhow::Result<std::process::Command> {
    if dry || metadata_only {
        let mut command = if is_node_entrypoint(orig) {
            let mut command = std::process::Command::new(
                selected_node(orig).unwrap_or_else(|| "node".to_string()),
            );
            command.arg(orig);
            command
        } else {
            std::process::Command::new(orig)
        };
        apply_privacy_default(&mut command);
        apply_web_search_provider(&mut command);
        return Ok(command);
    }
    let bin = selected_node(orig).ok_or_else(|| {
        anyhow::anyhow!(match locale {
            crate::locale::Locale::English => "RDSH_SECURITY: compatible Node runtime is required",
            crate::locale::Locale::Chinese => "RDSH_SECURITY：需要兼容的 Node 运行时",
            crate::locale::Locale::Japanese =>
                "RDSH_SECURITY: 互換性のある Node ランタイムが必要です",
        })
    })?;
    if !crate::tool_security::sandbox_enabled() {
        // Default: hand the run to DSH with its normal tools and normal file
        // access. The strict boundary stays available through --share-file,
        // features.agent_tool_sandbox, or RDSH_SECURITY=1.
        let mut command = if is_node_entrypoint(orig) {
            let mut command = std::process::Command::new(&bin);
            // Always-on compat: let custom OpenCode zen routes get the
            // x-opencode-session header (DSH's own custom-route provider
            // builder omits it). RDSH_OPENCODE_SESSION_HEADER=0 opts out.
            // `--import` resolves as an ES-module specifier, so pass a `file:`
            // URL rather than a raw path (Windows drive letters and Unix
            // reserved characters both break the path form).
            if let Some(preload) = crate::opencode_header::import_specifier() {
                command.arg("--import").arg(preload);
            }
            command.arg(orig);
            command
        } else {
            std::process::Command::new(orig)
        };
        // The rdsh settings card reports this without spawning a second binary.
        command.env("RDSH_VERSION", env!("CARGO_PKG_VERSION"));
        crate::tmp_guard::apply_to_command(&mut command);
        apply_privacy_default(&mut command);
        apply_web_search_provider(&mut command);
        return Ok(command);
    }
    let mut command = crate::tool_security::command(orig, &bin, locale)?;
    command.env("RDSH_VERSION", env!("CARGO_PKG_VERSION"));
    crate::tmp_guard::apply_to_command(&mut command);
    apply_privacy_default(&mut command);
    apply_web_search_provider(&mut command);
    Ok(command)
}

/// Upstream provider id for delegated web search, set once from the settings
/// document in `main`. Empty means "leave the child environment alone".
static WEB_SEARCH_PROVIDER: std::sync::OnceLock<String> = std::sync::OnceLock::new();

/// Remember the configured provider id for later delegated runs.
pub fn configure_web_search_provider(cfg: &crate::rdsh_config::RdshSettings) {
    let _ = WEB_SEARCH_PROVIDER.set(cfg.search.dsh_search_provider.clone());
}

const WEB_SEARCH_PROVIDER_ENV: &str = "DSH_WEB_SEARCH_PROVIDER";

/// The id to export, or `None` to leave the child environment untouched.
///
/// Opt-in: an empty setting exports nothing, and a value the caller already put
/// in the environment always wins. Upstream fails a search closed with
/// `WEB_PROVIDER_CONFIGURED_MISSING` when the id is not registered, so a value
/// that is not a plain provider id (whitespace or control characters) is
/// ignored rather than passed on.
fn provider_env_id<'a>(configured: &'a str, existing: Option<&str>) -> Option<&'a str> {
    if existing.is_some_and(|value| !value.is_empty()) {
        return None;
    }
    let id = configured.trim();
    if id.is_empty() || id.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return None;
    }
    Some(id)
}

/// Pin the upstream web-search provider for delegated runs when
/// `search.dsh_search_provider` is set. See docs/WEB-SEARCH.md.
fn apply_web_search_provider(cmd: &mut std::process::Command) {
    let configured = WEB_SEARCH_PROVIDER.get().map(String::as_str).unwrap_or("");
    let existing = std::env::var(WEB_SEARCH_PROVIDER_ENV).ok();
    if let Some(id) = provider_env_id(configured, existing.as_deref()) {
        cmd.env(WEB_SEARCH_PROVIDER_ENV, id);
    }
}

/// Privacy default for every delegated DSH run: upstream telemetry stays off
/// unless the run opted in (`features.telemetry` / RDSH_TELEMETRY=on) or the
/// user already set DSH_TELEMETRY_DISABLED (any non-empty value disables
/// upstream). See docs/PRIVACY.md.
fn apply_privacy_default(cmd: &mut std::process::Command) {
    let existing = std::env::var("DSH_TELEMETRY_DISABLED").ok();
    if let Some((key, value)) =
        crate::slim::telemetry_env(crate::slim::features().telemetry, existing.as_deref())
    {
        cmd.env(key, value);
    }
}

fn apply_slim(cmd: &mut std::process::Command, slim: bool, locale: crate::locale::Locale) {
    if !slim {
        return;
    }
    for (k, v) in crate::slim::slim_env() {
        cmd.env(k, v);
    }
    // features.node_compile_cache=false leaves NODE_COMPILE_CACHE untouched.
    if !crate::slim::features().node_compile_cache {
        return;
    }
    // V8 code cache for the delegated Node process. Set unconditionally:
    // Node < 22.1 ignores the variable, and a version probe would cost a
    // `node --version` spawn (~14ms) per launch — more than the cache saves.
    // Never overrides an explicit user value; RDSH_NODE_COMPILE_CACHE=0 opts
    // out, RDSH_NODE_COMPILE_CACHE=<dir> places the cache at that dir.
    let hint = std::env::var("RDSH_NODE_COMPILE_CACHE").ok();
    let existing = std::env::var("NODE_COMPILE_CACHE").ok();
    let default_dir = crate::slim::default_compile_cache_dir().unwrap_or_default();
    if let Some(dir) =
        crate::slim::resolve_node_compile_cache(hint.as_deref(), existing.as_deref(), &default_dir)
    {
        let _ = std::fs::create_dir_all(&dir);
        // 育ちすぎたキャッシュは起動を逆に遅くする。消さずに一度だけ知らせる。
        if let Some(advice) = crate::slim::compile_cache_advice(&dir, locale) {
            eprintln!("[rdsh slim] {advice}");
        }
        cmd.env("NODE_COMPILE_CACHE", dir);
    }
}

fn exec_or_spawn(
    mut cmd: std::process::Command,
    dry: bool,
    locale: crate::locale::Locale,
) -> anyhow::Result<()> {
    if dry {
        println!(
            "[rdsh dry-run] {}: {cmd:?}",
            match locale {
                crate::locale::Locale::English => "would exec",
                crate::locale::Locale::Chinese => "将执行",
                crate::locale::Locale::Japanese => "実行予定",
            }
        );
        return Ok(());
    }
    // Reclaim orphaned dsh-workspace-changes dirs once, before this process
    // is replaced by dsh (exec) or waits for it (Windows spawn).
    crate::tmp_guard::sweep_before_exec(locale);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        let err = cmd.exec();
        Err(anyhow::anyhow!(
            "{}: {err}",
            match locale {
                crate::locale::Locale::English => "exec failed",
                crate::locale::Locale::Chinese => "执行失败",
                crate::locale::Locale::Japanese => "実行に失敗しました",
            }
        ))
    }
    #[cfg(not(unix))]
    {
        // No exec(3) on Windows: spawn, wait, and exit with the child status
        // so callers/pipes observe the same code. The per-run temp dir is
        // ours to remove once the wait returns.
        let status = cmd.status();
        crate::tmp_guard::cleanup_after_spawn();
        match status {
            Ok(st) => std::process::exit(st.code().unwrap_or(1)),
            Err(e) => Err(anyhow::anyhow!(
                "{}: {e}",
                match locale {
                    crate::locale::Locale::English => "spawn failed",
                    crate::locale::Locale::Chinese => "启动失败",
                    crate::locale::Locale::Japanese => "起動に失敗しました",
                }
            )),
        }
    }
}

pub fn exec_boot(
    profile: &str,
    from_default: Option<&str>,
    patches: &[String],
    app_args: &[String],
    dry: bool,
    slim: bool,
    locale: crate::locale::Locale,
) -> anyhow::Result<()> {
    let orig =
        find_original_dsh().ok_or_else(|| anyhow::anyhow!(original_dsh_not_found(locale)))?;
    let mut cmd = base_cmd(&orig, dry, false, locale)?;
    if !dry {
        // Status is read-only and runs only after enforcement validation.
        crate::auth::pre_boot(true, locale);
    }
    cmd.arg("--profile").arg(profile);
    if let Some(f) = from_default {
        cmd.arg("--from-default-profile").arg(f);
    }
    // Generated layer first so every caller-supplied --patch stays authoritative.
    let overlay = !dry && apply_gzip_overlay(&mut cmd, &orig, profile);
    for p in patches {
        cmd.arg("--patch").arg(p);
    }
    cmd.args(app_args);
    apply_slim(&mut cmd, slim, locale);
    apply_web_assets(&mut cmd, &orig, profile);
    if slim {
        eprintln!(
            "[rdsh] {} '{profile}' {} {orig} ({}: {})",
            match locale {
                crate::locale::Locale::English => "boot",
                crate::locale::Locale::Chinese => "启动",
                crate::locale::Locale::Japanese => "起動",
            },
            match locale {
                crate::locale::Locale::English => "via",
                crate::locale::Locale::Chinese => "通过",
                crate::locale::Locale::Japanese => "経由",
            },
            match locale {
                crate::locale::Locale::English => "slim ON",
                crate::locale::Locale::Chinese => "精简环境开启",
                crate::locale::Locale::Japanese => "slim 環境オン",
            },
            crate::slim::describe()
        );
    }
    if overlay {
        eprintln!("[rdsh] web ui: gzip overlay applied");
    }
    exec_or_spawn(cmd, dry, locale)
}

pub fn exec_dump_config(
    profile: &str,
    from_default: Option<&str>,
    kind: crate::dsh_args::DumpKind,
    patches: &[String],
    dry: bool,
    slim: bool,
    locale: crate::locale::Locale,
) -> anyhow::Result<()> {
    let orig =
        find_original_dsh().ok_or_else(|| anyhow::anyhow!(original_dsh_not_found(locale)))?;
    let mut cmd = base_cmd(&orig, dry, false, locale)?;
    if !dry {
        crate::auth::pre_boot(false, locale);
    }
    cmd.arg("--profile").arg(profile);
    if let Some(f) = from_default {
        cmd.arg("--from-default-profile").arg(f);
    }
    for p in patches {
        cmd.arg("--patch").arg(p);
    }
    match kind {
        crate::dsh_args::DumpKind::Config => cmd.arg("--dump-config"),
        crate::dsh_args::DumpKind::DefaultConfig => cmd.arg("--dump-default-config"),
        crate::dsh_args::DumpKind::Schema => cmd.arg("--dump-config-schema"),
    };
    apply_slim(&mut cmd, slim, locale);
    exec_or_spawn(cmd, dry, locale)
}

/// Raw verbatim delegation (used when invoked as `dsh`): no arg rewriting.
pub fn exec_raw(args: &[OsString], dry: bool, slim: bool) -> anyhow::Result<()> {
    // Same first-boot guidance as exec_boot: `dsh` (shadowed) is the usual
    // first thing a newcomer runs.

    let orig = find_original_dsh().ok_or_else(|| {
        anyhow::anyhow!("original dsh not found (set DSH_ORIG_BIN or reinstall with install.sh)")
    })?;
    let metadata_only = args.len() == 1
        && ["--version", "-V", "--help", "-h"]
            .iter()
            .any(|flag| args[0] == OsStr::new(flag));
    let mut cmd = base_cmd(&orig, dry, metadata_only, crate::locale::Locale::English)?;
    if !dry {
        crate::auth::pre_boot(true, crate::locale::Locale::English);
    }
    cmd.args(args);
    apply_slim(&mut cmd, slim, crate::locale::Locale::English);
    // The shadowed-dsh path (`dsh --profile web`) is how the web profile is
    // actually started, so the web optimizations must apply here too, not only
    // on the `rdsh boot` subcommand.
    if let Some(profile) = profile_of(args) {
        let profile = profile.to_string();
        apply_web_assets(&mut cmd, &orig, &profile);
    }
    exec_or_spawn(cmd, dry, crate::locale::Locale::English)
}

pub fn exec_plugin(
    profile: &str,
    pnpm_args: &[String],
    dry: bool,
    slim: bool,
    locale: crate::locale::Locale,
) -> anyhow::Result<()> {
    let orig =
        find_original_dsh().ok_or_else(|| anyhow::anyhow!(original_dsh_not_found(locale)))?;
    let mut cmd = base_cmd(&orig, dry, false, locale)?;
    if !dry {
        crate::auth::pre_boot(false, locale);
    }
    cmd.arg("plugin").arg("--profile").arg(profile);
    cmd.args(pnpm_args);
    apply_slim(&mut cmd, slim, locale);
    exec_or_spawn(cmd, dry, locale)
}

fn original_dsh_not_found(locale: crate::locale::Locale) -> &'static str {
    match locale {
        crate::locale::Locale::English => "original dsh not found in PATH (set DSH_ORIG_BIN)",
        crate::locale::Locale::Chinese => "未在 PATH 中找到原始 dsh（请设置 DSH_ORIG_BIN）",
        crate::locale::Locale::Japanese => {
            "PATH に元の dsh が見つかりません（DSH_ORIG_BIN を設定してください）"
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;

    fn sv(v: &[&str]) -> Vec<String> {
        v.iter().map(ToString::to_string).collect()
    }

    // The provider pin is opt-in and never overrides the caller's environment:
    // an unregistered id would make every upstream search fail closed.
    #[test]
    fn web_search_provider_is_opt_in_and_never_overrides_the_caller() {
        assert_eq!(provider_env_id("", None), None);
        assert_eq!(provider_env_id("   ", Some("")), None);
        // Not a provider id: whitespace and control characters are refused.
        assert_eq!(provider_env_id("local searxng", None), None);
        assert_eq!(
            provider_env_id("searxng\nDSH_TELEMETRY_DISABLED=1", None),
            None
        );
        // The caller's own value wins, including a non-empty one on purpose.
        assert_eq!(provider_env_id("searxng", Some("exa")), None);
        assert_eq!(provider_env_id(" searxng ", Some("")), Some("searxng"));
        assert_eq!(
            provider_env_id("dsh-web-search-searxng", None),
            Some("dsh-web-search-searxng")
        );
    }

    #[test]
    fn profile_flag_is_found_in_every_spelling() {
        // The shadowed-dsh path forwards user arguments verbatim, so the flag
        // arrives in whichever form the user typed.
        assert_eq!(profile_of(&sv(&["--profile", "web"])), Some("web"));
        assert_eq!(profile_of(&sv(&["--profile=web"])), Some("web"));
        assert_eq!(
            profile_of(&sv(&["--profile", "web", "--", "--port", "1"])),
            Some("web")
        );
        // Unrelated arguments must not be mistaken for the profile.
        assert_eq!(profile_of(&sv(&["--port", "3080"])), None);
        assert_eq!(profile_of(&sv(&["--profile"])), None);
        assert_eq!(profile_of::<String>(&[]), None);
        // A later flag does not override the first one found.
        assert_eq!(
            profile_of(&sv(&["--profile", "tui", "--profile", "web"])),
            Some("tui")
        );
    }

    #[test]
    fn frontend_assets_are_found_through_a_bin_symlink_layout() {
        // Mirror the installed layout: <tree>/bin/dsh plus the frontend bundle
        // under <tree>/lib/node_modules/@deepseek-ai/dsh/node_modules.
        let tree = std::env::temp_dir().join(format!(
            "rdsh-assets-probe-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&tree);
        let assets = tree
            .join("lib/node_modules/@deepseek-ai/dsh")
            .join(FRONTEND_ASSETS_REL);
        std::fs::create_dir_all(&assets).unwrap();
        std::fs::write(assets.join("index-abc.js"), b"x").unwrap();
        let bin = tree.join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let dsh = bin.join("dsh");
        std::fs::write(&dsh, b"").unwrap();

        // The finder canonicalizes the entry point before walking its
        // ancestors, so compare on the same footing: macOS keeps temp dirs
        // behind the /var -> /private/var symlink and the raw path would differ.
        let expected = std::fs::canonicalize(&assets).unwrap();
        let found = find_frontend_assets_dir(&dsh.to_string_lossy());
        let found_canonical = found.as_ref().and_then(|p| std::fs::canonicalize(p).ok());
        assert_eq!(found_canonical.as_deref(), Some(expected.as_path()));

        // A path pointing at nothing must not invent a directory.
        assert!(find_frontend_assets_dir("/nonexistent/rdsh/bin/dsh").is_none());

        let _ = std::fs::remove_dir_all(&tree);
    }

    #[test]
    fn parses_tree_names() {
        let p = parse_node_tree_version("node-v24.16.0-linux-x64").unwrap();
        assert_eq!(p.0, (24, 16, 0));
        assert_eq!(p.1, "linux");
        assert_eq!(p.2, "x64");
        assert!(parse_node_tree_version("node-v24.16.0").is_none());
        assert!(parse_node_tree_version("node-v24-linux-x64").is_none());
        assert!(parse_node_tree_version("other-v24.0.0-linux-x64").is_none());
    }

    fn env_lock() -> crate::test_support::EnvLock {
        crate::test_support::env_lock()
    }

    struct EnvGuard {
        saved: Vec<(String, Option<String>)>,
    }
    impl EnvGuard {
        fn set(keys: &[&str]) -> Self {
            let saved = keys
                .iter()
                .map(|k| (k.to_string(), std::env::var(k).ok()))
                .collect();
            Self { saved }
        }
    }
    impl Drop for EnvGuard {
        fn drop(&mut self) {
            for (k, v) in &self.saved {
                match v {
                    Some(v) => std::env::set_var(k, v),
                    None => std::env::remove_var(k),
                }
            }
        }
    }

    #[cfg(unix)]
    fn make_exec(path: &std::path::Path) {
        use std::os::unix::fs::PermissionsExt;
        let mut p = std::fs::metadata(path).unwrap().permissions();
        p.set_mode(0o755);
        std::fs::set_permissions(path, p).unwrap();
    }

    #[cfg(unix)]
    fn make_non_exec(path: &std::path::Path) {
        use std::os::unix::fs::PermissionsExt;
        let mut p = std::fs::metadata(path).unwrap().permissions();
        p.set_mode(0o644);
        std::fs::set_permissions(path, p).unwrap();
    }

    #[cfg(unix)]
    fn make_other_exec_only(path: &std::path::Path) {
        use std::os::unix::fs::PermissionsExt;
        let mut p = std::fs::metadata(path).unwrap().permissions();
        p.set_mode(0o001);
        std::fs::set_permissions(path, p).unwrap();
    }

    #[test]
    fn skips_directory_and_non_executable_candidates() {
        let root = std::env::temp_dir().join(format!(
            "rdsh-passthrough-cand-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let dir_cand = root.join("dsh-dir");
        std::fs::create_dir_all(&dir_cand).unwrap();
        assert!(!is_executable_candidate(&dir_cand));
        assert!(!is_executable_candidate(&root.join("missing")));
        let file_cand = root.join("dsh-file");
        std::fs::write(&file_cand, b"x").unwrap();
        #[cfg(unix)]
        {
            make_non_exec(&file_cand);
            assert!(!is_executable_candidate(&file_cand));
            make_exec(&file_cand);
            assert!(is_executable_candidate(&file_cand));
            if unsafe { libc::geteuid() } != 0 {
                make_other_exec_only(&file_cand);
                assert!(!is_executable_candidate(&file_cand));
            }
        }
        #[cfg(not(unix))]
        {
            assert!(is_executable_candidate(&file_cand));
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn path_lookup_skips_non_executable_dsh_and_node() {
        let _guard = env_lock();
        let env = EnvGuard::set(&[
            "PATH",
            "RDSH_ORIG_BIN",
            "DSH_ORIG_BIN",
            "HOME",
            "USERPROFILE",
        ]);
        let root = std::env::temp_dir().join(format!(
            "rdsh-passthrough-path-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let first = root.join("first");
        let second = root.join("second");
        let home = root.join("home");
        std::fs::create_dir_all(&first).unwrap();
        std::fs::create_dir_all(&second).unwrap();
        std::fs::create_dir_all(&home).unwrap();
        std::env::set_var("HOME", &home);
        std::env::set_var("USERPROFILE", &home);
        std::env::remove_var("RDSH_ORIG_BIN");
        std::env::remove_var("DSH_ORIG_BIN");
        // Valid fallback candidates so the lookup has somewhere to land.
        let valid_dsh = second.join("dsh");
        std::fs::write(&valid_dsh, b"#!/bin/sh\nexit 0\n").unwrap();
        let valid_node = second.join("node");
        std::fs::write(&valid_node, b"#!/bin/sh\nexit 0\n").unwrap();
        #[cfg(unix)]
        {
            make_exec(&valid_dsh);
            make_exec(&valid_node);
        }
        // PATH keeps working system dirs after our fixtures; fixtures come
        // first to prove they are skipped when non-executable.
        let sys_path = env.saved[0].1.clone().unwrap_or_default();
        let mut parts = vec![first.clone(), second];
        parts.extend(std::env::split_paths(&sys_path));
        std::env::set_var("PATH", std::env::join_paths(&parts).unwrap());
        // 1. Leading directory with the target name is skipped.
        std::fs::create_dir_all(first.join("dsh")).unwrap();
        std::fs::create_dir_all(first.join("node")).unwrap();
        assert_eq!(
            find_original_dsh(),
            Some(valid_dsh.to_string_lossy().into_owned())
        );
        assert_eq!(
            find_node_bin(),
            Some(valid_node.to_string_lossy().into_owned())
        );
        std::fs::remove_dir_all(first.join("dsh")).unwrap();
        std::fs::remove_dir_all(first.join("node")).unwrap();
        // 2. Leading non-executable regular files are skipped (Unix exec bits).
        #[cfg(unix)]
        {
            std::fs::write(first.join("dsh"), b"not executable\n").unwrap();
            make_non_exec(&first.join("dsh"));
            std::fs::write(first.join("node"), b"not executable\n").unwrap();
            make_non_exec(&first.join("node"));
            assert_eq!(
                find_original_dsh(),
                Some(valid_dsh.to_string_lossy().into_owned())
            );
            assert_eq!(
                find_node_bin(),
                Some(valid_node.to_string_lossy().into_owned())
            );

            // An execute bit for another permission class does not make this
            // caller able to run the file (e.g. owner mode 0001).
            if unsafe { libc::geteuid() } != 0 {
                std::fs::write(first.join("dsh"), b"not executable for owner\n").unwrap();
                make_other_exec_only(&first.join("dsh"));
                std::fs::write(first.join("node"), b"not executable for owner\n").unwrap();
                make_other_exec_only(&first.join("node"));
                assert_eq!(
                    find_original_dsh(),
                    Some(valid_dsh.to_string_lossy().into_owned())
                );
                assert_eq!(
                    find_node_bin(),
                    Some(valid_node.to_string_lossy().into_owned())
                );
            }
        }
        // 3. Explicit RDSH_ORIG_BIN keeps priority even without exec bits.
        #[cfg(unix)]
        {
            std::env::set_var("RDSH_ORIG_BIN", first.join("dsh"));
            assert_eq!(
                find_original_dsh(),
                Some(first.join("dsh").to_string_lossy().into_owned())
            );
            std::env::remove_var("RDSH_ORIG_BIN");
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn skips_foreign_trees_and_picks_latest() {
        let names = sv(&[
            "node-v20.11.0-linux-x64",
            "node-v24.16.0-darwin-arm64",
            "node-v22.1.0-linux-x64",
            "node-v24.16.0-linux-x64",
            "node-v24.16.0-linux-arm64",
            "node-v24.16.0-win-x64",
        ]);
        assert_eq!(
            pick_latest_node_tree(&names, "linux", "x64"),
            Some("node-v24.16.0-linux-x64")
        );
        assert_eq!(
            pick_latest_node_tree(&names, "darwin", "arm64"),
            Some("node-v24.16.0-darwin-arm64")
        );
        assert_eq!(pick_latest_node_tree(&names, "win", "arm64"), None);
    }

    /// eightman999 asked for a test that exercises the delegated argv itself
    /// rather than only the embedded patch source.
    #[test]
    fn delegated_js_boots_receive_the_preload_as_a_file_url() {
        let _lock = env_lock();
        if crate::tool_security::sandbox_enabled() {
            return; // the strict boundary path does not inject this preload
        }
        let dir = std::env::temp_dir().join(format!(
            "rdsh-base-cmd-{}-{}",
            std::process::id(),
            crate::local_http::random_token().unwrap()
        ));
        std::fs::create_dir(&dir).unwrap();
        let fixture = dir.join("dsh.js");
        std::fs::write(&fixture, "// fixture\n").unwrap();
        let orig = fixture.to_string_lossy().into_owned();

        let command = base_cmd(&orig, false, false, crate::locale::Locale::English);
        std::fs::remove_dir_all(&dir).unwrap();
        let Ok(command) = command else {
            return; // no compatible Node runtime in this environment
        };
        let args: Vec<String> = command
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();
        if crate::opencode_header::import_specifier().is_none() {
            assert_eq!(args, vec![orig]); // RDSH_OPENCODE_SESSION_HEADER=0
            return;
        }
        assert_eq!(args.len(), 3, "unexpected delegated argv: {args:?}");
        assert_eq!(args[0], "--import");
        assert!(
            args[1].starts_with("file:///") && args[1].ends_with("opencode-session-header.mjs"),
            "the preload must be a file: URL, got {}",
            args[1]
        );
        assert_eq!(args[2], orig);
    }

    /// Eureka-COM's review: `install.sh --as-dsh` stores the original as the
    /// extension-less `dsh-orig`, so the file name must not decide whether the
    /// preload applies.
    #[test]
    fn node_entrypoints_are_detected_from_the_shebang_not_the_name() {
        let dir = std::env::temp_dir().join(format!(
            "rdsh-node-entrypoint-{}-{}",
            std::process::id(),
            crate::local_http::random_token().unwrap()
        ));
        std::fs::create_dir(&dir).unwrap();
        let cases = [
            ("dsh-orig", "#!/usr/bin/env node\n", true),
            ("node-bin", "#!/usr/bin/node\n", true),
            ("env-s-node", "#!/usr/bin/env -S node\n", true),
            (
                "env-s-flags",
                "#!/usr/bin/env -S node --no-warnings\n",
                false,
            ),
            ("shell-wrapper", "#!/bin/sh\nexec node \"$@\"\n", false),
            ("binary", "\u{7f}ELF\n", false),
        ];
        for (name, body, expected) in cases {
            let path = dir.join(name);
            std::fs::write(&path, body).unwrap();
            assert_eq!(node_shebang(&path), expected, "shebang: {name}");
            assert_eq!(
                is_node_entrypoint(&path.to_string_lossy()),
                expected || name.ends_with(".js"),
                "entrypoint: {name}"
            );
        }
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// The real `--as-dsh` shape: a symlinked, extension-less backup must
    /// still receive the preload argument.
    #[cfg(unix)]
    #[test]
    fn a_symlinked_backup_is_still_a_node_entrypoint() {
        use std::os::unix::fs::symlink;
        let dir = std::env::temp_dir().join(format!(
            "rdsh-node-entrypoint-link-{}-{}",
            std::process::id(),
            crate::local_http::random_token().unwrap()
        ));
        std::fs::create_dir(&dir).unwrap();
        let target = dir.join("bin.js");
        std::fs::write(&target, "#!/usr/bin/env node\n// fixture\n").unwrap();
        let link = dir.join("dsh-orig");
        symlink(&target, &link).unwrap();

        assert!(node_shebang(&link));
        assert!(is_node_entrypoint(&link.to_string_lossy()));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// The delegated argv for that backup must be the same shape as for a
    /// `.js` entry, and a shell wrapper must keep its direct exec.
    #[test]
    fn delegated_extensionless_node_backups_receive_the_preload() {
        let _lock = env_lock();
        if crate::tool_security::sandbox_enabled() {
            return; // the strict boundary path does not inject this preload
        }
        let dir = std::env::temp_dir().join(format!(
            "rdsh-dsh-orig-{}-{}",
            std::process::id(),
            crate::local_http::random_token().unwrap()
        ));
        std::fs::create_dir(&dir).unwrap();
        let fixture = dir.join("dsh-orig");
        std::fs::write(&fixture, "#!/usr/bin/env node\n// fixture\n").unwrap();
        let orig = fixture.to_string_lossy().into_owned();

        let command = base_cmd(&orig, false, false, crate::locale::Locale::English);
        std::fs::remove_dir_all(&dir).unwrap();
        let Ok(command) = command else {
            return; // no compatible Node runtime in this environment
        };
        let args: Vec<String> = command
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();
        if crate::opencode_header::import_specifier().is_none() {
            assert_eq!(args, vec![orig]); // RDSH_OPENCODE_SESSION_HEADER=0
            return;
        }
        assert_eq!(args.len(), 3, "unexpected delegated argv: {args:?}");
        assert_eq!(args[0], "--import");
        assert!(
            args[1].starts_with("file:///") && args[1].ends_with("opencode-session-header.mjs"),
            "the preload must be a file: URL, got {}",
            args[1]
        );
        assert_eq!(args[2], orig);
    }

    #[test]
    fn delegated_shell_wrappers_keep_their_direct_exec() {
        if crate::tool_security::sandbox_enabled() {
            return; // the strict boundary path does not inject this preload
        }
        let dir = std::env::temp_dir().join(format!(
            "rdsh-shell-wrapper-{}-{}",
            std::process::id(),
            crate::local_http::random_token().unwrap()
        ));
        std::fs::create_dir(&dir).unwrap();
        let fixture = dir.join("dsh-orig");
        std::fs::write(&fixture, "#!/bin/sh\nexec node \"$@\"\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&fixture, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let orig = fixture.to_string_lossy().into_owned();

        let command = base_cmd(&orig, false, false, crate::locale::Locale::English);
        std::fs::remove_dir_all(&dir).unwrap();
        let Ok(command) = command else {
            return; // no compatible Node runtime in this environment
        };
        assert_eq!(
            command.get_program().to_string_lossy(),
            orig.as_str(),
            "a shell wrapper must keep its direct exec"
        );
        let args: Vec<String> = command
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();
        assert!(args.is_empty(), "unexpected delegated argv: {args:?}");
    }

    /// #585: every delegated run carries DSH_TELEMETRY_DISABLED=1 by default,
    /// while an explicit user value is never overwritten.
    #[test]
    fn delegated_runs_disable_upstream_telemetry_by_default() {
        let _lock = env_lock();
        let _env = EnvGuard::set(&["DSH_TELEMETRY_DISABLED", "RDSH_TELEMETRY"]);
        std::env::remove_var("DSH_TELEMETRY_DISABLED");
        std::env::remove_var("RDSH_TELEMETRY");

        let dir = std::env::temp_dir().join(format!(
            "rdsh-telemetry-{}-{}",
            std::process::id(),
            crate::local_http::random_token().unwrap()
        ));
        std::fs::create_dir(&dir).unwrap();
        let fixture = dir.join("dsh-orig");
        std::fs::write(&fixture, "#!/bin/sh\nexit 0\n").unwrap();
        #[cfg(unix)]
        make_exec(&fixture);
        let orig = fixture.to_string_lossy().into_owned();

        let Ok(command) = base_cmd(&orig, false, false, crate::locale::Locale::English) else {
            std::fs::remove_dir_all(&dir).unwrap();
            return; // no compatible Node runtime in this environment
        };
        let telemetry = command
            .get_envs()
            .find(|(key, _)| *key == "DSH_TELEMETRY_DISABLED")
            .and_then(|(_, value)| value)
            .map(|value| value.to_string_lossy().into_owned());
        assert_eq!(telemetry.as_deref(), Some("1"));

        // A value the user set is never overwritten; upstream already treats
        // any non-empty value (even "0") as an opt-out.
        std::env::set_var("DSH_TELEMETRY_DISABLED", "0");
        let Ok(command) = base_cmd(&orig, false, false, crate::locale::Locale::English) else {
            std::fs::remove_dir_all(&dir).unwrap();
            return;
        };
        assert!(
            command
                .get_envs()
                .all(|(key, _)| key != "DSH_TELEMETRY_DISABLED"),
            "an explicit DSH_TELEMETRY_DISABLED must not be overwritten"
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
