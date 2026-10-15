//! `rdsh task-outcomes` integration: the Rust module ports
//! `dashboard/task-outcomes.mjs`, so the CLI contract is checked on the real
//! binary — compact JSON on stdout, the JS error message on stderr, exit 1,
//! byte-identical output across runs, and no dependency on settings.
use std::path::PathBuf;
use std::process::{Command, Output};

/// A state document plus the mutation request both implementations read.
const REQUEST: &str = r#"{
  "operation": "apply",
  "state": {
    "schema": 1,
    "tasks": [
      { "id": "goal", "title": "Goal", "status": "done" },
      { "id": "child", "title": "Child", "status": "doing" }
    ]
  },
  "input": {
    "id": "goal",
    "milestone": "M1",
    "outcome": {
      "purpose": "保存内容を復元できるようにする",
      "owner": "担当者",
      "latest_outcome": "保存と読み込みを実装した",
      "next_step": null
    },
    "milestone_contract": {
      "id": "M1",
      "title": "保存処理の受入",
      "criteria": [
        { "task_id": "goal", "criterion_id": "restore", "description": "復元できる" },
        { "task_id": "goal", "criterion_id": "shape", "description": "形が正しい" }
      ]
    }
  }
}"#;

/// Exact `JSON.stringify` of the JS `applyTaskOutcomes` result for REQUEST.
const EXPECTED: &str = concat!(
    r#"{"operation":"apply","applied":true,"task_outcomes":{"schema":1,"tasks":["#,
    r#"{"task_id":"goal","purpose":"保存内容を復元できるようにする","owner":"担当者","#,
    r#""latest_outcome":"保存と読み込みを実装した","next_step":null}],"milestones":[{"#,
    r#""id":"M1","title":"保存処理の受入","criteria":[{"task_id":"goal","#,
    r#""criterion_id":"restore","description":"復元できる"},{"task_id":"goal","#,
    r#""criterion_id":"shape","description":"形が正しい"}]}]}}"#,
);

#[test]
fn apply_prints_the_js_json_shape() {
    let fixture = Fixture::new();
    fixture.write("request.json", REQUEST);
    let output = fixture.run(&[
        "task-outcomes",
        "apply",
        "--input-file",
        &fixture.path("request.json"),
    ]);
    assert!(output.status.success(), "{}", public_output(&output));
    assert!(output.stderr.is_empty(), "{}", public_output(&output));
    assert_eq!(stdout(&output), format!("{EXPECTED}\n"));
}

#[test]
fn apply_is_byte_identical_across_runs() {
    let fixture = Fixture::new();
    fixture.write("request.json", REQUEST);
    let args = [
        "task-outcomes",
        "apply",
        "--input-file",
        &fixture.path("request.json"),
    ];
    let first = fixture.run(&args);
    let second = fixture.run(&args);
    assert!(first.status.success() && second.status.success());
    assert_eq!(stdout(&first), stdout(&second));
}

#[test]
fn apply_is_idempotent_for_a_fixed_milestone_contract() {
    let fixture = Fixture::new();
    let document = r#"{"operation":"apply","state":{"schema":1,"tasks":[{"id":"goal","title":"G","status":"done"}]},
      "input":{"id":"goal","milestone":"M1","milestone_contract":
        {"id":"M1","title":"M","criteria":[{"task_id":"goal","criterion_id":"c","description":"d"}]}}}"#;
    let first = fixture.run_json(document);
    assert_eq!(
        first["task_outcomes"]["milestones"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    // Feed the produced document back in under the same ID and definition: it
    // is accepted and the milestone stays stored exactly once.
    let stored = serde_json::to_string(&first["task_outcomes"]).unwrap();
    let again = format!(
        r#"{{"operation":"apply","state":{{"schema":1,"tasks":[{{"id":"goal","title":"G","status":"done"}}],"task_outcomes":{stored}}},"input":{{"id":"goal","milestone":"M1","milestone_contract":{{"id":"M1","title":"M","criteria":[{{"task_id":"goal","criterion_id":"c","description":"d"}}]}}}}}}"#
    );
    let second = fixture.run_json(&again);
    assert_eq!(second["task_outcomes"], first["task_outcomes"]);
    // A changed definition under the same ID is refused.
    let changed = format!(
        r#"{{"operation":"apply","state":{{"schema":1,"tasks":[{{"id":"goal","title":"G","status":"done"}}],"task_outcomes":{stored}}},"input":{{"id":"goal","milestone":"M1","milestone_contract":{{"id":"M1","title":"M","criteria":[{{"task_id":"goal","criterion_id":"other","description":"d"}}]}}}}}}"#
    );
    fixture.write("changed-id.json", &changed);
    let refused = fixture.run(&[
        "task-outcomes",
        "apply",
        "--input-file",
        &fixture.path("changed-id.json"),
    ]);
    assert_eq!(
        refused.status.code(),
        Some(1),
        "{}",
        public_output(&refused)
    );
    assert!(
        public_output(&refused).contains("Milestone criteria are fixed"),
        "{}",
        public_output(&refused)
    );
}

#[test]
fn apply_rejects_forged_and_malformed_reports_with_the_js_message() {
    let fixture = Fixture::new();
    let cases: [(&str, &str); 5] = [
        (
            r#"{"operation":"apply","state":{"schema":1,"tasks":[]},"input":{"id":"goal","outcome":{"verified":true}}}"#,
            "Invalid outcome report fields",
        ),
        (
            r#"{"operation":"apply","state":{"schema":1,"tasks":[]},"input":{"id":"goal","outcome":{"owner":null,"purpose":"  "}}}"#,
            "Invalid outcome purpose",
        ),
        (
            r#"{"operation":"apply","state":{"schema":1,"tasks":[]},"input":{"id":"goal","milestone":"M2","milestone_contract":{"id":"M1","title":"t","criteria":[{"task_id":"goal","criterion_id":"c","description":"d"}]}}}"#,
            "Milestone contract must match the task milestone",
        ),
        (
            r#"{"operation":"apply","state":{"schema":1,"tasks":[]},"input":{"id":"goal","milestone":"M1","milestone_contract":{"id":"M1","title":"t","criteria":[{"task_id":"goal","criterion_id":"c","description":"d"},{"task_id":"goal","criterion_id":"c","description":"d"}]}}}"#,
            "Duplicate milestone criterion",
        ),
        (
            r#"{"operation":"apply","state":{"schema":1,"tasks":[]},"input":{"id":"goal","milestone":"M1","milestone_contract":{"id":"M1","title":"t","criteria":[]}}}"#,
            "Invalid milestone criteria",
        ),
    ];
    for (document, message) in cases {
        fixture.write("case.json", document);
        let output = fixture.run(&[
            "task-outcomes",
            "apply",
            "--input-file",
            &fixture.path("case.json"),
        ]);
        assert_eq!(output.status.code(), Some(1), "{}", public_output(&output));
        assert!(stdout(&output).is_empty(), "{}", public_output(&output));
        assert!(
            public_output(&output).contains(&format!("Task outcomes: {message}")),
            "expected {message} in {}",
            public_output(&output)
        );
    }
}

#[test]
fn apply_rejects_changed_criteria_for_a_stored_milestone() {
    let fixture = Fixture::new();
    let document = r#"{"operation":"apply","state":{"schema":1,"tasks":[],
      "task_outcomes":{"schema":1,"tasks":[],"milestones":[
        {"id":"M1","title":"M","criteria":[{"task_id":"goal","criterion_id":"c","description":"d"}]}]}},
      "input":{"id":"goal","milestone":"M1","milestone_contract":
        {"id":"M1","title":"M","criteria":[{"task_id":"goal","criterion_id":"other","description":"d"}]}}}"#;
    fixture.write("changed.json", document);
    let output = fixture.run(&[
        "task-outcomes",
        "apply",
        "--input-file",
        &fixture.path("changed.json"),
    ]);
    assert_eq!(output.status.code(), Some(1));
    assert!(
        public_output(&output).contains(
            "Task outcomes: Milestone criteria are fixed; declare changed criteria with a new milestone ID"
        ),
        "{}",
        public_output(&output)
    );
}

#[test]
fn apply_without_outcome_or_contract_keeps_the_state() {
    let fixture = Fixture::new();
    let document = r#"{"operation":"apply","state":{"schema":1,"tasks":[]},"input":{"id":"goal","title":"Goal"}}"#;
    let result = fixture.run_json(document);
    assert_eq!(result["applied"], true);
    // The JS early return leaves `task_outcomes` undefined (`null` in JSON).
    assert_eq!(result["task_outcomes"], serde_json::Value::Null);
}

#[test]
fn validate_accepts_and_rejects_like_the_js_module() {
    let fixture = Fixture::new();
    let ok = fixture.run_json(
        r#"{"operation":"validate","state":{"schema":1,"tasks":[{"id":"goal"}],
           "task_outcomes":{"schema":1,"tasks":[{"task_id":"goal","purpose":"p"}],"milestones":[]}}}"#,
    );
    assert_eq!(ok["valid"], true);
    // A missing document is valid: the JS function returns early.
    let absent = fixture.run_json(r#"{"operation":"validate","state":{"schema":1,"tasks":[]}}"#);
    assert_eq!(absent["valid"], true);
    for (document, message) in [
        (
            r#"{"operation":"validate","state":{"schema":1,"tasks":[],"task_outcomes":{"schema":1,"tasks":[{"task_id":"ghost"}],"milestones":[]}}}"#,
            "Invalid outcome task",
        ),
        (
            r#"{"operation":"validate","state":{"schema":1,"tasks":[],"task_outcomes":{"schema":2,"tasks":[],"milestones":[]}}}"#,
            "Invalid task outcomes",
        ),
        (
            r#"{"operation":"validate","state":{"schema":1,"tasks":[],"task_outcomes":{"schema":1,"tasks":[{"task_id":"goal","verified":true}],"milestones":[]}}}"#,
            "Invalid outcome task",
        ),
    ] {
        fixture.write("validate.json", document);
        let output = fixture.run(&[
            "task-outcomes",
            "validate",
            "--input-file",
            &fixture.path("validate.json"),
        ]);
        assert_eq!(output.status.code(), Some(1), "{}", public_output(&output));
        assert!(
            public_output(&output).contains(&format!("Task outcomes: {message}")),
            "{}",
            public_output(&output)
        );
    }
}

#[test]
fn schema_prints_the_advertised_js_schemas() {
    let fixture = Fixture::new();
    let result = fixture.run_json(r#"{"operation":"schema","state":{"schema":1,"tasks":[]}}"#);
    let outcome = &result["outcome"];
    assert_eq!(outcome["type"], "object");
    assert_eq!(outcome["additionalProperties"], false);
    let properties = outcome["properties"].as_object().unwrap();
    // `reportFields` in declaration order.
    let keys: Vec<&String> = properties.keys().collect();
    assert_eq!(
        keys,
        [
            "purpose",
            "owner",
            "latest_outcome",
            "next_step",
            "acceptance_task_id"
        ]
    );
    for (key, limit) in [
        ("purpose", 4000),
        ("owner", 1000),
        ("latest_outcome", 4000),
        ("next_step", 2000),
        ("acceptance_task_id", 160),
    ] {
        assert_eq!(
            properties[key]["type"],
            serde_json::json!(["string", "null"])
        );
        assert_eq!(properties[key]["minLength"], 1);
        assert_eq!(properties[key]["maxLength"], limit);
    }
    let milestone = &result["milestone_contract"];
    assert_eq!(
        milestone["required"],
        serde_json::json!(["id", "title", "criteria"])
    );
    assert_eq!(milestone["properties"]["id"]["maxLength"], 160);
    assert_eq!(milestone["properties"]["title"]["maxLength"], 1000);
    let criteria = &milestone["properties"]["criteria"];
    assert_eq!(criteria["minItems"], 1);
    assert_eq!(criteria["maxItems"], 50);
    let item = &criteria["items"];
    assert_eq!(item["additionalProperties"], false);
    assert_eq!(
        item["required"],
        serde_json::json!(["task_id", "criterion_id", "description"])
    );
    assert_eq!(
        item["properties"]["criterion_id"]["pattern"],
        "^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$"
    );
}

#[test]
fn commands_refuse_unreadable_invalid_and_mismatched_input() {
    let fixture = Fixture::new();
    fixture.write("invalid.json", "{ not json");
    let invalid = fixture.run(&[
        "task-outcomes",
        "apply",
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
        "task-outcomes",
        "apply",
        "--input-file",
        &fixture.path("missing.json"),
    ]);
    assert!(!missing.status.success());
    assert!(
        public_output(&missing).contains("cannot read JSON"),
        "{}",
        public_output(&missing)
    );
    let oversized = fixture.path("oversized.json");
    std::fs::write(&oversized, vec![b' '; 300 * 1024]).unwrap();
    let huge = fixture.run(&["task-outcomes", "apply", "--input-file", &oversized]);
    assert!(!huge.status.success());
    assert!(
        public_output(&huge).contains("at most 256 KiB"),
        "{}",
        public_output(&huge)
    );
    // The declared operation must match the requested action.
    fixture.write(
        "mismatch.json",
        r#"{"operation":"validate","state":{"schema":1,"tasks":[]}}"#,
    );
    let mismatch = fixture.run(&[
        "task-outcomes",
        "apply",
        "--input-file",
        &fixture.path("mismatch.json"),
    ]);
    assert!(!mismatch.status.success());
    assert!(
        public_output(&mismatch).contains("operation does not match"),
        "{}",
        public_output(&mismatch)
    );
}

#[test]
fn apply_accepts_a_utf8_bom_like_the_dashboard_cli() {
    let fixture = Fixture::new();
    fixture.write("request.json", &format!("\u{feff}{REQUEST}"));
    let output = fixture.run(&[
        "task-outcomes",
        "apply",
        "--input-file",
        &fixture.path("request.json"),
    ]);
    assert!(output.status.success(), "{}", public_output(&output));
    assert_eq!(stdout(&output), format!("{EXPECTED}\n"));
}

#[test]
fn commands_require_the_input_file_option() {
    let fixture = Fixture::new();
    let output = fixture.run(&["task-outcomes", "apply"]);
    assert!(!output.status.success());
    assert!(
        public_output(&output).contains("--input-file"),
        "{}",
        public_output(&output)
    );
}

#[test]
fn apply_ignores_unrelated_corrupt_settings_without_replacing_them() {
    // The pure validator must not fail closed on an unreadable settings file.
    let fixture = Fixture::new();
    fixture.write("request.json", REQUEST);
    fixture.write("dsh/rdsh.json", "{broken");
    let output = fixture.run(&[
        "task-outcomes",
        "apply",
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

struct Fixture {
    root: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let mut random = [0u8; 16];
        getrandom::fill(&mut random).unwrap();
        let suffix: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
        let root = std::env::temp_dir().join(format!("rdsh-outcomes-{suffix}"));
        std::fs::create_dir_all(root.join("dsh")).unwrap();
        Self { root }
    }

    fn path(&self, name: &str) -> String {
        self.root.join(name).to_string_lossy().into_owned()
    }

    fn write(&self, name: &str, text: &str) {
        std::fs::write(self.root.join(name), text).unwrap();
    }

    /// Run `task-outcomes apply` on an inline document and parse the stdout.
    fn run_json(&self, document: &str) -> serde_json::Value {
        self.write("inline.json", document);
        let operation = serde_json::from_str::<serde_json::Value>(document)
            .expect("fixture documents are JSON")["operation"]
            .as_str()
            .expect("fixture documents declare an operation")
            .to_string();
        let output = self.run(&[
            "task-outcomes",
            &operation,
            "--input-file",
            &self.path("inline.json"),
        ]);
        assert!(output.status.success(), "{}", public_output(&output));
        serde_json::from_str(&stdout(&output)).expect("stdout is JSON")
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
