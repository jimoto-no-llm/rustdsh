//! Local rustxng sidecar: base URL, health probe and on-demand lifecycle.
//!
//! License boundary (do not relax): rustdsh is MIT, rustxng is
//! AGPL-3.0-or-later. rustxng is therefore used strictly as a *separate
//! process* reached over HTTP on loopback. Its crate is never linked into this
//! binary and none of its source is copied here; the only coupling is the
//! CLI/env contract below and the SearXNG-compatible endpoints.
//!
//! Environment:
//!   RUSTXNG_BIN       explicit binary path (wins over the PATH lookup)
//!   RUSTXNG_URL       use the instance already running there (never spawns)
//!   RUSTXNG_PORT      port for the sidecar this module starts
//!   RUSTXNG_SETTINGS  settings file passed as --config when it is a real file
//!
//! State lives in $DSH_HOME (see [state_file](state_file)); nothing outside
//! $DSH_HOME, ~/.config or /tmp is written.

use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use anyhow::Result;

/// Loopback address the sidecar binds; never a public interface.
pub const BIND: &str = "127.0.0.1";
/// How long one /healthz probe may take. Short: it sits in a CLI's start path.
pub const HEALTH_TIMEOUT: Duration = Duration::from_secs(2);
/// How long ensure() waits for a freshly spawned process to answer.
pub const START_TIMEOUT: Duration = Duration::from_secs(20);
/// Delay between health probes while a started process boots.
pub const POLL_INTERVAL: Duration = Duration::from_millis(250);
/// The binary name used for the PATH lookup.
pub const BIN_NAME: &str = "rustxng";

/// Why the local engine could not be used. Every variant carries its own
/// locale-aware sentence, so callers can print it unchanged.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Error {
    /// RUSTXNG_BIN and the fallback locations all missed.
    BinNotFound,
    /// The process could not be spawned (permission, exec format, ...).
    Spawn(String),
    /// The process started but /healthz never answered within START_TIMEOUT.
    Unresponsive(String),
    /// The recorded-state file could not be written.
    State(String),
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::BinNotFound => write!(f, "{}", missing_binary_hint(crate::locale::Locale::English)),
            Self::Spawn(e) => write!(f, "could not start rustxng: {e}"),
            Self::Unresponsive(url) => write!(
                f,
                "rustxng did not answer /healthz at {url} within {}s",
                START_TIMEOUT.as_secs()
            ),
            Self::State(e) => write!(f, "cannot record the rustxng port: {e}"),
        }
    }
}

impl std::error::Error for Error {}

/// One sentence naming RUSTXNG_BIN when it is unset and no binary was found.
/// Used by the error above, by [status] and by the CLI output.
pub fn missing_binary_hint(locale: crate::locale::Locale) -> String {
    match locale {
        crate::locale::Locale::English => {
            "rustxng binary not found; set RUSTXNG_BIN=/path/to/rustxng, put rustxng on PATH, or install it to ~/.local/bin/rustxng (rustdsh stays MIT: the AGPL engine runs as a separate process)".to_string()
        }
        crate::locale::Locale::Chinese => {
            "未找到 rustxng 可执行文件；请设置 RUSTXNG_BIN=/path/to/rustxng，或将 rustxng 放入 PATH，或安装到 ~/.local/bin/rustxng（rustdsh 保持 MIT：AGPL 引擎作为独立进程运行）".to_string()
        }
        crate::locale::Locale::Japanese => {
            "rustxng の実行ファイルが見つかりません。RUSTXNG_BIN=/path/to/rustxng を設定するか、rustxng を PATH に置くか、~/.local/bin/rustxng へインストールしてください（rustdsh は MIT のまま: AGPL エンジンは別プロセスとして動きます）".to_string()
        }
    }
}

/// Test-only override of [binary]'s environment lookup. 0 = normal (the real
/// RUSTXNG_BIN/PATH/HOME), 1 = RUSTXNG_BIN wins, 2 = the lookup finds nothing.
/// Injected here so the unit tests never have to mutate PATH or HOME, which
/// are process-global and would break unrelated suites running in parallel.
#[cfg(test)]
static BIN_MODE: std::sync::atomic::AtomicU8 = std::sync::atomic::AtomicU8::new(0);

fn env(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

/// The executable name for this platform (Windows needs the extension).
fn exe_name(name: &str) -> String {
    if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    }
}

/// Resolve the rustxng binary: RUSTXNG_BIN, then rustxng on PATH, then
/// ~/.local/bin/rustxng and /usr/local/bin/rustxng. None means "not installed
/// here"; callers turn that into [missing_binary_hint].
pub fn binary() -> Option<PathBuf> {
    #[cfg(test)]
    {
        use std::sync::atomic::Ordering;
        match BIN_MODE.load(Ordering::Relaxed) {
            1 => return env("RUSTXNG_BIN").map(PathBuf::from).filter(|p| p.is_file()),
            2 => return None,
            _ => {}
        }
    }
    binary_with(
        &|name| env(name),
        &std::env::var_os("PATH"),
        home_dir().as_deref(),
    )
}

/// [binary] with its inputs injected, so the lookup order is testable without
/// touching the process environment.
fn binary_with(
    lookup: &dyn Fn(&str) -> Option<String>,
    path: &Option<std::ffi::OsString>,
    home: Option<&Path>,
) -> Option<PathBuf> {
    if let Some(explicit) = lookup("RUSTXNG_BIN") {
        let candidate = PathBuf::from(explicit);
        return candidate.is_file().then_some(candidate);
    }
    let name = exe_name(BIN_NAME);
    if let Some(path) = path {
        for dir in std::env::split_paths(path) {
            let candidate = dir.join(&name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    for dir in fallback_dirs(home) {
        let candidate = dir.join(&name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

/// Install locations tried after PATH: the per-user bin directory first (where
/// the rustxng installer puts it), then the system-wide one.
pub fn fallback_dirs(home: Option<&Path>) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(home) = home {
        dirs.push(home.join(".local").join("bin"));
    }
    dirs.push(PathBuf::from("/usr/local/bin"));
    dirs
}

fn home_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        if let (Ok(drive), Ok(path)) = (std::env::var("HOMEDRIVE"), std::env::var("HOMEPATH")) {
            if !drive.is_empty() && !path.is_empty() {
                return Some(PathBuf::from(format!("{drive}{path}")));
            }
        }
    }
    env("HOME").map(PathBuf::from)
}

/// The URL of a rustxng chosen by the environment, if any: RUSTXNG_URL, then
/// RUSTXNG_PORT as loopback. None means "nothing configured"; the caller then
/// falls back to a recorded or freshly chosen port.
pub fn base_url() -> Option<String> {
    if let Some(url) = env("RUSTXNG_URL") {
        return Some(url.trim_end_matches('/').to_string());
    }
    configured_port().map(url_for)
}

/// The state file that remembers the port of the instance rdsh started, so a
/// second call reuses it instead of spawning another process.
pub fn state_file() -> PathBuf {
    PathBuf::from(crate::inspect::dsh_home()).join("rustxng.port")
}

/// The log file the detached sidecar appends to.
pub fn log_file() -> PathBuf {
    PathBuf::from(crate::inspect::dsh_home())
        .join("logs")
        .join("rustxng.log")
}

/// Recorded (port, pid) of the instance rdsh started, when the file is there.
pub fn recorded_state() -> Option<(u16, Option<u32>)> {
    read_state(&state_file())
}

fn read_state(path: &Path) -> Option<(u16, Option<u32>)> {
    let text = std::fs::read_to_string(path).ok()?;
    parse_state(&text)
}

/// Parse "port" or "port<TAB>pid". A malformed file is treated as absent, so a
/// hand-edited file can never inject an argument into the spawn call.
fn parse_state(text: &str) -> Option<(u16, Option<u32>)> {
    let mut fields = text.split_whitespace();
    let port = fields.next()?.parse::<u16>().ok().filter(|port| *port != 0)?;
    let pid = fields.next().and_then(|pid| pid.parse::<u32>().ok());
    Some((port, pid))
}

fn write_state(path: &Path, port: u16, pid: Option<u32>) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let body = match pid {
        Some(pid) => format!("{port}\t{pid}\n"),
        None => format!("{port}\n"),
    };
    std::fs::write(path, body)
}

fn clear_state(path: &Path) {
    let _ = std::fs::remove_file(path);
}

/// A free loopback port: bind, read back the assignment, release immediately.
/// The window before rustxng binds it is small, and a collision only costs one
/// retry, which beats hard-coding a port a host may already use.
pub fn free_port() -> Result<u16> {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
    Ok(listener.local_addr()?.port())
}

/// Whether something already listens on the loopback port. Used to avoid
/// spawning a second engine onto a port that is taken.
pub fn port_in_use(port: u16) -> bool {
    probe_port(port, Duration::from_millis(300))
}

fn probe_port(port: u16, timeout: Duration) -> bool {
    let address = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    TcpStream::connect_timeout(&address, timeout).is_ok()
}

/// The port from RUSTXNG_PORT, when it is a usable nonzero u16.
fn configured_port() -> Option<u16> {
    env("RUSTXNG_PORT")
        .and_then(|port| port.parse::<u16>().ok())
        .filter(|port| *port != 0)
}

fn url_for(port: u16) -> String {
    format!("http://{BIND}:{port}")
}

/// One /healthz probe against <base>: an HTTP status in 200..300 counts as
/// healthy, and when the body parses as JSON a `status` field of
/// "ok" is accepted as well. rustxng answers both; a 204 from a front proxy
/// still passes on the status alone. Every failure (no listener, timeout,
/// non-2xx) is just false.
pub fn health(base: &str) -> bool {
    let Ok(response) = http_get(base, "/healthz", HEALTH_TIMEOUT) else {
        return false;
    };
    if !response.healthy() {
        return false;
    }
    match response.json() {
        Some(value) => match value.get("status").and_then(|status| status.as_str()) {
            Some(status) => status.eq_ignore_ascii_case("ok") || status.eq_ignore_ascii_case("healthy"),
            None => true,
        },
        None => true,
    }
}

/// Run a rustxng instance and wait until it answers.
///
/// Order: an instance already listening and healthy is reused; a configured
/// RUSTXNG_URL is returned untouched (never spawn a second engine for a URL
/// the user owns); otherwise spawn detached with --bind 127.0.0.1 --port PORT
/// (plus --config when RUSTXNG_SETTINGS is a file), append stdout and stderr
/// to $DSH_HOME/logs/rustxng.log, then poll /healthz for up to START_TIMEOUT.
pub fn ensure() -> Result<String, Error> {
    // Every environment read in this function must see one consistent picture,
    // so the test harness guards it as a whole (a no-op in production).
    #[cfg(test)]
    let _lock = tests::env_lock();
    let state_path = state_file();
    if let Some(url) = env("RUSTXNG_URL") {
        if health(&url) {
            return Ok(url);
        }
        return Err(Error::Unresponsive(url));
    }

    // An instance already running on the configured or recorded port is reused
    // instead of starting a second one.
    let known = configured_port().or_else(|| recorded_state().map(|(port, _)| port));
    if let Some(port) = known {
        let url = url_for(port);
        if port_in_use(port) && health(&url) {
            return Ok(url);
        }
    }

    let binary = binary().ok_or(Error::BinNotFound)?;
    // Reuse the recorded port while it is still free; otherwise try once per
    // fresh port. A collision between free_port() and the engine's bind is a
    // normal race on a busy host, not a reason to give up.
    let mut ports = Vec::new();
    match configured_port() {
        Some(port) => ports.push(port),
        None => {
            if let Some((recorded, _)) = recorded_state() {
                if !port_in_use(recorded) {
                    ports.push(recorded);
                }
            }
            ports.push(free_port().map_err(|e| Error::Spawn(e.to_string()))?);
        }
    }
    let mut last = Error::BinNotFound;
    for port in ports {
        // Something else already owns the port and is not rustxng; another
        // attempt would collide, so report the engine's own failure instead.
        if port_in_use(port) {
            return Err(Error::Spawn(format!(
                "{BIND}:{port} is already in use by another process"
            )));
        }
        match start_engine(&binary, port, &state_path) {
            Ok(url) => return Ok(url),
            // A process that never answered is retried on another port, but
            // the failure is still reported when every attempt missed.
            Err(e) => last = e,
        }
    }
    Err(last)
}

/// Spawn one detached instance on `port`, record it, and wait for /healthz.
/// A failed write or a silent process is undone: the child is killed and the
/// recorded state is cleared, so the next attempt starts clean.
fn start_engine(binary: &Path, port: u16, path: &Path) -> Result<String, Error> {
    let log = log_file();
    if let Some(parent) = log.parent() {
        std::fs::create_dir_all(parent).map_err(|e| Error::Spawn(e.to_string()))?;
    }
    let handle = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log)
        .map_err(|e| Error::Spawn(e.to_string()))?;
    let mut child =
        spawn_detached(binary, port, handle).map_err(|e| Error::Spawn(e.to_string()))?;
    if let Err(e) = write_state(path, port, Some(child.id())) {
        kill_and_reap(&mut child);
        clear_state(path);
        return Err(Error::State(e.to_string()));
    }
    let url = url_for(port);
    let deadline = Instant::now() + START_TIMEOUT;
    while Instant::now() < deadline {
        if health(&url) {
            return Ok(url);
        }
        std::thread::sleep(POLL_INTERVAL);
    }
    kill_and_reap(&mut child);
    clear_state(path);
    Err(Error::Unresponsive(url))
}

/// Stop a child this process started and collect it, so a failed start leaves
/// neither a listener nor a zombie behind.
fn kill_and_reap(child: &mut std::process::Child) {
    let _ = child.kill();
    let _ = child.wait();
}

/// Spawn the sidecar detached so it outlives this CLI invocation.
#[cfg(unix)]
fn spawn_detached(
    binary: &Path,
    port: u16,
    log: std::fs::File,
) -> std::io::Result<std::process::Child> {
    use std::os::unix::process::CommandExt;
    let mut command = std::process::Command::new(binary);
    build_command(&mut command, port);
    command
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::from(log.try_clone()?))
        .stderr(std::process::Stdio::from(log));
    // Own process group plus SIGHUP ignored: closing the terminal that ran
    // rdsh must not take the search engine down with it.
    unsafe {
        command.pre_exec(|| {
            libc::setsid();
            libc::signal(libc::SIGHUP, libc::SIG_IGN);
            Ok(())
        });
    }
    command.spawn()
}

#[cfg(not(unix))]
fn spawn_detached(
    binary: &Path,
    port: u16,
    log: std::fs::File,
) -> std::io::Result<std::process::Child> {
    let mut command = std::process::Command::new(binary);
    build_command(&mut command, port);
    command
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::from(log.try_clone()?))
        .stderr(std::process::Stdio::from(log));
    command.spawn()
}

/// The documented rustxng CLI contract: --config (only a real file),
/// --bind 127.0.0.1, --port PORT.
fn build_command(command: &mut std::process::Command, port: u16) {
    if let Some(settings) = env("RUSTXNG_SETTINGS") {
        let path = PathBuf::from(settings);
        if path.is_file() {
            command.arg("--config").arg(path);
        }
    }
    command
        .arg("--bind")
        .arg(BIND)
        .arg("--port")
        .arg(port.to_string());
}

/// Terminate the instance this module recorded: SIGTERM, a short grace period,
/// then SIGKILL. A stale or foreign pid is left alone and only the state file
/// is removed.
pub fn stop() -> Result<bool> {
    let Some((_port, pid)) = recorded_state() else {
        clear_state(&state_file());
        return Ok(false);
    };
    let mut killed = false;
    if let Some(pid) = pid {
        if process_is_rustxng(pid) {
            killed = terminate(pid);
            reap_if_ours(pid);
        }
    }
    clear_state(&state_file());
    Ok(killed)
}

/// Collect the process when it is a direct child of this process. The OS
/// reports no child for an instance started by another run, which is fine.
#[cfg(unix)]
fn reap_if_ours(pid: u32) {
    let mut status = 0;
    unsafe {
        libc::waitpid(pid as libc::pid_t, &mut status, libc::WNOHANG);
    }
}

#[cfg(not(unix))]
fn reap_if_ours(_pid: u32) {}

/// Whether pid is a rustxng process. PID reuse must not turn <stop> into a
/// signal sent to an unrelated program, so the name is checked first.
pub fn process_is_rustxng(pid: u32) -> bool {
    #[cfg(target_os = "linux")]
    {
        std::fs::read_to_string(format!("/proc/{pid}/comm"))
            .map(|name| name.trim().contains(BIN_NAME))
            .unwrap_or(false)
    }
    #[cfg(all(unix, not(target_os = "linux")))]
    {
        std::process::Command::new("ps")
            .args(["-p", &pid.to_string(), "-o", "comm="])
            .output()
            .map(|out| String::from_utf8_lossy(&out.stdout).trim().contains(BIN_NAME))
            .unwrap_or(false)
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
        false
    }
}

#[cfg(unix)]
fn terminate(pid: u32) -> bool {
    let target = pid as libc::pid_t;
    if unsafe { libc::kill(target, libc::SIGTERM) } != 0 {
        return false;
    }
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        if !process_running(pid) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    unsafe { libc::kill(target, libc::SIGKILL) };
    true
}

/// Whether pid is alive and not a zombie. A stopped child stays in /proc as a
/// zombie until its parent reaps it, and `kill(pid, 0)` succeeds for one, so
/// the state check is what makes `stop` return promptly.
#[cfg(unix)]
fn process_running(pid: u32) -> bool {
    #[cfg(target_os = "linux")]
    {
        return std::fs::read_to_string(format!("/proc/{pid}/stat"))
            .map(|stat| {
                let state = stat.rsplit(')').next().unwrap_or_default();
                !state.trim_start().starts_with('Z')
            })
            .unwrap_or(false);
    }
    #[cfg(not(target_os = "linux"))]
    {
        unsafe { libc::kill(pid as libc::pid_t, 0) == 0 }
    }
}

#[cfg(not(unix))]
fn terminate(_pid: u32) -> bool {
    false
}

/// JSON-able snapshot for the status subcommand: what was found, which URL
/// applies, whether it answers, and a hint when no binary exists.
pub fn status() -> serde_json::Value {
    let binary = binary();
    let recorded = recorded_state();
    let url = env("RUSTXNG_URL")
        .map(|url| url.trim_end_matches('/').to_string())
        .or_else(|| configured_port().map(url_for))
        .or_else(|| recorded.map(|(port, _)| url_for(port)));
    let running = url.as_deref().is_some_and(health);
    serde_json::json!({
        "binary": binary.as_ref().map(|path| path.display().to_string()),
        "url": url,
        "running": running,
        "port": recorded.map(|(port, _)| port),
        "pid": recorded.and_then(|(_, pid)| pid),
        "state_file": state_file().display().to_string(),
        "log_file": log_file().display().to_string(),
        "hint": if binary.is_none() {
            Some(missing_binary_hint(crate::locale::Locale::English))
        } else {
            None
        },
    })
}

/// `rdsh rustxng status`: the same snapshot as [status], either as JSON or as
/// one localized sentence per fact.
pub fn cmd_status(json_out: bool, locale: crate::locale::Locale) -> Result<()> {
    let value = status();
    if json_out {
        println!("{}", serde_json::to_string_pretty(&value)?);
        return Ok(());
    }
    let binary = value
        .get("binary")
        .and_then(|v| v.as_str())
        .map(str::to_string);
    let running = value
        .get("running")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let url = value
        .get("url")
        .and_then(|v| v.as_str())
        .map(str::to_string);
    match &binary {
        Some(path) => println!(
            "{}",
            match locale {
                crate::locale::Locale::English => format!("rustxng binary: {path}"),
                crate::locale::Locale::Chinese => format!("rustxng 可执行文件：{path}"),
                crate::locale::Locale::Japanese => format!("rustxng 実行ファイル: {path}"),
            }
        ),
        None => println!("{}", missing_binary_hint(locale)),
    }
    if let Some(url) = url {
        let state = if running {
            match locale {
                crate::locale::Locale::English => "running",
                crate::locale::Locale::Chinese => "运行中",
                crate::locale::Locale::Japanese => "稼働中",
            }
        } else {
            match locale {
                crate::locale::Locale::English => "not answering",
                crate::locale::Locale::Chinese => "无响应",
                crate::locale::Locale::Japanese => "応答なし",
            }
        };
        println!(
            "{}",
            match locale {
                crate::locale::Locale::English => format!("url: {url} ({state})"),
                crate::locale::Locale::Chinese => format!("地址：{url}（{state}）"),
                crate::locale::Locale::Japanese => format!("URL: {url}（{state}）"),
            }
        );
    } else {
        println!(
            "{}",
            match locale {
                crate::locale::Locale::English => "no recorded instance in $DSH_HOME",
                crate::locale::Locale::Chinese => "$DSH_HOME 中没有已记录的实例",
                crate::locale::Locale::Japanese => "$DSH_HOME に記録されたインスタンスはありません",
            }
        );
    }
    Ok(())
}

/// `rdsh rustxng start`: ensure a healthy instance and print its base URL.
pub fn cmd_start(locale: crate::locale::Locale) -> Result<()> {
    let url = ensure().map_err(anyhow::Error::new)?;
    println!(
        "{}",
        match locale {
            crate::locale::Locale::English => format!("rustxng ready at {url}"),
            crate::locale::Locale::Chinese => format!("rustxng 已就绪：{url}"),
            crate::locale::Locale::Japanese => format!("rustxng は {url} で利用できます"),
        }
    );
    Ok(())
}

/// `rdsh rustxng stop`: terminate the recorded instance.
pub fn cmd_stop(locale: crate::locale::Locale) -> Result<()> {
    let terminated = stop()?;
    println!(
        "{}",
        match (locale, terminated) {
            (crate::locale::Locale::English, true) => "stopped the recorded rustxng instance",
            (crate::locale::Locale::English, false) => "no rustxng instance was running",
            (crate::locale::Locale::Chinese, true) => "已停止记录的 rustxng 实例",
            (crate::locale::Locale::Chinese, false) => "没有正在运行的 rustxng 实例",
            (crate::locale::Locale::Japanese, true) => "記録された rustxng インスタンスを停止しました",
            (crate::locale::Locale::Japanese, false) => {
                "稼働中の rustxng インスタンスはありませんでした"
            }
        }
    );
    Ok(())
}

/// One minimal HTTP/1.0 GET; returns the status and the body. Kept small on
/// purpose: the sidecar needs a health probe and a JSON /search, while the
/// HTML search client stays in crate::websearch.
fn http_get(base: &str, target: &str, timeout: Duration) -> Result<HttpResponse> {
    let (host, port, prefix) = split_base(base)?;
    let deadline = Instant::now() + timeout;
    let mut stream = connect(&host, port, deadline)?;
    let request = format!(
        "GET {prefix}{target} HTTP/1.0\r\nHost: {host}:{port}\r\nUser-Agent: rdsh/{}\r\nAccept: application/json, text/html\r\nConnection: close\r\n\r\n",
        env!("CARGO_PKG_VERSION")
    );
    let remaining = deadline.saturating_duration_since(Instant::now());
    stream.set_write_timeout(Some(remaining.max(Duration::from_millis(1))))?;
    stream.write_all(request.as_bytes())?;
    let mut raw = Vec::new();
    stream.set_read_timeout(Some(remaining.max(Duration::from_millis(1))))?;
    let mut chunk = [0u8; 4096];
    loop {
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                if raw.len().saturating_add(n) > 1024 * 1024 {
                    break;
                }
                raw.extend_from_slice(&chunk[..n]);
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => break,
            Err(e) => return Err(e.into()),
        }
    }
    parse_response(&String::from_utf8_lossy(&raw))
}

fn connect(host: &str, port: u16, deadline: Instant) -> Result<TcpStream> {
    let bare = host
        .strip_prefix('[')
        .and_then(|host| host.strip_suffix(']'))
        .unwrap_or(host);
    let mut last = None;
    for address in (bare, port).to_socket_addrs()? {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }
        match TcpStream::connect_timeout(&address, remaining) {
            Ok(stream) => return Ok(stream),
            Err(e) => last = Some(e),
        }
    }
    Err(match last {
        Some(e) => e.into(),
        None => anyhow::anyhow!("no address for {host}:{port}"),
    })
}

/// Split "http://host[:port][/prefix]" for the loopback sidecar: only http, a
/// real port, and no userinfo, query or fragment.
fn split_base(base: &str) -> Result<(String, u16, String)> {
    anyhow::ensure!(
        !base.chars().any(|c| c.is_control() || c.is_whitespace())
            && !base.contains(['@', '?', '#']),
        "invalid rustxng URL: {base}"
    );
    let rest = base
        .strip_prefix("http://")
        .ok_or_else(|| anyhow::anyhow!("only http:// rustxng URLs are supported: {base}"))?;
    let (hostport, prefix) = match rest.find('/') {
        Some(i) => (&rest[..i], rest[i..].to_string()),
        None => (rest, String::new()),
    };
    let (host, port) = match hostport.rsplit_once(':') {
        Some((host, port)) => (
            host.to_string(),
            port.parse::<u16>()
                .ok()
                .filter(|port| *port != 0)
                .ok_or_else(|| anyhow::anyhow!("invalid rustxng port in {base}"))?,
        ),
        None => (hostport.to_string(), 80),
    };
    anyhow::ensure!(!host.is_empty(), "invalid rustxng host in {base}");
    Ok((host, port, prefix))
}

/// Status line plus body of one HTTP response. Chunked bodies are decoded, so
/// both a small test stub and rustxng's own server are accepted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpResponse {
    pub status: u16,
    pub body: String,
}

impl HttpResponse {
    pub fn healthy(&self) -> bool {
        (200..300).contains(&self.status)
    }

    pub fn json(&self) -> Option<serde_json::Value> {
        serde_json::from_str(&self.body).ok()
    }
}

fn parse_response(text: &str) -> Result<HttpResponse> {
    let (head, body) = text
        .split_once("\r\n\r\n")
        .or_else(|| text.split_once("\n\n"))
        .ok_or_else(|| anyhow::anyhow!("malformed HTTP response"))?;
    let status = head
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|code| code.parse::<u16>().ok())
        .ok_or_else(|| anyhow::anyhow!("malformed HTTP status line"))?;
    let chunked = head.lines().skip(1).any(|line| {
        let lower = line.to_ascii_lowercase();
        lower.starts_with("transfer-encoding:") && lower.contains("chunked")
    });
    let body = if chunked {
        decode_chunked(body)
    } else {
        body.to_string()
    };
    Ok(HttpResponse { status, body })
}

/// Decode a chunked body; a truncated stream yields what was decoded so far,
/// which is enough for a health check.
fn decode_chunked(body: &str) -> String {
    let mut out = String::new();
    let mut rest = body;
    loop {
        let Some(eol) = rest.find("\r\n") else {
            break;
        };
        let size = usize::from_str_radix(rest[..eol].trim(), 16).unwrap_or(0);
        if size == 0 {
            break;
        }
        let start = eol + 2;
        if start + size > rest.len() {
            out.push_str(&rest[start..]);
            break;
        }
        out.push_str(&rest[start..start + size]);
        rest = &rest[(start + size).min(rest.len())..];
        rest = rest.strip_prefix("\r\n").unwrap_or(rest);
    }
    out
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::{Mutex, MutexGuard, OnceLock};

    // Reentrancy depth of env_lock on this thread, plus the parked guard.
    std::thread_local! {
        static DEPTH: std::cell::Cell<u32> = const { std::cell::Cell::new(0) };
        /// The Mutex guard, parked while this thread holds the lock.
        static HELD: std::cell::RefCell<Option<MutexGuard<'static, ()>>> =
            const { std::cell::RefCell::new(None) };
    }

    /// Serialises the tests that touch the process environment. Cargo runs test
    /// functions on parallel threads, so an unguarded set_var could redirect a
    /// binary lookup in another test.
    ///
    /// Reentrant on purpose: some tests hold it and then call code ([ensure])
    /// that takes it again, and a plain Mutex would deadlock there.
    pub(crate) fn env_lock() -> EnvLock {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        let depth = DEPTH.with(|d| {
            let depth = d.get() + 1;
            d.set(depth);
            depth
        });
        if depth == 1 {
            let guard = LOCK
                .get_or_init(|| Mutex::new(()))
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            HELD.with(|held| *held.borrow_mut() = Some(guard));
        }
        EnvLock
    }

    /// Pins the binary lookup for one test: None means "not found anywhere",
    /// Some(path) means "this file is RUSTXNG_BIN". Restores the previous mode
    /// and the previous RUSTXNG_BIN value on drop.
    pub(crate) struct BinGuard {
        previous_mode: u8,
        previous: Option<String>,
    }

    impl BinGuard {
        pub(crate) fn install(path: Option<&Path>) -> Self {
            use std::sync::atomic::Ordering;
            let previous_mode = BIN_MODE.swap(if path.is_some() { 1 } else { 2 }, Ordering::Relaxed);
            let previous = std::env::var("RUSTXNG_BIN").ok();
            match path {
                Some(path) => std::env::set_var("RUSTXNG_BIN", path),
                None => std::env::remove_var("RUSTXNG_BIN"),
            }
            Self {
                previous_mode,
                previous,
            }
        }
    }

    impl Drop for BinGuard {
        fn drop(&mut self) {
            use std::sync::atomic::Ordering;
            match &self.previous {
                Some(value) => std::env::set_var("RUSTXNG_BIN", value),
                None => std::env::remove_var("RUSTXNG_BIN"),
            }
            BIN_MODE.store(self.previous_mode, Ordering::Relaxed);
        }
    }

    /// Releases one [env_lock] level; the outermost level drops the guard, so
    /// the Mutex is only ever held by the thread that last acquired it.
    pub(crate) struct EnvLock;

    impl Drop for EnvLock {
        fn drop(&mut self) {
            let depth = DEPTH.with(|d| {
                let depth = d.get().saturating_sub(1);
                d.set(depth);
                depth
            });
            if depth == 0 {
                let _guard = HELD.with(|held| held.borrow_mut().take());
            }
        }
    }

    /// Set or clear environment variables for one test, restoring every value
    /// afterwards even when an assertion unwinds the stack.
    struct EnvGuard {
        saved: Vec<(String, Option<String>)>,
    }

    impl EnvGuard {
        fn apply(pairs: &[(&str, Option<&str>)]) -> Self {
            let mut saved = Vec::new();
            for (name, value) in pairs {
                saved.push(((*name).to_string(), std::env::var(name).ok()));
                match value {
                    Some(value) => std::env::set_var(name, value),
                    None => std::env::remove_var(name),
                }
            }
            Self { saved }
        }
    }

    impl Drop for EnvGuard {
        fn drop(&mut self) {
            for (name, value) in &self.saved {
                match value {
                    Some(value) => std::env::set_var(name, value),
                    None => std::env::remove_var(name),
                }
            }
        }
    }

    struct KillOnDrop(std::process::Child);

    impl Drop for KillOnDrop {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    fn next_nonce() -> u64 {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        NEXT.fetch_add(1, Ordering::Relaxed)
    }

    fn test_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "rdsh-rustxng-test-{}-{}-{tag}",
            std::process::id(),
            next_nonce()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_executable(path: &Path, body: &str) {
        std::fs::write(path, body).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
    }

    fn dirs(path: &Path) -> Option<std::ffi::OsString> {
        Some(std::ffi::OsString::from(path.display().to_string()))
    }

    // RUSTXNG_BIN wins even when a PATH candidate exists.
    #[test]
    fn explicit_binary_environment_variable_wins_over_path() {
        let dir = test_dir("bin-env");
        let explicit = dir.join("explicit-rustxng");
        write_executable(&explicit, "#!/bin/sh\nexit 0\n");
        let path_dir = dir.join("path");
        std::fs::create_dir_all(&path_dir).unwrap();
        write_executable(&path_dir.join(exe_name(BIN_NAME)), "#!/bin/sh\nexit 0\n");
        let lookup = |name: &str| (name == "RUSTXNG_BIN").then(|| explicit.display().to_string());
        assert_eq!(binary_with(&lookup, &dirs(&path_dir), Some(&dir)), Some(explicit));
    }

    // A directory named rustxng, or a missing RUSTXNG_BIN path, is not a binary.
    #[test]
    fn only_a_real_file_is_accepted() {
        let dir = test_dir("bin-none");
        let as_dir = dir.join(exe_name(BIN_NAME));
        std::fs::create_dir_all(&as_dir).unwrap();
        std::fs::create_dir_all(dir.join("nope")).unwrap();
        let lookup = |name: &str| (name == "RUSTXNG_BIN").then(|| as_dir.display().to_string());
        assert_eq!(
            binary_with(&lookup, &None, Some(&dir)),
            None,
            "a directory named rustxng must not be accepted"
        );
        let absent =
            |name: &str| (name == "RUSTXNG_BIN").then(|| dir.join("nope").display().to_string());
        assert_eq!(
            binary_with(&absent, &None, Some(&dir)),
            None,
            "a missing RUSTXNG_BIN path falls through to the other locations"
        );
    }

    // PATH is searched before the ~/.local/bin and /usr/local/bin fallbacks.
    #[test]
    fn path_lookup_precedes_the_fallback_directories() {
        let dir = test_dir("bin-path");
        let home = dir.join("home");
        std::fs::create_dir_all(home.join(".local/bin")).unwrap();
        let path_dir = dir.join("path");
        std::fs::create_dir_all(&path_dir).unwrap();
        let on_path = path_dir.join(exe_name(BIN_NAME));
        write_executable(&on_path, "#!/bin/sh\nexit 0\n");
        write_executable(
            &home.join(".local/bin").join(exe_name(BIN_NAME)),
            "#!/bin/sh\nexit 0\n",
        );
        assert_eq!(
            binary_with(&|_: &str| None, &dirs(&path_dir), Some(&home)),
            Some(on_path)
        );
    }

    // With no PATH entry the ~/.local/bin copy is the next candidate.
    #[test]
    fn home_local_bin_is_the_first_fallback_directory() {
        let dir = test_dir("bin-home");
        let home = dir.join("home");
        let bin = home.join(".local/bin");
        std::fs::create_dir_all(&bin).unwrap();
        let candidate = bin.join(exe_name(BIN_NAME));
        write_executable(&candidate, "#!/bin/sh\nexit 0\n");
        assert_eq!(
            binary_with(&|_: &str| None, &None, Some(&home)),
            Some(candidate)
        );
        assert!(fallback_dirs(Some(&home))
            .iter()
            .any(|dir| dir == Path::new("/usr/local/bin")));
    }

    #[test]
    fn state_round_trips_port_and_pid() {
        let dir = test_dir("state");
        let path = dir.join("rustxng.port");
        write_state(&path, 45123, Some(4242)).unwrap();
        assert_eq!(read_state(&path), Some((45123, Some(4242))));
        write_state(&path, 45124, None).unwrap();
        assert_eq!(read_state(&path), Some((45124, None)));
        clear_state(&path);
        assert_eq!(read_state(&path), None);
    }

    #[test]
    fn malformed_state_is_ignored_or_kept_safe() {
        for text in ["", "not-a-port", "0", "70000", "\t", "45123\tnot-a-pid"] {
            match parse_state(text) {
                None => {}
                Some((port, pid)) => {
                    assert!((1..=65535).contains(&port), "{text:?}");
                    assert!(pid.is_none(), "{text:?}");
                }
            }
        }
        assert_eq!(parse_state("45123"), Some((45123, None)));
        assert_eq!(
            parse_state("45123\t4242\ttrailing"),
            Some((45123, Some(4242)))
        );
    }

    #[test]
    fn free_port_is_bindable_and_in_use_reports_a_live_listener() {
        let reserved = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = reserved.local_addr().unwrap().port();
        assert_ne!(port, 0);
        assert!(port_in_use(port), "the reserved listener owns the port");
        drop(reserved);
        // free_port never hands out 0 and always returns a bindable loopback
        // port; re-binding right away proves the release.
        let fresh = free_port().unwrap();
        assert_ne!(fresh, 0);
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, fresh)).unwrap();
        assert!(port_in_use(fresh));
        drop(listener);
    }

    #[test]
    fn plain_chunked_and_bad_health_responses_are_understood() {
        let plain =
            parse_response("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok").unwrap();
        assert_eq!(plain.status, 200);
        assert_eq!(plain.body, "ok");
        assert!(plain.healthy());
        let chunked = parse_response(
            "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2\r\nok\r\n0\r\n\r\n",
        )
        .unwrap();
        assert_eq!(chunked.body, "ok");
        assert!(!parse_response("HTTP/1.1 404 Not Found\r\n\r\nnope")
            .unwrap()
            .healthy());
        assert!(parse_response("<html>not http</html>").is_err());
        // The request-line splitter refuses anything injectable, and keeps a
        // path prefix for instances mounted under one.
        assert!(split_base("http://127.0.0.1:8888/x\r\nInjected: yes").is_err());
        assert!(split_base("https://127.0.0.1:8888").is_err());
        assert_eq!(
            split_base("http://127.0.0.1:8888/searx").unwrap(),
            ("127.0.0.1".to_string(), 8888, "/searx".to_string())
        );
    }

    /// A rustxng stand-in compiled from STUB_SOURCE at test time, so this
    /// exercises the real spawn and probe path with no rustxng installed.
    fn start_stub() -> (String, u16, KillOnDrop) {
        let program = stub_program();
        let port = free_port().unwrap();
        let child = std::process::Command::new(&program)
            .arg(port.to_string())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let guard = KillOnDrop(child);
        let base = url_for(port);
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline && !health(&base) {
            std::thread::sleep(Duration::from_millis(25));
        }
        (base, port, guard)
    }

    /// The compiler that built this test binary. Cargo may export RUSTC as a
    /// bare name, which a test that shrinks PATH for a child would then fail to
    /// find, so resolve an absolute path first.
    fn compiler() -> PathBuf {
        // Cargo exports RUSTC as a bare name, which a test that shrinks PATH
        // for its children would then fail to find. Resolve an absolute path
        // exactly once, on the first call (every caller holds the env lock,
        // so PATH is stable at that moment).
        static RESOLVED: OnceLock<PathBuf> = OnceLock::new();
        RESOLVED
            .get_or_init(|| {
                if let Ok(sysroot) = std::process::Command::new("rustc")
                    .arg("--print")
                    .arg("sysroot")
                    .output()
                {
                    let bin = PathBuf::from(String::from_utf8_lossy(&sysroot.stdout).trim())
                        .join("bin")
                        .join(exe_name("rustc"));
                    if bin.is_file() {
                        return bin;
                    }
                }
                match std::env::var("RUSTC") {
                    Ok(value) if Path::new(&value).is_absolute() => PathBuf::from(value),
                    _ => PathBuf::from("rustc"),
                }
            })
            .clone()
    }

    /// The compiled stub stand-in, built once while PATH is still healthy.
    /// A later PATH change would also hide the linker (cc), so every caller
    /// shares this build instead of compiling its own.
    fn stub_program() -> PathBuf {
        static BUILT: OnceLock<PathBuf> = OnceLock::new();
        BUILT
            .get_or_init(|| build_stub_program(&test_dir("stub-bin")))
            .clone()
    }

    // Compile the stub stand-in; each caller owns the resulting process.
    fn build_stub_program(dir: &Path) -> PathBuf {
        let source = dir.join("stub.rs");
        std::fs::write(&source, STUB_SOURCE).unwrap();
        let program = dir.join(exe_name("stub"));
        let rustc = compiler();
        let output = std::process::Command::new(rustc)
            .arg(&source)
            .arg("-o")
            .arg(&program)
            .output()
            .expect("rustc must run: cargo test ships one");
        assert!(
            output.status.success(),
            "rustc failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        program
    }

    // /healthz and /search answer from the std TCP stub, and the HTML search
    // client parses the stub's results page.
    #[test]
    fn health_and_search_answer_from_a_local_tcp_stub() {
        let _lock = env_lock();
        let (base, port, _guard) = start_stub();
        assert!(health(&base), "/healthz must answer");
        assert!(port_in_use(port));
        let response = http_get(&base, "/search?q=x", Duration::from_secs(5)).unwrap();
        assert_eq!(response.status, 200);
        assert!(response.body.contains("DUMMY_HIT"));
        assert!(response.json().is_none(), "the stub answers HTML, not JSON");
        let hits = crate::websearch::fetch_via_stub(&base, "x", crate::locale::Locale::English)
            .expect("the stub's /search page must parse");
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].title, "DUMMY_HIT");
        assert!(!health(&url_for(free_port().unwrap())));
    }

    // ensure() reuses a healthy instance instead of spawning a second one.
    #[test]
    fn ensure_reuses_a_healthy_instance() {
        let _lock = env_lock();
        let (base, port, _guard) = start_stub();
        let dir = test_dir("ensure-reuse");
        let home = dir.join("home");
        std::fs::create_dir_all(&home).unwrap();
        let state = home.join("rustxng.port");
        write_state(&state, port, Some(999_999)).unwrap();
        let _env = EnvGuard::apply(&[
            ("DSH_HOME", Some(home.to_string_lossy().as_ref())),
            ("RUSTXNG_BIN", None),
            ("RUSTXNG_URL", None),
            ("RUSTXNG_PORT", None),
            ("RUSTXNG_SETTINGS", None),
        ]);
        let _bin = BinGuard::install(Some(&stub_program()));
        let url = ensure().expect("a healthy recorded instance is reused");
        assert_eq!(url, base);
        assert_eq!(read_state(&state), Some((port, Some(999_999))));
    }

    // A configured RUSTXNG_URL is returned when it answers and never spawned
    // into; a dead one is an explicit error, not a silent fallback.
    #[test]
    fn configured_url_is_used_without_spawning() {
        let _lock = env_lock();
        let (base, _port, _guard) = start_stub();
        let dir = test_dir("ensure-url");
        let home = dir.join("home");
        std::fs::create_dir_all(&home).unwrap();
        let dead = free_port().unwrap();
        let _env = EnvGuard::apply(&[
            ("DSH_HOME", Some(home.to_string_lossy().as_ref())),
            ("RUSTXNG_BIN", Some("/nonexistent/rdsh-test-rustxng")),
            ("RUSTXNG_URL", Some(base.as_str())),
            ("RUSTXNG_PORT", None),
        ]);
        assert_eq!(ensure(), Ok(base));
        std::env::set_var("RUSTXNG_URL", url_for(dead));
        let failure = ensure().unwrap_err();
        assert!(matches!(failure, Error::Unresponsive(_)), "{failure:?}");
        assert!(!home.join("rustxng.port").exists());
    }

    // With no binary anywhere, ensure() reports the hint that names RUSTXNG_BIN
    // and writes no state. The fresh $DSH_HOME bounds the write to the test.
    #[test]
    fn ensure_reports_the_missing_binary_hint() {
        let _lock = env_lock();
        let dir = test_dir("ensure-missing");
        let home = dir.join("home");
        std::fs::create_dir_all(&home).unwrap();
        let _env = EnvGuard::apply(&[
            ("DSH_HOME", Some(home.to_string_lossy().as_ref())),
            ("RUSTXNG_BIN", None),
            ("RUSTXNG_URL", None),
            ("RUSTXNG_PORT", None),
            ("RUSTXNG_SETTINGS", None),
        ]);
        let _bin = BinGuard::install(None);
        let failure = ensure().unwrap_err();
        assert_eq!(failure, Error::BinNotFound);
        let hint = missing_binary_hint(crate::locale::Locale::English);
        assert!(hint.contains("RUSTXNG_BIN"), "{hint}");
        assert!(hint.contains("PATH"), "{hint}");
        assert!(!home.join("rustxng.port").exists());
        // The per-platform fallbacks stay documented even with no PATH.
        assert!(!fallback_dirs(Some(&home)).is_empty());
    }

    // start+stop over the real spawn path: ensure() records the port and stop()
    // terminates the recorded pid.
    #[cfg(unix)]
    #[test]
    fn ensure_spawns_and_stop_terminates_the_recorded_instance() {
        let _lock = env_lock();
        let dir = test_dir("ensure-spawn");
        let home = dir.join("home");
        std::fs::create_dir_all(&home).unwrap();
        // stop() identifies the recorded pid by process name, so the fixture
        // has to be named exactly like the real binary.
        let program = dir.join(exe_name(BIN_NAME));
        std::fs::copy(stub_program(), &program).unwrap();
        let _env = EnvGuard::apply(&[
            ("DSH_HOME", Some(home.to_string_lossy().as_ref())),
            ("RUSTXNG_BIN", Some(program.to_string_lossy().as_ref())),
            ("RUSTXNG_URL", None),
            ("RUSTXNG_PORT", None),
            ("RUSTXNG_SETTINGS", None),
        ]);
        let url = ensure().expect("the stub must start");
        let (port, pid) = read_state(&state_file()).expect("ensure records the port");
        assert_eq!(url, url_for(port));
        assert!(health(&url));
        // The log lives under $DSH_HOME/logs, as documented.
        assert!(log_file().starts_with(&home));
        assert!(stop().unwrap(), "stop must terminate the recorded stub");
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline && port_in_use(port) {
            std::thread::sleep(Duration::from_millis(25));
        }
        assert!(!port_in_use(port), "the spawned process must be gone");
        assert_eq!(read_state(&state_file()), None);
        assert!(pid.is_some());
        assert!(!stop().unwrap(), "a second stop has nothing to terminate");
    }

    #[cfg(unix)]
    #[test]
    fn process_is_rustxng_rejects_a_foreign_pid() {
        // Our own test process is not rustxng, so stop() would not signal it.
        assert!(!process_is_rustxng(std::process::id()));
        assert!(!process_is_rustxng(999_999));
    }

    // The spawn contract: --bind ADDRESS --port PORT, plus --config only when
    // RUSTXNG_SETTINGS names a real file.
    #[test]
    fn spawn_arguments_follow_the_documented_cli() {
        let dir = test_dir("config");
        let config = dir.join("settings.yml");
        std::fs::write(&config, "search: {}\n").unwrap();
        let _env = EnvGuard::apply(&[("RUSTXNG_SETTINGS", None)]);
        let mut command = std::process::Command::new(BIN_NAME);
        build_command(&mut command, 45123);
        let args: Vec<String> = command
            .get_args()
            .map(|arg| arg.to_string_lossy().to_string())
            .collect();
        assert_eq!(args, vec!["--bind", "127.0.0.1", "--port", "45123"]);

        std::env::set_var("RUSTXNG_SETTINGS", &config);
        let mut command = std::process::Command::new(BIN_NAME);
        build_command(&mut command, 45124);
        let args: Vec<String> = command
            .get_args()
            .map(|arg| arg.to_string_lossy().to_string())
            .collect();
        assert_eq!(
            args,
            vec![
                "--config",
                config.to_string_lossy().as_ref(),
                "--bind",
                "127.0.0.1",
                "--port",
                "45124"
            ]
        );
    }

    const STUB_SOURCE: &str = r#"
use std::io::{Read, Write};
use std::net::TcpListener;

fn main() {
    // The documented rustxng CLI contract: --bind ADDRESS --port PORT. A
    // bare positional port is accepted too, so the fixture can also be run
    // by hand.
    let mut positional = None;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        if arg == "--port" {
            positional = Some(args.next().unwrap());
        } else if !arg.starts_with('-') {
            positional.get_or_insert(arg);
        }
    }
    let port: u16 = positional.expect("--port is required").parse().unwrap();
    let listener = TcpListener::bind(("127.0.0.1", port)).unwrap();
    for stream in listener.incoming() {
        let Ok(mut stream) = stream else { continue };
        let mut request = Vec::new();
        let mut byte = [0u8; 1];
        while let Ok(1) = stream.read(&mut byte) {
            request.push(byte[0]);
            if request.ends_with(b"\r\n\r\n") || request.len() > 16384 {
                break;
            }
        }
        let request = String::from_utf8_lossy(&request).to_string();
        let target = request
            .lines()
            .next()
            .and_then(|line| line.split_whitespace().nth(1))
            .unwrap_or("/")
            .to_string();
        let (status, body) = if target.starts_with("/healthz") {
            ("200 OK", "{\"status\":\"ok\"}".to_string())
        } else if target.starts_with("/search") {
            (
                "200 OK",
                "<html><head><meta name=\"generator\" content=\"searxng/test\"></head><body><div id=\"results\"><article class=\"result\"><a href=\"https://example.invalid/\">DUMMY_HIT</a></article></div></body></html>".to_string(),
            )
        } else {
            ("404 Not Found", "no".to_string())
        };
        let response = format!(
            "HTTP/1.0 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}{}\r\n\r\n{body}",
            body.len(),
            "\r\n\r\n"
        );
        let _ = stream.write_all(response.as_bytes());
        let _ = stream.flush();
    }
}
"#;
}
