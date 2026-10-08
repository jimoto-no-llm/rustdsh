/// Env overrides for drop-in `dsh` mode (see install.sh --as-dsh).
/// RDSH_PASSTHROUGH=1 disables slim env; RDSH_DRY_RUN=1 only prints the exec.
pub fn env_passthrough() -> bool {
    std::env::var("RDSH_PASSTHROUGH").as_deref() == Ok("1")
}

pub fn env_dry() -> bool {
    std::env::var("RDSH_DRY_RUN").as_deref() == Ok("1")
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

/// Locate the original Node-based dsh (never ourselves).
pub fn find_original_dsh() -> Option<String> {
    // Canonical name first, legacy DSH_ORIG_BIN kept as fallback.
    for key in ["RDSH_ORIG_BIN", "DSH_ORIG_BIN"] {
        if let Ok(p) = std::env::var(key) {
            if !p.is_empty() {
                return Some(p);
            }
        }
    }
    if let Some(p) = origin_file() {
        if std::fs::metadata(&p).is_ok() {
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
                if std::fs::metadata(&cand).is_ok() {
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
                if std::fs::metadata(&cand).is_ok() {
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
    }
    if let Some(home) = crate::inspect::home_dir() {
        for cand in [
            format!("{home}/.local/bin/dsh.orig"),
            format!("{home}/.local/bin/dsh-orig"),
        ] {
            if std::fs::metadata(&cand).is_ok() {
                return Some(cand);
            }
        }
        if let Some(tree) = latest_node_tree_for(&format!("{home}/.local/opt")) {
            let cand = format!("{tree}/lib/node_modules/@deepseek-ai/dsh/lib/bin.js");
            if std::fs::metadata(&cand).is_ok() {
                return Some(cand);
            }
        }
    }
    None
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
    let mut names: Vec<String> = vec![];
    for e in entries.flatten() {
        if e.metadata().map(|m| m.is_dir()).unwrap_or(false) {
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

// Node binary to run .js delegations: PATH lookup is metadata-only (a
// `node --version` spawn costs ~14ms per delegation), else the newest
// matching tree under ~/.local/opt.
pub fn find_node_bin() -> Option<String> {
    #[cfg(target_os = "windows")]
    const NAMES: &[&str] = &["node.exe", "node.cmd", "node.bat", "node"];
    #[cfg(not(target_os = "windows"))]
    const NAMES: &[&str] = &["node"];
    if let Ok(path) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path) {
            for n in NAMES {
                let cand = dir.join(n);
                if cand.is_file() {
                    return Some(cand.to_string_lossy().into_owned());
                }
            }
        }
    }
    let tree = latest_node_tree()?;
    #[cfg(target_os = "windows")]
    let cand = format!("{tree}/bin/node.exe");
    #[cfg(not(target_os = "windows"))]
    let cand = format!("{tree}/bin/node");
    if std::fs::metadata(&cand).is_ok() {
        Some(cand)
    } else {
        None
    }
}

fn base_cmd(orig: &str, dry: bool, metadata_only: bool) -> anyhow::Result<std::process::Command> {
    if dry || metadata_only {
        if orig.ends_with(".js") {
            let mut command =
                std::process::Command::new(find_node_bin().unwrap_or_else(|| "node".to_string()));
            command.arg(orig);
            return Ok(command);
        }
        return Ok(std::process::Command::new(orig));
    }
    let bin = find_node_bin()
        .ok_or_else(|| anyhow::anyhow!("RDSH_SECURITY: compatible Node runtime is required"))?;
    crate::tool_security::command(orig, &bin)
}

fn apply_slim(cmd: &mut std::process::Command, slim: bool) {
    if !slim {
        return;
    }
    for (k, v) in crate::slim::slim_env() {
        cmd.env(k, v);
    }
    // V8 code cache for the delegated Node process. Set unconditionally:
    // Node < 22.1 ignores the variable, and a version probe would cost a
    // `node --version` spawn (~14ms) per launch — more than the cache saves.
    // Never overrides an explicit user value; RDSH_NODE_COMPILE_CACHE=0 opts out.
    let hint = std::env::var("RDSH_NODE_COMPILE_CACHE").ok();
    let existing = std::env::var("NODE_COMPILE_CACHE").ok();
    if let Some(dir) = crate::slim::default_compile_cache_dir().and_then(|d| {
        crate::slim::resolve_node_compile_cache(hint.as_deref(), existing.as_deref(), &d)
    }) {
        let _ = std::fs::create_dir_all(&dir);
        cmd.env("NODE_COMPILE_CACHE", dir);
    }
}

fn exec_or_spawn(mut cmd: std::process::Command, dry: bool) -> anyhow::Result<()> {
    if dry {
        println!("[rdsh dry-run] would exec: {cmd:?}");
        return Ok(());
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        let err = cmd.exec();
        Err(anyhow::anyhow!("exec failed: {err}"))
    }
    #[cfg(not(unix))]
    {
        // No exec(3) on Windows: spawn, wait, and exit with the child status
        // so callers/pipes observe the same code.
        match cmd.status() {
            Ok(st) => std::process::exit(st.code().unwrap_or(1)),
            Err(e) => Err(anyhow::anyhow!("spawn failed: {e}")),
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
) -> anyhow::Result<()> {
    let orig = find_original_dsh()
        .ok_or_else(|| anyhow::anyhow!("original dsh not found in PATH (set DSH_ORIG_BIN)"))?;
    let mut cmd = base_cmd(&orig, dry, false)?;
    if !dry {
        // Status is read-only and runs only after enforcement validation.
        crate::auth::pre_boot(true);
    }
    cmd.arg("--profile").arg(profile);
    if let Some(f) = from_default {
        cmd.arg("--from-default-profile").arg(f);
    }
    for p in patches {
        cmd.arg("--patch").arg(p);
    }
    cmd.args(app_args);
    apply_slim(&mut cmd, slim);
    if slim {
        eprintln!(
            "[rdsh] boot '{profile}' via {orig} (slim ON: {})",
            crate::slim::describe()
        );
    }
    exec_or_spawn(cmd, dry)
}

pub fn exec_dump_config(
    profile: &str,
    patches: &[String],
    dry: bool,
    slim: bool,
) -> anyhow::Result<()> {
    let orig = find_original_dsh()
        .ok_or_else(|| anyhow::anyhow!("original dsh not found in PATH (set DSH_ORIG_BIN)"))?;
    let mut cmd = base_cmd(&orig, dry, false)?;
    if !dry {
        crate::auth::pre_boot(false);
    }
    cmd.arg("--profile").arg(profile);
    for p in patches {
        cmd.arg("--patch").arg(p);
    }
    cmd.arg("--dump-config");
    apply_slim(&mut cmd, slim);
    exec_or_spawn(cmd, dry)
}

/// Raw verbatim delegation (used when invoked as `dsh`): no arg rewriting.
pub fn exec_raw(args: &[String], dry: bool, slim: bool) -> anyhow::Result<()> {
    // Same first-boot guidance as exec_boot: `dsh` (shadowed) is the usual
    // first thing a newcomer runs.

    let orig = find_original_dsh().ok_or_else(|| {
        anyhow::anyhow!("original dsh not found (set DSH_ORIG_BIN or reinstall with install.sh)")
    })?;
    let metadata_only =
        args.len() == 1 && matches!(args[0].as_str(), "--version" | "-V" | "--help" | "-h");
    let mut cmd = base_cmd(&orig, dry, metadata_only)?;
    if !dry {
        crate::auth::pre_boot(true);
    }
    cmd.args(args);
    apply_slim(&mut cmd, slim);
    exec_or_spawn(cmd, dry)
}

pub fn exec_plugin(
    profile: &str,
    pnpm_args: &[String],
    dry: bool,
    slim: bool,
) -> anyhow::Result<()> {
    let orig = find_original_dsh()
        .ok_or_else(|| anyhow::anyhow!("original dsh not found in PATH (set DSH_ORIG_BIN)"))?;
    let mut cmd = base_cmd(&orig, dry, false)?;
    if !dry {
        crate::auth::pre_boot(false);
    }
    cmd.arg("plugin").arg("--profile").arg(profile);
    cmd.args(pnpm_args);
    apply_slim(&mut cmd, slim);
    exec_or_spawn(cmd, dry)
}
#[cfg(test)]
mod tests {
    use super::*;

    fn sv(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
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
}
