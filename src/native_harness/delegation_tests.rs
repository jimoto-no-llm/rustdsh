use super::{
    engine::{Call, Engine, Message, State},
    profiles, sdk, tools,
};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
fn reply(text: String, input: u64, output: u64, cache: u64) -> (u16, Value) {
    (
        200,
        json!({"choices":[{"message":{"content":text}}],"usage":{"prompt_tokens":input,"completion_tokens":output,"prompt_tokens_details":{"cached_tokens":cache}}}),
    )
}
fn engine(url: &str) -> Arc<Engine> {
    let mut registry = profiles::tests::registry("openai-completions", url);
    let mut other = profiles::tests::registry("openai-completions", url)
        .routes
        .remove(0);
    other.id = "dsh:reviewer".into();
    other.models[0].id = "reviewer-model".into();
    registry.routes.push(other);
    Arc::new(Engine {
        state: Mutex::new(State {
            provider: "dsh:test".into(),
            model: "test-model".into(),
            run_id: 1,
            status: "running".into(),
            messages: vec![Message {
                role: "user".into(),
                content: "PRIVATE_PARENT_HISTORY".into(),
            }],
            ..State::default()
        }),
        workspace: std::env::temp_dir(),
        sdk: sdk::SdkConfig {
            bridge_dir: std::env::temp_dir(),
            agy_key: None,
        },
        devin: "never-run".into(),
        registry,
        secrets: vec!["synthetic-api-secret".into()],
    })
}
async fn pending(engine: &Engine) -> String {
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        loop {
            if let Some(p) = &engine.state.lock().unwrap().pending {
                return p.id.clone();
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap()
}
fn proposal() -> String {
    json!({"version":1,"text":"ask reviewer","toolCalls":[{"id":"delegate-1","name":"model_call","arguments":{"provider":"dsh:reviewer","model":"reviewer-model","prompt":"Reply with CHILD_PROOF"}}]}).to_string()
}
#[tokio::test]
async fn cross_model_calls_require_approval_and_only_send_the_displayed_prompt() {
    let _env = crate::test_support::env_lock();
    for allow in [false, true] {
        let mut replies = vec![reply(proposal(), 100, 20, 80)];
        if allow {
            replies.push(reply(
                json!({"version":1,"text":"CHILD_PROOF","toolCalls":[]}).to_string(),
                50,
                10,
                0,
            ));
        }
        replies.push(reply(
            json!({"version":1,"text":"done","toolCalls":[]}).to_string(),
            120,
            10,
            100,
        ));
        let (url, server) = profiles::tests::mock(replies);
        let engine = engine(&url);
        let task = tokio::spawn(engine.clone().run(1));
        let id = pending(&engine).await;
        assert_eq!(engine.snapshot()["usage"]["requests"], 1);
        assert_eq!(engine.snapshot()["pending"]["tool"], "model_call");
        assert!(engine.approve("wrong-id", true).is_err());
        engine.approve(&id, allow).unwrap();
        task.await.unwrap();
        let requests = server.join().unwrap();
        assert_eq!(requests.len(), if allow { 3 } else { 2 });
        if allow {
            let body = requests[1].1.to_string();
            assert!(body.contains("Reply with CHILD_PROOF"));
            assert!(!body.contains("PRIVATE_PARENT_HISTORY"));
            assert!(body.contains("History JSON"));
            assert!(body.contains("same workspace") || body.contains("Current workspace"));
            assert!(requests[1].1.get("tools").is_none());
        }
        let state = engine.snapshot();
        assert_eq!(state["status"], "idle");
        let result: Value = serde_json::from_str(
            state["messages"]
                .as_array()
                .unwrap()
                .iter()
                .find(|m| m["role"] == "tool")
                .unwrap()["content"]
                .as_str()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(result["result"]["executed"], allow);
        assert_eq!(state["usage"]["requests"], if allow { 3 } else { 2 });
        assert_eq!(
            state["usage"]["input_tokens"],
            if allow { 270 } else { 220 }
        );
        assert_eq!(state["usage"]["cache_read_tokens"], 180);
        assert_eq!(
            state["usage"]["known_cache_requests"],
            state["usage"]["requests"]
        );
    }
}
#[tokio::test]
async fn cancelled_approval_does_not_start_a_recipient_or_record_a_late_result() {
    let _env = crate::test_support::env_lock();
    let (url, server) = profiles::tests::mock(vec![reply(proposal(), 100, 20, 80)]);
    let engine = engine(&url);
    let task = tokio::spawn(engine.clone().run(1));
    let id = pending(&engine).await;
    engine.cancel();
    task.await.unwrap();
    assert!(engine.approve(&id, true).is_err());
    assert_eq!(server.join().unwrap().len(), 1);
    assert_eq!(engine.snapshot()["usage"]["requests"], 1);
    assert_eq!(engine.snapshot()["status"], "idle");
    assert!(engine.snapshot()["messages"]
        .as_array()
        .unwrap()
        .iter()
        .all(|m| m["role"] != "tool"));
}
#[test]
fn recipient_validation_is_exact_and_rejects_unknown_routes_before_execution() {
    let engine = engine("http://127.0.0.1:1/v1");
    let mut call = Call {
        id: "test".into(),
        name: "model_call".into(),
        arguments: json!({"provider":"dsh:reviewer","model":"reviewer-model","prompt":"task"}),
    };
    assert!(tools::validate_target(&engine, &call).is_ok());
    call.arguments["model"] = json!("invented-model");
    assert!(tools::validate_target(&engine, &call).is_err());
    call.arguments["extra"] = json!(true);
    assert!(tools::validate(&call).is_err());
    call.arguments =
        json!({"provider":"dsh:reviewer","model":"reviewer-model","prompt":"x".repeat(16385)});
    assert!(tools::validate(&call).is_err());
}

fn turn(text: &str, calls: Value) -> (u16, Value) {
    reply(
        json!({"version":1,"text":text,"toolCalls":calls}).to_string(),
        10,
        2,
        4,
    )
}
fn read_call(id: &str, path: &str) -> Value {
    json!({"id":id,"name":"read","arguments":{"path":path}})
}
fn write_call() -> Value {
    json!({"id":"write-proof","name":"write","arguments":{"path":"child-proof.txt","content":"CHILD_WRITE_PROOF"}})
}
async fn approve_tool(engine: &Engine, name: &str, allow: bool) {
    let id = pending(engine).await;
    assert_eq!(engine.snapshot()["pending"]["tool"], name);
    engine.approve(&id, allow).unwrap();
}

#[tokio::test]
#[cfg(unix)]
async fn delegated_model_reads_writes_and_reads_back_under_shared_permissions() {
    let _env = crate::test_support::env_lock();
    for full_access in [false, true] {
        let root = sdk::TemporaryRoot::create().unwrap();
        std::fs::write(root.0.join("source.txt"), "CHILD_SOURCE_NONCE").unwrap();
        let (url, server) = profiles::tests::mock(vec![
            reply(proposal(), 10, 2, 4),
            turn("read source", json!([read_call("source", "source.txt")])),
            turn("write artifact", json!([write_call()])),
            turn(
                "verify artifact",
                json!([read_call("verify", "child-proof.txt")]),
            ),
            turn("CHILD_DONE", json!([])),
            turn("PARENT_DONE", json!([])),
        ]);
        let mut engine = engine(&url);
        Arc::get_mut(&mut engine).unwrap().workspace = root.0.canonicalize().unwrap();
        if full_access {
            engine.state.lock().unwrap().controls.permission =
                super::controls::Permission::FullAccess;
        }
        let task = tokio::spawn(engine.clone().run(1));
        if !full_access {
            for tool in ["model_call", "read", "write", "read"] {
                approve_tool(&engine, tool, true).await;
            }
        }
        tokio::time::timeout(std::time::Duration::from_secs(10), task)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            std::fs::read_to_string(root.0.join("child-proof.txt")).unwrap(),
            "CHILD_WRITE_PROOF"
        );
        let requests = server.join().unwrap();
        assert_eq!(requests.len(), 6);
        for request in &requests[1..5] {
            assert!(!request.1.to_string().contains("PRIVATE_PARENT_HISTORY"));
        }
        assert!(requests[2].1.to_string().contains("CHILD_SOURCE_NONCE"));
        assert!(requests[4].1.to_string().contains("CHILD_WRITE_PROOF"));
        let snapshot = engine.snapshot();
        assert_eq!(snapshot["status"], "idle");
        assert_eq!(snapshot["pending"], Value::Null);
        assert_eq!(snapshot["usage"]["requests"], 6);
        assert_eq!(snapshot["usage"]["input_tokens"], 60);
        assert_eq!(snapshot["usage"]["cache_read_tokens"], 24);
        let outer: Value = serde_json::from_str(
            snapshot["messages"]
                .as_array()
                .unwrap()
                .iter()
                .find(|m| m["role"] == "tool")
                .unwrap()["content"]
                .as_str()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(outer["result"]["text"], "CHILD_DONE");
        assert_eq!(outer["result"]["completed"], true);
        assert_eq!(outer["result"]["toolCalls"].as_array().unwrap().len(), 3);
        assert!(!outer.to_string().contains("CHILD_SOURCE_NONCE"));
    }
}

#[tokio::test]
#[cfg(unix)]
async fn delegated_write_denials_and_plan_never_modify_the_workspace() {
    let _env = crate::test_support::env_lock();
    for plan in [false, true] {
        let root = sdk::TemporaryRoot::create().unwrap();
        let (url, server) = profiles::tests::mock(vec![
            reply(proposal(), 10, 2, 4),
            turn("write artifact", json!([write_call()])),
            turn("Could not write", json!([])),
            turn("PARENT_DONE", json!([])),
        ]);
        let mut engine = engine(&url);
        Arc::get_mut(&mut engine).unwrap().workspace = root.0.canonicalize().unwrap();
        if plan {
            engine.state.lock().unwrap().controls.mode = super::controls::Mode::Plan;
        }
        let task = tokio::spawn(engine.clone().run(1));
        approve_tool(&engine, "model_call", true).await;
        if !plan {
            approve_tool(&engine, "write", false).await;
        }
        tokio::time::timeout(std::time::Duration::from_secs(10), task)
            .await
            .unwrap()
            .unwrap();
        assert!(!root.0.join("child-proof.txt").exists());
        let requests = server.join().unwrap();
        assert!(requests[2].1.to_string().contains(if plan {
            "POLICY_DENIED"
        } else {
            "USER_DENIED"
        }));
        assert_eq!(engine.snapshot()["status"], "idle");
        assert_eq!(engine.snapshot()["pending"], Value::Null);
    }
}

#[tokio::test]
#[cfg(unix)]
async fn cancel_during_a_child_write_approval_prevents_the_write_and_late_result() {
    let _env = crate::test_support::env_lock();
    let root = sdk::TemporaryRoot::create().unwrap();
    let (url, server) = profiles::tests::mock(vec![
        reply(proposal(), 10, 2, 4),
        turn("write", json!([write_call()])),
    ]);
    let mut engine = engine(&url);
    Arc::get_mut(&mut engine).unwrap().workspace = root.0.canonicalize().unwrap();
    let task = tokio::spawn(engine.clone().run(1));
    approve_tool(&engine, "model_call", true).await;
    let id = pending(&engine).await;
    assert_eq!(engine.snapshot()["pending"]["tool"], "write");
    engine.cancel();
    task.await.unwrap();
    assert!(engine.approve(&id, true).is_err());
    assert!(!root.0.join("child-proof.txt").exists());
    assert_eq!(server.join().unwrap().len(), 2);
    assert_eq!(engine.snapshot()["status"], "idle");
    assert!(engine.snapshot()["messages"]
        .as_array()
        .unwrap()
        .iter()
        .all(|m| m["role"] != "tool"));
}

#[tokio::test]
#[cfg(unix)]
async fn child_timeout_cleans_its_approval_without_writing() {
    let _env = crate::test_support::env_lock();
    let root = sdk::TemporaryRoot::create().unwrap();
    let (url, server) = profiles::tests::mock(vec![turn("write", json!([write_call()]))]);
    let mut engine = engine(&url);
    Arc::get_mut(&mut engine).unwrap().workspace = root.0.canonicalize().unwrap();
    let next = engine.clone();
    let task = tokio::spawn(async move {
        super::delegation::execute_with_timeout(
            &next,
            1,
            "dsh:reviewer",
            "reviewer-model",
            "write",
            std::time::Duration::from_secs(1),
        )
        .await
    });
    let id = pending(&engine).await;
    assert_eq!(engine.snapshot()["pending"]["tool"], "write");
    let result = task.await.unwrap().unwrap();
    assert_eq!(result["error"], "MODEL_CALL_TIMEOUT");
    assert_eq!(result["completed"], false);
    assert_eq!(engine.snapshot()["status"], "running");
    assert_eq!(engine.snapshot()["pending"], Value::Null);
    assert!(engine.state.lock().unwrap().decision.is_none());
    assert!(engine.approve(&id, true).is_err());
    assert!(!root.0.join("child-proof.txt").exists());
    assert_eq!(server.join().unwrap().len(), 1);
}

#[tokio::test]
async fn dropping_an_old_permission_future_keeps_a_replacement_request() {
    let engine = engine("http://127.0.0.1:1/v1");
    let next = engine.clone();
    let task = tokio::spawn(async move {
        next.permission(
            1,
            &Call {
                id: "read".into(),
                name: "read".into(),
                arguments: json!({"path":"file.txt"}),
            },
        )
        .await
    });
    let old = pending(&engine).await;
    {
        let mut state = engine.state.lock().unwrap();
        state.pending.as_mut().unwrap().id = "replacement-id".into();
    }
    task.abort();
    let _ = task.await;
    let snapshot = engine.snapshot();
    assert_ne!(old, "replacement-id");
    assert_eq!(snapshot["pending"]["id"], "replacement-id");
    assert_eq!(snapshot["status"], "approval");
    engine.cancel();
}

#[tokio::test]
#[cfg(unix)]
async fn nested_model_call_rejects_the_entire_child_batch_before_writing() {
    let _env = crate::test_support::env_lock();
    let root = sdk::TemporaryRoot::create().unwrap();
    let nested = json!({"id":"nested","name":"model_call","arguments":{"provider":"dsh:reviewer","model":"reviewer-model","prompt":"recursive"}});
    let invalid = turn("batch", json!([write_call(), nested]));
    let (url, server) = profiles::tests::mock(vec![invalid.clone(), invalid]);
    let mut engine = engine(&url);
    Arc::get_mut(&mut engine).unwrap().workspace = root.0.canonicalize().unwrap();
    engine.state.lock().unwrap().controls.permission = super::controls::Permission::FullAccess;
    let result = super::delegation::execute(&engine, 1, "dsh:reviewer", "reviewer-model", "task")
        .await
        .unwrap();
    assert_eq!(result["error"], "MODEL_CALL_INVALID_TURN");
    assert!(!root.0.join("child-proof.txt").exists());
    assert_eq!(server.join().unwrap().len(), 2);
    assert_eq!(engine.snapshot()["pending"], Value::Null);
}
