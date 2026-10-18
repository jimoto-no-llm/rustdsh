//! CLI selection/gating tests never call the hosted API or use real credentials.
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::path::PathBuf;
use std::process::{Command, Output};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

static NEXT: AtomicUsize = AtomicUsize::new(0);

struct Fixture(PathBuf);

impl Fixture {
    fn new(enabled: bool) -> Self {
        let path = std::env::temp_dir().join(format!(
            "rdsh-web-provider-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(path.join("dsh")).unwrap();
        fs::write(
            path.join("dsh/rdsh.json"),
            serde_json::json!({"features":{"search-web":enabled}}).to_string(),
        )
        .unwrap();
        Self(path)
    }

    fn command(&self, language: &str, args: &[&str]) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_rdsh"));
        command.env_clear();
        for name in ["PATH", "SystemRoot", "WINDIR", "COMSPEC", "TEMP", "TMP"] {
            if let Some(value) = std::env::var_os(name) {
                command.env(name, value);
            }
        }
        command
            .current_dir(&self.0)
            .env("HOME", &self.0)
            .env("USERPROFILE", &self.0)
            .env("DSH_HOME", self.0.join("dsh"))
            .args(["--language", language, "search-web"])
            .args(args);
        command
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn failed(output: Output) -> String {
    assert!(!output.status.success(), "{output:?}");
    assert!(output.stdout.is_empty(), "{output:?}");
    String::from_utf8(output.stderr).unwrap()
}

#[test]
fn disabled_search_stays_gated_even_with_an_ollama_key() {
    let fixture = Fixture::new(false);
    let output = fixture
        .command("en", &["private query", "--provider", "ollama", "--json"])
        .env("OLLAMA_API_KEY", "fixture-key-never-send")
        .output()
        .unwrap();
    let error = failed(output);
    assert!(error.contains("disabled"), "{error}");
    assert!(!error.contains("fixture-key-never-send"));
    assert!(!error.contains("HTTP"));
}

#[test]
fn missing_or_malformed_keys_fail_locally_in_each_language() {
    let fixture = Fixture::new(true);
    for (language, expected) in [
        ("en", "set a valid"),
        ("zh-CN", "请设置有效"),
        ("ja", "設定してください"),
    ] {
        for key in [None, Some(""), Some("fixture-secret\r\nInjected: value")] {
            let mut command = fixture.command(
                language,
                &["private query", "--provider", "ollama", "--json"],
            );
            if let Some(key) = key {
                command.env("OLLAMA_API_KEY", key);
            }
            let error = failed(command.output().unwrap());
            assert!(error.contains("OLLAMA_API_KEY"), "{error}");
            assert!(error.contains(expected), "{error}");
            assert!(!error.contains("fixture-secret"), "{error}");
            assert!(!error.contains("private query"), "{error}");
        }
    }
}

#[test]
fn unknown_provider_is_rejected_and_help_lists_both_choices() {
    let fixture = Fixture::new(true);
    for language in ["en", "zh-CN", "ja"] {
        let error = failed(
            fixture
                .command(language, &["query", "--provider", "unknown"])
                .output()
                .unwrap(),
        );
        assert!(error.contains("searxng"), "{error}");
        assert!(error.contains("ollama"), "{error}");
        let output = fixture.command(language, &["--help"]).output().unwrap();
        assert!(output.status.success(), "{output:?}");
        let help = String::from_utf8(output.stdout).unwrap();
        for text in [
            "--provider",
            "searxng",
            "ollama",
            "OLLAMA_API_KEY",
            "https://www.tavily.com/",
            "https://docs.tavily.com/documentation/quickstart",
        ] {
            assert!(help.contains(text), "{help}");
        }
    }
}

#[test]
fn default_searxng_is_unchanged_by_an_ambient_ollama_key() {
    let fixture = Fixture::new(true);
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let server = std::thread::spawn(move || {
        for _ in 0..2 {
            let deadline = Instant::now() + Duration::from_secs(5);
            let mut stream = loop {
                match listener.accept() {
                    Ok((stream, _)) => break stream,
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        assert!(Instant::now() < deadline, "no SearXNG request");
                        std::thread::sleep(Duration::from_millis(5));
                    }
                    Err(e) => panic!("{e}"),
                }
            };
            stream.set_nonblocking(false).unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut reader = BufReader::new(&stream);
            let mut request = String::new();
            loop {
                let mut line = String::new();
                assert!(reader.read_line(&mut line).unwrap() > 0);
                if line == "\r\n" {
                    break;
                }
                request.push_str(&line);
                assert!(request.len() < 8192);
            }
            assert!(request.starts_with("GET /search?q=hello+world HTTP/1.0"));
            assert!(!request.to_ascii_lowercase().contains("authorization"));
            assert!(!request.contains("fixture-key-never-send"));
            let body = "<article class=\"result\"><a href=\"https://example.invalid/a\">Alpha</a><p class=\"content\">A &amp; B</p></article>";
            write!(
                stream,
                "HTTP/1.0 200 OK\r\nContent-Length: {}\r\n\r\n{body}",
                body.len()
            )
            .unwrap();
        }
    });
    let mut results = Vec::new();
    for args in [
        &["hello world", "--json"][..],
        &["hello world", "--json", "--provider", "searxng"],
    ] {
        let output = fixture
            .command("en", args)
            .env("SEARXNG_URL", &base)
            .env("OLLAMA_API_KEY", "fixture-key-never-send")
            .output()
            .unwrap();
        assert!(output.status.success(), "{output:?}");
        results.push(serde_json::from_slice::<serde_json::Value>(&output.stdout).unwrap());
    }
    server.join().unwrap();
    assert_eq!(results[0], results[1]);
    assert_eq!(
        results[0],
        serde_json::json!({"query":"hello world","engine":base,"results":[{"title":"Alpha","url":"https://example.invalid/a","content":"A & B"}]})
    );
}

#[test]
fn auto_start_is_advertised_and_a_remote_base_starts_nothing() {
    let fixture = Fixture::new(true);
    for language in ["en", "zh-CN", "ja"] {
        let output = fixture.command(language, &["--help"]).output().unwrap();
        assert!(output.status.success(), "{output:?}");
        let help = String::from_utf8(output.stdout).unwrap();
        assert!(help.contains("--auto-start"), "{help}");
    }
    // A non-loopback endpoint is never served by a local container: the run
    // reports the connection failure instead of looking for a compose file.
    for language in ["en", "ja"] {
        let output = fixture
            .command(language, &["query", "--auto-start"])
            .env("SEARXNG_URL", "http://searx.example.invalid:8888")
            .env("RDSH_SEARXNG_COMPOSE_FILE", fixture.0.join("missing.yml"))
            .output()
            .unwrap();
        let error = failed(output);
        assert!(!error.contains("panic"), "{error}");
        assert!(!error.contains("container runtime"), "{error}");
        assert!(!error.contains("コンテナランタイム"), "{error}");
    }
}
