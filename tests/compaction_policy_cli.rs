//! The compaction policy layer on the real binary, against a stand-in `dsh`
//! that prints a fixture for `--dump-config`, records that it was asked for
//! it, and records its boot arguments.
#![cfg(unix)]

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::process::{Command, Output};

/// `dsh --profile headless --dump-config`, trimmed: the row is top level.
const HEADLESS_DUMP: &str = "\
# == @deepseek-ai/dsh-base
- id: token-meter
  name: '@deepseek-ai/dsh-token-meter'
- id: compaction-basic
  name: '@deepseek-ai/dsh-compaction-basic'
- id: command-compact
  name: '@deepseek-ai/dsh-command-compact'
";

/// `dsh --profile web --dump-config`, trimmed: the top-level row is disabled
/// and the live rows sit inside the agent presets.
const WEB_DUMP: &str = "\
# == @deepseek-ai/dsh-base, patched by @deepseek-ai/dsh-web-app
- id: compaction-basic
  name: '@deepseek-ai/dsh-compaction-basic'
  disabled: true
# == @deepseek-ai/dsh-web-app
- id: preset-standard
  name: '@deepseek-ai/dsh-agent-preset'
  config:
    id: standard
    order: 1
    plugins:
      - id: compaction
        name: cordis:group
        group: true
        config:
          - id: compaction-basic
            name: '@deepseek-ai/dsh-compaction-basic'
          - id: command-compact
            name: '@deepseek-ai/dsh-command-compact'
- id: preset-minimal
  name: '@deepseek-ai/dsh-agent-preset'
  config:
    id: minimal
    plugins:
      - id: compaction
        name: cordis:group
        group: true
        config:
          - id: compaction-basic
            name: '@deepseek-ai/dsh-compaction-basic'
";

const NO_ROW_DUMP: &str = "\
- id: token-meter
  name: '@deepseek-ai/dsh-token-meter'
";

const POLICY: &str = r#"{
  "schema": 1,
  "policies": [
    {
      "provider": "hai",
      "model": "deepseek-v4-flash",
      "context_window": 1000000,
      "output_reserve": 8192,
      "trigger_tokens": 150000,
      "retain_tokens": 20000,
      "max_tokens": 8192
    }
  ]
}"#;

const POLICY_LINES: &str = "\
modelPolicies:
  - provider: 'hai'
    model: 'deepseek-v4-flash'
    thresholdRatio: 1
    headroomTokens: 841808
    retainTokens: 20000
    maxTokens: 8192
";

struct Fixture {
    root: PathBuf,
}

impl Fixture {
    fn new(dump: &str, feature_on: bool) -> Self {
        let mut random = [0u8; 16];
        getrandom::fill(&mut random).unwrap();
        let suffix: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
        let root = std::env::temp_dir().join(format!("rdsh-compaction-policy-{suffix}"));
        fs::create_dir(&root).unwrap();
        fs::create_dir_all(root.join("home/.dsh")).unwrap();
        fs::write(
            root.join("home/.dsh/rdsh.json"),
            format!(
                r#"{{"schema":1,"features":{{"compaction_policy":{feature_on},"web_gzip_level":false,"update_check":false}}}}"#
            ),
        )
        .unwrap();
        fs::write(root.join("dump.yml"), dump).unwrap();
        fs::write(root.join("own.patch.yml"), "- id: own\n").unwrap();
        let script = format!(
            "#!/bin/sh\n\
             for arg in \"$@\"; do\n\
             \x20 if [ \"$arg\" = \"--dump-config\" ]; then\n\
             \x20   : > '{root}/dumped'; cat '{root}/dump.yml'; exit 0\n\
             \x20 fi\n\
             done\n\
             printf '%s\\n' \"$@\" > '{root}/args.txt'\n",
            root = root.display()
        );
        let dsh = root.join("fake-dsh");
        fs::write(&dsh, script).unwrap();
        fs::set_permissions(&dsh, fs::Permissions::from_mode(0o755)).unwrap();
        // A boot refuses to start without a Node runtime on PATH. The stand-in
        // `dsh` is a shell script, so this `node` is only looked up, never run.
        fs::create_dir(root.join("bin")).unwrap();
        let node = root.join("bin/node");
        fs::write(&node, "#!/bin/sh\nexit 0\n").unwrap();
        fs::set_permissions(&node, fs::Permissions::from_mode(0o755)).unwrap();
        Self { root }
    }

    fn dsh_home(&self) -> PathBuf {
        self.root.join("home/.dsh")
    }

    fn write_policy(&self, text: &str) {
        fs::write(self.dsh_home().join("rdsh-compaction.json"), text).unwrap();
    }

    fn overlay_path(&self) -> PathBuf {
        fs::read_dir(self.dsh_home().join("compaction"))
            .ok()
            .and_then(|entries| {
                entries
                    .filter_map(Result::ok)
                    .map(|e| e.path())
                    .find(|p| p.extension().is_some_and(|e| e == "yml"))
            })
            .unwrap_or_else(|| self.dsh_home().join("compaction/not-created.patch.yml"))
    }

    fn own_patch(&self) -> String {
        self.root.join("own.patch.yml").display().to_string()
    }

    /// The real binary in the fixture's environment, pinned to English.
    fn rdsh(&self) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_rdsh"));
        command
            .env_clear()
            .current_dir(&self.root)
            .env("HOME", self.root.join("home"))
            .env("XDG_CONFIG_HOME", self.root.join("config"))
            .env("XDG_DATA_HOME", self.root.join("data"))
            .env("XDG_CACHE_HOME", self.root.join("cache"))
            .env("DSH_HOME", self.dsh_home())
            .env(
                "PATH",
                format!("{}:/usr/bin:/bin", self.root.join("bin").display()),
            )
            .env("RDSH_AUTH_AUTOSYNC", "0")
            .env("RDSH_LANG", "en")
            .env("RDSH_ORIG_BIN", self.root.join("fake-dsh"));
        command
    }

    fn boot(&self, profile: &str, extra: &[&str]) -> Output {
        self.rdsh()
            .args(extra)
            .args(["--no-slim", "--profile", profile, "--patch"])
            .arg(self.own_patch())
            .output()
            .unwrap()
    }

    fn doctor(&self, extra: &[&str]) -> Output {
        self.rdsh().arg("doctor").args(extra).output().unwrap()
    }

    /// True when the stand-in `dsh` was asked to compose a profile.
    fn composed_a_profile(&self) -> bool {
        self.root.join("dumped").exists()
    }

    /// Arguments the stand-in `dsh` was booted with, or `None` when it never ran.
    fn boot_args(&self) -> Option<Vec<String>> {
        let text = fs::read_to_string(self.root.join("args.txt")).ok()?;
        Some(text.lines().map(str::to_string).collect())
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn stderr(output: &Output) -> String {
    String::from_utf8_lossy(&output.stderr).to_string()
}

fn stdout(output: &Output) -> String {
    String::from_utf8_lossy(&output.stdout).to_string()
}

/// True when rdsh found no Node runtime it accepts here. The in-crate boot
/// tests skip in that case, and so do these.
fn no_node_runtime(output: &Output) -> bool {
    stderr(output).contains("compatible Node runtime is required")
}

fn patches(args: &[String]) -> Vec<String> {
    args.windows(2)
        .filter(|pair| pair[0] == "--patch")
        .map(|pair| pair[1].clone())
        .collect()
}

#[test]
fn headless_boot_gets_the_policy_overlay_before_the_users_patch() {
    let fixture = Fixture::new(HEADLESS_DUMP, true);
    fixture.write_policy(POLICY);
    let output = fixture.boot("headless", &[]);
    if no_node_runtime(&output) {
        return;
    }
    assert!(output.status.success(), "{}", stderr(&output));

    let args = fixture.boot_args().expect("the stand-in dsh was booted");
    assert_eq!(
        patches(&args),
        vec![
            fixture.overlay_path().display().to_string(),
            fixture.own_patch()
        ],
        "generated layer first, the caller's patch last"
    );
    assert!(
        stderr(&output).contains("[rdsh] compaction: policy overlay applied (1 rows)"),
        "{}",
        stderr(&output)
    );

    let indented: String = POLICY_LINES
        .lines()
        .map(|line| format!("    {line}\n"))
        .collect();
    assert_eq!(
        fs::read_to_string(fixture.overlay_path()).unwrap(),
        format!("- id: compaction-basic\n  config:\n{indented}")
    );
}

#[test]
fn web_boot_restates_each_preset_with_the_policies() {
    let fixture = Fixture::new(WEB_DUMP, true);
    fixture.write_policy(POLICY);
    let output = fixture.boot("web", &[]);
    if no_node_runtime(&output) {
        return;
    }
    assert!(output.status.success(), "{}", stderr(&output));
    assert!(
        stderr(&output).contains("[rdsh] compaction: policy overlay applied (2 rows)"),
        "{}",
        stderr(&output)
    );

    let overlay = fs::read_to_string(fixture.overlay_path()).unwrap();
    assert!(overlay.starts_with("- id: preset-standard\n  config:\n    id: standard\n"));
    assert!(overlay.contains("\n- id: preset-minimal\n  config:\n    id: minimal\n"));
    let indented: String = POLICY_LINES
        .lines()
        .map(|line| format!("              {line}\n"))
        .collect();
    let under_the_row = format!(
        "          - id: compaction-basic\n            name: '@deepseek-ai/dsh-compaction-basic'\n            config:\n{indented}"
    );
    assert_eq!(overlay.matches(&under_the_row).count(), 2, "{overlay}");
    // The disabled top-level row is not patched.
    assert!(!overlay.contains("- id: compaction-basic\n  config:"));
}

#[test]
fn feature_off_leaves_the_boot_untouched() {
    let fixture = Fixture::new(HEADLESS_DUMP, false);
    fixture.write_policy(POLICY);
    let output = fixture.boot("headless", &[]);
    if no_node_runtime(&output) {
        return;
    }
    assert!(output.status.success(), "{}", stderr(&output));
    let args = fixture.boot_args().expect("the stand-in dsh was booted");
    assert_eq!(patches(&args), vec![fixture.own_patch()]);
    assert!(
        !stderr(&output).contains("compaction"),
        "{}",
        stderr(&output)
    );
    assert!(!fixture.overlay_path().exists());
}

#[test]
fn no_policy_file_is_silent() {
    let fixture = Fixture::new(HEADLESS_DUMP, true);
    let output = fixture.boot("headless", &[]);
    if no_node_runtime(&output) {
        return;
    }
    assert!(output.status.success(), "{}", stderr(&output));
    let args = fixture.boot_args().expect("the stand-in dsh was booted");
    assert_eq!(patches(&args), vec![fixture.own_patch()]);
    assert!(
        !stderr(&output).contains("compaction"),
        "{}",
        stderr(&output)
    );
}

#[test]
fn a_bad_opted_in_policy_file_blocks_boot_before_any_request() {
    let fixture = Fixture::new(HEADLESS_DUMP, true);
    fixture.write_policy(r#"{"schema":1,"policies":[{"provider":"hai"}]}"#);
    let output = fixture.boot("headless", &[]);
    if no_node_runtime(&output) {
        return;
    }
    assert!(!output.status.success(), "{}", stderr(&output));
    assert!(fixture.boot_args().is_none());
    assert!(
        stderr(&output).contains("policies[0] needs a string \"model\""),
        "{}",
        stderr(&output)
    );
    assert!(!fixture.overlay_path().exists());
}

#[test]
fn a_profile_without_a_compaction_row_is_reported() {
    let fixture = Fixture::new(NO_ROW_DUMP, true);
    fixture.write_policy(POLICY);
    let output = fixture.boot("headless", &[]);
    if no_node_runtime(&output) {
        return;
    }
    assert!(output.status.success(), "{}", stderr(&output));
    let args = fixture.boot_args().expect("the boot still happened");
    assert_eq!(patches(&args), vec![fixture.own_patch()]);
    assert!(
        stderr(&output).contains(
            "[rdsh] compaction: policy overlay skipped: the profile has no compaction row that can be configured"
        ),
        "{}",
        stderr(&output)
    );
}

#[test]
fn dry_run_writes_nothing() {
    let fixture = Fixture::new(HEADLESS_DUMP, true);
    fixture.write_policy(POLICY);
    let output = fixture.boot("headless", &["--dry-run"]);
    assert!(output.status.success(), "{}", stderr(&output));
    assert_eq!(fixture.boot_args(), None, "a dry run does not boot dsh");
    assert!(!fixture.overlay_path().exists());
    assert!(
        !stderr(&output).contains("compaction"),
        "{}",
        stderr(&output)
    );
}

#[test]
fn doctor_shows_the_routes_without_composing_a_profile() {
    let fixture = Fixture::new(HEADLESS_DUMP, true);
    fixture.write_policy(POLICY);
    let output = fixture.doctor(&[]);
    let text = stdout(&output);
    assert!(output.status.success(), "{text}{}", stderr(&output));
    assert!(
        text.contains("[rdsh] compaction policy: ON, 1 route(s) from rdsh-compaction.json"),
        "{text}"
    );
    assert!(
        text.contains(
            "[rdsh] compaction policy:   hai / deepseek-v4-flash: compacts at 150000 tokens, keeps the last 20000, summary cap 8192"
        ),
        "{text}"
    );
    // Doctor is read-only: no profile is composed and no overlay is written.
    assert!(!fixture.composed_a_profile());
    assert!(!fixture.overlay_path().exists());
}

#[test]
fn doctor_is_silent_while_the_feature_was_never_used() {
    let fixture = Fixture::new(HEADLESS_DUMP, false);
    let output = fixture.doctor(&[]);
    let text = stdout(&output);
    assert!(output.status.success(), "{text}{}", stderr(&output));
    assert!(!text.contains("compaction policy"), "{text}");

    let output = fixture.doctor(&["--json"]);
    assert!(output.status.success(), "{}", stderr(&output));
    let report: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(
        report["compaction_policy"],
        serde_json::json!({
            "enabled": false,
            "file": "absent",
            "policies": null,
            "reason": null
        })
    );
}

#[test]
fn doctor_reports_a_policy_file_a_boot_would_ignore() {
    let fixture = Fixture::new(HEADLESS_DUMP, true);
    fixture.write_policy(r#"{"schema":1,"policies":[{"provider":"hai"}]}"#);
    let line = "[rdsh] compaction policy: ON, but rdsh-compaction.json policies[0] needs a string \"model\"; routes stay on the DSH defaults";

    let output = fixture.doctor(&[]);
    let text = stdout(&output);
    assert!(output.status.success(), "{text}{}", stderr(&output));
    assert!(text.contains(line), "{text}");

    let output = fixture.doctor(&["--json"]);
    assert!(output.status.success(), "{}", stderr(&output));
    let report: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(
        report["compaction_policy"],
        serde_json::json!({
            "enabled": true,
            "file": "invalid",
            "policies": null,
            "reason": "policies[0] needs a string \"model\""
        })
    );
    let warnings = report["warnings"].as_array().unwrap();
    assert!(
        warnings.iter().any(|warning| warning == line),
        "{warnings:?}"
    );
    assert!(!fixture.composed_a_profile());
}
