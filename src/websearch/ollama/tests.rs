use super::*;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;

fn fixture(response: String) -> (String, std::thread::JoinHandle<(String, serde_json::Value)>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let endpoint = format!("http://{}/api/web_search", listener.local_addr().unwrap());
    let handle = std::thread::spawn(move || {
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        let mut stream = loop {
            match listener.accept() {
                Ok((stream, _)) => break stream,
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    assert!(std::time::Instant::now() < deadline, "no fixture request");
                    std::thread::sleep(Duration::from_millis(5));
                }
                Err(e) => panic!("{e}"),
            }
        };
        stream.set_nonblocking(false).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        stream
            .set_write_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let mut reader = BufReader::new(&stream);
        let mut headers = String::new();
        let mut length = None;
        loop {
            let mut line = String::new();
            assert!(reader.read_line(&mut line).unwrap() > 0);
            if line == "\r\n" {
                break;
            }
            if let Some((name, value)) = line.split_once(':') {
                if name.eq_ignore_ascii_case("content-length") {
                    length = Some(value.trim().parse::<usize>().unwrap());
                }
            }
            headers.push_str(&line);
            assert!(headers.len() < 8192);
        }
        let length = length.unwrap();
        assert!(length < 8192);
        let mut body = vec![0; length];
        reader.read_exact(&mut body).unwrap();
        // An oversized response may be rejected before its body is read.
        let _ = stream.write_all(response.as_bytes());
        (headers, serde_json::from_slice(&body).unwrap())
    });
    (endpoint, handle)
}

fn response(status: u16, body: &str) -> String {
    format!("HTTP/1.1 {status} Fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len())
}

async fn run_fixture(
    raw: String,
    limit: usize,
) -> (anyhow::Result<Vec<Hit>>, String, serde_json::Value) {
    let (endpoint, server) = fixture(raw);
    let result = fetch(
        &endpoint,
        "fixture-key",
        "Rust 日本語\n\"query\"",
        limit,
        Locale::English,
        Duration::from_secs(3),
    )
    .await;
    let (headers, body) = server.join().unwrap();
    (result, headers, body)
}

#[tokio::test]
async fn posts_bearer_and_json_and_maps_results_without_html_decoding() {
    let raw = r#"{"results":[{"title":"結果 &amp; Rust","url":"https://example.invalid/a","content":"日本語 <code>"},{"title":"B","url":"https://example.invalid/b","content":""}]}"#;
    let (result, headers, body) = run_fixture(response(200, raw), 1).await;
    assert!(
        headers.starts_with("POST /api/web_search HTTP/1.1\r\n"),
        "{headers}"
    );
    let headers = headers.to_ascii_lowercase();
    assert!(headers.contains("authorization: bearer fixture-key\r\n"));
    assert!(headers.contains("content-type: application/json\r\n"));
    assert!(!headers.contains("query"));
    assert_eq!(
        body,
        serde_json::json!({"query":"Rust 日本語\n\"query\"", "max_results":1})
    );
    assert_eq!(
        result.unwrap(),
        vec![Hit {
            title: "結果 &amp; Rust".into(),
            url: "https://example.invalid/a".into(),
            content: "日本語 <code>".into(),
        }]
    );
}

#[tokio::test]
async fn caps_requested_and_returned_results_at_ten_and_keeps_order() {
    let hits: Vec<_> = (0..12).map(|n| serde_json::json!({"title":n.to_string(),"url":"https://example.invalid","content":""})).collect();
    let raw = serde_json::json!({"results":hits}).to_string();
    let (result, _, body) = run_fixture(response(200, &raw), usize::MAX).await;
    assert_eq!(body["max_results"], 10);
    let hits = result.unwrap();
    assert_eq!(hits.len(), 10);
    assert_eq!(hits[0].title, "0");
    assert_eq!(hits[9].title, "9");
    let (result, _, body) = run_fixture(response(200, r#"{"results":[]}"#), 0).await;
    assert_eq!(body["max_results"], 1);
    assert!(result.unwrap().is_empty());
}

#[tokio::test]
async fn rejects_http_errors_and_redirects_without_echoing_remote_body() {
    // Every 3xx must be returned without contacting its Location destination.
    for status in [302, 307, 400, 401, 403, 429, 500, 502] {
        let body = r#"{"error":"secret fixture-key and private query"}"#;
        let raw = response(status, body).replacen(
            "Content-Type:",
            "Location: https://example.invalid/credential-sink\r\nContent-Type:",
            1,
        );
        let (result, _, _) = run_fixture(raw, 5).await;
        let error = format!("{:#}", result.unwrap_err());
        assert!(error.contains(&format!("HTTP {status}")), "{error}");
        assert!(!error.contains("fixture-key"));
        assert!(!error.contains("private query"));
        assert!(!error.contains("credential-sink"));
    }
}

#[tokio::test]
async fn rejects_invalid_json_and_schema_instead_of_reporting_empty_results() {
    for body in [
        "not JSON",
        "{}",
        r#"{"results":null}"#,
        r#"{"results":[{"title":"missing fields"}]}"#,
        r#"{"results":[{"title":7,"url":"x","content":""}]}"#,
    ] {
        let (result, _, _) = run_fixture(response(200, body), 5).await;
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("invalid search response"));
    }
}

#[tokio::test]
async fn bounds_both_declared_and_streamed_body_sizes() {
    let raw = format!(
        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        MAX_BODY_BYTES + 1
    );
    let (result, _, _) = run_fixture(raw, 5).await;
    assert!(result.unwrap_err().to_string().contains("2 MiB"));
    let raw = format!(
        "HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n{}",
        " ".repeat(MAX_BODY_BYTES + 1)
    );
    let (result, _, _) = run_fixture(raw, 5).await;
    assert!(result.unwrap_err().to_string().contains("2 MiB"));
}

#[tokio::test]
async fn validates_keys_before_connecting_and_localizes_errors() {
    for (locale, expected) in [
        (Locale::English, "set a valid"),
        (Locale::Chinese, "请设置有效"),
        (Locale::Japanese, "設定してください"),
    ] {
        for key in ["", "  ", "secret\r\nInjected: value", "secret token"] {
            let error = fetch(
                "http://127.0.0.1:1",
                key,
                "private",
                5,
                locale,
                Duration::from_secs(1),
            )
            .await
            .unwrap_err()
            .to_string();
            assert!(error.contains(expected), "{error}");
            assert!(!error.contains("secret"), "{error}");
            assert!(!error.contains("private"), "{error}");
        }
    }
}

#[tokio::test]
async fn total_timeout_covers_a_stalled_response() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}/api/web_search", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        tokio::time::sleep(Duration::from_secs(5)).await;
        drop(stream);
    });
    let result = fetch(
        &endpoint,
        "fixture-key",
        "private",
        5,
        Locale::English,
        Duration::from_millis(100),
    )
    .await;
    server.abort();
    let error = result.unwrap_err().to_string();
    assert!(error.contains("timed out"), "{error}");
    assert!(!error.contains("fixture-key"));
}
