use super::super::{
    engine::{Message, Pending, State},
    profiles, sdk,
};
use super::*;
use ratatui::backend::TestBackend;
use std::sync::Mutex;
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
fn runtime() -> Arc<Runtime> {
    Arc::new(
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(1)
            .enable_all()
            .build()
            .unwrap(),
    )
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
    let mut app = App::new(&engine);
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
    let runtime = runtime();
    let mut app = App::new(&engine);
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
    app.key(key(KeyCode::Char('y')), &snapshot, &engine, &runtime);
    assert!(rx.try_recv().is_err(), "typing y must not auto-approve");
    app.key(key(KeyCode::Enter), &snapshot, &engine, &runtime);
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
    app.key(key(KeyCode::Enter), &snapshot, &engine, &runtime);
    assert!(rx.try_recv().is_err());
    app.sync_pending(&engine.snapshot());
    assert!(!app.allow);
    app.key(key(KeyCode::Tab), &engine.snapshot(), &engine, &runtime);
    app.key(key(KeyCode::Enter), &engine.snapshot(), &engine, &runtime);
    assert!(rx.try_recv().unwrap());
}
#[test]
fn editor_history_model_filter_and_scrolling_preserve_drafts() {
    let engine = engine();
    let runtime = runtime();
    let mut app = App::new(&engine);
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
    app.key(key(KeyCode::Enter), &engine.snapshot(), &engine, &runtime);
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
    let runtime = runtime();
    let mut app = App::new(&engine);
    app.editor.insert("/");
    assert_eq!(app.command_candidates().len(), commands::COMMANDS.len());
    let output = render(&mut app, &engine.snapshot(), 80, 24);
    assert!(output.contains("コマンド"));
    assert!(output.contains("/status"));
    app.key(key(KeyCode::Down), &engine.snapshot(), &engine, &runtime);
    app.key(key(KeyCode::Tab), &engine.snapshot(), &engine, &runtime);
    assert_eq!(app.editor.text, "/model ");
    assert!(!app.palette_open());
    assert!(engine.state.lock().unwrap().messages.is_empty());
    app.editor.clear();
    app.editor.insert("/sta");
    app.key(key(KeyCode::Enter), &engine.snapshot(), &engine, &runtime);
    assert!(matches!(app.overlay, Overlay::Status));
    assert!(app.editor.text.is_empty());
    app.key(key(KeyCode::Esc), &engine.snapshot(), &engine, &runtime);
    app.editor.insert("/unknown");
    app.submit(&engine, &runtime);
    assert!(app.notice.contains("不明なコマンド"));
    assert_eq!(app.editor.text, "/unknown");
    assert!(engine.state.lock().unwrap().messages.is_empty());
    app.editor.clear();
    app.editor.insert("/model extra");
    app.submit(&engine, &runtime);
    assert!(app.notice.contains("使い方"));
    assert_eq!(engine.state.lock().unwrap().model, "composer-2.5");
    app.editor.clear();
    app.editor.insert("/logs");
    app.submit(&engine, &runtime);
    assert!(matches!(app.overlay, Overlay::Logs));
    assert!(render(&mut app, &engine.snapshot(), 42, 14).contains("実行ログ"));
}
#[test]
fn slash_new_requires_confirmation_and_rejects_running_work() {
    let engine = engine();
    let runtime = runtime();
    let mut app = App::new(&engine);
    engine.state.lock().unwrap().messages.push(Message {
        role: "user".into(),
        content: "keep me".into(),
    });
    app.editor.insert("/new");
    app.submit(&engine, &runtime);
    assert!(matches!(app.overlay, Overlay::New { confirm: false }));
    assert!(render(&mut app, &engine.snapshot(), 80, 24).contains("元の会話には戻れません"));
    app.key(key(KeyCode::Enter), &engine.snapshot(), &engine, &runtime);
    assert_eq!(engine.state.lock().unwrap().messages.len(), 1);
    app.editor.insert("/new");
    app.submit(&engine, &runtime);
    app.key(key(KeyCode::Tab), &engine.snapshot(), &engine, &runtime);
    app.key(key(KeyCode::Enter), &engine.snapshot(), &engine, &runtime);
    assert!(engine.state.lock().unwrap().messages.is_empty());
    assert_eq!(engine.state.lock().unwrap().model, "composer-2.5");
    engine.state.lock().unwrap().status = "running".into();
    for command in ["/model", "/new", "/model cursor-sdk composer-2.5"] {
        app.editor.clear();
        app.editor.insert(command);
        app.submit(&engine, &runtime);
        assert!(matches!(app.overlay, Overlay::None));
        assert_eq!(app.editor.text, command);
        assert!(app.notice.contains("実行中"));
    }
    app.editor.clear();
    app.editor.insert("/cancel");
    app.submit(&engine, &runtime);
    assert_eq!(engine.state.lock().unwrap().status, "idle");
}
#[test]
fn escape_dismisses_palette_without_cancelling_and_edit_reopens_it() {
    let engine = engine();
    let runtime = runtime();
    let mut app = App::new(&engine);
    engine.state.lock().unwrap().status = "running".into();
    app.editor.insert("/");
    app.key(key(KeyCode::Esc), &engine.snapshot(), &engine, &runtime);
    assert!(!app.palette_open());
    assert_eq!(engine.state.lock().unwrap().status, "running");
    app.key(
        key(KeyCode::Char('s')),
        &engine.snapshot(),
        &engine,
        &runtime,
    );
    assert!(app.palette_open());
    assert_eq!(app.command_candidates()[0].name, "status");
}
