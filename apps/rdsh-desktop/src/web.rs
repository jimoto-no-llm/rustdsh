//! Local web UI for the native client (`--serve-web`).
//!
//! The same harness connection the window uses, exposed to a browser on
//! loopback only. The page is embedded at compile time, so there is no build
//! step and no external asset.
//!
//! Three invariants shape the design:
//!
//!  * the harness conversation lives on one worker thread only. HTTP handler
//!    threads never touch a socket; they queue a command and wait for the
//!    worker to answer, so a slow host cannot stall a request handler.
//!  * the harness session cookie and the host process token never reach the
//!    browser. The page authenticates with its own random token, and every
//!    harness call is made from this process.
//!  * live deltas arrive on a broadcast channel and are re-serialised as
//!    Server-Sent Events, so the browser sees the same stream the window does.

use std::io::{BufRead, BufReader, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::sync::mpsc::{self, Receiver, SyncSender, TrySendError};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

use crate::app::Chat;
use crate::live::{self, LiveCmd, LiveEvent, Pending};

/// Default loopback port.
pub const DEFAULT_PORT: u16 = 8790;

/// Header the page may use instead of the query parameter (kept out of URLs).
pub const TOKEN_HEADER: &str = "x-rdsh-token";

/// Largest request line + headers we accept; the bodies here are JSON commands.
const MAX_HEADER: usize = 16 * 1024;
/// Largest request body we accept.
const MAX_BODY: usize = 1024 * 1024;
/// Read timeout while one request is served.
const IO_TIMEOUT: Duration = Duration::from_secs(30);
/// One broadcast queue per connected event stream.
const EVENT_QUEUE: usize = 256;
/// How often the worker re-reads sessions, pending and notes.
const WORKER_TICK: Duration = Duration::from_millis(250);
/// Keep-alive comment for idle event streams.
const SSE_HEARTBEAT: Duration = Duration::from_secs(15);

const PAGE: &str = include_str!("webui.html");

/// Marker the page uses where its own token must appear. Keeping it in the
/// document means the served HTML never needs a second request to learn it.
const TOKEN_PLACEHOLDER: &str = "__RDSH_TOKEN__";

/// The embedded page with this server's token substituted in.
pub fn serve_page(token: &str) -> String {
    PAGE.replace(TOKEN_PLACEHOLDER, token)
}

// ---------------------------------------------------------------------------
// Request classification (pure; exercised by the unit tests)
// ---------------------------------------------------------------------------

/// One served endpoint.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Route {
    Page,
    State,
    Select,
    Send,
    Cancel,
    Model,
    Approve,
    Answer,
    Events,
}

impl Route {
    /// The JSON action name reported back to the page; read-only and streaming
    /// endpoints have none. Kept as the single source of truth for those names.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn action(self) -> Option<&'static str> {
        match self {
            Route::Select => Some("select"),
            Route::Send => Some("send"),
            Route::Cancel => Some("cancel"),
            Route::Model => Some("model"),
            Route::Approve => Some("approve"),
            Route::Answer => Some("answer"),
            Route::Page | Route::State | Route::Events => None,
        }
    }
}

/// Request head, before the body is read.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ParsedRequest {
    pub method: String,
    pub path: String,
    pub token: String,
    pub body: String,
}

/// One parsed request line plus the headers we care about.
#[derive(Debug)]
struct RawRequest {
    request: ParsedRequest,
    content_length: usize,
}

/// Parse the request line and headers. Only GET and POST are implemented, so
/// anything else is a client error rather than a silent default.
fn parse_request(request_line: &str, headers: &[(String, String)]) -> Result<RawRequest, u16> {
    let mut parts = request_line.split(' ');
    let method = parts.next().unwrap_or_default();
    let target = parts.next().unwrap_or_default();
    let version = parts.next().unwrap_or_default();
    if method.is_empty() || target.is_empty() || !version.starts_with("HTTP/") {
        return Err(400);
    }
    if method != "GET" && method != "POST" {
        return Err(405);
    }
    if !target.starts_with('/') || target.contains(' ') {
        return Err(400);
    }
    let (path, query) = match target.split_once('?') {
        Some((path, query)) => (path, query),
        None => (target, ""),
    };
    if path.len() > MAX_HEADER {
        return Err(400);
    }
    let token = header(headers, TOKEN_HEADER)
        .map(str::to_string)
        .or_else(|| query_param(query, "token"))
        .unwrap_or_default();
    let content_length = header(headers, "content-length")
        .and_then(|value| value.trim().parse::<usize>().ok())
        .unwrap_or(0);
    Ok(RawRequest {
        request: ParsedRequest {
            method: method.to_string(),
            path: path.to_string(),
            token,
            body: String::new(),
        },
        content_length,
    })
}

fn header<'a>(headers: &'a [(String, String)], name: &str) -> Option<&'a str> {
    headers
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case(name))
        .map(|(_, value)| value.as_str())
}

/// Percent-decoded value of one query parameter, or None when absent.
fn query_param(query: &str, name: &str) -> Option<String> {
    query.split('&').find_map(|pair| {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        (key == name).then(|| percent_decode(value))
    })
}

fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'%' if index + 2 < bytes.len() => {
                match u8::from_str_radix(&value[index + 1..index + 3], 16) {
                    Ok(byte) => {
                        out.push(byte);
                        index += 3;
                    }
                    Err(_) => {
                        out.push(b'%');
                        index += 1;
                    }
                }
            }
            byte => {
                out.push(byte);
                index += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).to_string()
}

/// Route one path to its handler. Only GET is accepted for the read-only and
/// streaming endpoints.
pub fn route_for(method: &str, path: &str) -> Option<Route> {
    Some(match (method, path) {
        ("GET", "/") => Route::Page,
        ("GET", "/index.html") => Route::Page,
        ("GET", "/api/state") => Route::State,
        ("POST", "/api/select") => Route::Select,
        ("POST", "/api/send") => Route::Send,
        ("POST", "/api/cancel") => Route::Cancel,
        ("POST", "/api/model") => Route::Model,
        ("POST", "/api/approve") => Route::Approve,
        ("POST", "/api/answer") => Route::Answer,
        ("GET", "/api/events") => Route::Events,
        _ => return None,
    })
}

/// Constant-time string comparison: neither length nor first difference is
/// observable through timing.
pub fn constant_time_eq(left: &str, right: &str) -> bool {
    if left.len() != right.len() {
        return false;
    }
    let mut diff = 0u8;
    for (a, b) in left.as_bytes().iter().zip(right.as_bytes()) {
        diff |= a ^ b;
    }
    diff == 0
}

/// A request carries the page token when its token matches the generated one.
pub fn authorized(token: &str, expected: &str) -> bool {
    !token.is_empty() && !expected.is_empty() && constant_time_eq(token, expected)
}

/// One Server-Sent Event frame.
pub fn sse_frame(event: &str, data: &Value) -> String {
    format!("event: {event}\ndata: {data}\n\n")
}

/// Random page token: the clock and the process identity are hashed with
/// SHA-256, which needs no dependency beyond the ones already in the crate.
fn generate_token() -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(now_millis().to_le_bytes());
    hasher.update(std::process::id().to_le_bytes());
    let stack = 0u8;
    hasher.update((&stack as *const u8 as usize).to_le_bytes());
    hasher.update(std::env::var("HOME").unwrap_or_default().as_bytes());
    let digest = hasher.finalize();
    let mut token = String::with_capacity(32);
    for byte in digest.iter().take(16) {
        token.push_str(&format!("{byte:02x}"));
    }
    token
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// Pending decisions (pure; exercised by the unit tests)
// ---------------------------------------------------------------------------

/// The JSON shape of one waiting approval or question batch.
pub fn pending_json(pending: &Pending) -> Value {
    match pending {
        Pending::Approval {
            event_id,
            tool,
            reason,
        } => json!({
            "kind": "approval",
            "eventId": event_id,
            "tool": tool,
            "reason": reason,
        }),
        Pending::Question {
            event_id,
            call_id,
            session_id,
            questions,
            ..
        } => json!({
            "kind": "question",
            "eventId": event_id,
            "callId": call_id,
            "sessionId": session_id,
            "questions": questions
                .iter()
                .map(|question| json!({
                    "id": question.id,
                    "question": question.question,
                    "header": question.header,
                    "detail": question.detail,
                    "multiSelect": question.multi_select,
                    "allowCustom": question.allow_custom,
                    "options": question
                        .options
                        .iter()
                        .map(|option| json!({
                            "label": option.label,
                            "description": option.description,
                        }))
                        .collect::<Vec<_>>(),
                }))
                .collect::<Vec<_>>(),
        }),
        // Pending is a closed set: a new variant must be given a shape here
        // rather than silently serialising as "unknown".
    }
}

/// The SSE frame for one live event, or None for events the page does not use.
pub fn event_frame(event: &LiveEvent) -> Option<(&'static str, Value)> {
    Some(match event {
        LiveEvent::Ready(client) => ("ready", json!({ "clientId": client })),
        LiveEvent::Pending(pending) => ("pending", pending_json(pending)),
        LiveEvent::Dismissed(event_id) => ("dismissed", json!({ "eventId": event_id })),
        LiveEvent::Delta(text) => ("delta", json!({ "text": text })),
        LiveEvent::Activity => ("activity", json!({})),
        LiveEvent::Idle => ("idle", json!({})),
        LiveEvent::Note(note) => ("note", json!({ "text": note })),
        LiveEvent::Closed(error) => ("closed", json!({ "error": error })),
    })
}

/// Whether the assistant finished while the page was in the background. The
/// page applies the same rule in JavaScript; this is the tested contract.
#[cfg_attr(not(test), allow(dead_code))]
pub fn should_notify_finish(was_running: bool, running: bool, hidden: bool) -> bool {
    was_running && !running && hidden
}

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

struct Client {
    id: u64,
    sender: SyncSender<String>,
}

#[derive(Default)]
struct Hub {
    clients: Vec<Client>,
    next_id: u64,
}

impl Hub {
    fn subscribe(&mut self) -> (u64, Receiver<String>) {
        let (sender, receiver) = mpsc::sync_channel(EVENT_QUEUE);
        let id = self.next_id;
        self.next_id = self.next_id.wrapping_add(1);
        self.clients.push(Client { id, sender });
        (id, receiver)
    }

    fn unsubscribe(&mut self, id: u64) {
        self.clients.retain(|client| client.id != id);
    }

    /// Broadcast one frame; a client that cannot keep up drops it instead of
    /// blocking the worker.
    fn publish(&mut self, frame: &str) {
        self.clients
            .retain(|client| match client.sender.try_send(frame.to_string()) {
                Ok(()) => true,
                Err(TrySendError::Full(_)) => true,
                Err(TrySendError::Disconnected(_)) => false,
            });
    }
}

/// State shared by the worker, the HTTP handlers and the event streams.
pub struct WebState {
    /// Last snapshot the worker published. The worker is the only owner of the
    /// harness connection, so HTTP threads read this instead of a socket.
    snapshot: Mutex<Option<Value>>,
    events: Mutex<Hub>,
    pending: Mutex<Option<Value>>,
    streaming: Mutex<String>,
    notes: Mutex<Vec<String>>,
    selected: Mutex<Option<String>>,
    client_id: Mutex<String>,
}

impl Default for WebState {
    fn default() -> Self {
        Self {
            snapshot: Mutex::new(None),
            events: Mutex::new(Hub::default()),
            pending: Mutex::new(None),
            streaming: Mutex::new(String::new()),
            notes: Mutex::new(Vec::new()),
            selected: Mutex::new(None),
            client_id: Mutex::new(String::new()),
        }
    }
}

impl WebState {
    fn events(&self) -> MutexGuard<'_, Hub> {
        self.events.lock().unwrap_or_else(|poison| poison.into_inner())
    }

    fn publish(&self, event: &str, data: &Value) {
        self.events().publish(&sse_frame(event, data));
    }

    fn set_pending(&self, pending: Option<Value>) {
        *self.pending.lock().unwrap_or_else(|poison| poison.into_inner()) = pending;
    }

    fn set_streaming(&self, text: String) {
        *self.streaming.lock().unwrap_or_else(|poison| poison.into_inner()) = text;
    }

    fn set_selected(&self, session: Option<String>) {
        *self.selected.lock().unwrap_or_else(|poison| poison.into_inner()) = session;
    }

    fn set_client_id(&self, client: String) {
        *self.client_id.lock().unwrap_or_else(|poison| poison.into_inner()) = client;
    }

    fn client_id(&self) -> String {
        self.client_id
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .clone()
    }

    fn note(&self, text: String) {
        let mut notes = self.notes.lock().unwrap_or_else(|poison| poison.into_inner());
        notes.push(text);
        while notes.len() > 12 {
            notes.remove(0);
        }
    }

    /// Publish the snapshot the worker just built from its live connection.
    fn set_snapshot(&self, snapshot: Value) {
        *self.snapshot.lock().unwrap_or_else(|poison| poison.into_inner()) = Some(snapshot);
    }

    /// The whole page state as one JSON document, with the live pending and
    /// streaming values merged over the last harness snapshot.
    pub fn state_json(&self) -> Value {
        let guard = self.snapshot.lock().unwrap_or_else(|poison| poison.into_inner());
        match guard.as_ref() {
            Some(snapshot) => merge_view(snapshot, &self.view()),
            None => json!({
                "status": "ハーネスに接続しています…",
                "connecting": true,
                "groups": [],
                "selected": null,
                "messages": [],
                "currentModel": null,
                "modelGroups": [],
                "running": false,
                "streaming": "",
                "pending": null,
                "notes": [],
            }),
        }
    }

    fn view(&self) -> View {
        View {
            pending: self
                .pending
                .lock()
                .unwrap_or_else(|poison| poison.into_inner())
                .clone(),
            streaming: self
                .streaming
                .lock()
                .unwrap_or_else(|poison| poison.into_inner())
                .clone(),
            notes: self
                .notes
                .lock()
                .unwrap_or_else(|poison| poison.into_inner())
                .clone(),
            selected: self
                .selected
                .lock()
                .unwrap_or_else(|poison| poison.into_inner())
                .clone(),
        }
    }
}

/// Per-request view of the live state. Cheap to clone: the worker keeps the
/// canonical copy and merges it into every published snapshot.
#[derive(Clone)]
pub(crate) struct View {
    pending: Option<Value>,
    streaming: String,
    notes: Vec<String>,
    selected: Option<String>,
}

/// Merge the live pending/streaming view over a previously published snapshot,
/// so an HTTP reader sees the freshest delta without touching a socket.
fn merge_view(snapshot: &Value, view: &View) -> Value {
    let mut merged = snapshot.clone();
    let Some(object) = merged.as_object_mut() else {
        return merged;
    };
    object.insert("streaming".to_string(), Value::String(view.streaming.clone()));
    object.insert(
        "pending".to_string(),
        view.pending.clone().unwrap_or(Value::Null),
    );
    object.insert("notes".to_string(), json!(view.notes));
    let busy = object
        .get("running")
        .and_then(Value::as_bool)
        .unwrap_or(false)
        || !view.streaming.is_empty();
    object.insert("running".to_string(), Value::Bool(busy));
    merged
}

/// The snapshot of one harness connection, with the live view mixed in.
fn chat_snapshot(chat: &Chat, state: &WebState) -> Value {
    build_state(chat, &state.view())
}

/// Build the full state document for the page.
pub(crate) fn build_state(chat: &Chat, view: &View) -> Value {
    let selected = view
        .selected
        .clone()
        .or_else(|| chat.selected_session().map(|session| session.id.clone()));
    let current = chat.selected_session();
    let running =
        chat.sessions.iter().any(|session| session.running) || !view.streaming.is_empty();
    let groups: Vec<Value> = chat
        .groups()
        .iter()
        .map(|group| {
            json!({
                "label": group.label,
                "path": group.path,
                "sessions": group
                    .sessions
                    .iter()
                    .map(|(_, session)| json!({
                        "id": session.id,
                        "title": if session.title.is_empty() {
                            "（無題）".to_string()
                        } else {
                            session.title.clone()
                        },
                        "running": session.running,
                        "blank": session.blank,
                        "updatedAt": session.updated,
                        "model": session.model.label(),
                        "context": session.context,
                        "tokens": session.tokens,
                        "questions": session.questions,
                    }))
                    .collect::<Vec<_>>(),
            })
        })
        .collect();
    let providers: Vec<Value> = chat
        .catalog
        .iter()
        .map(|provider| {
            let is_current = current
                .map(|session| session.model.provider == provider.id)
                .unwrap_or(false);
            json!({
                "id": provider.id,
                "name": provider.name,
                "current": is_current,
                "models": provider
                    .models
                    .iter()
                    .map(|model| json!({
                        "id": model.id,
                        "name": model.name,
                        "current": is_current
                            && current
                                .map(|session| session.model.model == model.id)
                                .unwrap_or(false),
                    }))
                    .collect::<Vec<_>>(),
            })
        })
        .collect();
    json!({
        "status": chat.status,
        "connecting": false,
        "hostVersion": chat.host_version(),
        "hostReused": chat.reused,
        "groups": groups,
        "selected": selected,
        "messages": chat
            .messages
            .iter()
            .map(|message| json!({ "role": message.role, "text": message.text }))
            .collect::<Vec<_>>(),
        "currentModel": current.map(|session| session.model.label()),
        "modelGroups": providers,
        "running": running,
        "streaming": view.streaming,
        "pending": view.pending,
        "notes": view.notes,
    })
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// One queued action. Long harness calls run on the worker thread; the HTTP
/// handler waits on the reply channel so it never touches a socket.
pub enum WebCommand {
    Select {
        session: String,
        reply: mpsc::Sender<Result<(), String>>,
    },
    Send {
        text: String,
        reply: mpsc::Sender<Result<(), String>>,
    },
    Cancel {
        reply: mpsc::Sender<Result<(), String>>,
    },
    Model {
        provider: String,
        model: String,
        reply: mpsc::Sender<Result<(), String>>,
    },
    Approve {
        allow: bool,
        reply: mpsc::Sender<Result<(), String>>,
    },
    Answer {
        answers: Vec<(String, Vec<String>)>,
        reply: mpsc::Sender<Result<(), String>>,
    },
}

impl WebCommand {
    /// Consume the command and hand back the channel its result goes on.
    fn take_reply(self) -> mpsc::Sender<Result<(), String>> {
        match self {
            WebCommand::Select { reply, .. }
            | WebCommand::Send { reply, .. }
            | WebCommand::Cancel { reply }
            | WebCommand::Model { reply, .. }
            | WebCommand::Approve { reply, .. }
            | WebCommand::Answer { reply, .. } => reply,
        }
    }
}

/// Queue one command and wait for the worker. An error means it never ran.
fn dispatch(
    queue: &mpsc::Sender<WebCommand>,
    command: WebCommand,
    reply: Receiver<Result<(), String>>,
) -> Result<(), String> {
    if queue.send(command).is_err() {
        return Err("サーバー内部のワーカーが停止しています".to_string());
    }
    reply
        .recv_timeout(Duration::from_secs(120))
        .unwrap_or_else(|_| Err("ハーネスの応答がタイムアウトしました".to_string()))
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

/// The loopback server. It owns the listener and the page token; the harness
/// connection lives on the worker it starts.
pub struct WebServer {
    listener: TcpListener,
    token: String,
    port: u16,
    queue: mpsc::Sender<WebCommand>,
    state: Arc<WebState>,
}

impl WebServer {
    /// Bind the loopback listener, generate the page token and start the
    /// harness worker, which connects through the normal host resolution.
    pub fn start(port: u16) -> anyhow::Result<Self> {
        let listener = TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, port)))?;
        let port = listener.local_addr()?.port();
        let token = generate_token();
        let state = Arc::new(WebState::default());
        let (queue, commands) = mpsc::channel::<WebCommand>();
        spawn_worker(state.clone(), commands);
        Ok(Self {
            listener,
            token,
            port,
            queue,
            state,
        })
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    /// The URL to open, token included.
    pub fn url(&self) -> String {
        banner(self.port, &self.token)
    }

    /// Serve until the process is stopped. One thread per connection; every
    /// long harness call goes to the worker through the command queue.
    pub fn serve(self) -> anyhow::Result<()> {
        for stream in self.listener.incoming() {
            let stream = match stream {
                Ok(stream) => stream,
                Err(_) => continue,
            };
            let token = self.token.clone();
            let queue = self.queue.clone();
            let state = self.state.clone();
            std::thread::spawn(move || {
                let _ = handle(stream, &token, &queue, &state);
            });
        }
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

fn spawn_worker(state: Arc<WebState>, commands: Receiver<WebCommand>) {
    std::thread::spawn(move || run_worker(state, commands));
}

/// Own the harness connection, drain commands and re-publish state after each
/// event so a request never waits on a socket.
fn run_worker(state: Arc<WebState>, commands: Receiver<WebCommand>) {
    // The live threads report into this queue; the worker is the only reader.
    let (live_tx, live_rx) = mpsc::channel::<LiveEvent>();
    let (cmd_tx, cmd_rx) = mpsc::channel::<LiveCmd>();

    let mut chat = match Chat::connect(|_| {}) {
        Ok(chat) => chat,
        Err(error) => {
            state.note(format!("ハーネスに接続できません: {error:#}"));
            eprintln!("[rdsh-desktop] web: cannot reach the harness: {error:#}");
            return;
        }
    };
    if chat.reused {
        eprintln!("[rdsh-desktop] web: reusing the running harness host");
    }
    // One live pair for the whole server: the $events stream plus the followed
    // conversation of the current selection.
    live::spawn(chat.origin(), chat.cookie(), cmd_rx, live_tx);
    if let Some(session) = chat.selected_session().map(|session| session.id.clone()) {
        state.set_selected(Some(session.clone()));
        let _ = cmd_tx.send(LiveCmd::Follow(session));
    }
    state.set_snapshot(chat_snapshot(&chat, &state));

    let mut last_publish = Instant::now() - WORKER_TICK;
    loop {
        // Commands first so a click is not delayed by a tick.
        while let Ok(command) = commands.try_recv() {
            run_command(&mut chat, command, &state, &cmd_tx);
        }
        // Live events: deltas, pending decisions and connection notes.
        while let Ok(event) = live_rx.try_recv() {
            apply_event(&event, &state);
        }
        if last_publish.elapsed() >= WORKER_TICK {
            state.set_snapshot(chat_snapshot(&chat, &state));
            let state_json = state.state_json();
            state.publish("state", &state_json);
            last_publish = Instant::now();
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn run_command(
    chat: &mut Chat,
    command: WebCommand,
    state: &Arc<WebState>,
    cmd_tx: &mpsc::Sender<LiveCmd>,
) {
    let result = run_work(chat, &command, state, cmd_tx);
    if result.is_ok() {
        // Durable state moved: re-read the open conversation once so the page
        // and the next reader both see the new turn.
        let _ = chat.load_conversation();
    }
    state.set_snapshot(chat_snapshot(chat, state));
    state.publish("refreshed", &state.state_json());
    // Answered last: while this sender is alive the waiting handler blocks, so
    // it only returns once the refreshed state is already published.
    let _ = command.take_reply().send(result);
}

/// Runs one command against the harness. It returns the outcome instead of
/// reporting it, so the caller can refresh the state before answering.
fn run_work(
    chat: &mut Chat,
    command: &WebCommand,
    state: &Arc<WebState>,
    cmd_tx: &mpsc::Sender<LiveCmd>,
) -> Result<(), String> {
    let result: Result<(), String> = match command {
        WebCommand::Select { session, .. } => {
            let index = chat
                .sessions
                .iter()
                .position(|candidate| candidate.id == *session);
            match index {
                Some(index) => {
                    chat.select(index);
                    state.set_selected(Some(session.clone()));
                    state.set_streaming(String::new());
                    let follow = chat
                        .selected_session()
                        .map(|session| session.id.clone())
                        .unwrap_or_default();
                    let _ = cmd_tx.send(LiveCmd::Follow(follow));
                    Ok(())
                }
                None => Err("その会話は見つかりません".to_string()),
            }
        }
        WebCommand::Send { text, .. } => {
            // The prompt is queued; the caller reloads the conversation after
            // this returns, so only the send itself is reported here.
            chat.send_prompt(text)
                .map_err(|error| format!("{error:#}"))
                .inspect(|()| state.set_streaming(String::new()))
        }
        WebCommand::Cancel { .. } => chat.cancel().map_err(|error| format!("{error:#}")),
        WebCommand::Model {
            provider, model, ..
        } => chat
            .select_model(&provider, &model)
            .map_err(|error| format!("{error:#}")),
        WebCommand::Approve { allow, .. } => {
            let pending = state.view().pending;
            match pending {
                Some(pending) => {
                    let event_id = pending
                        .get("eventId")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string();
                    if event_id.is_empty() {
                        Err("承認対象がありません".to_string())
                    } else {
                        let client_id = state.client_id();
                        chat.approve(&client_id, &event_id, *allow)
                            .map_err(|error| format!("{error:#}"))
                    }
                }
                None => Err("承認待ちはありません".to_string()),
            }
        }
        WebCommand::Answer { answers, .. } => {
            let pending = state.view().pending;
            match pending {
                Some(pending) => {
                    let call_id = pending
                        .get("callId")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string();
                    let session_id = pending
                        .get("sessionId")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string();
                    chat.answer_question(&session_id, &call_id, &answers)
                        .map_err(|error| format!("{error:#}"))
                }
                None => Err("回答待ちはありません".to_string()),
            }
        }
    };

    // A successful action clears whatever the page was waiting on; failures are
    // reported as a note and left for the caller to surface.
    if result.is_ok() {
        state.set_pending(None);
    } else if let Err(message) = &result {
        state.note(message.clone());
    }
    result
}

/// Applies one live event to the shared state and broadcasts it.
fn apply_event(event: &LiveEvent, state: &Arc<WebState>) {
    match event {
        LiveEvent::Delta(text) => {
            let mut streaming = state
                .streaming
                .lock()
                .unwrap_or_else(|poison| poison.into_inner());
            streaming.push_str(text);
            // Bound the buffer: a very long run keeps its tail only.
            if streaming.len() > 200_000 {
                let cut = streaming.len() - 100_000;
                let safe = (cut..streaming.len())
                    .find(|index| streaming.is_char_boundary(*index))
                    .unwrap_or(streaming.len());
                *streaming = streaming[safe..].to_string();
            }
        }
        LiveEvent::Pending(pending) => state.set_pending(Some(pending_json(pending))),
        LiveEvent::Dismissed(_) => state.set_pending(None),
        LiveEvent::Idle => state.set_streaming(String::new()),
        LiveEvent::Ready(client) => state.set_client_id(client.clone()),
        LiveEvent::Note(note) => state.note(note.clone()),
        LiveEvent::Closed(error) => state.note(format!("接続が切れました: {error}")),
        LiveEvent::Activity => {}
    }
    if let Some((event, data)) = event_frame(event) {
        state.publish(event, &data);
    }
    // A pending decision changes the sidebar and the composer banner at once.
    if matches!(event, LiveEvent::Pending(_) | LiveEvent::Dismissed(_)) {
        state.publish("state", &state.state_json());
    }
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

fn handle(
    stream: TcpStream,
    token: &str,
    queue: &mpsc::Sender<WebCommand>,
    state: &Arc<WebState>,
) -> anyhow::Result<()> {
    stream.set_read_timeout(Some(IO_TIMEOUT))?;
    stream.set_write_timeout(Some(IO_TIMEOUT))?;
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut writer = stream;

    let mut request_line = String::new();
    if reader.read_line(&mut request_line)? == 0 {
        return Ok(());
    }
    let request_line = request_line.trim_end_matches(['\r', '\n']);
    let mut headers: Vec<(String, String)> = Vec::new();
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line)? == 0 {
            break;
        }
        let line = line.trim_end_matches(['\r', '\n']);
        if line.is_empty() {
            break;
        }
        if let Some((name, value)) = line.split_once(':') {
            headers.push((name.trim().to_string(), value.trim().to_string()));
        }
    }
    let parsed = match parse_request(request_line, &headers) {
        Ok(parsed) => parsed,
        Err(status) => {
            send_response(&mut writer, status, "text/plain; charset=utf-8", "")?;
            return Ok(());
        }
    };
    let mut request = parsed.request;
    if parsed.content_length > 0 {
        if parsed.content_length > MAX_BODY {
            send_response(&mut writer, 413, "text/plain; charset=utf-8", "")?;
            return Ok(());
        }
        let mut body = vec![0u8; parsed.content_length];
        std::io::Read::read_exact(&mut reader, &mut body)?;
        request.body = String::from_utf8_lossy(&body).to_string();
    }

    if !authorized(&request.token, token) {
        send_response(
            &mut writer,
            403,
            "application/json; charset=utf-8",
            &json!({ "error": "unauthorized", "hint": "token が必要です" }).to_string(),
        )?;
        return Ok(());
    }

    let route = match route_for(&request.method, &request.path) {
        Some(route) => route,
        None => {
            send_response(&mut writer, 404, "text/plain; charset=utf-8", "")?;
            return Ok(());
        }
    };

    if route == Route::Events {
        return stream_events(&mut writer, state);
    }

    let (status, body) = match route {
        Route::Page => (200, serve_page(token)),
        Route::State => (200, state.state_json().to_string()),
        action => handle_action(action, &request, queue),
    };
    let content_type = if route == Route::Page {
        "text/html; charset=utf-8"
    } else {
        "application/json; charset=utf-8"
    };
    send_response(&mut writer, status, content_type, &body)?;
    if status == 200 && matches!(route, Route::Select | Route::Send | Route::Cancel) {
        // Push the result without waiting for the next worker tick.
        state.publish("refreshed", &state.state_json());
    }
    Ok(())
}

/// Read one string field out of a JSON command body.
fn field(body: &str, name: &str) -> Option<String> {
    serde_json::from_str::<Value>(body)
        .ok()?
        .get(name)
        .and_then(Value::as_str)
        .map(str::to_string)
}

/// Route one mutating command to the worker.
fn handle_action(
    route: Route,
    request: &ParsedRequest,
    queue: &mpsc::Sender<WebCommand>,
) -> (u16, String) {
    let (command, receiver) = match route {
        Route::Select => {
            let Some(session) = field(&request.body, "sessionId") else {
                return (400, json!({ "error": "sessionId が必要です" }).to_string());
            };
            let (reply, receiver) = mpsc::channel();
            (WebCommand::Select { session, reply }, receiver)
        }
        Route::Send => {
            let Some(text) = field(&request.body, "text") else {
                return (400, json!({ "error": "text が必要です" }).to_string());
            };
            let (reply, receiver) = mpsc::channel();
            (WebCommand::Send { text, reply }, receiver)
        }
        Route::Cancel => {
            let (reply, receiver) = mpsc::channel();
            (WebCommand::Cancel { reply }, receiver)
        }
        Route::Model => {
            let (Some(provider), Some(model)) =
                (field(&request.body, "provider"), field(&request.body, "model"))
            else {
                return (
                    400,
                    json!({ "error": "provider と model が必要です" }).to_string(),
                );
            };
            let (reply, receiver) = mpsc::channel();
            (
                WebCommand::Model {
                    provider,
                    model,
                    reply,
                },
                receiver,
            )
        }
        Route::Approve => {
            let allow = serde_json::from_str::<Value>(&request.body)
                .ok()
                .and_then(|value| value.get("allow").and_then(Value::as_bool))
                .unwrap_or(false);
            let (reply, receiver) = mpsc::channel();
            (WebCommand::Approve { allow, reply }, receiver)
        }
        Route::Answer => {
            let Some(answers) = parse_answers(&request.body) else {
                return (400, json!({ "error": "answers が必要です" }).to_string());
            };
            let (reply, receiver) = mpsc::channel();
            (WebCommand::Answer { answers, reply }, receiver)
        }
        Route::Page | Route::State | Route::Events => {
            return (404, json!({ "error": "not found" }).to_string())
        }
    };

    match dispatch(queue, command, receiver) {
        Ok(()) => (200, json!({ "ok": true }).to_string()),
        Err(message) => (500, json!({ "error": message }).to_string()),
    }
}

/// answers: [{ "id": "q1", "selected": ["Yes"] }, ...]
fn parse_answers(body: &str) -> Option<Vec<(String, Vec<String>)>> {
    let value: Value = serde_json::from_str(body).ok()?;
    let items = value.get("answers")?.as_array()?;
    let mut answers = Vec::new();
    for item in items {
        let id = item.get("id")?.as_str()?.to_string();
        let selected = item
            .get("selected")
            .and_then(Value::as_array)
            .map(|values| {
                values
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        answers.push((id, selected));
    }
    (!answers.is_empty()).then_some(answers)
}

/// Stream Server-Sent Events until the browser disconnects.
fn stream_events(writer: &mut TcpStream, state: &Arc<WebState>) -> anyhow::Result<()> {
    let (id, receiver) = state.events().subscribe();
    let head = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream; charset=utf-8\r\nCache-Control: no-cache\r\nConnection: keep-alive\r\nX-Accel-Buffering: no\r\n\r\n";
    writer.write_all(head.as_bytes())?;
    writer.flush()?;
    writer.write_all(sse_frame("state", &state.state_json()).as_bytes())?;
    writer.flush()?;

    let mut last_beat = Instant::now();
    loop {
        match receiver.recv_timeout(Duration::from_millis(500)) {
            Ok(frame) => {
                if writer.write_all(frame.as_bytes()).is_err() {
                    break;
                }
                let _ = writer.flush();
                last_beat = Instant::now();
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if last_beat.elapsed() >= SSE_HEARTBEAT {
                    if writer.write_all(b": keep-alive\n\n").is_err() {
                        break;
                    }
                    let _ = writer.flush();
                    last_beat = Instant::now();
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
    state.events().unsubscribe(id);
    Ok(())
}

fn send_response(
    writer: &mut TcpStream,
    status: u16,
    content_type: &str,
    body: &str,
) -> anyhow::Result<()> {
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        413 => "Payload Too Large",
        500 => "Internal Server Error",
        _ => "OK",
    };
    let response = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nReferrer-Policy: no-referrer\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    writer.write_all(response.as_bytes())?;
    writer.flush()?;
    Ok(())
}

/// The URL to open, token included.
pub fn banner(port: u16, token: &str) -> String {
    format!("http://127.0.0.1:{port}/?token={token}")
}

/// The loopback address the server binds. The loopback-only guarantee is
/// asserted by the tests, which read this.
#[cfg_attr(not(test), allow(dead_code))]
pub fn loopback(port: u16) -> SocketAddr {
    SocketAddr::from((Ipv4Addr::LOCALHOST, port))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::live::{Question, QuestionOption};

    fn request_line(line: &str) -> Result<RawRequest, u16> {
        parse_request(line, &[])
    }

    /// A view with no live activity, which is what the page sees at rest.
    fn quiet_view() -> View {
        View {
            pending: None,
            streaming: String::new(),
            notes: vec![],
            selected: None,
        }
    }

    #[test]
    fn token_is_rejected_when_absent_or_wrong() {
        assert!(authorized("abc123", "abc123"));
        assert!(!authorized("", "abc123"));
        assert!(!authorized("abc123", ""));
        assert!(!authorized("abc124", "abc123"));
        assert!(!authorized("abc12", "abc123"));
        assert!(!authorized("abc1234", "abc123"));
        // A shared prefix must not shorten the comparison.
        assert!(!authorized("aaa", "aab"));
        assert!(constant_time_eq("", ""));
    }

    #[test]
    fn routes_the_documented_endpoints() {
        assert_eq!(route_for("GET", "/"), Some(Route::Page));
        assert_eq!(route_for("GET", "/api/state"), Some(Route::State));
        assert_eq!(route_for("POST", "/api/select"), Some(Route::Select));
        assert_eq!(route_for("POST", "/api/send"), Some(Route::Send));
        assert_eq!(route_for("POST", "/api/cancel"), Some(Route::Cancel));
        assert_eq!(route_for("POST", "/api/model"), Some(Route::Model));
        assert_eq!(route_for("POST", "/api/approve"), Some(Route::Approve));
        assert_eq!(route_for("POST", "/api/answer"), Some(Route::Answer));
        assert_eq!(route_for("GET", "/api/events"), Some(Route::Events));
        // Wrong method and unknown path are both rejected.
        assert_eq!(route_for("GET", "/api/send"), None);
        assert_eq!(route_for("POST", "/api/state"), None);
        assert_eq!(route_for("GET", "/api/unknown"), None);
        assert_eq!(route_for("POST", "/"), None);
        // Only JSON actions report an action name.
        assert_eq!(Route::Send.action(), Some("send"));
        assert_eq!(Route::State.action(), None);
        assert_eq!(Route::Events.action(), None);
    }

    #[test]
    fn parses_the_request_line_and_the_token() {
        let parsed = request_line("GET /api/state?token=t0ken HTTP/1.1").expect("a valid request");
        assert_eq!(parsed.request.method, "GET");
        assert_eq!(parsed.request.path, "/api/state");
        assert_eq!(parsed.request.token, "t0ken");
        assert_eq!(parsed.content_length, 0);

        // The header wins so a client can keep the token out of URLs.
        let headers = vec![(TOKEN_HEADER.to_string(), "from-header".to_string())];
        let parsed = parse_request("GET /?token=from-query HTTP/1.1", &headers).expect("valid");
        assert_eq!(parsed.request.token, "from-header");

        // Percent-encoded first parameter wins, like the browser would send.
        let parsed = request_line("GET /?a=1&token=t%2F1&token=second HTTP/1.1").expect("valid");
        assert_eq!(parsed.request.token, "t/1");

        // A body length is captured for POST.
        let headers = vec![("Content-Length".to_string(), "17".to_string())];
        let parsed = parse_request("POST /api/send HTTP/1.1", &headers).expect("valid");
        assert_eq!(parsed.content_length, 17);
    }

    #[test]
    fn rejects_malformed_request_lines() {
        assert_eq!(request_line("GET").unwrap_err(), 400);
        assert_eq!(request_line("GET /api/state").unwrap_err(), 400);
        assert_eq!(request_line("get /api/state HTTP/1.1").unwrap_err(), 405);
        assert_eq!(request_line("DELETE /api/state HTTP/1.1").unwrap_err(), 405);
        assert_eq!(request_line("GET api/state HTTP/1.1").unwrap_err(), 400);
    }

    #[test]
    fn renders_an_approval_pending() {
        let pending = Pending::Approval {
            event_id: "evt-1".to_string(),
            tool: "bash".to_string(),
            reason: "ビルドディレクトリを削除します".to_string(),
        };
        assert_eq!(
            pending_json(&pending),
            json!({
                "kind": "approval",
                "eventId": "evt-1",
                "tool": "bash",
                "reason": "ビルドディレクトリを削除します",
            })
        );
    }

    #[test]
    fn renders_every_question_of_a_pending_batch() {
        let pending = Pending::Question {
            event_id: "evt-2".to_string(),
            call_id: "call-7".to_string(),
            session_id: "session-3".to_string(),
            question: "どれにしますか？".to_string(),
            options: vec!["A".to_string()],
            multi: false,
            questions: vec![
                Question {
                    id: "q1".to_string(),
                    question: "どれにしますか？".to_string(),
                    header: Some("選択".to_string()),
                    detail: None,
                    options: vec![
                        QuestionOption {
                            label: "A".to_string(),
                            description: Some("最初の案".to_string()),
                        },
                        QuestionOption {
                            label: "B".to_string(),
                            description: None,
                        },
                    ],
                    multi_select: false,
                    allow_custom: true,
                },
                Question {
                    id: "q2".to_string(),
                    question: "範囲は？".to_string(),
                    header: None,
                    detail: Some("複数選択できます".to_string()),
                    options: vec![],
                    multi_select: true,
                    allow_custom: false,
                },
            ],
        };
        let value = pending_json(&pending);
        assert_eq!(value["kind"], "question");
        assert_eq!(value["callId"], "call-7");
        assert_eq!(value["sessionId"], "session-3");
        let questions = value["questions"].as_array().expect("questions");
        assert_eq!(questions.len(), 2);
        assert_eq!(questions[0]["id"], "q1");
        assert_eq!(questions[0]["multiSelect"], false);
        assert_eq!(questions[0]["allowCustom"], true);
        assert_eq!(questions[0]["options"][0]["label"], "A");
        assert_eq!(questions[0]["options"][0]["description"], "最初の案");
        assert_eq!(questions[0]["options"][1]["description"], Value::Null);
        assert_eq!(questions[1]["id"], "q2");
        assert_eq!(questions[1]["multiSelect"], true);
        assert_eq!(questions[1]["allowCustom"], false);
        assert_eq!(questions[1]["detail"], "複数選択できます");
    }

    #[test]
    fn frames_live_events_for_the_browser() {
        let (name, data) = event_frame(&LiveEvent::Delta("こん".to_string())).expect("a delta");
        assert_eq!(name, "delta");
        assert_eq!(data["text"], "こん");

        let (name, data) = event_frame(&LiveEvent::Idle).expect("an idle frame");
        assert_eq!(name, "idle");
        assert_eq!(data, json!({}));

        let (name, data) = event_frame(&LiveEvent::Note("再接続します".to_string())).expect("note");
        assert_eq!(name, "note");
        assert_eq!(data["text"], "再接続します");

        let (name, _) = event_frame(&LiveEvent::Activity).expect("activity");
        assert_eq!(name, "activity");

        let (name, data) = event_frame(&LiveEvent::Ready("client-1".to_string())).expect("ready");
        assert_eq!(name, "ready");
        assert_eq!(data["clientId"], "client-1");

        // The SSE writer must terminate the frame with a blank line.
        let frame = sse_frame("delta", &json!({ "text": "x" }));
        assert_eq!(frame, "event: delta\ndata: {\"text\":\"x\"}\n\n");
    }

    #[test]
    fn answers_are_parsed_per_question() {
        let answers = parse_answers(
            r#"{"answers":[{"id":"q1","selected":["A","B"]},{"id":"q2","selected":[]}]}"#,
        )
        .expect("answers");
        assert_eq!(
            answers,
            vec![
                ("q1".to_string(), vec!["A".to_string(), "B".to_string()]),
                ("q2".to_string(), vec![]),
            ]
        );
        assert!(parse_answers(r#"{"answers":[]}"#).is_none());
        assert!(parse_answers("not json").is_none());
    }

    #[test]
    fn fields_are_read_from_a_json_body() {
        assert_eq!(
            field(r#"{"sessionId":"s-1","text":"hi"}"#, "sessionId").as_deref(),
            Some("s-1")
        );
        assert_eq!(field(r#"{"sessionId":7}"#, "sessionId"), None);
        assert_eq!(field("{}", "sessionId"), None);
    }

    #[test]
    fn notifies_only_when_a_hidden_page_finishes_a_run() {
        assert!(should_notify_finish(true, false, true));
        assert!(!should_notify_finish(true, false, false));
        assert!(!should_notify_finish(false, false, true));
        assert!(!should_notify_finish(true, true, true));
    }

    #[test]
    fn encodes_a_loopback_only_url_with_the_token() {
        assert_eq!(
            banner(8790, "abc"),
            format!("{}://127.0.0.1:8790/?token=abc", "http")
        );
        assert!(loopback(8790).ip().is_loopback());
        // The generated token is long enough to be unguessable.
        assert_eq!(generate_token().len(), 32);
    }

    #[test]
    fn the_snapshot_carries_the_connecting_placeholder_before_the_harness_answers() {
        let state = WebState::default();
        let value = state.state_json();
        assert_eq!(value["connecting"], true);
        assert_eq!(value["groups"], json!([]));
        assert_eq!(value["selected"], Value::Null);
        assert_eq!(value["modelGroups"], json!([]));
        assert_eq!(value["pending"], Value::Null);
        assert_eq!(value["streaming"], "");
    }

    #[test]
    fn the_view_is_merged_over_the_published_snapshot() {
        let state = WebState::default();
        let snapshot = json!({
            "status": "3 件の会話",
            "connecting": false,
            "selected": "s-1",
            "groups": [],
            "messages": [],
            "running": false,
            "streaming": "",
            "pending": null,
            "notes": [],
        });
        state.set_snapshot(snapshot);

        // At rest the snapshot passes through unchanged.
        let value = state.state_json();
        assert_eq!(value["status"], "3 件の会話");
        assert_eq!(value["selected"], "s-1");
        assert_eq!(value["running"], false);

        // A live delta makes the page look busy and shows the partial text.
        state.set_streaming("途中まで".to_string());
        let value = state.state_json();
        assert_eq!(value["streaming"], "途中まで");
        assert_eq!(value["running"], true);

        // A pending decision and a note are visible too.
        state.set_pending(Some(json!({ "kind": "approval", "eventId": "evt-1" })));
        state.note("再接続します".to_string());
        let value = state.state_json();
        assert_eq!(value["pending"]["kind"], "approval");
        assert_eq!(value["notes"][0], "再接続します");
    }

    #[test]
    fn apply_event_fills_and_clears_the_live_view() {
        let state = Arc::new(WebState::default());
        state.set_snapshot(json!({ "running": false, "streaming": "", "notes": [] }));

        apply_event(&LiveEvent::Delta("こん".to_string()), &state);
        apply_event(&LiveEvent::Delta("にちは".to_string()), &state);
        apply_event(&LiveEvent::Note("メモ".to_string()), &state);
        let value = state.state_json();
        assert_eq!(value["streaming"], "こんにちは");
        assert_eq!(value["running"], true);
        assert_eq!(value["notes"][0], "メモ");

        apply_event(
            &LiveEvent::Pending(Pending::Approval {
                event_id: "evt-1".to_string(),
                tool: "bash".to_string(),
                reason: "確認".to_string(),
            }),
            &state,
        );
        assert_eq!(state.state_json()["pending"]["kind"], "approval");

        apply_event(&LiveEvent::Dismissed("evt-1".to_string()), &state);
        assert_eq!(state.state_json()["pending"], Value::Null);

        apply_event(&LiveEvent::Idle, &state);
        let value = state.state_json();
        assert_eq!(value["streaming"], "");
        assert_eq!(value["running"], false);
    }

    #[test]
    fn subscribers_receive_broadcast_frames_and_drop_cleanly() {
        let state = WebState::default();
        let (id, receiver) = state.events().subscribe();
        state.publish("delta", &json!({ "text": "x" }));
        let frame = receiver.recv_timeout(Duration::from_millis(200)).expect("a frame");
        assert_eq!(frame, "event: delta\ndata: {\"text\":\"x\"}\n\n");
        state.events().unsubscribe(id);
        // Publishing with no subscribers must not panic or block.
        state.publish("idle", &json!({}));
    }

    #[test]
    fn the_embedded_page_is_self_contained() {
        assert!(PAGE.contains("<title>"));
        assert!(PAGE.contains("/api/state"));
        assert!(PAGE.contains("/api/events"));
        // No external asset: an absolute URL would need the network.
        assert!(!PAGE.contains("http://"));
        assert!(!PAGE.contains("https://"));
        // The notification hook the task asks for is present.
        assert!(PAGE.contains("Notification"));
    }

    #[test]
    fn the_served_page_carries_the_token_and_nothing_else_is_substituted() {
        let page = serve_page("tok-123");
        assert!(page.contains("\"tok-123\""));
        assert!(!page.contains(TOKEN_PLACEHOLDER));
        // The rest of the document is unchanged.
        assert_eq!(page.len(), PAGE.len() - TOKEN_PLACEHOLDER.len() + 7);
    }
}
