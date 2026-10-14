//! `rdsh models auto`: the schedule around `rdsh models sync`.
//!
//! Every case runs the real binary against a hermetic `DSH_HOME` that holds no
//! provider block, so `models sync` has nothing to fetch: no network, no model
//! credentials and no harness are needed.

use std::path::PathBuf;
use std::process::{Command, Output};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

static NEXT_FIXTURE: AtomicUsize = AtomicUsize::new(0);

struct Fixture {
    root: PathBuf,
}

impl Fixture {
    fn new(tag: &str) -> Self {
        let id = NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "rdsh-models-auto-{tag}-{}-{id}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        Self { root }
    }

    /// The environment a launch needs so it can only ever fail: no dsh on
    /// PATH, an explicit missing original, and a private HOME.
    fn launch_command(&self, args: &[&str]) -> Command {
        let empty = self.root.join("empty-path");
        let _ = std::fs::create_dir_all(&empty);
        let mut command = Command::new(env!("CARGO_BIN_EXE_rdsh"));
        command
            .args(args)
            .env("DSH_HOME", &self.root)
            .env("HOME", self.root.join("home"))
            .env("PATH", &empty)
            .env("DSH_ORIG_BIN", self.root.join("missing-dsh"))
            .env_remove("RDSH_NO_MODELS_AUTO")
            .env_remove("RDSH_MODELS_AUTO_INTERVAL_HOURS");
        command
    }

    fn with_profile(self) -> Self {
        let profile = self.root.join("profiles/web");
        std::fs::create_dir_all(&profile).unwrap();
        // An empty but present patch is a usable profile; the sync has no
        // provider blocks and performs no network request.
        std::fs::write(profile.join("cordis.patch.yml"), "").unwrap();
        self
    }

    fn with_settings(self, raw: &str) -> Self {
        std::fs::write(self.root.join("rdsh.json"), raw).unwrap();
        self
    }

    fn run(&self, args: &[&str]) -> Output {
        let empty = self.root.join("empty-path");
        let _ = std::fs::create_dir_all(&empty);
        Command::new(env!("CARGO_BIN_EXE_rdsh"))
            .args(args)
            .env("DSH_HOME", &self.root)
            .env("HOME", self.root.join("home"))
            .env("PATH", empty)
            .env_remove("RDSH_NO_MODELS_AUTO")
            .env_remove("RDSH_MODELS_AUTO_INTERVAL_HOURS")
            .output()
            .unwrap()
    }

    fn state(&self) -> Option<serde_json::Value> {
        let text = std::fs::read_to_string(self.state_path()).ok()?;
        serde_json::from_str(&text).ok()
    }

    fn state_path(&self) -> PathBuf {
        self.root.join("cache/rdsh-models-auto.json")
    }

    fn report(&self, args: &[&str]) -> serde_json::Value {
        let output = self.run(args);
        assert!(
            output.status.success(),
            "{} failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&output.stderr)
        );
        serde_json::from_slice(&output.stdout).expect("--json must print a report")
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn json<'a>(args: &[&'a str]) -> Vec<&'a str> {
    let mut all = args.to_vec();
    all.push("--json");
    all
}

#[test]
fn a_first_run_refreshes_and_records_the_attempt() {
    let fixture = Fixture::new("first").with_profile();
    let report = fixture.report(&json(&["models", "auto"]));
    assert_eq!(report["enabled"], serde_json::json!(true));
    assert_eq!(report["ran"], serde_json::json!(true));
    assert_eq!(report["reason"], serde_json::json!("due"));
    assert_eq!(report["failed"], serde_json::json!(false));
    assert_eq!(report["command"], serde_json::json!("models sync --json"));

    let state = fixture.state().expect("the attempt is recorded");
    assert_eq!(state["schema"], serde_json::json!(1));
    assert_eq!(state["outcome"], serde_json::json!("ok"));
    assert!(state["last_attempt_unix"].as_u64().is_some());
}

#[test]
fn the_recorded_interval_holds_the_next_run_back() {
    let fixture = Fixture::new("interval").with_profile();
    fixture.report(&json(&["models", "auto"]));

    let second = fixture.report(&json(&["models", "auto"]));
    assert_eq!(second["ran"], serde_json::json!(false));
    assert_eq!(second["reason"], serde_json::json!("not_due"));
    assert_eq!(second["hint"], serde_json::json!("run again with --force"));

    let forced = fixture.report(&json(&["models", "auto", "--force"]));
    assert_eq!(forced["ran"], serde_json::json!(true));
}

#[test]
fn a_dry_run_never_records_an_attempt() {
    let fixture = Fixture::new("dry-run").with_profile();
    let report = fixture.report(&json(&["models", "auto", "--force", "--dry-run"]));
    assert_eq!(report["ran"], serde_json::json!(true));
    assert_eq!(report["reason"], serde_json::json!("dry_run"));
    assert!(
        !fixture.state_path().exists(),
        "a preview must not gate the next real refresh"
    );
}

#[test]
fn the_feature_switch_and_the_kill_switch_disable_it() {
    let off = Fixture::new("feature-off")
        .with_profile()
        .with_settings(r#"{"schema":1,"features":{"models_auto":false}}"#);
    let report = off.report(&json(&["models", "auto"]));
    assert_eq!(report["enabled"], serde_json::json!(false));
    assert_eq!(report["reason"], serde_json::json!("disabled"));
    assert!(!off.state_path().exists());

    let killed = Fixture::new("kill-switch").with_profile();
    let output = Command::new(env!("CARGO_BIN_EXE_rdsh"))
        .args(json(&["models", "auto"]))
        .env("DSH_HOME", &killed.root)
        .env("RDSH_NO_MODELS_AUTO", "1")
        .output()
        .unwrap();
    assert!(output.status.success());
    let report: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["enabled"], serde_json::json!(false));
    assert!(!killed.state_path().exists());
}

#[test]
fn a_home_without_profiles_is_left_alone() {
    let fixture = Fixture::new("no-profiles");
    let report = fixture.report(&json(&["models", "auto"]));
    assert_eq!(report["ran"], serde_json::json!(false));
    assert_eq!(report["reason"], serde_json::json!("no_profiles"));
    assert!(!fixture.state_path().exists());
}

#[test]
fn an_empty_profiles_directory_is_not_marked_as_an_attempt() {
    let fixture = Fixture::new("empty-profiles");
    std::fs::create_dir_all(fixture.root.join("profiles")).unwrap();
    let report = fixture.report(&json(&["models", "auto"]));
    assert_eq!(report["ran"], serde_json::json!(false));
    assert_eq!(report["reason"], serde_json::json!("no_profiles"));
    assert!(!fixture.state_path().exists());
}

#[test]
fn provider_fetch_failure_is_not_recorded_as_success() {
    let fixture = Fixture::new("provider-failure");
    let profile = fixture.root.join("profiles/web");
    std::fs::create_dir_all(&profile).unwrap();
    std::fs::write(
        profile.join("cordis.patch.yml"),
        "- id: llm-pi-ai\n  config:\n    providers:\n      openai-codex:\n        models: []\n",
    )
    .unwrap();
    let output = fixture.run(&["models", "auto", "--force", "--json"]);
    assert!(!output.status.success());
    let report: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["failed"], serde_json::json!(true));
    assert_eq!(report["summary"]["failed"], serde_json::json!(1));
    let state = fixture.state().expect("failed refresh state is recorded");
    assert_eq!(state["outcome"], serde_json::json!("failed"));
    assert_eq!(state["last_success_unix"], serde_json::Value::Null);
}

#[test]
fn unsupported_profile_layout_is_reported_as_a_skip() {
    let fixture = Fixture::new("unsupported-layout");
    let profile = fixture.root.join("profiles/web");
    std::fs::create_dir_all(&profile).unwrap();
    std::fs::write(
        profile.join("cordis.patch.yml"),
        "- id: llm-pi-ai\n  config:\n    providers:\n      openai-codex:\n        models: [{id: gpt-5.6-sol}]\n",
    )
    .unwrap();
    let report = fixture.report(&json(&["models", "auto", "--force"]));
    assert_eq!(report["failed"], serde_json::json!(false));
    assert_eq!(report["summary"]["skipped"], serde_json::json!(1));
    assert_eq!(report["summary"]["failed"], serde_json::json!(0));
    assert_eq!(fixture.state().unwrap()["outcome"], serde_json::json!("ok"));
}

#[test]
fn a_missing_named_profile_fails_loudly() {
    let fixture = Fixture::new("missing-profile").with_profile();
    let output = fixture.run(&json(&["models", "auto", "--force", "--profile", "nope"]));
    assert!(
        !output.status.success(),
        "an unusable profile selection must not look like a successful refresh"
    );
    let report: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["failed"], serde_json::json!(true));
    // The failure is recorded, so the interval still gates the retry.
    let state = fixture.state().expect("a failed attempt is recorded");
    assert_eq!(state["outcome"], serde_json::json!("failed"));
    assert_eq!(state["last_success_unix"], serde_json::Value::Null);
}

#[test]
fn a_dry_run_boot_never_starts_a_background_refresh() {
    let fixture = Fixture::new("boot-dry").with_profile();
    let _ = fixture
        .launch_command(&["--dry-run", "boot", "--profile", "web"])
        .output()
        .unwrap();
    assert!(
        !fixture.state_path().exists(),
        "a dry-run launch must not schedule anything"
    );
}

/// The boot hook runs before the delegation, so a launch that cannot find
/// `dsh` still proves whether the background refresh was started. The empty
/// `PATH` keeps the launcher from reaching a real harness.
#[test]
fn a_boot_without_dsh_still_schedules_the_refresh() {
    let fixture = Fixture::new("boot-hook").with_profile();
    let output = fixture
        .launch_command(&["boot", "--profile", "web"])
        .output()
        .unwrap();
    assert!(
        !output.status.success(),
        "the launch itself must fail without a dsh on PATH"
    );

    let deadline = Instant::now() + Duration::from_secs(20);
    while Instant::now() < deadline && fixture.state().is_none() {
        std::thread::sleep(Duration::from_millis(100));
    }
    let state = fixture.state().unwrap_or_else(|| {
        panic!(
            "the background refresh recorded its attempt (stderr: {})",
            String::from_utf8_lossy(&output.stderr)
        )
    });
    assert_eq!(state["outcome"], serde_json::json!("ok"));
    assert_eq!(state["changed"], serde_json::json!(false));
}

#[test]
fn an_as_dsh_profile_launch_schedules_the_background_refresh() {
    let fixture = Fixture::new("shadow-launch").with_profile();
    let binary_dir = fixture.root.join("shadow-bin");
    std::fs::create_dir_all(&binary_dir).unwrap();
    let binary = binary_dir.join(if cfg!(windows) { "dsh.exe" } else { "dsh" });
    std::fs::copy(env!("CARGO_BIN_EXE_rdsh"), &binary).unwrap();
    let empty = fixture.root.join("empty-path");
    std::fs::create_dir_all(&empty).unwrap();
    let output = Command::new(binary)
        .arg("web")
        .env("DSH_HOME", &fixture.root)
        .env("HOME", fixture.root.join("home"))
        .env("PATH", empty)
        .env("DSH_ORIG_BIN", fixture.root.join("missing-dsh"))
        .env_remove("RDSH_NO_MODELS_AUTO")
        .output()
        .unwrap();
    assert!(
        !output.status.success(),
        "the original dsh is intentionally absent"
    );
    let deadline = Instant::now() + Duration::from_secs(20);
    while Instant::now() < deadline && fixture.state().is_none() {
        std::thread::sleep(Duration::from_millis(100));
    }
    let state = fixture.state().unwrap_or_else(|| {
        panic!(
            "the shadow launch schedules auto refresh: {}",
            String::from_utf8_lossy(&output.stderr)
        )
    });
    assert_eq!(state["outcome"], serde_json::json!("ok"));
}
