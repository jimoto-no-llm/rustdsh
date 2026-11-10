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
    assert!(result["unsupported"]
        .as_array()
        .unwrap()
        .contains(&json!("provider_native")));
}
