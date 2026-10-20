//! `rdsh update auto` manages the daily auto-update timer without touching the
//! real systemd instance: every test redirects the unit directory, the sync
//! script and the systemctl calls.
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::sync::atomic::{AtomicUsize, Ordering};

static NEXT: AtomicUsize = AtomicUsize::new(0);

struct Fixture(PathBuf);

impl Fixture {
    fn new(with_script: bool) -> Self {
        let root = std::env::temp_dir().join(format!(
            "rdsh-update-auto-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&root).unwrap();
        if with_script {
            let script = root.join("sync-dsh.sh");
            fs::write(&script, "#!/bin/sh\nexit 0\n").unwrap();
        }
        Self(root)
    }

    fn units(&self) -> PathBuf {
        self.0.join("units")
    }

    fn script(&self) -> PathBuf {
        self.0.join("sync-dsh.sh")
    }

    fn run(&self, args: &[&str]) -> Output {
        self.run_with_script(&self.script(), args)
    }

    fn run_with_script(&self, script: &Path, args: &[&str]) -> Output {
        Command::new(env!("CARGO_BIN_EXE_rdsh"))
            .args(args)
            .env("HOME", &self.0)
            .env("XDG_CONFIG_HOME", self.0.join("config"))
            .env("RDSH_SYSTEMD_DIR", self.units())
            .env("RDSH_SYNC_SCRIPT", script)
            // Never talk to the test runner's own systemd instance.
            .env("RDSH_SYSTEMD_NO_RELOAD", "1")
            .env("DSH_HOME", self.0.join("dsh"))
            // The assertions read the English messages; the runner's locale
            // must not decide which language they are written in.
            .env("LC_ALL", "C")
            .env("LANG", "C")
            .output()
            .unwrap()
    }

    fn json(&self, args: &[&str]) -> Value {
        let out = self.run(args);
        assert!(
            out.status.success(),
            "{args:?} failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        serde_json::from_slice(&out.stdout).expect("json output")
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn service_unit(root: &Path) -> String {
    fs::read_to_string(root.join("units/rdsh-sync.service")).unwrap()
}

#[test]
fn status_reports_paths_before_anything_is_installed() {
    let f = Fixture::new(true);
    let value = f.json(&["update", "auto", "status", "--json"]);
    assert_eq!(value["installed"], false);
    assert_eq!(value["unit_directory"], f.units().display().to_string());
    assert_eq!(value["sync_script"], f.script().display().to_string());
    assert_eq!(value["enabled"], "not-installed");
}

#[test]
fn on_writes_units_for_this_machine_then_status_confirms_them() {
    let f = Fixture::new(true);
    let applied = f.json(&["update", "auto", "on", "--json"]);
    assert_eq!(applied["dry_run"], false);
    assert_eq!(applied["enabled"], true);
    assert_eq!(applied["systemctl"], "skipped");

    // The unit must run the script we resolved, not a template path.
    let service = service_unit(&f.0);
    let script = f.script().display().to_string().replace('\\', "\\\\");
    assert!(
        service.contains(&format!("ExecStart=\"{script}\"\n")),
        "{service}"
    );
    assert!(service.contains("Type=oneshot"));
    let timer = fs::read_to_string(f.units().join("rdsh-sync.timer")).unwrap();
    assert!(timer.contains("OnCalendar=daily"));
    assert!(timer.contains("WantedBy=timers.target"));

    let status = f.json(&["update", "auto", "status", "--json"]);
    assert_eq!(status["installed"], true);
}

#[cfg(unix)]
#[test]
fn unit_quotes_a_script_path_with_whitespace_and_percent() {
    let f = Fixture::new(false);
    let script = f.0.join("with space/50%done/sync-dsh.sh");
    fs::create_dir_all(script.parent().unwrap()).unwrap();
    fs::write(&script, "#!/bin/sh\nexit 0\n").unwrap();
    let out = f.run_with_script(&script, &["update", "auto", "on", "--json"]);
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );

    // Unquoted whitespace splits; `%` is a specifier.
    let service = service_unit(&f.0);
    let quoted = script.display().to_string().replace('%', "%%");
    assert!(
        service.contains(&format!("ExecStart=\"{quoted}\"\n")),
        "{service}"
    );
}

#[test]
fn off_removes_the_units_and_is_idempotent() {
    let f = Fixture::new(true);
    f.json(&["update", "auto", "on", "--json"]);
    assert!(f.units().join("rdsh-sync.timer").is_file());

    let removed = f.json(&["update", "auto", "off", "--json"]);
    assert_eq!(removed["removed"], true);
    assert!(!f.units().join("rdsh-sync.timer").exists());
    assert!(!f.units().join("rdsh-sync.service").exists());

    let again = f.json(&["update", "auto", "off", "--json"]);
    assert_eq!(again["removed"], false);
}

#[test]
fn dry_run_plans_without_writing_anything() {
    let f = Fixture::new(true);
    let planned = f.json(&["update", "auto", "on", "--dry-run", "--json"]);
    assert_eq!(planned["dry_run"], true);
    assert_eq!(planned["systemctl"], "skipped");
    assert!(!f.units().exists(), "dry run created the unit directory");
}

#[test]
fn a_missing_updater_is_refused_instead_of_installing_a_dead_timer() {
    let f = Fixture::new(false);
    let out = f.run(&["update", "auto", "on"]);
    assert!(!out.status.success());
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(stderr.contains("sync-dsh.sh was not found"), "{stderr}");
    assert!(!f.units().exists());
}

/// Make `path` writable by group and world, the way an unpacked tarball or a
/// world-writable directory would leave it.
#[cfg(unix)]
fn make_group_and_world_writable(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let mode = fs::metadata(path).unwrap().permissions().mode();
    fs::set_permissions(path, fs::Permissions::from_mode(mode | 0o022)).unwrap();
}

#[cfg(unix)]
#[test]
fn a_group_writable_updater_is_refused_and_no_unit_is_written() {
    let f = Fixture::new(true);
    make_group_and_world_writable(&f.script());
    let out = f.run(&["update", "auto", "on"]);
    assert!(!out.status.success());
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(stderr.contains("group/world-writable"), "{stderr}");
    assert!(
        stderr.contains("--force"),
        "the refusal must point at --force: {stderr}"
    );
    assert!(
        !f.units().exists(),
        "a refused registration must not leave a unit behind"
    );
}

#[cfg(unix)]
#[test]
fn force_registers_a_group_writable_updater() {
    let f = Fixture::new(true);
    make_group_and_world_writable(&f.script());
    let applied = f.json(&["update", "auto", "on", "--force", "--json"]);
    assert_eq!(applied["forced"], true);
    assert!(f.units().join("rdsh-sync.service").is_file());
    assert!(f.units().join("rdsh-sync.timer").is_file());
}

#[cfg(unix)]
#[test]
fn unit_quotes_a_script_path_with_a_dollar_sign() {
    let f = Fixture::new(false);
    let script = f.0.join("cost$5/sync-dsh.sh");
    fs::create_dir_all(script.parent().unwrap()).unwrap();
    fs::write(&script, "#!/bin/sh\nexit 0\n").unwrap();
    let out = f.run_with_script(&script, &["update", "auto", "on", "--json"]);
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );

    // Unescaped, systemd would expand $5 before exec; "$$" is a literal "$".
    let service = service_unit(&f.0);
    let quoted = script.display().to_string().replace('$', "$$");
    assert!(
        service.contains(&format!("ExecStart=\"{quoted}\"\n")),
        "{service}"
    );
}

#[test]
fn unknown_actions_and_arguments_are_rejected() {
    let f = Fixture::new(true);
    let bad = f.run(&["update", "auto", "sometimes"]);
    assert!(!bad.status.success());
    let extra = f.run(&["update", "auto", "status", "--force"]);
    assert!(!extra.status.success());
}
