//! `rdsh subagents plan` integration: the Rust planner replaced
//! `dashboard/subagent-plan.mjs`, so the CLI contract is checked on the real
//! binary — compact JSON on stdout, exit 1 and the JS error code on stderr,
//! and byte-identical output for the same request.
use std::path::PathBuf;
use std::process::{Command, Output};

const REQUEST: &str = r#"{
  "use_case": "review",
  "tiers": {
    "fast": { "provider": "example-provider", "model": "fast-model", "effort": "low" },
    "balanced": { "provider": "example-provider", "model": "balanced-model", "effort": "medium" },
    "deep": { "provider": "example-provider", "model": "deep-model", "effort": "high" }
  },
  "limits": { "max_parallel": 2, "max_items_per_agent": 2, "max_weight_per_agent": 6, "budget_units": 40 },
  "items": [
    { "id": "pr-460", "weight": 4, "signals": { "files": 30, "risk": "security" } },
    { "id": "pr-458", "weight": 2, "signals": { "files": 12 } }
  ]
}"#;

/// The same shape as REQUEST but with no `limits`: every limit comes from the
/// built-in defaults or the `subagents` settings section.
const OMITTED_LIMITS_REQUEST: &str = r#"{
  "use_case": "review",
  "tiers": {
    "fast": { "provider": "example-provider", "model": "fast-model", "effort": "low" },
    "balanced": { "provider": "example-provider", "model": "balanced-model", "effort": "medium" },
    "deep": { "provider": "example-provider", "model": "deep-model", "effort": "high" }
  },
  "items": [{ "id": "a" }, { "id": "b" }, { "id": "c" }]
}"#;

/// Exact `JSON.stringify(planSubagents(request))` from the removed JS planner.
const EXPECTED: &str = concat!(
    r#"{"use_case":"review","read_only":true,"tiers_used":["balanced","deep"],"waves":[{"wave":1,"agents":["#,
    r#"{"agent_id":"review-balanced-1","role":"review","tier":"balanced","route":{"provider":"example-provider","model":"balanced-model","effort":"medium"},"items":["pr-458"],"weight":2,"cost_units":6},"#,
    r#"{"agent_id":"review-deep-2","role":"review","tier":"deep","route":{"provider":"example-provider","model":"deep-model","effort":"high"},"items":["pr-460"],"weight":4,"cost_units":36}]}],"#,
    r#""totals":{"agents":2,"items":2,"waves":1,"cost_units":42},"warnings":[{"code":"budget-exceeded","cost_units":42,"budget_units":40}]}"#,
);

#[test]
fn plan_prints_the_js_json_shape() {
    let fixture = Fixture::new();
    fixture.write("request.json", REQUEST);
    let output = fixture.run(&[
        "subagents",
        "plan",
        "--input-file",
        &fixture.path("request.json"),
    ]);
    assert!(output.status.success(), "{}", public_output(&output));
    assert!(output.stderr.is_empty(), "{}", public_output(&output));
    assert_eq!(stdout(&output), format!("{EXPECTED}\n"));
}

#[test]
fn plan_json_flag_keeps_the_same_output() {
    let fixture = Fixture::new();
    fixture.write("request.json", REQUEST);
    let plain = fixture.run(&[
        "subagents",
        "plan",
        "--input-file",
        &fixture.path("request.json"),
    ]);
    let flagged = fixture.run(&[
        "subagents",
        "plan",
        "--input-file",
        &fixture.path("request.json"),
        "--json",
    ]);
    assert!(flagged.status.success(), "{}", public_output(&flagged));
    assert_eq!(stdout(&plain), stdout(&flagged));
}

#[test]
fn plan_accepts_utf8_bom_like_the_dashboard_cli() {
    let fixture = Fixture::new();
    fixture.write("request.json", &format!("\u{feff}{REQUEST}"));
    let output = fixture.run(&[
        "subagents",
        "plan",
        "--input-file",
        &fixture.path("request.json"),
    ]);
    assert!(output.status.success(), "{}", public_output(&output));
    assert_eq!(stdout(&output), format!("{EXPECTED}\n"));
}

#[test]
fn plan_ignores_unrelated_corrupt_settings_without_replacing_them() {
    let fixture = Fixture::new();
    fixture.write("request.json", REQUEST);
    fixture.write("dsh/rdsh.json", "{broken");
    let output = fixture.run(&[
        "subagents",
        "plan",
        "--input-file",
        &fixture.path("request.json"),
    ]);
    assert!(output.status.success(), "{}", public_output(&output));
    assert_eq!(stdout(&output), format!("{EXPECTED}\n"));
    assert_eq!(
        std::fs::read_to_string(fixture.path("dsh/rdsh.json")).unwrap(),
        "{broken"
    );
}

#[test]
fn plan_is_byte_identical_across_runs() {
    let fixture = Fixture::new();
    fixture.write("request.json", REQUEST);
    let first = fixture.run(&[
        "subagents",
        "plan",
        "--input-file",
        &fixture.path("request.json"),
    ]);
    let second = fixture.run(&[
        "subagents",
        "plan",
        "--input-file",
        &fixture.path("request.json"),
    ]);
    assert!(first.status.success() && second.status.success());
    assert_eq!(stdout(&first), stdout(&second));
}

#[test]
fn plan_reports_the_js_error_code_and_exits_nonzero() {
    let fixture = Fixture::new();
    fixture.write(
        "duplicate.json",
        r#"{"use_case":"review","tiers":{"fast":{"provider":"p","model":"m","effort":null}},"items":[{"id":"a"},{"id":"a"}]}"#,
    );
    let output = fixture.run(&[
        "subagents",
        "plan",
        "--input-file",
        &fixture.path("duplicate.json"),
    ]);
    assert!(!output.status.success());
    assert_eq!(output.status.code(), Some(1));
    assert!(stdout(&output).is_empty());
    assert!(
        public_output(&output).contains("Subagent plan: duplicate-item:a"),
        "{}",
        public_output(&output)
    );
}

#[test]
fn plan_refuses_unreadable_and_invalid_input() {
    let fixture = Fixture::new();
    fixture.write("invalid.json", "{ not json");
    let invalid = fixture.run(&[
        "subagents",
        "plan",
        "--input-file",
        &fixture.path("invalid.json"),
    ]);
    assert!(!invalid.status.success());
    assert!(
        public_output(&invalid).contains("Input JSON is invalid"),
        "{}",
        public_output(&invalid)
    );
    let missing = fixture.run(&[
        "subagents",
        "plan",
        "--input-file",
        &fixture.path("missing.json"),
    ]);
    assert!(!missing.status.success());
    assert!(
        public_output(&missing).contains("cannot read input JSON"),
        "{}",
        public_output(&missing)
    );
    let oversized = fixture.path("oversized.json");
    std::fs::write(&oversized, vec![b' '; 300 * 1024]).unwrap();
    let huge = fixture.run(&["subagents", "plan", "--input-file", &oversized]);
    assert!(!huge.status.success());
    assert!(
        public_output(&huge).contains("at most 256 KiB"),
        "{}",
        public_output(&huge)
    );
}

#[test]
fn defaults_prints_the_built_in_limits_when_no_settings_file_exists() {
    let fixture = Fixture::new();
    let output = fixture.run(&["subagents", "defaults"]);
    assert!(output.status.success(), "{}", public_output(&output));
    assert!(output.stderr.is_empty(), "{}", public_output(&output));
    assert_eq!(
        stdout(&output),
        format!(
            "{}\n",
            r#"{"source":"builtin","max_parallel":3,"max_items_per_agent":3,"max_weight_per_agent":9,"budget_units":null}"#
        )
    );
}

#[test]
fn defaults_reports_the_settings_section_and_clamps_out_of_range_values() {
    let fixture = Fixture::new();
    fixture.write(
        "dsh/rdsh.json",
        r#"{"subagents":{"max_parallel":2,"max_items_per_agent":1,"max_weight_per_agent":4,"budget_units":5}}"#,
    );
    let output = fixture.run(&["subagents", "defaults", "--json"]);
    assert!(output.status.success(), "{}", public_output(&output));
    assert_eq!(
        stdout(&output),
        format!(
            "{}\n",
            r#"{"source":"settings","max_parallel":2,"max_items_per_agent":1,"max_weight_per_agent":4,"budget_units":5}"#
        )
    );

    // A stored value outside the planner's range is clamped, not refused.
    fixture.write(
        "dsh/rdsh.json",
        r#"{"subagents":{"max_parallel":99,"budget_units":0}}"#,
    );
    let clamped = fixture.run(&["subagents", "defaults"]);
    assert!(clamped.status.success(), "{}", public_output(&clamped));
    assert_eq!(
        stdout(&clamped),
        format!(
            "{}\n",
            r#"{"source":"settings","max_parallel":16,"max_items_per_agent":3,"max_weight_per_agent":9,"budget_units":null}"#
        )
    );
}

#[test]
fn plan_uses_the_settings_section_for_limits_the_request_omits() {
    let fixture = Fixture::new();
    fixture.write("request.json", OMITTED_LIMITS_REQUEST);
    let built_in = fixture.run(&[
        "subagents",
        "plan",
        "--input-file",
        &fixture.path("request.json"),
    ]);
    assert!(built_in.status.success(), "{}", public_output(&built_in));
    let built_in: serde_json::Value = serde_json::from_str(&stdout(&built_in)).unwrap();
    assert_eq!(
        built_in["totals"],
        serde_json::json!({ "agents": 1, "items": 3, "waves": 1, "cost_units": 3 })
    );

    fixture.write(
        "dsh/rdsh.json",
        r#"{"subagents":{"max_parallel":2,"max_items_per_agent":1,"max_weight_per_agent":4}}"#,
    );
    let narrowed = fixture.run(&[
        "subagents",
        "plan",
        "--input-file",
        &fixture.path("request.json"),
    ]);
    assert!(narrowed.status.success(), "{}", public_output(&narrowed));
    let narrowed: serde_json::Value = serde_json::from_str(&stdout(&narrowed)).unwrap();
    assert_eq!(
        narrowed["totals"],
        serde_json::json!({ "agents": 3, "items": 3, "waves": 2, "cost_units": 3 })
    );
    assert_eq!(narrowed["warnings"], serde_json::json!([]));
}

#[test]
fn an_explicit_request_limit_still_wins_over_the_settings_section() {
    let fixture = Fixture::new();
    fixture.write(
        "dsh/rdsh.json",
        r#"{"subagents":{"max_items_per_agent":1,"max_weight_per_agent":1,"max_parallel":1}}"#,
    );
    fixture.write(
        "request.json",
        r#"{"use_case":"review","tiers":{"balanced":{"provider":"p","model":"m","effort":null}},"limits":{"max_items_per_agent":3,"max_weight_per_agent":9,"max_parallel":3},"items":[{"id":"a"},{"id":"b"},{"id":"c"}]}"#,
    );
    let output = fixture.run(&[
        "subagents",
        "plan",
        "--input-file",
        &fixture.path("request.json"),
    ]);
    assert!(output.status.success(), "{}", public_output(&output));
    let plan: serde_json::Value = serde_json::from_str(&stdout(&output)).unwrap();
    assert_eq!(
        plan["totals"],
        serde_json::json!({ "agents": 1, "items": 3, "waves": 1, "cost_units": 9 })
    );
}

#[test]
fn plan_requires_the_input_file_option() {
    let fixture = Fixture::new();
    let output = fixture.run(&["subagents", "plan"]);
    assert!(!output.status.success());
    assert!(
        public_output(&output).contains("--input-file"),
        "{}",
        public_output(&output)
    );
}

struct Fixture {
    root: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let mut random = [0u8; 16];
        getrandom::fill(&mut random).unwrap();
        let suffix: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
        let root = std::env::temp_dir().join(format!("rdsh-subagents-{suffix}"));
        std::fs::create_dir_all(root.join("dsh")).unwrap();
        Self { root }
    }

    fn path(&self, name: &str) -> String {
        self.root.join(name).to_string_lossy().into_owned()
    }

    fn write(&self, name: &str, text: &str) {
        std::fs::write(self.root.join(name), text).unwrap();
    }

    fn run(&self, args: &[&str]) -> Output {
        let mut command = Command::new(env!("CARGO_BIN_EXE_rdsh"));
        command
            .env("HOME", self.root.join("home"))
            .env("USERPROFILE", self.root.join("home"))
            .env("APPDATA", self.root.join("appdata"))
            .env("XDG_DATA_HOME", self.root.join("data"))
            .env("XDG_CONFIG_HOME", self.root.join("config"))
            .env("DSH_HOME", self.root.join("dsh"))
            .env_remove("RDSH_ORIG_BIN")
            .env_remove("RDSH_PASSTHROUGH")
            .env_remove("RDSH_DRY_RUN")
            .env_remove("RDSH_DEFAULT_PROFILE");
        command.args(args).output().unwrap()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn stdout(output: &Output) -> String {
    String::from_utf8_lossy(&output.stdout).into_owned()
}

fn public_output(output: &Output) -> String {
    format!(
        "{}{}",
        stdout(output),
        String::from_utf8_lossy(&output.stderr)
    )
}
