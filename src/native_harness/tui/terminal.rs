//! An attached DSH terminal rendered into cells, never into the outer terminal.
use super::{backend::HarnessBackend, editor};
use anyhow::{bail, Context, Result};
use crossterm::event::{KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
use ratatui::{
    layout::{Constraint, Direction, Layout, Rect},
    style::{Color, Modifier, Style},
    widgets::{Block, Borders, Clear, Paragraph},
    Frame,
};
use serde_json::{json, Value};
use std::time::{Duration, Instant};

enum Phase {
    Confirm(bool),
    Creating(String),
    Following(String),
    Failed,
    Closed,
}
pub(super) struct Pane {
    session: String,
    id: Option<String>,
    owned: bool,
    attachment: String,
    phase: Phase,
    parser: vt100::Parser,
    cols: u16,
    rows: u16,
    info: Value,
    event_sequence: u64,
    terminal_sequence: Option<u64>,
    dropped: u64,
    next_poll: Instant,
    control_job: Option<String>,
    write_queue: String,
    resize_pending: bool,
    notice: String,
}

fn viewport(cols: u16, rows: u16) -> (u16, u16) {
    (
        cols.saturating_sub(4).clamp(2, 500),
        rows.saturating_sub(8).clamp(1, 200),
    )
}
fn start(backend: &dyn HarnessBackend, id: &str, args: Value) -> Result<String> {
    let value = backend.request(
        "/api/admin/start",
        json!({"id":id,"args":args,"confirmed":true}),
    )?;
    value["jobId"]
        .as_str()
        .filter(|s| {
            !s.is_empty()
                && s.len() <= 256
                && s.bytes()
                    .all(|c| c.is_ascii_alphanumeric() || b"_-".contains(&c))
        })
        .map(str::to_owned)
        .context("端末操作のjob IDが不正です")
}
fn job(backend: &dyn HarnessBackend, id: &str) -> Result<Value> {
    backend.request(&format!("/api/admin/job?id={id}"), json!({"jobId":id}))
}
fn failure(backend: &dyn HarnessBackend, value: &Value) -> String {
    backend.redact(
        value["error"]
            .as_str()
            .unwrap_or("端末操作が完了しませんでした"),
    )
}
fn active(value: &Value) -> bool {
    matches!(value["status"].as_str(), Some("running" | "cancelling"))
}

impl Pane {
    pub(super) fn new(session_id: String, existing_id: Option<String>) -> Self {
        Self {
            session: session_id,
            owned: existing_id.is_none(),
            id: existing_id,
            attachment: String::new(),
            phase: Phase::Confirm(false),
            parser: vt100::Parser::new(24, 80, 5000),
            cols: 80,
            rows: 24,
            info: Value::Null,
            event_sequence: 0,
            terminal_sequence: None,
            dropped: 0,
            next_poll: Instant::now(),
            control_job: None,
            write_queue: String::new(),
            resize_pending: false,
            notice: String::new(),
        }
    }
    pub(super) fn clear_confirmation(&mut self) {
        if let Phase::Confirm(value) = &mut self.phase {
            *value = false;
        }
    }
    pub(super) fn is_closed(&self) -> bool {
        matches!(self.phase, Phase::Closed)
            || matches!(self.info["state"].as_str(), Some("exited" | "failed"))
    }
    fn create(&mut self, backend: &dyn HarnessBackend) -> Result<()> {
        if self.id.is_some() {
            return self.follow(backend);
        }
        let id = format!("rdsh-{}", crate::local_http::random_token()?);
        let job = start(
            backend,
            "terminal/create",
            json!({"agentId":self.session,
            "request":{"id":id,"cols":self.cols,"rows":self.rows}}),
        )?;
        self.id = Some(id);
        self.phase = Phase::Creating(job);
        self.next_poll = Instant::now();
        self.notice = "ワークスペースの端末を準備中".into();
        Ok(())
    }
    fn follow(&mut self, backend: &dyn HarnessBackend) -> Result<()> {
        let id = self.id.as_ref().context("端末IDがありません")?;
        let attachment = crate::local_http::random_token()?;
        let next = start(
            backend,
            "terminal/follow",
            json!({"agentId":self.session,
            "id":id,"attachmentId":attachment}),
        )?;
        // A replacement attachment will receive fresh ownership metadata in its
        // snapshot. The previous attachment was ours, not another operator's.
        if self.info["controllerId"].as_str() == Some(self.attachment.as_str()) {
            self.info["controllerId"] = Value::Null;
        }
        self.attachment = attachment;
        self.phase = Phase::Following(next);
        self.next_poll = Instant::now();
        self.event_sequence = 0;
        self.terminal_sequence = None;
        self.dropped = 0;
        // Keep only unsent input while create/follow prepares the screen. A
        // submitted write was already taken out of this queue; never replay it.
        self.resize_pending = true;
        self.notice = "端末の画面を取得中".into();
        Ok(())
    }
    pub(super) fn resize(&mut self, cols: u16, rows: u16, _backend: &dyn HarnessBackend) {
        if cols < super::MIN_WIDTH || rows < super::MIN_HEIGHT {
            self.clear_confirmation();
            return;
        }
        let (cols, rows) = viewport(cols, rows);
        if (cols, rows) != (self.cols, self.rows) {
            self.cols = cols;
            self.rows = rows;
            self.parser.set_size(rows, cols);
            if matches!(self.phase, Phase::Following(_)) {
                self.resize_pending = true;
            }
        }
    }
    fn args(&self) -> Value {
        json!({"agentId":self.session,"id":self.id,"attachmentId":self.attachment})
    }
    fn writable(&self) -> bool {
        matches!(self.phase, Phase::Following(_))
            && self.terminal_sequence.is_some()
            && self.info["state"] == "running"
            && self.info["controllerId"]
                .as_str()
                .is_none_or(|id| id == self.attachment)
    }
    fn enqueue(&mut self, data: &str) -> Result<()> {
        if !matches!(self.phase, Phase::Creating(_) | Phase::Following(_))
            || matches!(self.info["state"].as_str(), Some("exited" | "failed"))
            || self.info["controllerId"]
                .as_str()
                .is_some_and(|id| id != self.attachment)
        {
            bail!("この端末へ入力できません（未確認・終了済み・他の画面が操作中）");
        }
        if self.write_queue.len() + data.len() > 16 * 1024 {
            bail!("端末入力は16KiB以内にしてください");
        }
        self.parser.set_scrollback(0);
        self.write_queue.push_str(data);
        Ok(())
    }
    pub(super) fn paste(&mut self, value: &str, _backend: &dyn HarnessBackend) -> Result<()> {
        // Pasted controls cannot impersonate key presses or terminate bracketed paste.
        let value: String = value
            .replace("\r\n", "\n")
            .replace('\r', "\n")
            .chars()
            .filter(|c| !c.is_control() || matches!(c, '\n' | '\t'))
            .collect();
        let value = if self.parser.screen().bracketed_paste() {
            format!("\x1b[200~{value}\x1b[201~")
        } else {
            value
        };
        self.enqueue(&value)
    }
    pub(super) fn key(&mut self, key: KeyEvent, backend: &dyn HarnessBackend) -> Result<bool> {
        if key.kind == KeyEventKind::Release {
            return Ok(false);
        }
        let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
        // Legacy terminals send GS (0x1d) for Ctrl+]. Crossterm 0.28 decodes
        // that byte as Ctrl+5; enhanced keyboard reports Ctrl+] directly.
        if ctrl && matches!(key.code, KeyCode::Char(']' | '5')) {
            return Ok(true);
        }
        if let Phase::Confirm(confirm) = &mut self.phase {
            match key.code {
                KeyCode::Esc => {
                    *confirm = false;
                    return Ok(true);
                }
                KeyCode::Tab | KeyCode::BackTab | KeyCode::Left | KeyCode::Right => {
                    *confirm = !*confirm
                }
                KeyCode::Enter if key.kind == KeyEventKind::Press => {
                    if !*confirm {
                        return Ok(true);
                    }
                    *confirm = false;
                    if let Err(error) = self.create(backend) {
                        self.notice = backend.redact(&error.to_string());
                        return Err(error);
                    }
                }
                _ => {}
            }
            return Ok(false);
        }
        if ctrl && key.code == KeyCode::Char('r') && matches!(self.phase, Phase::Failed) {
            self.follow(backend)?;
            return Ok(false);
        }
        if key.modifiers.contains(KeyModifiers::SHIFT)
            && matches!(key.code, KeyCode::PageUp | KeyCode::PageDown)
        {
            let offset = self.parser.screen().scrollback();
            self.parser.set_scrollback(if key.code == KeyCode::PageUp {
                offset.saturating_add(self.rows as usize / 2)
            } else {
                offset.saturating_sub(self.rows as usize / 2)
            });
            return Ok(false);
        }
        if let Some(data) = key_bytes(key, self.parser.screen().application_cursor()) {
            if let Err(error) = self.enqueue(&data) {
                self.notice = backend.redact(&error.to_string());
                return Err(error);
            }
        }
        Ok(false)
    }
    fn apply_frame(&mut self, frame: &Value) -> Result<()> {
        match frame["type"].as_str() {
            Some("snapshot") => {
                let sequence = frame["sequence"]
                    .as_u64()
                    .context("端末snapshotのsequenceが不正です")?;
                if self
                    .terminal_sequence
                    .is_some_and(|previous| sequence < previous)
                {
                    return Ok(());
                }
                let screen = frame["screen"].as_str().context("端末snapshotが不正です")?;
                let cols = frame["info"]["cols"]
                    .as_u64()
                    .unwrap_or(self.cols.into())
                    .clamp(2, 500) as u16;
                let rows = frame["info"]["rows"]
                    .as_u64()
                    .unwrap_or(self.rows.into())
                    .clamp(1, 200) as u16;
                self.parser = vt100::Parser::new(rows, cols, 5000);
                self.parser.process(screen.as_bytes());
                self.terminal_sequence = Some(sequence);
                self.info = frame["info"].clone();
                self.notice.clear();
            }
            Some("output") => {
                let sequence = frame["sequence"]
                    .as_u64()
                    .context("端末outputのsequenceが不正です")?;
                let previous = self
                    .terminal_sequence
                    .context("端末snapshotが届いていません")?;
                if sequence <= previous {
                    return Ok(());
                }
                if sequence != previous + 1 {
                    bail!("端末出力に欠落があります");
                }
                self.parser.process(
                    frame["data"]
                        .as_str()
                        .context("端末outputが不正です")?
                        .as_bytes(),
                );
                self.terminal_sequence = Some(sequence);
            }
            Some("state") => self.info = frame["info"].clone(),
            _ => bail!("未対応の端末フレームです"),
        }
        Ok(())
    }
    fn refresh_snapshot(&mut self, backend: &dyn HarnessBackend) -> Result<()> {
        if let Phase::Following(id) = &self.phase {
            backend.request("/api/admin/cancel", json!({"jobId":id}))?;
        }
        self.follow(backend)?;
        self.notice = "出力の欠落を検出したため、現在の画面を再取得しています".into();
        Ok(())
    }
    fn update(&mut self, backend: &dyn HarnessBackend) -> Result<()> {
        if let Phase::Creating(id) = &self.phase {
            let value = job(backend, id)?;
            if active(&value) {
                return Ok(());
            }
            if value["status"] != "complete" {
                bail!("{}", failure(backend, &value));
            }
            let id = value["result"]["id"]
                .as_str()
                .context("端末作成の応答が不正です")?;
            if self.id.as_deref() != Some(id) {
                bail!("端末作成の応答IDが一致しません");
            }
            self.info = value["result"].clone();
            return self.follow(backend);
        }
        let Phase::Following(id) = &self.phase else {
            return Ok(());
        };
        let value = job(backend, id)?;
        let dropped = value["droppedEvents"].as_u64().unwrap_or(0);
        if dropped > self.dropped && self.event_sequence < dropped {
            return self.refresh_snapshot(backend);
        }
        self.dropped = dropped;
        for event in value["events"].as_array().into_iter().flatten() {
            let sequence = event["sequence"]
                .as_u64()
                .context("端末jobのsequenceが不正です")?;
            if sequence <= self.event_sequence {
                continue;
            }
            if sequence > self.event_sequence + 1 || self.apply_frame(&event["value"]).is_err() {
                return self.refresh_snapshot(backend);
            }
            self.event_sequence = sequence;
        }
        if !active(&value) {
            if value["status"] != "complete" {
                bail!("{}", failure(backend, &value));
            }
            self.phase = Phase::Closed;
            self.notice = "端末出力が終了しました".into();
            return Ok(());
        }
        if let Some(id) = &self.control_job {
            let value = job(backend, id)?;
            if active(&value) {
                return Ok(());
            }
            self.control_job = None;
            if value["status"] != "complete" {
                self.notice = failure(backend, &value);
            }
        }
        if self.writable() && self.control_job.is_none() {
            if self.resize_pending {
                let mut args = self.args();
                args["cols"] = json!(self.cols);
                args["rows"] = json!(self.rows);
                self.control_job = Some(start(backend, "terminal/resize", args)?);
                self.parser.set_size(self.rows, self.cols);
                self.resize_pending = false;
            } else if !self.write_queue.is_empty() {
                let mut args = self.args();
                // Preserve ordering; never retry a write after an ambiguous failure.
                args["data"] = json!(std::mem::take(&mut self.write_queue));
                self.control_job = Some(start(backend, "terminal/write", args)?);
            }
        }
        Ok(())
    }
    pub(super) fn poll(&mut self, backend: &dyn HarnessBackend) {
        if Instant::now() < self.next_poll
            || !matches!(self.phase, Phase::Creating(_) | Phase::Following(_))
        {
            return;
        }
        self.next_poll = Instant::now() + Duration::from_millis(100);
        if let Err(error) = self.update(backend) {
            self.notice = backend.redact(&error.to_string());
            if let Phase::Following(id) = &self.phase {
                let _ = backend.request("/api/admin/cancel", json!({"jobId":id}));
            }
            self.phase = Phase::Failed;
            self.write_queue.clear();
        }
    }
    pub(super) fn cancel(&mut self, backend: &dyn HarnessBackend) {
        if matches!(self.phase, Phase::Confirm(_)) {
            return;
        }
        if let Phase::Following(id) | Phase::Creating(id) = &self.phase {
            let _ = backend.request("/api/admin/cancel", json!({"jobId":id}));
        }
        if self.owned {
            if let Some(id) = &self.id {
                if let Ok(close) = start(
                    backend,
                    "terminal/close",
                    json!({"agentId":self.session,"id":id}),
                ) {
                    // The host is about to shut down: give close its acknowledgement.
                    let deadline = Instant::now() + Duration::from_secs(2);
                    while Instant::now() < deadline {
                        match job(backend, &close) {
                            Ok(value) if active(&value) => {
                                std::thread::sleep(Duration::from_millis(20))
                            }
                            _ => break,
                        }
                    }
                }
            }
        }
        self.owned = false;
        self.phase = Phase::Closed;
        self.write_queue.clear();
    }
    pub(super) fn draw(&mut self, frame: &mut Frame, area: Rect) {
        let area = Rect::new(
            area.x + 1,
            area.y + 1,
            area.width.saturating_sub(2),
            area.height.saturating_sub(2),
        );
        frame.render_widget(Clear, area);
        let border = Block::default()
            .borders(Borders::ALL)
            .title(" DSH 端末 ")
            .border_style(Style::default().fg(Color::Cyan));
        let inner = border.inner(area);
        frame.render_widget(border, area);
        let rows = Layout::default()
            .direction(Direction::Vertical)
            .constraints([
                Constraint::Length(2),
                Constraint::Min(1),
                Constraint::Length(2),
            ])
            .split(inner);
        if let Phase::Confirm(confirm) = self.phase {
            frame.render_widget(
                Paragraph::new(if self.owned {
                    "ワークスペースにシェルを起動します"
                } else {
                    "既存の端末へ接続し、入力とサイズ変更の操作権を取得します"
                }),
                rows[0],
            );
            frame.render_widget(
                Paragraph::new(editor::clean(&format!(
                    "セッション: {}\n端末: {}\n\n端末への入力はシェルで実行されます。\n{}",
                    self.session,
                    self.id.as_deref().unwrap_or("新規"),
                    self.notice
                ))),
                rows[1],
            );
            frame.render_widget(
                Paragraph::new(if confirm {
                    "  戻る      ▶ 接続する\nTab 選択 · Enter 決定 · Esc 戻る"
                } else {
                    "▶ 戻る        接続する\nTab 選択 · Enter 決定 · Esc 戻る"
                })
                .style(Style::default().fg(Color::Yellow)),
                rows[2],
            );
            return;
        }
        let state = if self.writable() {
            "running"
        } else if matches!(self.phase, Phase::Failed) {
            "接続失敗"
        } else if matches!(self.info["state"].as_str(), Some("exited" | "failed")) {
            self.info["state"].as_str().unwrap()
        } else if self.info["controllerId"]
            .as_str()
            .is_some_and(|id| id != self.attachment)
        {
            "読み取り専用"
        } else {
            "接続準備中"
        };
        frame.render_widget(
            Paragraph::new(editor::clean(&format!(
                "{state} · {}\n{}",
                self.id.as_deref().unwrap_or("端末"),
                self.notice
            ))),
            rows[0],
        );
        let screen = self.parser.screen();
        for y in 0..rows[1].height {
            for x in 0..rows[1].width {
                if let Some(cell) = screen.cell(y, x) {
                    if cell.is_wide_continuation() {
                        continue;
                    }
                    let contents = cell.contents();
                    let symbol = if contents.is_empty() { " " } else { &contents };
                    let mut style = Style::default()
                        .fg(color(cell.fgcolor()))
                        .bg(color(cell.bgcolor()));
                    if cell.bold() {
                        style = style.add_modifier(Modifier::BOLD);
                    }
                    if cell.italic() {
                        style = style.add_modifier(Modifier::ITALIC);
                    }
                    if cell.underline() {
                        style = style.add_modifier(Modifier::UNDERLINED);
                    }
                    if cell.inverse() {
                        style = style.add_modifier(Modifier::REVERSED);
                    }
                    frame.buffer_mut()[(rows[1].x + x, rows[1].y + y)]
                        .set_symbol(symbol)
                        .set_style(style);
                }
            }
        }
        if self.writable() && !screen.hide_cursor() && screen.scrollback() == 0 {
            let (y, x) = screen.cursor_position();
            if x < rows[1].width && y < rows[1].height {
                frame.set_cursor_position((rows[1].x + x, rows[1].y + y));
            }
        }
        frame.render_widget(
            Paragraph::new(if matches!(self.phase, Phase::Failed) {
                "接続が停止しました · Ctrl+R 再接続\nCtrl+] 閉じる · Ctrl+Q 終了"
            } else {
                "Ctrl+] 閉じる · Ctrl+C シェルへ送信\nShift+PgUp/Dn 履歴 · Ctrl+Q 終了"
            }),
            rows[2],
        );
    }
}

fn color(value: vt100::Color) -> Color {
    match value {
        vt100::Color::Default => Color::Reset,
        vt100::Color::Idx(i) => Color::Indexed(i),
        vt100::Color::Rgb(r, g, b) => Color::Rgb(r, g, b),
    }
}
fn key_bytes(key: KeyEvent, application: bool) -> Option<String> {
    let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
    let alt = key.modifiers.contains(KeyModifiers::ALT);
    let shift = key.modifiers.contains(KeyModifiers::SHIFT);
    let modifier = 1 + u8::from(shift) + 2 * u8::from(alt) + 4 * u8::from(ctrl);
    let arrow = |suffix| {
        if modifier > 1 {
            format!("\x1b[1;{modifier}{suffix}")
        } else if application {
            format!("\x1bO{suffix}")
        } else {
            format!("\x1b[{suffix}")
        }
    };
    let data = match key.code {
        KeyCode::Char(c) if ctrl && c.is_ascii() => {
            let byte = match c {
                ' ' | '@' => 0,
                '?' => 127,
                _ => (c.to_ascii_uppercase() as u8) & 31,
            };
            char::from(byte).to_string()
        }
        KeyCode::Char(c) => c.to_string(),
        KeyCode::Enter => "\r".into(),
        KeyCode::Backspace => "\x7f".into(),
        KeyCode::Tab => "\t".into(),
        KeyCode::BackTab => "\x1b[Z".into(),
        KeyCode::Esc => "\x1b".into(),
        KeyCode::Up => return Some(arrow('A')),
        KeyCode::Down => return Some(arrow('B')),
        KeyCode::Right => return Some(arrow('C')),
        KeyCode::Left => return Some(arrow('D')),
        KeyCode::Home => return Some(arrow('H')),
        KeyCode::End => return Some(arrow('F')),
        KeyCode::Delete => "\x1b[3~".into(),
        KeyCode::Insert => "\x1b[2~".into(),
        KeyCode::PageUp => "\x1b[5~".into(),
        KeyCode::PageDown => "\x1b[6~".into(),
        KeyCode::F(n @ 1..=4) => format!("\x1bO{}", char::from(b'P' + n - 1)),
        KeyCode::F(n @ 5..=12) => format!(
            "\x1b[{}~",
            [15, 17, 18, 19, 20, 21, 23, 24][(n - 5) as usize]
        ),
        _ => return None,
    };
    Some(if alt { format!("\x1b{data}") } else { data })
}

#[cfg(test)]
mod tests {
    use super::*;
    use ratatui::{backend::TestBackend, Terminal};
    use std::{collections::HashMap, sync::Mutex};
    struct Mock {
        calls: Mutex<Vec<(String, Value)>>,
        jobs: Mutex<HashMap<String, Value>>,
    }
    impl Default for Mock {
        fn default() -> Self {
            Self {
                calls: Mutex::new(vec![]),
                jobs: Mutex::new(HashMap::new()),
            }
        }
    }
    impl HarnessBackend for Mock {
        fn snapshot(&self) -> Value {
            json!({"backend":"dsh","status":"idle","sessionId":"session"})
        }
        fn request(&self, path: &str, body: Value) -> Result<Value> {
            self.calls.lock().unwrap().push((path.into(), body.clone()));
            match path {
                "/api/admin/start" => {
                    let mut jobs = self.jobs.lock().unwrap();
                    let id = format!("job-{}", jobs.len() + 1);
                    let result = if body["id"] == "terminal/create" {
                        json!({"id":body["args"]["request"]["id"],"state":"running"})
                    } else {
                        Value::Null
                    };
                    jobs.insert(
                        id.clone(),
                        if body["id"] == "terminal/follow" {
                            json!({"status":"running","events":[]})
                        } else {
                            json!({"status":"complete","result":result})
                        },
                    );
                    Ok(json!({"jobId":id}))
                }
                "/api/admin/cancel" => Ok(json!({"ok":true})),
                _ if path.starts_with("/api/admin/job?id=") => self
                    .jobs
                    .lock()
                    .unwrap()
                    .get(body["jobId"].as_str().unwrap())
                    .cloned()
                    .context("unknown job"),
                _ => bail!("unexpected call"),
            }
        }
        fn cancel(&self) {}
        fn reset(&self) -> Result<()> {
            Ok(())
        }
        fn redact(&self, text: &str) -> String {
            text.into()
        }
    }
    fn key(code: KeyCode) -> KeyEvent {
        KeyEvent::new(code, KeyModifiers::NONE)
    }
    fn ctrl(c: char) -> KeyEvent {
        KeyEvent::new(KeyCode::Char(c), KeyModifiers::CONTROL)
    }
    fn confirm(pane: &mut Pane, backend: &Mock) {
        pane.key(key(KeyCode::Tab), backend).unwrap();
        pane.key(key(KeyCode::Enter), backend).unwrap();
    }
    fn snapshot(sequence: u64, screen: &str, attachment: &str) -> Value {
        json!({"type":"snapshot","sequence":sequence,"screen":screen,"info":{"id":"terminal","cols":80,"rows":24,"state":"running","controllerId":attachment}})
    }
    fn attach(pane: &mut Pane, backend: &Mock, screen: &str) {
        confirm(pane, backend);
        if matches!(pane.phase, Phase::Creating(_)) {
            pane.poll(backend);
        }
        let Phase::Following(id) = &pane.phase else {
            panic!("not following")
        };
        backend.jobs.lock().unwrap().insert(id.clone(), json!({"status":"running","events":[{"sequence":1,"value":snapshot(0,screen,&pane.attachment)}]}));
        pane.next_poll = Instant::now();
        pane.poll(backend);
    }
    #[test]
    fn create_confirmation_defaults_back_and_narrow_view_resets_selection() {
        let backend = Mock::default();
        let mut pane = Pane::new("session".into(), None);
        assert!(pane.key(key(KeyCode::Enter), &backend).unwrap());
        assert!(backend.calls.lock().unwrap().is_empty());
        pane.key(key(KeyCode::Tab), &backend).unwrap();
        pane.resize(30, 8, &backend);
        assert!(pane.key(key(KeyCode::Enter), &backend).unwrap());
        assert!(backend.calls.lock().unwrap().is_empty());
        pane.resize(100, 32, &backend);
        attach(&mut pane, &backend, "$ ");
        assert_eq!((pane.cols, pane.rows), (96, 24));
        let calls = backend.calls.lock().unwrap();
        let (_, create) = calls
            .iter()
            .find(|(_, v)| v["id"] == "terminal/create")
            .unwrap();
        assert_eq!(create["args"]["request"]["cols"], 96);
        assert_eq!(create["args"]["agentId"], "session");
    }
    #[test]
    fn terminal_keystrokes_paste_and_resize_use_the_same_attachment() {
        let backend = Mock::default();
        let mut pane = Pane::new("session".into(), Some("existing".into()));
        attach(&mut pane, &backend, "\x1b[?2004h$ ");
        pane.key(ctrl('c'), &backend).unwrap();
        pane.paste("日\x1b[201~本\n", &backend).unwrap();
        pane.next_poll = Instant::now();
        pane.poll(&backend);
        let calls = backend.calls.lock().unwrap();
        assert!(!calls.iter().any(|(_, v)| v["id"] == "terminal/create"));
        let (_, write) = calls
            .iter()
            .find(|(_, v)| v["id"] == "terminal/write")
            .unwrap();
        assert_eq!(write["args"]["attachmentId"], pane.attachment);
        assert_eq!(write["args"]["data"], "\x03\x1b[200~日[201~本\n\x1b[201~");
        drop(calls);
        pane.resize(120, 40, &backend);
        pane.next_poll = Instant::now();
        pane.poll(&backend);
        let calls = backend.calls.lock().unwrap();
        let (_, resize) = calls
            .iter()
            .rev()
            .find(|(_, v)| v["id"] == "terminal/resize")
            .unwrap();
        assert_eq!(resize["args"]["attachmentId"], pane.attachment);
        assert_eq!(resize["args"]["cols"], 116);
        assert_eq!(resize["args"]["rows"], 32);
        drop(calls);
        assert!(pane.key(ctrl(']'), &backend).unwrap());
        assert!(
            matches!(pane.phase, Phase::Following(_)),
            "hiding must preserve terminal and stream"
        );
    }
    #[test]
    fn startup_input_keeps_the_first_character_through_create_and_follow() {
        let backend = Mock::default();
        let mut pane = Pane::new("session".into(), None);
        assert!(pane.paste("not-confirmed", &backend).is_err());
        pane.key(key(KeyCode::Char('x')), &backend).unwrap();
        assert!(pane.write_queue.is_empty());
        assert!(backend.calls.lock().unwrap().is_empty());

        confirm(&mut pane, &backend);
        assert!(matches!(pane.phase, Phase::Creating(_)));
        pane.key(key(KeyCode::Char('p')), &backend).unwrap();
        pane.poll(&backend);
        let Phase::Following(id) = &pane.phase else {
            panic!("not following")
        };
        let id = id.clone();
        assert!(!pane.writable());
        pane.paste("rintf startup-ok\n", &backend).unwrap();
        assert_eq!(pane.write_queue, "printf startup-ok\n");
        assert!(pane.paste(&"a".repeat(16 * 1024), &backend).is_err());
        let mut terminal = Terminal::new(TestBackend::new(100, 32)).unwrap();
        terminal.draw(|f| pane.draw(f, f.area())).unwrap();
        let screen: String = terminal
            .backend()
            .buffer()
            .content
            .iter()
            .map(|c| c.symbol())
            .collect::<String>()
            .chars()
            .filter(|c| !c.is_whitespace())
            .collect();
        assert!(screen.contains("接続準備中"));

        backend.jobs.lock().unwrap().insert(id, json!({"status":"running","events":[{"sequence":1,"value":snapshot(0,"$ ",&pane.attachment)}]}));
        for _ in 0..2 {
            pane.next_poll = Instant::now();
            pane.poll(&backend);
        }
        let calls = backend.calls.lock().unwrap();
        let writes: Vec<_> = calls
            .iter()
            .filter(|(_, v)| v["id"] == "terminal/write")
            .collect();
        assert_eq!(writes.len(), 1);
        assert_eq!(writes[0].1["args"]["data"], "printf startup-ok\n");
        assert!(pane.write_queue.is_empty());
        drop(calls);
        // Re-following never repopulates an already submitted write.
        pane.follow(&backend).unwrap();
        assert!(pane.write_queue.is_empty());
    }
    #[test]
    fn known_ended_or_other_controlled_terminals_reject_input() {
        let backend = Mock::default();
        let mut pane = Pane::new("session".into(), Some("existing".into()));
        confirm(&mut pane, &backend);
        for info in [
            json!({"state":"exited"}),
            json!({"state":"failed"}),
            json!({"state":"running","controllerId":"another-attachment"}),
        ] {
            pane.info = info;
            assert!(pane.paste("must-not-send", &backend).is_err());
            assert!(pane.write_queue.is_empty());
        }
        pane.info = Value::Null;
        pane.phase = Phase::Failed;
        assert!(pane.paste("must-not-send", &backend).is_err());
    }
    #[test]
    fn ansi_colors_unicode_cursor_and_repeated_draw_are_rendered_as_cells() {
        let backend = Mock::default();
        let mut pane = Pane::new("session".into(), Some("existing".into()));
        attach(
            &mut pane,
            &backend,
            "\x1b[31;1m日本\x1b[0m!\x1b]52;c;evil\x07",
        );
        assert_eq!(pane.parser.screen().contents(), "日本!");
        assert_eq!(pane.parser.screen().cursor_position(), (0, 5));
        assert_eq!(
            pane.parser.screen().cell(0, 0).unwrap().fgcolor(),
            vt100::Color::Idx(1)
        );
        let mut terminal = Terminal::new(TestBackend::new(100, 32)).unwrap();
        terminal.draw(|f| pane.draw(f, f.area())).unwrap();
        let first = terminal.backend().buffer().clone();
        terminal.draw(|f| pane.draw(f, f.area())).unwrap();
        assert_eq!(&first, terminal.backend().buffer());
        let cell = &first[(2, 4)];
        assert_eq!(cell.symbol(), "日");
        assert_eq!(cell.fg, Color::Indexed(1));
        assert!(cell.modifier.contains(Modifier::BOLD));
        assert!(first.content.iter().all(|c| !c.symbol().contains('\x1b')));
    }
    #[test]
    fn cumulative_events_deduplicate_and_gap_refollows_without_recreating_shell() {
        let backend = Mock::default();
        let mut pane = Pane::new("session".into(), Some("existing".into()));
        attach(&mut pane, &backend, "A");
        let Phase::Following(id) = &pane.phase else {
            panic!()
        };
        let id = id.clone();
        let value = json!({"status":"running","events":[{"sequence":1,"value":snapshot(0,"A",&pane.attachment)},{"sequence":2,"value":{"type":"output","sequence":1,"data":"B"}}]});
        backend.jobs.lock().unwrap().insert(id.clone(), value);
        for _ in 0..2 {
            pane.next_poll = Instant::now();
            pane.poll(&backend);
        }
        assert_eq!(pane.parser.screen().contents(), "AB");
        backend.jobs.lock().unwrap().insert(id,json!({"status":"running","droppedEvents":3,"events":[{"sequence":4,"value":{"type":"output","sequence":3,"data":"D"}}]}));
        pane.next_poll = Instant::now();
        pane.poll(&backend);
        assert!(matches!(pane.phase, Phase::Following(_)));
        assert!(pane.terminal_sequence.is_none());
        let calls = backend.calls.lock().unwrap();
        assert_eq!(
            calls
                .iter()
                .filter(|(_, v)| v["id"] == "terminal/follow")
                .count(),
            2
        );
        assert!(!calls.iter().any(|(_, v)| v["id"] == "terminal/create"));
    }
    #[test]
    fn shutdown_closes_only_terminals_created_by_this_pane() {
        for owned in [true, false] {
            let backend = Mock::default();
            let mut pane = Pane::new(
                "session".into(),
                if owned { None } else { Some("existing".into()) },
            );
            attach(&mut pane, &backend, "$ ");
            pane.cancel(&backend);
            pane.cancel(&backend);
            let calls = backend.calls.lock().unwrap();
            assert_eq!(
                calls
                    .iter()
                    .filter(|(_, v)| v["id"] == "terminal/close")
                    .count(),
                usize::from(owned)
            );
            assert!(calls.iter().any(|(p, _)| p == "/api/admin/cancel"));
        }
    }
    #[test]
    fn close_shortcut_accepts_legacy_gs_and_enhanced_keyboard_events() {
        let backend = Mock::default();
        let mut pane = Pane::new("session".into(), Some("existing".into()));
        attach(&mut pane, &backend, "$ ");
        // Crossterm's Unix parser maps 0x1c..=0x1f to Ctrl+4..=Ctrl+7.
        let legacy_gs = KeyEvent::new(
            KeyCode::Char(char::from(0x1d_u8 - 0x1c + b'4')),
            KeyModifiers::CONTROL,
        );
        assert!(pane.key(legacy_gs, &backend).unwrap());
        assert!(pane.key(ctrl(']'), &backend).unwrap());
        assert!(matches!(pane.phase, Phase::Following(_)));
        assert!(pane.write_queue.is_empty());
        assert!(!backend
            .calls
            .lock()
            .unwrap()
            .iter()
            .any(|(_, value)| value["id"] == "terminal/close"));
    }
    #[test]
    fn common_control_and_application_cursor_keys_are_encoded() {
        assert_eq!(key_bytes(ctrl('c'), false).as_deref(), Some("\x03"));
        assert_eq!(key_bytes(key(KeyCode::Up), true).as_deref(), Some("\x1bOA"));
        assert_eq!(
            key_bytes(key(KeyCode::Up), false).as_deref(),
            Some("\x1b[A")
        );
        assert_eq!(
            key_bytes(KeyEvent::new(KeyCode::Char('x'), KeyModifiers::ALT), false).as_deref(),
            Some("\x1bx")
        );
    }
}
