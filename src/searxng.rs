//! On-demand lifecycle for the local SearXNG container behind
//! 'rdsh search-web --provider searxng --auto-start'.
//!
//! Nothing starts unless the caller asked for it (--auto-start) and the
//! endpoint is loopback. The compose project is compiled into the binary, so
//! an installed rdsh (release archive or `cargo install`) can start it too:
//! the archives carry the binary alone and both installers refuse an archive
//! with extra members, so a file next to the binary would never be there.
//! $RDSH_SEARXNG_COMPOSE_FILE still overrides the built-in project. Failures
//! stay advisory: a host without Docker or Podman gets one clear sentence
//! instead of a panic or a hang, and callers that did not opt in never reach
//! this code at all.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// Compose file this repository ships for the local instance. It is both the
/// file name of the built-in project and the name the checked-in file uses.
pub const COMPOSE_FILE: &str = "docker-compose.searxng.yml";
/// Names the compose file explicitly (absolute, or relative to the cwd).
pub const COMPOSE_FILE_ENV: &str = "RDSH_SEARXNG_COMPOSE_FILE";

/// The project compiled into the binary. Substituting the endpoint into this
/// text keeps the checked-in file the single source of truth.
const BUNDLED_COMPOSE: &str = include_str!("../docker-compose.searxng.yml");
/// Settings file the built-in compose mounts, also compiled in.
const BUNDLED_SETTINGS: &str = include_str!("../docker/searxng/settings.yml");
/// Where the built-in compose mounts its settings, relative to the project
/// directory. Writing the bundle with this layout keeps the volume path in the
/// compose file unchanged and resolvable.
const SETTINGS_RELATIVE: &str = "docker/searxng/settings.yml";
/// Endpoint the checked-in compose publishes; the built-in project replaces it
/// with the configured one.
const BUNDLED_ENDPOINT: &str = "127.0.0.1:8888";

/// One reachability probe: short enough to sit in a CLI's startup path.
const PROBE_TIMEOUT: Duration = Duration::from_millis(200);
/// How long to wait for the container to answer after 'up -d'.
const START_TIMEOUT: Duration = Duration::from_secs(10);
const POLL_INTERVAL: Duration = Duration::from_millis(500);
/// How long a compose runtime gets to prove it accepted the command. 'up -d'
/// keeps running while an image is pulled, so exiting right away means this
/// runtime could not start the service and the next candidate deserves a turn.
const RUNTIME_SETTLE: Duration = Duration::from_millis(300);

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
    /// The file named by $RDSH_SEARXNG_COMPOSE_FILE is not there.
    NoComposeFile,
    /// The built-in compose project could not be written to a cache directory.
    ComposeUnavailable,
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
                crate::locale::Locale::English => format!(
                    "{COMPOSE_FILE_ENV} does not name a readable file; {runtime_hint}"
                ),
                crate::locale::Locale::Chinese => {
                    format!("{COMPOSE_FILE_ENV} 未指向可读文件；{runtime_hint}")
                }
                crate::locale::Locale::Japanese => format!(
                    "{COMPOSE_FILE_ENV} が読み取り可能なファイルを指していません。{runtime_hint}"
                ),
            },
            Self::ComposeUnavailable => match locale {
                crate::locale::Locale::English => format!(
                    "the built-in {COMPOSE_FILE} could not be written to the cache directory; set a writable HOME or name your own file with {COMPOSE_FILE_ENV}"
                ),
                crate::locale::Locale::Chinese => format!(
                    "无法将内置 {COMPOSE_FILE} 写入缓存目录；请设置可写的 HOME，或用 {COMPOSE_FILE_ENV} 指定文件"
                ),
                crate::locale::Locale::Japanese => format!(
                    "同梱の {COMPOSE_FILE} をキャッシュディレクトリへ書き出せません。書き込み可能な HOME を設定するか、{COMPOSE_FILE_ENV} でファイルを指定してください"
                ),
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

/// Where the compose project for the local instance comes from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ComposeSource {
    /// $RDSH_SEARXNG_COMPOSE_FILE names the file; its port mapping is the
    /// user's, so rdsh never rewrites it.
    Override(PathBuf),
    /// The project compiled into the binary, written to a cache directory for
    /// the selected endpoint when a start is attempted.
    Bundled,
}

impl ComposeSource {
    /// 'rdsh doctor' label: the user's file, or the built-in project.
    pub fn label(&self, locale: crate::locale::Locale) -> String {
        let missing = match locale {
            crate::locale::Locale::English => "not found",
            crate::locale::Locale::Chinese => "未找到",
            crate::locale::Locale::Japanese => "見つかりません",
        };
        match self {
            Self::Override(path) if path.is_file() => path.display().to_string(),
            Self::Override(path) => format!("{} ({missing})", path.display()),
            Self::Bundled => match locale {
                crate::locale::Locale::English => {
                    "built in (written under the cache dir on demand)".to_string()
                }
                crate::locale::Locale::Chinese => "内置（需要时写入缓存目录）".to_string(),
                crate::locale::Locale::Japanese => {
                    "同梱（必要時にキャッシュへ書き出し）".to_string()
                }
            },
        }
    }
}

/// Resolve the compose source for this process.
pub fn compose_source() -> ComposeSource {
    match std::env::var_os(COMPOSE_FILE_ENV) {
        Some(explicit) => ComposeSource::Override(PathBuf::from(explicit)),
        None => ComposeSource::Bundled,
    }
}

/// Directory the built-in project is written to: the per-user cache, so one
/// account reuses a single copy instead of writing into a checkout.
fn bundled_dir() -> Option<PathBuf> {
    crate::inspect::home_dir().map(|home| {
        PathBuf::from(home)
            .join(".cache")
            .join("rdsh")
            .join("searxng")
    })
}

/// Write the built-in project for one endpoint and return its compose file.
fn write_bundled(host: &str, port: u16) -> Option<PathBuf> {
    write_bundled_in(&bundled_dir()?, host, port)
}

/// Write the project under 'dir'. Split out from 'write_bundled' so tests stay
/// hermetic.
fn write_bundled_in(dir: &Path, host: &str, port: u16) -> Option<PathBuf> {
    let settings = dir.join(SETTINGS_RELATIVE);
    std::fs::create_dir_all(settings.parent()?).ok()?;
    write_if_changed(&settings, BUNDLED_SETTINGS.as_bytes())?;
    let compose = dir.join(COMPOSE_FILE);
    write_if_changed(&compose, render_compose(host, port).as_bytes())?;
    Some(compose)
}

/// Replace the bundled endpoint with the selected loopback one, so the
/// published port follows SEARXNG_URL instead of always being 8888. The
/// default endpoint renders back to the checked-in file byte for byte.
fn render_compose(host: &str, port: u16) -> String {
    let bare = host
        .strip_prefix('[')
        .and_then(|rest| rest.strip_suffix(']'))
        .unwrap_or(host);
    let bracketed = bare.contains(':');
    // A docker port binding needs a literal address; 'localhost' is the only
    // loopback name split_base can hand over.
    let bind = if bracketed {
        format!("[{bare}]")
    } else if bare.eq_ignore_ascii_case("localhost") {
        "127.0.0.1".to_string()
    } else {
        bare.to_string()
    };
    let authority = if bracketed {
        format!("[{bare}]:{port}")
    } else {
        format!("{bare}:{port}")
    };
    BUNDLED_COMPOSE
        .replace(
            &format!("{BUNDLED_ENDPOINT}:8080"),
            &format!("{bind}:{port}:8080"),
        )
        .replace(
            &format!("http://{BUNDLED_ENDPOINT}/"),
            &format!("http://{authority}/"),
        )
}

/// Write only when the content differs, and never in place: a concurrent
/// reader (or a second --auto-start) must not see a half-written file.
fn write_if_changed(path: &Path, bytes: &[u8]) -> Option<()> {
    if std::fs::read(path).ok().as_deref() == Some(bytes) {
        return Some(());
    }
    let temporary = path.with_file_name(format!(
        "{}.{}.tmp",
        path.file_name()?.to_string_lossy(),
        std::process::id()
    ));
    std::fs::write(&temporary, bytes).ok()?;
    std::fs::rename(&temporary, path).ok()
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
    ensure_with(base, enabled, locale, &Plan::detect(), &candidates)
}

struct Plan {
    compose: ComposeSource,
    start_timeout: Duration,
}

impl Plan {
    fn detect() -> Self {
        Self {
            compose: compose_source(),
            start_timeout: START_TIMEOUT,
        }
    }
}

/// 'runtimes' maps the resolved compose file to the invocations to try, in
/// order. It is a parameter so tests can choose the runtime without touching
/// PATH.
fn ensure_with(
    base: &str,
    enabled: bool,
    locale: crate::locale::Locale,
    plan: &Plan,
    runtimes: &dyn Fn(&Path) -> Vec<Vec<String>>,
) -> Outcome {
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
    // The built-in project is written for this endpoint, so its published port
    // always follows the configured URL. A user-named file keeps its own
    // mapping; a mismatch there shows up as the timeout below.
    let compose = match &plan.compose {
        ComposeSource::Override(path) => {
            if !path.is_file() {
                return Outcome::NoComposeFile;
            }
            path.clone()
        }
        ComposeSource::Bundled => match write_bundled(&host, port) {
            Some(path) => path,
            None => return Outcome::ComposeUnavailable,
        },
    };
    if !runtimes(&compose).iter().any(|argv| spawn(argv)) {
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
/// spawn it detached and poll the endpoint instead. It still has to accept the
/// command, which a successful spawn alone does not prove: a host whose
/// 'docker' has no Compose v2 plugin exits immediately, and the next candidate
/// (docker-compose, podman) must get its turn instead of the whole attempt
/// ending in a timeout.
fn spawn(argv: &[String]) -> bool {
    let Some((program, args)) = argv.split_first() else {
        return false;
    };
    let Ok(mut child) = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    else {
        return false;
    };
    std::thread::sleep(RUNTIME_SETTLE);
    match child.try_wait() {
        // Still running: it took the command (a pull can take minutes).
        Ok(None) => true,
        // It finished this fast: only a clean exit means it handled the
        // command, so a failure falls through to the next candidate.
        Ok(Some(status)) => status.success(),
        // It started and cannot be observed; do not spawn a second runtime.
        Err(_) => true,
    }
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
    use std::sync::atomic::{AtomicU64, Ordering};

    fn english() -> crate::locale::Locale {
        crate::locale::Locale::English
    }

    fn free_port() -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.local_addr().unwrap().port()
    }

    /// A per-test directory that does not collide with parallel tests.
    fn test_dir(tag: &str) -> PathBuf {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let nonce = NEXT.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "rdsh-searxng-test-{}-{nonce}-{tag}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("test directory");
        dir
    }

    /// A compose file that exists, for plans that only exercise the runtime.
    fn compose_in(dir: &Path) -> PathBuf {
        let path = dir.join(COMPOSE_FILE);
        std::fs::write(&path, "services: {}\n").expect("test compose file");
        path
    }

    fn noop_command() -> Vec<String> {
        if cfg!(windows) {
            vec!["cmd".to_string(), "/c".to_string(), "exit".to_string()]
        } else {
            vec!["/bin/sh".to_string(), "-c".to_string(), "true".to_string()]
        }
    }

    fn failing_command() -> Vec<String> {
        if cfg!(windows) {
            vec!["cmd".to_string(), "/c".to_string(), "exit 1".to_string()]
        } else {
            vec![
                "/bin/sh".to_string(),
                "-c".to_string(),
                "exit 1".to_string(),
            ]
        }
    }

    /// Writes "ok" to 'marker' through a shell, so the fall-through is proven
    /// by a side effect. The path travels as a positional argument, which keeps
    /// the quoting identical for every path.
    #[cfg(unix)]
    fn marker_command(marker: &Path) -> Vec<String> {
        vec![
            "/bin/sh".to_string(),
            "-c".to_string(),
            "printf ok > \"$1\"".to_string(),
            "rdsh-searxng-test".to_string(),
            marker.display().to_string(),
        ]
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
    fn probe_finds_listener_and_rejects_bound_non_listener() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        assert!(probe("127.0.0.1", port, PROBE_TIMEOUT));
        // Keep the negative port reserved without listening. Dropping a
        // listener lets another parallel test immediately reuse its port.
        let reserved = tokio::net::TcpSocket::new_v4().unwrap();
        reserved.bind("127.0.0.1:0".parse().unwrap()).unwrap();
        let unused_port = reserved.local_addr().unwrap().port();
        assert!(!probe("127.0.0.1", unused_port, PROBE_TIMEOUT));
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
    fn a_missing_override_file_is_reported_before_spawning() {
        let _lock = crate::test_support::env_lock();
        let dir = test_dir("missing-override");
        let plan = Plan {
            compose: ComposeSource::Override(dir.join("absent.yml")),
            start_timeout: Duration::from_millis(250),
        };
        let base = format!("http://127.0.0.1:{}", free_port());
        assert_eq!(
            ensure_with(&base, true, english(), &plan, &|_| Vec::new()),
            Outcome::NoComposeFile
        );
    }

    #[test]
    fn an_unknown_runtime_is_reported_instead_of_panicking() {
        let _lock = crate::test_support::env_lock();
        let dir = test_dir("unknown-runtime");
        let plan = Plan {
            compose: ComposeSource::Override(compose_in(&dir)),
            start_timeout: Duration::from_millis(250),
        };
        let missing = vec![vec!["rdsh-compose-does-not-exist-9f3a".to_string()]];
        let base = format!("http://127.0.0.1:{}", free_port());
        assert_eq!(
            ensure_with(&base, true, english(), &plan, &|_| missing.clone()),
            Outcome::NoRuntime
        );
    }

    #[test]
    fn a_runtime_that_starts_nothing_reports_a_timeout() {
        let _lock = crate::test_support::env_lock();
        let dir = test_dir("noop-runtime");
        let plan = Plan {
            compose: ComposeSource::Override(compose_in(&dir)),
            start_timeout: Duration::from_millis(250),
        };
        let base = format!("http://127.0.0.1:{}", free_port());
        let noop = vec![noop_command()];
        assert_eq!(
            ensure_with(&base, true, english(), &plan, &|_| noop.clone()),
            Outcome::Timeout
        );
    }

    #[test]
    fn an_unusable_runtime_falls_through_to_the_next_candidate() {
        let _lock = crate::test_support::env_lock();
        let dir = test_dir("fallthrough");
        // The first runtime exits at once, as 'docker compose' does without the
        // Compose v2 plugin. Missing the second candidate only becomes visible
        // now that the first failure does not end the attempt: the old code
        // stopped at the first successful spawn and reported a timeout.
        let runtimes = vec![
            failing_command(),
            vec!["rdsh-compose-does-not-exist-9f3a".to_string()],
        ];
        let plan = Plan {
            compose: ComposeSource::Override(compose_in(&dir)),
            start_timeout: Duration::from_millis(250),
        };
        let base = format!("http://127.0.0.1:{}", free_port());
        assert_eq!(
            ensure_with(&base, true, english(), &plan, &|_| runtimes.clone()),
            Outcome::NoRuntime
        );
    }

    #[cfg(unix)]
    #[test]
    fn the_candidate_after_a_failed_runtime_really_runs() {
        let _lock = crate::test_support::env_lock();
        let dir = test_dir("fallthrough-runs");
        let marker = dir.join("second-ran");
        // The first runtime exits at once; the second one must still get its
        // turn, proven by the file it writes.
        let runtimes = vec![failing_command(), marker_command(&marker)];
        let plan = Plan {
            compose: ComposeSource::Override(compose_in(&dir)),
            start_timeout: Duration::from_millis(250),
        };
        let base = format!("http://127.0.0.1:{}", free_port());
        // The second runtime ran but started nothing, so the wait still times
        // out; the point is that it was tried at all.
        assert_eq!(
            ensure_with(&base, true, english(), &plan, &|_| runtimes.clone()),
            Outcome::Timeout
        );
        assert_eq!(
            std::fs::read_to_string(&marker)
                .expect("second candidate ran")
                .trim(),
            "ok"
        );
    }

    #[test]
    fn the_bundled_compose_follows_the_selected_endpoint() {
        // The default endpoint renders back to the checked-in file exactly.
        assert_eq!(render_compose("127.0.0.1", 8888), BUNDLED_COMPOSE);
        // Another port moves the published port and the base URL together.
        let custom = render_compose("127.0.0.1", 8899);
        assert!(custom.contains("\"127.0.0.1:8899:8080\""), "{custom}");
        assert!(custom.contains("http://127.0.0.1:8899/"), "{custom}");
        assert!(!custom.contains(BUNDLED_ENDPOINT), "{custom}");
        // IPv6 keeps its brackets; 'localhost' binds the literal address docker
        // accepts while keeping its own base URL.
        let ipv6 = render_compose("[::1]", 8888);
        assert!(ipv6.contains("\"[::1]:8888:8080\""), "{ipv6}");
        assert!(ipv6.contains("http://[::1]:8888/"), "{ipv6}");
        let local = render_compose("localhost", 8888);
        assert!(local.contains("\"127.0.0.1:8888:8080\""), "{local}");
        assert!(local.contains("http://localhost:8888/"), "{local}");
    }

    #[test]
    fn the_bundled_project_is_written_with_the_settings_it_mounts() {
        let dir = test_dir("bundle");
        let compose = write_bundled_in(&dir, "127.0.0.1", 8899).expect("bundle");
        assert_eq!(compose, dir.join(COMPOSE_FILE));
        assert_eq!(
            std::fs::read_to_string(&compose).unwrap(),
            render_compose("127.0.0.1", 8899)
        );
        // The compose file mounts the settings by a path relative to its own
        // directory, so the settings must land at exactly that layout.
        assert!(std::fs::read_to_string(&compose)
            .unwrap()
            .contains("./docker/searxng/settings.yml"));
        assert_eq!(
            std::fs::read_to_string(dir.join(SETTINGS_RELATIVE)).unwrap(),
            BUNDLED_SETTINGS
        );
        // Writing again is idempotent and leaves no temporary file behind.
        assert_eq!(write_bundled_in(&dir, "127.0.0.1", 8899), Some(compose));
        let entries: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        assert_eq!(entries.len(), 2, "{entries:?}");
    }

    #[test]
    fn failures_explain_themselves_and_started_status_is_advisory() {
        let no_runtime = Outcome::NoRuntime
            .start_failure("http://127.0.0.1:8888", english())
            .unwrap();
        assert!(no_runtime.contains("docker compose"), "{no_runtime}");
        assert!(Outcome::NoComposeFile
            .start_failure("http://127.0.0.1:8888", english())
            .unwrap()
            .contains(COMPOSE_FILE_ENV));
        assert!(Outcome::ComposeUnavailable
            .start_failure("http://127.0.0.1:8888", english())
            .unwrap()
            .contains("cache"));
        assert!(Outcome::Timeout
            .start_failure("http://127.0.0.1:8888", english())
            .unwrap()
            .contains("did not answer"));
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
