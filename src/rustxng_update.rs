//! Keeps the rdsh-managed rustxng sidecar on the latest GitHub release.
//!
//! License boundary (unchanged, see the parent module): rustxng is AGPL and is
//! only ever downloaded as a release asset and run as a separate process.
//!
//! What is updated: only `~/.local/bin/rustxng` (the file rdsh itself
//! installs). A binary named by RUSTXNG_BIN, an instance at RUSTXNG_URL, or a
//! rustxng found elsewhere on PATH belongs to the user and is never touched.
//!
//! Where it runs: `ensure()` only *decides* whether a check is due (one small
//! file read) and, when it is, starts a detached `rdsh rustxng update
//! --background`. The network round trips and the up-to-200MB download happen
//! in that worker, so a search never waits for them; an update that finishes
//! later is picked up by the next run. A synchronous check with a short budget
//! was rejected: an API call plus a download cannot honestly fit "a few
//! seconds" on a slow link, and a half-finished download is wasted work.
//!
//! Safety: downloads come only from [INSTALL_REPO]'s releases over https
//! (redirects stay on GitHub hosts), are size-capped, must match the sha256 in
//! the API and in the `.sha256` asset, are written next to the target, are
//! started once (`--version`) before the atomic rename, started again after it,
//! and rolled back from `rustxng.prev` when that second start fails.
//!
//! Environment:
//!   RUSTXNG_SKIP_UPDATE=1             stop the automatic update only
//!   RUSTXNG_SKIP_INSTALL=1            also stops the automatic update
//!   RUSTXNG_UPDATE_INTERVAL_HOURS=N   hours between checks (default 24, 0 = always)

use std::cmp::Ordering;
use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::{bail, ensure, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::{
    choose_asset, env, exe_name, home_dir, install_path, looks_like_executable,
    parse_latest_assets, state_file, target_triple, ReleaseAsset, BIN_NAME, INSTALL_REPO,
};
use crate::locale::Locale;

/// Ceiling for one downloaded binary; the real ones are ~15MB.
const MAX_BINARY_BYTES: usize = 200 * 1024 * 1024;
/// Ceiling for the release JSON and a `.sha256` sidecar.
const MAX_TEXT_BYTES: usize = 1024 * 1024;
const API_TIMEOUT: Duration = Duration::from_secs(20);
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(300);
/// How long `<binary> --version` may take before the binary counts as broken.
const PROBE_TIMEOUT: Duration = Duration::from_secs(3);
/// A lock older than this belongs to a worker that died.
const LOCK_STALE: Duration = Duration::from_secs(15 * 60);
const DEFAULT_INTERVAL_HOURS: u64 = 24;
const DAY_SECS: u64 = 24 * 3600;

// ---------------------------------------------------------------- versions

/// Minimal semver: `major.minor.patch[-pre][+build]`, with an optional `v`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Version {
    major: u64,
    minor: u64,
    patch: u64,
    pre: Option<String>,
}

impl std::fmt::Display for Version {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}.{}.{}", self.major, self.minor, self.patch)?;
        if let Some(pre) = &self.pre {
            write!(f, "-{pre}")?;
        }
        Ok(())
    }
}

impl Ord for Version {
    fn cmp(&self, other: &Self) -> Ordering {
        (self.major, self.minor, self.patch)
            .cmp(&(other.major, other.minor, other.patch))
            .then_with(|| match (&self.pre, &other.pre) {
                (None, None) => Ordering::Equal,
                // A release outranks any of its pre-releases.
                (None, Some(_)) => Ordering::Greater,
                (Some(_), None) => Ordering::Less,
                (Some(a), Some(b)) => cmp_pre(a, b),
            })
    }
}

impl PartialOrd for Version {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

fn cmp_pre(a: &str, b: &str) -> Ordering {
    let mut left = a.split('.');
    let mut right = b.split('.');
    loop {
        match (left.next(), right.next()) {
            (None, None) => return Ordering::Equal,
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(x), Some(y)) => {
                let order = match (x.parse::<u64>(), y.parse::<u64>()) {
                    (Ok(x), Ok(y)) => x.cmp(&y),
                    (Ok(_), Err(_)) => Ordering::Less,
                    (Err(_), Ok(_)) => Ordering::Greater,
                    (Err(_), Err(_)) => x.cmp(y),
                };
                if order != Ordering::Equal {
                    return order;
                }
            }
        }
    }
}

/// Parse a tag or version word such as `v0.14.0`, `0.4.1` or `1.0.0-rc.1`.
pub(crate) fn parse_version(text: &str) -> Option<Version> {
    let text = text.trim();
    let text = text.strip_prefix('v').unwrap_or(text);
    let text = text.split('+').next()?;
    let (core, pre) = match text.split_once('-') {
        Some((core, pre)) => (core, Some(pre)),
        None => (text, None),
    };
    let mut parts = core.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    let patch = parts.next()?.parse().ok()?;
    if parts.next().is_some() {
        return None;
    }
    let pre = match pre {
        Some(pre) => {
            let valid = !pre.is_empty()
                && pre.split('.').all(|id| {
                    !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
                });
            if !valid {
                return None;
            }
            Some(pre.to_string())
        }
        None => None,
    };
    Some(Version {
        major,
        minor,
        patch,
        pre,
    })
}

/// The version in `rustxng --version` output (`RustXNG 0.4.1`): the first word
/// that parses as a version.
pub(crate) fn parse_installed_version(output: &str) -> Option<Version> {
    output.split_whitespace().find_map(parse_version)
}

// --------------------------------------------------------------- processes

/// Run a command with a hard time limit; Some((success, stdout)) when it
/// finished in time, None when it could not start or had to be killed.
fn run_capture(mut command: Command, timeout: Duration) -> Option<(bool, String)> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut child = command.spawn().ok()?;
    let mut stdout = child.stdout.take()?;
    let reader = std::thread::spawn(move || {
        let mut out = Vec::new();
        let _ = (&mut stdout).take(64 * 1024).read_to_end(&mut out);
        out
    });
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(20));
            }
            // Timed out or lost track of the child: kill it and walk away
            // without joining the reader, which a stray grandchild could hold.
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    };
    let out = reader.join().ok()?;
    Some((status.success(), String::from_utf8_lossy(&out).into_owned()))
}

/// What running `<binary> --version` told us.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Probe {
    /// The binary started, answered in time and exited successfully.
    pub runs: bool,
    pub version: Option<Version>,
}

fn probe_binary(path: &Path) -> Probe {
    let mut command = Command::new(path);
    command.arg("--version");
    match run_capture(command, PROBE_TIMEOUT) {
        Some((true, out)) => Probe {
            runs: true,
            version: parse_installed_version(&out),
        },
        _ => Probe {
            runs: false,
            version: None,
        },
    }
}

// ------------------------------------------------------------------- state

/// What the last checks learned. Lives next to the sidecar's port file.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub(crate) struct UpdateState {
    /// Unix seconds of the last attempt (success or failure).
    pub last_check: u64,
    /// Latest release tag seen (`v0.14.0`).
    pub latest_tag: Option<String>,
    /// Consecutive failed attempts; drives the backoff.
    pub failures: u32,
    /// Tag rdsh itself installed last, with the file size it had.
    pub installed_tag: Option<String>,
    pub installed_len: u64,
    /// The binary was replaced: the sidecar rdsh started must be restarted.
    pub restart_pending: bool,
}

fn update_state_path() -> PathBuf {
    state_file().with_file_name("rustxng-update.json")
}

fn lock_path() -> PathBuf {
    state_file().with_file_name("rustxng-update.lock")
}

pub(crate) fn load_state(path: &Path) -> UpdateState {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

pub(crate) fn save_state(path: &Path, state: &UpdateState) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_string_pretty(state)?)?;
    std::fs::rename(&tmp, path)
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Seconds between checks from RUSTXNG_UPDATE_INTERVAL_HOURS (0 = every time).
fn base_interval_secs(lookup: &dyn Fn(&str) -> Option<String>) -> u64 {
    lookup("RUSTXNG_UPDATE_INTERVAL_HOURS")
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(DEFAULT_INTERVAL_HOURS)
        .saturating_mul(3600)
}

/// Wait before the next attempt. After failures the wait starts at one hour
/// and doubles per failure, capped at 24h and never above the normal interval.
fn effective_interval(base_secs: u64, failures: u32) -> u64 {
    if base_secs == 0 {
        return 0;
    }
    if failures == 0 {
        return base_secs;
    }
    let step = 3600u64
        .checked_shl(failures.saturating_sub(1).min(16))
        .unwrap_or(DAY_SECS);
    step.min(DAY_SECS).min(base_secs)
}

fn is_due(now: u64, state: &UpdateState, base_secs: u64) -> bool {
    // A clock that moved backwards must not postpone the check indefinitely.
    if state.last_check > now {
        return true;
    }
    now - state.last_check >= effective_interval(base_secs, state.failures)
}

fn record_success(state: &mut UpdateState, tag: &str, now: u64) {
    state.last_check = now;
    state.latest_tag = Some(tag.to_string());
    state.failures = 0;
}

fn record_failure(state: &mut UpdateState, now: u64) {
    state.last_check = now;
    state.failures = state.failures.saturating_add(1);
}

// ---------------------------------------------------------------- decision

fn truthy_one(lookup: &dyn Fn(&str) -> Option<String>, name: &str) -> bool {
    lookup(name).is_some_and(|value| value == "1")
}

/// Why an automatic check does not run right now.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Skip {
    /// RUSTXNG_SKIP_UPDATE=1 or RUSTXNG_SKIP_INSTALL=1.
    Disabled,
    /// RUSTXNG_BIN or RUSTXNG_URL: the user manages the engine.
    UserManaged,
    /// There is no rdsh-installed binary to update.
    NotInstalled,
    /// The binary that would run is a different one (another PATH entry).
    NotResolved,
    /// The interval has not elapsed.
    NotDue,
}

fn same_file(a: &Path, b: &Path) -> bool {
    match (a.canonicalize(), b.canonicalize()) {
        (Ok(a), Ok(b)) => a == b,
        _ => a == b,
    }
}

/// Is the automatic update enabled by the environment alone?
pub(crate) fn auto_enabled(lookup: &dyn Fn(&str) -> Option<String>) -> bool {
    !truthy_one(lookup, "RUSTXNG_SKIP_UPDATE") && !truthy_one(lookup, "RUSTXNG_SKIP_INSTALL")
}

fn user_managed(lookup: &dyn Fn(&str) -> Option<String>) -> bool {
    lookup("RUSTXNG_BIN").is_some() || lookup("RUSTXNG_URL").is_some()
}

/// Whether an automatic check should run now: None means "yes, check".
pub(crate) fn auto_skip_reason(
    lookup: &dyn Fn(&str) -> Option<String>,
    managed: &Path,
    resolved: Option<&Path>,
    state: &UpdateState,
    now: u64,
) -> Option<Skip> {
    if !auto_enabled(lookup) {
        return Some(Skip::Disabled);
    }
    if user_managed(lookup) {
        return Some(Skip::UserManaged);
    }
    if !managed.is_file() {
        return Some(Skip::NotInstalled);
    }
    if !resolved.is_some_and(|resolved| same_file(resolved, managed)) {
        return Some(Skip::NotResolved);
    }
    if !is_due(now, state, base_interval_secs(lookup)) {
        return Some(Skip::NotDue);
    }
    None
}

/// Must the binary be replaced? An unreadable version counts as "maybe old",
/// except that a file rdsh installed at this very tag and size is trusted
/// (otherwise a binary that cannot print its version would be re-downloaded on
/// every check).
fn needs_update(
    probe: &Probe,
    latest: &Version,
    latest_tag: &str,
    state: &UpdateState,
    file_len: u64,
) -> bool {
    match &probe.version {
        Some(installed) => installed < latest,
        None => {
            let trusted = probe.runs
                && state.installed_tag.as_deref() == Some(latest_tag)
                && state.installed_len == file_len;
            !trusted
        }
    }
}

// ----------------------------------------------------------- network layer

/// One GET with a size cap. The real implementation is [HttpsFetch]; tests
/// substitute a table so nothing ever reaches the network.
pub(crate) trait Fetch {
    fn get(&self, url: &str, limit: usize, timeout: Duration) -> Result<Vec<u8>>;
}

/// The host of an `https://host[/path]` URL; None for anything else (plain
/// http, userinfo, an explicit port, a query or fragment).
fn https_host(url: &str) -> Option<&str> {
    let rest = url.strip_prefix("https://")?;
    let host = rest.split('/').next()?;
    if host.is_empty()
        || host.contains(['@', ':', '?', '#', '\\'])
        || url.chars().any(|c| c.is_control() || c.is_whitespace())
    {
        return None;
    }
    Some(host)
}

/// Hosts a request or redirect may land on: GitHub itself and its asset CDN.
pub(crate) fn allowed_url(url: &str) -> bool {
    let Some(host) = https_host(url) else {
        return false;
    };
    let host = host.to_ascii_lowercase();
    host == "github.com"
        || host == "api.github.com"
        || host == "githubusercontent.com"
        || host.ends_with(".githubusercontent.com")
}

/// A release asset URL must be a download of INSTALL_REPO's own releases.
pub(crate) fn allowed_asset_url(url: &str) -> bool {
    let prefix = format!("https://github.com/{INSTALL_REPO}/releases/download/");
    allowed_url(url) && url.starts_with(&prefix) && !url.contains("..")
}

fn latest_api_url() -> String {
    format!("https://api.github.com/repos/{INSTALL_REPO}/releases/latest")
}

struct HttpsFetch;

impl Fetch for HttpsFetch {
    fn get(&self, url: &str, limit: usize, timeout: Duration) -> Result<Vec<u8>> {
        ensure!(allowed_url(url), "refusing to fetch {url}");
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()?;
        runtime.block_on(async {
            let client = reqwest::Client::builder()
                .user_agent(format!("rdsh/{}", env!("CARGO_PKG_VERSION")))
                .connect_timeout(Duration::from_secs(10))
                .timeout(timeout)
                .https_only(true)
                .redirect(reqwest::redirect::Policy::custom(|attempt| {
                    if attempt.previous().len() >= 5 {
                        attempt.error("too many redirects")
                    } else if allowed_url(attempt.url().as_str()) {
                        attempt.follow()
                    } else {
                        attempt.error("redirect leaves GitHub")
                    }
                }))
                .build()?;
            let mut response = client.get(url).send().await?.error_for_status()?;
            if response
                .content_length()
                .is_some_and(|len| len > limit as u64)
            {
                bail!("{url} is larger than {limit} bytes");
            }
            let mut out = Vec::new();
            while let Some(chunk) = response.chunk().await? {
                ensure!(
                    out.len() + chunk.len() <= limit,
                    "{url} exceeded {limit} bytes"
                );
                out.extend_from_slice(&chunk);
            }
            Ok(out)
        })
    }
}

// ----------------------------------------------------------------- release

/// The parts of `/releases/latest` an update needs.
#[derive(Debug, Clone)]
pub(crate) struct Release {
    pub tag: String,
    pub version: Version,
    pub assets: Vec<ReleaseAsset>,
    /// asset name -> lowercase hex sha256 from the API's `digest` field.
    pub digests: HashMap<String, String>,
}

pub(crate) fn parse_release(json: &str) -> Result<Release> {
    let value: serde_json::Value = serde_json::from_str(json)?;
    ensure!(
        value.get("prerelease").and_then(|v| v.as_bool()) != Some(true)
            && value.get("draft").and_then(|v| v.as_bool()) != Some(true),
        "the latest release is a draft or pre-release"
    );
    let tag = value
        .get("tag_name")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow::anyhow!("release has no tag_name"))?
        .to_string();
    let version = parse_version(&tag)
        .filter(|version| version.pre.is_none())
        .ok_or_else(|| anyhow::anyhow!("release tag {tag} is not a plain version"))?;
    let mut digests = HashMap::new();
    if let Some(assets) = value.get("assets").and_then(|v| v.as_array()) {
        for asset in assets {
            let name = asset.get("name").and_then(|v| v.as_str());
            let digest = asset
                .get("digest")
                .and_then(|v| v.as_str())
                .and_then(|d| d.strip_prefix("sha256:"))
                .and_then(normalize_hex);
            if let (Some(name), Some(digest)) = (name, digest) {
                digests.insert(name.to_string(), digest);
            }
        }
    }
    Ok(Release {
        tag,
        version,
        assets: parse_latest_assets(json),
        digests,
    })
}

fn fetch_release(fetch: &dyn Fetch) -> Result<Release> {
    let body = fetch.get(&latest_api_url(), MAX_TEXT_BYTES, API_TIMEOUT)?;
    parse_release(&String::from_utf8_lossy(&body))
}

/// A 64-digit hex string, lowercased; anything else is not a sha256.
fn normalize_hex(text: &str) -> Option<String> {
    let text = text.trim();
    (text.len() == 64 && text.chars().all(|c| c.is_ascii_hexdigit()))
        .then(|| text.to_ascii_lowercase())
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// `<hex>  <file>` (sha256sum) or a bare hex digest.
fn parse_sha256_file(text: &str) -> Option<String> {
    text.split_whitespace().next().and_then(normalize_hex)
}

/// Check `bytes` against every digest that could be obtained. One source is
/// enough; two sources must both match (so they cannot disagree); none is a
/// refusal.
pub(crate) fn verify_digests(
    bytes: &[u8],
    api_digest: Option<&str>,
    sidecar_digest: Option<&str>,
) -> Result<()> {
    let actual = sha256_hex(bytes);
    let expected: Vec<&str> = [api_digest, sidecar_digest].into_iter().flatten().collect();
    ensure!(
        !expected.is_empty(),
        "no sha256 digest is available for the download"
    );
    for digest in expected {
        ensure!(
            digest.eq_ignore_ascii_case(&actual),
            "sha256 mismatch: downloaded {actual}, expected {digest}"
        );
    }
    Ok(())
}

/// Download this host's release binary and prove it is the published one.
fn download_verified(fetch: &dyn Fetch, release: &Release) -> Result<Vec<u8>> {
    let triple = target_triple();
    let asset = choose_asset(&release.assets, triple)
        .ok_or_else(|| anyhow::anyhow!("no release asset matches {triple}"))?;
    ensure!(
        asset.name.starts_with(&format!("rustxng-{}-", release.tag)),
        "asset {} does not belong to {}",
        asset.name,
        release.tag
    );
    ensure!(
        allowed_asset_url(&asset.url),
        "asset URL is not a {INSTALL_REPO} release download: {}",
        asset.url
    );
    let bytes = fetch.get(&asset.url, MAX_BINARY_BYTES, DOWNLOAD_TIMEOUT)?;
    // The `.sha256` asset is optional evidence: a missing or unreadable one
    // leaves the API digest to decide, and verify_digests refuses when both
    // are gone.
    let sidecar_name = format!("{}.sha256", asset.name);
    let sidecar = release
        .assets
        .iter()
        .find(|a| a.name == sidecar_name && allowed_asset_url(&a.url))
        .and_then(|a| fetch.get(&a.url, MAX_TEXT_BYTES, API_TIMEOUT).ok())
        .and_then(|body| parse_sha256_file(&String::from_utf8_lossy(&body)));
    verify_digests(
        &bytes,
        release.digests.get(&asset.name).map(String::as_str),
        sidecar.as_deref(),
    )?;
    ensure!(
        !bytes.is_empty() && looks_like_executable(&bytes),
        "{} did not download as an executable",
        asset.name
    );
    Ok(bytes)
}

// ------------------------------------------------------------ replacement

fn sibling(dest: &Path, suffix: &str) -> PathBuf {
    let dir = dest.parent().unwrap_or_else(|| Path::new("."));
    dir.join(exe_name(&format!("{BIN_NAME}.{suffix}")))
}

/// Where the previous version is kept (one generation).
pub(crate) fn prev_path(dest: &Path) -> PathBuf {
    sibling(dest, "prev")
}

/// Replace `dest` with `bytes` atomically, keeping the old file as
/// `rustxng.prev`. `probe` must see the new file start, both before the rename
/// (nothing changed yet when it fails) and after it (rolled back when it fails).
pub(crate) fn install_verified(
    dest: &Path,
    bytes: &[u8],
    probe: &dyn Fn(&Path) -> Probe,
) -> Result<()> {
    let dir = dest.parent().unwrap_or_else(|| Path::new("."));
    std::fs::create_dir_all(dir)?;
    let tmp = sibling(dest, "update");
    let prev = prev_path(dest);
    let prev_tmp = sibling(dest, "prev-new");
    let cleanup = |path: &Path| {
        let _ = std::fs::remove_file(path);
    };

    std::fs::write(&tmp, bytes)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Err(e) = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755)) {
            cleanup(&tmp);
            return Err(e.into());
        }
    }
    if !probe(&tmp).runs {
        cleanup(&tmp);
        bail!("the downloaded rustxng did not start; keeping the current one");
    }

    // Keep the outgoing version before the swap. A copy (not a rename) so the
    // final rename onto `dest` is the only step that changes what runs.
    let had_old = dest.is_file();
    if had_old {
        let kept = std::fs::copy(dest, &prev_tmp).and_then(|_| std::fs::rename(&prev_tmp, &prev));
        if let Err(e) = kept {
            cleanup(&prev_tmp);
            cleanup(&tmp);
            return Err(e.into());
        }
    }
    if let Err(e) = std::fs::rename(&tmp, dest) {
        // Windows refuses to replace a running executable; leave it for later.
        cleanup(&tmp);
        return Err(e.into());
    }
    if !probe(dest).runs {
        if had_old {
            let _ = std::fs::rename(&prev, dest);
        } else {
            cleanup(dest);
        }
        bail!("the new rustxng failed its start check and was rolled back");
    }
    Ok(())
}

// ------------------------------------------------------------------ driver

/// What a check (and, unless check-only, an update) concluded.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Action {
    UpToDate,
    Available,
    Updated,
}

#[derive(Debug, Clone)]
pub(crate) struct Report {
    pub action: Action,
    pub installed: Option<Version>,
    pub latest_tag: String,
}

/// Check against the latest release and, unless `check_only`, update `dest`.
/// `state` is updated in place (the caller persists it).
pub(crate) fn run_update(
    fetch: &dyn Fetch,
    dest: &Path,
    check_only: bool,
    probe: &dyn Fn(&Path) -> Probe,
    state: &mut UpdateState,
    now: u64,
) -> Result<Report> {
    let release = match fetch_release(fetch) {
        Ok(release) => release,
        Err(e) => {
            record_failure(state, now);
            return Err(e);
        }
    };
    record_success(state, &release.tag, now);
    let current = probe(dest);
    let file_len = std::fs::metadata(dest).map(|m| m.len()).unwrap_or(0);
    let report = |action| Report {
        action,
        installed: current.version.clone(),
        latest_tag: release.tag.clone(),
    };
    if !needs_update(&current, &release.version, &release.tag, state, file_len) {
        return Ok(report(Action::UpToDate));
    }
    if check_only {
        return Ok(report(Action::Available));
    }
    let outcome = download_verified(fetch, &release).and_then(|bytes| {
        install_verified(dest, &bytes, probe)?;
        Ok(bytes.len() as u64)
    });
    match outcome {
        Ok(len) => {
            state.installed_tag = Some(release.tag.clone());
            state.installed_len = len;
            state.restart_pending = true;
            Ok(report(Action::Updated))
        }
        Err(e) => {
            record_failure(state, now);
            Err(e)
        }
    }
}

/// Exclusive right to run an update; released on drop. A stale lock left by a
/// crashed worker is taken over.
struct UpdateLock(PathBuf);

impl UpdateLock {
    fn acquire(path: &Path) -> Option<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).ok()?;
        }
        for _ in 0..2 {
            match std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(path)
            {
                Ok(_) => return Some(Self(path.to_path_buf())),
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                    let stale = lock_is_stale(path);
                    if !stale || std::fs::remove_file(path).is_err() {
                        return None;
                    }
                }
                Err(_) => return None,
            }
        }
        None
    }
}

impl Drop for UpdateLock {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

fn lock_is_stale(path: &Path) -> bool {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|modified| SystemTime::now().duration_since(modified).ok())
        .is_some_and(|age| age > LOCK_STALE)
}

fn lock_is_fresh(path: &Path) -> bool {
    path.exists() && !lock_is_stale(path)
}

fn real_lookup(name: &str) -> Option<String> {
    env(name)
}

/// Called from `ensure()`: start a background check when one is due. Never
/// waits, never prints, never fails the caller.
pub(super) fn auto_tick() {
    // Unit tests never spawn processes or touch the real home.
    #[cfg(not(test))]
    {
        let Some(home) = home_dir() else { return };
        let managed = install_path(&home);
        let state = load_state(&update_state_path());
        let resolved = super::binary();
        if auto_skip_reason(
            &real_lookup,
            &managed,
            resolved.as_deref(),
            &state,
            now_secs(),
        )
        .is_some()
            || lock_is_fresh(&lock_path())
        {
            return;
        }
        spawn_worker();
    }
}

#[cfg(not(test))]
fn spawn_worker() {
    let Ok(exe) = std::env::current_exe() else {
        return;
    };
    let mut command = Command::new(exe);
    command
        .args(["rustxng", "update", "--background"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // Own session, so closing the terminal does not interrupt a download.
        unsafe {
            command.pre_exec(|| {
                libc::setsid();
                libc::signal(libc::SIGHUP, libc::SIG_IGN);
                Ok(())
            });
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // DETACHED_PROCESS | CREATE_NO_WINDOW
        command.creation_flags(0x0000_0008 | 0x0800_0000);
    }
    let _ = command.spawn();
}

/// The detached worker: re-check the policy, then update. Silent by design;
/// every failure only lands in the state file (and backs the next check off).
pub(super) fn run_background() {
    let Some(home) = home_dir() else { return };
    let managed = install_path(&home);
    let state_path = update_state_path();
    let mut state = load_state(&state_path);
    let resolved = super::binary();
    let now = now_secs();
    if auto_skip_reason(&real_lookup, &managed, resolved.as_deref(), &state, now).is_some() {
        return;
    }
    let Some(_lock) = UpdateLock::acquire(&lock_path()) else {
        return;
    };
    let _ = run_update(&HttpsFetch, &managed, false, &probe_binary, &mut state, now);
    let _ = save_state(&state_path, &state);
}

/// `ensure()` found a healthy recorded instance. When the binary was replaced
/// since, stop that instance (only one rdsh started and recorded, verified by
/// name) so the caller starts the new version. True means "stopped; start a
/// fresh one". The flag is cleared either way: an instance the user started
/// themselves is never killed.
pub(super) fn restart_if_stale(port: u16) -> bool {
    let path = update_state_path();
    let mut state = load_state(&path);
    if !state.restart_pending {
        return false;
    }
    state.restart_pending = false;
    let _ = save_state(&path, &state);
    match super::recorded_state() {
        Some((recorded, Some(pid))) if recorded == port && super::process_is_rustxng(pid) => {
            super::stop().unwrap_or(false)
        }
        _ => false,
    }
}

/// A freshly started engine already runs the current binary.
pub(super) fn clear_restart_pending() {
    let path = update_state_path();
    let mut state = load_state(&path);
    if state.restart_pending {
        state.restart_pending = false;
        let _ = save_state(&path, &state);
    }
}

// -------------------------------------------------------------- status/CLI

fn managed_binary_in_use() -> Option<PathBuf> {
    let managed = install_path(&home_dir()?);
    let resolved = super::binary()?;
    (managed.is_file() && same_file(&resolved, &managed)).then_some(managed)
}

/// Extra keys for `rdsh rustxng status --json` (all additive).
pub(super) fn status_fields(binary: Option<&Path>) -> serde_json::Value {
    let state = load_state(&update_state_path());
    let managed = home_dir()
        .map(|home| install_path(&home))
        .zip(binary)
        .is_some_and(|(managed, binary)| same_file(binary, &managed));
    let version = binary.and_then(|b| probe_binary(b).version);
    serde_json::json!({
        "version": version.map(|v| v.to_string()),
        "managed": managed,
        "latest_version": state.latest_tag,
        "last_update_check": (state.last_check > 0).then_some(state.last_check),
        "auto_update": auto_enabled(&real_lookup) && !user_managed(&real_lookup),
    })
}

/// One localized doctor line when the managed binary is older than the latest
/// tag recorded by a previous check. Local only: no network.
pub(crate) fn doctor_line(locale: Locale) -> Option<String> {
    let managed = managed_binary_in_use()?;
    let latest_tag = load_state(&update_state_path()).latest_tag?;
    let latest = parse_version(&latest_tag)?;
    let installed = probe_binary(&managed).version?;
    (installed < latest).then(|| {
        t(
            locale,
            format!("rustxng {installed} is older than {latest_tag}; run: rdsh rustxng update"),
            format!("rustxng {installed} 低于 {latest_tag}；请运行：rdsh rustxng update"),
            format!("rustxng {installed} は {latest_tag} より古い版です。rdsh rustxng update を実行してください"),
        )
    })
}

fn t(locale: Locale, en: String, zh: String, ja: String) -> String {
    match locale {
        Locale::English => en,
        Locale::Chinese => zh,
        Locale::Japanese => ja,
    }
}

/// `rdsh rustxng update [--check] [--json]` (and the hidden `--background`).
pub fn cmd_update(check: bool, json_out: bool, background: bool, locale: Locale) -> Result<()> {
    if background {
        run_background();
        return Ok(());
    }
    let Some(home) = home_dir() else {
        bail!(
            "{}",
            t(
                locale,
                "no home directory".into(),
                "没有主目录".into(),
                "ホームディレクトリがありません".into()
            )
        );
    };
    let dest = install_path(&home);
    let emit = |status: &str, installed: Option<&Version>, latest: Option<&str>, text: String| {
        if json_out {
            let value = serde_json::json!({
                "status": status,
                "installed": installed.map(|v| v.to_string()),
                "latest": latest,
                "path": dest.display().to_string(),
            });
            serde_json::to_string_pretty(&value).map(|s| println!("{s}"))?;
        } else {
            println!("{text}");
        }
        Ok::<(), anyhow::Error>(())
    };
    if !dest.is_file() {
        return emit(
            "not-installed",
            None,
            None,
            t(
                locale,
                format!("no rdsh-managed rustxng at {}; install it with: rdsh rustxng install", dest.display()),
                format!("{} 没有 rdsh 管理的 rustxng；请运行：rdsh rustxng install", dest.display()),
                format!("{} に rdsh が管理する rustxng がありません。rdsh rustxng install で導入してください", dest.display()),
            ),
        );
    }
    let state_path = update_state_path();
    let mut state = load_state(&state_path);
    let _lock = if check {
        None
    } else {
        match UpdateLock::acquire(&lock_path()) {
            Some(lock) => Some(lock),
            None => bail!(
                "{}",
                t(
                    locale,
                    "another rustxng update is already running".into(),
                    "另一个 rustxng 更新正在运行".into(),
                    "別の rustxng 更新が実行中です".into()
                )
            ),
        }
    };
    let result = run_update(
        &HttpsFetch,
        &dest,
        check,
        &probe_binary,
        &mut state,
        now_secs(),
    );
    let _ = save_state(&state_path, &state);
    let report = result?;
    let installed = report
        .installed
        .as_ref()
        .map(|v| v.to_string())
        .unwrap_or_else(|| "?".to_string());
    let latest = report.latest_tag.clone();
    match report.action {
        Action::UpToDate => emit(
            "up-to-date",
            report.installed.as_ref(),
            Some(&latest),
            t(
                locale,
                format!("rustxng is up to date ({installed}, latest {latest})"),
                format!("rustxng 已是最新（{installed}，最新 {latest}）"),
                format!("rustxng は最新です（{installed}、最新 {latest}）"),
            ),
        ),
        Action::Available => emit(
            "update-available",
            report.installed.as_ref(),
            Some(&latest),
            t(
                locale,
                format!("update available: {installed} -> {latest}; run: rdsh rustxng update"),
                format!("有可用更新：{installed} -> {latest}；请运行：rdsh rustxng update"),
                format!("更新があります: {installed} -> {latest}。rdsh rustxng update を実行してください"),
            ),
        ),
        Action::Updated => emit(
            "updated",
            report.installed.as_ref(),
            Some(&latest),
            t(
                locale,
                format!(
                    "rustxng updated: {installed} -> {latest} (previous kept as {}); a running engine restarts on next use",
                    prev_path(&dest).display()
                ),
                format!(
                    "rustxng 已更新：{installed} -> {latest}（旧版保留为 {}）；运行中的引擎将在下次使用时重启",
                    prev_path(&dest).display()
                ),
                format!(
                    "rustxng を更新しました: {installed} -> {latest}（旧版は {} に保存）。稼働中のエンジンは次回の利用時に再起動します",
                    prev_path(&dest).display()
                ),
            ),
        ),
    }
}

/// Short note appended to `rdsh rustxng install`'s messages.
pub(super) fn update_hint(locale: Locale) -> &'static str {
    match locale {
        Locale::English => "keep it current with: rdsh rustxng update",
        Locale::Chinese => "更新请运行：rdsh rustxng update",
        Locale::Japanese => "最新版への更新: rdsh rustxng update",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    use std::sync::atomic::{AtomicU64, Ordering as AtomicOrdering};

    fn v(text: &str) -> Version {
        parse_version(text).unwrap()
    }

    fn temp_dir(label: &str) -> PathBuf {
        static N: AtomicU64 = AtomicU64::new(0);
        let dir = std::env::temp_dir().join(format!(
            "rdsh-rustxng-update-{label}-{}-{}",
            std::process::id(),
            N.fetch_add(1, AtomicOrdering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn lookup_of<'a>(pairs: &'a [(&'a str, &'a str)]) -> impl Fn(&str) -> Option<String> + 'a {
        move |name| {
            pairs
                .iter()
                .find(|(key, _)| *key == name)
                .map(|(_, value)| value.to_string())
        }
    }

    const ELF: &[u8] = b"\x7fELF fake-binary-";

    fn ok_probe(_: &Path) -> Probe {
        Probe {
            runs: true,
            version: None,
        }
    }

    #[test]
    fn semver_orders_numerically_and_prereleases_below_releases() {
        assert!(v("0.4.1") < v("0.14.0"));
        assert!(v("v0.14.0") == v("0.14.0"));
        assert!(v("1.0.0-rc.1") < v("1.0.0"));
        assert!(v("1.0.0-alpha") < v("1.0.0-alpha.1"));
        assert!(v("1.0.0-alpha.2") < v("1.0.0-alpha.10"));
        assert!(v("1.0.0-1") < v("1.0.0-alpha"));
        assert!(v("1.0.0+build5") == v("1.0.0"));
        assert!(v("0.14.0") < v("0.14.1"));
        for bad in [
            "",
            "1.2",
            "1.2.3.4",
            "a.b.c",
            "1.2.x",
            "1.0.0-",
            "1.0.0-a..b",
        ] {
            assert!(parse_version(bad).is_none(), "{bad}");
        }
    }

    #[test]
    fn version_output_is_parsed_from_the_first_version_word() {
        assert_eq!(parse_installed_version("RustXNG 0.4.1\n"), Some(v("0.4.1")));
        assert_eq!(
            parse_installed_version("rustxng v0.14.0 (abc123)"),
            Some(v("0.14.0"))
        );
        assert_eq!(parse_installed_version("RustXNG dev"), None);
        assert_eq!(parse_installed_version(""), None);
    }

    #[cfg(unix)]
    #[test]
    fn run_capture_returns_output_and_enforces_the_timeout() {
        let mut ok = Command::new("sh");
        ok.args(["-c", "echo RustXNG 0.4.1"]);
        let (success, out) = run_capture(ok, Duration::from_secs(5)).unwrap();
        assert!(success);
        assert_eq!(parse_installed_version(&out), Some(v("0.4.1")));

        let mut slow = Command::new("sh");
        slow.args(["-c", "exec sleep 5"]);
        let started = Instant::now();
        assert!(run_capture(slow, Duration::from_millis(200)).is_none());
        assert!(started.elapsed() < Duration::from_secs(3));

        assert!(
            run_capture(Command::new("/nonexistent/rustxng"), Duration::from_secs(1)).is_none()
        );
    }

    #[test]
    fn needs_update_covers_old_new_and_unreadable_versions() {
        let latest = v("0.14.0");
        let runs = |version: Option<Version>| Probe {
            runs: true,
            version,
        };
        let blank = UpdateState::default();
        assert!(needs_update(
            &runs(Some(v("0.4.1"))),
            &latest,
            "v0.14.0",
            &blank,
            10
        ));
        assert!(!needs_update(
            &runs(Some(v("0.14.0"))),
            &latest,
            "v0.14.0",
            &blank,
            10
        ));
        assert!(!needs_update(
            &runs(Some(v("0.15.0-rc.1"))),
            &latest,
            "v0.14.0",
            &blank,
            10
        ));
        // Unreadable: update, unless rdsh installed exactly this file.
        assert!(needs_update(&runs(None), &latest, "v0.14.0", &blank, 10));
        let trusted = UpdateState {
            installed_tag: Some("v0.14.0".into()),
            installed_len: 10,
            ..Default::default()
        };
        assert!(!needs_update(&runs(None), &latest, "v0.14.0", &trusted, 10));
        assert!(needs_update(&runs(None), &latest, "v0.14.0", &trusted, 11));
        let broken = Probe {
            runs: false,
            version: None,
        };
        assert!(needs_update(&broken, &latest, "v0.14.0", &trusted, 10));
    }

    #[test]
    fn automatic_policy_respects_ownership_switches_and_the_interval() {
        let dir = temp_dir("policy");
        let managed = dir.join("rustxng");
        let other = dir.join("elsewhere-rustxng");
        std::fs::write(&managed, ELF).unwrap();
        std::fs::write(&other, ELF).unwrap();
        let due = UpdateState::default();
        let now = 1_000_000;
        let reason = |pairs: &[(&str, &str)],
                      resolved: Option<&Path>,
                      state: &UpdateState,
                      managed: &Path| {
            auto_skip_reason(&lookup_of(pairs), managed, resolved, state, now)
        };
        assert_eq!(reason(&[], Some(&managed), &due, &managed), None);
        assert_eq!(
            reason(
                &[("RUSTXNG_SKIP_UPDATE", "1")],
                Some(&managed),
                &due,
                &managed
            ),
            Some(Skip::Disabled)
        );
        assert_eq!(
            reason(
                &[("RUSTXNG_SKIP_INSTALL", "1")],
                Some(&managed),
                &due,
                &managed
            ),
            Some(Skip::Disabled)
        );
        assert_eq!(
            reason(
                &[("RUSTXNG_SKIP_UPDATE", "0")],
                Some(&managed),
                &due,
                &managed
            ),
            None
        );
        assert_eq!(
            reason(
                &[("RUSTXNG_BIN", "/x/rustxng")],
                Some(&managed),
                &due,
                &managed
            ),
            Some(Skip::UserManaged)
        );
        assert_eq!(
            reason(
                &[("RUSTXNG_URL", "http://h:1")],
                Some(&managed),
                &due,
                &managed
            ),
            Some(Skip::UserManaged)
        );
        assert_eq!(
            reason(&[], Some(&other), &due, &managed),
            Some(Skip::NotResolved)
        );
        assert_eq!(reason(&[], None, &due, &managed), Some(Skip::NotResolved));
        assert_eq!(
            reason(&[], Some(&managed), &due, &dir.join("missing")),
            Some(Skip::NotInstalled)
        );
        let recent = UpdateState {
            last_check: now - 60,
            ..Default::default()
        };
        assert_eq!(
            reason(&[], Some(&managed), &recent, &managed),
            Some(Skip::NotDue)
        );
        assert_eq!(
            reason(
                &[("RUSTXNG_UPDATE_INTERVAL_HOURS", "0")],
                Some(&managed),
                &recent,
                &managed
            ),
            None
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn interval_backoff_doubles_and_caps_at_a_day() {
        let day = 24 * 3600;
        assert_eq!(effective_interval(day, 0), day);
        assert_eq!(effective_interval(day, 1), 3600);
        assert_eq!(effective_interval(day, 2), 7200);
        assert_eq!(effective_interval(day, 3), 4 * 3600);
        assert_eq!(effective_interval(day, 6), day);
        assert_eq!(effective_interval(day, 60), day);
        // Never lazier than the configured interval, and 0 means always.
        assert_eq!(effective_interval(2 * 3600, 5), 2 * 3600);
        assert_eq!(effective_interval(0, 5), 0);

        let lookup = lookup_of(&[("RUSTXNG_UPDATE_INTERVAL_HOURS", "6")]);
        assert_eq!(base_interval_secs(&lookup), 6 * 3600);
        assert_eq!(base_interval_secs(&lookup_of(&[])), day);
        assert_eq!(
            base_interval_secs(&lookup_of(&[("RUSTXNG_UPDATE_INTERVAL_HOURS", "soon")])),
            day
        );

        let mut state = UpdateState::default();
        let t = 1_700_000_000;
        assert!(is_due(t, &state, day));
        record_failure(&mut state, t);
        assert!(!is_due(t + 1800, &state, day));
        assert!(is_due(t + 3600, &state, day));
        record_failure(&mut state, t + 10_000);
        assert!(!is_due(t + 10_000 + 3600, &state, day));
        assert!(is_due(t + 10_000 + 7200, &state, day));
        record_success(&mut state, "v0.14.0", t + 30_000);
        assert_eq!(state.failures, 0);
        assert!(!is_due(t + 30_000 + 3600, &state, day));
        assert!(is_due(t + 30_000 + day, &state, day));
        // A clock that went backwards does not stall the check.
        assert!(is_due(100, &state, day));
    }

    #[test]
    fn state_file_round_trips_and_tolerates_damage() {
        let dir = temp_dir("state");
        let path = dir.join("nested").join("rustxng-update.json");
        assert_eq!(load_state(&path), UpdateState::default());
        let state = UpdateState {
            last_check: 42,
            latest_tag: Some("v0.14.0".into()),
            failures: 2,
            installed_tag: Some("v0.14.0".into()),
            installed_len: 7,
            restart_pending: true,
        };
        save_state(&path, &state).unwrap();
        assert_eq!(load_state(&path), state);
        std::fs::write(&path, "{not json").unwrap();
        assert_eq!(load_state(&path), UpdateState::default());
        std::fs::write(&path, r#"{"last_check": 5, "future_key": true}"#).unwrap();
        assert_eq!(load_state(&path).last_check, 5);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn url_allowlist_keeps_downloads_on_github_over_https() {
        let ok = [
            "https://api.github.com/repos/sahenjp/RustXNG/releases/latest",
            "https://github.com/sahenjp/RustXNG/releases/download/v1.0.0/x",
            "https://objects.githubusercontent.com/abc",
            "https://release-assets.githubusercontent.com/a/b",
        ];
        for url in ok {
            assert!(allowed_url(url), "{url}");
        }
        for url in [
            "http://github.com/a",
            "https://evil.example/a",
            "https://github.com.evil.example/a",
            "https://evilgithubusercontent.com/a",
            "https://user@github.com/a",
            "https://github.com:8443/a",
            "https://github.com?x=1",
            "ftp://github.com/a",
            "",
        ] {
            assert!(!allowed_url(url), "{url}");
        }
        assert!(allowed_asset_url(
            "https://github.com/sahenjp/RustXNG/releases/download/v1.0.0/rustxng-v1.0.0-x"
        ));
        assert!(!allowed_asset_url(
            "https://github.com/other/repo/releases/download/v1/x"
        ));
        assert!(!allowed_asset_url(
            "https://objects.githubusercontent.com/x"
        ));
        assert!(!allowed_asset_url(
            "https://github.com/sahenjp/RustXNG/releases/download/../../x"
        ));
    }

    #[test]
    fn digest_check_needs_every_available_source_to_agree() {
        let bytes = b"payload";
        let good = sha256_hex(bytes);
        let bad = "0".repeat(64);
        assert!(verify_digests(bytes, Some(&good), Some(&good)).is_ok());
        assert!(verify_digests(bytes, Some(&good), None).is_ok());
        assert!(verify_digests(bytes, None, Some(&good.to_uppercase())).is_ok());
        assert!(verify_digests(bytes, Some(&good), Some(&bad)).is_err());
        assert!(verify_digests(bytes, Some(&bad), Some(&good)).is_err());
        assert!(verify_digests(bytes, Some(&bad), None).is_err());
        assert!(verify_digests(bytes, None, Some(&bad)).is_err());
        assert!(verify_digests(bytes, None, None).is_err());
        assert_eq!(
            parse_sha256_file(&format!("{good}  rustxng-v1-x\n")),
            Some(good.clone())
        );
        assert_eq!(parse_sha256_file("<html>"), None);
        assert_eq!(normalize_hex("sha"), None);
    }

    #[test]
    fn release_json_yields_tag_assets_and_digests() {
        let json = r#"{"tag_name":"v0.14.0","prerelease":false,"assets":[
            {"name":"a","browser_download_url":"https://github.com/x","digest":"sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"},
            {"name":"b","browser_download_url":"https://github.com/y","digest":"md5:zz"}]}"#;
        let release = parse_release(json).unwrap();
        assert_eq!(release.tag, "v0.14.0");
        assert_eq!(release.version, v("0.14.0"));
        assert_eq!(release.assets.len(), 2);
        assert_eq!(release.digests.get("a").unwrap(), &"a".repeat(64));
        assert!(!release.digests.contains_key("b"));
        assert!(parse_release(r#"{"tag_name":"v1.0.0-rc.1","assets":[]}"#).is_err());
        assert!(parse_release(r#"{"tag_name":"v1.0.0","prerelease":true,"assets":[]}"#).is_err());
        assert!(parse_release(r#"{"assets":[]}"#).is_err());
        assert!(parse_release("not json").is_err());
    }

    #[test]
    fn install_replaces_atomically_and_keeps_one_previous_version() {
        let dir = temp_dir("install");
        let dest = dir.join(exe_name("rustxng"));
        std::fs::write(&dest, b"OLD").unwrap();
        install_verified(&dest, ELF, &ok_probe).unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), ELF);
        assert_eq!(std::fs::read(prev_path(&dest)).unwrap(), b"OLD");
        assert!(!sibling(&dest, "update").exists());
        assert!(!sibling(&dest, "prev-new").exists());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&dest).unwrap().permissions().mode() & 0o111,
                0o111
            );
        }
        // A second update replaces the single kept generation.
        install_verified(&dest, b"\x7fELF second", &ok_probe).unwrap();
        assert_eq!(std::fs::read(prev_path(&dest)).unwrap(), ELF);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn install_without_an_existing_binary_creates_it() {
        let dir = temp_dir("fresh");
        let dest = dir.join("sub").join(exe_name("rustxng"));
        install_verified(&dest, ELF, &ok_probe).unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), ELF);
        assert!(!prev_path(&dest).exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn install_keeps_the_current_binary_when_the_new_one_does_not_start() {
        let dir = temp_dir("badnew");
        let dest = dir.join(exe_name("rustxng"));
        std::fs::write(&dest, b"OLD").unwrap();
        let never = |_: &Path| Probe {
            runs: false,
            version: None,
        };
        assert!(install_verified(&dest, ELF, &never).is_err());
        assert_eq!(std::fs::read(&dest).unwrap(), b"OLD");
        assert!(!sibling(&dest, "update").exists());
        assert!(!prev_path(&dest).exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn install_rolls_back_when_the_replaced_binary_fails_its_check() {
        let dir = temp_dir("rollback");
        let dest = dir.join(exe_name("rustxng"));
        std::fs::write(&dest, b"OLD").unwrap();
        let calls = Cell::new(0);
        // First call (the temp file) passes; the second (after the rename) fails.
        let flaky = |_: &Path| {
            calls.set(calls.get() + 1);
            Probe {
                runs: calls.get() == 1,
                version: None,
            }
        };
        let error = install_verified(&dest, ELF, &flaky).unwrap_err();
        assert!(error.to_string().contains("rolled back"));
        assert_eq!(calls.get(), 2);
        assert_eq!(std::fs::read(&dest).unwrap(), b"OLD");
        // First-ever install that fails leaves nothing behind.
        let fresh = dir.join("fresh").join(exe_name("rustxng"));
        calls.set(0);
        assert!(install_verified(&fresh, ELF, &flaky).is_err());
        assert!(!fresh.exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// Table-backed fetcher: URL -> bytes, counting what was asked for.
    struct FakeFetch {
        table: HashMap<String, Vec<u8>>,
        calls: std::cell::RefCell<Vec<String>>,
    }

    impl Fetch for FakeFetch {
        fn get(&self, url: &str, _limit: usize, _timeout: Duration) -> Result<Vec<u8>> {
            self.calls.borrow_mut().push(url.to_string());
            self.table
                .get(url)
                .cloned()
                .ok_or_else(|| anyhow::anyhow!("offline: {url}"))
        }
    }

    /// A release for this host with the binary `bytes`; `api_digest` and
    /// `sidecar` choose what evidence is published.
    fn fake_release(
        tag: &str,
        bytes: &[u8],
        api_digest: Option<&str>,
        sidecar: Option<&str>,
    ) -> FakeFetch {
        let triple = target_triple();
        let suffix = if cfg!(windows) { ".exe" } else { "" };
        let name = format!("rustxng-{tag}-{triple}{suffix}");
        let base = format!("https://github.com/{INSTALL_REPO}/releases/download/{tag}");
        let mut assets = vec![serde_json::json!({
            "name": name,
            "browser_download_url": format!("{base}/{name}"),
            "digest": api_digest.map(|d| format!("sha256:{d}")),
        })];
        let mut table = HashMap::new();
        table.insert(format!("{base}/{name}"), bytes.to_vec());
        if let Some(sidecar) = sidecar {
            assets.push(serde_json::json!({
                "name": format!("{name}.sha256"),
                "browser_download_url": format!("{base}/{name}.sha256"),
            }));
            table.insert(
                format!("{base}/{name}.sha256"),
                format!("{sidecar}  {name}\n").into_bytes(),
            );
        }
        let release = serde_json::json!({"tag_name": tag, "prerelease": false, "assets": assets});
        table.insert(latest_api_url(), release.to_string().into_bytes());
        FakeFetch {
            table,
            calls: Default::default(),
        }
    }

    fn sha(bytes: &[u8]) -> String {
        sha256_hex(bytes)
    }

    fn probe_reading(version: &'static str) -> impl Fn(&Path) -> Probe {
        move |_| Probe {
            runs: true,
            version: parse_version(version),
        }
    }

    #[test]
    fn update_downloads_verifies_installs_and_flags_a_restart() {
        let dir = temp_dir("run-ok");
        let dest = dir.join(exe_name("rustxng"));
        std::fs::write(&dest, b"OLD").unwrap();
        let digest = sha(ELF);
        let fetch = fake_release("v0.14.0", ELF, Some(&digest), Some(&digest));
        let mut state = UpdateState {
            failures: 3,
            ..Default::default()
        };
        let report = run_update(
            &fetch,
            &dest,
            false,
            &probe_reading("0.4.1"),
            &mut state,
            500,
        )
        .unwrap();
        assert_eq!(report.action, Action::Updated);
        assert_eq!(std::fs::read(&dest).unwrap(), ELF);
        assert_eq!(std::fs::read(prev_path(&dest)).unwrap(), b"OLD");
        assert_eq!(state.latest_tag.as_deref(), Some("v0.14.0"));
        assert_eq!(state.installed_tag.as_deref(), Some("v0.14.0"));
        assert_eq!(state.installed_len, ELF.len() as u64);
        assert_eq!(
            (state.failures, state.last_check, state.restart_pending),
            (0, 500, true)
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn check_only_never_downloads_or_writes() {
        let dir = temp_dir("run-check");
        let dest = dir.join(exe_name("rustxng"));
        std::fs::write(&dest, b"OLD").unwrap();
        let digest = sha(ELF);
        let fetch = fake_release("v0.14.0", ELF, Some(&digest), None);
        let mut state = UpdateState::default();
        let report =
            run_update(&fetch, &dest, true, &probe_reading("0.4.1"), &mut state, 9).unwrap();
        assert_eq!(report.action, Action::Available);
        assert_eq!(fetch.calls.borrow().as_slice(), [latest_api_url()]);
        assert_eq!(std::fs::read(&dest).unwrap(), b"OLD");
        assert!(!prev_path(&dest).exists());
        assert!(!state.restart_pending);

        let report =
            run_update(&fetch, &dest, true, &probe_reading("0.14.0"), &mut state, 9).unwrap();
        assert_eq!(report.action, Action::UpToDate);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn current_binary_is_not_downloaded_again() {
        let dir = temp_dir("run-current");
        let dest = dir.join(exe_name("rustxng"));
        std::fs::write(&dest, b"CURRENT").unwrap();
        let fetch = fake_release("v0.14.0", ELF, Some(&sha(ELF)), None);
        let mut state = UpdateState::default();
        let report = run_update(
            &fetch,
            &dest,
            false,
            &probe_reading("0.14.0"),
            &mut state,
            1,
        )
        .unwrap();
        assert_eq!(report.action, Action::UpToDate);
        assert_eq!(fetch.calls.borrow().len(), 1);
        assert_eq!(std::fs::read(&dest).unwrap(), b"CURRENT");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn digest_problems_refuse_the_update_and_back_off() {
        let dest_for = |label| {
            let dir = temp_dir(label);
            let dest = dir.join(exe_name("rustxng"));
            std::fs::write(&dest, b"OLD").unwrap();
            (dir, dest)
        };
        let good = sha(ELF);
        let bad = "f".repeat(64);
        let cases: [(&str, Option<&str>, Option<&str>); 4] = [
            ("disagree", Some(&good), Some(&bad)),
            ("api-only-wrong", Some(&bad), None),
            ("sidecar-only-wrong", None, Some(&bad)),
            ("none", None, None),
        ];
        for (label, api, sidecar) in cases {
            let (dir, dest) = dest_for(label);
            let fetch = fake_release("v0.14.0", ELF, api, sidecar);
            let mut state = UpdateState::default();
            assert!(
                run_update(&fetch, &dest, false, &probe_reading("0.4.1"), &mut state, 7).is_err(),
                "{label}"
            );
            assert_eq!(std::fs::read(&dest).unwrap(), b"OLD", "{label}");
            assert_eq!(state.failures, 1, "{label}");
            assert!(!state.restart_pending, "{label}");
            std::fs::remove_dir_all(&dir).unwrap();
        }
        // One good source is enough when the other is simply absent.
        let (dir, dest) = dest_for("api-only-right");
        let fetch = fake_release("v0.14.0", ELF, Some(&good), None);
        let mut state = UpdateState::default();
        run_update(&fetch, &dest, false, &probe_reading("0.4.1"), &mut state, 7).unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), ELF);
        std::fs::remove_dir_all(&dir).unwrap();
        let (dir, dest) = dest_for("sidecar-only-right");
        let fetch = fake_release("v0.14.0", ELF, None, Some(&good));
        let mut state = UpdateState::default();
        run_update(&fetch, &dest, false, &probe_reading("0.4.1"), &mut state, 7).unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), ELF);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn non_executable_and_offline_downloads_leave_the_binary_alone() {
        let dir = temp_dir("run-bad");
        let dest = dir.join(exe_name("rustxng"));
        std::fs::write(&dest, b"OLD").unwrap();
        let html = b"<html>rate limited</html>";
        let fetch = fake_release("v0.14.0", html, Some(&sha(html)), None);
        let mut state = UpdateState::default();
        assert!(run_update(&fetch, &dest, false, &probe_reading("0.4.1"), &mut state, 3).is_err());
        assert_eq!(std::fs::read(&dest).unwrap(), b"OLD");

        // The release lookup itself fails: counted as a failure, nothing else.
        let offline = FakeFetch {
            table: HashMap::new(),
            calls: Default::default(),
        };
        let mut state = UpdateState::default();
        assert!(run_update(
            &offline,
            &dest,
            false,
            &probe_reading("0.4.1"),
            &mut state,
            3
        )
        .is_err());
        assert_eq!(
            (state.failures, state.last_check, state.latest_tag.clone()),
            (1, 3, None)
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn assets_from_a_foreign_repository_or_tag_are_refused() {
        let dir = temp_dir("run-foreign");
        let dest = dir.join(exe_name("rustxng"));
        std::fs::write(&dest, b"OLD").unwrap();
        let triple = target_triple();
        let suffix = if cfg!(windows) { ".exe" } else { "" };
        let digest = sha(ELF);
        for (name, url) in [
            (
                format!("rustxng-v0.14.0-{triple}{suffix}"),
                "https://github.com/evil/RustXNG/releases/download/v0.14.0/x".to_string(),
            ),
            (
                format!("rustxng-v0.13.0-{triple}{suffix}"),
                format!("https://github.com/{INSTALL_REPO}/releases/download/v0.13.0/x"),
            ),
        ] {
            let release = serde_json::json!({"tag_name":"v0.14.0","assets":[
                {"name": name, "browser_download_url": url, "digest": format!("sha256:{digest}")}]});
            let mut table = HashMap::new();
            table.insert(latest_api_url(), release.to_string().into_bytes());
            table.insert(url.clone(), ELF.to_vec());
            let fetch = FakeFetch {
                table,
                calls: Default::default(),
            };
            let mut state = UpdateState::default();
            assert!(
                run_update(&fetch, &dest, false, &probe_reading("0.4.1"), &mut state, 1).is_err()
            );
            assert_eq!(fetch.calls.borrow().len(), 1, "no asset request for {url}");
            assert_eq!(std::fs::read(&dest).unwrap(), b"OLD");
        }
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_failed_start_check_after_replacing_rolls_back_through_run_update() {
        let dir = temp_dir("run-rollback");
        let dest = dir.join(exe_name("rustxng"));
        std::fs::write(&dest, b"OLD").unwrap();
        let digest = sha(ELF);
        let fetch = fake_release("v0.14.0", ELF, Some(&digest), None);
        let calls = Cell::new(0);
        // call 1 = the installed version, 2 = temp file, 3 = after the swap.
        let probe = |_: &Path| {
            calls.set(calls.get() + 1);
            match calls.get() {
                1 => Probe {
                    runs: true,
                    version: parse_version("0.4.1"),
                },
                2 => Probe {
                    runs: true,
                    version: None,
                },
                _ => Probe {
                    runs: false,
                    version: None,
                },
            }
        };
        let mut state = UpdateState::default();
        assert!(run_update(&fetch, &dest, false, &probe, &mut state, 4).is_err());
        assert_eq!(std::fs::read(&dest).unwrap(), b"OLD");
        assert!(!state.restart_pending);
        assert_eq!(state.failures, 1);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn update_lock_is_exclusive_and_released_on_drop() {
        let dir = temp_dir("lock");
        let path = dir.join("rustxng-update.lock");
        let first = UpdateLock::acquire(&path).unwrap();
        assert!(UpdateLock::acquire(&path).is_none());
        assert!(lock_is_fresh(&path));
        drop(first);
        assert!(!path.exists());
        assert!(UpdateLock::acquire(&path).is_some());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
