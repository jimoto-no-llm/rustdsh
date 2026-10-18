//! `rdsh-desktop`: a native GPUI shell that renders the dashboard design and
//! fills it from the `rdsh` binary. No Electron, no Node, no web server.
//!
//! `--print-json` runs the data layer without a window, which is what CI and the
//! tests use; the window itself only renders the same snapshot.

mod api;
mod app;
mod cookies;
mod editor;
mod host;
mod http;
mod live;
mod mux;
mod rdsh;
mod theme;
mod web;

use gpui::*;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();

    if args.iter().any(|arg| arg == "--help" || arg == "-h") {
        println!(
            "rdsh-desktop {}\n\nUSAGE:\n  rdsh-desktop [--serve-web [--port N]] [--print-json] [--probe]\n\nOPTIONS:\n  --serve-web   Serve the same harness session as a local web UI on 127.0.0.1 (no window)\n  --port N      Port for --serve-web (default {})\n  --print-json  Collect one native rdsh snapshot and print it as JSON (no window)\n  --probe       Start the harness host, exchange the token and print the conversation list (no window)\n  -h, --help    Show this help",
            env!("CARGO_PKG_VERSION"),
            web::DEFAULT_PORT
        );
        return;
    }

    if args.iter().any(|arg| arg == "--serve-web") {
        let port = args
            .iter()
            .position(|arg| arg == "--port")
            .and_then(|index| args.get(index + 1))
            .and_then(|value| value.parse::<u16>().ok())
            .unwrap_or(web::DEFAULT_PORT);
        if port == 0 {
            eprintln!("[rdsh-desktop] --port needs a port in 1..=65535");
            std::process::exit(2);
        }
        match web::WebServer::start(port) {
            Ok(server) => {
                println!(
                    "[rdsh-desktop] ローカル Web UI (port {}): {}",
                    server.port(),
                    server.url()
                );
                println!(
                    "[rdsh-desktop] 127.0.0.1 のみにバインドしています。上の URL をそのまま開いてください。"
                );
                println!(
                    "[rdsh-desktop] URL の token は推測困難なアクセス用の値で、ハーネスの cookie やトークンはこのプロセスから外へ出ません。"
                );
                println!("[rdsh-desktop] 停止するには Ctrl+C を押してください。");
                if let Err(error) = publish_web_url(&server.url()) {
                    eprintln!("[rdsh-desktop] URL ファイルを書けませんでした: {error:#}");
                }
                if let Err(error) = server.serve() {
                    eprintln!("[rdsh-desktop] serve-web failed: {error:#}");
                    std::process::exit(1);
                }
            }
            Err(error) => {
                eprintln!("[rdsh-desktop] serve-web failed: {error:#}");
                std::process::exit(1);
            }
        }
        return;
    }

    if let Some(index) = args.iter().position(|arg| arg == "--send") {
        let text = args.get(index + 1).cloned().unwrap_or_default();
        if text.is_empty() {
            eprintln!("[rdsh-desktop] --send needs a prompt");
            std::process::exit(2);
        }
        let session = args
            .iter()
            .position(|arg| arg == "--session")
            .and_then(|index| args.get(index + 1))
            .map(String::as_str);
        let listen = args
            .iter()
            .position(|arg| arg == "--listen")
            .and_then(|index| args.get(index + 1))
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(60);
        let provider = args
            .iter()
            .position(|arg| arg == "--provider")
            .and_then(|index| args.get(index + 1))
            .map(String::as_str);
        let model = args
            .iter()
            .position(|arg| arg == "--model")
            .and_then(|index| args.get(index + 1))
            .map(String::as_str);
        let model = match (provider, model) {
            (Some(provider), Some(model)) => Some((provider, model)),
            _ => None,
        };
        match send_probe(&text, session, listen, model) {
            Ok(report) => println!("{report}"),
            Err(error) => {
                eprintln!("[rdsh-desktop] send failed: {error:#}");
                std::process::exit(1);
            }
        }
        return;
    }

    if args.iter().any(|arg| arg == "--dump-titles") {
        let limit = args
            .iter()
            .position(|arg| arg == "--limit")
            .and_then(|index| args.get(index + 1))
            .and_then(|value| value.parse::<usize>().ok())
            .unwrap_or(20);
        match dump_titles(limit) {
            Ok(report) => println!("{report}"),
            Err(error) => {
                eprintln!("[rdsh-desktop] dump-titles failed: {error:#}");
                std::process::exit(1);
            }
        }
        return;
    }

    if args.iter().any(|arg| arg == "--select-model") {
        let session = args
            .iter()
            .position(|arg| arg == "--session")
            .and_then(|index| args.get(index + 1))
            .map(String::as_str)
            .unwrap_or_default();
        let provider = args
            .iter()
            .position(|arg| arg == "--provider")
            .and_then(|index| args.get(index + 1))
            .map(String::as_str)
            .unwrap_or_default();
        let model = args
            .iter()
            .position(|arg| arg == "--model")
            .and_then(|index| args.get(index + 1))
            .map(String::as_str)
            .unwrap_or_default();
        if session.is_empty() || provider.is_empty() || model.is_empty() {
            eprintln!("[rdsh-desktop] --select-model needs --session --provider --model");
            std::process::exit(2);
        }
        match select_model(session, provider, model) {
            Ok(report) => println!("{report}"),
            Err(error) => {
                eprintln!("[rdsh-desktop] select-model failed: {error:#}");
                std::process::exit(1);
            }
        }
        return;
    }

    if args.iter().any(|arg| arg == "--check-host") {
        let online = args.iter().any(|arg| arg == "--online");
        match check_host(online) {
            Ok(report) => println!("{report}"),
            Err(error) => {
                eprintln!("[rdsh-desktop] check-host failed: {error:#}");
                std::process::exit(1);
            }
        }
        return;
    }

    if args.iter().any(|arg| arg == "--stop-host") {
        match host::stop_cached() {
            Ok(message) => println!("{message}"),
            Err(error) => {
                eprintln!("[rdsh-desktop] stop-host failed: {error:#}");
                std::process::exit(1);
            }
        }
        return;
    }

    if args.iter().any(|arg| arg == "--new-session") {
        match dump_new_session() {
            Ok(report) => println!("{report}"),
            Err(error) => {
                eprintln!("[rdsh-desktop] new-session failed: {error:#}");
                std::process::exit(1);
            }
        }
        return;
    }

    if args.iter().any(|arg| arg == "--dump-live") {
        let secs = args
            .iter()
            .position(|arg| arg == "--listen")
            .and_then(|index| args.get(index + 1))
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(12);
        match dump_live(secs) {
            Ok(report) => println!("{report}"),
            Err(error) => {
                eprintln!("[rdsh-desktop] dump-live failed: {error:#}");
                std::process::exit(1);
            }
        }
        return;
    }

    if args.iter().any(|arg| arg == "--dump-session") {
        let session = args
            .iter()
            .position(|arg| arg == "--session")
            .and_then(|index| args.get(index + 1))
            .map(String::as_str);
        match dump_session(session) {
            Ok(report) => println!("{report}"),
            Err(error) => {
                eprintln!("[rdsh-desktop] dump-session failed: {error:#}");
                std::process::exit(1);
            }
        }
        return;
    }

    if args.iter().any(|arg| arg == "--dump-ui") {
        match dump_ui() {
            Ok(report) => println!("{report}"),
            Err(error) => {
                eprintln!("[rdsh-desktop] dump failed: {error:#}");
                std::process::exit(1);
            }
        }
        return;
    }

    if args.iter().any(|arg| arg == "--probe") {
        match probe() {
            Ok(report) => println!("{report}"),
            Err(error) => {
                eprintln!("[rdsh-desktop] probe failed: {error:#}");
                std::process::exit(1);
            }
        }
        return;
    }

    if args.iter().any(|arg| arg == "--print-json") {
        let snapshot = rdsh::snapshot();
        match serde_json::to_string_pretty(&snapshot) {
            Ok(text) => println!("{text}"),
            Err(error) => {
                eprintln!("[rdsh-desktop] {error}");
                std::process::exit(1);
            }
        }
        return;
    }

    // A fixed origin and size keeps screenshots and window management
    // predictable; the layout itself stays fluid inside it.
    let bounds = Bounds::new(point(px(80.), px(80.)), size(px(1280.), px(860.)));
    let options = WindowOptions {
        window_bounds: Some(WindowBounds::Windowed(bounds)),
        ..Default::default()
    };

    // Fail with a clear message instead of a panic when started outside a
    // graphical session (for example from a service or a plain SSH shell).
    if std::env::var_os("WAYLAND_DISPLAY").is_none() && std::env::var_os("DISPLAY").is_none() {
        eprintln!(
            "[rdsh-desktop] no graphical session: set WAYLAND_DISPLAY or DISPLAY, or use a headless mode such as --dump-ui"
        );
        std::process::exit(1);
    }

    // GPUI reports renderer and window problems through `log`; without a
    // subscriber a failed surface looks like an idle process.
    let mut logger = env_logger::Builder::from_env(
        env_logger::Env::default().default_filter_or("warn,rdsh_desktop=info"),
    );
    if let Some(path) = std::env::var_os("RDSH_DESKTOP_LOG") {
        if let Ok(file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
        {
            logger.target(env_logger::Target::Pipe(Box::new(file)));
        }
    }
    logger.init();
    log::info!("rdsh-desktop {} starting", env!("CARGO_PKG_VERSION"));

    Application::new().run(|cx: &mut App| {
        cx.open_window(options, |window, cx| {
            let bounds = window.bounds();
            log::info!(
                "window opened: x={:?} y={:?} w={:?} h={:?}",
                bounds.origin.x,
                bounds.origin.y,
                bounds.size.width,
                bounds.size.height
            );
            cx.new(app::DesktopApp::new)
        })
        .expect("open the rdsh window");
        cx.activate(true);
        log::info!("window activated");
    });
}







/// Switch the model of one conversation (used by tests and by the operator).
fn select_model(session: &str, provider: &str, model: &str) -> anyhow::Result<String> {
    let mut chat = app::Chat::connect(|_step| {})?;
    chat.switch_model(session, provider, model)?;
    let value = chat
        .projections(session)
        .map(|value| {
            value
                .get("modelSelection")
                .cloned()
                .unwrap_or(serde_json::Value::Null)
        })
        .unwrap_or(serde_json::Value::Null);
    Ok(serde_json::to_string_pretty(&serde_json::json!({
        "session": session,
        "provider": provider,
        "model": model,
        "modelSelection": value,
    }))?)
}


/// Write the Web UI URL where a background service user can read it.
fn publish_web_url(url: &str) -> anyhow::Result<()> {
    let path = match std::env::var_os("RDSH_DESKTOP_WEB_URL_FILE") {
        Some(value) => std::path::PathBuf::from(value),
        None => {
            let base = std::env::var_os("XDG_CACHE_HOME")
                .map(std::path::PathBuf::from)
                .or_else(|| {
                    std::env::var_os("HOME").map(|home| std::path::PathBuf::from(home).join(".cache"))
                })
                .ok_or_else(|| anyhow::anyhow!("neither XDG_CACHE_HOME nor HOME is set"))?;
            base.join("rdsh-desktop").join("webui.url")
        }
    };
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&path, format!("{url}\n"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
    }
    println!("[rdsh-desktop] URL を {} に保存しました", path.display());
    Ok(())
}

/// Report which harness launcher the app would use and whether it answers.
fn check_host(online: bool) -> anyhow::Result<String> {
    let (binary, version) = host::resolve_launcher()?;
    let latest = if online { host::latest_published() } else { None };
    let newest = if online { host::newest_published() } else { None };
    let chat = app::Chat::connect(|_step| {})?;
    let newer = newest
        .as_ref()
        .map(|newest| host::compare_versions(newest, chat.host_version()).is_gt())
        .unwrap_or(false);
    Ok(serde_json::to_string_pretty(&serde_json::json!({
        "launcher": binary.display().to_string(),
        "version": version,
        "activeVersion": chat.host_version(),
        "attached": chat.reused,
        "sessions": chat.sessions.len(),
        "catalogProviders": chat.catalog.len(),
        "latestPublished": latest,
        "newestPublished": newest,
        "updateAvailable": newer,
    }))?)
}

/// Highest published harness version, including prereleases.
fn newest_published() -> Option<String> {
    let mut command = std::process::Command::new("npm");
    command.args(["view", "@deepseek-ai/dsh", "versions", "--json"]);
    if let Some(path) = std::env::var_os("PATH") {
        command.env("PATH", path);
    }
    let output = command.output().ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let versions: Vec<String> = match serde_json::from_str::<serde_json::Value>(text.trim()) {
        Ok(serde_json::Value::Array(values)) => values
            .into_iter()
            .filter_map(|value| value.as_str().map(str::to_string))
            .collect(),
        Ok(serde_json::Value::String(single)) => vec![single],
        _ => Vec::new(),
    };
    versions.into_iter().reduce(|best, candidate| {
        if host::compare_versions(&candidate, &best).is_gt() {
            candidate
        } else {
            best
        }
    })
}

/// Newest published harness version, when npm can answer.
fn latest_published() -> Option<String> {
    let mut command = std::process::Command::new("npm");
    command.args(["view", "@deepseek-ai/dsh", "version"]);
    if let Some(path) = std::env::var_os("PATH") {
        command.env("PATH", path);
    }
    let output = command.output().ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let version = text.split_whitespace().last()?.trim().to_string();
    (!version.is_empty()).then_some(version)
}

/// Verify that conversation titles resolve (the window fills them in the
/// background; this mode does the same work sequentially).
fn dump_titles(limit: usize) -> anyhow::Result<String> {
    use std::time::Instant;
    let mut chat = app::Chat::connect(|_step| {})?;
    let started = Instant::now();
    let mut titles = Vec::new();
    chat.fill_titles(limit, |batch| titles.extend(batch));
    Ok(serde_json::to_string_pretty(&serde_json::json!({
        "requested": limit,
        "loaded": titles.len(),
        "ms": started.elapsed().as_millis(),
        "reused": chat.reused,
        "sample": titles.iter().take(5).map(|(_, title)| title.clone()).collect::<Vec<_>>(),
    }))?)
}

/// Create one conversation through the host and report its id.
fn dump_new_session() -> anyhow::Result<String> {
    let mut chat = app::Chat::connect(|_step| {})?;
    let before = chat.sessions.len();
    let id = chat.create_session(None)?;
    Ok(serde_json::to_string_pretty(&serde_json::json!({
        "created": id,
        "sessionsBefore": before,
        "sessionsAfter": chat.sessions.len(),
        "selected": chat.selected,
    }))?)
}

/// Verify both live sockets without a window: wait for the $events handshake and
/// count what the followed conversation reports.
fn dump_live(secs: u64) -> anyhow::Result<String> {
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    let chat = app::Chat::connect(|_step| {})?;
    let (cmd_tx, cmd_rx) = mpsc::channel();
    let (evt_tx, evt_rx) = mpsc::channel();
    live::spawn(chat.origin(), chat.cookie(), cmd_rx, evt_tx);
    let session = chat
        .selected_session()
        .map(|session| session.id.clone())
        .unwrap_or_default();
    let _ = cmd_tx.send(live::LiveCmd::Follow(session.clone()));

    let deadline = Instant::now() + Duration::from_secs(secs);
    let (mut ready, mut activity, mut deltas, mut pending) = (false, 0u32, 0u32, 0u32);
    let mut notes: Vec<String> = Vec::new();
    while Instant::now() < deadline {
        match evt_rx.recv_timeout(Duration::from_millis(200)) {
            Ok(live::LiveEvent::Ready(_)) => ready = true,
            Ok(live::LiveEvent::Activity) => activity += 1,
            Ok(live::LiveEvent::Delta(_)) => deltas += 1,
            Ok(live::LiveEvent::Pending(_)) => pending += 1,
            Ok(live::LiveEvent::Note(note)) => notes.push(note),
            Ok(live::LiveEvent::Closed(error)) => notes.push(format!("closed: {error}")),
            Ok(_) => {}
            Err(_) => {}
        }
    }
    Ok(serde_json::to_string_pretty(&serde_json::json!({
        "session": session,
        "eventsReady": ready,
        "activity": activity,
        "deltas": deltas,
        "pending": pending,
        "notes": notes,
    }))?)
}

/// Dump the raw opening snapshot of one conversation: header, projections and
/// the event kinds, so the window can be built against real shapes.
fn dump_session(session: Option<&str>) -> anyhow::Result<String> {
    let host = host::Host::start()?;
    let api = api::Api::connect(&host)?;
    let items = api
        .session_list()?
        .get("items")
        .and_then(serde_json::Value::as_array)
        .cloned()
        .unwrap_or_default();
    let target = match session {
        Some(id) => id.to_string(),
        None => items
            .iter()
            .filter(|item| {
                item.get("origin").is_none()
                    && item
                        .get("parentSessionId")
                        .is_none_or(|value| value.is_null())
            })
            .max_by_key(|item| item.get("updatedAt").and_then(serde_json::Value::as_i64).unwrap_or(0))
            .and_then(|item| item.get("sessionId").and_then(serde_json::Value::as_str))
            .unwrap_or_default()
            .to_string(),
    };
    let mut mux = mux::Mux::connect(&host.origin, api.cookie())?;
    let address = serde_json::json!({ "kind": "session", "sessionId": target });
    let stream = mux.open(
        "session/follow",
        serde_json::json!({
            "request": { "address": address, "maxMessages": 6, "assistantStream": true }
        }),
    )?;
    let opening = mux.read()?;
    let _ = mux.cancel(&stream);
    let snapshot = opening.get("value").cloned().unwrap_or(serde_json::Value::Null);
    let records = snapshot
        .get("records")
        .and_then(serde_json::Value::as_array)
        .cloned()
        .unwrap_or_default();
    let kinds: Vec<String> = records
        .iter()
        .filter_map(|record| {
            record
                .get("event")
                .and_then(|event| event.get("type"))
                .and_then(serde_json::Value::as_str)
                .map(str::to_string)
        })
        .collect();
    let sample = records
        .iter()
        .take(2)
        .map(|record| record.to_string().chars().take(400).collect::<String>())
        .collect::<Vec<_>>();
    let report = serde_json::json!({
        "sessionId": target,
        "header": snapshot.get("header").cloned().unwrap_or(serde_json::Value::Null),
        "projections": snapshot.get("projections").cloned().unwrap_or(serde_json::Value::Null),
        "cursor": snapshot.get("cursor").cloned().unwrap_or(serde_json::Value::Null),
        "kinds": kinds,
        "samples": sample,
    });
    Ok(serde_json::to_string_pretty(&report)?)
}

/// The exact sidebar/header state the window renders, without a display. This is
/// how the layout and label rules are verified in CI.
fn dump_ui() -> anyhow::Result<String> {
    let chat = app::Chat::connect(|_step| {})?;
    let groups = chat.groups();
    let current = chat.selected_session().cloned();
    let report = serde_json::json!({
        "sessions": chat.sessions.len(),
        "startupMs": chat.startup_ms,
        "hostReused": chat.reused,
        "titlesLoaded": chat.sessions.iter().filter(|session| !session.title.is_empty()).count(),
        "status": chat.status,
        "groups": groups
            .iter()
            .map(|group| serde_json::json!({
                "path": group.path,
                "label": group.label,
                "sessions": group.sessions.len(),
                "titles": group
                    .sessions
                    .iter()
                    .take(3)
                    .map(|(_, session)| session.title.clone())
                    .collect::<Vec<_>>(),
            }))
            .collect::<Vec<_>>(),
        "selected": current.as_ref().map(|session| serde_json::json!({
            "title": session.title,
            "project": app::project_path(&session.cwd),
            "model": session.model.label(),
            "context": session.context,
            "tokens": session.tokens,
            "questions": session.questions,
        })),
        "messages": chat.messages.len(),
        // Model picker data: one entry per provider with every model id, plus
        // the order the picker renders (current provider first).
        "modelGroups": chat
            .catalog
            .iter()
            .map(|provider| serde_json::json!({
                "id": provider.id,
                "name": provider.name,
                "models": provider
                    .models
                    .iter()
                    .map(|model| model.id.clone())
                    .collect::<Vec<_>>(),
            }))
            .collect::<Vec<_>>(),
        "modelOrder": app::order_providers(
            &chat.catalog,
            current
                .as_ref()
                .map(|session| session.model.provider.as_str())
                .unwrap_or_default(),
        )
        .iter()
        .map(|provider| provider.id.clone())
        .collect::<Vec<_>>(),
        "currentModel": current.as_ref().map(|session| app::composer_model_label(&session.model, &chat.catalog)),
    });
    Ok(serde_json::to_string_pretty(&report)?)
}

/// Start the harness host, exchange the process token, and read the conversation
/// list and model catalog. This exercises the whole client chain with no window,
/// so it runs on a headless machine and in CI.
fn probe() -> anyhow::Result<String> {
    let host = host::Host::start()?;
    let api = api::Api::connect(&host)?;
    let sessions = api.session_list()?;
    let items = sessions
        .get("items")
        .and_then(serde_json::Value::as_array)
        .cloned()
        .unwrap_or_default();
    let catalog = match api.model_catalog() {
        Ok(value) => serde_json::json!({
            "default": value.get("default").cloned().unwrap_or(serde_json::Value::Null),
            "groups": value.get("groups").and_then(serde_json::Value::as_array).map(Vec::len).unwrap_or(0),
            "routable": value.get("routableProviders").cloned().unwrap_or(serde_json::Value::Null),
            "failures": value.get("failures").cloned().unwrap_or(serde_json::Value::Null),
            "groupModels": value
                .get("groups")
                .and_then(serde_json::Value::as_array)
                .map(|groups| {
                    groups
                        .iter()
                        .map(|group| {
                            let models: Vec<serde_json::Value> = group
                                .get("models")
                                .and_then(serde_json::Value::as_array)
                                .map(|models| {
                                    models
                                        .iter()
                                        .take(3)
                                        .map(|model| {
                                            model.get("id").cloned().unwrap_or(serde_json::Value::Null)
                                        })
                                        .collect()
                                })
                                .unwrap_or_default();
                            serde_json::json!({
                                "id": group.get("id").cloned().unwrap_or(serde_json::Value::Null),
                                "models": models,
                            })
                        })
                        .collect::<Vec<_>>()
                }),
            "groupKeys": value
                .get("groups")
                .and_then(serde_json::Value::as_array)
                .and_then(|groups| groups.first())
                .and_then(serde_json::Value::as_object)
                .map(|map| map.keys().cloned().collect::<Vec<_>>()),
            "firstGroup": value
                .get("groups")
                .and_then(serde_json::Value::as_array)
                .and_then(|groups| groups.first())
                .map(|group| group.to_string().chars().take(400).collect::<String>()),
        }),
        Err(error) => serde_json::json!({ "error": format!("{error:#}") }),
    };
    // Newest top-level conversation: subagent sessions need their parent address.
    let newest = items
        .iter()
        .filter(|item| {
            item.get("origin").is_none() && item.get("parentSessionId").is_none_or(|value| value.is_null())
        })
        .max_by_key(|item| item.get("updatedAt").and_then(serde_json::Value::as_i64).unwrap_or(0))
        .cloned();
    let mut conversation = serde_json::json!({ "session": newest.is_none() });
    if let Some(session) = newest.clone() {
        let session_id = session
            .get("sessionId")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .to_string();
        let mut mux = mux::Mux::connect(&host.origin, api.cookie())?;
        let address = serde_json::json!({ "kind": "session", "sessionId": session_id });
        let stream = mux.open(
            "session/follow",
            serde_json::json!({
                "request": { "address": address, "maxMessages": 12, "assistantStream": true }
            }),
        )?;
        let opening = mux.read()?;
        if opening.get("type").and_then(serde_json::Value::as_str) == Some("error") {
            return Err(anyhow::anyhow!(
                "session/follow failed: {}",
                opening
                    .get("error")
                    .map(|error| error.to_string())
                    .unwrap_or_else(|| opening.to_string())
            ));
        }
        let snapshot = opening
            .get("value")
            .cloned()
            .unwrap_or(serde_json::Value::Null);
        let records = snapshot
            .get("records")
            .and_then(serde_json::Value::as_array)
            .map(Vec::len)
            .unwrap_or(0);
        let cursor = snapshot.get("cursor").cloned().unwrap_or(serde_json::Value::Null);
        // The opening cursor is the log cut for session/page.
        let through = cursor
            .as_i64()
            .or_else(|| cursor.get("throughSeq").and_then(serde_json::Value::as_i64))
            .or_else(|| cursor.get("seq").and_then(serde_json::Value::as_i64))
            .unwrap_or(0);
        let history = api
            .unary(
                "session/page",
                serde_json::json!({
                    "request": { "address": address, "throughSeq": through, "maxMessages": 8 }
                }),
            )
            .map(|value| {
                serde_json::json!({
                    "records": value.get("records").and_then(serde_json::Value::as_array).map(Vec::len).unwrap_or(0),
                    "hasMore": value.get("hasMore").cloned().unwrap_or(serde_json::Value::Null),
                })
            })
            .unwrap_or_else(|error| serde_json::json!({ "error": format!("{error:#}") }));
        let _ = mux.cancel(&stream);
        conversation = serde_json::json!({
            "sessionId": session_id,
            "snapshotKeys": snapshot.as_object().map(|map| map.keys().cloned().collect::<Vec<_>>()),
            "openingType": opening.get("type").cloned().unwrap_or(serde_json::Value::Null),
            "records": records,
            "cursor": cursor,
            "firstRecordType": snapshot.get("records").and_then(serde_json::Value::as_array).and_then(|rows| rows.first()).and_then(|row| row.get("type")).cloned().unwrap_or(serde_json::Value::Null),
            "page": history,
        });
    }

    let report = serde_json::json!({
        // Never print the process token.
        "origin": host.origin,
        "sessions": items.len(),
        "first": items
            .iter()
            .take(3)
            .map(|item| serde_json::json!({
                "sessionId": item.get("sessionId").and_then(serde_json::Value::as_str).unwrap_or_default(),
                "updatedAt": item.get("updatedAt").cloned().unwrap_or(serde_json::Value::Null),
                "running": item.get("running").cloned().unwrap_or(serde_json::Value::Null),
                "blank": item.get("blank").cloned().unwrap_or(serde_json::Value::Null),
                "cwd": item.get("cwd").and_then(serde_json::Value::as_str).unwrap_or_default(),
            }))
            .collect::<Vec<_>>(),
        "modelCatalog": catalog,
        "blankTopLevel": items
            .iter()
            .filter(|item| {
                item.get("origin").is_none()
                    && item.get("parentSessionId").is_none_or(|value| value.is_null())
                    && item.get("blank").and_then(serde_json::Value::as_bool) == Some(true)
            })
            .count(),
        "conversation": conversation,
    });
    Ok(serde_json::to_string_pretty(&report)?)
}

/// Send one prompt and watch the live assistant stream. This is the write path:
/// it starts a real agent turn in the target session.
fn send_probe(
    text: &str,
    session: Option<&str>,
    listen_secs: u64,
    model: Option<(&str, &str)>,
) -> anyhow::Result<String> {
    use std::time::{Duration, Instant};

    let host = host::Host::start()?;
    let api = api::Api::connect(&host)?;
    let items = api
        .session_list()?
        .get("items")
        .and_then(serde_json::Value::as_array)
        .cloned()
        .unwrap_or_default();
    let top_level = |item: &serde_json::Value| {
        item.get("origin").is_none()
            && item
                .get("parentSessionId")
                .is_none_or(|value| value.is_null())
    };
    let newest = |candidates: Vec<&serde_json::Value>| {
        candidates
            .into_iter()
            .max_by_key(|item| item.get("updatedAt").and_then(serde_json::Value::as_i64).unwrap_or(0))
            .cloned()
    };
    let target = match session {
        // An unknown id is still sent: the host may create the session.
        Some(id) => items
            .iter()
            .find(|item| item.get("sessionId").and_then(serde_json::Value::as_str) == Some(id))
            .cloned()
            .unwrap_or_else(|| serde_json::json!({ "sessionId": id, "blank": true, "new": true })),
        None => {
            let blanks: Vec<&serde_json::Value> = items
                .iter()
                .filter(|item| {
                    top_level(item)
                        && item.get("blank").and_then(serde_json::Value::as_bool) == Some(true)
                })
                .collect();
            let fallback: Vec<&serde_json::Value> =
                items.iter().filter(|item| top_level(item)).collect();
            newest(blanks)
                .or_else(|| newest(fallback))
                .ok_or_else(|| anyhow::anyhow!("no top-level session to prompt"))?
        }
    };
    let session_id = target
        .get("sessionId")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .to_string();
    let blank = target
        .get("blank")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);

    let mut mux = mux::Mux::connect(&host.origin, api.cookie())?;
    let address = serde_json::json!({ "kind": "session", "sessionId": session_id });

    // A session that does not exist yet is created by the prompt, so send first
    // and follow afterwards; existing sessions are followed before prompting so
    // the snapshot is the pre-prompt history.
    let is_new = target.get("new").and_then(serde_json::Value::as_bool).unwrap_or(false);
    let mut follow = |mux: &mut mux::Mux| -> anyhow::Result<String> {
        let stream = mux.open(
            "session/follow",
            serde_json::json!({
                "request": { "address": address, "maxMessages": 20, "assistantStream": true }
            }),
        )?;
        let opening = mux.read()?;
        if opening.get("type").and_then(serde_json::Value::as_str) == Some("error") {
            return Err(anyhow::anyhow!("session/follow failed: {opening}"));
        }
        Ok(stream)
    };
    let mut stream = if is_new { None } else { Some(follow(&mut mux)?) };

    // Selecting a model is optional; the session keeps its default otherwise.
    let selected = match model {
        Some((provider, model)) => api.unary(
            "session/selectModel",
            serde_json::json!({
                "request": { "sessionId": session_id, "provider": provider, "model": model }
            }),
        )?,
        None => serde_json::Value::Null,
    };

    let request_id = format!(
        "rdsh-desktop-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|value| value.as_millis())
            .unwrap_or(0)
    );
    let accepted = api.unary(
        "session/prompt",
        serde_json::json!({
            "request": {
                "requestId": request_id,
                "sessionId": session_id,
                "mode": "queue",
                "content": [ { "type": "text", "text": text } ]
            }
        }),
    )?;

    if stream.is_none() {
        stream = Some(follow(&mut mux)?);
    }
    let stream = stream.expect("follow stream");

    mux.set_read_timeout(Duration::from_millis(500))?;
    let deadline = Instant::now() + Duration::from_secs(listen_secs);
    let mut assistant = String::new();
    let mut events = 0u64;
    let mut frames = 0u64;
    let mut kinds: Vec<String> = Vec::new();
    let mut chunks: Vec<String> = Vec::new();
    let mut ended = false;
    while Instant::now() < deadline && !ended {
        let Ok(message) = mux.read() else {
            continue;
        };
        let kind = message
            .get("type")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default();
        match kind {
            "item" => {
                let value = message
                    .get("value")
                    .cloned()
                    .unwrap_or(serde_json::Value::Null);
                let value_type = value
                    .get("type")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                if kinds.len() < 12 && !kinds.contains(&value_type) {
                    kinds.push(value_type.clone());
                }
                if value_type == "assistant-stream" {
                    frames += 1;
                    let frame = value
                        .get("frame")
                        .cloned()
                        .unwrap_or(serde_json::Value::Null);
                    match frame.get("type").and_then(serde_json::Value::as_str) {
                        Some("chunk") => {
                            // The chunk carries a model stream delta; collect any
                            // textual leaf so the preview works across providers.
                            if chunks.len() < 6 {
                                let payload = frame
                                    .get("chunk")
                                    .cloned()
                                    .unwrap_or(serde_json::Value::Null);
                                let text = payload
                                    .to_string()
                                    .chars()
                                    .take(160)
                                    .collect::<String>();
                                if !chunks.contains(&text) {
                                    chunks.push(text);
                                }
                            }
                            if let Some(chunk) = frame.get("chunk") {
                                app::collect_text(chunk, &mut assistant);
                            }
                        }
                        Some("end") => ended = true,
                        _ => {}
                    }
                } else if value_type == "event" {
                    events += 1;
                }
            }
            "end" => ended = true,
            _ => {}
        }
    }
    let _ = mux.cancel(&stream);

    Ok(serde_json::to_string_pretty(&serde_json::json!({
        "sessionId": session_id,
        "blank": blank,
        "requestId": request_id,
        "selected": selected,
        "accepted": accepted,
        "events": events,
        "assistantFrames": frames,
        "recordKinds": kinds,
        "assistantChars": assistant.chars().count(),
        "assistantPreview": assistant.chars().take(400).collect::<String>(),
        "chunkPayloads": chunks,
        "ended": ended,
    }))?)
}



