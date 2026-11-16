use serde_json::{json, Value};
use std::{fs, process::Command};

#[test]
fn compaction_report_is_read_only_metadata_and_reconstructs_lifecycles() {
    let mut random = [0u8; 16];
    getrandom::fill(&mut random).unwrap();
    let root = std::env::temp_dir().join(format!("rdsh-compaction-report-{:?}", random));
    fs::create_dir(&root).unwrap();
    let path = root.join("events.jsonl");
    let records = [
        json!({"type":"compaction/start","data":{"compactionId":"one"}}),
        json!({"type":"compaction/summary","data":{"compactionId":"one","summary":[{"type":"text","text":"PRIVATE_SUMMARY"}],"rawOutput":"PRIVATE_RAW","shadowedSeqs":[1,2,3],"shadowedTokenCount":1000,"usage":{"inputTokens":500,"outputTokens":50,"cacheReadTokens":400,"secret":"PRIVATE_USAGE"}}}),
        json!({"type":"compaction/end","data":{"compactionId":"one"}}),
        json!({"type":"compaction/start","data":{"compactionId":"incomplete"}}),
        json!({"type":"compaction/prune","data":{"body":"PRIVATE_PRUNED"}}),
        json!({"type":"assistant/message","data":{"message":{"content":[{"type":"text","text":"PRIVATE_REPLY"}],"source":{"kind":"model","provider":"native","model":"m","replayState":{"response":{"kind":"rdsh-llm-native","version":1,"window":{"items":[{"type":"compaction","id":"cmp_1","encrypted_content":"PRIVATE_OPAQUE_HANDLE"}],"covered":13,"anchor":"msg-1"}}}}}}}),
        json!({"type":"assistant/message","data":{"message":{"content":[],"source":{"kind":"model","provider":"native","model":"m","replayState":{"response":{"kind":"rdsh-llm-native","version":1,"window":{"items":[{"type":"compaction","id":"cmp_1","encrypted_content":"PRIVATE_OPAQUE_HANDLE"}],"covered":13,"anchor":"msg-1"}}}}}}}),
        json!({"type":"assistant/message","data":{"message":{"content":[],"source":{"kind":"model","provider":"other","model":"m","replayState":{"response":{"kind":"pi-ai","version":2}}}}}}),
        json!({"type":"assistant/message","data":{"message":{"content":[],"source":{"kind":"model","provider":"claude","model":"m","replayState":{"response":{"kind":"rdsh-llm-native","version":1,"window":{"items":[{"role":"assistant","content":[{"type":"compaction","content":"PRIVATE_READABLE_SUMMARY","signature":"PRIVATE_SIGNATURE"}]}],"covered":4}}}}}}}),
    ];
    let text = records
        .iter()
        .map(Value::to_string)
        .collect::<Vec<_>>()
        .join("\n");
    fs::write(&path, &text).unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_rdsh"))
        .args(["compaction", "report"])
        .arg(&path)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8(output.stdout).unwrap();
    assert!(!stdout.contains("PRIVATE_"));
    let report: Value = serde_json::from_str(&stdout).unwrap();
    assert_eq!(report["count"], 2);
    assert_eq!(report["prune_events"], 1);
    let one = report["compactions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["id"] == "one")
        .unwrap();
    assert_eq!(one["completed"], true);
    assert_eq!(one["replaced_messages"], 3);
    assert_eq!(one["usage"]["inputTokens"], 500);
    assert_eq!(one["summary_sha256"].as_str().unwrap().len(), 64);
    // A provider-side result is reported by hash and counts only.
    let windows = report["provider_windows"].as_array().unwrap();
    assert_eq!(windows.len(), 2);
    let window = |replaced: u64| {
        windows
            .iter()
            .find(|row| row["replaced_messages"] == replaced)
            .unwrap()
    };
    assert_eq!(window(13)["sha256"].as_str().unwrap().len(), 64);
    assert_eq!(window(13)["items"], 1);
    assert_eq!(window(13)["opaque_bytes"], 21);
    assert_eq!(window(13)["carried_by"], 2);
    // An Anthropic block is hashed by its signature; the readable summary stays out.
    assert_eq!(window(4)["opaque_bytes"], 17);
    assert_ne!(window(4)["sha256"], window(13)["sha256"]);
    assert_ne!(
        window(4)["sha256"],
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
    assert_eq!(fs::read_to_string(&path).unwrap(), text);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn compaction_capabilities_explicitly_exclude_provider_transport() {
    let output = Command::new(env!("CARGO_BIN_EXE_rdsh"))
        .args(["compaction", "capabilities"])
        .output()
        .unwrap();
    assert!(output.status.success());
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(result["default_method"], "dsh_summary");
    let unsupported = result["unsupported"].as_array().unwrap();
    for name in ["openai_in_stream", "model_tool"] {
        assert!(unsupported.contains(&json!(name)), "{name}");
    }
    // Each provider-native method is tied to its adapter and says how far it was verified.
    for name in [
        "openai_standalone",
        "xai_standalone",
        "anthropic_on_demand",
        "anthropic_threshold",
    ] {
        assert!(!unsupported.contains(&json!(name)), "{name}");
        assert_eq!(
            result["adapter_methods"][name]["verified_against"], "local emulator only",
            "{name}"
        );
    }
    assert_eq!(
        result["adapter_methods"]["openai_standalone"]["plugin"],
        "rdsh-llm-native"
    );
    assert_eq!(
        result["adapter_methods"]["openai_standalone"]["verified_against"],
        "local emulator only"
    );
}
