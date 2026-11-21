use super::*;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::thread::JoinHandle;
use std::time::Instant;

struct Endpoints {
    keyed: String,
    public: String,
}

fn fixture(response: String) -> (Endpoints, JoinHandle<(String, serde_json::Value)>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let endpoints = Endpoints {
        keyed: format!("{base}/v1/search"),
        public: format!("{base}/v1/search/public"),
    };
    let handle = std::thread::spawn(move || {
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        let mut stream = loop {
            match listener.accept() {
                Ok((stream, _)) => break stream,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    assert!(std::time::Instant::now() < deadline, "no fixture request");
                    std::thread::sleep(Duration::from_millis(5));
                }
                Err(error) => panic!("{error}"),
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
        let _ = stream.write_all(response.as_bytes());
        (headers, serde_json::from_slice(&body).unwrap())
    });
    (endpoints, handle)
}

fn response(status: u16, body: &str) -> String {
    format!(
        "HTTP/1.1 {status} Fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
}

fn accept_request(listener: &TcpListener, deadline: Instant) -> Option<TcpStream> {
    loop {
        match listener.accept() {
            Ok((stream, _)) => {
                stream.set_nonblocking(false).unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                stream
                    .set_write_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                return Some(stream);
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                if Instant::now() >= deadline {
                    return None;
                }
                std::thread::sleep(Duration::from_millis(5));
            }
            Err(error) => panic!("{error}"),
        }
    }
}

fn read_request(stream: &TcpStream) -> (String, serde_json::Value) {
    let mut reader = BufReader::new(stream);
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
    (headers, serde_json::from_slice(&body).unwrap())
}

fn sequence_fixture(
    responses: Vec<String>,
) -> (String, JoinHandle<Vec<(String, serde_json::Value)>>) {
    sequence_fixture_with_timeout(responses, Duration::from_secs(3))
}

fn sequence_fixture_with_timeout(
    responses: Vec<String>,
    timeout: Duration,
) -> (String, JoinHandle<Vec<(String, serde_json::Value)>>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let endpoint = format!("http://{}/v1/search/public", listener.local_addr().unwrap());
    let server = std::thread::spawn(move || {
        let deadline = Instant::now() + timeout;
        let mut requests = Vec::new();
        for response in responses {
            let Some(mut stream) = accept_request(&listener, deadline) else {
                break;
            };
            let request = read_request(&stream);
            let _ = stream.write_all(response.as_bytes());
            requests.push(request);
        }
        requests
    });
    (endpoint, server)
}

fn delayed_fixture(delay: Duration) -> (String, JoinHandle<(String, serde_json::Value)>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let endpoint = format!("http://{}/v1/search/public", listener.local_addr().unwrap());
    let server = std::thread::spawn(move || {
        let stream = accept_request(&listener, Instant::now() + Duration::from_secs(3))
            .expect("no fixture request");
        let request = read_request(&stream);
        let response_body = r#"{"results":[{"title":"late","url":"https://example.invalid/late","snippet":"remote-secret"}]}"#;
        let response_headers = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            response_body.len()
        );
        let mut stream = stream;
        stream.write_all(response_headers.as_bytes()).unwrap();
        stream.flush().unwrap();
        std::thread::sleep(delay);
        let _ = stream.write_all(response_body.as_bytes());
        request
    });
    (endpoint, server)
}

fn response_with_retry_after(status: u16, body: &str, retry_after: Option<&str>) -> String {
    let response = response(status, body);
    match retry_after {
        Some(seconds) => response.replacen(
            "Content-Type:",
            &format!("Retry-After: {seconds}\r\nContent-Type:"),
            1,
        ),
        None => response,
    }
}

async fn run_fixture(
    raw: String,
    key: Option<&str>,
    limit: usize,
) -> (anyhow::Result<Vec<Hit>>, String, serde_json::Value) {
    let (endpoints, server) = fixture(raw);
    let endpoint = if key.is_some() {
        &endpoints.keyed
    } else {
        &endpoints.public
    };
    let result = fetch(
        endpoint,
        key,
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
async fn keyless_posts_public_path_and_uses_snippet_not_deprecated_description() {
    let raw = r#"{"results":[{"title":"日本語","url":"https://example.invalid/a","snippet":"正しい snippet","description":"deprecated text"}]}"#;
    let (result, headers, body) = run_fixture(response(200, raw), None, 7).await;
    assert!(
        headers.starts_with("POST /v1/search/public HTTP/1.1\r\n"),
        "{headers}"
    );
    let headers = headers.to_ascii_lowercase();
    assert!(headers.contains("x-keenable-title: rdsh\r\n"));
    assert!(headers.contains("content-type: application/json\r\n"));
    assert!(!headers.contains("x-api-key:"));
    assert_eq!(
        body,
        serde_json::json!({"query":"Rust 日本語\n\"query\"", "max_results":7})
    );
    assert_eq!(result.unwrap()[0].content, "正しい snippet");
}

#[tokio::test]
async fn keyed_posts_private_path_and_never_sends_public_title() {
    let raw = r#"{"results":[{"title":"A","url":"https://example.invalid/a","snippet":"text"}]}"#;
    let (result, headers, body) = run_fixture(response(200, raw), Some("fixture-key"), 3).await;
    assert!(
        headers.starts_with("POST /v1/search HTTP/1.1\r\n"),
        "{headers}"
    );
    let headers = headers.to_ascii_lowercase();
    assert!(headers.contains("x-api-key: fixture-key\r\n"));
    assert!(!headers.contains("x-keenable-title:"));
    assert_eq!(body["max_results"], 3);
    assert_eq!(result.unwrap()[0].title, "A");
}

#[tokio::test]
async fn requested_and_returned_result_counts_stay_within_api_range() {
    let results: Vec<_> = (0..55)
        .map(|index| serde_json::json!({"title":index.to_string(),"url":"https://example.invalid","snippet":""}))
        .collect();
    let body = serde_json::json!({"results":results}).to_string();
    let (result, _, request) = run_fixture(response(200, &body), None, usize::MAX).await;
    assert_eq!(request["max_results"], 50);
    let hits = result.unwrap();
    assert_eq!(hits.len(), 50);
    assert_eq!(hits[0].title, "0");
    assert_eq!(hits[49].title, "49");

    let (result, _, request) = run_fixture(response(200, r#"{"results":[]}"#), None, 0).await;
    assert_eq!(request["max_results"], 1);
    assert!(result.unwrap().is_empty());
}

#[tokio::test]
async fn rejects_http_errors_redirects_and_remote_body_without_following_or_echoing() {
    for status in [302, 401, 403, 429, 500] {
        let raw = response(
            status,
            r#"{"error":"fixture-key private query remote-secret"}"#,
        )
        .replacen(
            "Content-Type:",
            "Location: /credential-sink\r\nContent-Type:",
            1,
        );
        let raw = if status == 500 {
            raw.replacen("Content-Type:", "Retry-After: 61\r\nContent-Type:", 1)
        } else {
            raw
        };
        let (result, _, _) = run_fixture(raw, Some("fixture-key"), 5).await;
        let error = format!("{:#}", result.unwrap_err());
        assert!(error.contains(&format!("HTTP {status}")), "{error}");
        for secret in [
            "fixture-key",
            "private query",
            "remote-secret",
            "credential-sink",
        ] {
            assert!(!error.contains(secret), "{error}");
        }
    }
}

#[tokio::test]
async fn rejects_invalid_json_and_schema_with_localized_errors() {
    for body in [
        "not JSON",
        "{}",
        r#"{"results":null}"#,
        r#"{"results":[{"title":"missing fields"}]}"#,
        r#"{"results":[{"title":7,"url":"x","snippet":""}]}"#,
    ] {
        let (result, _, _) = run_fixture(response(200, body), None, 5).await;
        let error = result.unwrap_err().to_string();
        assert!(error.contains("invalid"), "{error}");
    }
    for (locale, expected) in [
        (Locale::English, "query, IP address, and app title"),
        (Locale::Chinese, "查询、IP 地址和应用标题"),
        (Locale::Japanese, "検索語、IP アドレス、アプリ名"),
    ] {
        let error = message(locale, "fixture").to_string();
        assert!(error.contains(expected), "{error}");
    }
}

#[tokio::test]
async fn rejects_declared_and_streamed_responses_over_two_mib() {
    let oversized = format!(
        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        MAX_BODY_BYTES + 1
    );
    let (result, _, _) = run_fixture(oversized, None, 5).await;
    assert!(result.unwrap_err().to_string().contains("2 MiB"));

    let oversized = format!(
        "HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n{}",
        " ".repeat(MAX_BODY_BYTES + 1)
    );
    let (result, _, _) = run_fixture(oversized, None, 5).await;
    assert!(result.unwrap_err().to_string().contains("2 MiB"));
}

#[tokio::test]
async fn rejects_invalid_key_header_without_sending_request_or_echoing_it() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let endpoint = format!("http://{}/v1/search", listener.local_addr().unwrap());
    let key = "fixture-secret\r\nInjected: value";
    let error = fetch(
        &endpoint,
        Some(key),
        "private query",
        5,
        Locale::English,
        Duration::from_secs(3),
    )
    .await
    .unwrap_err()
    .to_string();
    assert!(error.contains("KEENABLE_API_KEY"), "{error}");
    assert!(!error.contains("fixture-secret"));
    assert!(!error.contains("private query"));
    assert_eq!(
        listener.accept().unwrap_err().kind(),
        std::io::ErrorKind::WouldBlock
    );
}

#[tokio::test]
async fn retries_429_once_after_retry_after_and_returns_success() {
    let success =
        r#"{"results":[{"title":"A","url":"https://example.invalid/a","snippet":"retried"}]}"#;
    let (endpoint, server) = sequence_fixture(vec![
        response_with_retry_after(
            429,
            r#"{"error":"rate_limited","message":"fixture-secret private query remote-secret"}"#,
            Some("1"),
        ),
        response(200, success),
    ]);
    let started = Instant::now();
    let result = fetch(
        &endpoint,
        None,
        "private query",
        5,
        Locale::English,
        Duration::from_secs(3),
    )
    .await;
    let elapsed = started.elapsed();
    let requests = server.join().unwrap();

    assert_eq!(requests.len(), 2, "{requests:?}");
    assert!(
        elapsed >= Duration::from_millis(900),
        "waited only {elapsed:?}"
    );
    assert_eq!(requests[0].1, requests[1].1);
    assert!(requests
        .iter()
        .all(|(headers, _)| headers.starts_with("POST /v1/search/public HTTP/1.1\r\n")));
    assert_eq!(result.unwrap()[0].content, "retried");
}

#[tokio::test]
async fn stops_after_second_429_and_reports_the_server_wait_without_echoing_data() {
    let remote_error =
        r#"{"error":"rate_limited","message":"fixture-secret private query remote-secret"}"#;
    let (endpoint, server) = sequence_fixture(vec![
        response_with_retry_after(429, remote_error, Some("0")),
        response_with_retry_after(429, remote_error, Some("7")),
    ]);
    let result = fetch(
        &endpoint,
        None,
        "private query",
        5,
        Locale::English,
        Duration::from_secs(3),
    )
    .await;
    let requests = server.join().unwrap();
    assert_eq!(requests.len(), 2, "{requests:?}");
    let error = result.unwrap_err().to_string();
    assert!(error.contains("HTTP 429"), "{error}");
    assert!(error.contains("7 seconds"), "{error}");
    for secret in ["fixture-secret", "private query", "remote-secret"] {
        assert!(!error.contains(secret), "{error}");
    }
}

#[tokio::test]
async fn insufficient_credits_402_stops_without_retry_or_remote_details() {
    let remote_error =
        r#"{"error":"insufficient_credits","message":"fixture-key private query remote-secret"}"#;
    let (endpoint, server) = sequence_fixture(vec![response_with_retry_after(
        402,
        remote_error,
        Some("0"),
    )]);
    let result = fetch(
        &endpoint,
        Some("fixture-key"),
        "private query",
        5,
        Locale::English,
        Duration::from_secs(3),
    )
    .await;
    let requests = server.join().unwrap();
    assert_eq!(requests.len(), 1, "{requests:?}");
    let error = result.unwrap_err().to_string();
    assert!(error.contains("402"), "{error}");
    assert!(error.contains("insufficient_credits"), "{error}");
    for secret in ["fixture-key", "private query", "remote-secret"] {
        assert!(!error.contains(secret), "{error}");
    }
}

#[tokio::test]
async fn missing_invalid_or_excessive_retry_after_never_retries_early() {
    for (retry_after, expected_wait) in [
        (None, "60 seconds"),
        (Some("not-seconds"), "60 seconds"),
        (Some("+1"), "60 seconds"),
        (Some("61"), "61 seconds"),
    ] {
        let remote_error =
            r#"{"error":"rate_limited","message":"fixture-secret private query remote-secret"}"#;
        let (endpoint, server) = sequence_fixture(vec![response_with_retry_after(
            429,
            remote_error,
            retry_after,
        )]);
        let result = fetch(
            &endpoint,
            None,
            "private query",
            5,
            Locale::English,
            Duration::from_secs(3),
        )
        .await;
        let requests = server.join().unwrap();
        assert_eq!(requests.len(), 1, "{requests:?}");
        let error = result.unwrap_err().to_string();
        assert!(error.contains("HTTP 429"), "{error}");
        assert!(error.contains(expected_wait), "{error}");
        for secret in ["fixture-secret", "private query", "remote-secret"] {
            assert!(!error.contains(secret), "{error}");
        }
    }
}

#[tokio::test]
async fn retries_500_with_bounded_exponential_backoff_when_retry_after_is_missing() {
    let remote_error =
        r#"{"error":"server_error","message":"fixture-secret private query remote-secret"}"#;
    let success =
        r#"{"results":[{"title":"A","url":"https://example.invalid/a","snippet":"recovered"}]}"#;
    let (endpoint, server) =
        sequence_fixture(vec![response(500, remote_error), response(200, success)]);
    let started = Instant::now();
    let result = fetch(
        &endpoint,
        None,
        "private query",
        5,
        Locale::English,
        Duration::from_secs(3),
    )
    .await;
    let elapsed = started.elapsed();
    let requests = server.join().unwrap();

    assert_eq!(requests.len(), 2, "{requests:?}");
    assert!(
        elapsed >= Duration::from_millis(900),
        "waited only {elapsed:?}"
    );
    assert_eq!(result.unwrap()[0].content, "recovered");
}

#[tokio::test]
async fn honors_retry_after_on_503_and_529_instead_of_shorter_backoff() {
    let remote_error =
        r#"{"error":"server_error","message":"fixture-secret private query remote-secret"}"#;
    let success =
        r#"{"results":[{"title":"A","url":"https://example.invalid/a","snippet":"recovered"}]}"#;
    for status in [503, 529] {
        let (endpoint, server) = sequence_fixture(vec![
            response_with_retry_after(status, remote_error, Some("2")),
            response(200, success),
        ]);
        let started = Instant::now();
        let result = fetch(
            &endpoint,
            None,
            "private query",
            5,
            Locale::English,
            Duration::from_secs(3),
        )
        .await;
        let elapsed = started.elapsed();
        let requests = server.join().unwrap();

        assert_eq!(requests.len(), 2, "status {status}: {requests:?}");
        assert!(
            elapsed >= Duration::from_millis(1900),
            "status {status} waited only {elapsed:?}"
        );
        assert_eq!(result.unwrap()[0].content, "recovered");
    }
}

#[tokio::test]
async fn retry_after_zero_does_not_shorten_503_and_529_backoff_floor() {
    let remote_error =
        r#"{"error":"server_error","message":"fixture-secret private query remote-secret"}"#;
    let success =
        r#"{"results":[{"title":"A","url":"https://example.invalid/a","snippet":"recovered"}]}"#;
    for status in [503, 529] {
        let (endpoint, server) = sequence_fixture(vec![
            response_with_retry_after(status, remote_error, Some("0")),
            response(200, success),
        ]);
        let started = Instant::now();
        let result = fetch(
            &endpoint,
            None,
            "private query",
            5,
            Locale::English,
            Duration::from_secs(3),
        )
        .await;
        let elapsed = started.elapsed();
        let requests = server.join().unwrap();

        assert_eq!(requests.len(), 2, "status {status}: {requests:?}");
        assert!(
            elapsed >= Duration::from_millis(900),
            "status {status} waited only {elapsed:?}"
        );
        assert_eq!(result.unwrap()[0].content, "recovered");
    }
}

#[test]
fn retry_after_is_a_floor_for_each_server_error_backoff_step() {
    for (retries, backoff_floor) in SERVER_ERROR_BACKOFF_SECONDS.iter().copied().enumerate() {
        assert_eq!(server_error_wait_seconds(retries, None), backoff_floor);
        assert_eq!(server_error_wait_seconds(retries, Some(0)), backoff_floor);
        assert_eq!(
            server_error_wait_seconds(retries, Some(backoff_floor.saturating_sub(1))),
            backoff_floor
        );
        assert_eq!(
            server_error_wait_seconds(retries, Some(backoff_floor + 1)),
            backoff_floor + 1
        );
    }
    assert_eq!(server_error_wait_seconds(0, Some(2)), 2);
}

#[tokio::test]
async fn stops_after_three_5xx_retries() {
    let remote_error =
        r#"{"error":"server_error","message":"fixture-secret private query remote-secret"}"#;
    let responses = (0..4)
        .map(|_| response_with_retry_after(500, remote_error, Some("0")))
        .collect();
    let (endpoint, server) = sequence_fixture_with_timeout(responses, Duration::from_secs(12));
    let result = fetch(
        &endpoint,
        None,
        "private query",
        5,
        Locale::English,
        Duration::from_secs(3),
    )
    .await;
    let requests = server.join().unwrap();

    assert_eq!(
        requests.len(),
        4,
        "initial attempt plus three retries: {requests:?}"
    );
    let error = result.unwrap_err().to_string();
    assert!(error.contains("HTTP 500"), "{error}");
    assert!(error.contains("3 retries"), "{error}");
    for secret in ["fixture-secret", "private query", "remote-secret"] {
        assert!(!error.contains(secret), "{error}");
    }
}

#[tokio::test]
async fn overflow_retry_after_stops_5xx_and_429_without_echoing_large_value() {
    let overflow = "18446744073709551616";
    let remote_error =
        r#"{"error":"server_error","message":"fixture-secret private query remote-secret"}"#;
    let success = r#"{"results":[]}"#;
    for status in [503, 429] {
        let (endpoint, server) = sequence_fixture_with_timeout(
            vec![
                response_with_retry_after(status, remote_error, Some(overflow)),
                response(200, success),
            ],
            Duration::from_secs(2),
        );
        let result = fetch(
            &endpoint,
            None,
            "private query",
            5,
            Locale::English,
            Duration::from_secs(3),
        )
        .await;
        let requests = server.join().unwrap();

        assert_eq!(requests.len(), 1, "status {status}: {requests:?}");
        let error = result.unwrap_err().to_string();
        assert!(error.contains(&format!("HTTP {status}")), "{error}");
        assert!(
            error.contains("No further automatic retry will be made"),
            "{error}"
        );
        assert!(error.contains("full Retry-After delay"), "{error}");
        assert!(!error.contains(overflow), "{error}");
        for secret in ["fixture-secret", "private query", "remote-secret"] {
            assert!(!error.contains(secret), "{error}");
        }
    }
}

#[tokio::test]
async fn does_not_shorten_excessive_529_retry_after() {
    let remote_error =
        r#"{"error":"server_error","message":"fixture-secret private query remote-secret"}"#;
    let (endpoint, server) = sequence_fixture(vec![response_with_retry_after(
        529,
        remote_error,
        Some("61"),
    )]);
    let result = fetch(
        &endpoint,
        None,
        "private query",
        5,
        Locale::English,
        Duration::from_secs(3),
    )
    .await;
    let requests = server.join().unwrap();

    assert_eq!(requests.len(), 1, "{requests:?}");
    let error = result.unwrap_err().to_string();
    assert!(error.contains("HTTP 529"), "{error}");
    assert!(error.contains("61 seconds"), "{error}");
    for secret in ["fixture-secret", "private query", "remote-secret"] {
        assert!(!error.contains(secret), "{error}");
    }
}

#[tokio::test]
async fn injected_short_timeout_fails_on_a_delayed_response_body() {
    let (endpoint, server) = delayed_fixture(Duration::from_millis(700));
    let result = fetch(
        &endpoint,
        None,
        "private query",
        5,
        Locale::English,
        Duration::from_millis(150),
    )
    .await;
    let error = result.unwrap_err().to_string();
    let request = server.join().unwrap();

    assert_eq!(request.1["query"], "private query");
    assert!(error.contains("timed out"), "{error}");
    for secret in ["private query", "remote-secret", "fixture-key"] {
        assert!(!error.contains(secret), "{error}");
    }
}

#[test]
fn request_timeout_is_fifteen_seconds() {
    assert_eq!(REQUEST_TIMEOUT, Duration::from_secs(15));
}
