use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Output, Stdio};

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
fn instruction_queue_serve_processes_ordered_requests_after_errors() {
    let fixture = Fixture::new();
    let state = serde_json::json!({
        "project": {"id": "p"},
        "feedback": [],
        "answer_applications": {
            "consumers": {
                "consumer-1": {
                    "consumer_id": "consumer-1",
                    "run_id": "run-1",
                    "session_id": "session-1"
                }
            },
            "commands": {}
        }
    });
    let submit = serde_json::json!({
        "operation": "submit",
        "state": state,
        "input": {
            "command_id": "input_00000000-0000-0000-0000-000000000071",
            "consumer_id": "consumer-1",
            "run_id": "run-1",
            "session_id": "session-1",
            "text": "常駐Rustプロセスで追加",
            "mode": "next_turn",
            "expected_queue_revision": 0
        },
        "context": {"actor": "human", "now": "2026-10-15T01:00:00.000Z"}
    });
    let invalid = serde_json::json!({
        "operation": "submit",
        "state": state,
        "input": {"unknown": true},
        "context": {"actor": "human"}
    });
    let validate = serde_json::json!({
        "operation": "validate",
        "state": state
    });
    let mut child = Command::new(env!("CARGO_BIN_EXE_rdsh"))
        .args(["instruction-queue", "serve"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("HOME", fixture.root.join("home"))
        .env("USERPROFILE", fixture.root.join("home"))
        .env("APPDATA", fixture.root.join("appdata"))
        .env("XDG_DATA_HOME", fixture.root.join("data"))
        .env("XDG_CONFIG_HOME", fixture.root.join("config"))
        .env_remove("RDSH_ORIG_BIN")
        .env_remove("RDSH_PASSTHROUGH")
        .env_remove("RDSH_DRY_RUN")
        .spawn()
        .unwrap();
    {
        let stdin = child.stdin.as_mut().unwrap();
        for request in [submit, invalid, validate] {
            writeln!(stdin, "{request}").expect("serve must accept JSONL requests on stdin");
        }
    }
    drop(child.stdin.take());
    let output = child.wait_with_output().unwrap();

    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8(output.stdout).unwrap();
    let responses: Vec<serde_json::Value> = stdout
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(responses.len(), 3);
    assert_eq!(responses[0]["result"]["request"]["status"], "accepted");
    assert_eq!(responses[0]["state"].as_object().unwrap().len(), 1);
    assert!(responses[0]["state"]["instructions"]["requests"].is_object());
    assert_eq!(responses[1]["status"], 400);
    assert_eq!(responses[1]["error"], "Unknown instruction field");
    assert_eq!(responses[2]["valid"], true);
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
fn submit_creates_an_accepted_ordered_instruction() {
    let fixture = Fixture::new();
    let document = serde_json::json!({
        "operation": "submit",
        "state": {
            "project": {"id": "p"},
            "feedback": [],
            "answer_applications": {
                "consumers": {
                    "consumer-1": {
                        "consumer_id": "consumer-1",
                        "run_id": "run-1",
                        "session_id": "session-1"
                    }
                },
                "commands": {}
            }
        },
        "input": {
            "command_id": "input_00000000-0000-0000-0000-000000000002",
            "consumer_id": "consumer-1",
            "run_id": "run-1",
            "session_id": "session-1",
            "text": "日本語の指示",
            "mode": "next_turn",
            "expected_queue_revision": 0
        },
        "context": {
            "actor": "human",
            "now": "2026-10-15T01:00:00.000Z"
        }
    });
    let output = fixture.run("submit", &document.to_string());

    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let printed: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(printed["operation"], "submit");
    assert_eq!(printed["result"]["duplicate"], false);
    assert_eq!(printed["result"]["request"]["status"], "accepted");
    assert_eq!(
        printed["result"]["request"]["created_at"],
        "2026-10-15T01:00:00.000Z"
    );
    assert_eq!(printed["result"]["command"]["queue_sequence"], 1);
    assert_eq!(printed["state"]["instructions"]["revision"], 1);
    assert_eq!(printed["state"]["instructions"]["sequence"], 1);
}

#[test]
fn submit_uses_a_canonical_utc_timestamp_without_an_override() {
    let fixture = Fixture::new();
    let document = serde_json::json!({
        "operation": "submit",
        "state": {
            "project": {"id": "p"},
            "feedback": [],
            "answer_applications": {
                "consumers": {
                    "consumer-1": {
                        "consumer_id": "consumer-1",
                        "run_id": "run-1",
                        "session_id": "session-1"
                    }
                },
                "commands": {}
            }
        },
        "input": {
            "command_id": "input_00000000-0000-0000-0000-000000000032",
            "consumer_id": "consumer-1",
            "run_id": "run-1",
            "session_id": "session-1",
            "text": "現在時刻で記録",
            "mode": "next_turn",
            "expected_queue_revision": 0
        },
        "context": {"actor": "human"}
    });
    let output = fixture.run("submit", &document.to_string());

    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let printed: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    let created_at = printed["result"]["request"]["created_at"].as_str().unwrap();
    assert_eq!(created_at.len(), 24);
    assert!(created_at.ends_with('Z'));
    assert_eq!(&created_at[4..5], "-");
    assert_eq!(&created_at[10..11], "T");
}

#[test]
fn submit_retries_are_idempotent_and_changed_payloads_conflict() {
    let fixture = Fixture::new();
    let mut document = serde_json::json!({
        "operation": "submit",
        "state": {
            "project": {"id": "p"},
            "feedback": [],
            "answer_applications": {
                "consumers": {
                    "consumer-1": {
                        "consumer_id": "consumer-1",
                        "run_id": "run-1",
                        "session_id": "session-1"
                    }
                },
                "commands": {}
            }
        },
        "input": {
            "command_id": "input_00000000-0000-0000-0000-000000000003",
            "consumer_id": "consumer-1",
            "run_id": "run-1",
            "session_id": "session-1",
            "text": "再試行しても一度だけ",
            "mode": "next_turn",
            "expected_queue_revision": 0
        },
        "context": {"actor": "human", "now": "2026-10-15T01:00:00.000Z"}
    });
    let first = fixture.run("submit", &document.to_string());
    assert!(
        first.status.success(),
        "{}",
        String::from_utf8_lossy(&first.stderr)
    );
    let first: serde_json::Value = serde_json::from_slice(&first.stdout).unwrap();

    document["state"] = first["state"].clone();
    let retry = fixture.run("submit", &document.to_string());
    assert!(
        retry.status.success(),
        "{}",
        String::from_utf8_lossy(&retry.stderr)
    );
    let retry: serde_json::Value = serde_json::from_slice(&retry.stdout).unwrap();
    assert_eq!(retry["result"]["duplicate"], true);
    assert_eq!(retry["state"]["instructions"]["revision"], 1);
    assert_eq!(retry["state"]["instructions"]["sequence"], 1);

    document["input"]["text"] = serde_json::json!("違う内容");
    let conflict = fixture.run("submit", &document.to_string());
    assert_eq!(conflict.status.code(), Some(1));
    assert!(conflict.stdout.is_empty());
    assert!(String::from_utf8_lossy(&conflict.stderr)
        .contains("Command ID already holds a different instruction"));
}

#[test]
fn resolve_can_append_a_stale_request_as_the_next_turn() {
    let fixture = Fixture::new();
    let submitted = serde_json::json!({
        "operation": "submit",
        "state": {
            "project": {"id": "p"},
            "feedback": [],
            "answer_applications": {
                "consumers": {
                    "consumer-1": {
                        "consumer_id": "consumer-1",
                        "run_id": "run-1",
                        "session_id": "session-1"
                    }
                },
                "commands": {}
            }
        },
        "input": {
            "command_id": "input_00000000-0000-0000-0000-000000000004",
            "consumer_id": "consumer-1",
            "run_id": "run-1",
            "session_id": "session-1",
            "text": "確認後に追加する",
            "mode": "next_turn",
            "expected_queue_revision": 9
        },
        "context": {"actor": "human", "now": "2026-10-15T01:00:00.000Z"}
    });
    let submitted = fixture.run("submit", &submitted.to_string());
    assert!(
        submitted.status.success(),
        "{}",
        String::from_utf8_lossy(&submitted.stderr)
    );
    let submitted: serde_json::Value = serde_json::from_slice(&submitted.stdout).unwrap();
    assert_eq!(submitted["result"]["request"]["status"], "review_required");
    assert_eq!(
        submitted["result"]["request"]["review_reason"],
        "queue_revision_changed"
    );
    assert!(submitted["result"]["command"].is_null());

    let resolved = serde_json::json!({
        "operation": "resolve",
        "state": submitted["state"],
        "input": {
            "command_id": "input_00000000-0000-0000-0000-000000000004",
            "expected_queue_revision": 1,
            "decision": "append_next_turn"
        },
        "context": {"actor": "human", "now": "2026-10-15T01:01:00.000Z"}
    });
    let output = fixture.run("resolve", &resolved.to_string());
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let printed: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(printed["result"]["request"]["status"], "accepted");
    assert_eq!(printed["result"]["request"]["effective_mode"], "next_turn");
    assert_eq!(
        printed["result"]["request"]["resolution"],
        "append_next_turn"
    );
    assert_eq!(printed["result"]["command"]["queue_sequence"], 1);
    assert_eq!(printed["state"]["instructions"]["revision"], 2);
}

#[test]
fn stale_submit_state_above_256_kib_can_still_be_resolved() {
    let fixture = Fixture::new();
    let instruction_text = "x".repeat(8_000);
    let mut state = serde_json::json!({
        "project": {"id": "p"},
        "feedback": [],
        "answer_applications": {
            "consumers": {
                "consumer-1": {
                    "consumer_id": "consumer-1",
                    "run_id": "run-1",
                    "session_id": "session-1"
                }
            },
            "commands": {}
        }
    });

    for index in 0..20 {
        let command_id = format!("input_00000000-0000-0000-0000-{index:012}");
        let document = serde_json::json!({
            "operation": "submit",
            "state": state,
            "input": {
                "command_id": command_id,
                "consumer_id": "consumer-1",
                "run_id": "run-1",
                "session_id": "session-1",
                "text": instruction_text,
                "mode": "next_turn",
                "expected_queue_revision": index
            },
            "context": {"actor": "human", "now": "2026-10-15T01:00:00.000Z"}
        });
        let output = fixture.run("submit", &document.to_string());
        assert!(
            output.status.success(),
            "submit {index}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        state =
            serde_json::from_slice::<serde_json::Value>(&output.stdout).unwrap()["state"].clone();
    }
    assert!(serde_json::to_vec(&state).unwrap().len() < 256 * 1024);

    let command_id = "input_00000000-0000-0000-0000-000099999999";
    let stale = serde_json::json!({
        "operation": "submit",
        "state": state,
        "input": {
            "command_id": command_id,
            "consumer_id": "consumer-1",
            "run_id": "run-1",
            "session_id": "session-1",
            "text": "stale review",
            "mode": "next_turn",
            "expected_queue_revision": 0
        },
        "context": {"actor": "human", "now": "2026-10-15T01:01:00.000Z"}
    });
    let output = fixture.run("submit", &stale.to_string());
    assert!(
        output.status.success(),
        "stale submit: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let stale: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    let state = stale["state"].clone();
    assert!(serde_json::to_vec(&state).unwrap().len() > 256 * 1024);

    let resolve = serde_json::json!({
        "operation": "resolve",
        "state": state,
        "input": {
            "command_id": command_id,
            "expected_queue_revision": stale["state"]["instructions"]["revision"],
            "decision": "append_next_turn"
        },
        "context": {"actor": "human", "now": "2026-10-15T01:02:00.000Z"}
    });
    let output = fixture.run("resolve", &resolve.to_string());
    assert!(
        output.status.success(),
        "resolve after large stale submit: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let resolved: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(resolved["result"]["request"]["status"], "accepted");
}

#[test]
fn interrupt_review_and_control_bind_only_the_exact_active_command() {
    let fixture = Fixture::new();
    let owner = "owner_00000000-0000-0000-0000-000000000001";
    let parent_id = "input_00000000-0000-0000-0000-000000000001";
    let parent_native_id = "cmd_00000000-0000-0000-0000-000000000001";
    let command_id = "input_00000000-0000-0000-0000-000000000005";
    let state = serde_json::json!({
        "project": {"id": "p"},
        "feedback": [],
        "instructions": {
            "schema": 1,
            "revision": 0,
            "sequence": 1,
            "requests": {},
            "commands": {}
        },
        "answer_applications": {
            "consumers": {
                "consumer-1": {
                    "consumer_id": "consumer-1",
                    "run_id": "run-1",
                    "session_id": "session-1"
                }
            },
            "commands": {
                "reply_parent": {
                    "command_id": parent_id,
                    "consumer_id": "consumer-1",
                    "run_id": "run-1",
                    "session_id": "session-1",
                    "queue_sequence": 1,
                    "phase": "started",
                    "attempt_owner_id": owner,
                    "native_command_id": parent_native_id
                }
            }
        }
    });
    let submit = serde_json::json!({
        "operation": "submit",
        "state": state,
        "input": {
            "command_id": command_id,
            "consumer_id": "consumer-1",
            "run_id": "run-1",
            "session_id": "session-1",
            "text": "現在の応答を中断",
            "mode": "interrupt",
            "expected_queue_revision": 0,
            "active_command_id": parent_id
        },
        "context": {
            "actor": "management_agent",
            "available": true,
            "owner_id": owner,
            "now": "2026-10-15T01:00:00.000Z"
        }
    });
    let submitted = fixture.run("submit", &submit.to_string());
    assert!(
        submitted.status.success(),
        "{}",
        String::from_utf8_lossy(&submitted.stderr)
    );
    let submitted: serde_json::Value = serde_json::from_slice(&submitted.stdout).unwrap();
    assert_eq!(submitted["result"]["request"]["status"], "review_required");
    assert_eq!(
        submitted["result"]["request"]["review_reason"],
        "human_interrupt_confirmation_required"
    );
    assert!(submitted["result"]["request"]["control"].is_null());

    let resolve = serde_json::json!({
        "operation": "resolve",
        "state": submitted["state"],
        "input": {
            "command_id": command_id,
            "expected_queue_revision": 1,
            "decision": "approve_interrupt"
        },
        "context": {
            "actor": "human",
            "available": true,
            "owner_id": owner,
            "now": "2026-10-15T01:01:00.000Z"
        }
    });
    let resolved = fixture.run("resolve", &resolve.to_string());
    assert!(
        resolved.status.success(),
        "{}",
        String::from_utf8_lossy(&resolved.stderr)
    );
    let resolved: serde_json::Value = serde_json::from_slice(&resolved.stdout).unwrap();
    assert_eq!(resolved["result"]["request"]["status"], "accepted");
    assert_eq!(
        resolved["result"]["request"]["control"]["target_command_id"],
        parent_id
    );
    assert_eq!(
        resolved["result"]["request"]["control"]["target_native_command_id"],
        parent_native_id
    );
    assert_eq!(resolved["result"]["command"]["queue_sequence"], 2);

    let control = serde_json::json!({
        "operation": "control",
        "state": resolved["state"],
        "input": {
            "consumer_id": "consumer-1",
            "command_id": command_id,
            "phase": "begin",
            "native_command_id": "cmd_00000000-0000-0000-0000-000000000002"
        },
        "context": {
            "consumer": {"consumer_id": "consumer-1"},
            "available": true,
            "owner_id": owner,
            "now": "2026-10-15T01:02:00.000Z"
        }
    });
    let output = fixture.run("control", &control.to_string());
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let printed: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(printed["result"]["claimed"], true);
    assert_eq!(printed["result"]["control"]["phase"], "claimed");
    assert_eq!(
        printed["result"]["control"]["native_command_id"],
        "cmd_00000000-0000-0000-0000-000000000002"
    );

    let repeated_begin = serde_json::json!({
        "operation": "control",
        "state": printed["state"],
        "input": {
            "consumer_id": "consumer-1",
            "command_id": command_id,
            "phase": "begin",
            "native_command_id": "cmd_00000000-0000-0000-0000-000000000003"
        },
        "context": {
            "consumer": {"consumer_id": "consumer-1"},
            "available": true,
            "owner_id": owner,
            "now": "2026-10-15T01:02:30.000Z"
        }
    });
    let retried = fixture.run("control", &repeated_begin.to_string());
    assert!(
        retried.status.success(),
        "{}",
        String::from_utf8_lossy(&retried.stderr)
    );
    let retried: serde_json::Value = serde_json::from_slice(&retried.stdout).unwrap();
    assert_eq!(retried["result"]["claimed"], false);
    assert_eq!(
        retried["result"]["control"]["native_command_id"],
        "cmd_00000000-0000-0000-0000-000000000002"
    );

    let incomplete_proof = serde_json::json!({
        "operation": "control",
        "state": retried["state"],
        "input": {
            "consumer_id": "consumer-1",
            "command_id": command_id,
            "phase": "reconcile"
        },
        "context": {
            "consumer": {"consumer_id": "consumer-1"},
            "owner_id": owner,
            "cancel_proof": true,
            "now": "2026-10-15T01:02:45.000Z"
        }
    });
    let incomplete = fixture.run("control", &incomplete_proof.to_string());
    assert!(
        incomplete.status.success(),
        "{}",
        String::from_utf8_lossy(&incomplete.stderr)
    );
    let incomplete: serde_json::Value = serde_json::from_slice(&incomplete.stdout).unwrap();
    assert_eq!(
        incomplete["result"]["control"]["phase"],
        "notification_sent"
    );
    assert_ne!(incomplete["result"]["control"]["phase"], "confirmed");

    let unknown = serde_json::json!({
        "operation": "control",
        "state": incomplete["state"],
        "input": {
            "consumer_id": "consumer-1",
            "command_id": command_id,
            "phase": "unknown"
        },
        "context": {
            "consumer": {"consumer_id": "consumer-1"},
            "owner_id": owner,
            "now": "2026-10-15T01:02:50.000Z"
        }
    });
    let unknown = fixture.run("control", &unknown.to_string());
    assert!(
        unknown.status.success(),
        "{}",
        String::from_utf8_lossy(&unknown.stderr)
    );
    let unknown: serde_json::Value = serde_json::from_slice(&unknown.stdout).unwrap();
    assert_eq!(unknown["result"]["control"]["phase"], "unknown");
    assert_ne!(unknown["result"]["control"]["phase"], "confirmed");

    let reconcile = serde_json::json!({
        "operation": "control",
        "state": unknown["state"],
        "input": {
            "consumer_id": "consumer-1",
            "command_id": command_id,
            "phase": "reconcile"
        },
        "context": {
            "consumer": {"consumer_id": "consumer-1"},
            "owner_id": owner,
            "cancel_proof": true,
            "parent_proof": {
                "reason": "native_prompt_cancelled",
                "at": "2026-10-15T01:03:00.000Z"
            },
            "now": "2026-10-15T01:03:00.000Z"
        }
    });
    let acknowledged = fixture.run("control", &reconcile.to_string());
    assert!(
        acknowledged.status.success(),
        "{}",
        String::from_utf8_lossy(&acknowledged.stderr)
    );
    let acknowledged: serde_json::Value = serde_json::from_slice(&acknowledged.stdout).unwrap();
    assert_eq!(acknowledged["result"]["control"]["phase"], "confirmed");
    assert_eq!(
        acknowledged["result"]["control"]["reason"],
        "correlated_cancelled_prompt_result"
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
