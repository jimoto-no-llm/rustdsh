//! Plugin provisioning for a DSH profile.
//!
//! plugins/install.sh is the only place that knew the essential plugin tier,
//! and nothing calls it by itself: upgrading the binary leaves
//! $DSH_HOME/profiles/<profile>/package.json untouched, so a profile keeps
//! whatever was attached by hand (an upgraded install silently misses every
//! essential package). A release archive carries the binary alone, so the
//! script is not even present there.
//!
//! This module compiles the same catalog in (src/plugin_catalog.json), which
//! lets the shipped binary report the gap (rdsh plugins status) and close it
//! in one command (rdsh plugins install). plugins/install.sh keeps its own
//! lists for the checkout path; tests/plugin-catalog.test.mjs fails when the
//! two disagree.

use std::path::PathBuf;
use std::process::Command;

use anyhow::{bail, Context, Result};
use serde_json::{json, Value};

use crate::desktop::{self, OsEnv, ProfileState};
use crate::locale::Locale;
use crate::rdsh_config::RdshSettings;

/// The catalog is embedded so a release install needs no checkout to read it.
const CATALOG: &str = include_str!("plugin_catalog.json");
/// A bundled entry is attachable only when its package directory exists.
const BUNDLED_MANIFEST: &str = "package.json";

macro_rules! out {
    ($($arg:tt)*) => {{
        use std::io::Write;
        let _ = writeln!(std::io::stdout(), $($arg)*);
    }};
}

macro_rules! err {
    ($($arg:tt)*) => {{
        use std::io::Write;
        let _ = writeln!(std::io::stderr(), $($arg)*);
    }};
}

fn text(
    locale: Locale,
    english: &'static str,
    chinese: &'static str,
    japanese: &'static str,
) -> &'static str {
    match locale {
        Locale::English => english,
        Locale::Chinese => chinese,
        Locale::Japanese => japanese,
    }
}

/// One package the catalog knows about.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    /// Catalog id (translation), or the package name for an essential entry.
    pub id: String,
    /// npm name, github:owner/repo spec, or the bundled directory name.
    pub package: String,
    /// The spec is a directory next to plugins/install.sh, not a registry name.
    pub bundled: bool,
    /// Profiles the entry applies to; None means every profile.
    pub profiles: Option<Vec<String>>,
    /// Feature switch whose *off* state selects this entry: it is provisioned
    /// only while `features.<id>` is false. None means unconditional.
    /// `rdsh-no-feedback` is the one case today.
    pub feature: Option<String>,
    /// Member of the beginner starter set.
    pub starter: bool,
    /// Essential tier: installed on every provisioning run.
    pub essential: bool,
    pub why: String,
}

impl Entry {
    /// The dependency key dsh plugin add records for this package.
    pub fn key(&self) -> String {
        if self.package.starts_with("github:") {
            if let Some((_, repo)) = self.package.rsplit_once('/') {
                return repo.to_string();
            }
        }
        self.package.clone()
    }

    /// A Web-only essential (rdsh-update-banner) is not expected elsewhere.
    pub fn applies_to(&self, profile: &str) -> bool {
        match &self.profiles {
            Some(list) => list.iter().any(|name| name == profile),
            None => true,
        }
    }

    pub fn tier(&self) -> &'static str {
        if self.essential {
            "essential"
        } else {
            "recommended"
        }
    }
}

/// The embedded catalog: the essential tier plus the opt-in recommended set.
#[derive(Debug, Clone)]
pub struct Catalog {
    pub essential: Vec<Entry>,
    pub recommended: Vec<Entry>,
    pub starter_profiles: Vec<String>,
}

impl Catalog {
    pub fn load() -> Result<Self> {
        let value: Value =
            serde_json::from_str(CATALOG).context("embedded plugin catalog is not valid JSON")?;
        let schema = value.get("schema").and_then(Value::as_u64).unwrap_or(0);
        if schema != 1 {
            bail!("unsupported plugin catalog schema: {schema}");
        }
        let essential = entries(value.get("essential"), true)?;
        let recommended = entries(value.get("recommended"), false)?;
        if essential.is_empty() || recommended.is_empty() {
            bail!("embedded plugin catalog has an empty tier");
        }
        let starter_profiles = string_list(value.get("starter_profiles"));
        Ok(Self {
            essential,
            recommended,
            starter_profiles,
        })
    }

    pub fn essential_for(&self, profile: &str) -> Vec<Entry> {
        self.essential
            .iter()
            .filter(|entry| entry.applies_to(profile))
            .cloned()
            .collect()
    }

    /// The essential tier for one profile with the feature-gated entries
    /// resolved: a row whose `feature` switch is off is provisioned, and one
    /// whose switch is on (the default) is left to the stock DSH bundle.
    /// Callers that only describe the tier keep using `essential_for`.
    pub fn essential_for_settings(&self, profile: &str, cfg: &RdshSettings) -> Vec<Entry> {
        self.essential_for(profile)
            .into_iter()
            .filter(|entry| match &entry.feature {
                Some(id) => !crate::rdsh_config::feature_enabled(cfg, id),
                None => true,
            })
            .collect()
    }

    pub fn has_starter(&self, profile: &str) -> bool {
        self.starter_profiles.iter().any(|name| name == profile)
    }

    pub fn recommended_ids(&self) -> Vec<String> {
        self.recommended
            .iter()
            .map(|entry| entry.id.clone())
            .collect()
    }

    /// The recommended set for one run: the per-profile default or an explicit
    /// --recommended value (none, all, starter, or a comma-separated id list).
    pub fn recommended_for(&self, profile: &str, spec: Option<&str>) -> Result<Vec<Entry>> {
        let starter = || {
            self.recommended
                .iter()
                .filter(|entry| entry.starter)
                .cloned()
                .collect::<Vec<_>>()
        };
        let chosen = match spec.map(str::trim).filter(|s| !s.is_empty()) {
            None => {
                if self.has_starter(profile) {
                    starter()
                } else {
                    Vec::new()
                }
            }
            Some("none") => Vec::new(),
            Some("all") => self.recommended.clone(),
            Some("starter") => starter(),
            Some(other) => {
                let mut picked: Vec<Entry> = Vec::new();
                for raw in other.split(',').map(str::trim).filter(|s| !s.is_empty()) {
                    let found = self
                        .recommended
                        .iter()
                        .find(|entry| entry.id == raw || alias_matches(entry, raw));
                    let Some(entry) = found else {
                        bail!(
                            "unknown recommended plugin '{raw}' (ids: {})",
                            self.recommended_ids().join(", ")
                        );
                    };
                    if !picked.iter().any(|p| p.id == entry.id) {
                        picked.push(entry.clone());
                    }
                }
                picked
            }
        };
        Ok(chosen)
    }

    /// Everything one provisioning run has to make sure of, essential first.
    /// The feature-gated essentials are resolved against `cfg`, so a run
    /// matches what `plugins/install.sh` would have attached.
    pub fn selection(
        &self,
        profile: &str,
        spec: Option<&str>,
        cfg: &RdshSettings,
    ) -> Result<Vec<Entry>> {
        let mut all = self.essential_for_settings(profile, cfg);
        all.extend(self.recommended_for(profile, spec)?);
        Ok(all)
    }
}

fn string_list(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn entries(value: Option<&Value>, essential: bool) -> Result<Vec<Entry>> {
    let list = value
        .and_then(Value::as_array)
        .context("plugin catalog tier is not a list")?;
    let mut out = Vec::new();
    for item in list {
        let package = item
            .get("package")
            .and_then(Value::as_str)
            .filter(|name| !name.is_empty())
            .context("plugin catalog entry without a package")?
            .to_string();
        let id = match item.get("id").and_then(Value::as_str) {
            Some(id) => id.to_string(),
            None if essential => default_id(&package),
            None => bail!("recommended plugin '{package}' has no id"),
        };
        out.push(Entry {
            id,
            bundled: item
                .get("bundled")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            profiles: item.get("profiles").and_then(Value::as_array).map(|list| {
                list.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect::<Vec<_>>()
            }),
            feature: item
                .get("feature")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())
                .map(str::to_string),
            starter: item
                .get("starter")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            essential,
            why: item
                .get("why")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            package,
        });
    }
    Ok(out)
}

fn default_id(package: &str) -> String {
    let tail = package.rsplit('/').next().unwrap_or(package);
    tail.strip_prefix("rdsh-")
        .or_else(|| tail.strip_prefix("dsh-"))
        .unwrap_or(tail)
        .to_string()
}

/// --recommended=rdsh-translation / dsh-intelligent-ui name the same entry as
/// its id, matching how plugins/install.sh accepts aliases.
fn alias_matches(entry: &Entry, raw: &str) -> bool {
    let tail = entry.package.rsplit('/').next().unwrap_or(&entry.package);
    tail == raw || tail.strip_prefix("rdsh-") == Some(raw) || tail.strip_prefix("dsh-") == Some(raw)
}

/// $DSH_HOME/profiles/<profile>.
pub fn profile_dir(env: &OsEnv, profile: &str) -> PathBuf {
    env.dsh_home.join("profiles").join(profile)
}

pub fn read(env: &OsEnv, profile: &str) -> ProfileState {
    desktop::read_profile(&profile_dir(env, profile))
}

/// A package is present when pnpm recorded it, under its own name or the full
/// spec. A package attached under an unrelated alias is reported as absent.
pub fn installed(state: &ProfileState, entry: &Entry) -> bool {
    let key = entry.key();
    state.installed(&key) || state.installed(&entry.package)
}

fn enabled(state: &ProfileState, entry: &Entry) -> bool {
    state.enabled(&entry.key()) || state.enabled(&entry.package)
}

#[derive(Debug, Clone)]
pub struct Row {
    pub entry: Entry,
    pub installed: bool,
    pub enabled: bool,
}

impl Row {
    fn state_label(&self) -> &'static str {
        if self.enabled {
            "enabled"
        } else if self.installed {
            "installed"
        } else {
            "missing"
        }
    }

    fn localized_state(&self, locale: Locale) -> &'static str {
        match self.state_label() {
            "enabled" => text(locale, "enabled", "已启用", "有効"),
            "installed" => text(locale, "installed", "已安装", "インストール済み"),
            _ => text(locale, "missing", "未安装", "未導入"),
        }
    }
}

#[derive(Debug, Clone)]
pub struct Report {
    pub profile: String,
    pub dir: PathBuf,
    pub initialized: bool,
    pub error: Option<String>,
    pub plugins_dir: Option<PathBuf>,
    pub plugins_dir_error: Option<String>,
    pub essentials: Vec<Row>,
    pub recommended: Vec<Row>,
    pub missing_essential: Vec<String>,
}

impl Report {
    pub fn ok(&self) -> bool {
        self.missing_essential.is_empty()
    }

    fn bundled_missing(&self) -> bool {
        self.essentials
            .iter()
            .any(|row| !row.installed && row.entry.bundled)
    }
}

pub fn report(
    env: &OsEnv,
    catalog: &Catalog,
    profile: &str,
    plugins_dir: Option<&str>,
    locale: Locale,
    cfg: &RdshSettings,
) -> Report {
    let state = read(env, profile);
    let row = |entry: Entry| Row {
        installed: installed(&state, &entry),
        enabled: enabled(&state, &entry),
        entry,
    };
    let essentials: Vec<Row> = catalog
        .essential_for_settings(profile, cfg)
        .into_iter()
        .map(row)
        .collect();
    let recommended: Vec<Row> = catalog.recommended.iter().cloned().map(row).collect();
    let missing_essential = essentials
        .iter()
        .filter(|row| !row.installed)
        .map(|row| row.entry.package.clone())
        .collect();
    let (plugins_dir, plugins_dir_error) =
        match desktop::resolve_plugins_dir(plugins_dir, env, locale) {
            Ok(dir) => (Some(dir), None),
            Err(error) => (None, Some(error.to_string())),
        };
    Report {
        profile: profile.to_string(),
        dir: profile_dir(env, profile),
        initialized: state.initialized,
        error: state.error,
        plugins_dir,
        plugins_dir_error,
        essentials,
        recommended,
        missing_essential,
    }
}

fn row_json(row: &Row) -> Value {
    json!({
        "id": row.entry.id,
        "package": row.entry.package,
        "bundled": row.entry.bundled,
        "tier": row.entry.tier(),
        "starter": row.entry.starter,
        "profiles": row.entry.profiles,
        "installed": row.installed,
        "enabled": row.enabled,
        "state": row.state_label(),
        "why": row.entry.why,
    })
}

fn report_json(report: &Report) -> Value {
    json!({
        "schema": 1,
        "profile": report.profile,
        "profile_dir": report.dir.display().to_string(),
        "initialized": report.initialized,
        "error": report.error,
        "plugins_dir": report.plugins_dir.as_ref().map(|dir| dir.display().to_string()),
        "plugins_dir_error": report.plugins_dir_error,
        "essential": report.essentials.iter().map(row_json).collect::<Vec<_>>(),
        "recommended": report.recommended.iter().map(row_json).collect::<Vec<_>>(),
        "missing_essential": report.missing_essential,
        "ok": report.ok(),
    })
}

/// rdsh plugins status - read-only: what the profile has and what it misses.
pub fn cmd_status(
    profile: &str,
    plugins_dir: Option<&str>,
    json_out: bool,
    locale: Locale,
) -> Result<()> {
    let env = OsEnv::from_process();
    let catalog = Catalog::load()?;
    let cfg = crate::rdsh_config::load();
    let report = report(&env, &catalog, profile, plugins_dir, locale, &cfg);
    if json_out {
        out!("{}", serde_json::to_string_pretty(&report_json(&report))?);
        return Ok(());
    }
    out!(
        "[rdsh] plugins: {} {} ({})",
        text(locale, "profile", "配置文件", "プロファイル"),
        report.profile,
        report.dir.display()
    );
    if let Some(error) = &report.error {
        out!(
            "[rdsh] plugins: {}: {error}",
            text(locale, "unreadable", "无法读取", "読み取れません")
        );
    } else if !report.initialized {
        out!(
            "[rdsh] plugins: {}",
            text(
                locale,
                "the profile has no package.json yet; boot it once, then provision",
                "该配置文件尚无 package.json；请先启动一次再安装",
                "このプロファイルにはまだ package.json がありません。一度起動してから導入してください"
            )
        );
    }
    match (&report.plugins_dir, &report.plugins_dir_error) {
        (Some(dir), _) => out!(
            "[rdsh] plugins: {} {}",
            text(locale, "sources", "来源", "取得元"),
            dir.display()
        ),
        (None, Some(error)) if report.bundled_missing() => out!(
            "[rdsh] plugins: {}: {error}",
            text(locale, "sources", "来源", "取得元")
        ),
        _ => {}
    }
    for (tier, rows) in [
        (
            text(locale, "essential", "必需", "必須"),
            &report.essentials,
        ),
        (
            text(locale, "recommended", "推荐", "推奨"),
            &report.recommended,
        ),
    ] {
        out!("[rdsh] plugins: {tier}");
        for row in rows {
            let mut note = String::new();
            if row.entry.bundled {
                note.push_str(text(locale, " (bundled)", "（内置）", "（同梱）"));
            }
            if row.entry.starter {
                note.push_str(text(locale, " (starter)", "（入门）", "（スターター）"));
            }
            out!(
                "[rdsh] plugins:   {:<9} {}{note}",
                row.localized_state(locale),
                row.entry.package
            );
        }
    }
    if report.ok() {
        out!(
            "[rdsh] plugins: {}",
            text(
                locale,
                "essential plugins are complete",
                "必需插件已齐全",
                "必須プラグインは揃っています"
            )
        );
    } else {
        let missing = report.missing_essential.len();
        let total = report.essentials.len();
        let line = match locale {
            Locale::English => {
                format!("[rdsh] plugins: {missing} of {total} essential package(s) are missing")
            }
            Locale::Chinese => format!("[rdsh] plugins: 必需插件缺失 {missing} 个（共 {total}）"),
            Locale::Japanese => format!(
                "[rdsh] plugins: 必須プラグインが {missing} 件不足しています（全 {total} 件）"
            ),
        };
        out!("{line}");
        out!(
            "[rdsh] plugins: {}: rdsh plugins install --profile {}",
            text(locale, "fix", "修复", "修正"),
            report.profile
        );
    }
    Ok(())
}

/// One package to attach: the resolved spec plus the catalog entry it came from.
struct Target {
    entry: Entry,
    spec: String,
}

/// Packages a run cannot attach, each with its reason: an explicit --no-bundled
/// opt-out, or a checkout that does not carry the package. Skips are reported,
/// never dropped silently.
type Skipped = Vec<(String, String)>;

#[derive(Debug, Clone, Default)]
pub struct InstallRequest {
    pub profile: String,
    pub plugins_dir: Option<String>,
    pub recommended: Option<String>,
    /// Skip the bundled plugins; a release-only install has no checkout.
    pub no_bundled: bool,
    pub dry_run: bool,
    pub json: bool,
}

/// The dsh CLI that owns plugin --profile <name> add; plugins/install.sh uses
/// the same command. RDSH_DSH_BIN overrides the PATH lookup.
fn dsh_bin() -> anyhow::Result<String> {
    dsh_bin_from(std::env::var("RDSH_DSH_BIN").ok())
}

fn dsh_bin_from(override_value: Option<String>) -> anyhow::Result<String> {
    if let Some(value) = override_value {
        let trimmed = value.trim().to_string();
        if !trimmed.is_empty() {
            if let Some(reason) =
                crate::exec_trust::untrusted_reason(std::path::Path::new(&trimmed))
            {
                anyhow::bail!("RDSH_DSH_BIN '{trimmed}' is not trusted: {reason}");
            }
            return Ok(trimmed);
        }
    }
    crate::exec_trust::find_trusted_on_path("dsh")
        .map(|path| path.to_string_lossy().into_owned())
        .ok_or_else(|| {
            anyhow::anyhow!(
                "could not find a trusted 'dsh' on PATH; install the dsh CLI or set RDSH_DSH_BIN to its absolute path",
            )
        })
}

/// Resolve the selected entries to concrete specs, skipping the ones a missing
/// checkout or --no-bundled cannot provide. Skips are returned, never dropped.
fn targets_for(
    env: &OsEnv,
    state: &ProfileState,
    selection: Vec<Entry>,
    request: &InstallRequest,
    locale: Locale,
) -> Result<(Vec<Target>, Skipped)> {
    let mut missing = Vec::new();
    let mut skipped = Vec::new();
    for entry in selection {
        if installed(state, &entry) {
            continue;
        }
        if entry.bundled && request.no_bundled {
            skipped.push((entry.package.clone(), "--no-bundled".to_string()));
            continue;
        }
        missing.push(entry);
    }
    let needs_bundled = missing.iter().any(|entry| entry.bundled);
    let (root, root_error) = if needs_bundled {
        match desktop::resolve_plugins_dir(request.plugins_dir.as_deref(), env, locale) {
            Ok(dir) => (Some(dir), None),
            Err(error) => (None, Some(error.to_string())),
        }
    } else {
        (None, None)
    };
    let mut targets = Vec::new();
    for entry in missing {
        if !entry.bundled {
            targets.push(Target {
                spec: entry.package.clone(),
                entry,
            });
            continue;
        }
        let Some(dir) = &root else {
            skipped.push((
                entry.package.clone(),
                root_error
                    .clone()
                    .unwrap_or_else(|| "no checkout".to_string()),
            ));
            continue;
        };
        let path = dir.join(&entry.package);
        if !path.join(BUNDLED_MANIFEST).is_file() {
            skipped.push((entry.package.clone(), format!("not in {}", dir.display())));
            continue;
        }
        // Plugin specs stay slash-separated: Windows separators would leak into
        // a spec handed to the dsh CLI.
        targets.push(Target {
            spec: path.display().to_string().replace('\\', "/"),
            entry,
        });
    }
    Ok((targets, skipped))
}

/// rdsh plugins install - attach what the profile is missing, essential first.
pub fn cmd_install(request: InstallRequest, locale: Locale) -> Result<()> {
    let env = OsEnv::from_process();
    let catalog = Catalog::load()?;
    if request.profile == desktop::PROFILE {
        return install_desktop(&env, &catalog, &request, locale);
    }
    let state = read(&env, &request.profile);
    let cfg = crate::rdsh_config::load();
    let selection = catalog.selection(&request.profile, request.recommended.as_deref(), &cfg)?;
    let (targets, skipped) = targets_for(&env, &state, selection, &request, locale)?;
    // --no-bundled is an explicit opt-out: reported, but not a failure.
    let (declined, unresolved): (Skipped, Skipped) = skipped
        .into_iter()
        .partition(|(_, why)| why == "--no-bundled");
    let sources = desktop::resolve_plugins_dir(request.plugins_dir.as_deref(), &env, locale)
        .ok()
        .map(|dir| dir.display().to_string());
    let dsh = dsh_bin()?;
    let mut actions = Vec::new();
    let mut not_installed: Vec<String> = unresolved
        .iter()
        .map(|(package, why)| format!("{package} ({why})"))
        .collect();

    if !request.json {
        out!(
            "[rdsh] plugins: {} {} ({})",
            text(locale, "profile", "配置文件", "プロファイル"),
            request.profile,
            state.path.display()
        );
        if let Some(dir) = &sources {
            out!(
                "[rdsh] plugins: {} {}",
                text(locale, "sources", "来源", "取得元"),
                dir
            );
        }
        if targets.is_empty() {
            out!(
                "[rdsh] plugins: {}",
                text(
                    locale,
                    "nothing to add; the selected plugins are already attached",
                    "无需添加；所选插件均已安装",
                    "追加するものはありません（選択したプラグインは導入済み）"
                )
            );
        }
    }

    let mut installed_count = 0usize;
    for target in &targets {
        let args = vec![
            "plugin".to_string(),
            "--profile".to_string(),
            request.profile.clone(),
            "add".to_string(),
            target.spec.clone(),
        ];
        if request.dry_run {
            if !request.json {
                out!(
                    "[rdsh] {}: {} {}",
                    text(locale, "dry-run", "试运行", "ドライラン"),
                    dsh,
                    args.join(" ")
                );
            }
            actions.push(json!({
                "package": target.entry.package,
                "spec": target.spec,
                "tier": target.entry.tier(),
                "status": "dry-run",
                "args": args,
            }));
            continue;
        }
        if !request.json {
            out!(
                "[rdsh] plugins: {} {}",
                text(locale, "installing", "正在安装", "インストール中"),
                target.entry.package
            );
        }
        let output = match Command::new(&dsh).args(&args).output() {
            Ok(output) => output,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                bail!("could not run '{dsh}'; install the dsh CLI or set RDSH_DSH_BIN")
            }
            Err(error) => {
                return Err(error).with_context(|| format!("failed to run {dsh}"));
            }
        };
        let ok = output.status.success();
        if ok {
            installed_count += 1;
        } else {
            not_installed.push(format!(
                "{} (exit {})",
                target.entry.package,
                output.status.code().unwrap_or(-1)
            ));
        }
        if request.json {
            actions.push(json!({
                "package": target.entry.package,
                "spec": target.spec,
                "tier": target.entry.tier(),
                "status": if ok { "installed" } else { "failed" },
                "exit": output.status.code(),
                "stderr_tail": tail(&String::from_utf8_lossy(&output.stderr), 8),
            }));
        } else {
            out!(
                "[rdsh] plugins: {} {}",
                if ok {
                    text(locale, "installed", "已安装", "インストールしました")
                } else {
                    text(locale, "failed", "失败", "失敗しました")
                },
                target.entry.package
            );
            if !ok {
                let combined = format!(
                    "{}{}",
                    String::from_utf8_lossy(&output.stdout),
                    String::from_utf8_lossy(&output.stderr)
                );
                for line in tail(&combined, 8).lines() {
                    err!("[rdsh] {line}");
                }
            }
        }
    }

    if request.json {
        out!(
            "{}",
            serde_json::to_string_pretty(&json!({
                "schema": 1,
                "profile": request.profile,
                "profile_dir": state.path.display().to_string(),
                "plugins_dir": sources,
                "dry_run": request.dry_run,
                "command": dsh,
                "actions": actions,
                "failed": not_installed,
                "skipped": declined
                    .iter()
                    .map(|(package, why)| format!("{package} ({why})"))
                    .collect::<Vec<_>>(),
            }))?
        );
    } else {
        let line = match locale {
            Locale::English => format!(
                "[rdsh] plugins: done: {installed_count} installed, {} not installed",
                not_installed.len()
            ),
            Locale::Chinese => format!(
                "[rdsh] plugins: 完成：已安装 {installed_count} 个，未安装 {} 个",
                not_installed.len()
            ),
            Locale::Japanese => format!(
                "[rdsh] plugins: 完了: {installed_count} 件をインストール、{} 件は未導入",
                not_installed.len()
            ),
        };
        out!("{line}");
        if installed_count > 0 {
            out!(
                "[rdsh] plugins: {}: {}",
                text(locale, "next", "下一步", "次の手順"),
                text(
                    locale,
                    "restart the DSH session so the new plugins load",
                    "请重启 DSH 会话以加载新插件",
                    "新しいプラグインを読み込むため DSH セッションを再起動してください"
                )
            );
        }
    }
    if !request.json {
        for (package, why) in &declined {
            out!(
                "[rdsh] plugins: {}: {package} ({why})",
                text(locale, "skipped", "已跳过", "スキップ")
            );
        }
    }
    if !not_installed.is_empty() {
        for item in &not_installed {
            err!(
                "[rdsh] plugins: {}: {item}",
                text(locale, "not installed", "未安装", "未導入")
            );
        }
        bail!(
            "plugin provisioning incomplete: {}",
            not_installed.join(", ")
        );
    }
    Ok(())
}

/// The Desktop profile forwards to the app's own command runtime: the npm CLI
/// refuses to manage it, and rdsh desktop install resolves that runtime.
fn install_desktop(
    env: &OsEnv,
    catalog: &Catalog,
    request: &InstallRequest,
    locale: Locale,
) -> Result<()> {
    let state = read(env, &request.profile);
    let cfg = crate::rdsh_config::load();
    let selection = catalog.selection(&request.profile, request.recommended.as_deref(), &cfg)?;
    let (targets, skipped) = targets_for(env, &state, selection, request, locale)?;
    let unresolved: Vec<String> = skipped
        .iter()
        .filter(|(_, why)| why != "--no-bundled")
        .map(|(package, why)| format!("{package} ({why})"))
        .collect();
    if !unresolved.is_empty() {
        bail!(
            "desktop plugin provisioning incomplete: {}",
            unresolved.join(", ")
        );
    }
    if targets.is_empty() {
        out!(
            "[rdsh] plugins: {}",
            text(
                locale,
                "nothing to add; the selected plugins are already attached",
                "无需添加；所选插件均已安装",
                "追加するものはありません（選択したプラグインは導入済み）"
            )
        );
        return Ok(());
    }
    // --no-bundled keeps the Desktop command's own defaults out of the run:
    // every package this command attaches is one the catalog selected.
    desktop::cmd_install(
        desktop::InstallOptions {
            plugins_dir: request.plugins_dir.clone(),
            packages: targets.iter().map(|target| target.spec.clone()).collect(),
            no_bundled: true,
            dry_run: request.dry_run,
            compute: false,
            no_sound: true,
            no_gitview: true,
            no_intelligent_ui: true,
            json: request.json,
        },
        locale,
    )
}

fn tail(text: &str, lines: usize) -> String {
    let all: Vec<&str> = text.lines().collect();
    all[all.len().saturating_sub(lines)..].join("\n")
}

/// Missing essential packages per initialized profile, for rdsh doctor.
/// An uninitialized profile is skipped: it has no manifest to be missing from.
pub fn essential_gaps(
    env: &OsEnv,
    catalog: &Catalog,
    cfg: &RdshSettings,
) -> Vec<(String, Vec<String>)> {
    let Ok(entries) = std::fs::read_dir(env.dsh_home.join("profiles")) else {
        return Vec::new();
    };
    let mut gaps = Vec::new();
    for entry in entries.flatten() {
        let profile = entry.file_name().to_string_lossy().into_owned();
        let state = desktop::read_profile(&entry.path());
        if !state.initialized {
            continue;
        }
        let missing: Vec<String> = catalog
            .essential_for_settings(&profile, cfg)
            .into_iter()
            .filter(|entry| !installed(&state, entry))
            .map(|entry| entry.package)
            .collect();
        if !missing.is_empty() {
            gaps.push((profile, missing));
        }
    }
    gaps.sort();
    gaps
}

/// Profiles whose manifest carries the bundled feedback patch.
pub fn profiles_with_feedback_patch(env: &OsEnv) -> Vec<String> {
    const BUNDLES: [&str; 2] = ["rdsh-no-feedback", "rdsh-no-feedback-client"];
    let Ok(entries) = std::fs::read_dir(env.dsh_home.join("profiles")) else {
        return Vec::new();
    };
    let mut dirs: Vec<PathBuf> = entries.flatten().map(|entry| entry.path()).collect();
    dirs.sort();
    dirs.into_iter()
        .filter_map(|dir| {
            let state = desktop::read_profile(&dir);
            if !state.initialized || !BUNDLES.iter().any(|name| state.installed(name)) {
                return None;
            }
            dir.file_name()
                .map(|name| name.to_string_lossy().into_owned())
        })
        .collect()
}

/// Detach the bundled feedback patch from every initialized profile.
///
/// `rdsh features on feedback` only flips the switch, and the switch selects the
/// bundle at provisioning time. An install that already carries the patch keeps
/// the DSH surface hidden until the package is removed, so the toggle removes it
/// here.
pub fn detach_feedback_bundles(env: &OsEnv, locale: Locale) -> Result<Vec<(String, bool)>> {
    const BUNDLES: [&str; 2] = ["rdsh-no-feedback", "rdsh-no-feedback-client"];
    let _ = locale;
    let dsh = dsh_bin()?;
    let mut results = Vec::new();
    for profile in profiles_with_feedback_patch(env) {
        let state = desktop::read_profile(&env.dsh_home.join("profiles").join(&profile));
        let attached: Vec<&str> = BUNDLES
            .iter()
            .copied()
            .filter(|name| state.installed(name))
            .collect();
        if attached.is_empty() {
            continue;
        }
        let mut args = vec![
            "plugin".to_string(),
            "--profile".to_string(),
            profile.clone(),
            "remove".to_string(),
        ];
        args.extend(attached.iter().map(|name| name.to_string()));
        let ok = match Command::new(&dsh).args(&args).output() {
            Ok(output) => output.status.success(),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                bail!("could not run '{dsh}'; install the dsh CLI or set RDSH_DSH_BIN")
            }
            Err(error) => return Err(error).with_context(|| format!("failed to run {dsh}")),
        };
        results.push((profile, ok));
    }
    Ok(results)
}

/// One doctor line per profile whose essential tier is incomplete.
pub fn doctor_lines(env: &OsEnv, locale: Locale) -> Vec<String> {
    let Ok(catalog) = Catalog::load() else {
        return Vec::new();
    };
    let cfg = crate::rdsh_config::load();
    essential_gaps(env, &catalog, &cfg)
        .into_iter()
        .map(|(profile, missing)| match locale {
            Locale::English => format!(
                "[rdsh] plugins: {profile} is missing {} essential plugin(s) (fix: rdsh plugins install --profile {profile})",
                missing.len()
            ),
            Locale::Chinese => format!(
                "[rdsh] plugins: {profile} 缺少 {} 个必需插件（修复：rdsh plugins install --profile {profile}）",
                missing.len()
            ),
            Locale::Japanese => format!(
                "[rdsh] plugins: {profile} は必須プラグインが {} 件不足（修正: rdsh plugins install --profile {profile}）",
                missing.len()
            ),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn checkout() -> PathBuf {
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("plugins")
    }

    fn packages(entries: &[Entry]) -> Vec<String> {
        entries.iter().map(|entry| entry.package.clone()).collect()
    }

    #[cfg(unix)]
    #[test]
    fn dsh_bin_from_enforces_the_trust_policy() {
        use std::os::unix::fs::PermissionsExt;
        let root = std::env::temp_dir().join(format!(
            "rdsh-dsh-bin-test-{}-{}",
            std::process::id(),
            crate::local_http::random_token().unwrap()
        ));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700)).unwrap();
        let clean = root.join("dsh");
        std::fs::write(&clean, b"#!/bin/sh\n").unwrap();
        std::fs::set_permissions(&clean, std::fs::Permissions::from_mode(0o755)).unwrap();
        let resolved =
            dsh_bin_from(Some(clean.to_string_lossy().into_owned())).expect("clean bin passes");
        assert_eq!(resolved, clean.to_string_lossy());

        let loose = root.join("loose-dsh");
        std::fs::write(&loose, b"#!/bin/sh\n").unwrap();
        std::fs::set_permissions(&loose, std::fs::Permissions::from_mode(0o777)).unwrap();
        let error =
            dsh_bin_from(Some(loose.to_string_lossy().into_owned())).expect_err("must refuse");
        assert!(error.to_string().contains("not trusted"), "{error}");

        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn catalog_carries_the_essential_tier_the_installer_ships() {
        let catalog = Catalog::load().unwrap();
        let web = packages(&catalog.essential_for("web"));
        // The tier is the eleven unconditional entries plus the two Web-only
        // bundles plus the two feature-gated feedback packages; the gate itself
        // is asserted in feedback_bundle_is_provisioned_only_when_the_switch_is_off.
        // asserted in feedback_bundle_is_provisioned_only_when_the_switch_is_off.
        assert_eq!(web.len(), 14);
        assert_eq!(web[0], "@deepseek-ai/dsh-tool-present");
        assert_eq!(web[6], "@deepseek-ai/dsh-mcp-client");
        assert_eq!(web[7], "rdsh-settings");
        assert_eq!(web[10], "rdsh-update-banner");
        assert_eq!(web[11], "rdsh-web-cache");
        assert_eq!(web[12], "rdsh-no-feedback");
        // The Web banner and the asset server are essential for web only.
        let headless = packages(&catalog.essential_for("headless"));
        assert_eq!(headless.len(), 12);
        assert!(!headless.iter().any(|name| name == "rdsh-update-banner"));
        assert!(!headless.iter().any(|name| name == "rdsh-web-cache"));
    }

    #[test]
    fn starter_set_is_the_web_and_desktop_default() {
        let catalog = Catalog::load().unwrap();
        let web = catalog
            .selection("web", None, &RdshSettings::default())
            .unwrap();
        let ids: Vec<String> = web.iter().map(|entry| entry.id.clone()).collect();
        for id in [
            "translation",
            "subagents",
            "sound",
            "gitview",
            "intelligent-ui",
        ] {
            assert!(ids.contains(&id.to_string()), "{id} missing from {ids:?}");
        }
        assert!(!ids.contains(&"compute".to_string()));
        // headless keeps the essential tier only.
        let headless = catalog
            .selection("headless", None, &RdshSettings::default())
            .unwrap();
        assert_eq!(headless.len(), 12);
        assert!(headless.iter().all(|entry| entry.essential));
    }

    #[test]
    fn recommended_spec_accepts_ids_aliases_and_rejects_unknown_ones() {
        let catalog = Catalog::load().unwrap();
        let picked = catalog
            .recommended_for("headless", Some("compute,gitview"))
            .unwrap();
        let ids: Vec<&str> = picked.iter().map(|entry| entry.id.as_str()).collect();
        assert_eq!(ids, ["compute", "gitview"]);
        // Aliases name the package, as plugins/install.sh accepts them.
        let alias = catalog
            .recommended_for("headless", Some("rdsh-translation,dsh-intelligent-ui"))
            .unwrap();
        let ids: Vec<&str> = alias.iter().map(|entry| entry.id.as_str()).collect();
        assert_eq!(ids, ["translation", "intelligent-ui"]);
        let error = catalog
            .recommended_for("web", Some("nope"))
            .unwrap_err()
            .to_string();
        assert!(
            error.contains("unknown recommended plugin 'nope'"),
            "{error}"
        );
        assert_eq!(
            catalog.recommended_for("web", Some("all")).unwrap().len(),
            9
        );
        assert!(catalog
            .recommended_for("web", Some("none"))
            .unwrap()
            .is_empty());
    }

    #[test]
    fn feedback_bundle_is_provisioned_only_when_the_switch_is_off() {
        let catalog = Catalog::load().unwrap();
        // The tier one profile gets under these settings, as package names.
        let tier = |profile: &str, cfg: &RdshSettings| {
            packages(&catalog.essential_for_settings(profile, cfg))
        };

        // Default (switch absent = OFF): the rdsh-no-feedback bundle is
        // provisioned so rdsh-specific issues never reach the DSH upstream.
        assert!(tier("web", &RdshSettings::default())
            .iter()
            .any(|name| name == "rdsh-no-feedback"));

        // Explicit on is the only way to keep the stock DSH surface.
        let on = settings_with_feature("feedback", true);
        assert!(
            !tier("web", &on)
                .iter()
                .any(|name| name == "rdsh-no-feedback"),
            "explicit features.feedback=true keeps the stock surface"
        );

        // Explicit off provisions the bundle on every profile, same as the
        // default.
        let off = settings_with_feature("feedback", false);
        assert!(tier("web", &off)
            .iter()
            .any(|name| name == "rdsh-no-feedback"));
        assert!(tier("headless", &off)
            .iter()
            .any(|name| name == "rdsh-no-feedback"));

        // The selection a provisioning run uses sees the same entry.
        let selection = catalog.selection("web", Some("none"), &off).unwrap();
        assert!(selection
            .iter()
            .any(|entry| entry.package == "rdsh-no-feedback"));
    }

    /// Settings carrying one explicit feature value. `features` only holds
    /// explicitly written ids, so inserting here mirrors a real rdsh.json.
    fn settings_with_feature(id: &str, on: bool) -> RdshSettings {
        let mut cfg = RdshSettings::default();
        cfg.features.values.insert(id.to_string(), on);
        cfg
    }

    #[test]
    fn every_bundled_entry_exists_in_this_checkout() {
        let catalog = Catalog::load().unwrap();
        for entry in catalog.essential.iter().chain(catalog.recommended.iter()) {
            if !entry.bundled {
                continue;
            }
            let manifest = checkout().join(&entry.package).join(BUNDLED_MANIFEST);
            assert!(manifest.is_file(), "{} is missing", manifest.display());
        }
    }

    #[test]
    fn dependency_keys_match_what_the_profile_records() {
        let catalog = Catalog::load().unwrap();
        let key = |package: &str| {
            catalog
                .essential
                .iter()
                .chain(catalog.recommended.iter())
                .find(|entry| entry.package == package)
                .unwrap()
                .key()
        };
        assert_eq!(
            key("@deepseek-ai/dsh-tool-present"),
            "@deepseek-ai/dsh-tool-present"
        );
        assert_eq!(key("rdsh-answer-guard"), "rdsh-answer-guard");
        assert_eq!(key("github:yugapor/dsh-gitview"), "dsh-gitview");
    }

    #[test]
    fn bundled_targets_use_slash_separated_specs_from_the_checkout() {
        let env = OsEnv {
            platform: "windows".to_string(),
            home: PathBuf::from("C:/Users/test"),
            dsh_home: PathBuf::from("C:/Users/test/.dsh"),
            ..Default::default()
        };
        let catalog = Catalog::load().unwrap();
        let selection = catalog
            .selection("headless", Some("none"), &RdshSettings::default())
            .unwrap();
        let request = InstallRequest {
            profile: "headless".to_string(),
            plugins_dir: Some(checkout().display().to_string()),
            recommended: Some("none".to_string()),
            no_bundled: false,
            dry_run: true,
            json: false,
        };
        let (targets, skipped) = targets_for(
            &env,
            &ProfileState::default(),
            selection,
            &request,
            Locale::English,
        )
        .unwrap();
        assert!(skipped.is_empty(), "{skipped:?}");
        let bundled = targets
            .iter()
            .find(|target| target.entry.package == "rdsh-settings")
            .unwrap();
        assert!(!bundled.spec.contains('\\'), "{}", bundled.spec);
        assert!(bundled.spec.ends_with("/rdsh-settings"));
    }

    #[test]
    fn a_checkout_missing_a_bundled_package_skips_it_instead_of_dropping_it() {
        let temp = std::env::temp_dir().join(format!("rdsh-plugins-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&temp);
        // A checkout that carries only one of the bundled essentials.
        let partial = temp.join("checkout");
        std::fs::create_dir_all(partial.join("rdsh-settings")).unwrap();
        std::fs::write(
            partial.join("rdsh-settings").join(BUNDLED_MANIFEST),
            r#"{"name":"rdsh-settings"}"#,
        )
        .unwrap();
        let env = OsEnv {
            dsh_home: temp.join(".dsh"),
            home: temp.clone(),
            ..Default::default()
        };
        let catalog = Catalog::load().unwrap();
        let selection = catalog
            .selection("headless", Some("none"), &RdshSettings::default())
            .unwrap();
        let request = InstallRequest {
            profile: "headless".to_string(),
            plugins_dir: Some(partial.display().to_string()),
            recommended: Some("none".to_string()),
            no_bundled: false,
            dry_run: true,
            json: false,
        };
        let (targets, skipped) = targets_for(
            &env,
            &ProfileState::default(),
            selection,
            &request,
            Locale::English,
        )
        .unwrap();
        // Seven upstream specs plus the one bundled package the checkout
        // carries; the feedback bundle joins the skipped list by default now.
        assert_eq!(targets.len(), 8);
        let skipped_packages: Vec<&str> = skipped
            .iter()
            .map(|(package, _)| package.as_str())
            .collect();
        assert_eq!(
            skipped_packages,
            [
                "rdsh-mobile-ui",
                "rdsh-answer-guard",
                "rdsh-no-feedback",
                "rdsh-no-feedback-client",
            ]
        );
        assert!(skipped.iter().all(|(_, why)| why.contains("not in")));
        let _ = std::fs::remove_dir_all(&temp);
    }
}
