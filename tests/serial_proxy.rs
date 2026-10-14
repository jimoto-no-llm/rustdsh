use futures_util::StreamExt;
use reqwest::Client;
use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Read, Write},
    net::{SocketAddr, TcpListener, TcpStream},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        mpsc, Arc, Mutex,
    },
    thread,
    time::Duration,
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
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
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
        Self {
            addr,
            state,
            stop,
            accept_thread: Some(accept_thread),
        }
    }
}

impl Drop for MockUpstream {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        let _ = TcpStream::connect(self.addr);
        if let Some(thread) = self.accept_thread.take() {
            let _ = thread.join();
        }
    }
}

fn serve_mock_request(mut stream: TcpStream, state: Arc<MockState>) {
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
    let length = headers
        .get("content-length")
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or_default();
    let mut body = vec![0; length];
    if reader.read_exact(&mut body).is_err() {
        return;
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
}

impl ProxyProcess {
    fn start(upstream: &str, options: &[&str]) -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_rdsh"))
            .args(["serial-proxy", "--upstream", upstream, "--port", "0"])
            .args(options)
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
        }
    }
}

impl Drop for ProxyProcess {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
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

#[tokio::test]
async fn native_cli_rewrites_tool_choice_and_streams_sse() {
    let upstream = MockUpstream::start(Duration::from_millis(250));
    let base_url = format!("http://{}/v1", upstream.addr);
    let proxy = ProxyProcess::start(&base_url, &["--tool-choice-default", "auto"]);
    let client = Client::new();
    let body = br#"{"model":"m","tools":[{"type":"function","function":{"name":"f"}}]}"#;
    let response = client
        .post(format!("{}/chat/completions?x=1", proxy.url))
        .header("content-type", "application/json")
        .header("authorization", "Bearer test-secret")
        .body(body.to_vec())
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::OK);

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
    let response = client
        .post(format!("{}/chat/completions", proxy.url))
        .header("content-type", "application/json")
        .body(unchanged.to_vec())
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::OK);
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
        response.bytes().await.unwrap();
        status
    });
    wait_until(|| upstream.state.seen.lock().unwrap().len() == 1).await;

    let second_client = client.clone();
    let second_url = format!("{}/second", proxy.url);
    let second = tokio::spawn(async move {
        let response = second_client.get(second_url).send().await.unwrap();
        let status = response.status();
        response.bytes().await.unwrap();
        status
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

    assert_eq!(first.await.unwrap(), reqwest::StatusCode::OK);
    assert_eq!(second.await.unwrap(), reqwest::StatusCode::OK);
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
    let first = client
        .get(format!("{}/first", proxy.url))
        .send()
        .await
        .unwrap();
    assert_eq!(first.status(), reqwest::StatusCode::OK);
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
