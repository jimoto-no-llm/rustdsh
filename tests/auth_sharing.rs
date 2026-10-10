//! Run the real CLI with isolated credential stores. Fixture secrets are
//! intentionally recognizable so stdout/stderr can be checked for disclosure.
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

const CODEX_ACCESS: &str = "fixture-codex-access-must-not-print";
const CODEX_REFRESH: &str = "fixture-codex-refresh-must-not-print";
const CODEX_KEY: &str = "fixture-codex-api-key-must-not-print";
const OPENCODE_ACCESS: &str = "fixture-opencode-access-must-not-print";
const OPENCODE_REFRESH: &str = "fixture-opencode-refresh-must-not-print";
const ACCOUNT: &str = "fixture-account-id-must-not-print";
const ENV_OPENAI: &str = "fixture-env-openai-must-not-print";
const ENV_DEEPSEEK: &str = "fixture-env-deepseek-must-not-print";
const EXISTING: &str = "# preserve CRLF and manual entries\r\nversion: 1\r\nrecords:\r\n  llm-pi-ai/anthropic:\r\n    kind: grant\r\n    payload:\r\n      access: fixture-existing-anthropic\r\n      refresh: fixture-existing-refresh\r\n      expires: 9000000000000\r\n      type: oauth\r\nrefs:\r\n  MANUAL_KEY: fixture-existing-manual";

#[test]
fn one_time_provider_import_does_not_persist_consent_or_copy_other_secrets() {
    let fixture = Fixture::new();
    fixture.seed();
    fixture.json(&["auth", "--select", "opencode:anthropic", "--json"]);
    let policy = fixture.read("dsh/rdsh-auth-sharing.json");
    let preview = fixture.json(&[
        "--dry-run",
        "auth",
        "--import",
        "--source",
        "codex",
        "--provider",
        "openai-codex",
        "--json",
    ]);
    assert_eq!(preview["dry_run"], true);
    assert_eq!(preview["sharing"]["one_time_import"], true);
    assert!(!fixture.root.join("dsh/.credentials.yaml").exists());
    let imported = fixture.json(&[
        "auth",
        "--import",
        "--source",
        "codex",
        "--provider",
        "openai-codex",
        "--json",
    ]);
    let credentials = fixture.read("dsh/.credentials.yaml");
    assert!(credentials.contains(CODEX_ACCESS));
    assert!(!credentials.contains(CODEX_KEY));
    assert!(!credentials.contains(OPENCODE_ACCESS));
    assert!(!credentials.contains("fixture-other-provider"));
    assert_eq!(fixture.read("dsh/rdsh-auth-sharing.json"), policy);
    assert_eq!(
        imported["sharing"]["selected"],
        serde_json::json!(["opencode:anthropic"])
    );
    assert!(!fixture
        .run(&[
            "auth",
            "--import",
            "--source",
            "unknown",
            "--provider",
            "openai-codex"
        ])
        .status
        .success());
    assert!(!fixture
        .run(&[
            "auth",
            "--import",
            "--provider",
            "openai-codex",
            "--select",
            "codex:openai-codex"
        ])
        .status
        .success());
    assert_eq!(fixture.read("dsh/rdsh-auth-sharing.json"), policy);
}

#[test]
fn one_time_key_reference_does_not_enable_automatic_copying() {
    let fixture = Fixture::new();
    fixture.seed();
    let imported = fixture.json(&[
        "auth",
        "--import",
        "--source",
        "codex",
        "--ref",
        "OPENAI_API_KEY",
        "--json",
    ]);
    let credentials = fixture.read("dsh/.credentials.yaml");
    assert!(credentials.contains(CODEX_KEY));
    assert!(!credentials.contains(CODEX_ACCESS));
    assert!(!fixture.root.join("dsh/rdsh-auth-sharing.json").exists());
    assert_eq!(imported["sharing"]["selected"], serde_json::json!([]));
    assert_eq!(imported["sharing"]["autosync_enabled"], false);
}

#[test]
fn one_time_key_reference_rejects_unlisted_names_without_writing() {
    let fixture = Fixture::new();
    fixture.seed();
    let output = fixture.run(&[
        "auth",
        "--import",
        "--source",
        "codex",
        "--ref",
        "UNKNOWN_SECRET_REF",
        "--json",
    ]);
    assert!(!output.status.success());
    let text = public_output(&output);
    assert!(text.contains("no credential sharing selected"));
    for secret in [
        CODEX_ACCESS,
        CODEX_REFRESH,
        CODEX_KEY,
        OPENCODE_ACCESS,
        OPENCODE_REFRESH,
    ] {
        assert!(!text.contains(secret));
    }
    assert!(!fixture.root.join("dsh/.credentials.yaml").exists());
    assert!(!fixture.root.join("dsh/rdsh-auth-sharing.json").exists());
}

struct Fixture {
    root: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let mut random = [0u8; 16];
        getrandom::fill(&mut random).unwrap();
        let suffix: String = random.iter().map(|b| format!("{b:02x}")).collect();
        let root = std::env::temp_dir().join(format!("rdsh-sharing-fixture-{suffix}"));
        std::fs::create_dir(&root).unwrap();
        for dir in ["home/.codex", "data/opencode", "config", "dsh"] {
            std::fs::create_dir_all(root.join(dir)).unwrap();
        }
        Self { root }
    }

    fn seed(&self) {
        self.write("home/.codex/auth.json", &serde_json::json!({
            "OPENAI_API_KEY": CODEX_KEY,
            "tokens": {"access_token": CODEX_ACCESS, "refresh_token": CODEX_REFRESH, "account_id": ACCOUNT}
        }).to_string());
        self.write("data/opencode/auth.json", &serde_json::json!({
            "openai": {"type": "oauth", "access": OPENCODE_ACCESS, "refresh": OPENCODE_REFRESH, "expires": 8000000000000i64, "accountId": ACCOUNT},
            "anthropic": {"type": "oauth", "access": "fixture-other-provider", "refresh": "fixture-other-refresh", "expires": 9500000000000i64},
            "invalid fixture-provider-must-not-print": {"access": "ignored", "refresh": "ignored"}
        }).to_string());
    }

    fn write(&self, path: &str, value: &str) {
        std::fs::write(self.root.join(path), value).unwrap();
    }

    fn read(&self, path: &str) -> String {
        std::fs::read_to_string(self.root.join(path)).unwrap()
    }

    fn command_for(&self, executable: &Path) -> Command {
        let mut cmd = Command::new(executable);
        cmd.env("HOME", self.root.join("home"))
            .env("USERPROFILE", self.root.join("home"))
            .env("APPDATA", self.root.join("data"))
            .env("XDG_DATA_HOME", self.root.join("data"))
            .env("XDG_CONFIG_HOME", self.root.join("config"))
            .env("DSH_HOME", self.root.join("dsh"))
            .env("DSH_ORIG_BIN", self.root.join("stub-dsh"))
            .env_remove("RDSH_ORIG_BIN")
            .env_remove("RDSH_PASSTHROUGH")
            .env_remove("RDSH_DRY_RUN")
            .env_remove("RDSH_AUTH_AUTOSYNC")
            .env_remove("DEEPSEEK_API_KEY")
            .env_remove("OPENAI_API_KEY")
            .env_remove("ANTHROPIC_API_KEY");
        cmd
    }

    fn command(&self) -> Command {
        self.command_for(Path::new(env!("CARGO_BIN_EXE_rdsh")))
    }

    fn run(&self, args: &[&str]) -> Output {
        self.command().args(args).output().unwrap()
    }

    fn json(&self, args: &[&str]) -> serde_json::Value {
        let output = self.run(args);
        assert!(output.status.success(), "{}", public_output(&output));
        serde_json::from_slice(&output.stdout).unwrap()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        // Only recursively remove the unique directory allocated by this fixture.
        assert_eq!(self.root.parent(), Some(std::env::temp_dir().as_path()));
        assert!(self
            .root
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("rdsh-sharing-fixture-"));
        std::fs::remove_dir_all(&self.root).unwrap();
    }
}

fn public_output(output: &Output) -> String {
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    for secret in [
        CODEX_ACCESS,
        CODEX_REFRESH,
        CODEX_KEY,
        OPENCODE_ACCESS,
        OPENCODE_REFRESH,
        ACCOUNT,
        ENV_OPENAI,
        ENV_DEEPSEEK,
        "fixture-other-provider",
        "fixture-other-refresh",
        "fixture-existing-anthropic",
        "fixture-existing-refresh",
        "fixture-existing-manual",
        "invalid fixture-provider-must-not-print",
    ] {
        assert!(
            !text.contains(secret),
            "credential appeared in CLI diagnostics"
        );
    }
    text
}

#[test]
fn missing_policy_is_read_only_and_import_requires_selection() {
    let fixture = Fixture::new();
    fixture.seed();
    let output = fixture.run(&["auth", "--json"]);
    public_output(&output);
    let status: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(status["sharing"]["selected"], serde_json::json!([]));
    assert_eq!(status["sharing"]["autosync_enabled"], false);
    assert!(status["sharing"]["inventory"]
        .as_array()
        .unwrap()
        .iter()
        .all(|i| i["selected"] == false));
    assert!(!fixture.root.join("dsh/.credentials.yaml").exists());
    assert!(!fixture.root.join("dsh/rdsh-auth-sharing.json").exists());
    let refused = fixture.run(&["auth", "--import"]);
    assert!(!refused.status.success());
    assert!(public_output(&refused).contains("no credential sharing selected"));
    let setup = fixture.json(&["setup", "--json"]);
    assert_eq!(
        setup["needed"], true,
        "external logins are not DSH credentials until copied"
    );
    assert!(!fixture.root.join("dsh/.credentials.yaml").exists());
}

#[test]
fn source_selection_beats_a_newer_unselected_source_and_preserves_other_bytes() {
    let fixture = Fixture::new();
    fixture.seed();
    fixture.write("dsh/.credentials.yaml", EXISTING);
    let output = fixture.run(&[
        "auth",
        "--select",
        "codex:openai-codex",
        "--import",
        "--json",
    ]);
    assert!(output.status.success(), "{}", public_output(&output));
    public_output(&output);
    let stored = fixture.read("dsh/.credentials.yaml");
    assert!(stored.contains(CODEX_ACCESS));
    assert!(!stored.contains(OPENCODE_ACCESS));
    assert!(!stored.contains(CODEX_KEY));
    assert!(stored.starts_with("# preserve CRLF and manual entries\r\nversion: 1\r\n"));
    assert!(stored.contains(
        &EXISTING
            [EXISTING.find("  llm-pi-ai/anthropic:").unwrap()..EXISTING.find("refs:").unwrap()]
    ));
    assert!(stored.ends_with("refs:\r\n  MANUAL_KEY: fixture-existing-manual"));
    let status = fixture.json(&["auth", "--json"]);
    assert_eq!(
        status["sharing"]["selected"],
        serde_json::json!(["codex:openai-codex"])
    );
}

#[test]
fn dry_run_previews_destination_and_scope_without_saving_consent_or_secrets() {
    let fixture = Fixture::new();
    fixture.seed();
    let output = fixture.run(&[
        "--dry-run",
        "auth",
        "--select",
        "opencode:openai-codex",
        "--import",
        "--json",
    ]);
    assert!(output.status.success(), "{}", public_output(&output));
    public_output(&output);
    let status: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(status["dry_run"], true);
    assert_eq!(status["wrote"], serde_json::json!([]));
    assert_eq!(
        status["sharing"]["selected"],
        serde_json::json!(["opencode:openai-codex"])
    );
    assert!(status["sharing"]["scope"]
        .as_str()
        .unwrap()
        .contains("every DSH profile"));
    assert!(status["sharing"]["remove_copy"]
        .as_str()
        .unwrap()
        .contains("retains existing"));
    assert!(!fixture.root.join("dsh/.credentials.yaml").exists());
    assert!(!fixture.root.join("dsh/rdsh-auth-sharing.json").exists());
    assert!(!fixture.root.join("dsh/.rdsh-auth-sharing.lock").exists());
}

#[test]
fn unselect_retains_copies_and_prevents_automatic_reimport_after_copy_removal() {
    let fixture = Fixture::new();
    fixture.seed();
    fixture.json(&[
        "auth",
        "--select",
        "opencode:openai-codex",
        "--import",
        "--json",
    ]);
    let copy = fixture.read("dsh/.credentials.yaml");
    fixture.json(&["auth", "--unselect", "opencode:openai-codex", "--json"]);
    assert_eq!(copy, fixture.read("dsh/.credentials.yaml"));
    fixture.write("dsh/.credentials.yaml", "version: 1\n");
    let output = fixture
        .command()
        .env("RDSH_AUTH_AUTOSYNC", "1")
        .args(["setup", "--json"])
        .output()
        .unwrap();
    assert!(output.status.success(), "{}", public_output(&output));
    public_output(&output);
    assert_eq!(fixture.read("dsh/.credentials.yaml"), "version: 1\n");
    assert_eq!(
        fixture.json(&["auth", "--json"])["sharing"]["selected"],
        serde_json::json!([])
    );
}

#[test]
fn environment_references_are_transient_and_persistence_requires_each_selection() {
    let fixture = Fixture::new();
    let env_command = || {
        let mut cmd = fixture.command();
        cmd.env("OPENAI_API_KEY", ENV_OPENAI)
            .env("DEEPSEEK_API_KEY", ENV_DEEPSEEK);
        cmd
    };
    let output = env_command()
        .args(["setup", "--yes", "--json"])
        .output()
        .unwrap();
    assert!(output.status.success(), "{}", public_output(&output));
    public_output(&output);
    let status: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(status["needed"], false);
    let references = status["sharing"]["environment_references"]
        .as_array()
        .unwrap();
    assert_eq!(references.len(), 2);
    assert!(references
        .iter()
        .all(|r| r["persistent"] == false && r["writes"] == serde_json::json!([])));
    assert!(!fixture.root.join("dsh/.credentials.yaml").exists());
    let output = env_command()
        .args([
            "auth",
            "--select",
            "env:OPENAI_API_KEY",
            "--import",
            "--json",
        ])
        .output()
        .unwrap();
    assert!(output.status.success(), "{}", public_output(&output));
    public_output(&output);
    let stored = fixture.read("dsh/.credentials.yaml");
    assert!(stored.contains(ENV_OPENAI));
    assert!(!stored.contains(ENV_DEEPSEEK));
    assert!(!stored.contains("DEEPSEEK_API_KEY"));
}

#[test]
fn invalid_policy_fails_closed_without_exposing_its_content() {
    let fixture = Fixture::new();
    fixture.seed();
    for invalid in [
        r#"{"version":2,"selected":["codex:openai-codex"]}"#,
        r#"{"version":1,"selected":["codex:*"]}"#,
        r#"{"version":1,"selected":["codex:openai-codex"],"secret":"fixture-invalid-policy-secret"}"#,
        r#"fixture-invalid-policy-secret"#,
    ] {
        fixture.write("dsh/rdsh-auth-sharing.json", invalid);
        let output = fixture.run(&["auth", "--import", "--json"]);
        assert!(!output.status.success());
        assert!(!public_output(&output).contains("fixture-invalid-policy-secret"));
        let output = fixture.run(&["setup", "--json"]);
        assert!(output.status.success());
        assert!(!public_output(&output).contains("fixture-invalid-policy-secret"));
        let status: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(status["sharing"]["autosync_enabled"], false);
        assert!(status["sharing"]["policy_error"].is_string());
        assert!(!fixture.root.join("dsh/.credentials.yaml").exists());
        assert_eq!(fixture.read("dsh/rdsh-auth-sharing.json"), invalid);
    }
}

#[test]
fn invalid_selector_and_selected_credential_errors_are_secret_free() {
    let fixture = Fixture::new();
    let output = fixture.run(&[
        "auth",
        "--select",
        "fixture-invalid-selector-secret",
        "--import",
    ]);
    assert!(!output.status.success());
    assert!(!public_output(&output).contains("fixture-invalid-selector-secret"));
    fixture.write("home/.codex/auth.json", r#"{"tokens":{"access_token":"fixture-bad-credential-secret\ninjected","refresh_token":"valid"}} "#);
    let output = fixture.run(&["auth", "--select", "codex:openai-codex", "--import"]);
    assert!(!output.status.success());
    assert!(!public_output(&output).contains("fixture-bad-credential-secret"));
    assert!(!fixture.root.join("dsh/.credentials.yaml").exists());
}

#[test]
fn locked_consent_cannot_be_changed_and_autosync_cannot_write() {
    let fixture = Fixture::new();
    fixture.seed();
    fixture.json(&["auth", "--select", "codex:openai-codex", "--json"]);
    let policy = fixture.read("dsh/rdsh-auth-sharing.json");
    fixture.write("dsh/.rdsh-auth-sharing.lock", "fixture-writer");
    let output = fixture.run(&["auth", "--unselect", "codex:openai-codex", "--json"]);
    assert!(!output.status.success());
    assert!(public_output(&output).contains("locked"));
    let output = fixture.run(&["setup", "--json"]);
    assert!(output.status.success());
    public_output(&output);
    assert!(!fixture.root.join("dsh/.credentials.yaml").exists());
    assert_eq!(fixture.read("dsh/rdsh-auth-sharing.json"), policy);
}

#[test]
fn unreadable_or_ambiguous_credentials_are_never_replaced() {
    let fixture = Fixture::new();
    fixture.seed();
    for text in [
        "version: 1\nrecords: {}\n",
        "version: 1\nrecords:\n  llm-pi-ai/anthropic: {kind: grant}\n",
        "version: 1\nrefs:\n  MANUAL_KEY: first\n  MANUAL_KEY: second\n",
        "version: 1\nrecords:\nrecords:\n",
    ] {
        fixture.write("dsh/.credentials.yaml", text);
        let output = fixture.run(&[
            "auth",
            "--select",
            "codex:openai-codex",
            "--import",
            "--json",
        ]);
        assert!(!output.status.success());
        public_output(&output);
        assert_eq!(fixture.read("dsh/.credentials.yaml"), text);
    }
    std::fs::write(fixture.root.join("dsh/.credentials.yaml"), [0xff, 0xfe]).unwrap();
    let output = fixture.run(&["auth", "--import", "--json"]);
    assert!(!output.status.success());
    public_output(&output);
    assert_eq!(
        std::fs::read(fixture.root.join("dsh/.credentials.yaml")).unwrap(),
        [0xff, 0xfe]
    );
}

#[test]
fn setup_dry_run_does_not_import_an_existing_selection() {
    let fixture = Fixture::new();
    fixture.seed();
    fixture.json(&["auth", "--select", "codex:openai-codex", "--json"]);
    let output = fixture.run(&["--dry-run", "setup", "--yes", "--json"]);
    assert!(output.status.success());
    public_output(&output);
    assert!(!fixture.root.join("dsh/.credentials.yaml").exists());
}

#[cfg(unix)]
#[test]
fn delegation_enforcement_precedes_copying_and_metadata_obeys_consent() {
    use std::os::unix::fs::PermissionsExt;
    let fixture = Fixture::new();
    fixture.seed();
    fixture.write("stub-dsh", "#!/bin/sh\nexit 0\n");
    std::fs::set_permissions(
        fixture.root.join("stub-dsh"),
        std::fs::Permissions::from_mode(0o700),
    )
    .unwrap();
    let proxy = fixture.root.join("dsh-proxy");
    std::fs::create_dir(&proxy).unwrap();
    let proxy = proxy.join("dsh");
    std::fs::copy(env!("CARGO_BIN_EXE_rdsh"), &proxy).unwrap();
    let args: &[&[&str]] = &[
        &["boot", "--profile", "tui"],
        &["dump-config", "--profile", "tui"],
        &["plugin", "--profile", "tui", "add", "fixture"],
    ];
    for selected in [false, true] {
        if selected {
            fixture.json(&["auth", "--select", "codex:openai-codex", "--json"]);
        }
        for args in args.iter().copied() {
            fixture.write("dsh/.credentials.yaml", "version: 1\n");
            let output = fixture.run(args);
            assert!(!output.status.success(), "{}", public_output(&output));
            assert!(public_output(&output).contains("RDSH_SECURITY"));
            let stored = fixture.read("dsh/.credentials.yaml");
            assert!(!stored.contains(CODEX_ACCESS));
            assert!(!stored.contains(OPENCODE_ACCESS));
        }
        fixture.write("dsh/.credentials.yaml", "version: 1\n");
        let output = fixture
            .command_for(&proxy)
            .args(["--profile", "tui"])
            .output()
            .unwrap();
        assert!(!output.status.success(), "{}", public_output(&output));
        assert!(public_output(&output).contains("RDSH_SECURITY"));
        assert_eq!(fixture.read("dsh/.credentials.yaml"), "version: 1\n");
        // The trusted metadata path executes the stub without starting an agent.
        let output = fixture
            .command_for(&proxy)
            .args(["--version"])
            .output()
            .unwrap();
        assert!(output.status.success(), "{}", public_output(&output));
        public_output(&output);
        assert_eq!(
            fixture.read("dsh/.credentials.yaml").contains(CODEX_ACCESS),
            selected
        );
    }
    fixture.write("dsh/.credentials.yaml", "version: 1\n");
    let output = fixture
        .command()
        .env("RDSH_AUTH_AUTOSYNC", "0")
        .args(["setup", "--json"])
        .output()
        .unwrap();
    assert!(output.status.success());
    public_output(&output);
    assert_eq!(fixture.read("dsh/.credentials.yaml"), "version: 1\n");
    // Disabling automatic sync does not disable an explicitly requested import.
    let output = fixture
        .command()
        .env("RDSH_AUTH_AUTOSYNC", "0")
        .args(["auth", "--import", "--json"])
        .output()
        .unwrap();
    assert!(output.status.success());
    assert!(fixture.read("dsh/.credentials.yaml").contains(CODEX_ACCESS));
    for path in ["dsh/.credentials.yaml", "dsh/rdsh-auth-sharing.json"] {
        assert_eq!(
            std::fs::metadata(fixture.root.join(path))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
}
