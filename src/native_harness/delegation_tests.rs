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
            replies.push(reply("CHILD_PROOF".into(), 50, 10, 0));
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
            assert!(!body.contains("History JSON"));
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
