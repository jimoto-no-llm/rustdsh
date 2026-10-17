use serde_json::{json, Value};
use std::path::PathBuf;
use std::process::{Command, Output};

const PROFILE: &str = "- id: llm-pi-ai\n  config:\n    providers:\n      openai-codex:\n        models:\n          - id: old\n            name: Keep\n";

struct Fixture {
    root: PathBuf,
    patch: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root =
            std::env::temp_dir().join(format!("rdsh-models-cli-{}-{nonce}", std::process::id()));
        let patch = root.join(".dsh/profiles/web/cordis.patch.yml");
        std::fs::create_dir_all(patch.parent().unwrap()).unwrap();
        std::fs::create_dir_all(root.join(".codex")).unwrap();
        std::fs::create_dir_all(root.join("bin")).unwrap();
        std::fs::write(&patch, PROFILE).unwrap();
        std::fs::write(root.join(".codex/models_cache.json"), json!({"models":[{"slug":"gpt-6.1-sol","display_name":"GPT-6.1-Sol","context_window":272000}]}).to_string()).unwrap();
        Self { root, patch }
    }

    fn run(&self, args: &[&str], env_dry: bool) -> Output {
        self.run_with_codex_home(args, env_dry, None)
    }

    fn run_with_codex_home(
        &self,
        args: &[&str],
        env_dry: bool,
        codex_home: Option<&std::path::Path>,
    ) -> Output {
        let mut command = Command::new(env!("CARGO_BIN_EXE_rdsh"));
        command.env_clear();
        for name in ["SystemRoot", "WINDIR", "COMSPEC", "TEMP", "TMP"] {
            if let Some(value) = std::env::var_os(name) {
                command.env(name, value);
            }
        }
        command
            .env("HOME", &self.root)
            .env("USERPROFILE", &self.root)
            .env("DSH_HOME", self.root.join(".dsh"))
            .env("PATH", self.root.join("bin"))
            .env("RDSH_AUTH_AUTOSYNC", "0")
            .env("RDSH_ORIG_BIN", self.root.join("absent-dsh"))
            .current_dir(&self.root)
            .args(args);
        if env_dry {
            command.env("RDSH_DRY_RUN", "1");
        }
        if let Some(home) = codex_home {
            command.env("CODEX_HOME", home);
        }
        command.output().unwrap()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

#[test]
fn models_sync_inherits_outer_provider_and_json() {
    let fixture = Fixture::new();
    let output = fixture.run(
        &[
            "models",
            "--provider",
            "kimi-coding",
            "--json",
            "sync",
            "--profile",
            "web",
            "--dry-run",
        ],
        false,
    );
    assert!(output.status.success());
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["profiles"], json!([]));
    assert_eq!(report["dry_run"], true);
    assert_eq!(std::fs::read_to_string(&fixture.patch).unwrap(), PROFILE);
}

#[test]
fn models_sync_inner_provider_overrides_outer_provider() {
    let fixture = Fixture::new();
    let output = fixture.run(
        &[
            "models",
            "--provider",
            "kimi-coding",
            "--json",
            "sync",
            "--profile",
            "web",
            "--provider",
            "openai-codex",
            "--dry-run",
        ],
        false,
    );
    assert!(output.status.success());
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["profiles"].as_array().unwrap().len(), 1);
    assert_eq!(report["profiles"][0]["provider"], "openai-codex");
    assert_eq!(std::fs::read_to_string(&fixture.patch).unwrap(), PROFILE);
}

#[test]
fn models_sync_obeys_environment_dry_run() {
    let fixture = Fixture::new();
    let output = fixture.run(
        &[
            "models",
            "sync",
            "--profile",
            "web",
            "--provider",
            "openai-codex",
            "--json",
        ],
        true,
    );
    assert!(output.status.success());
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["dry_run"], true);
    assert_eq!(report["profiles"][0]["written"], false);
    assert_eq!(std::fs::read_to_string(&fixture.patch).unwrap(), PROFILE);
}

#[test]
fn models_sync_obeys_settings_dry_run() {
    let fixture = Fixture::new();
    std::fs::write(
        fixture.root.join(".dsh/rdsh.json"),
        json!({"general":{"dry_run":true}}).to_string(),
    )
    .unwrap();
    let output = fixture.run(
        &[
            "models",
            "sync",
            "--profile",
            "web",
            "--provider",
            "openai-codex",
            "--json",
        ],
        false,
    );
    assert!(output.status.success());
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["dry_run"], true);
    assert_eq!(report["profiles"][0]["written"], false);
    assert_eq!(std::fs::read_to_string(&fixture.patch).unwrap(), PROFILE);
}

#[test]
fn models_sync_uses_custom_codex_home_without_default_cache() {
    let fixture = Fixture::new();
    let custom_home = fixture.root.join("custom-codex");
    std::fs::create_dir_all(&custom_home).unwrap();
    std::fs::rename(
        fixture.root.join(".codex/models_cache.json"),
        custom_home.join("models_cache.json"),
    )
    .unwrap();
    let output = fixture.run_with_codex_home(
        &[
            "models",
            "sync",
            "--profile",
            "web",
            "--provider",
            "openai-codex",
            "--json",
        ],
        false,
        Some(&custom_home),
    );
    assert!(output.status.success());
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["profiles"][0]["added"], json!(["gpt-6.1-sol"]));
    assert_eq!(report["profiles"][0]["written"], true);
    assert!(std::fs::read_to_string(&fixture.patch)
        .unwrap()
        .starts_with(PROFILE));
}

#[test]
fn models_rejects_duplicate_llm_pi_ai_entries_for_show_dry_run_and_sync() {
    for first_provider in ["openai-codex", "unrelated"] {
        for operation in ["show", "dry-run", "sync"] {
            let fixture = Fixture::new();
            let first = PROFILE.replacen("openai-codex:", &format!("{first_provider}:"), 1);
            let duplicate = format!("{first}{PROFILE}");
            std::fs::write(&fixture.patch, &duplicate).unwrap();
            let mut args = vec!["models"];
            if operation != "show" {
                args.push("sync");
            }
            args.extend(["--profile", "web", "--provider", "openai-codex", "--json"]);
            if operation == "dry-run" {
                args.push("--dry-run");
            }
            let output = fixture.run(&args, false);
            assert!(output.status.success());
            let report: Value = serde_json::from_slice(&output.stdout).unwrap();
            let profiles = report["profiles"].as_array().unwrap();
            assert_eq!(profiles.len(), 1, "{first_provider} {operation}");
            assert!(profiles[0]["skipped"]
                .as_str()
                .is_some_and(|reason| reason.contains("multiple llm-pi-ai")));
            assert_eq!(profiles[0]["written"], false);
            assert_eq!(
                std::fs::read_to_string(&fixture.patch).unwrap(),
                duplicate,
                "{first_provider} {operation}"
            );
        }
    }
}

#[test]
fn models_sync_custom_codex_home_ignores_stale_default_cache() {
    let fixture = Fixture::new();
    let custom_home = fixture.root.join("custom-codex");
    std::fs::create_dir_all(&custom_home).unwrap();
    std::fs::rename(
        fixture.root.join(".codex/models_cache.json"),
        custom_home.join("models_cache.json"),
    )
    .unwrap();
    std::fs::write(
        fixture.root.join(".codex/models_cache.json"),
        json!({"models":[{"slug":"stale-default-model","display_name":"Stale Model","context_window":8192}]}).to_string(),
    )
    .unwrap();
    let output = fixture.run_with_codex_home(
        &[
            "models",
            "sync",
            "--profile",
            "web",
            "--provider",
            "openai-codex",
            "--json",
        ],
        false,
        Some(&custom_home),
    );
    assert!(output.status.success());
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["profiles"][0]["added"], json!(["gpt-6.1-sol"]));
    assert_eq!(report["profiles"][0]["written"], true);
    let saved = std::fs::read_to_string(&fixture.patch).unwrap();
    assert!(saved.starts_with(PROFILE));
    assert!(!saved.contains("stale-default-model"));

    #[cfg(windows)]
    let non_unicode_home = {
        use std::os::windows::ffi::{OsStrExt, OsStringExt};
        let mut path: Vec<u16> = fixture
            .root
            .join("absent-codex")
            .as_os_str()
            .encode_wide()
            .collect();
        path.push(0xd800);
        PathBuf::from(std::ffi::OsString::from_wide(&path))
    };
    #[cfg(unix)]
    let non_unicode_home = {
        use std::os::unix::ffi::{OsStrExt, OsStringExt};
        let mut path = fixture
            .root
            .join("absent-codex")
            .as_os_str()
            .as_bytes()
            .to_vec();
        path.push(0xff);
        PathBuf::from(std::ffi::OsString::from_vec(path))
    };
    #[cfg(any(windows, unix))]
    for operation in ["show", "dry-run", "sync"] {
        std::fs::write(&fixture.patch, PROFILE).unwrap();
        let mut args = vec!["models"];
        if operation != "show" {
            args.extend(["sync", "--profile", "web"]);
        }
        args.extend(["--provider", "openai-codex", "--json"]);
        if operation == "dry-run" {
            args.push("--dry-run");
        }
        let output = fixture.run_with_codex_home(&args, false, Some(&non_unicode_home));
        assert!(output.status.success());
        let report: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(report["profiles"][0]["added"], json!([]), "{operation}");
        assert_eq!(report["profiles"][0]["written"], false, "{operation}");
        assert!(report["profiles"][0]["skipped"].is_string(), "{operation}");
        assert_eq!(std::fs::read_to_string(&fixture.patch).unwrap(), PROFILE);
    }
}

#[test]
fn models_refuses_uninterpreted_patch_entries_without_hiding_duplicate_plugins() {
    let cases: Value =
        serde_json::from_str(include_str!("fixtures/models-entry-shapes.json")).unwrap();
    for case in cases.as_array().unwrap() {
        for operation in ["show", "dry-run", "sync"] {
            let fixture = Fixture::new();
            let profile = case["profile"].as_str().unwrap();
            std::fs::write(&fixture.patch, profile).unwrap();
            let mut args = vec!["models"];
            if operation != "show" {
                args.push("sync");
            }
            args.extend(["--profile", "web", "--provider", "openai-codex", "--json"]);
            if operation == "dry-run" {
                args.push("--dry-run");
            }
            let output = fixture.run(&args, false);
            assert!(output.status.success());
            let report: Value = serde_json::from_slice(&output.stdout).unwrap();
            let profiles = report["profiles"].as_array().unwrap();
            assert_eq!(profiles.len(), 1, "{} {operation}", case["label"]);
            if case["refuse"] == true {
                assert!(
                    profiles[0]["skipped"]
                        .as_str()
                        .is_some_and(|reason| !reason.is_empty()),
                    "{} {operation}: {report}",
                    case["label"]
                );
                assert_eq!(profiles[0]["written"], false);
                assert_eq!(std::fs::read_to_string(&fixture.patch).unwrap(), profile);
            } else {
                assert_eq!(profiles[0]["skipped"], Value::Null);
                assert_eq!(profiles[0]["added"], json!(["gpt-6.1-sol"]));
                assert_eq!(profiles[0]["written"], operation == "sync");
                if operation != "sync" {
                    assert_eq!(std::fs::read_to_string(&fixture.patch).unwrap(), profile);
                }
            }
        }
    }
}

/// `rdsh features --json` carries the new gate with its built-in default.
#[test]
fn models_sync_feature_is_listed_and_on_by_default() {
    let fixture = Fixture::new();
    let output = fixture.run(&["features", "--json"], false);
    assert!(output.status.success());
    let document: Value = serde_json::from_slice(&output.stdout).unwrap();
    let entry = document["features"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["id"] == "models_sync")
        .expect("models_sync is missing from rdsh features --json");
    assert_eq!(entry["default"], json!(true));
    assert_eq!(entry["enabled"], json!(true));
    assert_eq!(entry["explicit"], json!(false));
}

/// The timer runs `--auto`: with the switch off it reports the skip, writes
/// nothing and still succeeds, so the daily run it belongs to is not stopped.
#[test]
fn models_sync_auto_is_a_no_op_when_the_switch_is_off() {
    let fixture = Fixture::new();
    std::fs::write(
        fixture.root.join(".dsh/rdsh.json"),
        json!({"features": {"models_sync": false}}).to_string(),
    )
    .unwrap();
    let output = fixture.run(
        &[
            "models",
            "sync",
            "--profile",
            "web",
            "--provider",
            "openai-codex",
            "--json",
            "--auto",
        ],
        false,
    );
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    // `--json` stays machine-readable, and the profile stays untouched.
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["skipped"], json!("models_sync"));
    assert_eq!(report["profiles"], json!([]));
    assert_eq!(std::fs::read_to_string(&fixture.patch).unwrap(), PROFILE);
}

/// `--auto` is not a dry run: with the switch on (the default) it writes like
/// the manual command does.
#[test]
fn models_sync_auto_writes_when_the_switch_is_on() {
    let fixture = Fixture::new();
    let output = fixture.run(
        &[
            "models",
            "sync",
            "--profile",
            "web",
            "--provider",
            "openai-codex",
            "--json",
            "--auto",
        ],
        false,
    );
    assert!(output.status.success());
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["profiles"][0]["added"], json!(["gpt-6.1-sol"]));
    assert_eq!(report["profiles"][0]["written"], json!(true));
}

/// A catalog the run cannot read must not stop the daily run; the manual
/// command still reports the same failure with a failing status.
#[test]
fn models_sync_auto_survives_a_failing_run() {
    let fixture = Fixture::new();
    let auto = fixture.run(
        &["models", "sync", "--provider", "no-such-provider", "--auto"],
        false,
    );
    assert!(
        auto.status.success(),
        "models sync --auto must not fail the daily run: {}",
        String::from_utf8_lossy(&auto.stderr)
    );
    assert!(String::from_utf8_lossy(&auto.stderr).contains("models sync --auto"));
    let manual = fixture.run(&["models", "sync", "--provider", "no-such-provider"], false);
    assert!(
        !manual.status.success(),
        "a manual run still reports the failure"
    );
    assert_eq!(std::fs::read_to_string(&fixture.patch).unwrap(), PROFILE);
}
