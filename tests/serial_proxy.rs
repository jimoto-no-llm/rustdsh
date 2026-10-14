use futures_util::StreamExt;
use reqwest::Client;
use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Read, Write},
    net::{SocketAddr, TcpListener, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        mpsc, Arc, Mutex,
    },
    thread,
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream as AsyncTcpStream,
};

#[derive(Clone, Debug)]
struct SeenRequest {
    method: String,
    path: String,
    headers: HashMap<String, String>,
    body: Vec<u8>,
}

struct MockState {
    seen: Mutex<Vec<SeenRequest>>,
    active: AtomicUsize,
    peak: AtomicUsize,
    finished: AtomicUsize,
    delay: Duration,
}

struct MockUpstream {
    addr: SocketAddr,
    state: Arc<MockState>,
    stop: Arc<AtomicBool>,
    accept_thread: Option<thread::JoinHandle<()>>,
}

impl MockUpstream {
    fn start(delay: Duration) -> Self {
        Self::start_at("127.0.0.1:0", delay).unwrap()
    }

    fn start_ipv6(delay: Duration) -> std::io::Result<Self> {
        Self::start_at("[::1]:0", delay)
    }

    fn start_at(address: &str, delay: Duration) -> std::io::Result<Self> {
        let listener = TcpListener::bind(address)?;
        listener.set_nonblocking(true).unwrap();
        let addr = listener.local_addr().unwrap();
        let state = Arc::new(MockState {
            seen: Mutex::new(Vec::new()),
            active: AtomicUsize::new(0),
            peak: AtomicUsize::new(0),
            finished: AtomicUsize::new(0),
            delay,
        });
        let stop = Arc::new(AtomicBool::new(false));
        let thread_state = state.clone();
        let thread_stop = stop.clone();
        let accept_thread = thread::spawn(move || {
            while !thread_stop.load(Ordering::Relaxed) {
                match listener.accept() {
                    Ok((stream, _)) => {
                        let state = thread_state.clone();
                        thread::spawn(move || serve_mock_request(stream, state));
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(5));
                    }
                    Err(_) => break,
                }
            }
        });
        Ok(Self {
            addr,
            state,
            stop,
            accept_thread: Some(accept_thread),
        })
    }
}

impl Drop for MockUpstream {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        // Wake the accept loop, but never block teardown: on a host where
        // loopback connections are dropped rather than refused, an untimed
        // connect retries for over two minutes before it gives up.
        let _ = TcpStream::connect_timeout(&self.addr, Duration::from_millis(500));
        if let Some(thread) = self.accept_thread.take() {
            let _ = thread.join();
        }
    }
}

fn serve_mock_request(mut stream: TcpStream, state: Arc<MockState>) {
    // Accepted sockets may inherit the listener's nonblocking mode on macOS.
    if stream.set_nonblocking(false).is_err() {
        return;
    }
    let _ = stream.set_read_timeout(Some(Duration::from_secs(3)));
    let Ok(reader_stream) = stream.try_clone() else {
        return;
    };
    let mut reader = BufReader::new(reader_stream);
    let mut request_line = String::new();
    if reader.read_line(&mut request_line).is_err() {
        return;
    }
    let mut request = request_line.split_whitespace();
    let method = request.next().unwrap_or_default().to_string();
    let path = request.next().unwrap_or_default().to_string();
    let mut headers = HashMap::new();
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).is_err() || line == "\r\n" || line.is_empty() {
            break;
        }
        if let Some((name, value)) = line.split_once(':') {
            headers.insert(name.trim().to_ascii_lowercase(), value.trim().to_string());
        }
    }
    let mut body = Vec::new();
    if headers
        .get("transfer-encoding")
        .is_some_and(|value| value.eq_ignore_ascii_case("chunked"))
    {
        // Streaming requests may use chunked framing even with an empty body.
        // Drain the terminal chunk and trailers before replying and closing;
        // unread input can turn the close into a reset on Windows and macOS.
        loop {
            let mut line = String::new();
            if reader.read_line(&mut line).is_err() || line.is_empty() {
                return;
            }
            let Ok(length) = usize::from_str_radix(line.trim().split(';').next().unwrap_or(""), 16)
            else {
                return;
            };
            if length == 0 {
                loop {
                    line.clear();
                    if reader.read_line(&mut line).is_err() || line.is_empty() {
                        return;
                    }
                    if line == "\r\n" {
                        break;
                    }
                }
                break;
            }
            let start = body.len();
            body.resize(start + length, 0);
            let mut delimiter = [0; 2];
            if reader.read_exact(&mut body[start..]).is_err()
                || reader.read_exact(&mut delimiter).is_err()
                || delimiter != *b"\r\n"
            {
                return;
            }
        }
    } else {
        let length = headers
            .get("content-length")
            .and_then(|value| value.parse::<usize>().ok())
            .unwrap_or_default();
        body.resize(length, 0);
        if reader.read_exact(&mut body).is_err() {
            return;
        }
    }
    drop(reader);

    let active = state.active.fetch_add(1, Ordering::SeqCst) + 1;
    state.peak.fetch_max(active, Ordering::SeqCst);
    state
        .seen
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .push(SeenRequest {
            method,
            path,
            headers,
            body,
        });

    let chunks = [
        b"data: first\n\n".as_slice(),
        b"data: second\n\n".as_slice(),
    ];
    if write!(
        stream,
        "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ntransfer-encoding: chunked\r\nconnection: close\r\n\r\n"
    )
    .is_ok()
    {
        for (index, chunk) in chunks.iter().enumerate() {
            if write!(stream, "{:x}\r\n", chunk.len())
                .and_then(|_| stream.write_all(chunk))
                .and_then(|_| stream.write_all(b"\r\n"))
                .and_then(|_| stream.flush())
                .is_err()
            {
                break;
            }
            if index == 0 {
                thread::sleep(state.delay);
            }
        }
        let _ = stream.write_all(b"0\r\n\r\n");
        let _ = stream.flush();
    }
    state.active.fetch_sub(1, Ordering::SeqCst);
    state.finished.fetch_add(1, Ordering::SeqCst);
}

struct ProxyProcess {
    child: Child,
    url: String,
    logs: Arc<Mutex<Vec<String>>>,
    binary_dir: Option<PathBuf>,
}

#[test]
fn mock_upstream_consumes_chunked_bodies_and_trailers_before_closing() {
    for (method, chunks, expected) in [
        ("GET", "0\r\n\r\n", ""),
        (
            "POST",
            "2;fixture=yes\r\nhi\r\n1\r\n!\r\n0\r\nx-fixture: done\r\n\r\n",
            "hi!",
        ),
    ] {
        let upstream = MockUpstream::start(Duration::ZERO);
        let mut stream = TcpStream::connect(upstream.addr).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        write!(stream, "{method} /chunked HTTP/1.1\r\nhost: {}\r\ntransfer-encoding: chunked\r\nconnection: close\r\n\r\n{chunks}", upstream.addr).unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).unwrap();
        assert!(response.starts_with("HTTP/1.1 200 OK\r\n"));
        let seen = upstream.state.seen.lock().unwrap();
        assert_eq!(seen.len(), 1);
        assert_eq!(seen[0].body, expected.as_bytes());
    }
}

impl ProxyProcess {
    fn start(upstream: &str, options: &[&str]) -> Self {
        Self::start_binary(
            Path::new(env!("CARGO_BIN_EXE_rdsh")),
            upstream,
            options,
            None,
        )
    }

    fn start_as_dsh(upstream: &str, options: &[&str]) -> Self {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let binary_dir = std::env::temp_dir().join(format!(
            "rdsh-shadow-integration-{}-{nonce}",
            std::process::id()
        ));
        std::fs::create_dir_all(&binary_dir).unwrap();
        let binary_name = if cfg!(windows) { "dsh.exe" } else { "dsh" };
        let binary = binary_dir.join(binary_name);
        std::fs::copy(env!("CARGO_BIN_EXE_rdsh"), &binary).unwrap();
        let missing_original = binary_dir.join("no-original-dsh");
        let mut proxy = Self::start_binary(&binary, upstream, options, Some(&missing_original));
        proxy.binary_dir = Some(binary_dir);
        proxy
    }

    fn start_binary(
        binary: &Path,
        upstream: &str,
        options: &[&str],
        original_dsh: Option<&Path>,
    ) -> Self {
        let mut command = Command::new(binary);
        command
            .args(["serial-proxy", "--upstream", upstream, "--port", "0"])
            .args(options);
        if let Some(original_dsh) = original_dsh {
            command.env("DSH_ORIG_BIN", original_dsh);
        }
        let mut child = command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let stderr = child.stderr.take().unwrap();
        let (sender, receiver) = mpsc::sync_channel(1);
        let logs = Arc::new(Mutex::new(Vec::new()));
        let thread_logs = logs.clone();
        thread::spawn(move || {
            let mut sent = false;
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                thread_logs
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .push(line.clone());
                if !sent && line.contains("serial-proxy listening on") {
                    sent = true;
                    let _ = sender.send(line);
                }
            }
        });
        let line = receiver
            .recv_timeout(Duration::from_secs(10))
            .unwrap_or_else(|error| panic!("serial-proxy did not start: {error}"));
        let start = line.find("http://").unwrap();
        let address = line[start..].split(" -> ").next().unwrap();
        Self {
            child,
            url: address.to_string(),
            logs,
            binary_dir: None,
        }
    }
}

impl Drop for ProxyProcess {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        if let Some(binary_dir) = &self.binary_dir {
            let _ = std::fs::remove_dir_all(binary_dir);
        }
    }
}

async fn wait_until(mut condition: impl FnMut() -> bool) {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if condition() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("condition timed out");
}

async fn wait_for_queued(client: &Client, proxy_url: &str, queued: usize) {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Ok(response) = client
                .get(format!("{proxy_url}/__proxy/status"))
                .send()
                .await
            {
                if let Ok(body) = response.bytes().await {
                    if serde_json::from_slice::<serde_json::Value>(&body)
                        .is_ok_and(|value| value["queued"] == queued)
                    {
                        return;
                    }
                }
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("queue status timed out");
}

async fn wait_for_active(client: &Client, proxy_url: &str, active: usize) {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Ok(response) = client
                .get(format!("{proxy_url}/__proxy/status"))
                .send()
                .await
            {
                if let Ok(body) = response.bytes().await {
                    if serde_json::from_slice::<serde_json::Value>(&body)
                        .is_ok_and(|value| value["active"] == active)
                    {
                        return;
                    }
                }
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("active count status timed out");
}

async fn raw_request(proxy_url: &str, path: &str) -> AsyncTcpStream {
    let authority = proxy_url.strip_prefix("http://").unwrap();
    let mut stream = AsyncTcpStream::connect(authority).await.unwrap();
    stream
        .write_all(format!("GET {path} HTTP/1.1\r\nHost: {authority}\r\n\r\n").as_bytes())
        .await
        .unwrap();
    stream
}

/// How long a plain IPv6 loopback connect may take before this host is treated
/// as unable to carry the traffic the IPv6 test needs.
const IPV6_LOOPBACK_PROBE_TIMEOUT: Duration = Duration::from_secs(5);

/// Checks that an IPv6 loopback *connection* can be established, not just bound.
///
/// `TcpListener::bind("[::1]:0")` succeeds on hosts where connecting to `::1`
/// still fails (a firewall that drops loopback IPv6, a stack that is only half
/// enabled). The proxy then answers `502 upstream connection failed`
/// (src/serial_proxy.rs, the `is_connect()` branch) and the host header this
/// test exists to check is never observable. Only that environment
/// precondition is skipped: once this probe has reached an IPv6 loopback
/// listener, any later failure is a regression and still fails the test.
fn ipv6_loopback_is_usable() -> Result<(), String> {
    let listener = TcpListener::bind("[::1]:0").map_err(|error| error.to_string())?;
    let addr = listener.local_addr().map_err(|error| error.to_string())?;
    TcpStream::connect_timeout(&addr, IPV6_LOOPBACK_PROBE_TIMEOUT)
        .map(|_| ())
        .map_err(|error| error.to_string())
}

/// Returns the response when the proxy answered `200 OK`; otherwise fails with
/// the proxy's own upstream error and the child's stderr.
///
/// The JSON error body is the only place the proxy distinguishes `upstream
/// connection failed` from `upstream timeout`, so printing it keeps the next
/// Windows/macOS transport failure diagnosable from the test log alone
/// (issue #528) instead of a bare `left: 502, right: 200`.
async fn expect_proxy_ok(
    response: reqwest::Response,
    logs: &Arc<Mutex<Vec<String>>>,
) -> reqwest::Response {
    if response.status() == reqwest::StatusCode::OK {
        return response;
    }
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    let logs = logs
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .join("\n");
    panic!("proxy answered {status}: {body}\nserial-proxy stderr:\n{logs}");
}

#[tokio::test]
async fn native_cli_rewrites_tool_choice_and_streams_sse() {
    let upstream = MockUpstream::start(Duration::from_millis(250));
    let base_url = format!("http://{}/v1", upstream.addr);
    let proxy = ProxyProcess::start(&base_url, &["--tool-choice-default", "auto"]);
    let client = Client::new();
    let body = br#"{"model":"m","tools":[{"type":"function","function":{"name":"f"}}]}"#;
    let response = expect_proxy_ok(
        client
            .post(format!("{}/chat/completions?x=1", proxy.url))
            .header("content-type", "application/json")
            .header("authorization", "Bearer test-secret")
            .body(body.to_vec())
            .send()
            .await
            .unwrap(),
        &proxy.logs,
    )
    .await;

    let mut stream = response.bytes_stream();
    let first = stream.next().await.unwrap().unwrap();
    assert!(String::from_utf8_lossy(&first).contains("data: first"));
    let status = client
        .get(format!("{}/__proxy/status", proxy.url))
        .send()
        .await
        .unwrap()
        .bytes()
        .await
        .unwrap();
    let status: serde_json::Value = serde_json::from_slice(&status).unwrap();
    assert_eq!(
        status["active"], 1,
        "first SSE chunk should arrive before completion"
    );
    while stream.next().await.is_some() {}

    wait_until(|| {
        !upstream
            .state
            .seen
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .is_empty()
    })
    .await;
    let seen = upstream
        .state
        .seen
        .lock()
        .unwrap_or_else(|error| error.into_inner())[0]
        .clone();
    assert_eq!(seen.method, "POST");
    assert_eq!(seen.path, "/v1/chat/completions?x=1");
    assert_eq!(seen.headers["authorization"], "Bearer test-secret");
    assert!(!seen.headers.contains_key("transfer-encoding"));
    let rewritten: serde_json::Value = serde_json::from_slice(&seen.body).unwrap();
    assert_eq!(rewritten["tool_choice"], "auto");
    assert_eq!(
        seen.headers["content-length"].parse::<usize>().unwrap(),
        seen.body.len()
    );
    assert_eq!(upstream.state.finished.load(Ordering::SeqCst), 1);

    let unchanged = br#"{ "tools" : [1], "tool_choice" : null }"#;
    let response = expect_proxy_ok(
        client
            .post(format!("{}/chat/completions", proxy.url))
            .header("content-type", "application/json")
            .body(unchanged.to_vec())
            .send()
            .await
            .unwrap(),
        &proxy.logs,
    )
    .await;
    response.bytes().await.unwrap();
    wait_until(|| upstream.state.seen.lock().unwrap().len() == 2).await;
    assert_eq!(upstream.state.seen.lock().unwrap()[1].body, unchanged);
    assert_eq!(upstream.state.finished.load(Ordering::SeqCst), 2);
    let logs = proxy
        .logs
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .join("\n");
    assert!(logs.contains("tool_choice defaulted"));
    assert!(!logs.contains("test-secret"));
}

#[tokio::test]
async fn native_cli_caps_upstream_concurrency_and_rejects_full_queue() {
    let upstream = MockUpstream::start(Duration::from_millis(250));
    let proxy = ProxyProcess::start(
        &format!("http://{}", upstream.addr),
        &["--max", "1", "--max-queue", "1", "--queue-timeout", "0.5"],
    );
    let client = Client::new();
    let first_client = client.clone();
    let first_url = format!("{}/first", proxy.url);
    let first = tokio::spawn(async move {
        let response = first_client.get(first_url).send().await.unwrap();
        let status = response.status();
        let body = response.bytes().await.unwrap();
        (status, body)
    });
    wait_until(|| upstream.state.seen.lock().unwrap().len() == 1).await;

    let second_client = client.clone();
    let second_url = format!("{}/second", proxy.url);
    let second = tokio::spawn(async move {
        let response = second_client.get(second_url).send().await.unwrap();
        let status = response.status();
        let body = response.bytes().await.unwrap();
        (status, body)
    });
    wait_for_queued(&client, &proxy.url, 1).await;
    let full = client
        .get(format!("{}/third", proxy.url))
        .send()
        .await
        .unwrap();
    assert_eq!(full.status(), reqwest::StatusCode::TOO_MANY_REQUESTS);
    let error: serde_json::Value = serde_json::from_slice(&full.bytes().await.unwrap()).unwrap();
    assert_eq!(error["error"]["type"], "serial_proxy_error");

    let (first_status, first_body) = first.await.unwrap();
    assert_eq!(
        first_status,
        reqwest::StatusCode::OK,
        "{}",
        String::from_utf8_lossy(&first_body)
    );
    let (second_status, second_body) = second.await.unwrap();
    assert_eq!(
        second_status,
        reqwest::StatusCode::OK,
        "{}",
        String::from_utf8_lossy(&second_body)
    );
    assert_eq!(upstream.state.peak.load(Ordering::SeqCst), 1);
    assert_eq!(upstream.state.seen.lock().unwrap().len(), 2);
}

#[tokio::test]
async fn native_cli_queue_timeout_returns_503_without_dispatching_waiter() {
    let upstream = MockUpstream::start(Duration::from_millis(250));
    let proxy = ProxyProcess::start(
        &format!("http://{}", upstream.addr),
        &["--max", "1", "--queue-timeout", "0.05"],
    );
    let client = Client::new();
    let first_client = client.clone();
    let first_url = format!("{}/first", proxy.url);
    let first = tokio::spawn(async move {
        let response = first_client.get(first_url).send().await.unwrap();
        let status = response.status();
        response.bytes().await.unwrap();
        status
    });
    wait_until(|| upstream.state.seen.lock().unwrap().len() == 1).await;
    let second = client
        .get(format!("{}/waiter", proxy.url))
        .send()
        .await
        .unwrap();
    assert_eq!(second.status(), reqwest::StatusCode::SERVICE_UNAVAILABLE);
    let error: serde_json::Value = serde_json::from_slice(&second.bytes().await.unwrap()).unwrap();
    assert_eq!(error["error"]["type"], "serial_proxy_error");
    assert_eq!(upstream.state.seen.lock().unwrap().len(), 1);
    assert_eq!(first.await.unwrap(), reqwest::StatusCode::OK);
}

#[tokio::test]
async fn native_cli_rpm_window_is_reported_and_waiter_times_out() {
    let upstream = MockUpstream::start(Duration::from_millis(20));
    let proxy = ProxyProcess::start(
        &format!("http://{}", upstream.addr),
        &["--rpm", "1", "--queue-timeout", "0.05"],
    );
    let client = Client::new();
    let first = expect_proxy_ok(
        client
            .get(format!("{}/first", proxy.url))
            .send()
            .await
            .unwrap(),
        &proxy.logs,
    )
    .await;
    first.bytes().await.unwrap();

    let status = client
        .get(format!("{}/__proxy/status", proxy.url))
        .send()
        .await
        .unwrap()
        .bytes()
        .await
        .unwrap();
    let status: serde_json::Value = serde_json::from_slice(&status).unwrap();
    assert_eq!(status["rpm"], 1);
    assert_eq!(status["window_count"], 1);
    assert!(status["next_slot_in"].as_u64().unwrap() > 0);

    let waiting = client
        .get(format!("{}/second", proxy.url))
        .send()
        .await
        .unwrap();
    assert_eq!(waiting.status(), reqwest::StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(upstream.state.seen.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn disconnect_while_queued_removes_waiter_before_slot_opens() {
    let upstream = MockUpstream::start(Duration::from_millis(400));
    let proxy = ProxyProcess::start(
        &format!("http://{}", upstream.addr),
        &["--max", "1", "--queue-timeout", "2"],
    );
    let client = Client::new();
    let first_client = client.clone();
    let first_url = format!("{}/first", proxy.url);
    let first = tokio::spawn(async move {
        let response = first_client.get(first_url).send().await.unwrap();
        response.bytes().await.unwrap();
    });
    wait_until(|| upstream.state.seen.lock().unwrap().len() == 1).await;

    let abandoned = raw_request(&proxy.url, "/queued").await;
    wait_for_queued(&client, &proxy.url, 1).await;
    drop(abandoned);
    wait_for_queued(&client, &proxy.url, 0).await;

    first.await.unwrap();
    assert_eq!(upstream.state.seen.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn disconnect_during_sse_releases_slot_and_cancels_upstream_stream() {
    let upstream = MockUpstream::start(Duration::from_millis(150));
    let proxy = ProxyProcess::start(&format!("http://{}", upstream.addr), &[]);
    let mut downstream = raw_request(&proxy.url, "/active-sse").await;
    wait_until(|| upstream.state.seen.lock().unwrap().len() == 1).await;

    let mut response = Vec::new();
    tokio::time::timeout(Duration::from_secs(3), async {
        let mut buffer = [0u8; 512];
        loop {
            let read = downstream.read(&mut buffer).await.unwrap();
            assert_ne!(read, 0, "proxy closed before the first SSE event");
            response.extend_from_slice(&buffer[..read]);
            if String::from_utf8_lossy(&response).contains("data: first") {
                return;
            }
        }
    })
    .await
    .expect("first SSE event timed out");
    drop(downstream);

    wait_for_active(&Client::new(), &proxy.url, 0).await;
    wait_until(|| upstream.state.finished.load(Ordering::SeqCst) == 1).await;
    assert_eq!(upstream.state.active.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn disconnect_while_waiting_for_rpm_releases_slot_without_dispatch() {
    let upstream = MockUpstream::start(Duration::from_millis(20));
    let proxy = ProxyProcess::start(
        &format!("http://{}", upstream.addr),
        &["--rpm", "1", "--max", "5", "--queue-timeout", "5"],
    );
    let client = Client::new();
    let first = client
        .get(format!("{}/first", proxy.url))
        .send()
        .await
        .unwrap();
    assert_eq!(first.status(), reqwest::StatusCode::OK);
    first.bytes().await.unwrap();
    wait_for_active(&client, &proxy.url, 0).await;

    let mut abandoned = raw_request(&proxy.url, "/rpm-waiter").await;
    wait_for_active(&client, &proxy.url, 1).await;
    let mut byte = [0u8; 1];
    assert!(
        tokio::time::timeout(Duration::from_millis(100), abandoned.read(&mut byte))
            .await
            .is_err()
    );
    drop(abandoned);

    wait_for_active(&client, &proxy.url, 0).await;
    assert_eq!(upstream.state.seen.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn ipv6_upstream_host_header_keeps_exactly_one_pair_of_brackets() {
    let upstream = match MockUpstream::start_ipv6(Duration::from_millis(10)) {
        Ok(upstream) => upstream,
        Err(error)
            if matches!(
                error.kind(),
                std::io::ErrorKind::AddrNotAvailable | std::io::ErrorKind::PermissionDenied
            ) =>
        {
            eprintln!("skipping IPv6 upstream test: {error}");
            return;
        }
        Err(error) => panic!("failed to bind IPv6 loopback: {error}"),
    };
    if let Err(error) = ipv6_loopback_is_usable() {
        eprintln!("skipping IPv6 upstream test: IPv6 loopback is not usable: {error}");
        return;
    }
    let proxy = ProxyProcess::start(&format!("http://{}/v1", upstream.addr), &[]);
    let response = expect_proxy_ok(
        Client::new()
            .get(format!("{}/forward", proxy.url))
            .send()
            .await
            .unwrap(),
        &proxy.logs,
    )
    .await;
    response.bytes().await.unwrap();
    wait_until(|| upstream.state.seen.lock().unwrap().len() == 1).await;

    let expected = format!("[::1]:{}", upstream.addr.port());
    assert_eq!(
        upstream.state.seen.lock().unwrap()[0].headers["host"],
        expected
    );
}

#[tokio::test]
async fn serial_proxy_runs_when_binary_is_invoked_as_dsh() {
    let upstream = MockUpstream::start(Duration::from_millis(10));
    let proxy = ProxyProcess::start_as_dsh(&format!("http://{}", upstream.addr), &[]);
    let status = Client::new()
        .get(format!("{}/__proxy/status", proxy.url))
        .send()
        .await
        .unwrap();
    assert_eq!(status.status(), reqwest::StatusCode::OK);
}

#[test]
fn invalid_serial_proxy_options_exit_with_usage_status() {
    let invalid_cases: &[(&str, &[&str])] = &[
        ("invalid tool choice", &["--tool-choice-default", "any"]),
        ("empty tool choice", &["--tool-choice-default", ""]),
        ("zero rpm", &["--rpm", "0"]),
        ("non-numeric rpm", &["--rpm", "abc"]),
        ("fractional rpm", &["--rpm", "1.5"]),
        ("negative rpm", &["--rpm=-1"]),
        ("zero max", &["--max", "0"]),
        ("zero body cap", &["--max-body-bytes", "0"]),
        ("non-numeric body cap", &["--max-body-bytes", "x"]),
        ("non-finite queue timeout", &["--queue-timeout", "NaN"]),
        ("non-loopback host without opt-in", &["--host", "0.0.0.0"]),
    ];
    for invalid in invalid_cases {
        let (name, invalid) = invalid;
        let output = Command::new(env!("CARGO_BIN_EXE_rdsh"))
            .args(["serial-proxy", "--upstream", "http://127.0.0.1:1"])
            .args(*invalid)
            .output()
            .unwrap();
        assert_eq!(output.status.code(), Some(2), "{name}: {invalid:?}");
    }

    let invalid_upstream = Command::new(env!("CARGO_BIN_EXE_rdsh"))
        .args(["serial-proxy", "--upstream", "file:///tmp/upstream"])
        .output()
        .unwrap();
    assert_eq!(invalid_upstream.status.code(), Some(2));
}

#[test]
fn serial_proxy_runtime_startup_failure_keeps_runtime_status() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port().to_string();
    let output = Command::new(env!("CARGO_BIN_EXE_rdsh"))
        .args([
            "serial-proxy",
            "--upstream",
            "http://127.0.0.1:1",
            "--port",
            &port,
        ])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(1));
}

#[tokio::test]
async fn closed_stderr_does_not_abort_startup_or_tool_choice_streaming() {
    let upstream = MockUpstream::start(Duration::from_millis(10));
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    let mut child = Command::new(env!("CARGO_BIN_EXE_rdsh"))
        .args([
            "serial-proxy",
            "--upstream",
            &format!("http://{}", upstream.addr),
            "--port",
            &port.to_string(),
            "--tool-choice-default",
            "auto",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    drop(child.stderr.take());
    let proxy = ProxyProcess {
        child,
        url: format!("http://127.0.0.1:{port}"),
        logs: Arc::new(Mutex::new(Vec::new())),
        binary_dir: None,
    };
    let client = Client::new();
    let status = tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            if let Ok(response) = client
                .get(format!("{}/__proxy/status", proxy.url))
                .send()
                .await
            {
                if response.status().is_success() {
                    return response;
                }
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("proxy did not start with a closed stderr");
    status.bytes().await.unwrap();

    let body = br#"{"tools":[{"type":"function"}]}"#;
    let response = expect_proxy_ok(
        client
            .post(format!("{}/v1/chat/completions", proxy.url))
            .header("content-type", "application/json")
            .body(body.to_vec())
            .send()
            .await
            .unwrap(),
        &proxy.logs,
    )
    .await;
    response.bytes().await.unwrap();
    wait_until(|| upstream.state.seen.lock().unwrap().len() == 1).await;
    let forwarded: serde_json::Value =
        serde_json::from_slice(&upstream.state.seen.lock().unwrap()[0].body).unwrap();
    assert_eq!(forwarded["tool_choice"], "auto");
}
