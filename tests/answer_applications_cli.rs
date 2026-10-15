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
            .args(["--language", "en"])
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

#[test]
fn record_requires_a_valid_reply_command_id() {
    let fixture = Fixture::new();
    let request = format!(
        r#"{{"operation":"record","state":{{"project":{{"id":"prj_0123456789abcdef"}},"feedback":[]}},"input":{{"command_id":"bad","message":{{"question_id":"Q1"}}}},"now":"{NOW}"}}"#
    );
    let output = fixture.run("apply", &request);
    assert_eq!(output.status.code(), Some(1));
    assert!(output.stdout.is_empty());
    assert!(String::from_utf8_lossy(&output.stderr).contains("Input JSON is invalid"));
}

#[test]
fn record_requires_an_object_message_with_question_id() {
    let fixture = Fixture::new();
    let valid_id = "reply_01234567-89ab-cdef-0123-456789abcdef";
    for message in ["null", "[]", "{}"] {
        let request = format!(
            r#"{{"operation":"record","state":{{"project":{{"id":"prj_0123456789abcdef"}},"feedback":[]}},"input":{{"command_id":"{valid_id}","message":{message}}},"now":"{NOW}"}}"#
        );
        let output = fixture.run("apply", &request);
        assert_eq!(output.status.code(), Some(1), "message={message}");
        assert!(output.stdout.is_empty(), "message={message}");
        assert!(
            String::from_utf8_lossy(&output.stderr).contains("Input JSON is invalid"),
            "message={message}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
}

#[test]
fn record_outputs_only_the_answer_application_registry() {
    let fixture = Fixture::new();
    let valid_id = "reply_01234567-89ab-cdef-0123-456789abcdef";
    let request = format!(
        r#"{{"operation":"record","state":{{"project":{{"id":"prj_0123456789abcdef"}},"feedback":[]}},"input":{{"command_id":"{valid_id}","message":{{"question_id":"Q1"}}}},"now":"{NOW}"}}"#
    );
    let output = fixture.run("apply", &request);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let printed: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(printed["answer_applications"], serde_json::Value::Null);
    assert!(printed["answer_applications"].get("project").is_none());
}

#[test]
fn record_returns_updated_instruction_queue_revision_and_sequence() {
    let fixture = Fixture::new();
    let valid_id = "reply_01234567-89ab-cdef-0123-456789abcdef";
    let consumer_id = "consumer_83ca3f922609863760d5de5eb2f7bc77";
    let run_id = "run_01234567-89ab-cdef-0123-456789abcdef";
    let session_id = "session-fixture";
    let request = serde_json::json!({
        "operation": "record",
        "state": {
            "project": { "id": "fixture" },
            "revision": 1,
            "feedback": [],
            "answer_applications": {
                "schema": 1,
                "consumers": {
                    "consumer_83ca3f922609863760d5de5eb2f7bc77": {
                        "consumer_id": consumer_id,
                        "project_id": "fixture",
                        "run_id": run_id,
                        "session_id": session_id,
                        "task_id": null,
                        "created_at": "2026-10-15T02:20:09.985Z"
                    }
                },
                "commands": {}
            },
            "question_contracts": {
                "cards": {
                    "Q1": {
                        "snapshot": {
                            "decision": {
                                "consumer_id": consumer_id,
                                "target": {
                                    "run_id": run_id,
                                    "session_id": session_id,
                                    "task_id": null
                                }
                            }
                        }
                    }
                }
            },
            "instructions": {
                "schema": 1,
                "revision": 4,
                "sequence": 4,
                "requests": {},
                "commands": {}
            }
        },
        "input": {
            "command_id": valid_id,
            "message": { "question_id": "Q1", "sequence": 4 }
        },
        "now": NOW
    })
    .to_string();
    let output = fixture.run("apply", &request);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let printed: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(printed["instructions"]["sequence"], 5);
    assert_eq!(printed["instructions"]["revision"], 5);
    assert_eq!(
        printed["answer_applications"]["commands"][valid_id]["queue_sequence"],
        5
    );
}

#[test]
fn ack_claims_instruction_when_control_is_null() {
    let fixture = Fixture::new();
    let request = include_str!("fixtures/instruction-ack-null-control.json");
    let output = fixture.run("apply", request);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let printed: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(printed["result"]["claimed"], true);
    assert_eq!(printed["result"]["command"]["phase"], "started");
}
