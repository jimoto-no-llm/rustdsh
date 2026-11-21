//! `rdsh tui` without a local DSH tui profile must not fail on the missing
//! profile: it starts the built-in Rust TUI and says so.
use std::fs;
use std::path::PathBuf;
use std::process::Output;

struct Fixture {
    root: PathBuf,
}

impl Fixture {
    fn new(name: &str, with_tui_profile: bool) -> Self {
        let root =
            std::env::temp_dir().join(format!("rdsh-tui-fallback-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("dsh/profiles/web")).unwrap();
        if with_tui_profile {
            fs::create_dir_all(root.join("dsh/profiles/tui")).unwrap();
        }
        Self { root }
    }

    fn run(&self, args: &[&str]) -> Output {
        let mut command = std::process::Command::new(env!("CARGO_BIN_EXE_rdsh"));
        command.env_clear();
        for key in ["PATH", "SystemRoot", "WINDIR", "COMSPEC", "TEMP", "TMP"] {
            if let Some(value) = std::env::var_os(key) {
                command.env(key, value);
            }
        }
        command
            .args(args)
            .current_dir(&self.root)
            .env("HOME", &self.root)
            .env("USERPROFILE", &self.root)
            .env("DSH_HOME", self.root.join("dsh"))
            .env("RUSTXNG_SKIP_INSTALL", "1")
            .env("RDSH_LANG", "en")
            .env("LANG", "C")
            .stdin(std::process::Stdio::null())
            .output()
            .unwrap()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[test]
fn bare_tui_without_a_local_profile_starts_the_builtin_tui() {
    let fixture = Fixture::new("missing", false);
    let output = fixture.run(&["tui"]);
    let stderr = String::from_utf8_lossy(&output.stderr);
    // The built-in TUI is reached and stops at its terminal guard, not at a
    // missing-profile error from the DSH delegation.
    assert!(
        stderr.contains("built-in Rust TUI"),
        "expected the fallback notice, got: {stderr}"
    );
    assert!(
        stderr.contains("requires an interactive terminal"),
        "expected the built-in TUI to run, got: {stderr}"
    );
    assert!(
        !stderr.contains("profile \"tui\" does not exist"),
        "the missing-profile error must not surface: {stderr}"
    );
}

#[test]
fn an_installed_tui_profile_still_delegates_to_dsh() {
    let fixture = Fixture::new("present", true);
    let output = fixture.run(&["tui", "--dry-run"]);
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        !stderr.contains("built-in Rust TUI"),
        "an installed profile must keep delegating: {stderr}"
    );
}

#[test]
fn an_explicit_profile_flag_never_falls_back() {
    let fixture = Fixture::new("explicit", false);
    let output = fixture.run(&["--profile", "tui", "--dry-run"]);
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        !stderr.contains("built-in Rust TUI"),
        "an explicit --profile tui must not be replaced: {stderr}"
    );
}
