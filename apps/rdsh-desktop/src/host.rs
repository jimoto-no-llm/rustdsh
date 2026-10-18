//! Supervise the harness web host.
//!
//! The harness runtime is a Node process, so launching it costs seconds. The
//! host is therefore detached from the app: it keeps running between launches,
//! its ready URL is cached, and a later start reuses it in milliseconds. The
//! ready URL carries the process token, so the cache is written with 0600 mode
//! under the user cache directory.

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
        for origin in candidate_origins() {
            if !alive(&origin) {
                continue;
            }
            let authority = origin.strip_prefix("http://")?.to_string();
            let (name, value) = crate::cookies::cookie_for(&secret, &authority);
            return Some(Self {
                url: origin.clone(),
                origin,
                token: String::new(),
                cookie: Some(format!("{name}={value}")),
                reused: true,
            });
        }
        None
    }

    fn spawn() -> Result<Self> {
        let binary = resolve_dsh()?;
        let log_path = cache_dir()?.join("host.log");
        if let Some(parent) = log_path.parent() {
            fs::create_dir_all(parent).ok();
        }
        let log = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_path)
            .with_context(|| format!("open {}", log_path.display()))?;
        let start_offset = log.metadata().map(|meta| meta.len()).unwrap_or(0);

        let mut command = Command::new(&binary);
        command
            .args(["web", "--no-open", "--port", "0"])
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
                write_cache(&url, &origin, &token, child.id())?;
                return Ok(Self {
                    url,
                    origin,
                    token,
                    cookie: None,
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
    if cached.pid > 0 {
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

struct Cached {
    url: String,
    origin: String,
    pid: u32,
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
    })
}

fn write_cache(url: &str, origin: &str, token: &str, pid: u32) -> Result<()> {
    let dir = cache_dir()?;
    fs::create_dir_all(&dir)?;
    let path = dir.join("host.json");
    let body = serde_json::json!({
        "url": url,
        "origin": origin,
        "token": token,
        "pid": pid,
        "startedAt": std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|value| value.as_secs())
            .unwrap_or(0),
    });
    fs::write(&path, serde_json::to_vec(&body)?)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o600));
    }
    Ok(())
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

/// A live host accepts TCP connections on its loopback port.
fn alive(origin: &str) -> bool {
    let Some(authority) = origin.strip_prefix("http://") else {
        return false;
    };
    let Ok(addresses) = authority.to_socket_addrs() else {
        return false;
    };
    addresses
        .into_iter()
        .any(|address| TcpStream::connect_timeout(&address, Duration::from_millis(250)).is_ok())
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

/// RDSH_DESKTOP_DSH, then PATH, then the layout used by the local install.
fn resolve_dsh() -> Result<PathBuf> {
    if let Ok(value) = std::env::var("RDSH_DESKTOP_DSH") {
        if !value.is_empty() {
            return Ok(PathBuf::from(value));
        }
    }
    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            for name in ["dsh", "dsh-orig"] {
                let candidate = dir.join(name);
                if candidate.is_file() {
                    return Ok(candidate);
                }
            }
        }
    }
    for candidate in [
        "/home/sahen/.local/opt/dsh-original/bin/dsh",
        "/home/sahen/.local/bin/dsh",
    ] {
        let path = PathBuf::from(candidate);
        if path.is_file() {
            return Ok(path);
        }
    }
    Err(anyhow!(
        "dsh was not found; set RDSH_DESKTOP_DSH to the harness launcher"
    ))
}

#[cfg(test)]
mod tests {
    use super::parse_ready;

    #[test]
    fn reads_the_ready_url_from_noisy_output() {
        let text = "plugin noise\ndsh web: http://127.0.0.1:46051/?token=abc123\n";
        let (url, origin, token) = parse_ready(text).expect("ready url");
        assert_eq!(url, "http://127.0.0.1:46051/?token=abc123");
        assert_eq!(origin, "http://127.0.0.1:46051");
        assert_eq!(token, "abc123");
    }

    #[test]
    fn ignores_plugin_noise() {
        assert!(parse_ready("{\"level\":\"fatal\",\"message\":\"Authentication required\"}").is_none());
        assert!(parse_ready("http://example.com/?token=x").is_none());
    }
}
