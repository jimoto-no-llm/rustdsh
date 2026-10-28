//! `rdsh setup --web`: floating first-run connect UI on localhost.
//! One-shot local server (127.0.0.1 only): Apple-style glass page showing
//! OAuth/API-key status. Writes only on explicit key submit (allowlisted
//! ref names); browser auto-opens on interactive terminals.

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;

const HTML: &str = include_str!("setup.html");
const ICON: &str = include_str!("../assets/icon.svg");

/// The one instruction that matters when no browser was opened for the person.
fn paste_hint(locale: crate::locale::Locale) {
    eprintln!(
        "[rdsh setup] {}",
        match locale {
            crate::locale::Locale::English =>
                "enter the token handoff file contents in the setup page; the token is never printed",
            crate::locale::Locale::Chinese => "请在设置页面中输入令牌交接文件的内容；令牌绝不会打印",
            crate::locale::Locale::Japanese =>
                "セットアップページでトークン引き渡しファイルの内容を入力してください。トークンは表示されません",
        }
    );
}

/// A desktop session exists, so a browser can be opened and seen.
pub(crate) fn a_desktop_session_is_available() -> bool {
    cfg!(any(target_os = "windows", target_os = "macos"))
        || std::env::var_os("DISPLAY").is_some()
        || std::env::var_os("WAYLAND_DISPLAY").is_some()
}

/// Both ends are a terminal: a question can be asked and the answer read.
pub(crate) fn interactive_terminal() -> bool {
    use std::io::IsTerminal as _;
    std::io::stdin().is_terminal() && std::io::stderr().is_terminal()
}

/// Whether this run should open the setup page by itself.
///
/// A browser is assumed wherever a desktop session exists, even when stdin is
/// not a terminal: an agent, a double-clicked launcher or `ssh -T` used to skip
/// the page and make the person paste the handoff file by hand, which is where
/// first-time setup stalled. A machine with no display keeps the URL line only,
/// and RDSH_SETUP_OPEN=0 forces that quiet behavior anywhere.
fn should_open_page() -> bool {
    if std::env::var_os("RDSH_SETUP_OPEN").is_some_and(|value| value == "0" || value == "false") {
        return false;
    }
    {
        use std::io::IsTerminal as _;
        if std::io::stdin().is_terminal() {
            return true;
        }
    }
    cfg!(any(target_os = "windows", target_os = "macos"))
        || std::env::var_os("DISPLAY").is_some()
        || std::env::var_os("WAYLAND_DISPLAY").is_some()
}

pub fn cmd_setup_web(
    port: u16,
    profile: &str,
    auto_import: bool,
    locale: crate::locale::Locale,
) -> anyhow::Result<()> {
    let listener = std::net::TcpListener::bind(format!("127.0.0.1:{port}")).map_err(|e| {
        anyhow::anyhow!(
            "{} 127.0.0.1:{port}: {e}",
            match locale {
                crate::locale::Locale::English => "cannot listen on",
                crate::locale::Locale::Chinese => "无法监听",
                crate::locale::Locale::Japanese => "待受できません",
            }
        )
    })?;
    listener.set_nonblocking(true)?;
    crate::shutdown::install(locale)?;
    let port = listener.local_addr()?.port();
    // 画面を開く前に、鍵の揃った検出経路を一度だけ登録する（既にある経路は触らない）。
    if auto_import {
        let added = crate::provider_detect::auto_import(profile, profile, locale);
        if !added.is_empty() {
            eprintln!(
                "[rdsh setup] {}: {}",
                match locale {
                    crate::locale::Locale::English => "added detected routes",
                    crate::locale::Locale::Chinese => "已添加检测到的路由",
                    crate::locale::Locale::Japanese => "検出した経路を追加しました",
                },
                added.join(", ")
            );
        }
    }
    let token = Arc::new(crate::local_http::random_token()?);
    let handoff = crate::token_handoff::TokenHandoff::create(&token, locale)?;
    let base = format!("http://127.0.0.1:{port}/");
    eprintln!(
        "[rdsh setup] {}: {base} ({})",
        match locale {
            crate::locale::Locale::English => "floating UI",
            crate::locale::Locale::Chinese => "浮动界面",
            crate::locale::Locale::Japanese => "フローティングUI",
        },
        match locale {
            crate::locale::Locale::English => "localhost only, Ctrl-C to stop",
            crate::locale::Locale::Chinese => "仅限 localhost，按 Ctrl-C 停止",
            crate::locale::Locale::Japanese => "localhost のみ、Ctrl-C で停止",
        }
    );
    eprintln!(
        "[rdsh setup] {}: {}",
        match locale {
            crate::locale::Locale::English => "token handoff file",
            crate::locale::Locale::Chinese => "令牌交接文件",
            crate::locale::Locale::Japanese => "トークン引き渡しファイル",
        },
        handoff.path().display()
    );
    // Keep the bearer token out of the browser-launch argv: open a protected
    // local launcher page that forwards with the token in the fragment, so a
    // first-time user lands on a connected page without pasting anything.
    //
    // The page is opened even when stdin is not a terminal (an agent, a
    // double-clicked launcher, `ssh -T`): asking the person to paste the
    // handoff file by hand is the step where first-time setup used to stall.
    // A machine with no display (CI, a container) has nobody to open a browser
    // for, so it keeps only the URL line above. RDSH_SETUP_OPEN=0 forces that
    // quiet behavior even where a browser would be reachable.
    let mut _launcher = None;
    if should_open_page() {
        // The launcher lives until the server exits. Explorer can report a
        // failure status after opening the page, so never open a second tab.
        let opened = match crate::token_handoff::TokenHandoff::launcher(&base, &token, locale) {
            Ok(launcher) => {
                let result = crate::auth::open_browser(&launcher.path().to_string_lossy(), locale);
                _launcher = Some(launcher);
                result
            }
            Err(_) => crate::auth::open_browser(&base, locale),
        };
        match opened {
            Ok(true) => {}
            Ok(false) | Err(_) => paste_hint(locale),
        }
    } else {
        paste_hint(locale);
    }
    let done = Arc::new(AtomicBool::new(false));
    let connections = Arc::new(AtomicUsize::new(0));
    loop {
        if done.load(Ordering::Relaxed) || crate::shutdown::requested() {
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
                    if let Err(e) = handle(s, &d, &token, port, locale) {
                        eprintln!("[rdsh setup] {e:#}");
                    }
                });
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
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
    let finish_after_response = req.method.as_str() == "POST"
        && req.target.as_str() == "/api/done"
        && req.authorized(token);
    if req.method.as_str() == "GET" {
        let asset = match req.target.as_str() {
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
    let (status, ctype, payload): (u16, &str, Cow<str>) =
        match (req.method.as_str(), req.target.as_str()) {
            ("GET", "/") => (
                200,
                "text/html; charset=utf-8",
                Cow::Owned(HTML.replace(
                    "__RDSH_LOCALE__",
                    match locale {
                        crate::locale::Locale::English => "en",
                        crate::locale::Locale::Chinese => "zh-CN",
                        crate::locale::Locale::Japanese => "ja",
                    },
                )),
            ),
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
                // Report the effective state: an explicit features.<id> wins
                // over the legacy extras list (issue #384).
                let cfg = crate::rdsh_config::load();
                (
                    200,
                    "application/json",
                    Cow::Owned(
                        serde_json::json!({"enable": crate::rdsh_config::enabled_extras(&cfg)})
                            .to_string(),
                    ),
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
            ("GET", "/api/webui") if !req.authorized(token) => (
                401,
                "application/json",
                Cow::Borrowed("{\"error\":\"unauthorized\"}"),
            ),
            ("GET", "/api/webui") => (
                200,
                "application/json",
                Cow::Owned(crate::desktop_webui::status(locale).to_json().to_string()),
            ),
            ("POST", "/api/webui") if !req.authorized(token) => (
                401,
                "application/json",
                Cow::Borrowed("{\"error\":\"unauthorized\"}"),
            ),
            ("POST", "/api/webui") if req.header("content-type") != Some("application/json") => (
                400,
                "application/json",
                Cow::Borrowed("{\"error\":\"JSON required\"}"),
            ),
            ("POST", "/api/webui") => match webui_body(&req.body) {
                Ok(enable) => match crate::desktop_webui::apply(enable, locale) {
                    Ok(state) => (
                        200,
                        "application/json",
                        Cow::Owned(state.to_json().to_string()),
                    ),
                    Err(e) => (
                        500,
                        "application/json",
                        Cow::Owned(serde_json::json!({"error": e.to_string()}).to_string()),
                    ),
                },
                Err(e) => (
                    400,
                    "application/json",
                    Cow::Owned(serde_json::json!({"error": e.to_string()}).to_string()),
                ),
            },
            ("GET", "/api/env") if !req.authorized(token) => (
                401,
                "application/json",
                Cow::Borrowed("{\"error\":\"unauthorized\"}"),
            ),
            ("GET", "/api/env") => (
                200,
                "application/json",
                Cow::Owned(crate::setup_wizard::env_json()),
            ),
            ("POST", "/api/share" | "/api/login" | "/api/start") if !req.authorized(token) => (
                401,
                "application/json",
                Cow::Borrowed("{\"error\":\"unauthorized\"}"),
            ),
            ("POST", "/api/share" | "/api/login" | "/api/start")
                if req.header("content-type") != Some("application/json") =>
            {
                (
                    400,
                    "application/json",
                    Cow::Borrowed("{\"error\":\"JSON required\"}"),
                )
            }
            ("POST", target @ ("/api/share" | "/api/login" | "/api/start")) => {
                match wizard_action(target, &req.body) {
                    Ok(value) => (200, "application/json", Cow::Owned(value.to_string())),
                    Err(e) => (
                        400,
                        "application/json",
                        Cow::Owned(serde_json::json!({"error": e.to_string()}).to_string()),
                    ),
                }
            }
            ("POST", "/api/done") if !req.authorized(token) => (
                401,
                "application/json",
                Cow::Borrowed("{\"error\":\"unauthorized\"}"),
            ),
            ("POST", "/api/done") => (200, "application/json", Cow::Borrowed("{\"ok\":true}")),
            _ => (
                404,
                "application/json",
                Cow::Borrowed("{\"error\":\"not found\"}"),
            ),
        };
    crate::local_http::respond(&mut s, status, ctype, payload.as_bytes())?;
    // The main thread can exit as soon as it observes done. Send the complete
    // acknowledgement first, and keep serving if writing the response fails.
    if finish_after_response {
        done.store(true, Ordering::Relaxed);
    }
    Ok(())
}

/// Wizard buttons: each body names one allowlisted target, never a command.
fn wizard_action(target: &str, body: &str) -> anyhow::Result<serde_json::Value> {
    let v: serde_json::Value = serde_json::from_str(body)?;
    let field = |name: &str| v.get(name).and_then(|x| x.as_str()).unwrap_or("");
    match target {
        "/api/share" => {
            let wrote = crate::auth::setup_share(field("selector"))?;
            Ok(serde_json::json!({"shared": true, "wrote": wrote}))
        }
        "/api/login" => {
            crate::setup_wizard::start_login(field("tool"))?;
            Ok(serde_json::json!({"started": true}))
        }
        _ => {
            crate::setup_wizard::start_chat(field("kind"))?;
            Ok(serde_json::json!({"started": true}))
        }
    }
}

/// The Web UI switch takes one strict boolean: anything else is a client bug.
fn webui_body(body: &str) -> anyhow::Result<bool> {
    let v: serde_json::Value = serde_json::from_str(body)?;
    v.get("enable")
        .and_then(|x| x.as_bool())
        .ok_or_else(|| anyhow::anyhow!("enable must be true or false"))
}

fn store_extras_body(body: &str) -> anyhow::Result<Vec<String>> {
    let v: serde_json::Value = serde_json::from_str(body)?;
    let arr = v
        .get("enable")
        .and_then(|x| x.as_array())
        .ok_or_else(|| anyhow::anyhow!("enable must be an array of extra names"))?;
    if arr.iter().any(|x| !x.is_string()) {
        anyhow::bail!("enable must be an array of extra names");
    }
    let requested: Vec<String> = arr
        .iter()
        .filter_map(|x| x.as_str())
        .map(|s| s.trim().to_string())
        .collect();
    let mut enable = Vec::new();
    crate::rdsh_config::update(crate::locale::Locale::English, |cfg| {
        // The setup switches are authoritative: write the canonical feature key
        // for every known extra and keep the legacy list in sync (issue #384).
        for id in crate::rdsh_config::KNOWN_EXTRAS {
            let on = requested.iter().any(|s| s == id);
            if on {
                enable.push((*id).to_string());
            }
            cfg.set_dotted(&format!("features.{id}"), if on { "true" } else { "false" })?;
        }
        cfg.extras.enable = enable.clone();
        Ok(())
    })?;
    Ok(enable)
}

fn store_key_body(body: &str) -> anyhow::Result<bool> {
    let v: serde_json::Value = serde_json::from_str(body)?;
    let name = v.get("name").and_then(|x| x.as_str()).unwrap_or("");
    let value = v.get("value").and_then(|x| x.as_str()).unwrap_or("");
    crate::auth::setup_store_key(name, value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read as _, Write as _};

    const TOKEN: &str = "test-token";

    /// One request through `handle` over a real loopback socket.
    fn call(request: impl FnOnce(u16) -> String) -> (u16, String, bool) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let mut client = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
        let (server, _) = listener.accept().unwrap();
        let done = AtomicBool::new(false);
        client.write_all(request(port).as_bytes()).unwrap();
        handle(server, &done, TOKEN, port, crate::locale::Locale::Japanese).unwrap();
        let mut bytes = Vec::new();
        client.read_to_end(&mut bytes).unwrap();
        let raw = String::from_utf8_lossy(&bytes);
        let status = raw[9..12].parse().unwrap();
        let body = raw
            .split_once("\r\n\r\n")
            .map(|(_, b)| b.to_string())
            .unwrap_or_default();
        (status, body, done.load(Ordering::Relaxed))
    }

    fn get(path: &'static str, token: Option<&'static str>) -> (u16, String, bool) {
        call(move |port| {
            let auth = token
                .map(|t| format!("X-RDSH-Token: {t}\r\n"))
                .unwrap_or_default();
            format!(
                "GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n{auth}Connection: close\r\n\r\n"
            )
        })
    }

    fn post(
        path: &'static str,
        ctype: &'static str,
        body: &'static str,
        token: bool,
    ) -> (u16, String, bool) {
        call(move |port| {
            let auth = if token {
                format!("X-RDSH-Token: {TOKEN}\r\n")
            } else {
                String::new()
            };
            format!(
                "POST {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n{auth}Content-Type: {ctype}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            )
        })
    }

    /// The platforms whose opener needs no display variable of its own.
    fn spawns_a_browser_without_one() -> bool {
        cfg!(any(target_os = "windows", target_os = "macos"))
    }

    #[test]
    fn the_page_opens_off_a_terminal_but_never_in_a_headless_session() {
        // The quiet switch wins over everything else.
        std::env::set_var("RDSH_SETUP_OPEN", "0");
        assert!(!should_open_page());
        std::env::remove_var("RDSH_SETUP_OPEN");
        // A desktop session opens the page even without a terminal on stdin,
        // which is the case an agent or a double-clicked launcher hits.
        // A terminal on stdin opens it on every platform.
        let stdin_is_terminal = {
            use std::io::IsTerminal as _;
            std::io::stdin().is_terminal()
        };
        assert_eq!(
            should_open_page(),
            stdin_is_terminal || spawns_a_browser_without_one()
        );
        // ...and a desktop session covers the case with no terminal at all.
        if !stdin_is_terminal {
            std::env::set_var("DISPLAY", ":1");
            let with_display = should_open_page();
            std::env::remove_var("DISPLAY");
            assert!(with_display);
        }
    }

    #[test]
    fn page_is_localized_and_api_requires_the_token() {
        let (status, page, _) = get("/", None);
        assert_eq!(status, 200);
        assert!(page.contains("<html lang=\"ja\" data-rdsh-locale=\"ja\">"));
        for path in ["/api/status", "/api/env", "/api/extras", "/api/webui"] {
            assert_eq!(get(path, None).0, 401, "{path}");
        }
        for path in [
            "/api/share",
            "/api/login",
            "/api/start",
            "/api/key",
            "/api/done",
            "/api/webui",
        ] {
            assert_eq!(post(path, "application/json", "{}", false).0, 401, "{path}");
        }
        assert_eq!(get("/missing", Some(TOKEN)).0, 404);
        assert_eq!(get("/icon.png", None).0, 200);
    }

    #[test]
    fn untrusted_hosts_are_refused() {
        let (status, _, _) =
            call(|_| "GET / HTTP/1.1\r\nHost: evil.example\r\nConnection: close\r\n\r\n".into());
        assert_eq!(status, 403);
    }

    #[test]
    fn environment_and_status_documents_are_served() {
        let (status, body, _) = get("/api/env", Some(TOKEN));
        assert_eq!(status, 200);
        let env: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(env["rdsh"], env!("CARGO_PKG_VERSION"));
        let (status, body, _) = get("/api/status", Some(TOKEN));
        assert_eq!(status, 200);
        assert!(serde_json::from_str::<serde_json::Value>(&body).unwrap()["needed"].is_boolean());
    }

    #[test]
    fn webui_route_reports_state_and_rejects_a_non_boolean_switch() {
        let (status, body, _) = get("/api/webui", Some(TOKEN));
        assert_eq!(status, 200);
        let state: serde_json::Value = serde_json::from_str(&body).unwrap();
        for key in ["unit_present", "enabled", "active", "client_present"] {
            assert!(state[key].is_boolean(), "{key} in {body}");
        }
        assert_eq!(post("/api/webui", "text/plain", "{}", true).0, 400);
        let (status, reply, _) = post("/api/webui", "application/json", "{}", true);
        assert_eq!(status, 400);
        assert!(reply.contains("enable"), "{reply}");
        for body in ["{\"enable\":\"yes\"}", "{\"enable\":1}", "not json"] {
            assert_eq!(
                post("/api/webui", "application/json", body, true).0,
                400,
                "{body}"
            );
        }
    }

    #[test]
    fn wizard_actions_need_json_and_refuse_unknown_targets() {
        for path in ["/api/share", "/api/login", "/api/start"] {
            assert_eq!(post(path, "text/plain", "{}", true).0, 400, "{path}");
        }
        let (status, body, _) = post(
            "/api/login",
            "application/json",
            "{\"tool\":\"bash\"}",
            true,
        );
        assert_eq!(status, 400);
        assert!(body.contains("login helper is not installed"));
        let (status, body, _) = post(
            "/api/start",
            "application/json",
            "{\"kind\":\"shell\"}",
            true,
        );
        assert_eq!(status, 400);
        assert!(body.contains("unknown start target"));
        let (status, body, _) = post(
            "/api/share",
            "application/json",
            "{\"selector\":\"nowhere:none\"}",
            true,
        );
        assert_eq!(status, 400);
        assert!(body.contains("credential is not available to share"));
        assert_eq!(
            post("/api/share", "application/json", "not json", true).0,
            400
        );
    }

    #[test]
    fn done_stops_the_server_after_answering() {
        let (status, body, done) = post("/api/done", "application/json", "{}", true);
        assert_eq!((status, body.as_str(), done), (200, "{\"ok\":true}", true));
    }
}
