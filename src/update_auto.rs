//! One-command control of the rdsh auto-update timer.
//!
//! The repository ships `systemd/rdsh-sync.{service,timer}`, but they are
//! templates: the service points `ExecStart` at the machine the unit was
//! written on, and nothing installed or enabled them, so a published release
//! was only picked up when someone ran `sync-dsh.sh` by hand.
//!
//! This command closes that gap. It writes the two units with the sync script
//! path resolved for this machine and hands them to the user's systemd
//! instance:
//!
//! * `rdsh update auto status` — where the units live, which script they run,
//!   and whether the timer is enabled and active.
//! * `rdsh update auto on` — write the units, `daemon-reload`, then
//!   `enable --now rdsh-sync.timer`.
//! * `rdsh update auto off` — `disable --now`, then remove the units.
//!
//! The script path comes from `RDSH_SYNC_SCRIPT`, else the checkout that holds
//! this binary's sources (`RDSH_SOURCE_DIR`, else the directory above the
//! running executable when it contains `sync-dsh.sh`). Nothing is written when
//! the script cannot be found: a timer that silently fails every day is worse
//! than no timer.
//!
//! `--dry-run` prints the plan without touching the filesystem or systemd, and
//! `RDSH_SYSTEMD_DIR` redirects the unit directory (used by the tests and by
//! anyone running an unsupported init system).

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{bail, Context, Result};
use serde_json::json;

/// Unit name of the timer; the service is its `Service` counterpart.
const TIMER: &str = "rdsh-sync.timer";
const SERVICE: &str = "rdsh-sync.service";

/// Where the user units live, unless the caller redirects them.
fn unit_directory() -> PathBuf {
    if let Some(dir) = std::env::var_os("RDSH_SYSTEMD_DIR") {
        return PathBuf::from(dir);
    }
    let base = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".config")))
        .unwrap_or_else(|| PathBuf::from(".config"));
    base.join("systemd/user")
}

/// The sync script this installation should run.
fn sync_script() -> Option<PathBuf> {
    let candidates = [
        std::env::var_os("RDSH_SYNC_SCRIPT").map(PathBuf::from),
        std::env::var_os("RDSH_SOURCE_DIR").map(|dir| PathBuf::from(dir).join("sync-dsh.sh")),
        std::env::current_exe().ok().and_then(|exe| {
            exe.parent()
                .and_then(|bin| bin.parent())
                .map(|root| root.join("sync-dsh.sh"))
        }),
    ];
    candidates
        .into_iter()
        .flatten()
        .find(|candidate| candidate.is_file())
}

fn service_unit(script: &Path) -> String {
    format!(
        "[Unit]\n\
         Description=rdsh dsh auto-update (check upstream, update, verify, roll back)\n\
         \n\
         [Service]\n\
         Type=oneshot\n\
         # Low-spec hosts: never steal the machine during auto-update.\n\
         Nice=19\n\
         IOSchedulingClass=idle\n\
         CPUWeight=10\n\
         ExecStart={}\n",
        exec_start_path(script)
    )
}

/// Quote for systemd's command-line syntax.
fn exec_start_path(script: &Path) -> String {
    let mut quoted = String::from("\"");
    for character in script.display().to_string().chars() {
        match character {
            '"' | '\\' => {
                quoted.push('\\');
                quoted.push(character);
            }
            '%' => quoted.push_str("%%"),
            _ => quoted.push(character),
        }
    }
    quoted.push('"');
    quoted
}

fn timer_unit() -> String {
    "[Unit]\n\
     Description=Daily dsh auto-update check for rdsh\n\
     \n\
     [Timer]\n\
     OnCalendar=daily\n\
     RandomizedDelaySec=1800\n\
     Persistent=true\n\
     \n\
     [Install]\n\
     WantedBy=timers.target\n"
        .to_string()
}

/// True when systemctl must not be called (tests, containers, other init
/// systems). The units are still written, so the operator keeps the file plan.
fn systemctl_skipped() -> bool {
    std::env::var_os("RDSH_SYSTEMD_NO_RELOAD").is_some_and(|value| value == "1")
}

fn systemctl(args: &[&str]) -> Result<String> {
    let output = Command::new("systemctl")
        .arg("--user")
        .args(args)
        .output()
        .with_context(|| format!("running systemctl --user {}", args.join(" ")))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        bail!(
            "systemctl --user {} failed: {}",
            args.join(" "),
            stderr.trim()
        );
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn systemctl_read(args: &[&str]) -> String {
    Command::new("systemctl")
        .arg("--user")
        .args(args)
        .output()
        .ok()
        .map(|out| String::from_utf8_lossy(&out.stdout).trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "unknown".to_string())
}

fn status(json: bool) -> Result<()> {
    let directory = unit_directory();
    let script = sync_script();
    let installed = directory.join(TIMER).is_file() && directory.join(SERVICE).is_file();
    let state = json!({
        "unit_directory": directory.display().to_string(),
        "sync_script": script.as_ref().map(|path| path.display().to_string()),
        "installed": installed,
        "enabled": if installed { systemctl_read(&["is-enabled", TIMER]) } else { "not-installed".into() },
        "active": if installed { systemctl_read(&["is-active", TIMER]) } else { "not-installed".into() },
    });
    if json {
        println!("{}", serde_json::to_string_pretty(&state)?);
    } else {
        println!("units:   {}", directory.display());
        println!(
            "script:  {}",
            script
                .as_ref()
                .map(|path| path.display().to_string())
                .unwrap_or_else(|| "(not found; set RDSH_SYNC_SCRIPT)".to_string())
        );
        println!("installed: {}", if installed { "yes" } else { "no" });
        if installed {
            println!(
                "enabled: {}",
                state["enabled"].as_str().unwrap_or("unknown")
            );
            println!("active:  {}", state["active"].as_str().unwrap_or("unknown"));
        }
    }
    Ok(())
}

/// Turn the timer on. Returns the plan that was applied so `--dry-run` and
/// callers share one code path.
fn enable(dry_run: bool, json: bool) -> Result<()> {
    let directory = unit_directory();
    let Some(script) = sync_script() else {
        bail!(
            "sync-dsh.sh was not found; set RDSH_SYNC_SCRIPT=/path/to/sync-dsh.sh \
             (a timer that cannot run the updater would fail silently every day)"
        );
    };
    let service = directory.join(SERVICE);
    let timer = directory.join(TIMER);
    if !dry_run {
        fs::create_dir_all(&directory)
            .with_context(|| format!("creating {}", directory.display()))?;
        fs::write(&service, service_unit(&script))
            .with_context(|| format!("writing {}", service.display()))?;
        fs::write(&timer, timer_unit()).with_context(|| format!("writing {}", timer.display()))?;
        if !systemctl_skipped() {
            systemctl(&["daemon-reload"])?;
            systemctl(&["enable", "--now", TIMER])?;
        }
    }
    let result = json!({
        "service": service.display().to_string(),
        "timer": timer.display().to_string(),
        "sync_script": script.display().to_string(),
        "dry_run": dry_run,
        "enabled": !dry_run,
        "systemctl": if dry_run || systemctl_skipped() { "skipped" } else { "applied" },
    });
    if json {
        println!("{}", serde_json::to_string_pretty(&result)?);
    } else if dry_run {
        println!("would write: {}", service.display());
        println!("would write: {}", timer.display());
        println!("would run:   systemctl --user enable --now {TIMER}");
        println!("script:      {}", script.display());
    } else {
        println!("auto-update enabled: {} (daily)", timer.display());
        println!("script: {}", script.display());
        println!("check with: rdsh update auto status");
    }
    Ok(())
}

fn disable(dry_run: bool, json: bool) -> Result<()> {
    let directory = unit_directory();
    let service = directory.join(SERVICE);
    let timer = directory.join(TIMER);
    let installed = timer.is_file() || service.is_file();
    if !dry_run && installed {
        // A timer that is not loaded cannot be disabled; ignore that case so an
        // interrupted install can still be cleaned up.
        if !systemctl_skipped() {
            let _ = systemctl(&["disable", "--now", TIMER]);
        }
        for path in [&timer, &service] {
            if path.is_file() {
                fs::remove_file(path).with_context(|| format!("removing {}", path.display()))?;
            }
        }
        if !systemctl_skipped() {
            systemctl(&["daemon-reload"])?;
        }
    }
    let result = json!({
        "timer": timer.display().to_string(),
        "service": service.display().to_string(),
        "dry_run": dry_run,
        "removed": installed && !dry_run,
    });
    if json {
        println!("{}", serde_json::to_string_pretty(&result)?);
    } else if dry_run {
        println!(
            "would remove: {} and {}",
            timer.display(),
            service.display()
        );
    } else if installed {
        println!("auto-update disabled and units removed");
    } else {
        println!("auto-update was not installed");
    }
    Ok(())
}

/// Entry point behind `rdsh update auto ...`.
pub(crate) fn cmd_update_auto(action: &str, dry_run: bool, json: bool) -> Result<()> {
    match action {
        "status" => status(json),
        "on" => enable(dry_run, json),
        "off" => disable(dry_run, json),
        other => bail!("unknown action {other:?}: use status, on or off"),
    }
}
