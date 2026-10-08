//! Real executable + filesystem + loopback HTTP tests. No model credentials.
use serde_json::{json, Value};
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, Output, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc;
use std::time::{Duration, Instant};

static NEXT: AtomicUsize = AtomicUsize::new(0);

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let p = std::env::temp_dir().join(format!(
            "rdsh-e2e-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&p).unwrap();
        fs::create_dir(p.join("dsh")).unwrap();
        Self(p)
    }
    fn command(&self, args: &[&str]) -> Command {
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_rdsh"));
        cmd.env_clear();
        for key in ["PATH", "SystemRoot", "WINDIR", "COMSPEC", "TEMP", "TMP"] {
            if let Some(v) = std::env::var_os(key) {
                cmd.env(key, v);
            }
        }
        cmd.args(args)
            .current_dir(&self.0)
            .env("HOME", &self.0)
            .env("USERPROFILE", &self.0)
            .env("DSH_HOME", self.0.join("dsh"))
            .env("XDG_CACHE_HOME", self.0.join("cache"))
            .env("XDG_DATA_HOME", self.0.join("data"))
            .env("XDG_CONFIG_HOME", self.0.join("config"))
            .env("RDSH_ORIG_BIN", self.0.join("no-original-dsh"));
        cmd
    }
    fn run(&self, args: &[&str], input: &[u8]) -> Output {
        let mut child = self
            .command(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child.stdin.take().unwrap().write_all(input).unwrap();
        child.wait_with_output().unwrap()
    }
    fn ok(&self, args: &[&str], input: &[u8]) -> Vec<u8> {
        let output = self.run(args, input);
        assert!(
            output.status.success(),
            "{args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        output.stdout
    }
    fn settings(&self, value: Value) {
        fs::write(self.0.join("dsh/rdsh.json"), value.to_string()).unwrap();
    }
    fn sessions(&self) -> Value {
        serde_json::from_slice(&self.ok(&["sessions", "--tokens", "--json"], b"")).unwrap()
    }
    fn session(&self, name: &str, raw: &[u8], known_size: bool) -> PathBuf {
        let dir = self.0.join("dsh/sessions/project").join(name);
        fs::create_dir_all(&dir).unwrap();
        let p = dir.join("messages.jsonl.zstd");
        fs::write(&p, raw_frame(raw, known_size)).unwrap();
        p
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

// Valid RFC 8878 raw-block frames: independent of a compressor or token cache.
fn raw_frame(body: &[u8], known_size: bool) -> Vec<u8> {
    let mut frame = vec![0x28, 0xb5, 0x2f, 0xfd];
    if known_size {
        frame.push(0xa0);
        frame.extend_from_slice(&(body.len() as u32).to_le_bytes());
    } else {
        frame.extend_from_slice(&[0, 0x38]);
    }
    let chunks = body.chunks(128 * 1024).collect::<Vec<_>>();
    for (i, chunk) in chunks.iter().enumerate() {
        let header = ((chunk.len() as u32) << 3) | u32::from(i + 1 == chunks.len());
        frame.extend_from_slice(&header.to_le_bytes()[..3]);
        frame.extend_from_slice(chunk);
    }
    frame
}

#[test]
fn sessions_known_and_concatenated_frames_cache_and_growth() {
    let f = Fixture::new();
    let p = f.session("one", &vec![b'a'; 4096], true);
    let mut frames = raw_frame(&vec![b'b'; 2048], true);
    frames.extend(raw_frame(&vec![b'c'; 2048], true));
    let two = f.session("two", b"xxxx", true);
    fs::write(two, frames).unwrap();
    for _ in 0..2 {
        for s in f.sessions()["sessions"].as_array().unwrap() {
            assert_eq!(s["tokens"], 1024);
            assert_eq!(s["tokens_exact"], true);
        }
    }
    fs::write(p, raw_frame(&vec![b'd'; 8192], true)).unwrap();
    let rows = f.sessions();
    let s = rows["sessions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["id"] == "one")
        .unwrap();
    assert_eq!(s["tokens"], 2048);
    assert_eq!(s["tokens_exact"], true);
    fs::write(f.0.join("cache/rdsh/sessions-tokens.json"), b"{broken").unwrap();
    assert_eq!(f.sessions(), rows);
}

#[test]
fn legacy_cache_cannot_promote_an_old_estimate_to_exact() {
    let f = Fixture::new();
    let p = f.session("one", &vec![b'a'; 8192], true);
    let metadata = fs::metadata(p).unwrap();
    let mtime = metadata
        .modified()
        .unwrap()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;
    let key = format!("{}/sessions/project/one", f.0.join("dsh").display());
    let cache = f.0.join("cache/rdsh/sessions-tokens.json");
    fs::create_dir_all(cache.parent().unwrap()).unwrap();
    fs::write(
        cache,
        json!({key:{"mtime":mtime,"bytes":metadata.len(),"decomp":4096,"ts":0}}).to_string(),
    )
    .unwrap();
    let rows = f.sessions();
    assert_eq!(rows["sessions"][0]["tokens"], 2048);
    assert_eq!(rows["sessions"][0]["tokens_exact"], true);
}

#[test]
fn unreadable_session_is_inexact_on_first_and_cached_multi_session_views() {
    let f = Fixture::new();
    f.session("good", b"abcdabcd", true);
    let p = f.session("bad", b"abcd", true);
    fs::write(p, b"not zstd!").unwrap();
    for _ in 0..2 {
        let rows = f.sessions();
        let s = rows["sessions"]
            .as_array()
            .unwrap()
            .iter()
            .find(|s| s["id"] == "bad")
            .unwrap();
        assert_eq!(
            s["tokens_exact"], false,
            "corrupt frame was labelled exact: {s}"
        );
    }
}

#[test]
fn partly_corrupt_session_never_reports_an_exact_partial_total() {
    for count in [1, 2] {
        let f = Fixture::new();
        for i in 0..count {
            let p = f.session(&format!("session-{i}"), &vec![b'a'; 4096], true);
            fs::write(p.parent().unwrap().join("broken.jsonl.zstd"), b"not zstd!").unwrap();
        }
        for _ in 0..2 {
            for s in f.sessions()["sessions"].as_array().unwrap() {
                assert_eq!(
                    s["tokens_exact"], false,
                    "partial total labelled exact: {s}"
                );
            }
        }
    }
}

#[cfg(unix)]
#[test]
fn missing_compressed_file_never_reports_an_exact_partial_total() {
    let f = Fixture::new();
    let p = f.session("one", &vec![b'a'; 4096], true);
    std::os::unix::fs::symlink("nonexistent", p.parent().unwrap().join("broken.jsonl.zstd"))
        .unwrap();
    for _ in 0..2 {
        assert_eq!(f.sessions()["sessions"][0]["tokens_exact"], false);
    }
}

#[cfg(unix)]
#[test]
fn streaming_growth_stays_inexact_until_recomputed_single_and_parallel() {
    for count in [1, 2] {
        let f = Fixture::new();
        f.settings(json!({"sessions":{"stale_secs":3600}}));
        for i in 0..count {
            f.session(&format!("session-{i}"), &vec![b'a'; 4096], false);
        }
        for s in f.sessions()["sessions"].as_array().unwrap() {
            assert_eq!(s["tokens"], 1024);
            assert_eq!(s["tokens_exact"], true);
        }
        for i in 0..count {
            f.session(&format!("session-{i}"), &vec![b'b'; 8192], false);
        }
        for _ in 0..2 {
            for s in f.sessions()["sessions"].as_array().unwrap() {
                assert_eq!(s["tokens"], 1024);
                assert_eq!(
                    s["tokens_exact"], false,
                    "stale value promoted to exact: {s}"
                );
            }
        }
        f.settings(json!({"sessions":{"stale_secs":0}}));
        for s in f.sessions()["sessions"].as_array().unwrap() {
            assert_eq!(s["tokens"], 2048);
            assert_eq!(s["tokens_exact"], true);
        }
    }
}

#[test]
fn concurrent_session_writers_leave_parseable_correct_cache() {
    let f = Fixture::new();
    for i in 0..20 {
        f.session(&format!("session-{i}"), &vec![b'a'; 4096 + 4 * i], true);
    }
    for _ in 0..8 {
        let cache = f.0.join("cache/rdsh/sessions-tokens.json");
        let _ = fs::remove_file(&cache);
        let mut children = (0..4)
            .map(|_| {
                f.command(&["sessions", "--tokens", "--json"])
                    .stdout(Stdio::piped())
                    .stderr(Stdio::piped())
                    .spawn()
                    .unwrap()
            })
            .collect::<Vec<_>>();
        for child in children.drain(..) {
            let o = child.wait_with_output().unwrap();
            assert!(o.status.success());
            let v: Value = serde_json::from_slice(&o.stdout).unwrap();
            assert_eq!(v["sessions"].as_array().unwrap().len(), 20);
            for s in v["sessions"].as_array().unwrap() {
                let i: usize = s["id"]
                    .as_str()
                    .unwrap()
                    .strip_prefix("session-")
                    .unwrap()
                    .parse()
                    .unwrap();
                assert_eq!(s["tokens"], 1024 + i);
                assert_eq!(s["tokens_exact"], true);
            }
        }
        let value: Value = serde_json::from_slice(&fs::read(cache).unwrap()).unwrap();
        assert_eq!(value.as_object().unwrap().len(), 20);
    }
}

struct Server {
    child: Child,
    port: u16,
    token: String,
}
impl Server {
    fn start(f: &Fixture, args: &[&str]) -> Self {
        let mut child = f
            .command(args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let stderr = child.stderr.take().unwrap();
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                if let Some(url) = line
                    .split_whitespace()
                    .find(|s| s.starts_with("http://127.0.0.1:"))
                {
                    let _ = tx.send(url.to_owned());
                }
            }
        });
        let url = match rx.recv_timeout(Duration::from_secs(15)) {
            Ok(url) => url,
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                panic!("server did not become ready: {e}");
            }
        };
        let (address, token) = url
            .trim_start_matches("http://127.0.0.1:")
            .split_once("/#key=")
            .unwrap();
        Self {
            child,
            port: address.parse().unwrap(),
            token: token.to_owned(),
        }
    }
    fn request(
        &self,
        method: &str,
        path: &str,
        body: &str,
        authorized: bool,
        extra: &str,
    ) -> (u16, String) {
        let mut stream = TcpStream::connect(("127.0.0.1", self.port)).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(12)))
            .unwrap();
        let key = if authorized {
            format!("X-RDSH-Token: {}\r\n", self.token)
        } else {
            String::new()
        };
        write!(stream, "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\n{key}{extra}Content-Length: {}\r\nConnection: close\r\n\r\n{body}", self.port, body.len()).unwrap();
        let mut bytes = Vec::new();
        stream.read_to_end(&mut bytes).unwrap();
        let response = String::from_utf8(bytes).unwrap();
        let (head, body) = response.split_once("\r\n\r\n").unwrap();
        (
            head.split_whitespace().nth(1).unwrap().parse().unwrap(),
            body.to_owned(),
        )
    }
    fn stopped(&mut self) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while self.child.try_wait().unwrap().is_none() {
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(TcpStream::connect(("127.0.0.1", self.port)).is_err());
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[test]
fn setup_save_extras_restart_serve_and_use_real_http_api() {
    let f = Fixture::new();
    let mut setup = Server::start(&f, &["setup", "--web", "--port", "0"]);
    assert_eq!(setup.request("GET", "/api/status", "", false, "").0, 401);
    assert_eq!(
        setup
            .request(
                "POST",
                "/api/extras",
                r#"{"enable":["serve"]}"#,
                true,
                "Origin: https://evil.example\r\n"
            )
            .0,
        403
    );
    assert_eq!(
        setup
            .request("POST", "/api/extras", r#"{"enable":["serve"]}"#, true, "")
            .0,
        200
    );
    let saved = fs::read(f.0.join("dsh/rdsh.json")).unwrap();
    assert_eq!(
        setup
            .request("POST", "/api/extras", r#"{"enable":false}"#, true, "")
            .0,
        400
    );
    assert_eq!(fs::read(f.0.join("dsh/rdsh.json")).unwrap(), saved);
    assert_eq!(setup.request("POST", "/api/done", "{}", true, "").0, 200);
    setup.stopped();
    let serve = Server::start(&f, &["serve", "--port", "0"]);
    assert_eq!(serve.request("GET", "/", "", false, "").0, 200);
    assert_eq!(
        serve
            .request("POST", "/api/tokens", r#"{"text":"abcd日本語"}"#, false, "")
            .0,
        401
    );
    let (status, body) = serve.request("POST", "/api/tokens", r#"{"text":"abcd日本語"}"#, true, "");
    assert_eq!(status, 200);
    assert_eq!(serde_json::from_str::<Value>(&body).unwrap()["tokens"], 4);
    let text = "日本語abcd".repeat(1000);
    let (status, body) = serve.request(
        "POST",
        "/api/prune",
        &json!({"text":text,"max_tokens":100}).to_string(),
        true,
        "",
    );
    assert_eq!(status, 200);
    let v: Value = serde_json::from_str(&body).unwrap();
    assert!(v["after"].as_u64().unwrap() <= 100);
    assert_eq!(
        serve
            .request("GET", "/api/version", "", true, "Host: evil.example\r\n")
            .0,
        400
    );
    assert_eq!(fs::read(f.0.join("dsh/rdsh.json")).unwrap(), saved);
}

#[test]
fn http_truncated_and_oversized_requests_do_not_damage_serve() {
    let f = Fixture::new();
    f.settings(json!({"extras":{"enable":["serve"]}}));
    let server = Server::start(&f, &["serve", "--port", "0"]);
    for request in [
        format!(
            "POST /api/tokens HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nContent-Length: 10\r\n\r\nx",
            server.port
        ),
        format!(
            "POST /api/tokens HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nContent-Length: 70000\r\n\r\n",
            server.port
        ),
    ] {
        let mut stream = TcpStream::connect(("127.0.0.1", server.port)).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(12)))
            .unwrap();
        stream.write_all(request.as_bytes()).unwrap();
        stream.shutdown(Shutdown::Write).unwrap();
        let mut answer = String::new();
        stream.read_to_string(&mut answer).unwrap();
        assert!(answer.starts_with("HTTP/1.1 400") || answer.starts_with("HTTP/1.1 413"));
    }
    assert_eq!(server.request("GET", "/api/version", "", true, "").0, 200);
}

#[test]
fn cli_tokens_prune_compact_search_logs_guard_and_settings_work_together() {
    let f = Fixture::new();
    assert_eq!(
        serde_json::from_slice::<Value>(&f.ok(&["tokens"], "abcd日本語".as_bytes())).unwrap()
            ["tokens"],
        4
    );
    let source = "START\n".to_owned() + &"日本語 context\n".repeat(1000) + "END";
    let pruned = f.ok(&["prune", "--max-tokens", "100"], source.as_bytes());
    assert!(String::from_utf8_lossy(&pruned).contains("START"));
    assert!(String::from_utf8_lossy(&pruned).contains("END"));
    assert!(
        serde_json::from_slice::<Value>(&f.ok(&["tokens"], &pruned)).unwrap()["tokens"]
            .as_u64()
            .unwrap()
            <= 101
    ); // CLI appends a newline.
    let file = f.0.join("conversation.jsonl");
    let conversation = "{\"role\":\"system\",\"content\":\"START\"}\n".to_owned()
        + &"{\"role\":\"tool\",\"content\":\"old context\"}\n".repeat(1000)
        + "{\"role\":\"user\",\"content\":\"END\"}";
    fs::write(&file, &conversation).unwrap();
    let compact = f.ok(
        &["compact", file.to_str().unwrap(), "--max-tokens", "300"],
        b"",
    );
    assert!(String::from_utf8_lossy(&compact).contains("START"));
    assert!(String::from_utf8_lossy(&compact).contains("END"));
    assert_eq!(fs::read_to_string(file).unwrap(), conversation);
    for count in [8, 40] {
        let dir = f.0.join(format!("search-{count}"));
        fs::create_dir(&dir).unwrap();
        fs::create_dir(dir.join("node_modules")).unwrap();
        fs::write(dir.join("node_modules/ignored.txt"), "needle").unwrap();
        for i in 0..count {
            fs::write(dir.join(format!("{i}.txt")), "nothing\nneedle\n").unwrap();
        }
        let output = f.ok(
            &[
                "search",
                "needle",
                "--dir",
                dir.to_str().unwrap(),
                "--max",
                "3",
            ],
            b"",
        );
        let text = String::from_utf8(output).unwrap();
        assert_eq!(text.lines().count(), 3);
        assert!(!text.contains("ignored.txt"));
    }
    let log = f.0.join("test.log");
    fs::write(&log, "old\nerror first\nnormal\nerror last\n").unwrap();
    assert!(String::from_utf8(f.ok(
        &[
            "logs",
            "--file",
            log.to_str().unwrap(),
            "--tail",
            "2",
            "--grep",
            "error"
        ],
        b""
    ))
    .unwrap()
    .contains("error last"));
    let logs_dir = f.0.join("dsh/logs");
    fs::create_dir_all(&logs_dir).unwrap();
    fs::write(logs_dir.join("named.log"), "named log\n").unwrap();
    assert!(
        String::from_utf8(f.ok(&["logs", "--file", "named.log"], b""))
            .unwrap()
            .contains("named log")
    );
    f.ok(&["settings", "set", "guard.deny", "danger*"], b"");
    assert_eq!(
        f.run(&["guard"], b"danger operation").status.code(),
        Some(2)
    );
    assert!(f.run(&["guard"], b"safe operation").status.success());
    f.ok(&["settings", "set", "search.max", "42"], b"");
    assert!(!f
        .run(&["settings", "set", "search.max", "bad"], b"")
        .status
        .success());
    assert_eq!(
        String::from_utf8(f.ok(&["settings", "get", "search.max"], b""))
            .unwrap()
            .trim(),
        "42"
    );
}

#[test]
fn web_search_gate_and_real_http_results_and_failure() {
    let f = Fixture::new();
    assert!(!f.run(&["search-web", "hello"], b"").status.success());
    for status in [200, 503] {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        listener.set_nonblocking(true).unwrap();
        f.settings(json!({"extras":{"enable":["search-web"]},"search":{"searxng_url":format!("http://127.0.0.1:{port}/fixture")}}));
        let handler = std::thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(10);
            let mut stream = loop {
                match listener.accept() {
                    Ok((stream, _)) => break stream,
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        assert!(Instant::now() < deadline, "search never connected");
                        std::thread::sleep(Duration::from_millis(10));
                    }
                    Err(e) => panic!("{e}"),
                }
            };
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut reader = BufReader::new(&stream);
            let mut first = String::new();
            reader.read_line(&mut first).unwrap();
            assert!(first.starts_with("GET /fixture/search?q=hello+%E6%97%A5%E6%9C%AC%E8%AA%9E"));
            let mut line = String::new();
            loop {
                line.clear();
                reader.read_line(&mut line).unwrap();
                if line == "\r\n" {
                    break;
                }
            }
            let body = r#"<article class="result"><h3><a href="https://example.com/a">Alpha</a></h3><p class="content">A &amp; B</p></article><article class="result"><h3><a href="https://example.com/b">Beta</a></h3></article>"#;
            write!(stream, "HTTP/1.1 {status} Fixture\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
        });
        let result = f.run(
            &["search-web", "hello 日本語", "--limit", "1", "--json"],
            b"",
        );
        handler.join().unwrap();
        if status == 200 {
            assert!(result.status.success());
            let value: Value = serde_json::from_slice(&result.stdout).unwrap();
            assert_eq!(value["results"].as_array().unwrap().len(), 1);
            assert_eq!(value["results"][0]["title"], "Alpha");
            assert_eq!(value["results"][0]["content"], "A & B");
        } else {
            assert!(!result.status.success());
            assert!(String::from_utf8_lossy(&result.stderr).contains("HTTP 503"));
        }
    }
}
