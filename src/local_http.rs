//! Bounded HTTP/1.1 framing for the two loopback-only servers.

use std::io::{Read, Write};
use std::net::TcpStream;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

const MAX_HEADER: usize = 16 * 1024;
const MAX_BODY: usize = 64 * 1024;
pub const MAX_CONNECTIONS: usize = 32;

pub struct Request {
    pub method: String,
    pub target: String,
    pub body: String,
    headers: Vec<(String, String)>,
}

impl Request {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.as_str())
    }

    pub fn trusted(&self, port: u16) -> bool {
        let local = format!("127.0.0.1:{port}");
        let localhost = format!("localhost:{port}");
        let host = self.header("host");
        let origin = self.header("origin");
        // Browser-context POSTs must carry Origin. Keep authenticated native
        // clients working: Node fetch sends Sec-Fetch-Mode without Origin, so
        // Mode alone is not a browser signal. These hints never replace token auth.
        let browser_post = self.method == "POST"
            && ["sec-fetch-site", "sec-fetch-dest", "sec-fetch-user"]
                .iter()
                .any(|name| self.header(name).is_some());
        matches!(host, Some(h) if h == local || h == localhost)
            && origin
                .map(|o| o == format!("http://{local}") || o == format!("http://{localhost}"))
                .unwrap_or(!browser_post)
    }

    pub fn authorized(&self, token: &str) -> bool {
        self.header("x-rdsh-token")
            .map(|value| constant_time_eq(value, token))
            .unwrap_or(false)
    }
}

fn constant_time_eq(a: &str, b: &str) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.bytes()
        .zip(b.bytes())
        .fold(0u8, |diff, (x, y)| diff | (x ^ y))
        == 0
}

pub fn random_token() -> anyhow::Result<String> {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|e| anyhow::anyhow!("OS random source failed: {e}"))?;
    let mut out = String::with_capacity(64);
    for b in bytes {
        out.push(HEX[(b >> 4) as usize] as char);
        out.push(HEX[(b & 0x0f) as usize] as char);
    }
    Ok(out)
}

pub fn read_request(stream: &mut TcpStream) -> Result<Request, u16> {
    let mut raw = Vec::with_capacity(4096);
    let mut chunk = [0u8; 4096];
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    let header_end = loop {
        if let Some(pos) = raw.windows(4).position(|w| w == b"\r\n\r\n") {
            break pos + 4;
        }
        if raw.len() >= MAX_HEADER {
            return Err(413);
        }
        let n = read_with_deadline(stream, &mut chunk, deadline)?;
        if n == 0 {
            return Err(400);
        }
        raw.extend_from_slice(&chunk[..n]);
        if raw.len() > MAX_HEADER + MAX_BODY {
            return Err(413);
        }
    };
    if header_end > MAX_HEADER {
        return Err(413);
    }
    let head = std::str::from_utf8(&raw[..header_end])
        .map_err(|_| 400u16)?
        .to_owned();
    let mut lines = head[..head.len() - 4].split("\r\n");
    let request_line = lines.next().ok_or(400u16)?;
    let mut parts = request_line.split(' ');
    let method = parts.next().ok_or(400u16)?;
    let target = parts.next().ok_or(400u16)?;
    if !matches!(method, "GET" | "POST")
        || !target.starts_with('/')
        || parts.next() != Some("HTTP/1.1")
        || parts.next().is_some()
    {
        return Err(400);
    }
    let mut headers = Vec::new();
    let mut length = None;
    for line in lines {
        let (key, value) = line.split_once(':').ok_or(400u16)?;
        if key.is_empty() || !key.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') {
            return Err(400);
        }
        let key = key.to_ascii_lowercase();
        let value = value.trim();
        if value.bytes().any(|b| b < 0x20 && b != b'\t') {
            return Err(400);
        }
        if key == "transfer-encoding" {
            return Err(400);
        }
        if key == "content-length" {
            if length.is_some() || value.is_empty() || !value.bytes().all(|b| b.is_ascii_digit()) {
                return Err(400);
            }
            length = Some(value.parse::<usize>().map_err(|_| 413u16)?);
        }
        if (key == "host" || key == "origin" || key == "x-rdsh-token")
            && headers.iter().any(|(k, _)| k == &key)
        {
            return Err(400);
        }
        headers.push((key, value.to_string()));
    }
    if method == "POST" && length.is_none() {
        return Err(400);
    }
    let length = length.unwrap_or(0);
    if length > MAX_BODY || raw.len() - header_end > length {
        return Err(413);
    }
    while raw.len() - header_end < length {
        let n = read_with_deadline(stream, &mut chunk, deadline)?;
        if n == 0 {
            return Err(400);
        }
        raw.extend_from_slice(&chunk[..n]);
        if raw.len() - header_end > length {
            return Err(413);
        }
    }
    let body = String::from_utf8(raw[header_end..].to_vec()).map_err(|_| 400u16)?;
    Ok(Request {
        method: method.to_string(),
        target: target.to_string(),
        body,
        headers,
    })
}

fn read_with_deadline(
    stream: &mut TcpStream,
    chunk: &mut [u8],
    deadline: std::time::Instant,
) -> Result<usize, u16> {
    let remaining = deadline.saturating_duration_since(std::time::Instant::now());
    if remaining.is_zero() {
        return Err(408);
    }
    stream
        .set_read_timeout(Some(remaining))
        .map_err(|_| 400u16)?;
    stream.read(chunk).map_err(|e| {
        if e.kind() == std::io::ErrorKind::TimedOut || e.kind() == std::io::ErrorKind::WouldBlock {
            408
        } else {
            400
        }
    })
}

pub fn respond(
    stream: &mut TcpStream,
    status: u16,
    ctype: &str,
    payload: impl AsRef<[u8]>,
) -> std::io::Result<()> {
    let payload = payload.as_ref();
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        408 => "Request Timeout",
        413 => "Payload Too Large",
        503 => "Service Unavailable",
        _ => "Error",
    };
    write!(stream, "HTTP/1.1 {status} {reason}\r\nContent-Type: {ctype}\r\nContent-Length: {}\r\nConnection: close\r\nX-Content-Type-Options: nosniff\r\nReferrer-Policy: no-referrer\r\n\r\n", payload.len())?;
    stream.write_all(payload)
}

pub struct ConnectionSlot(Arc<AtomicUsize>);
impl ConnectionSlot {
    pub fn acquire(count: &Arc<AtomicUsize>) -> Option<Self> {
        let mut current = count.load(Ordering::Acquire);
        loop {
            if current >= MAX_CONNECTIONS {
                return None;
            }
            match count.compare_exchange_weak(
                current,
                current + 1,
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(_) => break,
                Err(latest) => current = latest,
            }
        }
        Some(Self(count.clone()))
    }
}
impl Drop for ConnectionSlot {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    fn request(method: &str, headers: &[(&str, &str)]) -> Request {
        Request {
            method: method.into(),
            target: "/api/tokens".into(),
            body: String::new(),
            headers: headers
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
        }
    }

    #[test]
    fn browser_posts_require_origin_but_native_clients_and_navigation_still_work() {
        for name in ["sec-fetch-site", "sec-fetch-dest", "sec-fetch-user"] {
            for value in [
                "same-origin",
                "cross-site",
                "none",
                "empty",
                "?1",
                "",
                "unknown",
            ] {
                let mut req = request("POST", &[("host", "127.0.0.1:8080"), (name, value)]);
                assert!(!req.trusted(8080), "missing Origin with {name}: {value}");
                req.headers
                    .push(("origin".into(), "http://127.0.0.1:8080".into()));
                assert!(req.trusted(8080));
                req.method = "GET".into();
                req.headers.pop();
                assert!(req.trusted(8080), "GET navigation with {name}: {value}");
            }
        }
        // Node's fetch adds Sec-Fetch-Mode alone, without browser context headers.
        for headers in [
            vec![("host", "localhost:8080")],
            vec![("host", "localhost:8080"), ("sec-fetch-mode", "cors")],
        ] {
            let req = request("POST", &headers);
            assert!(req.trusted(8080));
            assert!(!req.authorized("test-token"));
        }
    }

    #[test]
    fn explicit_origin_and_host_are_always_checked() {
        for method in ["GET", "POST"] {
            for origin in [
                "",
                "null",
                "https://evil.example",
                "http://127.0.0.1:8081",
                "http://localhost:8080.evil.example",
                "https://localhost:8080",
            ] {
                assert!(
                    !request(method, &[("host", "localhost:8080"), ("origin", origin)])
                        .trusted(8080)
                );
            }
            for host in ["127.0.0.1:8080", "localhost:8080"] {
                for origin in ["http://127.0.0.1:8080", "http://localhost:8080"] {
                    assert!(request(method, &[("host", host), ("origin", origin)]).trusted(8080));
                }
            }
            assert!(!request(method, &[("origin", "http://localhost:8080")]).trusted(8080));
            for host in [
                "evil.example:8080",
                "localhost:8081",
                "localhost:8080.evil.example",
            ] {
                assert!(!request(
                    method,
                    &[("host", host), ("origin", "http://localhost:8080")]
                )
                .trusted(8080));
            }
        }
    }

    #[test]
    fn waits_for_a_split_body_and_rejects_ambiguous_framing() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let worker = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let request = read_request(&mut stream).unwrap();
            assert_eq!(request.body, "{\"text\":\"abc\"}");
            assert!(request.trusted(address.port()));
            assert!(request.authorized("secret"));
        });
        let mut client = TcpStream::connect(address).unwrap();
        client.write_all(format!("POST /api/tokens HTTP/1.1\r\nHost: {address}\r\nX-RDSH-Token: secret\r\nContent-Length: 14\r\n\r\n{{\"text\":").as_bytes()).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(30));
        client.write_all(b"\"abc\"}").unwrap();
        worker.join().unwrap();

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let worker = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            assert!(read_request(&mut stream).is_err());
        });
        let mut client = TcpStream::connect(address).unwrap();
        client.write_all(format!("POST /api/key HTTP/1.1\r\nHost: {address}\r\nContent-Length: 2\r\nContent-Length: 2\r\n\r\n{{}}").as_bytes()).unwrap();
        worker.join().unwrap();
    }
}
