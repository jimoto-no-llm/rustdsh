//! The native answer-application CLI preserves the JSON contract used by the
//! dashboard while keeping every state transition deterministic and offline.
use std::process::{Command, Output};

const NOW: &str = "2026-10-15T00:00:00.000Z";

struct Fixture {
    root: std::path::PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let mut random = [0u8; 16];
        getrandom::fill(&mut random).unwrap();
        let suffix: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
        let root = std::env::temp_dir().join(format!("rdsh-answer-applications-{suffix}"));
        std::fs::create_dir_all(root.join("dsh")).unwrap();
        Self { root }
    }

    fn run(&self, action: &str, request: &str) -> Output {
        let input = self.root.join("request.json");
        std::fs::write(&input, request).unwrap();
        Command::new(env!("CARGO_BIN_EXE_rdsh"))
            .args([
                "answer-applications",
                action,
                "--input-file",
                input.to_str().unwrap(),
            ])
            .env("HOME", self.root.join("home"))
            .env("USERPROFILE", self.root.join("home"))
            .env("APPDATA", self.root.join("appdata"))
            .env("XDG_DATA_HOME", self.root.join("data"))
            .env("XDG_CONFIG_HOME", self.root.join("config"))
            .env("DSH_HOME", self.root.join("dsh"))
            .env_remove("RDSH_ORIG_BIN")
            .env_remove("RDSH_PASSTHROUGH")
            .env_remove("RDSH_DRY_RUN")
            .output()
            .unwrap()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn empty_state() -> String {
    format!(
        r#"{{"state":{{"project":{{}},"feedback":[]}},"input":{{}},"now":"{NOW}","live_jobs":{{}}}}"#
    )
}

#[test]
fn public_and_schema_preserve_the_js_json_shape() {
    let fixture = Fixture::new();
    let base = empty_state();
    let public = base.replacen("{\"state\"", "{\"operation\":\"public\",\"state\"", 1);
    let output = fixture.run("public", &public);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        output.stdout,
        b"{\"operation\":\"public\",\"answer_applications\":null}\n"
    );

    let output = fixture.run("schema", &public);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        output.stdout,
        b"{\"operation\":\"public\",\"answer_applications\":null}\n"
    );
}

#[test]
fn validate_is_deterministic_and_rejects_corrupt_registry_state() {
    let fixture = Fixture::new();
    let base = empty_state();
    let valid = base.replacen("{\"state\"", "{\"operation\":\"validate\",\"state\"", 1);
    let output = fixture.run("validate", &valid);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        output.stdout,
        b"{\"operation\":\"validate\",\"valid\":true}\n"
    );

    let corrupt = valid.replace(
        "\"feedback\":[]",
        "\"feedback\":[],\"answer_applications\":{\"schema\":1,\"consumers\":{},\"commands\":{},\"extra\":true}",
    );
    let output = fixture.run("validate", &corrupt);
    assert_eq!(output.status.code(), Some(1));
    assert!(output.stdout.is_empty());
    assert!(String::from_utf8_lossy(&output.stderr).contains("Unknown answer application field"));
}

#[test]
fn action_and_document_must_match() {
    let fixture = Fixture::new();
    let request = empty_state().replacen("{\"state\"", "{\"operation\":\"public\",\"state\"", 1);
    let output = fixture.run("validate", &request);
    assert_eq!(output.status.code(), Some(1));
    assert!(output.stdout.is_empty());
    assert!(String::from_utf8_lossy(&output.stderr)
        .contains("Input JSON operation does not match the requested action"));
}
