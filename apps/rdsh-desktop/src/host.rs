//! Supervise the harness web host.
//!
//! The harness runtime is a Node process, so launching it costs seconds. The
//! host is therefore detached from the app: it keeps running between launches,
//! its ready URL is cached, and a later start reuses it in milliseconds. The
//! ready URL carries the process token, so the cache directory and the files
//! in it are owner-only (0700/0600) rather than inheriting the umask: the host
//! log holds the token-bearing ready URL the launcher printed.

use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Seek, SeekFrom};
use std::net::{TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use anyhow::{anyhow, Context, Result};

const READY_TIMEOUT: Duration = Duration::from_secs(90);

pub struct Host {
    pub url: String,
    pub origin: String,
    pub token: String,
    /// Pre-minted session cookie for an already running host.
    pub cookie: Option<String>,
    /// Launcher this host was started from (empty when attached by accident).
    pub binary: std::path::PathBuf,
    /// Version reported by that launcher.
    pub version: String,
    /// True when this launch reused a detached host instead of starting one.
    pub reused: bool,
}

impl Host {
    /// Attach to a host that is already listening, otherwise start one.
    ///
    /// The cookie signing secret lives in the user credentials, so no process
    /// token is needed to talk to the user service or a previous launch. That
    /// turns a cold start into a single HTTP round trip.
    pub fn start() -> Result<Self> {
        // RDSH_DESKTOP_NO_ATTACH forces a fresh host, which is how a specific
        // harness build (for example a release candidate) gets exercised.
        if std::env::var_os("RDSH_DESKTOP_NO_ATTACH").is_none() {
            if let Some(host) = Self::attach() {
                return Ok(host);
            }
        }
        Self::spawn()
    }

    /// Try the running candidates in order and mint a cookie for the first hit.
    pub fn attach() -> Option<Self> {
        let secret = crate::cookies::load_secret()?;
        let mut rejected_cache = false;
        for origin in candidate_origins() {
            if !alive(&origin) {
                continue;
            }
            let authority = origin.strip_prefix("http://")?.to_string();
            let (name, value) = crate::cookies::cookie_for(&secret, &authority);
            // A recorded host may belong to another harness home, in which case
            // our signed cookie is refused. Never trust a candidate that does not
            // accept the cookie we can mint: drop the stale cache and move on.
            if !accepts_cookie(&origin, &format!("{name}={value}")) {
                if origin == cached_origin().unwrap_or_default() {
                    // The cache points at a host we cannot use; drop it so the
                    // next launch goes straight to a host we can talk to.
                    if let Ok(dir) = cache_dir() {
                        let _ = std::fs::remove_file(dir.join("host.json"));
                    }
                    rejected_cache = true;
                }
                continue;
            }
            let (binary, version) = resolve_launcher()
                .map(|(binary, version)| (binary, version))
                .unwrap_or_else(|_| (std::path::PathBuf::new(), "unknown".to_string()));
            if rejected_cache {
                log::info!("discarded a cached host that refused our cookie");
            }
            return Some(Self {
                url: origin.clone(),
                origin,
                token: String::new(),
                cookie: Some(format!("{name}={value}")),
                binary,
                version,
                reused: true,
            });
        }
        None
    }

    fn spawn() -> Result<Self> {
        let (binary, version) = resolve_launcher()?;
        let log_path = cache_dir()?.join("host.log");
        if let Some(parent) = log_path.parent() {
            create_owner_only_dir(parent).ok();
        }
        let log = open_owner_only_append(&log_path)
            .with_context(|| format!("open {}", log_path.display()))?;
        let start_offset = log.metadata().map(|meta| meta.len()).unwrap_or(0);

        let mut command = Command::new(&binary);
        command
            .args(HOST_ARGS)
            .stdin(Stdio::null())
            .stdout(Stdio::from(log.try_clone()?))
            .stderr(Stdio::from(log));
        // Own process group: closing the app must not take the host down.
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        let mut child = command
            .spawn()
            .with_context(|| format!("spawn {} web", binary.display()))?;

        let deadline = Instant::now() + READY_TIMEOUT;
        let mut position = start_offset;
        let mut seen = String::new();
        while Instant::now() < deadline {
            if let Ok(Some(status)) = child.try_wait() {
                return Err(anyhow!(
                    "dsh web exited with {status} before printing a ready URL; log: {}",
                    log_path.display()
                ));
            }
            read_new_lines(&log_path, &mut position, &mut seen);
            if let Some((url, origin, token)) = parse_ready(&seen) {
                write_cache(&url, &origin, child.id(), &binary.to_string_lossy())?;
                return Ok(Self {
                    url,
                    origin,
                    token,
                    cookie: None,
                    binary: binary.clone(),
                    version: version.clone(),
                    reused: false,
                });
            }
            std::thread::sleep(Duration::from_millis(150));
        }
        let _ = child.kill();
        Err(anyhow!(
            "dsh web did not print a ready URL within {}s; log: {}",
            READY_TIMEOUT.as_secs(),
            log_path.display()
        ))
    }
}

/// Stop the detached host recorded in the cache.
pub fn stop_cached() -> Result<String> {
    let Some(cached) = read_cache() else {
        return Ok("no cached host".to_string());
    };
    let mut stopped = false;
    // The PID may have been reused since the host was cached; only signal a
    // process that is still the detached `dsh web` host.
    if cached.pid > 0 && is_cached_host(cached.pid, &cached.binary) {
        stopped = Command::new("kill")
            .args(["-TERM", &cached.pid.to_string()])
            .status()
            .map(|status| status.success())
            .unwrap_or(false);
    }
    let _ = fs::remove_file(cache_dir()?.join("host.json"));
    Ok(if stopped {
        format!("stopped host pid {}", cached.pid)
    } else {
        "cleared the cached host".to_string()
    })
}

/// The exact host invocation `spawn` starts; `--stop-host` signals a PID only
/// while its command line still is this invocation of the recorded binary.
const HOST_ARGS: [&str; 4] = ["web", "--no-open", "--port", "0"];

fn is_cached_host(pid: u32, binary: &str) -> bool {
    Command::new("ps")
        .args(["-o", "command=", "-p", &pid.to_string()])
        .output()
        .ok()
        .filter(|output| output.status.success())
        .is_some_and(|output| {
            is_host_command(String::from_utf8_lossy(&output.stdout).trim(), binary)
        })
}

/// A launcher script runs under its interpreter (`node /path/dsh web …`), so
/// the recorded binary followed by the fixed arguments may appear after argv[0].
fn is_host_command(command: &str, binary: &str) -> bool {
    if binary.is_empty() {
        return false;
    }
    let invocation = format!("{binary} {}", HOST_ARGS.join(" "));
    command == invocation || command.ends_with(&format!(" {invocation}"))
}

struct Cached {
    url: String,
    origin: String,
    pid: u32,
    /// The binary `spawn` started; a cache written before this field existed
    /// has none, so its PID is never signalled.
    binary: String,
}

fn cache_dir() -> Result<PathBuf> {
    let base = std::env::var_os("XDG_CACHE_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".cache")))
        .ok_or_else(|| anyhow!("neither XDG_CACHE_HOME nor HOME is set"))?;
    Ok(base.join("rdsh-desktop"))
}

fn read_cache() -> Option<Cached> {
    let path = cache_dir().ok()?.join("host.json");
    let text = fs::read_to_string(path).ok()?;
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    Some(Cached {
        url: value.get("url")?.as_str()?.to_string(),
        origin: value.get("origin")?.as_str()?.to_string(),
        pid: value.get("pid").and_then(serde_json::Value::as_u64).unwrap_or(0) as u32,
        binary: value
            .get("binary")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .to_string(),
    })
}

fn write_cache(url: &str, origin: &str, pid: u32, binary: &str) -> Result<()> {
    let dir = cache_dir()?;
    create_owner_only_dir(&dir)?;
    let path = dir.join("host.json");
    // The ready URL still carries the process token; nothing reads a separate
    // token field, so it is not stored twice.
    let body = serde_json::json!({
        "url": url,
        "origin": origin,
        "pid": pid,
        "binary": binary,
        "startedAt": std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|value| value.as_secs())
            .unwrap_or(0),
    });
    // Write an owner-only temporary file and rename it over the cache, so the
    // token-bearing URL is never readable by others and concurrent launches
    // replace the cache atomically instead of racing on create.
    let temporary = dir.join(format!("host.json.{}.tmp", std::process::id()));
    let mut options = OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let written = options
        .open(&temporary)
        .with_context(|| format!("create {}", temporary.display()))
        .and_then(|mut file| {
            std::io::Write::write_all(&mut file, &serde_json::to_vec(&body)?)?;
            Ok(())
        })
        .and_then(|()| {
            fs::rename(&temporary, &path).with_context(|| format!("replace {}", path.display()))
        });
    if written.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    written
}

/// Create the cache directory owner-only on unix.
///
/// `create_dir_all` alone inherits the umask, so a host with the usual 0022
/// would leave the directory, and everything later created inside it, readable
/// by other local users.
pub(crate) fn create_owner_only_dir(path: &Path) -> std::io::Result<()> {
    fs::create_dir_all(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        // Advisory on purpose: a filesystem without chmod support must not stop
        // the launch, and a directory that is already owner-only stays so.
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o700));
    }
    Ok(())
}

/// Open a cache file for appending with owner-only permissions on unix.
///
/// The host log carries the ready URL, which includes the process token, so the
/// mode is set explicitly instead of relying on the umask. A file left behind
/// by an earlier run is tightened as well.
fn open_owner_only_append(path: &Path) -> std::io::Result<std::fs::File> {
    let mut options = OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options.open(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
    }
    Ok(file)
}

/// Write a cache file owner-only on unix.
///
/// The Web UI URL carries the access token too. Setting the mode when the
/// file is created, and tightening a file from an earlier run before writing
/// to it, keeps the contents private without a window where they are briefly
/// readable under the process umask.
pub(crate) fn write_owner_only(path: &Path, contents: &[u8]) -> std::io::Result<()> {
    let mut options = OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        // Tighten a file left behind by an earlier run before writing to it.
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
    }
    std::io::Write::write_all(&mut file, contents)
}

fn cached_origin() -> Option<String> {
    read_cache().map(|cached| cached.origin)
}

/// The host must accept a unary call with the cookie we minted, otherwise it
/// belongs to another harness home and is useless to us.
fn accepts_cookie(origin: &str, cookie: &str) -> bool {
    let request = serde_json::json!({
        "type": "client-request",
        "rpcId": "rdsh-desktop-attach-check",
        "method": "session/list",
        "payload": { "args": { "_request": {} } }
    });
    match crate::http::post_json(origin, "/api/session/list", cookie, &request.to_string()) {
        Ok(response) => response.status < 400,
        Err(_) => false,
    }
}

/// Origins to try, cheapest first: explicit override, cached host, user service.
fn candidate_origins() -> Vec<String> {
    let mut list: Vec<String> = Vec::new();
    if let Ok(value) = std::env::var("RDSH_DESKTOP_ORIGIN") {
        if !value.is_empty() {
            list.push(value.trim_end_matches('/').to_string());
        }
    }
    if let Some(cached) = read_cache() {
        list.push(cached.origin);
    }
    list.push("http://127.0.0.1:3080".to_string());
    list.dedup();
    list
}

/// Run one npm query with a hard deadline, so a hung registry cannot stall the caller.
fn npm_view(arguments: &[&str]) -> Option<String> {
    let mut command = std::process::Command::new("npm");
    command
        .args(arguments)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());
    let mut child = command.spawn().ok()?;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(25);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                if !status.success() {
                    return None;
                }
                break;
            }
            Ok(None) => {
                if std::time::Instant::now() > deadline {
                    let _ = child.kill();
                    return None;
                }
                std::thread::sleep(std::time::Duration::from_millis(200));
            }
            Err(_) => return None,
        }
    }
    let mut output = String::new();
    use std::io::Read;
    child.stdout.take()?.read_to_string(&mut output).ok()?;
    Some(output)
}

/// Version behind the npm latest tag.
pub fn latest_published() -> Option<String> {
    let output = npm_view(&["view", "@deepseek-ai/dsh", "version"])?;
    let version = output.split_whitespace().last()?.trim().to_string();
    (!version.is_empty()).then_some(version)
}

/// Highest published version, prereleases included.
pub fn newest_published() -> Option<String> {
    let output = npm_view(&["view", "@deepseek-ai/dsh", "versions", "--json"])?;
    let versions: Vec<String> = match serde_json::from_str::<serde_json::Value>(output.trim()) {
        Ok(serde_json::Value::Array(values)) => values
            .into_iter()
            .filter_map(|value| value.as_str().map(str::to_string))
            .collect(),
        Ok(serde_json::Value::String(single)) => vec![single],
        _ => Vec::new(),
    };
    versions.into_iter().reduce(|best, candidate| {
        if compare_versions(&candidate, &best).is_gt() {
            candidate
        } else {
            best
        }
    })
}

/// A live host accepts TCP connections on its loopback port.
///
/// The signed session cookie is sent to whatever answers here, so a candidate
/// (including `RDSH_DESKTOP_ORIGIN`) is accepted only when every address it
/// resolves to is loopback.
fn alive(origin: &str) -> bool {
    let Some(addresses) = loopback_addresses(origin) else {
        return false;
    };
    addresses
        .into_iter()
        .any(|address| TcpStream::connect_timeout(&address, Duration::from_millis(250)).is_ok())
}

fn loopback_addresses(origin: &str) -> Option<Vec<std::net::SocketAddr>> {
    let authority = origin.strip_prefix("http://")?;
    if authority.is_empty() || authority.contains(['/', '?', '#', '@']) {
        return None;
    }
    // The HTTP and WebSocket clients resolve the authority again for every
    // connection, so a DNS name could answer loopback here and a remote
    // address later. Accept only literal IPs and `localhost`, which resolvers
    // answer locally (RFC 6761).
    let (host, _) = authority.rsplit_once(':')?;
    let host = host.trim_start_matches('[').trim_end_matches(']');
    if host != "localhost" && host.parse::<std::net::IpAddr>().is_err() {
        return None;
    }
    let addresses: Vec<_> = authority.to_socket_addrs().ok()?.collect();
    (!addresses.is_empty() && addresses.iter().all(|address| address.ip().is_loopback()))
        .then_some(addresses)
}

fn read_new_lines(path: &Path, position: &mut u64, out: &mut String) {
    let Ok(mut file) = fs::File::open(path) else {
        return;
    };
    if file.seek(SeekFrom::Start(*position)).is_err() {
        return;
    }
    let reader = BufReader::new(file);
    for line in reader.lines().map_while(Result::ok) {
        out.push_str(&line);
        out.push('\n');
        if out.len() > 200_000 {
            let keep = out.len() - 100_000;
            out.drain(..keep);
        }
    }
    if let Ok(meta) = fs::metadata(path) {
        *position = meta.len();
    }
}

/// Find the printed ready URL and split it into url, origin and process token.
fn parse_ready(text: &str) -> Option<(String, String, String)> {
    for candidate in text.split_whitespace() {
        let Some(index) = candidate.find("http://") else {
            continue;
        };
        let url = candidate[index..].trim_end_matches(['.', ',', ')']);
        let Some((base, query)) = url.split_once('?') else {
            continue;
        };
        let Some(token) = query.split('&').find_map(|pair| pair.strip_prefix("token=")) else {
            continue;
        };
        if token.is_empty() {
            continue;
        }
        let origin = base.trim_end_matches('/').to_string();
        if !origin.starts_with("http://127.0.0.1:") && !origin.starts_with("http://localhost:") {
            continue;
        }
        return Some((url.to_string(), origin, token.to_string()));
    }
    None
}

/// Every place a harness launcher may live, most specific first.
fn candidate_binaries() -> Vec<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(value) = std::env::var("RDSH_DESKTOP_DSH") {
        if !value.is_empty() {
            candidates.push(PathBuf::from(value));
        }
    }
    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            for name in ["dsh", "dsh-orig"] {
                candidates.push(dir.join(name));
            }
        }
    }
    if let Some(home) = std::env::var_os("HOME") {
        let home = PathBuf::from(home);
        candidates.push(home.join(".local/bin/dsh"));
        candidates.push(home.join(".local/opt/dsh-original/bin/dsh"));
        candidates.push(home.join(".npm-global/bin/dsh"));
    }
    candidates.push(PathBuf::from("/usr/local/bin/dsh"));
    candidates.push(PathBuf::from("/usr/bin/dsh"));
    candidates
}

/// Version reported by one launcher, or None when it does not answer.
pub fn version_of(binary: &Path) -> Option<String> {
    let output = Command::new(binary).arg("--version").output().ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let candidate = text.split_whitespace().last()?.trim().to_string();
    let looks_like_version = candidate
        .chars()
        .next()
        .map(|character| character.is_ascii_digit())
        .unwrap_or(false);
    looks_like_version.then_some(candidate)
}

fn split_prerelease(version: &str) -> (&str, Option<&str>) {
    match version.split_once('-') {
        Some((base, pre)) => (base, Some(pre)),
        None => (version, None),
    }
}

fn compare_numeric(left: &str, right: &str) -> std::cmp::Ordering {
    let left: Vec<u64> = left
        .split('.')
        .map(|part| part.parse::<u64>().unwrap_or(0))
        .collect();
    let right: Vec<u64> = right
        .split('.')
        .map(|part| part.parse::<u64>().unwrap_or(0))
        .collect();
    for index in 0..left.len().max(right.len()) {
        let left = left.get(index).copied().unwrap_or(0);
        let right = right.get(index).copied().unwrap_or(0);
        match left.cmp(&right) {
            std::cmp::Ordering::Equal => continue,
            other => return other,
        }
    }
    std::cmp::Ordering::Equal
}

/// Compare dotted versions; a prerelease sorts below its release tag.
pub fn compare_versions(left: &str, right: &str) -> std::cmp::Ordering {
    let (left_base, left_pre) = split_prerelease(left);
    let (right_base, right_pre) = split_prerelease(right);
    let base = compare_numeric(left_base, right_base);
    if base != std::cmp::Ordering::Equal {
        return base;
    }
    match (left_pre, right_pre) {
        (None, None) => std::cmp::Ordering::Equal,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (Some(_), None) => std::cmp::Ordering::Less,
        (Some(left), Some(right)) => {
            let (left_tag, left_number) = match left.rsplit_once('.') {
                Some((tag, number)) if number.chars().all(|c| c.is_ascii_digit()) => (tag, number),
                _ => (left, ""),
            };
            let (right_tag, right_number) = match right.rsplit_once('.') {
                Some((tag, number)) if number.chars().all(|c| c.is_ascii_digit()) => (tag, number),
                _ => (right, ""),
            };
            match left_tag.cmp(right_tag) {
                std::cmp::Ordering::Equal => compare_numeric(left_number, right_number),
                other => other,
            }
        }
    }
}

/// Pick the newest launcher that answers, so an upstream upgrade is picked up
/// without touching the app. RDSH_DESKTOP_DSH always wins when it is set.
pub fn resolve_launcher() -> Result<(PathBuf, String)> {
    if let Ok(value) = std::env::var("RDSH_DESKTOP_DSH") {
        if !value.is_empty() {
            let binary = PathBuf::from(&value);
            let version = version_of(&binary).unwrap_or_else(|| "unknown".to_string());
            return Ok((binary, version));
        }
    }
    let mut best: Option<(PathBuf, String)> = None;
    for candidate in candidate_binaries() {
        if !candidate.is_file() {
            continue;
        }
        match version_of(&candidate) {
            Some(version) => {
                let better = best
                    .as_ref()
                    .map(|(_, current)| compare_versions(&version, current).is_gt())
                    .unwrap_or(true);
                if better {
                    best = Some((candidate, version));
                }
            }
            None => {
                if best.is_none() {
                    best = Some((candidate, "unknown".to_string()));
                }
            }
        }
    }
    best.ok_or_else(|| {
        anyhow!("dsh was not found; set RDSH_DESKTOP_DSH to the harness launcher")
    })
}

#[cfg(test)]
mod tests {
    use super::{
        create_owner_only_dir, is_host_command, loopback_addresses, open_owner_only_append,
        parse_ready, write_owner_only,
    };

    #[test]
    fn orders_releases_above_their_prereleases() {
        use super::compare_versions;
        use std::cmp::Ordering;
        assert_eq!(compare_versions("0.2.1", "0.2.1-rc.2"), Ordering::Greater);
        assert_eq!(compare_versions("0.2.1-rc.2", "0.2.1-alpha.2"), Ordering::Greater);
        assert_eq!(compare_versions("0.2.1-rc.2", "0.2.0-rc.2"), Ordering::Greater);
        assert_eq!(compare_versions("0.2.1-alpha.10", "0.2.1-alpha.2"), Ordering::Greater);
        assert_eq!(compare_versions("0.2.1-rc.2", "0.2.1-rc.2"), Ordering::Equal);
        assert_eq!(compare_versions("0.2.0", "0.10.0"), Ordering::Less);
    }

    #[test]
    fn reads_the_ready_url_from_noisy_output() {
        let text = "plugin noise\ndsh web: http://127.0.0.1:46051/?token=abc123\n";
        let (url, origin, token) = parse_ready(text).expect("ready url");
        assert_eq!(url, "http://127.0.0.1:46051/?token=abc123");
        assert_eq!(origin, "http://127.0.0.1:46051");
        assert_eq!(token, "abc123");
    }

    #[test]
    fn attaches_only_to_loopback_origins() {
        assert!(loopback_addresses("http://127.0.0.1:3080").is_some());
        assert!(loopback_addresses("http://[::1]:3080").is_some());
        assert!(loopback_addresses("http://localhost:3080").is_some());
        for origin in [
            "http://192.0.2.10:3080",
            "https://127.0.0.1:3080",
            "http://127.0.0.1:3080/path",
            "http://user@127.0.0.1:3080",
            "http://127.0.0.1",
            "http://",
            // DNS names are resolved again per connection, so only literal
            // IPs and localhost are accepted.
            "http://loopback.example:3080",
        ] {
            assert!(loopback_addresses(origin).is_none(), "{origin}");
        }
    }

    #[test]
    fn stops_only_the_recorded_host_invocation() {
        let dsh = "/opt/harness/bin/launcher";
        assert!(is_host_command(
            "/opt/harness/bin/launcher web --no-open --port 0",
            dsh
        ));
        // A launcher script runs under its interpreter.
        assert!(is_host_command(
            "node /opt/harness/bin/launcher web --no-open --port 0",
            dsh
        ));
        for command in [
            "python3 /tmp/rdsh-maintenance.py web",
            "/usr/local/bin/dsh web --no-open --port 0",
            "/opt/harness/bin/launcher web",
            "/opt/harness/bin/launcher-evil web --no-open --port 0",
            "/opt/harness/bin/launcher web --no-open --port 0 --extra",
        ] {
            assert!(!is_host_command(command, dsh), "{command}");
        }
        // A cache written before the binary was recorded never signals.
        assert!(!is_host_command("dsh web --no-open --port 0", ""));
    }

    #[test]
    fn ignores_plugin_noise() {
        assert!(parse_ready("{\"level\":\"fatal\",\"message\":\"Authentication required\"}").is_none());
        assert!(parse_ready("http://example.com/?token=x").is_none());
    }

    // The host log carries the token-bearing ready URL, so its mode must not
    // follow the umask of whoever launched the app.
    #[cfg(unix)]
    #[test]
    fn cache_files_are_owner_only_even_when_a_loose_one_exists() {
        use std::fs;
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!(
            "rdsh-desktop-cache-mode-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        create_owner_only_dir(&dir).unwrap();
        assert_eq!(fs::metadata(&dir).unwrap().permissions().mode() & 0o777, 0o700);

        let log = dir.join("host.log");
        drop(open_owner_only_append(&log).unwrap());
        assert_eq!(fs::metadata(&log).unwrap().permissions().mode() & 0o777, 0o600);

        // A log written by an earlier run with a looser umask is tightened.
        fs::set_permissions(&log, fs::Permissions::from_mode(0o644)).unwrap();
        drop(open_owner_only_append(&log).unwrap());
        assert_eq!(fs::metadata(&log).unwrap().permissions().mode() & 0o777, 0o600);

        // The Web UI URL carries the same token, and a loose file from an
        // earlier run is tightened before the new value is written.
        let url = dir.join("webui.url");
        fs::write(&url, "http://127.0.0.1:1/?token=old\n").unwrap();
        fs::set_permissions(&url, fs::Permissions::from_mode(0o644)).unwrap();
        write_owner_only(&url, b"http://127.0.0.1:1/?token=new\n").unwrap();
        assert_eq!(fs::metadata(&url).unwrap().permissions().mode() & 0o777, 0o600);
        assert_eq!(
            fs::read_to_string(&url).unwrap(),
            "http://127.0.0.1:1/?token=new\n"
        );
        let _ = fs::remove_dir_all(&dir);
    }
}
