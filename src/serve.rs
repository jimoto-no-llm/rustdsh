//! `rdsh serve`: bounded local dashboard (127.0.0.1 only).
//! Serves the embedded UI plus a tiny JSON API. Read-only operations only:
//! no boot, no file writes, no command execution from HTTP.

const UI: &str = include_str!("ui.html");
const ICON: &str = include_str!("../assets/icon.svg");
use std::sync::atomic::AtomicUsize;
use std::sync::Arc;

pub fn cmd_serve(port: u16) -> anyhow::Result<()> {
    let addr = format!("127.0.0.1:{port}");
    let listener = std::net::TcpListener::bind(&addr).map_err(|e| {
        anyhow::anyhow!(
            "cannot listen on {addr}: {e} (dsh web GUI uses 3080; rdsh serve defaults to 38080, or try --port 0)"
        )
    })?;
    let port = listener.local_addr()?.port();
    let token = Arc::new(crate::local_http::random_token()?);
    eprintln!(
        "[rdsh] dashboard: http://127.0.0.1:{port}/#key={token}  (Ctrl-C to stop, localhost only)"
    );
    let connections = Arc::new(AtomicUsize::new(0));
    for stream in listener.incoming() {
        match stream {
            Ok(mut s) => {
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
                    if let Err(e) = handle(s, &token, port) {
                        eprintln!("[rdsh serve] {e:#}");
                    }
                });
            }
            Err(e) => eprintln!("[rdsh serve] accept: {e}"),
        }
    }
    Ok(())
}

fn handle(mut s: std::net::TcpStream, token: &str, port: u16) -> anyhow::Result<()> {
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
    let method = req.method.as_str();
    let target = req.target.as_str();
    let (path, query) = match target.find('?') {
        Some(i) => (&target[..i], &target[i + 1..]),
        None => (target, ""),
    };
    if path.starts_with("/api/") && path != "/api/version" && !req.authorized(token) {
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
    let (status, ctype, payload): (u16, &str, Cow<'_, str>) = match (method, path) {
        ("GET", "/") => (200, "text/html; charset=utf-8", Cow::Borrowed(UI)),
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
                Cow::Owned(serde_json::json!({"tokens": t, "chars": text.len()}).to_string()),
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
        _ => (404, "application/json", Cow::Borrowed(NOT_FOUND_JSON)),
    };
    crate::local_http::respond(&mut s, status, ctype, &payload)?;
    Ok(())
}

fn doctor_json() -> String {
    let orig = crate::passthrough::find_original_dsh();
    let home = crate::inspect::dsh_home();
    let profiles = std::fs::read_dir(format!("{home}/profiles"))
        .map(|d| d.count())
        .unwrap_or(0);
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
                .map(|s| s.success())
                .unwrap_or(false);
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
