//! Full-screen terminal client shared by harness backends.
pub(super) mod backend;
mod commands;
mod dsh;
mod editor;
mod questions;
mod view;

use super::create_engine;
use anyhow::{bail, Result};
use backend::{HarnessBackend, NativeBackend};
use crossterm::{
    cursor::{Hide, Show},
    event::{
        self, DisableBracketedPaste, DisableMouseCapture, EnableBracketedPaste, EnableMouseCapture,
        Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers, MouseEventKind,
    },
    execute,
    terminal::{disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen},
};
use editor::Editor;
use ratatui::{backend::CrosstermBackend, Terminal};
use serde_json::{json, Value};
use std::{
    io::{self, IsTerminal},
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant},
};

const MIN_WIDTH: u16 = 42;
const MIN_HEIGHT: u16 = 14;

#[derive(Clone)]
struct ModelRow {
    provider: String,
    id: String,
    unavailable: Option<String>,
}
#[derive(Clone)]
struct SessionRow {
    id: String,
    title: String,
    cwd: String,
}
#[derive(Default)]
enum Overlay {
    #[default]
    None,
    Models {
        query: Editor,
        selected: usize,
    },
    Help,
    Status,
    Logs,
    Diagnostics,
    Sessions {
        items: Vec<SessionRow>,
        selected: usize,
    },
    ReadOnly {
        title: &'static str,
        content: String,
    },
    New {
        confirm: bool,
    },
    Permission {
        preset: String,
        description: String,
        confirm: bool,
    },
}
#[derive(Default)]
struct App {
    editor: Editor,
    overlay: Overlay,
    notice: String,
    scroll: usize,
    max_scroll: usize,
    follow: bool,
    show_activity: bool,
    history: Vec<String>,
    history_index: Option<usize>,
    saved_draft: String,
    pending_id: Option<String>,
    pending_is_questions: bool,
    question_form: Option<questions::QuestionForm>,
    question_error: Option<String>,
    allow: bool,
    approval_scroll: u16,
    models: Vec<ModelRow>,
    detail_scroll: usize,
    detail_max_scroll: usize,
    detail_follow: bool,
    input_visible: bool,
    command_selected: usize,
    command_dismissed: Option<String>,
}
impl App {
    fn has_pending(&self) -> bool {
        self.pending_id.is_some() || self.pending_is_questions
    }
    fn new(providers: Value) -> Self {
        let mut models = Vec::new();
        for p in providers.as_array().into_iter().flatten() {
            for m in p["models"].as_array().into_iter().flatten() {
                models.push(ModelRow {
                    provider: p["id"].as_str().unwrap_or("").into(),
                    id: m["id"].as_str().unwrap_or("").into(),
                    unavailable: m["unavailable"].as_str().map(str::to_owned),
                });
            }
        }
        Self {
            follow: true,
            models,
            ..Self::default()
        }
    }
    fn set_size(&mut self, width: u16, height: u16) {
        self.input_visible = width >= MIN_WIDTH && height >= MIN_HEIGHT;
        if !self.input_visible {
            // A hidden dialog must not retain a previously selected confirmation.
            self.allow = false;
            if let Some(form) = &mut self.question_form {
                form.clear_answers();
            }
            if let Overlay::New { confirm } | Overlay::Permission { confirm, .. } =
                &mut self.overlay
            {
                *confirm = false;
            }
        }
    }
    fn guard_input_size(&mut self, width: u16, height: u16) {
        // Input may restrict visibility, but only a rendered frame may restore it.
        if width < MIN_WIDTH || height < MIN_HEIGHT {
            self.set_size(width, height);
        }
    }
    fn paste(&mut self, value: &str) {
        if !self.input_visible {
            return;
        }
        if self.has_pending() {
            if let Some(form) = &mut self.question_form {
                if !form.paste(value) {
                    self.notice = "自由入力は16KiB以内にしてください".into();
                }
            }
            return;
        }
        let inserted = match &mut self.overlay {
            Overlay::None => self.editor.insert(value),
            Overlay::Models { query, selected } => {
                let inserted = query.insert(value);
                if inserted {
                    *selected = 0;
                }
                inserted
            }
            _ => return,
        };
        if !inserted {
            self.notice = "貼り付けが上限16KiBを超えています".into();
        }
        self.command_selected = 0;
        self.command_dismissed = None;
    }
    fn sync_pending(&mut self, snapshot: &Value) {
        let is_questions = snapshot["pending"]["kind"] == "questions";
        let id = snapshot["pending"]["id"]
            .as_str()
            .filter(|id| {
                !is_questions
                    || (!id.trim().is_empty()
                        && id.len() <= 512
                        && !id.chars().any(char::is_control))
            })
            .map(str::to_owned);
        let changed = id != self.pending_id || is_questions != self.pending_is_questions;
        if changed {
            self.pending_id = id;
            self.pending_is_questions = is_questions;
            self.question_form = None;
            self.question_error = None;
            self.allow = false;
            self.approval_scroll = 0;
            if self.has_pending() {
                self.overlay = Overlay::None;
            }
        }
        if is_questions {
            if self.pending_id.is_none() {
                self.question_form = None;
                self.question_error = Some("質問要求IDが不正です。Escで中止してください".into());
                return;
            }
            let data = questions::data(&snapshot["pending"]);
            if self.question_form.as_ref().is_none_or(|f| !f.matches(data)) {
                match questions::QuestionForm::parse(data) {
                    Ok(form) => {
                        self.question_form = Some(form);
                        self.question_error = None;
                    }
                    Err(error) => {
                        self.question_form = None;
                        self.question_error = Some(error.to_string());
                    }
                }
            }
        }
    }
    fn open_details(&mut self, overlay: Overlay) {
        self.detail_scroll = 0;
        self.detail_max_scroll = 0;
        self.detail_follow = matches!(overlay, Overlay::Logs);
        self.overlay = overlay;
    }
    fn scroll_details(&mut self, delta: isize) {
        self.detail_scroll = self
            .detail_scroll
            .saturating_add_signed(delta)
            .min(self.detail_max_scroll);
        self.detail_follow = self.detail_scroll == self.detail_max_scroll;
    }
    fn filtered_models(&self) -> Vec<&ModelRow> {
        let query = match &self.overlay {
            Overlay::Models { query, .. } => query.text.to_lowercase(),
            _ => String::new(),
        };
        self.models
            .iter()
            .filter(|m| {
                format!("{} {}", m.provider, m.id)
                    .to_lowercase()
                    .contains(&query)
            })
            .collect()
    }
    fn call(&mut self, path: &str, body: Value, backend: &dyn HarnessBackend) -> bool {
        match backend.request(path, body) {
            Ok(_) => {
                self.notice.clear();
                true
            }
            Err(e) => {
                self.notice = backend.redact(&e.to_string());
                false
            }
        }
    }
    fn scroll_by(&mut self, delta: isize) {
        self.scroll = self
            .scroll
            .saturating_add_signed(delta)
            .min(self.max_scroll);
        self.follow = self.scroll == self.max_scroll;
    }
    fn history(&mut self, previous: bool) {
        if self.history.is_empty() || (self.history_index.is_none() && !previous) {
            return;
        }
        let index = match (self.history_index, previous) {
            (None, true) => {
                self.saved_draft = self.editor.text.clone();
                Some(self.history.len() - 1)
            }
            (Some(i), true) => Some(i.saturating_sub(1)),
            (Some(i), false) if i + 1 < self.history.len() => Some(i + 1),
            _ => None,
        };
        self.history_index = index;
        self.editor.text = index
            .map(|i| self.history[i].clone())
            .unwrap_or_else(|| self.saved_draft.clone());
        self.editor.cursor = self.editor.text.len();
    }
    fn submit(&mut self, backend: &dyn HarnessBackend) -> bool {
        let text = self.editor.text.trim().to_owned();
        if text.is_empty() {
            return false;
        }
        if let Some(command) = commands::parse(&text) {
            match command {
                Ok(command) => {
                    if let Some(quit) = self.execute_command(command, backend) {
                        self.editor.clear();
                        self.command_selected = 0;
                        self.command_dismissed = None;
                        return quit;
                    }
                }
                Err(error) => self.notice = error.to_string(),
            }
            return false;
        }
        let literal = if text.starts_with("//") {
            self.editor.text.replacen("//", "/", 1)
        } else {
            self.editor.text.clone()
        };
        let (path, body) = ("/api/message", json!({"text":literal}));
        if self.call(path, body, backend) {
            if path == "/api/message" {
                if self.history.len() == 100 {
                    self.history.remove(0);
                }
                self.history.push(self.editor.text.clone());
                self.history_index = None;
                self.saved_draft.clear();
            }
            self.editor.clear();
            self.follow = true;
        }
        false
    }
    /// Return true only for the explicit quit action. Approval uses the displayed ID.
    fn key(&mut self, key: KeyEvent, snapshot: &Value, backend: &dyn HarnessBackend) -> bool {
        if key.kind == KeyEventKind::Release {
            return false;
        }
        let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
        let busy = self.has_pending()
            || matches!(snapshot["status"].as_str(), Some("running" | "approval"));
        if ctrl && key.code == KeyCode::Char('q') {
            return true;
        }
        if ctrl && key.code == KeyCode::Char('c') {
            if busy {
                backend.cancel();
            } else {
                self.editor.clear();
            }
            return false;
        }
        if !self.input_visible {
            if key.code == KeyCode::Esc {
                if let Some(id) = self.pending_id.clone() {
                    self.call("/api/approval", json!({"id":id,"allow":false}), backend);
                } else {
                    if busy {
                        backend.cancel();
                    }
                    self.overlay = Overlay::None;
                }
            }
            return false;
        }
        if self.has_pending() {
            if self.pending_is_questions {
                if key.code == KeyCode::Esc {
                    if let Some(id) = self.pending_id.clone() {
                        self.call("/api/approval", json!({"id":id,"allow":false}), backend);
                    } else {
                        backend.cancel();
                    }
                } else if let Some(form) = &mut self.question_form {
                    match form.key(key) {
                        Ok(Some(answers)) => {
                            let latest = backend.snapshot();
                            if latest["pending"]["id"].as_str() != self.pending_id.as_deref()
                                || latest["pending"]["kind"] != "questions"
                                || !form.matches(questions::data(&latest["pending"]))
                            {
                                self.sync_pending(&latest);
                                self.notice =
                                    "質問が更新されました。内容を確認して回答し直してください"
                                        .into();
                            } else {
                                self.call(
                                    "/api/question",
                                    json!({"id":self.pending_id,"answers":answers}),
                                    backend,
                                );
                            }
                        }
                        Ok(None) => {}
                        Err(error) => self.notice = backend.redact(&error.to_string()),
                    }
                }
                return false;
            }
            match key.code {
                KeyCode::Tab | KeyCode::BackTab | KeyCode::Left | KeyCode::Right => {
                    self.allow = !self.allow
                }
                KeyCode::PageDown | KeyCode::Down => {
                    self.approval_scroll = self.approval_scroll.saturating_add(3)
                }
                KeyCode::PageUp | KeyCode::Up => {
                    self.approval_scroll = self.approval_scroll.saturating_sub(3)
                }
                KeyCode::Enter if key.kind == KeyEventKind::Press => {
                    if let Some(id) = self.pending_id.clone() {
                        self.call(
                            "/api/approval",
                            json!({"id":id,"allow":self.allow}),
                            backend,
                        );
                    }
                }
                KeyCode::Esc => {
                    if let Some(id) = self.pending_id.clone() {
                        self.call("/api/approval", json!({"id":id,"allow":false}), backend);
                    }
                }
                _ => {}
            }
            return false;
        }
        if matches!(self.overlay, Overlay::Permission { .. }) {
            let scrolled = match key.code {
                KeyCode::Up | KeyCode::PageUp => {
                    self.scroll_details(if key.code == KeyCode::Up { -1 } else { -8 });
                    true
                }
                KeyCode::Down | KeyCode::PageDown => {
                    self.scroll_details(if key.code == KeyCode::Down { 1 } else { 8 });
                    true
                }
                KeyCode::Home => {
                    self.detail_scroll = 0;
                    true
                }
                KeyCode::End => {
                    self.detail_scroll = self.detail_max_scroll;
                    true
                }
                _ => false,
            };
            if scrolled {
                return false;
            }
        }
        if let Overlay::Permission {
            preset, confirm, ..
        } = &mut self.overlay
        {
            match key.code {
                KeyCode::Tab | KeyCode::BackTab | KeyCode::Left | KeyCode::Right => {
                    *confirm = !*confirm
                }
                KeyCode::Esc => self.overlay = Overlay::None,
                KeyCode::Enter if key.kind == KeyEventKind::Press => {
                    let confirmed = *confirm;
                    let preset = preset.clone();
                    if !confirmed
                        || self.change_control(
                            "/api/permission",
                            json!({"preset":preset,"confirmed":true}),
                            backend,
                        )
                    {
                        self.overlay = Overlay::None;
                    } else if let Overlay::Permission { confirm, .. } = &mut self.overlay {
                        *confirm = false;
                    }
                }
                _ => {}
            }
            return false;
        }
        if let Overlay::New { confirm } = &mut self.overlay {
            match key.code {
                KeyCode::Tab | KeyCode::BackTab | KeyCode::Left | KeyCode::Right => {
                    *confirm = !*confirm
                }
                KeyCode::Esc => self.overlay = Overlay::None,
                KeyCode::Enter if key.kind == KeyEventKind::Press => {
                    let confirmed = *confirm;
                    if !confirmed || self.new_chat(backend) {
                        self.overlay = Overlay::None;
                    }
                }
                _ => {}
            }
            return false;
        }
        if matches!(
            self.overlay,
            Overlay::Help
                | Overlay::Status
                | Overlay::Logs
                | Overlay::Diagnostics
                | Overlay::ReadOnly { .. }
        ) {
            match key.code {
                KeyCode::Esc | KeyCode::F(1) | KeyCode::Enter => self.overlay = Overlay::None,
                KeyCode::Up | KeyCode::PageUp => {
                    self.scroll_details(if key.code == KeyCode::Up { -1 } else { -8 })
                }
                KeyCode::Down | KeyCode::PageDown => {
                    self.scroll_details(if key.code == KeyCode::Down { 1 } else { 8 })
                }
                KeyCode::Home => {
                    self.detail_scroll = 0;
                    self.detail_follow = false;
                }
                KeyCode::End => {
                    self.detail_scroll = self.detail_max_scroll;
                    self.detail_follow = true;
                }
                _ => {}
            }
            return false;
        }
        if let Overlay::Sessions { items, selected } = &mut self.overlay {
            match key.code {
                KeyCode::Up => *selected = selected.saturating_sub(1),
                KeyCode::Down => *selected = (*selected + 1).min(items.len().saturating_sub(1)),
                KeyCode::Home => *selected = 0,
                KeyCode::End => *selected = items.len().saturating_sub(1),
                KeyCode::Esc => self.overlay = Overlay::None,
                KeyCode::Enter if key.kind == KeyEventKind::Press => {
                    if let Some(row) = items.get(*selected).cloned() {
                        if self.call("/api/resume", json!({"sessionId":row.id}), backend) {
                            self.editor.clear();
                            self.history.clear();
                            self.history_index = None;
                            self.saved_draft.clear();
                            self.scroll = 0;
                            self.follow = true;
                            self.overlay = Overlay::None;
                        }
                    }
                }
                _ => {}
            }
            return false;
        }
        if matches!(self.overlay, Overlay::Models { .. }) {
            let count = self.filtered_models().len();
            if key.code == KeyCode::Enter {
                let selected = match &self.overlay {
                    Overlay::Models { selected, .. } => *selected,
                    _ => 0,
                };
                if let Some(row) = self
                    .filtered_models()
                    .get(selected.min(count.saturating_sub(1)))
                    .cloned()
                    .cloned()
                {
                    if let Some(reason) = row.unavailable {
                        self.notice = reason;
                    } else if self.call(
                        "/api/model",
                        json!({"provider":row.provider,"model":row.id}),
                        backend,
                    ) {
                        self.overlay = Overlay::None;
                    }
                }
            } else if key.code == KeyCode::Esc {
                self.overlay = Overlay::None;
                self.notice.clear();
            } else if let Overlay::Models { query, selected } = &mut self.overlay {
                match key.code {
                    KeyCode::Up => *selected = selected.saturating_sub(1),
                    KeyCode::Down => *selected = (*selected + 1).min(count.saturating_sub(1)),
                    _ => {
                        edit(query, key);
                        *selected = 0;
                    }
                }
            }
            return false;
        }
        if let Some(quit) = self.command_key(key, backend) {
            return quit;
        }
        match key.code {
            KeyCode::F(1) => self.open_details(Overlay::Help),
            KeyCode::F(2) => {
                if busy {
                    self.notice = "実行を中止してからモデルを変更してください（Esc）".into();
                } else {
                    self.overlay = Overlay::Models {
                        query: Editor::default(),
                        selected: 0,
                    };
                }
            }
            KeyCode::F(3) => self.show_activity = !self.show_activity,
            KeyCode::PageUp => self.scroll_by(-8),
            KeyCode::PageDown => self.scroll_by(8),
            KeyCode::End if ctrl => {
                self.follow = true;
                self.scroll = self.max_scroll;
            }
            KeyCode::Home if ctrl => {
                self.follow = false;
                self.scroll = 0;
            }
            KeyCode::Char('p') if ctrl => self.history(true),
            KeyCode::Char('n') if ctrl => self.history(false),
            KeyCode::Esc => {
                if busy {
                    backend.cancel();
                }
                self.notice.clear();
            }
            KeyCode::Enter
                if key
                    .modifiers
                    .intersects(KeyModifiers::ALT | KeyModifiers::SHIFT) =>
            {
                self.editor.insert("\n");
            }
            KeyCode::Enter if key.kind == KeyEventKind::Press => return self.submit(backend),
            _ => {
                let before = self.editor.text.clone();
                if !edit(&mut self.editor, key) {
                    self.notice = "入力は16KiB以内にしてください".into();
                }
                if self.editor.text != before {
                    self.command_selected = 0;
                    self.command_dismissed = None;
                }
            }
        }
        false
    }
}
fn edit(editor: &mut Editor, key: KeyEvent) -> bool {
    let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
    match key.code {
        KeyCode::Char('j') if ctrl => return editor.insert("\n"),
        KeyCode::Char('u') if ctrl => editor.clear(),
        KeyCode::Char(c) if !ctrl && !key.modifiers.contains(KeyModifiers::ALT) => {
            return editor.insert(&c.to_string())
        }
        KeyCode::Left => editor.left(),
        KeyCode::Right => editor.right(),
        KeyCode::Up => editor.vertical(false),
        KeyCode::Down => editor.vertical(true),
        KeyCode::Home => editor.home(),
        KeyCode::End => editor.end(),
        KeyCode::Backspace => editor.backspace(),
        KeyCode::Delete => editor.delete(),
        _ => {}
    }
    true
}
fn restore_terminal() {
    let _ = disable_raw_mode();
    let _ = execute!(
        io::stdout(),
        DisableBracketedPaste,
        DisableMouseCapture,
        Show,
        LeaveAlternateScreen
    );
}
struct Screen;
impl Screen {
    fn enter() -> Result<Self> {
        enable_raw_mode()?;
        let guard = Self;
        execute!(
            io::stdout(),
            EnterAlternateScreen,
            EnableBracketedPaste,
            EnableMouseCapture,
            Hide
        )?;
        Ok(guard)
    }
}
impl Drop for Screen {
    fn drop(&mut self) {
        restore_terminal();
    }
}

#[allow(clippy::too_many_arguments)]
pub fn cmd_native_tui(
    mode: String,
    workspace: PathBuf,
    sdk_dir: Option<PathBuf>,
    dsh_profile: Option<String>,
    dsh_catalog: Option<PathBuf>,
    devin: Option<PathBuf>,
    provider: Option<String>,
    model: Option<String>,
    locale: crate::locale::Locale,
) -> Result<()> {
    if !io::stdin().is_terminal() || !io::stdout().is_terminal() {
        bail!("native-tui requires an interactive terminal");
    }
    let backend: Box<dyn HarnessBackend> = if mode == "dsh" {
        if sdk_dir.is_some() || dsh_catalog.is_some() || devin.is_some() {
            bail!("DSHモードでは --sdk-dir / --dsh-catalog / --devin-bin を使えません。既存DSHプロファイルの設定を使用します");
        }
        let backend =
            dsh::DshBackend::start(workspace, dsh_profile.as_deref().unwrap_or("web"), locale)?;
        if let (Some(provider), Some(model)) = (provider, model) {
            backend.request("/api/model", json!({"provider":provider,"model":model}))?;
        }
        Box::new(backend)
    } else {
        let engine = create_engine(workspace, sdk_dir, dsh_profile, dsh_catalog, devin)?;
        let runtime = Arc::new(
            tokio::runtime::Builder::new_multi_thread()
                .worker_threads(2)
                .enable_all()
                .build()?,
        );
        let backend = NativeBackend::new(engine, runtime);
        backend.request("/api/model", json!({"provider":provider.unwrap_or_else(||"cursor-sdk".into()),"model":model.unwrap_or_else(||"composer-2.5".into())}))?;
        Box::new(backend)
    };
    crate::shutdown::install(locale)?;
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        restore_terminal();
        previous(info);
    }));
    let result = run_screen(backend.as_ref());
    backend.cancel();
    result
}
pub(super) fn run_screen(backend: &dyn HarnessBackend) -> Result<()> {
    let _screen = Screen::enter()?;
    let mut terminal = Terminal::new(CrosstermBackend::new(io::stdout()))?;
    terminal.clear()?;
    let mut app = App::new(backend.snapshot()["providers"].clone());
    let started = Instant::now();
    while !crate::shutdown::requested() {
        let snapshot = backend.snapshot();
        app.sync_pending(&snapshot);
        terminal.draw(|frame| view::draw(frame, &mut app, &snapshot, started.elapsed()))?;
        if !event::poll(Duration::from_millis(100))? {
            continue;
        }
        let input = event::read()?;
        // Recheck the actual size at input time as well as at draw time: a key
        // may already be queued when the terminal shrinks after the last frame.
        let size = terminal.size()?;
        app.guard_input_size(size.width, size.height);
        match input {
            Event::Key(key) => {
                if app.key(key, &snapshot, backend) {
                    break;
                }
            }
            Event::Paste(value) => app.paste(&value),
            Event::Resize(width, height) => app.guard_input_size(width, height),
            Event::Mouse(mouse) if app.pending_is_questions => {
                if let Some(form) = &mut app.question_form {
                    let delta = match mouse.kind {
                        MouseEventKind::ScrollUp => -3,
                        MouseEventKind::ScrollDown => 3,
                        _ => 0,
                    };
                    form.scroll = form
                        .scroll
                        .saturating_add_signed(delta)
                        .min(form.max_scroll);
                    form.follow_focus = false;
                }
            }
            Event::Mouse(mouse) => match mouse.kind {
                MouseEventKind::ScrollUp
                    if matches!(
                        app.overlay,
                        Overlay::Status
                            | Overlay::Logs
                            | Overlay::Diagnostics
                            | Overlay::ReadOnly { .. }
                    ) =>
                {
                    app.scroll_details(-3)
                }
                MouseEventKind::ScrollDown
                    if matches!(
                        app.overlay,
                        Overlay::Status
                            | Overlay::Logs
                            | Overlay::Diagnostics
                            | Overlay::ReadOnly { .. }
                    ) =>
                {
                    app.scroll_details(3)
                }
                MouseEventKind::ScrollUp => app.scroll_by(-3),
                MouseEventKind::ScrollDown => app.scroll_by(3),
                _ => {}
            },
            _ => {}
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests;
