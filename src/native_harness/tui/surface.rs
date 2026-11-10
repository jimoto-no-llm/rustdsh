//! A terminal front end for a private Web renderer. No page input enters chat history.
use super::{backend::HarnessBackend, edit, editor, Editor};
use anyhow::{bail, Context, Result};
use base64::Engine;
use crossterm::event::{
    KeyCode, KeyEvent, KeyEventKind, KeyModifiers, MouseButton, MouseEvent, MouseEventKind,
};
use ratatui::{
    layout::{Constraint, Direction, Layout, Rect},
    style::{Color, Style},
    text::Line,
    widgets::{Block, Borders, Clear, List, ListItem, ListState, Paragraph},
    Frame,
};
use serde_json::{json, Value};
use std::{
    io::Cursor,
    time::{Duration, Instant},
};

const MAX_TEXT: usize = 256 * 1024;
const MAX_PNG: usize = 12 * 1024 * 1024;
const MAX_DOCUMENT: usize = 512 * 1024;
const MAX_PIXELS: usize = 1600 * 1200;
#[derive(Clone)]
struct Control {
    id: String,
    role: String,
    name: String,
    value: String,
    editable: bool,
    password: bool,
    disabled: bool,
    value_truncated: bool,
}
#[derive(PartialEq)]
enum Page {
    Content,
    Tabs,
    Activity,
}
#[derive(PartialEq)]
enum FormKind {
    Text {
        id: String,
        password: bool,
        request_id: Option<String>,
    },
    Dialog {
        id: String,
        prompt: bool,
    },
    Files {
        id: String,
        multiple: bool,
    },
    Directory {
        id: String,
    },
    Document {
        id: String,
        revision: Value,
        writable: bool,
    },
}
struct Form {
    kind: FormKind,
    title: String,
    editor: Editor,
    confirm: bool,
    confirming: bool,
    submitted_at: Option<u64>,
    message_scroll: usize,
}
struct Pixels {
    width: u32,
    height: u32,
    rgb: Vec<[u8; 3]>,
}
pub(super) struct Pane {
    state: Value,
    controls: Vec<Control>,
    selected: usize,
    tab_selected: usize,
    page: Page,
    pixel: bool,
    direct: bool,
    form: Option<Form>,
    handled_prompt: Option<String>,
    pixels: Option<Pixels>,
    frame_sequence: Option<u64>,
    viewport: (u32, u32),
    image_area: Rect,
    controls_area: Rect,
    controls_offset: usize,
    scroll: usize,
    max_scroll: usize,
    next_poll: Instant,
    notice: String,
}
fn bounded(value: &str, max: usize) -> String {
    let mut end = value.len().min(max);
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    editor::clean(&value[..end])
}
fn field(value: &Value, key: &str, max: usize) -> String {
    bounded(value[key].as_str().unwrap_or(""), max)
}
fn id(value: &Value) -> Option<&str> {
    value
        .as_str()
        .filter(|v| !v.is_empty() && v.len() <= 512 && !v.chars().any(char::is_control))
}
fn action(backend: &dyn HarnessBackend, value: Value) -> Result<()> {
    backend.request("/api/surface/input", value).map(|_| ())
}
fn decode_png(encoded: &str) -> Result<Pixels> {
    if encoded.len() > MAX_PNG * 4 / 3 + 8 {
        bail!("Web画像が上限を超えています");
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .context("Web画像のbase64が不正です")?;
    let mut decoder = png::Decoder::new(Cursor::new(bytes));
    decoder.set_limits(png::Limits { bytes: MAX_PNG });
    decoder.set_transformations(png::Transformations::EXPAND | png::Transformations::STRIP_16);
    let mut reader = decoder.read_info().context("Web画像のPNGが不正です")?;
    let info = reader.info();
    let count = (info.width as usize)
        .checked_mul(info.height as usize)
        .context("Web画像の寸法が不正です")?;
    if count == 0 || count > MAX_PIXELS || info.width > 1600 || info.height > 1200 {
        bail!("Web画像の寸法が上限を超えています");
    }
    let size = reader
        .output_buffer_size()
        .context("Web画像の容量が不正です")?;
    if size > MAX_PNG {
        bail!("Web画像が上限を超えています");
    }
    let mut buffer = vec![0; size];
    let info = reader
        .next_frame(&mut buffer)
        .context("Web画像を復号できません")?;
    let channels = match info.color_type {
        png::ColorType::Rgb => 3,
        png::ColorType::Rgba => 4,
        png::ColorType::Grayscale => 1,
        png::ColorType::GrayscaleAlpha => 2,
        _ => bail!("Web画像の色形式が未対応です"),
    };
    if info.bit_depth != png::BitDepth::Eight {
        bail!("Web画像の色深度が未対応です");
    }
    let mut rgb = Vec::with_capacity(count);
    for p in buffer[..info.buffer_size()].chunks_exact(channels) {
        rgb.push(if channels < 3 {
            [p[0]; 3]
        } else {
            [p[0], p[1], p[2]]
        });
    }
    if rgb.len() != count {
        bail!("Web画像のpixel数が不正です");
    }
    Ok(Pixels {
        width: info.width,
        height: info.height,
        rgb,
    })
}
impl Pane {
    pub(super) fn start(backend: &dyn HarnessBackend) -> Result<Self> {
        backend.request("/api/surface/start", json!({"width":960,"height":720}))?;
        Ok(Self {
            state: json!({"status":"starting"}),
            controls: vec![],
            selected: 0,
            tab_selected: 0,
            page: Page::Content,
            pixel: false,
            direct: false,
            form: None,
            handled_prompt: None,
            pixels: None,
            frame_sequence: None,
            viewport: (960, 720),
            image_area: Rect::default(),
            controls_area: Rect::default(),
            controls_offset: 0,
            scroll: 0,
            max_scroll: 0,
            next_poll: Instant::now(),
            notice: String::new(),
        })
    }
    pub(super) fn selected_session(&self, backend: &dyn HarnessBackend) -> Result<Option<String>> {
        let value = backend.request("/api/surface/session", json!({}))?;
        if value["sessionId"].is_null() {
            return Ok(None);
        }
        let session = id(&value["sessionId"]).context("Web側の選択会話IDが不正です")?;
        Ok(Some(session.to_owned()))
    }
    pub(super) fn is_closed(&self) -> bool {
        matches!(self.state["status"].as_str(), Some("closed" | "failed"))
    }
    pub(super) fn report_error(&mut self, value: String) {
        self.notice = value;
    }
    pub(super) fn clear_confirmation(&mut self) {
        if let Some(form) = &mut self.form {
            form.confirm = false;
        }
    }
    pub(super) fn close(&mut self, backend: &dyn HarnessBackend) {
        let _ = backend.request("/api/surface/close", json!({}));
        self.form = None;
        self.state = json!({"status":"closed"});
    }
    pub(super) fn resize(&mut self, cols: u16, rows: u16, backend: &dyn HarnessBackend) {
        if cols < super::MIN_WIDTH || rows < super::MIN_HEIGHT {
            self.clear_confirmation();
            return;
        }
        let viewport = (
            (u32::from(cols) * 8).clamp(480, 1600),
            (u32::from(rows.saturating_sub(7)) * 16).clamp(320, 1200),
        );
        if viewport != self.viewport {
            self.viewport = viewport;
            self.send(
                backend,
                json!({"kind":"resize","width":viewport.0,"height":viewport.1}),
            );
        }
    }
    fn send(&mut self, backend: &dyn HarnessBackend, value: Value) {
        if let Err(error) = action(backend, value) {
            self.notice = backend.redact(&error.to_string());
        }
    }
    fn receive(&mut self, state: Value) -> Result<()> {
        if !matches!(
            state["status"].as_str(),
            Some("starting" | "ready" | "failed" | "closed")
        ) {
            bail!("Web画面の状態が不正です");
        }
        let rows = state["controls"].as_array();
        if rows.is_some_and(|r| r.len() > 4096) {
            bail!("Web操作項目が多すぎます");
        }
        let selected_id = self.controls.get(self.selected).map(|c| c.id.clone());
        self.controls = rows
            .into_iter()
            .flatten()
            .filter_map(|v| {
                Some(Control {
                    id: id(&v["id"])?.into(),
                    role: field(v, "role", 100),
                    name: field(v, "name", 4096),
                    value: if v["password"] == true {
                        String::new()
                    } else {
                        field(v, "value", 16384)
                    },
                    editable: v["editable"] == true,
                    password: v["password"] == true,
                    disabled: v["disabled"] == true,
                    value_truncated: v["valueTruncated"] == true,
                })
            })
            .collect();
        self.selected = selected_id
            .and_then(|id| self.controls.iter().position(|c| c.id == id))
            .unwrap_or(self.selected.min(self.controls.len().saturating_sub(1)));
        let sequence = state["frame"]["sequence"].as_u64();
        if sequence != self.frame_sequence || self.pixels.is_none() {
            if let Some(encoded) = state["frame"]["png"].as_str().filter(|s| !s.is_empty()) {
                self.pixels = Some(decode_png(encoded)?);
                self.frame_sequence = sequence;
            }
        }
        let prompt = if let Some(dialog) = state.get("dialog").filter(|v| v.is_object()) {
            id(&dialog["id"]).map(|i| {
                (
                    format!("dialog:{i}"),
                    Form {
                        kind: FormKind::Dialog {
                            id: i.into(),
                            prompt: matches!(dialog["type"].as_str(), Some("prompt" | "clipboard")),
                        },
                        title: format!("Web確認: {}", field(dialog, "message", 16384)),
                        editor: Editor {
                            text: field(dialog, "defaultPrompt", 16384),
                            cursor: field(dialog, "defaultPrompt", 16384).len(),
                        },
                        confirm: false,
                        confirming: true,
                        submitted_at: None,
                        message_scroll: 0,
                    },
                )
            })
        } else if let Some(chooser) = state.get("fileChooser").filter(|v| v.is_object()) {
            id(&chooser["id"]).map(|i| {
                (
                    format!("files:{i}"),
                    Form {
                        kind: FormKind::Files {
                            id: i.into(),
                            multiple: chooser["multiple"] == true,
                        },
                        title: "添付ファイルの絶対パス（複数は1行に1つ）".into(),
                        editor: Editor::default(),
                        confirm: false,
                        confirming: false,
                        submitted_at: None,
                        message_scroll: 0,
                    },
                )
            })
        } else if let Some(chooser) = state.get("directoryChooser").filter(|v| v.is_object()) {
            id(&chooser["id"]).map(|i| {
                (
                    format!("directory:{i}"),
                    Form {
                        kind: FormKind::Directory { id: i.into() },
                        title: "フォルダの絶対パス".into(),
                        editor: Editor::default(),
                        confirm: false,
                        confirming: false,
                        submitted_at: None,
                        message_scroll: 0,
                    },
                )
            })
        } else if let Some(document) = state.get("document").filter(|v| v.is_object()) {
            let content = document["content"].as_str().unwrap_or("");
            if content.len() > MAX_DOCUMENT {
                bail!("文書は512KiB以内にしてください");
            }
            id(&document["id"]).map(|i| {
                (
                    format!("document:{i}"),
                    Form {
                        kind: FormKind::Document {
                            id: i.into(),
                            revision: document["revision"].clone(),
                            writable: document["writable"] == true,
                        },
                        title: format!(
                            "文書編集: {}{}",
                            field(document, "path", 4096),
                            if document["writable"] == true {
                                ""
                            } else {
                                "（読取り専用）"
                            }
                        ),
                        editor: Editor {
                            text: content.into(),
                            cursor: 0,
                        },
                        confirm: false,
                        confirming: false,
                        submitted_at: None,
                        message_scroll: 0,
                    },
                )
            })
        } else {
            None
        };
        let mut text_applied = false;
        if let Some(form) = &mut self.form {
            if let FormKind::Text {
                request_id: Some(request_id),
                ..
            } = &form.kind
            {
                if state["fillResult"]["id"].as_str() == Some(request_id.as_str()) {
                    form.submitted_at = None;
                    text_applied = state["fillResult"]["ok"] == true;
                    if !text_applied {
                        self.notice = format!(
                            "入力を適用できませんでした: {}",
                            field(&state["fillResult"], "error", 512)
                        );
                    }
                } else if state["status"] == "failed" || state["status"] == "closed" {
                    form.submitted_at = None;
                    self.notice =
                        "Web画面が終了しました。入力内容はこの画面に保持しています".into();
                }
            } else if form
                .submitted_at
                .is_some_and(|seq| state["commandSequence"].as_u64().unwrap_or(0) > seq)
            {
                form.submitted_at = None;
            }
        }
        if text_applied {
            self.form = None;
            self.notice.clear();
        }
        if let Some((prompt_id, form)) = prompt {
            if self.handled_prompt.as_deref() != Some(&prompt_id) {
                self.form = Some(form);
                self.handled_prompt = Some(prompt_id);
                self.direct = false;
            }
        } else {
            self.handled_prompt = None;
            if self
                .form
                .as_ref()
                .is_some_and(|f| !matches!(f.kind, FormKind::Text { .. }))
            {
                self.form = None;
            }
        }
        self.state = state;
        Ok(())
    }
    pub(super) fn poll(&mut self, backend: &dyn HarnessBackend) {
        if Instant::now() < self.next_poll {
            return;
        }
        self.next_poll = Instant::now() + Duration::from_millis(250);
        if let Err(error) = backend
            .request("/api/surface/state", json!({}))
            .and_then(|v| self.receive(v))
        {
            self.notice = backend.redact(&error.to_string());
        }
    }
    fn begin_edit(&mut self) {
        if let Some(control) = self
            .controls
            .get(self.selected)
            .filter(|c| c.editable && !c.disabled)
        {
            if control.value_truncated {
                self.notice =
                    "長文はF3の直接入力とマウスで編集してください（省略値の上書きはしません）"
                        .into();
                return;
            }
            let text = control.value.clone();
            self.form = Some(Form {
                kind: FormKind::Text {
                    id: control.id.clone(),
                    password: control.password,
                    request_id: None,
                },
                title: control.name.clone(),
                editor: Editor {
                    cursor: text.len(),
                    text,
                },
                confirm: false,
                confirming: false,
                submitted_at: None,
                message_scroll: 0,
            });
        }
    }
    fn confirm_form(&mut self, backend: &dyn HarnessBackend, accept: bool) -> Result<()> {
        let Some(form) = self.form.as_mut() else {
            return Ok(());
        };
        if form.submitted_at.is_some() {
            return Ok(());
        }
        let text = &form.editor.text;
        match &mut form.kind {
            FormKind::Text { id, request_id, .. } => {
                if accept {
                    let next = crate::local_http::random_token()?;
                    action(
                        backend,
                        json!({"kind":"fill","id":id,"text":text,"requestId":next}),
                    )?;
                    *request_id = Some(next);
                    form.submitted_at = Some(self.state["commandSequence"].as_u64().unwrap_or(0));
                    self.notice.clear();
                } else {
                    self.form = None;
                }
                return Ok(());
            }
            FormKind::Dialog { id, .. } => action(
                backend,
                json!({"kind":"dialog","id":id,"accept":accept,"text":if accept {text.as_str()}else{""}}),
            )?,
            FormKind::Files { id, multiple } => {
                let paths: Vec<_> = if accept {
                    text.lines()
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                        .collect()
                } else {
                    vec![]
                };
                if paths.len() > 32
                    || (!*multiple && paths.len() > 1)
                    || paths
                        .iter()
                        .any(|p| p.len() > 4096 || !std::path::Path::new(p).is_absolute())
                {
                    bail!("絶対パスを1件、複数対応時は32件以内で入力してください");
                }
                action(backend, json!({"kind":"files","id":id,"paths":paths}))?;
            }
            FormKind::Directory { id } => {
                if accept
                    && (text.trim().len() > 4096
                        || !std::path::Path::new(text.trim()).is_absolute())
                {
                    bail!("フォルダの絶対パスを入力してください");
                }
                action(
                    backend,
                    json!({"kind":"directory","id":id,"path":if accept {Some(text.trim())}else{None},"cancel":!accept}),
                )?;
            }
            FormKind::Document {
                id,
                revision,
                writable,
            } => {
                if accept && !*writable {
                    bail!("この文書は読取り専用です");
                }
                action(
                    backend,
                    json!({"kind":"document","id":id,"content":if accept {text.as_str()}else{""},"expectedRevision":revision,"accept":accept}),
                )?;
            }
        }
        form.confirm = false;
        form.submitted_at = Some(self.state["commandSequence"].as_u64().unwrap_or(0));
        Ok(())
    }
    fn form_key(&mut self, key: KeyEvent, backend: &dyn HarnessBackend) -> Result<()> {
        let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
        let Some(form) = &mut self.form else {
            return Ok(());
        };
        if form.submitted_at.is_some() {
            return Ok(());
        }
        if matches!(form.kind, FormKind::Dialog { .. })
            && matches!(key.code, KeyCode::PageUp | KeyCode::PageDown)
        {
            form.message_scroll = if key.code == KeyCode::PageDown {
                form.message_scroll.saturating_add(5)
            } else {
                form.message_scroll.saturating_sub(5)
            };
            return Ok(());
        }
        if key.code == KeyCode::Esc {
            return self.confirm_form(backend, false);
        }
        if matches!(form.kind, FormKind::Dialog { .. }) || form.confirming {
            if matches!(key.code, KeyCode::Tab | KeyCode::BackTab) {
                form.confirm = !form.confirm;
                return Ok(());
            }
            if key.code == KeyCode::Enter && key.kind == KeyEventKind::Press {
                let allow = form.confirm;
                return self.confirm_form(backend, allow);
            }
            if matches!(form.kind, FormKind::Dialog { prompt: true, .. }) {
                edit(&mut form.editor, key);
            }
        } else if ctrl && key.code == KeyCode::Char('s') {
            if matches!(form.kind, FormKind::Text { .. }) {
                return self.confirm_form(backend, true);
            }
            form.confirming = true;
            form.confirm = false;
        } else if let FormKind::Document { writable, .. } = form.kind {
            if writable {
                document_key(&mut form.editor, key)?;
            } else if !matches!(
                key.code,
                KeyCode::Char(_) | KeyCode::Enter | KeyCode::Backspace | KeyCode::Delete
            ) {
                edit(&mut form.editor, key);
            }
        } else if key.code == KeyCode::Enter {
            form.editor.insert("\n");
        } else {
            edit(&mut form.editor, key);
        }
        Ok(())
    }
    pub(super) fn key(&mut self, key: KeyEvent, backend: &dyn HarnessBackend) -> Result<bool> {
        if key.kind == KeyEventKind::Release {
            return Ok(false);
        }
        let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
        if ctrl && matches!(key.code, KeyCode::Char(']' | '5')) {
            self.clear_confirmation();
            return Ok(true);
        }
        if self.form.is_some() {
            self.form_key(key, backend)?;
            return Ok(false);
        }
        match key.code {
            KeyCode::F(2) => {
                self.pixel = !self.pixel;
                self.page = Page::Content;
            }
            KeyCode::F(3) => self.direct = !self.direct,
            KeyCode::F(5) => action(backend, json!({"kind":"reload"}))?,
            KeyCode::F(6) => {
                self.page = if self.page == Page::Tabs {
                    Page::Content
                } else {
                    Page::Tabs
                };
                self.direct = false;
            }
            KeyCode::F(7) => {
                self.page = if self.page == Page::Activity {
                    Page::Content
                } else {
                    Page::Activity
                };
                self.direct = false;
            }
            KeyCode::Left if key.modifiers.contains(KeyModifiers::ALT) => {
                action(backend, json!({"kind":"back"}))?
            }
            KeyCode::Right if key.modifiers.contains(KeyModifiers::ALT) => {
                action(backend, json!({"kind":"forward"}))?
            }
            _ if self.direct => {
                if let Some((key, modifiers)) = browser_key(key) {
                    action(
                        backend,
                        json!({"kind":"key","key":key,"modifiers":modifiers}),
                    )?;
                }
            }
            _ if self.page == Page::Tabs => {
                let tabs = self.state["tabs"].as_array().map_or(0, Vec::len);
                match key.code {
                    KeyCode::Down | KeyCode::Tab => {
                        self.tab_selected = (self.tab_selected + 1).min(tabs.saturating_sub(1))
                    }
                    KeyCode::Up | KeyCode::BackTab => {
                        self.tab_selected = self.tab_selected.saturating_sub(1)
                    }
                    KeyCode::Enter => {
                        if let Some(id) = id(&self.state["tabs"][self.tab_selected]["id"]) {
                            action(backend, json!({"kind":"tab","id":id}))?;
                            self.page = Page::Content;
                        }
                    }
                    KeyCode::Char('x') => {
                        if let Some(id) = id(&self.state["tabs"][self.tab_selected]["id"]) {
                            action(backend, json!({"kind":"close_tab","id":id}))?;
                        }
                    }
                    KeyCode::Esc => self.page = Page::Content,
                    _ => {}
                }
            }
            KeyCode::Down | KeyCode::Tab => {
                self.selected = (self.selected + 1).min(self.controls.len().saturating_sub(1))
            }
            KeyCode::Up | KeyCode::BackTab => self.selected = self.selected.saturating_sub(1),
            KeyCode::Enter => {
                if let Some(control) = self.controls.get(self.selected) {
                    if control.disabled {
                        self.notice = "この項目はWeb側で無効になっています".into();
                    } else if control.editable {
                        self.begin_edit();
                    } else {
                        action(backend, json!({"kind":"activate","id":control.id}))?;
                    }
                }
            }
            KeyCode::Char('e') => self.begin_edit(),
            KeyCode::PageDown => {
                self.scroll = self.scroll.saturating_add(10).min(self.max_scroll);
                if self.pixel {
                    self.wheel(backend, 300)?;
                }
            }
            KeyCode::PageUp => {
                self.scroll = self.scroll.saturating_sub(10);
                if self.pixel {
                    self.wheel(backend, -300)?;
                }
            }
            KeyCode::Home => self.scroll = 0,
            KeyCode::End => self.scroll = self.max_scroll,
            KeyCode::Esc => {
                self.page = Page::Content;
                self.direct = false;
            }
            _ => {}
        }
        Ok(false)
    }
    pub(super) fn paste(&mut self, value: &str, backend: &dyn HarnessBackend) -> Result<()> {
        if let Some(form) = &mut self.form {
            if form.submitted_at.is_none()
                && (!form.confirming || matches!(form.kind, FormKind::Dialog { prompt: true, .. }))
            {
                match form.kind {
                    FormKind::Document { writable: true, .. } => {
                        document_insert(&mut form.editor, value)?
                    }
                    FormKind::Document {
                        writable: false, ..
                    } => {}
                    _ if !form.editor.insert(value) => bail!("入力は16KiB以内にしてください"),
                    _ => {}
                }
            }
            return Ok(());
        }
        if self.direct {
            if value.len() > 16384 {
                bail!("入力は16KiB以内にしてください");
            }
            action(backend, json!({"kind":"text","text":editor::clean(value)}))?;
        }
        Ok(())
    }
    fn wheel(&self, backend: &dyn HarnessBackend, delta: i32) -> Result<()> {
        action(
            backend,
            json!({"kind":"scroll","x":self.viewport.0/2,"y":self.viewport.1/2,"deltaX":0,"deltaY":delta}),
        )
    }
    pub(super) fn mouse(&mut self, event: MouseEvent, backend: &dyn HarnessBackend) -> Result<()> {
        if self.form.is_some() {
            return Ok(());
        }
        if self.pixel
            && self.page == Page::Content
            && self.image_area.contains((event.column, event.row).into())
        {
            let x = u32::from(event.column - self.image_area.x) * self.viewport.0
                / u32::from(self.image_area.width.max(1));
            let y = u32::from(event.row - self.image_area.y) * self.viewport.1
                / u32::from(self.image_area.height.max(1));
            let button = |b| match b {
                MouseButton::Left => "left",
                MouseButton::Right => "right",
                MouseButton::Middle => "middle",
            };
            match event.kind {
                MouseEventKind::Down(b) => action(
                    backend,
                    json!({"kind":"click","x":x,"y":y,"button":button(b),"event":"down"}),
                )?,
                MouseEventKind::Up(b) => action(
                    backend,
                    json!({"kind":"click","x":x,"y":y,"button":button(b),"event":"up"}),
                )?,
                MouseEventKind::Drag(b) => action(
                    backend,
                    json!({"kind":"move","x":x,"y":y,"buttons":match b {MouseButton::Left=>1,MouseButton::Right=>2,MouseButton::Middle=>4}}),
                )?,
                MouseEventKind::Moved => {
                    action(backend, json!({"kind":"move","x":x,"y":y,"buttons":0}))?
                }
                MouseEventKind::ScrollUp
                | MouseEventKind::ScrollDown
                | MouseEventKind::ScrollLeft
                | MouseEventKind::ScrollRight => {
                    let (dx, dy) = match event.kind {
                        MouseEventKind::ScrollUp => (0, -200),
                        MouseEventKind::ScrollDown => (0, 200),
                        MouseEventKind::ScrollLeft => (-200, 0),
                        _ => (200, 0),
                    };
                    action(
                        backend,
                        json!({"kind":"scroll","x":x,"y":y,"deltaX":dx,"deltaY":dy}),
                    )?;
                }
            }
        } else if self
            .controls_area
            .contains((event.column, event.row).into())
            && matches!(event.kind, MouseEventKind::Down(MouseButton::Left))
        {
            self.selected = (self.controls_offset + usize::from(event.row - self.controls_area.y))
                .min(self.controls.len().saturating_sub(1));
        } else {
            match event.kind {
                MouseEventKind::ScrollUp => self.scroll = self.scroll.saturating_sub(3),
                MouseEventKind::ScrollDown => {
                    self.scroll = self.scroll.saturating_add(3).min(self.max_scroll)
                }
                _ => {}
            }
        }
        Ok(())
    }
    pub(super) fn draw(&mut self, frame: &mut Frame, area: Rect) {
        let area = Rect::new(
            area.x + 1,
            area.y + 1,
            area.width.saturating_sub(2),
            area.height.saturating_sub(2),
        );
        frame.render_widget(Clear, area);
        let block = Block::default()
            .borders(Borders::ALL)
            .title(" DSH Web UI · TUI内 ")
            .border_style(Style::default().fg(Color::Cyan));
        let inner = block.inner(area);
        frame.render_widget(block, area);
        let rows = Layout::default()
            .direction(Direction::Vertical)
            .constraints([
                Constraint::Length(2),
                Constraint::Min(1),
                Constraint::Length(3),
            ])
            .split(inner);
        let status = field(&self.state, "status", 30);
        let title = field(&self.state, "title", 512);
        frame.render_widget(
            Paragraph::new(format!(
                "{status} · {title}\n{}",
                if self.direct {
                    "ブラウザ入力中（キーをWeb画面へ送信）"
                } else if self.pixel {
                    "画像表示 · マウスでWeb画面を操作"
                } else {
                    "文字表示 · 操作項目を選択"
                }
            )),
            rows[0],
        );
        self.image_area = Rect::default();
        self.controls_area = Rect::default();
        if self.form.is_some() {
            self.draw_form(frame, rows[1]);
        } else if self.page == Page::Tabs {
            let items = self.state["tabs"]
                .as_array()
                .into_iter()
                .flatten()
                .take(128)
                .map(|v| {
                    ListItem::new(format!(
                        "{} {}",
                        if v["selected"] == true { "●" } else { "○" },
                        field(v, "title", 512)
                    ))
                })
                .collect::<Vec<_>>();
            let mut state = ListState::default().with_selected(Some(self.tab_selected));
            frame.render_stateful_widget(
                List::new(items)
                    .highlight_symbol("▶ ")
                    .highlight_style(Style::default().fg(Color::Cyan)),
                rows[1],
                &mut state,
            );
        } else if self.page == Page::Activity {
            let value = json!({"downloads":self.state["downloads"],"notifications":self.state["notifications"]});
            self.draw_text(
                frame,
                rows[1],
                &bounded(
                    &serde_json::to_string_pretty(&value).unwrap_or_default(),
                    MAX_TEXT,
                ),
            );
        } else if self.pixel {
            self.draw_pixels(frame, rows[1]);
        } else {
            let split = Layout::default()
                .direction(Direction::Horizontal)
                .constraints([Constraint::Percentage(60), Constraint::Percentage(40)])
                .split(rows[1]);
            self.draw_text(frame, split[0], &field(&self.state, "text", MAX_TEXT));
            self.controls_area = split[1];
            let items = self
                .controls
                .iter()
                .map(|c| {
                    ListItem::new(format!(
                        "{} {}{}",
                        c.role,
                        c.name,
                        if c.disabled {
                            " [無効]"
                        } else if c.value_truncated {
                            " [長文/直接入力]"
                        } else if c.password {
                            " [機密入力]"
                        } else if c.editable {
                            " [入力]"
                        } else {
                            ""
                        }
                    ))
                })
                .collect::<Vec<_>>();
            let mut state = ListState::default().with_selected(Some(self.selected));
            frame.render_stateful_widget(
                List::new(items)
                    .highlight_symbol("▶ ")
                    .highlight_style(Style::default().fg(Color::Cyan)),
                split[1],
                &mut state,
            );
            self.controls_offset = state.offset();
        }
        let notice = if !self.notice.is_empty() {
            self.notice.clone()
        } else {
            field(&self.state, "error", 4096)
        };
        frame.render_widget(
            Paragraph::new(vec![
                Line::styled(bounded(&notice, 4096), Style::default().fg(Color::Yellow)),
                Line::raw("F2 文字/画像 · F3 Web入力 · F5 更新 · F6 タブ · F7 通知/保存"),
                Line::raw("↑↓/Tab 項目 · Enter 操作 · Alt+←/→ 履歴 · Ctrl+] 会話へ"),
            ]),
            rows[2],
        );
    }
    fn draw_text(&mut self, frame: &mut Frame, area: Rect, text: &str) {
        let lines = editor::wrap(text, area.width.saturating_sub(1), usize::MAX).0;
        self.max_scroll = lines.len().saturating_sub(area.height as usize);
        self.scroll = self.scroll.min(self.max_scroll);
        frame.render_widget(
            Paragraph::new(
                lines
                    .into_iter()
                    .skip(self.scroll)
                    .take(area.height as usize)
                    .map(Line::raw)
                    .collect::<Vec<_>>(),
            ),
            area,
        );
    }
    fn draw_pixels(&mut self, frame: &mut Frame, area: Rect) {
        self.image_area = area;
        let Some(image) = &self.pixels else {
            frame.render_widget(Paragraph::new("画像を取得中…"), area);
            return;
        };
        for y in 0..area.height {
            for x in 0..area.width {
                let sx = u32::from(x) * image.width / u32::from(area.width.max(1));
                let sy = u32::from(y) * 2 * image.height / (u32::from(area.height.max(1)) * 2);
                let lower =
                    (u32::from(y) * 2 + 1) * image.height / (u32::from(area.height.max(1)) * 2);
                let a = image.rgb[(sy * image.width + sx) as usize];
                let b = image.rgb[(lower.min(image.height - 1) * image.width + sx) as usize];
                frame.buffer_mut()[(area.x + x, area.y + y)]
                    .set_symbol("▀")
                    .set_fg(Color::Rgb(a[0], a[1], a[2]))
                    .set_bg(Color::Rgb(b[0], b[1], b[2]));
            }
        }
    }
    fn draw_form(&mut self, frame: &mut Frame, area: Rect) {
        let form = self.form.as_mut().unwrap();
        let dialog = matches!(form.kind, FormKind::Dialog { .. });
        let title_height = if dialog {
            area.height.saturating_sub(5).max(1)
        } else {
            2
        };
        let rows = Layout::default()
            .direction(Direction::Vertical)
            .constraints([
                Constraint::Length(title_height),
                Constraint::Min(1),
                Constraint::Length(2),
            ])
            .split(area);
        let heading = if self.notice.is_empty() {
            form.title.clone()
        } else {
            format!("{}\n{}", self.notice, form.title)
        };
        let title = editor::wrap(
            &bounded(&heading, 16384),
            rows[0].width.saturating_sub(1),
            usize::MAX,
        )
        .0;
        form.message_scroll = form
            .message_scroll
            .min(title.len().saturating_sub(rows[0].height as usize));
        frame.render_widget(
            Paragraph::new(
                title
                    .into_iter()
                    .skip(form.message_scroll)
                    .map(Line::raw)
                    .collect::<Vec<_>>(),
            ),
            rows[0],
        );
        let masked = matches!(form.kind, FormKind::Text { password: true, .. });
        let text = if masked {
            "•".repeat(form.editor.text.chars().count())
        } else {
            editor::clean(&form.editor.text)
        };
        let (lines, (cx, cy)) = editor::wrap(
            &text,
            rows[1].width.saturating_sub(1),
            if masked {
                form.editor.text[..form.editor.cursor].chars().count() * "•".len()
            } else {
                editor::clean(&form.editor.text[..form.editor.cursor]).len()
            },
        );
        let start = usize::from(cy.saturating_sub(rows[1].height.saturating_sub(1)));
        frame.render_widget(
            Paragraph::new(
                lines
                    .into_iter()
                    .skip(start)
                    .map(Line::raw)
                    .collect::<Vec<_>>(),
            ),
            rows[1],
        );
        if !form.confirming && rows[1].width > 0 && rows[1].height > 0 {
            frame.set_cursor_position((
                rows[1].x + cx.min(rows[1].width - 1),
                rows[1].y + cy.saturating_sub(start as u16).min(rows[1].height - 1),
            ));
        }
        let help = if form.submitted_at.is_some() {
            "処理中…（Web画面の応答を待っています）"
        } else if form.confirming {
            if form.confirm {
                "  取消      ▶ 確定\nTab 選択 · Enter 決定 · Esc 取消 · PgUp/Dn 本文"
            } else {
                "▶ 取消        確定\nTab 選択 · Enter 決定 · Esc 取消 · PgUp/Dn 本文"
            }
        } else {
            "Ctrl+S 適用/確認 · Ctrl+U 消去\nEnter 改行 · Esc 取消"
        };
        frame.render_widget(
            Paragraph::new(help).style(Style::default().fg(Color::Yellow)),
            rows[2],
        );
    }
}
fn document_insert(editor: &mut Editor, value: &str) -> Result<()> {
    use unicode_segmentation::UnicodeSegmentation;
    let value = value.replace("\r\n", "\n").replace('\r', "\n");
    if editor.text.len() + value.len() > MAX_DOCUMENT {
        bail!("文書は512KiB以内にしてください");
    }
    editor.text.insert_str(editor.cursor, &value);
    editor.cursor += value.len();
    editor.cursor = editor
        .text
        .grapheme_indices(true)
        .map(|(i, _)| i)
        .find(|i| *i >= editor.cursor)
        .unwrap_or(editor.text.len());
    Ok(())
}
fn document_key(editor: &mut Editor, key: KeyEvent) -> Result<()> {
    if key.code == KeyCode::Enter
        || (key.code == KeyCode::Char('j') && key.modifiers.contains(KeyModifiers::CONTROL))
    {
        document_insert(editor, "\n")?;
    } else if let KeyCode::Char(c) = key.code {
        if !key
            .modifiers
            .intersects(KeyModifiers::CONTROL | KeyModifiers::ALT | KeyModifiers::SUPER)
        {
            document_insert(editor, &c.to_string())?;
        } else {
            edit(editor, key);
        }
    } else {
        edit(editor, key);
    }
    Ok(())
}
fn browser_key(key: KeyEvent) -> Option<(String, u8)> {
    let name = match key.code {
        KeyCode::Char(' ') => "Space".into(),
        KeyCode::Char(c) => c.to_string(),
        KeyCode::Enter => "Enter".into(),
        KeyCode::Tab | KeyCode::BackTab => "Tab".into(),
        KeyCode::Esc => "Escape".into(),
        KeyCode::Backspace => "Backspace".into(),
        KeyCode::Delete => "Delete".into(),
        KeyCode::Up => "ArrowUp".into(),
        KeyCode::Down => "ArrowDown".into(),
        KeyCode::Left => "ArrowLeft".into(),
        KeyCode::Right => "ArrowRight".into(),
        KeyCode::Home => "Home".into(),
        KeyCode::End => "End".into(),
        KeyCode::PageUp => "PageUp".into(),
        KeyCode::PageDown => "PageDown".into(),
        _ => return None,
    };
    let mut modifiers = 0;
    for (flag, mask) in [
        (KeyModifiers::ALT, 1),
        (KeyModifiers::CONTROL, 2),
        (KeyModifiers::SUPER, 4),
        (KeyModifiers::SHIFT, 8),
    ] {
        if key.modifiers.contains(flag) {
            modifiers |= mask;
        }
    }
    if key.code == KeyCode::BackTab {
        modifiers |= 8;
    }
    Some((name, modifiers))
}

#[cfg(test)]
mod tests {
    use super::*;
    use ratatui::{backend::TestBackend, Terminal};
    use std::cell::RefCell;
    #[derive(Default)]
    struct Backend {
        calls: RefCell<Vec<(String, Value)>>,
        fail: RefCell<bool>,
        observed: RefCell<Value>,
    }
    impl HarnessBackend for Backend {
        fn snapshot(&self) -> Value {
            json!({"backend":"dsh","status":"idle"})
        }
        fn request(&self, path: &str, body: Value) -> Result<Value> {
            if *self.fail.borrow() {
                bail!("rejected");
            }
            self.calls.borrow_mut().push((path.into(), body));
            if path == "/api/surface/session" {
                return Ok(json!({"sessionId":self.observed.borrow()["sessionId"]}));
            }
            Ok(json!({"ok":true}))
        }
        fn cancel(&self) {}
        fn reset(&self) -> Result<()> {
            Ok(())
        }
        fn redact(&self, value: &str) -> String {
            value.into()
        }
    }
    fn key(code: KeyCode) -> KeyEvent {
        KeyEvent::new(code, KeyModifiers::NONE)
    }
    fn ctrl(c: char) -> KeyEvent {
        KeyEvent::new(KeyCode::Char(c), KeyModifiers::CONTROL)
    }
    fn calls(backend: &Backend) -> Vec<Value> {
        backend
            .calls
            .borrow()
            .iter()
            .filter(|(path, _)| path == "/api/surface/input")
            .map(|(_, body)| body.clone())
            .collect()
    }
    fn render(pane: &mut Pane, width: u16, height: u16) -> String {
        let mut terminal = Terminal::new(TestBackend::new(width, height)).unwrap();
        terminal.draw(|f| pane.draw(f, f.area())).unwrap();
        terminal
            .backend()
            .buffer()
            .content
            .iter()
            .map(|c| c.symbol())
            .collect()
    }
    #[test]
    fn web_surface_disabled_controls_are_visible_and_never_activate() {
        let backend = Backend::default();
        let mut pane = Pane::start(&backend).unwrap();
        pane.receive(json!({"status":"ready","controls":[{"id":"disabled","role":"textbox","name":"Choose workspace","editable":true,"disabled":true}]})).unwrap();
        assert!(render(&mut pane, 120, 32)
            .replace(' ', "")
            .contains("[無効]"));
        pane.key(key(KeyCode::Enter), &backend).unwrap();
        pane.key(key(KeyCode::Char('e')), &backend).unwrap();
        assert!(pane.form.is_none());
        assert!(calls(&backend).is_empty());
        assert!(pane.notice.contains("無効"));
    }
    #[test]
    fn web_surface_command_session_cleanup_and_pending_overlay_are_local() {
        use super::super::{App, Overlay};
        let backend = Backend::default();
        let mut app = App::new(json!([]));
        app.set_size(100, 32);
        app.editor.insert("/webui");
        assert!(!app.submit(&backend));
        assert!(matches!(app.overlay, Overlay::Surface));
        assert!(app.history.is_empty());
        app.surface
            .as_mut()
            .unwrap()
            .receive(
                json!({"status":"ready","dialog":{"id":"d","type":"confirm","message":"Confirm"}}),
            )
            .unwrap();
        app.key(key(KeyCode::Tab), &backend.snapshot(), &backend);
        assert!(app.surface.as_ref().unwrap().form.as_ref().unwrap().confirm);
        app.sync_pending(&json!({"pending":{"id":"approval","tool":"read"}}));
        assert!(matches!(app.overlay, Overlay::None));
        assert!(!app.surface.as_ref().unwrap().form.as_ref().unwrap().confirm);
        app.clear_session_panels(&backend);
        assert!(app.surface.is_none());
        assert_eq!(
            backend.calls.borrow().last().unwrap().0,
            "/api/surface/close"
        );
        assert!(backend
            .calls
            .borrow()
            .iter()
            .all(|(path, _)| path.starts_with("/api/surface/")));
    }
    #[test]
    fn web_surface_return_resumes_observed_session_and_missing_selection_stays_local() {
        use super::super::{App, Overlay};
        let backend = Backend::default();
        let mut app = App::new(json!([]));
        app.set_size(100, 32);
        app.surface = Some(Pane::start(&backend).unwrap());
        app.overlay = Overlay::Surface;
        *backend.observed.borrow_mut() = json!({"status":"ready","sessionId":"web-session"});
        app.key(
            ctrl(']'),
            &json!({"status":"idle","sessionId":"old-session"}),
            &backend,
        );
        assert!(matches!(app.overlay, Overlay::None));
        assert!(app.surface.is_none());
        assert!(backend
            .calls
            .borrow()
            .iter()
            .any(|(path, body)| path == "/api/resume" && body["sessionId"] == "web-session"));
        backend.calls.borrow_mut().clear();
        app.surface = Some(Pane::start(&backend).unwrap());
        app.overlay = Overlay::Surface;
        *backend.observed.borrow_mut() = json!({"status":"ready","sessionId":null});
        app.key(
            ctrl(']'),
            &json!({"status":"idle","sessionId":"old-session"}),
            &backend,
        );
        assert!(app.surface.is_some());
        assert!(!backend
            .calls
            .borrow()
            .iter()
            .any(|(path, _)| path == "/api/resume"));
        assert!(app.notice.contains("維持"));
    }
    #[test]
    fn web_surface_backend_failure_remains_visible_with_draft_intact() {
        use super::super::{App, Overlay};
        let backend = Backend::default();
        let mut app = App::new(json!([]));
        app.set_size(100, 32);
        app.surface = Some(Pane::start(&backend).unwrap());
        app.overlay = Overlay::Surface;
        app.surface.as_mut().unwrap().receive(json!({"status":"ready","controls":[{"id":"a","name":"Test","role":"textbox","editable":true}]})).unwrap();
        app.key(key(KeyCode::Enter), &backend.snapshot(), &backend);
        app.surface
            .as_mut()
            .unwrap()
            .paste("draft", &backend)
            .unwrap();
        *backend.fail.borrow_mut() = true;
        app.key(ctrl('s'), &backend.snapshot(), &backend);
        let pane = app.surface.as_mut().unwrap();
        assert_eq!(pane.form.as_ref().unwrap().editor.text, "draft");
        assert!(render(pane, 100, 32).contains("rejected"));
    }
    #[test]
    fn web_surface_long_dialog_scrolls_without_hiding_confirmation() {
        let backend = Backend::default();
        let mut pane = Pane::start(&backend).unwrap();
        pane.receive(json!({"status":"ready","dialog":{"id":"d","type":"confirm","message":format!("{}END", "Long message\n".repeat(30))}})).unwrap();
        assert!(!render(&mut pane, 80, 24).contains("END"));
        for _ in 0..10 {
            pane.key(key(KeyCode::PageDown), &backend).unwrap();
        }
        let output = render(&mut pane, 80, 24);
        assert!(output.contains("END"));
        assert!(output
            .chars()
            .filter(|c| !c.is_whitespace())
            .collect::<String>()
            .contains("取消"));
        assert!(calls(&backend).is_empty());
    }
    #[test]
    fn web_surface_truncated_value_never_opens_destructive_editor() {
        let backend = Backend::default();
        let mut pane = Pane::start(&backend).unwrap();
        pane.receive(json!({"status":"ready","controls":[{"id":"large","role":"textbox","name":"Long document","value":"partial","editable":true,"valueTruncated":true}]})).unwrap();
        pane.key(key(KeyCode::Enter), &backend).unwrap();
        pane.key(ctrl('s'), &backend).unwrap();
        assert!(pane.form.is_none());
        assert!(calls(&backend).is_empty());
        assert!(render(&mut pane, 100, 32)
            .replace(' ', "")
            .contains("長文/直接入力"));
    }
    #[test]
    fn web_surface_async_fill_preserves_draft_until_matching_success() {
        let backend = Backend::default();
        let mut pane = Pane::start(&backend).unwrap();
        pane.receive(json!({"status":"ready","controls":[{"id":"entry","role":"textbox","name":"Draft","editable":true}]})).unwrap();
        pane.key(key(KeyCode::Enter), &backend).unwrap();
        pane.paste("recoverable draft", &backend).unwrap();
        pane.key(ctrl('s'), &backend).unwrap();
        let request = calls(&backend)[0]["requestId"].clone();
        pane.receive(json!({"status":"ready","commandSequence":10,"fillResult":{"id":"unrelated","ok":true}})).unwrap();
        assert!(pane.form.as_ref().unwrap().submitted_at.is_some());
        pane.receive(json!({"status":"ready","fillResult":{"id":request,"ok":false,"error":"CONTROL_EXPIRED"}})).unwrap();
        assert_eq!(pane.form.as_ref().unwrap().editor.text, "recoverable draft");
        assert!(pane.form.as_ref().unwrap().submitted_at.is_none());
        assert!(render(&mut pane, 100, 32).contains("CONTROL_EXPIRED"));
        pane.key(ctrl('s'), &backend).unwrap();
        let retry = calls(&backend)[1]["requestId"].clone();
        assert_ne!(request, retry);
        pane.receive(json!({"status":"ready","fillResult":{"id":retry,"ok":true}}))
            .unwrap();
        assert!(pane.form.is_none());
    }
    #[test]
    fn web_surface_password_edit_masks_and_applies_without_chat() {
        let backend = Backend::default();
        let mut pane = Pane::start(&backend).unwrap();
        pane.receive(json!({"status":"ready","text":"設定","controls":[{"id":"password","role":"textbox","name":"API key","password":true,"editable":true,"value":"server-secret"}]})).unwrap();
        pane.key(key(KeyCode::Enter), &backend).unwrap();
        pane.paste("typed-secret", &backend).unwrap();
        let output = render(&mut pane, 100, 32);
        assert!(!output.contains("typed-secret"));
        assert!(!output.contains("server-secret"));
        assert!(output.contains('•'));
        pane.key(ctrl('s'), &backend).unwrap();
        let submitted = calls(&backend);
        assert_eq!(submitted.len(), 1);
        assert_eq!(submitted[0]["kind"], "fill");
        assert_eq!(submitted[0]["id"], "password");
        assert_eq!(submitted[0]["text"], "typed-secret");
        assert!(submitted[0]["requestId"].as_str().is_some());
        assert!(backend
            .calls
            .borrow()
            .iter()
            .all(|(path, _)| path.starts_with("/api/surface/")));
    }
    #[test]
    fn web_surface_clipboard_request_requires_paste_and_explicit_confirmation() {
        let backend = Backend::default();
        let mut pane = Pane::start(&backend).unwrap();
        pane.receive(json!({"status":"ready","dialog":{"id":"clip","type":"clipboard","message":"貼り付け","defaultPrompt":""}})).unwrap();
        pane.paste("user supplied text", &backend).unwrap();
        assert!(calls(&backend).is_empty());
        pane.key(key(KeyCode::Tab), &backend).unwrap();
        pane.key(key(KeyCode::Enter), &backend).unwrap();
        assert_eq!(
            calls(&backend),
            vec![json!({"kind":"dialog","id":"clip","accept":true,"text":"user supplied text"})]
        );
    }
    #[test]
    fn web_surface_dialog_denies_by_default_and_retains_until_acknowledged() {
        let backend = Backend::default();
        let mut pane = Pane::start(&backend).unwrap();
        let state = json!({"status":"ready","commandSequence":2,"dialog":{"id":"confirm-1","type":"confirm","message":"Delete?"}});
        pane.receive(state.clone()).unwrap();
        assert!(calls(&backend).is_empty());
        pane.key(key(KeyCode::Enter), &backend).unwrap();
        assert_eq!(
            calls(&backend),
            vec![json!({"kind":"dialog","id":"confirm-1","accept":false,"text":""})]
        );
        pane.key(key(KeyCode::Enter), &backend).unwrap();
        assert_eq!(calls(&backend).len(), 1);
        pane.receive(state).unwrap();
        assert!(pane.form.is_some());
        pane.receive(json!({"status":"ready","commandSequence":3}))
            .unwrap();
        assert!(pane.form.is_none());
    }
    #[test]
    fn web_surface_hide_and_shrink_clear_confirmation() {
        let backend = Backend::default();
        let mut pane = Pane::start(&backend).unwrap();
        pane.receive(
            json!({"status":"ready","dialog":{"id":"d","type":"confirm","message":"Confirm"}}),
        )
        .unwrap();
        pane.key(key(KeyCode::Tab), &backend).unwrap();
        assert!(pane.form.as_ref().unwrap().confirm);
        pane.resize(20, 8, &backend);
        assert!(!pane.form.as_ref().unwrap().confirm);
        pane.key(key(KeyCode::Tab), &backend).unwrap();
        assert!(pane.key(ctrl(']'), &backend).unwrap());
        assert!(!pane.form.as_ref().unwrap().confirm);
        assert!(pane.key(ctrl('5'), &backend).unwrap());
        assert!(calls(&backend).is_empty());
    }
    #[test]
    fn web_surface_file_selection_requires_explicit_confirm_and_rejection_preserves_draft() {
        let backend = Backend::default();
        let mut pane = Pane::start(&backend).unwrap();
        pane.receive(json!({"status":"ready","fileChooser":{"id":"f","multiple":false}}))
            .unwrap();
        pane.paste("relative.txt", &backend).unwrap();
        pane.key(ctrl('s'), &backend).unwrap();
        pane.key(key(KeyCode::Tab), &backend).unwrap();
        assert!(pane.key(key(KeyCode::Enter), &backend).is_err());
        assert_eq!(pane.form.as_ref().unwrap().editor.text, "relative.txt");
        assert!(calls(&backend).is_empty());
        pane.key(key(KeyCode::Esc), &backend).unwrap();
        assert_eq!(
            calls(&backend),
            vec![json!({"kind":"files","id":"f","paths":[]})]
        );
    }
    #[test]
    fn web_surface_file_paths_and_directory_are_explicit() {
        let backend = Backend::default();
        let mut pane = Pane::start(&backend).unwrap();
        pane.receive(json!({"status":"ready","fileChooser":{"id":"f","multiple":true}}))
            .unwrap();
        pane.paste("/tmp/a\n/tmp/b", &backend).unwrap();
        pane.key(ctrl('s'), &backend).unwrap();
        assert!(calls(&backend).is_empty());
        pane.key(key(KeyCode::Tab), &backend).unwrap();
        pane.key(key(KeyCode::Enter), &backend).unwrap();
        assert_eq!(
            calls(&backend)[0],
            json!({"kind":"files","id":"f","paths":["/tmp/a","/tmp/b"]})
        );
        pane.receive(json!({"status":"ready","directoryChooser":{"id":"dir"}}))
            .unwrap();
        pane.key(key(KeyCode::Esc), &backend).unwrap();
        assert_eq!(
            calls(&backend)[1],
            json!({"kind":"directory","id":"dir","path":null,"cancel":true})
        );
    }
    #[test]
    fn web_surface_document_preserves_content_revision_and_large_draft() {
        let backend = Backend::default();
        let mut pane = Pane::start(&backend).unwrap();
        let original = format!("\t{}\n", "a".repeat(20000));
        let state = json!({"status":"ready","document":{"id":"doc","path":"/tmp/test.md","revision":"sha256-1","content":original,"writable":true}});
        pane.receive(state.clone()).unwrap();
        pane.paste("追記\n", &backend).unwrap();
        pane.receive(state).unwrap();
        pane.key(ctrl('s'), &backend).unwrap();
        pane.key(key(KeyCode::Tab), &backend).unwrap();
        pane.key(key(KeyCode::Enter), &backend).unwrap();
        let call = calls(&backend).remove(0);
        assert_eq!(call["kind"], "document");
        assert_eq!(call["expectedRevision"], "sha256-1");
        assert_eq!(call["content"], format!("追記\n{original}"));
        assert_eq!(call["accept"], true);
        let mut editor = Editor::default();
        document_insert(&mut editor, "\tcode\n").unwrap();
        assert_eq!(editor.text, "\tcode\n");
        editor.clear();
        assert!(document_insert(&mut editor, &"x".repeat(MAX_DOCUMENT)).is_ok());
        assert!(document_insert(&mut editor, "a").is_err());
    }
    #[test]
    fn web_surface_document_read_only_cannot_be_modified_or_saved() {
        let backend = Backend::default();
        let mut pane = Pane::start(&backend).unwrap();
        pane.receive(json!({"status":"ready","document":{"id":"doc","revision":1,"content":"original","writable":false}})).unwrap();
        pane.paste("change", &backend).unwrap();
        pane.key(key(KeyCode::Char('x')), &backend).unwrap();
        assert_eq!(pane.form.as_ref().unwrap().editor.text, "original");
        pane.key(ctrl('s'), &backend).unwrap();
        pane.key(key(KeyCode::Tab), &backend).unwrap();
        assert!(pane.key(key(KeyCode::Enter), &backend).is_err());
        assert!(calls(&backend).is_empty());
    }
    #[test]
    fn web_surface_png_pixels_and_canvas_mouse_use_same_coordinates() {
        let mut bytes = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut bytes, 2, 2);
            encoder.set_color(png::ColorType::Rgb);
            encoder.set_depth(png::BitDepth::Eight);
            let mut writer = encoder.write_header().unwrap();
            writer
                .write_image_data(&[255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255])
                .unwrap();
        }
        let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
        let pixels = decode_png(&encoded).unwrap();
        assert_eq!(pixels.rgb[0], [255, 0, 0]);
        assert!(decode_png("bad").is_err());
        let backend = Backend::default();
        let mut pane = Pane::start(&backend).unwrap();
        pane.receive(json!({"status":"ready","frame":{"png":encoded,"sequence":1}}))
            .unwrap();
        pane.pixel = true;
        render(&mut pane, 100, 32);
        let area = pane.image_area;
        let column = area.x + area.width / 2;
        let row = area.y + area.height / 2;
        for kind in [
            MouseEventKind::Down(MouseButton::Left),
            MouseEventKind::Drag(MouseButton::Left),
            MouseEventKind::Up(MouseButton::Left),
            MouseEventKind::ScrollDown,
        ] {
            pane.mouse(
                MouseEvent {
                    kind,
                    column,
                    row,
                    modifiers: KeyModifiers::NONE,
                },
                &backend,
            )
            .unwrap();
        }
        let actions = calls(&backend);
        assert_eq!(actions[0]["event"], "down");
        assert_eq!(actions[1]["buttons"], 1);
        assert_eq!(actions[2]["event"], "up");
        assert_eq!(actions[3]["deltaY"], 200);
        assert_eq!(actions[0]["x"], actions[3]["x"]);
        assert_eq!(actions[0]["y"], actions[3]["y"]);
    }
    #[test]
    fn web_surface_direct_keys_tabs_and_close_are_scoped() {
        let backend = Backend::default();
        let mut pane = Pane::start(&backend).unwrap();
        pane.receive(json!({"status":"ready","tabs":[{"id":"t1","title":"tab1"},{"id":"t2","title":"tab2"}]})).unwrap();
        pane.key(key(KeyCode::F(3)), &backend).unwrap();
        pane.key(ctrl('c'), &backend).unwrap();
        assert_eq!(
            calls(&backend)[0],
            json!({"kind":"key","key":"c","modifiers":2})
        );
        pane.key(key(KeyCode::F(6)), &backend).unwrap();
        pane.key(key(KeyCode::Down), &backend).unwrap();
        pane.key(key(KeyCode::Enter), &backend).unwrap();
        assert_eq!(calls(&backend)[1], json!({"kind":"tab","id":"t2"}));
        assert_eq!(
            browser_key(KeyEvent::new(
                KeyCode::BackTab,
                KeyModifiers::ALT | KeyModifiers::SUPER
            )),
            Some(("Tab".into(), 13))
        );
        pane.close(&backend);
        assert_eq!(
            backend.calls.borrow().last().unwrap().0,
            "/api/surface/close"
        );
    }
    #[test]
    fn web_surface_forms_and_pixel_view_render_at_small_sizes_without_panics() {
        let backend = Backend::default();
        let mut pane = Pane::start(&backend).unwrap();
        pane.receive(json!({"status":"ready","text":"日本語👨‍👩‍👧‍👦\u{1b}[31m","controls":[{"id":"a","role":"button","name":"Open"}],"dialog":{"id":"d","type":"prompt","message":"設定","defaultPrompt":"hello"}})).unwrap();
        for (w, h) in [(1, 1), (20, 8), (42, 14), (100, 32)] {
            assert!(!render(&mut pane, w, h).contains('\u{1b}'));
        }
    }
}
