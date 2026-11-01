#![cfg(unix)]
//! POSIX argv must survive the alias, and native CLI errors must not abort.
use std::ffi::OsString;
use std::fs;
use std::os::unix::ffi::OsStringExt;
use std::os::unix::fs::{symlink, PermissionsExt};
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicUsize, Ordering};

static NEXT: AtomicUsize = AtomicUsize::new(0);

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "rdsh-nonutf8-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        fs::create_dir(root.join("home")).unwrap();
        fs::create_dir(root.join("state")).unwrap();
        // Per-fixture temp root: the tmp guard must stay inside the fixture.
        fs::create_dir(root.join("tmp")).unwrap();
        fs::write(
            root.join("state/.credentials.yaml"),
            "version: 1\nrefs:\n  TEST: 'yes'\n",
        )
        .unwrap();
        symlink(env!("CARGO_BIN_EXE_rdsh"), root.join("dsh")).unwrap();
        fs::write(
            root.join("original"),
            "#!/bin/sh\nprintf '%s\\0' \"$@\"\nprintf 'original stderr 日本語\\n' >&2\nexit 23\n",
        )
        .unwrap();
        fs::set_permissions(root.join("original"), fs::Permissions::from_mode(0o755)).unwrap();
        Self(root)
    }
    fn command(&self, alias: bool) -> Command {
        let mut command = Command::new(if alias {
            self.0.join("dsh")
        } else {
            PathBuf::from(env!("CARGO_BIN_EXE_rdsh"))
        });
        command
            .env_clear()
            .env(
                "PATH",
                std::env::var_os("PATH").unwrap_or_else(|| "/usr/bin:/bin".into()),
            )
            .env("HOME", self.0.join("home"))
            .env("DSH_HOME", self.0.join("state"))
            .env("TMPDIR", self.0.join("tmp"))
            .env("XDG_CACHE_HOME", self.0.join("cache"))
            .env("XDG_CONFIG_HOME", self.0.join("config"))
            .env("XDG_DATA_HOME", self.0.join("data"))
            .env("RDSH_ORIG_BIN", self.0.join("original"))
            .current_dir(&self.0);
        command
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn alias_forwards_every_argument_byte_in_both_environment_modes() {
    use std::os::unix::ffi::OsStrExt;
    for passthrough in ["0", "1"] {
        for first in [
            OsString::from("--profile=web"),
            OsString::from_vec(b"raw-\xff".to_vec()),
        ] {
            // A fresh fixture per iteration: a normal-mode delegation leaves
            // its per-run temp dir behind (exec hands the process over), and
            // the next start would legitimately reclaim it with a stderr
            // line — which this byte-exact test must not mix in.
            let fixture = Fixture::new();
            let args = [
                first,
                "日本語".into(),
                "".into(),
                "--".into(),
                OsString::from_vec(b"file-\xfe\n\xff".to_vec()),
            ];
            let output = fixture
                .command(true)
                .env("RDSH_PASSTHROUGH", passthrough)
                .args(&args)
                .output()
                .unwrap();
            assert_eq!(output.status.code(), Some(23), "{output:?}");
            let expected: Vec<u8> = args
                .iter()
                .flat_map(|arg| arg.as_bytes().iter().copied().chain([0]))
                .collect();
            assert_eq!(output.stdout, expected);
            assert_eq!(output.stderr, "original stderr 日本語\n".as_bytes());
        }
    }
}

#[test]
fn native_commands_reject_invalid_utf8_without_panicking_in_locale_bootstrap() {
    let fixture = Fixture::new();
    for alias in [false, true] {
        for language in [vec![], vec!["--language", "ja"]] {
            let output = fixture
                .command(alias)
                .arg("search")
                .args(language)
                .arg(OsString::from_vec(b"pattern-\xff".to_vec()))
                .output()
                .unwrap();
            assert_eq!(output.status.code(), Some(2), "{output:?}");
            assert!(output.stdout.is_empty());
            let stderr = String::from_utf8_lossy(&output.stderr);
            assert!(!stderr.contains("panicked"), "{stderr}");
            assert!(!stderr.is_empty());
        }
    }
}

#[test]
fn non_utf8_argv0_parent_does_not_abort_alias_detection() {
    use std::os::unix::process::CommandExt;
    let fixture = Fixture::new();
    let native = fixture
        .command(false)
        .arg0(OsString::from_vec(b"parent-\xff/rdsh".to_vec()))
        .arg("--version")
        .output()
        .unwrap();
    assert!(native.status.success(), "{native:?}");
    assert!(native.stdout.starts_with(b"rdsh "));
    let delegated = fixture
        .command(true)
        .arg0(OsString::from_vec(b"parent-\xff/dsh".to_vec()))
        .env("RDSH_PASSTHROUGH", "1")
        .arg("--version")
        .output()
        .unwrap();
    assert_eq!(delegated.status.code(), Some(23), "{delegated:?}");
    assert_eq!(delegated.stdout, b"--version\0");
}
