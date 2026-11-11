use super::*;
use std::path::Path;

fn view() -> View {
    let mut v = View::new(
        Path::new("/workspace"),
        "web",
        json!({"default":{"provider":"demo","model":"small"},"groups":[{"id":"demo","models":[{"id":"small"}]}]}),
    );
    v.set_session("owned");
    v.client_id = "client".into();
    v.connected();
    v
}
fn event(seq: u64, kind: &str, data: Value) -> Value {
    json!({"type":"event","event":{"type":kind,"seq":seq,"data":data,"surfaceOp":"append"}})
}
fn opening(records: Vec<Value>, projections: Value) -> Value {
    json!({"type":"snapshot","header":{"id":"owned"},"cursor":records.last().map(|r|r["event"]["seq"].clone()).unwrap_or(json!(0)),"records":records,"hasMore":false,"projections":{"asOfSeq":99,"values":projections}})
}
fn approval(id: &str, agent: &str, call: &str) -> Value {
    json!({"type":"waterfall","event":"approval/request","eventId":id,"agentId":agent,"request":{"toolName":"read","callId":call,"reason":"Read marker"}})
}

#[test]
fn startup_auth_url_is_loopback_only_and_never_accepts_extra_parameters() {
    assert!(startup_url("dsh web: http://127.0.0.1:54321/?token=opaque").is_some());
    for raw in [
        "http://evil.test:54321/?token=x",
        "http://localhost:54321/?token=x",
        "https://127.0.0.1:54321/?token=x",
        "http://127.0.0.1:54321/?token=x&token=y",
        "http://127.0.0.1:54321/?token=x&redirect=evil",
        "http://user@127.0.0.1:54321/?token=x",
        "http://127.0.0.1:54321/api?token=x",
        "http://127.0.0.1:54321/?token=x#fragment",
        "http://127.0.0.1:54321/?token=",
    ] {
        assert!(validate_launch(&Url::parse(raw).unwrap()).is_err(), "{raw}");
    }
    assert!(startup_url("warning: dsh web: http://127.0.0.1:54321/?token=x").is_none());
}
#[test]
fn connection_secrets_and_secret_fields_are_recursively_redacted() {
    let mut value = json!({"messages":[{"content":"prefix PRIVATE-LAUNCH-TOKEN suffix"}],"nested":{"apiKey":"key","token":"token","accessToken":"access","password":"pass","cookie":"cookie"},"ordinary":"visible"});
    redact_value(&mut value, &["PRIVATE-LAUNCH-TOKEN".into()]);
    assert!(!value.to_string().contains("PRIVATE-LAUNCH-TOKEN"));
    assert_eq!(value["messages"][0]["content"], "prefix [REDACTED] suffix");
    for v in value["nested"].as_object().unwrap().values() {
        assert_eq!(v, "[REDACTED]");
    }
    assert_eq!(value["ordinary"], "visible");
}
#[test]
fn approvals_are_scoped_queued_and_never_implicitly_accepted() {
    let mut v = view();
    assert!(!v.waterfall(&approval("foreign", "other-session", "c")));
    assert!(v.snapshot()["pending"].is_null());
    assert!(v.waterfall(&approval("one", "owned", "c")));
    assert_eq!(v.snapshot()["pending"]["detailsUnavailable"], true);
    assert!(v.waterfall(&approval("one", "owned", "c"))); // replay is idempotent
    assert!(v.waterfall(&approval("two", "owned", "d")));
    assert!(v.pending_event("two").is_none()); // a hidden dialog cannot be answered
    v.cancel_event("one");
    assert_eq!(v.snapshot()["pending"]["id"], "two");
    v.cancel_event("two");
    assert!(v.snapshot()["pending"].is_null());
}
#[test]
fn tool_arguments_must_arrive_and_parse_before_allowing_approval() {
    let mut v = view();
    v.apply_follow(&opening(vec![], json!({})));
    v.waterfall(&approval("one", "owned", "c"));
    v.apply_follow(&event(
        1,
        "tool/call",
        json!({"callId":"c","name":"read","arguments":"{\"path\":\"marker.txt\"}"}),
    ));
    let p = v.snapshot()["pending"].clone();
    assert_eq!(p["detailsUnavailable"], false);
    assert_eq!(p["arguments"]["path"], "marker.txt");
    v.apply_follow(&event(
        2,
        "tool/call",
        json!({"callId":"c","name":"read","arguments":"{invalid"}),
    ));
    assert_eq!(v.snapshot()["pending"]["detailsUnavailable"], true);
}
#[test]
fn repeated_journal_frames_do_not_duplicate_messages_or_usage() {
    let mut v = view();
    v.apply_follow(&opening(vec![], json!({})));
    let message = event(
        1,
        "assistant/message",
        json!({"message":{"content":[{"type":"text","text":"done"}]},"usage":{"inputTokens":20,"cacheReadTokens":60,"cacheWriteTokens":20,"outputTokens":10}}),
    );
    v.apply_follow(&message);
    v.apply_follow(&message);
    let s = v.snapshot();
    assert_eq!(s["messages"].as_array().unwrap().len(), 1);
    assert_eq!(s["usage"]["input_tokens"], 100);
    assert_eq!(s["usage"]["output_tokens"], 10);
    assert_eq!(s["usage"]["requests"], 1);
    assert_eq!(s["usage"]["cache_hit_rate"], 60.0);
    let p = json!({"type":"projection","sessionId":"owned","key":"tokenUsage","seq":5,"value":{"uncachedInputTokens":20,"cacheReadTokens":60,"cacheWriteTokens":20,"outputTokens":10}});
    v.apply_control(&p);
    v.apply_control(&p);
    assert_eq!(v.snapshot()["usage"]["input_tokens"], 100);
    assert_eq!(v.snapshot()["usage"]["requests"], 1);
}
#[test]
fn missing_usage_and_cache_buckets_remain_unknown() {
    let mut v = view();
    v.apply_follow(&opening(vec![event(1,"assistant/message",json!({"message":{"content":[{"type":"text","text":"answer"}]},"usage":{"inputTokens":20,"outputTokens":10}}))],json!({"tokenUsage":{"uncachedInputTokens":20,"cacheReadTokens":0,"cacheWriteTokens":0,"outputTokens":10}})));
    assert_eq!(v.snapshot()["usage"]["known_input_requests"], 0);
    assert_eq!(v.snapshot()["usage"]["known_output_requests"], 1);
    assert!(v.snapshot()["usage"]["cache_hit_rate"].is_null());
    assert_eq!(v.snapshot()["usage"]["known_cache_requests"], 0);
}
#[test]
fn streamed_text_is_replaced_by_the_committed_message() {
    let mut v = view();
    v.apply_follow(&opening(vec![], json!({})));
    v.apply_follow(
        &json!({"type":"assistant-stream","frame":{"type":"start","attemptId":"a","revision":1}}),
    );
    let chunk = json!({"type":"assistant-stream","frame":{"type":"chunk","attemptId":"a","revision":2,"index":0,"chunk":{"type":"text-delta","text":"hello"}}});
    v.apply_follow(&chunk);
    v.apply_follow(&chunk);
    assert_eq!(v.snapshot()["messages"][0]["content"], "hello");
    assert_eq!(v.snapshot()["usage"]["requests"], 0);
    v.apply_follow(&event(
        1,
        "assistant/message",
        json!({"message":{"content":[{"type":"text","text":"hello"}]}}),
    ));
    assert_eq!(v.snapshot()["messages"].as_array().unwrap().len(), 1);
    assert_eq!(v.snapshot()["messages"][0]["content"], "hello");
}
#[test]
fn question_projection_restores_continued_replies_without_default_answers() {
    let mut v = view();
    v.apply_follow(&opening(vec![],json!({"userQuestions":{"active":[{"callId":"question","state":"continued","questions":[{"id":"q","question":"Which?","options":[{"label":"yes"},{"label":"no"}]}]}],"settled":[]}})));
    let p = v.snapshot()["pending"].clone();
    assert_eq!(p["kind"], "questions");
    assert_eq!(p["continued"], true);
    assert_eq!(p["callId"], "question");
    assert!(p["answers"].is_null());
    let raw = v.pending_event("continued:question").unwrap();
    assert_eq!(raw["callId"], "question");
    v.apply_control(&json!({"type":"projection","sessionId":"owned","key":"userQuestions","seq":100,"value":{"active":[],"settled":[{"callId":"question","answers":[]}]}}));
    assert!(v.snapshot()["pending"].is_null());
}
#[test]
fn reconnect_discards_stale_pending_and_reloads_one_snapshot() {
    let mut v = view();
    v.apply_follow(&opening(
        vec![event(
            1,
            "user/message",
            json!({"content":[{"type":"text","text":"hello"}]}),
        )],
        json!({}),
    ));
    v.waterfall(&approval("one", "owned", "c"));
    v.disconnected();
    assert!(v.snapshot()["pending"].is_null());
    assert_eq!(v.snapshot()["connected"], false);
    v.connected();
    v.apply_follow(&opening(
        vec![event(
            1,
            "user/message",
            json!({"content":[{"type":"text","text":"hello"}]}),
        )],
        json!({}),
    ));
    assert_eq!(v.snapshot()["messages"].as_array().unwrap().len(), 1);
    assert_eq!(v.snapshot()["status"], "idle");
}
#[test]
fn paging_prepends_in_sequence_without_replacing_newer_usage() {
    let mut v = view();
    let mut opening = opening(
        vec![event(
            10,
            "assistant/message",
            json!({"message":{"content":[{"type":"text","text":"new"}]}}),
        )],
        json!({}),
    );
    opening["hasMore"] = json!(true);
    v.apply_follow(&opening);
    v.prepend_records(&json!([event(
        2,
        "user/message",
        json!({"content":[{"type":"text","text":"old"}]})
    )]));
    assert_eq!(v.snapshot()["messages"][0]["content"], "old");
    assert_eq!(v.snapshot()["messages"][1]["content"], "new");
    assert_eq!(v.snapshot()["usage"]["request_count_unknown"], true);
    v.history_complete();
    assert_eq!(v.snapshot()["usage"]["request_count_unknown"], false);
}
#[test]
fn new_session_starts_loading_and_does_not_keep_old_pending_or_usage() {
    let mut v = view();
    v.waterfall(&approval("one", "owned", "c"));
    v.set_session("other");
    let s = v.snapshot();
    assert_eq!(s["status"], "loading");
    assert!(s["pending"].is_null());
    assert_eq!(s["usage"]["requests"], 0);
    assert_eq!(s["sessionId"], "other");
}

#[test]
fn only_catalog_verified_descendants_can_ask_for_tool_approval() {
    let mut v = view();
    v.apply_follow(&opening(
        vec![],
        json!({"subagentCatalog":[{"id":"child","mode":"one-shot","createdAt":1}]}),
    ));
    v.apply_control(&json!({"type":"baseline","value":{"projections":{"child":{"asOfSeq":0,"values":{"subagentCatalog":[{"id":"grandchild","mode":"continuable","createdAt":2}]}}}}}));
    let owned = v.owned_sessions();
    assert!(owned.contains(&"child".into()));
    assert!(owned.contains(&"grandchild".into()));
    assert!(!owned.contains(&"unrelated".into()));
    assert!(!v.waterfall(&approval("unrelated", "unrelated", "c")));
    assert!(v.waterfall(&approval("child-approval", "child", "c")));
    // Root calls cannot provide arguments for a child call ID collision.
    v.apply_follow(&event(
        1,
        "tool/call",
        json!({"callId":"c","name":"read","arguments":"{\"path\":\"root.txt\"}"}),
    ));
    assert_eq!(v.snapshot()["pending"]["detailsUnavailable"], true);
    v.apply_child_follow("child",&json!({"type":"snapshot","header":{"id":"child","parentSession":"owned"},"cursor":0,"records":[event(0,"tool/call",json!({"callId":"c","name":"read","arguments":"{\"path\":\"child.txt\"}"}))],"projections":{"values":{}}}));
    assert_eq!(v.snapshot()["pending"]["detailsUnavailable"], false);
    assert_eq!(v.snapshot()["pending"]["arguments"]["path"], "child.txt");
    assert_eq!(v.snapshot()["pending"]["agentId"], "child");
    v.set_session("different");
    assert!(v.owned_sessions().is_empty());
}
#[test]
fn child_token_usage_does_not_double_count_into_the_parent() {
    let mut v = view();
    v.apply_follow(&opening(
        vec![],
        json!({"subagentCatalog":[{"id":"child","createdAt":1,"mode":"one-shot"}]}),
    ));
    v.apply_control(&json!({"type":"projection","sessionId":"child","key":"tokenUsage","seq":9,"value":{"uncachedInputTokens":50,"cacheReadTokens":100,"cacheWriteTokens":10,"outputTokens":3}}));
    assert_eq!(v.snapshot()["subagentUsage"]["child"]["outputTokens"], 3);
    assert_eq!(v.snapshot()["usage"]["output_tokens"], 0);
}
#[test]
fn structured_answers_reject_ambiguous_missing_and_oversize_input() {
    let event = json!({"questions":[{"id":"q","question":"Which?","options":[{"label":"yes"},{"label":"no"}]}]});
    assert!(validate_answers(&event, &json!([{"id":"q","selected":["yes"]}])).is_ok());
    for answer in [
        json!([]),
        json!([{"id":"different","selected":["yes"]}]),
        json!([{"id":"q","selected":["unknown"]}]),
        json!([{"id":"q","selected":["yes","no"]}]),
        json!([{"id":"q","selected":[],"custom":"  "}]),
        json!([{"id":"q","selected":[],"custom":"a".repeat(16385)}]),
        json!([{"id":"q","selected":["yes"],"extra":true}]),
    ] {
        assert!(validate_answers(&event, &answer).is_err());
    }
    let duplicate =
        json!({"questions":[{"id":"q","question":"One?"},{"id":"q","question":"Two?"}]});
    assert!(validate_answers(
        &duplicate,
        &json!([{"id":"q","selected":[],"custom":"x"},{"id":"q","selected":[],"custom":"y"}])
    )
    .is_err());
    let multi = json!({"questions":[{"id":"q","question":"Which?","multiSelect":true,"options":[{"label":"yes"}]}]});
    assert!(validate_answers(&multi, &json!([{"id":"q","selected":["yes","yes"]}])).is_err());
}

#[test]
fn projection_watermark_prevents_live_usage_from_disappearing_or_adding_twice() {
    let mut v = view();
    let mut baseline = opening(
        vec![],
        json!({"tokenUsage":{"uncachedInputTokens":20,"cacheReadTokens":50,"cacheWriteTokens":10,"outputTokens":4}}),
    );
    baseline["projections"]["asOfSeq"] = json!(0);
    v.apply_follow(&baseline);
    v.apply_follow(&event(1,"assistant/message",json!({"message":{"content":[{"type":"text","text":"done"}]},"usage":{"inputTokens":5,"cacheReadTokens":10,"cacheWriteTokens":5,"outputTokens":2}})));
    assert_eq!(v.snapshot()["usage"]["input_tokens"], 100);
    assert_eq!(v.snapshot()["usage"]["output_tokens"], 6);
    v.apply_control(&json!({"type":"projection","sessionId":"owned","key":"tokenUsage","seq":1,"value":{"uncachedInputTokens":25,"cacheReadTokens":60,"cacheWriteTokens":15,"outputTokens":6}}));
    assert_eq!(v.snapshot()["usage"]["input_tokens"], 100);
    assert_eq!(v.snapshot()["usage"]["output_tokens"], 6);
}
#[test]
fn a_delayed_stream_start_cannot_resurrect_committed_text() {
    let mut v = view();
    v.apply_follow(&opening(vec![], json!({})));
    let start =
        json!({"type":"assistant-stream","frame":{"type":"start","attemptId":"a","revision":1}});
    v.apply_follow(&start);
    v.apply_follow(&json!({"type":"assistant-stream","frame":{"type":"chunk","attemptId":"a","revision":2,"index":0,"chunk":{"type":"text-delta","text":"hello"}}}));
    v.apply_follow(&event(
        1,
        "assistant/message",
        json!({"message":{"content":[{"type":"text","text":"hello"}]}}),
    ));
    v.apply_follow(&start);
    assert_eq!(v.snapshot()["messages"].as_array().unwrap().len(), 1);
}

#[test]
fn reconnect_expands_compact_assistant_text_without_charging_live_chunks() {
    let mut v = view();
    let mut baseline = opening(vec![], json!({}));
    baseline["assistantStream"] = json!({"revision":5,"activeAttempt":{"attemptId":"a","stream":[{"type":"text-chunks","index":0,"time0":1,"dt":[0,1],"texts":["こん","にちは"]}],"nextIndex":2}});
    v.apply_follow(&baseline);
    assert_eq!(v.snapshot()["messages"][0]["content"], "こんにちは");
    assert_eq!(v.snapshot()["usage"]["requests"], 0);
}
#[test]
fn continued_child_questions_preserve_their_agent_when_restored() {
    let mut v = view();
    v.apply_follow(&opening(
        vec![],
        json!({"subagentCatalog":[{"id":"child","createdAt":1,"mode":"one-shot"}]}),
    ));
    v.apply_control(&json!({"type":"projection","sessionId":"child","key":"userQuestions","seq":1,"value":{"active":[{"callId":"qcall","state":"continued","questions":[{"id":"q","question":"Continue?"}]}],"settled":[]}}));
    let snapshot = v.snapshot();
    assert_eq!(snapshot["pending"]["agentId"], "child");
    assert_eq!(snapshot["pending"]["continued"], true);
    let id = snapshot["pending"]["id"].as_str().unwrap();
    let event = v.pending_event(id).unwrap();
    assert_eq!(event["agentId"], "child");
    assert_eq!(event["callId"], "qcall");
}

#[test]
fn session_summary_is_mapped_and_only_nonblank_workspace_roots_are_listed() {
    let value = session_list(&json!({"items":[
        {"sessionId":"kept","cwd":"/workspace","blank":false,"projections":{"values":{"title":"Saved"}}},
        {"sessionId":"blank","cwd":"/workspace","blank":true},
        {"sessionId":"elsewhere","cwd":"/other"},
        {"sessionId":"child","cwd":"/workspace","parentSessionId":"kept","origin":"subagent"}
    ]}),Path::new("/workspace")).unwrap();
    assert_eq!(value["items"].as_array().unwrap().len(), 1);
    assert_eq!(value["items"][0]["id"], "kept");
    assert_eq!(value["items"][0]["title"], "Saved");
}

#[test]
fn plan_and_permission_states_follow_host_projections_without_guessing_activation() {
    let mut v = view();
    v.apply_follow(&opening(
        vec![],
        json!({"plan":{"active":false,"pending":true},"permissions":{"currentValue":"safe"}}),
    ));
    assert_eq!(v.value["controls"]["mode"], "normal");
    assert_eq!(v.value["controls"]["planPending"], true);
    assert_eq!(v.value["controls"]["permission"], "safe");
    v.apply_follow(&opening(
        vec![],
        json!({"plan":{"active":true,"pending":false},"permissions":{"currentValue":"custom"}}),
    ));
    assert_eq!(v.value["controls"]["mode"], "plan");
    assert_eq!(v.value["controls"]["planPending"], false);
    assert_eq!(v.value["controls"]["permission"], "custom");
    v.apply_follow(&opening(vec![], json!({})));
    assert!(v.value["controls"]["mode"].is_null());
    assert!(v.value["controls"]["permission"].is_null());
}

#[test]
fn resume_preserves_existing_membership_and_uses_the_sessions_own_cwd() {
    let baseline = json!({"items":[{"workspaceId":"foreign-workspace","path":"/foreign","sessionIds":["bound"]}]});
    assert!(workspace_contains(&baseline, "bound").unwrap());
    assert!(!workspace_contains(&baseline, "legacy").unwrap());
    let saved_cwd = std::env::temp_dir().join("saved-session-workspace");
    let sessions = json!({"items":[{"sessionId":"bound","cwd":"/foreign"},{"sessionId":"legacy","cwd":saved_cwd}]});
    assert_eq!(
        resume_cwd(&sessions, "legacy").unwrap(),
        saved_cwd.to_str().unwrap()
    );
    assert!(resume_cwd(
        &json!({"items":[{"sessionId":"relative","cwd":"relative/path"}]}),
        "relative"
    )
    .is_err());
    assert!(resume_cwd(&sessions, "missing").is_err());
    assert!(workspace_contains(&json!({"items":[{}]}), "legacy").is_err());
    assert!(registered_workspace_id(&json!({"workspace":{}})).is_err());
}
