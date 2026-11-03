//! Full-screen terminal client of the Rust engine; no DSH runtime or HTTP server.
mod commands;
mod editor;
mod view;

use super::{create_engine, dispatch, engine::Engine};
use anyhow::{bail, Result};
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
use tokio::runtime::Runtime;

#[derive(Clone)]
struct ModelRow {
    provider: String,
    id: String,
    unavailable: Option<String>,
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
    New {
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
    allow: bool,
    approval_scroll: u16,
    models: Vec<ModelRow>,
    command_selected: usize,
    command_dismissed: Option<String>,
}
impl App {
    fn new(engine: &Engine) -> Self {
        let mut models = Vec::new();
        for p in engine.providers().as_array().into_iter().flatten() {
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
    fn sync_pending(&mut self, snapshot: &Value) {
        let id = snapshot["pending"]["id"].as_str().map(str::to_owned);
        if id != self.pending_id {
            self.pending_id = id;
            self.allow = false;
            self.approval_scroll = 0;
            if self.pending_id.is_some() {
                self.overlay = Overlay::None;
            }
        }
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
    fn call(
        &mut self,
        path: &str,
        body: Value,
        engine: &Arc<Engine>,
        runtime: &Arc<Runtime>,
    ) -> bool {
        match dispatch(
            "POST",
            path,
            &body.to_string(),
            engine.clone(),
            runtime.clone(),
        ) {
            Ok(_) => {
                self.notice.clear();
                true
            }
            Err(e) => {
                self.notice = engine.redact(&e.to_string());
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
        if self.history.is_empty() {
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
    fn submit(&mut self, engine: &Arc<Engine>, runtime: &Arc<Runtime>) -> bool {
        let text = self.editor.text.trim().to_owned();
        if text.is_empty() {
            return false;
        }
        if let Some(command) = commands::parse(&text) {
            match command {
                Ok(command) => {
                    if let Some(quit) = self.execute_command(command, engine, runtime) {
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
        if self.call(path, body, engine, runtime) {
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
    fn key(
        &mut self,
        key: KeyEvent,
        snapshot: &Value,
        engine: &Arc<Engine>,
        runtime: &Arc<Runtime>,
    ) -> bool {
        if key.kind == KeyEventKind::Release {
            return false;
        }
        let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
        let busy = matches!(snapshot["status"].as_str(), Some("running" | "approval"));
        if ctrl && key.code == KeyCode::Char('q') {
            return true;
        }
        if ctrl && key.code == KeyCode::Char('c') {
            if busy {
                engine.cancel();
            } else {
                self.editor.clear();
            }
            return false;
        }
        if self.pending_id.is_some() {
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
                            engine,
                            runtime,
                        );
                    }
                }
                KeyCode::Esc => {
                    if let Some(id) = self.pending_id.clone() {
                        self.call(
                            "/api/approval",
                            json!({"id":id,"allow":false}),
                            engine,
                            runtime,
                        );
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
                    if !confirmed || self.new_chat(engine) {
                        self.overlay = Overlay::None;
                    }
                }
                _ => {}
            }
            return false;
        }
        if matches!(
            self.overlay,
            Overlay::Help | Overlay::Status | Overlay::Logs
        ) {
            if matches!(key.code, KeyCode::Esc | KeyCode::F(1) | KeyCode::Enter) {
                self.overlay = Overlay::None;
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
                if let Some(row) = self.filtered_models().get(selected).cloned().cloned() {
                    if let Some(reason) = row.unavailable {
                        self.notice = reason;
                    } else if self.call(
                        "/api/model",
                        json!({"provider":row.provider,"model":row.id}),
                        engine,
                        runtime,
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
        if let Some(quit) = self.command_key(key, engine, runtime) {
            return quit;
        }
        match key.code {
            KeyCode::F(1) => self.overlay = Overlay::Help,
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
                    engine.cancel();
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
            KeyCode::Enter if key.kind == KeyEventKind::Press => {
                return self.submit(engine, runtime)
            }
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
    workspace: PathBuf,
    sdk_dir: Option<PathBuf>,
    dsh_profile: Option<String>,
    dsh_catalog: Option<PathBuf>,
    devin: Option<PathBuf>,
    provider: String,
    model: String,
    locale: crate::locale::Locale,
) -> Result<()> {
    if !io::stdin().is_terminal() || !io::stdout().is_terminal() {
        bail!("native-tui requires an interactive terminal");
    }
    let engine = create_engine(workspace, sdk_dir, dsh_profile, dsh_catalog, devin)?;
    let runtime = Arc::new(
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()?,
    );
    dispatch(
        "POST",
        "/api/model",
        &json!({"provider":provider,"model":model}).to_string(),
        engine.clone(),
        runtime.clone(),
    )?;
    crate::shutdown::install(locale)?;
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        restore_terminal();
        previous(info);
    }));
    let result = run_screen(&engine, &runtime);
    engine.cancel();
    result
}
fn run_screen(engine: &Arc<Engine>, runtime: &Arc<Runtime>) -> Result<()> {
    let _screen = Screen::enter()?;
    let mut terminal = Terminal::new(CrosstermBackend::new(io::stdout()))?;
    terminal.clear()?;
    let mut app = App::new(engine);
    let started = Instant::now();
    while !crate::shutdown::requested() {
        let snapshot = engine.snapshot();
        app.sync_pending(&snapshot);
        terminal.draw(|frame| view::draw(frame, &mut app, &snapshot, started.elapsed()))?;
        if !event::poll(Duration::from_millis(100))? {
            continue;
        }
        match event::read()? {
            Event::Key(key) => {
                if app.key(key, &snapshot, engine, runtime) {
                    break;
                }
            }
            Event::Paste(value) => {
                if app.pending_id.is_some() {
                    continue;
                }
                let target = match &mut app.overlay {
                    Overlay::None => &mut app.editor,
                    Overlay::Models { query, .. } => query,
                    _ => continue,
                };
                if !target.insert(&value) {
                    app.notice = "貼り付けが上限16KiBを超えています".into();
                }
                app.command_selected = 0;
                app.command_dismissed = None;
            }
            Event::Mouse(mouse) => match mouse.kind {
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
