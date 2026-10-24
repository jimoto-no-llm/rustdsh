//! Exercise type rejection and recovery through the resident NDJSON process.
use serde_json::{json, Value};
use std::io::Write;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};

static NEXT: AtomicUsize = AtomicUsize::new(0);

fn resident(requests: &[Value]) -> Vec<Value> {
    let root = std::env::temp_dir().join(format!(
        "rdsh-compute-validation-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::create_dir(&root).unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_rdsh"))
        .args(["compute"])
        .env_clear()
        .env("HOME", &root)
        .env("DSH_HOME", root.join("dsh"))
        .env("XDG_CONFIG_HOME", root.join("config"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    for request in requests {
        writeln!(stdin, "{request}").unwrap();
    }
    drop(stdin);
    let output = child.wait_with_output().unwrap();
    std::fs::remove_dir_all(root).unwrap();
    assert!(output.status.success(), "{output:?}");
    assert!(output.stderr.is_empty(), "{output:?}");
    let responses: Vec<Value> = String::from_utf8(output.stdout)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(responses.len(), requests.len());
    for (request, response) in requests.iter().zip(&responses) {
        assert_eq!(response["id"], request["id"]);
    }
    responses
}

#[test]
fn wrong_types_fail_and_the_next_request_still_succeeds() {
    let mut requests = Vec::new();
    let mut expected = Vec::new();
    for op in ["tokens.estimate", "tokens.prune"] {
        for text in [json!(null), json!(42), json!(true), json!([]), json!({})] {
            requests
                .push(json!({"v":1,"id":format!("text-{}", requests.len()),"op":op,"text":text}));
            expected.push("bad_text");
        }
    }
    for budget in [
        json!(null),
        json!("100"),
        json!(true),
        json!([]),
        json!({}),
        json!(-1),
        json!(1.5),
        json!(0),
        json!(200001),
        json!(u64::MAX),
    ] {
        requests.push(json!({"v":1,"id":format!("budget-{}", requests.len()),"op":"tokens.prune","text":"hello","max_tokens":budget}));
        expected.push("bad_budget");
    }
    requests.push(json!({"v":1,"id":"recovered","op":"tokens.estimate","text":"日本語abc"}));
    let responses = resident(&requests);
    for (response, code) in responses.iter().zip(expected) {
        assert_eq!(response["ok"], false, "{response}");
        assert_eq!(response["code"], code);
        assert!(response.get("tokens").is_none());
        assert!(response.get("pruned").is_none());
    }
    let last = responses.last().unwrap();
    assert_eq!(last["ok"], true);
    assert_eq!(last["chars"], 6);
}

#[test]
fn omitted_fields_empty_text_and_budget_boundaries_keep_their_contract() {
    let responses = resident(&[
        json!({"v":1,"id":"empty","op":"tokens.estimate","text":""}),
        json!({"v":1,"id":"omitted-text","op":"tokens.estimate"}),
        json!({"v":1,"id":"default","op":"tokens.prune"}),
        json!({"v":1,"id":"minimum","op":"tokens.prune","text":"hello world","max_tokens":1}),
        json!({"v":1,"id":"maximum","op":"tokens.prune","text":"hello world","max_tokens":200000}),
        json!({"v":1,"id":"batch","op":"tokens.estimate_batch","texts":["", "日本語", "abc"]}),
    ]);
    for response in &responses {
        assert_eq!(response["ok"], true, "{response}");
    }
    assert_eq!(responses[0]["tokens"], 0);
    assert_eq!(responses[1]["tokens"], 0);
    assert_eq!(responses[2]["budget"], 4000);
    assert_eq!(responses[2]["pruned"], "");
    assert_eq!(responses[3]["budget"], 1);
    assert!(responses[3]["after"].as_u64().unwrap() <= 1);
    assert_eq!(responses[4]["budget"], 200000);
    assert_eq!(responses[4]["pruned"], "hello world");
    assert_eq!(responses[5]["chars"], json!([0, 3, 3]));
}
