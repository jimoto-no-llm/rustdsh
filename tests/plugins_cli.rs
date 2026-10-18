use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::sync::atomic::{AtomicUsize, Ordering};

static NEXT_FIXTURE: AtomicUsize = AtomicUsize::new(0);

/// rdsh-settings and one upstream tool are attached; the rest of the essential
/// tier is missing, which is the state an upgraded install was left in.
const PARTIAL_MANIFEST: &str = r#"{
  "name": "dsh-profile-web",
  "private": true,
  "dependencies": {
    "rdsh-settings": "link:/checkout/plugins/rdsh-settings",
    "@deepseek-ai/dsh-tool-present": "0.2.0"
  },
  "dsh": { "profile": { "bundles": ["rdsh-settings"] } }
}"#;

struct Fixture {
    root: PathBuf,
    checkout: PathBuf,
}

impl Fixture {
    fn new(profile: &str, manifest: Option<&str>) -> Self {
        let id = NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed);
        let root =
            std::env::temp_dir().join(format!("rdsh-plugins-cli-{}-{id}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let profile_dir = root.join("dsh").join("profiles").join(profile);
        std::fs::create_dir_all(&profile_dir).unwrap();
        if let Some(text) = manifest {
            std::fs::write(profile_dir.join("package.json"), text).unwrap();
        }
        // A fake dsh CLI that records every plugin add it is asked to run. The
        // tests that execute it are Unix-only: the shim is a POSIX shell script,
        // so a Windows run keeps the report and dry-run contracts instead.
        #[cfg(unix)]
        {
            let bin = root.join("bin");
            std::fs::create_dir_all(&bin).unwrap();
            let recorder = bin.join("dsh");
            std::fs::write(
                &recorder,
                format!(
                    "#!/bin/sh\nprintf '%s\\n' \"$*\" >> '{}'\n",
                    root.join("calls.txt").display()
                ),
            )
            .unwrap();
            make_executable(&recorder);
        }
        Self {
            root,
            checkout: Path::new(env!("CARGO_MANIFEST_DIR")).join("plugins"),
        }
    }

    fn command(&self, args: &[&str]) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_rdsh"));
        command.env_clear();
        command
            .args(args)
            .current_dir(&self.root)
            .env("HOME", &self.root)
            .env("USERPROFILE", &self.root)
            .env("DSH_HOME", self.root.join("dsh"))
            .env("PATH", self.root.join("bin"))
            .env("RDSH_PLUGINS_DIR", &self.checkout);
        command
    }

    fn run(&self, args: &[&str]) -> Output {
        self.command(args).output().unwrap()
    }

    fn calls(&self) -> Vec<String> {
        std::fs::read_to_string(self.root.join("calls.txt"))
            .map(|text| text.lines().map(str::to_string).collect())
            .unwrap_or_default()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

#[cfg(unix)]
fn make_executable(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
}

fn json(output: &Output) -> serde_json::Value {
    serde_json::from_slice(&output.stdout).unwrap_or_else(|error| {
        panic!(
            "not JSON ({error}): {}\nstderr: {}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        )
    })
}

fn status_json(fixture: &Fixture, profile: &str) -> serde_json::Value {
    let output = fixture.run(&["plugins", "status", "--profile", profile, "--json"]);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    json(&output)
}

fn row<'a>(report: &'a serde_json::Value, tier: &str, package: &str) -> &'a serde_json::Value {
    report[tier]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["package"].as_str() == Some(package))
        .unwrap_or_else(|| panic!("{package} missing from the {tier} tier"))
}

fn specs(output: &Output) -> Vec<String> {
    json(output)["actions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|action| action["spec"].as_str().unwrap().to_string())
        .collect()
}

#[test]
fn status_reports_installed_enabled_and_missing_essential_packages() {
    let fixture = Fixture::new("web", Some(PARTIAL_MANIFEST));
    let report = status_json(&fixture, "web");
    assert_eq!(report["schema"], 1);
    assert_eq!(report["profile"], "web");
    assert_eq!(report["initialized"], true);
    assert_eq!(report["ok"], false);
    assert_eq!(report["essential"].as_array().unwrap().len(), 11);
    assert_eq!(
        row(&report, "essential", "rdsh-settings")["installed"],
        true
    );
    assert_eq!(row(&report, "essential", "rdsh-settings")["enabled"], true);
    assert_eq!(
        row(&report, "essential", "@deepseek-ai/dsh-tool-present")["installed"],
        true
    );
    assert_eq!(
        row(&report, "essential", "rdsh-answer-guard")["state"],
        "missing"
    );
    // 11 essentials on web, 2 already attached.
    assert_eq!(report["missing_essential"].as_array().unwrap().len(), 9);
}

#[test]
fn status_keeps_the_web_only_banner_out_of_other_profiles() {
    let fixture = Fixture::new("headless", Some("{}"));
    let report = status_json(&fixture, "headless");
    assert_eq!(report["essential"].as_array().unwrap().len(), 10);
    assert!(!report["essential"]
        .as_array()
        .unwrap()
        .iter()
        .any(|entry| entry["package"].as_str() == Some("rdsh-update-banner")));
}

#[test]
fn an_uninitialized_profile_reports_every_essential_as_missing() {
    let fixture = Fixture::new("web", None);
    let report = status_json(&fixture, "web");
    assert_eq!(report["initialized"], false);
    assert_eq!(report["missing_essential"].as_array().unwrap().len(), 11);
}

#[test]
fn install_dry_run_lists_the_essential_specs_without_calling_dsh() {
    let fixture = Fixture::new("web", Some("{}"));
    let checkout = fixture.checkout.display().to_string();
    let output = fixture.run(&[
        "plugins",
        "install",
        "--profile",
        "web",
        "--recommended",
        "none",
        "--plugins-dir",
        &checkout,
        "--dry-run",
        "--json",
    ]);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let report = json(&output);
    assert_eq!(report["dry_run"], true);
    assert_eq!(report["command"], "dsh");
    let actions = report["actions"].as_array().unwrap();
    assert_eq!(actions.len(), 11);
    let bundled = actions
        .iter()
        .find(|action| action["package"].as_str() == Some("rdsh-settings"))
        .unwrap();
    let spec = bundled["spec"].as_str().unwrap();
    assert!(spec.ends_with("/plugins/rdsh-settings"), "{spec}");
    // A Windows path separator must never leak into a plugin spec.
    assert!(!spec.contains('\\'), "{spec}");
    assert!(
        fixture.calls().is_empty(),
        "a dry run must not call dsh: {:?}",
        fixture.calls()
    );
}

#[cfg(unix)]
#[test]
fn install_attaches_only_the_missing_packages_through_dsh() {
    let fixture = Fixture::new("web", Some(PARTIAL_MANIFEST));
    let output = fixture.run(&[
        "plugins",
        "install",
        "--profile",
        "web",
        "--recommended",
        "none",
        "--json",
    ]);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let calls = fixture.calls();
    assert_eq!(calls.len(), 9, "{calls:?}");
    assert!(
        !calls.iter().any(|line| line.contains("rdsh-settings")),
        "an attached package must not be added twice: {calls:?}"
    );
    // rdsh-settings and dsh-tool-present are already attached, so the first
    // package the CLI is asked for is the next essential one.
    assert_eq!(
        calls[0],
        "plugin --profile web add @deepseek-ai/dsh-tool-ask-user"
    );
    assert!(calls
        .iter()
        .all(|line| line.starts_with("plugin --profile web add ")));
}

#[test]
fn install_defaults_to_the_starter_set_on_web_and_essential_only_on_headless() {
    let web = Fixture::new("web", Some("{}"));
    let output = web.run(&[
        "plugins",
        "install",
        "--profile",
        "web",
        "--dry-run",
        "--json",
    ]);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let selected = specs(&output);
    assert!(
        selected
            .iter()
            .any(|spec| spec.ends_with("/plugins/rdsh-translation")),
        "{selected:?}"
    );
    assert!(selected
        .iter()
        .any(|spec| spec == "github:cwd514/dsh-sound-notifications"));
    assert!(!selected.iter().any(|spec| spec.contains("rdsh-compute")));

    let headless = Fixture::new("headless", Some("{}"));
    let output = headless.run(&[
        "plugins",
        "install",
        "--profile",
        "headless",
        "--dry-run",
        "--json",
    ]);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    // 7 upstream + 3 bundled, no recommended plugin.
    assert_eq!(specs(&output).len(), 10);
}

#[test]
fn a_missing_checkout_fails_loudly_unless_bundled_plugins_are_declined() {
    let fixture = Fixture::new("web", Some("{}"));
    let mut command = fixture.command(&[
        "plugins",
        "install",
        "--profile",
        "web",
        "--recommended",
        "none",
        "--dry-run",
        "--json",
    ]);
    command.env_remove("RDSH_PLUGINS_DIR");
    let output = command.output().unwrap();
    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("plugin provisioning incomplete"),
        "{stderr}"
    );
    assert!(stderr.contains("rdsh-answer-guard"), "{stderr}");

    let mut command = fixture.command(&[
        "plugins",
        "install",
        "--profile",
        "web",
        "--recommended",
        "none",
        "--no-bundled",
        "--dry-run",
        "--json",
    ]);
    command.env_remove("RDSH_PLUGINS_DIR");
    let output = command.output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let selected = specs(&output);
    assert_eq!(selected.len(), 7);
    assert!(selected
        .iter()
        .all(|spec| spec.starts_with("@deepseek-ai/")));
    assert!(json(&output)["failed"].as_array().unwrap().is_empty());
    // web carries four bundled essentials (the release banner is Web-only).
    assert_eq!(json(&output)["skipped"].as_array().unwrap().len(), 4);
}
