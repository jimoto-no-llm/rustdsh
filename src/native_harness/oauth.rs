//! Inference-only OAuth transport. No DSH, CLI, or SDK process is started.
use crate::auth::native_oauth::{now_ms, Grant};
use anyhow::{bail, Result};
use serde_json::{json, Value};
use std::time::Duration;

const LIMIT: usize = 8 * 1024 * 1024;

/// OAuth tokens must never follow a profile's custom base URL to another origin.
pub(super) fn supported(provider: &str, api: &str, base: &str) -> bool {
    match provider {
        "openai-codex" => {
            api == "openai-codex-responses"
                && matches!(
                    base.trim_end_matches('/'),
                    "https://chatgpt.com/backend-api" | "https://chatgpt.com/backend-api/codex"
                )
        }
        _ => false,
    }
}

pub(super) async fn generate_with_usage(
    grant: &Grant,
    provider: &str,
    model: &str,
    prompt: &str,
) -> Result<super::usage::Generation> {
    let endpoint = match provider {
        "openai-codex" => "https://chatgpt.com/backend-api/codex/responses",
        _ => bail!("NATIVE_OAUTH_PROVIDER_UNSUPPORTED"),
    };
    generate_at(grant, provider, model, prompt, endpoint).await
}

async fn generate_at(
    grant: &Grant,
    provider: &str,
    model: &str,
    prompt: &str,
    endpoint: &str,
) -> Result<super::usage::Generation> {
    if grant.expires <= now_ms().saturating_add(30_000) {
        bail!("NATIVE_OAUTH_EXPIRED");
    }
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(180))
        .build()
        .map_err(|_| anyhow::anyhow!("NATIVE_OAUTH_HTTP_SETUP_FAILED"))?;
    let mut request = client
        .post(endpoint)
        .bearer_auth(&grant.access)
        .header("content-type", "application/json")
        .header("user-agent", concat!("rdsh/", env!("CARGO_PKG_VERSION")));
    let body = match provider {
        "openai-codex" => {
            let account = grant
                .account_id
                .as_deref()
                .ok_or_else(|| anyhow::anyhow!("NATIVE_OAUTH_ACCOUNT_REQUIRED"))?;
            request = request
                .header("chatgpt-account-id", account)
                .header("OpenAI-Beta", "responses=experimental")
                .header("accept", "text/event-stream");
            // The subscription Responses endpoint requires streaming and store=false;
            // it does not accept max_output_tokens. Rust validates the final JSON turn.
            json!({"model":model,"store":false,"stream":true,
                "instructions":"Follow the response format in the user request.",
                "input":[{"role":"user","content":[{"type":"input_text","text":prompt}]}]})
        }
        _ => bail!("NATIVE_OAUTH_PROVIDER_UNSUPPORTED"),
    };
    let mut response = request
        .body(serde_json::to_vec(&body)?)
        .send()
        .await
        .map_err(|_| anyhow::anyhow!("NATIVE_OAUTH_HTTP_REQUEST_FAILED"))?;
    if !response.status().is_success() {
        // Never render provider error bodies: they may echo credentials or prompts.
        bail!("NATIVE_OAUTH_HTTP_STATUS_{}", response.status().as_u16());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| anyhow::anyhow!("NATIVE_OAUTH_HTTP_READ_FAILED"))?
    {
        if bytes.len().saturating_add(chunk.len()) > LIMIT {
            bail!("NATIVE_OAUTH_OUTPUT_LIMIT");
        }
        bytes.extend_from_slice(&chunk);
    }
    codex_generation(&bytes)
}

fn content_text(content: &Value) -> Result<String> {
    let blocks = content
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("NATIVE_OAUTH_INVALID_RESPONSE"))?;
    let mut text = String::new();
    for block in blocks {
        if matches!(block["type"].as_str(), Some("text" | "output_text")) {
            text.push_str(
                block["text"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("NATIVE_OAUTH_INVALID_RESPONSE"))?,
            );
        } else {
            bail!("NATIVE_OAUTH_UNEXPECTED_CONTENT");
        }
    }
    if text.is_empty() {
        bail!("NATIVE_OAUTH_EMPTY_RESPONSE");
    }
    Ok(text)
}

#[cfg(test)]
fn codex_text(bytes: &[u8]) -> Result<String> {
    Ok(codex_generation(bytes)?.text)
}
fn codex_generation(bytes: &[u8]) -> Result<super::usage::Generation> {
    let stream =
        std::str::from_utf8(bytes).map_err(|_| anyhow::anyhow!("NATIVE_OAUTH_INVALID_RESPONSE"))?;
    let normalized = stream.replace("\r\n", "\n");
    let mut result = None;
    for frame in normalized.split("\n\n") {
        let data = frame
            .lines()
            .filter_map(|l| {
                l.strip_prefix("data:")
                    .map(|s| s.strip_prefix(' ').unwrap_or(s))
            })
            .collect::<Vec<_>>()
            .join("\n");
        if data.is_empty() || data == "[DONE]" {
            continue;
        }
        let event: Value = serde_json::from_str(&data)
            .map_err(|_| anyhow::anyhow!("NATIVE_OAUTH_INVALID_STREAM"))?;
        match event["type"].as_str() {
            Some("response.completed") => {
                if result.is_some() || event["response"]["status"] != "completed" {
                    bail!("NATIVE_OAUTH_INVALID_STREAM");
                }
                let output = event["response"]["output"]
                    .as_array()
                    .ok_or_else(|| anyhow::anyhow!("NATIVE_OAUTH_INVALID_STREAM"))?;
                let mut text = String::new();
                for item in output {
                    match item["type"].as_str() {
                        Some("message") => text.push_str(&content_text(&item["content"])?),
                        Some("reasoning") => {}
                        _ => bail!("NATIVE_OAUTH_UNEXPECTED_CONTENT"),
                    }
                }
                if text.is_empty() {
                    bail!("NATIVE_OAUTH_EMPTY_RESPONSE");
                }
                result = Some(super::usage::Generation {
                    text,
                    usage: super::usage::Usage::parse("openai-responses", &event["response"]),
                });
            }
            Some("response.failed" | "response.incomplete" | "error") => {
                bail!("NATIVE_OAUTH_INCOMPLETE_RESPONSE")
            }
            _ => {}
        }
    }
    result.ok_or_else(|| anyhow::anyhow!("NATIVE_OAUTH_INCOMPLETE_RESPONSE"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn final_sse_event_supplies_actual_usage() {
        let event = json!({"type":"response.completed","response":{"status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"ok"}]}],"usage":{"input_tokens":100,"output_tokens":9,"input_tokens_details":{"cached_tokens":70}}}});
        let result = codex_generation(format!("data: {event}\n\n").as_bytes()).unwrap();
        assert_eq!(result.usage.input_tokens, Some(100));
        assert_eq!(result.usage.cache_read_tokens, Some(70));
    }
    #[test]
    fn subscription_tokens_are_pinned_to_provider_origin_and_protocol() {
        assert!(supported(
            "openai-codex",
            "openai-codex-responses",
            "https://chatgpt.com/backend-api/codex"
        ));
        assert!(!supported(
            "anthropic",
            "anthropic-messages",
            "https://api.anthropic.com/v1/"
        ));
        for base in [
            "http://api.anthropic.com",
            "https://api.anthropic.com.evil.invalid",
            "https://api.anthropic.com/v1?x=1",
            "https://user@api.anthropic.com/v1",
        ] {
            assert!(!supported("anthropic", "anthropic-messages", base));
        }
        assert!(!supported(
            "other",
            "anthropic-messages",
            "https://api.anthropic.com"
        ));
    }
    #[test]
    fn sse_requires_successful_terminal_response_not_partial_deltas() {
        let partial = "data: {\"type\":\"response.output_text.delta\",\"delta\":\"partial\"}\n\n";
        assert!(codex_text(partial.as_bytes()).is_err());
        let final_event = json!({"type":"response.completed","response":{"status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"final"}]}]}});
        let stream = format!("{partial}data: {final_event}\r\n\r\ndata: [DONE]\r\n\r\n");
        assert_eq!(codex_text(stream.as_bytes()).unwrap(), "final");
        assert!(codex_text(stream.replace("completed", "incomplete").as_bytes()).is_err());
        assert!(codex_text(b"data: {not-json}\n\n").is_err());
        assert!(
            codex_text(format!("{stream}data: {{\"type\":\"error\"}}\n\n").as_bytes()).is_err()
        );
    }
    #[tokio::test]
    async fn codex_http_uses_bearer_account_and_sse_without_echoing_errors_or_redirecting() {
        use std::io::{Read, Write};
        for status in [200, 401, 302] {
            let listener = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).unwrap();
            listener.set_nonblocking(true).unwrap();
            let endpoint = format!(
                "http://127.0.0.1:{}/responses",
                listener.local_addr().unwrap().port()
            );
            let thread = std::thread::spawn(move || {
                let start = std::time::Instant::now();
                let (mut stream, _) = loop {
                    match listener.accept() {
                        Ok(connection) => break connection,
                        Err(e)
                            if e.kind() == std::io::ErrorKind::WouldBlock
                                && start.elapsed() < Duration::from_secs(5) =>
                        {
                            std::thread::sleep(Duration::from_millis(5))
                        }
                        Err(e) => panic!("mock accept: {e}"),
                    }
                };
                stream.set_nonblocking(false).unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut request = Vec::new();
                let (headers, body) = loop {
                    let mut chunk = [0; 4096];
                    let n = stream.read(&mut chunk).unwrap();
                    assert!(n > 0);
                    request.extend_from_slice(&chunk[..n]);
                    if let Some(end) = request.windows(4).position(|w| w == b"\r\n\r\n") {
                        let headers = String::from_utf8_lossy(&request[..end]).to_lowercase();
                        let count: usize = headers
                            .lines()
                            .find_map(|l| l.strip_prefix("content-length:"))
                            .unwrap()
                            .trim()
                            .parse()
                            .unwrap();
                        if request.len() >= end + 4 + count {
                            break (
                                headers,
                                serde_json::from_slice::<Value>(&request[end + 4..end + 4 + count])
                                    .unwrap(),
                            );
                        }
                    }
                };
                assert_eq!(body["stream"], true);
                assert_eq!(body["store"], false);
                assert_eq!(body["model"], "test-model");
                assert!(body.get("max_output_tokens").is_none());
                let event = json!({"type":"response.completed","response":{"status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"fixture answer"}]}]}});
                let body = if status == 200 {
                    format!("data: {event}\n\ndata: [DONE]\n\n")
                } else {
                    "sensitive-error-body".into()
                };
                write!(stream, "HTTP/1.1 {status} Test\r\nContent-Type: text/event-stream\r\nLocation: http://127.0.0.1:1/never-follow\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
                (headers, body)
            });
            let grant = Grant {
                access: "synthetic-access".into(),
                expires: i64::MAX,
                account_id: Some("fixture-account".into()),
            };
            let result = generate_at(
                &grant,
                "openai-codex",
                "test-model",
                "fixture prompt",
                &endpoint,
            )
            .await;
            if status == 200 {
                assert_eq!(result.unwrap().text, "fixture answer");
            } else {
                assert_eq!(
                    result.err().unwrap().to_string(),
                    format!("NATIVE_OAUTH_HTTP_STATUS_{status}")
                );
            }
            let (headers, _) = thread.join().unwrap();
            assert!(headers.contains("authorization: bearer synthetic-access"));
            assert!(headers.contains("chatgpt-account-id: fixture-account"));
            assert!(headers.contains("accept: text/event-stream"));
        }
    }
}
