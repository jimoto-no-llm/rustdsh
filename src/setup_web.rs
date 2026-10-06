//! `rdsh setup --web`: floating first-run connect UI on localhost.
//! One-shot local server (127.0.0.1 only): Apple-style glass page showing
//! OAuth/API-key status. Writes only on explicit key submit (allowlisted
//! ref names); browser auto-opens on interactive terminals.

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;

const HTML: &str = include_str!("setup.html");
const ICON: &str = include_str!("../assets/icon.svg");

pub fn cmd_setup_web(port: u16) -> anyhow::Result<()> {
    let listener = std::net::TcpListener::bind(format!("127.0.0.1:{port}"))
        .map_err(|e| anyhow::anyhow!("cannot listen on 127.0.0.1:{port}: {e}"))?;
    let port = listener.local_addr()?.port();
    let token = Arc::new(crate::local_http::random_token()?);
    // The fragment never leaves the browser as part of an HTTP request.
    let url = format!("http://127.0.0.1:{port}/#key={token}");
    eprintln!("[rdsh setup] floating UI: {url}  (localhost only, Ctrl-C to stop)");
    use std::io::IsTerminal as _;
    if std::io::stdin().is_terminal() {
        if let Err(e) = crate::auth::open_browser(&url) {
            eprintln!("[rdsh setup] could not open browser ({e:#}); open the URL manually");
        }
    }
    listener.set_nonblocking(true)?;
    let done = Arc::new(AtomicBool::new(false));
    let connections = Arc::new(AtomicUsize::new(0));
    loop {
        if done.load(Ordering::Relaxed) {
            break;
        }
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
                let d = done.clone();
                let token = token.clone();
                std::thread::spawn(move || {
                    let _slot = slot;
                    if let Err(e) = handle(s, &d, &token, port) {
                        eprintln!("[rdsh setup] {e:#}");
                    }
                });
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            Err(e) => {
                eprintln!("[rdsh setup] accept: {e:#}");
                break;
            }
        }
    }
    Ok(())
}

fn handle(
    mut s: std::net::TcpStream,
    done: &AtomicBool,
    token: &str,
    port: u16,
) -> anyhow::Result<()> {
    use std::borrow::Cow;
    s.set_read_timeout(Some(std::time::Duration::from_secs(10)))?;
    let req = match crate::local_http::read_request(&mut s) {
        Ok(req) => req,
        Err(status) => {
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
    let (status, ctype, payload): (u16, &str, Cow<str>) =
        match (req.method.as_str(), req.target.as_str()) {
            ("GET", "/") => (200, "text/html; charset=utf-8", Cow::Borrowed(HTML)),
            ("GET", "/icon.svg") => (200, "image/svg+xml", Cow::Borrowed(ICON)),
            ("GET", "/api/status") if !req.authorized(token) => (
                401,
                "application/json",
                Cow::Borrowed("{\"error\":\"unauthorized\"}"),
            ),
            ("GET", "/api/status") => (
                200,
                "application/json",
                Cow::Owned(crate::auth::setup_status_json()),
            ),
            ("POST", "/api/key") if !req.authorized(token) => (
                401,
                "application/json",
                Cow::Borrowed("{\"error\":\"unauthorized\"}"),
            ),
            ("POST", "/api/key") if req.header("content-type") != Some("application/json") => (
                400,
                "application/json",
                Cow::Borrowed("{\"error\":\"JSON required\"}"),
            ),
            ("POST", "/api/key") => match store_key_body(&req.body) {
                Ok(stored) => (
                    200,
                    "application/json",
                    Cow::Owned(serde_json::json!({"stored": stored}).to_string()),
                ),
                Err(e) => (
                    400,
                    "application/json",
                    Cow::Owned(serde_json::json!({"error": e.to_string()}).to_string()),
                ),
            },
            ("GET", "/api/extras") if !req.authorized(token) => (
                401,
                "application/json",
                Cow::Borrowed("{\"error\":\"unauthorized\"}"),
            ),
            ("GET", "/api/extras") => {
                let cfg = crate::rdsh_config::load();
                (
                    200,
                    "application/json",
                    Cow::Owned(serde_json::json!({"enable": cfg.extras.enable}).to_string()),
                )
            }
            ("POST", "/api/extras") if !req.authorized(token) => (
                401,
                "application/json",
                Cow::Borrowed("{\"error\":\"unauthorized\"}"),
            ),
            ("POST", "/api/extras") => match store_extras_body(&req.body) {
                Ok(enable) => (
                    200,
                    "application/json",
                    Cow::Owned(serde_json::json!({"enable": enable}).to_string()),
                ),
                Err(e) => (
                    400,
                    "application/json",
                    Cow::Owned(serde_json::json!({"error": e.to_string()}).to_string()),
                ),
            },
            ("POST", "/api/done") if !req.authorized(token) => (
                401,
                "application/json",
                Cow::Borrowed("{\"error\":\"unauthorized\"}"),
            ),
            ("POST", "/api/done") => {
                done.store(true, Ordering::Relaxed);
                (200, "application/json", Cow::Borrowed("{\"ok\":true}"))
            }
            _ => (
                404,
                "application/json",
                Cow::Borrowed("{\"error\":\"not found\"}"),
            ),
        };
    crate::local_http::respond(&mut s, status, ctype, &payload)?;
    Ok(())
}

fn store_extras_body(body: &str) -> anyhow::Result<Vec<String>> {
    let v: serde_json::Value = serde_json::from_str(body)?;
    let arr = v.get("enable").and_then(|x| x.as_array());
    let mut cfg = crate::rdsh_config::load();
    let mut enable = Vec::new();
    if let Some(items) = arr {
        for x in items {
            if let Some(s) = x.as_str() {
                let s = s.trim().to_string();
                if crate::rdsh_config::KNOWN_EXTRAS.contains(&s.as_str()) && !enable.contains(&s) {
                    enable.push(s);
                }
            }
        }
    }
    cfg.extras.enable = enable.clone();
    cfg.save()?;
    Ok(enable)
}

fn store_key_body(body: &str) -> anyhow::Result<bool> {
    let v: serde_json::Value = serde_json::from_str(body)?;
    let name = v.get("name").and_then(|x| x.as_str()).unwrap_or("");
    let value = v.get("value").and_then(|x| x.as_str()).unwrap_or("");
    crate::auth::setup_store_key(name, value)
}
