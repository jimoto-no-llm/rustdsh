/// Env overrides for drop-in `dsh` mode (see install.sh --as-dsh).
/// RDSH_PASSTHROUGH=1 disables slim env; RDSH_DRY_RUN=1 only prints the exec.
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

/// Check a PATH candidate without spawning it. On Unix, query whether the
/// current effective user can execute this regular file; mode bits alone can
/// accept a file whose only execute bit belongs to another permission class.
fn is_executable_candidate(path: &std::path::Path) -> bool {
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
        // SAFETY: c_path is NUL-terminated and AT_FDCWD makes this a read-only query.
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

/// True when `path` is runnable as the original DSH: an executable binary,
/// or a `.js` entry launched via Node (regular file suffices there).
fn is_runnable_original(path: &std::path::Path) -> bool {
    if path.extension().is_some_and(|e| e == "js") {
        return path.is_file();
    }
    is_executable_candidate(path)
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
        if is_runnable_original(std::path::Path::new(&p)) {
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
    let tree = latest_node_tree()?;
    #[cfg(target_os = "windows")]
    let cand = format!("{tree}/bin/node.exe");
    #[cfg(not(target_os = "windows"))]
    let cand = format!("{tree}/bin/node");
    if is_executable_candidate(std::path::Path::new(&cand)) {
        Some(cand)
    } else {
        None
    }
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
    None
}

fn base_cmd(orig: &str, dry: bool, metadata_only: bool) -> anyhow::Result<std::process::Command> {
    let selected_node = || node_for_dsh(orig).or_else(find_node_bin);
    if dry || metadata_only {
        if orig.ends_with(".js") {
            let mut command =
                std::process::Command::new(selected_node().unwrap_or_else(|| "node".to_string()));
            command.arg(orig);
            return Ok(command);
        }
        return Ok(std::process::Command::new(orig));
    }
    let bin = selected_node()
        .ok_or_else(|| anyhow::anyhow!("RDSH_SECURITY: compatible Node runtime is required"))?;
    if !crate::tool_security::sandbox_enabled() {
        // Default: hand the run to DSH with its normal tools and normal file
        // access. The strict boundary stays available through --share-file,
        // features.agent_tool_sandbox, or RDSH_SECURITY=1.
        let mut command = if orig.ends_with(".js") {
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
        return Ok(command);
    }
    let mut command = crate::tool_security::command(orig, &bin)?;
    command.env("RDSH_VERSION", env!("CARGO_PKG_VERSION"));
    Ok(command)
}

fn apply_slim(cmd: &mut std::process::Command, slim: bool) {
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
    from_default: Option<&str>,
    kind: crate::dsh_args::DumpKind,
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
        v.iter().map(ToString::to_string).collect()
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

    fn env_lock() -> std::sync::MutexGuard<'static, ()> {
        static M: std::sync::OnceLock<std::sync::Mutex<()>> = std::sync::OnceLock::new();
        M.get_or_init(|| std::sync::Mutex::new(()))
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
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

        let command = base_cmd(&orig, false, false);
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
}
