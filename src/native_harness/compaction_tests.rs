use super::*;
use crate::native_harness::{engine::State, profiles, sdk};
use std::sync::{Arc, Mutex};

fn message(role: &str, content: &str) -> Message {
    Message {
        role: role.into(),
        content: content.into(),
    }
}
fn history() -> Vec<Message> {
    vec![
        message("user", "original goal"),
        message("assistant", &"old text with useful facts. ".repeat(600)),
        message("user", "continue"),
        message("assistant", "recent reply"),
        message("user", "current request"),
    ]
}
fn engine(messages: Vec<Message>, registry: profiles::Registry) -> Arc<Engine> {
    let mut options = Options::default();
    options.native_web.trigger_bytes = 5000;
    options.native_web.retain_bytes = 300;
    Arc::new(Engine {
        compaction: options,
        state: Mutex::new(State {
            provider: "dsh:test".into(),
            model: "test-model".into(),
            run_id: 1,
            status: "running".into(),
            messages,
            ..State::default()
        }),
        workspace: std::env::temp_dir(),
        devin: "never-run".into(),
        sdk: sdk::SdkConfig {
            bridge_dir: "never-run".into(),
            agy_key: None,
        },
        registry,
        secrets: vec!["SYNTHETIC_SECRET".into()],
    })
}

#[tokio::test]
async fn below_threshold_leaves_exact_prompt_and_history_unchanged() {
    let e = engine(
        vec![message("user", "hello")],
        profiles::Registry::default(),
    );
    let before = e.snapshot();
    e.compact_history(1).await.unwrap();
    assert_eq!(e.snapshot(), before);
}

#[tokio::test]
async fn prunes_only_tool_payloads_without_a_model_call() {
    let original = vec![message("user", "goal"),
        message("assistant_tool_proposals", r#"[{"id":"read1","name":"read","arguments":{"path":"a.txt"}}]"#),
        message("tool", &json!({"toolCallId":"read1","name":"read","result":{"content":"many lines\n".repeat(2000),"executed":true}}).to_string()),
        message("user", "continue"), message("assistant", "recent"), message("user", "now")];
    let mut e = engine(original, profiles::Registry::default());
    Arc::get_mut(&mut e)
        .unwrap()
        .compaction
        .native_web
        .tool_result_tokens = 100;
    e.compact_history(1).await.unwrap();
    let s = e.state.lock().unwrap();
    assert_eq!(s.messages.len(), 6);
    let tool: Value = serde_json::from_str(&s.messages[2].content).unwrap();
    assert_eq!(tool["toolCallId"], "read1");
    assert_eq!(tool["result"]["executed"], true);
    assert!(tool["result"]["content"].as_str().unwrap().len() < 2000);
    assert_eq!(
        s.events.iter().filter(|e| e.name == "compaction").count(),
        1
    );
}

#[tokio::test]
async fn summary_uses_selected_route_redacts_and_removes_old_ui_history() {
    let (url, server) = profiles::tests::mock(vec![(
        200,
        json!({"choices":[{"message":{"content":"kept facts SYNTHETIC_SECRET"}}]}),
    )]);
    let e = engine(
        history(),
        profiles::tests::registry("openai-completions", &url),
    );
    e.state.lock().unwrap().events.push(Event {
        kind: "tool".into(),
        name: "read".into(),
        content: "old payload".into(),
    });
    e.compact_history(1).await.unwrap();
    let requests = server.join().unwrap();
    assert_eq!(requests.len(), 1);
    let request = &requests[0].1;
    assert_eq!(request["model"], "test-model");
    assert!(request["messages"][0]["content"]
        .as_str()
        .unwrap()
        .contains("compaction engine"));
    let s = e.state.lock().unwrap();
    assert_eq!(s.messages[0].content, "original goal");
    assert_eq!(s.messages[1].content, "kept facts [REDACTED]");
    assert_eq!(s.messages.last().unwrap().content, "current request");
    assert!(!e
        .redact(&serde_json::to_string(&s.messages).unwrap())
        .contains("old text"));
    assert_eq!(s.events.len(), 1);
    assert!(!s.events[0].content.contains("kept facts"));
}

#[tokio::test]
async fn failures_empty_and_larger_summaries_roll_back_every_change() {
    for (code, text) in [
        (500, "bad".to_owned()),
        (200, "".into()),
        (200, "larger".repeat(5000)),
    ] {
        let (url, server) = profiles::tests::mock(vec![(
            code,
            json!({"choices":[{"message":{"content":text}}]}),
        )]);
        let e = engine(
            history(),
            profiles::tests::registry("openai-completions", &url),
        );
        let before = e.snapshot();
        e.compact_history(1).await.unwrap();
        server.join().unwrap();
        assert_eq!(e.snapshot(), before);
    }
}

#[tokio::test]
async fn cancellation_during_summary_cannot_commit() {
    let (url, server) = profiles::tests::mock(vec![(
        200,
        json!({"choices":[{"message":{"content":"summary"}}]}),
    )]);
    let e = engine(
        history(),
        profiles::tests::registry("openai-completions", &url),
    );
    let original = e.state.lock().unwrap().messages.clone();
    // Poll through the first await, then invalidate the generation while the HTTP
    // future is in flight. No sleeps or timing-dependent process cancellation.
    let future = e.compact_history(1);
    tokio::pin!(future);
    assert!(futures_util::poll!(&mut future).is_pending());
    e.cancel();
    assert!(future.await.is_err());
    server.join().unwrap();
    assert_eq!(e.state.lock().unwrap().messages, original);
    assert!(e
        .state
        .lock()
        .unwrap()
        .events
        .iter()
        .all(|event| event.name != "compaction"));
}

#[test]
fn cuts_keep_complete_tool_groups_and_exact_denials() {
    let mut messages = history();
    messages.splice(2..2, [
        message("assistant_tool_proposals", r#"[{"id":"denied1","name":"read","arguments":{"path":"private.txt"}}]"#),
        message("tool", r#"{"toolCallId":"denied1","name":"read","result":{"error":"USER_DENIED","executed":false}}"#),
    ]);
    let e = engine(messages.clone(), profiles::Registry::default());
    let limits = Limits::resolve(&e.compaction, None).unwrap();
    let range = cut(&messages, &limits).unwrap();
    assert!(range.contains(&2) && range.contains(&3));
    let record = denied(&messages[range]);
    assert!(record.contains("USER_DENIED") && record.contains("private.txt"));
    assert_eq!(
        denied(&[message("summary", &format!("summary{record}"))]),
        record
    );
    // An unresolved proposal is never summarized.
    messages.remove(3);
    assert!(cut(&messages, &limits).unwrap().end <= 2);
}

#[test]
fn known_capacity_clamps_tokens_unknown_capacity_uses_bytes_only() {
    let options = Options::default();
    let limits = Limits::resolve(&options, Some((100_000, 30_000))).unwrap();
    assert_eq!(limits.tokens.unwrap().trigger, 70_000);
    assert_eq!(limits.tokens.unwrap().retain, 16_000);
    assert!(Limits::resolve(&options, None).unwrap().tokens.is_none());
}
