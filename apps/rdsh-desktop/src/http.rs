//! Minimal HTTP/1.1 client for the loopback harness host.
//!
//! The host listens on `127.0.0.1` over plain HTTP, so the desktop app keeps its
//! dependency surface small instead of pulling a full HTTP stack. Only the two
//! shapes the protocol needs are implemented: a redirect-free GET (the token
//! exchange) and a JSON POST (unary RPC).

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::time::Duration;

use anyhow::{anyhow, Context, Result};

const MAX_BODY: usize = 16 * 1024 * 1024;
const IO_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug)]
pub struct Response {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: String,
}

impl Response {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }

    pub fn json(&self) -> Result<serde_json::Value> {
        serde_json::from_str(&self.body)
            .with_context(|| format!("response is not JSON: {}", truncate(&self.body, 200)))
    }
}

/// origin is http://127.0.0.1:<port>
pub fn get(origin: &str, path: &str) -> Result<Response> {
    send(origin, "GET", path, &[("Connection", "close")], None)
}

pub fn post_json(origin: &str, path: &str, cookie: &str, body: &str) -> Result<Response> {
    send(
        origin,
        "POST",
        path,
        &[
            ("Content-Type", "application/json"),
            ("Content-Length", &body.len().to_string()),
            ("Cookie", cookie),
            ("Accept", "application/json"),
            ("Connection", "close"),
        ],
        Some(body),
    )
}

fn send(
    origin: &str,
    method: &str,
    path: &str,
    headers: &[(&str, &str)],
    body: Option<&str>,
) -> Result<Response> {
    let authority = origin
        .strip_prefix("http://")
        .ok_or_else(|| anyhow!("only loopback http origins are supported: {origin}"))?;
    let mut stream =
        TcpStream::connect(authority).with_context(|| format!("connect to {authority}"))?;
    stream.set_read_timeout(Some(IO_TIMEOUT))?;
    stream.set_write_timeout(Some(IO_TIMEOUT))?;

    let mut request = format!("{method} {path} HTTP/1.1\r\nHost: {authority}\r\n");
    for (name, value) in headers {
        request.push_str(&format!("{name}: {value}\r\n"));
    }
    request.push_str("\r\n");
    if let Some(body) = body {
        request.push_str(body);
    }
    stream.write_all(request.as_bytes())?;
    stream.flush()?;

    let mut reader = BufReader::new(stream);
    let status_line = read_line(&mut reader)?;
    let status = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|code| code.parse::<u16>().ok())
        .ok_or_else(|| anyhow!("malformed status line: {status_line}"))?;

    let mut headers_out = Vec::new();
    loop {
        let line = read_line(&mut reader)?;
        if line.is_empty() {
            break;
        }
        if let Some((name, value)) = line.split_once(':') {
            headers_out.push((name.trim().to_string(), value.trim().to_string()));
        }
    }

    let chunked = headers_out.iter().any(|(name, value)| {
        name.eq_ignore_ascii_case("transfer-encoding") && value.contains("chunked")
    });
    let length = headers_out
        .iter()
        .find(|(name, _)| name.eq_ignore_ascii_case("content-length"))
        .and_then(|(_, value)| value.parse::<usize>().ok());

    let body = if chunked {
        read_chunked(&mut reader)?
    } else if let Some(length) = length {
        read_exact(&mut reader, length)?
    } else {
        let mut buffer = String::new();
        let _ = reader.take(MAX_BODY as u64).read_to_string(&mut buffer);
        buffer
    };

    Ok(Response {
        status,
        headers: headers_out,
        body,
    })
}

fn read_line(reader: &mut impl BufRead) -> Result<String> {
    let mut line = String::new();
    let read = reader.read_line(&mut line)?;
    if read == 0 {
        return Err(anyhow!("connection closed while reading the response"));
    }
    Ok(line
        .trim_end_matches([char::from(13), char::from(10)])
        .to_string())
}

fn read_exact(reader: &mut impl Read, length: usize) -> Result<String> {
    let length = length.min(MAX_BODY);
    let mut buffer = vec![0u8; length];
    reader.read_exact(&mut buffer)?;
    Ok(String::from_utf8_lossy(&buffer).to_string())
}

fn read_chunked(reader: &mut impl BufRead) -> Result<String> {
    let mut body = String::new();
    loop {
        let size_line = read_line(reader)?;
        let size = usize::from_str_radix(size_line.split(';').next().unwrap_or("").trim(), 16)
            .with_context(|| format!("malformed chunk size: {size_line}"))?;
        if size == 0 {
            let _ = read_line(reader)?;
            break;
        }
        let mut chunk = vec![0u8; size];
        reader.read_exact(&mut chunk)?;
        body.push_str(&String::from_utf8_lossy(&chunk));
        let _ = read_line(reader)?;
        if body.len() > MAX_BODY {
            return Err(anyhow!("chunked response exceeded {MAX_BODY} bytes"));
        }
    }
    Ok(body)
}

fn truncate(text: &str, limit: usize) -> String {
    if text.len() <= limit {
        return text.to_string();
    }
    let mut end = limit;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}...", &text[..end])
}
