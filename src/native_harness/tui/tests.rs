use super::super::{
    engine::{Engine, Message, Pending, State},
    profiles, sdk,
};
use super::*;
use ratatui::backend::TestBackend;
use std::sync::Mutex;
use tokio::runtime::Runtime;
fn engine() -> Arc<Engine> {
    Arc::new(Engine {
        state: Mutex::new(State::default()),
        workspace: PathBuf::from("/test/workspace"),
        sdk: sdk::SdkConfig {
            bridge_dir: PathBuf::from("/test/sdk"),
            agy_key: None,
        },
        devin: PathBuf::from("/no-devin"),
        secrets: vec![],
        registry: profiles::Registry::default(),
    })
}
fn ready_app(engine: &Engine) -> App {
    let mut app = App::new(engine.providers());
    app.set_size(100, 32);
    app
}
fn runtime() -> Arc<Runtime> {
    Arc::new(
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(1)
            .enable_all()
            .build()
            .unwrap(),
    )
}
fn backend(engine: &Arc<Engine>) -> NativeBackend {
    NativeBackend::new(engine.clone(), runtime())
}
fn key(code: KeyCode) -> KeyEvent {
    KeyEvent::new(code, KeyModifiers::NONE)
}
fn render(app: &mut App, state: &Value, width: u16, height: u16) -> String {
    let mut terminal = Terminal::new(TestBackend::new(width, height)).unwrap();
    terminal
        .draw(|f| view::draw(f, app, state, Duration::ZERO))
        .unwrap();
    terminal
        .backend()
        .buffer()
        .content
        .iter()
        .map(|c| c.symbol())
        .collect::<String>()
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect()
}
#[test]
fn layout_adapts_without_panics_and_renders_unicode_and_overlays() {
    let engine = engine();
    let mut app = ready_app(&engine);
    engine.state.lock().unwrap().messages.push(Message {
        role: "assistant".into(),
        content: "日本語の応答\n```rust\nlet x = 1;\n```".into(),
    });
    app.editor.insert("複数行\n👨‍👩‍👧‍👦 e\u{301}");
    let state = engine.snapshot();
    for (width, height) in [(1, 1), (41, 13), (42, 14), (80, 24), (120, 40)] {
        for overlay in 0..3 {
            app.overlay = match overlay {
                1 => Overlay::Help,
                2 => Overlay::Models {
                    query: Editor::default(),
                    selected: 0,
                },
                _ => Overlay::None,
            };
            let output = render(&mut app, &state, width, height);
            if width >= 42 && height >= 14 {
                assert!(output.contains("RDSH"));
            }
        }
    }
    app.overlay = Overlay::None;
    let output = render(&mut app, &state, 100, 32);
    assert!(output.contains("日本語の応答"));
    assert!(output.contains("複数行"));
}
#[test]
fn approval_defaults_to_deny_and_is_tied_to_visible_id() {
    let engine = engine();
    let backend = backend(&engine);
    let mut app = ready_app(&engine);
    let (tx, mut rx) = tokio::sync::oneshot::channel();
    {
        let mut state = engine.state.lock().unwrap();
        state.status = "approval".into();
        state.pending = Some(Pending {
            id: "first".into(),
            tool: "read".into(),
            arguments: json!({"path":"日本語.txt"}),
            reason: "Read this file?".into(),
        });
        state.decision = Some(tx);
    }
    app.editor.insert("preserved draft");
    let snapshot = engine.snapshot();
    app.sync_pending(&snapshot);
    let output = render(&mut app, &snapshot, 100, 32);
    assert!(output.contains("操作の承認"));
    assert!(output.contains("日本語.txt"));
    assert!(!app.allow);
    assert!(rx.try_recv().is_err());
    app.key(key(KeyCode::Char('y')), &snapshot, &backend);
    assert!(rx.try_recv().is_err(), "typing y must not auto-approve");
    app.key(key(KeyCode::Enter), &snapshot, &backend);
    assert!(!rx.try_recv().unwrap());
    assert_eq!(app.editor.text, "preserved draft");
    // A stale view cannot approve a new request; a new ID resets to deny.
    let (tx, mut rx) = tokio::sync::oneshot::channel();
    {
        let mut state = engine.state.lock().unwrap();
        state.status = "approval".into();
        state.pending = Some(Pending {
            id: "second".into(),
            tool: "read".into(),
            arguments: json!({}),
            reason: "new".into(),
        });
        state.decision = Some(tx);
    }
    app.allow = true;
    app.key(key(KeyCode::Enter), &snapshot, &backend);
    assert!(rx.try_recv().is_err());
    app.sync_pending(&engine.snapshot());
    assert!(!app.allow);
    app.key(key(KeyCode::Tab), &engine.snapshot(), &backend);
    app.key(key(KeyCode::Enter), &engine.snapshot(), &backend);
    assert!(rx.try_recv().unwrap());
}
#[test]
fn editor_history_model_filter_and_scrolling_preserve_drafts() {
    let engine = engine();
    let backend = backend(&engine);
    let mut app = ready_app(&engine);
    app.history = vec!["previous".into()];
    app.editor.insert("draft");
    app.history(true);
    assert_eq!(app.editor.text, "previous");
    app.history(false);
    assert_eq!(app.editor.text, "draft");
    app.overlay = Overlay::Models {
        query: Editor::default(),
        selected: 0,
    };
    if let Overlay::Models { query, .. } = &mut app.overlay {
        query.insert("composer");
    }
    assert_eq!(app.filtered_models().len(), 1);
    app.key(key(KeyCode::Enter), &engine.snapshot(), &backend);
    assert!(matches!(app.overlay, Overlay::None));
    assert_eq!(app.editor.text, "draft");
    app.max_scroll = 30;
    app.scroll = 30;
    app.scroll_by(-8);
    assert_eq!(app.scroll, 22);
    assert!(!app.follow);
    app.scroll_by(100);
    assert!(app.follow);
}
#[test]
fn localized_cli_includes_native_terminal_command() {
    for locale in [
        crate::locale::Locale::Japanese,
        crate::locale::Locale::Chinese,
    ] {
        let mut command = crate::localized_command(locale);
        assert!(command
            .find_subcommand_mut("native-tui")
            .unwrap()
            .render_help()
            .to_string()
            .contains("--workspace"));
    }
}

#[test]
fn slash_menu_completion_execution_and_errors_stay_local() {
    let engine = engine();
    let backend = backend(&engine);
    let mut app = ready_app(&engine);
    app.editor.insert("/");
    assert_eq!(app.command_candidates().len(), commands::COMMANDS.len());
    let output = render(&mut app, &engine.snapshot(), 80, 24);
    assert!(output.contains("コマンド"));
    assert!(output.contains("/status"));
    app.key(key(KeyCode::Down), &engine.snapshot(), &backend);
    app.key(key(KeyCode::Tab), &engine.snapshot(), &backend);
    assert_eq!(app.editor.text, "/model ");
    assert!(!app.palette_open());
    assert!(engine.state.lock().unwrap().messages.is_empty());
    app.editor.clear();
    app.editor.insert("/sta");
    app.key(key(KeyCode::Enter), &engine.snapshot(), &backend);
    assert!(matches!(app.overlay, Overlay::Status));
    assert!(app.editor.text.is_empty());
    app.key(key(KeyCode::Esc), &engine.snapshot(), &backend);
    app.editor.insert("/unknown");
    app.submit(&backend);
    assert!(app.notice.contains("不明なコマンド"));
    assert_eq!(app.editor.text, "/unknown");
    assert!(engine.state.lock().unwrap().messages.is_empty());
    app.editor.clear();
    app.editor.insert("/model extra");
    app.submit(&backend);
    assert!(app.notice.contains("使い方"));
    assert_eq!(engine.state.lock().unwrap().model, "composer-2.5");
    app.editor.clear();
    app.editor.insert("/logs");
    app.submit(&backend);
    assert!(matches!(app.overlay, Overlay::Logs));
    assert!(render(&mut app, &engine.snapshot(), 42, 14).contains("実行ログ"));
}
#[test]
fn slash_new_requires_confirmation_and_rejects_running_work() {
    let engine = engine();
    let backend = backend(&engine);
    let mut app = ready_app(&engine);
    engine.state.lock().unwrap().messages.push(Message {
        role: "user".into(),
        content: "keep me".into(),
    });
    app.editor.insert("/new");
    app.submit(&backend);
    assert!(matches!(app.overlay, Overlay::New { confirm: false }));
    assert!(render(&mut app, &engine.snapshot(), 80, 24).contains("元の会話には戻れません"));
    app.key(key(KeyCode::Enter), &engine.snapshot(), &backend);
    assert_eq!(engine.state.lock().unwrap().messages.len(), 1);
    app.editor.insert("/new");
    app.submit(&backend);
    app.key(key(KeyCode::Tab), &engine.snapshot(), &backend);
    app.key(key(KeyCode::Enter), &engine.snapshot(), &backend);
    assert!(engine.state.lock().unwrap().messages.is_empty());
    assert_eq!(engine.state.lock().unwrap().model, "composer-2.5");
    engine.state.lock().unwrap().status = "running".into();
    for command in ["/model", "/new", "/model cursor-sdk composer-2.5"] {
        app.editor.clear();
        app.editor.insert(command);
        app.submit(&backend);
        assert!(matches!(app.overlay, Overlay::None));
        assert_eq!(app.editor.text, command);
        assert!(app.notice.contains("実行中"));
    }
    app.editor.clear();
    app.editor.insert("/cancel");
    app.submit(&backend);
    assert_eq!(engine.state.lock().unwrap().status, "idle");
}
#[test]
fn new_chat_preserves_history_when_backend_rejects_reset_and_invalidates_old_runs_on_success() {
    let engine = engine();
    let backend = backend(&engine);
    let mut app = ready_app(&engine);
    app.history = vec!["previous message".into()];
    app.history_index = Some(0);
    app.saved_draft = "saved draft".into();
    {
        let mut state = engine.state.lock().unwrap();
        state.status = "running".into();
        state.run_id = 42;
        state.error = Some("old error".into());
        state.messages.push(Message {
            role: "user".into(),
            content: "keep until reset succeeds".into(),
        });
    }
    assert!(!app.new_chat(&backend));
    assert_eq!(app.history, ["previous message"]);
    assert_eq!(app.history_index, Some(0));
    assert_eq!(app.saved_draft, "saved draft");
    assert_eq!(engine.state.lock().unwrap().run_id, 42);
    assert_eq!(engine.state.lock().unwrap().messages.len(), 1);
    engine.state.lock().unwrap().status = "idle".into();
    assert!(app.new_chat(&backend));
    assert!(app.history.is_empty());
    assert!(app.history_index.is_none());
    assert!(app.saved_draft.is_empty());
    let state = engine.state.lock().unwrap();
    assert_eq!(state.run_id, 43);
    assert_eq!(state.provider, "cursor-sdk");
    assert_eq!(state.model, "composer-2.5");
    assert!(state.messages.is_empty());
    assert!(state.error.is_none());
}
#[test]
fn escape_dismisses_palette_without_cancelling_and_edit_reopens_it() {
    let engine = engine();
    let backend = backend(&engine);
    let mut app = ready_app(&engine);
    engine.state.lock().unwrap().status = "running".into();
    app.editor.insert("/");
    app.key(key(KeyCode::Esc), &engine.snapshot(), &backend);
    assert!(!app.palette_open());
    assert_eq!(engine.state.lock().unwrap().status, "running");
    app.key(key(KeyCode::Char('s')), &engine.snapshot(), &backend);
    assert!(app.palette_open());
    assert_eq!(app.command_candidates()[0].name, "status");
}

#[test]
fn forward_history_outside_navigation_preserves_current_and_edited_drafts() {
    let engine = engine();
    let backend = backend(&engine);
    let mut app = ready_app(&engine);
    app.history = vec!["sent message".into()];
    app.editor.insert("new draft 日本語");
    app.editor.cursor = 3;
    let forward = KeyEvent::new(KeyCode::Char('n'), KeyModifiers::CONTROL);
    app.key(forward, &engine.snapshot(), &backend);
    assert_eq!(app.editor.text, "new draft 日本語");
    assert_eq!(app.editor.cursor, 3);
    app.history(true);
    assert_eq!(app.editor.text, "sent message");
    app.history(false);
    app.editor.insert(" edited");
    let edited = app.editor.text.clone();
    let cursor = app.editor.cursor;
    app.key(forward, &engine.snapshot(), &backend);
    app.key(forward, &engine.snapshot(), &backend);
    assert_eq!(app.editor.text, edited);
    assert_eq!(app.editor.cursor, cursor);
}

#[test]
fn hidden_approval_cannot_confirm_and_resizing_back_resets_to_deny() {
    let engine = engine();
    let backend = backend(&engine);
    let mut app = ready_app(&engine);
    let (tx, mut rx) = tokio::sync::oneshot::channel();
    {
        let mut state = engine.state.lock().unwrap();
        state.status = "approval".into();
        state.pending = Some(Pending {
            id: "small-screen".into(),
            tool: "read".into(),
            arguments: json!({"path":"proof.txt"}),
            reason: "confirm".into(),
        });
        state.decision = Some(tx);
    }
    let snapshot = engine.snapshot();
    app.sync_pending(&snapshot);
    app.allow = true;
    assert!(render(&mut app, &snapshot, 41, 13).contains("端末を42列"));
    assert!(!app.allow);
    app.key(key(KeyCode::Tab), &snapshot, &backend);
    app.key(key(KeyCode::Enter), &snapshot, &backend);
    assert!(rx.try_recv().is_err());
    assert_eq!(engine.state.lock().unwrap().status, "approval");
    app.guard_input_size(80, 24);
    assert!(
        !app.input_visible,
        "resizing alone cannot expose an unrendered dialog"
    );
    app.key(key(KeyCode::Tab), &snapshot, &backend);
    app.key(key(KeyCode::Enter), &snapshot, &backend);
    assert!(rx.try_recv().is_err());
    render(&mut app, &snapshot, 80, 24);
    app.key(key(KeyCode::Enter), &snapshot, &backend);
    assert!(
        !rx.try_recv().unwrap(),
        "a hidden selection must not survive resize"
    );
}

#[test]
fn hidden_new_chat_and_input_are_blocked_but_cancel_and_quit_remain_available() {
    let engine = engine();
    let backend = backend(&engine);
    let mut app = ready_app(&engine);
    engine.state.lock().unwrap().messages.push(Message {
        role: "user".into(),
        content: "keep this conversation".into(),
    });
    app.overlay = Overlay::New { confirm: true };
    render(&mut app, &engine.snapshot(), 80, 13);
    app.key(key(KeyCode::Tab), &engine.snapshot(), &backend);
    app.key(key(KeyCode::Enter), &engine.snapshot(), &backend);
    assert!(matches!(app.overlay, Overlay::New { confirm: false }));
    assert_eq!(engine.state.lock().unwrap().messages.len(), 1);
    app.key(key(KeyCode::Esc), &engine.snapshot(), &backend);
    assert!(matches!(app.overlay, Overlay::None));
    app.editor.insert("unsent draft");
    app.paste("hidden paste");
    app.key(key(KeyCode::Enter), &engine.snapshot(), &backend);
    assert_eq!(app.editor.text, "unsent draft");
    assert_eq!(engine.state.lock().unwrap().messages.len(), 1);
    engine.state.lock().unwrap().status = "running".into();
    app.key(
        KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL),
        &engine.snapshot(),
        &backend,
    );
    assert_eq!(engine.state.lock().unwrap().status, "idle");
    assert!(app.key(
        KeyEvent::new(KeyCode::Char('q'), KeyModifiers::CONTROL),
        &engine.snapshot(),
        &backend
    ));
}

#[test]
fn pasted_model_query_resets_selection_to_the_highlighted_match() {
    let engine = engine();
    let backend = backend(&engine);
    let mut app = ready_app(&engine);
    app.overlay = Overlay::Models {
        query: Editor::default(),
        selected: 2,
    };
    app.paste("composer");
    assert!(matches!(app.overlay, Overlay::Models { selected: 0, .. }));
    assert_eq!(app.filtered_models().len(), 1);
    assert!(render(&mut app, &engine.snapshot(), 80, 24).contains("composer-2.5"));
    app.key(key(KeyCode::Enter), &engine.snapshot(), &backend);
    assert!(matches!(app.overlay, Overlay::None));
    assert_eq!(engine.state.lock().unwrap().provider, "cursor-sdk");
    assert_eq!(engine.state.lock().unwrap().model, "composer-2.5");
}

#[test]
fn usage_footer_reports_real_counters_and_keeps_missing_usage_distinct_from_zero() {
    let engine = engine();
    let backend = backend(&engine);
    let mut app = ready_app(&engine);
    let unknown = render(&mut app, &engine.snapshot(), 100, 32);
    assert!(unknown.contains("Cache:未取得"));
    {
        let mut state = engine.state.lock().unwrap();
        state.usage.start("test", "model");
        state.usage.finish(
            &super::super::usage::Usage {
                input_tokens: Some(100),
                output_tokens: Some(20),
                cache_read_tokens: Some(80),
                ..Default::default()
            },
            15,
        );
    }
    let output = render(&mut app, &engine.snapshot(), 100, 32);
    assert!(output.contains("In:100"));
    assert!(output.contains("Out:20"));
    assert!(output.contains("Cache:80.0%"));
    engine.state.lock().unwrap().usage.start("sdk", "unknown");
    assert!(render(&mut app, &engine.snapshot(), 100, 32).contains("Cache:80.0%*"));
    app.editor.insert("/usage");
    app.submit(&backend);
    assert!(matches!(app.overlay, Overlay::Status));
    assert!(render(&mut app, &engine.snapshot(), 100, 32).contains("キャッシュ集計対象"));
    assert!(app.new_chat(&backend));
    assert_eq!(engine.snapshot()["usage"]["requests"], 0);
}

#[test]
fn web_diagnostics_and_complete_event_history_are_readable_in_narrow_terminals() {
    let engine = engine();
    let backend = backend(&engine);
    let mut app = ready_app(&engine);
    let mut state = engine.snapshot();
    state["diagnostics"] = json!(["PROFILE_DIAGNOSTIC_DETAILS"]);
    state["providers"][0]["models"][0]["unavailable"] = json!("MODEL_UNAVAILABLE_REASON_COMPLETE");
    app.editor.insert("/diagnostics");
    app.submit(&backend);
    assert!(matches!(app.overlay, Overlay::Diagnostics));
    assert!(render(&mut app, &state, 60, 24).contains("PROFILE_DIAGNOSTIC_DETAILS"));
    assert!(render(&mut app, &state, 60, 24).contains("MODEL_UNAVAILABLE_REASON_COMPLETE"));
    app.overlay = Overlay::None;
    app.editor.insert("/logs");
    app.submit(&backend);
    state["events"] = json!((0..40)
        .map(|n| json!({"kind":"info","name":format!("EVENT{n}"),"content":"complete event text"}))
        .collect::<Vec<_>>());
    assert!(render(&mut app, &state, 42, 14).contains("EVENT39"));
    app.key(key(KeyCode::Home), &state, &backend);
    assert!(render(&mut app, &state, 42, 14).contains("EVENT0"));
    app.key(key(KeyCode::End), &state, &backend);
    assert!(render(&mut app, &state, 42, 14).contains("EVENT39"));
}

struct TestHarness {
    state: Mutex<Value>,
    requests: Mutex<Vec<(String, Value)>>,
    replies: Mutex<std::collections::HashMap<String, Value>>,
    fail_path: Mutex<Option<String>>,
    cancelled: std::sync::atomic::AtomicBool,
}
impl TestHarness {
    fn new() -> Self {
        Self {
            state: Mutex::new(json!({
                "backend":"dsh", "engine":"dsh-runtime", "status":"idle", "providers":[],
                "messages":[], "events":[], "usage":{}, "workspace":"/mock/workspace",
                "provider":"test", "model":"test", "capabilities":{"sessionPersistence":true}
            })),
            requests: Mutex::new(vec![]),
            replies: Mutex::new(std::collections::HashMap::new()),
            fail_path: Mutex::new(None),
            cancelled: std::sync::atomic::AtomicBool::new(false),
        }
    }
    fn questions(value: Value) -> Self {
        let backend = Self::new();
        backend.state.lock().unwrap()["pending"] = json!({
            "id":"question-call", "kind":"questions", "tool":"user_questions", "questions":value
        });
        backend.state.lock().unwrap()["status"] = json!("approval");
        backend
    }
    fn app(&self) -> App {
        let snapshot = self.snapshot();
        let mut app = App::new(snapshot["providers"].clone());
        app.set_size(100, 32);
        app.sync_pending(&snapshot);
        app
    }
}
impl HarnessBackend for TestHarness {
    fn snapshot(&self) -> Value {
        self.state.lock().unwrap().clone()
    }
    fn request(&self, path: &str, body: Value) -> Result<Value> {
        self.requests.lock().unwrap().push((path.into(), body));
        if self.fail_path.lock().unwrap().as_deref() == Some(path) {
            bail!("mock request failed");
        }
        Ok(self
            .replies
            .lock()
            .unwrap()
            .get(path)
            .cloned()
            .unwrap_or(json!({"ok":true})))
    }
    fn cancel(&self) {
        self.cancelled
            .store(true, std::sync::atomic::Ordering::SeqCst);
    }
    fn reset(&self) -> Result<()> {
        Ok(())
    }
    fn redact(&self, text: &str) -> String {
        text.into()
    }
}
fn control(c: char) -> KeyEvent {
    KeyEvent::new(KeyCode::Char(c), KeyModifiers::CONTROL)
}

#[test]
fn questions_and_plan_review_have_no_default_and_only_ctrl_s_submits() {
    let detail = (0..80)
        .map(|i| format!("PLAN_DETAIL_{i}\n"))
        .collect::<String>();
    let backend = TestHarness::questions(json!([{
        "id":"review", "question":"計画を確認してください", "detail":detail,
        "options":[{"label":"承認"},{"label":"戻す"}],
        "intent":{"kind":"plan-review","approve":"承認"}
    }]));
    let mut app = backend.app();
    let state = backend.snapshot();
    assert!(app.question_form.as_ref().unwrap().items[0]
        .selected
        .iter()
        .all(|s| !s));
    let output = render(&mut app, &state, 100, 32);
    assert!(output.contains("計画レビュー"));
    assert!(output.contains("PLAN_DETAIL_0"));
    app.key(key(KeyCode::End), &state, &backend);
    assert!(render(&mut app, &state, 100, 32).contains("PLAN_DETAIL_79"));
    app.key(key(KeyCode::Enter), &state, &backend);
    app.key(control('s'), &state, &backend);
    assert!(backend.requests.lock().unwrap().is_empty());
    assert!(app.notice.contains("未回答"));
    app.key(key(KeyCode::Char(' ')), &state, &backend);
    app.key(key(KeyCode::Enter), &state, &backend);
    assert!(backend.requests.lock().unwrap().is_empty());
    app.key(control('s'), &state, &backend);
    assert_eq!(
        backend.requests.lock().unwrap().as_slice(),
        &[(
            "/api/question".into(),
            json!({"id":"question-call","answers":[{"id":"review","selected":["承認"]}]})
        )]
    );
}

#[test]
fn hidden_questions_clear_answers_and_block_submission_while_cancel_and_quit_work() {
    let backend = TestHarness::questions(json!([{
        "id":"q", "question":"choose", "options":[{"label":"yes"},{"label":"no"}]
    }]));
    let mut app = backend.app();
    let state = backend.snapshot();
    app.key(key(KeyCode::Char(' ')), &state, &backend);
    assert!(app.question_form.as_ref().unwrap().items[0].selected[0]);
    render(&mut app, &state, 41, 13);
    assert!(!app.question_form.as_ref().unwrap().items[0].selected[0]);
    app.key(control('e'), &state, &backend);
    app.paste("hidden answer");
    app.key(control('s'), &state, &backend);
    app.guard_input_size(100, 32);
    app.key(key(KeyCode::Char(' ')), &state, &backend);
    app.key(control('s'), &state, &backend);
    assert!(backend.requests.lock().unwrap().is_empty());
    render(&mut app, &state, 100, 32);
    app.key(control('s'), &state, &backend);
    assert!(backend.requests.lock().unwrap().is_empty());
    render(&mut app, &state, 41, 13);
    app.key(control('c'), &state, &backend);
    assert!(backend.cancelled.load(std::sync::atomic::Ordering::SeqCst));
    app.key(key(KeyCode::Esc), &state, &backend);
    assert_eq!(
        backend.requests.lock().unwrap()[0],
        (
            "/api/approval".into(),
            json!({"id":"question-call","allow":false})
        )
    );
    assert!(app.key(control('q'), &state, &backend));
}

#[test]
fn multiselect_custom_text_and_multiple_questions_keep_exact_labels() {
    let backend = TestHarness::questions(json!([
        {"id":"multi","question":"pick", "multiSelect":true,"options":[
            {"label":" A α  ","description":"full context"},{"label":"日本語B"}
        ]},
        {"id":"free","question":"自由入力"}
    ]));
    let mut app = backend.app();
    let state = backend.snapshot();
    app.key(key(KeyCode::Char(' ')), &state, &backend);
    app.key(key(KeyCode::Down), &state, &backend);
    app.key(key(KeyCode::Char(' ')), &state, &backend);
    app.key(control('e'), &state, &backend);
    app.paste("custom 日本語\nsecond line");
    app.key(key(KeyCode::Tab), &state, &backend);
    assert_eq!(app.question_form.as_ref().unwrap().current, 1);
    app.key(control('e'), &state, &backend);
    app.paste("Other");
    app.key(control('s'), &state, &backend);
    assert_eq!(
        backend.requests.lock().unwrap()[0].1,
        json!({
            "id":"question-call", "answers":[
                {"id":"multi","selected":[" A α  ","日本語B"],"custom":"custom 日本語\nsecond line"},
                {"id":"free","selected":[],"custom":"Other"}
            ]
        })
    );
}

#[test]
fn invalid_or_oversize_question_forms_never_fall_back_to_approval() {
    let invalid = vec![
        json!([]),
        json!([{"id":"q"}]),
        json!([{"id":"q","question":"?"},{"id":"q","question":"duplicate"}]),
        json!([{"id":"q","question":"?","options":[{"label":"same"},{"label":"same"}]}]),
        json!([{"id":"q","question":"?","options":[{"label":"hidden\u{1b}"}]}]),
        json!([{"id":"q","question":"?","detail":"plan","options":[{"label":"no"}],"intent":{"kind":"plan-review","approve":"yes"}}]),
        json!([{"id":"q","question":"?","options":[{"label":"yes"}],"intent":{"kind":"plan-review","approve":"yes"}}]),
        json!([{"id":"q","question":"?","detail":"x".repeat(256 * 1024)}]),
        json!((0..33)
            .map(|n| json!({"id":n.to_string(),"question":"?"}))
            .collect::<Vec<_>>()),
        json!([{"id":"q","question":"?","options":(0..65).map(|n|json!({"label":n.to_string()})).collect::<Vec<_>>()}]),
    ];
    for questions in invalid {
        let backend = TestHarness::questions(questions);
        let mut app = backend.app();
        let state = backend.snapshot();
        assert!(app.question_form.is_none());
        assert!(app.question_error.is_some());
        render(&mut app, &state, 100, 32);
        for event in [
            key(KeyCode::Char(' ')),
            key(KeyCode::Tab),
            key(KeyCode::Enter),
            control('e'),
            control('s'),
        ] {
            app.key(event, &state, &backend);
        }
        app.paste("cannot answer invalid form");
        assert!(backend.requests.lock().unwrap().is_empty());
        app.key(key(KeyCode::Esc), &state, &backend);
        assert_eq!(backend.requests.lock().unwrap()[0].0, "/api/approval");
        assert_eq!(backend.requests.lock().unwrap()[0].1["allow"], false);
    }
}

#[test]
fn changed_question_with_same_id_does_not_accept_old_selection() {
    let backend =
        TestHarness::questions(json!([{"id":"q","question":"first","options":[{"label":"yes"}]}]));
    let mut app = backend.app();
    let state = backend.snapshot();
    app.key(key(KeyCode::Char(' ')), &state, &backend);
    backend.state.lock().unwrap()["pending"]["questions"][0]["question"] = json!("changed");
    app.key(control('s'), &state, &backend);
    assert!(backend.requests.lock().unwrap().is_empty());
    assert!(app.notice.contains("更新"));
    assert!(!app.question_form.as_ref().unwrap().items[0].selected[0]);
}

#[test]
fn malformed_question_request_id_blocks_input_and_can_still_cancel() {
    let backend = TestHarness::questions(json!([{"id":"q","question":"question"}]));
    backend.state.lock().unwrap()["pending"]["id"] = Value::Null;
    let mut app = backend.app();
    let state = backend.snapshot();
    app.editor.insert("preserved message draft");
    assert!(app.has_pending());
    assert!(app.question_form.is_none());
    assert!(app.question_error.as_deref().unwrap().contains("要求ID"));
    app.key(key(KeyCode::Enter), &state, &backend);
    app.key(control('s'), &state, &backend);
    app.paste("hidden text");
    assert_eq!(app.editor.text, "preserved message draft");
    assert!(backend.requests.lock().unwrap().is_empty());
    app.key(key(KeyCode::Esc), &state, &backend);
    assert!(backend.cancelled.load(std::sync::atomic::Ordering::SeqCst));
}

#[test]
fn session_picker_keeps_draft_until_resume_succeeds() {
    let backend = TestHarness::new();
    backend.replies.lock().unwrap().insert(
        "/api/sessions".into(),
        json!({"items":[{"id":"exact-id","title":"過去の会話","cwd":"/saved"}]}),
    );
    let mut app = backend.app();
    app.editor.insert("preserved draft 日本語");
    app.execute_command(commands::Invocation::Sessions, &backend);
    assert_eq!(app.editor.text, "preserved draft 日本語");
    assert!(matches!(app.overlay, Overlay::Sessions { .. }));
    *backend.fail_path.lock().unwrap() = Some("/api/resume".into());
    app.key(key(KeyCode::Enter), &backend.snapshot(), &backend);
    assert_eq!(app.editor.text, "preserved draft 日本語");
    assert!(matches!(app.overlay, Overlay::Sessions { .. }));
    assert!(app.notice.contains("failed"));
    *backend.fail_path.lock().unwrap() = None;
    app.key(key(KeyCode::Enter), &backend.snapshot(), &backend);
    assert!(app.editor.text.is_empty());
    assert!(matches!(app.overlay, Overlay::None));
    assert_eq!(
        backend.requests.lock().unwrap()[2],
        ("/api/resume".into(), json!({"sessionId":"exact-id"}))
    );
}

#[test]
fn dsh_only_commands_are_local_errors_in_native_mode() {
    let engine = engine();
    let backend = backend(&engine);
    let mut app = ready_app(&engine);
    for command in ["/sessions", "/plugins", "/settings"] {
        app.editor.clear();
        app.editor.insert(command);
        app.submit(&backend);
        assert!(app.notice.contains("DSHバックエンド専用"));
        assert_eq!(app.editor.text, command);
        assert!(matches!(app.overlay, Overlay::None));
    }
    assert!(engine.state.lock().unwrap().messages.is_empty());
    assert!(engine.state.lock().unwrap().events.is_empty());
}

#[test]
fn readonly_settings_redact_secret_fields_and_limit_scrollable_output() {
    let backend = TestHarness::new();
    backend.replies.lock().unwrap().insert("/api/settings".into(), json!({
        "apiKey":"private-fixture-a", "nested":{"OPENAI_API_KEY":"private-fixture-b","access_token":"private-fixture-c"},
        "body":"x".repeat(300 * 1024)
    }));
    let mut app = backend.app();
    app.execute_command(commands::Invocation::Settings, &backend);
    let Overlay::ReadOnly { content, .. } = &app.overlay else {
        panic!("missing readonly overlay")
    };
    assert!(!content.contains("private-fixture"));
    assert!(content.contains("[REDACTED]"));
    assert!(content.contains("表示上限256KiB"));
    assert!(content.len() < 257 * 1024);
    render(&mut app, &backend.snapshot(), 60, 24);
    assert!(app.detail_max_scroll > 0);
    app.key(key(KeyCode::End), &backend.snapshot(), &backend);
    assert!(render(&mut app, &backend.snapshot(), 60, 24).contains("省略しました"));
    assert_eq!(backend.requests.lock().unwrap()[0].0, "/api/settings");
}

#[test]
fn header_and_new_chat_describe_actual_backend_and_persistence() {
    let backend = TestHarness::new();
    backend.state.lock().unwrap()["usage"]["request_count_unknown"] = json!(true);
    let mut app = backend.app();
    let state = backend.snapshot();
    let output = render(&mut app, &state, 120, 40);
    assert!(output.contains("dsh-runtime"));
    assert!(output.contains("Req:?"));
    app.overlay = Overlay::New { confirm: false };
    let output = render(&mut app, &state, 120, 40);
    assert!(output.contains("/sessionsで再開できます"));
    assert!(!output.contains("元の会話には戻れません"));
    let engine = engine();
    let mut native = ready_app(&engine);
    assert!(render(&mut native, &engine.snapshot(), 120, 40).contains("rust-rdsh"));
    native.overlay = Overlay::New { confirm: false };
    assert!(render(&mut native, &engine.snapshot(), 120, 40).contains("元の会話には戻れません"));
}

#[test]
fn control_commands_and_aliases_parse_without_accepting_extra_actions() {
    use commands::{parse, Invocation::*};
    for (text, expected) in [
        ("/mode plan", Mode(Some("plan".into()))),
        ("/mode act", Mode(Some("normal".into()))),
        ("/plan", Plan(None)),
        ("/plan off", Plan(Some(false))),
        (
            "/permission read-only",
            Permission(Some("read-only".into())),
        ),
        (
            "/permission full-access",
            Permission(Some("full-access".into())),
        ),
        ("/clear", New),
        ("/exit", Quit),
        ("/stop", Cancel),
        ("/resume", Sessions),
    ] {
        assert_eq!(parse(text).unwrap().unwrap(), expected);
    }
    for text in [
        "/mode auto",
        "/plan execute this task",
        "/permission auto extra",
        "/permission ;shell",
        "/clear now",
        "/mode plan\n/permission auto",
    ] {
        assert!(parse(text).unwrap().is_err(), "{text}");
    }
}

#[test]
fn permission_changes_require_visible_confirmation_and_new_preserves_controls() {
    let engine = engine();
    let backend = backend(&engine);
    let mut app = ready_app(&engine);
    app.editor.insert("/mode plan");
    app.submit(&backend);
    assert_eq!(engine.snapshot()["controls"]["mode"], "plan");
    app.editor.insert("/permission read-only");
    app.submit(&backend);
    assert!(matches!(
        app.overlay,
        Overlay::Permission { confirm: false, .. }
    ));
    app.paste("\t\n/permission ask\n");
    assert_eq!(engine.snapshot()["controls"]["permission"], "ask");
    app.key(key(KeyCode::Tab), &engine.snapshot(), &backend);
    app.set_size(41, 13);
    app.key(key(KeyCode::Enter), &engine.snapshot(), &backend);
    assert_eq!(engine.snapshot()["controls"]["permission"], "ask");
    app.set_size(100, 32);
    app.key(key(KeyCode::Enter), &engine.snapshot(), &backend);
    assert!(matches!(app.overlay, Overlay::None));
    app.editor.insert("/permission read-only");
    app.submit(&backend);
    app.key(key(KeyCode::Tab), &engine.snapshot(), &backend);
    app.key(key(KeyCode::Enter), &engine.snapshot(), &backend);
    assert_eq!(engine.snapshot()["controls"]["permission"], "read-only");
    app.editor.insert("/clear");
    app.submit(&backend);
    assert!(matches!(app.overlay, Overlay::New { confirm: false }));
    app.key(key(KeyCode::Tab), &engine.snapshot(), &backend);
    app.key(key(KeyCode::Enter), &engine.snapshot(), &backend);
    assert_eq!(engine.snapshot()["controls"]["mode"], "plan");
    assert_eq!(engine.snapshot()["controls"]["permission"], "read-only");
    assert!(render(&mut app, &engine.snapshot(), 120, 40).contains("plan"));
    app.editor.insert("/plan off");
    app.submit(&backend);
    assert_eq!(engine.snapshot()["controls"]["mode"], "normal");
}

#[test]
fn controls_are_not_changed_while_generating_or_approving() {
    let engine = engine();
    let backend = backend(&engine);
    let mut app = ready_app(&engine);
    for status in ["running", "approval"] {
        engine.state.lock().unwrap().status = status.into();
        for text in [
            "/mode plan",
            "/plan on",
            "/permission read-only",
            "/permission full-access",
        ] {
            app.editor.clear();
            app.editor.insert(text);
            app.submit(&backend);
            assert_eq!(app.editor.text, text);
            assert!(app.notice.contains("実行中"));
        }
    }
    assert_eq!(engine.snapshot()["controls"]["mode"], "normal");
    assert_eq!(engine.snapshot()["controls"]["permission"], "ask");
}

#[test]
fn native_full_access_requires_confirmation_and_survives_new_chat() {
    let engine = engine();
    let backend = backend(&engine);
    let mut app = ready_app(&engine);
    app.editor.insert("/permission");
    app.submit(&backend);
    let output = render(&mut app, &engine.snapshot(), 100, 32);
    assert!(output.contains("/permissionfull-access"));
    assert!(!output.contains("normalパーミッション"));
    assert!(!output.contains("確認します/permission"));
    app.key(key(KeyCode::Esc), &engine.snapshot(), &backend);
    app.editor.insert("/permission full-access");
    app.submit(&backend);
    let output = render(&mut app, &engine.snapshot(), 100, 32);
    assert!(output.contains("自動承認"));
    assert!(output.contains("ネットワーク"));
    assert!(output.contains("戻る"));
    app.paste("\t\n");
    app.key(key(KeyCode::Enter), &engine.snapshot(), &backend);
    assert_eq!(engine.snapshot()["controls"]["permission"], "ask");
    app.editor.insert("/permission full-access");
    app.submit(&backend);
    app.key(key(KeyCode::Tab), &engine.snapshot(), &backend);
    app.set_size(41, 13);
    app.key(key(KeyCode::Enter), &engine.snapshot(), &backend);
    app.set_size(100, 32);
    app.key(key(KeyCode::Enter), &engine.snapshot(), &backend);
    assert_eq!(engine.snapshot()["controls"]["permission"], "ask");
    app.editor.insert("/permission full-access");
    app.submit(&backend);
    app.key(key(KeyCode::Tab), &engine.snapshot(), &backend);
    app.key(key(KeyCode::Enter), &engine.snapshot(), &backend);
    assert_eq!(engine.snapshot()["controls"]["permission"], "full-access");
    app.editor.insert("/new");
    app.submit(&backend);
    app.key(key(KeyCode::Tab), &engine.snapshot(), &backend);
    app.key(key(KeyCode::Enter), &engine.snapshot(), &backend);
    assert_eq!(engine.snapshot()["controls"]["permission"], "full-access");
    assert!(render(&mut app, &engine.snapshot(), 120, 40).contains("full-access"));
}

#[test]
fn dsh_permissions_keep_host_ids_and_require_an_explicit_confirmation() {
    let backend = TestHarness::new();
    backend.replies.lock().unwrap().insert(
        "/api/controls".into(),
        json!({"mode":"normal","permission":"safe","permissions":[
        {"id":"safe","name":"Safe","description":"Host safe rules"},
        {"id":"auto","name":"Auto","description":"Host automatically approves tools"},
        {"id":"custom","name":"Custom","selectable":false}]}),
    );
    let mut app = backend.app();
    app.editor.insert("/permission auto");
    app.submit(&backend);
    assert!(matches!(
        app.overlay,
        Overlay::Permission { confirm: false, .. }
    ));
    assert!(render(&mut app, &backend.snapshot(), 100, 32).contains("automatically"));
    app.key(key(KeyCode::Enter), &backend.snapshot(), &backend);
    assert!(!backend
        .requests
        .lock()
        .unwrap()
        .iter()
        .any(|r| r.0 == "/api/permission"));
    app.editor.insert("/permission auto");
    app.submit(&backend);
    app.key(key(KeyCode::Tab), &backend.snapshot(), &backend);
    app.key(key(KeyCode::Enter), &backend.snapshot(), &backend);
    assert_eq!(
        backend.requests.lock().unwrap().last().unwrap(),
        &(
            "/api/permission".into(),
            json!({"preset":"auto","confirmed":true})
        )
    );
    app.editor.insert("/permission custom");
    app.submit(&backend);
    assert_eq!(app.editor.text, "/permission custom");
    assert!(app.notice.contains("選択可能"));
    assert!(backend.state.lock().unwrap()["messages"]
        .as_array()
        .unwrap()
        .is_empty());
}

#[test]
fn unsupported_control_views_keep_input_and_help_lists_all_aliases() {
    let backend = TestHarness::new();
    *backend.fail_path.lock().unwrap() = Some("/api/controls".into());
    let mut app = backend.app();
    app.editor.insert("/permission");
    app.submit(&backend);
    assert_eq!(app.editor.text, "/permission");
    assert!(app.notice.contains("failed"));
    assert!(matches!(app.overlay, Overlay::None));
    let engine = engine();
    let native = backend::NativeBackend::new(engine.clone(), runtime());
    app.editor.clear();
    app.editor.insert("/help");
    app.submit(&native);
    render(&mut app, &engine.snapshot(), 60, 24);
    assert!(app.detail_max_scroll > 0);
    app.key(key(KeyCode::End), &engine.snapshot(), &native);
    assert!(render(&mut app, &engine.snapshot(), 60, 24).contains("/resume"));
}

#[test]
fn long_permission_explanations_scroll_above_a_visible_confirmation_footer() {
    let backend = TestHarness::new();
    backend.replies.lock().unwrap().insert("/api/controls".into(),json!({"permissions":[{
        "id":"auto","name":"Auto",
        "description":format!("全ツールを自動承認する設定です。\n{}\nLONG_PERMISSION_END", "long permission explanation 日本語\n".repeat(80))
    }]}));
    let mut app = backend.app();
    app.detail_scroll = 999;
    app.editor.insert("/permission auto");
    app.submit(&backend);
    assert_eq!(
        app.detail_scroll, 0,
        "opening the confirmation must show the initial warning"
    );
    let output = render(&mut app, &backend.snapshot(), 42, 14);
    assert!(output.contains("全ツールを自動承認"));
    assert!(output.contains("戻る"));
    assert!(output.contains("設定を適用"));
    assert!(app.detail_max_scroll > 8);
    app.key(key(KeyCode::PageDown), &backend.snapshot(), &backend);
    assert!(app.detail_scroll > 0);
    let output = render(&mut app, &backend.snapshot(), 42, 14);
    assert!(output.contains("戻る"));
    assert!(output.contains("設定を適用"));
    app.key(key(KeyCode::End), &backend.snapshot(), &backend);
    let output = render(&mut app, &backend.snapshot(), 42, 14);
    assert!(output.contains("LONG_PERMISSION_END"));
    assert!(output.contains("戻る"));
    assert!(output.contains("設定を適用"));
    assert!(!backend
        .requests
        .lock()
        .unwrap()
        .iter()
        .any(|r| r.0 == "/api/permission"));
    app.key(key(KeyCode::Enter), &backend.snapshot(), &backend);
    assert!(matches!(app.overlay, Overlay::None));
    assert!(!backend
        .requests
        .lock()
        .unwrap()
        .iter()
        .any(|r| r.0 == "/api/permission"));
}
