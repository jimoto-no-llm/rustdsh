//! Contain and reclaim `dsh-workspace-changes` snapshot directories.
//!
//! The upstream `@deepseek-ai/dsh-workspace-changes` plugin photographs every
//! untracked, non-ignored file of the working tree into
//! `$TMPDIR/dsh-workspace-changes-XXXXXX` on a session's first turn. A session
//! that is killed, crashes or is interrupted headless never disposes, so its
//! directory (hundreds of MB per session) stays forever — a known limitation
//! documented upstream, which will not fix it.
//!
//! rdsh contains the leak on its side of the delegation boundary:
//!
//! 1. every delegated run receives its own temp dir
//!    (`<temp>/rdsh-tmp-<pid>-<random>`, mode 0700 on unix), so one crashed
//!    run can only orphan its own directory;
//! 2. right before handing over to dsh, a conservative reclaim deletes only
//!    orphans: this uid's real directories (symlinks are never followed)
//!    matching a known prefix, whose owner process is dead or whose files
//!    have been untouched for over 24 hours, and which no live process holds
//!    open;
//! 3. `rdsh doctor` reports the same findings read-only.
//!
//! `RDSH_NO_TMP_GUARD=1` restores the previous behavior, and the
//! byte-identical `RDSH_PASSTHROUGH=1` reference mode leaves the environment
//! untouched.
//!
//! Design limits (documented on purpose):
//! - on unix, delegation is `exec(3)`: rdsh *becomes* dsh, so nobody remains
//!   to delete the per-run dir at exit. The dead-pid rule reclaims it on the
//!   next delegated start. On Windows rdsh spawns and waits, so the dir is
//!   removed right after the child exits.
//! - the process holding the check reads `/proc`, so it only runs on Linux;
//!   elsewhere (macOS, Windows) the 24-hour quiet rule is the only reclaim
//!   signal for legacy directories.
//! - dsh started without rdsh (for example a systemd unit pointing at the
//!   upstream binary directly) never gets a per-run TMPDIR; such orphans are
//!   only covered by the reclaim, and only under the TMPDIR that rdsh itself
//!   sees when it starts.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, SystemTime};

/// Opt-out switch: `RDSH_NO_TMP_GUARD=1` disables both the per-run temp dir
/// and the startup reclaim.
pub const ENV_NO_GUARD: &str = "RDSH_NO_TMP_GUARD";

/// Legacy snapshot directories created by the upstream plugin itself.
const LEGACY_PREFIX: &str = "dsh-workspace-changes-";
/// Per-run directories this guard creates (the owner pid is part of the name).
const OWN_PREFIX: &str = "rdsh-tmp-";
/// A directory whose every file has been untouched for this long is an
/// orphan candidate even without a dead owner pid.
const STALE_AFTER: Duration = Duration::from_secs(24 * 60 * 60);
/// `rdsh doctor` warns about untracked, non-ignored paths this large.
const DOCTOR_UNTRACKED_LIMIT: u64 = 100 * 1024 * 1024;
/// How many large untracked paths `rdsh doctor` lists before summarizing.
const DOCTOR_UNTRACKED_MAX: usize = 5;

thread_local! {
    /// This process's per-run dir; the Windows spawn path removes it on exit.
    static OWN_DIR: std::cell::RefCell<Option<PathBuf>> =
        const { std::cell::RefCell::new(None) };
}

/// True when the guard must not touch anything: an explicit opt-out, or the
/// byte-identical passthrough reference mode, which never edits the env.
pub fn disabled() -> bool {
    std::env::var(ENV_NO_GUARD).is_ok_and(|v| v == "1") || crate::passthrough::env_passthrough()
}

/// Name of a per-run dir: `rdsh-tmp-<pid>-<random hex>`.
fn own_name(pid: u32, random_hex: &str) -> String {
    format!("{OWN_PREFIX}{pid}-{random_hex}")
}

/// The owner pid encoded in a per-run dir name, when the shape is exactly
/// ours (`rdsh-tmp-<digits>-<non-empty>`). Unknown shapes return `None` so a
/// foreign directory with a similar name is never touched.
fn parse_own_name(name: &str) -> Option<u32> {
    let rest = name.strip_prefix(OWN_PREFIX)?;
    let (pid, random) = rest.split_once('-')?;
    if random.is_empty() || pid.is_empty() || !pid.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    pid.parse().ok()
}

/// Create the private per-run temp dir under `base` (0700 on unix so no
/// other local user can read what dsh snapshots there). `None` means the
/// guard must fail open and leave the environment alone.
fn create_own_dir(base: &Path) -> Option<PathBuf> {
    let random = crate::local_http::random_token().ok()?;
    let dir = base.join(own_name(std::process::id(), &random[..16]));
    let created = {
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            std::fs::DirBuilder::new()
                .mode(0o700)
                .recursive(true)
                .create(&dir)
                .is_ok()
        }
        #[cfg(not(unix))]
        {
            std::fs::create_dir_all(&dir).is_ok()
        }
    };
    created.then_some(dir)
}

/// Give the delegated child its own temp dir. Fail-open: a missing temp root
/// or a failed mkdir only costs the guard, never the boot.
pub fn apply_to_command(cmd: &mut Command) {
    apply_to_command_with_base(cmd, &std::env::temp_dir());
}

/// Same, with an explicit temp root. Tests inject their scratch dir here
/// instead of mutating `TMPDIR`: the environment is process-global, so a
/// `set_var` race would misdirect every concurrently reading test in the
/// parallel test runner.
fn apply_to_command_with_base(cmd: &mut Command, base: &Path) {
    if disabled() {
        return;
    }
    let Some(dir) = create_own_dir(base) else {
        return;
    };
    OWN_DIR.with(|slot| *slot.borrow_mut() = Some(dir.clone()));
    cmd.env("TMPDIR", &dir);
    #[cfg(not(unix))]
    {
        // Node's os.tmpdir() on Windows reads TMP, then TEMP.
        cmd.env("TMP", &dir);
        cmd.env("TEMP", &dir);
    }
}

/// Remove our per-run dir after a spawn+wait delegation (the Windows path —
/// on unix the exec replaced this image, so nothing remains to clean here,
/// and the dead-pid rule reclaims the dir on the next delegated start).
#[cfg(any(not(unix), test))]
pub fn cleanup_after_spawn() {
    let dir = OWN_DIR.with(|slot| slot.borrow_mut().take());
    if let Some(dir) = dir {
        let _ = std::fs::remove_dir_all(dir);
    }
}

/// True when the process still exists. `kill(pid, 0)` performs only the
/// existence check; EPERM means it exists but belongs to someone else.
#[cfg(unix)]
fn pid_alive(pid: u32) -> bool {
    if pid == 0 {
        return true;
    }
    // SAFETY: kill(2) with signal 0 never sends anything and takes plain ints.
    if unsafe { libc::kill(pid as libc::pid_t, 0) } == 0 {
        return true;
    }
    std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

/// True when any readable process holds a file descriptor or its working
/// directory under `dir`. Unreadable answers count as "held" so a permission
/// oddity can only keep a directory alive, never lose data.
#[cfg(target_os = "linux")]
fn held_open_by_any_process(dir: &Path) -> bool {
    let Ok(real) = std::fs::canonicalize(dir) else {
        return true;
    };
    let Ok(procs) = std::fs::read_dir("/proc") else {
        return true;
    };
    for pid in procs.flatten() {
        let Some(name) = pid.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        if name.is_empty() || !name.bytes().all(|b| b.is_ascii_digit()) {
            continue;
        }
        let base = PathBuf::from("/proc").join(&name);
        if let Ok(cwd) = std::fs::read_link(base.join("cwd")) {
            if cwd.starts_with(&real) {
                return true;
            }
        }
        let Ok(fds) = std::fs::read_dir(base.join("fd")) else {
            continue;
        };
        for fd in fds.flatten() {
            if let Ok(target) = std::fs::read_link(fd.path()) {
                if target.starts_with(&real) {
                    return true;
                }
            }
        }
    }
    false
}

/// Without `/proc` there is no portable open-handle scan; the 24-hour quiet
/// rule is the only reclaim signal there.
#[cfg(not(target_os = "linux"))]
fn held_open_by_any_process(_dir: &Path) -> bool {
    false
}

/// Metadata freshness: anything newer than `cutoff`, or unknowable, counts as
/// fresh so the caller keeps the directory.
fn is_fresh(md: &std::fs::Metadata, cutoff: SystemTime) -> bool {
    match md.modified() {
        Ok(modified) => modified > cutoff,
        Err(_) => true,
    }
}

/// True when no file or directory under `dir` was modified after `cutoff`.
/// The walk stops at the first fresh entry, and an unreadable answer counts
/// as fresh: a live session is never deleted on a read error.
fn tree_is_quiet(dir: &Path, cutoff: SystemTime) -> bool {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return false;
    };
    for entry in entries.flatten() {
        let Ok(md) = entry.metadata() else {
            return false;
        };
        if is_fresh(&md, cutoff) {
            return false;
        }
        // Symlinked directories are not traversed (their target keeps its own
        // mtime; a symlink is never a reason to keep the snapshot).
        if md.is_dir() && !tree_is_quiet(&entry.path(), cutoff) {
            return false;
        }
    }
    true
}

/// Apparent file size of a directory tree (symlinks count zero).
fn tree_bytes(dir: &Path) -> u64 {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    let mut total = 0u64;
    for entry in entries.flatten() {
        let Ok(md) = entry.metadata() else {
            continue;
        };
        if md.is_dir() {
            total += tree_bytes(&entry.path());
        } else if md.is_file() {
            total += md.len();
        }
    }
    total
}

/// Ownership gate: only this user's directories are ever considered. On
/// Windows each user's temp root is already private, so everything under it
/// counts as ours.
#[cfg(unix)]
fn owned_by_current_user(md: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    // SAFETY: getuid takes no arguments and always succeeds.
    md.uid() == unsafe { libc::getuid() }
}

#[cfg(not(unix))]
fn owned_by_current_user(_md: &std::fs::Metadata) -> bool {
    true
}

/// Why a directory qualifies as an orphan.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OrphanKind {
    /// A per-run dir whose owning process is gone.
    DeadOwner,
    /// A legacy snapshot dir (or a per-run dir on non-unix) quiet for
    /// over [`STALE_AFTER`].
    Stale,
}

/// Decide whether `name` inside the temp root is an orphan this run may act
/// on. Real directories only (symlinks are never followed or deleted), and
/// only the two known prefixes.
fn orphan_kind(
    dir: &Path,
    name: &str,
    md: &std::fs::Metadata,
    now: SystemTime,
) -> Option<OrphanKind> {
    if !md.is_dir() || md.is_symlink() {
        return None;
    }
    if let Some(pid) = parse_own_name(name) {
        if pid == std::process::id() {
            return None; // this very run
        }
        #[cfg(unix)]
        {
            return (!pid_alive(pid)).then_some(OrphanKind::DeadOwner);
        }
        #[cfg(not(unix))]
        {
            // No portable liveness probe; cleanup_after_spawn covers normal
            // exits, so a leftover dir is reclaimed only once quiet.
            let _ = pid;
        }
    } else if !name.starts_with(LEGACY_PREFIX) {
        return None;
    }
    let cutoff = now.checked_sub(STALE_AFTER).unwrap_or(now);
    tree_is_quiet(dir, cutoff).then_some(OrphanKind::Stale)
}

/// What a scan found (dirs is "removed" in reclaim mode, "orphans" in
/// report mode).
#[derive(Debug, Default, Clone, Copy)]
pub(crate) struct Scan {
    pub(crate) dirs: usize,
    pub(crate) bytes: u64,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
    /// Count only; touch nothing (`rdsh doctor`).
    Report,
    /// Delete what qualifies (the pre-delegation reclaim).
    Reclaim,
}

/// Scan (and in [`Mode::Reclaim`] delete) orphan snapshot directories
/// directly under `base`. `ours` is the ownership gate, injected so tests can
/// exercise the foreign-owner path without root.
fn scan(
    base: &Path,
    now: SystemTime,
    ours: &dyn Fn(&std::fs::Metadata) -> bool,
    mode: Mode,
) -> Scan {
    let mut found = Scan::default();
    let Ok(entries) = std::fs::read_dir(base) else {
        return found;
    };
    for entry in entries.flatten() {
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        let Ok(md) = entry.metadata() else {
            continue;
        };
        if !md.is_dir() || md.is_symlink() || !ours(&md) {
            continue;
        }
        let dir = entry.path();
        if orphan_kind(&dir, &name, &md, now).is_none() {
            continue;
        }
        // A live process with a file or cwd inside stops the removal; the
        // directory stays for the next attempt. The report counts the same
        // way so `rdsh doctor` never promises a reclaim that cannot happen.
        if held_open_by_any_process(&dir) {
            continue;
        }
        let bytes = tree_bytes(&dir);
        if mode == Mode::Reclaim && std::fs::remove_dir_all(&dir).is_err() {
            continue; // raced with another reclaim or an active writer
        }
        found.bytes += bytes;
        found.dirs += 1;
    }
    found
}

/// The one-line reclaim result for stderr.
fn report_line(locale: crate::locale::Locale, found: Scan, base: &Path) -> String {
    let mb = found.bytes as f64 / 1_000_000.0;
    let base = base.display();
    match locale {
        crate::locale::Locale::English => format!(
            "[rdsh] tmp guard: removed {} orphan snapshot dir(s) ({mb:.1} MB) under {base}",
            found.dirs
        ),
        crate::locale::Locale::Chinese => format!(
            "[rdsh] tmp guard: 已从 {base} 清理 {} 个孤儿快照目录（{mb:.1} MB）",
            found.dirs
        ),
        crate::locale::Locale::Japanese => format!(
            "[rdsh] tmp guard: {base} 配下の孤立スナップショット {} 個（{mb:.1} MB）を削除しました",
            found.dirs
        ),
    }
}

/// Lightweight orphan reclaim, once per process, right before handing over
/// to dsh. Prints one stderr line only when something was actually removed.
pub fn sweep_before_exec(locale: crate::locale::Locale) {
    static ONCE: std::sync::Once = std::sync::Once::new();
    if disabled() {
        return;
    }
    ONCE.call_once(|| {
        let base = std::env::temp_dir();
        let found = scan(
            &base,
            SystemTime::now(),
            &owned_by_current_user,
            Mode::Reclaim,
        );
        if found.dirs > 0 {
            eprintln!("{}", report_line(locale, found, &base));
        }
    });
}

/// Untracked, non-ignored paths over [`DOCTOR_UNTRACKED_LIMIT`] in the
/// current working tree. The upstream snapshot photographs all of them every
/// session, so a big one is the direct cause of huge leftover directories.
fn large_untracked_lines(locale: crate::locale::Locale) -> Vec<String> {
    let Ok(output) = Command::new("git")
        .args(["ls-files", "--others", "--exclude-standard", "-z"])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .output()
    else {
        return Vec::new();
    };
    if !output.status.success() {
        return Vec::new();
    }
    let mut totals: HashMap<String, u64> = HashMap::new();
    let mut reported: HashSet<String> = HashSet::new();
    for raw in output.stdout.split(|byte| *byte == 0) {
        if raw.is_empty() {
            continue;
        }
        let path = String::from_utf8_lossy(raw).into_owned();
        let Some(group) = path.split('/').next().map(str::to_owned) else {
            continue;
        };
        if reported.contains(&group) {
            continue; // size no longer matters once the warning exists
        }
        let Ok(md) = std::fs::metadata(&path) else {
            continue;
        };
        let total = totals.entry(group.clone()).or_insert(0);
        *total += md.len();
        if *total >= DOCTOR_UNTRACKED_LIMIT {
            reported.insert(group);
        }
    }
    let mut big: Vec<(&String, &u64)> = reported
        .iter()
        .filter_map(|group| totals.get(group).map(|bytes| (group, bytes)))
        .collect();
    big.sort_unstable_by(|a, b| b.1.cmp(a.1));
    big.truncate(DOCTOR_UNTRACKED_MAX);
    big.into_iter()
        .map(|(group, bytes)| {
            let mb = *bytes as f64 / 1_000_000.0;
            match locale {
                crate::locale::Locale::English => format!(
                    "[rdsh] tmp guard: untracked '{group}' holds {mb:.0} MB — add it to .git/info/exclude or .gitignore to keep dsh workspace snapshots small"
                ),
                crate::locale::Locale::Chinese => format!(
                    "[rdsh] tmp guard: 未跟踪的 '{group}' 占用 {mb:.0} MB——请加入 .git/info/exclude 或 .gitignore，让 dsh 工作区快照保持小巧"
                ),
                crate::locale::Locale::Japanese => format!(
                    "[rdsh] tmp guard: 未追跡の '{group}' は {mb:.0} MB です。dsh のワークスペーススナップショットを小さく保つため .git/info/exclude か .gitignore に追加してください"
                ),
            }
        })
        .collect()
}

/// Read-only count of orphan snapshot directories under the temp root.
fn orphan_lines(locale: crate::locale::Locale) -> Vec<String> {
    let base = std::env::temp_dir();
    let found = scan(
        &base,
        SystemTime::now(),
        &owned_by_current_user,
        Mode::Report,
    );
    if found.dirs == 0 {
        return Vec::new();
    }
    let mb = found.bytes as f64 / 1_000_000.0;
    let base = base.display();
    let line = if disabled() {
        match locale {
            crate::locale::Locale::English => format!(
                "[rdsh] tmp guard: {n} orphan dsh workspace snapshot dir(s) ({mb:.1} MB) under {base} — automatic reclaim is off (RDSH_NO_TMP_GUARD=1)",
                n = found.dirs
            ),
            crate::locale::Locale::Chinese => format!(
                "[rdsh] tmp guard: {base} 下有 {} 个孤儿 dsh 工作区快照目录（{mb:.1} MB）——自动清理已关闭（RDSH_NO_TMP_GUARD=1）",
                found.dirs
            ),
            crate::locale::Locale::Japanese => format!(
                "[rdsh] tmp guard: {base} 配下に孤立した dsh ワークスペーススナップショットが {} 個（{mb:.1} MB）あります。自動回収は無効です（RDSH_NO_TMP_GUARD=1）",
                found.dirs
            ),
        }
    } else {
        match locale {
            crate::locale::Locale::English => format!(
                "[rdsh] tmp guard: {n} orphan dsh workspace snapshot dir(s) ({mb:.1} MB) under {base} — the next delegated run reclaims them (opt out: RDSH_NO_TMP_GUARD=1)",
                n = found.dirs
            ),
            crate::locale::Locale::Chinese => format!(
                "[rdsh] tmp guard: {base} 下有 {} 个孤儿 dsh 工作区快照目录（{mb:.1} MB）——下一次委派运行时会回收（可用 RDSH_NO_TMP_GUARD=1 退出）",
                found.dirs
            ),
            crate::locale::Locale::Japanese => format!(
                "[rdsh] tmp guard: {base} 配下に孤立した dsh ワークスペーススナップショットが {} 個（{mb:.1} MB）あります。次の委譲実行時に回収します（無効化: RDSH_NO_TMP_GUARD=1）",
                found.dirs
            ),
        }
    };
    vec![line]
}

/// Read-only doctor notes: snapshot bloat sources and leftover orphans.
/// `rdsh doctor` never deletes anything; the lines are plain strings so the
/// JSON report can reuse them verbatim.
pub fn doctor_lines(locale: crate::locale::Locale) -> Vec<String> {
    let mut out = large_untracked_lines(locale);
    out.extend(orphan_lines(locale));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("rdsh-tmp-guard-test-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn age_file(path: &Path, hours: u64) {
        let file = std::fs::File::options()
            .write(true)
            // The content is already on disk and must survive: only the mtime
            // changes. `.create(true)` + `.truncate(false)` keeps it.
            .truncate(false)
            .create(true)
            .open(path)
            .unwrap();
        let old = SystemTime::now() - Duration::from_secs(hours * 3600);
        file.set_times(std::fs::FileTimes::new().set_modified(old))
            .unwrap();
    }

    fn everyone() -> &'static dyn Fn(&std::fs::Metadata) -> bool {
        &|_| true
    }

    #[test]
    fn own_dir_names_round_trip_and_reject_foreign_shapes() {
        let name = own_name(12345, "a1b2c3d4e5f60718");
        assert_eq!(parse_own_name(&name), Some(12345));
        // Unknown shapes never match, so similar foreign names are untouched.
        assert_eq!(parse_own_name("rdsh-tmp-123"), None);
        assert_eq!(parse_own_name("rdsh-tmp--abc"), None);
        assert_eq!(parse_own_name("rdsh-tmp-abc-1"), None);
        assert_eq!(parse_own_name("rdsh-tmp-123-"), None);
        assert_eq!(parse_own_name("rdsh-e2e-123-1"), None);
        assert_eq!(parse_own_name("dsh-workspace-changes-1"), None);
    }

    fn write_file(dir: &Path, name: &str, bytes: usize) {
        std::fs::write(dir.join(name), vec![b'x'; bytes]).unwrap();
    }

    // `dead_pid()` spawns and `held_open_by_any_process` walks /proc: when the
    // test harness runs these in parallel they observe each other's children
    // and race. This gate serializes the tests that scan real processes.
    static SWEEP_GATE: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn gate() -> std::sync::MutexGuard<'static, ()> {
        SWEEP_GATE.lock().unwrap_or_else(|e| e.into_inner())
    }

    // The pid of a process that already exited: a reliable "dead owner".
    #[cfg(unix)]
    fn dead_pid() -> u32 {
        let child = std::process::Command::new("/bin/true").spawn().unwrap();
        let pid = child.id();
        child.wait_with_output().unwrap();
        pid
    }

    #[cfg(unix)]
    #[test]
    fn sweep_removes_dead_owner_and_quiet_dirs_and_keeps_the_rest() {
        let _g = gate();
        let base = scratch("reclaim");
        // A per-run dir owned by this still-running process: never touched.
        let live = base.join(own_name(std::process::id(), "live00000000000"));
        std::fs::create_dir_all(&live).unwrap();
        write_file(&live, "snap.bin", 10);
        // A per-run dir whose owner is gone: reclaimed.
        let dead = base.join(own_name(dead_pid(), "dead00000000000"));
        std::fs::create_dir_all(&dead).unwrap();
        write_file(&dead, "snap.bin", 20);
        // A legacy dir quiet for over 24h: reclaimed.
        let quiet = base.join("dsh-workspace-changes-old");
        std::fs::create_dir_all(&quiet).unwrap();
        write_file(&quiet, "a.bin", 30);
        age_file(&quiet.join("a.bin"), 25);
        // A legacy dir written minutes ago: a live session, keep it.
        let fresh = base.join("dsh-workspace-changes-new");
        std::fs::create_dir_all(&fresh).unwrap();
        write_file(&fresh, "a.bin", 40);

        let now = SystemTime::now();
        let found = scan(&base, now, everyone(), Mode::Reclaim);
        assert_eq!(found.dirs, 2, "exactly the dead and quiet dirs go");
        assert_eq!(found.bytes, 50);
        assert!(live.is_dir());
        assert!(fresh.is_dir());
        assert!(!dead.exists());
        assert!(!quiet.exists());

        let _ = std::fs::remove_dir_all(&base);
    }

    #[cfg(unix)]
    #[test]
    fn sweep_keeps_foreign_owned_and_wrong_prefix_entries() {
        let _g = gate();
        let base = scratch("foreign");
        let foreign = base.join(own_name(dead_pid(), "foreign0000000"));
        std::fs::create_dir_all(&foreign).unwrap();
        write_file(&foreign, "snap.bin", 10);
        let wrong_prefix = base.join("rdsh-e2e-1-2");
        std::fs::create_dir_all(&wrong_prefix).unwrap();
        let unrelated = base.join("unrelated-dir");
        std::fs::create_dir_all(&unrelated).unwrap();

        // The ownership gate rejects the marked dir exactly like a foreign
        // uid would (creating one for real needs root privileges); the
        // discriminator is the dir's inode, the same role uid plays.
        use std::os::unix::fs::MetadataExt;
        let foreign_ino = std::fs::metadata(&foreign).unwrap().ino();
        let not_ours = move |md: &std::fs::Metadata| md.ino() != foreign_ino;
        let now = SystemTime::now();
        let found = scan(&base, now, &not_ours, Mode::Reclaim);
        assert_eq!(found.dirs, 0);
        assert!(foreign.is_dir(), "a foreign-owned dir is never deleted");
        assert!(wrong_prefix.is_dir());
        assert!(unrelated.is_dir());

        let _ = std::fs::remove_dir_all(&base);
    }

    #[cfg(unix)]
    #[test]
    fn sweep_never_follows_symlinks() {
        let _g = gate();
        let base = scratch("symlink");
        let victim = base.join("victim");
        std::fs::create_dir_all(&victim).unwrap();
        write_file(&victim, "data.bin", 10);
        age_file(&victim.join("data.bin"), 25);
        // A symlink with the orphan name must not drag its target along.
        std::os::unix::fs::symlink(&victim, base.join("dsh-workspace-changes-link")).unwrap();
        // The same for a per-run shaped link.
        std::os::unix::fs::symlink(&victim, base.join(own_name(dead_pid(), "link00000000000")))
            .unwrap();
        // A plain file with the orphan name is not a directory either.
        std::fs::write(base.join("dsh-workspace-changes-file"), b"x").unwrap();

        let now = SystemTime::now();
        let found = scan(&base, now, everyone(), Mode::Reclaim);
        assert_eq!(found.dirs, 0);
        assert!(victim.is_dir(), "the symlink target must survive");
        assert!(base.join("dsh-workspace-changes-link").is_symlink());
        assert!(base.join("dsh-workspace-changes-file").is_file());

        let _ = std::fs::remove_dir_all(&base);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn sweep_keeps_a_dir_a_live_process_holds_open() {
        let _g = gate();
        let base = scratch("held-open");
        let held = base.join("dsh-workspace-changes-held");
        std::fs::create_dir_all(&held).unwrap();
        let file = held.join("snap.bin");
        write_file(&held, "snap.bin", 10);
        age_file(&file, 25);
        let open = std::fs::File::open(&file).unwrap();

        let now = SystemTime::now();
        let found = scan(&base, now, everyone(), Mode::Reclaim);
        assert_eq!(found.dirs, 0, "an open handle must stop the reclaim");
        assert!(held.is_dir());
        drop(open);

        let found = scan(&base, now, everyone(), Mode::Reclaim);
        assert_eq!(found.dirs, 1, "released handles are reclaimed");
        assert!(!held.exists());

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn report_mode_counts_without_deleting() {
        let _g = gate();
        let base = scratch("report");
        let orphan = base.join("dsh-workspace-changes-counted");
        std::fs::create_dir_all(&orphan).unwrap();
        write_file(&orphan, "a.bin", 100);
        age_file(&orphan.join("a.bin"), 25);

        let now = SystemTime::now();
        let found = scan(&base, now, everyone(), Mode::Report);
        assert_eq!(found.dirs, 1);
        assert_eq!(found.bytes, 100);
        assert!(orphan.is_dir(), "report mode never deletes");

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn report_line_shows_counts_and_bytes() {
        let line = report_line(
            crate::locale::Locale::English,
            Scan {
                dirs: 2,
                bytes: 4_700_000_000,
            },
            Path::new("/var/tmp"),
        );
        assert!(line.contains("2"), "{line}");
        assert!(line.contains("4700.0 MB"), "{line}");
        assert!(line.starts_with("[rdsh] tmp guard:"), "{line}");
    }

    #[cfg(unix)]
    #[test]
    fn apply_to_command_scopes_the_child_temp_dir() {
        let base = scratch("apply");

        let mut cmd = Command::new("true");
        apply_to_command_with_base(&mut cmd, &base);
        let tmpdir = cmd
            .get_envs()
            .find(|(key, _)| *key == std::ffi::OsStr::new("TMPDIR"))
            .and_then(|(_, value)| value)
            .map(std::ffi::OsString::from)
            .expect("TMPDIR must be set for the child");
        let dir = PathBuf::from(tmpdir);
        assert!(dir.starts_with(&base));
        let name = dir.file_name().unwrap().to_str().unwrap().to_owned();
        assert_eq!(parse_own_name(&name), Some(std::process::id()));
        assert!(dir.is_dir());

        cleanup_after_spawn();
        assert!(!dir.exists(), "the spawn path removes its own dir");

        let _ = std::fs::remove_dir_all(&base);
    }
}
