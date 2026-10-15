use std::path::PathBuf;
use std::process::{Command, Output};

use serde_json::{json, Map, Value};
use sha2::Digest;

fn refresh_request_fingerprint(request: &mut Value) {
    let mut payload = Map::new();
    for key in [
        "command_id",
        "consumer_id",
        "run_id",
        "session_id",
        "text",
        "mode",
        "expected_queue_revision",
        "active_command_id",
        "actor",
    ] {
        payload.insert(key.into(), request.get(key).cloned().unwrap_or(Value::Null));
    }
    let serialized = serde_json::to_vec(&Value::Object(payload)).unwrap();
    let digest = sha2::Sha256::digest(serialized);
    request["fingerprint"] = json!(digest
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>());
}

struct Fixture {
    root: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let mut random = [0u8; 16];
        getrandom::fill(&mut random).unwrap();
        let suffix: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
        let root = std::env::temp_dir().join(format!("rdsh-instruction-queue-{suffix}"));
        std::fs::create_dir_all(&root).unwrap();
        Self { root }
    }

    fn run(&self, action: &str, request: &str) -> Output {
        let input = self.root.join("request.json");
        std::fs::write(&input, request).unwrap();
        Command::new(env!("CARGO_BIN_EXE_rdsh"))
            .args([
                "instruction-queue",
                action,
                "--input-file",
                input.to_str().unwrap(),
            ])
            .env("HOME", self.root.join("home"))
            .env("USERPROFILE", self.root.join("home"))
            .env("APPDATA", self.root.join("appdata"))
            .env("XDG_DATA_HOME", self.root.join("data"))
            .env("XDG_CONFIG_HOME", self.root.join("config"))
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

#[test]
fn validate_accepts_a_state_without_an_instruction_registry() {
    let fixture = Fixture::new();
    let output = fixture.run(
        "validate",
        r#"{"operation":"validate","state":{"project":{"id":"p"},"feedback":[]}}"#,
    );

    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        output.stdout,
        b"{\"operation\":\"validate\",\"valid\":true}\n"
    );
}

#[test]
fn validate_accepts_a_snapshot_created_by_the_javascript_module() {
    let fixture = Fixture::new();
    let output = fixture.run(
        "validate",
        include_str!("fixtures/instruction_queue_valid.json"),
    );

    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        output.stdout,
        b"{\"operation\":\"validate\",\"valid\":true}\n"
    );
}

#[test]
fn validate_rejects_an_accepted_request_without_explicit_null_control() {
    let fixture = Fixture::new();
    let mut document: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/instruction_queue_valid.json")).unwrap();
    document["state"]["instructions"]["requests"]["input_00000000-0000-0000-0000-000000000001"]
        .as_object_mut()
        .unwrap()
        .remove("control");
    let output = fixture.run("validate", &document.to_string());

    assert_eq!(output.status.code(), Some(1));
    assert!(output.stdout.is_empty());
    assert!(String::from_utf8_lossy(&output.stderr).contains("Missing exact interrupt binding"));
}

#[test]
fn validate_keeps_javascript_integer_number_semantics_for_decimal_json() {
    let fixture = Fixture::new();
    let request = include_str!("fixtures/instruction_queue_valid.json").replace(":1,", ":1.0,");
    let output = fixture.run("validate", &request);

    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        output.stdout,
        b"{\"operation\":\"validate\",\"valid\":true}\n"
    );
}

#[test]
fn validate_rejects_ordered_commands_without_the_registry() {
    let fixture = Fixture::new();
    let output = fixture.run(
        "validate",
        r#"{"operation":"validate","state":{"project":{"id":"p"},"feedback":[],"answer_applications":{"commands":{"reply":{"queue_sequence":1}}}}}"#,
    );

    assert_eq!(output.status.code(), Some(1));
    assert!(output.stdout.is_empty());
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("Missing ordered instruction registry")
    );
}

#[test]
fn validate_rejects_unknown_registry_fields() {
    let fixture = Fixture::new();
    let output = fixture.run(
        "validate",
        r#"{"operation":"validate","state":{"project":{"id":"p"},"feedback":[],"instructions":{"schema":1,"revision":0,"sequence":0,"requests":{},"commands":{},"unexpected":true}}}"#,
    );

    assert_eq!(output.status.code(), Some(1));
    assert!(output.stdout.is_empty());
    assert!(String::from_utf8_lossy(&output.stderr).contains("Unknown instruction field"));
}

#[test]
fn validate_falls_back_only_for_missing_or_null_queue_sequences() {
    let fixture = Fixture::new();
    for invalid in [json!(1.5), json!(false), json!("bad")] {
        let mut document: Value =
            serde_json::from_str(include_str!("fixtures/instruction_queue_valid.json")).unwrap();
        document["state"]["instructions"]["sequence"] = json!(2);
        document["state"]["answer_applications"]["commands"]["legacy"] = json!({
            "queue_sequence": invalid,
            "feedback_sequence": 2,
        });
        let output = fixture.run("validate", &document.to_string());

        assert_eq!(output.status.code(), Some(1), "queue_sequence={invalid}");
        assert!(output.stdout.is_empty(), "queue_sequence={invalid}");
        assert!(
            String::from_utf8_lossy(&output.stderr).contains("Corrupt or duplicate input order"),
            "queue_sequence={invalid}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    for missing_value in [None, Some(Value::Null)] {
        let mut document: Value =
            serde_json::from_str(include_str!("fixtures/instruction_queue_valid.json")).unwrap();
        document["state"]["instructions"]["sequence"] = json!(2);
        let mut command = json!({ "feedback_sequence": 2 });
        if let Some(value) = missing_value {
            command["queue_sequence"] = value;
        }
        document["state"]["answer_applications"]["commands"]["legacy"] = command;
        let output = fixture.run("validate", &document.to_string());

        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
}

#[test]
fn validate_rejects_null_consumers_even_when_request_ids_are_null() {
    let fixture = Fixture::new();
    let mut document: Value =
        serde_json::from_str(include_str!("fixtures/instruction_queue_valid.json")).unwrap();
    let request = &mut document["state"]["instructions"]["requests"]
        ["input_00000000-0000-0000-0000-000000000001"];
    request["status"] = json!("review_required");
    request["effective_mode"] = Value::Null;
    request["review_reason"] = json!("queue_revision_changed");
    request["control"] = Value::Null;
    request["run_id"] = Value::Null;
    request["session_id"] = Value::Null;
    refresh_request_fingerprint(request);
    document["state"]["answer_applications"]["consumers"]["consumer-1"] = Value::Null;
    document["state"]["instructions"]["commands"]
        .as_object_mut()
        .unwrap()
        .remove("input_00000000-0000-0000-0000-000000000001");

    let output = fixture.run("validate", &document.to_string());

    assert_eq!(output.status.code(), Some(1));
    assert!(output.stdout.is_empty());
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("Invalid instruction snapshot"),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn validate_accepts_large_valid_instruction_histories() {
    let fixture = Fixture::new();
    let mut document: Value =
        serde_json::from_str(include_str!("fixtures/instruction_queue_valid.json")).unwrap();
    let template = document["state"]["instructions"]["requests"]
        ["input_00000000-0000-0000-0000-000000000001"]
        .clone();
    for index in 0..40 {
        let id = format!("input_00000000-0000-0000-0000-00000000{:04x}", index + 2);
        let mut request = template.clone();
        request["command_id"] = json!(id);
        request["text"] = json!("x".repeat(8_000));
        request["status"] = json!("review_required");
        request["effective_mode"] = Value::Null;
        request["timing_reason"] = Value::Null;
        request["review_reason"] = json!("queue_revision_changed");
        request["comparison"] = json!([]);
        request["resolution"] = Value::Null;
        request["resolved_at"] = Value::Null;
        request["control"] = Value::Null;
        refresh_request_fingerprint(&mut request);
        document["state"]["instructions"]["requests"][id] = request;
    }
    let serialized = document.to_string();
    assert!(serialized.len() > 256 * 1024);

    let output = fixture.run("validate", &serialized);

    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn context_returns_only_the_exact_consumers_ordered_inputs() {
    let fixture = Fixture::new();
    let output = fixture.run(
        "context",
        r#"{"operation":"context","state":{"project":{"id":"p"},"feedback":[],"answer_applications":{"consumers":{"consumer-1":{"consumer_id":"consumer-1","run_id":"run-1","session_id":"session-1"}},"commands":{}}},"input":{"consumer_id":"consumer-1"}}"#,
    );

    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        output.stdout.as_slice(),
        concat!(
            "{\"operation\":\"context\",\"context\":{\"consumer\":{\"consumer_id\":\"consumer-1\",\"run_id\":\"run-1\",\"session_id\":\"session-1\"},",
            "\"queue_revision\":0,\"steer\":{\"supported\":false,\"fallback\":\"next_turn\",\"reason\":\"dsh_acp_no_verified_steer\"},",
            "\"inputs\":[],\"active_command_id\":null}}\n"
        )
        .as_bytes()
    );
}

#[test]
fn context_projects_the_latest_input_from_a_javascript_snapshot() {
    let fixture = Fixture::new();
    let mut document: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/instruction_queue_valid.json")).unwrap();
    document["operation"] = serde_json::json!("context");
    document["input"] = serde_json::json!({"consumer_id":"consumer-1"});
    let output = fixture.run("context", &document.to_string());

    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let printed: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(printed["context"]["queue_revision"], 1);
    assert_eq!(
        printed["context"]["inputs"][0]["command_id"],
        "input_00000000-0000-0000-0000-000000000001"
    );
    assert_eq!(printed["context"]["inputs"][0]["sequence"], 1);
    assert_eq!(printed["context"]["inputs"][0]["phase"], "saved");
    assert_eq!(printed["context"]["inputs"][0]["text"], "確認してください");
}

#[test]
fn validate_rejects_a_tampered_request_fingerprint() {
    let fixture = Fixture::new();
    let mut document: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/instruction_queue_valid.json")).unwrap();
    document["state"]["instructions"]["requests"]["input_00000000-0000-0000-0000-000000000001"]
        ["text"] = serde_json::json!("改ざん");
    let output = fixture.run("validate", &document.to_string());

    assert_eq!(output.status.code(), Some(1));
    assert!(output.stdout.is_empty());
    assert!(String::from_utf8_lossy(&output.stderr)
        .contains("Instruction payload fingerprint is corrupt"));
}

#[test]
fn context_rejects_an_unknown_exact_recipient() {
    let fixture = Fixture::new();
    let output = fixture.run(
        "context",
        r#"{"operation":"context","state":{"project":{"id":"p"},"feedback":[],"answer_applications":{"consumers":{},"commands":{}}},"input":{"consumer_id":"missing"}}"#,
    );

    assert_eq!(output.status.code(), Some(1));
    assert!(output.stdout.is_empty());
    assert!(String::from_utf8_lossy(&output.stderr).contains("Unknown exact run/session recipient"));
}

#[test]
fn context_rejects_a_null_exact_recipient() {
    let fixture = Fixture::new();
    let output = fixture.run(
        "context",
        r#"{"operation":"context","state":{"project":{"id":"p"},"feedback":[],"answer_applications":{"consumers":{"consumer-1":null},"commands":{}}},"input":{"consumer_id":"consumer-1"}}"#,
    );

    assert_eq!(output.status.code(), Some(1));
    assert!(output.stdout.is_empty());
    assert!(String::from_utf8_lossy(&output.stderr).contains("Unknown exact run/session recipient"));
}

#[test]
fn action_and_document_operation_must_match() {
    let fixture = Fixture::new();
    let output = fixture.run(
        "validate",
        r#"{"operation":"context","state":{"project":{"id":"p"},"feedback":[]}}"#,
    );

    assert_eq!(output.status.code(), Some(1));
    assert!(output.stdout.is_empty());
    assert!(String::from_utf8_lossy(&output.stderr)
        .contains("Input JSON operation does not match the requested action"));
}
