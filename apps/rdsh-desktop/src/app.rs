//! Conversation window: project-grouped sidebar with real titles, model picker,
//! live assistant streaming, approval and question prompts, tool rows.
//!
//! Startup and all sockets run on background threads; the window paints first and
//! receives updates through channels.

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::ops::Range;
use std::rc::Rc;
use std::sync::mpsc::{self, Receiver, Sender, TryRecvError};
use std::time::{Duration, Instant};

use gpui::prelude::*;
use gpui::*;
use serde_json::Value;

use crate::api::Api;
use crate::editor::{Editor, Motion};
use crate::host::Host;
use crate::live::{self, LiveCmd, LiveEvent, Pending};
use crate::markdown::{self, Block, Span};
use crate::mux::Mux;
use crate::theme;

const POLL: Duration = Duration::from_millis(120);
const RELOAD_AFTER: Duration = Duration::from_millis(500);
/// One older-history page, matching the follow window used on open.
const PAGE_LIMIT: usize = 60;
/// Retained timeline rows, about seven pages, to bound memory.
const MAX_RETAINED_MESSAGES: usize = 400;
/// A second Esc inside this window cancels the active run.
const ESC_CANCEL_WINDOW: Duration = Duration::from_millis(700);

#[derive(Clone, Debug, Default)]
pub struct Model {
    pub provider: String,
    pub model: String,
}

impl Model {
    pub fn is_empty(&self) -> bool {
        self.provider.is_empty() && self.model.is_empty()
    }

    pub fn label(&self) -> String {
        if self.model.is_empty() {
            self.provider.clone()
        } else if self.provider.is_empty() {
            self.model.clone()
        } else {
            format!("{} · {}", short_model(&self.model), self.provider)
        }
    }
}

/// One selectable model inside a provider group. `id` is what
/// `session/selectModel` takes; `name` is the display label.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CatalogModel {
    pub id: String,
    pub name: String,
}

/// One provider group from `session/modelCatalog`: the provider id, its display
/// name (the group's `name` field) and every model it offers.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CatalogProvider {
    pub id: String,
    pub name: String,
    pub models: Vec<CatalogModel>,
}

#[derive(Clone, Debug)]
pub struct Session {
    pub id: String,
    pub cwd: String,
    pub updated: i64,
    pub blank: bool,
    pub running: bool,
    pub title: String,
    pub model: Model,
    pub context: String,
    pub tokens: String,
    pub questions: usize,
}

#[derive(Clone, Debug)]
pub struct Message {
    pub role: String,
    pub text: String,
}

#[derive(Clone, Debug)]
pub struct Group {
    pub label: String,
    pub path: String,
    pub sessions: Vec<(usize, Session)>,
}

enum Update {
    Step(String),
    Titles(Vec<(String, String)>),
    Ready(Box<Chat>),
    /// Newest published harness version, when it is ahead of the active one.
    Update(String),
    Failed(String),
}

pub struct Chat {
    host: Host,
    api: Api,
    pub status: String,
    pub sessions: Vec<Session>,
    pub selected: Option<usize>,
    pub messages: Vec<Message>,
    /// Log cut carried by the follow opening snapshot: the through sequence that
    /// every session/page call must not read past.
    pub cursor: Option<i64>,
    /// Whether the harness still holds records older than the loaded window.
    pub has_more: bool,
    /// Sequence of the oldest loaded record: the beforeSeq for the next page.
    pub oldest_seq: Option<i64>,
    pub catalog: Vec<CatalogProvider>,
    pub reused: bool,
    pub startup_ms: u128,
}

impl Chat {
    pub fn connect(mut progress: impl FnMut(&str)) -> anyhow::Result<Self> {
        let started = std::time::Instant::now();
        progress("ハーネスに接続しています…");
        let host = Host::start()?;
        let reused = host.reused;
        progress("接続を認証しています…");
        let api = Api::connect(&host)?;
        let mut chat = Self {
            host,
            api,
            status: String::new(),
            sessions: Vec::new(),
            selected: None,
            messages: Vec::new(),
            cursor: None,
            has_more: false,
            oldest_seq: None,
            catalog: Vec::new(),
            reused,
            startup_ms: 0,
        };
        progress("モデル一覧を取得しています…");
        chat.catalog = chat.load_catalog();
        progress("会話一覧を取得しています…");
        chat.reload_sessions()?;
        progress("会話を読み込んでいます…");
        chat.load_conversation()?;
        chat.startup_ms = started.elapsed().as_millis();
        chat.status = format!(
            "{} 件の会話 / 接続 {}ms / dsh {}{}",
            chat.sessions.len(),
            chat.startup_ms,
            chat.host_version(),
            if chat.reused { "（ホスト再利用）" } else { "" }
        );
        Ok(chat)
    }

    pub fn origin(&self) -> &str {
        &self.host.origin
    }

    pub fn cookie(&self) -> &str {
        self.api.cookie()
    }

    fn load_catalog(&self) -> Vec<CatalogProvider> {
        match self.api.model_catalog() {
            Ok(value) => providers_from_catalog(&value),
            Err(_) => Vec::new(),
        }
    }

    fn reload_sessions(&mut self) -> anyhow::Result<()> {
        let items = self
            .api
            .session_list()?
            .get("items")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let projections = self.load_projections().unwrap_or_default();
        self.sessions = items
            .iter()
            .filter(|item| {
                item.get("origin").is_none()
                    && item
                        .get("parentSessionId")
                        .is_none_or(|value| value.is_null())
            })
            .map(|item| {
                let id = item
                    .get("sessionId")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                let values = projections.get(&id).cloned().unwrap_or(Value::Null);
                Session {
                    id,
                    cwd: item
                        .get("cwd")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                    updated: item.get("updatedAt").and_then(Value::as_i64).unwrap_or(0),
                    blank: item.get("blank").and_then(Value::as_bool).unwrap_or(false),
                    running: item.get("running").and_then(Value::as_bool).unwrap_or(false),
                    title: values
                        .get("title")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                    model: model_of(&values),
                    context: context_of(&values),
                    tokens: tokens_of(&values),
                    questions: active_questions(&values),
                }
            })
            .collect();
        self.sessions
            .sort_by(|left, right| right.updated.cmp(&left.updated));
        if self.selected.is_none() && !self.sessions.is_empty() {
            self.selected = Some(0);
        }
        self.status = format!("{} 件の会話", self.sessions.len());
        Ok(())
    }

    fn load_projections(&self) -> anyhow::Result<HashMap<String, Value>> {
        let mut mux = Mux::connect(&self.host.origin, self.api.cookie())?;
        let stream = mux.open("session/control", serde_json::json!({ "request": {} }))?;
        let opening = mux.read()?;
        let _ = mux.cancel(&stream);
        let frame = opening.get("value").cloned().unwrap_or(Value::Null);
        let mut values = HashMap::new();
        if let Some(entries) = frame
            .get("value")
            .and_then(|value| value.get("projections"))
            .and_then(Value::as_object)
        {
            for (session, entry) in entries {
                values.insert(
                    session.clone(),
                    entry.get("values").cloned().unwrap_or(Value::Null),
                );
            }
        }
        Ok(values)
    }

    pub fn load_conversation(&mut self) -> anyhow::Result<()> {
        let Some(index) = self.selected else {
            return Ok(());
        };
        let Some(session) = self.sessions.get(index).cloned() else {
            return Ok(());
        };
        self.messages.clear();
        self.cursor = None;
        self.has_more = false;
        self.oldest_seq = None;
        let mut mux = Mux::connect(&self.host.origin, self.api.cookie())?;
        let address = serde_json::json!({ "kind": "session", "sessionId": session.id });
        let stream = mux.open(
            "session/follow",
            serde_json::json!({
                "request": { "address": address, "maxMessages": 60, "assistantStream": true }
            }),
        )?;
        let opening = mux.read()?;
        let _ = mux.cancel(&stream);
        if opening.get("type").and_then(Value::as_str) == Some("error") {
            return Ok(());
        }
        let snapshot = opening.get("value").cloned().unwrap_or(Value::Null);
        if let Some(values) = snapshot
            .get("projections")
            .and_then(|projections| projections.get("values"))
        {
            if let Some(session) = self.sessions.get_mut(index) {
                if let Some(title) = values.get("title").and_then(Value::as_str) {
                    session.title = title.to_string();
                }
                let model = model_of(values);
                if !model.is_empty() {
                    session.model = model;
                }
                session.context = context_of(values);
                session.tokens = tokens_of(values);
                session.questions = active_questions(values);
            }
        }
        let records = snapshot
            .get("records")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        // The opening snapshot is the paging anchor: its cursor is the log cut
        // and its hasMore says whether an older page exists.
        self.cursor = snapshot.get("cursor").and_then(Value::as_i64);
        self.has_more = snapshot
            .get("hasMore")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        self.oldest_seq = records.first().and_then(record_seq);
        self.messages = records_to_messages(&records);
        cap_messages(&mut self.messages);
        Ok(())
    }

    /// Read the page immediately before the oldest loaded record and prepend it
    /// in front of the window. Returns whether older records still remain.
    pub fn load_older(&mut self) -> anyhow::Result<bool> {
        if !self.has_more {
            return Ok(false);
        }
        let Some(index) = self.selected else {
            return Ok(false);
        };
        let Some(session) = self.sessions.get(index).cloned() else {
            return Ok(false);
        };
        let Some(through) = self.cursor else {
            anyhow::bail!("履歴カーソルがありません");
        };
        let Some(before) = self.oldest_seq else {
            anyhow::bail!("最古の記録がありません");
        };
        let value = self.api.unary(
            "session/page",
            page_request(&session.id, through, before, PAGE_LIMIT),
        )?;
        let records = value
            .get("records")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let has_more = value
            .get("hasMore")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let state = advance_page(
            PageState {
                oldest: self.oldest_seq,
                has_more: self.has_more,
            },
            &records,
            has_more,
        );
        self.oldest_seq = state.oldest;
        self.has_more = state.has_more;
        self.messages = merge_messages(
            records_to_messages(&records),
            std::mem::take(&mut self.messages),
        );
        cap_messages(&mut self.messages);
        Ok(self.has_more)
    }

    pub fn select(&mut self, index: usize) {
        self.selected = Some(index);
        let _ = self.load_conversation();
    }

    pub fn selected_session(&self) -> Option<&Session> {
        self.selected.and_then(|index| self.sessions.get(index))
    }

    pub fn send_prompt(&mut self, text: &str) -> anyhow::Result<()> {
        let Some(session) = self.selected_session() else {
            anyhow::bail!("会話が選択されていません");
        };
        let session_id = session.id.clone();
        let request_id = format!(
            "rdsh-desktop-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|value| value.as_millis())
                .unwrap_or(0)
        );
        self.api.unary(
            "session/prompt",
            serde_json::json!({
                "request": {
                    "requestId": request_id,
                    "sessionId": session_id,
                    "mode": "queue",
                    "content": [ { "type": "text", "text": text } ]
                }
            }),
        )?;
        Ok(())
    }

    pub fn cancel(&self) -> anyhow::Result<()> {
        let Some(session) = self.selected_session() else {
            return Ok(());
        };
        let session_id = session.id.clone();
        self.api
            .unary("session/cancel", serde_json::json!({ "sessionId": session_id }))?;
        Ok(())
    }

    pub fn select_model(&mut self, provider: &str, model: &str) -> anyhow::Result<()> {
        let Some(session) = self.selected_session() else {
            anyhow::bail!("会話が選択されていません");
        };
        let session_id = session.id.clone();
        self.api.unary(
            "session/selectModel",
            serde_json::json!({
                "request": { "sessionId": session_id, "provider": provider, "model": model }
            }),
        )?;
        if let Some(index) = self.selected {
            if let Some(session) = self.sessions.get_mut(index) {
                session.model = Model {
                    provider: provider.to_string(),
                    model: model.to_string(),
                };
            }
        }
        Ok(())
    }

    pub fn create_session(&mut self, cwd: Option<&str>) -> anyhow::Result<String> {
        let mut request = serde_json::json!({});
        if let Some(cwd) = cwd {
            request["cwd"] = Value::String(cwd.to_string());
        }
        let value = self
            .api
            .unary("session/create", serde_json::json!({ "request": request }))?;
        let id = value
            .get("sessionId")
            .or_else(|| value.get("id"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        if id.is_empty() {
            anyhow::bail!("作成された会話IDを取得できませんでした");
        }
        self.sessions.insert(
            0,
            Session {
                id: id.clone(),
                cwd: cwd.unwrap_or_default().to_string(),
                updated: std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|value| value.as_millis() as i64)
                    .unwrap_or(0),
                blank: true,
                running: false,
                title: String::new(),
                model: Model::default(),
                context: String::new(),
                tokens: String::new(),
                questions: 0,
            },
        );
        self.selected = Some(0);
        self.messages.clear();
        Ok(id)
    }

    /// Version of the harness launcher this session runs against.
    pub fn host_version(&self) -> &str {
        &self.host.version
    }

    /// Path of the launcher, when one was resolved.
    pub fn host_binary(&self) -> &std::path::Path {
        &self.host.binary
    }

    pub fn switch_model(&mut self, session_id: &str, provider: &str, model: &str) -> anyhow::Result<()> {
        self.api.unary(
            "session/selectModel",
            serde_json::json!({"request": {"sessionId": session_id, "provider": provider, "model": model}}),
        )?;
        Ok(())
    }

    /// Current projection values for one conversation.
    pub fn projections(&self, session_id: &str) -> anyhow::Result<Value> {
        self.api.unary("session/projections", serde_json::json!({"sessionId": session_id}))
    }

    pub fn approve(
        &self,
        client_id: &str,
        event_id: &str,
        allow: bool,
    ) -> anyhow::Result<()> {
        let value = if allow { "allowed-once" } else { "rejected" };
        self.api.unary(
            "$events/result",
            serde_json::json!({
                "clientId": client_id,
                "eventId": event_id,
                "outcome": { "kind": "result", "value": value }
            }),
        )?;
        Ok(())
    }

    pub fn answer_question(
        &self,
        session_id: &str,
        call_id: &str,
        answers: &[(String, Vec<String>)],
    ) -> anyhow::Result<()> {
        let payload: Vec<serde_json::Value> = answers
            .iter()
            .map(|(id, selected)| serde_json::json!({ "id": id, "selected": selected }))
            .collect();
        self.api.unary(
            "userQuestions/answer",
            serde_json::json!({
                "sessionId": session_id,
                "callId": call_id,
                "answer": { "answers": payload }
            }),
        )?;
        Ok(())
    }

    /// Rename one conversation; the harness returns the stored title.
    pub fn rename_session(&self, session_id: &str, title: &str) -> anyhow::Result<String> {
        let value = self.api.unary(
            "session/rename",
            serde_json::json!({ "request": { "sessionId": session_id, "title": title } }),
        )?;
        Ok(value
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or(title)
            .to_string())
    }

    pub fn fill_titles(
        &mut self,
        limit: usize,
        mut on_batch: impl FnMut(Vec<(String, String)>),
    ) {
        let pending: Vec<String> = self
            .sessions
            .iter()
            .filter(|session| session.title.is_empty())
            .take(limit)
            .map(|session| session.id.clone())
            .collect();
        let mut batch = Vec::new();
        for id in pending {
            if let Ok(title) = self.session_title(&id) {
                if !title.is_empty() {
                    if let Some(session) = self.sessions.iter_mut().find(|session| session.id == id) {
                        session.title = title.clone();
                    }
                    batch.push((id, title));
                }
            }
            if batch.len() >= 8 {
                on_batch(std::mem::take(&mut batch));
            }
        }
        if !batch.is_empty() {
            on_batch(batch);
        }
    }

    pub fn session_title(&self, session: &str) -> anyhow::Result<String> {
        fetch_title(self.origin(), self.api.cookie(), session)
    }

    pub fn groups(&self) -> Vec<Group> {
        let mut groups: Vec<Group> = Vec::new();
        for (index, session) in self.sessions.iter().enumerate() {
            let label = project_label(&session.cwd);
            match groups.iter_mut().find(|group| group.label == label) {
                Some(group) => group.sessions.push((index, session.clone())),
                None => groups.push(Group {
                    label,
                    path: project_path(&session.cwd),
                    sessions: vec![(index, session.clone())],
                }),
            }
        }
        groups
    }
}


/// Read one conversation title over a short-lived socket. Free function so the
/// title workers can run after the window already owns the connection.
pub fn fetch_title(origin: &str, cookie: &str, session: &str) -> anyhow::Result<String> {
    let mut mux = Mux::connect(origin, cookie)?;
    let address = serde_json::json!({ "kind": "session", "sessionId": session });
    let stream = mux.open(
        "session/follow",
        serde_json::json!({ "request": { "address": address, "maxMessages": 1 } }),
    )?;
    let opening = mux.read()?;
    let _ = mux.cancel(&stream);
    let value = opening.get("value").cloned().unwrap_or(Value::Null);
    Ok(value
        .get("projections")
        .and_then(|projections| projections.get("values"))
        .and_then(|values| values.get("title"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string())
}

fn model_of(values: &Value) -> Model {
    let selection = values.get("modelSelection");
    let next = selection
        .and_then(|selection| selection.get("next"))
        .or_else(|| selection.and_then(|selection| selection.get("lastUsed")));
    Model {
        provider: next
            .and_then(|next| next.get("provider"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        model: next
            .and_then(|next| next.get("model"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
    }
}

fn context_of(values: &Value) -> String {
    let pressure = values.get("contextPressure");
    let used = pressure
        .and_then(|pressure| pressure.get("pressureTokens"))
        .and_then(Value::as_i64);
    let window = pressure
        .and_then(|pressure| pressure.get("contextWindow"))
        .and_then(Value::as_i64);
    match (used, window) {
        (Some(used), Some(window)) if window > 0 => {
            format!("ctx {}%", (used * 100 / window).min(100))
        }
        (Some(used), _) => format!("ctx {}", compact(used)),
        _ => String::new(),
    }
}

fn tokens_of(values: &Value) -> String {
    let usage = values.get("tokenUsage");
    let input = usage
        .and_then(|usage| usage.get("uncachedInputTokens"))
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let output = usage
        .and_then(|usage| usage.get("outputTokens"))
        .and_then(Value::as_i64)
        .unwrap_or(0);
    if input == 0 && output == 0 {
        return String::new();
    }
    format!("{} in / {} out", compact(input), compact(output))
}

fn active_questions(values: &Value) -> usize {
    values
        .get("userQuestions")
        .and_then(|questions| questions.get("active"))
        .and_then(Value::as_array)
        .map(Vec::len)
        .unwrap_or(0)
}

fn compact(value: i64) -> String {
    if value >= 1_000_000 {
        format!("{:.1}M", value as f64 / 1_000_000.0)
    } else if value >= 1_000 {
        format!("{:.0}k", value as f64 / 1_000.0)
    } else {
        value.to_string()
    }
}

fn part_text(parts: &Value, kind: &str) -> String {
    let Some(items) = parts.as_array() else {
        return String::new();
    };
    let mut text = String::new();
    for item in items {
        if item.get("type").and_then(Value::as_str) == Some(kind) {
            if let Some(value) = item.get("text").and_then(Value::as_str) {
                text.push_str(value);
            }
        }
    }
    text
}

fn records_to_messages(records: &[Value]) -> Vec<Message> {
    let mut messages = Vec::new();
    for record in records {
        let event = record.get("event").cloned().unwrap_or(Value::Null);
        let kind = event
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("event");
        let data = event.get("data").cloned().unwrap_or(Value::Null);
        match kind {
            "user/message" => {
                let mut text = part_text(data.get("content").unwrap_or(&Value::Null), "text");
                if text.is_empty() {
                    collect_text(&data, &mut text);
                }
                if !text.trim().is_empty() {
                    messages.push(Message {
                        role: "user".to_string(),
                        text: text.trim().to_string(),
                    });
                }
            }
            "assistant/message" => {
                let content = data.get("content").cloned().unwrap_or(Value::Null);
                let reasoning = part_text(&content, "reasoning");
                if !reasoning.trim().is_empty() {
                    messages.push(Message {
                        role: "reasoning".to_string(),
                        text: reasoning.trim().to_string(),
                    });
                }
                let text = part_text(&content, "text");
                if !text.trim().is_empty() {
                    messages.push(Message {
                        role: "assistant".to_string(),
                        text: text.trim().to_string(),
                    });
                }
            }
            "tool/call" => {
                let name = data
                    .get("name")
                    .or_else(|| data.get("toolName"))
                    .and_then(Value::as_str)
                    .unwrap_or("tool");
                let mut summary = String::new();
                collect_text(data.get("args").unwrap_or(&Value::Null), &mut summary);
                let summary = summary.trim();
                let text = if summary.is_empty() {
                    name.to_string()
                } else {
                    format!("{name} · {}", truncate(summary, 120))
                };
                messages.push(Message {
                    role: "tool".to_string(),
                    text,
                });
            }
            _ => {}
        }
    }
    messages
}

/// Durable sequence of one history record. Records wrap their event, so the
/// sequence normally lives on the inner event.
fn record_seq(record: &Value) -> Option<i64> {
    record
        .get("seq")
        .or_else(|| record.get("event").and_then(|event| event.get("seq")))
        .and_then(Value::as_i64)
}

/// Paging bookkeeping kept beside the timeline.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct PageState {
    /// Sequence of the oldest loaded record, or None for an empty window.
    oldest: Option<i64>,
    /// Whether the harness reported older records after the last page.
    has_more: bool,
}

/// Fold one session/page response into the current paging state. The anchor only
/// moves when the page carries records, and an empty page clears has_more so a
/// contradictory response cannot make the button loop forever.
fn advance_page(state: PageState, records: &[Value], has_more: bool) -> PageState {
    match records.first().and_then(record_seq) {
        Some(oldest) => PageState {
            oldest: Some(oldest),
            has_more,
        },
        None => PageState {
            oldest: state.oldest,
            has_more: false,
        },
    }
}

/// The session/page request for the page ending just before "before".
fn page_request(session_id: &str, through: i64, before: i64, limit: usize) -> Value {
    serde_json::json!({
        "request": {
            "address": { "kind": "session", "sessionId": session_id },
            "throughSeq": through,
            "beforeSeq": before,
            "maxMessages": limit,
        }
    })
}

/// Older records go in front of the window. Both slices are oldest-first, so the
/// result stays chronological.
fn merge_messages(older: Vec<Message>, current: Vec<Message>) -> Vec<Message> {
    let mut merged = older;
    merged.extend(current);
    merged
}

/// Trim the timeline to MAX_RETAINED_MESSAGES and report how many rows went.
///
/// A prepend must not move what is on screen, so the rows that go are the oldest
/// ones; the page anchor is tracked separately, so trimming never blocks paging.
/// Only when one page is larger than the whole cap does the cut move to the
/// middle, keeping both the newest rows and the oldest anchor instead of
/// throwing the fresh page away.
fn cap_messages(messages: &mut Vec<Message>) -> usize {
    if messages.len() <= MAX_RETAINED_MESSAGES {
        return 0;
    }
    let excess = messages.len() - MAX_RETAINED_MESSAGES;
    let cut = if excess * 2 >= messages.len() {
        excess / 2
    } else {
        0
    };
    messages.drain(cut..cut + excess);
    excess
}

/// Whether "now" is a second Esc close enough to the previous one to cancel.
fn esc_cancels(previous: Option<Instant>, now: Instant) -> bool {
    previous.is_some_and(|previous| now.saturating_duration_since(previous) <= ESC_CANCEL_WINDOW)
}

/// Case-insensitive substring search over a session title and its project path.
/// A blank or all-space filter keeps every row.
fn session_matches(filter: &str, title: &str, cwd: &str) -> bool {
    let needle = filter.trim().to_lowercase();
    if needle.is_empty() {
        return true;
    }
    title.to_lowercase().contains(&needle) || cwd.to_lowercase().contains(&needle)
}

/// The sidebar label for one session, shared by rendering and filtering so a row
/// that is visible is also searchable.
fn session_display_title(session: &Session, titles: &HashMap<String, String>) -> String {
    titles
        .get(&session.id)
        .cloned()
        .filter(|title| !title.is_empty())
        .or_else(|| (!session.title.is_empty()).then(|| session.title.clone()))
        .unwrap_or_else(|| {
            if session.blank {
                "新しい会話".to_string()
            } else {
                short_id(&session.id)
            }
        })
}

/// First (session index, title, cwd) row that passes the filter, in the order the
/// sidebar displays them.
fn first_match(rows: &[(usize, String, String)], filter: &str) -> Option<usize> {
    rows.iter()
        .find(|(_, title, cwd)| session_matches(filter, title, cwd))
        .map(|(index, _, _)| *index)
}

fn truncate(text: &str, limit: usize) -> String {
    if text.chars().count() <= limit {
        return text.to_string();
    }
    let mut out: String = text.chars().take(limit).collect();
    out.push('…');
    out
}

pub(crate) fn collect_text(value: &Value, out: &mut String) {
    match value {
        Value::String(text) => out.push_str(text),
        Value::Array(items) => {
            for item in items {
                collect_text(item, out);
            }
        }
        Value::Object(map) => {
            for (key, item) in map {
                if matches!(key.as_str(), "text" | "content") {
                    collect_text(item, out);
                }
            }
        }
        _ => {}
    }
}

pub fn project_label(cwd: &str) -> String {
    if cwd.is_empty() {
        return "その他".to_string();
    }
    let name = cwd.trim_end_matches('/').rsplit('/').next().unwrap_or(cwd);
    if let Some((prefix, rest)) = name.split_once('-') {
        if prefix.len() >= 8 && prefix.chars().all(|character| character.is_ascii_hexdigit()) {
            return rest.to_string();
        }
    }
    name.to_string()
}

pub fn project_path(cwd: &str) -> String {
    let home = std::env::var("HOME").unwrap_or_default();
    let short = if !home.is_empty() && cwd.starts_with(&home) {
        format!("~{}", &cwd[home.len()..])
    } else {
        cwd.to_string()
    };
    let parts: Vec<&str> = short.trim_end_matches('/').split('/').collect();
    match parts.len() {
        0 => short,
        1 => parts[0].to_string(),
        _ => format!(
            "{}/{}",
            parts[parts.len() - 2],
            project_label(short.as_str())
        ),
    }
}

/// Parse a `session/modelCatalog` value into provider groups. Every group with
/// an id is kept in catalog order and every model with an id is kept; a missing
/// `name` falls back to the id so nothing is dropped from the picker.
pub fn providers_from_catalog(value: &Value) -> Vec<CatalogProvider> {
    let mut providers = Vec::new();
    let Some(groups) = value.get("groups").and_then(Value::as_array) else {
        return providers;
    };
    for group in groups {
        let id = group.get("id").and_then(Value::as_str).unwrap_or_default();
        if id.is_empty() {
            continue;
        }
        let name = group
            .get("name")
            .and_then(Value::as_str)
            .filter(|name| !name.is_empty())
            .unwrap_or(id)
            .to_string();
        let mut models = Vec::new();
        if let Some(entries) = group.get("models").and_then(Value::as_array) {
            for entry in entries {
                let model_id = entry.get("id").and_then(Value::as_str).unwrap_or_default();
                if model_id.is_empty() {
                    continue;
                }
                let model_name = entry
                    .get("name")
                    .and_then(Value::as_str)
                    .filter(|name| !name.is_empty())
                    .unwrap_or(model_id)
                    .to_string();
                models.push(CatalogModel {
                    id: model_id.to_string(),
                    name: model_name,
                });
            }
        }
        providers.push(CatalogProvider {
            id: id.to_string(),
            name,
            models,
        });
    }
    providers
}

/// Order providers for the picker: the provider that owns the current selection
/// comes first, every other provider keeps its catalog order and no model is
/// dropped. An unknown current provider leaves the catalog order untouched.
pub fn order_providers(
    providers: &[CatalogProvider],
    current_provider: &str,
) -> Vec<CatalogProvider> {
    let mut ordered = providers.to_vec();
    if let Some(index) = ordered
        .iter()
        .position(|provider| provider.id == current_provider)
    {
        let current = ordered.remove(index);
        ordered.insert(0, current);
    }
    ordered
}

/// The catalog entry for one provider/model pair, if the catalog lists it.
pub fn catalog_model<'a>(
    providers: &'a [CatalogProvider],
    provider: &str,
    model: &str,
) -> Option<&'a CatalogModel> {
    providers
        .iter()
        .find(|entry| entry.id == provider)?
        .models
        .iter()
        .find(|entry| entry.id == model)
}

/// Maximum composer height: eight body lines at 24px plus a little padding.
const COMPOSER_MAX_HEIGHT: f32 = 200.;

/// Rows of the composer text field.
///
/// The editor text is split on hard line breaks; each logical line becomes one
/// flex row that wraps inside the field width. The caret is rendered inline
/// between the text before and after it, so within a row it lands exactly at
/// the character boundary without needing the caret's x offset.
fn input_rows(input: &str, caret: usize) -> Vec<AnyElement> {
    let caret = caret.min(input.len());
    let mut rows = Vec::new();
    let mut start = 0usize;
    loop {
        let break_at = input[start..].find('\n').map(|index| start + index);
        let end = break_at.unwrap_or(input.len());
        let line = &input[start..end];
        // The caret is always on a character boundary, but stay defensive: a
        // mis-aligned offset must degrade to a caret-less line, not panic.
        let (before, after) = if caret < start || line.get(..caret - start).is_none() {
            ("", line)
        } else if caret <= end {
            let offset = caret - start;
            (&line[..offset], &line[offset..])
        } else {
            (line, "")
        };
        let mut row = div()
            .w_full()
            .min_h(theme::body_line_height())
            .flex()
            .flex_row()
            .flex_wrap()
            .items_start()
            .text_size(theme::body_size())
            .line_height(theme::body_line_height())
            .text_color(theme::label());
        if !before.is_empty() {
            row = row.child(before.to_string());
        }
        if (start..=end).contains(&caret) {
            row = row.child(
                div()
                    .w(px(2.))
                    .h(theme::body_line_height())
                    .flex_none()
                    .bg(theme::accent()),
            );
        }
        if !after.is_empty() {
            row = row.child(after.to_string());
        }
        rows.push(row.into_any_element());
        match break_at {
            Some(index) => start = index + 1,
            None => break,
        }
    }
    rows
}

/// Composer text for the current selection. The catalog display name is used
/// when the catalog knows the pair; a selection the catalog does not list is
/// still shown, with a note saying so. An empty catalog means "unknown", not
/// "absent", so it does not add the note.
pub fn composer_model_label(model: &Model, providers: &[CatalogProvider]) -> String {
    if model.is_empty() {
        return String::new();
    }
    if providers.is_empty() {
        return model.label();
    }
    match catalog_model(providers, &model.provider, &model.model) {
        Some(entry) => {
            let name = if entry.name.is_empty() {
                short_model(&model.model)
            } else {
                entry.name.clone()
            };
            if model.provider.is_empty() {
                name
            } else {
                format!("{} · {}", name, model.provider)
            }
        }
        None => format!("{}（カタログにありません）", model.label()),
    }
}

fn short_model(model: &str) -> String {
    model.rsplit('/').next().unwrap_or(model).to_string()
}

#[cfg(test)]
mod ui_state_tests {
    use super::{load_ui_state, save_ui_state};
    use std::collections::HashSet;

    #[test]
    fn sidebar_state_round_trips_through_the_config_file() {
        let home = std::env::temp_dir().join(format!("rdsh-ui-state-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(&home).unwrap();
        std::env::set_var("XDG_CONFIG_HOME", &home);
        let mut collapsed = HashSet::new();
        collapsed.insert("/home/me/Prog/one".to_string());
        let mut archived = HashSet::new();
        archived.insert("/home/me/Prog/two".to_string());
        save_ui_state(&collapsed, &archived);
        let (loaded_collapsed, loaded_archived) = load_ui_state();
        assert_eq!(loaded_collapsed, collapsed);
        assert_eq!(loaded_archived, archived);
        std::env::remove_var("XDG_CONFIG_HOME");
        let _ = std::fs::remove_dir_all(&home);
    }
}

#[cfg(test)]
mod tests {
    use super::{
        advance_page, byte_to_utf16, cap_messages, composer_model_label, esc_cancels, first_match,
        ime_replacement_range, ime_selected_range, merge_messages, order_providers, project_label,
        project_path, providers_from_catalog, reasoning_preview, record_seq, session_matches,
        short_model, tool_state_of, tool_text_state, utf16_to_byte, CatalogModel, CatalogProvider,
        Message, Model, PageState, ToolState,
    };
    use std::time::{Duration, Instant};

    fn message(text: &str) -> Message {
        Message {
            role: "user".to_string(),
            text: text.to_string(),
        }
    }

    fn provider(id: &str, name: &str, models: &[&str]) -> CatalogProvider {
        CatalogProvider {
            id: id.to_string(),
            name: name.to_string(),
            models: models
                .iter()
                .map(|model| CatalogModel {
                    id: model.to_string(),
                    name: model.to_string(),
                })
                .collect(),
        }
    }

    #[test]
    fn strips_checkout_hashes_from_folder_names() {
        assert_eq!(
            project_label("/home/sahen/Projects/windows-migration/c1a2a17f4caf-rustdsh"),
            "rustdsh"
        );
    }

    #[test]
    fn keeps_plain_folder_names() {
        assert_eq!(project_label("/home/sahen/File/Prog/rustdsh"), "rustdsh");
        assert_eq!(project_label("/srv/team/26.10.04"), "26.10.04");
        assert_eq!(project_label(""), "その他");
    }

    #[test]
    fn header_shows_parent_and_project_for_foreign_paths() {
        assert_eq!(project_path("/srv/work/rustdsh"), "work/rustdsh");
        assert_eq!(
            project_path("/srv/team/2026/c1a2a17f4caf-rustdsh"),
            "2026/rustdsh"
        );
    }

    #[test]
    fn model_label_keeps_the_provider_visible() {
        let model = Model {
            provider: "commandcode-goat".to_string(),
            model: "deepseek/deepseek-v4.1-flash".to_string(),
        };
        assert_eq!(model.label(), "deepseek-v4.1-flash · commandcode-goat");
        assert_eq!(
            short_model("opencode/deepseek-v4.1-flash-free"),
            "deepseek-v4.1-flash-free"
        );
    }

    #[test]
    fn empty_model_is_reported_as_empty() {
        assert!(Model::default().is_empty());
    }

    #[test]
    fn catalog_groups_keep_every_provider_and_model() {
        let value = serde_json::json!({
            "groups": [
                {
                    "id": "deepseek-official",
                    "name": "DeepSeek",
                    "models": [
                        { "id": "deepseek-flash", "name": "DeepSeek-V41-Flash" },
                        { "id": "deepseek-v4-pro", "name": "DeepSeek-V4-Pro" }
                    ]
                },
                {
                    // No group name: the provider id is the display name.
                    "id": "opencode-go",
                    "models": [ { "id": "minimax-m3" } ]
                },
                {
                    "id": "commandcode-goat",
                    "name": "CommandCode Goat",
                    "models": [
                        { "id": "deepseek/deepseek-v4.1-flash", "name": "DeepSeek V4.1 Flash" },
                        { "id": "claude-sonnet-5", "name": "Claude Sonnet 5" }
                    ]
                }
            ]
        });
        let providers = providers_from_catalog(&value);
        assert_eq!(providers.len(), 3, "one section per provider");
        assert_eq!(providers[0].id, "deepseek-official");
        assert_eq!(providers[0].name, "DeepSeek");
        assert_eq!(providers[1].name, "opencode-go", "missing name falls back to id");
        assert_eq!(providers[1].models[0].name, "minimax-m3", "missing model name falls back to id");
        assert_eq!(providers[2].id, "commandcode-goat");
        assert_eq!(providers[2].name, "CommandCode Goat");
        assert_eq!(
            providers[2].models[0].id,
            "deepseek/deepseek-v4.1-flash",
            "the commandcode-goat section is not truncated"
        );
        let total: usize = providers.iter().map(|provider| provider.models.len()).sum();
        assert_eq!(total, 5, "every model is retained");
    }

    #[test]
    fn ordering_puts_the_current_provider_first_and_keeps_the_rest_stable() {
        let providers = vec![
            provider("deepseek-official", "DeepSeek", &["deepseek-flash", "deepseek-v4-pro"]),
            provider("openai-codex", "Codex", &["gpt-5.5"]),
            provider("opencode-go", "opencode-go", &["minimax-m3"]),
            provider("opencode-free", "opencode-free", &["opencode/glm-5.3-flash-free"]),
            provider(
                "commandcode-goat",
                "CommandCode Goat",
                &["deepseek/deepseek-v4.1-flash", "claude-sonnet-5"],
            ),
        ];

        let ordered = order_providers(&providers, "commandcode-goat");
        let ids: Vec<&str> = ordered.iter().map(|provider| provider.id.as_str()).collect();
        assert_eq!(
            ids,
            [
                "commandcode-goat",
                "deepseek-official",
                "openai-codex",
                "opencode-go",
                "opencode-free",
            ],
            "current provider first, the rest stable"
        );
        assert_eq!(
            ordered[0].models[0].id, "deepseek/deepseek-v4.1-flash",
            "the current provider keeps all of its models"
        );
        let total: usize = ordered.iter().map(|provider| provider.models.len()).sum();
        assert_eq!(total, 7, "no model is dropped while reordering");

        let untouched: Vec<String> = order_providers(&providers, "not-installed")
            .into_iter()
            .map(|provider| provider.id)
            .collect();
        assert_eq!(
            untouched,
            providers.iter().map(|provider| provider.id.clone()).collect::<Vec<_>>(),
            "an unknown current provider leaves the catalog order alone"
        );
    }

    #[test]
    fn composer_says_when_the_current_model_is_not_in_the_catalog() {
        let providers = vec![provider(
            "commandcode-goat",
            "CommandCode Goat",
            &["deepseek/deepseek-v4.1-flash"],
        )];
        let known = Model {
            provider: "commandcode-goat".to_string(),
            model: "deepseek/deepseek-v4.1-flash".to_string(),
        };
        assert_eq!(
            composer_model_label(&known, &providers),
            "deepseek/deepseek-v4.1-flash · commandcode-goat"
        );

        let unknown = Model {
            provider: "commandcode-goat".to_string(),
            model: "deepseek/deepseek-v4.1-flash-ghost".to_string(),
        };
        assert_eq!(
            composer_model_label(&unknown, &providers),
            "deepseek-v4.1-flash-ghost · commandcode-goat（カタログにありません）"
        );

        // An empty catalog is "unknown", not "absent".
        assert_eq!(
            composer_model_label(&unknown, &[]),
            "deepseek-v4.1-flash-ghost · commandcode-goat"
        );
    }

    #[test]
    fn ime_replacement_prefers_the_platform_range() {
        assert_eq!(
            ime_replacement_range(Some(2..5), Some(0..1), 9..9),
            2..5,
            "an explicit platform range wins over the marked preedit"
        );
    }

    #[test]
    fn ime_replacement_falls_back_to_the_marked_preedit() {
        assert_eq!(
            ime_replacement_range(None, Some(0..1), 3..3),
            0..1,
            "a preedit update replaces the marked text instead of inserting after it"
        );
    }

    #[test]
    fn ime_replacement_falls_back_to_the_editor_selection() {
        assert_eq!(ime_replacement_range(None, None, 4..7), 4..7);
    }

    #[test]
    fn ime_selected_range_is_relative_to_the_inserted_text() {
        // "k" replaced by "ka" at UTF-16 3..5: the cursor at the end stays there.
        assert_eq!(ime_selected_range(3..5, 2..2), 5..5);
        // A segment selected inside the preedit keeps its span.
        assert_eq!(ime_selected_range(3..7, 1..3), 4..6);
    }

    #[test]
    fn ime_selected_range_is_clamped_to_the_inserted_text() {
        assert_eq!(ime_selected_range(3..5, 0..99), 3..5);
        assert_eq!(ime_selected_range(3..5, 9..9), 5..5);
    }

    #[test]
    fn ime_offsets_map_across_surrogate_pairs() {
        let text = "a😀b"; // UTF-16: a=0..1, 😀=1..3, b=3..4
        assert_eq!(utf16_to_byte(text, 0), 0);
        assert_eq!(utf16_to_byte(text, 1), 1);
        assert_eq!(utf16_to_byte(text, 3), 5);
        assert_eq!(utf16_to_byte(text, 4), 6);
        assert_eq!(byte_to_utf16(text, 1), 1);
        assert_eq!(byte_to_utf16(text, 5), 3);
    }

    #[test]
    fn tool_rows_infer_their_state_from_the_message_text() {
        assert_eq!(tool_text_state("read_file · src/app.rs"), ToolState::Done);
        assert_eq!(tool_text_state("read_file · running"), ToolState::Running);
        assert_eq!(tool_text_state("bazel · 実行中"), ToolState::Running);
        assert_eq!(tool_text_state("cargo test · done"), ToolState::Done);
        assert_eq!(tool_text_state("cargo test · 完了"), ToolState::Done);
        assert_eq!(tool_text_state("write · failed"), ToolState::Failed);
        assert_eq!(tool_text_state("write · permission denied"), ToolState::Failed);
        assert_eq!(tool_text_state("shell · エラー"), ToolState::Failed);
        assert_eq!(tool_text_state("shell · status: DONE, errorCount: 0"), ToolState::Failed);
    }

    #[test]
    fn tool_rows_split_name_from_summary() {
        let (name, state, summary) = tool_state_of("read_file · src/app.rs");
        assert_eq!(name, "read_file");
        assert_eq!(state, ToolState::Done);
        assert_eq!(summary, "src/app.rs");

        let (name, state, summary) = tool_state_of("tool: find · failed · no such file");
        assert_eq!(name, "find");
        assert_eq!(state, ToolState::Failed);
        assert_eq!(summary, "failed · no such file");

        let (name, _, summary) = tool_state_of("apply_patch");
        assert_eq!(name, "apply_patch");
        assert!(summary.is_empty());

        let (name, _, _) = tool_state_of("   ");
        assert_eq!(name, "tool");
    }

    #[test]
    fn reasoning_preview_is_one_shortened_line() {
        assert_eq!(reasoning_preview("  a\n  b  "), "a b");
        let long = "x".repeat(200);
        let preview = reasoning_preview(&long);
        assert_eq!(preview.chars().count(), 97, "96 characters plus the ellipsis");
        assert!(preview.ends_with('…'));
    }

    #[test]
    fn older_pages_prepend_in_front_of_the_window() {
        let older = vec![message("m1"), message("m2")];
        let current = vec![message("m3")];
        let merged = merge_messages(older, current);
        let texts: Vec<&str> = merged.iter().map(|row| row.text.as_str()).collect();
        assert_eq!(texts, ["m1", "m2", "m3"], "the page stays oldest-first");
    }

    #[test]
    fn page_progress_moves_the_anchor_and_tracks_has_more() {
        let records = vec![
            serde_json::json!({ "type": "event", "event": { "seq": 7 } }),
            serde_json::json!({ "type": "event", "event": { "seq": 9 } }),
        ];
        assert_eq!(record_seq(&records[0]), Some(7));
        let state = advance_page(
            PageState {
                oldest: Some(20),
                has_more: true,
            },
            &records,
            true,
        );
        assert_eq!(
            state,
            PageState {
                oldest: Some(7),
                has_more: true,
            }
        );
        // A response that claims more but carries nothing must stop the loop.
        let exhausted = advance_page(state, &[], true);
        assert_eq!(
            exhausted,
            PageState {
                oldest: Some(7),
                has_more: false,
            }
        );
    }

    #[test]
    fn retained_timeline_drops_the_oldest_rows() {
        let mut rows: Vec<Message> = (0..460)
            .map(|index| message(&format!("m{index}")))
            .collect();
        assert_eq!(cap_messages(&mut rows), 60);
        assert_eq!(rows.len(), 400);
        assert_eq!(rows[0].text, "m60", "the newest 400 rows survive");
        assert_eq!(rows[399].text, "m459");
    }

    #[test]
    fn one_oversized_page_is_trimmed_from_the_middle() {
        // A page larger than the whole cap cannot keep every newest row and the
        // oldest anchor with a front-only cut, so the middle is dropped instead.
        let mut rows: Vec<Message> = (0..900)
            .map(|index| message(&format!("m{index}")))
            .collect();
        assert_eq!(cap_messages(&mut rows), 500);
        assert_eq!(rows.len(), 400);
        assert_eq!(rows[0].text, "m0", "the oldest anchor survives");
        assert_eq!(rows[399].text, "m899", "so does the newest row");

        let mut small: Vec<Message> = (0..400)
            .map(|index| message(&format!("m{index}")))
            .collect();
        assert_eq!(cap_messages(&mut small), 0);
        assert_eq!(small.len(), 400);
    }

    #[test]
    fn escape_cancels_only_on_a_second_press_inside_the_window() {
        let first = Instant::now();
        assert!(!esc_cancels(None, first), "the first Esc only arms");
        assert!(esc_cancels(Some(first), first + Duration::from_millis(700)));
        assert!(!esc_cancels(Some(first), first + Duration::from_millis(701)));
    }

    #[test]
    fn the_filter_matches_titles_and_project_paths_without_case() {
        assert!(
            session_matches("", "anything", "/srv/x"),
            "a blank filter keeps every row"
        );
        assert!(session_matches("  ", "anything", "/srv/x"));
        assert!(session_matches("RUST", "rustdsh の作業", "/home/me/Prog/rustdsh"));
        assert!(session_matches(
            "prog/rustdsh",
            "設計レビュー",
            "/home/me/Prog/rustdsh"
        ));
        assert!(session_matches("設計", "設計レビュー", "/srv/x"));
        assert!(!session_matches("missing", "設計レビュー", "/srv/x"));
    }

    #[test]
    fn enter_picks_the_first_visible_match() {
        let rows = vec![
            (3, "alpha".to_string(), "/srv/one".to_string()),
            (5, "beta".to_string(), "/srv/two".to_string()),
            (9, "alpha two".to_string(), "/srv/three".to_string()),
        ];
        assert_eq!(first_match(&rows, "ALPHA"), Some(3));
        assert_eq!(first_match(&rows, "/srv/two"), Some(5));
        assert_eq!(first_match(&rows, "none"), None);
        assert_eq!(first_match(&rows, ""), Some(3));
    }
}

/// Sidebar preferences live next to the app's other user config.
fn ui_state_path() -> Option<std::path::PathBuf> {
    let base = std::env::var_os("XDG_CONFIG_HOME")
        .map(std::path::PathBuf::from)
        .or_else(|| {
            std::env::var_os("HOME").map(|home| std::path::PathBuf::from(home).join(".config"))
        })?;
    Some(base.join("rdsh-desktop").join("ui.json"))
}

fn load_ui_state() -> (HashSet<String>, HashSet<String>) {
    let empty = || (HashSet::new(), HashSet::new());
    let Some(path) = ui_state_path() else {
        return empty();
    };
    let Ok(text) = std::fs::read_to_string(path) else {
        return empty();
    };
    let Ok(value) = serde_json::from_str::<Value>(&text) else {
        return empty();
    };
    let read = |key: &str| -> HashSet<String> {
        value
            .get(key)
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default()
    };
    (read("collapsed"), read("archived"))
}

fn save_ui_state(collapsed: &HashSet<String>, archived: &HashSet<String>) {
    let Some(path) = ui_state_path() else {
        return;
    };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let body = serde_json::json!({
        "collapsed": collapsed.iter().cloned().collect::<Vec<_>>(),
        "archived": archived.iter().cloned().collect::<Vec<_>>(),
    });
    let _ = std::fs::write(path, body.to_string());
}

fn short_id(id: &str) -> String {
    id.chars()
        .rev()
        .take(6)
        .collect::<String>()
        .chars()
        .rev()
        .collect()
}

fn relative(updated: i64) -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_millis() as i64)
        .unwrap_or(0);
    let minutes = ((now - updated) / 60_000).max(0);
    if minutes < 1 {
        "たった今".to_string()
    } else if minutes < 60 {
        format!("{minutes}分前")
    } else if minutes < 60 * 24 {
        format!("{}時間前", minutes / 60)
    } else {
        format!("{}日前", minutes / (60 * 24))
    }
}

pub struct DesktopApp {
    chat: Option<Box<Chat>>,
    titles: HashMap<String, String>,
    status: String,
    /// Composer editing model: text, caret and selection.
    editor: Editor,
    focus: FocusHandle,
    /// Kept in sync with the composer's text area so typing scrolls it.
    composer_scroll: ScrollHandle,
    live: Sender<LiveCmd>,
    pending: Option<Pending>,
    client_id: Option<String>,
    streaming: String,
    running: bool,
    dirty: bool,
    picker: bool,
    marked: Option<Range<usize>>,
    sidebar_scroll: ScrollHandle,
    timeline_scroll: ScrollHandle,
    model_scroll: ScrollHandle,
    /// Newest published harness version when an upgrade exists.
    update: Option<String>,
    /// Timeline message ids whose reasoning row the user expanded. Reasoning is
    /// collapsed by default, so only the opened rows are kept.
    expanded: Rc<RefCell<HashSet<String>>>,
    /// Project rows the operator folded away.
    collapsed_projects: HashSet<String>,
    /// Projects archived out of the sidebar.
    archived_projects: HashSet<String>,
    show_archived: bool,
    /// Conversation being renamed inline, plus its edit buffer.
    rename_target: Option<String>,
    rename_editor: Editor,
    rename_focus: FocusHandle,
    /// Sidebar search box; empty means no filtering.
    filter: Editor,
    filter_focus: FocusHandle,
    /// Last Esc press, for the double-Esc cancel while a run is active.
    last_escape: Option<Instant>,
}

impl DesktopApp {
    pub fn new(cx: &mut Context<Self>) -> Self {
        let (collapsed_projects, archived_projects) = load_ui_state();
        let (update_tx, update_rx) = mpsc::channel();
        let (live_cmd_tx, live_cmd_rx) = mpsc::channel();
        let (live_evt_tx, live_evt_rx) = mpsc::channel();

        std::thread::spawn(move || {
            let progress = update_tx.clone();
            let mut chat = match Chat::connect(move |step| {
                let _ = progress.send(Update::Step(step.to_string()));
            }) {
                Ok(chat) => chat,
                Err(error) => {
                    let _ = update_tx.send(Update::Failed(format!(
                        "ハーネスに接続できませんでした: {error}"
                    )));
                    return;
                }
            };
            // Ready arrives before titles: the sidebar shows the list at once and
            // titles stream in from worker threads while the window is usable.
            let origin = chat.origin().to_string();
            let cookie = chat.cookie().to_string();
            let pending: Vec<String> = chat
                .sessions
                .iter()
                .filter(|session| session.title.is_empty())
                .map(|session| session.id.clone())
                .collect();
            let titles = update_tx.clone();
            let active_version = chat.host_version().to_string();
            let _ = update_tx.send(Update::Ready(Box::new(chat)));
            // Update awareness mirrors rustdsh's own update notification: one
            // background registry query per launch, never blocking the window.
            if std::env::var("RDSH_DESKTOP_UPDATE_CHECK").as_deref() != Ok("0") {
                // Announce what the last check already knows, so the notice is
                // visible on the first frame instead of one registry round later.
                if let Some(cached) = crate::host::cached_newest_published() {
                    if crate::host::compare_versions(&cached, &active_version).is_gt() {
                        let _ = update_tx.send(Update::Update(cached));
                    }
                }
                let updates = update_tx.clone();
                let active_version = active_version.clone();
                std::thread::spawn(move || {
                    let newest = crate::host::newest_published();
                    match newest {
                        Some(newest) => {
                            crate::host::store_newest_published(&newest);
                            let newer =
                                crate::host::compare_versions(&newest, &active_version).is_gt();
                            log::info!(
                                "update check: active {active_version}, newest {newest}, newer {newer}"
                            );
                            if newer {
                                let _ = updates.send(Update::Update(newest));
                            }
                        }
                        None => log::info!("update check: the registry did not answer"),
                    }
                });
            }
            if !pending.is_empty() {
                std::thread::spawn(move || {
                    let queue = std::sync::Arc::new(std::sync::Mutex::new(pending));
                    let mut workers = Vec::new();
                    for _ in 0..4 {
                        let queue = queue.clone();
                        let titles = titles.clone();
                        let origin = origin.clone();
                        let cookie = cookie.clone();
                        workers.push(std::thread::spawn(move || loop {
                            let next = queue.lock().ok().and_then(|mut queue| queue.pop());
                            let Some(id) = next else {
                                break;
                            };
                            if let Ok(title) = fetch_title(&origin, &cookie, &id) {
                                if !title.is_empty() {
                                    let _ = titles.send(Update::Titles(vec![(id, title)]));
                                }
                            }
                        }));
                    }
                    for worker in workers {
                        let _ = worker.join();
                    }
                });
            }
        });

        poll(cx, update_rx, live_evt_rx, live_cmd_rx, live_evt_tx);

        // The composer is the only text field in the window, so it starts
        // focused: defer past this frame, when the window can accept focus.
        let composer = cx.focus_handle();
        cx.defer(move |cx| {
            let Some(window) = cx.active_window() else {
                return;
            };
            window
                .update(cx, |_view, window, _cx| {
                    if window.is_window_active() {
                        window.focus(&composer);
                    }
                })
                .ok();
        });

        Self {
            chat: None,
            titles: HashMap::new(),
            status: "ハーネスを起動しています…".to_string(),
            editor: Editor::new(),
            focus: cx.focus_handle(),
            composer_scroll: ScrollHandle::new(),
            live: live_cmd_tx,
            pending: None,
            client_id: None,
            streaming: String::new(),
            running: false,
            dirty: false,
            picker: false,
            marked: None,
            sidebar_scroll: ScrollHandle::new(),
            timeline_scroll: ScrollHandle::new(),
            model_scroll: ScrollHandle::new(),
            update: None,
            expanded: Rc::new(RefCell::new(HashSet::new())),
            collapsed_projects: collapsed_projects,
            archived_projects: archived_projects,
            show_archived: false,
            rename_target: None,
            rename_editor: Editor::new(),
            rename_focus: cx.focus_handle(),
            filter: Editor::new(),
            filter_focus: cx.focus_handle(),
            last_escape: None,
        }
    }

    fn follow_selected(&self) {
        let Some(session) = self.chat.as_ref().and_then(|chat| chat.selected_session()) else {
            return;
        };
        let id = session.id.clone();
        let _ = self.live.send(LiveCmd::Follow(id));
    }

    fn submit(&mut self) {
        let text = self.editor.text().trim().to_string();
        if text.is_empty() {
            return;
        }
        self.editor.clear();
        self.composer_scroll.scroll_to_bottom();
        let Some(chat) = self.chat.as_mut() else {
            self.status = "接続が完了していません".to_string();
            return;
        };
        match chat.send_prompt(&text) {
            Ok(()) => {
                self.status = "送信しました".to_string();
                self.running = true;
                self.follow_selected();
            }
            Err(error) => self.status = format!("送信できませんでした: {error}"),
        }
    }

    fn stop(&mut self) {
        if let Some(chat) = self.chat.as_ref() {
            match chat.cancel() {
                Ok(()) => self.status = "停止を要求しました".to_string(),
                Err(error) => self.status = format!("停止できませんでした: {error}"),
            }
        }
        self.running = false;
    }

    /// Start renaming one conversation with its current title in the buffer.
    fn begin_rename(&mut self, session_id: &str, title: &str) {
        self.rename_editor.clear();
        self.rename_editor.insert(title);
        self.rename_editor.select_all();
        self.rename_target = Some(session_id.to_string());
    }

    fn cancel_rename(&mut self) {
        self.rename_target = None;
        self.rename_editor.clear();
    }

    fn commit_rename(&mut self) {
        let Some(target) = self.rename_target.clone() else {
            return;
        };
        let title = self.rename_editor.text().trim().to_string();
        if title.is_empty() {
            self.cancel_rename();
            return;
        }
        match self.chat.as_ref() {
            Some(chat) => match chat.rename_session(&target, &title) {
                Ok(stored) => {
                    self.titles.insert(target.clone(), stored.clone());
                    if let Some(chat) = self.chat.as_mut() {
                        if let Some(session) =
                            chat.sessions.iter_mut().find(|session| session.id == target)
                        {
                            session.title = stored.clone();
                        }
                    }
                    self.status = format!("名前を変更しました: {stored}");
                }
                Err(error) => self.status = format!("名前を変更できませんでした: {error}"),
            },
            None => {}
        }
        self.cancel_rename();
    }

    /// Fold or unfold one project row in the sidebar.
    fn toggle_collapsed(&mut self, path: &str) {
        if !self.collapsed_projects.remove(path) {
            self.collapsed_projects.insert(path.to_string());
        }
        save_ui_state(&self.collapsed_projects, &self.archived_projects);
    }

    /// Hide or restore one project in the sidebar.
    fn set_archived(&mut self, path: &str, archived: bool) {
        if archived {
            self.archived_projects.insert(path.to_string());
        } else {
            self.archived_projects.remove(path);
        }
        save_ui_state(&self.collapsed_projects, &self.archived_projects);
    }

    fn new_conversation(&mut self) {
        // A brand-new session has no title yet, so it must not stay hidden
        // behind an active search.
        self.filter.clear();
        let cwd = self
            .chat
            .as_ref()
            .and_then(|chat| chat.selected_session())
            .map(|session| session.cwd.clone())
            .filter(|cwd| !cwd.is_empty());
        let Some(chat) = self.chat.as_mut() else {
            return;
        };
        match chat.create_session(cwd.as_deref()) {
            Ok(_) => {
                self.status = "新しい会話を作成しました".to_string();
                self.running = false;
                self.streaming.clear();
                self.follow_selected();
            }
            Err(error) => self.status = format!("作成できませんでした: {error}"),
        }
    }

    /// Load one older history page, or report that the log is exhausted.
    fn load_older(&mut self) {
        let result = self.chat.as_mut().map(|chat| chat.load_older());
        match result {
            Some(Ok(more)) => {
                self.status = if more {
                    "以前の履歴を読み込みました".to_string()
                } else {
                    "ここから先はありません".to_string()
                };
            }
            Some(Err(error)) => self.status = format!("以前の履歴を読み込めませんでした: {error}"),
            None => {}
        }
    }

    /// Enter in the filter row: open the first session the sidebar shows for the
    /// filter, then clear the filter so the selection is visible.
    fn select_first_match(&mut self) {
        let filter = self.filter.text().to_string();
        self.filter.clear();
        if filter.trim().is_empty() {
            return;
        }
        // Mirror the sidebar's visible order: archived projects are skipped
        // unless the operator is showing them.
        let rows: Vec<(usize, String, String)> = {
            let Some(chat) = self.chat.as_ref() else {
                return;
            };
            let titles = self.titles.clone();
            let mut rows = Vec::new();
            for group in chat.groups() {
                if !self.show_archived && self.archived_projects.contains(&group.path) {
                    continue;
                }
                for (index, session) in group.sessions {
                    let title = session_display_title(&session, &titles);
                    rows.push((index, title, session.cwd));
                }
            }
            rows
        };
        let Some(index) = first_match(&rows, &filter) else {
            self.status = format!("「{filter}」に一致する会話がありません");
            return;
        };
        if let Some(chat) = self.chat.as_mut() {
            chat.select(index);
            self.status = format!("{} メッセージ", chat.messages.len());
        }
        self.running = false;
        self.streaming.clear();
        self.follow_selected();
    }

    fn answer_pending(&mut self, allow: bool, answers: Option<Vec<(String, Vec<String>)>>) {
        let Some(pending) = self.pending.take() else {
            return;
        };
        let Some(chat) = self.chat.as_mut() else {
            return;
        };
        let result = match (pending, answers) {
            (Pending::Approval { event_id, .. }, _) => match self.client_id.clone() {
                Some(client_id) => chat.approve(&client_id, &event_id, allow),
                None => Ok(()),
            },
            (Pending::Question { call_id, session_id, .. }, Some(answers)) => {
                chat.answer_question(&session_id, &call_id, &answers)
            }
            (Pending::Question { .. }, None) => Ok(()),
        };
        match result {
            Ok(()) => self.status = "応答しました".to_string(),
            Err(error) => self.status = format!("応答できませんでした: {error}"),
        }
    }
}

fn poll(
    cx: &mut Context<DesktopApp>,
    updates: Receiver<Update>,
    live_events: Receiver<LiveEvent>,
    live_cmd: Receiver<LiveCmd>,
    live_out: Sender<LiveEvent>,
) {
    cx.spawn(async move |this, cx| {
        // Startup: wait for the background connect, then start the live threads.
        loop {
            match updates.try_recv() {
                Ok(Update::Step(step)) => {
                    let _ = this.update(cx, |app, cx| {
                        app.status = step;
                        cx.notify();
                    });
                }
                Ok(Update::Titles(batch)) => {
                    let _ = this.update(cx, |app, cx| {
                        for (id, title) in batch {
                            app.titles.insert(id, title);
                        }
                        cx.notify();
                    });
                }
                Ok(Update::Update(newest)) => {
                    let _ = this.update(cx, |app, cx| {
                        app.update = Some(newest);
                        cx.notify();
                    });
                }
                Ok(Update::Ready(chat)) => {
                    let origin = chat.origin().to_string();
                    let cookie = chat.cookie().to_string();
                    live::spawn(&origin, &cookie, live_cmd, live_out.clone());
                    let follow = chat.selected_session().map(|session| session.id.clone());
                    let _ = this.update(cx, |app, cx| {
                        app.status = chat.status.clone();
                        app.chat = Some(chat);
                        app.running = false;
                        cx.notify();
                    });
                    if let Some(id) = follow {
                        let _ = this.update(cx, |app, _| {
                            let _ = app.live.send(LiveCmd::Follow(id));
                        });
                    }
                    break;
                }
                Ok(Update::Failed(error)) => {
                    let _ = this.update(cx, |app, cx| {
                        app.status = error;
                        cx.notify();
                    });
                    return;
                }
                Err(TryRecvError::Empty) => {}
                Err(TryRecvError::Disconnected) => return,
            }
            cx.background_executor().timer(POLL).await;
        }

        // Live loop: stream deltas, pending decisions and debounced reloads.
        let mut last_reload = Instant::now();
        loop {
            let mut changed = false;
            loop {
                match live_events.try_recv() {
                    Ok(LiveEvent::Ready(client_id)) => {
                        let _ = this.update(cx, |app, cx| {
                            app.client_id = Some(client_id);
                            cx.notify();
                        });
                        changed = true;
                    }
                    Ok(LiveEvent::Pending(pending)) => {
                        let _ = this.update(cx, |app, cx| {
                            app.status = "応答待ちの要求があります".to_string();
                            app.pending = Some(pending);
                            cx.notify();
                        });
                        changed = true;
                    }
                    Ok(LiveEvent::Dismissed(_)) => {
                        let _ = this.update(cx, |app, cx| {
                            app.pending = None;
                            cx.notify();
                        });
                        changed = true;
                    }
                    Ok(LiveEvent::Delta(text)) => {
                        let _ = this.update(cx, |app, cx| {
                            app.streaming.push_str(&text);
                            app.running = true;
                            cx.notify();
                        });
                        changed = true;
                    }
                    Ok(LiveEvent::Activity) => {
                        let _ = this.update(cx, |app, _| {
                            app.dirty = true;
                            app.running = true;
                        });
                    }
                    Ok(LiveEvent::Idle) => {
                        let _ = this.update(cx, |app, cx| {
                            app.running = false;
                            app.dirty = true;
                            cx.notify();
                        });
                    }
                    Ok(LiveEvent::Note(note)) => {
                        let _ = this.update(cx, |app, cx| {
                            app.status = note;
                            cx.notify();
                        });
                        changed = true;
                    }
                    Ok(LiveEvent::Closed(error)) => {
                        let _ = this.update(cx, |app, cx| {
                            app.status = format!("ストリームが切れました: {error}");
                            app.running = false;
                            cx.notify();
                        });
                        changed = true;
                    }
                    Err(TryRecvError::Empty) => break,
                    Err(TryRecvError::Disconnected) => return,
                }
            }

            if last_reload.elapsed() >= RELOAD_AFTER {
                let should_reload = this
                    .update(cx, |app, _| {
                        let dirty = app.dirty;
                        app.dirty = false;
                        dirty
                    })
                    .unwrap_or(false);
                if should_reload {
                    let _ = this.update(cx, |app, cx| {
                        if let Some(chat) = app.chat.as_mut() {
                            let _ = chat.load_conversation();
                        }
                        app.streaming.clear();
                        cx.notify();
                    });
                }
                last_reload = Instant::now();
            }
            let _ = changed;
            cx.background_executor().timer(POLL).await;
        }
    })
    .detach();
}

impl Render for DesktopApp {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let groups = self
            .chat
            .as_ref()
            .map(|chat| chat.groups())
            .unwrap_or_default();
        let selected = self.chat.as_ref().and_then(|chat| chat.selected);
        let messages = self
            .chat
            .as_ref()
            .map(|chat| chat.messages.clone())
            .unwrap_or_default();
        let catalog = self
            .chat
            .as_ref()
            .map(|chat| chat.catalog.clone())
            .unwrap_or_default();
        let current = self
            .chat
            .as_ref()
            .and_then(|chat| chat.selected_session().cloned());
        let status = self.status.clone();
        let input = self.editor.text().to_string();
        let filter_text = self.filter.text().to_string();
        let titles = self.titles.clone();
        let loading = self.chat.is_none();
        let streaming = self.streaming.clone();
        let running = self.running;
        let has_more = self
            .chat
            .as_ref()
            .map(|chat| chat.has_more)
            .unwrap_or(false);
        let picker = self.picker;
        let pending = self.pending.clone();
        let collapsed_paths = self.collapsed_projects.clone();
        let archived_paths = self.archived_projects.clone();
        let show_archived = self.show_archived;
        let rename_target = self.rename_target.clone();
        let rename_text = self.rename_editor.text().to_string();
        let rename_focus = self.rename_focus.clone();
        let archived_count = groups
            .iter()
            .filter(|group| self.archived_projects.contains(&group.path))
            .count();

        let sidebar = div()
            .flex()
            .flex_col()
            .w(px(theme::SIDEBAR_DEFAULT))
            .h_full()
            .bg(theme::sidebar())
            .border_r_1()
            .border_color(theme::hairline())
            .child(
                div()
                    .flex()
                    .items_center()
                    .h(px(theme::LOGO_ROW_HEIGHT))
                    .px(px(16.))
                    .child(
                        div()
                            .text_size(theme::heading_size())
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(theme::label())
                            .child("DeepSeek Harness"),
                    ),
            )
            .child(
                div()
                    .id("new-session")
                    .mx(px(12.))
                    .mb(px(10.))
                    .h(px(theme::NEW_SESSION_HEIGHT))
                    .flex()
                    .items_center()
                    .justify_center()
                    .rounded(theme::radius_md())
                    .border_1()
                    .border_color(theme::border())
                    .text_size(theme::meta_size())
                    .text_color(theme::label())
                    .cursor_pointer()
                    .hover(|style| style.bg(rgb(0xf1f2f5)))
                    .on_click(cx.listener(|this, _event, _window, cx| {
                        this.new_conversation();
                        cx.notify();
                    }))
                    .child("+ 新しい会話"),
            )
            .child(
                // Sidebar search: filters the rendered rows by title and project
                // path. It owns the keyboard while focused, exactly like the
                // inline rename field.
                div()
                    .id("session-filter")
                    .track_focus(&self.filter_focus)
                    .mx(px(12.))
                    .mb(px(8.))
                    .h(px(theme::LIST_ROW_HEIGHT - 6.))
                    .px(px(10.))
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(6.))
                    .rounded(theme::radius_sm())
                    .bg(theme::composer())
                    .border_1()
                    .border_color(theme::border())
                    .text_size(theme::meta_size())
                    .cursor(CursorStyle::IBeam)
                    .on_click(cx.listener(|this, _event, window, cx| {
                        this.filter_focus.focus(window);
                        cx.notify();
                    }))
                    .on_key_down(cx.listener(|this, event: &KeyDownEvent, window, cx| {
                        let keystroke = &event.keystroke;
                        if keystroke.is_ime_in_progress() {
                            return;
                        }
                        let command =
                            keystroke.modifiers.platform || keystroke.modifiers.control;
                        match keystroke.key.as_str() {
                            // Enter opens the first visible match and drops the
                            // filter; Esc clears it and returns to the composer.
                            "enter" => this.select_first_match(),
                            "escape" => {
                                this.filter.clear();
                                this.focus.focus(window);
                            }
                            "backspace" => this.filter.delete_backward(),
                            "delete" => this.filter.delete_forward(),
                            "left" if command => this.filter.moved(Motion::WordLeft),
                            "right" if command => this.filter.moved(Motion::WordRight),
                            "left" => this.filter.moved(Motion::Left),
                            "right" => this.filter.moved(Motion::Right),
                            "a" if command => this.filter.select_all(),
                            "k" if command => this.focus.focus(window),
                            "n" if command => this.new_conversation(),
                            _ => {
                                if let Some(text) = &keystroke.key_char {
                                    if !text.is_empty()
                                        && !text.chars().any(char::is_control)
                                        && !command
                                        && !keystroke.modifiers.alt
                                    {
                                        this.filter.insert(text);
                                    }
                                }
                            }
                        }
                        cx.notify();
                    }))
                    .child(
                        div()
                            .flex_1()
                            .overflow_hidden()
                            .text_color(if filter_text.is_empty() {
                                theme::tertiary()
                            } else {
                                theme::label()
                            })
                            .child(if filter_text.is_empty() {
                                "会話を検索…".to_string()
                            } else {
                                filter_text.clone()
                            }),
                    )
                    .when(!filter_text.is_empty(), |element| {
                        element.child(
                            div()
                                .id("clear-filter")
                                .px(px(4.))
                                .rounded(theme::radius_sm())
                                .cursor_pointer()
                                .text_size(theme::micro_size())
                                .text_color(theme::tertiary())
                                .hover(|style| style.bg(rgb(0xe9ecf1)))
                                .child("×")
                                .on_click(cx.listener(|this, _event, _window, cx| {
                                    this.filter.clear();
                                    cx.notify();
                                })),
                        )
                    }),
            )
            .child(
                div()
                    .id("sessions")
                    .flex()
                    .flex_col()
                    .flex_1()
                    .overflow_y_scroll()
                    .track_scroll(&self.sidebar_scroll)
                    .px(px(8.))
                    .when(loading, |element| {
                        element.children((0..8).map(|row| {
                            div()
                                .h(px(theme::SESSION_ROW_HEIGHT))
                                .mb(px(6.))
                                .mx(px(4.))
                                .rounded(theme::radius_sm())
                                .bg(rgb(0xf1f2f4))
                                .when(row % 3 == 0, |element| element.w(px(120.)))
                                .when(row % 3 == 1, |element| element.w(px(180.)))
                                .when(row % 3 == 2, |element| element.w(px(150.)))
                        }))
                    })
                    .when(!loading, |element| {
                        // Only the rows that fit the viewport are built; a long
                        // history would otherwise create thousands of elements
                        // on every frame.
                        let mut budget = usize::MAX;
                        let mut matched = 0usize;
                        let mut visible: Vec<AnyElement> = groups
                            .into_iter()
                            .filter_map(|group| {
                            if budget == 0 {
                                return None;
                            }
                            let is_archived = archived_paths.contains(&group.path);
                            if is_archived && !show_archived {
                                return None;
                            }
                            let is_collapsed = collapsed_paths.contains(&group.path);
                            // Search runs before the row budget, so a project
                            // whose sessions all fail the filter disappears
                            // completely instead of leaving an empty header.
                            let sessions: Vec<(usize, Session)> = group
                                .sessions
                                .into_iter()
                                .filter(|(_, session)| {
                                    session_matches(
                                        &filter_text,
                                        &session_display_title(session, &titles),
                                        &session.cwd,
                                    )
                                })
                                .take(budget)
                                .collect();
                            if sessions.is_empty() {
                                return None;
                            }
                            matched += sessions.len();
                            let rows: Vec<AnyElement> = if is_collapsed {
                                Vec::new()
                            } else {
                                sessions
                                .into_iter()
                                .map(|(index, session)| {
                                    let active = selected == Some(index);
                                    let title = session_display_title(&session, &titles);
                                    if rename_target.as_deref() == Some(session.id.as_str()) {
                                        let focus = rename_focus.clone();
                                        div()
                                            .id(("rename", index))
                                            .flex()
                                            .items_center()
                                            .h(px(theme::SESSION_ROW_HEIGHT + 10.))
                                            .px(px(8.))
                                            .mb(px(1.))
                                            .rounded(theme::radius_sm())
                                            .bg(theme::composer())
                                            .border_1()
                                            .border_color(theme::accent())
                                            .track_focus(&focus)
                                            .on_key_down(cx.listener(|this, event: &KeyDownEvent, _window, cx| {
                                                let keystroke = &event.keystroke;
                                                if keystroke.is_ime_in_progress() {
                                                    return;
                                                }
                                                let command = keystroke.modifiers.platform
                                                    || keystroke.modifiers.control;
                                                match keystroke.key.as_str() {
                                                    "enter" => this.commit_rename(),
                                                    "escape" => this.cancel_rename(),
                                                    "backspace" => this.rename_editor.delete_backward(),
                                                    "delete" => this.rename_editor.delete_forward(),
                                                    "left" if command => {
                                                        this.rename_editor.moved(Motion::WordLeft)
                                                    }
                                                    "right" if command => {
                                                        this.rename_editor.moved(Motion::WordRight)
                                                    }
                                                    "left" => this.rename_editor.moved(Motion::Left),
                                                    "right" => this.rename_editor.moved(Motion::Right),
                                                    "a" if command => this.rename_editor.select_all(),
                                                    _ => {
                                                        if let Some(text) = &keystroke.key_char {
                                                            if !text.is_empty()
                                                                && !text.chars().any(|character| character.is_control())
                                                            {
                                                                this.rename_editor.insert(text);
                                                            }
                                                        }
                                                    }
                                                }
                                                cx.notify();
                                            }))
                                            .child(
                                                div()
                                                    .text_size(theme::meta_size())
                                                    .text_color(theme::label())
                                                    .child(rename_text.clone()),
                                            )
                                            .into_any_element()
                                    } else {
                                    div()
                                        .id(("session", index))
                                        .flex()
                                        .flex_col()
                                        .justify_center()
                                        .gap(px(1.))
                                        .h(px(theme::SESSION_ROW_HEIGHT + 10.))
                                        .px(px(10.))
                                        .mb(px(1.))
                                        .rounded(theme::radius_sm())
                                        .cursor_pointer()
                                        .when(active, |element| element.bg(rgb(0xe9ecf1)))
                                        .hover(|style| style.bg(rgb(0xf1f2f5)))
                                        .on_click(cx.listener(move |this, _event, _window, cx| {
                                            if let Some(chat) = this.chat.as_mut() {
                                                chat.select(index);
                                                this.status = format!(
                                                    "{} メッセージ",
                                                    chat.messages.len()
                                                );
                                            }
                                            this.running = false;
                                            this.streaming.clear();
                                            this.follow_selected();
                                            cx.notify();
                                        }))
                                        .child(
                                            div()
                                                .flex()
                                                .flex_row()
                                                .items_center()
                                                .gap(px(6.))
                                                .when(session.running, |element| {
                                                    element.child(
                                                        div()
                                                            .w(px(6.))
                                                            .h(px(6.))
                                                            .rounded(px(999.))
                                                            .bg(theme::accent()),
                                                    )
                                                })
                                                .child(
                                                    div()
                                                        .text_size(theme::meta_size())
                                                        .text_color(theme::label())
                                                        .child(title.clone()),
                                                )
                                                .child(
                                                    div()
                                                        .id(SharedString::from(format!("rename-{}", session.id)))
                                                        .px(px(2.))
                                                        .rounded(theme::radius_sm())
                                                        .cursor_pointer()
                                                        .text_size(theme::micro_size())
                                                        .text_color(theme::tertiary())
                                                        .hover(|style| style.bg(rgb(0xe9ecf1)))
                                                        .child("✎")
                                                        .on_click(cx.listener({
                                                            let id = session.id.clone();
                                                            let current = title.clone();
                                                            move |this, _event, window, cx| {
                                                                this.begin_rename(&id, &current);
                                                                window.focus(&this.rename_focus);
                                                                cx.notify();
                                                            }
                                                        })),
                                                ),
                                        )
                                        .child(
                                            div()
                                                .text_size(theme::micro_size())
                                                .text_color(theme::tertiary())
                                                .child(relative(session.updated)),
                                        )
                                        .into_any_element()
                                    }
                                })
                                .collect()
                            };
                            budget = budget.saturating_sub(rows.len());
                            Some(
                            div()
                                .flex()
                                .flex_col()
                                .mb(px(6.))
                                .when(is_archived, |element| element.opacity(0.6))
                                .child(
                                    div()
                                        .id(SharedString::from(format!("project-{}", group.path.clone())))
                                        .flex()
                                        .flex_row()
                                        .items_center()
                                        .gap(px(4.))
                                        .h(px(theme::PROJECT_ROW_HEIGHT))
                                        .px(px(10.))
                                        .cursor_pointer()
                                        .hover(|style| style.bg(rgb(0xf4f5f7)))
                                        .on_click(cx.listener({
                                            let path = group.path.clone();
                                            move |this, _event, _window, cx| {
                                                this.toggle_collapsed(&path);
                                                cx.notify();
                                            }
                                        }))
                                        .child(
                                            div()
                                                .text_size(theme::micro_size())
                                                .text_color(theme::tertiary())
                                                .child(if is_collapsed { "▸" } else { "▾" }),
                                        )
                                        .child(
                                            div()
                                                .flex_1()
                                                .overflow_hidden()
                                                .text_size(theme::micro_size())
                                                .font_weight(FontWeight::MEDIUM)
                                                .text_color(theme::tertiary())
                                                .child(group.path.clone()),
                                        )
                                        .child(
                                            div()
                                                .id(SharedString::from(format!("archive-{}", group.path)))
                                                .px(px(4.))
                                                .rounded(theme::radius_sm())
                                                .cursor_pointer()
                                                .text_size(theme::micro_size())
                                                .text_color(theme::tertiary())
                                                .hover(|style| style.bg(rgb(0xe9ecf1)))
                                                .child(if is_archived { "戻す" } else { "×" })
                                                .on_click(cx.listener({
                                                    let path = group.path.clone();
                                                    move |this, _event, _window, cx| {
                                                        this.set_archived(&path, !is_archived);
                                                        cx.notify();
                                                    }
                                                })),
                                        ),
                                )
                                .children(rows)
                                .into_any_element(),
                            )
                        })
                        .collect();
                        if matched == 0 && !filter_text.trim().is_empty() {
                            visible.push(
                                div()
                                    .id("no-match")
                                    .px(px(12.))
                                    .py(px(10.))
                                    .text_size(theme::micro_size())
                                    .text_color(theme::tertiary())
                                    .child("一致なし")
                                    .into_any_element(),
                            );
                        }
                        element.children(visible)
                    }),
            )
            .child(
                div()
                    .flex()
                    .items_center()
                    .h(px(theme::TOP_STRIP_HEIGHT))
                    .px(px(16.))
                    .border_t_1()
                    .border_color(theme::hairline())
                    .child(
                        div()
                            .text_size(theme::micro_size())
                            .text_color(theme::tertiary())
                            .child(status),
                    )
                    .when(archived_count > 0, |element| {
                        let label = if show_archived {
                            format!("アーカイブを隠す ({archived_count})")
                        } else {
                            format!("アーカイブ ({archived_count})")
                        };
                        element.child(
                            div()
                                .id("toggle-archived")
                                .px(px(6.))
                                .py(px(1.))
                                .rounded(theme::radius_sm())
                                .cursor_pointer()
                                .text_size(theme::micro_size())
                                .text_color(theme::secondary())
                                .hover(|style| style.bg(rgb(0xf1f2f5)))
                                .child(label)
                                .on_click(cx.listener(|this, _event, _window, cx| {
                                    this.show_archived = !this.show_archived;
                                    cx.notify();
                                })),
                        )
                    })
                    .when(self.update.is_some(), |element| {
                        let newest = self.update.clone().unwrap_or_default();
                        element.child(
                            div()
                                .px(px(6.))
                                .py(px(1.))
                                .rounded(theme::radius_sm())
                                .bg(rgb(0xe8f0ff))
                                .text_size(theme::micro_size())
                                .text_color(theme::accent())
                                .child(format!("dsh {newest} が利用可能")),
                        )
                    }),
            );

        let header = div()
            .flex()
            .flex_row()
            .items_center()
            .justify_between()
            .min_h(px(theme::HEADER_MIN_HEIGHT))
            .px(px(28.))
            .border_b_1()
            .border_color(theme::hairline())
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(3.))
                    .child(
                        div()
                            .text_size(theme::title_size())
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(theme::label())
                            .child(match current.as_ref() {
                                Some(session) => titles
                                    .get(&session.id)
                                    .cloned()
                                    .filter(|title| !title.is_empty())
                                    .or_else(|| {
                                        (!session.title.is_empty()).then(|| session.title.clone())
                                    })
                                    .unwrap_or_else(|| project_path(&session.cwd)),
                                None => "会話を選択してください".to_string(),
                            }),
                    )
                    .child(
                        div()
                            .flex()
                            .flex_row()
                            .gap(px(10.))
                            .text_size(theme::micro_size())
                            .text_color(theme::tertiary())
                            .when(
                                current
                                    .as_ref()
                                    .map(|session| !session.model.is_empty())
                                    .unwrap_or(false),
                                |element| {
                                    element.child(
                                        current
                                            .as_ref()
                                            .map(|session| {
                                                composer_model_label(&session.model, &catalog)
                                            })
                                            .unwrap_or_default(),
                                    )
                                },
                            )
                            .child(
                                current
                                    .as_ref()
                                    .map(|session| project_path(&session.cwd))
                                    .unwrap_or_default(),
                            )
                            .when(
                                current
                                    .as_ref()
                                    .map(|session| !session.context.is_empty())
                                    .unwrap_or(false),
                                |element| {
                                    element.child(
                                        current
                                            .as_ref()
                                            .map(|session| session.context.clone())
                                            .unwrap_or_default(),
                                    )
                                },
                            )
                            .when(
                                current
                                    .as_ref()
                                    .map(|session| !session.tokens.is_empty())
                                    .unwrap_or(false),
                                |element| {
                                    element.child(
                                        current
                                            .as_ref()
                                            .map(|session| session.tokens.clone())
                                            .unwrap_or_default(),
                                    )
                                },
                            )
                            .when(
                                current
                                    .as_ref()
                                    .map(|session| session.questions > 0)
                                    .unwrap_or(false),
                                |element| {
                                    element.child(
                                        current
                                            .as_ref()
                                            .map(|session| {
                                                format!("未回答の質問 {}", session.questions)
                                            })
                                            .unwrap_or_default(),
                                    )
                                },
                            ),
                    ),
            );

        let expanded_snapshot = self.expanded.borrow().clone();
        let mut rows: Vec<AnyElement> = messages
            .iter()
            .enumerate()
            .map(|(index, message)| {
                let row = div()
                    .flex()
                    .w_full()
                    .mb(px(14.))
                    .when(message.role == "user", |element| element.justify_end())
                    .when(message.role != "user", |element| element.justify_start());

                if message.role == "tool" {
                    let (name, state, summary) = tool_state_of(&message.text);
                    let (glyph, color) = tool_glyph(state);
                    return row
                        .child(
                            div()
                                .flex()
                                .items_center()
                                .gap(px(6.))
                                .px(px(10.))
                                .py(px(4.))
                                .rounded(theme::radius_sm())
                                .border_1()
                                .border_color(theme::border())
                                .bg(rgb(0xf7f8fa))
                                .text_size(theme::micro_size())
                                .text_color(theme::secondary())
                                .child(div().text_color(color).child(glyph))
                                .child(
                                    div()
                                        .text_color(theme::label())
                                        .font_weight(FontWeight::SEMIBOLD)
                                        .child(name),
                                )
                                .when(!summary.is_empty(), |element| {
                                    element.child(
                                        div().text_color(theme::tertiary()).child(summary),
                                    )
                                }),
                        )
                        .into_any_element();
                }

                // Reasoning is collapsed behind one clickable row per message,
                // and the expanded ids live in the view, not in the message.
                if message.role == "reasoning" {
                    let id = index.to_string();
                    let expanded = expanded_snapshot.contains(&id);
                    let toggle = Rc::clone(&self.expanded);
                    let base = div()
                        .max_w(px(620.))
                        .px(px(16.))
                        .py(px(10.))
                        .rounded(theme::radius_xl())
                        .bg(rgb(0xfafafa))
                        .border_l_1()
                        .border_color(theme::border())
                        .text_size(theme::body_size())
                        .line_height(theme::body_line_height())
                        .text_color(theme::tertiary());
                    let element = if expanded {
                        let base = base.id(("reasoning", index));
                        let mut content = Vec::new();
                        content.push(
                            div()
                                .flex()
                                .items_center()
                                .gap(px(6.))
                                .text_color(theme::secondary())
                                .child("\u{25BE} \u{63A8}\u{8A18}\u{3092}\u{96A0}\u{3059}")
                                .into_any_element(),
                        );
                        content.extend(render_blocks(
                            &markdown::parse(&message.text),
                            cx,
                            theme::secondary(),
                        ));
                        base.flex().flex_col().children(content).into_any_element()
                    } else {
                        base
                            .id(("reasoning", index))
                            .cursor_pointer()
                            .child(
                                div()
                                    .flex()
                                    .items_center()
                                    .gap(px(6.))
                                    .text_color(theme::secondary())
                                    .child("\u{25B8} \u{63A8}\u{8A18}\u{3092}\u{8868}\u{793A}"),
                            )
                            .child(
                                div()
                                    .mt(px(4.))
                                    .text_size(theme::micro_size())
                                    .text_color(theme::tertiary())
                                    .child(reasoning_preview(&message.text)),
                            )
                            .on_click(cx.listener(move |_this, _event, _window, cx| {
                                let open = !toggle.borrow().contains(&id);
                                if open {
                                    toggle.borrow_mut().insert(id.clone());
                                } else {
                                    toggle.borrow_mut().remove(&id);
                                }
                                cx.notify();
                            }))
                            .into_any_element()
                    };
                    return row.child(element).into_any_element();
                }

                let bubble = div()
                    .max_w(px(620.))
                    .px(px(16.))
                    .py(px(10.))
                    .rounded(theme::radius_xl())
                    .text_size(theme::body_size())
                    .line_height(theme::body_line_height())
                    .text_color(theme::label())
                    .when(message.role == "user", |element| {
                        element.bg(theme::user_bubble())
                    })
                    .when(message.role == "assistant", |element| {
                        element.bg(theme::code_block())
                    });
                // Assistant replies are Markdown; user text stays literal, so a
                // pasted diff or inline code is never reinterpreted as formatting.
                let bubble = if message.role == "user" {
                    bubble.child(message.text.clone())
                } else {
                    bubble.children(render_blocks(
                        &markdown::parse(&message.text),
                        cx,
                        theme::label(),
                    ))
                };
                row.child(bubble).into_any_element()
            })
            .collect();
        if !streaming.is_empty() {
            rows.push(
                div()
                    .flex()
                    .w_full()
                    .mb(px(14.))
                    .justify_start()
                    .child(
                        div()
                            .max_w(px(620.))
                            .px(px(16.))
                            .py(px(10.))
                            .rounded(theme::radius_xl())
                            .bg(theme::code_block())
                            .text_size(theme::body_size())
                            .line_height(theme::body_line_height())
                            .text_color(theme::secondary())
                            .children(render_blocks(
                                &markdown::parse(&streaming),
                                cx,
                                theme::secondary(),
                            )),
                    )
                    .into_any_element(),
            );
        }
        if messages.is_empty() && streaming.is_empty() {
            rows.push(
                div()
                    .text_size(theme::body_size())
                    .text_color(theme::tertiary())
                    .child("この会話にはまだメッセージがありません")
                    .into_any_element(),
            );
        }
        // Older-history affordance at the very top of the timeline. It is only
        // meaningful once the window carries records, and the load itself is a
        // button, so the view never scrolls on its own.
        if !messages.is_empty() {
            let top = if has_more {
                div()
                    .id("load-older")
                    .flex()
                    .justify_center()
                    .w_full()
                    .mb(px(12.))
                    .py(px(6.))
                    .rounded(theme::radius_sm())
                    .cursor_pointer()
                    .hover(|style| style.bg(rgb(0xf1f2f5)))
                    .text_size(theme::micro_size())
                    .text_color(theme::secondary())
                    .on_click(cx.listener(|this, _event, _window, cx| {
                        this.load_older();
                        cx.notify();
                    }))
                    .child("以前を読み込む")
                    .into_any_element()
            } else {
                div()
                    .flex()
                    .justify_center()
                    .w_full()
                    .mb(px(12.))
                    .py(px(6.))
                    .text_size(theme::micro_size())
                    .text_color(theme::tertiary())
                    .child("ここから先はありません")
                    .into_any_element()
            };
            rows.insert(0, top);
        }

        let timeline = div()
            .id("timeline")
            .flex()
            .flex_col()
            .flex_1()
            .overflow_y_scroll()
            .track_scroll(&self.timeline_scroll)
            .px(px(32.))
            .py(px(24.))
            .children(rows);

        let update_notice = self.update.clone().map(|newest| {
            let command = format!("npm install -g @deepseek-ai/dsh@{newest}");
            div()
                .mx(px(32.))
                .mb(px(10.))
                .px(px(16.))
                .py(px(10.))
                .rounded(theme::radius_lg())
                .bg(rgb(0xfff7e6))
                .border_1()
                .border_color(rgb(0xf0d9a8))
                .flex()
                .flex_row()
                .items_center()
                .justify_between()
                .gap(px(12.))
                .child(
                    div()
                        .flex()
                        .flex_col()
                        .gap(px(2.))
                        .child(
                            div()
                                .text_size(theme::meta_size())
                                .font_weight(FontWeight::MEDIUM)
                                .text_color(theme::label())
                                .child(format!("dsh {newest} が利用可能です")),
                        )
                        .child(
                            div()
                                .text_size(theme::micro_size())
                                .text_color(theme::secondary())
                                .child(format!("更新: {command}")),
                        ),
                )
                .child(
                    div()
                        .id("dismiss-update")
                        .px(px(8.))
                        .py(px(2.))
                        .rounded(theme::radius_sm())
                        .cursor_pointer()
                        .hover(|style| style.bg(rgb(0xf4e6c8)))
                        .text_size(theme::micro_size())
                        .text_color(theme::secondary())
                        .child("閉じる")
                        .on_click(cx.listener(|this, _event, _window, cx| {
                            this.update = None;
                            cx.notify();
                        })),
                )
                .into_any_element()
        });

        let banner = pending.as_ref().map(|pending| match pending {
            Pending::Approval { tool, reason, .. } => {
                let (tool, reason) = (tool.clone(), reason.clone());
                div()
                    .mx(px(32.))
                    .mb(px(10.))
                    .px(px(16.))
                    .py(px(12.))
                    .rounded(theme::radius_lg())
                    .bg(rgb(0xfff7e8))
                    .border_1()
                    .border_color(theme::border())
                    .flex()
                    .flex_col()
                    .gap(px(8.))
                    .child(
                        div()
                            .text_size(theme::meta_size())
                            .text_color(theme::label())
                            .child(format!("承認待ち: {tool}")),
                    )
                    .when(!reason.is_empty(), |element| {
                        element.child(
                            div()
                                .text_size(theme::micro_size())
                                .text_color(theme::secondary())
                                .child(reason),
                        )
                    })
                    .child(
                        div()
                            .flex()
                            .flex_row()
                            .gap(px(8.))
                            .child(action_button("allow", "許可", true, cx, |this, _| {
                                this.answer_pending(true, None)
                            }))
                            .child(action_button("deny", "拒否", false, cx, |this, _| {
                                this.answer_pending(false, None)
                            })),
                    )
                    .into_any_element()
            }
            Pending::Question {
                questions,
                question,
                options,
                ..
            } => {
                let question = question.clone();
                let question_id = questions
                    .first()
                    .map(|question| question.id.clone())
                    .unwrap_or_default();
                let options = options.clone();
                let mut buttons = div().flex().flex_row().gap(px(8.));
                for (index, option) in options.into_iter().enumerate() {
                    let label = option.clone();
                    buttons = buttons.child(action_button(
                        ("answer", index),
                        label,
                        true,
                        cx,
                        {
                            let question_id = question_id.clone();
                            move |this, label: &str| {
                                let label = label.to_string();
                                this.answer_pending(true, Some(vec![(question_id.clone(), vec![label])]))
                            }
                        },
                    ));
                }
                div()
                    .mx(px(32.))
                    .mb(px(10.))
                    .px(px(16.))
                    .py(px(12.))
                    .rounded(theme::radius_lg())
                    .bg(rgb(0xf2f6ff))
                    .border_1()
                    .border_color(theme::border())
                    .flex()
                    .flex_col()
                    .gap(px(8.))
                    .child(
                        div()
                            .text_size(theme::meta_size())
                            .text_color(theme::label())
                            .child(if question.is_empty() {
                                "質問".to_string()
                            } else {
                                question
                            }),
                    )
                    .child(buttons)
                    .into_any_element()
            }
        });

        let picker_panel = picker.then(|| {
            let current_provider = current
                .as_ref()
                .map(|session| session.model.provider.clone())
                .unwrap_or_default();
            let current_model = current
                .as_ref()
                .map(|session| session.model.model.clone())
                .unwrap_or_default();
            let mut list = div().flex().flex_col().gap(px(2.)).px(px(8.)).py(px(6.));
            if catalog.is_empty() {
                list = list.child(
                    div()
                        .px(px(10.))
                        .py(px(6.))
                        .text_size(theme::micro_size())
                        .text_color(theme::tertiary())
                        .child("カタログを読み込めませんでした"),
                );
            }
            // One section per provider; the current provider is first so its
            // model list is visible without scrolling.
            for provider in order_providers(&catalog, &current_provider) {
                list = list.child(
                    div()
                        .px(px(10.))
                        .pt(px(8.))
                        .pb(px(2.))
                        .text_size(theme::micro_size())
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(theme::tertiary())
                        .child(provider.name.clone()),
                );
                for entry in provider.models {
                    let provider_id = provider.id.clone();
                    let model_id = entry.id.clone();
                    let label = entry.name.clone();
                    let active = provider_id == current_provider && model_id == current_model;
                    list = list.child(
                        div()
                            .id(SharedString::from(format!("model-{provider_id}/{model_id}")))
                            .h(px(28.))
                            .px(px(10.))
                            .flex()
                            .items_center()
                            .rounded(theme::radius_sm())
                            .cursor_pointer()
                            .when(active, |element| element.bg(rgb(0xeef3fd)))
                            .hover(|style| style.bg(rgb(0xf1f2f5)))
                            .text_size(theme::micro_size())
                            .text_color(if active {
                                theme::accent()
                            } else {
                                theme::label()
                            })
                            .when(active, |element| {
                                element.font_weight(FontWeight::SEMIBOLD)
                            })
                            .on_click(cx.listener(move |this, _event, _window, cx| {
                                let mut switched = false;
                                if let Some(chat) = this.chat.as_mut() {
                                    match chat.select_model(&provider_id, &model_id) {
                                        Ok(()) => {
                                            this.status = format!("モデルを変更: {model_id}");
                                            switched = true;
                                        }
                                        Err(error) => {
                                            let text = error.to_string();
                                            this.status = if text.contains("model-unavailable") {
                                                format!("{model_id} はこの会話では利用できません")
                                            } else {
                                                format!("変更できません: {text}")
                                            };
                                        }
                                    }
                                }
                                // Close on success; keep the panel open after a
                                // rejection so another model can be picked.
                                this.picker = !switched;
                                cx.notify();
                            }))
                            .child(if active {
                                format!("● {label}")
                            } else {
                                format!("   {label}")
                            }),
                    );
                }
            }
            div()
                .id("model-picker")
                .mx(px(32.))
                .mb(px(8.))
                .max_h(px(320.))
                .overflow_y_scroll()
                .track_scroll(&self.model_scroll)
                .rounded(theme::radius_lg())
                .bg(theme::page())
                .border_1()
                .border_color(theme::border())
                .child(list)
                .into_any_element()
        });

        // An empty composer shows the placeholder instead of an empty row.
        let placeholder = "メッセージを入力…".to_string();

        let ime_entity = cx.entity();
        let ime_focus = self.focus.clone();
        let composer = div()
            .id("composer")
            .track_focus(&self.focus)
            .flex()
            .flex_col()
            .gap(px(6.))
            .mx(px(32.))
            .mb(px(20.))
            .px(px(18.))
            .py(px(12.))
            .rounded(theme::radius_panel())
            .bg(theme::composer())
            .border_1()
            .border_color(theme::border())
            .on_click(cx.listener(|this, _event, window, cx| {
                this.focus.focus(window);
                cx.notify();
            }))
            .on_key_down(cx.listener(|this, event: &KeyDownEvent, window, cx| {
                let keystroke = &event.keystroke;
                let modifiers = keystroke.modifiers;
                let command = modifiers.platform || modifiers.control;
                let shift = modifiers.shift;
                // While an IME is composing, Enter commits the composition
                // instead of sending a half-composed message, and the keys
                // arrive with an empty key_char.
                if keystroke.is_ime_in_progress() {
                    return;
                }
                let mut changed = false;
                let mut submitted = false;
                match keystroke.key.as_str() {
                    "enter" => {
                        // Enter and Cmd/Ctrl+Enter both send; Shift/Alt+Enter
                        // keeps a hard line break.
                        if shift || modifiers.alt {
                            this.editor.insert_newline();
                            changed = true;
                        } else {
                            this.submit();
                            submitted = true;
                        }
                    }
                    "escape" => {
                        if this.running {
                            // While a run is live Esc is the stop gesture: the
                            // first press arms it, a second one inside the window
                            // cancels, and neither clears the draft.
                            let now = Instant::now();
                            if esc_cancels(this.last_escape, now) {
                                this.last_escape = None;
                                this.stop();
                            } else {
                                this.last_escape = Some(now);
                            }
                        } else {
                            this.last_escape = None;
                            this.editor.clear();
                        }
                        changed = true;
                    }
                    "backspace" => {
                        this.editor.delete_backward();
                        changed = true;
                    }
                    "delete" => {
                        this.editor.delete_forward();
                        changed = true;
                    }
                    "left" if command => this.editor.moved(Motion::WordLeft),
                    "right" if command => this.editor.moved(Motion::WordRight),
                    "up" | "left" => this.editor.moved(Motion::Left),
                    "down" | "right" => this.editor.moved(Motion::Right),
                    "home" => this.editor.moved(Motion::Home),
                    "end" => this.editor.moved(Motion::End),
                    "a" if command => this.editor.select_all(),
                    "k" if command => {
                        this.focus.focus(window);
                        changed = true;
                    }
                    "n" if command => {
                        this.new_conversation();
                        changed = true;
                    }
                    "c" if command => {
                        let selected = this.editor.selected_text().to_string();
                        if !selected.is_empty() {
                            cx.write_to_clipboard(ClipboardItem::new_string(selected));
                        }
                    }
                    "x" if command => {
                        let removed = this.editor.cut_forward();
                        if !removed.is_empty() {
                            cx.write_to_clipboard(ClipboardItem::new_string(removed));
                            changed = true;
                        }
                    }
                    "v" if command => {
                        if let Some(text) = cx.read_from_clipboard().and_then(|item| item.text()) {
                            if !text.is_empty() {
                                let text = text.replace('\r', "").replace('\0', "");
                                this.editor.insert(&text);
                                changed = true;
                            }
                        }
                    }
                    _ => {
                        // Printable input only: no command/alt chords, no
                        // unmodified keys that produce no text (arrows,
                        // function keys, dead keys, IME composition).
                        let printable = keystroke
                            .key_char
                            .as_deref()
                            .filter(|text| !text.is_empty())
                            .filter(|text| !text.chars().any(char::is_control));
                        if let Some(text) = printable {
                            if !command && !modifiers.alt {
                                this.editor.insert(text);
                                changed = true;
                            }
                        }
                    }
                }
                if changed || submitted {
                    this.composer_scroll.scroll_to_bottom();
                    cx.notify();
                }
            }))
            .child(
                // The editable area: one row per hard line, wrapping inside a
                // row. Grows to eight 24px lines and then scrolls internally,
                // so the model chip and send button never move.
                div()
                    .id("composer-text")
                    .w_full()
                    .min_h(px(theme::COMPOSER_MIN_HEIGHT))
                    .max_h(px(COMPOSER_MAX_HEIGHT))
                    .overflow_y_scroll()
                    .track_scroll(&self.composer_scroll)
                    .relative()
                    .cursor(CursorStyle::IBeam)
                    .text_size(theme::body_size())
                    .line_height(theme::body_line_height())
                    .flex()
                    .flex_col()
                    .items_start()
                    .children(input_rows(&input, self.editor.caret()))
                    .when(input.is_empty(), |element| {
                        element.child(
                            div()
                                .h(theme::body_line_height())
                                .flex()
                                .items_center()
                                .text_color(theme::tertiary())
                                .child(placeholder),
                        )
                    })
                    .child(
                        canvas(
                            |bounds, _window, _cx| bounds,
                            move |bounds, _prepaint, window, cx| {
                                window.handle_input(
                                    &ime_focus,
                                    ElementInputHandler::new(bounds, ime_entity.clone()),
                                    cx,
                                );
                            },
                        )
                        .absolute()
                        .top_0()
                        .left_0()
                        .size_full(),
                    ),
            )
            .child(
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .justify_between()
                    .child(
                        div()
                            .id("model-chip")
                            .px(px(8.))
                            .py(px(2.))
                            .rounded(theme::radius_sm())
                            .cursor_pointer()
                            .hover(|style| style.bg(rgb(0xf1f2f5)))
                            .text_size(theme::micro_size())
                            .text_color(theme::secondary())
                            .on_click(cx.listener(|this, _event, _window, cx| {
                                this.picker = !this.picker;
                                cx.notify();
                            }))
                            .child(
                                current
                                    .as_ref()
                                    .map(|session| composer_model_label(&session.model, &catalog))
                                    .filter(|label| !label.is_empty())
                                    .unwrap_or_else(|| "モデルを選択".to_string()),
                            ),
                    )
                    .child(
                        div()
                            .flex()
                            .flex_row()
                            .items_center()
                            .gap(px(8.))
                            .when(running, |element| {
                                element.child(
                                    div()
                                        .id("stop")
                                        .w(px(34.))
                                        .h(px(34.))
                                        .flex()
                                        .items_center()
                                        .justify_center()
                                        .rounded(px(999.))
                                        .bg(rgb(0xf1f2f5))
                                        .text_size(theme::meta_size())
                                        .text_color(theme::label())
                                        .cursor_pointer()
                                        .on_click(cx.listener(|this, _event, _window, cx| {
                                            this.stop();
                                            cx.notify();
                                        }))
                                        .child("■"),
                                )
                            })
                            .child(
                                div()
                                    .id("send")
                                    .w(px(34.))
                                    .h(px(34.))
                                    .flex()
                                    .items_center()
                                    .justify_center()
                                    .rounded(px(999.))
                                    .bg(theme::accent())
                                    .text_size(theme::meta_size())
                                    .text_color(rgb(0xffffff))
                                    .cursor_pointer()
                                    .on_click(cx.listener(|this, _event, _window, cx| {
                                        this.submit();
                                        cx.notify();
                                    }))
                                    .child("↑"),
                            ),
                    ),
            );

        let center = div()
            .flex()
            .flex_col()
            .flex_1()
            .h_full()
            .bg(theme::page())
            .child(header)
            .child(timeline)
            .children(update_notice)
            .children(banner)
            .children(picker_panel)
            .child(composer);

        div()
            .flex()
            .flex_row()
            .size_full()
            .bg(theme::page())
            .text_color(theme::label())
            .text_size(theme::body_size())
            .child(sidebar)
            .child(center)
            .into_any_element()
    }
}

/// One rendered inline run: plain, bold, italic, code or link.
fn inline_span(span: &Span, ctx: &mut Context<DesktopApp>, color: Rgba) -> AnyElement {
    match span {
        Span::Text(text) => {
            if color == theme::label() {
                text.clone().into_any_element()
            } else {
                div().text_color(color).child(text.clone()).into_any_element()
            }
        }
        Span::Bold(inner) => div()
            .font_weight(FontWeight::BOLD)
            .children(render_inlines(inner, ctx, color))
            .into_any_element(),
        Span::Italic(inner) => div()
            .italic()
            .children(render_inlines(inner, ctx, color))
            .into_any_element(),
        Span::Code(code) => div()
            .font_family(MONO_FONT)
            .text_size(theme::meta_size())
            .bg(theme::code_block())
            .px(px(4.))
            .py(px(1.))
            .rounded(theme::radius_xs())
            .child(code.clone())
            .into_any_element(),
        Span::Link { text, .. } => div()
            .text_color(theme::accent())
            .children(render_inlines(text, ctx, color))
            .into_any_element(),
    }
}

fn render_inlines(spans: &[Span], ctx: &mut Context<DesktopApp>, color: Rgba) -> Vec<AnyElement> {
    spans
        .iter()
        .map(|span| inline_span(span, ctx, color))
        .collect()
}

/// Headings scale up to 16px (theme::heading_size) with larger h1/h2.
fn heading_size(level: u8) -> Pixels {
    match level {
        1 => px(18.),
        2 => px(17.),
        _ => theme::heading_size(),
    }
}

/// Render a parsed message as timeline elements. `color` is the base text
/// colour; code keeps its own background and secondary text.
fn render_blocks(blocks: &[Block], ctx: &mut Context<DesktopApp>, color: Rgba) -> Vec<AnyElement> {
    let last = blocks.len().saturating_sub(1);
    blocks
        .iter()
        .enumerate()
        .map(|(index, block)| block_element(block, ctx, color, index == last).into_any_element())
        .collect()
}

fn block_element(block: &Block, ctx: &mut Context<DesktopApp>, color: Rgba, last: bool) -> Div {
    match block {
        Block::Paragraph(spans) => {
            let content: Vec<AnyElement> = render_inlines(spans, ctx, color);
            let mut element = div().flex().flex_wrap().line_height(theme::body_line_height());
            if !last {
                element = element.mb(px(8.));
            }
            element.children(content)
        }
        Block::Heading { level, spans } => {
            let content: Vec<AnyElement> = render_inlines(spans, ctx, color);
            let mut element = div()
                .flex()
                .flex_wrap()
                .font_weight(FontWeight::SEMIBOLD)
                .text_size(heading_size(*level))
                .line_height(px(24.));
            if !last {
                element = element.mb(px(8.));
            }
            element.children(content)
        }
        Block::List { ordered, items } => {
            let rows: Vec<AnyElement> = items
                .iter()
                .enumerate()
                .map(|(index, item)| list_row(*ordered, index, item, ctx, color))
                .collect();
            let mut element = div().flex().flex_col().gap(px(4.));
            if !last {
                element = element.mb(px(8.));
            }
            element.children(rows)
        }
        Block::Blockquote(inner) => {
            let content = render_blocks(inner, ctx, theme::secondary());
            let mut element = div()
                .flex()
                .flex_col()
                .pl(px(10.))
                .border_l_1()
                .border_color(theme::border_strong())
                .text_color(theme::secondary());
            if !last {
                element = element.mb(px(8.));
            }
            element.children(content)
        }
        Block::CodeBlock { language, code } => {
            let mut element = div()
                .flex()
                .flex_col()
                .gap(px(6.))
                .p(px(10.))
                .rounded(theme::radius_sm())
                .bg(theme::code_block())
                .font_family(MONO_FONT)
                .text_size(theme::meta_size())
                .line_height(px(20.))
                .text_color(theme::secondary())
                .when_some(language.clone(), |element, language| {
                    element.child(
                        div()
                            .text_size(theme::micro_size())
                            .text_color(theme::tertiary())
                            .child(language),
                    )
                });
            if !code.is_empty() {
                element = element.children(code.lines().map(|line| {
                    div().flex().flex_wrap().child(if line.is_empty() {
                        " ".to_string()
                    } else {
                        line.to_string()
                    })
                }));
            }
            if !last {
                element = element.mb(px(8.));
            }
            element
        }
        Block::Rule => div()
            .h(px(1.))
            .w_full()
            .my(px(6.))
            .rounded(theme::radius_xs())
            .bg(theme::border()),
    }
}

fn list_row(
    ordered: bool,
    index: usize,
    item: &[Span],
    ctx: &mut Context<DesktopApp>,
    color: Rgba,
) -> AnyElement {
    let marker = if ordered {
        format!("{}.", index + 1)
    } else {
        "•".to_string()
    };
    div()
        .flex()
        .gap(px(8.))
        .child(
            div()
                .w(px(18.))
                .flex_shrink_0()
                .text_color(theme::tertiary())
                .child(marker),
        )
        .child(
            div()
                .flex()
                .flex_wrap()
                .flex_1()
                .line_height(theme::body_line_height())
                .children(render_inlines(item, ctx, color)),
        )
        .into_any_element()
}

/// The glyph and colour of one tool row.
fn tool_glyph(state: ToolState) -> (&'static str, Rgba) {
    match state {
        ToolState::Running => ("◐", theme::accent()),
        ToolState::Done => ("✓", theme::tertiary()),
        ToolState::Failed => ("✕", rgb(theme::DANGER)),
    }
}

/// Monospace family for code blocks and inline code; fontconfig resolves the
/// generic alias to Noto Sans Mono CJK on this host.
pub const MONO_FONT: &str = "monospace";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ToolState {
    Running,
    Done,
    Failed,
}

/// Infer the tool state from the message text: the verb the timeline shows is
/// the state word the harness wrote into the tool row.
fn tool_text_state(text: &str) -> ToolState {
    let normalized: String = text
        .chars()
        .take(240)
        .flat_map(char::to_lowercase)
        .collect();
    let has = |needle: &str| normalized.contains(needle);
    if has("failed")
        || has("failure")
        || has("error")
        || has("exception")
        || has("denied")
        || has("rejected")
        || has("失敗")
        || has("エラー")
    {
        ToolState::Failed
    } else if has("running")
        || has("started")
        || has("pending")
        || has("in progress")
        || has("実行中")
        || has("開始")
    {
        ToolState::Running
    } else if has("done")
        || has("completed")
        || has("success")
        || has("finished")
        || has("完了")
        || has("完了\u{3057}\u{307E}\u{3057}\u{305F}")
    {
        ToolState::Done
    } else {
        // A tool row that carries no state word is a finished call.
        ToolState::Done
    }
}

/// Split a tool row into the tool name and its compact summary.
fn tool_state_of(text: &str) -> (String, ToolState, String) {
    let first = text.trim().lines().next().unwrap_or_default().trim();
    let base = first
        .strip_prefix("tool:")
        .or_else(|| first.strip_prefix("tool/"))
        .or_else(|| first.strip_prefix("tool "))
        .unwrap_or(first)
        .trim();
    let (name, rest) = match base.split_once("·") {
        Some((name, rest)) => (name.trim(), rest.trim()),
        None => match base.split_once(" - ") {
            Some((name, rest)) => (name.trim(), rest.trim()),
            None => (base, ""),
        },
    };
    let name = if name.is_empty() {
        "tool".to_string()
    } else {
        name.to_string()
    };
    (name, tool_text_state(text), truncate(rest, 90))
}
/// Collapsed reasoning shows a one-line preview of the full text.
fn reasoning_preview(text: &str) -> String {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut preview: String = flat.chars().take(96).collect();
    if flat.chars().count() > 96 {
        preview.push('…');
    }
    preview
}

fn action_button(
    id: impl Into<ElementId>,
    label: impl Into<SharedString>,
    primary: bool,
    cx: &mut Context<DesktopApp>,
    action: impl Fn(&mut DesktopApp, &str) + 'static,
) -> AnyElement {
    let element_id = id.into();
    let text: SharedString = label.into();
    let label_string = text.to_string();
    div()
        .id(element_id)
        .px(px(12.))
        .py(px(6.))
        .rounded(theme::radius_sm())
        .cursor_pointer()
        .when(primary, |element| element.bg(theme::accent()))
        .when(!primary, |element| element.bg(theme::page()))
        .border_1()
        .border_color(theme::border())
        .text_size(theme::micro_size())
        .text_color(if primary {
            rgb(0xffffff)
        } else {
            theme::label()
        })
        .on_click(cx.listener(move |this, _event, _window, cx| {
            action(this, &label_string);
            cx.notify();
        }))
        .child(text)
        .into_any_element()
}


// ---- IME / text input plumbing -------------------------------------------
//
// gpui delivers IME composition and committed text through an InputHandler that
// is installed during paint. Ranges on that wire are UTF-16, so they are mapped
// to the editor's byte offsets here.

fn utf16_to_byte(text: &str, utf16: usize) -> usize {
    let mut units = 0;
    for (byte, character) in text.char_indices() {
        if units >= utf16 {
            return byte;
        }
        units += character.len_utf16();
    }
    text.len()
}

fn byte_to_utf16(text: &str, byte: usize) -> usize {
    let byte = byte.min(text.len());
    text[..byte]
        .chars()
        .map(|character| character.len_utf16())
        .sum()
}

/// Pick the UTF-16 range an IME replacement overwrites. The range the platform
/// sends wins; otherwise the active preedit is replaced, so a `k` -> `ka`
/// update rewrites the marked text instead of appending after it; otherwise the
/// editor selection is used, which is an insert at the caret.
fn ime_replacement_range(
    requested: Option<Range<usize>>,
    marked: Option<Range<usize>>,
    selection: Range<usize>,
) -> Range<usize> {
    requested.or(marked).unwrap_or(selection)
}

/// Rebase the IME's selected range — UTF-16 offsets relative to the newly
/// inserted preedit — onto the document, clamped to the inserted text.
fn ime_selected_range(inserted: Range<usize>, selected: Range<usize>) -> Range<usize> {
    let start = inserted
        .start
        .saturating_add(selected.start)
        .min(inserted.end);
    let end = inserted
        .start
        .saturating_add(selected.end)
        .min(inserted.end)
        .max(start);
    start..end
}

impl DesktopApp {
    /// Replace the IME range with `text` and return the inserted range as UTF-16
    /// offsets into the new text.
    fn ime_replace(&mut self, range: Option<Range<usize>>, text: &str) -> Range<usize> {
        let current = self.editor.text().to_string();
        let selection = self.editor.selection();
        let selection =
            byte_to_utf16(&current, selection.start)..byte_to_utf16(&current, selection.end);
        let range = ime_replacement_range(range, self.marked.clone(), selection);
        let start = utf16_to_byte(&current, range.start);
        let end = utf16_to_byte(&current, range.end).max(start);
        let start = start.min(current.len());
        let end = end.min(current.len()).max(start);
        let inserted_end = start + text.len();
        self.editor.move_to(start);
        self.editor.select_to(end);
        self.editor.insert(text);
        let current = self.editor.text();
        byte_to_utf16(current, start)..byte_to_utf16(current, inserted_end)
    }
}

impl EntityInputHandler for DesktopApp {
    fn text_for_range(
        &mut self,
        range: Range<usize>,
        adjusted_range: &mut Option<Range<usize>>,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<String> {
        let text = self.editor.text();
        let start = utf16_to_byte(text, range.start);
        let end = utf16_to_byte(text, range.end).max(start);
        *adjusted_range = Some(byte_to_utf16(text, start)..byte_to_utf16(text, end));
        Some(text[start..end].to_string())
    }

    fn selected_text_range(
        &mut self,
        _ignore_disabled_input: bool,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<UTF16Selection> {
        let text = self.editor.text();
        let selection = self.editor.selection();
        Some(UTF16Selection {
            range: byte_to_utf16(text, selection.start)..byte_to_utf16(text, selection.end),
            reversed: self.editor.caret() < self.editor.anchor(),
        })
    }

    fn marked_text_range(
        &self,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<Range<usize>> {
        self.marked.clone()
    }

    fn unmark_text(&mut self, _window: &mut Window, _cx: &mut Context<Self>) {
        self.marked = None;
    }

    fn replace_text_in_range(
        &mut self,
        range: Option<Range<usize>>,
        text: &str,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.ime_replace(range, text);
        self.marked = None;
        log::info!("IME commit: {} chars", text.chars().count());
        cx.notify();
    }

    fn replace_and_mark_text_in_range(
        &mut self,
        range: Option<Range<usize>>,
        new_text: &str,
        new_selected_range: Option<Range<usize>>,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let inserted = self.ime_replace(range, new_text);
        if new_text.is_empty() {
            self.marked = None;
        } else {
            self.marked = Some(inserted.clone());
            // The platform reports this range relative to the preedit it just
            // sent, so rebase it onto the document before moving the caret.
            if let Some(selected) = new_selected_range {
                let selected = ime_selected_range(inserted, selected);
                let text = self.editor.text();
                let start = utf16_to_byte(text, selected.start);
                let end = utf16_to_byte(text, selected.end);
                self.editor.move_to(start);
                self.editor.select_to(end);
            }
        }
        log::debug!("IME composing: {} chars", new_text.chars().count());
        cx.notify();
    }

    fn bounds_for_range(
        &mut self,
        _range_utf16: Range<usize>,
        element_bounds: Bounds<Pixels>,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<Bounds<Pixels>> {
        Some(element_bounds)
    }

    fn character_index_for_point(
        &mut self,
        _point: Point<Pixels>,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<usize> {
        let text = self.editor.text();
        Some(byte_to_utf16(text, self.editor.caret()))
    }
}
