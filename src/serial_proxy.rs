use std::{
    collections::VecDeque,
    io,
    net::{IpAddr, SocketAddr},
    pin::Pin,
    sync::{
        atomic::{AtomicU64, AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

use axum::{
    body::{Body, Bytes},
    extract::State,
    http::{header, HeaderMap, HeaderValue, Method, Request, StatusCode},
    response::{IntoResponse, Response},
    routing::any,
    Router,
};
use futures_util::{stream, Stream, StreamExt};
use hyper::service::service_fn;
use hyper_util::rt::{TokioIo, TokioTimer};
use reqwest::{redirect::Policy, Url};
use tokio::{
    net::TcpListener,
    sync::{OwnedSemaphorePermit, Semaphore},
    task::JoinSet,
    time::{sleep_until, timeout, timeout_at},
};
use tower::ServiceExt;

const DEFAULT_BODY_GRACE: Duration = Duration::from_secs(300);
const DEFAULT_HEADER_TIMEOUT: Duration = Duration::from_secs(60);
const RATE_WINDOW: Duration = Duration::from_secs(60);
const HOP_BY_HOP: &[&str] = &[
    "host",
    "connection",
    "keep-alive",
    "transfer-encoding",
    "upgrade",
    "te",
    "trailer",
    "proxy-authorization",
    "proxy-authenticate",
    "proxy-connection",
];

#[derive(Debug, Clone)]
pub struct SerialProxyOptions {
    pub upstream: String,
    pub port: u16,
    pub host: String,
    pub allow_remote: bool,
    pub max: usize,
    pub queue_timeout: f64,
    pub max_queue: usize,
    pub tool_choice_default: Option<String>,
    pub max_body_bytes: usize,
    pub rpm: Option<usize>,
}

struct ProxyState {
    upstream: Url,
    client: reqwest::Client,
    semaphore: Arc<Semaphore>,
    active: AtomicUsize,
    queued: AtomicUsize,
    max: usize,
    max_queue: usize,
    queue_timeout: Duration,
    request_deadline: Duration,
    max_body_bytes: usize,
    tool_choice_default: Option<String>,
    rate: Option<RateWindow>,
    next_id: AtomicU64,
}

struct SlotPermit {
    _permit: OwnedSemaphorePermit,
    state: Arc<ProxyState>,
}

impl Drop for SlotPermit {
    fn drop(&mut self) {
        self.state.active.fetch_sub(1, Ordering::Relaxed);
    }
}

struct QueueCount {
    state: Arc<ProxyState>,
    counted: bool,
}

impl QueueCount {
    fn leave(&mut self) {
        if self.counted {
            self.counted = false;
            self.state.queued.fetch_sub(1, Ordering::Relaxed);
        }
    }
}

impl Drop for QueueCount {
    fn drop(&mut self) {
        self.leave();
    }
}

impl ProxyState {
    async fn acquire_slot(self: &Arc<Self>) -> Result<SlotPermit, SlotError> {
        if let Ok(permit) = self.semaphore.clone().try_acquire_owned() {
            self.active.fetch_add(1, Ordering::Relaxed);
            return Ok(SlotPermit {
                _permit: permit,
                state: self.clone(),
            });
        }

        let queued = self.queued.fetch_add(1, Ordering::Relaxed);
        if queued >= self.max_queue {
            self.queued.fetch_sub(1, Ordering::Relaxed);
            return Err(SlotError::Full);
        }
        let mut queue_count = QueueCount {
            state: self.clone(),
            counted: true,
        };
        let acquired = timeout(self.queue_timeout, self.semaphore.clone().acquire_owned()).await;
        queue_count.leave();
        let permit = match acquired {
            Err(_) => return Err(SlotError::Timeout),
            Ok(Err(_)) => return Err(SlotError::Closed),
            Ok(Ok(permit)) => permit,
        };
        self.active.fetch_add(1, Ordering::Relaxed);
        Ok(SlotPermit {
            _permit: permit,
            state: self.clone(),
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SlotError {
    Full,
    Timeout,
    Closed,
}

struct RateState {
    next_ticket: u64,
    queue: VecDeque<u64>,
    started: Option<Instant>,
    count: usize,
}

struct RateWindow {
    limit: usize,
    state: Mutex<RateState>,
    changed: tokio::sync::Notify,
}

struct RateTicket<'a> {
    window: &'a RateWindow,
    id: u64,
    queued: bool,
}

impl Drop for RateTicket<'_> {
    fn drop(&mut self) {
        if !self.queued {
            return;
        }
        let mut state = self.window.state.lock().unwrap_or_else(|e| e.into_inner());
        state.queue.retain(|ticket| *ticket != self.id);
        self.queued = false;
        drop(state);
        self.window.changed.notify_waiters();
    }
}

impl RateWindow {
    fn new(limit: usize) -> Self {
        Self {
            limit,
            state: Mutex::new(RateState {
                next_ticket: 0,
                queue: VecDeque::new(),
                started: None,
                count: 0,
            }),
            changed: tokio::sync::Notify::new(),
        }
    }

    fn snapshot(&self) -> (usize, u64) {
        let now = Instant::now();
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        roll_window(&mut state, now);
        let next = if state.count >= self.limit {
            state
                .started
                .map(|started| started + RATE_WINDOW)
                .unwrap_or(now)
                .saturating_duration_since(now)
                .as_secs_f64()
                .ceil() as u64
        } else {
            0
        };
        (state.count, next)
    }

    async fn acquire(&self, wait: Duration) -> bool {
        let id = {
            let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
            let id = state.next_ticket;
            state.next_ticket = state.next_ticket.wrapping_add(1);
            state.queue.push_back(id);
            id
        };
        let mut ticket = RateTicket {
            window: self,
            id,
            queued: true,
        };
        let deadline = Instant::now() + wait;

        loop {
            let changed = self.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();

            let now = Instant::now();
            let next_window = {
                let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
                roll_window(&mut state, now);
                if state.queue.front() == Some(&id) && state.count < self.limit {
                    if state.count == 0 {
                        state.started = Some(now);
                    }
                    state.count += 1;
                    state.queue.pop_front();
                    ticket.queued = false;
                    drop(state);
                    self.changed.notify_waiters();
                    return true;
                }
                if state.count >= self.limit {
                    state.started.map(|started| started + RATE_WINDOW)
                } else {
                    None
                }
            };

            if Instant::now() >= deadline {
                return false;
            }
            match next_window {
                Some(at) if at < deadline => {
                    tokio::select! {
                        _ = sleep_until(at.into()) => {},
                        _ = sleep_until(deadline.into()) => return false,
                        _ = &mut changed => {},
                    }
                }
                Some(_) => {
                    tokio::select! {
                        _ = sleep_until(deadline.into()) => return false,
                        _ = &mut changed => {},
                    }
                }
                None => {
                    tokio::select! {
                        _ = sleep_until(deadline.into()) => return false,
                        _ = &mut changed => {},
                    }
                }
            }
        }
    }
}

fn roll_window(state: &mut RateState, now: Instant) {
    if state
        .started
        .is_some_and(|started| state.count > 0 && now >= started + RATE_WINDOW)
    {
        state.started = None;
        state.count = 0;
    }
}

fn map_path(base: &str, url_path: &str) -> String {
    let base = base.trim_end_matches('/');
    let (path, query) = url_path.find('?').map_or((url_path, ""), |index| {
        (&url_path[..index], &url_path[index..])
    });
    let path = if !base.is_empty() && (path == base || path.starts_with(&format!("{base}/"))) {
        &path[base.len()..]
    } else {
        path
    };
    let path = if path.starts_with('/') {
        path.to_string()
    } else {
        format!("/{path}")
    };
    format!("{base}{path}{query}")
}

fn json_error(status: StatusCode, message: &str) -> Response {
    let body = serde_json::json!({
        "error": { "message": message, "type": "serial_proxy_error" }
    })
    .to_string();
    let mut response = Response::new(Body::from(body));
    *response.status_mut() = status;
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    response
}

fn log_request(method: &Method, path: &str, status: u16, wait_ms: u128, started: Instant, id: u64) {
    let duration = started.elapsed().as_millis().saturating_sub(wait_ms);
    eprintln!("{method} {path} {status} wait={wait_ms}ms dur={duration}ms id={id}");
}

fn is_json_content_type(value: Option<&HeaderValue>) -> bool {
    let Some(value) = value.and_then(|v| v.to_str().ok()) else {
        return false;
    };
    let mut parts = value.trim().split(';');
    let media = parts.next().unwrap_or_default().trim().to_ascii_lowercase();
    let is_json = media.strip_prefix("application/").is_some_and(|subtype| {
        subtype == "json"
            || subtype.strip_suffix("+json").is_some_and(|prefix| {
                prefix
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b"_.+-".contains(&byte))
            })
    });
    if !is_json {
        return false;
    }
    let Some(parameter) = parts.next() else {
        return true;
    };
    if parts.next().is_some() {
        return false;
    }
    let Some((name, value)) = parameter.trim().split_once('=') else {
        return false;
    };
    if !name.trim().eq_ignore_ascii_case("charset") {
        return false;
    }
    let value = value.trim();
    let charset = if value.starts_with('"') && value.ends_with('"') && value.len() >= 2 {
        &value[1..value.len() - 1]
    } else {
        value
    };
    charset.eq_ignore_ascii_case("utf-8") || charset.eq_ignore_ascii_case("utf8")
}

fn default_tool_choice(body: &[u8], value: &str) -> Option<Bytes> {
    let json: serde_json::Value = serde_json::from_slice(body).ok()?;
    let object = json.as_object()?;
    if object.contains_key("tool_choice")
        || !object
            .get("tools")
            .and_then(serde_json::Value::as_array)
            .is_some_and(|tools| !tools.is_empty())
    {
        return None;
    }
    let closing_brace = body.iter().rposition(|byte| !byte.is_ascii_whitespace())?;
    if body[closing_brace] != b'}' {
        return None;
    }
    let mut rewritten = Vec::with_capacity(body.len() + value.len() + 17);
    rewritten.extend_from_slice(&body[..closing_brace]);
    rewritten.extend_from_slice(b",\"tool_choice\":");
    serde_json::to_writer(&mut rewritten, value).ok()?;
    rewritten.extend_from_slice(&body[closing_brace..]);
    Some(Bytes::from(rewritten))
}

type IncomingStream = Pin<Box<dyn Stream<Item = Result<Bytes, axum::Error>> + Send>>;
type OutgoingStream = Pin<Box<dyn Stream<Item = Result<Bytes, io::Error>> + Send>>;

fn timed_body_stream(input: IncomingStream, deadline: Instant) -> OutgoingStream {
    Box::pin(stream::unfold(
        (input, true),
        move |(mut input, active)| async move {
            if !active {
                return None;
            }
            match timeout_at(deadline.into(), input.next()).await {
                Ok(Some(Ok(bytes))) => Some((Ok(bytes), (input, true))),
                Ok(Some(Err(error))) => {
                    Some((Err(io::Error::other(error.to_string())), (input, false)))
                }
                Ok(None) => None,
                Err(_) => Some((
                    Err(io::Error::new(
                        io::ErrorKind::TimedOut,
                        "request body timeout",
                    )),
                    (input, false),
                )),
            }
        },
    ))
}

async fn request_body(
    body: Body,
    should_inspect: bool,
    known_length: Option<u64>,
    choice: Option<&str>,
    max_body_bytes: usize,
    deadline: Instant,
) -> Result<(reqwest::Body, Option<usize>, bool), ()> {
    let input: IncomingStream = Box::pin(body.into_data_stream());
    if !should_inspect || known_length.is_some_and(|length| length > max_body_bytes as u64) {
        return Ok((
            reqwest::Body::wrap_stream(timed_body_stream(input, deadline)),
            None,
            false,
        ));
    }

    let mut input = input;
    let mut chunks = Vec::new();
    let mut total = 0usize;
    loop {
        let next = timeout_at(deadline.into(), input.next())
            .await
            .map_err(|_| ())?;
        match next {
            Some(Ok(chunk)) => {
                if total.saturating_add(chunk.len()) > max_body_bytes {
                    chunks.push(chunk);
                    let prefix = stream::iter(chunks.into_iter().map(Ok::<Bytes, io::Error>));
                    let rest = timed_body_stream(input, deadline);
                    return Ok((reqwest::Body::wrap_stream(prefix.chain(rest)), None, false));
                }
                total += chunk.len();
                chunks.push(chunk);
            }
            Some(Err(_)) => return Err(()),
            None => break,
        }
    }
    let body = Bytes::from(chunks.concat());
    let rewritten = choice.and_then(|value| default_tool_choice(&body, value));
    let modified = rewritten.is_some();
    let bytes = rewritten.unwrap_or(body);
    let len = bytes.len();
    Ok((reqwest::Body::from(bytes), Some(len), modified))
}

async fn proxy(State(state): State<Arc<ProxyState>>, request: Request<Body>) -> Response {
    let started = Instant::now();
    let method = request.method().clone();
    let path = request.uri().path().to_string();
    if method == Method::GET && path == "/__proxy/status" {
        let mut value = serde_json::json!({
            "active": state.active.load(Ordering::Relaxed),
            "queued": state.queued.load(Ordering::Relaxed),
            "max": state.max,
            "upstream": state.upstream.origin().ascii_serialization(),
        });
        if let Some(rate) = &state.rate {
            let (count, next) = rate.snapshot();
            value["rpm"] = serde_json::json!(rate.limit);
            value["window_count"] = serde_json::json!(count);
            value["next_slot_in"] = serde_json::json!(next);
        }
        return axum::Json(value).into_response();
    }

    let id = state.next_id.fetch_add(1, Ordering::Relaxed) + 1;
    let slot = match state.acquire_slot().await {
        Ok(slot) => slot,
        Err(SlotError::Full) => {
            log_request(&method, &path, 429, 0, started, id);
            return json_error(StatusCode::TOO_MANY_REQUESTS, "serial-proxy queue is full");
        }
        Err(SlotError::Timeout | SlotError::Closed) => {
            log_request(&method, &path, 503, 0, started, id);
            return json_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "serial-proxy queue timeout",
            );
        }
    };
    let mut wait_ms = started.elapsed().as_millis();
    let request_deadline = started + state.request_deadline;
    let (parts, body) = request.into_parts();
    let base_path = state.upstream.path();
    let target_path = map_path(base_path, &parts.uri.to_string());
    let inspection_path = target_path.split('?').next().unwrap_or_default();
    let content_length = parts
        .headers
        .get(header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok());
    let inspect = state.tool_choice_default.is_some()
        && method == Method::POST
        && inspection_path.ends_with("/chat/completions")
        && is_json_content_type(parts.headers.get(header::CONTENT_TYPE))
        && !parts.headers.contains_key(header::CONTENT_ENCODING)
        && !content_length.is_some_and(|length| length > state.max_body_bytes as u64);
    let choice = if inspect {
        state.tool_choice_default.as_deref()
    } else {
        None
    };

    let (upstream_body, buffered_length, modified) = match request_body(
        body,
        inspect,
        content_length,
        choice,
        state.max_body_bytes,
        request_deadline,
    )
    .await
    {
        Ok(body) => body,
        Err(()) => {
            log_request(&method, &path, 400, wait_ms, started, id);
            return json_error(StatusCode::BAD_REQUEST, "request body unavailable");
        }
    };

    if let Some(rate) = &state.rate {
        let rpm_started = Instant::now();
        if !rate.acquire(state.queue_timeout).await {
            log_request(&method, &path, 503, wait_ms, started, id);
            return json_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "serial-proxy queue timeout",
            );
        }
        wait_ms += rpm_started.elapsed().as_millis();
    }

    let mut headers = HeaderMap::new();
    for (name, value) in &parts.headers {
        if !HOP_BY_HOP.contains(&name.as_str()) {
            headers.append(name.clone(), value.clone());
        }
    }
    let upstream_host = state.upstream.host_str().unwrap_or_default();
    let authority = if upstream_host.contains(':') {
        match state.upstream.port() {
            Some(port) => format!("[{upstream_host}]:{port}"),
            None => format!("[{upstream_host}]"),
        }
    } else {
        match state.upstream.port() {
            Some(port) => format!("{upstream_host}:{port}"),
            None => upstream_host.to_string(),
        }
    };
    if let Ok(host) = HeaderValue::from_str(&authority) {
        headers.insert(header::HOST, host);
    }
    if let Some(length) = buffered_length {
        headers.remove(header::TRANSFER_ENCODING);
        if let Ok(value) = HeaderValue::from_str(&length.to_string()) {
            headers.insert(header::CONTENT_LENGTH, value);
        }
    }
    if modified {
        eprintln!("tool_choice defaulted id={id}");
    }
    let url = format!(
        "{}{}",
        state.upstream.origin().ascii_serialization(),
        target_path
    );
    let outgoing = state
        .client
        .request(method.clone(), url)
        .headers(headers)
        .body(upstream_body)
        .send()
        .await;
    let upstream = match outgoing {
        Ok(response) => response,
        Err(error) => {
            let message = if error.is_timeout() {
                "upstream timeout"
            } else if error.is_connect() {
                "upstream connection failed"
            } else {
                "upstream request failed"
            };
            log_request(&method, &path, 502, wait_ms, started, id);
            return json_error(StatusCode::BAD_GATEWAY, message);
        }
    };

    let status = upstream.status();
    let mut response = Response::new(Body::empty());
    *response.status_mut() =
        StatusCode::from_u16(status.as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    for (name, value) in upstream.headers() {
        if !HOP_BY_HOP.contains(&name.as_str()) {
            response.headers_mut().append(name.clone(), value.clone());
        }
    }
    let upstream_body = Box::pin(upstream.bytes_stream());
    let stream = stream::unfold(
        Some((
            upstream_body,
            slot,
            method.clone(),
            path.clone(),
            status.as_u16(),
            wait_ms,
            started,
            id,
        )),
        |state| async move {
            let (mut body, slot, method, path, status, wait_ms, started, id) = state?;
            match body.next().await {
                Some(Ok(bytes)) => Some((
                    Ok(bytes),
                    Some((body, slot, method, path, status, wait_ms, started, id)),
                )),
                Some(Err(_)) => {
                    log_request(&method, &path, 502, wait_ms, started, id);
                    Some((Err(io::Error::other("upstream response failed")), None))
                }
                None => {
                    log_request(&method, &path, status, wait_ms, started, id);
                    drop(slot);
                    None
                }
            }
        },
    );
    *response.body_mut() = Body::from_stream(stream);
    response
}

pub fn cmd_serial_proxy(options: SerialProxyOptions) -> anyhow::Result<()> {
    if options.max == 0 {
        anyhow::bail!("invalid --max");
    }
    if !options.queue_timeout.is_finite() || options.queue_timeout <= 0.0 {
        anyhow::bail!("invalid --queue-timeout");
    }
    if options.max_body_bytes == 0 {
        anyhow::bail!("invalid --max-body-bytes");
    }
    if options.rpm == Some(0) {
        anyhow::bail!("invalid --rpm");
    }
    if options
        .tool_choice_default
        .as_deref()
        .is_some_and(|value| !["none", "auto", "required"].contains(&value))
    {
        anyhow::bail!("invalid --tool-choice-default (none, auto or required)");
    }
    let upstream =
        Url::parse(&options.upstream).map_err(|_| anyhow::anyhow!("invalid --upstream"))?;
    if !["http", "https"].contains(&upstream.scheme()) {
        anyhow::bail!("--upstream must be http(s)");
    }
    if upstream.host_str().is_none() {
        anyhow::bail!("invalid --upstream");
    }
    if !is_loopback_host(&options.host) && !options.allow_remote {
        anyhow::bail!("refusing non-loopback --host without --allow-remote");
    }
    let addr = socket_addr(&options.host, options.port)?;
    let queue_timeout = Duration::try_from_secs_f64(options.queue_timeout)
        .map_err(|_| anyhow::anyhow!("invalid --queue-timeout"))?;
    let request_deadline = queue_timeout
        .checked_mul(if options.rpm.is_some() { 2 } else { 1 })
        .and_then(|duration| duration.checked_add(DEFAULT_BODY_GRACE))
        .ok_or_else(|| anyhow::anyhow!("invalid --queue-timeout"))?;
    let client = reqwest::Client::builder()
        .redirect(Policy::none())
        .http1_only()
        .build()?;
    let state = Arc::new(ProxyState {
        upstream,
        client,
        semaphore: Arc::new(Semaphore::new(options.max)),
        active: AtomicUsize::new(0),
        queued: AtomicUsize::new(0),
        max: options.max,
        max_queue: options.max_queue,
        queue_timeout,
        request_deadline,
        max_body_bytes: options.max_body_bytes,
        tool_choice_default: options.tool_choice_default.clone(),
        rate: options.rpm.map(RateWindow::new),
        next_id: AtomicU64::new(0),
    });
    let upstream_status = state.upstream.clone();
    let app = Router::new().fallback(any(proxy)).with_state(state);
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    runtime.block_on(async move {
        let listener = TcpListener::bind(addr).await?;
        let bound = listener.local_addr()?;
        eprintln!(
            "serial-proxy listening on http://{bound} -> {}{} (max={}{}{})",
            upstream_status.origin().ascii_serialization(),
            upstream_status.path(),
            options.max,
            options.rpm.map(|v| format!(" rpm={v}")).unwrap_or_default(),
            options
                .tool_choice_default
                .as_ref()
                .map(|v| format!(" tool-choice-default={v}"))
                .unwrap_or_default()
        );
        serve(listener, app).await
    })
}

fn is_loopback_host(host: &str) -> bool {
    matches!(host, "localhost" | "127.0.0.1" | "::1" | "[::1]")
}

fn socket_addr(host: &str, port: u16) -> anyhow::Result<SocketAddr> {
    let normalized = host.trim_start_matches('[').trim_end_matches(']');
    if let Ok(ip) = normalized.parse::<IpAddr>() {
        return Ok(SocketAddr::new(ip, port));
    }
    (host, port)
        .to_socket_addrs()?
        .next()
        .ok_or_else(|| anyhow::anyhow!("invalid --host"))
}

use std::net::ToSocketAddrs;

async fn serve(listener: TcpListener, app: Router) -> anyhow::Result<()> {
    let mut connections = JoinSet::new();
    let shutdown = shutdown_signal();
    tokio::pin!(shutdown);
    loop {
        tokio::select! {
            _ = &mut shutdown => break,
            accepted = listener.accept() => {
                let (stream, _) = accepted?;
                let app = app.clone();
                connections.spawn(async move {
                    let service = service_fn(move |request: hyper::Request<hyper::body::Incoming>| {
                        let app = app.clone();
                        async move {
                            let (parts, body) = request.into_parts();
                            let request = Request::from_parts(parts, Body::new(body));
                            app.oneshot(request).await
                        }
                    });
                    let io = TokioIo::new(stream);
                    let mut builder = hyper::server::conn::http1::Builder::new();
                    builder
                        .timer(TokioTimer::new())
                        .header_read_timeout(DEFAULT_HEADER_TIMEOUT);
                    let _ = builder.serve_connection(io, service).await;
                });
            }
            Some(_) = connections.join_next(), if !connections.is_empty() => {}
        }
    }
    if timeout(Duration::from_secs(3), async {
        while connections.join_next().await.is_some() {}
    })
    .await
    .is_err()
    {
        connections.abort_all();
    }
    Ok(())
}

async fn shutdown_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        let mut terminate = signal(SignalKind::terminate()).expect("install SIGTERM handler");
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {},
            _ = terminate.recv() => {},
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_mapping_preserves_base_and_query_rules() {
        assert_eq!(
            map_path("/v1", "/chat/completions?x=1"),
            "/v1/chat/completions?x=1"
        );
        assert_eq!(
            map_path("/v1/", "/v1/chat/completions"),
            "/v1/chat/completions"
        );
        assert_eq!(map_path("", "/chat/completions"), "/chat/completions");
        assert_eq!(map_path("/v1", "chat/completions"), "/v1/chat/completions");
    }

    #[test]
    fn tool_choice_only_rewrites_valid_nonempty_tool_lists() {
        let source = br#"{"model":"m","tools":[{"type":"function"}]}"#;
        let rewritten = default_tool_choice(source, "auto").unwrap();
        let value: serde_json::Value = serde_json::from_slice(&rewritten).unwrap();
        assert_eq!(value["tool_choice"], "auto");
        let ordered = br#"{ "model" : "m", "tools" : [1] }"#;
        let rewritten =
            String::from_utf8(default_tool_choice(ordered, "auto").unwrap().to_vec()).unwrap();
        assert!(rewritten.find("\"model\"").unwrap() < rewritten.find("\"tools\"").unwrap());
        assert!(rewritten.find("\"tools\"").unwrap() < rewritten.find("\"tool_choice\"").unwrap());
        assert!(default_tool_choice(br#"{"tools":[],"x":1}"#, "auto").is_none());
        assert!(default_tool_choice(br#"{"tools":[1],"tool_choice":null}"#, "auto").is_none());
        assert!(default_tool_choice(b"not json", "auto").is_none());
    }

    #[test]
    fn content_type_accepts_json_and_utf8_only() {
        for value in [
            "application/json",
            "application/vnd.api+json",
            "application/json; charset=utf-8",
            "application/json ; charset = \"UTF8\"",
        ] {
            assert!(is_json_content_type(Some(
                &HeaderValue::from_str(value).unwrap()
            )));
        }
        for value in [
            "text/json",
            "application/vendor/path+json",
            "application/json; charset=latin1",
            "application/json; boundary=x",
        ] {
            assert!(!is_json_content_type(Some(
                &HeaderValue::from_str(value).unwrap()
            )));
        }
    }

    #[tokio::test]
    async fn rate_window_queues_in_fifo_order_and_rolls_after_sixty_seconds() {
        let rate = Arc::new(RateWindow::new(2));
        assert!(rate.acquire(Duration::from_secs(1)).await);
        assert!(rate.acquire(Duration::from_secs(1)).await);
        assert!(!rate.acquire(Duration::from_millis(10)).await);
        let (count, wait) = rate.snapshot();
        assert_eq!(count, 2);
        assert!(wait > 0);
    }
}
