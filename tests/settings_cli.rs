use std::path::PathBuf;
use std::process::{Command, Output};
use std::sync::atomic::{AtomicUsize, Ordering};

static NEXT_FIXTURE: AtomicUsize = AtomicUsize::new(0);

struct Fixture(PathBuf);

impl Fixture {
    fn new(raw: &str) -> Self {
        let id = NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed);
        let path =
            std::env::temp_dir().join(format!("rdsh-settings-cli-{}-{id}", std::process::id()));
        std::fs::create_dir(&path).unwrap();
        std::fs::write(path.join("rdsh.json"), raw).unwrap();
        Self(path)
    }

    fn run(&self, args: &[&str]) -> Output {
        Command::new(env!("CARGO_BIN_EXE_rdsh"))
            .args(args)
            .env("DSH_HOME", &self.0)
            .output()
            .unwrap()
    }

    fn read(&self) -> String {
        std::fs::read_to_string(self.0.join("rdsh.json")).unwrap()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[test]
fn force_init_recovers_corrupt_settings_and_loads_defaults() {
    for raw in ["{broken", "", "null", "[]", "false", "42", "\"text\""] {
        let fixture = Fixture::new(raw);
        let output = fixture.run(&["settings", "init", "--force"]);
        assert!(output.status.success(), "{:?}", output);
        let settings: serde_json::Value = serde_json::from_str(&fixture.read()).unwrap();
        assert_eq!(settings["schema"], 1);
        assert_eq!(settings["extras"]["enable"], serde_json::json!([]));
        assert!(fixture
            .run(&["settings", "show", "--json"])
            .status
            .success());
    }
}

#[test]
fn ordinary_commands_do_not_overwrite_corrupt_settings() {
    for args in [
        vec!["settings", "init"],
        vec!["settings", "set", "search.max", "42"],
        vec!["guard"],
    ] {
        for raw in ["{broken", "", "null", "[]", "false", "42", "\"text\""] {
            let fixture = Fixture::new(raw);
            assert!(
                !fixture.run(&args).status.success(),
                "accepted {raw} for {args:?}"
            );
            assert_eq!(fixture.read(), raw);
        }
    }
}

#[test]
fn init_without_force_preserves_existing_valid_settings() {
    let raw = r#"{"guard":{"deny":["danger*"]}}"#;
    let fixture = Fixture::new(raw);
    assert_eq!(fixture.run(&["settings", "init"]).status.code(), Some(2));
    assert_eq!(fixture.read(), raw);
}

#[test]
fn discord_settings_round_trip_through_cli_and_section_reset() {
    let fixture = Fixture::new("{}");
    for (key, value) in [
        ("discord.enabled", "true"),
        ("discord.application_id", "123456789012345678"),
        ("discord.details", "dshで作業中"),
        ("discord.show_agent_status", "false"),
        ("discord.show_elapsed", "false"),
        ("discord.show_image", "false"),
        ("discord.status_display", "state"),
        ("discord.large_image", "dsh_logo"),
        ("discord.large_text", "dsh作業中"),
        ("discord.button_label", "サイトを見る"),
        ("discord.button_url", "https://example.com/dsh"),
    ] {
        assert!(fixture
            .run(&["settings", "set", key, value])
            .status
            .success());
    }
    let settings: serde_json::Value = serde_json::from_str(&fixture.read()).unwrap();
    assert_eq!(
        settings["discord"],
        serde_json::json!({
            "enabled": true, "application_id": "123456789012345678",
            "details": "dshで作業中", "show_agent_status": false, "show_elapsed": false, "show_image": false,
            "status_display": "state", "large_image": "dsh_logo", "large_text": "dsh作業中",
            "button_label": "サイトを見る", "button_url": "https://example.com/dsh",
        })
    );
    // Unrelated Rust CLI saves must preserve the new section too.
    assert!(fixture
        .run(&["settings", "set", "search.max", "42"])
        .status
        .success());
    let after: serde_json::Value = serde_json::from_str(&fixture.read()).unwrap();
    assert_eq!(after["discord"], settings["discord"]);
    assert!(!fixture
        .run(&["settings", "set", "discord.status_display", "invalid"])
        .status
        .success());
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&fixture.read()).unwrap(),
        after
    );
    assert!(fixture
        .run(&["settings", "unset", "discord"])
        .status
        .success());
    let reset: serde_json::Value = serde_json::from_str(&fixture.read()).unwrap();
    assert_eq!(reset["discord"]["enabled"], true);
    assert_eq!(reset["discord"]["details"], "dshで作業中");
    assert_eq!(reset["discord"]["show_agent_status"], true);
    assert_eq!(reset["discord"]["show_image"], true);
}

#[test]
fn discord_defaults_on_and_preserves_explicit_off() {
    for (raw, expected) in [
        ("{}", true),
        (r#"{"discord":{}}"#, true),
        (r#"{"discord":{"enabled":false}}"#, false),
    ] {
        let fixture = Fixture::new(raw);
        assert!(fixture
            .run(&["settings", "set", "search.max", "42"])
            .status
            .success());
        let settings: serde_json::Value = serde_json::from_str(&fixture.read()).unwrap();
        assert_eq!(settings["discord"]["enabled"], expected);
    }
    let fixture = Fixture::new("{}");
    std::fs::remove_file(fixture.0.join("rdsh.json")).unwrap();
    assert!(fixture.run(&["settings", "init"]).status.success());
    let settings: serde_json::Value = serde_json::from_str(&fixture.read()).unwrap();
    assert_eq!(settings["discord"]["enabled"], true);
    assert!(fixture
        .run(&["settings", "set", "discord.enabled", "false"])
        .status
        .success());
    assert!(fixture
        .run(&["settings", "unset", "discord.enabled"])
        .status
        .success());
    let reset: serde_json::Value = serde_json::from_str(&fixture.read()).unwrap();
    assert_eq!(reset["discord"]["enabled"], true);
}

#[test]
fn discord_uses_bundled_application_id_until_explicitly_overridden() {
    for raw in [
        "{}",
        r#"{"discord":{"application_id":""}}"#,
        r#"{"discord":{"application_id":"  "}}"#,
    ] {
        let fixture = Fixture::new(raw);
        assert!(fixture
            .run(&["settings", "set", "discord.enabled", "true"])
            .status
            .success());
        let settings: serde_json::Value = serde_json::from_str(&fixture.read()).unwrap();
        assert_eq!(settings["discord"]["application_id"], "1557873849280888903");
        assert!(fixture
            .run(&[
                "settings",
                "set",
                "discord.application_id",
                "123456789012345678"
            ])
            .status
            .success());
        assert!(fixture
            .run(&["settings", "unset", "discord.application_id"])
            .status
            .success());
        let reset: serde_json::Value = serde_json::from_str(&fixture.read()).unwrap();
        assert_eq!(reset["discord"]["application_id"], "1557873849280888903");
    }
}

#[test]
fn settings_set_rejects_values_that_do_not_fit_storage_types() {
    let fixture = Fixture::new("{}");

    for (key, value) in [
        ("serve.port", "70000"),
        ("setup.web_port", "65536"),
        ("bench.n", "4294967296"),
    ] {
        let before = fixture.read();
        let output = fixture.run(&["settings", "set", key, value]);
        assert!(
            !output.status.success(),
            "accepted {key}={value}: stdout={} stderr={}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(fixture.read(), before, "{key}={value} changed settings");
    }
}

#[test]
fn settings_set_preserves_valid_port_boundaries_and_random_web_port() {
    let fixture = Fixture::new("{}");

    for (key, value, section, field, expected) in [
        ("serve.port", "65535", "serve", "port", 65535),
        ("setup.web_port", "65535", "setup", "web_port", 65535),
        ("setup.web_port", "0", "setup", "web_port", 0),
        ("bench.n", "20", "bench", "n", 20),
    ] {
        let output = fixture.run(&["settings", "set", key, value]);
        assert!(
            output.status.success(),
            "rejected {key}={value}: stdout={} stderr={}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        let settings: serde_json::Value = serde_json::from_str(&fixture.read()).unwrap();
        assert_eq!(settings[section][field], serde_json::json!(expected));
    }
}
