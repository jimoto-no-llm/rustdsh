//! Automatic provider-model refresh.
//!
//! `rdsh models sync` keeps a profile's provider blocks in step with what the
//! provider itself advertises, but somebody has to remember to run it. This
//! module is the schedule around that command: the boot path only reads a small
//! state file and, when the refresh is due, starts a detached
//! `rdsh models auto --quiet` that does the network work after DSH launched.
//!
//! Contract:
//! - A boot never blocks or fails on this: `maybe_spawn()` returns `()` and
//!   swallows every error, including a missing or corrupt state file.
//! - `features.models_auto=false` in `rdsh.json`, `RDSH_NO_MODELS_AUTO=1`, or
//!   `--dry-run` vetoes the background refresh.
//! - At most one refresh per interval (default 24 h, overridable with
//!   `RDSH_MODELS_AUTO_INTERVAL_HOURS`), serialized through the state file's
//!   sibling lock so two launches cannot refresh the same profiles at once.
//! - The state file records when the last attempt ran and what it changed, so
//!   `rdsh models auto --json` reports the schedule without new network work.

use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use serde_json::{json, Value};

use crate::file_lock::FileLock;
use crate::inspect::dsh_home;
use crate::rdsh_config::{feature_enabled, RdshSettings};

/// Feature id in `rdsh.json`; `rdsh features off models_auto` is the veto.
pub(crate) const FEATURE: &str = "models_auto";
/// Gap between refreshes when nothing overrides it.
const DEFAULT_INTERVAL_HOURS: u64 = 24;
/// Floor for the interval, so a typo cannot turn every launch into a refresh.
const MIN_INTERVAL_HOURS: u64 = 1;
/// Interval override, in hours.
const INTERVAL_ENV: &str = "RDSH_MODELS_AUTO_INTERVAL_HOURS";
/// Explicit kill switch for hosts that must never refresh in the background.
const DISABLE_ENV: &str = "RDSH_NO_MODELS_AUTO";
/// State file name under `$DSH_HOME/cache`.
const STATE_NAME: &str = "rdsh-models-auto.json";
/// The state file is bookkeeping, not a log; anything larger is not ours.
const MAX_STATE_BYTES: u64 = 64 * 1024;
/// How much of the sync's stderr a failed run keeps in its report.
const MAX_ERROR_CHARS: usize = 400;

/// What the last refresh attempt did, as recorded in the state file.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub(crate) struct State {
    pub last_attempt_unix: Option<u64>,
    pub last_success_unix: Option<u64>,
    pub changed: bool,
    pub outcome: Option<String>,
    pub detail: Option<String>,
}

impl State {
    fn to_json(&self) -> Value {
        json!({
            "schema": 1,
            "last_attempt_unix": self.last_attempt_unix,
            "last_success_unix": self.last_success_unix,
            "changed": self.changed,
            "outcome": self.outcome,
            "detail": self.detail,
        })
    }

    /// Unknown fields, wrong types and missing keys all fall back to "nothing
    /// recorded", which is the only state that allows a refresh.
    fn from_json(value: &Value) -> Self {
        let unix = |key: &str| value.get(key).and_then(Value::as_u64);
        let text = |key: &str| value.get(key).and_then(Value::as_str).map(str::to_string);
        Self {
            last_attempt_unix: unix("last_attempt_unix"),
            last_success_unix: unix("last_success_unix"),
            changed: value
                .get("changed")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            outcome: text("outcome"),
            detail: text("detail"),
        }
    }
}

/// What one `models sync --json` report added up to.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct Summary {
    pub profiles: usize,
    pub listed: usize,
    pub added: usize,
    pub renamed: usize,
    pub written: usize,
    pub skipped: usize,
    pub failed: usize,
}

impl Summary {
    fn changed(&self) -> bool {
        self.added > 0 || self.renamed > 0
    }

    fn line(&self) -> String {
        if self.profiles == 0 {
            return "no profile carries a provider block".to_string();
        }
        let mut parts = vec![format!("{} profile(s)", self.profiles)];
        if self.listed > 0 {
            parts.push(format!("{} listed", self.listed));
        }
        if self.added > 0 {
            parts.push(format!("{} added", self.added));
        }
        if self.renamed > 0 {
            parts.push(format!("{} renamed", self.renamed));
        }
        if self.skipped > 0 {
            parts.push(format!("{} skipped", self.skipped));
        }
        if self.failed > 0 {
            parts.push(format!("{} failed", self.failed));
        }
        if !self.changed() && self.failed == 0 {
            parts.push("up to date".to_string());
        }
        parts.join(", ")
    }
}

/// Why the schedule did or did not run a refresh.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Decision {
    Disabled,
    NotDue,
    Run,
}

/// The whole schedule decision, kept pure so every branch is testable.
fn decide(enabled: bool, state: &State, now: u64, interval: Duration) -> Decision {
    if !enabled {
        return Decision::Disabled;
    }
    if due(state, now, interval) {
        Decision::Run
    } else {
        Decision::NotDue
    }
}

/// True when the interval since the last attempt has elapsed. An unrecorded or
/// unreadable attempt counts as due: the schedule must not wedge itself.
fn due(state: &State, now: u64, interval: Duration) -> bool {
    state
        .last_attempt_unix
        .is_none_or(|last| now.saturating_sub(last) >= interval.as_secs())
}

/// `RDSH_MODELS_AUTO_INTERVAL_HOURS` clamped to at least one hour.
fn interval_hours_from(raw: Option<&str>) -> u64 {
    raw.and_then(|value| value.trim().parse::<u64>().ok())
        .map_or(DEFAULT_INTERVAL_HOURS, |hours| {
            hours.max(MIN_INTERVAL_HOURS)
        })
}

fn interval() -> Duration {
    let raw = std::env::var(INTERVAL_ENV).ok();
    Duration::from_secs(interval_hours_from(raw.as_deref()).saturating_mul(3600))
}

/// The feature switch plus the kill switch.
fn enabled(cfg: &RdshSettings) -> bool {
    std::env::var_os(DISABLE_ENV).is_none() && feature_enabled(cfg, FEATURE)
}

fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or(0)
}

fn state_path() -> PathBuf {
    PathBuf::from(dsh_home()).join("cache").join(STATE_NAME)
}

/// Where the profiles the sync would rewrite live.
fn profiles_root() -> PathBuf {
    PathBuf::from(dsh_home()).join("profiles")
}

fn read_state(path: &Path) -> State {
    let Ok(metadata) = std::fs::metadata(path) else {
        return State::default();
    };
    if !metadata.is_file() || metadata.len() > MAX_STATE_BYTES {
        return State::default();
    }
    match std::fs::read_to_string(path) {
        Ok(text) => serde_json::from_str::<Value>(&text)
            .map_or_else(|_| State::default(), |value| State::from_json(&value)),
        Err(_) => State::default(),
    }
}

fn write_state(path: &Path, state: &State) -> Result<()> {
    let text = format!("{}\n", serde_json::to_string_pretty(&state.to_json())?);
    // `write_creds` is the repository's atomic sibling-temp-and-rename write,
    // which is what the state needs; it holds no credential.
    crate::auth::write_creds(&path.display().to_string(), &text)
}

/// The launcher's only entry point: cheap, silent and never fatal.
pub(crate) fn maybe_spawn(cfg: &RdshSettings, dry_run: bool) {
    if dry_run {
        return;
    }
    let path = state_path();
    let state = read_state(&path);
    if decide(enabled(cfg), &state, now_unix(), interval()) != Decision::Run {
        return;
    }
    let Ok(exe) = std::env::current_exe() else {
        return;
    };
    let _ = spawn_detached(&exe, &["models", "auto", "--quiet"]);
}

/// Start the refresh without holding the terminal, a pipe or the boot path.
#[cfg(unix)]
fn spawn_detached(exe: &Path, args: &[&str]) -> std::io::Result<()> {
    use std::os::unix::process::CommandExt;
    let mut command = Command::new(exe);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    // SAFETY: the hook calls only setsid(2), which touches no memory shared
    // with the parent and cannot unwind.
    unsafe {
        command.pre_exec(|| {
            if libc::setsid() == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    command.spawn().map(|_child| ())
}

/// Windows counterpart: no console, no inherited handles, own process group.
#[cfg(windows)]
fn spawn_detached(exe: &Path, args: &[&str]) -> std::io::Result<()> {
    use std::os::windows::process::CommandExt;
    const DETACHED_PROCESS: u32 = 0x0000_0008;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    Command::new(exe)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(DETACHED_PROCESS | CREATE_NO_WINDOW)
        .spawn()
        .map(|_child| ())
}

/// `rdsh models sync --json` plus the selectors this run inherited.
fn sync_argv(profile: Option<&str>, provider: Option<&str>, dry_run: bool) -> Vec<String> {
    let mut args: Vec<String> = ["models", "sync", "--json"]
        .iter()
        .map(|arg| (*arg).to_string())
        .collect();
    if let Some(profile) = profile {
        args.push("--profile".to_string());
        args.push(profile.to_string());
    }
    if let Some(provider) = provider {
        args.push("--provider".to_string());
        args.push(provider.to_string());
    }
    if dry_run {
        args.push("--dry-run".to_string());
    }
    args
}

/// Run the sync in its own process: `cmd_models_sync` ends a failed run with
/// `exit(1)`, which must not take the scheduling process down with it.
fn run_sync(args: &[String]) -> Result<Output> {
    let exe = std::env::current_exe().context("cannot resolve the running rdsh executable")?;
    Command::new(exe)
        .args(args)
        .stdin(Stdio::null())
        .output()
        .context("cannot run `rdsh models sync`")
}

/// Add up one `models sync --json` report; a shape we do not understand is an
/// error rather than a silent "nothing changed".
fn summarize(report: &Value) -> Result<Summary> {
    let profiles = report
        .get("profiles")
        .and_then(Value::as_array)
        .context("the sync report carries no profiles array")?;
    let mut summary = Summary {
        profiles: profiles.len(),
        ..Summary::default()
    };
    for entry in profiles {
        let items = |key: &str| {
            entry
                .get(key)
                .and_then(Value::as_array)
                .map_or(0, |values| values.len())
        };
        let present = |key: &str| {
            entry
                .get(key)
                .is_some_and(|value| !value.is_null() && value.as_str() != Some(""))
        };
        summary.listed += entry
            .get("listed")
            .and_then(Value::as_u64)
            .unwrap_or(0)
            .try_into()
            .unwrap_or(0);
        summary.added += items("added");
        summary.renamed += items("renamed");
        summary.written += usize::from(entry.get("written").and_then(Value::as_bool) == Some(true));
        summary.skipped += usize::from(present("skipped"));
        summary.failed += usize::from(present("error"));
    }
    Ok(summary)
}

fn summarize_stdout(stdout: &[u8]) -> Result<Summary> {
    let report: Value =
        serde_json::from_slice(stdout).context("the sync report is not valid JSON")?;
    summarize(&report)
}

fn tail_error(output: &Output) -> Option<String> {
    let stderr = String::from_utf8_lossy(&output.stderr);
    let trimmed = stderr.trim();
    let text = if trimmed.is_empty() {
        format!(
            "`rdsh models sync` exited with {}",
            output.status.code().unwrap_or(-1)
        )
    } else {
        trimmed.chars().take(MAX_ERROR_CHARS).collect()
    };
    Some(text)
}

/// Human form of the gap since the last attempt ("3h ago").
fn ago(now: u64, then: u64) -> String {
    let seconds = now.saturating_sub(then);
    if seconds >= 86_400 {
        format!("{}d ago", seconds / 86_400)
    } else if seconds >= 3_600 {
        format!("{}h ago", seconds / 3_600)
    } else if seconds >= 60 {
        format!("{}m ago", seconds / 60)
    } else {
        format!("{seconds}s ago")
    }
}

/// `rdsh models auto`: apply the schedule once, by hand or from a timer.
pub(crate) fn cmd_models_auto(
    cfg: &RdshSettings,
    profile: Option<&str>,
    provider: Option<&str>,
    force: bool,
    dry_run: bool,
    json_out: bool,
    quiet: bool,
) -> Result<()> {
    let path = state_path();
    let now = now_unix();
    if !enabled(cfg) {
        return finish(
            json_out,
            quiet,
            false,
            json!({
                "enabled": false,
                "ran": false,
                "reason": "disabled",
                "hint": "enable with: rdsh features on models_auto",
                "state_path": path.display().to_string(),
            }),
            "[rdsh] models auto is off (enable with: rdsh features on models_auto)".to_string(),
        );
    }

    // The lock spans the due-check, the refresh and the state write: a second
    // launch (or a timer) waits here, then sees the fresh state and exits.
    let _lock = FileLock::exclusive_for(&path)?;

    let previous = read_state(&path);
    let gap = interval();
    if !force && decide(true, &previous, now, gap) == Decision::NotDue {
        let detail = previous
            .last_attempt_unix
            .map(|last| format!("last attempt {}", ago(now, last)))
            .unwrap_or_else(|| "no attempt recorded".to_string());
        return finish(
            json_out,
            quiet,
            false,
            json!({
                "enabled": true,
                "ran": false,
                "reason": "not_due",
                "detail": detail,
                "state": previous.to_json(),
                "interval_seconds": gap.as_secs(),
                "state_path": path.display().to_string(),
                "hint": "run again with --force",
            }),
            format!("[rdsh] models auto: not due ({detail}); use --force"),
        );
    }

    if !profiles_root().is_dir() {
        // A fresh DSH_HOME has no profile to refresh: nothing to fetch, and
        // nothing worth recording, so the first real launch still refreshes.
        return finish(
            json_out,
            quiet,
            false,
            json!({
                "enabled": true,
                "ran": false,
                "reason": "no_profiles",
                "detail": format!("no profiles under {}", profiles_root().display()),
                "state_path": path.display().to_string(),
            }),
            format!(
                "[rdsh] models auto: no profiles under {}",
                profiles_root().display()
            ),
        );
    }

    let args = sync_argv(profile, provider, dry_run);
    let (summary, error) = match run_sync(&args) {
        Ok(output) => {
            let summary = summarize_stdout(&output.stdout);
            match summary {
                Ok(summary) => {
                    let error = if output.status.success() {
                        None
                    } else {
                        tail_error(&output)
                    };
                    (Some(summary), error)
                }
                Err(parse) => (None, Some(format!("{parse:#}"))),
            }
        }
        Err(spawn) => (None, Some(format!("{spawn:#}"))),
    };
    let failed = error.is_some();
    let changed = summary.is_some_and(|summary| summary.changed());
    let detail = match (&summary, &error) {
        (Some(summary), _) => summary.line(),
        (None, Some(error)) => error.clone(),
        (None, None) => String::new(),
    };

    let mut state_error = None;
    if !dry_run {
        let recorded = State {
            last_attempt_unix: Some(now),
            last_success_unix: if failed {
                previous.last_success_unix
            } else {
                Some(now_unix())
            },
            changed,
            outcome: Some(if failed { "failed" } else { "ok" }.to_string()),
            detail: Some(detail.clone()),
        };
        if let Err(write) = write_state(&path, &recorded) {
            state_error = Some(format!("{write:#}"));
        }
    }

    let mut human = format!(
        "[rdsh] models auto: {}{}",
        detail,
        if dry_run { " (dry run)" } else { "" }
    );
    if changed && !dry_run {
        human.push_str("; restart the harness (or reload its config) to pick them up");
    }
    if let Some(state_error) = &state_error {
        human.push_str(&format!("; state not recorded: {state_error}"));
    }
    finish(
        json_out,
        quiet,
        failed,
        json!({
            "enabled": true,
            "ran": true,
            "reason": if dry_run { "dry_run" } else { "due" },
            "changed": changed,
            "detail": detail,
            "failed": failed,
            "summary": summary.map(|summary| json!({
                "profiles": summary.profiles,
                "listed": summary.listed,
                "added": summary.added,
                "renamed": summary.renamed,
                "written": summary.written,
                "skipped": summary.skipped,
                "failed": summary.failed,
            })),
            "command": args.join(" "),
            "state_path": path.display().to_string(),
            "state_error": state_error,
        }),
        human,
    )
}

fn finish(json_out: bool, quiet: bool, failed: bool, value: Value, human: String) -> Result<()> {
    if json_out {
        println!("{}", serde_json::to_string_pretty(&value)?);
    } else if !quiet {
        if failed {
            eprintln!("{human}");
        } else {
            println!("{human}");
        }
    }
    if failed {
        std::process::exit(1);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_file(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("rdsh-models-auto-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("state.json")
    }

    fn recorded(last_attempt_unix: Option<u64>) -> State {
        State {
            last_attempt_unix,
            ..State::default()
        }
    }

    #[test]
    fn an_unrecorded_attempt_is_due() {
        let interval = Duration::from_secs(24 * 3600);
        assert!(due(&State::default(), 1_000_000, interval));
        // An attempt recorded just now is not due again yet.
        assert!(!due(&recorded(Some(1_000_000)), 1_000_000, interval));
    }

    #[test]
    fn the_interval_gates_the_next_attempt() {
        let interval = Duration::from_secs(24 * 3600);
        let state = recorded(Some(1_000_000));
        assert!(!due(&state, 1_000_000 + 23 * 3600, interval));
        assert!(due(&state, 1_000_000 + 24 * 3600, interval));
        // A clock that moved backwards must not wedge the schedule forever.
        assert!(!due(&state, 999_000, interval));
    }

    #[test]
    fn the_interval_override_is_clamped() {
        assert_eq!(interval_hours_from(None), DEFAULT_INTERVAL_HOURS);
        assert_eq!(interval_hours_from(Some("6")), 6);
        assert_eq!(interval_hours_from(Some(" 12 ")), 12);
        assert_eq!(interval_hours_from(Some("0")), MIN_INTERVAL_HOURS);
        assert_eq!(interval_hours_from(Some("")), DEFAULT_INTERVAL_HOURS);
        assert_eq!(interval_hours_from(Some("soon")), DEFAULT_INTERVAL_HOURS);
    }

    #[test]
    fn the_decision_covers_disabled_not_due_and_run() {
        let interval = Duration::from_secs(3600);
        let stale = recorded(Some(1_000));
        let fresh = recorded(Some(199_500));
        assert_eq!(decide(false, &stale, 200_000, interval), Decision::Disabled);
        assert_eq!(decide(true, &fresh, 200_000, interval), Decision::NotDue);
        assert_eq!(decide(true, &stale, 200_000, interval), Decision::Run);
        assert_eq!(
            decide(true, &State::default(), 200_000, interval),
            Decision::Run
        );
    }

    #[test]
    fn corrupt_or_oversized_state_reads_as_unrecorded() {
        let path = temp_file("corrupt");
        std::fs::write(&path, "{not json").unwrap();
        assert_eq!(read_state(&path), State::default());
        std::fs::write(&path, "\"text\"").unwrap();
        assert_eq!(read_state(&path), State::default());
        std::fs::write(&path, "null").unwrap();
        assert_eq!(read_state(&path), State::default());
        std::fs::write(&path, vec![b'x'; (MAX_STATE_BYTES + 1) as usize]).unwrap();
        assert_eq!(read_state(&path), State::default());
        // A directory in place of the file is not a state either.
        let dir = path.parent().unwrap().join("as-dir");
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(read_state(&dir), State::default());
        // A missing file is the first-run case.
        assert_eq!(
            read_state(&path.parent().unwrap().join("absent.json")),
            State::default()
        );
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn state_round_trips_and_tolerates_unknown_fields() {
        let path = temp_file("roundtrip");
        let state = State {
            last_attempt_unix: Some(1_700_000_000),
            last_success_unix: Some(1_699_999_000),
            changed: true,
            outcome: Some("ok".to_string()),
            detail: Some("2 profile(s), 3 added".to_string()),
        };
        write_state(&path, &state).unwrap();
        assert_eq!(read_state(&path), state);
        assert_eq!(state.to_json()["schema"], 1);

        std::fs::write(
            &path,
            r#"{"schema":1,"last_attempt_unix":"soon","changed":"yes","extra":1}"#,
        )
        .unwrap();
        let tolerant = read_state(&path);
        assert_eq!(tolerant.last_attempt_unix, None);
        assert!(!tolerant.changed);
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn the_sync_report_is_summarized() {
        let report = serde_json::json!({
            "dry_run": false,
            "profiles": [
                {"profile":"web","provider":"openai-codex","listed":10,"added":["gpt-6.1-sol"],"renamed":[],"written":true,"skipped":null,"error":null},
                {"profile":"web","provider":"kimi-coding","listed":4,"added":[],"renamed":["kimi-for-coding"],"written":true,"skipped":null,"error":null},
                {"profile":"tui","provider":"openai-codex","listed":8,"added":[],"renamed":[],"written":false,"skipped":"no apiKeyEnv","error":null},
                {"profile":"tui","provider":"kimi-coding","listed":0,"added":[],"renamed":[],"written":false,"skipped":null,"error":"cannot write"}
            ]
        });
        let summary = summarize(&report).unwrap();
        assert_eq!(summary.profiles, 4);
        assert_eq!(summary.listed, 22);
        assert_eq!(summary.added, 1);
        assert_eq!(summary.renamed, 1);
        assert_eq!(summary.written, 2);
        assert_eq!(summary.skipped, 1);
        assert_eq!(summary.failed, 1);
        assert!(summary.changed());
        assert!(summary.line().contains("1 added"));
        assert!(summary.line().contains("1 renamed"));
    }

    #[test]
    fn an_empty_report_is_not_a_change() {
        let summary = summarize(&serde_json::json!({"profiles": []})).unwrap();
        assert_eq!(summary, Summary::default());
        assert!(!summary.changed());
        assert_eq!(summary.line(), "no profile carries a provider block");

        let up_to_date = summarize(&serde_json::json!({
            "profiles": [{"profile":"web","provider":"openai-codex","listed":10,"added":[],"renamed":[],"written":false}]
        }))
        .unwrap();
        assert!(!up_to_date.changed());
        assert!(up_to_date.line().contains("up to date"));
        assert!(summarize(&serde_json::json!({"dry_run": false})).is_err());
    }

    #[test]
    fn the_sync_command_carries_the_selectors() {
        assert_eq!(sync_argv(None, None, false), ["models", "sync", "--json"]);
        assert_eq!(
            sync_argv(Some("web"), Some("openai-codex"), true),
            [
                "models",
                "sync",
                "--json",
                "--profile",
                "web",
                "--provider",
                "openai-codex",
                "--dry-run"
            ]
        );
    }

    #[test]
    fn the_gap_reads_in_human_units() {
        assert_eq!(ago(1_000, 1_000), "0s ago");
        assert_eq!(ago(1_000 + 90, 1_000), "1m ago");
        assert_eq!(ago(1_000 + 3 * 3600, 1_000), "3h ago");
        assert_eq!(ago(1_000 + 2 * 86_400, 1_000), "2d ago");
    }
}
