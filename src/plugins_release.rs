//! The bundled `rdsh-*` plugins, taken from the release instead of a checkout.
//!
//! A release install has only the binary, so without a checkout `rdsh plugins
//! install` could not attach rdsh-settings, rdsh-translation and the rest. The
//! release already ships them as `rdsh-plugins.tar.gz` (a tree rooted at
//! `plugins/`); this module fetches that archive, verifies it, unpacks it under
//! `$DSH_HOME/rdsh-plugins/` and keeps it current. It reuses the transport, the
//! digest rule, the interval/backoff, the lock and the detached worker of
//! `rustxng_update.rs`.
//!
//! Layout (everything below is rdsh's own; nothing outside it is ever touched):
//!   current/plugins/<package>/  the tree profiles link to (a stable path)
//!   current/.rdsh-release       the tag of that tree
//!   previous/<tag>/             the last two replaced trees
//!   update.json, update.lock    check state (same shape as the rustxng one)
//!
//! Why a stable path: `dsh plugin add <dir>` records `link:<dir>` in the profile
//! and pnpm symlinks it, so replacing the *contents* of `current/` updates every
//! profile that links there. No manifest is rewritten and no plugin is added.
//!
//! Trust: the archive digest must match every source that is available — the
//! pinned ledger `release-plugins-digests.tsv` (the one install.sh trusts,
//! fetched from the canonical repository), the API `digest` and the `.sha256`
//! asset — and at least one must exist. The ledger lags releases (it is pinned
//! by a follow-up PR), so it is an extra source, not a requirement; when it does
//! pin the tag it can only make verification stricter.
//!
//! Which version: the tag of the running rdsh (plugins and binary agree). The
//! automatic update and `--latest` follow the latest release instead, never
//! downgrade, and never run when the user manages a checkout.
//!
//! Environment:
//!   RDSH_PLUGINS_SKIP_UPDATE=1             stop the automatic update only
//!   RDSH_PLUGINS_UPDATE_INTERVAL_HOURS=N   hours between checks (default 24, 0 = always)
//!   RDSH_PLUGINS_DIR / --plugins-dir       a checkout the user manages: nothing is fetched

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use anyhow::{bail, ensure, Context, Result};
use serde_json::{json, Value};

use crate::desktop::{self, OsEnv};
use crate::locale::Locale;
use crate::plugins_tar::{self, Limits};
use crate::rustxng::update as upd;
use upd::{Fetch, UpdateState};

/// The repository that publishes rdsh and its plugins archive.
pub(crate) const REPO: &str = "jimoto-no-llm/rustdsh";
pub(crate) const ASSET: &str = "rdsh-plugins.tar.gz";
const LEDGER_URL: &str =
    "https://raw.githubusercontent.com/jimoto-no-llm/rustdsh/main/release-plugins-digests.tsv";
/// Same ceiling as scripts/verify-release-assets.py.
const MAX_ARCHIVE_BYTES: usize = 64 * 1024 * 1024;
const MAX_TEXT_BYTES: usize = 1024 * 1024;
const API_TIMEOUT: Duration = Duration::from_secs(20);
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(300);
/// Replaced trees kept next to `current`.
const KEEP_PREVIOUS: usize = 2;
const STALE_STAGE: Duration = Duration::from_secs(3600);
const MARKER: &str = ".rdsh-release";

// ------------------------------------------------------------------- paths

pub(crate) fn root(env: &OsEnv) -> PathBuf {
    env.dsh_home.join("rdsh-plugins")
}

fn state_path(root: &Path) -> PathBuf {
    root.join("update.json")
}

fn lock_path(root: &Path) -> PathBuf {
    root.join("update.lock")
}

/// `vMAJOR.MINOR.PATCH` and nothing else: the tag becomes a directory name.
pub(crate) fn valid_tag(tag: &str) -> bool {
    tag.starts_with('v')
        && tag[1..].split('.').count() == 3
        && tag[1..]
            .split('.')
            .all(|part| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit()))
}

pub(crate) fn binary_tag() -> String {
    format!("v{}", env!("CARGO_PKG_VERSION"))
}

/// The tag recorded in `current/`, when that tree is a usable plugins tree.
pub(crate) fn current_tag(root: &Path) -> Option<String> {
    let current = root.join("current");
    let tag = std::fs::read_to_string(current.join(MARKER)).ok()?;
    let tag = tag.trim().to_string();
    (valid_tag(&tag) && desktop::is_plugins_dir(&current.join("plugins"))).then_some(tag)
}

/// The plugins directory of the release copy, when there is one.
pub(crate) fn managed_plugins_dir(env: &OsEnv) -> Option<PathBuf> {
    let root = root(env);
    current_tag(&root)?;
    Some(root.join("current").join("plugins"))
}

fn same_or_newer(a: &str, b: &str) -> bool {
    match (upd::parse_version(a), upd::parse_version(b)) {
        (Some(a), Some(b)) => a >= b,
        _ => false,
    }
}

// ------------------------------------------------------------ release data

fn tag_api_url(tag: &str) -> String {
    format!("https://api.github.com/repos/{REPO}/releases/tags/{tag}")
}

fn latest_api_url() -> String {
    format!("https://api.github.com/repos/{REPO}/releases/latest")
}

fn has_archive(release: &upd::Release) -> bool {
    release.assets.iter().any(|asset| asset.name == ASSET)
}

fn fetch_latest(fetch: &dyn Fetch) -> Result<upd::Release> {
    let release = upd::fetch_release_from(fetch, &latest_api_url())?;
    ensure!(has_archive(&release), "{} has no {ASSET}", release.tag);
    Ok(release)
}

fn fetch_tag(fetch: &dyn Fetch, tag: &str) -> Result<upd::Release> {
    let release = upd::fetch_release_from(fetch, &tag_api_url(tag))?;
    ensure!(release.tag == tag, "asked for {tag}, got {}", release.tag);
    ensure!(has_archive(&release), "{tag} has no {ASSET}");
    Ok(release)
}

/// The digest a ledger pins for `tag`: `<tag> rdsh-plugins.tar.gz <sha256>`.
pub(crate) fn ledger_digest(text: &str, tag: &str) -> Option<String> {
    text.lines()
        .map(str::trim)
        .filter(|line| !line.starts_with('#'))
        .find_map(|line| {
            let mut fields = line.split_whitespace();
            let (row_tag, asset, digest) = (fields.next()?, fields.next()?, fields.next()?);
            (fields.next().is_none() && row_tag == tag && asset == ASSET)
                .then(|| upd::normalize_hex(digest))
                .flatten()
        })
}

/// Download the archive and prove it is the published one.
pub(crate) fn download_verified(fetch: &dyn Fetch, release: &upd::Release) -> Result<Vec<u8>> {
    ensure!(
        valid_tag(&release.tag),
        "unexpected release tag {}",
        release.tag
    );
    let asset = release
        .assets
        .iter()
        .find(|asset| asset.name == ASSET)
        .ok_or_else(|| anyhow::anyhow!("{} has no {ASSET}", release.tag))?;
    ensure!(
        upd::allowed_asset_url_for(REPO, &asset.url)
            && asset
                .url
                .contains(&format!("/releases/download/{}/", release.tag)),
        "asset URL is not a {REPO} release download: {}",
        asset.url
    );
    let bytes = fetch.get(&asset.url, MAX_ARCHIVE_BYTES, DOWNLOAD_TIMEOUT)?;
    // Both extra sources are best effort: a missing one leaves the others to
    // decide, and verify_sources refuses when none is left.
    let sidecar_name = format!("{ASSET}.sha256");
    let sidecar = release
        .assets
        .iter()
        .find(|a| a.name == sidecar_name && upd::allowed_asset_url_for(REPO, &a.url))
        .and_then(|a| fetch.get(&a.url, MAX_TEXT_BYTES, API_TIMEOUT).ok())
        .and_then(|body| upd::parse_sha256_file(&String::from_utf8_lossy(&body)));
    let ledger = fetch
        .get(LEDGER_URL, MAX_TEXT_BYTES, API_TIMEOUT)
        .ok()
        .and_then(|body| ledger_digest(&String::from_utf8_lossy(&body), &release.tag));
    upd::verify_sources(
        &bytes,
        &[
            ledger.as_deref(),
            release.digests.get(ASSET).map(String::as_str),
            sidecar.as_deref(),
        ],
    )?;
    Ok(bytes)
}

// ----------------------------------------------------------- unpack + swap

fn unique_suffix() -> String {
    let nanos = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{}-{nanos}", std::process::id())
}

/// Unpack `bytes` beside `current/` and swap it in. A failure at any step
/// leaves `current/` as it was and removes the staging directory.
pub(crate) fn install_archive(root: &Path, tag: &str, bytes: &[u8]) -> Result<()> {
    ensure!(valid_tag(tag), "unexpected release tag {tag}");
    std::fs::create_dir_all(root)?;
    remove_stale_stages(root);
    let stage = root.join(format!(".stage-{}", unique_suffix()));
    std::fs::create_dir(&stage)?;
    let staged = (|| -> Result<()> {
        plugins_tar::unpack_gz(bytes, &stage, Limits::RELEASE)?;
        let plugins = stage.join("plugins");
        ensure!(
            desktop::is_plugins_dir(&plugins),
            "the archive holds no rdsh-settings plugin"
        );
        ensure!(
            plugins.join("install.sh").is_file(),
            "the archive has no plugins/install.sh"
        );
        std::fs::write(stage.join(MARKER), format!("{tag}\n"))?;
        swap_in(root, &stage, tag)
    })();
    if staged.is_err() {
        let _ = std::fs::remove_dir_all(&stage);
    }
    staged?;
    prune_previous(root, KEEP_PREVIOUS);
    Ok(())
}

/// `current` becomes `previous/<old tag>`, then the stage becomes `current`;
/// the first move is undone if the second fails.
fn swap_in(root: &Path, stage: &Path, tag: &str) -> Result<()> {
    let current = root.join("current");
    let mut parked: Option<PathBuf> = None;
    if current.exists() {
        match current_tag(root) {
            Some(old) if old == tag => std::fs::remove_dir_all(&current)?,
            old => {
                let previous = root.join("previous");
                std::fs::create_dir_all(&previous)?;
                let name = old.unwrap_or_else(|| format!("unknown-{}", unique_suffix()));
                let dest = previous.join(name);
                if dest.exists() {
                    std::fs::remove_dir_all(&dest)?;
                }
                std::fs::rename(&current, &dest)
                    .with_context(|| format!("could not move {} aside", current.display()))?;
                parked = Some(dest);
            }
        }
    }
    if let Err(error) = std::fs::rename(stage, &current) {
        if let Some(dest) = parked {
            let _ = std::fs::rename(dest, &current);
        }
        return Err(error).context("could not put the new plugins tree in place");
    }
    Ok(())
}

/// Keep the `keep` newest trees under `previous/`; only names this module
/// creates (`vX.Y.Z`, `unknown-*`) are ever deleted.
pub(crate) fn prune_previous(root: &Path, keep: usize) {
    let previous = root.join("previous");
    let Ok(entries) = std::fs::read_dir(&previous) else {
        return;
    };
    let mut trees: Vec<(Option<upd::Version>, PathBuf)> = entries
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            let path = entry.path();
            if !path.is_dir() {
                return None;
            }
            if valid_tag(&name) {
                Some((upd::parse_version(&name), path))
            } else if name.starts_with("unknown-") {
                Some((None, path))
            } else {
                None
            }
        })
        .collect();
    // Newest first; trees of unknown version sort last.
    trees.sort_by(|a, b| b.0.cmp(&a.0));
    for (_, path) in trees.into_iter().skip(keep) {
        let _ = std::fs::remove_dir_all(path);
    }
}

fn remove_stale_stages(root: &Path) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let stale = entry.file_name().to_string_lossy().starts_with(".stage-")
            && entry
                .metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|modified| SystemTime::now().duration_since(modified).ok())
                .is_some_and(|age| age > STALE_STAGE);
        if stale {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
}

// ------------------------------------------------------ profile references

/// Profiles whose manifest links packages into `current/`, with those packages.
pub(crate) fn linked_packages(env: &OsEnv) -> Vec<(String, Vec<String>)> {
    let prefix = format!(
        "{}/current/",
        root(env).display().to_string().replace('\\', "/")
    );
    let Ok(entries) = std::fs::read_dir(env.dsh_home.join("profiles")) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let Ok(text) = std::fs::read_to_string(entry.path().join("package.json")) else {
            continue;
        };
        let Ok(manifest) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        let packages: Vec<String> = manifest
            .get("dependencies")
            .and_then(Value::as_object)
            .map(|deps| {
                deps.iter()
                    .filter(|(_, spec)| {
                        spec.as_str()
                            .and_then(|s| s.strip_prefix("link:"))
                            .is_some_and(|path| path.replace('\\', "/").starts_with(&prefix))
                    })
                    .map(|(name, _)| name.clone())
                    .collect()
            })
            .unwrap_or_default();
        if !packages.is_empty() {
            out.push((entry.file_name().to_string_lossy().into_owned(), packages));
        }
    }
    out.sort();
    out
}

/// Linked packages the current tree no longer carries (a plugin the release
/// dropped): reported, never fixed silently.
fn dangling(env: &OsEnv) -> Vec<String> {
    let plugins = root(env).join("current").join("plugins");
    let mut missing: Vec<String> = linked_packages(env)
        .into_iter()
        .flat_map(|(_, packages)| packages)
        .filter(|package| !plugins.join(package).join("package.json").is_file())
        .collect();
    missing.sort();
    missing.dedup();
    missing
}

// ------------------------------------------------------------------ driver

/// Which release `provision` should use when nothing is installed yet.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Want {
    /// The tag of the running rdsh (falls back to the latest release when that
    /// tag publishes no archive, e.g. a source build ahead of releases).
    Binary,
    Latest,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Provisioned {
    pub tag: String,
    /// The tree was fetched or replaced by this call.
    pub changed: bool,
}

fn lock(root: &Path) -> Result<upd::UpdateLock> {
    upd::UpdateLock::acquire(&lock_path(root))
        .ok_or_else(|| anyhow::anyhow!("another plugins update is already running"))
}

/// Make sure a release copy exists (foreground; `rdsh plugins install`). An
/// existing copy is used as is unless `Want::Latest` finds a newer release.
pub(crate) fn provision(
    env: &OsEnv,
    fetch: &dyn Fetch,
    want: Want,
    now: u64,
) -> Result<Provisioned> {
    let root = root(env);
    std::fs::create_dir_all(&root)?;
    let _lock = lock(&root)?;
    let mut state = upd::load_state(&state_path(&root));
    let current = current_tag(&root);
    let release = match (&current, want) {
        (Some(tag), Want::Binary) => {
            return Ok(Provisioned {
                tag: tag.clone(),
                changed: false,
            })
        }
        (_, Want::Binary) => fetch_tag(fetch, &binary_tag()).or_else(|_| fetch_latest(fetch)),
        (_, Want::Latest) => fetch_latest(fetch),
    };
    let release = match release {
        Ok(release) => {
            upd::record_success(&mut state, &release.tag, now);
            release
        }
        Err(error) => {
            upd::record_failure(&mut state, now);
            let _ = upd::save_state(&state_path(&root), &state);
            return Err(error);
        }
    };
    if current
        .as_deref()
        .is_some_and(|tag| same_or_newer(tag, &release.tag))
    {
        let _ = upd::save_state(&state_path(&root), &state);
        return Ok(Provisioned {
            tag: current.unwrap_or_default(),
            changed: false,
        });
    }
    let installed = download_verified(fetch, &release)
        .and_then(|bytes| install_archive(&root, &release.tag, &bytes));
    match installed {
        Ok(()) => {
            state.installed_tag = Some(release.tag.clone());
            let _ = upd::save_state(&state_path(&root), &state);
            Ok(Provisioned {
                tag: release.tag,
                changed: true,
            })
        }
        Err(error) => {
            upd::record_failure(&mut state, now);
            let _ = upd::save_state(&state_path(&root), &state);
            Err(error)
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Action {
    /// There is no release copy to keep current (a checkout, or none yet).
    NotManaged,
    UpToDate,
    Available,
    Updated,
}

#[derive(Debug, Clone)]
pub(crate) struct Report {
    pub action: Action,
    pub installed: Option<String>,
    pub latest: Option<String>,
    /// Linked packages the new tree no longer carries.
    pub dangling: Vec<String>,
}

/// Compare the release copy with the latest release and, unless `check_only`,
/// replace it. Never downgrades; `state` is updated in place (the caller saves).
pub(crate) fn run_update(
    env: &OsEnv,
    fetch: &dyn Fetch,
    check_only: bool,
    state: &mut UpdateState,
    now: u64,
) -> Result<Report> {
    let root = root(env);
    let Some(installed) = current_tag(&root) else {
        return Ok(Report {
            action: Action::NotManaged,
            installed: None,
            latest: state.latest_tag.clone(),
            dangling: Vec::new(),
        });
    };
    let release = match fetch_latest(fetch) {
        Ok(release) => release,
        Err(error) => {
            upd::record_failure(state, now);
            return Err(error);
        }
    };
    upd::record_success(state, &release.tag, now);
    state.installed_tag = Some(installed.clone());
    let report = |action, dangling| Report {
        action,
        installed: Some(installed.clone()),
        latest: Some(release.tag.clone()),
        dangling,
    };
    if same_or_newer(&installed, &release.tag) {
        return Ok(report(Action::UpToDate, Vec::new()));
    }
    if check_only {
        return Ok(report(Action::Available, Vec::new()));
    }
    let done = download_verified(fetch, &release)
        .and_then(|bytes| install_archive(&root, &release.tag, &bytes));
    match done {
        Ok(()) => {
            state.installed_tag = Some(release.tag.clone());
            Ok(report(Action::Updated, dangling(env)))
        }
        Err(error) => {
            upd::record_failure(state, now);
            Err(error)
        }
    }
}

// ------------------------------------------------------------- auto update

/// Why an automatic check does not run right now.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Skip {
    /// RDSH_PLUGINS_SKIP_UPDATE=1.
    Disabled,
    /// RDSH_PLUGINS_DIR: the user manages a checkout.
    UserManaged,
    /// No profile links plugins from the release copy.
    NotManaged,
    NotDue,
}

pub(crate) fn auto_enabled(lookup: &dyn Fn(&str) -> Option<String>) -> bool {
    !upd::truthy_one(lookup, "RDSH_PLUGINS_SKIP_UPDATE")
}

fn user_managed(lookup: &dyn Fn(&str) -> Option<String>) -> bool {
    lookup("RDSH_PLUGINS_DIR").is_some()
}

/// Whether an automatic check should run now: None means "yes, check".
/// `linked` is "some profile uses the release copy".
pub(crate) fn auto_skip_reason(
    lookup: &dyn Fn(&str) -> Option<String>,
    linked: bool,
    state: &UpdateState,
    now: u64,
) -> Option<Skip> {
    if !auto_enabled(lookup) {
        return Some(Skip::Disabled);
    }
    if user_managed(lookup) {
        return Some(Skip::UserManaged);
    }
    if !linked {
        return Some(Skip::NotManaged);
    }
    let base = upd::interval_secs(lookup, "RDSH_PLUGINS_UPDATE_INTERVAL_HOURS");
    if !upd::is_due(now, state, base) {
        return Some(Skip::NotDue);
    }
    None
}

fn real_lookup(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

/// Called when a profile boots: start a background check when one is due.
/// Never waits, never prints, never fails the caller.
pub(crate) fn auto_tick() {
    // Unit tests never spawn processes or touch the real home.
    #[cfg(not(test))]
    {
        let env = OsEnv::from_process();
        let root = root(&env);
        let state = upd::load_state(&state_path(&root));
        let linked = !linked_packages(&env).is_empty();
        if auto_skip_reason(&real_lookup, linked, &state, upd::now_secs()).is_some()
            || upd::lock_is_fresh(&lock_path(&root))
        {
            return;
        }
        upd::spawn_detached(&["plugins", "update", "--background"]);
    }
}

/// The detached worker: re-check the policy, then update. Silent by design;
/// every failure only lands in the state file (and backs the next check off).
pub(crate) fn run_background() {
    let env = OsEnv::from_process();
    let root = root(&env);
    let mut state = upd::load_state(&state_path(&root));
    let now = upd::now_secs();
    let linked = !linked_packages(&env).is_empty();
    if auto_skip_reason(&real_lookup, linked, &state, now).is_some() {
        return;
    }
    let Ok(_lock) = lock(&root) else { return };
    let _ = run_update(&env, &upd::HttpsFetch, false, &mut state, now);
    let _ = upd::save_state(&state_path(&root), &state);
}

// ------------------------------------------------------------ status / CLI

/// What `rdsh plugins status` shows about the bundled plugins' origin.
#[derive(Debug, Clone)]
pub(crate) struct Info {
    /// `release`, `checkout` or `none`.
    pub source: &'static str,
    pub dir: Option<PathBuf>,
    pub tag: Option<String>,
    pub latest: Option<String>,
    pub last_check: Option<u64>,
    pub auto_update: bool,
    pub update_available: bool,
}

pub(crate) fn info(env: &OsEnv, resolved: Option<&Path>) -> Info {
    let root = root(env);
    let state = upd::load_state(&state_path(&root));
    let source = match resolved {
        Some(dir) if dir.starts_with(&root) => "release",
        Some(_) => "checkout",
        None => "none",
    };
    let tag = (source == "release").then(|| current_tag(&root)).flatten();
    let update_available = match (&tag, &state.latest_tag) {
        (Some(tag), Some(latest)) => !same_or_newer(tag, latest) && valid_tag(latest),
        _ => false,
    };
    Info {
        source,
        dir: resolved.map(Path::to_path_buf),
        tag,
        latest: state.latest_tag.clone(),
        last_check: (state.last_check > 0).then_some(state.last_check),
        auto_update: source == "release"
            && auto_enabled(&real_lookup)
            && !user_managed(&real_lookup)
            && env.plugins_dir.is_none(),
        update_available,
    }
}

/// Additive keys for `rdsh plugins status --json`.
pub(crate) fn info_json(info: &Info) -> Value {
    json!({
        "source": info.source,
        "dir": info.dir.as_ref().map(|dir| dir.display().to_string()),
        "tag": info.tag,
        "latest": info.latest,
        "last_check": info.last_check,
        "auto_update": info.auto_update,
        "update_available": info.update_available,
    })
}

fn t(locale: Locale, en: String, zh: String, ja: String) -> String {
    match locale {
        Locale::English => en,
        Locale::Chinese => zh,
        Locale::Japanese => ja,
    }
}

/// One status line about the origin, in the user's language.
pub(crate) fn info_line(info: &Info, locale: Locale) -> Option<String> {
    let auto = |on: bool| match (locale, on) {
        (Locale::English, true) => "auto-update on",
        (Locale::English, false) => "auto-update off",
        (Locale::Chinese, true) => "自动更新开启",
        (Locale::Chinese, false) => "自动更新关闭",
        (Locale::Japanese, true) => "自動更新オン",
        (Locale::Japanese, false) => "自動更新オフ",
    };
    match (info.source, &info.tag) {
        ("release", Some(tag)) => {
            let latest = info.latest.clone().unwrap_or_else(|| "?".into());
            Some(t(
                locale,
                format!(
                    "bundled plugins: release {tag} (latest {latest}; {})",
                    auto(info.auto_update)
                ),
                format!(
                    "内置插件：release {tag}（最新 {latest}；{}）",
                    auto(info.auto_update)
                ),
                format!(
                    "同梱プラグイン: release {tag}（最新 {latest}、{}）",
                    auto(info.auto_update)
                ),
            ))
        }
        ("checkout", _) => Some(t(
            locale,
            "bundled plugins: checkout (managed by you; never fetched)".into(),
            "内置插件：检出目录（由你管理，不会下载）".into(),
            "同梱プラグイン: チェックアウト（利用者の管理。取得しません）".into(),
        )),
        _ => Some(t(
            locale,
            "bundled plugins: none (rdsh plugins install fetches them from the release)".into(),
            "内置插件：无（rdsh plugins install 会从 release 获取）".into(),
            "同梱プラグイン: なし（rdsh plugins install で release から取得します）".into(),
        )),
    }
}

/// Doctor lines from recorded values only: no network.
pub(crate) fn doctor_lines(env: &OsEnv, locale: Locale) -> Vec<String> {
    let root = root(env);
    let Some(tag) = current_tag(&root) else {
        return Vec::new();
    };
    let state = upd::load_state(&state_path(&root));
    match state.latest_tag {
        Some(latest) if valid_tag(&latest) && !same_or_newer(&tag, &latest) => vec![t(
            locale,
            format!("[rdsh] plugins: bundled plugins {tag} are older than {latest}; run: rdsh plugins update"),
            format!("[rdsh] plugins: 内置插件 {tag} 低于 {latest}；请运行：rdsh plugins update"),
            format!("[rdsh] plugins: 同梱プラグイン {tag} は {latest} より古い版です。rdsh plugins update を実行してください"),
        )],
        _ => Vec::new(),
    }
}

/// `rdsh plugins update [--profile <name>] [--check] [--json]` (and the hidden
/// `--background`).
pub(crate) fn cmd_update(
    profile: &str,
    check: bool,
    json_out: bool,
    background: bool,
    locale: Locale,
) -> Result<()> {
    if background {
        run_background();
        return Ok(());
    }
    let env = OsEnv::from_process();
    if env.plugins_dir.is_some() {
        bail!(
            "{}",
            t(
                locale,
                "RDSH_PLUGINS_DIR is set: you manage that checkout, so nothing is fetched".into(),
                "已设置 RDSH_PLUGINS_DIR：该检出目录由你管理，不会下载".into(),
                "RDSH_PLUGINS_DIR が設定されています。そのチェックアウトは利用者の管理なので取得しません".into(),
            )
        );
    }
    let root = root(&env);
    let _lock = if check {
        None
    } else {
        std::fs::create_dir_all(&root)?;
        Some(lock(&root)?)
    };
    let path = state_path(&root);
    let mut state = upd::load_state(&path);
    let result = run_update(&env, &upd::HttpsFetch, check, &mut state, upd::now_secs());
    if root.exists() {
        let _ = upd::save_state(&path, &state);
    }
    let report = result?;
    let linked: Vec<String> = linked_packages(&env)
        .into_iter()
        .filter(|(name, _)| name == profile)
        .flat_map(|(_, packages)| packages)
        .collect();
    let status = match report.action {
        Action::NotManaged => "not-managed",
        Action::UpToDate => "up-to-date",
        Action::Available => "update-available",
        Action::Updated => "updated",
    };
    let installed = report.installed.clone().unwrap_or_else(|| "-".into());
    let latest = report.latest.clone().unwrap_or_else(|| "-".into());
    if json_out {
        let value = json!({
            "status": status,
            "installed": report.installed,
            "latest": report.latest,
            "path": root.join("current").join("plugins").display().to_string(),
            "profile": profile,
            "linked": linked,
            "dangling": report.dangling,
        });
        println!("{}", serde_json::to_string_pretty(&value)?);
        return Ok(());
    }
    let line = match report.action {
        Action::NotManaged => t(
            locale,
            "no release copy of the bundled plugins is installed; fetch it with: rdsh plugins install".into(),
            "尚未安装 release 版内置插件；请运行：rdsh plugins install".into(),
            "release 版の同梱プラグインは未導入です。rdsh plugins install で取得してください".into(),
        ),
        Action::UpToDate => t(
            locale,
            format!("bundled plugins are up to date ({installed}, latest {latest})"),
            format!("内置插件已是最新（{installed}，最新 {latest}）"),
            format!("同梱プラグインは最新です（{installed}、最新 {latest}）"),
        ),
        Action::Available => t(
            locale,
            format!("update available: {installed} -> {latest}; run: rdsh plugins update"),
            format!("有可用更新：{installed} -> {latest}；请运行：rdsh plugins update"),
            format!("更新があります: {installed} -> {latest}。rdsh plugins update を実行してください"),
        ),
        Action::Updated => t(
            locale,
            format!("bundled plugins updated: {installed} -> {latest}; restart DSH sessions to load them"),
            format!("内置插件已更新：{installed} -> {latest}；请重启 DSH 会话以加载"),
            format!("同梱プラグインを更新しました: {installed} -> {latest}。DSH セッションを再起動すると反映されます"),
        ),
    };
    println!("[rdsh] plugins: {line}");
    for package in &report.dangling {
        println!(
            "[rdsh] plugins: {}",
            t(
                locale,
                format!("{package} is linked but the new release no longer ships it"),
                format!("{package} 仍被链接，但新版本已不再提供"),
                format!("{package} は参照されていますが、新しい release には含まれていません"),
            )
        );
    }
    Ok(())
}

#[cfg(test)]
#[path = "plugins_release_tests.rs"]
mod tests;
