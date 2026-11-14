//! Standalone, authenticated loopback GUI backed exclusively by Rust-owned state.
mod claude;
mod compaction;
mod engine;
mod oauth;
mod profiles;
mod sdk;
mod tools;

use anyhow::{bail, Result};
use engine::{Engine, Event, Message, State};
use serde::Deserialize;
use serde_json::{json, Value};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::{atomic::AtomicUsize, Arc, Mutex};
use tokio::runtime::Runtime;
const UI: &str = include_str!("ui.html");

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ModelRequest {
    provider: String,
    model: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct MessageRequest {
    text: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ApprovalRequest {
    id: String,
    allow: bool,
}

pub fn cmd_native_web(
    port: u16,
    workspace: PathBuf,
    sdk_dir: Option<PathBuf>,
    dsh_profile: Option<String>,
    dsh_catalog: Option<PathBuf>,
    devin: Option<PathBuf>,
    locale: crate::locale::Locale,
) -> Result<()> {
    let workspace = workspace.canonicalize()?;
    if !workspace.is_dir() {
        bail!("--workspaceは既存のディレクトリを指定してください");
    }
    let bridge_dir = if let Some(path) = sdk_dir {
        path.canonicalize()?
    } else {
        std::env::current_dir()?.join("plugins/rdsh-direct-models")
    };
    let registry = if let Some(profile) = dsh_profile {
        profiles::Registry::load(&profile, dsh_catalog)?
    } else if PathBuf::from(crate::inspect::dsh_home())
        .join("profiles/web")
        .is_dir()
    {
        profiles::Registry::load("web", dsh_catalog)?
    } else {
        profiles::Registry::default()
    };
    let refs = crate::auth::stored_refs();
    let agy_key = ["GEMINI_API_KEY", "GOOGLE_API_KEY"]
        .into_iter()
        .find_map(|key| {
            std::env::var(key)
                .ok()
                .filter(|v| !v.is_empty())
                .or_else(|| refs.get(key).cloned())
        });
    let mut secrets: Vec<String> = refs.into_values().collect();
    secrets.extend(registry.routes.iter().filter_map(|r| r.key.clone()));
    for (name, value) in std::env::vars() {
        if name.contains("TOKEN") || name.contains("API_KEY") || name.contains("SECRET") {
            secrets.push(value);
        }
    }
    if let Some(key) = &agy_key {
        secrets.push(key.clone());
    }
    // Cursor's SDK owns its store; only its known API-key field participates in
    // output masking. It is never copied to model context or another store.
    if let Some(home) = crate::auth::home() {
        if let Ok(raw) = std::fs::read_to_string(PathBuf::from(home).join(".cursor/sdk/auth.json"))
        {
            if let Ok(value) = serde_json::from_str::<Value>(&raw) {
                collect_secret_fields(&value, &mut secrets);
            }
        }
    }
    secrets.retain(|s| s.len() >= 6);
    secrets.sort_by_key(|s| std::cmp::Reverse(s.len()));
    secrets.dedup();
    let devin = devin.unwrap_or_else(|| {
        crate::auth::home()
            .map(|h| PathBuf::from(h).join(".local/bin/devin"))
            .unwrap_or_else(|| PathBuf::from("devin"))
    });
    let engine = Arc::new(Engine {
        compaction: crate::compaction_config::Options::load()?,
        state: Mutex::new(State::default()),
        workspace,
        sdk: sdk::SdkConfig {
            bridge_dir,
            agy_key,
        },
        devin,
        registry,
        secrets,
    });
    let runtime = Arc::new(
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()?,
    );
    let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port))?;
    let port = listener.local_addr()?.port();
    listener.set_nonblocking(true)?;
    let token = Arc::new(crate::local_http::random_token()?);
    let handoff = crate::token_handoff::TokenHandoff::create(&token, locale)?;
    crate::shutdown::install(locale)?;
    eprintln!("[rdsh native-web] Rust inference loop / tools / approvals; DSH is not used");
    eprintln!("[rdsh native-web] http://127.0.0.1:{port}/");
    eprintln!("[rdsh native-web] token file: {}", handoff.path().display());
    let slots = Arc::new(AtomicUsize::new(0));
    while !crate::shutdown::requested() {
        match listener.accept() {
            Ok((mut stream, _)) => {
                let Some(slot) = crate::local_http::ConnectionSlot::acquire(&slots) else {
                    let _ = respond(&mut stream, 503, "application/json", r#"{"error":"busy"}"#);
                    continue;
                };
                let engine = engine.clone();
                let token = token.clone();
                let runtime = runtime.clone();
                std::thread::spawn(move || {
                    let _slot = slot;
                    let _ = handle(stream, &token, port, engine, runtime);
                });
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(std::time::Duration::from_millis(10))
            }
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
            Err(e) => return Err(e.into()),
        }
    }
    engine.cancel();
    Ok(())
}
fn collect_secret_fields(value: &Value, secrets: &mut Vec<String>) {
    match value {
        Value::Object(map) => {
            for (key, value) in map {
                let key = key.to_ascii_lowercase();
                if key.contains("key") || key.contains("token") || key.contains("secret") {
                    if let Some(s) = value.as_str() {
                        secrets.push(s.into());
                    }
                }
                collect_secret_fields(value, secrets);
            }
        }
        Value::Array(values) => {
            for value in values {
                collect_secret_fields(value, secrets);
            }
        }
        _ => {}
    }
}
fn respond(
    stream: &mut TcpStream,
    status: u16,
    ctype: &str,
    payload: impl AsRef<[u8]>,
) -> std::io::Result<()> {
    use std::io::Write;
    let payload = payload.as_ref();
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        413 => "Payload Too Large",
        503 => "Service Unavailable",
        _ => "Error",
    };
    write!(stream,"HTTP/1.1 {status} {reason}\r\nContent-Type: {ctype}\r\nContent-Length: {}\r\nConnection: close\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nReferrer-Policy: no-referrer\r\nContent-Security-Policy: default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'\r\n\r\n",payload.len())?;
    stream.write_all(payload)
}

fn handle(
    mut stream: TcpStream,
    token: &str,
    port: u16,
    engine: Arc<Engine>,
    runtime: Arc<Runtime>,
) -> Result<()> {
    let req = match crate::local_http::read_request(&mut stream) {
        Ok(req) => req,
        Err(crate::local_http::ReadRequestError::Idle) => return Ok(()),
        Err(crate::local_http::ReadRequestError::Status(code)) => {
            respond(
                &mut stream,
                code,
                "application/json",
                r#"{"error":"invalid request"}"#,
            )?;
            return Ok(());
        }
    };
    if !req.trusted(port) {
        respond(
            &mut stream,
            403,
            "application/json",
            r#"{"error":"origin rejected"}"#,
        )?;
        return Ok(());
    }
    if req.method == "GET" && req.target == "/" {
        respond(&mut stream, 200, "text/html; charset=utf-8", UI)?;
        return Ok(());
    }
    if !req.authorized(token) {
        respond(
            &mut stream,
            401,
            "application/json",
            r#"{"error":"認証トークンが必要です"}"#,
        )?;
        return Ok(());
    }
    let result = dispatch(&req.method, &req.target, &req.body, engine.clone(), runtime);
    let (code, mut value) = match result {
        Ok(value) => (200, value),
        Err(error) => (400, json!({"error":engine.redact(&error.to_string())})),
    };
    engine.redact_value(&mut value);
    respond(
        &mut stream,
        code,
        "application/json",
        serde_json::to_vec(&value)?,
    )?;
    Ok(())
}
fn dispatch(
    method: &str,
    path: &str,
    body: &str,
    engine: Arc<Engine>,
    runtime: Arc<Runtime>,
) -> Result<Value> {
    match (method, path) {
        ("GET", "/api/state") => Ok(engine.snapshot()),
        ("POST", "/api/model") => {
            let req: ModelRequest =
                serde_json::from_str(body).map_err(|_| anyhow::anyhow!("モデル指定が不正です"))?;
            if !engine.model_allowed(&req.provider, &req.model) {
                bail!("登録済みモデルを選択してください");
            }
            let mut s = engine.state.lock().unwrap();
            if matches!(s.status.as_str(), "running" | "approval") {
                bail!("実行中はモデルを変更できません");
            }
            s.provider = req.provider;
            s.model = req.model;
            s.error = None;
            s.status = "idle".into();
            let content = format!("Rustモデル選択: {} / {}", s.provider, s.model);
            s.events.push(Event {
                kind: "model".into(),
                name: "select".into(),
                content,
            });
            Ok(json!({"ok":true}))
        }
        ("POST", "/api/message") => {
            let req: MessageRequest =
                serde_json::from_str(body).map_err(|_| anyhow::anyhow!("メッセージが不正です"))?;
            if req.text.trim().is_empty() || req.text.len() > 16 * 1024 {
                bail!("メッセージは1〜16384バイトで入力してください");
            }
            let mut s = engine.state.lock().unwrap();
            if matches!(s.status.as_str(), "running" | "approval") {
                bail!("実行中です");
            }
            let message = Message {
                role: "user".into(),
                content: engine.redact(&req.text),
            };
            // Measure the way the loop does. A message that does not fit is
            // held back: the run compacts the finished turns first and appends
            // it only if that made room, so a refusal never grows the history.
            let deferred = if engine::fits_with(&s.messages, &message) {
                s.messages.push(message);
                None
            } else if engine.compaction.native_web.enabled {
                Some(message)
            } else {
                bail!("会話がサイズ上限に達しています");
            };
            s.error = None;
            s.status = "running".into();
            s.run_id += 1;
            let id = s.run_id;
            let next = engine.clone();
            let task = runtime.spawn(async move {
                next.run_admitting(id, deferred).await;
            });
            s.task = Some(task.abort_handle());
            Ok(json!({"ok":true}))
        }
        ("POST", "/api/approval") => {
            let req: ApprovalRequest =
                serde_json::from_str(body).map_err(|_| anyhow::anyhow!("承認指定が不正です"))?;
            engine.approve(&req.id, req.allow)?;
            Ok(json!({"ok":true}))
        }
        ("POST", "/api/cancel") => {
            let _: serde_json::Map<String, Value> = serde_json::from_str(body)?;
            engine.cancel();
            Ok(json!({"ok":true}))
        }
        _ => bail!("endpoint not found"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn http_fences_protect_state_and_model_mutation() {
        use std::io::{Read, Write};
        let e = engine();
        let runtime = Arc::new(
            tokio::runtime::Builder::new_multi_thread()
                .worker_threads(1)
                .enable_all()
                .build()
                .unwrap(),
        );
        let request = |path: &str, headers: &str, body: Option<&str>| {
            let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).unwrap();
            let port = listener.local_addr().unwrap().port();
            let next = e.clone();
            let runtime = runtime.clone();
            let task = std::thread::spawn(move || {
                let (stream, _) = listener.accept().unwrap();
                handle(stream, "test-token", port, next, runtime).unwrap();
            });
            let mut client = TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, port)).unwrap();
            let method = if body.is_some() { "POST" } else { "GET" };
            let headers = headers.replace("$PORT", &port.to_string());
            write!(client,"{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n{headers}Content-Length: {}\r\n\r\n{}",body.unwrap_or("").len(),body.unwrap_or("")).unwrap();
            let mut response = String::new();
            client.read_to_string(&mut response).unwrap();
            task.join().unwrap();
            response
        };
        let response = request("/api/state", "", None);
        assert!(response.starts_with("HTTP/1.1 401"));
        assert!(!response.contains("rust-rdsh"));
        let response = request(
            "/api/state",
            "x-rdsh-token: test-token\r\nOrigin: https://evil.invalid\r\n",
            None,
        );
        assert!(response.starts_with("HTTP/1.1 403"));
        let body = r#"{"provider":"agy-sdk","model":"gemini-3.7-flash"}"#;
        let response = request(
            "/api/model",
            "x-rdsh-token: test-token\r\nSec-Fetch-Site: same-origin\r\n",
            Some(body),
        );
        assert!(response.starts_with("HTTP/1.1 403"));
        assert_eq!(e.snapshot()["provider"], "cursor-sdk");
        let response = request(
            "/api/model",
            "x-rdsh-token: test-token\r\nOrigin: http://127.0.0.1:$PORT\r\n",
            Some(body),
        );
        assert!(response.starts_with("HTTP/1.1 200"));
        assert_eq!(e.snapshot()["provider"], "agy-sdk");
        let response = request("/api/state", "x-rdsh-token: test-token\r\n", None);
        assert!(response.contains("rust-rdsh"));
        assert!(response.contains("Cache-Control: no-store"));
        assert!(response.contains("frame-ancestors 'none'"));
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn cancellation_after_approval_prevents_devin_spawn() {
        use std::os::unix::fs::PermissionsExt;
        let root = std::env::temp_dir().join(format!(
            "rdsh-deny-spawn-{}",
            crate::local_http::random_token().unwrap()
        ));
        std::fs::create_dir(&root).unwrap();
        let cli = root.join("devin-test");
        std::fs::write(&cli, "#!/bin/sh\n: > \"$0.started\"\n").unwrap();
        std::fs::set_permissions(&cli, std::fs::Permissions::from_mode(0o700)).unwrap();
        let e = Arc::new(Engine {
            compaction: crate::compaction_config::Options::default(),
            state: Mutex::new(State::default()),
            workspace: root.clone(),
            sdk: sdk::SdkConfig {
                bridge_dir: root.clone(),
                agy_key: None,
            },
            devin: cli,
            registry: profiles::Registry::default(),
            secrets: vec![],
        });
        let (tx, _rx) = tokio::sync::oneshot::channel();
        {
            let mut s = e.state.lock().unwrap();
            s.run_id = 1;
            s.status = "approval".into();
            s.pending = Some(engine::Pending {
                id: "exact".into(),
                tool: "devin_cli".into(),
                arguments: json!({"prompt":"hello"}),
                reason: "test".into(),
            });
            s.decision = Some(tx);
        }
        e.approve("exact", true).unwrap();
        e.cancel();
        let call = engine::Call {
            id: "call".into(),
            name: "devin_cli".into(),
            arguments: json!({"prompt":"hello"}),
        };
        assert_eq!(
            tools::execute(&e, 1, &call).await.unwrap_err().to_string(),
            "cancelled"
        );
        assert!(!root.join("devin-test.started").exists());
        std::fs::remove_dir_all(root).unwrap();
    }
    /// An engine whose finished turns leave no room for one more message.
    fn full_engine(enabled: bool, registry: profiles::Registry) -> Arc<Engine> {
        let mut compaction = crate::compaction_config::Options::default();
        compaction.native_web.enabled = enabled;
        let reply = |text: &str, count: usize| Message {
            role: "assistant".into(),
            content: text.repeat(count),
        };
        let user = |text: &str| Message {
            role: "user".into(),
            content: text.into(),
        };
        Arc::new(Engine {
            compaction,
            state: Mutex::new(State {
                provider: "dsh:test".into(),
                model: "test-model".into(),
                messages: vec![
                    user("original goal"),
                    reply("first long reply. ", 16_000),
                    user("continue"),
                    reply("second long reply. ", 14_000),
                ],
                ..State::default()
            }),
            workspace: std::env::temp_dir(),
            sdk: sdk::SdkConfig {
                bridge_dir: std::env::temp_dir(),
                agy_key: None,
            },
            devin: PathBuf::from("devin"),
            registry,
            secrets: vec![],
        })
    }
    fn post_message(e: &Arc<Engine>, runtime: &Arc<Runtime>) -> Result<Value> {
        dispatch(
            "POST",
            "/api/message",
            r#"{"text":"next request"}"#,
            e.clone(),
            runtime.clone(),
        )
    }
    /// Wait for the spawned run to leave the running state.
    fn settled(e: &Arc<Engine>) -> Value {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
        loop {
            let snapshot = e.snapshot();
            if snapshot["status"] != "running" {
                return snapshot;
            }
            assert!(std::time::Instant::now() < deadline, "run did not settle");
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
    }
    fn runtime() -> Arc<Runtime> {
        Arc::new(
            tokio::runtime::Builder::new_multi_thread()
                .worker_threads(1)
                .enable_all()
                .build()
                .unwrap(),
        )
    }
    #[test]
    fn a_full_history_refuses_at_admission_only_when_compaction_is_off() {
        let e = full_engine(false, profiles::Registry::default());
        let before = e.snapshot()["messages"].clone();
        let error = post_message(&e, &runtime()).unwrap_err();
        assert_eq!(error.to_string(), "会話がサイズ上限に達しています");
        assert_eq!(e.snapshot()["messages"], before);
        assert_eq!(e.snapshot()["status"], "idle");
    }
    #[test]
    fn a_full_history_is_compacted_before_the_message_is_admitted() {
        // One reply: the summary. The model call of the turn then finds the
        // stand-in provider closed, which ends the run after admission.
        let (url, server) = profiles::tests::mock(vec![(
            200,
            json!({"choices":[{"message":{"content":"kept facts"}}]}),
        )]);
        let e = full_engine(true, profiles::tests::registry("openai-completions", &url));
        // The runtime owns the spawned run; it must outlive the request.
        let runtime = runtime();
        assert_eq!(post_message(&e, &runtime).unwrap(), json!({"ok":true}));
        let snapshot = settled(&e);
        let requests = server.join().unwrap();
        assert!(requests[0].1["messages"][0]["content"]
            .as_str()
            .unwrap()
            .contains("compaction engine"));
        let messages = snapshot["messages"].as_array().unwrap();
        assert_eq!(messages[0]["content"], "original goal");
        assert!(messages.iter().any(|m| m["role"] == "summary"));
        assert_eq!(messages.last().unwrap()["content"], "next request");
        assert!(serde_json::to_vec(messages).unwrap().len() <= engine::MAX_HISTORY);
    }
    #[test]
    fn a_failed_compaction_refuses_the_message_without_growing_the_history() {
        let (url, server) = profiles::tests::mock(vec![(
            500,
            json!({"choices":[{"message":{"content":"bad"}}]}),
        )]);
        let e = full_engine(true, profiles::tests::registry("openai-completions", &url));
        let before = e.snapshot()["messages"].clone();
        // The message is held back, so a refusal cannot accumulate requests.
        let runtime = runtime();
        assert_eq!(post_message(&e, &runtime).unwrap(), json!({"ok":true}));
        let snapshot = settled(&e);
        server.join().unwrap();
        assert_eq!(snapshot["status"], "error");
        assert_eq!(snapshot["error"], "会話がサイズ上限に達しています");
        assert_eq!(snapshot["messages"], before);
    }
    fn engine() -> Arc<Engine> {
        Arc::new(Engine {
            compaction: crate::compaction_config::Options::default(),
            state: Mutex::new(State::default()),
            workspace: std::env::temp_dir(),
            sdk: sdk::SdkConfig {
                bridge_dir: std::env::temp_dir(),
                agy_key: None,
            },
            devin: PathBuf::from("devin"),
            registry: profiles::Registry::default(),
            secrets: vec!["synthetic-secret-key".into()],
        })
    }
    #[test]
    fn approval_is_single_use_and_exact_id() {
        let e = engine();
        let (tx, mut rx) = tokio::sync::oneshot::channel();
        {
            let mut s = e.state.lock().unwrap();
            s.status = "approval".into();
            s.pending = Some(engine::Pending {
                id: "exact".into(),
                tool: "devin_cli".into(),
                arguments: json!({"prompt":"hello"}),
                reason: "test".into(),
            });
            s.decision = Some(tx);
        }
        assert!(e.approve("wrong", true).is_err());
        assert!(rx.try_recv().is_err());
        e.approve("exact", false).unwrap();
        assert!(!rx.try_recv().unwrap());
        assert!(e.approve("exact", true).is_err());
    }
    #[test]
    fn cancel_invalidates_approval_and_masks_known_credentials() {
        let e = engine();
        let (tx, rx) = tokio::sync::oneshot::channel();
        e.state.lock().unwrap().decision = Some(tx);
        e.cancel();
        assert!(rx.blocking_recv().is_err());
        assert!(e.approve("old", true).is_err());
        assert_eq!(
            e.redact("prefix synthetic-secret-key suffix"),
            "prefix [REDACTED] suffix"
        );
    }
}
