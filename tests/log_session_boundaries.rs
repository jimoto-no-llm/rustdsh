//! Boundary regression tests for `rdsh logs` and `rdsh sessions`.
//!
//! Dummy fixtures only, under a temporary `DSH_HOME`/`XDG_CACHE_HOME`: never
//! the real home, never real credentials, no network. These pin the
//! descriptor-based confinement in `src/inspect.rs`:
//! - `logs --file` stays under `<dsh>/logs` (outside paths/links rejected)
//! - the final open never follows links, hardlinks, or FIFOs (Unix)
//! - explicit `sessions --project` cannot escape the sessions root
//! - the token cache never truncates a planted `.tmp` symlink target and
//!   stays 0600 (Unix)

use std::path::PathBuf;
use std::process::Command;

struct Fixture {
    root: PathBuf,
    dsh: PathBuf,
}

impl Fixture {
    fn fresh(tag: &str) -> Self {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root =
            std::env::temp_dir().join(format!("rdsh-bound-{}-{}-{tag}", std::process::id(), nanos));
        let dsh = root.join("dsh");
        std::fs::create_dir_all(dsh.join("logs")).unwrap();
        std::fs::create_dir_all(dsh.join("sessions")).unwrap();
        Self { root, dsh }
    }

    fn cmd(&self) -> Command {
        let mut c = Command::new(env!("CARGO_BIN_EXE_rdsh"));
        c.env_clear();
        c.env("HOME", &self.root);
        c.env("PATH", std::env::var_os("PATH").unwrap_or_default());
        c.env("DSH_HOME", &self.dsh);
        c.env("XDG_CACHE_HOME", self.root.join("cache"));
        c.env("RDSH_TOKENS_CACHE", "1");
        c
    }

    fn session(&self, project: &str, id: &str) -> PathBuf {
        let dir = self.dsh.join("sessions").join(project).join(id);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

/// Minimal single-frame zstd stream whose header carries content size `n`:
/// magic + desc(single-segment, 1-byte FCS) + FCS + empty last raw block.
/// The std-only parser reports `Some(n)` with no CLI involved.
#[cfg(unix)]
fn frame_with_size(n: u8) -> Vec<u8> {
    vec![0x28, 0xB5, 0x2F, 0xFD, 0x20, n, 0x01, 0x00, 0x00]
}

#[test]
fn logs_reads_legit_file() {
    let f = Fixture::fresh("logs-ok");
    std::fs::write(f.dsh.join("logs").join("app.log"), "DUMMY_LOG_LINE\n").unwrap();
    let out = f
        .cmd()
        .arg("logs")
        .arg("--file")
        .arg("app.log")
        .output()
        .unwrap();
    assert!(out.status.success());
    assert!(String::from_utf8_lossy(&out.stdout).contains("DUMMY_LOG_LINE"));
}

#[test]
fn logs_preserves_relative_home_latest_selection_and_tail_filter() {
    let f = Fixture::fresh("logs-relative");
    std::fs::write(
        f.dsh.join("logs").join("app.log"),
        "DUMMY_MATCH old\nordinary\nDUMMY_MATCH new\n",
    )
    .unwrap();
    for selection in [
        Vec::<&str>::new(),
        vec!["--file", "app.log"],
        vec!["--file", "dsh/logs/app.log"],
        vec!["--file", "./dsh/logs/app.log"],
    ] {
        let out = f
            .cmd()
            .current_dir(&f.root)
            .env("DSH_HOME", "dsh")
            .args(["logs", "--tail", "1", "--grep", "DUMMY_MATCH"])
            .args(selection)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        assert!(String::from_utf8_lossy(&out.stdout).ends_with("DUMMY_MATCH new\n"));
        assert!(!String::from_utf8_lossy(&out.stdout).contains("DUMMY_MATCH old"));
        assert!(String::from_utf8_lossy(&out.stderr).contains("dsh"));
    }
}

#[test]
fn logs_rejects_absolute_and_dotdot() {
    let f = Fixture::fresh("logs-trav");
    std::fs::write(f.dsh.join("logs").join("app.log"), "DUMMY\n").unwrap();
    std::fs::write(f.root.join("DUMMY_OUTSIDE_MARKER.txt"), "DUMMY_SECRET").unwrap();
    let abs = f.root.join("DUMMY_OUTSIDE_MARKER.txt");
    for cand in [
        abs.to_string_lossy().into_owned(),
        "../DUMMY_OUTSIDE_MARKER.txt".into(),
    ] {
        let out = f
            .cmd()
            .arg("logs")
            .arg("--file")
            .arg(&cand)
            .output()
            .unwrap();
        assert!(!out.status.success(), "{cand}");
        assert!(
            !String::from_utf8_lossy(&out.stdout).contains("DUMMY_SECRET"),
            "{cand}"
        );
    }
    // The marker file itself is untouched.
    assert_eq!(
        std::fs::read_to_string(f.root.join("DUMMY_OUTSIDE_MARKER.txt")).unwrap(),
        "DUMMY_SECRET"
    );
}

#[cfg(unix)]
#[test]
fn logs_rejects_outside_symlink() {
    let f = Fixture::fresh("logs-link");
    std::fs::write(f.dsh.join("logs").join("app.log"), "DUMMY\n").unwrap();
    std::fs::write(f.root.join("outside.txt"), "DUMMY_SECRET").unwrap();
    std::os::unix::fs::symlink(f.root.join("outside.txt"), f.dsh.join("logs").join("evil"))
        .unwrap();
    let out = f
        .cmd()
        .arg("logs")
        .arg("--file")
        .arg("evil")
        .output()
        .unwrap();
    assert!(!out.status.success());
    assert!(!String::from_utf8_lossy(&out.stdout).contains("DUMMY_SECRET"));
}

#[cfg(unix)]
#[test]
fn logs_rejects_hardlink() {
    let f = Fixture::fresh("logs-hard");
    let target = f.dsh.join("logs").join("app.log");
    std::fs::write(&target, "DUMMY_LOG_LINE\n").unwrap();
    std::fs::hard_link(&target, f.dsh.join("logs").join("alias")).unwrap();
    let out = f
        .cmd()
        .arg("logs")
        .arg("--file")
        .arg("alias")
        .output()
        .unwrap();
    assert!(!out.status.success());
}

#[cfg(unix)]
#[test]
fn logs_fifo_is_rejected_without_blocking() {
    use std::os::unix::ffi::OsStrExt;
    use std::time::Duration;
    let f = Fixture::fresh("logs-fifo");
    std::fs::write(f.dsh.join("logs").join("app.log"), "DUMMY\n").unwrap();
    let name =
        std::ffi::CString::new(f.dsh.join("logs").join("pipe").as_os_str().as_bytes()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
    let mut child = f
        .cmd()
        .arg("logs")
        .arg("--file")
        .arg("pipe")
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let deadline = std::time::Instant::now() + Duration::from_secs(3);
    loop {
        if let Some(status) = child.try_wait().unwrap() {
            assert!(!status.success());
            break;
        }
        if std::time::Instant::now() >= deadline {
            child.kill().unwrap();
            child.wait().unwrap();
            panic!("fifo open must not block");
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn sessions_rejects_project_traversal() {
    let f = Fixture::fresh("sess-trav");
    let dir = f.session("realproj", "s1");
    std::fs::write(dir.join("f.jsonl"), "{\"dummy\":1}").unwrap();
    std::fs::write(f.root.join("DUMMY_probe.txt"), "x").unwrap();
    for cand in ["../..", "..", "."] {
        let out = f
            .cmd()
            .arg("sessions")
            .arg("--project")
            .arg(cand)
            .arg("--json")
            .output()
            .unwrap();
        assert!(out.status.success(), "{cand}");
        let v: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
        assert_eq!(v["total"], 0, "{cand}");
        assert!(
            !String::from_utf8_lossy(&out.stdout).contains("DUMMY_probe"),
            "{cand}"
        );
    }
    // The legitimate project still lists.
    let out = f
        .cmd()
        .arg("sessions")
        .arg("--project")
        .arg("realproj")
        .arg("--json")
        .output()
        .unwrap();
    let v: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(v["total"], 1);
}

#[cfg(unix)]
#[test]
fn sessions_rejects_symlinked_project() {
    let f = Fixture::fresh("sess-link");
    let dir = f.session("realproj", "s1");
    std::fs::write(dir.join("f.jsonl"), "{\"dummy\":1}").unwrap();
    std::fs::write(f.root.join("DUMMY_EVIDENCE.txt"), "x").unwrap();
    std::os::unix::fs::symlink(&f.root, f.dsh.join("sessions").join("evilproj")).unwrap();
    let out = f
        .cmd()
        .arg("sessions")
        .arg("--project")
        .arg("evilproj")
        .arg("--json")
        .output()
        .unwrap();
    assert!(out.status.success());
    let v: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(v["total"], 0);
    assert!(!String::from_utf8_lossy(&out.stdout).contains("DUMMY_EVIDENCE"));
}

#[cfg(unix)]
#[test]
fn token_sizes_ignore_linked_zstd() {
    let f = Fixture::fresh("sess-tok");
    let dir = f.session("realproj", "s1");
    std::fs::write(dir.join("data.zstd"), frame_with_size(40)).unwrap();
    std::fs::write(f.root.join("big.zstd"), frame_with_size(200)).unwrap();
    std::os::unix::fs::symlink(f.root.join("big.zstd"), dir.join("evil.zstd")).unwrap();
    let out = f
        .cmd()
        .arg("sessions")
        .arg("--project")
        .arg("realproj")
        .arg("--tokens")
        .arg("--json")
        .output()
        .unwrap();
    assert!(out.status.success());
    let v: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    // 40 decompressed bytes -> 10 tokens; the linked 200-byte frame is out.
    assert_eq!(v["sessions"][0]["tokens"], 10);
    assert_eq!(v["sessions"][0]["tokens_exact"], false);
}

/// Drives a real cache write: one `.zstd` frame with a header-known size.
#[cfg(unix)]
fn run_cache_write(f: &Fixture, project: &str) {
    let out = f
        .cmd()
        .arg("sessions")
        .arg("--project")
        .arg(project)
        .arg("--tokens")
        .output()
        .unwrap();
    assert!(out.status.success());
}

#[cfg(unix)]
fn cache_file(f: &Fixture) -> PathBuf {
    f.root
        .join("cache")
        .join("rdsh")
        .join("sessions-tokens.json")
}

#[cfg(unix)]
#[test]
fn cache_tmp_symlink_cannot_clobber() {
    let f = Fixture::fresh("cache-tmp");
    let dir = f.session("realproj", "s1");
    std::fs::write(dir.join("data.zstd"), frame_with_size(40)).unwrap();
    // The old predictable tmp path, planted as a link at a victim file.
    let victim = f.root.join("DUMMY_VICTIM.txt");
    std::fs::write(&victim, "DUMMY_VICTIM_CONTENT").unwrap();
    let predictable = f
        .root
        .join("cache")
        .join("rdsh")
        .join("sessions-tokens.json.tmp");
    std::fs::create_dir_all(predictable.parent().unwrap()).unwrap();
    std::os::unix::fs::symlink(&victim, &predictable).unwrap();
    run_cache_write(&f, "realproj");
    assert_eq!(
        std::fs::read_to_string(&victim).unwrap(),
        "DUMMY_VICTIM_CONTENT"
    );
    // A real cache file was still written through the random tmp name.
    assert!(cache_file(&f).is_file());
}

#[cfg(unix)]
#[test]
fn cache_file_is_0600() {
    use std::os::unix::fs::PermissionsExt;
    let f = Fixture::fresh("cache-mode");
    let dir = f.session("realproj", "s1");
    std::fs::write(dir.join("data.zstd"), frame_with_size(40)).unwrap();
    run_cache_write(&f, "realproj");
    let mode = std::fs::metadata(cache_file(&f))
        .unwrap()
        .permissions()
        .mode()
        & 0o777;
    assert_eq!(mode, 0o600);
}
