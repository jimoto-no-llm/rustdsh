//! On-demand lifecycle for the local SearXNG container behind
//! 'rdsh search-web --provider searxng --auto-start'.
//!
//! Nothing starts unless the caller asked for it (--auto-start), the endpoint
//! is loopback, and a compose file from this repository is found (or
//! $RDSH_SEARXNG_COMPOSE_FILE names one). Failures stay advisory: a host
//! without Docker or Podman gets one clear sentence instead of a panic or a
//! hang, and callers that did not opt in never reach this code at all.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// Compose file this repository ships for the local instance.
pub const COMPOSE_FILE: &str = "docker-compose.searxng.yml";
/// Names the compose file explicitly (absolute, or relative to the cwd).
pub const COMPOSE_FILE_ENV: &str = "RDSH_SEARXNG_COMPOSE_FILE";

/// One reachability probe: short enough to sit in a CLI's startup path.
const PROBE_TIMEOUT: Duration = Duration::from_millis(200);
/// How long to wait for the container to answer after 'up -d'.
const START_TIMEOUT: Duration = Duration::from_secs(10);
const POLL_INTERVAL: Duration = Duration::from_millis(500);

/// What 'ensure_running' did, or why it did nothing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    /// The endpoint answered; nothing was started.
    AlreadyUp,
    /// A compose runtime started the container and it answered.
    Started,
    /// The caller did not ask for auto-start.
    Disabled,
    /// The endpoint is not loopback, so a local container cannot serve it.
    Remote,
    /// No compose file was found.
    NoComposeFile,
    /// No usable docker/docker-compose/podman/podman-compose on PATH.
    NoRuntime,
    /// A runtime was spawned but the endpoint stayed silent.
    Timeout,
}

impl Outcome {
    /// Advisory line worth printing before a search, if any.
    pub fn notice(&self, base: &str, locale: crate::locale::Locale) -> Option<String> {
        if !matches!(self, Self::Started) {
            return None;
        }
        Some(match locale {
            crate::locale::Locale::English => {
                format!("[rdsh] started SearXNG for {base} (compose up -d)")
            }
            crate::locale::Locale::Chinese => {
                format!("[rdsh] 已为 {base} 启动 SearXNG（compose up -d）")
            }
            crate::locale::Locale::Japanese => {
                format!("[rdsh] {base} 向けに SearXNG を起動しました（compose up -d）")
            }
        })
    }

    /// Plain sentence for a start that could not complete. None keeps the
    /// caller on its normal path (already up, opted out, or a remote base
    /// that reports its own connection error).
    pub fn start_failure(&self, base: &str, locale: crate::locale::Locale) -> Option<String> {
        let runtime_hint = match locale {
            crate::locale::Locale::English => "start Docker/Podman, or run SearXNG yourself",
            crate::locale::Locale::Chinese => "请启动 Docker/Podman，或自行运行 SearXNG",
            crate::locale::Locale::Japanese => {
                "Docker/Podman を起動するか、SearXNG を手動で起動してください"
            }
        };
        Some(match self {
            Self::NoRuntime => match locale {
                crate::locale::Locale::English => format!(
                    "no container runtime found (docker compose, docker-compose, podman compose, podman-compose); {runtime_hint}"
                ),
                crate::locale::Locale::Chinese => format!(
                    "未找到容器运行时（docker compose、docker-compose、podman compose、podman-compose）；{runtime_hint}"
                ),
                crate::locale::Locale::Japanese => format!(
                    "コンテナランタイムが見つかりません（docker compose、docker-compose、podman compose、podman-compose）。{runtime_hint}"
                ),
            },
            Self::NoComposeFile => match locale {
                crate::locale::Locale::English => format!("{COMPOSE_FILE} not found; {runtime_hint}"),
                crate::locale::Locale::Chinese => format!("未找到 {COMPOSE_FILE}；{runtime_hint}"),
                crate::locale::Locale::Japanese => format!("{COMPOSE_FILE} が見つかりません。{runtime_hint}"),
            },
            Self::Timeout => match locale {
                crate::locale::Locale::English => format!(
                    "SearXNG at {base} did not answer within {}s; the container may still be starting",
                    START_TIMEOUT.as_secs()
                ),
                crate::locale::Locale::Chinese => format!(
                    "{base} 的 SearXNG 在 {} 秒内没有响应；容器可能仍在启动",
                    START_TIMEOUT.as_secs()
                ),
                crate::locale::Locale::Japanese => format!(
                    "{base} の SearXNG が {} 秒以内に応答しません。コンテナはまだ起動中の可能性があります",
                    START_TIMEOUT.as_secs()
                ),
            },
            _ => return None,
        })
    }
}

/// The compose file to use: an explicit override, then the working directory,
/// then the directory holding this binary (an installed rdsh keeps the file
/// next to itself).
pub fn compose_file() -> Option<PathBuf> {
    if let Some(explicit) = std::env::var_os(COMPOSE_FILE_ENV) {
        let path = PathBuf::from(explicit);
        return path.is_file().then_some(path);
    }
    let local = PathBuf::from(COMPOSE_FILE);
    if local.is_file() {
        return Some(local);
    }
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.join(COMPOSE_FILE)))
        .filter(|path| path.is_file())
}

/// Container runtimes reachable on PATH, for 'rdsh doctor'.
pub fn runtime_names() -> Vec<&'static str> {
    const NAMES: [&str; 4] = ["docker", "docker-compose", "podman", "podman-compose"];
    NAMES.iter().copied().filter(|name| on_path(name)).collect()
}

/// Whether 'base' answers a TCP connection within PROBE_TIMEOUT.
pub fn reachable(base: &str, locale: crate::locale::Locale) -> bool {
    match crate::websearch::split_base(base, locale) {
        Ok((host, port, _)) => probe(&host, port, PROBE_TIMEOUT),
        Err(_) => false,
    }
}

/// Start the shipped local instance when it is down.
///
/// Returns what happened; it never returns an error, because every failure
/// here is a reason to keep going without web search rather than to abort.
pub fn ensure_running(base: &str, enabled: bool, locale: crate::locale::Locale) -> Outcome {
    ensure_with(base, enabled, locale, &Plan::detect())
}

struct Plan {
    compose: Option<PathBuf>,
    argv: Vec<Vec<String>>,
    start_timeout: Duration,
}

impl Plan {
    fn detect() -> Self {
        let compose = compose_file();
        let argv = compose.as_deref().map(candidates).unwrap_or_default();
        Self {
            compose,
            argv,
            start_timeout: START_TIMEOUT,
        }
    }
}

fn ensure_with(base: &str, enabled: bool, locale: crate::locale::Locale, plan: &Plan) -> Outcome {
    if !enabled {
        return Outcome::Disabled;
    }
    let (host, port) = match crate::websearch::split_base(base, locale) {
        Ok((host, port, _)) => (host, port),
        // A malformed base is reported by the search itself, not here.
        Err(_) => return Outcome::Remote,
    };
    if !crate::websearch::is_loopback_host(&host) {
        return Outcome::Remote;
    }
    if probe(&host, port, PROBE_TIMEOUT) {
        return Outcome::AlreadyUp;
    }
    if plan.compose.is_none() {
        return Outcome::NoComposeFile;
    }
    if !plan.argv.iter().any(|argv| spawn(argv)) {
        return Outcome::NoRuntime;
    }
    let deadline = Instant::now() + plan.start_timeout;
    while Instant::now() < deadline {
        if probe(&host, port, PROBE_TIMEOUT) {
            return Outcome::Started;
        }
        std::thread::sleep(POLL_INTERVAL.min(plan.start_timeout));
    }
    Outcome::Timeout
}

/// Compose invocations to try, in order. 'docker compose' (v2) first: a Docker
/// Desktop install ships it and docker-compose v1 is end of life.
fn candidates(file: &Path) -> Vec<Vec<String>> {
    let file = file.display().to_string();
    let mut out: Vec<Vec<String>> = Vec::new();
    for (program, sub) in [
        ("docker", Some("compose")),
        ("docker-compose", None),
        ("podman", Some("compose")),
        ("podman-compose", None),
    ] {
        let mut argv = vec![program.to_string()];
        if let Some(sub) = sub {
            argv.push(sub.to_string());
        }
        argv.extend([
            "-f".to_string(),
            file.clone(),
            "up".to_string(),
            "-d".to_string(),
        ]);
        out.push(argv);
    }
    out
}

/// 'up -d' keeps running while an image is pulled, so never wait for it:
/// spawn it detached and poll the endpoint instead.
fn spawn(argv: &[String]) -> bool {
    let Some((program, args)) = argv.split_first() else {
        return false;
    };
    Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .is_ok()
}

fn probe(host: &str, port: u16, timeout: Duration) -> bool {
    use std::net::ToSocketAddrs;
    let bare = host
        .strip_prefix('[')
        .and_then(|h| h.strip_suffix(']'))
        .unwrap_or(host);
    let Ok(addresses) = (bare, port).to_socket_addrs() else {
        return false;
    };
    let deadline = Instant::now() + timeout;
    for address in addresses {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return false;
        }
        if std::net::TcpStream::connect_timeout(&address, remaining).is_ok() {
            return true;
        }
    }
    false
}

fn on_path(name: &str) -> bool {
    let Some(path) = std::env::var_os("PATH") else {
        return false;
    };
    std::env::split_paths(&path).any(|dir| {
        dir.join(name).is_file() || (cfg!(windows) && dir.join(format!("{name}.exe")).is_file())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    fn english() -> crate::locale::Locale {
        crate::locale::Locale::English
    }

    fn free_port() -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.local_addr().unwrap().port()
    }

    fn noop_command() -> Vec<String> {
        if cfg!(windows) {
            vec!["cmd".to_string(), "/c".to_string(), "exit".to_string()]
        } else {
            vec!["sh".to_string(), "-c".to_string(), "true".to_string()]
        }
    }

    #[test]
    fn compose_candidates_prefer_docker_compose_v2() {
        let list = candidates(Path::new("/tmp/docker-compose.searxng.yml"));
        assert_eq!(list.len(), 4);
        assert_eq!(list[0][..3], ["docker", "compose", "-f"]);
        assert_eq!(list[1][0], "docker-compose");
        assert_eq!(list[2][..2], ["podman", "compose"]);
        assert_eq!(list[3][0], "podman-compose");
        for argv in &list {
            assert_eq!(argv[argv.len() - 2..], ["up", "-d"]);
            assert!(argv.contains(&"/tmp/docker-compose.searxng.yml".to_string()));
        }
    }

    #[test]
    fn probe_finds_a_listening_socket_and_misses_a_closed_one() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        assert!(probe("127.0.0.1", port, PROBE_TIMEOUT));
        drop(listener);
        assert!(!probe("127.0.0.1", port, PROBE_TIMEOUT));
    }

    #[test]
    fn opted_out_and_remote_bases_never_start_anything() {
        assert_eq!(
            ensure_running("http://127.0.0.1:8888", false, english()),
            Outcome::Disabled
        );
        // A remote base is decided before any probe, so this makes no request.
        assert_eq!(
            ensure_running("http://searx.example.invalid:8888", true, english()),
            Outcome::Remote
        );
    }

    #[test]
    fn a_listening_endpoint_is_already_up_without_a_compose_file() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
        assert_eq!(ensure_running(&base, true, english()), Outcome::AlreadyUp);
    }

    #[test]
    fn a_missing_compose_file_is_reported_before_spawning() {
        let plan = Plan {
            compose: None,
            argv: vec![noop_command()],
            start_timeout: Duration::from_millis(250),
        };
        let base = format!("http://127.0.0.1:{}", free_port());
        assert_eq!(
            ensure_with(&base, true, english(), &plan),
            Outcome::NoComposeFile
        );
    }

    #[test]
    fn an_unknown_runtime_is_reported_instead_of_panicking() {
        let plan = Plan {
            compose: Some(PathBuf::from("/tmp/docker-compose.searxng.yml")),
            argv: vec![vec!["rdsh-compose-does-not-exist-9f3a".to_string()]],
            start_timeout: Duration::from_millis(250),
        };
        let base = format!("http://127.0.0.1:{}", free_port());
        assert_eq!(
            ensure_with(&base, true, english(), &plan),
            Outcome::NoRuntime
        );
    }

    #[test]
    fn a_runtime_that_starts_nothing_reports_a_timeout() {
        let plan = Plan {
            compose: Some(PathBuf::from("/tmp/docker-compose.searxng.yml")),
            argv: vec![noop_command()],
            start_timeout: Duration::from_millis(250),
        };
        let base = format!("http://127.0.0.1:{}", free_port());
        assert_eq!(ensure_with(&base, true, english(), &plan), Outcome::Timeout);
    }

    #[test]
    fn failures_explain_themselves_and_started_status_is_advisory() {
        let no_runtime = Outcome::NoRuntime
            .start_failure("http://127.0.0.1:8888", english())
            .unwrap();
        assert!(no_runtime.contains("docker compose"), "{no_runtime}");
        assert!(Outcome::Started
            .notice("http://127.0.0.1:8888", english())
            .unwrap()
            .contains("started SearXNG"));
        // Nothing is printed for a healthy or opted-out run.
        assert!(Outcome::AlreadyUp
            .notice("http://127.0.0.1:8888", english())
            .is_none());
        assert!(Outcome::Disabled
            .start_failure("http://127.0.0.1:8888", english())
            .is_none());
        assert!(Outcome::Remote
            .start_failure("http://127.0.0.1:8888", english())
            .is_none());
    }
}
