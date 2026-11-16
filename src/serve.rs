//! `rdsh serve`: bounded local dashboard (127.0.0.1 only).
//! Serves the embedded UI plus a tiny JSON API. HTTP never boots dsh and never
//! runs caller-supplied commands; its own side effects are limited to the local
//! token-handoff file and the self-benchmark spawn behind `GET /api/bench`.

const UI: &str = include_str!("ui.html");
const ICON: &str = include_str!("../assets/icon.svg");
use std::sync::atomic::AtomicUsize;
use std::sync::Arc;

/// Serve must survive a closed stderr: piping the output (for example
/// `rdsh serve | head -1`) closes the pipe, and a panicking eprintln! would
/// take the dashboard down with it.
fn log_line(message: std::fmt::Arguments<'_>) {
    use std::io::Write;
    let _ = writeln!(std::io::stderr(), "{message}");
}

pub fn cmd_serve(port: u16, locale: crate::locale::Locale) -> anyhow::Result<()> {
    let addr = format!("127.0.0.1:{port}");
    let listener = std::net::TcpListener::bind(&addr).map_err(|e| {
        anyhow::anyhow!(
            "{} {addr}: {e} ({})",
            match locale {
                crate::locale::Locale::English => "cannot listen on",
                crate::locale::Locale::Chinese => "无法监听",
                crate::locale::Locale::Japanese => "待受できません",
            },
            match locale {
                crate::locale::Locale::English => "dsh web GUI uses 3080; rdsh serve defaults to 38080, or try --port 0",
                crate::locale::Locale::Chinese => "dsh Web GUI 使用 3080；rdsh serve 默认使用 38080，也可尝试 --port 0",
                crate::locale::Locale::Japanese => "dsh Web GUI は 3080、rdsh serve は既定で 38080 を使います。--port 0 も試せます",
            }
        )
    })?;
    listener.set_nonblocking(true)?;
    crate::shutdown::install(locale)?;
    let port = listener.local_addr()?.port();
    let token = Arc::new(crate::local_http::random_token()?);
    let handoff = crate::token_handoff::TokenHandoff::create(&token, locale)?;
    log_line(format_args!(
        "[rdsh] {}: http://127.0.0.1:{port}/ ({})",
        match locale {
            crate::locale::Locale::English => "dashboard",
            crate::locale::Locale::Chinese => "仪表板",
            crate::locale::Locale::Japanese => "ダッシュボード",
        },
        match locale {
            crate::locale::Locale::English => "Ctrl-C to stop, localhost only",
            crate::locale::Locale::Chinese => "按 Ctrl-C 停止，仅限 localhost",
            crate::locale::Locale::Japanese => "Ctrl-C で停止、localhost のみ",
        }
    ));
    log_line(format_args!(
        "[rdsh] {}: {}",
        match locale {
            crate::locale::Locale::English => "token handoff file",
            crate::locale::Locale::Chinese => "令牌交接文件",
            crate::locale::Locale::Japanese => "トークン引き渡しファイル",
        },
        handoff.path().display()
    ));
    log_line(format_args!(
        "[rdsh] {}",
        match locale {
            crate::locale::Locale::English =>
                "enter the file contents in the dashboard; the token is never printed",
            crate::locale::Locale::Chinese => "请在仪表板中输入文件内容；令牌绝不会打印",
            crate::locale::Locale::Japanese =>
                "ダッシュボードでファイル内容を入力してください。トークンは表示されません",
        }
    ));
    let connections = Arc::new(AtomicUsize::new(0));
    while !crate::shutdown::requested() {
        match listener.accept() {
            Ok((mut s, _)) => {
                let Some(slot) = crate::local_http::ConnectionSlot::acquire(&connections) else {
                    let _ = crate::local_http::respond(
                        &mut s,
                        503,
                        "application/json",
                        "{\"error\":\"busy\"}",
                    );
                    continue;
                };
                let token = token.clone();
                std::thread::spawn(move || {
                    let _slot = slot;
                    if let Err(e) = handle(s, &token, port, locale) {
                        log_line(format_args!("[rdsh serve] {e:#}"));
                    }
                });
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                // Idle poll quantum: 5 ms keeps shutdown responsive while
                // capping added accept latency (measured ~93 ms at 100 ms).
                // Cost is ~200 trivial wakeups/s when fully idle.
                std::thread::sleep(std::time::Duration::from_millis(5));
            }
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
            Err(e) => log_line(format_args!("[rdsh serve] accept: {e}")),
        }
    }
    Ok(())
}

fn handle(
    mut s: std::net::TcpStream,
    token: &str,
    port: u16,
    locale: crate::locale::Locale,
) -> anyhow::Result<()> {
    use std::borrow::Cow;
    s.set_read_timeout(Some(std::time::Duration::from_secs(10)))?;
    let req = match crate::local_http::read_request(&mut s) {
        Ok(req) => req,
        Err(crate::local_http::ReadRequestError::Idle) => return Ok(()),
        Err(crate::local_http::ReadRequestError::Status(status)) => {
            crate::local_http::respond(
                &mut s,
                status,
                "application/json",
                "{\"error\":\"invalid request\"}",
            )?;
            return Ok(());
        }
    };
    if !req.trusted(port) {
        crate::local_http::respond(
            &mut s,
            403,
            "application/json",
            "{\"error\":\"untrusted host or origin\"}",
        )?;
        return Ok(());
    }
    let method = req.method.as_str();
    let target = req.target.as_str();
    let (path, query) = match target.find('?') {
        Some(i) => (&target[..i], &target[i + 1..]),
        None => (target, ""),
    };
    if path.starts_with("/api/") && !req.authorized(token) {
        crate::local_http::respond(
            &mut s,
            401,
            "application/json",
            "{\"error\":\"unauthorized\"}",
        )?;
        return Ok(());
    }
    let body = req.body.as_str();
    // Static payloads are byte-identical to the old serde_json output
    // (serde_json sorts object keys; single-key or pre-sorted here).
    const VERSION_JSON: &str = concat!(
        "{\"name\":\"rdsh\",\"version\":\"",
        env!("CARGO_PKG_VERSION"),
        "\"}"
    );
    const NOT_FOUND_JSON: &str = "{\"error\":\"not found\"}";
    if method == "GET" {
        let asset = match path {
            "/icon.png" => Some((
                "image/png",
                include_bytes!("../assets/icon-256.png").as_slice(),
            )),
            "/favicon.ico" => Some((
                "image/x-icon",
                include_bytes!("../assets/icon.ico").as_slice(),
            )),
            _ => None,
        };
        if let Some((ctype, bytes)) = asset {
            crate::local_http::respond(&mut s, 200, ctype, bytes)?;
            return Ok(());
        }
    }
    if (method, path) == ("GET", "/api/file") {
        return handle_file_download(&mut s, query).map_err(|e| anyhow::anyhow!("{e}"));
    }
    let (status, ctype, payload): (u16, &str, Cow<'_, str>) = match (method, path) {
        ("GET", "/") => (
            200,
            "text/html; charset=utf-8",
            Cow::Owned(
                UI.replace(
                    "__RDSH_LOCALE__",
                    match locale {
                        crate::locale::Locale::English => "en",
                        crate::locale::Locale::Chinese => "zh-CN",
                        crate::locale::Locale::Japanese => "ja",
                    },
                )
                // The build version is already public (rdsh --version and the
                // terminal banner), so render it immediately instead of leaving
                // the header blank until the token-gated /api/version answers.
                .replace("__RDSH_VERSION__", env!("CARGO_PKG_VERSION")),
            ),
        ),
        ("GET", "/icon.svg") => (200, "image/svg+xml", Cow::Borrowed(ICON)),
        ("GET", "/api/version") => (200, "application/json", Cow::Borrowed(VERSION_JSON)),
        ("GET", "/api/doctor") => (200, "application/json", Cow::Owned(doctor_json())),
        ("POST", "/api/tokens") => {
            // Borrow `text` from the parsed body instead of cloning it.
            let v: serde_json::Value =
                serde_json::from_str(body).unwrap_or(serde_json::Value::Null);
            let text: &str = v.get("text").and_then(|t| t.as_str()).unwrap_or_default();
            let t = crate::tokens::estimate_tokens(text);
            (
                200,
                "application/json",
                Cow::Owned(
                    serde_json::json!({"tokens": t, "chars": text.chars().count()}).to_string(),
                ),
            )
        }
        ("POST", "/api/prune") => {
            let v: serde_json::Value =
                serde_json::from_str(body).unwrap_or(serde_json::Value::Null);
            let text: &str = v.get("text").and_then(|t| t.as_str()).unwrap_or_default();
            let max = v.get("max_tokens").and_then(|m| m.as_u64()).unwrap_or(4000) as usize;
            let max = max.clamp(100, 200_000);
            let before = crate::tokens::estimate_tokens(text);
            let pruned = crate::tokens::prune_to_budget(text, max);
            let after = crate::tokens::estimate_tokens(&pruned);
            (200, "application/json", Cow::Owned(serde_json::json!({"pruned": pruned, "before": before, "after": after, "budget": max}).to_string()))
        }
        ("GET", "/api/bench") => (200, "application/json", Cow::Owned(bench_json(query))),
        ("GET", "/api/sessions") => {
            let n: usize = query
                .split('&')
                .find_map(|kv| {
                    let mut it = kv.splitn(2, '=');
                    match (it.next(), it.next()) {
                        (Some("limit"), Some(v)) => v.parse().ok(),
                        _ => None,
                    }
                })
                .unwrap_or(20)
                .clamp(1, 100);
            (
                200,
                "application/json",
                Cow::Owned(crate::inspect::sessions_json(n)),
            )
        }
        ("GET", "/api/skills") => (
            200,
            "application/json",
            Cow::Owned(crate::inspect::names_json("skills")),
        ),
        ("GET", "/api/profiles") => (
            200,
            "application/json",
            Cow::Owned(crate::inspect::names_json("profiles")),
        ),
        ("GET", "/api/files") => {
            let session = query_value(query, "session");
            match crate::files::deliverables(session.as_deref()) {
                Ok((label, files)) => {
                    let body = serde_json::json!({
                        "session": label,
                        "files": files.iter().map(|item| serde_json::json!({
                            "path": item.path,
                            "description": item.description,
                            "bytes": item.bytes,
                            "exists": item.bytes.is_some(),
                        })).collect::<Vec<_>>(),
                    });
                    (200, "application/json", Cow::Owned(body.to_string()))
                }
                Err(error) => (
                    404,
                    "application/json",
                    Cow::Owned(serde_json::json!({"error": error.to_string()}).to_string()),
                ),
            }
        }
        _ => (404, "application/json", Cow::Borrowed(NOT_FOUND_JSON)),
    };
    crate::local_http::respond(&mut s, status, ctype, payload.as_bytes())?;
    Ok(())
}

/// Stream one declared deliverable so a browser can save a copy.
fn handle_file_download(s: &mut std::net::TcpStream, query: &str) -> std::io::Result<()> {
    let Some(path) = query_value(query, "path") else {
        return crate::local_http::respond(
            s,
            400,
            "application/json",
            b"{\"error\":\"missing path\"}",
        );
    };
    let source = std::path::PathBuf::from(path);
    let session = query_value(query, "session");
    let declared = match crate::files::deliverables(session.as_deref()) {
        Ok((_, files)) => files,
        Err(error) => {
            let body = serde_json::json!({"error": error.to_string()}).to_string();
            return crate::local_http::respond(s, 404, "application/json", body.as_bytes());
        }
    };
    let (canonical, file, length) = match crate::files::open_source(&source, &declared) {
        Ok(source) => source,
        Err(error) => {
            let body = serde_json::json!({"error": error.to_string()}).to_string();
            return crate::local_http::respond(s, 403, "application/json", body.as_bytes());
        }
    };
    let name = crate::files::download_name(&canonical);
    let ctype = crate::files::content_type(&canonical);
    let disposition = content_disposition(&name);
    let header = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: {ctype}\r\nContent-Length: {length}\r\nContent-Disposition: {disposition}\r\nConnection: close\r\nX-Content-Type-Options: nosniff\r\nReferrer-Policy: no-referrer\r\n\r\n"
    );
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    write_before_deadline(s, header.as_bytes(), deadline)?;
    stream_file(s, file, length, deadline)
}

fn content_disposition(name: &str) -> String {
    use std::fmt::Write as _;
    let fallback: String = name
        .chars()
        .map(|c| match c {
            ' '..='~' if !matches!(c, '"' | '\\' | '%') => c,
            _ => '_',
        })
        .collect();
    let mut value = format!("attachment; filename=\"{fallback}\"; filename*=UTF-8''");
    for byte in name.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
            value.push(char::from(byte));
        } else {
            let _ = write!(value, "%{byte:02X}");
        }
    }
    value
}

fn stream_file(
    s: &mut std::net::TcpStream,
    file: std::fs::File,
    length: u64,
    deadline: std::time::Instant,
) -> std::io::Result<()> {
    use std::io::Read as _;
    let mut source = file.take(length);
    let mut buffer = [0u8; 16 * 1024];
    while source.limit() > 0 {
        let count = source.read(&mut buffer)?;
        if count == 0 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::UnexpectedEof,
                "deliverable changed during download",
            ));
        }
        write_before_deadline(s, &buffer[..count], deadline)?;
    }
    Ok(())
}

fn write_before_deadline(
    s: &mut std::net::TcpStream,
    mut bytes: &[u8],
    deadline: std::time::Instant,
) -> std::io::Result<()> {
    use std::io::Write as _;
    while !bytes.is_empty() {
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        if remaining.is_zero() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                "download response timed out",
            ));
        }
        s.set_write_timeout(Some(remaining))?;
        match s.write(bytes) {
            Ok(0) => return Err(std::io::ErrorKind::WriteZero.into()),
            Ok(count) => bytes = &bytes[count..],
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

fn query_value(query: &str, name: &str) -> Option<String> {
    query.split('&').find_map(|pair| {
        let (key, value) = pair.split_once('=')?;
        (key == name).then(|| percent_decode(value))
    })
}

/// Minimal percent-decoding for a query parameter.
fn percent_decode(input: &str) -> String {
    let mut out = Vec::with_capacity(input.len());
    let bytes = input.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("");
            if let Ok(byte) = u8::from_str_radix(hex, 16) {
                out.push(byte);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn doctor_json() -> String {
    let orig = crate::passthrough::find_original_dsh();
    let home = crate::inspect::dsh_home();
    let profiles = std::fs::read_dir(format!("{home}/profiles")).map_or(0, |d| d.count());
    serde_json::json!({
        "original_dsh": orig,
        "dsh_home": home,
        "local_profiles": profiles,
        "slim": crate::slim::describe(),
        "version": env!("CARGO_PKG_VERSION"),
    })
    .to_string()
}

fn bench_json(query: &str) -> String {
    use std::sync::{Mutex, OnceLock};
    static CACHE: OnceLock<Mutex<std::collections::HashMap<u32, String>>> = OnceLock::new();
    let n: u32 = query
        .split('&')
        .find_map(|kv| {
            let mut it = kv.splitn(2, '=');
            match (it.next(), it.next()) {
                (Some("n"), Some(v)) => v.parse().ok(),
                _ => None,
            }
        })
        .unwrap_or(3)
        .clamp(1, 5);
    let mut cache = CACHE
        .get_or_init(|| Mutex::new(std::collections::HashMap::new()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(result) = cache.get(&n) {
        return result.clone();
    }
    let me = std::env::current_exe().ok();
    let mut mine = vec![];
    if let Some(exe) = me {
        for _ in 0..n {
            let t = std::time::Instant::now();
            let ok = std::process::Command::new(&exe)
                .arg("--version")
                .status()
                .is_ok_and(|s| s.success());
            if !ok {
                break;
            }
            mine.push(t.elapsed().as_secs_f64() * 1000.0);
        }
    }
    let result = serde_json::json!({"rdsh_version_ms": mine, "n": n}).to_string();
    cache.insert(n, result.clone());
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;
    use std::net::{TcpListener, TcpStream};
    use std::time::{Duration, Instant};

    #[test]
    fn downloads_use_the_checked_length_when_the_open_file_changes() {
        let path =
            std::env::temp_dir().join(format!("rdsh-serve-changed-file-{}", std::process::id()));
        for (replacement, expected_error) in [
            (b"original appended".as_slice(), None),
            (b"short".as_slice(), Some(std::io::ErrorKind::UnexpectedEof)),
        ] {
            std::fs::write(&path, b"original").unwrap();
            let file = std::fs::File::open(&path).unwrap();
            let length = file.metadata().unwrap().len();
            std::fs::write(&path, replacement).unwrap();
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let mut client = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
            client
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let (mut server, _) = listener.accept().unwrap();
            let sender = std::thread::spawn(move || {
                stream_file(
                    &mut server,
                    file,
                    length,
                    Instant::now() + Duration::from_secs(2),
                )
            });
            let mut received = Vec::new();
            client.read_to_end(&mut received).unwrap();
            let result = sender.join().unwrap();
            assert_eq!(result.err().map(|error| error.kind()), expected_error);
            assert_eq!(
                received,
                replacement[..replacement.len().min(length as usize)]
            );
        }
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn download_releases_a_connection_that_stops_reading() {
        let path =
            std::env::temp_dir().join(format!("rdsh-serve-blocked-file-{}", std::process::id()));
        let length = 64 * 1024 * 1024;
        std::fs::File::create(&path)
            .unwrap()
            .set_len(length)
            .unwrap();
        let file = std::fs::File::open(&path).unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let _client = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let (mut server, _) = listener.accept().unwrap();
        let started = Instant::now();
        let error = stream_file(
            &mut server,
            file,
            length,
            started + Duration::from_millis(100),
        )
        .unwrap_err();
        std::fs::remove_file(path).unwrap();
        assert!(matches!(
            error.kind(),
            std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock
        ));
        assert!(started.elapsed() < Duration::from_secs(3));
    }
}
